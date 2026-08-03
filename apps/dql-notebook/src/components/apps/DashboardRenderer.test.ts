import { describe, expect, it } from 'vitest';
import { mergeDashboardTileChartConfig, summarizeDashboardKpiResult } from './dashboard-chart-config';

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
