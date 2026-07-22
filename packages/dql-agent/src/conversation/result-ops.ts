/**
 * Cross-result follow-up compute.
 *
 * A follow-up like "of the results above, what's the average?" or "sum those" or
 * "top 3 of these" should be answered from the ROWS the previous turn already
 * returned — not by re-running a fresh warehouse query. This module detects that
 * intent and computes the answer deterministically over the prior result rows.
 *
 * It is intentionally conservative: it only fires when the question clearly
 * refers back to the prior result (a demonstrative like "these/those/above")
 * AND names an aggregate or a re-rank. Anything ambiguous falls through to the
 * normal cascade, which builds a fresh governed query.
 *
 * It is also HONEST about scope: the persisted prior rows are a bounded sample.
 * When the full result had more rows than we retained, the answer says so and
 * points the user at re-asking as a fresh query for the exact full-set figure.
 */

export type ResultSetAggregate = 'avg' | 'sum' | 'count' | 'min' | 'max' | 'median';

export interface ResultSetOperation {
  kind: 'aggregate' | 'rerank';
  aggregate?: ResultSetAggregate;
  /** A column name the user referenced, if any (matched loosely against columns). */
  columnHint?: string;
  /** For rerank: how many rows and which end. */
  topK?: { n: number; direction: 'top' | 'bottom' };
}

export interface PriorResultData {
  columns: string[];
  /** Rows aligned to `columns` (the persisted bounded sample). */
  rows: unknown[][];
  /** Columns that hold numeric measures (preferred aggregate targets). */
  measureColumns?: string[];
  /** Full result row count — may exceed rows.length (sample bound). */
  rowCount?: number;
}

export interface ResultSetComputation {
  text: string;
  /** Present for rerank (a sub-table) — aligned to the prior columns. */
  result?: { columns: string[]; rows: unknown[][]; rowCount: number };
  /** The column the aggregate ran over (for aggregate ops). */
  targetColumn?: string;
  /** Rows the computation actually covered. */
  coveredRows: number;
  /** Full result size, when known. */
  ofRowCount?: number;
  /** True when coveredRows < ofRowCount (computed over a sample, not the full set). */
  partial: boolean;
}

// A demonstrative back-reference to the prior result. Required — this is what
// keeps a fresh question ("what is total revenue") from being treated as an
// operation over nothing.
const BACK_REFERENCE_RE = /\b(these|those|them|the\s+(?:results?|list|rows?|ones?|values?|numbers?)|above|shown\s+above|listed\s+above|from\s+(?:the\s+)?(?:results?|above|list))\b/i;

const AGGREGATE_PATTERNS: Array<{ re: RegExp; aggregate: ResultSetAggregate }> = [
  { re: /\b(average|avg|mean)\b/i, aggregate: 'avg' },
  { re: /\b(median)\b/i, aggregate: 'median' },
  { re: /\b(sum|total|combined|altogether|added\s+up)\b/i, aggregate: 'sum' },
  { re: /\b(how\s+many|count|number\s+of)\b/i, aggregate: 'count' },
  { re: /\b(minimum|min|lowest|smallest|least)\b/i, aggregate: 'min' },
  { re: /\b(maximum|max|highest|largest|most|greatest)\b/i, aggregate: 'max' },
];

/**
 * Detect a cross-result operation. Returns null unless the question both refers
 * back to the prior result AND names an aggregate or a re-rank.
 */
export function detectResultSetOperation(question: string): ResultSetOperation | null {
  const q = question.trim();
  if (!q) return null;
  if (!BACK_REFERENCE_RE.test(q)) return null;

  // Re-rank: "top 3 of these", "bottom 5 of those", "highest 3 above".
  const rerank = /\b(top|bottom|highest|lowest|first|last)\s+(\d{1,3})\b/i.exec(q)
    ?? /\b(\d{1,3})\s+(highest|lowest|top|bottom)\b/i.exec(q);
  if (rerank) {
    const nRaw = rerank[2] && /^\d+$/.test(rerank[2]) ? rerank[2] : rerank[1];
    const dirToken = (rerank[1] + ' ' + (rerank[2] ?? '')).toLowerCase();
    const n = Number.parseInt(nRaw, 10);
    if (Number.isFinite(n) && n > 0) {
      const direction: 'top' | 'bottom' = /\b(bottom|lowest|last)\b/.test(dirToken) ? 'bottom' : 'top';
      return { kind: 'rerank', topK: { n, direction }, columnHint: extractColumnHint(q) };
    }
  }

  for (const { re, aggregate } of AGGREGATE_PATTERNS) {
    if (re.test(q)) {
      return { kind: 'aggregate', aggregate, columnHint: extractColumnHint(q) };
    }
  }
  return null;
}

/** Loosely pull a column phrase the user mentioned ("average of the bcm"). */
function extractColumnHint(question: string): string | undefined {
  const m = /\b(?:of|for|by|in)\s+(?:the\s+)?([a-z][a-z0-9_ ]{1,40}?)\b(?:\s+(?:above|column|value|of\s+these|of\s+those))?/i.exec(question);
  return m ? m[1].trim() : undefined;
}

/** Parse a cell into a number, tolerating $, commas, %, and whitespace. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,%\s]/g, '');
    if (cleaned === '' || cleaned === '-') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isNumericColumn(rows: unknown[][], index: number): boolean {
  let numeric = 0;
  let total = 0;
  for (const row of rows) {
    const cell = row[index];
    if (cell === null || cell === undefined || cell === '') continue;
    total += 1;
    if (toNumber(cell) !== null) numeric += 1;
  }
  return total > 0 && numeric / total >= 0.6;
}

/** Resolve which column an aggregate/rerank should target. */
function resolveTargetColumn(op: ResultSetOperation, prior: PriorResultData): number {
  const lowerCols = prior.columns.map((c) => c.toLowerCase());
  // A named hint wins when it matches a real column.
  if (op.columnHint) {
    const hint = op.columnHint.toLowerCase().replace(/\s+/g, '');
    const byName = lowerCols.findIndex((c) => c.replace(/[_\s]+/g, '').includes(hint) || hint.includes(c.replace(/[_\s]+/g, '')));
    if (byName >= 0) return byName;
  }
  // Prefer a declared measure column that is actually numeric.
  for (const measure of prior.measureColumns ?? []) {
    const idx = lowerCols.indexOf(measure.toLowerCase());
    if (idx >= 0 && isNumericColumn(prior.rows, idx)) return idx;
  }
  // Otherwise the last numeric column (measures usually sit rightmost).
  for (let i = prior.columns.length - 1; i >= 0; i -= 1) {
    if (isNumericColumn(prior.rows, i)) return i;
  }
  return -1;
}

function formatNumber(value: number): string {
  const rounded = Math.abs(value) >= 1000 || Number.isInteger(value)
    ? Math.round(value * 100) / 100
    : Math.round(value * 10000) / 10000;
  return rounded.toLocaleString('en-US');
}

/**
 * Compute the operation over the prior result rows. Returns null when there is
 * nothing to compute (no rows, or no numeric column for a numeric aggregate).
 */
export function computeResultSetOperation(
  op: ResultSetOperation,
  prior: PriorResultData,
): ResultSetComputation | null {
  const rows = prior.rows.filter((row) => Array.isArray(row));
  const coveredRows = rows.length;
  const ofRowCount = typeof prior.rowCount === 'number' ? prior.rowCount : undefined;
  const partial = ofRowCount !== undefined && ofRowCount > coveredRows;
  if (coveredRows === 0) return null;

  const scopeNote = partial
    ? ` (computed over the ${coveredRows} rows shown; the full result had ${ofRowCount} — re-ask as a fresh query for the exact full-set figure)`
    : ` (computed over all ${coveredRows} rows shown)`;

  // COUNT needs no numeric column.
  if (op.kind === 'aggregate' && op.aggregate === 'count') {
    const total = ofRowCount ?? coveredRows;
    return {
      text: partial
        ? `The result had ${formatNumber(total)} rows (${coveredRows} are shown above).`
        : `There are ${formatNumber(total)} rows in the result above.`,
      coveredRows,
      ofRowCount,
      partial,
    };
  }

  const colIndex = resolveTargetColumn(op, prior);
  if (colIndex < 0) return null;
  const columnName = prior.columns[colIndex];

  if (op.kind === 'rerank' && op.topK) {
    const sorted = [...rows]
      .map((row) => ({ row, value: toNumber(row[colIndex]) }))
      .filter((entry) => entry.value !== null)
      .sort((a, b) => op.topK!.direction === 'bottom' ? a.value! - b.value! : b.value! - a.value!)
      .slice(0, op.topK.n)
      .map((entry) => entry.row);
    if (sorted.length === 0) return null;
    return {
      text: `The ${op.topK.direction === 'bottom' ? 'bottom' : 'top'} ${sorted.length} by ${columnName}, from the results above${partial ? ` (of ${ofRowCount} total)` : ''}.`,
      result: { columns: prior.columns, rows: sorted, rowCount: sorted.length },
      targetColumn: columnName,
      coveredRows,
      ofRowCount,
      partial,
    };
  }

  const values = rows.map((row) => toNumber(row[colIndex])).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  let computed: number;
  let verb: string;
  switch (op.aggregate) {
    case 'avg': computed = values.reduce((a, b) => a + b, 0) / values.length; verb = 'average'; break;
    case 'sum': computed = values.reduce((a, b) => a + b, 0); verb = 'sum'; break;
    case 'min': computed = Math.min(...values); verb = 'minimum'; break;
    case 'max': computed = Math.max(...values); verb = 'maximum'; break;
    case 'median': {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      computed = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      verb = 'median';
      break;
    }
    default: return null;
  }
  return {
    text: `The ${verb} of ${columnName} is ${formatNumber(computed)}${scopeNote}.`,
    targetColumn: columnName,
    coveredRows,
    ofRowCount,
    partial,
  };
}
