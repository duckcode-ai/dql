import { describe, it, expect } from 'vitest';
import { buildLineageGraph } from './builder.js';
import { queryBusiness360 } from './query.js';
import { buildDerivationWalk } from './derivation.js';

function customerGraph() {
  return buildLineageGraph(
    [
      {
        name: 'Customer Revenue',
        sql: 'SELECT customer_id, SUM(amount) AS revenue FROM fct_orders GROUP BY 1',
        domain: 'Customer',
        status: 'certified',
        owner: 'finance-team',
        reviewCadence: 'monthly',
        businessOutcome: 'Tracks revenue per customer for account planning.',
        termRefs: ['Customer'],
      },
    ],
    [],
    [],
    {
      dbtModels: [
        { name: 'fct_orders', uniqueId: 'model.shop.fct_orders', type: 'model', dependsOn: ['source.shop.raw.orders'] },
        { name: 'raw_orders', uniqueId: 'source.shop.raw.orders', type: 'source', dependsOn: [] },
      ],
      terms: [
        { name: 'Customer', domain: 'Customer', termType: 'entity', owner: 'data-gov', description: 'A buyer.' },
      ],
      dashboards: [{ name: 'Customer Health', blocks: ['Customer Revenue'], charts: [] }],
    },
  );
}

describe('buildDerivationWalk', () => {
  it('assembles a value → block → term → model/source walk from queryBusiness360', () => {
    const graph = customerGraph();
    const business360 = queryBusiness360(graph, 'Customer Revenue');
    expect(business360).not.toBeNull();

    const walk = buildDerivationWalk({
      business360: business360!,
      block: {
        name: 'Customer Revenue',
        owner: 'finance-team',
        status: 'certified',
        reviewCadence: 'monthly',
        caveats: ['Excludes refunds.'],
        termRefs: ['Customer'],
        metricRefs: ['total_revenue'],
      },
      value: '$1.2M',
    });

    const kinds = walk.steps.map((step) => step.kind);
    // Ordered: value first, block next, then term, metric, then model/source.
    expect(kinds[0]).toBe('value');
    expect(kinds[1]).toBe('block');
    expect(kinds).toContain('term');
    expect(kinds).toContain('metric');
    expect(kinds).toContain('model');
    expect(kinds).toContain('source');
    // value before block before model.
    expect(kinds.indexOf('value')).toBeLessThan(kinds.indexOf('block'));
    expect(kinds.indexOf('block')).toBeLessThan(kinds.indexOf('model'));

    const blockStep = walk.steps.find((step) => step.kind === 'block');
    expect(blockStep?.name).toBe('Customer Revenue');
    expect(blockStep?.owner).toBe('finance-team');
    expect(blockStep?.status).toBe('certified');
    // reviewCadence surfaces in the block step detail.
    expect(blockStep?.detail).toContain('monthly');

    expect(walk.steps.some((step) => step.kind === 'model' && step.name === 'fct_orders')).toBe(true);
    expect(walk.value).toBe('$1.2M');
  });

  it('surfaces block caveats and reviewCadence in the walk', () => {
    const graph = customerGraph();
    const business360 = queryBusiness360(graph, 'Customer Revenue')!;

    const walk = buildDerivationWalk({
      business360,
      block: {
        name: 'Customer Revenue',
        reviewCadence: 'quarterly',
        caveats: ['Excludes refunds.', 'Self-serve only.'],
      },
    });

    expect(walk.caveats).toEqual(['Excludes refunds.', 'Self-serve only.']);
    const blockStep = walk.steps.find((step) => step.kind === 'block');
    expect(blockStep?.detail).toContain('quarterly');
  });

  it('ends a generated (Tier-2) walk in a review-required state', () => {
    const graph = customerGraph();
    const business360 = queryBusiness360(graph, 'Customer Revenue')!;

    const walk = buildDerivationWalk({
      business360,
      block: { name: 'Customer Revenue' },
      value: '$980K',
      generated: true,
    });

    expect(walk.trustLabel).toBe('review_required');
    expect(walk.summary.toLowerCase()).toContain('review');
    // Still produces the full walk, not the raw graph.
    expect(walk.steps.some((step) => step.kind === 'block')).toBe(true);
    expect(walk.steps.some((step) => step.kind === 'model')).toBe(true);
  });

  it('falls back to focus governance metadata when no block descriptor is given', () => {
    const graph = customerGraph();
    const business360 = queryBusiness360(graph, 'Customer Revenue')!;

    const walk = buildDerivationWalk({ business360 });

    const blockStep = walk.steps.find((step) => step.kind === 'block');
    expect(blockStep?.owner).toBe('finance-team');
    expect(blockStep?.status).toBe('certified');
    // reviewCadence lives in the lineage node metadata for blocks.
    expect(blockStep?.detail).toContain('monthly');
  });

  it('respects optional trustLabel / freshness without requiring them', () => {
    const graph = customerGraph();
    const business360 = queryBusiness360(graph, 'Customer Revenue')!;

    const bare = buildDerivationWalk({ business360 });
    expect(bare.trustLabel).toBeUndefined();
    expect(bare.freshness).toBeUndefined();

    const enriched = buildDerivationWalk({
      business360,
      trustLabel: 'certified_fresh',
      freshness: '2026-06-26T00:00:00Z',
    });
    expect(enriched.trustLabel).toBe('certified_fresh');
    expect(enriched.freshness).toBe('2026-06-26T00:00:00Z');
  });

  it('caps steps per kind to keep the walk compact', () => {
    const graph = customerGraph();
    const business360 = queryBusiness360(graph, 'Customer Revenue')!;

    const walk = buildDerivationWalk({
      business360,
      block: {
        name: 'Customer Revenue',
        metricRefs: ['a', 'b', 'c', 'd', 'e'],
      },
      maxPerKind: 2,
    });

    expect(walk.steps.filter((step) => step.kind === 'metric')).toHaveLength(2);
  });
});
