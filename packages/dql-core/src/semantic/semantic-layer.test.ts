import { describe, it, expect } from 'vitest';
import {
  SemanticLayer,
  parseMetricDefinition,
  parseDimensionDefinition,
  parseHierarchyDefinition,
  parseBlockCompanionDefinition,
} from './semantic-layer.js';

describe('SemanticLayer', () => {
  it('adds and retrieves metrics', () => {
    const layer = new SemanticLayer();
    layer.addMetric({
      name: 'total_revenue', label: 'Total Revenue', description: 'Sum of revenue',
      domain: 'revenue', sql: 'SUM(amount)', type: 'sum', table: 'fct_revenue',
    });
    expect(layer.getMetric('total_revenue')).toBeDefined();
    expect(layer.getMetric('total_revenue')!.label).toBe('Total Revenue');
  });

  it('adds and retrieves dimensions', () => {
    const layer = new SemanticLayer();
    layer.addDimension({
      name: 'segment_tier', label: 'Segment', description: 'Customer segment',
      sql: 's.tier', type: 'string', table: 'dim_segment',
    });
    expect(layer.getDimension('segment_tier')).toBeDefined();
  });

  it('lists metrics by domain', () => {
    const layer = new SemanticLayer({
      metrics: [
        { name: 'rev', label: 'Rev', description: '', domain: 'revenue', sql: 'SUM(a)', type: 'sum', table: 't' },
        { name: 'churn', label: 'Churn', description: '', domain: 'retention', sql: 'AVG(c)', type: 'avg', table: 't' },
      ],
      dimensions: [],
    });
    expect(layer.listMetrics('revenue')).toHaveLength(1);
    expect(layer.listMetrics()).toHaveLength(2);
  });

  it('searches metrics and dimensions', () => {
    const layer = new SemanticLayer({
      metrics: [
        { name: 'total_revenue', label: 'Total Revenue', description: 'All revenue', domain: 'revenue', sql: 'SUM(a)', type: 'sum', table: 't' },
        { name: 'churn_rate', label: 'Churn Rate', description: 'Monthly churn', domain: 'retention', sql: 'AVG(c)', type: 'avg', table: 't' },
      ],
      dimensions: [
        { name: 'segment', label: 'Segment', description: 'Customer segment', sql: 's.tier', type: 'string', table: 't' },
      ],
    });
    const result = layer.search('revenue');
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].name).toBe('total_revenue');
  });

  it('validates references', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'rev', label: 'Rev', description: '', domain: 'r', sql: 'SUM(a)', type: 'sum', table: 't' }],
      dimensions: [{ name: 'seg', label: 'Seg', description: '', sql: 's', type: 'string', table: 't' }],
    });
    const result = layer.validateReferences(['rev', 'seg', 'unknown']);
    expect(result.valid).toEqual(['rev', 'seg']);
    expect(result.unknown).toEqual(['unknown']);
  });

  it('generates metric SQL with dimensions', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'r', sql: 'SUM(amount)', type: 'sum', table: 'fct_revenue' }],
      dimensions: [{ name: 'segment', label: 'Segment', description: '', sql: 's.tier', type: 'string', table: 'dim_segment' }],
    });
    const sql = layer.generateMetricSQL('revenue', ['segment']);
    expect(sql).toContain('SUM(amount) AS revenue');
    expect(sql).toContain('s.tier AS segment');
    expect(sql).toContain('GROUP BY');
  });

  it('supports hierarchy registration and drill-path resolution', () => {
    const layer = new SemanticLayer({
      metrics: [],
      dimensions: [
        { name: 'country', label: 'Country', description: '', sql: 'country', type: 'string', table: 'geo' },
        { name: 'state', label: 'State', description: '', sql: 'state', type: 'string', table: 'geo' },
        { name: 'city', label: 'City', description: '', sql: 'city', type: 'string', table: 'geo' },
      ],
      hierarchies: [
        {
          name: 'geo_hierarchy',
          label: 'Geo',
          description: 'Geographic drill path',
          domain: 'revenue',
          defaultRollup: 'sum',
          levels: [
            { name: 'country_level', label: 'Country', description: '', dimension: 'country', order: 1 },
            { name: 'state_level', label: 'State', description: '', dimension: 'state', order: 2 },
            { name: 'city_level', label: 'City', description: '', dimension: 'city', order: 3 },
          ],
          drillPaths: [
            { name: 'geo_default', levels: ['country_level', 'state_level', 'city_level'] },
          ],
          defaultDrillPath: 'geo_default',
        },
      ],
    });

    expect(layer.listHierarchies('revenue')).toHaveLength(1);
    expect(layer.getHierarchy('geo_hierarchy')?.defaultRollup).toBe('sum');

    const path = layer.resolveDrillPath('geo_hierarchy');
    expect(path.map((level) => level.name)).toEqual(['country_level', 'state_level', 'city_level']);

    const next = layer.nextDrillLevel('geo_hierarchy', 'state_level');
    expect(next?.name).toBe('city_level');

    const refs = layer.validateReferences(['geo_hierarchy', 'city_level', 'missing_ref']);
    expect(refs.valid).toEqual(['geo_hierarchy', 'city_level']);
    expect(refs.unknown).toEqual(['missing_ref']);
  });
});

describe('parseMetricDefinition', () => {
  it('parses a raw object into MetricDefinition', () => {
    const metric = parseMetricDefinition({
      name: 'total_revenue', label: 'Total Revenue', description: 'Sum',
      domain: 'revenue', sql: 'SUM(amount)', type: 'sum', table: 'fct_revenue',
      tags: ['revenue'], owner: 'kranthi',
    });
    expect(metric.name).toBe('total_revenue');
    expect(metric.type).toBe('sum');
    expect(metric.tags).toEqual(['revenue']);
  });
});

describe('parseDimensionDefinition', () => {
  it('parses a raw object into DimensionDefinition', () => {
    const dim = parseDimensionDefinition({
      name: 'segment', label: 'Segment', description: 'Tier',
      sql: 's.tier', type: 'string', table: 'dim_segment',
    });
    expect(dim.name).toBe('segment');
    expect(dim.type).toBe('string');
  });
});

describe('parseHierarchyDefinition', () => {
  it('parses hierarchy metadata, drill paths, and default rollup', () => {
    const hierarchy = parseHierarchyDefinition({
      name: 'time_hierarchy',
      label: 'Time',
      description: 'Time levels',
      domain: 'revenue',
      defaultRollup: 'avg',
      levels: [
        { name: 'year', dimension: 'year', order: 1 },
        { name: 'quarter', dimension: 'quarter', order: 2 },
      ],
      drillPaths: [{ name: 'calendar', levels: ['year', 'quarter'] }],
      defaultDrillPath: 'calendar',
      tags: ['time'],
      owner: 'analytics',
    });

    expect(hierarchy.name).toBe('time_hierarchy');
    expect(hierarchy.defaultRollup).toBe('avg');
    expect(hierarchy.levels).toHaveLength(2);
    expect(hierarchy.drillPaths?.[0].name).toBe('calendar');
    expect(hierarchy.defaultDrillPath).toBe('calendar');
    expect(hierarchy.owner).toBe('analytics');
  });
});

describe('parseBlockCompanionDefinition', () => {
  it('parses companion business metadata for a block', () => {
    const companion = parseBlockCompanionDefinition({
      name: 'revenue_by_segment',
      block: 'revenue_by_segment',
      domain: 'revenue',
      description: 'Business context for segment revenue reporting',
      owner: 'finance-analytics',
      tags: ['revenue', 'segment'],
      glossary: ['ARR', 'net retention'],
      semanticMappings: {
        segment: 'segment_tier',
        revenue: 'total_revenue',
      },
      lineage: ['warehouse.fct_revenue', 'warehouse.dim_segment'],
      notes: ['Reviewed with finance on 2026-03-01'],
      reviewStatus: 'review',
    });

    expect(companion.block).toBe('revenue_by_segment');
    expect(companion.reviewStatus).toBe('review');
    expect(companion.semanticMappings?.segment).toBe('segment_tier');
    expect(companion.lineage).toEqual(['warehouse.fct_revenue', 'warehouse.dim_segment']);
  });
});
