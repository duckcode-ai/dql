import { describe, it, expect } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { matchSemanticMetric, parseMetricDefinition } from './metric-match.js';
import type { KGNode } from '../kg/types.js';

describe('parseMetricDefinition (R2.6: structured-first, regex fallback)', () => {
  const node: KGNode = {
    nodeId: 'metric:total_revenue',
    kind: 'metric',
    name: 'total_revenue',
    description: '',
    tags: [],
    // Deliberately WRONG/stale llmContext to prove the structured def wins.
    llmContext: 'sql: SUM(stale_col)\ntable: dev.stale_table',
    sourceTier: 'semantic_layer',
  };

  it('prefers the structured semantic-layer definition over the llmContext blob', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: '', domain: 'finance', sql: 'SUM(amount)', type: 'sum', table: 'orders' }],
      dimensions: [],
    });
    expect(parseMetricDefinition(node, layer)).toEqual({ expr: 'SUM(amount)', table: 'orders' });
  });

  it('falls back to the llmContext blob when the semantic layer lacks the metric', () => {
    const layer = new SemanticLayer({ metrics: [], dimensions: [] });
    expect(parseMetricDefinition(node, layer)).toEqual({ expr: 'SUM(stale_col)', table: 'dev.stale_table' });
    // And with no layer at all.
    expect(parseMetricDefinition(node)).toEqual({ expr: 'SUM(stale_col)', table: 'dev.stale_table' });
  });

  it('rejects a degenerate metric expression (empty parens) instead of synthesizing hollow SQL', () => {
    // `COUNT()` used to pass the bare /[()]/ gate and produce `SELECT COUNT() AS x`.
    const degenerate: KGNode = { ...node, llmContext: 'sql: COUNT()\ntable: dev.orders' };
    expect(parseMetricDefinition(degenerate)).toBeUndefined();
    // Structured path: a real aggregate is accepted, and a whitespace-only table
    // no longer survives to synthesize `FROM   `.
    const okLayer = new SemanticLayer({
      metrics: [{ name: 'total_revenue', label: '', description: '', domain: 'finance', sql: 'COUNT(*)', type: 'count', table: '  orders  ' }],
      dimensions: [],
    });
    expect(parseMetricDefinition(node, okLayer)).toEqual({ expr: 'COUNT(*)', table: 'orders' });
    const badLayer = new SemanticLayer({
      metrics: [{ name: 'total_revenue', label: '', description: '', domain: 'finance', sql: 'SUM()', type: 'sum', table: 'orders' }],
      dimensions: [],
    });
    // Degenerate structured expr falls through to the (stale-but-valid) blob.
    expect(parseMetricDefinition(node, badLayer)).toEqual({ expr: 'SUM(stale_col)', table: 'dev.stale_table' });
  });
});

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

  it('finds a governed metric beyond the first 400 entries in an enterprise catalog', async () => {
    const enterpriseMetrics = Array.from({ length: 7_000 }, (_, index) => metric(`metric_${index}`));
    enterpriseMetrics[6_789] = metric('recognized_partner_revenue', 'Recognized partner revenue after refunds.');
    const match = await matchSemanticMetric('recognized partner revenue', enterpriseMetrics);
    expect(match?.metric.name).toBe('recognized_partner_revenue');
  });

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

  it('matches an underscored, non-revenue-family metric name (P5a — the reported avg_tax_rate miss)', async () => {
    // 'tax' is in no MEASURE_FAMILY, so this match rests entirely on the NAME-token
    // boost — which never fired before P5a because tokenize('avg_tax_rate') stayed one
    // glued token. A decoy on the same table must not win.
    const taxMetrics: KGNode[] = [
      metric('avg_tax_rate', 'Average tax rate on order items'),
      metric('total_shipping_cost', 'Total shipping cost per order'),
    ];
    const match = await matchSemanticMetric('what is the average tax rate', taxMetrics);
    expect(match).not.toBeNull();
    expect(match!.metric.name).toBe('avg_tax_rate');
  });

  it('matches a synonym ("sales") into the revenue family', async () => {
    const match = await matchSemanticMetric('what were total sales', jaffleMetrics);
    expect(match).not.toBeNull();
    expect(match!.family).toBe('revenue');
  });

  it('advances a strong description match to compiler validation even when the metric name differs', async () => {
    const match = await matchSemanticMetric('customer lifetime contribution', [
      metric('ltv_adjusted', 'Customer lifetime contribution after refunds'),
      metric('shipment_velocity', 'Average time to deliver an order'),
    ]);
    expect(match?.metric.name).toBe('ltv_adjusted');
    expect(match?.basis).toBe('description');
  });

  it('does not promote a weak one-word description overlap', async () => {
    const match = await matchSemanticMetric('monthly cohort performance', [
      metric('shipment_velocity', 'Monthly average delivery duration'),
    ]);
    expect(match).toBeNull();
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

  it('is deterministic across runs with the offline default embedding blend', async () => {
    const a = await matchSemanticMetric('total revenue this quarter', jaffleMetrics);
    const b = await matchSemanticMetric('total revenue this quarter', jaffleMetrics);
    expect(a?.metric.name).toBe(b?.metric.name);
  });
});

describe('executability-aware selection (Slice 2)', () => {
  const metricNode = (name: string, description: string) => ({
    nodeId: `metric:${name}`,
    kind: 'metric' as const,
    name,
    description,
    status: 'certified',
  }) as never;

  it('prefers the executable sibling on a lexical tie', async () => {
    const metrics = [
      metricNode('total_acm', 'Total ACM consumption measured daily'),
      metricNode('percent_dod_acm', 'Percent day over day ACM consumption measured daily'),
    ];
    const match = await matchSemanticMetric('what is the total ACM consumption', metrics, {
      canExecute: (name) => name === 'total_acm',
    });
    expect(match?.metric.name).toBe('total_acm');
  });

  it('still surfaces a runtime-only metric on a strong direct name match', async () => {
    const metrics = [
      metricNode('total_acm', 'Total ACM consumption measured daily'),
      metricNode('percent_dod_acm', 'Percent day over day ACM consumption measured daily'),
    ];
    const match = await matchSemanticMetric('show percent dod acm', metrics, {
      canExecute: (name) => name === 'total_acm',
    });
    expect(match?.metric.name).toBe('percent_dod_acm');
  });

  it('keeps a CLEARLY better runtime-only match over a weaker executable sibling (honest beats wrong)', async () => {
    // "consumption % by customer" — the ratio metric is the intent; the
    // executable total must NOT silently answer instead.
    const metrics = [
      metricNode('total_consumption', 'Total consumption'),
      metricNode('consumption_percent_share', 'Consumption percent share of total by customer, percentage breakdown'),
    ];
    const match = await matchSemanticMetric('consumption percent share by customer', metrics, {
      canExecute: (name) => name === 'total_consumption',
    });
    expect(match?.metric.name).toBe('consumption_percent_share');
  });

  it('changes nothing when no executability signal is supplied', async () => {
    const metrics = [metricNode('total_acm', 'Total ACM consumption measured daily')];
    const match = await matchSemanticMetric('total acm consumption', metrics, {});
    expect(match?.metric.name).toBe('total_acm');
  });
});

describe('name-proximity tie-breaker (BCM sibling metrics)', () => {
  // "who are the top 10 customers for BCM" scored total_bcm and percent_mom_bcm
  // identically (same name-token hit + family) and the alphabetical fallback
  // picked the month-over-month RATIO. The base metric — fewest name tokens the
  // question never said — must win the tie.
  const bcmMetrics: KGNode[] = [
    metric('percent_mom_bcm', 'Month over month percent change in billed consumption'),
    metric('percent_dod_bcm', 'Day over day percent change in billed consumption'),
    metric('total_bcm', 'Total billed consumption'),
  ];

  it('picks the base metric for a bare measure mention', async () => {
    const match = await matchSemanticMetric('who are the top 10 customers for BCM', bcmMetrics, {
      measureTerms: ['bcm'],
    });
    expect(match?.metric.name).toBe('total_bcm');
  });

  it('still picks the ratio metric when the question asks for it', async () => {
    const match = await matchSemanticMetric('percent month over month BCM change', bcmMetrics, {
      measureTerms: ['percent mom bcm'],
    });
    expect(match?.metric.name).toBe('percent_mom_bcm');
  });
});
