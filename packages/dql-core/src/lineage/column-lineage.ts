/**
 * Column-level lineage extractor.
 *
 * Parses a DQL block's SQL with `node-sql-parser` to produce a list of
 * output columns each tagged with the source `table.column` (or columns)
 * they derive from. Used by the manifest builder to populate the
 * `outputs[*].lineage` field documented in
 * manifest-spec/schemas/v1/dql-manifest.schema.json.
 *
 * Scope of v1:
 *   - Single-SELECT statements (no UNION / no top-level CTE chains yet).
 *   - Common shapes: `SELECT col`, `SELECT t.col`, `SELECT col AS alias`,
 *     `SELECT SUM(col) AS metric`, `SELECT a + b AS c`.
 *   - Star expansion is reported as a single `*` entry with `unresolved`.
 *   - Anything else (subqueries in select list, complex CASE,
 *     window functions, UNION) parses cleanly but the column entry is
 *     marked `unresolved: true`. The caller falls back to table-level
 *     lineage in that case.
 *
 * Phase 2.4 follow-up will expand to CTEs and joins with alias chains.
 */

// node-sql-parser ships as CommonJS — destructure the default import for ESM consumers.
import nodeSqlParserPkg from 'node-sql-parser';
const { Parser } = nodeSqlParserPkg;

export interface ColumnSource {
  table: string;
  column: string;
}

export interface ColumnLineageEntry {
  /** Output column name; alias when present, else the bare source column. */
  name: string;
  /** True if the column is an aggregate (SUM, COUNT, AVG, MIN, MAX, COUNT(DISTINCT), …). */
  isAggregate?: boolean;
  /** The aggregate function name when isAggregate is true. */
  aggregateFn?: string;
  /**
   * Source bindings (one per source column the output references). May be
   * empty when the column is a literal or fully-computed expression.
   */
  sources: ColumnSource[];
  /**
   * True when the entry could not be fully resolved (e.g. star expansion,
   * subquery, deeply nested CASE). The caller should fall back to
   * table-level lineage for unresolved entries.
   */
  unresolved?: boolean;
}

export interface ColumnLineageResult {
  /** True if SQL parsed AND we extracted at least one column entry. */
  parsed: boolean;
  /** Output columns in the order they appear in the SELECT list. */
  columns: ColumnLineageEntry[];
  /** Tables resolved from the FROM/JOIN clauses (best-effort, alias-aware). */
  tables: string[];
  /** Parse-error message when `parsed === false`. */
  error?: string;
}

const AGG_FUNCTIONS = new Set([
  'sum',
  'count',
  'avg',
  'average',
  'min',
  'max',
  'median',
  'stddev',
  'stddev_pop',
  'stddev_samp',
  'variance',
  'var_pop',
  'var_samp',
  'array_agg',
  'string_agg',
]);

const DEFAULT_DIALECT = 'duckdb';

const DIALECT_MAP: Record<string, string> = {
  duckdb: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  bigquery: 'bigquery',
  snowflake: 'snowflake',
  redshift: 'redshift',
  mssql: 'transactsql',
  sqlite: 'sqlite',
};

export function extractColumnLineage(sql: string, dialect = DEFAULT_DIALECT): ColumnLineageResult {
  const parser = new Parser();
  let astRoot: unknown;
  try {
    astRoot = parser.astify(sql, { database: DIALECT_MAP[dialect.toLowerCase()] ?? 'postgresql' });
  } catch (err) {
    return {
      parsed: false,
      columns: [],
      tables: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const stmts = Array.isArray(astRoot) ? astRoot : [astRoot];
  const select = stmts.find((s): s is Record<string, unknown> => isSelectNode(s));
  if (!select) {
    return {
      parsed: false,
      columns: [],
      tables: [],
      error: 'No SELECT statement found in block SQL.',
    };
  }

  const aliasToTable = collectFromAliases(select);
  const tables = Array.from(new Set(Object.values(aliasToTable))).filter(Boolean);
  const columns: ColumnLineageEntry[] = [];
  const columnsAst = (select.columns ?? []) as unknown;

  if (columnsAst === '*' || (Array.isArray(columnsAst) && columnsAst.length === 0)) {
    columns.push({ name: '*', sources: [], unresolved: true });
  } else if (Array.isArray(columnsAst)) {
    for (const entry of columnsAst) {
      columns.push(extractColumnEntry(entry as Record<string, unknown>, aliasToTable, tables));
    }
  }

  return {
    parsed: columns.length > 0,
    columns,
    tables,
  };
}

function isSelectNode(node: unknown): boolean {
  return Boolean(node && typeof node === 'object' && (node as { type?: string }).type === 'select');
}

function collectFromAliases(select: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  const fromList = select.from;
  if (!Array.isArray(fromList)) return map;
  for (const entry of fromList) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const tableName = typeof e.table === 'string' ? e.table : undefined;
    if (!tableName) continue;
    const alias = typeof e.as === 'string' && e.as ? e.as : tableName;
    map[alias] = tableName;
  }
  return map;
}

function extractColumnEntry(
  entry: Record<string, unknown>,
  aliasToTable: Record<string, string>,
  tables: string[],
): ColumnLineageEntry {
  const expr = entry.expr as Record<string, unknown> | undefined;
  const explicitAlias = extractAlias(entry);

  if (!expr) {
    return { name: explicitAlias ?? '?', sources: [], unresolved: true };
  }

  const exprType = expr.type as string | undefined;

  // Bare column reference: SELECT col, SELECT t.col
  if (exprType === 'column_ref') {
    const tableAlias = (expr.table as string | null | undefined) ?? null;
    const columnName = readColumnRefName(expr);
    const resolvedTable = tableAlias
      ? aliasToTable[tableAlias] ?? tableAlias
      : tables.length === 1
        ? tables[0]
        : '';
    if (columnName === '*') {
      const starName = explicitAlias ?? (tableAlias ? `${tableAlias}.*` : '*');
      return {
        name: starName,
        sources: resolvedTable ? [{ table: resolvedTable, column: '*' }] : [],
        unresolved: true,
      };
    }
    return {
      name: explicitAlias ?? columnName,
      sources: resolvedTable ? [{ table: resolvedTable, column: columnName }] : [],
    };
  }

  // Aggregate or function call
  if (exprType === 'aggr_func' || exprType === 'function') {
    const rawFnName = readFunctionName(expr);
    const fnLower = rawFnName.toLowerCase();
    const isAggregate = exprType === 'aggr_func' || AGG_FUNCTIONS.has(fnLower);
    const args = expr.args as Record<string, unknown> | undefined;
    const sources = collectColumnRefs(args, aliasToTable, tables);
    return {
      name: explicitAlias ?? fnLower,
      isAggregate: isAggregate || undefined,
      aggregateFn: isAggregate ? rawFnName.toUpperCase() : undefined,
      sources,
      unresolved: !explicitAlias && !isAggregate ? true : undefined,
    };
  }

  // Binary expression: a + b, etc.
  if (exprType === 'binary_expr') {
    const sources = collectColumnRefs(expr, aliasToTable, tables);
    return {
      name: explicitAlias ?? 'expr',
      sources,
      unresolved: !explicitAlias ? true : undefined,
    };
  }

  // Literal / number / string — no source column
  if (exprType === 'number' || exprType === 'string' || exprType === 'bool' || exprType === 'null') {
    return {
      name: explicitAlias ?? String(expr.value ?? ''),
      sources: [],
    };
  }

  // Anything else: parse it for column refs and mark unresolved.
  return {
    name: explicitAlias ?? exprType ?? '?',
    sources: collectColumnRefs(expr, aliasToTable, tables),
    unresolved: true,
  };
}

function extractAlias(entry: Record<string, unknown>): string | undefined {
  const as = entry.as;
  if (typeof as === 'string' && as.length > 0) return as;
  return undefined;
}

/**
 * node-sql-parser >= v5 wraps column names as
 * `column: { expr: { type: 'default', value: 'foo' } }` (sometimes
 * `'backtick_quote_string'`, etc.). Older shapes used a plain string. Read
 * either form into a bare string.
 */
function readColumnRefName(ref: Record<string, unknown>): string {
  const col = ref.column;
  if (typeof col === 'string') return col;
  if (col && typeof col === 'object') {
    const expr = (col as { expr?: Record<string, unknown> }).expr;
    if (expr && typeof expr === 'object') {
      const value = (expr as { value?: unknown }).value;
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

/**
 * Function calls hold their name either as a plain string (older AST) or
 * as `name: [{ type: 'origin', value: 'SUM' }]` (newer AST). Normalise.
 */
function readFunctionName(expr: Record<string, unknown>): string {
  const name = expr.name;
  if (typeof name === 'string') return name;
  if (Array.isArray(name) && name.length > 0) {
    const head = name[0] as Record<string, unknown> | undefined;
    if (head) {
      if (typeof head.value === 'string') return head.value;
      if (typeof head.name === 'string') return head.name;
    }
  }
  return '';
}

// ---- ref()-aware parent → child column usage (output-contract drift) ----

/**
 * Per-child-block column usage discovered in a parent block's SQL. `block` is
 * the child block name (the `ref()` argument); `columns` are the child columns
 * the parent references — qualified (`alias.col`) or, when the parent's only
 * source is a single `ref()`, unqualified columns too.
 */
export interface RefColumnUsage {
  block: string;
  columns: string[];
}

/**
 * Extract, per `ref()`'d child block, the columns a parent block's SQL
 * references. Powers output-contract drift detection: each returned column is
 * checked against the child block's current output schema.
 *
 * In DQL, `ref("child")` appears in a FROM/JOIN clause and parses (via
 * node-sql-parser) as a *function* call — not a `table` node — so the standard
 * column-lineage table resolver does not see it. This walker special-cases
 * that shape: it maps each `ref(...)` source to its alias, then attributes
 * column references back to the child block by alias. Unqualified columns are
 * attributed only when there is exactly one `ref()` source and no other table
 * in the FROM clause (so we never guess wrong on joins).
 *
 * Conservative by design: anything ambiguous yields no usage rather than a
 * false-positive drift warning. Returns one entry per distinct child block.
 */
export function extractRefColumnUsage(sql: string, dialect = DEFAULT_DIALECT): RefColumnUsage[] {
  const parser = new Parser();
  let astRoot: unknown;
  try {
    astRoot = parser.astify(sql, { database: DIALECT_MAP[dialect.toLowerCase()] ?? 'postgresql' });
  } catch {
    return [];
  }

  const stmts = Array.isArray(astRoot) ? astRoot : [astRoot];
  const select = stmts.find((s): s is Record<string, unknown> => isSelectNode(s));
  if (!select) return [];

  // Map ref-alias -> child block name. Also track non-ref relations so we know
  // whether unqualified columns can be safely attributed to a single ref.
  const aliasToBlock = new Map<string, string>();
  let nonRefRelationCount = 0;
  const fromList = select.from;
  if (Array.isArray(fromList)) {
    for (const entry of fromList) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const childBlock = readRefFunctionArg(e.expr);
      if (childBlock) {
        const alias = typeof e.as === 'string' && e.as ? e.as : childBlock;
        aliasToBlock.set(alias, childBlock);
      } else if (typeof e.table === 'string' && e.table) {
        nonRefRelationCount += 1;
      }
    }
  }

  if (aliasToBlock.size === 0) return [];

  const soleRefBlock =
    aliasToBlock.size === 1 && nonRefRelationCount === 0
      ? [...aliasToBlock.values()][0]
      : undefined;

  // Collect column refs across the whole statement (SELECT list, WHERE, etc.),
  // skipping the FROM clause so the ref() argument string is not counted.
  const usage = new Map<string, Set<string>>();
  const ensure = (block: string): Set<string> => {
    let set = usage.get(block);
    if (!set) {
      set = new Set<string>();
      usage.set(block, set);
    }
    return set;
  };

  const visit = (value: unknown, insideFrom: boolean): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, insideFrom);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (!insideFrom && obj.type === 'column_ref') {
      const column = readColumnRefName(obj);
      if (column && column !== '*') {
        const tableAlias = (obj.table as string | null | undefined) ?? null;
        if (tableAlias && aliasToBlock.has(tableAlias)) {
          ensure(aliasToBlock.get(tableAlias)!).add(column);
        } else if (!tableAlias && soleRefBlock) {
          ensure(soleRefBlock).add(column);
        }
      }
      return;
    }
    for (const [key, child] of Object.entries(obj)) {
      visit(child, insideFrom || key === 'from');
    }
  };

  visit(select, false);

  return [...usage.entries()].map(([block, columns]) => ({
    block,
    columns: [...columns],
  }));
}

/**
 * If `expr` is a `ref('name')` / `ref("name")` function call in a FROM clause,
 * return the referenced block name; otherwise undefined. node-sql-parser
 * encodes the string argument either as a quoted-string literal or as a
 * `column_ref` whose column expr holds the value.
 */
function readRefFunctionArg(expr: unknown): string | undefined {
  if (!expr || typeof expr !== 'object') return undefined;
  const e = expr as Record<string, unknown>;
  if (e.type !== 'function') return undefined;
  if (readCallName(e.name).toLowerCase() !== 'ref') return undefined;
  const args = e.args as Record<string, unknown> | undefined;
  const list = (args?.value ?? args) as unknown;
  const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) return undefined;
  // Quoted-string literal form: { type: 'single_quote_string', value: 'name' }
  if (typeof first.value === 'string') return first.value;
  // column_ref form: { type: 'column_ref', column: { expr: { value: 'name' } } }
  if (first.type === 'column_ref') {
    const name = readColumnRefName(first);
    if (name) return name;
  }
  return undefined;
}

/**
 * Read a function/relation call name across node-sql-parser shapes. FROM-clause
 * function relations wrap the name as `{ name: [{ value: 'ref' }] }` (an object
 * around the array), distinct from the bare-string / bare-array forms handled
 * by `readFunctionName`. Normalise all three to a plain string.
 */
function readCallName(name: unknown): string {
  if (typeof name === 'string') return name;
  if (Array.isArray(name)) return readFunctionName({ name });
  if (name && typeof name === 'object') {
    const inner = (name as { name?: unknown }).name;
    if (Array.isArray(inner)) return readFunctionName({ name: inner });
    if (typeof inner === 'string') return inner;
  }
  return '';
}

function collectColumnRefs(
  node: unknown,
  aliasToTable: Record<string, string>,
  tables: string[],
): ColumnSource[] {
  const out: ColumnSource[] = [];
  const seen = new Set<string>();

  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (obj.type === 'column_ref') {
      const column = readColumnRefName(obj);
      if (!column || column === '*') return;
      const tableAlias = (obj.table as string | null | undefined) ?? null;
      const resolvedTable = tableAlias
        ? aliasToTable[tableAlias] ?? tableAlias
        : tables.length === 1
          ? tables[0]
          : '';
      const key = `${resolvedTable}.${column}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ table: resolvedTable, column });
      return;
    }
    for (const v of Object.values(obj)) visit(v);
  }

  visit(node);
  return out;
}
