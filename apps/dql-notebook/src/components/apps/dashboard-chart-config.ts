import type { CellChartConfig, QueryResult } from '../../store/types';
import { CHART_TYPE_OPTIONS } from '../output/ChartOutput';

type DashboardTileChartInput = {
  title?: string;
  viz: { type?: string; options?: Record<string, unknown> };
};

/**
 * The chart types the client can actually render, derived from the chart engine
 * rather than restated. A dashboard `viz.type` outside this set (the server also
 * accepts `pivot`, `map`, `text` and `heading`) falls back to `table`, because
 * there is no renderer for it here.
 */
const CHART_TYPES = new Set<string>(['table', ...CHART_TYPE_OPTIONS.map((option) => option.value)]);

export function normalizeDashboardChartType(value: unknown): string {
  const normalized = String(value ?? 'table').toLowerCase().replace(/_/g, '-');
  if (normalized === 'single-value') return 'kpi';
  return CHART_TYPES.has(normalized) ? normalized : 'table';
}

export function mergeDashboardTileChartConfig(
  item: DashboardTileChartInput,
  base?: CellChartConfig,
): CellChartConfig {
  const rawOptions = item.viz.options ?? {};
  const options = rawOptions as Partial<CellChartConfig>;
  // Dashboard documents historically used `field` and the documented format
  // uses `valueField`; ChartOutput uses `y`. Normalize all three here so KPI
  // cards display the metric the author selected instead of the first numeric
  // column returned by a multi-measure block.
  const valueField = typeof rawOptions.valueField === 'string'
    ? rawOptions.valueField
    : typeof rawOptions.field === 'string'
      ? rawOptions.field
      : undefined;
  return {
    ...(base ?? {}),
    ...options,
    // The dashboard document owns the tile presentation. A reusable block may
    // carry a default chart, but that must not turn an explicitly-authored KPI
    // tile back into the block's bar/line/table visualization.
    chart: normalizeDashboardChartType(options.chart ?? item.viz.type ?? base?.chart),
    y: options.y ?? valueField ?? base?.y,
    title: options.title ?? base?.title ?? item.title,
    colorPalette: options.colorPalette ?? base?.colorPalette ?? 'corporate',
  };
}

export function summarizeDashboardKpiResult(result: QueryResult, valueField?: string): QueryResult {
  if (!valueField || result.rows.length <= 1 || !result.columns.includes(valueField)) return result;

  const values = result.rows
    .map((row) => row[valueField])
    .filter((value): value is number | string => (
      typeof value === 'number'
      || (typeof value === 'string' && value.trim() !== '')
    ))
    .map(Number)
    .filter(Number.isFinite);
  if (values.length === 0) return result;

  // Dashboard facts and Business Story already summarize repeated numeric rows
  // as totals. Feed the KPI renderer the same settled value so the visible card
  // cannot disagree with its evidence summary.
  const total = Number(values.reduce((sum, value) => sum + value, 0).toPrecision(15));
  return {
    ...result,
    columns: [valueField],
    rows: [{ [valueField]: total }],
    rowCount: 1,
  };
}
