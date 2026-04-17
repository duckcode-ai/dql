/**
 * `dql compile` — Generate the DQL project manifest.
 *
 * Scans all blocks, notebooks, and semantic layer definitions,
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
import { buildManifest, collectInputFiles, type DQLManifest } from '@duckcodeailabs/dql-core';
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

  // Auto-detect dbt manifest if not explicitly provided
  if (!dbtManifestPath) {
    const defaultDbtPath = join(projectRoot, 'target', 'manifest.json');
    if (existsSync(defaultDbtPath)) {
      dbtManifestPath = defaultDbtPath;
    }
  }

  const noCache = allArgs.includes('--no-cache');

  // Build manifest (with cache when possible)
  const startTime = Date.now();
  let manifest: DQLManifest;
  let cacheHit = false;

  const buildOptions = { projectRoot, dqlVersion, dbtManifestPath, maxDbtHops };

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
  const notebookCount = Object.keys(manifest.notebooks).length;
  const metricCount = Object.keys(manifest.metrics).length;
  const dimensionCount = Object.keys(manifest.dimensions).length;
  const sourceCount = Object.keys(manifest.sources).length;
  const nodeCount = manifest.lineage.nodes.length;
  const edgeCount = manifest.lineage.edges.length;
  const domainCount = manifest.lineage.domains.length;

  console.log(`\n  DQL Compile — ${manifest.project}`);
  console.log('  ' + '='.repeat(50));
  console.log(`\n  Scanned:`);
  console.log(`    ${blockCount} block(s)`);
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
  console.log(`  ${cacheHit ? 'Served from cache' : 'Compiled'} in ${elapsed}ms\n`);

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

    if (Object.keys(manifest.notebooks).length > 0) {
      console.log('\n  Notebooks:');
      for (const nb of Object.values(manifest.notebooks)) {
        console.log(`    ${nb.title} (${nb.cells.length} cells) — ${nb.filePath}`);
      }
    }

    console.log('');
  }
}
