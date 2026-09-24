import { describe, expect, it } from 'vitest';
import type { CellChartConfig, QueryResult } from '../../store/types';
import { buildVizOption } from '../output/echarts/viz-option';

const build = (chartType: string, result: QueryResult, config: CellChartConfig) => buildVizOption({ chartType: chartType as never, result, themeMode: 'paper', config, animate: false })!;
const split: QueryResult = {
  columns: ['month', 'region', 'revenue', 'orders'],
  rows: [
    { month: '2026-01-01', region: 'US', revenue: 85, orders: 4 },
    { month: '2026-01-01', region: 'CA', revenue: 60, orders: 9 },
    { month: '2026-02-01', region: 'US', revenue: 70, orders: 5 },
  ],
  rowCount: 3, executionTime: 1,
};
const text = (html: string) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

describe('tooltips and clicks read the mark under the pointer (RFC 0009 step 6a)', () => {
  it('shows a Tooltip-shelf measure for each series under a colour split, never the first series under the category', () => {
    const built = build('line', split, { x: 'month', y: 'revenue', color: 'region', tooltipColumns: ['orders'] } as CellChartConfig);
    const html = (built.option as any).tooltip.formatter([{ dataIndex: 0, seriesIndex: 0, value: 85, marker: '' }, { dataIndex: 0, seriesIndex: 1, value: 60, marker: '' }]);
    expect(text(html)).toContain('US: $85');
    expect(text(html)).toContain('Orders 4');
    expect(text(html)).toContain('CA: $60');
    expect(text(html)).toContain('Orders 9');
    // The old tooltip printed one "Orders: 4" for the whole month.
    expect(html).not.toContain('Orders: 4');
  });

  it('carries the clicked series to the click: CA in January is CA\'s row', () => {
    const built = build('bar', split, { x: 'month', y: 'revenue', color: 'region' } as CellChartConfig);
    expect(built.rowAt?.(1, 0)).toMatchObject({ region: 'CA', revenue: 60 });
    expect(built.rowAt?.(0, 1)).toMatchObject({ region: 'US', month: '2026-02-01' });
  });

  it('gives each part of a stack its share and closes with the total', () => {
    const built = build('stacked-bar', split, { x: 'month', y: 'revenue', color: 'region' } as CellChartConfig);
    const html = (built.option as any).tooltip.formatter([{ dataIndex: 0, seriesIndex: 0, value: 85, marker: '' }, { dataIndex: 0, seriesIndex: 1, value: 60, marker: '' }]);
    expect(text(html)).toMatch(/US: \$85(\.0)? \(59%\)/);
    expect(text(html)).toMatch(/CA: \$60(\.0)? \(41%\)/);
    expect(text(html)).toMatch(/Total: \$145/);
  });

  it("shows a slice's share, the Tooltip shelf and the trust line on a pie", () => {
    const regions: QueryResult = { columns: ['region', 'revenue', 'orders'], rows: [{ region: 'US', revenue: 75, orders: 3 }, { region: 'CA', revenue: 25, orders: 1 }], rowCount: 2, executionTime: 1 };
    const built = build('pie', regions, { x: 'region', y: 'revenue', tooltipColumns: ['orders'], tooltipFooter: 'Certified · Updated just now' } as CellChartConfig);
    const html = (built.option as any).tooltip.formatter({ name: 'US', value: 75 });
    expect(text(html)).toMatch(/US\|Revenue: \$75(\.0)? \(75% of the total\)\|Orders: 3\|Certified · Updated just now/);
    expect(built.rowAt?.(0, 0)).toMatchObject({ region: 'US' });
  });

  it('reads a heatmap cell and a scatter point back to their rows', () => {
    const grid: QueryResult = { columns: ['region', 'channel', 'revenue'], rows: [{ region: 'US', channel: 'Web', revenue: 10 }, { region: 'CA', channel: 'Store', revenue: 20 }], rowCount: 2, executionTime: 1 };
    const heat = build('heatmap', grid, {} as CellChartConfig);
    expect(heat.rowAt?.(0, 1)).toMatchObject({ region: 'CA', channel: 'Store' });
    expect(text((heat.option as any).tooltip.formatter({ dataIndex: 1, value: [1, 1, 20] }))).toContain('Revenue: $20');
    const points: QueryResult = { columns: ['customer', 'revenue', 'orders'], rows: [{ customer: 'C-1', revenue: 10, orders: 2 }], rowCount: 1, executionTime: 1 };
    const scatter = build('scatter', points, { x: 'revenue', y: 'orders' } as CellChartConfig);
    const point = (scatter.option as any).series[0].data[0];
    expect(scatter.rowAt?.(0, 0, point)).toMatchObject({ customer: 'C-1' });
  });
});

describe('series with no value at a point', () => {
  it('are left out of the tooltip instead of reading as zero', () => {
    const built = build('stacked-bar', split, { x: 'month', y: 'revenue', color: 'region' } as CellChartConfig);
    const html = (built.option as any).tooltip.formatter([
      { dataIndex: 1, seriesIndex: 0, value: 70, data: 70, marker: '' },
      { dataIndex: 1, seriesIndex: 1, value: 0, data: { value: 0, unavailable: true }, marker: '' },
    ]);
    expect(text(html)).toMatch(/US: \$70(\.0)? \(100%\)/);
    expect(html).not.toContain('CA');
  });
});
