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

/** What a result column IS, from the vocabulary: the units contract every renderer reads. */
export interface ResultColumnMeta {
  name: string;
  kind: 'currency' | 'percent' | 'number' | 'count' | 'duration' | 'date' | 'text' | 'boolean';
  /** `USD` for currency; `fraction` (0.626) or `percentage_points` (10.8) for percent. */
  unit?: string;
  decimals?: number;
  /** The vocabulary ref the column carries, when known. */
  ref?: string;
  /** The time grain of a date column. */
  grain?: string;
}

export interface ExecutedRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  executionTimeMs: number;
  truncated?: boolean;
  /** Units per column; absent on legacy results, which render exactly as before. */
  columnsMeta?: ResultColumnMeta[];
}

export interface ExecuteRunOptions {
  maxRows: number;
  /** What this statement is for: the answer itself, or the one-row fan-out probe. */
  purpose?: 'query' | 'fanout_probe';
  /** The tier whose candidate is being executed. */
  tier?: PreparedCandidate['tier'];
}

export interface ExecuteDeps {
  run(sql: string, params: unknown[] | undefined, options: ExecuteRunOptions): Promise<ExecutedRows>;
  maxRows?: number;
}

const numeric = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

/**
 * Compute ratio columns from two executed columns (semantic candidates carry
 * both metrics and divide here). Null when the denominator is 0 or absent;
 * helper columns are dropped unless the intent asked for them too.
 */
export function applyDerivedColumns(result: ExecutedRows, derived: NonNullable<PreparedCandidate['derived']>): ExecutedRows {
  if (derived.length === 0) return result;
  const find = (row: Record<string, unknown>, name: string): unknown => {
    if (name in row) return row[name];
    const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : row[key];
  };
  const drop = new Set(derived.filter((item) => !item.keepInputs).flatMap((item) => [item.numerator, item.denominator]).map((name) => name.toLowerCase()));
  const rows = result.rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) if (!drop.has(key.toLowerCase())) next[key] = value;
    for (const item of derived) {
      const numerator = numeric(find(row, item.numerator));
      const denominator = numeric(find(row, item.denominator));
      next[item.alias] = numerator === undefined || denominator === undefined || denominator === 0 ? null : numerator / denominator;
    }
    return next;
  });
  const columns = [...result.columns.filter((column) => !drop.has(column.toLowerCase())), ...derived.map((item) => item.alias).filter((alias) => !result.columns.includes(alias))];
  return { ...result, columns, rows };
}

export type ExecutionOutcome =
  | { ok: true; result: ExecutedRows; proofs: string[] }
  | { ok: false; code: 'filter_not_applied' | 'fanout_detected' | 'execution_failed' | 'no_rows_matched'; message: string; proofs: string[]; cause?: EmptyAggregateCause };

/** Why a single all-null aggregate row is empty: the restriction that matched nothing. */
export type EmptyAggregateCause = { kind: 'member'; literals: string[] } | { kind: 'window'; start: string; end: string } | { kind: 'predicate'; refs: string[] };

/**
 * A result that holds nothing (no rows, or one row whose every cell is null)
 * did not aggregate anything. Under a restriction (a member literal, a time
 * window, any predicate) that is the absence of matching rows, not a value,
 * and the cause is named. An unrestricted empty result stays an answer: the
 * table is empty, which is what the rows say.
 */
export function emptyAggregateCause(intent: AnalyticalIntentV1, result: ExecutedRows): EmptyAggregateCause | undefined {
  if (result.rows.length > 1) return undefined;
  if (result.rows.length === 1) {
    const cells = Object.values(result.rows[0] ?? {});
    if (cells.length === 0 || !cells.every((value) => value === null || value === undefined)) return undefined;
  }
  const predicates = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])];
  const literals = predicates.flatMap((predicate) => predicate.values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0 && !/^(true|false)$/i.test(value)));
  if (literals.length > 0) return { kind: 'member', literals };
  if (intent.time?.window) return { kind: 'window', start: intent.time.window.start, end: intent.time.window.end };
  if (predicates.length > 0) return { kind: 'predicate', refs: [...new Set(predicates.map((predicate) => predicate.ref))] };
  return undefined;
}

function describeEmptyAggregate(cause: EmptyAggregateCause): string {
  if (cause.kind === 'member') return `no rows matched ${cause.literals.map((value) => JSON.stringify(value)).join(', ')} on the warehouse; the aggregate was empty, so nothing about the member was answered`;
  if (cause.kind === 'window') return `no rows fell inside the window ${cause.start}..${cause.end}; the aggregate was empty, so nothing about that period was answered`;
  return `no rows matched the restriction on ${cause.refs.join(', ')}; the aggregate was empty, so nothing under that restriction was answered`;
}

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
  // The time window is a restriction too: both bounds must be bound, as
  // parameters or as date literals, or nothing runs.
  if (intent.time?.window) {
    const bounds = [intent.time.window.start, intent.time.window.end].map((bound) => bound.slice(0, 10).toLowerCase());
    const unbound = bounds.filter((bound) => !haystack.includes(bound));
    if (unbound.length > 0) {
      return { ok: false, code: 'filter_not_applied', message: `the prepared query does not apply the time window ${intent.time.window.start}..${intent.time.window.end} (missing ${unbound.join(', ')}); nothing was executed`, proofs };
    }
    proofs.push(`the time window ${bounds[0]}..${bounds[1]} is bound in the executed query`);
  }

  if (candidate.fanoutProbeSql) {
    try {
      const probe = await deps.run(candidate.fanoutProbeSql, undefined, { maxRows: 1, purpose: 'fanout_probe', tier: candidate.tier });
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
    const executed = await deps.run(candidate.sql, candidate.params, { maxRows: deps.maxRows ?? 500, purpose: 'query', tier: candidate.tier });
    const result = candidate.derived?.length ? applyDerivedColumns(executed, candidate.derived) : executed;
    proofs.push(`executed on the warehouse: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${Math.round(result.executionTimeMs)} ms`);
    if (candidate.derived?.length) proofs.push(`ratio${candidate.derived.length > 1 ? 's' : ''} ${candidate.derived.map((item) => `${item.alias} = ${item.numerator} / ${item.denominator}`).join('; ')} computed from the executed columns`);
    const cause = emptyAggregateCause(intent, result);
    if (cause) return { ok: false, code: 'no_rows_matched', message: describeEmptyAggregate(cause), proofs, cause };
    return { ok: true, result, proofs };
  } catch (error) {
    return { ok: false, code: 'execution_failed', message: error instanceof Error ? error.message : String(error), proofs };
  }
}
