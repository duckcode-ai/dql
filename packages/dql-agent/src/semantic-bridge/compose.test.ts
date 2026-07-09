import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { composeSemanticQueryForQuestion, composeSemanticQueryFromMembers } from './compose.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';

function layer(): SemanticLayer {
  return new SemanticLayer({
    metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: 'Recognized revenue.', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' }],
    dimensions: [{ name: 'channel', label: 'Channel', description: 'Sales channel.', domain: 'finance', sql: 'channel', type: 'string', table: 'orders' }],
  });
}

describe('composeSemanticQueryFromMembers — hollow-answer guard', () => {
  it('rejects a degenerate compile (empty/blank SQL) so the loop falls through to generation', () => {
    // Reproduces the "Answered from governed semantic metrics … " with an EMPTY SQL
    // preview and no rows: an incompatible metric×dimension combo compiles to blank
    // SQL. Accepting it would surface a hollow governed answer; it must be rejected.
    const l = layer();
    (l as unknown as { composeQuery: () => { sql: string } }).composeQuery = () => ({ sql: '   ' });
    const result = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question: 'top customers who bought the top products with revenue',
      selection: { metrics: ['total_revenue'], dimensions: ['channel'] },
    });
    expect(result).toBeUndefined();
  });

  it('accepts a real compiled query with executable SQL', () => {
    const l = layer();
    (l as unknown as { composeQuery: () => { sql: string } }).composeQuery = () =>
      ({ sql: 'SELECT channel, SUM(amount) AS total_revenue FROM orders GROUP BY channel' });
    const result = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question: 'revenue by channel',
      selection: { metrics: ['total_revenue'], dimensions: ['channel'] },
    });
    expect(result?.sql).toContain('SELECT channel');
    expect(result?.metrics).toEqual(['total_revenue']);
  });
});

describe('composeSemanticQueryForQuestion — grain-aware metric disambiguation', () => {
  // Mirrors the real jaffle project: two revenue metrics at different grains. The
  // measure-family match picks one, but only the product-grain metric can be
  // grouped "by product". Previously the wrong-grain pick failed to compose and the
  // question fell to raw generation; now the retry lands on the composable metric.
  function twoGrainLayer(): SemanticLayer {
    return new SemanticLayer({
      metrics: [
        { name: 'total_revenue', label: 'Total Revenue', description: 'Gross revenue.', domain: 'revenue', sql: 'order_total', type: 'sum', table: 'orders' },
        { name: 'product_revenue', label: 'Product Revenue', description: 'Item revenue.', domain: 'products', sql: 'product_price', type: 'sum', table: 'order_items' },
      ],
      dimensions: [
        { name: 'location_name', label: 'Location', description: 'Store location.', domain: 'revenue', sql: 'location_name', type: 'string', table: 'orders' },
        { name: 'product_name', label: 'Product', description: 'Product name.', domain: 'products', sql: 'product_name', type: 'string', table: 'order_items' },
      ],
    });
  }

  it("composes the product-grain metric for 'total revenue by product' (not the all-orders one)", () => {
    const l = twoGrainLayer();
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question: 'total revenue by product',
      questionPlan: buildAnalysisQuestionPlan('total revenue by product'),
    });
    expect(result?.sql).toContain('SUM(product_price)');
    expect(result?.sql).toContain('product_name');
    expect(result?.metric).toBe('product_revenue');
  });

  it("still composes the all-orders metric for a breakdown its grain DOES cover", () => {
    const l = twoGrainLayer();
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question: 'total revenue by location',
      questionPlan: buildAnalysisQuestionPlan('total revenue by location'),
    });
    expect(result?.sql).toContain('SUM(order_total)');
    expect(result?.sql).toContain('location_name');
    expect(result?.metric).toBe('total_revenue');
  });
});
