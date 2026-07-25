/**
 * SQL reference extractors for lineage and generated-query validation.
 *
 * `extractTablesFromSql` intentionally stays lightweight for manifest lineage.
 * `analyzeSqlReferences` uses node-sql-parser for the stricter Tier-2 agent
 * validation path, where relation and column references must be checked against
 * an inspected context pack before SQL is executed.
 */

import nodeSqlParserPkg from 'node-sql-parser';

const { Parser } = nodeSqlParserPkg;

export interface SqlParseResult {
  /** External table dependencies (CTEs excluded) */
  tables: string[];
  /** CTE names defined in this query */
  ctes: string[];
  /** ref() calls found in the SQL */
  refs: string[];
  /** @metric() references found in the SQL */
  metricRefs: string[];
  /** @dim() references found in the SQL */
  dimensionRefs: string[];
}

export interface SqlColumnReference {
  column: string;
  tableAlias?: string;
  relation?: string;
  unqualified: boolean;
  /** True when this is a legal reference to a select-list alias. */
  outputAliasReference?: boolean;
}

/** An equality join condition `left.col = right.col`, aliases resolved to relations. */
export interface SqlJoinCondition {
  leftRelation?: string;
  leftColumn: string;
  rightRelation?: string;
  rightColumn: string;
  joinType?: string;
}

/** An aggregate function reference in the SELECT list, e.g. `SUM(o.amount)`. */
export interface SqlAggregateReference {
  func: string;
  distinct: boolean;
  column?: string;
  relation?: string;
}

/**
 * References owned by one SELECT scope. Keeping aliases scoped prevents an
 * inner CTE alias from being treated as a peer of an outer alias during
 * ambiguity validation.
 */
export interface SqlReferenceScope {
  id: string;
  columns: SqlColumnReference[];
  aliasToRelation: Record<string, string>;
  outputAliases: string[];
}

export interface SqlReferenceAnalysis {
  parsed: boolean;
  statementTypes: string[];
  tables: string[];
  ctes: string[];
  /** Query-internal FROM/JOIN subquery aliases, never physical relations. */
  derivedRelations: string[];
  columns: SqlColumnReference[];
  /** Equality join conditions (for grain / fan-out analysis). Empty when unparsed. */
  joins: SqlJoinCondition[];
  /** Aggregate function references in the SELECT list. Empty when unparsed. */
  aggregates: SqlAggregateReference[];
  aliasToRelation: Record<string, string>;
  scopes: SqlReferenceScope[];
  error?: string;
}

const DIALECT_MAP: Record<string, string> = {
  duckdb: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  bigquery: 'bigquery',
  snowflake: 'snowflake',
  redshift: 'redshift',
  databricks: 'hive',
  spark: 'hive',
  spark_sql: 'hive',
  hive: 'hive',
  mssql: 'transactsql',
  sqlserver: 'transactsql',
  azure_sql: 'transactsql',
  sqlite: 'sqlite',
};

/**
 * Extract table references from a SQL string.
 *
 * Identifies tables in FROM and JOIN clauses, filters out CTE definitions,
 * and detects ref("block_name") calls.
 */
export function extractTablesFromSql(sql: string): SqlParseResult {
  const ctes = extractCteNames(sql);

  // Strip comments first (refs inside comments should be ignored)
  const noComments = stripComments(sql);

  // Extract DuckDB reader functions BEFORE stripping string literals
  // (because the file path is inside quotes that would be stripped)
  const readerTables = extractReaderFunctions(noComments);

  // Strip non-ref string literals, then extract refs from the result.
  // This ensures ref("block") and ref('block') are preserved, but
  // 'ref("fake")' (a string literal containing ref) is stripped.
  const withoutStringLiterals = stripStringLiterals(noComments);
  const refs = extractRefs(withoutStringLiterals);

  // For table extraction, use the fully cleaned version
  const cleaned = withoutStringLiterals;

  const rawTables = new Set<string>();

  // FROM <table> — handles FROM table, FROM schema.table, FROM "table"
  const fromPattern = /\bFROM\s+(?:LATERAL\s+)?([a-zA-Z_][a-zA-Z0-9_.]*|"[^"]+")/gi;
  for (const match of cleaned.matchAll(fromPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // JOIN <table> — all join types
  const joinPattern = /\bJOIN\s+(?:LATERAL\s+)?([a-zA-Z_][a-zA-Z0-9_.]*|"[^"]+")/gi;
  for (const match of cleaned.matchAll(joinPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // INTO <table> (INSERT INTO, MERGE INTO)
  const intoPattern = /\bINTO\s+([a-zA-Z_][a-zA-Z0-9_.]*|"[^"]+")/gi;
  for (const match of cleaned.matchAll(intoPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // Add DuckDB reader function references (extracted before string stripping)
  for (const rt of readerTables) {
    rawTables.add(rt);
  }

  // Filter out CTEs, SQL keywords that might match, and DuckDB functions
  const sqlKeywords = new Set([
    'select', 'where', 'group', 'order', 'having', 'limit', 'offset',
    'union', 'except', 'intersect', 'values', 'set', 'lateral',
    'unnest', 'generate_series', 'read_csv_auto', 'read_csv', 'read_parquet',
    'read_json', 'read_json_auto', 'range', 'information_schema', 'ref',
  ]);

  const cteNamesLower = new Set(ctes.map((c) => c.toLowerCase()));

  const tables = [...rawTables].filter((t) => {
    const lower = t.toLowerCase();
    return !cteNamesLower.has(lower) && !sqlKeywords.has(lower);
  });

  // Extract @metric() and @dim() semantic references
  const metricRefs = extractSemanticRefs(noComments, 'metric');
  const dimensionRefs = extractSemanticRefs(noComments, 'dim');

  return { tables, ctes, refs, metricRefs, dimensionRefs };
}

export function analyzeSqlReferences(sql: string, dialect = 'duckdb'): SqlReferenceAnalysis {
  const parser = new Parser();
  let astRoot: unknown;
  try {
    astRoot = parser.astify(sql, { database: DIALECT_MAP[dialect.toLowerCase()] ?? 'postgresql' });
  } catch (err) {
    const fallback = extractTablesFromSql(sql);
    return {
      parsed: false,
      statementTypes: [],
      tables: fallback.tables,
      ctes: fallback.ctes,
      derivedRelations: [],
      columns: [],
      joins: [],
      aggregates: [],
      aliasToRelation: {},
      scopes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const statements = Array.isArray(astRoot) ? astRoot : [astRoot];
  const ctes = new Set(extractCteNames(sql).map((name) => normalizeSqlIdentifier(name)));
  const derivedRelations = new Set<string>();
  const tableRefs = new Map<string, string>();
  const aliasToRelation = new Map<string, string>();
  const statementTypes = new Set<string>();

  for (const statement of statements) {
    const type = readStatementType(statement);
    if (type) statementTypes.add(type);
    collectSqlTables(statement, {
      ctes,
      derivedRelations,
      tableRefs,
      aliasToRelation,
    });
  }

  const columns: SqlColumnReference[] = [];
  for (const statement of statements) {
    collectSqlColumns(statement, {
      ctes,
      derivedRelations,
      aliasToRelation,
      singleRelation: tableRefs.size === 1 ? Array.from(tableRefs.values())[0] : undefined,
      columns,
    });
  }

  const singleRelation = tableRefs.size === 1 ? Array.from(tableRefs.values())[0] : undefined;
  const joins: SqlJoinCondition[] = [];
  const aggregates: SqlAggregateReference[] = [];
  for (const statement of statements) {
    collectSqlJoins(statement, { ctes, aliasToRelation, joins });
    collectSqlAggregates(statement, { ctes, derivedRelations, aliasToRelation, singleRelation, aggregates });
  }
  const scopes = statements.flatMap((statement, index) =>
    collectSqlReferenceScopes(statement, `statement_${index + 1}`),
  );

  return {
    parsed: true,
    statementTypes: Array.from(statementTypes),
    tables: Array.from(tableRefs.values()),
    ctes: Array.from(ctes),
    derivedRelations: Array.from(derivedRelations),
    columns: dedupeColumnReferences(columns),
    joins,
    aggregates,
    aliasToRelation: Object.fromEntries(aliasToRelation),
    scopes,
  };
}

function collectSqlReferenceScopes(node: unknown, id: string): SqlReferenceScope[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const statement = node as Record<string, unknown>;
  const scopes: SqlReferenceScope[] = [];

  const withItems = Array.isArray(statement.with) ? statement.with : [];
  for (const [index, item] of withItems.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const cteName = cteNameFromNode(record) ?? `cte_${index + 1}`;
    const stmt = record.stmt;
    const stmtRecord = stmt && typeof stmt === 'object' && !Array.isArray(stmt)
      ? stmt as Record<string, unknown>
      : undefined;
    // node-sql-parser returns the SELECT directly for PostgreSQL/DuckDB and
    // wraps it in `{ ast }` for Snowflake.
    const ast = stmtRecord?.ast ?? stmtRecord;
    scopes.push(...collectSqlReferenceScopes(ast, `${id}:cte:${cteName}`));
  }

  if (readStatementType(statement) === 'select') {
    const aliasToRelation = directScopeAliases(statement);
    const physicalRelations = Array.from(new Set(aliasToRelation.values()));
    const outputAliases = directSelectOutputAliases(statement);
    const columns: SqlColumnReference[] = [];
    collectCurrentScopeColumns(statement, {
      aliasToRelation,
      singleRelation: physicalRelations.length === 1 ? physicalRelations[0] : undefined,
      outputAliases: new Set(outputAliases),
      columns,
    });
    scopes.push({
      id,
      columns: dedupeColumnReferences(columns),
      aliasToRelation: Object.fromEntries(aliasToRelation),
      outputAliases,
    });
  }

  collectNestedSelectScopes(statement, id, scopes);
  return dedupeReferenceScopes(scopes);
}

function cteNameFromNode(node: Record<string, unknown>): string | undefined {
  const raw = node.name;
  if (typeof raw === 'string') return normalizeSqlIdentifier(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = stringField(raw as Record<string, unknown>, 'value');
    if (value) return normalizeSqlIdentifier(value);
  }
  return undefined;
}

function directScopeAliases(statement: Record<string, unknown>): Map<string, string> {
  const aliases = new Map<string, string>();
  const from = Array.isArray(statement.from) ? statement.from : [];
  for (const item of from) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (derivedRelationAlias(record)) continue;
    const relation = relationFromTableNode(record);
    if (!relation || isSqlFunctionRelation(relation)) continue;
    const alias = stringField(record, 'as')
      ?? stringField(record, 'alias')
      ?? relation.split('.').at(-1);
    if (alias) aliases.set(normalizeSqlIdentifier(alias), relation);
  }
  return aliases;
}

function collectCurrentScopeColumns(
  node: unknown,
  state: {
    aliasToRelation: Map<string, string>;
    singleRelation?: string;
    outputAliases: Set<string>;
    columns: SqlColumnReference[];
  },
  root = true,
  clause?: string,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectCurrentScopeColumns(item, state, false, clause);
    return;
  }
  const record = node as Record<string, unknown>;
  if (!root && readStatementType(record) === 'select') return;
  if (record.type === 'column_ref') {
    const column = readColumnRefName(record);
    if (!column || column === '*') return;
    const rawTable = stringField(record, 'table');
    const tableAlias = rawTable ? normalizeSqlIdentifier(rawTable) : undefined;
    const normalizedClause = clause?.toLowerCase();
    const outputAliasReference = !rawTable
      && state.outputAliases.has(normalizeSqlIdentifier(column))
      && (normalizedClause === 'orderby'
        || normalizedClause === 'order_by'
        || normalizedClause === 'groupby'
        || normalizedClause === 'group_by'
        || normalizedClause === 'having'
        || normalizedClause === 'qualify');
    state.columns.push({
      column,
      tableAlias: rawTable,
      relation: tableAlias
        ? state.aliasToRelation.get(tableAlias) ?? rawTable
        : state.singleRelation,
      unqualified: !rawTable,
      ...(outputAliasReference ? { outputAliasReference: true } : {}),
    });
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'with') continue;
    collectCurrentScopeColumns(value, state, false, root ? key : clause);
  }
}

function directSelectOutputAliases(statement: Record<string, unknown>): string[] {
  const aliases: string[] = [];
  const columns = Array.isArray(statement.columns) ? statement.columns : [];
  for (const column of columns) {
    if (!column || typeof column !== 'object' || Array.isArray(column)) continue;
    const alias = stringField(column as Record<string, unknown>, 'as');
    if (alias) aliases.push(normalizeSqlIdentifier(alias));
  }
  return Array.from(new Set(aliases));
}

function collectNestedSelectScopes(
  node: unknown,
  parentId: string,
  scopes: SqlReferenceScope[],
  counter = { value: 0 },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectNestedSelectScopes(item, parentId, scopes, counter);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'with') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)
      && readStatementType(value as Record<string, unknown>) === 'select') {
      counter.value += 1;
      scopes.push(...collectSqlReferenceScopes(value, `${parentId}:subquery:${counter.value}`));
      continue;
    }
    collectNestedSelectScopes(value, parentId, scopes, counter);
  }
}

function dedupeReferenceScopes(scopes: SqlReferenceScope[]): SqlReferenceScope[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const signature = `${scope.id}|${JSON.stringify(scope.aliasToRelation)}|${scope.columns.map((column) => `${column.tableAlias ?? ''}.${column.column}`).join(',')}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/** Resolve a column_ref node's `table` alias to a relation (or undefined). */
function resolveColumnRefRelation(
  ref: Record<string, unknown>,
  aliasToRelation: Map<string, string>,
  singleRelation?: string,
): string | undefined {
  const rawTable = stringField(ref, 'table');
  if (!rawTable) return singleRelation;
  const alias = normalizeSqlIdentifier(rawTable);
  return aliasToRelation.get(alias) ?? rawTable;
}

/** Walk the AST collecting equality join conditions from ON clauses. */
function collectSqlJoins(
  node: unknown,
  state: { ctes: Set<string>; aliasToRelation: Map<string, string>; joins: SqlJoinCondition[] },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlJoins(item, state);
    return;
  }
  const obj = node as Record<string, unknown>;
  // A joined FROM entry carries both `join` (type) and `on` (condition tree).
  if (typeof obj.join === 'string' && obj.on && typeof obj.on === 'object') {
    collectEquiJoinColumns(obj.on, obj.join, state);
  }
  for (const value of Object.values(obj)) collectSqlJoins(value, state);
}

/** Extract every `col = col` equality (recursing through AND/OR) from an ON tree. */
function collectEquiJoinColumns(
  onNode: unknown,
  joinType: string,
  state: { aliasToRelation: Map<string, string>; joins: SqlJoinCondition[] },
): void {
  if (!onNode || typeof onNode !== 'object') return;
  const node = onNode as Record<string, unknown>;
  if (node.type === 'binary_expr') {
    const op = typeof node.operator === 'string' ? node.operator : '';
    const left = node.left as Record<string, unknown> | undefined;
    const right = node.right as Record<string, unknown> | undefined;
    if (op === '=' && left?.type === 'column_ref' && right?.type === 'column_ref') {
      const leftColumn = readColumnRefName(left);
      const rightColumn = readColumnRefName(right);
      if (leftColumn && rightColumn) {
        state.joins.push({
          leftRelation: resolveColumnRefRelation(left, state.aliasToRelation),
          leftColumn,
          rightRelation: resolveColumnRefRelation(right, state.aliasToRelation),
          rightColumn,
          joinType,
        });
      }
      return;
    }
    // AND / OR / other composite conditions: recurse into both sides.
    collectEquiJoinColumns(left, joinType, state);
    collectEquiJoinColumns(right, joinType, state);
  }
}

/** Walk the AST collecting aggregate function references. */
function collectSqlAggregates(
  node: unknown,
  state: {
    ctes: Set<string>;
    derivedRelations: Set<string>;
    aliasToRelation: Map<string, string>;
    singleRelation?: string;
    aggregates: SqlAggregateReference[];
  },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlAggregates(item, state);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'aggr_func' && typeof obj.name === 'string') {
    const args = obj.args as Record<string, unknown> | undefined;
    const argExpr = args?.expr as Record<string, unknown> | undefined;
    const distinct = typeof args?.distinct === 'string' && args.distinct.toUpperCase() === 'DISTINCT';
    let column: string | undefined;
    let relation: string | undefined;
    if (argExpr?.type === 'column_ref') {
      const name = readColumnRefName(argExpr);
      column = name === '*' ? undefined : name;
      const resolved = resolveColumnRefRelation(argExpr, state.aliasToRelation, state.singleRelation);
      relation = resolved && !state.derivedRelations.has(normalizeSqlIdentifier(resolved)) ? resolved : undefined;
    } else if (argExpr) {
      // Generated analytical SQL commonly wraps the measure before aggregation,
      // for example SUM(ROUND(COALESCE(o.amount, 0), 2)) or
      // SUM(o.unit_price * o.quantity). The old direct-column-only extraction
      // lost the owning relation for those expressions, which made the fan-out
      // guard blind to exactly the wrong-number queries it is meant to stop.
      // Attribute the aggregate when every referenced input belongs to one
      // physical relation; retain a column only when the expression has one
      // distinct input column.
      const refs = collectAggregateArgumentColumnRefs(
        argExpr,
        state.aliasToRelation,
        state.singleRelation,
        state.derivedRelations,
      );
      const relations = Array.from(new Set(refs.map((ref) => ref.relation).filter((value): value is string => Boolean(value))));
      const columns = Array.from(new Set(refs.map((ref) => ref.column).filter((value) => value !== '*')));
      if (relations.length === 1) relation = relations[0];
      if (columns.length === 1) column = columns[0];
    }
    state.aggregates.push({ func: obj.name.toUpperCase(), distinct, column, relation });
  }
  for (const value of Object.values(obj)) collectSqlAggregates(value, state);
}

function collectAggregateArgumentColumnRefs(
  node: unknown,
  aliasToRelation: Map<string, string>,
  singleRelation?: string,
  derivedRelations: Set<string> = new Set(),
): Array<{ column: string; relation?: string }> {
  const refs: Array<{ column: string; relation?: string }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'column_ref') {
      const column = readColumnRefName(record);
      if (column) {
        const resolved = resolveColumnRefRelation(record, aliasToRelation, singleRelation);
        refs.push({
          column,
          relation: resolved && !derivedRelations.has(normalizeSqlIdentifier(resolved)) ? resolved : undefined,
        });
      }
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(node);
  return refs;
}

/** Extract CTE names from WITH ... AS (...) patterns */
function extractCteNames(sql: string): string[] {
  const ctes: string[] = [];
  // Match WITH ... AS and recursive WITH
  const withPattern = /\bWITH\s+(?:RECURSIVE\s+)?/gi;
  const withMatch = withPattern.exec(sql);
  if (!withMatch) return ctes;

  // From the WITH keyword, extract comma-separated CTE definitions
  const afterWith = sql.slice(withMatch.index + withMatch[0].length);
  // AGT-005 / E2E-008: generated SQL commonly quotes internal aliases (for example Snowflake
  // emits `WITH "subq_2" AS (...)`). Treat every supported identifier quoting
  // style as a CTE name; otherwise the alias is later mistaken for a physical
  // warehouse relation and the validation probe tries to query it directly.
  const cteDefPattern = /("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[a-zA-Z_][a-zA-Z0-9_$]*)\s+AS\s*\(/gi;

  for (const match of afterWith.matchAll(cteDefPattern)) {
    const name = normalizeSqlIdentifier(match[1]);
    if (name) ctes.push(name);
  }

  return ctes;
}

function collectSqlTables(
  node: unknown,
  state: {
    ctes: Set<string>;
    derivedRelations: Set<string>;
    tableRefs: Map<string, string>;
    aliasToRelation: Map<string, string>;
  },
  parentKey?: string,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlTables(item, state, parentKey);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (parentKey === 'with' || parentKey === 'cte') {
    const cteName = stringField(obj, 'name') ?? stringField(obj, 'as');
    if (cteName) state.ctes.add(normalizeSqlIdentifier(cteName));
  }

  const derivedAlias = derivedRelationAlias(obj);
  if (derivedAlias) {
    state.derivedRelations.add(derivedAlias);
    state.aliasToRelation.set(derivedAlias, derivedAlias);
  }

  const relation = relationFromTableNode(obj);
  if (relation && obj.type !== 'column_ref') {
    const normalized = normalizeSqlIdentifier(relation);
    // Some parser dialects expose a quote token as a synthetic table node for
    // a quoted CTE. An empty normalized identifier is never a real relation.
    if (normalized) {
      const alias = stringField(obj, 'as') ?? stringField(obj, 'alias') ?? relation.split('.').at(-1);
      if (alias) {
        const normalizedAlias = normalizeSqlIdentifier(alias);
        if (normalizedAlias) state.aliasToRelation.set(normalizedAlias, relation);
      }
      if (!state.ctes.has(normalized) && !isSqlFunctionRelation(relation)) {
        state.tableRefs.set(normalized, relation);
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    collectSqlTables(value, state, key);
  }
}

function collectSqlColumns(
  node: unknown,
  state: {
    ctes: Set<string>;
    derivedRelations: Set<string>;
    aliasToRelation: Map<string, string>;
    singleRelation?: string;
    columns: SqlColumnReference[];
  },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlColumns(item, state);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (obj.type === 'column_ref') {
    const column = readColumnRefName(obj);
    if (column && column !== '*') {
      const rawTable = stringField(obj, 'table');
      const tableAlias = rawTable ? normalizeSqlIdentifier(rawTable) : undefined;
      const relation = tableAlias
        ? state.aliasToRelation.get(tableAlias) ?? rawTable
        : state.singleRelation;
      const normalizedRelation = relation ? normalizeSqlIdentifier(relation) : undefined;
      if (!relation || (!state.ctes.has(normalizedRelation!) && !state.derivedRelations.has(normalizedRelation!))) {
        state.columns.push({
          column,
          tableAlias: rawTable,
          relation,
          unqualified: !rawTable,
        });
      }
    }
    return;
  }

  for (const value of Object.values(obj)) collectSqlColumns(value, state);
}

/** Return the alias for a FROM/JOIN item backed by a nested SELECT AST. */
function derivedRelationAlias(obj: Record<string, unknown>): string | undefined {
  const expression = obj.expr;
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return undefined;
  const ast = (expression as Record<string, unknown>).ast;
  if (!ast || typeof ast !== 'object') return undefined;
  const alias = stringField(obj, 'as') ?? stringField(obj, 'alias');
  return alias ? normalizeSqlIdentifier(alias) : undefined;
}

function relationFromTableNode(obj: Record<string, unknown>): string | undefined {
  const table = stringField(obj, 'table');
  if (!table) return undefined;
  const parts = [
    stringField(obj, 'database'),
    stringField(obj, 'db'),
    stringField(obj, 'schema'),
    table,
  ].filter((part): part is string => Boolean(part));
  return parts.join('.');
}

function readStatementType(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const type = (node as { type?: unknown }).type;
  return typeof type === 'string' ? type.toLowerCase() : undefined;
}

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

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSqlIdentifier(value: string): string {
  return value.replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.').trim().toLowerCase();
}

function isSqlFunctionRelation(relation: string): boolean {
  return /\b(read_csv_auto|read_csv|read_parquet|read_json|read_json_auto|unnest|generate_series|range)\s*\(/i.test(relation);
}

function dedupeColumnReferences(columns: SqlColumnReference[]): SqlColumnReference[] {
  const seen = new Set<string>();
  return columns.filter((column) => {
    const key = [
      column.relation ?? '',
      column.tableAlias ?? '',
      column.column.toLowerCase(),
      column.unqualified ? 'u' : 'q',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract DuckDB reader function calls (e.g., read_csv_auto('./data/file.csv')) */
function extractReaderFunctions(sql: string): string[] {
  const results: string[] = [];
  const pattern = /\b(read_csv_auto|read_csv|read_parquet|read_json|read_json_auto)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*[^)]*?)?\)/gi;
  for (const match of sql.matchAll(pattern)) {
    results.push(`${match[1]}('${match[2]}')`);
  }
  return results;
}

/** Extract ref("block_name") calls from SQL */
function extractRefs(sql: string): string[] {
  const refs: string[] = [];
  const refPattern = /\bref\s*\(\s*["']([^"']+)["']\s*\)/gi;
  for (const match of sql.matchAll(refPattern)) {
    refs.push(match[1]);
  }
  return refs;
}

/** Strip comments only */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * Strip single-quoted string literals, but preserve those inside ref() calls.
 * This ensures ref('block_name') works, while 'ref("fake")' is stripped.
 */
function stripStringLiterals(sql: string): string {
  // First, temporarily protect ref() arguments by replacing them with placeholders
  const refArgs: string[] = [];
  const withPlaceholders = sql.replace(
    /\bref\s*\(\s*'([^']*)'\s*\)/gi,
    (_match, arg: string) => {
      refArgs.push(arg);
      return `ref("__REF_PLACEHOLDER_${refArgs.length - 1}__")`;
    },
  );
  // Strip all remaining single-quoted strings
  const stripped = withPlaceholders.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Restore ref() arguments
  return stripped.replace(
    /ref\("__REF_PLACEHOLDER_(\d+)__"\)/g,
    (_match, idx: string) => `ref('${refArgs[parseInt(idx)]}')`
  );
}

/** Extract @metric() or @dim() references from SQL */
function extractSemanticRefs(sql: string, type: 'metric' | 'dim'): string[] {
  const refs: string[] = [];
  const pattern = new RegExp(`@${type}\\s*\\(\\s*["']?([^"')]+)["']?\\s*\\)`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    refs.push(match[1].trim());
  }
  return [...new Set(refs)];
}

/** Normalize and add a table reference */
function addTableRef(tables: Set<string>, ref: string): void {
  // Remove surrounding quotes
  const cleaned = ref.replace(/^"|"$/g, '');
  if (cleaned.length > 0) {
    tables.add(cleaned);
  }
}
