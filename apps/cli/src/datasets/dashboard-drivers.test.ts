import { describe, expect, it } from 'vitest';
import { dashboardExploreProbeItem, expandDashboardDriverItems, withDriverFilterScopes } from './dashboard-drivers.js';

const page = (filters: unknown[]) => ({
  version: 3, id: 'overview', metadata: { title: 'Overview' }, filters,
  layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'trend' }, { i: 'kpi' }, { i: 'trend-why', driver: {} }] },
}) as never;

describe('driver comparisons get the filters of the tile they explain (evaluation E1)', () => {
  it('widens Dataset binding tile lists and scopes for probes, listed drivers and Studio drivers', () => {
    const owners = new Map([
      ['trend::why::driver::total', 'trend::why'],
      ['trend::why::driver::region', 'trend::why'],
      ['trend-why::driver::total', 'trend-why'],
      ['other::driver::total', 'other'],
    ]);
    const scoped = withDriverFilterScopes(page([
      { id: 'region', type: 'select', datasetBindings: { ds1: { field: 'region', tileIds: ['trend'] } } },
      { id: 'segment', type: 'select', scope: { tileIds: ['kpi', 'other'] } },
      { id: 'all', type: 'select', scope: { app: true }, datasetBindings: { ds1: { field: 'region' } } },
    ]), owners) as any;
    // A probe on "trend" and the Studio driver "trend-why" follow trend's filter.
    expect(scoped.filters[0].datasetBindings.ds1.tileIds).toEqual(['trend', 'trend::why::driver::total', 'trend::why::driver::region', 'trend-why::driver::total']);
    // A driver listed by its own id keeps working.
    expect(scoped.filters[1].scope.tileIds).toEqual(['kpi', 'other', 'other::driver::total']);
    // A filter on every tile needs no widening.
    expect(scoped.filters[2].datasetBindings.ds1).toEqual({ field: 'region' });
  });
});

describe('what the reader is looking at narrows the explanation (RFC 0009 step 6a)', () => {
  const descriptor = {
    version: 1, id: 'orders', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Orders',
    contractRef: { kind: 'block_source', id: 'orders', fingerprint: 'c1' },
    binding: { sourceQualifiedId: 'orders', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
    lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['order'], keyFields: ['order_id'] },
    fields: [
      { kind: 'physical', name: 'order_date', qualifiedId: 'o.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'] } },
      { kind: 'physical', name: 'region', qualifiedId: 'o.region', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'channel', qualifiedId: 'o.channel', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'measure', name: 'revenue', qualifiedId: 'm.revenue', aggregation: 'sum', from: 'amount', dependsOn: ['amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
    ],
    operations: ['filter', 'group', 'trend', 'compare'], execution: { route: 'certified' },
  } as never;
  const driver = (filters?: unknown[]) => ({ i: 'trend::why', x: 0, y: 0, w: 12, h: 6, sourceId: 'orders', driver: { version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-02-01', comparison: 'previous_period', dimensions: ['*'], ...(filters ? { filters } : {}) }, viz: { type: 'waterfall' } }) as never;

  it('filters both periods and drops a breakdown by a field held to one value', () => {
    const expanded = expandDashboardDriverItems({ items: [driver([{ field: 'region', op: 'eq', values: ['US'] }])], descriptorFor: () => descriptor, sourceErrorFor: () => undefined });
    const queries = expanded.executionItems.map((item: any) => ({ id: item.i, filters: item.query.filters }));
    expect(queries.every((query) => JSON.stringify(query.filters).includes('"region","op":"eq","values":["US"]'))).toBe(true);
    expect(queries.some((query) => query.id.endsWith('::region'))).toBe(false);
    expect(queries.some((query) => query.id.endsWith('::channel'))).toBe(true);
  });

  it('builds an Explore view as a transient tile with the source tile\'s bindings', () => {
    const doc = { version: 3, id: 'p', metadata: { title: 'P' }, layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
      { i: 'regions', x: 0, y: 0, w: 6, h: 4, sourceId: 'orders', sourceRevision: 'r1', filterBindings: [{ filter: 'region' }], title: 'Revenue by region', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'bar' } },
    ] } } as never;
    const probe = dashboardExploreProbeItem(doc, { fromTileId: 'regions', query: { dimensions: [{ field: 'channel' }], measures: [{ measure: 'revenue' }], filters: [{ field: 'region', op: 'eq', values: ['US'] }] } });
    expect(probe).toMatchObject({ i: 'regions::explore', sourceId: 'orders', sourceRevision: 'r1', filterBindings: [{ filter: 'region' }], query: { dimensions: [{ field: 'channel' }] } });
    expect(() => dashboardExploreProbeItem(doc, { fromTileId: 'missing', query: {} })).toThrow('Dataset tile');
  });
});
