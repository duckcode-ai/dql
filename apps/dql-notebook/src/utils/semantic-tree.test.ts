import { describe, expect, it } from 'vitest';
import type { SemanticLayerState } from '../store/types';
import { buildSemanticTreeFromLayer } from './semantic-tree';

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
    const metricCount = domains.reduce((total, domain) =>
      total + (domain.children?.find((group) => group.label === 'Metrics')?.children?.length ?? 0), 0);

    expect(domains).toHaveLength(20);
    expect(metricCount).toBe(7_500);
  });

  it('returns no tree while the canonical catalog is empty', () => {
    expect(buildSemanticTreeFromLayer(layerWithMetrics(0))).toBeNull();
  });
});
