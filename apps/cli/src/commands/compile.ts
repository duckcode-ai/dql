/**
 * `dql compile` — Generate the DQL project manifest.
 *
 * Scans all blocks, business views, notebooks, and semantic layer definitions,
 * resolves dependencies, builds lineage, and writes dql-manifest.json.
 *
 * Usage:
 *   dql compile [path]                        Compile project at path (default: .)
 *   dql compile --dbt-manifest <path>         Import dbt manifest.json as upstream
 *   dql compile --dbt-hops <n>               Limit upstream dbt hops (default: unlimited)
 *   dql compile --out-dir <dir>               Write manifest to a specific directory
 *   dql compile --format json                 Output manifest to stdout (no file write)
 *
 * Selective dbt import (automatic for projects > 200 models):
 *   Only imports the dbt models/sources that are reachable upstream from the
 *   tables your DQL blocks actually reference. This keeps dql-manifest.json
 *   small and fast even in 4000+ model repos.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildManifest, collectInputFiles, resolveDataLexManifestPath, resolveDbtManifestPath, type DQLManifest } from '@duckcodeailabs/dql-core';
import { ManifestCache } from '@duckcodeailabs/dql-project';
import type { CLIFlags } from '../args.js';

export async function runCompile(
  pathArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  // Collect all args (pathArg might be a flag if no path was given)
  const allArgs = [...(pathArg ? [pathArg] : []), ...rest];

  // Parse --dbt-manifest flag
  let dbtManifestPath: string | undefined;
  const dbtIdx = allArgs.indexOf('--dbt-manifest');
  if (dbtIdx >= 0 && allArgs[dbtIdx + 1]) {
    dbtManifestPath = resolve(allArgs[dbtIdx + 1]);
    if (!existsSync(dbtManifestPath)) {
      console.error(`dbt manifest not found: ${dbtManifestPath}`);
      process.exitCode = 1;
      return;
    }
  }

  // Parse --dbt-hops flag (max upstream hops for selective import)
  let maxDbtHops: number | undefined;
  const hopsIdx = allArgs.indexOf('--dbt-hops');
  if (hopsIdx >= 0 && allArgs[hopsIdx + 1]) {
    const parsed = parseInt(allArgs[hopsIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) maxDbtHops = parsed;
  }

  // Determine project root — first non-flag positional arg, or cwd
  const pathCandidates = allArgs.filter((a) => !a.startsWith('-'));
  // Remove the dbt manifest path from candidates (only if --dbt-manifest was found)
  const filteredCandidates = dbtIdx >= 0
    ? pathCandidates.filter((c) => c !== allArgs[dbtIdx + 1])
    : pathCandidates;
  const projectRoot = resolve(filteredCandidates[0] ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No DQL project found (missing dql.config.json). Run from a project root or pass a project path.');
    process.exitCode = 1;
    return;
  }

  // Read DQL version from CLI package.json
  let dqlVersion = '0.6.0';
  try {
    const pkgPath = join(import.meta.dirname ?? __dirname, '..', '..', 'package.json');
    if (existsSync(pkgPath)) {
      dqlVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? dqlVersion;
    }
  } catch { /* use default */ }

  // Resolve via explicit flag → dql.config.json `dbt:` → target/manifest.json
  const resolvedDbt = resolveDbtManifestPath(projectRoot, dbtManifestPath);
  if (resolvedDbt) dbtManifestPath = resolvedDbt;
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, flags.datalexManifestPath || undefined) ?? undefined;
  if (flags.datalexManifestPath && (!datalexManifestPath || !existsSync(datalexManifestPath))) {
    console.error(`DataLex manifest not found: ${datalexManifestPath ?? flags.datalexManifestPath}`);
    process.exitCode = 1;
    return;
  }

  const noCache = allArgs.includes('--no-cache');

  // Build manifest (with cache when possible)
  const startTime = Date.now();
  let manifest: DQLManifest;
  let cacheHit = false;

  const buildOptions = { projectRoot, dqlVersion, dbtManifestPath, maxDbtHops, datalexManifestPath };

  try {
    if (noCache) {
      manifest = buildManifest(buildOptions);
    } else {
      const cachePath = join(projectRoot, '.dql', 'cache', 'manifest.sqlite');
      const cache = new ManifestCache({ path: cachePath });
      try {
        const files = collectInputFiles(buildOptions).map((path) => ({ path }));
        const fingerprint = cache.fingerprint(files);
        const lookup = cache.lookup<DQLManifest>(fingerprint, files);
        if (lookup.hit) {
          manifest = lookup.value;
          cacheHit = true;
        } else {
          manifest = buildManifest(buildOptions);
          cache.put(fingerprint, manifest, files);
        }
      } finally {
        cache.close();
      }
    }
  } catch (err) {
    console.error(`Failed to compile project: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const elapsed = Date.now() - startTime;

  // JSON mode: output to stdout
  if (flags.format === 'json') {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Write manifest file
  const outDir = flags.outDir ? resolve(flags.outDir) : projectRoot;
  const manifestPath = join(outDir, 'dql-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Print summary
  const blockCount = Object.keys(manifest.blocks).length;
  const businessViews = manifest.businessViews ?? {};
  const businessViewCount = Object.keys(businessViews).length;
  const terms = manifest.terms ?? {};
  const termCount = Object.keys(terms).length;
  const notebookCount = Object.keys(manifest.notebooks).length;
  const metricCount = Object.keys(manifest.metrics).length;
  const dimensionCount = Object.keys(manifest.dimensions).length;
  const sourceCount = Object.keys(manifest.sources).length;
  const nodeCount = manifest.lineage.nodes.length;
  const edgeCount = manifest.lineage.edges.length;
  const domainCount = manifest.lineage.domains.length;

  console.log(`\n  DQL Compile — ${manifest.project}`);
  console.log('  ' + '='.repeat(50));
  console.log('\n  Manifest:');
  console.log('    dql-manifest.json is the dbt-like compiled artifact for this DQL project.');
  console.log('    It records blocks, terms, business views, notebooks, Apps, dashboards, semantic objects, sources, dbt imports, and lineage.');
  console.log(`\n  Scanned:`);
  console.log(`    ${blockCount} block(s)`);
  console.log(`    ${termCount} term(s)`);
  console.log(`    ${businessViewCount} business view(s)`);
  console.log(`    ${notebookCount} notebook(s)`);
  console.log(`    ${metricCount} metric(s)`);
  console.log(`    ${dimensionCount} dimension(s)`);
  console.log(`    ${sourceCount} source table(s)`);

  console.log(`\n  Lineage:`);
  console.log(`    ${nodeCount} nodes, ${edgeCount} edges, ${domainCount} domain(s)`);

  if (manifest.lineage.crossDomainFlows.length > 0) {
    console.log(`    ${manifest.lineage.crossDomainFlows.length} cross-domain flow(s)`);
  }

  if (manifest.dbtImport) {
    const dbt = manifest.dbtImport;
    console.log(`\n  dbt Import:`);
    if (dbt.selective && dbt.totalDbtModels !== undefined && dbt.totalDbtModels > dbt.modelsImported) {
      console.log(`    ${dbt.modelsImported} of ${dbt.totalDbtModels} model(s) (selective — upstream of DQL blocks only)`);
      if (dbt.maxHops !== undefined) {
        console.log(`    depth: ${dbt.maxHops} hop(s) upstream`);
      }
    } else {
      console.log(`    ${dbt.modelsImported} model(s), ${dbt.sourcesImported} source(s)`);
    }
    console.log(`    from: ${dbt.manifestPath}`);
  }

  console.log(`\n  Manifest written to: ${manifestPath}`);
  console.log(`  ${cacheHit ? 'Served from cache' : 'Compiled'} in ${elapsed}ms`);

  // Surface non-fatal problems — a silent "0 blocks" should never happen again.
  const diagnostics = manifest.diagnostics ?? [];
  const errs = diagnostics.filter((d) => d.severity === 'error');
  const warns = diagnostics.filter((d) => d.severity === 'warning');
  if (diagnostics.length > 0) {
    console.log('');
    if (errs.length > 0) {
      console.log(`  ${errs.length} error(s):`);
      for (const d of errs) {
        const where = d.filePath ? `${d.filePath}: ` : '';
        console.log(`    ✗ ${where}${d.message}`);
      }
    }
    if (warns.length > 0) {
      console.log(`  ${warns.length} warning(s):`);
      for (const d of warns) {
        const where = d.filePath ? `${d.filePath}: ` : '';
        console.log(`    ⚠ ${where}${d.message}`);
      }
    }
    if (errs.length > 0) process.exitCode = 1;
  }
  console.log('');

  if (flags.verbose) {
    // Show block details
    console.log('  Blocks:');
    for (const block of Object.values(manifest.blocks)) {
      const deps = block.allDependencies;
      const meta = [block.domain, block.owner].filter(Boolean).join(', ');
      console.log(`    ${block.name}${meta ? ` (${meta})` : ''}`);
      if (deps.length > 0) {
        console.log(`      depends on: ${deps.join(', ')}`);
      }
    }

    if (termCount > 0) {
      console.log('\n  Terms:');
      for (const term of Object.values(terms)) {
        const meta = [term.domain, term.termType, term.owner].filter(Boolean).join(', ');
        console.log(`    ${term.name}${meta ? ` (${meta})` : ''}`);
        if (term.identifiers && term.identifiers.length > 0) {
          console.log(`      identifiers: ${term.identifiers.join(', ')}`);
        }
      }
    }

    if (businessViewCount > 0) {
      console.log('\n  Business Views:');
      for (const view of Object.values(businessViews)) {
        const meta = [view.domain, view.owner].filter(Boolean).join(', ');
        const refs = [...view.blockRefs.map((ref) => `block:${ref}`), ...view.businessViewRefs.map((ref) => `business_view:${ref}`)];
        console.log(`    ${view.name}${meta ? ` (${meta})` : ''}`);
        if (refs.length > 0) {
          console.log(`      includes: ${refs.join(', ')}`);
        }
        if (view.termRefs.length > 0) {
          console.log(`      terms: ${view.termRefs.join(', ')}`);
        }
      }
    }

    if (Object.keys(manifest.notebooks).length > 0) {
      console.log('\n  Notebooks:');
      for (const nb of Object.values(manifest.notebooks)) {
        console.log(`    ${nb.title} (${nb.cells.length} cells) — ${nb.filePath}`);
      }
    }

    console.log('');
  }
}
