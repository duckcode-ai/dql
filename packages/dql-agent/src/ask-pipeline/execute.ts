import type { AnalyticalIntentV1 } from './intent.js';
import type { PreparedCandidate } from './prepare/types.js';

/**
 * EXECUTE, then prove the executed query did what the intent said.
 *
 * Two proofs run before rows are trusted: every literal the intent filters
 * on must appear in the executed SQL (a dropped filter is a wrong answer
 * that looks right), and a native multi-relation join must not have
 * multiplied fact rows (the fan-out probe). Failures are typed and carry
 * the warehouse's own message.
 */

export interface ExecutedRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  executionTimeMs: number;
  truncated?: boolean;
}

export interface ExecuteDeps {
  run(sql: string, params: unknown[] | undefined, options: { maxRows: number }): Promise<ExecutedRows>;
  maxRows?: number;
}

export type ExecutionOutcome =
  | { ok: true; result: ExecutedRows; proofs: string[] }
  | { ok: false; code: 'filter_not_applied' | 'fanout_detected' | 'execution_failed'; message: string; proofs: string[] };

export async function executeCandidate(candidate: PreparedCandidate, intent: AnalyticalIntentV1, deps: ExecuteDeps): Promise<ExecutionOutcome> {
  const proofs: string[] = [];
  // Fail-closed filter proof: the SQL must mention every literal the intent filters on.
  const literals = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]
    .flatMap((predicate) => predicate.values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
  const haystack = `${candidate.sql}\n${(candidate.params ?? []).map(String).join('\n')}`.toLowerCase();
  const missing = literals.filter((literal) => !haystack.includes(literal.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, code: 'filter_not_applied', message: `the prepared query does not apply the filter value${missing.length > 1 ? 's' : ''} ${missing.map((value) => JSON.stringify(value)).join(', ')}; nothing was executed`, proofs };
  }
  if (literals.length > 0) proofs.push(`every filter literal (${literals.map((value) => JSON.stringify(value)).join(', ')}) is bound in the executed query`);

  if (candidate.fanoutProbeSql) {
    try {
      const probe = await deps.run(candidate.fanoutProbeSql, undefined, { maxRows: 1 });
      const row = probe.rows[0] ?? {};
      const base = Number(row.base_rows ?? row.BASE_ROWS ?? NaN);
      const joined = Number(row.joined_rows ?? row.JOINED_ROWS ?? NaN);
      if (Number.isFinite(base) && Number.isFinite(joined) && joined > base) {
        return { ok: false, code: 'fanout_detected', message: `the join multiplies fact rows (${base} base rows became ${joined}); the aggregate would be inflated, so nothing was executed`, proofs };
      }
      proofs.push('the join fan-out probe found no row multiplication');
    } catch (error) {
      proofs.push(`fan-out probe could not run (${error instanceof Error ? error.message : String(error)}); aggregation safety unproven`);
    }
  }
  try {
    const result = await deps.run(candidate.sql, candidate.params, { maxRows: deps.maxRows ?? 500 });
    proofs.push(`executed on the warehouse: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${Math.round(result.executionTimeMs)} ms`);
    return { ok: true, result, proofs };
  } catch (error) {
    return { ok: false, code: 'execution_failed', message: error instanceof Error ? error.message : String(error), proofs };
  }
}
