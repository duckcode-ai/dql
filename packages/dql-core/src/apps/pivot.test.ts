import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '../datasets/descriptor.js';
import { buildPivotGrid, pivotLayout, pivotRollups, withPivotRollups } from './pivot.js';
import { applyDatasetHierarchyDrill, normalizeTileQuery, validateTileQuery } from './tile-query.js';
import type { TileQuery } from './tile-query-types.js';

const descriptor = {
  version: 1, id: 'orders', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Orders',
  contractRef: { kind: 'block_source', id: 'orders', fingerprint: 'c1' },
  binding: { sourceQualifiedId: 'orders', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
  lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
  fields: [
    { kind: 'physical', name: 'region', qualifiedId: 'f.region', type: 'string', role: 'dimension', status: 'approved', hierarchy: { id: 'geo', level: 1 } },
    { kind: 'physical', name: 'country', qualifiedId: 'f.country', type: 'string', role: 'dimension', status: 'approved', hierarchy: { id: 'geo', level: 2 } },
    { kind: 'physical', name: 'channel', qualifiedId: 'f.channel', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'order_date', qualifiedId: 'f.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['month'] } },
    { kind: 'measure', name: 'revenue', qualifiedId: 'm.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'having'], execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

const query: TileQuery = { dimensions: [{ field: 'region' }, { field: 'country' }, { field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] };
const encoding = { version: 1 as const, columns: [{ dimension: 'order_date' }], rows: [{ dimension: 'region' }, { dimension: 'country' }], label: [{ measure: 'revenue' }] };

describe('pivot layout and total levels', () => {
  it('reads rows, columns and values from the shelves', () => {
    expect(pivotLayout(encoding, query)).toEqual({ rows: ['region', 'country'], columns: ['order_date_month'], values: ['revenue'] });
  });

  it('asks for subtotals, a total column, a total row and the grand total', () => {
    expect(pivotRollups({ rows: ['region', 'country'], columns: ['month'] }, undefined)).toEqual([
      ['region', 'month'],
      ['region', 'country'],
      ['region'],
      ['month'],
      [],
    ]);
    expect(pivotRollups({ rows: ['region', 'country'], columns: ['month'] }, { subtotals: false, columns: false })).toEqual([['month']]);
    expect(pivotRollups({ rows: ['region'], columns: [] }, undefined)).toEqual([[]]);
    expect(pivotRollups({ rows: ['region'], columns: [] }, { rows: false })).toEqual([]);
  });

  it('writes the levels into the query, and the contract accepts them', () => {
    const pivoted = withPivotRollups(query, encoding, undefined);
    expect(pivoted.rollups).toHaveLength(5);
    expect(validateTileQuery(descriptor, pivoted).outcome).toBe('covered');
    expect(normalizeTileQuery(pivoted)?.rollups).toEqual(pivoted.rollups);
  });

  it('refuses totals that would be wrong or cut, with the reason', () => {
    const pivoted = withPivotRollups(query, encoding, undefined);
    const message = (extra: Partial<TileQuery>) => validateTileQuery(descriptor, { ...pivoted, ...extra }).diagnostics[0]?.message;
    expect(message({ limit: 10 })).toBe('A table with totals shows every group; remove the row limit.');
    expect(message({ having: [{ field: 'revenue', op: 'gt', values: [1] }] })).toContain('drop total rows');
    expect(message({ calculations: [{ id: 'run', quick: { kind: 'running_total', of: 'revenue' } }] })).toContain('quick calculations');
    expect(message({ rollups: [['nope']] })).toBe('The total level names nope, which is not a dimension on this tile.');
  });

  it('follows a drilled level', () => {
    const pivoted = withPivotRollups({ ...query, dimensions: [{ field: 'region' }, { field: 'order_date', timeGrain: 'month' }] }, { ...encoding, rows: [{ dimension: 'region' }] }, undefined);
    const drilled = applyDatasetHierarchyDrill({ descriptor, query: pivoted, hierarchyId: 'geo', fromField: 'region', values: ['NA'] });
    expect(drilled.status === 'ready' && drilled.query.rollups).toEqual([['country'], ['order_date_month'], []]);
  });
});

describe('the pivot grid', () => {
  const layout = { rows: ['region', 'country'], columns: ['month'], values: ['revenue'] };
  const row = (region: string | null, country: string | null, month: string | null, revenue: number, flags: [number, number, number]) => ({
    region, country, month, revenue, __total_region: flags[0], __total_country: flags[1], __total_month: flags[2],
  });
  const result = {
    columns: ['region', 'country', 'month', 'revenue', '__total_region', '__total_country', '__total_month'],
    rows: [
      row('NA', 'US', 'Jan', 10, [0, 0, 0]), row('NA', 'US', 'Feb', 20, [0, 0, 0]), row('NA', 'CA', 'Jan', 5, [0, 0, 0]),
      row('EU', 'DE', 'Feb', 7, [0, 0, 0]),
      row('NA', null, 'Jan', 15, [0, 1, 0]), row('NA', null, 'Feb', 20, [0, 1, 0]), row('EU', null, 'Feb', 7, [0, 1, 0]),
      row('NA', 'US', null, 30, [0, 0, 1]), row('NA', 'CA', null, 5, [0, 0, 1]), row('EU', 'DE', null, 7, [0, 0, 1]),
      row('NA', null, null, 35, [0, 1, 1]), row('EU', null, null, 7, [0, 1, 1]),
      row(null, null, 'Jan', 15, [1, 1, 0]), row(null, null, 'Feb', 27, [1, 1, 0]),
      row(null, null, null, 42, [1, 1, 1]),
    ],
  };

  it('orders groups, subtotals after their group, and the grand total last', () => {
    const grid = buildPivotGrid(result, layout);
    expect(grid.columns.map((column) => (column.total ? 'Total' : column.values.join('/')))).toEqual(['Feb', 'Jan', 'Total']);
    expect(grid.rows.map((entry) => `${entry.kind}:${entry.values.join('/')}`)).toEqual([
      'cell:EU/DE', 'subtotal:EU', 'cell:NA/CA', 'cell:NA/US', 'subtotal:NA', 'total:',
    ]);
  });

  it('reads each cell and total from the warehouse rows', () => {
    const grid = buildPivotGrid(result, layout);
    const find = (label: string) => grid.rows.find((entry) => `${entry.kind}:${entry.values.join('/')}` === label)!;
    const total = grid.columns.find((column) => column.total)!;
    const jan = grid.columns.find((column) => column.values[0] === 'Jan')!;
    expect(grid.value(find('cell:NA/US'), jan, 'revenue')).toBe(10);
    expect(grid.value(find('subtotal:NA'), total, 'revenue')).toBe(35);
    expect(grid.value(find('total:'), jan, 'revenue')).toBe(15);
    expect(grid.value(find('total:'), total, 'revenue')).toBe(42);
    expect(grid.value(find('cell:EU/DE'), jan, 'revenue')).toBeUndefined();
  });

  it('draws a pivot without totals from a query without them', () => {
    const plain = { columns: ['region', 'country', 'month', 'revenue'], rows: result.rows.slice(0, 4).map(({ region, country, month, revenue }) => ({ region, country, month, revenue })) };
    const grid = buildPivotGrid(plain, layout);
    expect(grid.rows.every((entry) => entry.kind === 'cell')).toBe(true);
    expect(grid.columns.some((column) => column.total)).toBe(false);
  });
});
