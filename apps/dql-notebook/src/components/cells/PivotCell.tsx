import React, { useMemo, useState, useRef, useEffect } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, PivotCellConfig, QueryResult, ThemeMode } from '../../store/types';
import { aggregate, type Aggregation as SharedAggregation } from '../../utils/aggregate';

interface PivotCellProps {
  cell: Cell;
  cells: Cell[];
  index: number;
  themeMode: ThemeMode;
  onUpdate: (updates: Partial<Cell>) => void;
}

type Aggregation = PivotCellConfig['values'][number]['aggregation'];

const AGGREGATIONS: Aggregation[] = ['sum', 'avg', 'count', 'min', 'max', 'count_distinct'];

const DEFAULT_PIVOT_CONFIG: PivotCellConfig = { rows: [], columns: [], values: [] };

function rowKey(row: Record<string, unknown>, cols: string[]): string {
  return cols.map((c) => String(row[c] ?? '')).join('|');
}

/** Hex-style Pivot cell — drop zones for Rows, Columns, Values with per-value aggregation. */
export function PivotCell({ cell, cells, index, themeMode, onUpdate }: PivotCellProps) {
  const t: Theme = themes[themeMode];
  const config: PivotCellConfig = cell.pivotConfig ?? DEFAULT_PIVOT_CONFIG;

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

  const updateConfig = (next: PivotCellConfig) => onUpdate({ pivotConfig: next });

  const pivot = useMemo(() => {
    if (!result) return null;
    if (config.rows.length === 0 && config.columns.length === 0) return null;
    if (config.values.length === 0) return null;

    const colKeys = new Set<string>();
    const grouped = new Map<string, { row: Record<string, unknown>; groups: Map<string, Record<string, unknown>[]> }>();

    for (const r of result.rows) {
      const rKey = rowKey(r, config.rows);
      const cKey = rowKey(r, config.columns);
      colKeys.add(cKey);
      let entry = grouped.get(rKey);
      if (!entry) {
        const rowDims: Record<string, unknown> = {};
        for (const c of config.rows) rowDims[c] = r[c];
        entry = { row: rowDims, groups: new Map() };
        grouped.set(rKey, entry);
      }
      const cells = entry.groups.get(cKey) ?? [];
      cells.push(r);
      entry.groups.set(cKey, cells);
    }

    const sortedColKeys = [...colKeys].sort();
    const renderedHeaders = sortedColKeys.map((k) => (k === '' ? 'value' : k));

    const body: Array<{ rowDims: Record<string, unknown>; values: Array<Record<string, unknown>> }> = [];
    for (const [, entry] of grouped) {
      const row = entry;
      const valueCells = sortedColKeys.map((cKey) => {
        const bucket = row.groups.get(cKey) ?? [];
        const values: Record<string, unknown> = {};
        for (const v of config.values) {
          const raw = bucket.map((b) => b[v.column]);
          values[`${v.aggregation}(${v.column})`] = aggregate(raw, v.aggregation);
        }
        return values;
      });
      body.push({ rowDims: row.row, values: valueCells });
    }

    return { columnKeys: sortedColKeys, columnHeaders: renderedHeaders, body };
  }, [config, result]);

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
            Pivot
          </span>
          {cell.name && <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>}
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 10 }}>Pick an upstream dataframe to pivot.</div>
        {upstreamOptions.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted }}>No successful upstream cells yet.</div>
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
          Pivot
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

      {/* Config zones */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: 12, gap: 10, borderBottom: `1px solid ${t.cellBorder}` }}>
        <DropZone
          label="Rows"
          selected={config.rows}
          availableColumns={columns}
          theme={t}
          onAdd={(col) => updateConfig({ ...config, rows: [...config.rows, col] })}
          onRemove={(col) => updateConfig({ ...config, rows: config.rows.filter((c) => c !== col) })}
        />
        <DropZone
          label="Columns"
          selected={config.columns}
          availableColumns={columns}
          theme={t}
          onAdd={(col) => updateConfig({ ...config, columns: [...config.columns, col] })}
          onRemove={(col) => updateConfig({ ...config, columns: config.columns.filter((c) => c !== col) })}
        />
        <ValueZone
          values={config.values}
          availableColumns={columns}
          theme={t}
          onAdd={(col) => updateConfig({ ...config, values: [...config.values, { column: col, aggregation: 'sum' }] })}
          onUpdate={(idx, patch) =>
            updateConfig({ ...config, values: config.values.map((v, i) => (i === idx ? { ...v, ...patch } : v)) })
          }
          onRemove={(idx) => updateConfig({ ...config, values: config.values.filter((_, i) => i !== idx) })}
        />
      </div>

      {/* Preview */}
      <div style={{ padding: 12, overflowX: 'auto' }}>
        {!pivot || pivot.body.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            Pick at least one row/column dimension and one value to see a preview.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: t.fontMono, fontSize: 11 }}>
            <thead>
              <tr>
                {config.rows.map((r) => (
                  <th
                    key={r}
                    style={{
                      textAlign: 'left',
                      padding: '4px 8px',
                      borderBottom: `1px solid ${t.cellBorder}`,
                      color: t.textSecondary,
                      fontWeight: 600,
                    }}
                  >
                    {r}
                  </th>
                ))}
                {pivot.columnHeaders.map((h, i) => (
                  <th
                    key={i}
                    style={{
                      textAlign: 'right',
                      padding: '4px 8px',
                      borderBottom: `1px solid ${t.cellBorder}`,
                      color: t.textSecondary,
                      fontWeight: 600,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pivot.body.slice(0, 50).map((r, ri) => (
                <tr key={ri}>
                  {config.rows.map((rr) => (
                    <td key={rr} style={{ padding: '3px 8px', color: t.textPrimary, borderBottom: `1px solid ${t.cellBorder}30` }}>
                      {String(r.rowDims[rr] ?? '')}
                    </td>
                  ))}
                  {r.values.map((cell, ci) => (
                    <td key={ci} style={{ padding: '3px 8px', color: t.textPrimary, textAlign: 'right', borderBottom: `1px solid ${t.cellBorder}30` }}>
                      {Object.values(cell).map((v, vi) => (
                        <div key={vi}>{v === null ? '—' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v)}</div>
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DropZone({
  label,
  selected,
  availableColumns,
  theme,
  onAdd,
  onRemove,
}: {
  label: string;
  selected: string[];
  availableColumns: string[];
  theme: Theme;
  onAdd: (col: string) => void;
  onRemove: (col: string) => void;
}) {
  return (
    <ZoneBase label={label} theme={theme} availableColumns={availableColumns.filter((c) => !selected.includes(c))} onAdd={onAdd}>
      {selected.length === 0 ? (
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: theme.font }}>+ add column</span>
      ) : (
        selected.map((col) => (
          <div
            key={col}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px',
              background: `${theme.accent}14`,
              border: `1px solid ${theme.accent}55`,
              borderRadius: 3,
              fontSize: 11,
              fontFamily: theme.fontMono,
              color: theme.textPrimary,
              margin: 2,
            }}
          >
            {col}
            <span
              onClick={() => onRemove(col)}
              style={{ cursor: 'pointer', color: theme.textMuted, fontSize: 10 }}
              title="Remove"
            >
              ✕
            </span>
          </div>
        ))
      )}
    </ZoneBase>
  );
}

function ValueZone({
  values,
  availableColumns,
  theme,
  onAdd,
  onUpdate,
  onRemove,
}: {
  values: PivotCellConfig['values'];
  availableColumns: string[];
  theme: Theme;
  onAdd: (col: string) => void;
  onUpdate: (idx: number, patch: Partial<PivotCellConfig['values'][number]>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <ZoneBase label="Values" theme={theme} availableColumns={availableColumns} onAdd={onAdd}>
      {values.length === 0 ? (
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: theme.font }}>+ add value</span>
      ) : (
        values.map((v, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 2 }}>
            <select
              value={v.aggregation}
              onChange={(e) => onUpdate(i, { aggregation: e.target.value as Aggregation })}
              style={{
                background: theme.editorBg,
                border: `1px solid ${theme.cellBorder}`,
                borderRadius: 3,
                color: theme.textSecondary,
                fontSize: 10,
                fontFamily: theme.fontMono,
                padding: '1px 4px',
              }}
            >
              {AGGREGATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                background: `${theme.accent}14`,
                border: `1px solid ${theme.accent}55`,
                borderRadius: 3,
                fontSize: 11,
                fontFamily: theme.fontMono,
                color: theme.textPrimary,
              }}
            >
              {v.column}
              <span onClick={() => onRemove(i)} style={{ cursor: 'pointer', color: theme.textMuted, fontSize: 10 }}>✕</span>
            </span>
          </div>
        ))
      )}
    </ZoneBase>
  );
}

function ZoneBase({
  label,
  theme,
  availableColumns,
  onAdd,
  children,
}: {
  label: string;
  theme: Theme;
  availableColumns: string[];
  onAdd: (col: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
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
      </div>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          minHeight: 42,
          border: `1px dashed ${theme.cellBorder}`,
          borderRadius: 4,
          padding: 4,
          cursor: 'pointer',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {children}
      </div>
      {open && availableColumns.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 2px)',
            left: 0,
            right: 0,
            zIndex: 10,
            background: theme.cellBg,
            border: `1px solid ${theme.cellBorder}`,
            borderRadius: 6,
            boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
            padding: 4,
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          {availableColumns.map((col) => (
            <button
              key={col}
              onClick={() => {
                onAdd(col);
                setOpen(false);
              }}
              style={{
                width: '100%',
                padding: '4px 8px',
                background: 'transparent',
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
                textAlign: 'left',
                color: theme.textPrimary,
                fontFamily: theme.fontMono,
                fontSize: 11,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = theme.tableRowHover;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              {col}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
