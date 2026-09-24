import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../store/types';
import { buildVizOption } from '../output/echarts/viz-option';
import { formatDisplayValue } from '../../utils/value-format';
import { encodedTileResult, mergeDashboardTileChartConfig } from './dashboard-chart-config';

const byRegion: QueryResult = {
  columns: ['region', 'revenue', 'margin', 'orders'],
  rows: [
    { region: 'US', revenue: 85, margin: 40, orders: 4 },
    { region: 'CA', revenue: 60, margin: 27, orders: 3 },
  ],
  rowCount: 2,
  executionTime: 1,
  columnsMeta: [
    { name: 'revenue', kind: 'currency', unit: 'USD' },
    { name: 'margin', kind: 'currency', unit: 'USD' },
    { name: 'orders', kind: 'count' },
  ],
};

const tile = (encoding: unknown, measures = ['revenue', 'margin', 'orders'], type = 'bar') => ({
  i: 't', title: 'Revenue by region',
  query: { dimensions: [{ field: 'region' }], measures: measures.map((measure) => ({ measure })) },
  viz: { type, encoding } as never,
});

const option = (item: ReturnType<typeof tile>, result = byRegion) => {
  const config = mergeDashboardTileChartConfig(item);
  return buildVizOption({ chartType: config.chart as never, result: encodedTileResult(item, result), themeMode: 'paper', config, animate: false })!.option as any;
};

describe('charts drawn from shelves (RFC 0009 step 1)', () => {
  it('draws a dimension on Columns as vertical bars and on Rows as horizontal bars', () => {
    const vertical = option(tile({ version: 1, columns: [{ dimension: 'region' }], rows: [{ measure: 'revenue' }] }));
    expect(vertical.xAxis.type).toBe('category');
    expect(vertical.xAxis.data).toEqual(['US', 'CA']);
    const horizontal = option(tile({ version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }] }));
    expect(horizontal.yAxis.type).toBe('category');
  });

  it('draws every measure on the value shelf as a series, named as the author named it', () => {
    const drawn = option(tile({
      version: 1, columns: [{ dimension: 'region' }], rows: [{ measure: 'revenue' }, { measure: 'margin' }],
      fields: { 'measure:revenue': { label: 'Net revenue' } },
    }));
    expect(drawn.series.map((entry: any) => entry.name)).toEqual(['Net revenue', 'Margin']);
    expect(drawn.series.map((entry: any) => entry.data.map((point: any) => (typeof point === 'object' ? point.value : point)))).toEqual([[85, 60], [40, 27]]);
  });

  it('labels the measures on the Label shelf and adds Tooltip measures to the tooltip', () => {
    const drawn = option(tile({
      version: 1, columns: [{ dimension: 'region' }], rows: [{ measure: 'revenue' }],
      label: [{ measure: 'revenue' }], tooltip: [{ measure: 'orders' }],
    }));
    expect(drawn.series[0].data.every((point: any) => point.label?.show === true)).toBe(true);
    const html = drawn.tooltip.formatter([{ dataIndex: 0, seriesIndex: 0, value: 85, marker: '' }]);
    expect(html).toContain('<strong>US</strong>');
    expect(html).toContain('Revenue: $85');
    expect(html).toContain('Orders: 4');
  });

  it('draws a scatter from the shelves: x, y, bubble size and colour groups', () => {
    const points: QueryResult = {
      columns: ['customer', 'segment', 'revenue', 'margin', 'orders'],
      rows: [
        { customer: 'C-1', segment: 'Retail', revenue: 100, margin: 40, orders: 9 },
        { customer: 'C-2', segment: 'Retail', revenue: 60, margin: 20, orders: 1 },
        { customer: 'C-3', segment: 'Online', revenue: 80, margin: 35, orders: 4 },
      ],
      rowCount: 3, executionTime: 1,
    };
    const item = {
      i: 's', query: { dimensions: [{ field: 'customer' }, { field: 'segment' }], measures: [{ measure: 'revenue' }, { measure: 'margin' }, { measure: 'orders' }] },
      viz: { type: 'scatter', encoding: { version: 1, columns: [{ measure: 'margin' }], rows: [{ measure: 'revenue' }], size: { measure: 'orders' }, color: { dimension: 'segment' }, detail: [{ dimension: 'customer' }] } } as never,
    };
    const drawn = option(item as never, points);
    expect(drawn.xAxis.name).toBe('Margin');
    expect(drawn.yAxis.name).toBe('Revenue');
    expect(drawn.series.map((entry: any) => entry.name)).toEqual(['Retail', 'Online']);
    const [biggest, smallest] = drawn.series[0].data;
    expect(biggest.symbolSize).toBeGreaterThan(smallest.symbolSize);
    expect(drawn.tooltip.formatter({ data: biggest })).toContain('<strong>C-1</strong>');
  });

  it('applies per-field names and formats to the result every view reads', () => {
    const item = tile({
      version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }],
      fields: { 'dimension:region': { label: 'Sales region' }, 'measure:revenue': { format: { kind: 'compact' } }, 'measure:margin': { format: { kind: 'currency', decimals: 0 } } },
    }, ['revenue', 'margin']);
    const result = encodedTileResult(item, byRegion);
    const meta = (name: string) => result.columnsMeta!.find((entry) => entry.name === name)!;
    expect(meta('region')).toMatchObject({ label: 'Sales region' });
    expect(meta('revenue')).toMatchObject({ kind: 'currency', notation: 'compact' });
    expect(formatDisplayValue('revenue', 1_250_000, [], { meta: meta('revenue') })).toBe('$1.3M');
    expect(formatDisplayValue('margin', 40, [], { meta: meta('margin') })).toBe('$40');
    // A tile without shelves is untouched.
    const plain = { i: 'p', viz: { type: 'bar' } };
    expect(encodedTileResult(plain, byRegion)).toBe(byRegion);
    expect(mergeDashboardTileChartConfig(plain).orientation).toBeUndefined();
  });

  it('draws a point with no neighbour as a dot, so a sparse line is never blank', () => {
    const sparse: QueryResult = {
      columns: ['order_date_month', 'customer', 'revenue'],
      rows: [
        { order_date_month: '2026-01-01', customer: 'C-1', revenue: 60 },
        { order_date_month: '2026-02-01', customer: 'C-2', revenue: 30 },
        { order_date_month: '2026-03-01', customer: 'C-3', revenue: 25 },
      ],
      rowCount: 3, executionTime: 1,
    };
    const item = {
      i: 'l', query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'customer' }], measures: [{ measure: 'revenue' }] },
      viz: { type: 'line', encoding: { version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }], color: { dimension: 'customer' } } } as never,
    };
    const drawn = option(item as never, sparse);
    const c2 = drawn.series.find((entry: any) => entry.name === 'C-2');
    expect(c2.data).toEqual([null, expect.objectContaining({ value: 30, symbol: 'circle' }), null]);
  });

  it('draws shelves that read as a table as a table, whatever chart type is stored', () => {
    const item = tile({ version: 1, columns: [{ dimension: 'region' }], rows: [{ measure: 'revenue' }], detail: [{ dimension: 'channel' }] }, ['revenue'], 'line');
    (item.query.dimensions as Array<{ field: string }>).push({ field: 'channel' });
    expect(mergeDashboardTileChartConfig(item).chart).toBe('table');
  });
});
