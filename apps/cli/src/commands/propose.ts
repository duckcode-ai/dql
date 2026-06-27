/**
 * `dql propose` — scan dbt evidence and generate a ranked queue of DRAFT blocks.
 *
 * Product principle: **AI drafts, humans certify.** Instead of authoring DQL
 * from a blank file, a new user runs `dql propose` against an existing dbt repo
 * and gets a draft governance layer: one `block` per high-value model, born
 * `status: draft`, run through the Certifier (verdict stored so a reviewer sees
 * what's missing), demand-ranked, and NEVER auto-certified.
 *
 * Usage:
 *   dql propose [path]                      Propose drafts for the project at path
 *   dql propose --dbt-manifest <path>       Explicit manifest.json path
 *   dql propose --owner <name>              Default owner stamped on drafts
 *   dql propose --limit <n>                 Cap drafts written this run
 *   dql propose --dry-run                   Rank only; write nothing
 *   dql propose --format json               Machine-readable output
 */

import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadProjectConfig, resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import { propose, type ProposeSummary } from '@duckcodeailabs/dql-agent';
import type { CLIFlags } from '../args.js';

export async function runPropose(
  fileArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  // --dbt-manifest <path> may arrive in rest (it is not a first-class flag).
  let explicitManifest: string | undefined;
  const dbtIdx = rest.indexOf('--dbt-manifest');
  if (dbtIdx >= 0 && rest[dbtIdx + 1]) explicitManifest = resolve(rest[dbtIdx + 1]);

  // --limit <n> may also arrive in rest.
  let limit: number | undefined;
  const limitIdx = rest.indexOf('--limit');
  if (limitIdx >= 0 && rest[limitIdx + 1]) {
    const value = Number(rest[limitIdx + 1]);
    if (Number.isFinite(value) && value > 0) limit = value;
  }

  const skip = new Set<string>(['--dbt-manifest', explicitManifest, '--limit', rest[limitIdx + 1]].filter(Boolean) as string[]);
  const pathArg = fileArg && !fileArg.startsWith('-') ? fileArg : rest.find((a) => !a.startsWith('-') && !skip.has(a));
  const projectRoot = resolve(pathArg ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No DQL project found (missing dql.config.json). Run `dql init` first, then `dql propose`.');
    process.exitCode = 1;
    return;
  }

  const resolved = resolveDbtManifestPath(projectRoot, explicitManifest);
  if (!resolved) {
    const cfg = loadProjectConfig(projectRoot);
    console.error('\n  ✗ No dbt manifest found.');
    console.error('');
    if (cfg.dbt?.projectDir) {
      console.error(`    dql.config.json points at dbt project: ${cfg.dbt.projectDir}`);
      console.error('    Run `dbt parse` (or `dbt compile`) there first, then re-run `dql propose`.');
    } else {
      console.error('    Add a "dbt" section to dql.config.json, or pass --dbt-manifest <path>.');
    }
    console.error('');
    process.exitCode = 1;
    return;
  }

  let summary: ProposeSummary;
  try {
    summary = propose({
      projectRoot,
      dbtManifestPath: resolved,
      owner: flags.owner || undefined,
      limit,
      dryRun: Boolean(flags.dryRun),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ✗ Proposal failed: ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const dryRun = Boolean(flags.dryRun);
  console.log('\n  DQL Propose — drafts from dbt evidence');
  console.log('  ' + '='.repeat(50));
  if (summary.projectName) console.log(`  dbt project:   ${summary.projectName}`);
  console.log(`  Models scanned: ${summary.modelsScanned}`);
  console.log(`  Ranked:         ${summary.proposalsRanked}`);
  console.log(`  Drafts ${dryRun ? 'to write' : 'written'}:  ${summary.draftsWritten}`);
  console.log(`  Skipped:        ${summary.draftsSkipped}`);
  console.log('');
  console.log('  AI drafts, humans certify. Every block is status="draft" and');
  console.log('  was checked by the Certifier (verdict stored in each file).');
  console.log('');

  const shown = summary.proposals.slice(0, 25);
  for (const p of shown) {
    const where = p.path ? p.path : p.skipped ? '(skipped)' : '(ranked)';
    const exposure = p.ranking.exposureLinked ? ' · exposure' : '';
    const runs = p.ranking.runCount > 0 ? ` · ${p.ranking.runCount} run(s)` : '';
    console.log(`  • ${p.model}  [${p.inference.pattern}]  score ${p.ranking.score}`);
    console.log(`    domain ${p.domain} · fan-out ${p.ranking.fanOut}${exposure}${runs}${p.inference.grain ? ` · grain ${p.inference.grain}` : ''}`);
    const blocking = p.certification.errors.length;
    const warnings = p.certification.warnings.length;
    console.log(`    certify gap: ${blocking} blocking, ${warnings} warning(s) → ${where}`);
    if (p.skipped) console.log(`    note: ${p.skipped}`);
  }
  if (summary.proposals.length > shown.length) {
    console.log(`\n  ... and ${summary.proposals.length - shown.length} more.`);
  }
  console.log('');
  console.log('  Next: review the top drafts under blocks/_drafts (or domains/<d>/blocks/_drafts),');
  console.log('  then `dql certify --from-draft <path> --owner you@example.com` to promote.');
  console.log('');
}
