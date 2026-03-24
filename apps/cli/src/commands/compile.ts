/**
 * `dql compile` — Generate the DQL project manifest.
 *
 * Scans all blocks, notebooks, and semantic layer definitions,
 * resolves dependencies, builds lineage, and writes dql-manifest.json.
 *
 * Usage:
 *   dql compile [path]                        Compile project at path (default: .)
 *   dql compile --dbt-manifest <path>         Import dbt manifest.json as upstream
 *   dql compile --out-dir <dir>               Write manifest to a specific directory
 *   dql compile --format json                 Output manifest to stdout (no file write)
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildManifest, type DQLManifest } from '@duckcodeailabs/dql-core';
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

  // Determine project root — first non-flag positional arg, or cwd
  const pathCandidates = allArgs.filter((a) => !a.startsWith('-'));
  // Remove the dbt manifest path from candidates
  const filteredCandidates = pathCandidates.filter((c) => c !== allArgs[dbtIdx + 1]);
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

  // Build manifest
  const startTime = Date.now();
  let manifest: DQLManifest;

  try {
    manifest = buildManifest({
      projectRoot,
      dqlVersion,
      dbtManifestPath,
    });
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
    console.log(`\n  dbt Import:`);
    console.log(`    ${manifest.dbtImport.modelsImported} model(s), ${manifest.dbtImport.sourcesImported} source(s)`);
    console.log(`    from: ${manifest.dbtImport.manifestPath}`);
  }

  console.log(`\n  Manifest written to: ${manifestPath}`);
  console.log(`  Compiled in ${elapsed}ms\n`);

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
