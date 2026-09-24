import { describe, expect, it } from 'vitest';
import { readDriverDefinition } from './dashboard-document.js';

const base = { version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-02-01', comparison: 'previous_period', dimensions: ['*'] };

describe('driver definitions narrowed to what the reader sees (RFC 0009 step 6a)', () => {
  it('keeps scalar equality filters on named fields', () => {
    const errors: string[] = [];
    const definition = readDriverDefinition({ ...base, filters: [{ field: 'region', op: 'eq', values: ['US'] }, { field: 'channel', op: 'not_in', values: ['Web', 'Store'] }] }, 'driver', (message) => errors.push(message));
    expect(errors).toEqual([]);
    expect(definition?.filters).toEqual([{ field: 'region', op: 'eq', values: ['US'] }, { field: 'channel', op: 'not_in', values: ['Web', 'Store'] }]);
    expect(readDriverDefinition(base, 'driver', () => undefined)?.filters).toBeUndefined();
  });

  it('refuses ranges, empty values and too many filters', () => {
    const errors: string[] = [];
    expect(readDriverDefinition({ ...base, filters: [{ field: 'order_date', op: 'gte', values: ['2026-01-01'] }] }, 'driver', (message) => errors.push(message))).toBeUndefined();
    expect(readDriverDefinition({ ...base, filters: [{ field: 'region', op: 'eq', values: [] }] }, 'driver', (message) => errors.push(message))).toBeUndefined();
    expect(readDriverDefinition({ ...base, filters: Array.from({ length: 13 }, () => ({ field: 'region', op: 'eq', values: ['US'] })) }, 'driver', (message) => errors.push(message))).toBeUndefined();
    expect(errors).toHaveLength(3);
  });
});

describe('a driver tile follows its Dataset filter (RFC 0009 evaluation J4)', () => {
  it('may be listed in a filter binding for its own Dataset, and publishing parses', async () => {
    const { parseDashboardDocument } = await import('./dashboard-document.js');
    const page = (tileIds: string[], driverRevision = 'r1') => JSON.stringify({
      version: 3, id: 'overview', metadata: { title: 'Overview' },
      datasets: [{ id: 'orders', sourceId: 'app:block:orders', sourceRevision: 'r1', snapshotId: 's1', contractFingerprint: 'c1' }],
      filters: [{ id: 'region', type: 'select', datasetBindings: { orders: { field: 'region', tileIds } } }],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
        { i: 'trend', x: 0, y: 0, w: 6, h: 4, sourceId: 'app:block:orders', sourceRevision: 'r1', query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'line' } },
        { i: 'trend-why', x: 0, y: 4, w: 12, h: 6, sourceId: 'app:block:orders', sourceRevision: driverRevision, driver: base, viz: { type: 'waterfall' } },
      ] },
    });
    expect(parseDashboardDocument(page(['trend', 'trend-why']), 'overview.dqld').errors).toEqual([]);
    // A driver on another revision is still not that exact binding.
    expect(parseDashboardDocument(page(['trend', 'trend-why'], 'r2'), 'overview.dqld').errors.map((error) => error.message).join(' ')).toContain('does not resolve to that exact Dataset binding');
  });
});
