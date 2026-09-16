/**
 * Does an answer match a benchmark's correct answer, ignoring column names?
 *
 * A benchmark's gold SQL names its columns its own way (`total_loss`), and a
 * governed answer names them another (`sum_of_loss`); the answer is the same
 * when the values are. So rows are compared as multisets of value tuples,
 * each tuple sorted within the row, the rule public text-to-SQL benchmarks
 * state ("the order or the labels of the columns are not taken into account").
 *
 * `rowsEqual` in agent.ts stays exact and label-sensitive for DQL's own
 * fixtures; this comparator is for answers whose labels we do not control.
 */

export interface GoldRowMatchOptions {
  /** Numbers are equal when they round to the same value at this precision. */
  tolerance?: number;
  /** The question asks for an order, so rows must come back in it. */
  ordered?: boolean;
  /** The answer may carry extra columns (a name beside an id). */
  allowExtraColumns?: boolean;
}

export interface GoldRowMatch {
  match: boolean;
  reason?: string;
}

const DEFAULT_TOLERANCE = 1e-6;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** One cell, normalized so values with the same meaning compare equal. */
export function normalizeGoldValue(value: unknown, tolerance = DEFAULT_TOLERANCE): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') value = Number(value);
  if (typeof value === 'boolean') return value ? 'bool:true' : 'bool:false';
  if (value instanceof Date) value = value.toISOString();
  if (typeof value === 'number' || (typeof value === 'string' && NUMERIC.test(value.trim()))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return `num:${String(number)}`;
    const digits = Math.max(0, Math.round(-Math.log10(tolerance)));
    const rounded = Number(number.toFixed(digits));
    return `num:${Object.is(rounded, -0) ? 0 : rounded}`;
  }
  if (typeof value === 'string' && DATE_LIKE.test(value)) {
    // A date and a midnight timestamp of the same day are the same answer.
    const day = value.slice(0, 10);
    const time = value.slice(11, 19);
    return !time || time === '00:00:00' ? `date:${day}` : `ts:${day}T${time}`;
  }
  if (typeof value === 'object') return `json:${JSON.stringify(value)}`;
  return `str:${String(value).trim()}`;
}

function rowValues(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object') return Object.values(row as Record<string, unknown>);
  return [row];
}

function rowKey(row: unknown, tolerance: number): string {
  return rowValues(row).map((value) => normalizeGoldValue(value, tolerance)).sort().join('');
}

export function goldRowsMatch(actual: unknown[], gold: unknown[], options: GoldRowMatchOptions = {}): GoldRowMatch {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (!Array.isArray(actual) || !Array.isArray(gold)) return { match: false, reason: 'rows must be arrays' };
  if (actual.length !== gold.length) {
    return { match: false, reason: `returned ${actual.length} row(s); the correct answer has ${gold.length}` };
  }
  if (actual.length === 0) return { match: true };
  if (options.allowExtraColumns) return extraColumnMatch(actual, gold, options, tolerance);

  const actualKeys = actual.map((row) => rowKey(row, tolerance));
  const goldKeys = gold.map((row) => rowKey(row, tolerance));
  if (options.ordered) {
    const index = goldKeys.findIndex((key, position) => key !== actualKeys[position]);
    return index === -1 ? { match: true } : { match: false, reason: `row ${index + 1} differs from the correct answer` };
  }
  const remaining = new Map<string, number>();
  for (const key of goldKeys) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  for (const key of actualKeys) {
    const count = remaining.get(key) ?? 0;
    if (count === 0) return { match: false, reason: 'a returned row is not in the correct answer' };
    remaining.set(key, count - 1);
  }
  return { match: true };
}

/**
 * Every correct-answer column must be found among the returned columns, by
 * values; extra returned columns are ignored. Columns are paired by their
 * sorted values, then the chosen columns must also agree row by row.
 */
function extraColumnMatch(actual: unknown[], gold: unknown[], options: GoldRowMatchOptions, tolerance: number): GoldRowMatch {
  const columns = (rows: unknown[]) => {
    const width = rowValues(rows[0]).length;
    return Array.from({ length: width }, (_, column) => rows.map((row) => normalizeGoldValue(rowValues(row)[column], tolerance)));
  };
  const goldColumns = columns(gold);
  const actualColumns = columns(actual);
  if (actualColumns.length < goldColumns.length) {
    return { match: false, reason: `returned ${actualColumns.length} column(s); the correct answer needs ${goldColumns.length}` };
  }
  const signature = (column: string[]) => [...column].sort().join('');
  const available = actualColumns.map(signature);
  const chosen: number[] = [];
  for (const column of goldColumns) {
    const wanted = signature(column);
    const index = available.findIndex((candidate, position) => candidate === wanted && !chosen.includes(position));
    if (index === -1) return { match: false, reason: 'a column of the correct answer is missing from the result' };
    chosen.push(index);
  }
  const projected = actual.map((row) => chosen.map((position) => rowValues(row)[position]));
  return goldRowsMatch(projected, gold, { ...options, allowExtraColumns: false });
}
