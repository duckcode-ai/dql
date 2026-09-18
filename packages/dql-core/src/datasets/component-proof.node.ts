/**
 * Server-only parser and probe compiler for aggregate Dataset components.
 *
 * `node-sql-parser` recognizes structure only.  Its numeric AST leaves are
 * not authoritative because several dialect paths coerce decimals through
 * JavaScript numbers.  Numeric tokens are masked before parsing and restored
 * by this bounded printer from their original lexical spelling.
 */

import { createHash } from 'node:crypto';
import nodeSqlParserPkg from 'node-sql-parser';
import type { DatasetDescriptor } from './descriptor.js';

const { Parser } = nodeSqlParserPkg;

export class DatasetAggregateComponentSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DatasetAggregateComponentSourceError';
  }
}

export interface ParsedDatasetAggregateSourceComponent {
  alias: string;
  sourceAggregate: 'sum' | 'count_distinct';
  sourceExpressionSql: string;
  sourceExpressionFingerprint: string;
  countedKeySql?: string;
  countedKeyFingerprint?: string;
}

/**
 * A validated, printable source plan.  Raw SQL is returned only to the local
 * CLI compiler; durable proof objects retain the fingerprints below instead.
 */
export interface ParsedDatasetAggregateSource {
  sourceSqlFingerprint: string;
  fromSql: string;
  /** Native relation identity checked inside the same DuckDB read scope. */
  relation: { schema?: string; table: string; alias?: string; referencedColumns: string[] };
  whereSql?: string;
  groupingSql: string[];
  groupingFingerprint: string;
  timeBucketSql: string;
  timeBucketFingerprint: string;
  components: ReadonlyMap<string, ParsedDatasetAggregateSourceComponent>;
}

export interface CompiledDatasetAggregateDistinctProbe {
  component: ParsedDatasetAggregateSourceComponent;
  sql: string;
  fingerprint: string;
}

/**
 * Classify only source aggregation that the strict parser can observe. This
 * prevents a declaration from clearing `grain.aggregate` to bypass the App
 * runtime gate for a plainly grouped/aggregate source. It is not an attempt
 * to infer the business grain of arbitrary physical tables.
 */
export function classifyDatasetAggregateSource(input: {
  sourceSql: string;
  driver: string;
}): 'row' | 'aggregate' | 'unsupported' {
  const sourceSql = stripTerminator(input.sourceSql);
  if (!sourceSql) return 'unsupported';
  const literalMask = maskSourceNumericLiterals(sourceSql);
  const parser = new Parser();
  let root: unknown;
  try {
    root = parser.astify(literalMask.sql, { database: parserDialect(input.driver) });
  } catch {
    return 'unsupported';
  }
  const statements = Array.isArray(root) ? root : [root];
  if (statements.length !== 1) return 'unsupported';
  const statement = objectRecord(statements[0]);
  if (!statement || statement.type !== 'select') return 'unsupported';
  return sourceContainsAggregate(statement) ? 'aggregate' : 'row';
}

/**
 * Parse a complete source query that may supply native additive components.
 * Only the small shape described in the App Dataset contract is accepted.
 */
export function parseDatasetAggregateComponentSource(input: {
  descriptor: DatasetDescriptor;
  sourceSql: string;
  driver: string;
}): ParsedDatasetAggregateSource {
  const sourceSql = stripTerminator(input.sourceSql);
  if (!sourceSql) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_EMPTY', 'The aggregate Dataset source has no executable SQL to validate.');
  }
  const literalMask = maskSourceNumericLiterals(sourceSql);
  const parser = new Parser();
  let root: unknown;
  try {
    root = parser.astify(literalMask.sql, { database: parserDialect(input.driver) });
  } catch (error) {
    throw new DatasetAggregateComponentSourceError(
      'DATASET_COMPONENT_SOURCE_PARSE_FAILED',
      `The aggregate Dataset source cannot be parsed for component evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const statements = Array.isArray(root) ? root : [root];
  if (statements.length !== 1) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence supports exactly one SELECT source statement.');
  }
  const statement = objectRecord(statements[0]);
  if (!statement || statement.type !== 'select') {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence supports one SELECT source statement.');
  }
  assertSourceStatementShape(statement);
  const fromEntries = statement.from as unknown[];
  const relation = parseSimpleFrom(fromEntries[0]);
  const fromSql = relation.sql;
  const groupingNodes = groupingNodesFromStatement(statement);
  const groupingSql = groupingNodes.map((node) => renderDeterministicExpression(node, literalMask.literals));
  const groupingFingerprint = fingerprint({ groupingSql });
  const whereSql = statement.where === null || statement.where === undefined
    ? undefined
    : renderDeterministicExpression(statement.where, literalMask.literals);

  const projections = parseProjections(statement.columns, literalMask.literals);
  const referencedColumns = collectReferencedColumns(statement, literalMask.literals);
  const timeBucketName = input.descriptor.grain.timeBucketBy?.trim();
  if (!timeBucketName) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_TIME_BUCKET_MISSING', 'Aggregate component evidence requires the Dataset declaration to name timeBucketBy.');
  }
  const timeProjection = projections.get(timeBucketName.toLowerCase());
  if (!timeProjection || timeProjection.aggregate) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_TIME_BUCKET_UNRESOLVED', `The Dataset timeBucketBy ${timeBucketName} does not map to a direct source grouping expression.`);
  }
  if (!groupingSql.includes(timeProjection.sql)) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_TIME_BUCKET_GROUPING_MISMATCH', `The Dataset timeBucketBy ${timeBucketName} is not an exact source GROUP BY expression.`);
  }
  const components = new Map<string, ParsedDatasetAggregateSourceComponent>();
  for (const [alias, projection] of projections) {
    if (!projection.aggregate) continue;
    components.set(alias, projection.aggregate);
  }
  return {
    sourceSqlFingerprint: fingerprint({ sourceSql }),
    fromSql,
    relation: {
      ...(relation.schema ? { schema: relation.schema } : {}),
      table: relation.table,
      ...(relation.alias ? { alias: relation.alias } : {}),
      referencedColumns,
    },
    ...(whereSql ? { whereSql } : {}),
    groupingSql,
    groupingFingerprint,
    timeBucketSql: timeProjection.sql,
    timeBucketFingerprint: fingerprint({ timeBucketSql: timeProjection.sql, timeGrain: input.descriptor.grain.timeGrain ?? null }),
    components,
  };
}

/**
 * Compile an existential membership check for one COUNT(DISTINCT raw_key)
 * component.  The inner grouping is deliberately complete and unbounded:
 * each raw key must appear in no more than one original source bucket.
 */
export function compileDatasetAggregateDistinctProbe(input: {
  source: ParsedDatasetAggregateSource;
  component: string;
}): CompiledDatasetAggregateDistinctProbe {
  const component = input.source.components.get(input.component.trim().toLowerCase());
  if (!component) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_UNRESOLVED', `The aggregate source has no direct component ${input.component}.`);
  }
  if (component.sourceAggregate !== 'count_distinct' || !component.countedKeySql) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_DISTINCT_REQUIRED', `${component.alias} is not a direct COUNT(DISTINCT raw key) source component.`);
  }
  const countedKey = component.countedKeySql;
  const predicate = input.source.whereSql
    ? `(${input.source.whereSql}) AND (${countedKey}) IS NOT NULL`
    : `(${countedKey}) IS NOT NULL`;
  const sql = [
    'SELECT 1 AS "__dql_overlap"',
    'FROM (',
    `  SELECT ${countedKey} AS "__dql_count_key"`,
    `  FROM ${input.source.fromSql}`,
    `  WHERE ${predicate}`,
    `  GROUP BY ${[countedKey, ...input.source.groupingSql].join(', ')}`,
    ') AS "__dql_membership"',
    'GROUP BY "__dql_count_key"',
    'HAVING COUNT(*) > 1',
    'LIMIT 1',
  ].join('\n');
  return { component, sql, fingerprint: fingerprint({ source: input.source.sourceSqlFingerprint, component: component.alias, sql }) };
}

export function componentSourceForAlias(
  source: ParsedDatasetAggregateSource,
  alias: string,
): ParsedDatasetAggregateSourceComponent | undefined {
  return source.components.get(alias.trim().toLowerCase());
}

function assertSourceStatementShape(statement: Record<string, unknown>): void {
  if (statement.with || statement._next || statement.window || statement.having || statement.orderby) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence does not support CTEs, set queries, windows, HAVING, or ORDER BY in the source.');
  }
  const distinct = objectRecord(statement.distinct);
  if (distinct?.type != null) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence does not support a top-level DISTINCT source.');
  }
  const limit = objectRecord(statement.limit);
  const limitValues = limit?.value;
  if (Array.isArray(limitValues) && limitValues.length > 0) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence does not support source LIMIT, OFFSET, or FETCH clauses.');
  }
  const from = statement.from;
  if (!Array.isArray(from) || from.length !== 1 || !objectRecord(from[0])) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence requires one simple base-table FROM source.');
  }
  const groupby = objectRecord(statement.groupby);
  if (!groupby || !Array.isArray(groupby.columns) || groupby.columns.length === 0) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_GROUPING_REQUIRED', 'Aggregate component evidence requires an explicit expression GROUP BY source.');
  }
  if (!Array.isArray(statement.columns) || statement.columns.length === 0) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence requires source projections.');
  }
}

function sourceContainsAggregate(value: unknown): boolean {
  const visit = (candidate: unknown): boolean => {
    const node = objectRecord(candidate);
    if (!node) return Array.isArray(candidate) && candidate.some(visit);
    if (node.type === 'aggr_func') return true;
    const groupby = objectRecord(node.groupby);
    if (Array.isArray(groupby?.columns) && groupby.columns.length > 0) return true;
    return Object.entries(node).some(([key, nested]) =>
      !['type', 'table', 'column', 'as', 'name', 'value'].includes(key)
      && nested !== null
      && typeof nested === 'object'
      && visit(nested));
  };
  return visit(value);
}

function parseSimpleFrom(value: unknown): { sql: string; schema?: string; table: string; alias?: string } {
  const from = objectRecord(value);
  if (!from || typeof from.table !== 'string' || !safeIdentifier(from.table)) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence requires a simple named base table.');
  }
  if (from.join || from.on || from.expr || from.stmt) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence does not support joins or subqueries.');
  }
  const db = typeof from.db === 'string' && from.db ? from.db : undefined;
  if (from.db !== null && from.db !== undefined && !db) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence could not bind the source schema.');
  }
  const sqlTable = [db, from.table].filter(Boolean).map((part) => quoteIdentifier(part!)).join('.');
  if (from.as === null || from.as === undefined) return { sql: sqlTable, ...(db ? { schema: db } : {}), table: from.table };
  if (typeof from.as !== 'string' || !safeIdentifier(from.as)) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence requires a simple source alias.');
  }
  return { sql: `${sqlTable} AS ${quoteIdentifier(from.as)}`, ...(db ? { schema: db } : {}), table: from.table, alias: from.as };
}

function groupingNodesFromStatement(statement: Record<string, unknown>): unknown[] {
  const groupby = objectRecord(statement.groupby);
  const columns = Array.isArray(groupby?.columns) ? groupby!.columns : [];
  for (const column of columns) {
    if (typeof column === 'number' || (typeof column === 'string' && /^\d+$/.test(column))) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence does not support GROUP BY ordinals or aliases.');
    }
  }
  return columns;
}

type Projection = { sql: string; aggregate?: ParsedDatasetAggregateSourceComponent };

function parseProjections(columns: unknown, literals: ReadonlyMap<string, string>): Map<string, Projection> {
  if (!Array.isArray(columns)) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate source projections are unavailable.');
  const projections = new Map<string, Projection>();
  for (const column of columns) {
    const projection = objectRecord(column);
    // PostgreSQL wraps projections in { type: 'expr' }, while the parser's
    // SQLite/MySQL dialects expose the same validated { expr, as } shape
    // without that wrapper type. Both still pass the expression allowlist
    // below; no raw dialect text is accepted here.
    if (!projection || (projection.type !== undefined && projection.type !== 'expr') || !('expr' in projection)) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', 'Aggregate component evidence supports only direct SELECT expressions.');
    }
    const expression = projection.expr;
    const alias = projectionAlias(projection, expression);
    if (!alias) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_OUTPUT_ALIAS_REQUIRED', 'Every aggregate source projection must have a direct output name.');
    }
    const normalizedAlias = alias.toLowerCase();
    if (projections.has(normalizedAlias)) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_OUTPUT_ALIAS_DUPLICATE', `Aggregate source output ${alias} is ambiguous.`);
    }
    const aggregate = parseDirectAggregate(alias, expression, literals);
    projections.set(normalizedAlias, aggregate
      ? { sql: aggregate.sourceExpressionSql, aggregate }
      : { sql: renderDeterministicExpression(expression, literals) });
  }
  return projections;
}

function projectionAlias(projection: Record<string, unknown>, expression: unknown): string | undefined {
  if (typeof projection.as === 'string' && safeIdentifier(projection.as)) return projection.as;
  const node = objectRecord(expression);
  if (node?.type !== 'column_ref') return undefined;
  const column = columnRefName(node);
  return column && safeIdentifier(column) ? column : undefined;
}

function parseDirectAggregate(
  alias: string,
  value: unknown,
  literals: ReadonlyMap<string, string>,
): ParsedDatasetAggregateSourceComponent | undefined {
  const node = objectRecord(value);
  if (!node || node.type !== 'aggr_func') return undefined;
  if (node.over || node.window) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', `Aggregate source component ${alias} cannot use a window.`);
  }
  const name = typeof node.name === 'string' ? node.name.toUpperCase() : '';
  const args = objectRecord(node.args);
  if (!args) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', `Aggregate source component ${alias} has no direct argument.`);
  if (name === 'SUM') {
    if (args.distinct || args.orderby || args.separator || !isSimpleNumericExpression(args.expr, literals)) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', `Aggregate source component ${alias} must be a direct SUM of a simple numeric expression.`);
    }
    const sourceExpressionSql = renderDeterministicExpression(args.expr, literals);
    return {
      alias,
      sourceAggregate: 'sum',
      sourceExpressionSql,
      sourceExpressionFingerprint: fingerprint({ aggregate: 'sum', sourceExpressionSql }),
    };
  }
  if (name === 'COUNT') {
    if (args.distinct !== 'DISTINCT' || args.orderby || args.separator || !isSimpleColumnReference(args.expr)) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', `Aggregate source component ${alias} must be COUNT(DISTINCT one raw column).`);
    }
    const countedKeySql = renderDeterministicExpression(args.expr, literals);
    return {
      alias,
      sourceAggregate: 'count_distinct',
      sourceExpressionSql: countedKeySql,
      sourceExpressionFingerprint: fingerprint({ aggregate: 'count_distinct', sourceExpressionSql: countedKeySql }),
      countedKeySql,
      countedKeyFingerprint: fingerprint({ countedKeySql }),
    };
  }
  throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_SHAPE_UNSUPPORTED', `Aggregate source component ${alias} must use direct SUM or COUNT(DISTINCT raw key), not ${name || 'an unknown aggregate'}.`);
}

function isSimpleColumnReference(value: unknown): boolean {
  const node = objectRecord(value);
  return node?.type === 'column_ref' && Boolean(columnRefName(node));
}

function isSimpleNumericExpression(value: unknown, literals: ReadonlyMap<string, string>): boolean {
  const node = objectRecord(value);
  if (!node) return false;
  if (node.type === 'column_ref') return Boolean(columnRefName(node));
  if (node.type === 'cast') return isSimpleNumericExpression(node.expr, literals) && validCastTarget(node.target);
  if (node.type === 'var') return validVariable(node);
  if (node.type === 'unary_expr') return (node.operator === '+' || node.operator === '-') && isSimpleNumericExpression(node.expr, literals);
  if (node.type === 'binary_expr') {
    return ['+', '-', '*', '/'].includes(String(node.operator))
      && isSimpleNumericExpression(node.left, literals)
      && isSimpleNumericExpression(node.right, literals);
  }
  if (node.type === 'number') return false;
  if (node.type === 'column_ref') {
    const name = columnRefName(node);
    return Boolean(name && literals.has(name.toLowerCase()));
  }
  return false;
}

/** Own deterministic printer. Numeric placeholders restore exact lexical values. */
function renderDeterministicExpression(value: unknown, literals: ReadonlyMap<string, string>): string {
  const node = objectRecord(value);
  if (!node || typeof node.type !== 'string') {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence encountered an unknown source expression.');
  }
  if (node.type === 'column_ref') {
    const name = columnRefName(node);
    if (!name) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence cannot bind a source column reference.');
    const literal = literals.get(name.toLowerCase());
    if (literal !== undefined) return literal;
    const table = typeof node.table === 'string' && node.table ? node.table : undefined;
    if (node.table !== null && node.table !== undefined && !table) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence cannot bind a qualified source column.');
    }
    if (!safeIdentifier(name) || (table && !safeIdentifier(table))) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence requires simple source identifiers.');
    }
    return `${table ? `${quoteIdentifier(table)}.` : ''}${quoteIdentifier(name)}`;
  }
  if (node.type === 'var') {
    if (!validVariable(node)) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence requires positional source parameters.');
    return `$${String(node.name)}`;
  }
  if (node.type === 'null') return 'NULL';
  if (node.type === 'bool') return node.value === true || String(node.value).toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
  if (node.type === 'single_quote_string' || node.type === 'string') {
    if (typeof node.value !== 'string') throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence cannot bind a source string literal.');
    return `'${node.value.replaceAll("'", "''")}'`;
  }
  if (node.type === 'number') {
    // Numeric leaves are never accepted here. If a scanner bug or parser
    // dialect changed, refusing is safer than emitting a rounded predicate.
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_LITERAL_PRECISION_UNSUPPORTED', 'Aggregate component evidence cannot preserve a numeric source literal exactly.');
  }
  if (node.type === 'cast') {
    if (!validCastTarget(node.target)) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence encountered an unsupported CAST target.');
    return `CAST(${renderDeterministicExpression(node.expr, literals)} AS ${renderCastTarget(node.target)})`;
  }
  if (node.type === 'unary_expr') {
    const operator = String(node.operator ?? '');
    if (!['+', '-', 'NOT'].includes(operator.toUpperCase())) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', `Aggregate component evidence does not support unary ${operator || 'expression'} operators.`);
    }
    return `${operator.toUpperCase()} ${renderDeterministicExpression(node.expr, literals)}`;
  }
  if (node.type === 'binary_expr') {
    const operator = String(node.operator ?? '').toUpperCase();
    if (!['+', '-', '*', '/', '||', '=', '!=', '<>', '<', '<=', '>', '>=', 'AND', 'OR', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT', 'IN', 'NOT IN'].includes(operator)) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', `Aggregate component evidence does not support ${operator || 'unknown'} source predicates.`);
    }
    return `(${renderDeterministicExpression(node.left, literals)} ${operator} ${renderDeterministicExpression(node.right, literals)})`;
  }
  if (node.type === 'expr_list') {
    const values = Array.isArray(node.value) ? node.value : undefined;
    if (!values || values.length === 0) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence encountered an empty source expression list.');
    return `(${values.map((entry) => renderDeterministicExpression(entry, literals)).join(', ')})`;
  }
  if (node.type === 'function') {
    const name = functionName(node);
    if (!['date_trunc', 'lower', 'upper', 'coalesce'].includes(name)) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', `Aggregate component evidence does not support volatile or unknown source function ${name || '(unknown)'}.`);
    }
    const args = objectRecord(node.args);
    const values = Array.isArray(args?.value) ? args!.value : undefined;
    if (!values || values.length === 0) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', `Aggregate component evidence cannot bind ${name} without deterministic arguments.`);
    return `${name.toUpperCase()}(${values.map((entry) => renderDeterministicExpression(entry, literals)).join(', ')})`;
  }
  throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', `Aggregate component evidence does not support source expression ${node.type}.`);
}

function functionName(node: Record<string, unknown>): string {
  const name = node.name;
  if (typeof name === 'string') return name.toLowerCase();
  const record = objectRecord(name);
  const members = record?.name;
  if (Array.isArray(members) && members.length === 1) {
    const member = objectRecord(members[0]);
    return typeof member?.value === 'string' ? member.value.toLowerCase() : '';
  }
  return '';
}

function columnRefName(node: Record<string, unknown>): string | undefined {
  const column = node.column;
  if (typeof column === 'string') return column;
  const record = objectRecord(column);
  const expression = objectRecord(record?.expr);
  return typeof expression?.value === 'string' ? expression.value : undefined;
}

function validVariable(node: Record<string, unknown>): boolean {
  return node.prefix === '$' && Number.isSafeInteger(node.name) && Number(node.name) > 0;
}

function validCastTarget(value: unknown): boolean {
  try {
    renderCastTarget(value);
    return true;
  } catch {
    return false;
  }
}

function renderCastTarget(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence requires one explicit CAST target.');
  }
  const target = objectRecord(value[0]);
  const dataType = typeof target?.dataType === 'string' ? target.dataType.toUpperCase() : '';
  const supportedTypes = new Set(['DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'VARCHAR', 'TEXT', 'DOUBLE', 'REAL', 'DECIMAL', 'NUMERIC', 'INTEGER', 'BIGINT']);
  if (!target || !supportedTypes.has(dataType)) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence encountered an unsupported CAST target.');
  }
  // The parser exposes modifiers separately from dataType. Dropping any of
  // them can change a membership predicate (notably DECIMAL precision/scale),
  // so this bounded printer either renders every supported modifier or refuses.
  const suffix = target.suffix;
  if (suffix !== undefined && (!Array.isArray(suffix) || suffix.length !== 0)) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence cannot preserve CAST type modifiers.');
  }
  const parentheses = target.parentheses === true;
  const length = target.length;
  const scale = target.scale;
  if (!parentheses) {
    if (length !== undefined || scale !== undefined) {
      throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence cannot preserve an unparenthesized CAST precision or scale.');
    }
    return dataType;
  }
  if (!['DECIMAL', 'NUMERIC', 'VARCHAR', 'TIMESTAMP', 'TIMESTAMPTZ'].includes(dataType)
    || !Number.isSafeInteger(length)
    || Number(length) <= 0) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence encountered an unsupported CAST precision or length.');
  }
  if (scale === undefined) return `${dataType}(${String(length)})`;
  if (!['DECIMAL', 'NUMERIC'].includes(dataType)
    || !Number.isSafeInteger(scale)
    || Number(scale) < 0
    || Number(scale) > Number(length)) {
    throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_EXPRESSION_UNSUPPORTED', 'Aggregate component evidence encountered an unsupported CAST scale.');
  }
  return `${dataType}(${String(length)}, ${String(scale)})`;
}

function collectReferencedColumns(statement: Record<string, unknown>, literals: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    const node = objectRecord(value);
    if (!node) {
      if (Array.isArray(value)) value.forEach(visit);
      return;
    }
    if (node.type === 'column_ref') {
      const name = columnRefName(node);
      if (name && !literals.has(name.toLowerCase())) names.add(name);
    }
    for (const [key, nested] of Object.entries(node)) {
      if (key === 'table' || key === 'column' || key === 'as' || key === 'type' || key === 'name' || key === 'value') continue;
      if (nested && typeof nested === 'object') visit(nested);
    }
  };
  visit(statement.columns);
  visit(statement.where);
  visit(objectRecord(statement.groupby)?.columns);
  return [...names].sort((left, right) => left.localeCompare(right));
}

function stripTerminator(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

function parserDialect(driver: string): string {
  const normalized = driver.trim().toLowerCase();
  // This parser only establishes the bounded source shape. It does not make
  // a connector dialect generally interchangeable: unsupported syntax still
  // fails the AST allowlist. Map the supported App connector families so a
  // direct SUM mapping can stay usable without pretending it has DuckDB's
  // COUNT(DISTINCT) read-scope capability.
  if (['duckdb', 'file', 'postgresql', 'postgres', 'redshift', 'databricks', 'trino', 'athena', 'clickhouse', 'mssql', 'fabric'].includes(normalized)) return 'postgresql';
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'sqlite') return 'sqlite';
  if (normalized === 'snowflake') return 'snowflake';
  if (normalized === 'bigquery') return 'bigquery';
  throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_DIALECT_UNSUPPORTED', `Aggregate component evidence does not support the ${driver} source dialect.`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

/**
 * Preserve numeric token spelling before node-sql-parser can coerce it.  This
 * is a lexer, not a SQL authority: the masked statement still has to pass the
 * strict AST allowlist and is printed only by renderDeterministicExpression.
 */
function maskSourceNumericLiterals(source: string): { sql: string; literals: ReadonlyMap<string, string> } {
  let prefix = '__dql_component_literal_';
  while (source.toLowerCase().includes(prefix.toLowerCase())) prefix = `_${prefix}`;
  const literals = new Map<string, string>();
  let output = '';
  let index = 0;
  let literalIndex = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "'") {
      const end = consumeSingleQuoted(source, index);
      output += source.slice(index, end);
      index = end;
      continue;
    }
    if (character === '"') {
      const end = consumeDoubleQuoted(source, index);
      output += source.slice(index, end);
      index = end;
      continue;
    }
    if (character === '-' && source[index + 1] === '-') {
      const end = source.indexOf('\n', index + 2);
      const stop = end < 0 ? source.length : end;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_PARSE_FAILED', 'The aggregate Dataset source has an unterminated block comment.');
      const stop = end + 2;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }
    const previous = index > 0 ? source[index - 1]! : '';
    if (isNumericStart(source, index, previous)) {
      const end = consumeNumericLiteral(source, index);
      if (end > index) {
        const literal = source.slice(index, end);
        // CAST target precision/scale is structural parser input, not a SQL
        // expression literal. Leave the bounded, unsigned target parameter
        // intact so the AST can retain it and renderCastTarget can validate
        // and reproduce it exactly. Every other numeric token is still
        // masked before node-sql-parser can coerce it through Number.
        if (isSupportedCastTypeParameter(source, index, end, literal)) {
          output += literal;
          index = end;
          continue;
        }
        const placeholder = `${prefix}${literalIndex}__`;
        literalIndex += 1;
        literals.set(placeholder.toLowerCase(), literal);
        output += placeholder;
        index = end;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return { sql: output, literals };
}

function isNumericStart(source: string, index: number, previous: string): boolean {
  const current = source[index]!;
  if (previous && /[A-Za-z0-9_$]/.test(previous)) return false;
  if (current >= '0' && current <= '9') return true;
  return current === '.' && /[0-9]/.test(source[index + 1] ?? '');
}

function consumeNumericLiteral(source: string, start: number): number {
  let index = start;
  if (source[index] === '.') index += 1;
  while (/[0-9]/.test(source[index] ?? '')) index += 1;
  if (source[index] === '.') {
    index += 1;
    while (/[0-9]/.test(source[index] ?? '')) index += 1;
  }
  if (source[index] === 'e' || source[index] === 'E') {
    const exponent = index;
    index += 1;
    if (source[index] === '+' || source[index] === '-') index += 1;
    const exponentStart = index;
    while (/[0-9]/.test(source[index] ?? '')) index += 1;
    if (index === exponentStart) return exponent;
  }
  return index;
}

/**
 * Preserve only `CAST(... AS TYPE(precision[, scale]))` integer parameters.
 * This scanner does not authorize a cast expression: the strict AST and
 * renderCastTarget still validate the target and reject unknown modifiers.
 */
function isSupportedCastTypeParameter(source: string, start: number, end: number, literal: string): boolean {
  if (!/^[0-9]+$/.test(literal)) return false;
  let cursor = start - 1;
  while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor -= 1;
  if (source[cursor] === ',') {
    cursor -= 1;
    while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor -= 1;
    while (cursor >= 0 && /[0-9]/.test(source[cursor]!)) cursor -= 1;
    while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor -= 1;
  }
  if (source[cursor] !== '(') return false;
  let typeEnd = cursor - 1;
  while (typeEnd >= 0 && /\s/.test(source[typeEnd]!)) typeEnd -= 1;
  let typeStart = typeEnd;
  while (typeStart >= 0 && /[A-Za-z]/.test(source[typeStart]!)) typeStart -= 1;
  const type = source.slice(typeStart + 1, typeEnd + 1).toUpperCase();
  if (!['DECIMAL', 'NUMERIC', 'VARCHAR', 'TIMESTAMP', 'TIMESTAMPTZ'].includes(type)) return false;
  let after = end;
  while (after < source.length && /\s/.test(source[after]!)) after += 1;
  return source[after] === ',' || source[after] === ')';
}

function consumeSingleQuoted(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] !== "'") {
      index += 1;
      continue;
    }
    if (source[index + 1] === "'") {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_PARSE_FAILED', 'The aggregate Dataset source has an unterminated string literal.');
}

function consumeDoubleQuoted(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] !== '"') {
      index += 1;
      continue;
    }
    if (source[index + 1] === '"') {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new DatasetAggregateComponentSourceError('DATASET_COMPONENT_SOURCE_PARSE_FAILED', 'The aggregate Dataset source has an unterminated quoted identifier.');
}
