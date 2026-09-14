/**
 * ONE INVESTIGATION'S LEDGER: every query it ran, the pipeline receipt behind
 * each, and the budget. A query is not started once the run is cancelled, out
 * of time or out of warehouse statements; the report says which.
 */
import type { AnalyticalIntentV1 } from '../../ask-pipeline/intent.js';
import type { PipelineOutcome, PipelineReceipt } from '../../ask-pipeline/outcomes.js';
import type { ExecutedRows } from '../../ask-pipeline/execute.js';
import type { InvestigationCaveatV1, InvestigationLimits, InvestigationQueryPurpose, InvestigationQueryV1, InvestigationReceiptV1, InvestigationRuntime } from './types.js';

export interface InvestigationRun {
  question: string;
  runtime: InvestigationRuntime;
  limits: InvestigationLimits;
  queries: InvestigationQueryV1[];
  receipt: InvestigationReceiptV1;
  caveats: InvestigationCaveatV1[];
  /** Queries started and not yet settled: each holds a place in the statement budget. */
  inFlight?: number;
}

export type InvestigationQueryResult =
  | { status: 'answered'; id: string; rows: ExecutedRows; aiSql: boolean }
  | { status: 'no_rows'; id: string }
  | { status: 'unanswered'; id: string; message: string }
  | { status: 'stopped'; reason: 'cancelled' | 'deadline' | 'budget' };

export function investigationStopReason(run: InvestigationRun): 'cancelled' | 'deadline' | 'budget' | undefined {
  if (run.runtime.signal?.aborted) return 'cancelled';
  if (run.receipt.budget.statementsUsed + (run.inFlight ?? 0) >= run.limits.maxStatements) return 'budget';
  if (run.runtime.remainingMs() < run.limits.minRemainingMs) return 'deadline';
  return undefined;
}

const withoutReplies = (receipt: PipelineReceipt): PipelineReceipt => ({
  ...receipt,
  dispatches: receipt.dispatches.map(({ reply: _reply, ...rest }) => rest),
});

export function recordReadingCalls(run: InvestigationRun, outcome: PipelineOutcome): void {
  run.receipt.budget.aiCalls += outcome.receipt.dispatches.length;
}

export async function runInvestigationQuery(run: InvestigationRun, input: {
  purpose: InvestigationQueryPurpose;
  label: string;
  programId: string;
  intent: AnalyticalIntentV1;
  allowAiSql: boolean;
}): Promise<InvestigationQueryResult> {
  const stopped = investigationStopReason(run);
  if (stopped) {
    run.receipt.budget.stoppedBy ??= stopped;
    return { status: 'stopped', reason: stopped };
  }
  const id = `q${run.queries.length + 1}`;
  let outcome: PipelineOutcome;
  run.inFlight = (run.inFlight ?? 0) + 1;
  try {
    outcome = await run.runtime.runIntent(input.intent, { allowAiSql: input.allowAiSql });
  } catch (error) {
    if (run.runtime.signal?.aborted) {
      run.receipt.budget.stoppedBy ??= 'cancelled';
      return { status: 'stopped', reason: 'cancelled' };
    }
    const message = error instanceof Error ? error.message : String(error);
    run.queries.push({ id, purpose: input.purpose, label: input.label, programId: input.programId, intent: input.intent, outcome: 'failed', message, receiptIndex: -1 });
    return { status: 'unanswered', id, message };
  } finally {
    run.inFlight = Math.max(0, (run.inFlight ?? 1) - 1);
  }
  run.receipt.queries.push({ id, programId: input.programId, receipt: withoutReplies(outcome.receipt) });
  run.receipt.budget.statementsUsed += outcome.receipt.warehouse?.attempts ?? (outcome.kind === 'answered' ? 1 : 0);
  run.receipt.budget.aiCalls += outcome.receipt.dispatches.length;
  const answered = outcome.kind === 'answered' ? outcome : undefined;
  // The pipeline records an empty aggregate as a gap whose query ran and
  // returned nothing; a grouped query can also answer with no rows at all.
  const noRows = (outcome.kind === 'gap' && (outcome.receipt.executed?.rowCount === 0 || outcome.receipt.refusals.some((refusal) => String(refusal.code) === 'no_rows_matched')))
    || (outcome.kind === 'answered' && outcome.result.rowCount === 0);
  const message = outcome.kind === 'answered' ? undefined
    : outcome.kind === 'gap' || outcome.kind === 'failed' ? outcome.message
    : outcome.kind === 'clarify' ? outcome.question
    : outcome.text;
  run.queries.push({
    id, purpose: input.purpose, label: input.label, programId: input.programId, intent: input.intent, outcome: outcome.kind,
    ...(answered ? {
      tier: answered.candidate.tier, trust: answered.candidate.trust, sql: answered.candidate.sql,
      ...(answered.candidate.artifact !== undefined ? { dqlArtifact: answered.candidate.artifact } : {}),
      ...(answered.candidate.relations?.length ? { relations: answered.candidate.relations } : {}),
      result: {
        columns: answered.result.columns, rows: answered.result.rows.slice(0, 100), rowCount: answered.result.rowCount,
        ...(answered.result.columnsMeta ? { columnsMeta: answered.result.columnsMeta } : {}),
        ...(answered.result.truncated ? { truncated: true } : {}),
      },
    } : {}),
    ...(message && !noRows ? { message } : {}),
    receiptIndex: run.receipt.queries.length - 1,
  });
  if (answered) return { status: 'answered', id, rows: answered.result, aiSql: answered.candidate.tier === 'exploratory' };
  if (noRows) return { status: 'no_rows', id };
  return { status: 'unanswered', id, message: message ?? 'the query did not answer' };
}
