import { describe, expect, it } from 'vitest';
import { isPartialPeriod, readKpiStyle, summarizeKpi } from './kpi.js';
import { datasetTileVisualizationCompatibility } from './tile-query.js';

const months = [
  { month: '2026-03-01', revenue: 55 },
  { month: '2026-01-01', revenue: 60 },
  { month: '2026-02-01', revenue: 30 },
];

describe('KPI with a trend and a target', () => {
  it('shows the latest period, its change from the one before, and the series in time order', () => {
    const summary = summarizeKpi(months, { valueColumn: 'revenue', timeColumn: 'month', grain: 'month', now: Date.parse('2026-06-01') });
    expect(summary.value).toBe(55);
    expect(summary.period).toEqual({ value: '2026-03-01', partial: false });
    expect(summary.previous).toEqual({ period: '2026-02-01', value: 30 });
    expect(summary.change).toEqual({ absolute: 25, percent: 25 / 30, direction: 'up', good: true });
    expect(summary.series.map((point) => point.value)).toEqual([60, 30, 55]);
  });

  it('marks a period that has not ended, and reads lower-is-better changes', () => {
    const summary = summarizeKpi(months, { valueColumn: 'revenue', timeColumn: 'month', grain: 'month', now: Date.parse('2026-03-15'), style: { better: 'lower' } });
    expect(summary.period?.partial).toBe(true);
    expect(summary.change?.good).toBe(false);
    expect(isPartialPeriod('2026-03-01', 'quarter', Date.parse('2026-05-31'))).toBe(true);
    expect(isPartialPeriod('2026-03-01', 'quarter', Date.parse('2026-06-01'))).toBe(false);
  });

  it('measures against a target in either direction', () => {
    expect(summarizeKpi([{ revenue: 145 }], { valueColumn: 'revenue', style: { target: 150, targetLabel: 'Plan' } }).target).toEqual({ value: 150, label: 'Plan', share: 145 / 150, met: false, better: 'higher' });
    expect(summarizeKpi([{ churn: 0.04 }], { valueColumn: 'churn', style: { target: 0.05, better: 'lower' } }).target?.met).toBe(true);
  });

  it('reads the style and refuses what is malformed', () => {
    const problems: string[] = [];
    expect(readKpiStyle({ target: 50, targetLabel: 'Plan', better: 'lower' }, 'kpi', (message) => problems.push(message))).toEqual({ target: 50, targetLabel: 'Plan', better: 'lower' });
    expect(readKpiStyle({ target: 'lots', better: 'sideways' }, 'kpi', (message) => problems.push(message))).toBeUndefined();
    expect(problems).toHaveLength(2);
  });

  it('lets a KPI tile carry one date for its trend, and nothing else', () => {
    expect(datasetTileVisualizationCompatibility({ dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] }, 'single_value').compatible).toBe(true);
    expect(datasetTileVisualizationCompatibility({ dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }, 'single_value').compatible).toBe(false);
    expect(datasetTileVisualizationCompatibility({ dimensions: [], measures: [], calculations: [{ id: 'aov', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'orders' } } }] }, 'kpi').compatible).toBe(true);
  });
});
