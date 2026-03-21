import React, { useState } from 'react';
import { themes } from '../../themes/notebook-theme';
import { TableOutput } from './TableOutput';
import type { QueryResult, CellChartConfig } from '../../store/types';

interface ChartOutputProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
  chartConfig?: CellChartConfig;  // Explicit config from DQL visualization block
}

export type ChartType = 'bar' | 'line' | 'pie' | 'kpi' | 'table';

const DATE_NAME_RE = /date|time|at|day|month|year/i;
const LABEL_NAME_RE = /^(label|name|category)$/i;
const VALUE_NAME_RE = /^(value|count|total|revenue|amount)$/i;

function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return true;
  if (typeof v === 'string') return v.trim() !== '' && !isNaN(Number(v));
  return false;
}

function isStringLike(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number';
}

/**
 * Resolve chart type: explicit config takes priority, heuristics as fallback.
 * chartConfig.chart values: 'bar', 'line', 'pie', 'kpi', 'table'
 */
export function resolveChartType(result: QueryResult, chartConfig?: CellChartConfig): ChartType {
  if (chartConfig?.chart) {
    const c = chartConfig.chart.toLowerCase();
    if (c === 'bar' || c === 'line' || c === 'pie' || c === 'kpi') return c;
    if (c === 'table') return 'table';
  }
  return detectChartType(result);
}

/** Heuristic chart type detection from result columns and sample rows */
export function detectChartType(result: QueryResult): ChartType {
  const { columns, rows } = result;
  if (columns.length < 2 || rows.length === 0) return 'table';

  const col0 = columns[0];
  const col1 = columns[1];
  const sample = rows.slice(0, 5);

  const col1AllNumeric = sample.every((r) => isNumericValue(r[col1]));
  const col0AllString = sample.every((r) => isStringLike(r[col0]));

  // Line chart: col[0] is date-like name and col[1] is numeric
  if (DATE_NAME_RE.test(col0) && col1AllNumeric && col0AllString) {
    return 'line';
  }

  // Bar chart: label/name/category col + value/count/total/revenue/amount col
  const labelCol = columns.find((c) => LABEL_NAME_RE.test(c));
  const valueCol = columns.find((c) => VALUE_NAME_RE.test(c));
  if (labelCol && valueCol) {
    const valueAllNumeric = sample.every((r) => isNumericValue(r[valueCol]));
    if (valueAllNumeric) return 'bar';
  }

  // Bar chart: exactly 2 columns, col[0] string, col[1] numeric
  if (columns.length === 2 && col0AllString && col1AllNumeric) {
    return 'bar';
  }

  return 'table';
}

// ─── Number formatting ────────────────────────────────────────────────────────

function abbreviate(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ─── Bar Chart ────────────────────────────────────────────────────────────────

const MAX_BARS = 20;

interface BarChartProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
}

function BarChart({ result, themeMode }: BarChartProps) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Determine label and value columns
  const labelCol =
    result.columns.find((c) => LABEL_NAME_RE.test(c)) ?? result.columns[0];
  const valueCol =
    result.columns.find((c) => VALUE_NAME_RE.test(c)) ?? result.columns[1];

  const data = result.rows.slice(0, MAX_BARS).map((row) => ({
    label: String(row[labelCol] ?? ''),
    value: Number(row[valueCol] ?? 0),
  }));

  const truncated = result.rows.length > MAX_BARS;
  const maxVal = Math.max(...data.map((d) => d.value), 1);

  const BAR_H = 28;
  const LABEL_W = 120;
  const VALUE_W = 60;
  const GAP = 6;
  const PADDING = 12;

  const svgH = data.length * (BAR_H + GAP) + PADDING * 2;

  return (
    <div style={{ padding: '8px 0' }}>
      <svg
        width="100%"
        height={svgH}
        style={{ display: 'block', overflow: 'visible' }}
        viewBox={`0 0 600 ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {data.map((item, i) => {
          const y = PADDING + i * (BAR_H + GAP);
          const barMaxW = 600 - LABEL_W - VALUE_W - 24;
          const barW = Math.max((item.value / maxVal) * barMaxW, 2);
          const isHovered = hoveredIdx === i;
          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: 'default' }}
            >
              {/* Label */}
              <text
                x={LABEL_W - 8}
                y={y + BAR_H / 2 + 4}
                textAnchor="end"
                fontSize={11}
                fontFamily={t.font}
                fill={t.textSecondary}
              >
                {item.label.length > 16 ? item.label.slice(0, 15) + '…' : item.label}
              </text>
              {/* Bar */}
              <rect
                x={LABEL_W}
                y={y}
                width={barW}
                height={BAR_H}
                rx={3}
                fill={isHovered ? t.accentHover : t.accent}
                style={{ transition: 'fill 0.15s' }}
              />
              {/* Value */}
              <text
                x={LABEL_W + barW + 6}
                y={y + BAR_H / 2 + 4}
                textAnchor="start"
                fontSize={11}
                fontFamily={t.fontMono}
                fill={t.textMuted}
              >
                {abbreviate(item.value)}
              </text>
            </g>
          );
        })}
      </svg>
      {truncated && (
        <div
          style={{
            fontSize: 11,
            color: t.textMuted,
            fontFamily: t.font,
            fontStyle: 'italic',
            padding: '4px 12px',
          }}
        >
          Showing {MAX_BARS} of {result.rows.length} rows
        </div>
      )}
    </div>
  );
}

// ─── Line Chart ───────────────────────────────────────────────────────────────

interface LineChartProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
}

function formatDateLabel(val: string): string {
  // Try to parse common date strings
  const d = new Date(val);
  if (!isNaN(d.getTime())) {
    // If it has a day component (YYYY-MM-DD or similar)
    if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    if (/^\d{4}-\d{2}$/.test(val)) {
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
    }
  }
  // Truncate if too long
  return String(val).length > 8 ? String(val).slice(0, 8) : String(val);
}

function LineChart({ result, themeMode }: LineChartProps) {
  const t = themes[themeMode];
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

  const xCol = result.columns[0];
  const yCol = result.columns[1];

  const data = result.rows.map((row) => ({
    label: String(row[xCol] ?? ''),
    value: Number(row[yCol] ?? 0),
  }));

  if (data.length < 2) return null;

  const WIDTH = 560;
  const HEIGHT = 200;
  const PAD_L = 52;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 36;

  const chartW = WIDTH - PAD_L - PAD_R;
  const chartH = HEIGHT - PAD_T - PAD_B;

  const minVal = Math.min(...data.map((d) => d.value));
  const maxVal = Math.max(...data.map((d) => d.value));
  const valRange = maxVal - minVal || 1;

  const xStep = chartW / (data.length - 1);

  const toX = (i: number) => PAD_L + i * xStep;
  const toY = (v: number) => PAD_T + chartH - ((v - minVal) / valRange) * chartH;

  // Build smooth cubic bezier path
  const points = data.map((d, i) => ({ x: toX(i), y: toY(d.value) }));
  const pathD = points.reduce((acc, pt, i) => {
    if (i === 0) return `M ${pt.x},${pt.y}`;
    const prev = points[i - 1];
    const cx1 = prev.x + (pt.x - prev.x) / 2;
    const cy1 = prev.y;
    const cx2 = prev.x + (pt.x - prev.x) / 2;
    const cy2 = pt.y;
    return `${acc} C ${cx1},${cy1} ${cx2},${cy2} ${pt.x},${pt.y}`;
  }, '');

  // Area path closes below
  const areaD = `${pathD} L ${points[points.length - 1].x},${PAD_T + chartH} L ${PAD_L},${PAD_T + chartH} Z`;

  // Y axis ticks
  const TICKS = 5;
  const yTicks = Array.from({ length: TICKS + 1 }, (_, i) => {
    const val = minVal + (valRange * i) / TICKS;
    const y = toY(val);
    return { val, y };
  });

  // X axis: show at most 8 labels
  const labelStep = Math.ceil(data.length / 8);
  const xLabels = data.filter((_, i) => i % labelStep === 0 || i === data.length - 1);

  return (
    <div style={{ position: 'relative', padding: '8px 0' }}>
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Y grid + ticks */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              y1={tick.y}
              x2={PAD_L + chartW}
              y2={tick.y}
              stroke={t.tableBorder}
              strokeWidth={0.5}
            />
            <text
              x={PAD_L - 6}
              y={tick.y + 4}
              textAnchor="end"
              fontSize={10}
              fontFamily={t.fontMono}
              fill={t.textMuted}
            >
              {abbreviate(tick.val)}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaD} fill={t.accent} opacity={0.15} />

        {/* Line */}
        <path d={pathD} fill="none" stroke={t.accent} strokeWidth={2} strokeLinejoin="round" />

        {/* Data points */}
        {points.map((pt, i) => (
          <circle
            key={i}
            cx={pt.x}
            cy={pt.y}
            r={3}
            fill={t.accent}
            style={{ cursor: 'crosshair' }}
            onMouseEnter={() =>
              setTooltip({ x: pt.x, y: pt.y, label: data[i].label, value: data[i].value })
            }
          />
        ))}

        {/* X axis labels */}
        {xLabels.map((item, i) => {
          const idx = data.indexOf(item);
          return (
            <text
              key={i}
              x={toX(idx)}
              y={PAD_T + chartH + 16}
              textAnchor="middle"
              fontSize={10}
              fontFamily={t.font}
              fill={t.textMuted}
            >
              {formatDateLabel(item.label)}
            </text>
          );
        })}

        {/* Axes */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        <line x1={PAD_L} y1={PAD_T + chartH} x2={PAD_L + chartW} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />

        {/* Tooltip */}
        {tooltip && (
          <g>
            <rect
              x={tooltip.x + 8}
              y={tooltip.y - 20}
              width={90}
              height={32}
              rx={4}
              fill={t.cellBg}
              stroke={t.cellBorder}
              strokeWidth={1}
            />
            <text x={tooltip.x + 13} y={tooltip.y - 8} fontSize={10} fontFamily={t.font} fill={t.textSecondary}>
              {tooltip.label.length > 10 ? tooltip.label.slice(0, 10) + '…' : tooltip.label}
            </text>
            <text x={tooltip.x + 13} y={tooltip.y + 6} fontSize={11} fontFamily={t.fontMono} fill={t.textPrimary} fontWeight={600}>
              {abbreviate(tooltip.value)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── Pie Chart ────────────────────────────────────────────────────────────────

const MAX_PIE_SLICES = 12;
const PIE_PALETTE = [
  '#388bfd', '#56d364', '#e3b341', '#f78166', '#a371f7',
  '#39c5cf', '#ffa657', '#ff7b72', '#89d185', '#d2a8ff',
  '#58a6ff', '#3fb950',
];

interface PieChartProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
  chartConfig?: CellChartConfig;
}

function PieChart({ result, themeMode, chartConfig }: PieChartProps) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const labelCol = (chartConfig?.x
    ? result.columns.find((c) => c === chartConfig.x)
    : undefined) ?? result.columns.find((c) => LABEL_NAME_RE.test(c)) ?? result.columns[0];
  const valueCol = (chartConfig?.y
    ? result.columns.find((c) => c === chartConfig.y)
    : undefined) ?? result.columns.find((c) => VALUE_NAME_RE.test(c)) ?? result.columns[1];

  const rawData = result.rows.slice(0, MAX_PIE_SLICES).map((row) => ({
    label: String(row[labelCol] ?? ''),
    value: Math.abs(Number(row[valueCol] ?? 0)),
  }));

  const total = rawData.reduce((s, d) => s + d.value, 0) || 1;

  const CX = 90, CY = 90, R = 70, IR = 40;
  const slices: Array<{ path: string; color: string; label: string; value: number; pct: number }> = [];
  let angle = -Math.PI / 2;

  rawData.forEach((d, i) => {
    const sweep = (d.value / total) * 2 * Math.PI;
    const a1 = angle;
    const a2 = angle + sweep;
    const lx1 = CX + R * Math.cos(a1);
    const ly1 = CY + R * Math.sin(a1);
    const lx2 = CX + R * Math.cos(a2);
    const ly2 = CY + R * Math.sin(a2);
    const ix1 = CX + IR * Math.cos(a1);
    const iy1 = CY + IR * Math.sin(a1);
    const ix2 = CX + IR * Math.cos(a2);
    const iy2 = CY + IR * Math.sin(a2);
    const large = sweep > Math.PI ? 1 : 0;
    const path = [
      `M ${lx1} ${ly1}`,
      `A ${R} ${R} 0 ${large} 1 ${lx2} ${ly2}`,
      `L ${ix2} ${iy2}`,
      `A ${IR} ${IR} 0 ${large} 0 ${ix1} ${iy1}`,
      'Z',
    ].join(' ');
    slices.push({ path, color: PIE_PALETTE[i % PIE_PALETTE.length], label: d.label, value: d.value, pct: (d.value / total) * 100 });
    angle = a2;
  });

  const hovered = hoveredIdx !== null ? slices[hoveredIdx] : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 12px', flexWrap: 'wrap' }}>
      <svg
        width={180}
        height={180}
        style={{ flexShrink: 0 }}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {slices.map((s, i) => (
          <path
            key={i}
            d={s.path}
            fill={s.color}
            opacity={hoveredIdx === null || hoveredIdx === i ? 1 : 0.55}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
            onMouseEnter={() => setHoveredIdx(i)}
          />
        ))}
        {/* Center label */}
        <text x={CX} y={CY - 5} textAnchor="middle" fontSize={11} fontFamily={t.fontMono} fill={t.textSecondary}>
          {hovered ? abbreviate(hovered.value) : abbreviate(total)}
        </text>
        <text x={CX} y={CY + 9} textAnchor="middle" fontSize={9} fontFamily={t.font} fill={t.textMuted}>
          {hovered ? `${hovered.pct.toFixed(1)}%` : 'total'}
        </text>
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto', flex: 1 }}>
        {slices.map((s, i) => (
          <div
            key={i}
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'default', opacity: hoveredIdx === null || hoveredIdx === i ? 1 : 0.5 }}
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: t.font, color: t.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
              {s.label}
            </span>
            <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textMuted, marginLeft: 'auto', flexShrink: 0 }}>
              {s.pct.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
  chartConfig?: CellChartConfig;
}

function KpiCard({ result, themeMode, chartConfig }: KpiCardProps) {
  const t = themes[themeMode];
  const row = result.rows[0];
  if (!row) return null;

  // Find the value column: explicit y, or first numeric column
  const yCol = chartConfig?.y && result.columns.includes(chartConfig.y)
    ? chartConfig.y
    : result.columns.find((c) => isNumericValue(row[c])) ?? result.columns[0];

  const rawVal = row[yCol];
  const numVal = Number(rawVal);
  const displayVal = isNaN(numVal) ? String(rawVal) : numVal.toLocaleString(undefined, { maximumFractionDigits: 2 });

  // Label: explicit title, or x column value, or column name
  const label = chartConfig?.title
    ?? (chartConfig?.x && row[chartConfig.x] ? String(row[chartConfig.x]) : yCol);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px',
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 40,
          fontWeight: 700,
          fontFamily: t.fontMono,
          color: t.accent,
          lineHeight: 1.1,
        }}
      >
        {displayVal}
      </span>
      <span
        style={{
          fontSize: 13,
          fontFamily: t.font,
          color: t.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 500,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ─── ChartOutput ──────────────────────────────────────────────────────────────

export function ChartOutput({ result, themeMode, chartConfig }: ChartOutputProps) {
  const t = themes[themeMode];
  const resolvedType = resolveChartType(result, chartConfig);
  const canChart = resolvedType !== 'table';
  const [view, setView] = useState<'chart' | 'table'>(canChart ? 'chart' : 'table');

  // Use explicit x/y columns from chartConfig when rendering bar/line charts
  const xCol = chartConfig?.x && result.columns.includes(chartConfig.x) ? chartConfig.x : undefined;
  const yCol = chartConfig?.y && result.columns.includes(chartConfig.y) ? chartConfig.y : undefined;
  const configuredResult = (xCol || yCol) ? reorderColumns(result, xCol, yCol) : result;

  // Column mismatch warnings
  const warnings: string[] = [];
  if (chartConfig?.x && !result.columns.includes(chartConfig.x)) {
    warnings.push(`Column '${chartConfig.x}' not found in results — using auto-detection.`);
  }
  if (chartConfig?.y && !result.columns.includes(chartConfig.y)) {
    warnings.push(`Column '${chartConfig.y}' not found in results — using auto-detection.`);
  }

  const chartLabel = resolvedType === 'line' ? 'Line' : resolvedType === 'pie' ? 'Pie' : resolvedType === 'kpi' ? 'KPI' : 'Bar';

  // KPI renders without toggle bar
  if (resolvedType === 'kpi') {
    return (
      <div>
        {warnings.length > 0 && <ColumnWarnings warnings={warnings} t={t} />}
        <KpiCard result={result} themeMode={themeMode} chartConfig={chartConfig} />
      </div>
    );
  }

  return (
    <div>
      {/* Column warnings */}
      {warnings.length > 0 && <ColumnWarnings warnings={warnings} t={t} />}

      {/* Toggle bar */}
      {canChart && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: '4px 12px',
            gap: 4,
            borderBottom: `1px solid ${t.cellBorder}`,
            background: `${t.tableHeaderBg}60`,
          }}
        >
          <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, marginRight: 4 }}>
            View:
          </span>
          {(['chart', 'table'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              style={{
                padding: '2px 8px',
                fontSize: 10,
                fontFamily: t.font,
                borderRadius: 4,
                border: `1px solid ${view === mode ? t.accent : t.btnBorder}`,
                background: view === mode ? `${t.accent}20` : 'transparent',
                color: view === mode ? t.accent : t.textMuted,
                cursor: 'pointer',
                transition: 'all 0.15s',
                textTransform: 'capitalize',
              }}
            >
              {mode === 'chart' ? chartLabel : 'Table'}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      {view === 'table' || !canChart ? (
        <TableOutput result={result} themeMode={themeMode} />
      ) : resolvedType === 'line' ? (
        <LineChart result={configuredResult} themeMode={themeMode} />
      ) : resolvedType === 'pie' ? (
        <PieChart result={result} themeMode={themeMode} chartConfig={chartConfig} />
      ) : (
        <BarChart result={configuredResult} themeMode={themeMode} />
      )}
    </div>
  );
}

function ColumnWarnings({ warnings, t }: { warnings: string[]; t: typeof themes['dark'] }) {
  return (
    <div
      style={{
        padding: '4px 12px',
        background: '#e3b34115',
        borderBottom: `1px solid #e3b34130`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {warnings.map((w, i) => (
        <span key={i} style={{ fontSize: 11, color: '#e3b341', fontFamily: t.font }}>
          {w}
        </span>
      ))}
    </div>
  );
}

/** Reorder columns so that the explicit x/y cols come first (for bar/line charts) */
function reorderColumns(result: QueryResult, xCol?: string, yCol?: string): QueryResult {
  const cols = result.columns;
  const ordered: string[] = [];
  if (xCol && cols.includes(xCol)) ordered.push(xCol);
  if (yCol && cols.includes(yCol)) ordered.push(yCol);
  for (const c of cols) {
    if (!ordered.includes(c)) ordered.push(c);
  }
  if (ordered.join(',') === cols.join(',')) return result;
  return {
    ...result,
    columns: ordered,
    rows: result.rows.map((row) => {
      const reordered: Record<string, unknown> = {};
      for (const c of ordered) reordered[c] = row[c];
      return reordered;
    }),
  };
}
