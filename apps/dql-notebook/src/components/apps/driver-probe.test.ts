import { describe, expect, it } from 'vitest';
import { driverPeriodLabel, driverProbeFor, explainablePeriod, filtersForNewDriverTile, formatDriverNumber, formatDriverShare } from './driver-probe';

const trend = {
  i: 'trend', x: 0, y: 0, w: 6, h: 4, sourceId: 'ds', viz: { type: 'line' },
  query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] },
} as never;
const tile = (rows: Array<Record<string, unknown>>) => ({ tileId: 'trend', status: 'ok', result: { columns: [], rows, rowCount: rows.length, executionTime: 1 } }) as never;
const today = new Date('2026-09-23T12:00:00Z');

describe('"Why did it move?" probe (RFC 0008 step 7)', () => {
  it('explains the latest period a trend tile shows', () => {
    const rows = [{ order_date_month: '2026-01-01T00:00:00.000Z' }, { order_date_month: '2026-03-01T00:00:00.000Z' }, { order_date_month: '2026-02-01' }];
    expect(driverProbeFor(trend, tile(rows), 'previous_period', today)).toEqual({
      version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-03-01', comparison: 'previous_period', dimensions: ['*'],
    });
  });

  it('skips a period still running today', () => {
    expect(explainablePeriod(['2026-08-01', '2026-09-01'], 'month', today)).toBe('2026-08-01');
    expect(explainablePeriod(['2026-09-01'], 'month', today)).toBe('2026-09-01');
    expect(explainablePeriod(['2026-09-21', '2026-09-14'], 'week', today)).toBe('2026-09-14');
  });

  it('offers nothing for tiles without a time grain, without rows, or without a Dataset', () => {
    expect(driverProbeFor({ ...(trend as object), query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } } as never, tile([{ region: 'US' }]))).toBeNull();
    expect(driverProbeFor(trend, tile([]))).toBeNull();
    expect(driverProbeFor({ ...(trend as object), sourceId: undefined } as never, tile([{ order_date_month: '2026-03-01' }]))).toBeNull();
  });

  it('labels periods and numbers for readers', () => {
    expect(driverPeriodLabel('2026-03-01T00:00:00.000Z', 'month')).toBe('Mar 2026');
    expect(driverPeriodLabel('2026-02-01', 'quarter')).toBe('Q1 2026');
    expect(driverPeriodLabel('2026-03-02', 'week')).toBe('Week of Mar 2, 2026');
    expect(formatDriverNumber('10', true)).toBe('+10');
    expect(formatDriverNumber('-1234.5', true)).toBe('−1,235');
    expect(formatDriverNumber(undefined)).toBe('—');
    expect(formatDriverShare('0.333333')).toBe('33%');
  });
});

describe('a new driver tile joins its source tile\'s filters (evaluation E1)', () => {
  it('adds the driver to every filter that lists the source tile, and leaves the rest', () => {
    const filters = [
      { id: 'region', type: 'select', datasetBindings: { ds1: { field: 'region', tileIds: ['trend', 'kpi'] }, ds2: { field: 'region' } } },
      { id: 'segment', type: 'select', scope: { tileIds: ['trend'] } },
      { id: 'channel', type: 'select', datasetBindings: { ds1: { field: 'channel', tileIds: ['kpi'] } } },
      { id: 'all', type: 'select', scope: { app: true } },
    ] as never;
    const updated = filtersForNewDriverTile(filters, 'trend', 'trend-why');
    expect(updated.map((filter) => filter.id)).toEqual(['region', 'segment']);
    expect(updated[0]!.datasetBindings).toEqual({ ds1: { field: 'region', tileIds: ['trend', 'kpi', 'trend-why'] }, ds2: { field: 'region' } });
    expect(updated[1]!.scope).toEqual({ tileIds: ['trend', 'trend-why'] });
    expect(filtersForNewDriverTile(updated as never, 'trend', 'trend-why')).toEqual([]);
  });
});
