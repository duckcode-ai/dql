import { describe, it, expect } from 'vitest';
import { matchSemanticMetric } from './metric-match.js';
import type { KGNode } from '../kg/types.js';

function metric(name: string, description = '', tags: string[] = []): KGNode {
  return {
    nodeId: `metric:${name}`,
    kind: 'metric',
    name,
    description,
    tags,
    llmContext: `sql: SUM(amount)\ntable: dev.order_items`,
    sourceTier: 'semantic_layer',
  };
}

describe('matchSemanticMetric (spec 17, part C)', () => {
  const jaffleMetrics: KGNode[] = [
    metric('cumulative_revenue', 'Running total of recognized revenue'),
    metric('food_revenue', 'Revenue from food line items'),
    metric('drink_revenue', 'Revenue from drink line items'),
    metric('lifetime_spend', 'Total customer spend across all orders'),
    metric('order_count', 'Number of orders placed'),
  ];

  it('connects "total revenue" to a revenue-family metric (the reported miss)', async () => {
    const match = await matchSemanticMetric('what is our total revenue', jaffleMetrics);
    expect(match).not.toBeNull();
    expect(match!.metric.name).toMatch(/revenue/);
    expect(match!.family).toBe('revenue');
  });

  it('prefers the named family member for "food revenue"', async () => {
    const match = await matchSemanticMetric('show me food revenue', jaffleMetrics);
    expect(match).not.toBeNull();
    expect(match!.metric.name).toBe('food_revenue');
  });

  it('matches a synonym ("sales") into the revenue family', async () => {
    const match = await matchSemanticMetric('what were total sales', jaffleMetrics);
    expect(match).not.toBeNull();
    expect(match!.family).toBe('revenue');
  });

  it('returns null for a bare non-measure question (honest no-match)', async () => {
    const match = await matchSemanticMetric('what is this?', jaffleMetrics);
    expect(match).toBeNull();
  });

  it('returns null when no metric is in the question family (ad-hoc falls through)', async () => {
    const match = await matchSemanticMetric('median order value by region', [
      metric('cumulative_revenue', 'Running total of recognized revenue'),
    ]);
    // "order value" shares no revenue/spend family with cumulative_revenue and
    // has weak lexical overlap → stays below threshold so generated SQL handles it.
    expect(match).toBeNull();
  });

  it('is deterministic across runs (offline alpha=0)', async () => {
    const a = await matchSemanticMetric('total revenue this quarter', jaffleMetrics);
    const b = await matchSemanticMetric('total revenue this quarter', jaffleMetrics);
    expect(a?.metric.name).toBe(b?.metric.name);
  });
});
