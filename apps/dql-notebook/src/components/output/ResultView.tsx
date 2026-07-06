import React, { useMemo, useState } from 'react';
import type { QueryResult, CellChartConfig } from '../../store/types';
import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import { ChartOutput, CHART_TYPE_OPTIONS } from './ChartOutput';
import { TableOutput } from './TableOutput';

const CHART_X_DATE_RE = /date|time|day|month|year|week|quarter|period|_at$|^at$/i;

function isChartNumericCell(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
  return false;
}

/** Columns whose sampled non-blank values are all numeric — candidate measures. */
function numericResultColumns(result: QueryResult): string[] {
  const sample = result.rows.slice(0, 20);
  if (sample.length === 0) return [];
  return result.columns.filter((column) =>
    sample.some((row) => isChartNumericCell(row[column]))
    && sample.every((row) => {
      const value = row[column];
      return value === null || value === undefined || value === '' || isChartNumericCell(value);
    }),
  );
}

/**
 * Best-effort chart config for an arbitrary result: honors any config supplied,
 * else picks a category column for X and a numeric column for Y and defaults to a
 * line (time X) or bar chart. Returns chartable=false only when there is genuinely
 * nothing to plot (no numeric column, <2 columns, or 0 rows) — far more permissive
 * than the strict name-based auto-detector, so the Chart tab actually shows for
 * real-world outputs like `product_name, total_value, order_count`.
 */
export function deriveResultChartConfig(result: QueryResult, base?: CellChartConfig): { config: CellChartConfig; chartable: boolean } {
  const numeric = numericResultColumns(result);
  const chartable = result.rows.length > 0 && result.columns.length >= 2 && numeric.length >= 1;
  if (!chartable) return { config: base ?? {}, chartable: false };
  const category = result.columns.find((column) => !numeric.includes(column)) ?? result.columns[0];
  const x = base?.x && result.columns.includes(base.x) ? base.x : category;
  const y = base?.y && result.columns.includes(base.y) ? base.y : (numeric.find((column) => column !== x) ?? numeric[0]);
  const baseChart = base?.chart && base.chart.toLowerCase().replace(/_/g, '-') !== 'table' ? base.chart : undefined;
  const chart = baseChart ?? (CHART_X_DATE_RE.test(x) ? 'line' : 'bar');
  return { config: { ...(base ?? {}), chart, x, y }, chartable: true };
}

/**
 * Notebook-cell-style result view: a chart/table toggle + manual chart-type picker
 * over any QueryResult. Shared by Ask AI (UnifiedAgentRunPanel) and notebook query
 * cells so both render governed results identically.
 */
export function ResultView({ result, themeMode, t, chartConfig }: { result: QueryResult; themeMode: ThemeMode; t: Theme; chartConfig?: CellChartConfig }) {
  const isEmpty = result.rows.length === 0;
  // User overrides from the chart-type picker / settings gear (type / X / Y / palette …).
  const [override, setOverride] = useState<CellChartConfig | undefined>();
  const base = useMemo<CellChartConfig>(() => ({ ...(chartConfig ?? {}), ...(override ?? {}) }), [chartConfig, override]);
  const { config: effectiveChart, chartable } = deriveResultChartConfig(result, base);
  const [view, setView] = useState<'chart' | 'table'>(chartable ? 'chart' : 'table');
  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: t.font,
    fontSize: 11, fontWeight: 700, padding: '2px 4px', color: active ? t.accent : t.textMuted,
    borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
  });
  // Reflect the active chart type in the picker; fall back to bar if the resolved
  // type isn't one of the standard options.
  const currentChartType = CHART_TYPE_OPTIONS.some((option) => option.value === effectiveChart.chart)
    ? effectiveChart.chart
    : 'bar';
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 9px', borderBottom: `1px solid ${t.headerBorder}` }}>
        {/* Chart tab shows whenever the data can be plotted; the picker + gear let
            the user pick the chart type and axes manually. */}
        {chartable && <button type="button" onClick={() => setView('chart')} style={tabStyle(view === 'chart')}>Chart</button>}
        {chartable && <button type="button" onClick={() => setView('table')} style={tabStyle(view === 'table')}>Table</button>}
        {!chartable && !isEmpty && <span style={{ fontSize: 11, fontWeight: 700, color: t.textMuted }}>Table</span>}
        {chartable && view === 'chart' ? (
          <select
            value={currentChartType}
            onChange={(event) => setOverride((prev) => ({ ...(prev ?? {}), chart: event.target.value }))}
            title="Chart type"
            style={{
              fontFamily: t.font, fontSize: 10.5, fontWeight: 600, color: t.textSecondary,
              background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 5,
              padding: '1px 4px', cursor: 'pointer',
            }}
          >
            {CHART_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : null}
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: t.textMuted, alignSelf: 'center' }}>{result.rowCount ?? result.rows.length} rows</span>
      </div>
      <div style={{ padding: 8, minHeight: chartable && view === 'chart' ? 200 : undefined, maxHeight: 320, overflow: 'auto' }}>
        {isEmpty
          ? <div style={{ padding: '18px 8px', textAlign: 'center', color: t.textMuted, fontSize: 12 }}>
              The query ran successfully and matched 0 rows{result.columns.length > 0 ? ` (columns: ${result.columns.join(', ')})` : ''}.
            </div>
          : chartable && view === 'chart'
            ? <ChartOutput
                result={result}
                themeMode={themeMode}
                chartConfig={effectiveChart}
                onConfigChange={(updates) => setOverride((prev) => ({ ...(prev ?? {}), ...updates }))}
              />
            : <TableOutput result={result} themeMode={themeMode} />}
      </div>
    </div>
  );
}
