import { describe, expect, it } from 'vitest';
import { buildGovernedMetricFirstSql } from './metric-match.js';
import type { KGNode } from '../kg/types.js';

function metricNode(name: string, llmContext?: string): KGNode {
  return {
    nodeId: `metric:${name}`,
    kind: 'metric',
    name,
    llmContext,
  } as KGNode;
}

const SCHEMA_TABLES = [
  {
    relation: 'dev.order_items',
    name: 'order_items',
    columns: [{ name: 'category' }, { name: 'product_name' }, { name: 'product_price' }, { name: 'region_code' }],
  },
];

const REVENUE = metricNode('order_item.revenue', 'sql: SUM(product_price)\ntable: dev.order_items');

describe('buildGovernedMetricFirstSql — Tier 2 governed hierarchy', () => {
  it('scalar KPI: executes the metric definition with no dimensions', () => {
    const out = buildGovernedMetricFirstSql({
      metric: REVENUE,
      pool: [REVENUE],
      requestedShape: { dimensions: [], measures: ['revenue'], filters: [] },
      schemaTables: SCHEMA_TABLES,
    });
    expect(out?.sql).toContain('SELECT SUM(product_price) AS order_item_revenue');
    expect(out?.sql).toContain('FROM dev.order_items');
    expect(out?.dimensions).toEqual([]);
  });

  it('dimensional: group-by when every requested dimension resolves to a table column', () => {
    const out = buildGovernedMetricFirstSql({
      metric: REVENUE,
      pool: [REVENUE],
      requestedShape: {
        dimensions: ['category'],
        measures: ['revenue'],
        filters: [],
        topN: { n: 5, scope: 'overall' },
        rankingDirection: 'top',
      },
      schemaTables: SCHEMA_TABLES,
    });
    expect(out?.sql).toContain('SELECT category, SUM(product_price) AS order_item_revenue');
    expect(out?.sql).toContain('GROUP BY category');
    expect(out?.sql).toContain('ORDER BY order_item_revenue DESC');
    expect(out?.sql).toContain('LIMIT 5');
  });

  it('resolves plural and suffixed dimension names (regions → region_code)', () => {
    const out = buildGovernedMetricFirstSql({
      metric: REVENUE,
      pool: [REVENUE],
      requestedShape: { dimensions: ['region'], measures: ['revenue'], filters: [] },
      schemaTables: [{
        relation: 'dev.order_items',
        columns: [{ name: 'order_region' }, { name: 'product_price' }],
      }],
    });
    expect(out?.sql).toContain('GROUP BY order_region');
  });

  it('falls through when a requested dimension cannot resolve to the metric table', () => {
    const out = buildGovernedMetricFirstSql({
      metric: REVENUE,
      pool: [REVENUE],
      requestedShape: { dimensions: ['customer'], measures: ['revenue'], filters: [] },
      schemaTables: SCHEMA_TABLES,
    });
    expect(out).toBeUndefined();
  });

  it('falls through on explicit filters, multi-measure, and per-group top-N', () => {
    const base = { metric: REVENUE, pool: [REVENUE], schemaTables: SCHEMA_TABLES };
    expect(buildGovernedMetricFirstSql({
      ...base,
      requestedShape: { dimensions: ['category'], measures: ['revenue'], filters: ['Food'] },
    })).toBeUndefined();
    expect(buildGovernedMetricFirstSql({
      ...base,
      requestedShape: { dimensions: ['category'], measures: ['revenue', 'orders'], filters: [] },
    })).toBeUndefined();
    expect(buildGovernedMetricFirstSql({
      ...base,
      requestedShape: {
        dimensions: ['category'],
        measures: ['revenue'],
        filters: [],
        topN: { n: 3, scope: 'per_group' },
      },
    })).toBeUndefined();
  });

  it('resolves a thin derived metric through its leaf-named sibling measure', () => {
    const thin = metricNode('revenue');
    const out = buildGovernedMetricFirstSql({
      metric: thin,
      pool: [thin, REVENUE],
      requestedShape: { dimensions: [], measures: ['revenue'], filters: [] },
      schemaTables: SCHEMA_TABLES,
    });
    expect(out?.metric.name).toBe('order_item.revenue');
    expect(out?.sql).toContain('SUM(product_price)');
  });
});
