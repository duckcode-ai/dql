/**
 * `dql agent shadow-report` — the evidence for deciding whether the V2 Ask
 * runtime is ready to serve.
 *
 * In `shadow_v2` (the default), V2 builds its full decision state for every
 * Ask turn and then hands the turn to V1. That shadow state is persisted on
 * each run and, until now, nothing read it: the rollout gate called for
 * comparing V1 and V2 on route, required objects, and terminal cause, but
 * there was no way to see the comparison. An operator was left to flip an
 * undocumented flag and find out live.
 *
 * This reports what each runtime concluded for the same question, so the flip
 * is a decision about observed behavior rather than a leap.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SqliteAgentRunStore,
  defaultAgentRunSqlitePath,
  defaultAgentRunStorePath,
  type AgentRun,
} from '@duckcodeailabs/dql-agent';
import { findProjectRoot, terminalFailureTitleForAnswer } from '../local-runtime.js';
import type { CLIFlags } from '../args.js';

interface ShadowComparisonRow {
  runId: string;
  question: string;
  runtimeMode?: string;
  v1Route?: string;
  v1Status?: string;
  v1Trust?: string;
  v1Terminal?: string;
  v2TurnClass?: string;
  v2IntendedTool?: string;
  v2ExactCertifiedCandidateId?: string;
  v2CandidateCount: number;
  v2AdmittedSources: number;
  v2Terminal?: string;
  agreement: string;
}

/**
 * What V2 would have done, in one phrase — the column an operator actually
 * reads. Deliberately conservative: shadow never executes, so this reports the
 * intent V2 recorded, never a claim about a result it did not produce.
 */
function describeV2Intent(row: ShadowComparisonRow): string {
  if (row.v2ExactCertifiedCandidateId) return 'certified (exact fit proven)';
  if (row.v2TurnClass === 'prior_result') return 'prior-result continuation';
  if (row.v2TurnClass && row.v2TurnClass !== 'analytics') return row.v2TurnClass.replace(/_/g, ' ');
  if (row.v2IntendedTool) return row.v2IntendedTool;
  if (row.v2CandidateCount === 0) return 'no candidates retrieved';
  return 'analytics (tier undecided pre-freeze)';
}

/**
 * Did the two runtimes see the same turn the same way? Shadow V2 stops before
 * freezing, so this compares FRAMING, not results: whether V2 recognised the
 * certified fit V1 executed, whether both treated the turn as a follow-up, and
 * whether V2 had any evidence to work with at all.
 */
function compareFraming(run: AgentRun, row: ShadowComparisonRow): string {
  if (!row.v2TurnClass) return 'no V2 state (legacy or pre-V2 run)';
  if (row.v2CandidateCount === 0 && row.v2AdmittedSources === 0) return 'DIFFERS: V2 retrieved nothing';
  const v1Certified = run.route === 'certified_answer';
  if (v1Certified && row.v2ExactCertifiedCandidateId) return 'agree: certified';
  if (v1Certified && !row.v2ExactCertifiedCandidateId) return 'DIFFERS: V1 certified, V2 saw no exact fit';
  if (!v1Certified && row.v2ExactCertifiedCandidateId) return 'DIFFERS: V2 found a certified fit V1 did not use';
  if (run.status === 'needs_clarification') {
    return row.v2TurnClass === 'prior_result' ? 'agree: clarification on a follow-up' : 'both clarify';
  }
  if (run.status === 'blocked') return 'V1 blocked; V2 framing recorded';
  return 'agree: framing consistent';
}

function rowForRun(run: AgentRun): ShadowComparisonRow | undefined {
  const decision = run.routeDecision?.askAgentV2Decision;
  const state = decision?.state;
  const answer = run.artifacts?.[0]?.payload as { refusalCode?: string; refusalDetails?: { code?: string } } | undefined;
  const row: ShadowComparisonRow = {
    runId: run.id,
    question: run.question ?? '',
    runtimeMode: run.askAgentRuntimeMode ?? decision?.mode,
    v1Route: run.route,
    v1Status: run.status,
    v1Trust: run.trustState,
    v1Terminal: answer?.refusalCode
      ? terminalFailureTitleForAnswer({
        refusalCode: answer.refusalCode as never,
        ...(answer.refusalDetails ? { refusalDetails: answer.refusalDetails as never } : {}),
      })
      : undefined,
    v2TurnClass: state?.turnClass,
    v2IntendedTool: state?.candidatePlan?.intendedTool,
    v2ExactCertifiedCandidateId: state?.exactCertifiedCandidateId,
    v2CandidateCount: state?.retainedCandidateIds?.length ?? 0,
    v2AdmittedSources: (state?.contextCoverage ?? []).filter((coverage) => coverage.status === 'available').length,
    v2Terminal: state?.terminalOutcome?.kind ?? state?.terminal,
    agreement: '',
  };
  row.agreement = compareFraming(run, row);
  return row;
}

function truncate(value: string, width: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= width ? clean.padEnd(width) : `${clean.slice(0, width - 1)}…`;
}

/** Read `--limit <n>` from this subcommand's own argv; it is not a global flag. */
function limitFromArgs(rest: string[]): number {
  const index = rest.indexOf('--limit');
  if (index < 0) return 50;
  const parsed = Number(rest[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
}

export async function runAgentShadowReport(rest: string[], flags: CLIFlags): Promise<void> {
  const skip = new Set<string>();
  const limitIndex = rest.indexOf('--limit');
  if (limitIndex >= 0) skip.add(rest[limitIndex + 1] ?? '');
  const target = rest.find((arg) => !arg.startsWith('-') && !skip.has(arg)) ?? '.';
  const projectRoot = findProjectRoot(resolve(target));
  const sqlitePath = defaultAgentRunSqlitePath(projectRoot);
  const legacyJsonPath = defaultAgentRunStorePath(projectRoot);
  if (!existsSync(sqlitePath) && !existsSync(legacyJsonPath)) {
    console.log('No Ask runs recorded for this project yet. Ask a few questions, then run this again.');
    return;
  }

  const store = new SqliteAgentRunStore({ path: sqlitePath, legacyJsonPath });
  try {
    const rows = store.list()
      .filter((run) => Boolean(run.question))
      .slice(0, limitFromArgs(rest))
      .map(rowForRun)
      .filter((row): row is ShadowComparisonRow => Boolean(row));

    if (flags.format === 'json' || rest.includes('--json')) {
      console.log(JSON.stringify({ version: 1, projectRoot, rows }, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.log('No Ask runs with a recorded question were found.');
      return;
    }

    const withState = rows.filter((row) => row.v2TurnClass);
    console.log(`\n  Ask shadow comparison — ${rows.length} run(s), ${withState.length} with V2 state\n`);
    console.log(`  ${truncate('QUESTION', 40)}  ${truncate('V1 OUTCOME', 26)}  ${truncate('V2 WOULD', 30)}  AGREEMENT`);
    console.log(`  ${'─'.repeat(40)}  ${'─'.repeat(26)}  ${'─'.repeat(30)}  ${'─'.repeat(20)}`);
    for (const row of rows) {
      const v1 = row.v1Terminal ?? `${row.v1Route ?? 'unknown'} / ${row.v1Status ?? 'unknown'}`;
      console.log(`  ${truncate(row.question, 40)}  ${truncate(v1, 26)}  ${truncate(describeV2Intent(row), 30)}  ${row.agreement}`);
    }

    const differs = rows.filter((row) => row.agreement.startsWith('DIFFERS'));
    console.log(`\n  ${differs.length} of ${rows.length} run(s) framed differently by V2.`);
    if (withState.length === 0) {
      console.log('  No V2 state was recorded. Shadow mode must be active (the default) for this report to fill in.');
    }
    console.log('  Shadow V2 never executes: this compares how each runtime FRAMED the turn, not results.\n');
  } finally {
    store.close();
  }
}
