import { describe, expect, it } from 'vitest';
import { withDriverFilterScopes } from './dashboard-drivers.js';

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
