import React, { useMemo, useState, useRef, useEffect } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, PivotCellConfig, QueryResult, ThemeMode } from '../../store/types';
import { aggregate, type Aggregation as SharedAggregation } from '../../utils/aggregate';
import {
  classifyColumns,
  fieldKindColor,
  fieldKindIcon,
  type ClassifiedColumns,
  type FieldKind,
} from '../../utils/semantic-fields';
import { NoSemanticBindingNote } from './SemanticFieldPicker';
import { CellEmptyState } from './CellEmptyState';

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

function kindFor(classified: ClassifiedColumns, col: string): FieldKind {
  if (classified.metrics.includes(col)) return 'metric';
  if (classified.dimensions.includes(col)) return 'dimension';
  return 'column';
}

/** Return fields with the preferred kind first, then the rest. */
function orderForKind(classified: ClassifiedColumns, preferred: FieldKind): { name: string; kind: FieldKind }[] {
  const preferredFields = classified.fields.filter((f) => f.kind === preferred);
  const rest = classified.fields.filter((f) => f.kind !== preferred);
  return [...preferredFields, ...rest].map((f) => ({ name: f.name, kind: f.kind }));
}

/** Hex-style Pivot cell — drop zones for Rows, Columns, Values with per-value aggregation. */
export function PivotCell({ cell, cells, index, themeMode, onUpdate }: PivotCellProps) {
  const t: Theme = themes[themeMode];
  const rawConfig = cell.pivotConfig ?? DEFAULT_PIVOT_CONFIG;
  const config: PivotCellConfig = {
    upstream: rawConfig.upstream,
    rows: rawConfig.rows ?? [],
    columns: rawConfig.columns ?? [],
    values: rawConfig.values ?? [],
  };

  const upstream = useMemo(() => {
    const name = cell.upstream ?? config.upstream;
    if (!name) return undefined;
    return cells.find((c) => c.name === name);
  }, [cell.upstream, config.upstream, cells]);

  const upstreamOptions = useMemo(() => {
    return cells.slice(0, index).filter((c) => c.name && c.result);
  }, [cells, index]);

  const result: QueryResult | undefined = upstream?.result;
  const columns = result?.columns ?? [];
  const classified = useMemo(() => classifyColumns(result), [result]);

  const dimensionFirst = useMemo(() => orderForKind(classified, 'dimension'), [classified]);
  const metricFirst = useMemo(() => orderForKind(classified, 'metric'), [classified]);

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
      <CellEmptyState
        theme={t}
        accentColor="#a371f7"
        cellLabel="Pivot"
        cellName={cell.name}
        description="Pivots reshape an upstream dataframe into a rows × columns grid. Pick dimensions for rows/columns and a metric for values."
        upstreamOptions={upstreamOptions}
        onPick={(name) => onUpdate({ upstream: name })}
      />
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
      {!classified.hasSemanticBinding && (
        <div style={{ padding: '8px 12px 0' }}>
          <NoSemanticBindingNote theme={t} />
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: 12, gap: 10, borderBottom: `1px solid ${t.cellBorder}` }}>
        <DropZone
          label="Rows"
          selected={config.rows}
          availableFields={dimensionFirst.filter((f) => !config.rows.includes(f.name))}
          kindFor={(c) => kindFor(classified, c)}
          theme={t}
          onAdd={(col) => updateConfig({ ...config, rows: [...config.rows, col] })}
          onRemove={(col) => updateConfig({ ...config, rows: config.rows.filter((c) => c !== col) })}
        />
        <DropZone
          label="Columns"
          selected={config.columns}
          availableFields={dimensionFirst.filter((f) => !config.columns.includes(f.name))}
          kindFor={(c) => kindFor(classified, c)}
          theme={t}
          onAdd={(col) => updateConfig({ ...config, columns: [...config.columns, col] })}
          onRemove={(col) => updateConfig({ ...config, columns: config.columns.filter((c) => c !== col) })}
        />
        <ValueZone
          values={config.values}
          availableFields={metricFirst}
          kindFor={(c) => kindFor(classified, c)}
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
  availableFields,
  kindFor,
  theme,
  onAdd,
  onRemove,
}: {
  label: string;
  selected: string[];
  availableFields: { name: string; kind: FieldKind }[];
  kindFor: (col: string) => FieldKind;
  theme: Theme;
  onAdd: (col: string) => void;
  onRemove: (col: string) => void;
}) {
  return (
    <ZoneBase label={label} theme={theme} availableFields={availableFields} onAdd={onAdd}>
      {selected.length === 0 ? (
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: theme.font }}>+ add field</span>
      ) : (
        selected.map((col) => {
          const kind = kindFor(col);
          return (
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
              <span style={{ color: fieldKindColor(kind, theme.accent), fontWeight: 700 }}>
                {fieldKindIcon(kind)}
              </span>
              {col}
              <span
                onClick={() => onRemove(col)}
                style={{ cursor: 'pointer', color: theme.textMuted, fontSize: 10 }}
                title="Remove"
              >
                ✕
              </span>
            </div>
          );
        })
      )}
    </ZoneBase>
  );
}

function ValueZone({
  values,
  availableFields,
  kindFor,
  theme,
  onAdd,
  onUpdate,
  onRemove,
}: {
  values: PivotCellConfig['values'];
  availableFields: { name: string; kind: FieldKind }[];
  kindFor: (col: string) => FieldKind;
  theme: Theme;
  onAdd: (col: string) => void;
  onUpdate: (idx: number, patch: Partial<PivotCellConfig['values'][number]>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <ZoneBase label="Values" theme={theme} availableFields={availableFields} onAdd={onAdd}>
      {values.length === 0 ? (
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: theme.font }}>+ add value</span>
      ) : (
        values.map((v, i) => {
          const kind = kindFor(v.column);
          return (
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
                <span style={{ color: fieldKindColor(kind, theme.accent), fontWeight: 700 }}>
                  {fieldKindIcon(kind)}
                </span>
                {v.column}
                <span onClick={() => onRemove(i)} style={{ cursor: 'pointer', color: theme.textMuted, fontSize: 10 }}>✕</span>
              </span>
            </div>
          );
        })
      )}
    </ZoneBase>
  );
}

function ZoneBase({
  label,
  theme,
  availableFields,
  onAdd,
  children,
}: {
  label: string;
  theme: Theme;
  availableFields: { name: string; kind: FieldKind }[];
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
      {open && availableFields.length > 0 && (
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
          {availableFields.map((field) => (
            <button
              key={field.name}
              onClick={() => {
                onAdd(field.name);
                setOpen(false);
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
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
              <span style={{ color: fieldKindColor(field.kind, theme.accent), fontWeight: 700, width: 12 }}>
                {fieldKindIcon(field.kind)}
              </span>
              <span>{field.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
