/**
 * `dql verify` — prove the on-disk manifest is reproducible from source.
 *
 * Recompiles the manifest in-memory and diffs it against `dql-manifest.json`.
 * Returns a non-zero exit code (and prints a diff summary) on drift. Used by
 * CI to ensure programmable artifacts (Apps, dashboards, blocks, RLS rules,
 * schedules) stay in lock-step with their source files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, type DQLManifest } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

export async function runVerify(_rest: string[], flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`dql-manifest.json not found at ${manifestPath}. Run \`dql compile\` first.`);
  }

  const onDisk = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DQLManifest;
  const fresh = buildManifest({ projectRoot });

  const drift = diffManifest(onDisk, fresh);
  const json = (flags as { format?: string }).format === 'json';

  if (drift.length === 0) {
    if (json) {
      console.log(JSON.stringify({ ok: true }));
    } else {
      console.log('  ✓ Manifest verified — no drift between source tree and dql-manifest.json.');
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify({ ok: false, drift }, null, 2));
  } else {
    console.error(`  ✗ Manifest drift detected:`);
    for (const item of drift) console.error(`    - ${item}`);
    console.error('\n  Run `dql compile` to regenerate, then commit.');
  }
  process.exit(1);
}

function diffManifest(a: DQLManifest, b: DQLManifest): string[] {
  const drift: string[] = [];
  diffMap('blocks', new Set(Object.keys(a.blocks)), new Set(Object.keys(b.blocks)), drift);
  diffMap('notebooks', new Set(Object.keys(a.notebooks)), new Set(Object.keys(b.notebooks)), drift);
  diffMap('apps', new Set(Object.keys(a.apps ?? {})), new Set(Object.keys(b.apps ?? {})), drift);
  diffMap('dashboards', new Set(Object.keys(a.dashboards ?? {})), new Set(Object.keys(b.dashboards ?? {})), drift);
  diffMap('metrics', new Set(Object.keys(a.metrics)), new Set(Object.keys(b.metrics)), drift);
  diffMap('dimensions', new Set(Object.keys(a.dimensions)), new Set(Object.keys(b.dimensions)), drift);
  diffMap('sources', new Set(Object.keys(a.sources)), new Set(Object.keys(b.sources)), drift);

  // Block-level drift: shape changes that matter for downstream readers.
  for (const [name, block] of Object.entries(a.blocks)) {
    const other = b.blocks[name];
    if (!other) continue;
    if (block.sql !== other.sql) drift.push(`blocks/${name}: SQL drift`);
    if ((block.status ?? '') !== (other.status ?? '')) drift.push(`blocks/${name}: status drift (${block.status} → ${other.status})`);
    if ((block.domain ?? '') !== (other.domain ?? '')) drift.push(`blocks/${name}: domain drift`);
  }
  return drift;
}

function diffMap(label: string, a: Set<string>, b: Set<string>, into: string[]): void {
  for (const k of a) if (!b.has(k)) into.push(`${label}: removed "${k}"`);
  for (const k of b) if (!a.has(k)) into.push(`${label}: added "${k}"`);
}
