/**
 * Bounded aggregate expressions for governed Dataset measures.
 *
 * This module deliberately owns the persisted expression shape.  A SQL parser
 * may help a server construct one, but callers never store or trust that
 * parser's AST.  The module is browser-safe: it contains neither Node APIs nor
 * a SQL-parser dependency, so App Studio can display a reviewed expression
 * without gaining a way to authorize arbitrary SQL.
 */

export type DatasetAggregateFunction = 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max';
export type DatasetMeasureAggregation = DatasetAggregateFunction | 'ratio';

export type DatasetAggregateExpressionV1 =
  | { kind: 'decimal'; value: string }
  | { kind: 'field'; field: string }
  | { kind: 'aggregate'; function: DatasetAggregateFunction; field?: string; countStar?: boolean }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: DatasetAggregateExpressionV1; right: DatasetAggregateExpressionV1 }
  | { kind: 'nullif_zero'; value: DatasetAggregateExpressionV1 };

/** JSON-shape guard for descriptors received across the App API boundary. */
export function isDatasetAggregateExpression(value: unknown): value is DatasetAggregateExpressionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === 'decimal') return typeof node.value === 'string';
  if (node.kind === 'field') return typeof node.field === 'string';
  if (node.kind === 'aggregate') {
    return isAggregateFunction(node.function)
      && ((typeof node.field === 'string' && node.countStar !== true) || (node.function === 'count' && node.countStar === true && node.field === undefined));
  }
  if (node.kind === 'nullif_zero') return isDatasetAggregateExpression(node.value);
  return node.kind === 'binary'
    && (node.operator === '+' || node.operator === '-' || node.operator === '*' || node.operator === '/')
    && isDatasetAggregateExpression(node.left)
    && isDatasetAggregateExpression(node.right);
}

export interface DatasetAggregateExpressionRenderOptions {
  /** Return a source-bound, dialect-quoted physical field expression. */
  physicalField: (field: string) => string;
  /** Decimal literal used to make integer division deterministic. */
  decimalOne?: string;
}

export interface DatasetAggregateExpressionValidation {
  valid: boolean;
  diagnostics: Array<{ code: string; message: string; field?: string }>;
  dependencies: string[];
  aggregation?: DatasetMeasureAggregation;
}

/** Stable representation used for proposal hashes and source contract fingerprints. */
export function canonicalDatasetAggregateExpression(expression: DatasetAggregateExpressionV1): string {
  return JSON.stringify(canonicalExpression(expression));
}

/**
 * Render only the owned node set.  Division always promotes the left side to a
 * decimal value; ratio values remain stored as 0..1 and zero denominators stay
 * NULL only when the authored expression explicitly uses NULLIF(..., 0).
 */
export function renderDatasetAggregateExpression(
  expression: DatasetAggregateExpressionV1,
  options: DatasetAggregateExpressionRenderOptions,
): string {
  const decimalOne = options.decimalOne ?? '1.0';
  const render = (node: DatasetAggregateExpressionV1): string => {
    switch (node.kind) {
      case 'decimal':
        return node.value;
      case 'field':
        return options.physicalField(node.field);
      case 'aggregate': {
        if (node.function === 'count' && node.countStar) return 'COUNT(*)';
        if (!node.field) throw new Error(`Aggregate ${node.function} is missing its physical field.`);
        if (node.function === 'count_distinct') return `COUNT(DISTINCT ${options.physicalField(node.field)})`;
        const functionName = node.function.toUpperCase();
        return `${functionName}(${options.physicalField(node.field)})`;
      }
      case 'nullif_zero':
        return `NULLIF(${render(node.value)}, 0)`;
      case 'binary': {
        const left = render(node.left);
        const right = render(node.right);
        if (node.operator === '/') return `((${decimalOne} * ${left}) / ${right})`;
        return `(${left} ${node.operator} ${right})`;
      }
    }
  };
  return render(expression);
}

/**
 * Validate an already-owned AST.  Server parsing calls this after binding raw
 * SQL identifiers to the exact approved physical field names; callers that
 * receive a descriptor can use it to fail closed if a persisted object is
 * malformed.
 */
export function validateDatasetAggregateExpression(
  expression: DatasetAggregateExpressionV1,
  options: { physicalFields: readonly string[]; allowCountStar?: boolean },
): DatasetAggregateExpressionValidation {
  const physical = new Map(options.physicalFields.map((field) => [field.trim().toLowerCase(), field]));
  const diagnostics: DatasetAggregateExpressionValidation['diagnostics'] = [];
  const dependencies = new Set<string>();
  let aggregateCount = 0;

  const check = (node: DatasetAggregateExpressionV1, context: 'root' | 'aggregate_argument' = 'root'): void => {
    if (!node || typeof node !== 'object') {
      diagnostics.push({ code: 'DATASET_EXPRESSION_NODE_INVALID', message: 'The calculated measure contains an invalid expression node.' });
      return;
    }
    if (node.kind === 'decimal') {
      if (!isDecimal(node.value)) diagnostics.push({ code: 'DATASET_EXPRESSION_LITERAL_INVALID', message: 'Calculated measure literals must be finite decimal values.' });
      return;
    }
    if (node.kind === 'field') {
      const bound = physical.get(node.field?.trim().toLowerCase());
      if (!bound) diagnostics.push({ code: 'DATASET_EXPRESSION_FIELD_UNBOUND', field: node.field, message: `Calculated measure field ${node.field || '(empty)'} is not an approved physical field.` });
      else dependencies.add(bound);
      if (context !== 'aggregate_argument') diagnostics.push({ code: 'DATASET_EXPRESSION_ROW_AGGREGATE_MIX', field: node.field, message: `Physical field ${node.field} must be used inside one approved aggregate.` });
      return;
    }
    if (node.kind === 'aggregate') {
      aggregateCount += 1;
      if (!isAggregateFunction(node.function)) {
        diagnostics.push({ code: 'DATASET_EXPRESSION_AGGREGATE_INVALID', message: 'Calculated measure uses an unsupported aggregate function.' });
        return;
      }
      if (node.countStar) {
        if (node.function !== 'count' || node.field) diagnostics.push({ code: 'DATASET_EXPRESSION_COUNT_STAR_INVALID', message: 'Only COUNT(*) may use a star argument.' });
        if (!options.allowCountStar) diagnostics.push({ code: 'DATASET_EXPRESSION_COUNT_STAR_UNAPPROVED', message: 'COUNT(*) is not approved for this Dataset source.' });
        return;
      }
      if (!node.field) {
        diagnostics.push({ code: 'DATASET_EXPRESSION_AGGREGATE_FIELD_MISSING', message: `Aggregate ${node.function} requires one approved physical field.` });
        return;
      }
      check({ kind: 'field', field: node.field }, 'aggregate_argument');
      return;
    }
    if (node.kind === 'nullif_zero') {
      check(node.value, context);
      return;
    }
    if (node.kind === 'binary') {
      if (!['+', '-', '*', '/'].includes(node.operator)) {
        diagnostics.push({ code: 'DATASET_EXPRESSION_OPERATOR_INVALID', message: 'Calculated measure uses an unsupported arithmetic operator.' });
      }
      check(node.left, context);
      check(node.right, context);
      return;
    }
    diagnostics.push({ code: 'DATASET_EXPRESSION_NODE_INVALID', message: 'Calculated measure contains an unsupported expression node.' });
  };

  check(expression);
  if (aggregateCount === 0) diagnostics.push({ code: 'DATASET_EXPRESSION_AGGREGATE_REQUIRED', message: 'A calculated measure must contain at least one approved aggregate.' });
  const aggregation = diagnostics.length === 0 ? inferredDatasetExpressionAggregation(expression) : undefined;
  if (diagnostics.length === 0 && !aggregation) {
    diagnostics.push({ code: 'DATASET_EXPRESSION_AGGREGATION_AMBIGUOUS', message: 'The calculated measure mixes aggregate semantics that cannot be safely represented by one Dataset measure contract.' });
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    dependencies: [...dependencies].sort((left, right) => left.localeCompare(right)),
    ...(aggregation ? { aggregation } : {}),
  };
}

/** Infer the persisted Dataset aggregation only when the expression proves one. */
export function inferredDatasetExpressionAggregation(expression: DatasetAggregateExpressionV1): DatasetMeasureAggregation | undefined {
  const aggregateFunctions = new Set<DatasetAggregateFunction>();
  let divides = false;
  const visit = (node: DatasetAggregateExpressionV1): void => {
    if (node.kind === 'aggregate') aggregateFunctions.add(node.function);
    else if (node.kind === 'binary') {
      if (node.operator === '/') divides = true;
      visit(node.left);
      visit(node.right);
    } else if (node.kind === 'nullif_zero') visit(node.value);
  };
  visit(expression);
  if (divides) return aggregateFunctions.size > 0 ? 'ratio' : undefined;
  return aggregateFunctions.size === 1 ? [...aggregateFunctions][0] : undefined;
}

function canonicalExpression(expression: DatasetAggregateExpressionV1): DatasetAggregateExpressionV1 {
  switch (expression.kind) {
    case 'decimal': return { kind: 'decimal', value: expression.value };
    case 'field': return { kind: 'field', field: expression.field };
    case 'aggregate': return expression.countStar
      ? { kind: 'aggregate', function: expression.function, countStar: true }
      : { kind: 'aggregate', function: expression.function, field: expression.field ?? '' };
    case 'nullif_zero': return { kind: 'nullif_zero', value: canonicalExpression(expression.value) };
    case 'binary': return { kind: 'binary', operator: expression.operator, left: canonicalExpression(expression.left), right: canonicalExpression(expression.right) };
  }
}

function isAggregateFunction(value: unknown): value is DatasetAggregateFunction {
  return value === 'sum' || value === 'count' || value === 'count_distinct' || value === 'avg' || value === 'min' || value === 'max';
}

function isDecimal(value: unknown): boolean {
  return typeof value === 'string' && /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
}
