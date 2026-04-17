/**
 * `dql sync dbt` — detect dbt manifest changes and refresh the DQL cache.
 *
 * Usage:
 *   dql sync dbt [path]                   Sync dbt manifest for the project at path
 *   dql sync dbt --dbt-manifest <path>    Explicit manifest.json path
 *   dql sync dbt --watch                  Poll for manifest.json changes (1s interval)
 *   dql sync dbt --clear                  Clear the DQL manifest cache
 *
 * What it does:
 *   - Locates target/manifest.json (explicit or auto-detected)
 *   - Diffs current tracked-file hashes against `.dql/cache/manifest.sqlite`
 *   - Reports which DQL inputs (blocks, notebooks, semantic YAML, dbt manifest)
 *     changed since the last compile
 *   - Parses the dbt manifest for a quick model/source/metric count
 *   - In --watch mode, re-runs the diff whenever manifest.json mtime moves
 *
 * This never rebuilds the DQL manifest itself — it only tells the user whether
 * the next `dql compile` will be a cache hit or a rebuild. Use `dql compile`
 * to actually rebuild.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { collectInputFiles, loadProjectConfig, resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import { ManifestCache } from '@duckcodeailabs/dql-project';
import type { CLIFlags } from '../args.js';

interface DbtManifestShape {
  nodes?: Record<string, { resource_type?: string }>;
  sources?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  semantic_models?: Record<string, unknown>;
}

interface DbtCounts {
  models: number;
  sources: number;
  metrics: number;
  semanticModels: number;
}

export async function runSync(
  subcommand: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  if (subcommand !== 'dbt') {
    console.error('Usage: dql sync dbt [path] [--watch] [--clear] [--dbt-manifest <path>]');
    process.exitCode = 1;
    return;
  }

  const allArgs = rest;

  // --dbt-manifest <path>
  let dbtManifestPath: string | undefined;
  const dbtIdx = allArgs.indexOf('--dbt-manifest');
  if (dbtIdx >= 0 && allArgs[dbtIdx + 1]) {
    dbtManifestPath = resolve(allArgs[dbtIdx + 1]);
  }

  const watch = allArgs.includes('--watch');
  const clear = allArgs.includes('--clear');

  // First non-flag, non-value arg is the project root
  const skip = new Set<string>();
  if (dbtIdx >= 0) {
    skip.add(allArgs[dbtIdx]);
    if (allArgs[dbtIdx + 1]) skip.add(allArgs[dbtIdx + 1]);
  }
  const pathArg = allArgs.find((a) => !a.startsWith('-') && !skip.has(a));
  const projectRoot = resolve(pathArg ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No DQL project found (missing dql.config.json). Run from a project root or pass a path.');
    process.exitCode = 1;
    return;
  }

  // Resolution order: explicit --dbt-manifest flag → `dbt:` section in
  // dql.config.json → <projectRoot>/target/manifest.json.
  const resolved = resolveDbtManifestPath(projectRoot, dbtManifestPath);
  if (!resolved) {
    const cfg = loadProjectConfig(projectRoot);
    const hintedDir = cfg.dbt?.projectDir
      ? resolve(projectRoot, cfg.dbt.projectDir)
      : undefined;
    console.error('✗ No dbt manifest found.');
    console.error('');
    if (hintedDir) {
      console.error(`  dql.config.json points at: ${hintedDir}`);
      console.error(`  but no manifest.json exists at ${join(hintedDir, cfg.dbt?.manifestPath ?? 'target/manifest.json')}.`);
      console.error('');
      console.error(`  Run \`dbt parse\` (or \`dbt compile\`) inside ${hintedDir} first,`);
      console.error('  or pass an explicit --dbt-manifest <path>.');
    } else {
      console.error('  No `dbt` section in dql.config.json and no ./target/manifest.json in sight.');
      console.error('');
      console.error('  Fix one of:');
      console.error('    1. Add to dql.config.json:');
      console.error('         "dbt": { "projectDir": "../dbt" }');
      console.error('    2. Pass --dbt-manifest <path> to this command.');
      console.error('    3. Run this from a directory with ./target/manifest.json.');
    }
    process.exitCode = 1;
    return;
  }
  dbtManifestPath = resolved;

  const cachePath = join(projectRoot, '.dql', 'cache', 'manifest.sqlite');

  if (clear) {
    if (!existsSync(cachePath)) {
      console.log('  No cache to clear.');
      return;
    }
    const cache = new ManifestCache({ path: cachePath });
    try {
      cache.clear();
      console.log(`  Cleared DQL manifest cache at ${relative(projectRoot, cachePath)}`);
    } finally {
      cache.close();
    }
    return;
  }

  const runOnce = () => reportDiff({ projectRoot, dbtManifestPath: dbtManifestPath!, cachePath });
  runOnce();

  if (!watch) return;

  console.log(`\n  Watching ${relative(projectRoot, dbtManifestPath)} for changes (Ctrl-C to stop)...`);
  let lastMtime = safeMtime(dbtManifestPath);
  const interval = setInterval(() => {
    const current = safeMtime(dbtManifestPath!);
    if (current !== null && current !== lastMtime) {
      lastMtime = current;
      console.log(`\n  [${new Date().toISOString()}] Manifest changed — re-syncing.`);
      runOnce();
    }
  }, 1000);

  // Keep process alive until signalled
  await new Promise<void>((done) => {
    const stop = () => {
      clearInterval(interval);
      done();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function reportDiff(opts: {
  projectRoot: string;
  dbtManifestPath: string;
  cachePath: string;
}): void {
  const { projectRoot, dbtManifestPath, cachePath } = opts;

  const counts = readDbtCounts(dbtManifestPath);

  console.log(`\n  DQL Sync — dbt`);
  console.log('  ' + '='.repeat(50));
  console.log(`  Manifest: ${relative(projectRoot, dbtManifestPath)}`);
  console.log(`    ${counts.models} model(s), ${counts.sources} source(s), ${counts.metrics} metric(s), ${counts.semanticModels} semantic_model(s)`);

  if (!existsSync(cachePath)) {
    console.log('\n  Cache: (cold) — next `dql compile` will build from scratch.\n');
    return;
  }

  const files = collectInputFiles({ projectRoot, dbtManifestPath }).map((path) => ({ path }));
  const cache = new ManifestCache({ path: cachePath });
  try {
    const changed = cache.diffFiles(files);
    const fp = cache.fingerprint(files);
    const lookup = cache.lookup(fp, files);

    if (lookup.hit) {
      console.log('\n  Cache: HIT — next `dql compile` will be served from cache.');
      console.log(`    built at: ${lookup.builtAt}\n`);
      return;
    }

    console.log('\n  Cache: MISS — next `dql compile` will rebuild.');
    if (changed.length === 0) {
      console.log('    (no prior build for these exact inputs)\n');
      return;
    }
    console.log(`    ${changed.length} file(s) changed since last build:`);
    for (const path of changed.slice(0, 20)) {
      console.log(`      ${relative(projectRoot, path)}`);
    }
    if (changed.length > 20) {
      console.log(`      ... and ${changed.length - 20} more`);
    }
    console.log('');
  } finally {
    cache.close();
  }
}

function readDbtCounts(manifestPath: string): DbtCounts {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DbtManifestShape;
    let models = 0;
    for (const node of Object.values(raw.nodes ?? {})) {
      if (node?.resource_type === 'model') models += 1;
    }
    return {
      models,
      sources: Object.keys(raw.sources ?? {}).length,
      metrics: Object.keys(raw.metrics ?? {}).length,
      semanticModels: Object.keys(raw.semantic_models ?? {}).length,
    };
  } catch {
    return { models: 0, sources: 0, metrics: 0, semanticModels: 0 };
  }
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
