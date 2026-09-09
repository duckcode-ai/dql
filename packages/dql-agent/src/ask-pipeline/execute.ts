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

/**
 * A SUPERLATIVE THAT TIES HAS SEVERAL ANSWERS. The query fetched one row more
 * than it shows; when that row carries the same value as the last one kept,
 * every row sharing the top value is kept and the answer says they tie. When
 * it does not, the extra row is dropped and nothing about it is said.
 */
export function resolveTie(result: ExecutedRows, probe: NonNullable<PreparedCandidate['tieProbe']>): { result: ExecutedRows; note?: string } {
  if (result.rows.length <= probe.limit) return { result };
  const valueOf = (row: Record<string, unknown> | undefined): unknown => {
    if (!row) return undefined;
    if (probe.column in row) return row[probe.column];
    const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === probe.column.toLowerCase());
    return key === undefined ? undefined : row[key];
  };
  const last = valueOf(result.rows[probe.limit - 1]);
  const next = valueOf(result.rows[probe.limit]);
  if (last === undefined || next === undefined || String(last) !== String(next)) {
    return { result: { ...result, rows: result.rows.slice(0, probe.limit), rowCount: probe.limit } };
  }
  const tied = result.rows.filter((row) => String(valueOf(row)) === String(last));
  return {
    result: { ...result, rows: tied, rowCount: tied.length },
    note: `${tied.length} rows tie on ${probe.column} at ${String(last)}: all of them are shown, because no rule in this question chooses between them`,
  };
}

export type ExecutionOutcome =
  | { ok: true; result: ExecutedRows; proofs: string[] }
  | { ok: false; code: 'filter_not_applied' | 'fanout_detected' | 'execution_failed' | 'no_rows_matched'; message: string; proofs: string[]; cause?: EmptyAggregateCause; warehouse?: WarehouseFailure };

/**
 * What the warehouse said, in a class the answer can name. A driver message is
 * the only evidence a host has for why a query did not run, and "could not be
 * completed" reads the same for a suspended warehouse, a table the connection
 * cannot see, and a genuine SQL fault, which are three different next actions.
 */
export interface WarehouseFailure {
  class: 'warehouse_suspended' | 'relation_missing' | 'relation_denied' | 'catalog_stale' | 'sql_error';
  relations: string[];
}

const RELATION_TOKEN = /'([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*){0,2})'|"([A-Za-z_][\w$]*(?:"\."[A-Za-z_][\w$]*){0,2})"/g;

/** Relation names a driver mentioned, as written. */
function relationsIn(message: string): string[] {
  const found = new Set<string>();
  for (const match of message.matchAll(RELATION_TOKEN)) {
    const name = (match[1] ?? match[2] ?? '').replace(/"/g, '');
    if (name && /[A-Za-z]/.test(name)) found.add(name);
  }
  return [...found];
}

/**
 * Classify a driver error. The order matters: a message that names both a
 * privilege and a missing object is a privilege problem, and Snowflake's
 * "does not exist or not authorized" is reported as missing because the
 * catalog is what disagrees with the connection.
 */
export function classifyWarehouseError(message: string): WarehouseFailure {
  const text = message.toLowerCase();
  const relations = relationsIn(message);
  if (/known to be missing|catalog lists it/.test(text)) return { class: 'catalog_stale', relations };
  if (/warehouse/.test(text) && /suspend|not running|is stopped|cannot be resumed|no active warehouse|no running warehouse/.test(text)) {
    return { class: 'warehouse_suspended', relations };
  }
  if (/permission denied|access denied|insufficient privileg|not authorized to|access control error|is not allowed to/.test(text)) {
    return { class: 'relation_denied', relations };
  }
  if (/does not exist|doesn't exist|not found|no such table|unknown table|undefined table|invalid identifier|cannot be found/.test(text)) {
    return { class: 'relation_missing', relations };
  }
  return { class: 'sql_error', relations };
}

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
    const computed = candidate.derived?.length ? applyDerivedColumns(executed, candidate.derived) : executed;
    const tie = candidate.tieProbe ? resolveTie(computed, candidate.tieProbe) : { result: computed };
    const result = tie.result;
    if (tie.note) proofs.push(`tie: ${tie.note}`);
    proofs.push(`executed on the warehouse: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${Math.round(result.executionTimeMs)} ms`);
    if (candidate.derived?.length) proofs.push(`ratio${candidate.derived.length > 1 ? 's' : ''} ${candidate.derived.map((item) => `${item.alias} = ${item.numerator} / ${item.denominator}`).join('; ')} computed from the executed columns`);
    const cause = emptyAggregateCause(intent, result);
    if (cause) return { ok: false, code: 'no_rows_matched', message: describeEmptyAggregate(cause), proofs, cause };
    return { ok: true, result, proofs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'execution_failed', message, proofs, warehouse: classifyWarehouseError(message) };
  }
}

const GRAIN_STEP: Record<string, (date: Date) => void> = {
  day: (date) => date.setUTCDate(date.getUTCDate() + 1),
  week: (date) => date.setUTCDate(date.getUTCDate() + 7),
  month: (date) => date.setUTCMonth(date.getUTCMonth() + 1),
  quarter: (date) => date.setUTCMonth(date.getUTCMonth() + 3),
  year: (date) => date.setUTCFullYear(date.getUTCFullYear() + 1),
};

const startOfGrain = (date: Date, grain: string): Date => {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (grain === 'week') { start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); return start; }
  if (grain === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  if (grain === 'quarter') return new Date(Date.UTC(start.getUTCFullYear(), Math.floor(start.getUTCMonth() / 3) * 3, 1));
  if (grain === 'year') return new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
  return start;
};

/**
 * A SERIES MUST COVER THE PERIOD IT CLAIMS.
 *
 * "Monthly totals during calendar 2017" is twelve months. A warehouse returns
 * only the months that have rows, so a summer with no games silently became a
 * ten-row year: the reader cannot tell a month with nothing in it from a month
 * nobody asked about. The window the intent bound is the authority, so the
 * missing periods are added here, in the order the series runs — additive
 * measures read 0 (nothing happened), anything else stays null (nothing to
 * average). Only a single time grouping over an absolute window with no limit
 * is filled: with another grouping beside it, which member the empty period
 * belongs to is not ours to invent.
 */
export function fillPeriodGaps(intent: AnalyticalIntentV1, result: ExecutedRows): { result: ExecutedRows; added: number } {
  const window = intent.time?.window;
  const groups = intent.groupBy;
  const time = groups.find((group) => group.role === 'time' && group.grain);
  if (!window || !time?.grain || groups.length !== 1 || intent.limit !== undefined || !GRAIN_STEP[time.grain]) return { result, added: 0 };
  if (result.truncated || result.rows.length === 0) return { result, added: 0 };
  const start = new Date(`${window.start.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${window.end.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { result, added: 0 };
  const timeColumn = result.columns.find((column) => result.columnsMeta?.some((meta) => meta.name === column && meta.kind === 'date'))
    ?? result.columns.find((column) => result.rows.every((row) => typeof row[column] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(String(row[column]))));
  if (!timeColumn) return { result, added: 0 };
  const key = (value: unknown): string => String(value ?? '').slice(0, 10);
  const present = new Set(result.rows.map((row) => key(row[timeColumn])));
  // A filled period must look like the periods the warehouse returned: a bare
  // date beside timestamps (or the other way round) reads as a different value
  // to everything downstream.
  const sample = String(result.rows[0]?.[timeColumn] ?? '');
  const asPeriod = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(sample) ? iso : sample.includes('T') || sample === '' ? `${iso}T00:00:00.000Z` : iso);
  // Which columns read 0 for an empty period: only the measures that ADD up.
  // An average or a ratio of nothing is not zero, it is unknown.
  const additiveRefs = new Set(intent.measures
    .filter((measure) => !measure.derived && (measure.aggregation === undefined || ['sum', 'count', 'count_distinct'].includes(measure.aggregation)))
    .map((measure) => measure.ref));
  const additiveAliases = new Set(intent.measures
    .filter((measure) => !measure.derived && (measure.aggregation === undefined || ['sum', 'count', 'count_distinct'].includes(measure.aggregation)))
    .map((measure) => measure.alias)
    .filter((alias): alias is string => Boolean(alias)));
  const additive = new Set(result.columns.filter((column) => {
    if (additiveAliases.has(column)) return true;
    const meta = result.columnsMeta?.find((item) => item.name === column);
    return Boolean(meta?.ref && additiveRefs.has(meta.ref));
  }));
  const rows = [...result.rows];
  let added = 0;
  for (let at = startOfGrain(start, time.grain); at < end; GRAIN_STEP[time.grain]!(at)) {
    const iso = at.toISOString().slice(0, 10);
    if (present.has(iso)) continue;
    const row: Record<string, unknown> = {};
    for (const column of result.columns) {
      row[column] = column === timeColumn ? asPeriod(iso) : additive.has(column) ? 0 : null;
    }
    rows.push(row);
    added += 1;
    if (added > 400) return { result, added: 0 };
  }
  if (added === 0) return { result, added: 0 };
  rows.sort((left, right) => key(left[timeColumn]).localeCompare(key(right[timeColumn])));
  return { result: { ...result, rows, rowCount: rows.length }, added };
}
