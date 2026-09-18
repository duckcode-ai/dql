/** Server-only SQL parser adapter for Dataset aggregate expressions. */

import { createHash } from 'node:crypto';
import nodeSqlParserPkg from 'node-sql-parser';
import {
  canonicalDatasetAggregateExpression,
  renderDatasetAggregateExpression,
  validateDatasetAggregateExpression,
  type DatasetAggregateExpressionV1,
  type DatasetMeasureAggregation,
} from './aggregate-expression.js';

const { Parser } = nodeSqlParserPkg;

export interface ParsedDatasetAggregateExpression {
  expression: DatasetAggregateExpressionV1;
  /** Canonical reviewed source text, never a third-party parser AST. */
  canonicalExpression: string;
  dependencies: string[];
  aggregation: DatasetMeasureAggregation;
  fingerprint: string;
}

export class DatasetAggregateExpressionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DatasetAggregateExpressionError';
  }
}

/**
 * Parse one scalar SELECT projection with the deliberately small Dataset
 * expression language.  `node-sql-parser` is only a recognizer: the returned
 * object is the owned AST above, bound to exact approved physical names.
 */
export function parseDatasetAggregateExpression(input: {
  expression: string;
  physicalFields: readonly string[];
  allowCountStar?: boolean;
  dialect?: string;
}): ParsedDatasetAggregateExpression {
  const source = input.expression.trim();
  if (!source) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_EMPTY', 'A calculated measure expression is required.');
  const parser = new Parser();
  let astRoot: unknown;
  try {
    // node-sql-parser normalizes a decimal through JavaScript numbers on some
    // dialect paths.  Preserve the source spelling with collision-safe lexical
    // placeholders, then parse the bounded expression ourselves below.  The
    // SQL parser remains the structural guard for statements/clauses; it is
    // never the authority for a persisted numeric literal.
    astRoot = parser.astify(`SELECT ${maskDatasetExpressionLiterals(source)} AS __dql_dataset_measure`, { database: parserDialect(input.dialect ?? 'duckdb') });
  } catch (error) {
    throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_PARSE_FAILED', `Calculated measure expression could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const statements = Array.isArray(astRoot) ? astRoot : [astRoot];
  if (statements.length !== 1 || !isPlainSelect(statements[0])) {
    throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_STATEMENT_UNSUPPORTED', 'Calculated measures allow exactly one aggregate expression, not a SQL statement or query clause.');
  }
  const statement = statements[0] as Record<string, unknown>;
  if (!isExpressionOnlySelect(statement)) {
    throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_CLAUSE_UNSUPPORTED', 'Calculated measures do not allow FROM, WHERE, GROUP BY, HAVING, ORDER BY, limits, CTEs, windows, or set operations.');
  }
  const columns = Array.isArray(statement.columns) ? statement.columns : [];
  if (columns.length !== 1 || !record(columns[0])?.expr) {
    throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_PROJECTION_UNSUPPORTED', 'Calculated measures require exactly one scalar expression projection.');
  }
  assertParserExpressionShape(record(columns[0])!.expr);
  const owned = new DatasetExpressionPrattParser(source).parse();
  const validation = validateDatasetAggregateExpression(owned, {
    physicalFields: input.physicalFields,
    allowCountStar: input.allowCountStar === true,
  });
  if (!validation.valid || !validation.aggregation) {
    const first = validation.diagnostics[0];
    throw new DatasetAggregateExpressionError(first?.code ?? 'DATASET_EXPRESSION_INVALID', first?.message ?? 'Calculated measure expression is invalid.');
  }
  const canonicalExpression = renderDatasetAggregateExpression(owned, {
    physicalField: quoteSourceIdentifier,
  });
  const fingerprint = `sha256:${createHash('sha256').update(canonicalDatasetAggregateExpression(owned)).digest('hex')}`;
  return {
    expression: owned,
    canonicalExpression,
    dependencies: validation.dependencies,
    aggregation: validation.aggregation,
    fingerprint,
  };
}

function isPlainSelect(value: unknown): boolean {
  return record(value)?.type === 'select';
}

function isExpressionOnlySelect(statement: Record<string, unknown>): boolean {
  const emptyLimit = record(statement.limit)?.value;
  return !statement.with
    && !statement.from
    && !statement.where
    && !statement.groupby
    && !statement.having
    && !statement.orderby
    && !statement.window
    && !statement._next
    && (!Array.isArray(emptyLimit) || emptyLimit.length === 0)
    && record(statement.distinct)?.type == null;
}

function quoteSourceIdentifier(field: string): string {
  return `"${field.replaceAll('"', '""')}"`;
}

function parserDialect(driver: string): string {
  const value = driver.toLowerCase();
  if (value === 'duckdb' || value === 'postgres' || value === 'postgresql') return 'postgresql';
  if (value === 'sqlite') return 'sqlite';
  if (value === 'mysql') return 'mysql';
  if (value === 'bigquery') return 'bigquery';
  if (value === 'snowflake') return 'snowflake';
  if (value === 'redshift') return 'redshift';
  if (value === 'databricks' || value === 'spark' || value === 'spark_sql' || value === 'hive') return 'hive';
  if (value === 'mssql' || value === 'sqlserver' || value === 'azure_sql') return 'transactsql';
  throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_DIALECT_UNSUPPORTED', `Calculated measures do not support the ${driver} SQL dialect.`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The shared parser recognizes the masked expression as SQL, then this check
 * refuses every node outside the owned grammar. The precise Pratt parser below
 * additionally consumes the original source spelling, so numeric values never
 * pass through JavaScript's floating-point representation.
 */
function assertParserExpressionShape(value: unknown): void {
  const node = record(value);
  if (!node) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', 'Calculated measure expression is not a supported scalar node.');
  if (node.type === 'column_ref') {
    if (node.table || node.db || node.schema) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_FIELD_UNBOUND', 'Calculated measure expressions cannot qualify physical field names.');
    return;
  }
  if (node.type === 'binary_expr') {
    if (!['+', '-', '*', '/'].includes(String(node.operator))) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_OPERATOR_INVALID', 'Calculated measure uses an unsupported arithmetic operator.');
    assertParserExpressionShape(node.left);
    assertParserExpressionShape(node.right);
    return;
  }
  if (node.type === 'aggr_func') {
    if (node.over || node.window) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_WINDOW_UNSUPPORTED', 'Calculated measures do not allow window aggregates.');
    const args = record(node.args);
    if (!args) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_AGGREGATE_FIELD_MISSING', 'Calculated measure aggregate has no argument.');
    if (record(args.expr)?.type === 'star') return;
    assertParserExpressionShape(args.expr);
    return;
  }
  if (node.type === 'function') {
    const parts = record(node.name)?.name;
    const name = Array.isArray(parts) ? record(parts[0])?.value : node.name;
    if (typeof name !== 'string' || name.toLowerCase() !== 'nullif') throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', 'Calculated measures allow only NULLIF(value, 0) as a scalar function.');
    const values = record(node.args)?.value;
    if (!Array.isArray(values) || values.length !== 2) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NULLIF_INVALID', 'Only NULLIF(value, 0) is allowed in a calculated measure.');
    assertParserExpressionShape(values[0]);
    assertParserExpressionShape(values[1]);
    return;
  }
  // Numeric literals have been masked as harmless unqualified columns.
  throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', `Calculated measure expression node ${typeof node.type === 'string' ? node.type : 'unknown'} is not allowed.`);
}

type ExpressionToken =
  | { kind: 'identifier'; value: string }
  | { kind: 'decimal'; value: string }
  | { kind: 'operator'; value: '+' | '-' | '*' | '/' }
  | { kind: 'left_paren' | 'right_paren' | 'comma' | 'star' | 'eof'; value: string };

/** Small owned Pratt parser for the grammar documented in aggregate-expression.ts. */
class DatasetExpressionPrattParser {
  private readonly tokens: ExpressionToken[];
  private position = 0;

  constructor(source: string) {
    this.tokens = lexDatasetExpression(source);
  }

  parse(): DatasetAggregateExpressionV1 {
    const expression = this.parseBinary(0);
    if (this.current().kind !== 'eof') throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', `Unexpected token ${this.current().value || '(end)'} in calculated measure expression.`);
    return expression;
  }

  private parseBinary(minimumPrecedence: number): DatasetAggregateExpressionV1 {
    let left = this.parsePrimary();
    while (true) {
      const next = this.current();
      if (next.kind !== 'operator' || precedence(next.value) < minimumPrecedence) break;
      const operator = this.advance() as Extract<ExpressionToken, { kind: 'operator' }>;
      const right = this.parseBinary(precedence(operator.value) + 1);
      left = { kind: 'binary', operator: operator.value, left, right };
    }
    return left;
  }

  private parsePrimary(): DatasetAggregateExpressionV1 {
    const token = this.current();
    if (token.kind === 'operator' && (token.value === '+' || token.value === '-') && this.peek().kind === 'decimal') {
      this.advance();
      const decimal = this.advance() as Extract<ExpressionToken, { kind: 'decimal' }>;
      return { kind: 'decimal', value: `${token.value === '-' ? '-' : ''}${decimal.value}` };
    }
    if (token.kind === 'decimal') {
      this.advance();
      return { kind: 'decimal', value: token.value };
    }
    if (token.kind === 'left_paren') {
      this.advance();
      const expression = this.parseBinary(0);
      this.expect('right_paren');
      return expression;
    }
    if (token.kind !== 'identifier') throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', `Expected a field, decimal, aggregate, or parenthesized expression; got ${token.value || '(end)'}.`);
    this.advance();
    if (this.current().kind !== 'left_paren') return { kind: 'field', field: token.value };
    this.advance();
    return this.parseFunction(token.value);
  }

  private parseFunction(name: string): DatasetAggregateExpressionV1 {
    const normalized = name.toLowerCase();
    if (normalized === 'nullif') {
      const value = this.parseBinary(0);
      this.expect('comma');
      const zero = this.parseSignedDecimal();
      if (!isZeroLiteral(zero)) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NULLIF_INVALID', 'Only NULLIF(value, 0) is allowed in a calculated measure.');
      this.expect('right_paren');
      return { kind: 'nullif_zero', value };
    }
    if (!['sum', 'count', 'avg', 'min', 'max'].includes(normalized)) {
      throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', `Calculated measure function ${name} is not allowed.`);
    }
    if (normalized === 'count' && (this.current().kind === 'star' || (this.current().kind === 'operator' && this.current().value === '*'))) {
      this.advance();
      this.expect('right_paren');
      return { kind: 'aggregate', function: 'count', countStar: true };
    }
    const distinct = this.current().kind === 'identifier' && this.current().value.toLowerCase() === 'distinct';
    if (distinct) this.advance();
    const field = this.current();
    if (field.kind !== 'identifier' || this.peek().kind === 'left_paren') {
      throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_AGGREGATE_FIELD_MISSING', `${name.toUpperCase()} requires exactly one approved physical field.`);
    }
    this.advance();
    this.expect('right_paren');
    if (distinct && normalized !== 'count') throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_AGGREGATE_INVALID', `Only COUNT may use DISTINCT in a calculated measure.`);
    return { kind: 'aggregate', function: distinct ? 'count_distinct' : normalized as Exclude<DatasetMeasureAggregation, 'ratio' | 'count_distinct'>, field: field.value };
  }

  private parseSignedDecimal(): string {
    const sign = this.current().kind === 'operator' && (this.current().value === '+' || this.current().value === '-')
      ? (this.advance() as Extract<ExpressionToken, { kind: 'operator' }>).value
      : '';
    const decimal = this.current();
    if (decimal.kind !== 'decimal') throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_LITERAL_INVALID', 'NULLIF requires the exact decimal literal 0 as its second argument.');
    this.advance();
    return `${sign}${decimal.value}`;
  }

  private current(): ExpressionToken { return this.tokens[this.position]!; }
  private peek(): ExpressionToken { return this.tokens[this.position + 1] ?? { kind: 'eof', value: '' }; }
  private advance(): ExpressionToken { const token = this.current(); this.position += 1; return token; }
  private expect(kind: ExpressionToken['kind']): void {
    if (this.current().kind !== kind) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', `Expected ${kind.replace('_', ' ')} in calculated measure expression.`);
    this.advance();
  }
}

function lexDatasetExpression(source: string): ExpressionToken[] {
  const tokens: ExpressionToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === '"') {
      let value = '';
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') { value += '"'; index += 2; continue; }
        if (source[index] === '"') { index += 1; closed = true; break; }
        value += source[index++]!;
      }
      if (!closed || !value) throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_FIELD_UNBOUND', 'Calculated measure contains an invalid quoted physical field.');
      tokens.push({ kind: 'identifier', value });
      continue;
    }
    const decimal = source.slice(index).match(/^(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (decimal?.[0]) {
      tokens.push({ kind: 'decimal', value: decimal[0] });
      index += decimal[0].length;
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if (identifier?.[0]) {
      tokens.push({ kind: 'identifier', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    if (character === '+' || character === '-' || character === '*' || character === '/') {
      tokens.push({ kind: 'operator', value: character });
      index += 1;
      continue;
    }
    if (character === '(') { tokens.push({ kind: 'left_paren', value: character }); index += 1; continue; }
    if (character === ')') { tokens.push({ kind: 'right_paren', value: character }); index += 1; continue; }
    if (character === ',') { tokens.push({ kind: 'comma', value: character }); index += 1; continue; }
    if (character === '*') { tokens.push({ kind: 'star', value: character }); index += 1; continue; }
    throw new DatasetAggregateExpressionError('DATASET_EXPRESSION_NODE_UNSUPPORTED', `Calculated measure contains unsupported token ${character}.`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

function maskDatasetExpressionLiterals(source: string): string {
  let index = 0;
  let result = '';
  let counter = 0;
  const marker = `__dql_dataset_literal_${createHash('sha256').update(source).digest('hex').slice(0, 12)}_`;
  while (index < source.length) {
    if (source[index] === '"') {
      const start = index++;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') { index += 2; continue; }
        if (source[index++] === '"') break;
      }
      result += source.slice(start, index);
      continue;
    }
    const signedDecimal = (source[index] === '+' || source[index] === '-') && unaryPosition(source, index)
      ? source.slice(index).match(/^[+-](?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)
      : undefined;
    if (signedDecimal?.[0]) {
      result += `${marker}${counter++}`;
      index += signedDecimal[0].length;
      continue;
    }
    const decimal = source.slice(index).match(/^(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (decimal?.[0]) {
      result += `${marker}${counter++}`;
      index += decimal[0].length;
      continue;
    }
    result += source[index++]!;
  }
  return result;
}

function unaryPosition(source: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = source[cursor]!;
    if (/\s/.test(value)) continue;
    return value === '(' || value === ',' || value === '+' || value === '-' || value === '*' || value === '/';
  }
  return true;
}

function precedence(operator: '+' | '-' | '*' | '/'): number {
  return operator === '*' || operator === '/' ? 20 : 10;
}

function isZeroLiteral(value: string): boolean {
  return /^[+-]?(?:0(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/.test(value);
}
