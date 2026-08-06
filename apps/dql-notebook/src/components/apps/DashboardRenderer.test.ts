import { describe, expect, it, vi } from 'vitest';
import { mergeDashboardTileChartConfig, normalizeDashboardChartType, summarizeDashboardKpiResult } from './dashboard-chart-config';
import { autoLayoutDashboardItems } from './dashboard-layout';
import { formatDashboardValue } from './dashboard-format';
import { prepareStakeholderItems } from './dashboard-presentation';
import { CHART_TYPE_OPTIONS } from '../output/ChartOutput';

async function dashboardHelpers() {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  return import('./DashboardRenderer');
}

describe('Dashboard KPI display contract (UI-004)', () => {
  it('normalizes legacy field and documented valueField options to the KPI measure', () => {
    expect(mergeDashboardTileChartConfig({
      i: 'orders', x: 0, y: 0, w: 3, h: 2,
      title: 'Orders this month',
      viz: { type: 'kpi', options: { field: 'order_count' } },
    } as any, { chart: 'line', x: 'order_month', y: 'revenue' })).toMatchObject({
      chart: 'kpi',
      y: 'order_count',
    });

    expect(mergeDashboardTileChartConfig({
      i: 'revenue', x: 0, y: 0, w: 3, h: 2,
      title: 'Current revenue',
      viz: { type: 'single_value', options: { valueField: 'revenue', format: 'currency' } },
    } as any)).toMatchObject({ chart: 'kpi', y: 'revenue', format: 'currency' });
  });

  it('summarizes repeated KPI rows to the same total used by dashboard facts', () => {
    expect(summarizeDashboardKpiResult({
      columns: ['order_month', 'revenue'],
      rows: [
        { order_month: '2026-06-01', revenue: 120.25 },
        { order_month: '2026-07-01', revenue: 79.75 },
      ],
      rowCount: 2,
      executionTime: 4,
    }, 'revenue')).toEqual({
      columns: ['revenue'],
      rows: [{ revenue: 200 }],
      rowCount: 1,
      executionTime: 4,
    });
  });
});

describe('App dashboard interaction contract', () => {
  it('prepares a clean auto-layout without mutating the saved layout', async () => {
        const saved = [
      { i: 'chart', x: 7, y: 8, w: 2, h: 1, viz: { type: 'bar' }, title: 'Chart' },
      { i: 'heading', x: 3, y: 4, w: 2, h: 2, viz: { type: 'heading' }, title: 'Summary' },
      { i: 'kpi', x: 9, y: 2, w: 8, h: 5, viz: { type: 'kpi' }, title: 'Revenue' },
    ] as any;

    const preview = autoLayoutDashboardItems(saved, 12);

    expect(preview.map((item) => item.i)).toEqual(['heading', 'kpi', 'chart']);
    expect(preview[0]).toMatchObject({ x: 0, y: 0 });
    expect(saved[0]).toMatchObject({ x: 7, y: 8, w: 2, h: 1 });
  });

  it('always offers table as a non-persistent viewer alternative for a generated chart', async () => {
    const { getGeneratedVizOptions } = await dashboardHelpers();
    const options = getGeneratedVizOptions({
      i: 'trend', x: 0, y: 0, w: 6, h: 3,
      viz: { type: 'line' },
      title: 'Revenue trend',
    } as any, { allowedVisualizations: ['line', 'area'] });

    expect(options.map((option) => option.value)).toEqual(['table', 'line', 'area']);
  });

  it('formats AI-pinned evidence and summaries with business meaning', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    const rows = [
      { monthly: '2016-09-01T00:00:00.000Z', type: 'food_and_drink', revenue: 9839.34 },
      { monthly: '2016-09-01T00:00:00.000Z', type: 'drink', revenue: 6676.87 },
    ];

    expect(formatDashboardValue('monthly', rows[0].monthly, rows.map((row) => row.monthly))).toBe('Sep 2016');
    expect(formatDashboardValue('revenue', rows[0].revenue, rows.map((row) => row.revenue))).toBe('$9,839.34');
    expect(formatDashboardValue('type', rows[0].type, rows.map((row) => row.type))).toBe('food and drink');
    expect(computeTileInsight({
      status: 'ok',
      result: { columns: ['type', 'revenue'], rows, rowCount: 2, executionTime: 4 },
    } as any)).toBe('food and drink leads Revenue at $9.8K (60%).');
  });
});

describe('Dashboard visualization vocabulary and icons (UI-004)', () => {
  it('gives every renderable chart type its own icon', async () => {
    const { iconForChartType } = await dashboardHelpers();
    // Ten of sixteen types used to fall through to the same bar glyph, and the
    // viz switcher renders one button per allowed type — so a single tile could
    // show a row of seven identical bar icons.
    const icons = CHART_TYPE_OPTIONS.map((option) => {
      const element = iconForChartType(option.value) as { type: unknown };
      return element.type;
    });
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('keeps every renderable chart type and falls back only for types it cannot draw', () => {
    for (const option of CHART_TYPE_OPTIONS) {
      expect(normalizeDashboardChartType(option.value)).toBe(option.value);
    }
    // Underscore and legacy spellings normalize rather than degrade.
    expect(normalizeDashboardChartType('stacked_bar')).toBe('stacked-bar');
    expect(normalizeDashboardChartType('single_value')).toBe('kpi');
    // The client has no renderer for these, so `table` is the honest fallback.
    expect(normalizeDashboardChartType('pivot')).toBe('table');
    expect(normalizeDashboardChartType('map')).toBe('table');
  });
});

describe('Stakeholder view hides review-required pins, edit mode does not (UI-018)', () => {
  const pinItem = { i: 'ai-pin-1', x: 0, y: 0, w: 6, h: 3, aiPin: { id: 'pin-1' }, viz: { type: 'table' }, title: 'Revenue by region' };
  const blockItem = { i: 'revenue', x: 0, y: 3, w: 6, h: 3, block: { blockId: 'Total Revenue' }, viz: { type: 'kpi' }, title: 'Revenue' };

  it('filters an unreviewed pin out of the stakeholder view', async () => {
        const results = new Map([['ai-pin-1', { tileId: 'ai-pin-1', status: 'ok', tileType: 'aiPin', aiPin: { certification: 'ai_generated', reviewStatus: 'needs_review' } }]] as never);
    const visible = prepareStakeholderItems([pinItem, blockItem] as never, results as never, 12);
    expect(visible.map((item) => item.i)).toEqual(['revenue']);
  });

  it('keeps a certified pin in the stakeholder view', async () => {
        const results = new Map([['ai-pin-1', { tileId: 'ai-pin-1', status: 'ok', tileType: 'aiPin', aiPin: { certification: 'certified', reviewStatus: 'certified' } }]] as never);
    const visible = prepareStakeholderItems([pinItem, blockItem] as never, results as never, 12);
    // Adding a certified result must not vanish from the page it was added to.
    expect(visible.map((item) => item.i).sort()).toEqual(['ai-pin-1', 'revenue']);
  });
});
