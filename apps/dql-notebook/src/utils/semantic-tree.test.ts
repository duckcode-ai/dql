import { describe, expect, it } from 'vitest';
import type { SemanticLayerState, SemanticTreeNode } from '../store/types';
import { buildSemanticTreeFromLayer, scopeSemanticTreeForComposition } from './semantic-tree';

function layerWithMetrics(count: number): SemanticLayerState {
  return {
    available: true,
    provider: 'dbt',
    metrics: Array.from({ length: count }, (_, index) => ({
      name: `metric_${index}`,
      label: `Metric ${index}`,
      description: '',
      domain: `domain_${index % 20}`,
      sql: `metric_${index}`,
      type: 'custom',
      table: `model_${index % 4_000}`,
      tags: [],
      owner: null,
    })),
    measures: [],
    dimensions: [],
    timeDimensions: [],
    entities: [],
    hierarchies: [],
    semanticModels: [],
    savedQueries: [],
    domains: Array.from({ length: 20 }, (_, index) => `domain_${index}`),
    tags: [],
    favorites: [],
    recentlyUsed: [],
    loading: false,
    lastSyncTime: null,
  };
}

describe('buildSemanticTreeFromLayer', () => {
  it('renders a 7,500-metric catalog from the canonical layer without another API shape', () => {
    const tree = buildSemanticTreeFromLayer(layerWithMetrics(7_500));
    const domains = tree?.children?.[0]?.children ?? [];
    const metricCount = JSON.stringify(tree).match(/"kind":"metric"/g)?.length ?? 0;

    expect(domains).toHaveLength(20);
    expect(metricCount).toBe(7_500);
  });

  it('returns no tree while the canonical catalog is empty', () => {
    expect(buildSemanticTreeFromLayer(layerWithMetrics(0))).toBeNull();
  });

  it('preserves model-scoped dimension identities and dbt adapter aliases', () => {
    const layer = layerWithMetrics(1);
    layer.metrics[0].label = 'Gross revenue';
    layer.metrics[0].name = 'gross_revenue';
    layer.dimensions = [
      {
        name: 'customer_name',
        reference: 'orders.customer_name',
        canonicalId: 'dbt:dimension:orders:customer_name',
        qualifiedName: 'order__customer_name',
        entityLink: 'order',
        label: 'Customer',
        description: '',
        sql: 'customer_name',
        type: 'categorical',
        table: 'orders',
        cube: 'orders',
        tags: [],
        owner: null,
      },
      {
        name: 'customer_name',
        reference: 'customers.customer_name',
        canonicalId: 'dbt:dimension:customers:customer_name',
        qualifiedName: 'customer__customer_name',
        entityLink: 'customer',
        label: 'Customer',
        description: '',
        sql: 'customer_name',
        type: 'categorical',
        table: 'customers',
        cube: 'customers',
        tags: [],
        owner: null,
      },
    ];

    const tree = buildSemanticTreeFromLayer(layer);
    const dimensions: SemanticTreeNode[] = [];
    const visit = (node: SemanticTreeNode) => {
      if (node.kind === 'dimension') dimensions.push(node);
      for (const child of node.children ?? []) visit(child);
    };
    if (tree) visit(tree);

    expect(dimensions.map((node) => node.id)).toEqual([
      'dimension:customers.customer_name',
      'dimension:orders.customer_name',
    ]);
    expect(dimensions[0].meta).toMatchObject({
      localName: 'customer_name',
      reference: 'customers.customer_name',
      qualifiedName: 'customer__customer_name',
      canonicalId: 'dbt:dimension:customers:customer_name',
    });
  });

  it('ID-001/UI-009 groups business metrics and members under their semantic model without a duplicate model leaf', () => {
    const layer = layerWithMetrics(0);
    layer.semanticModels = [{
      name: 'orders',
      label: 'Orders',
      description: '',
      domain: 'commerce',
      table: 'orders',
      entities: ['order'],
      measures: ['gross_revenue'],
      dimensions: ['customer_name'],
      timeDimensions: [],
      tags: [],
      owner: null,
    }];
    layer.metrics = [{
      name: 'gross_revenue',
      label: 'Gross revenue',
      description: '',
      domain: 'commerce',
      cube: 'orders',
      semanticModelIds: ['orders'],
      sql: 'gross_revenue',
      type: 'sum',
      table: 'orders',
      tags: [],
      owner: null,
    }];
    layer.measures = [{
      name: 'gross_revenue_measure',
      label: 'Gross revenue measure',
      description: '',
      domain: 'commerce',
      agg: 'sum',
      table: 'orders',
      cube: 'orders',
      tags: [],
      owner: null,
    }];
    layer.dimensions = [{
      name: 'customer_name',
      reference: 'orders.customer_name',
      label: 'Customer',
      description: '',
      domain: 'commerce',
      sql: 'customer_name',
      type: 'categorical',
      table: 'orders',
      cube: 'orders',
      tags: [],
      owner: null,
    }];

    const tree = buildSemanticTreeFromLayer(layer);
    const serialized = JSON.stringify(tree);
    expect(serialized.match(/"id":"semantic_model:orders"/g)).toHaveLength(1);
    expect(serialized).toContain('"label":"Metrics"');
    expect(serialized).toContain('"label":"Underlying measures"');
    expect(serialized).toContain('"id":"dimension:orders.customer_name"');
  });

  it('UI-009 projects only exact governed dimensions after metric selection', () => {
    const layer = layerWithMetrics(0);
    layer.metrics = [{
      name: 'gross_revenue',
      label: 'Gross revenue',
      description: '',
      domain: 'commerce',
      cube: 'orders',
      semanticModelIds: ['orders'],
      sql: 'gross_revenue',
      type: 'sum',
      table: 'orders',
      tags: [],
      owner: null,
    }];
    layer.dimensions = [
      {
        name: 'report_date',
        reference: 'orders.report_date',
        label: 'Order date',
        description: '',
        domain: 'commerce',
        sql: 'report_date',
        type: 'date',
        table: 'orders',
        cube: 'orders',
        tags: [],
        owner: null,
      },
      {
        name: 'report_date',
        reference: 'accounts.report_date',
        label: 'Account snapshot date',
        description: '',
        domain: 'commerce',
        sql: 'report_date',
        type: 'date',
        table: 'accounts',
        cube: 'accounts',
        tags: [],
        owner: null,
      },
    ];
    const tree = buildSemanticTreeFromLayer(layer)!;

    const metricOnly = scopeSemanticTreeForComposition(tree, 0, null, 'idle');
    expect(JSON.stringify(metricOnly)).toContain('"kind":"metric"');
    expect(JSON.stringify(metricOnly)).not.toContain('"kind":"dimension"');

    const scoped = scopeSemanticTreeForComposition(
      tree,
      1,
      new Set(['orders.report_date']),
      'ready',
    );
    expect(JSON.stringify(scoped)).toContain('"id":"dimension:orders.report_date"');
    expect(JSON.stringify(scoped)).not.toContain('"id":"dimension:accounts.report_date"');
    expect(JSON.stringify(scoped)).not.toContain('"kind":"measure"');
  });
});
