import React, { useMemo } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, QueryResult, SingleValueCellConfig, ThemeMode } from '../../store/types';
import { aggregate } from '../../utils/aggregate';

interface SingleValueCellProps {
  cell: Cell;
  cells: Cell[];
  index: number;
  themeMode: ThemeMode;
  onUpdate: (updates: Partial<Cell>) => void;
}

type Aggregation = NonNullable<SingleValueCellConfig['aggregation']>;
type Format = NonNullable<SingleValueCellConfig['format']>;

const AGGREGATIONS: { value: Aggregation; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'count', label: 'Count' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'last', label: 'Last' },
];

const FORMATS: { value: Format; label: string }[] = [
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'duration', label: 'Duration' },
];

const DEFAULT_SINGLE_VALUE_CONFIG: SingleValueCellConfig = { aggregation: 'count', format: 'number' };

function computeAggregate(result: QueryResult, column: string | undefined, aggregation: Aggregation): number | null {
  if (aggregation === 'count') return aggregate(result.rows, 'count');
  if (!column || !result.columns.includes(column)) return null;
  return aggregate(result.rows.map((r) => r[column]), aggregation);
}

function formatValue(n: number | null, format: Format): string {
  if (n === null) return '—';
  switch (format) {
    case 'currency':
      return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    case 'percent':
      return `${(n * 100).toFixed(1)}%`;
    case 'duration': {
      if (n < 60) return `${n.toFixed(1)}s`;
      if (n < 3600) return `${(n / 60).toFixed(1)}m`;
      return `${(n / 3600).toFixed(1)}h`;
    }
    case 'number':
    default:
      return Math.abs(n) >= 1000
        ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : n.toFixed(Number.isInteger(n) ? 0 : 2);
  }
}

/** Hex-style Single Value card (KPI) — metric + aggregation + format + label. */
export function SingleValueCell({ cell, cells, index, themeMode, onUpdate }: SingleValueCellProps) {
  const t: Theme = themes[themeMode];
  const config: SingleValueCellConfig = cell.singleValueConfig ?? DEFAULT_SINGLE_VALUE_CONFIG;
  const aggregation: Aggregation = config.aggregation ?? 'count';
  const format: Format = config.format ?? 'number';

  const upstream = useMemo(() => {
    const name = cell.upstream ?? config.upstream;
    if (!name) return undefined;
    return cells.find((c) => c.name === name);
  }, [cell.upstream, config.upstream, cells]);

  const upstreamOptions = useMemo(() => {
    return cells.slice(0, index).filter((c) => c.name && c.status === 'success' && c.result);
  }, [cells, index]);

  const result: QueryResult | undefined = upstream?.result;
  const columns = result?.columns ?? [];

  const value = useMemo(
    () => (result ? computeAggregate(result, config.metric, aggregation) : null),
    [result, config.metric, aggregation]
  );

  const updateConfig = (patch: Partial<SingleValueCellConfig>) => {
    onUpdate({ singleValueConfig: { ...config, ...patch } });
  };

  if (!upstream || !result) {
    return (
      <div
        style={{
          background: t.cellBg,
          border: `1px solid ${t.cellBorder}`,
          borderLeft: `3px solid #a371f7`,
          borderRadius: 6,
          padding: '18px 20px',
          fontFamily: t.font,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span
            style={{
              fontSize: 10,
              fontFamily: t.fontMono,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: '#a371f7',
              background: '#a371f718',
              padding: '2px 6px',
              borderRadius: 3,
              textTransform: 'uppercase',
            }}
          >
            Single value
          </span>
          {cell.name && (
            <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 10 }}>Pick an upstream dataframe to compute a single value.</div>
        {upstreamOptions.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted }}>
            No successful upstream cells yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {upstreamOptions.map((c) => (
              <button
                key={c.id}
                onClick={() => onUpdate({ upstream: c.name })}
                style={{
                  fontSize: 11,
                  fontFamily: t.fontMono,
                  color: '#a371f7',
                  background: '#a371f714',
                  border: `1px solid #a371f755`,
                  borderRadius: 4,
                  padding: '3px 10px',
                  cursor: 'pointer',
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const formatted = formatValue(value, format);

  const inputStyle: React.CSSProperties = {
    background: t.editorBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 3,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.fontMono,
    padding: '3px 6px',
    outline: 'none',
  };

  return (
    <div
      style={{
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid #a371f7`,
        borderRadius: 6,
        fontFamily: t.font,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: `1px solid ${t.cellBorder}`,
          background: `${t.tableHeaderBg}60`,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontFamily: t.fontMono,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: '#a371f7',
            background: '#a371f718',
            padding: '2px 6px',
            borderRadius: 3,
            textTransform: 'uppercase',
          }}
        >
          Single value
        </span>
        {cell.name && <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>}
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>· df: {upstream.name}</span>
        <button
          onClick={() => onUpdate({ upstream: undefined })}
          style={{
            fontSize: 10,
            background: 'transparent',
            border: `1px solid ${t.btnBorder}`,
            borderRadius: 3,
            color: t.textMuted,
            padding: '1px 6px',
            cursor: 'pointer',
            fontFamily: t.fontMono,
          }}
        >
          change
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr' }}>
        {/* Config panel */}
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderRight: `1px solid ${t.cellBorder}` }}>
          <ConfigRow label="Aggregation" theme={t}>
            <select
              value={aggregation}
              onChange={(e) => updateConfig({ aggregation: e.target.value as Aggregation })}
              style={{ ...inputStyle, width: '100%' }}
            >
              {AGGREGATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </ConfigRow>
          {aggregation !== 'count' && (
            <ConfigRow label="Metric column" theme={t}>
              <select
                value={config.metric ?? ''}
                onChange={(e) => updateConfig({ metric: e.target.value || undefined })}
                style={{ ...inputStyle, width: '100%' }}
              >
                <option value="">Select column</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </ConfigRow>
          )}
          <ConfigRow label="Format" theme={t}>
            <select
              value={format}
              onChange={(e) => updateConfig({ format: e.target.value as Format })}
              style={{ ...inputStyle, width: '100%' }}
            >
              {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </ConfigRow>
          <ConfigRow label="Label" theme={t}>
            <input
              value={config.label ?? ''}
              onChange={(e) => updateConfig({ label: e.target.value || undefined })}
              placeholder="e.g. Total revenue"
              style={{ ...inputStyle, width: '100%' }}
            />
          </ConfigRow>
        </div>

        {/* KPI card preview */}
        <div
          style={{
            padding: '24px 20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontFamily: t.font,
              color: t.textMuted,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            {config.label ?? `${aggregation.toUpperCase()}${config.metric ? ` · ${config.metric}` : ''}`}
          </div>
          <div
            style={{
              fontSize: 42,
              fontWeight: 700,
              fontFamily: t.font,
              color: t.textPrimary,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
            }}
          >
            {formatted}
          </div>
          <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
            from {result.rows.length.toLocaleString()} rows
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfigRow({ label, theme, children }: { label: string; theme: Theme; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: theme.textMuted,
          textTransform: 'uppercase',
          fontFamily: theme.font,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
