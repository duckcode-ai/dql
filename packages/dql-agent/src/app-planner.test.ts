import { describe, it, expect } from 'vitest';
import { planApp, type PlanBlock } from './app-planner.js';
import type { KGNode } from './kg/types.js';

const revenueMetric: KGNode = {
  nodeId: 'metric:revenue',
  kind: 'metric',
  name: 'revenue',
  description: 'Total product revenue',
  llmContext: 'label: revenue\naggregation: sum\ntable: order_items\nsql: SUM(product_price)',
};

const revenueBlock: PlanBlock = {
  name: 'revenue',
  domain: 'marts',
  metricRef: 'revenue',
  allowedFilters: ['ordered_at', 'region'],
};

describe('planApp', () => {
  it('decomposes a goal into KPI + trend + requested breakdown, all covered', async () => {
    const plan = await planApp({ goal: 'revenue by region', metrics: [revenueMetric], blocks: [revenueBlock] });
    const kinds = plan.sections.map((s) => s.kind);
    expect(kinds).toContain('kpi');
    expect(kinds).toContain('trend');     // ordered_at present
    expect(kinds).toContain('breakdown'); // by region
    expect(plan.sections.find((s) => s.kind === 'breakdown')?.dimension).toBe('region');
    expect(plan.coverage).toBe(1);
    expect(plan.gaps).toHaveLength(0);
  });

  it('surfaces the shared filters that refresh every tile', async () => {
    const plan = await planApp({ goal: 'revenue by region', metrics: [revenueMetric], blocks: [revenueBlock] });
    expect(plan.sharedFilters).toContain('region');
    expect(plan.sharedFilters).toContain('ordered_at');
  });

  it('writes a narrative that names the metric and the refresh behavior', async () => {
    const plan = await planApp({ goal: 'revenue by region', metrics: [revenueMetric], blocks: [revenueBlock] });
    expect(plan.narrative.toLowerCase()).toContain('revenue');
    expect(plan.narrative.toLowerCase()).toContain('refreshes every tile');
  });

  it('reports a gap when a requested breakdown has no covering block', async () => {
    // The block only allows region; ask for a breakdown by a dim it does not declare.
    const plan = await planApp({ goal: 'revenue by product_category', metrics: [revenueMetric], blocks: [revenueBlock] });
    const breakdown = plan.sections.find((s) => s.dimension === 'product_category');
    expect(breakdown?.covered).toBe(false);
    expect(plan.gaps.length).toBeGreaterThan(0);
    expect(plan.coverage).toBeLessThan(1);
  });

  it('falls back to available categorical dimensions when none are requested', async () => {
    const plan = await planApp({ goal: 'revenue', metrics: [revenueMetric], blocks: [revenueBlock] });
    // No "by X" in the goal → uses the block's categorical filters (region).
    expect(plan.sections.some((s) => s.dimension === 'region')).toBe(true);
  });
});
