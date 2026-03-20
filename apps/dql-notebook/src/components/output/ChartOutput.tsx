import React, { useState } from 'react';
import { themes } from '../../themes/notebook-theme';
import { TableOutput } from './TableOutput';
import type { QueryResult } from '../../store/types';

interface ChartOutputProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
}

export type ChartType = 'bar' | 'line' | 'table';

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

/** Detect chart type from result columns and sample rows */
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

// ─── ChartOutput ──────────────────────────────────────────────────────────────

export function ChartOutput({ result, themeMode }: ChartOutputProps) {
  const t = themes[themeMode];
  const detectedType = detectChartType(result);
  const [view, setView] = useState<'chart' | 'table'>(
    detectedType !== 'table' ? 'chart' : 'table'
  );

  const canChart = detectedType !== 'table';

  return (
    <div>
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
              {mode === 'chart' ? (detectedType === 'line' ? 'Line' : 'Chart') : 'Table'}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      {view === 'table' || !canChart ? (
        <TableOutput result={result} themeMode={themeMode} />
      ) : detectedType === 'line' ? (
        <LineChart result={result} themeMode={themeMode} />
      ) : (
        <BarChart result={result} themeMode={themeMode} />
      )}
    </div>
  );
}
