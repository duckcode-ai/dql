import { describe, expect, it } from 'vitest';
import {
  canonicalDatasetAggregateExpression,
  renderDatasetAggregateExpression,
  validateDatasetAggregateExpression,
} from './aggregate-expression.js';
import { DatasetAggregateExpressionError, parseDatasetAggregateExpression } from './aggregate-expression.node.js';

const fields = ['net_amount', 'margin_amount', 'customer_id', 'order_id'];

describe('Dataset aggregate expressions', () => {
  it('owns and renders a bound ratio of aggregates with decimal-safe division', () => {
    const parsed = parseDatasetAggregateExpression({
      expression: 'SUM(margin_amount) / NULLIF(SUM(net_amount), 0)',
      physicalFields: fields,
    });
    expect(parsed.aggregation).toBe('ratio');
    expect(parsed.dependencies).toEqual(['margin_amount', 'net_amount']);
    expect(parsed.canonicalExpression).toBe('((1.0 * SUM("margin_amount")) / NULLIF(SUM("net_amount"), 0))');
    expect(parsed.fingerprint).toMatch(/^sha256:/);
    expect(renderDatasetAggregateExpression(parsed.expression, { physicalField: (field) => `ds.${field}` }))
      .toBe('((1.0 * SUM(ds.margin_amount)) / NULLIF(SUM(ds.net_amount), 0))');
  });

  it('keeps same-function arithmetic as an additive measure and canonicalizes deterministically', () => {
    const parsed = parseDatasetAggregateExpression({ expression: 'SUM(net_amount) - SUM(margin_amount)', physicalFields: fields });
    expect(parsed.aggregation).toBe('sum');
    expect(canonicalDatasetAggregateExpression(parsed.expression)).toBe(canonicalDatasetAggregateExpression(parsed.expression));
    expect(parsed.dependencies).toEqual(['margin_amount', 'net_amount']);
  });

  it('preserves exact large, signed, and exponent literal spellings', () => {
    const large = parseDatasetAggregateExpression({ expression: 'SUM(net_amount) + 9007199254740993', physicalFields: fields });
    const precise = parseDatasetAggregateExpression({ expression: 'SUM(net_amount) + 0.1234567890123456789', physicalFields: fields });
    const signed = parseDatasetAggregateExpression({ expression: 'SUM(net_amount) + -1e-20', physicalFields: fields });
    expect(large.canonicalExpression).toContain('9007199254740993');
    expect(precise.canonicalExpression).toContain('0.1234567890123456789');
    expect(signed.canonicalExpression).toContain('-1e-20');
  });

  it('supports exactly the approved aggregate forms including deliberate COUNT(*)', () => {
    expect(parseDatasetAggregateExpression({ expression: 'COUNT(DISTINCT customer_id)', physicalFields: fields }).aggregation).toBe('count_distinct');
    expect(parseDatasetAggregateExpression({ expression: 'AVG(net_amount)', physicalFields: fields }).aggregation).toBe('avg');
    expect(() => parseDatasetAggregateExpression({ expression: 'COUNT(*)', physicalFields: fields })).toThrow(/COUNT\(\*\).*not approved/i);
    expect(parseDatasetAggregateExpression({ expression: 'COUNT(*)', physicalFields: fields, allowCountStar: true }).aggregation).toBe('count');
  });

  it.each([
    ['unknown function', 'COALESCE(SUM(net_amount), 0)', 'DATASET_EXPRESSION_NODE_UNSUPPORTED'],
    ['unbound field', 'SUM(secret_amount)', 'DATASET_EXPRESSION_FIELD_UNBOUND'],
    ['row and aggregate mix', 'net_amount + SUM(margin_amount)', 'DATASET_EXPRESSION_ROW_AGGREGATE_MIX'],
    ['subquery', '(SELECT SUM(net_amount) FROM orders)', 'DATASET_EXPRESSION_NODE_UNSUPPORTED'],
    ['window', 'SUM(net_amount) OVER ()', 'DATASET_EXPRESSION_WINDOW_UNSUPPORTED'],
  ])('rejects %s', (_name, expression, code) => {
    try {
      parseDatasetAggregateExpression({ expression, physicalFields: fields });
      throw new Error('Expected expression to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetAggregateExpressionError);
      expect((error as DatasetAggregateExpressionError).code).toBe(code);
    }
  });

  it('fails closed for malformed persisted ASTs', () => {
    const result = validateDatasetAggregateExpression(
      { kind: 'binary', operator: '+', left: { kind: 'field', field: 'net_amount' }, right: { kind: 'decimal', value: '1' } },
      { physicalFields: fields },
    );
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('DATASET_EXPRESSION_ROW_AGGREGATE_MIX');
  });
});
