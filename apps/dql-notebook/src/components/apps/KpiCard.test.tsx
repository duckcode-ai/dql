import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../store/types';
import { KpiCard, kpiHtml, usesKpiCard } from './KpiCard';
import { ChartStylePanel } from './builder/ChartStylePanel';
import { vizTypeForEncoding } from './builder/field-query';

const result = {
  columns: ['order_date_month', 'revenue'],
  rows: [
    { order_date_month: '2026-01-01', revenue: 60 },
    { order_date_month: '2026-02-01', revenue: 30 },
    { order_date_month: '2026-03-01', revenue: 55 },
  ],
  columnsMeta: [{ name: 'order_date_month', kind: 'date', grain: 'month' }, { name: 'revenue', kind: 'currency', unit: 'USD' }],
} as unknown as QueryResult;
const query = { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] };

describe('KPI tiles with a trend and a target (RFC 0009 step 4)', () => {
  it('shows the latest period, its change in words and a sparkline', () => {
    const markup = renderToStaticMarkup(<KpiCard result={result} query={query} style={{ kpi: { target: 50, targetLabel: 'Plan' } }} label="Revenue" />);
    expect(markup).toContain('$55.00');
    expect(markup).toContain('Up');
    expect(markup).toContain('+$25');
    expect(markup).toContain('(+83.3%)');
    expect(markup).toContain('vs ');
    expect(markup).toContain('aria-label="Trend of Revenue over 3 periods"');
    expect(markup).toContain('✓ On track');
    expect(markup).toContain('110% of Plan $50.00');
  });

  it('draws the same KPI as static markup', () => {
    const html = kpiHtml(result, query, { kpi: { target: 80, better: 'higher' } }, 'Revenue')!;
    expect(html).toContain('<div class="dql-tile-kpi">$55.00</div>');
    expect(html).toContain('dql-kpi-change up');
    expect(html).toContain('✕ Off track');
  });

  it('uses the card for a KPI with a date or a target, and keeps such a KPI a KPI as fields move', () => {
    expect(usesKpiCard(query, undefined)).toBe(true);
    expect(usesKpiCard({ dimensions: [], measures: [{ measure: 'revenue' }] }, { kpi: { target: 1 } })).toBe(true);
    expect(usesKpiCard({ dimensions: [], measures: [{ measure: 'revenue' }] }, undefined)).toBe(false);
    const isTime = (field: string) => field === 'order_date';
    expect(vizTypeForEncoding({ version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }] }, isTime, 'single_value')).toBe('single_value');
    expect(vizTypeForEncoding({ version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }] }, isTime, 'bar')).toBe('bar');
  });

  it('offers a target in the measure unit, a rate in percent', () => {
    const markup = renderToStaticMarkup(<ChartStylePanel vizType="single_value" style={{ kpi: { target: 0.5 } }} kpiUnit="percent" disabled={false} onChange={() => undefined} />);
    expect(markup).toContain('aria-label="Target, in percent"');
    expect(markup).toContain('value="50"');
    expect(markup).toContain('Higher is better');
  });
});
