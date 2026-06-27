/**
 * Invariant evaluator.
 *
 * A block's `invariants` are free-form assertions (e.g. `"approval_rate_pct <= 100"`,
 * `"health_score between 0 and 100"`, `"arr >= 0"`) that must hold for the block's
 * result set. Until now they were stored in the manifest and surfaced to agents as
 * prompt grounding, but never executed — so "certified" did not mean "the stated
 * guarantees hold".
 *
 * This module parses each invariant string into a checkable predicate over result
 * columns and evaluates it against the block's result rows. It is a SMALL, SAFE
 * evaluator: it never calls `eval()` / `Function()`. Anything it cannot parse is
 * reported as an "uncheckable invariant" warning rather than failing closed.
 *
 * Supported forms (case-insensitive on keywords):
 *   - comparisons:      `<column> <op> <number>`  where op is `>= <= > < == = != <>`
 *   - between:          `<column> between <low> and <high>`  (inclusive)
 *   - not between:      `<column> not between <low> and <high>`
 *   - null checks:      `<column> is null` / `<column> is not null`
 *   - non-negative etc. handled by the comparison form (`arr >= 0`).
 *
 * The column is checked across EVERY row; a single-value result is just one row.
 * An invariant passes only if it holds for all rows. The first violating row is
 * reported in `detail` so the failure is actionable.
 */

/** Outcome of evaluating a single invariant against a result set. */
export interface InvariantResult {
  /** The original invariant expression string, verbatim. */
  expr: string;
  /** True when the invariant held for every row (or was vacuously true for an empty result). */
  passed: boolean;
  /**
   * True when the invariant string could not be parsed into a checkable predicate.
   * Uncheckable invariants do NOT count as violations — they are surfaced as
   * warnings so authors can fix the wording. `passed` is true for these so they
   * never block certification.
   */
  uncheckable?: boolean;
  /** Human-readable explanation of the pass / fail / uncheckable outcome. */
  detail: string;
}

/** A minimal, column/row-shaped view of a block result the evaluator can read. */
export interface InvariantResultSet {
  /** Column names present in the result. */
  columns: string[];
  /** Result rows keyed by column name. A scalar result is a single row. */
  rows: Array<Record<string, unknown>>;
}

type Comparator = '>=' | '<=' | '>' | '<' | '==' | '!=';

interface ComparisonPredicate {
  kind: 'comparison';
  column: string;
  op: Comparator;
  value: number;
}

interface BetweenPredicate {
  kind: 'between';
  column: string;
  low: number;
  high: number;
  negated: boolean;
}

interface NullPredicate {
  kind: 'null';
  column: string;
  negated: boolean; // `is not null`
}

type Predicate = ComparisonPredicate | BetweenPredicate | NullPredicate;

interface ParseFailure {
  kind: 'unparseable';
  reason: string;
}

type ParseOutcome = Predicate | ParseFailure;

const COMPARATORS: Comparator[] = ['>=', '<=', '!=', '==', '>', '<'];

/**
 * Parse a single invariant string into a checkable predicate, or a parse failure
 * describing why it is uncheckable. Pure / side-effect free.
 */
export function parseInvariant(raw: string): ParseOutcome {
  const expr = raw.trim();
  if (!expr) {
    return { kind: 'unparseable', reason: 'empty invariant' };
  }

  // null checks: `<column> is null` / `<column> is not null`
  const nullMatch = /^(.+?)\s+is\s+(not\s+)?null$/i.exec(expr);
  if (nullMatch) {
    const column = normalizeColumn(nullMatch[1]);
    if (!column) return { kind: 'unparseable', reason: 'missing column before "is null"' };
    return { kind: 'null', column, negated: Boolean(nullMatch[2]) };
  }

  // between: `<column> [not] between <low> and <high>`
  const betweenMatch = /^(.+?)\s+(not\s+)?between\s+(\S+)\s+and\s+(\S+)$/i.exec(expr);
  if (betweenMatch) {
    const column = normalizeColumn(betweenMatch[1]);
    const low = parseNumber(betweenMatch[3]);
    const high = parseNumber(betweenMatch[4]);
    if (!column) return { kind: 'unparseable', reason: 'missing column before "between"' };
    if (low === null || high === null) {
      return { kind: 'unparseable', reason: 'between bounds must be numeric' };
    }
    return { kind: 'between', column, low, high, negated: Boolean(betweenMatch[2]) };
  }

  // comparison: `<column> <op> <number>` — try the longest operators first so
  // `>=` is not mis-read as `>`.
  for (const op of COMPARATORS) {
    const idx = expr.indexOf(op);
    if (idx <= 0) continue;
    // Guard against `==` being seen inside `===` or `<op>` overlaps; we only
    // accept a clean single operator split.
    const left = expr.slice(0, idx).trim();
    const right = expr.slice(idx + op.length).trim();
    // Reject if the right side still starts with another comparator char that
    // would have formed a longer operator (e.g. catching `<` inside `<=`).
    if (/^[<>=!]/.test(right)) continue;
    const column = normalizeColumn(left);
    const value = parseNumber(right);
    if (!column) continue;
    if (value === null) {
      return { kind: 'unparseable', reason: `right-hand side "${right}" is not numeric` };
    }
    return { kind: 'comparison', column, op, value };
  }

  // `=` (single) as an alias for `==`, handled last so it doesn't shadow `>=`/`<=`/`!=`.
  const eqIdx = expr.indexOf('=');
  if (eqIdx > 0 && !/[<>=!]/.test(expr[eqIdx - 1] ?? '') && expr[eqIdx + 1] !== '=') {
    const left = expr.slice(0, eqIdx).trim();
    const right = expr.slice(eqIdx + 1).trim();
    const column = normalizeColumn(left);
    const value = parseNumber(right);
    if (column && value !== null) {
      return { kind: 'comparison', column, op: '==', value };
    }
  }

  return { kind: 'unparseable', reason: 'no recognized comparison, between, or null check' };
}

/**
 * Evaluate a single invariant string against a result set.
 *
 * Always returns an {@link InvariantResult}; it never throws. Unparseable
 * invariants and references to missing columns are reported as `uncheckable`
 * (passed = true) so they warn rather than block.
 */
export function evaluateInvariant(raw: string, result: InvariantResultSet): InvariantResult {
  const expr = raw.trim();
  const parsed = parseInvariant(expr);
  if (parsed.kind === 'unparseable') {
    return {
      expr,
      passed: true,
      uncheckable: true,
      detail: `Uncheckable invariant — ${parsed.reason}. Surfaced as a warning; not enforced.`,
    };
  }

  const column = parsed.column;
  if (!result.columns.includes(column)) {
    return {
      expr,
      passed: true,
      uncheckable: true,
      detail: `Uncheckable invariant — column "${column}" not found in result columns [${result.columns.join(', ')}].`,
    };
  }

  // Vacuously true for an empty result: there is no row that violates it.
  if (result.rows.length === 0) {
    return { expr, passed: true, detail: 'No rows to check — invariant vacuously holds.' };
  }

  for (let i = 0; i < result.rows.length; i++) {
    const cell = result.rows[i][column];
    const check = checkCell(parsed, cell);
    if (!check.ok) {
      const where = result.rows.length === 1 ? '' : ` (row ${i + 1} of ${result.rows.length})`;
      return {
        expr,
        passed: false,
        detail: `Violated${where}: ${check.reason}`,
      };
    }
  }

  return {
    expr,
    passed: true,
    detail: result.rows.length === 1
      ? 'Holds for the result value.'
      : `Holds across all ${result.rows.length} rows.`,
  };
}

/**
 * Evaluate every invariant in `invariants` against `result`. Order-preserving.
 * Returns an empty array for an empty / undefined invariant list, so callers can
 * treat "no invariants" as "nothing to enforce".
 */
export function evaluateInvariants(
  invariants: string[] | undefined,
  result: InvariantResultSet,
): InvariantResult[] {
  if (!invariants || invariants.length === 0) return [];
  return invariants.map((invariant) => evaluateInvariant(invariant, result));
}

/** True when any of the supplied results is a real (checkable) violation. */
export function hasInvariantViolation(results: InvariantResult[] | undefined): boolean {
  if (!results) return false;
  return results.some((entry) => !entry.passed && !entry.uncheckable);
}

function checkCell(predicate: Predicate, cell: unknown): { ok: boolean; reason: string } {
  if (predicate.kind === 'null') {
    const isNull = cell === null || cell === undefined;
    if (predicate.negated) {
      return isNull
        ? { ok: false, reason: `${predicate.column} is null but expected NOT NULL` }
        : { ok: true, reason: '' };
    }
    return isNull
      ? { ok: true, reason: '' }
      : { ok: false, reason: `${predicate.column}=${formatCell(cell)} is not null` };
  }

  const num = toNumber(cell);
  if (num === null) {
    return {
      ok: false,
      reason: `${predicate.column}=${formatCell(cell)} is not numeric, cannot evaluate "${describe(predicate)}"`,
    };
  }

  if (predicate.kind === 'between') {
    const inRange = num >= predicate.low && num <= predicate.high;
    const pass = predicate.negated ? !inRange : inRange;
    if (pass) return { ok: true, reason: '' };
    return {
      ok: false,
      reason: `${predicate.column}=${num} is ${predicate.negated ? 'within' : 'outside'} [${predicate.low}, ${predicate.high}]`,
    };
  }

  const pass = compareNumbers(num, predicate.op, predicate.value);
  if (pass) return { ok: true, reason: '' };
  return { ok: false, reason: `${predicate.column}=${num} ${predicate.op} ${predicate.value} is false` };
}

function compareNumbers(actual: number, op: Comparator, expected: number): boolean {
  switch (op) {
    case '>=': return actual >= expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '<': return actual < expected;
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    default: return false;
  }
}

function describe(predicate: Predicate): string {
  if (predicate.kind === 'between') {
    return `${predicate.column} ${predicate.negated ? 'not ' : ''}between ${predicate.low} and ${predicate.high}`;
  }
  if (predicate.kind === 'null') {
    return `${predicate.column} is ${predicate.negated ? 'not ' : ''}null`;
  }
  return `${predicate.column} ${predicate.op} ${predicate.value}`;
}

function normalizeColumn(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["'`]|["'`]$/g, '').trim();
  if (!trimmed) return null;
  // A column reference must be a single identifier-ish token (allow dotted refs
  // like `table.column`). Anything with whitespace or an operator is not a bare
  // column and we treat the invariant as uncheckable.
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(trimmed)) return null;
  return trimmed;
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/^["'`]|["'`,]$/g, '').replace(/[%,]/g, '');
  if (cleaned === '') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function toNumber(cell: unknown): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell === 'bigint') return Number(cell);
  if (typeof cell === 'boolean') return cell ? 1 : 0;
  if (typeof cell === 'string') {
    const cleaned = cell.trim().replace(/[%,$]/g, '');
    if (cleaned === '') return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function formatCell(cell: unknown): string {
  if (cell === null) return 'null';
  if (cell === undefined) return 'undefined';
  if (typeof cell === 'string') return `"${cell}"`;
  return String(cell);
}
