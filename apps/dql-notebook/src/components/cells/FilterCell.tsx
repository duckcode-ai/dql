import React, { useMemo } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type {
  Cell,
  FilterCellConfig,
  FilterGroup,
  FilterOperation,
  FilterRule,
  QueryResult,
  ThemeMode,
} from '../../store/types';
import { classifyColumns } from '../../utils/semantic-fields';
import { SemanticFieldPicker, NoSemanticBindingNote } from './SemanticFieldPicker';
import { CellEmptyState } from './CellEmptyState';

interface FilterCellProps {
  cell: Cell;
  cells: Cell[];
  index: number;
  themeMode: ThemeMode;
  onUpdate: (updates: Partial<Cell>) => void;
}

const OPERATIONS: { value: FilterOperation; label: string; needsValue: boolean }[] = [
  { value: 'eq', label: '=', needsValue: true },
  { value: 'neq', label: '!=', needsValue: true },
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '>=', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '<=', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true },
  { value: 'ends_with', label: 'ends with', needsValue: true },
  { value: 'in', label: 'in (list)', needsValue: true },
  { value: 'not_in', label: 'not in (list)', needsValue: true },
  { value: 'between', label: 'between (a, b)', needsValue: true },
  { value: 'is_null', label: 'is empty', needsValue: false },
  { value: 'is_not_null', label: 'is not empty', needsValue: false },
];

function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeDefaultFilterConfig(): FilterCellConfig {
  return {
    mode: 'keep',
    groups: [{ id: rid('g'), combinator: 'and', rules: [] }],
  };
}

function formatRule(rule: FilterRule): string {
  const op = OPERATIONS.find((o) => o.value === rule.operation);
  if (!op) return '';
  if (!rule.column) return '…';
  if (!op.needsValue) return `${rule.column} ${op.label}`;
  return `${rule.column} ${op.label} ${rule.value || '…'}`;
}

export function FilterCell({ cell, cells, index, themeMode, onUpdate }: FilterCellProps) {
  const t: Theme = themes[themeMode];
  const fallbackConfig = useMemo(makeDefaultFilterConfig, [cell.id]);
  const config: FilterCellConfig = cell.filterConfig ?? fallbackConfig;

  const upstream = useMemo(() => {
    const name = cell.upstream ?? config.upstream;
    if (!name) return undefined;
    return cells.find((c) => c.name === name);
  }, [cell.upstream, config.upstream, cells]);

  const upstreamOptions = useMemo(() => {
    return cells
      .slice(0, index)
      .filter((c) => c.name && c.result);
  }, [cells, index]);

  const result: QueryResult | undefined = upstream?.result;
  const columns = result?.columns ?? [];
  const classified = useMemo(() => classifyColumns(result), [result]);

  const updateConfig = (next: FilterCellConfig) => {
    onUpdate({ filterConfig: next });
  };

  const updateGroup = (groupId: string, patch: Partial<FilterGroup>) => {
    updateConfig({
      ...config,
      groups: config.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)),
    });
  };

  const updateRule = (groupId: string, ruleId: string, patch: Partial<FilterRule>) => {
    updateConfig({
      ...config,
      groups: config.groups.map((g) =>
        g.id === groupId
          ? { ...g, rules: g.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)) }
          : g,
      ),
    });
  };

  const addRule = (groupId: string) => {
    updateConfig({
      ...config,
      groups: config.groups.map((g) =>
        g.id === groupId
          ? { ...g, rules: [...g.rules, { id: rid('r'), column: columns[0] ?? '', operation: 'eq', value: '' }] }
          : g,
      ),
    });
  };

  const removeRule = (groupId: string, ruleId: string) => {
    updateConfig({
      ...config,
      groups: config.groups.map((g) =>
        g.id === groupId ? { ...g, rules: g.rules.filter((r) => r.id !== ruleId) } : g,
      ),
    });
  };

  const addGroup = () => {
    updateConfig({
      ...config,
      groups: [...config.groups, { id: rid('g'), combinator: 'and', rules: [] }],
    });
  };

  const removeGroup = (groupId: string) => {
    updateConfig({
      ...config,
      groups: config.groups.filter((g) => g.id !== groupId),
    });
  };

  if (!upstream || !result) {
    return (
      <CellEmptyState
        theme={t}
        accentColor="#ff7b72"
        cellLabel="Filter"
        cellName={cell.name}
        description="Filter cells keep or drop rows from an upstream dataframe using column-by-column rules — no SQL needed."
        upstreamOptions={upstreamOptions}
        onPick={(name) => onUpdate({ upstream: name })}
      />
    );
  }

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
        borderLeft: `3px solid #ff7b72`,
        borderRadius: 6,
        fontFamily: t.font,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
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
            color: '#ff7b72',
            background: '#ff7b7218',
            padding: '2px 6px',
            borderRadius: 3,
            textTransform: 'uppercase',
          }}
        >
          Filter
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
        <div style={{ flex: 1 }} />
        <div style={{ display: 'inline-flex', border: `1px solid ${t.cellBorder}`, borderRadius: 3, overflow: 'hidden' }}>
          {(['keep', 'drop'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => updateConfig({ ...config, mode })}
              style={{
                fontSize: 10,
                fontFamily: t.font,
                fontWeight: 600,
                letterSpacing: '0.04em',
                padding: '3px 10px',
                background: config.mode === mode ? `${t.accent}20` : 'transparent',
                color: config.mode === mode ? t.accent : t.textMuted,
                border: 'none',
                cursor: 'pointer',
                textTransform: 'uppercase',
              }}
            >
              {mode === 'keep' ? 'Keep rows' : 'Drop rows'}
            </button>
          ))}
        </div>
      </div>

      {/* Groups */}
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!classified.hasSemanticBinding && <NoSemanticBindingNote theme={t} />}
        {config.groups.map((group, gi) => (
          <div
            key={group.id}
            style={{
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 6,
              padding: 10,
              background: `${t.tableHeaderBg}30`,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: t.textMuted,
                  textTransform: 'uppercase',
                  fontFamily: t.font,
                }}
              >
                Group {gi + 1}
              </span>
              <div
                style={{
                  display: 'inline-flex',
                  border: `1px solid ${t.cellBorder}`,
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                {(['and', 'or'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => updateGroup(group.id, { combinator: c })}
                    style={{
                      fontSize: 10,
                      fontFamily: t.fontMono,
                      padding: '2px 8px',
                      background: group.combinator === c ? `${t.accent}20` : 'transparent',
                      color: group.combinator === c ? t.accent : t.textMuted,
                      border: 'none',
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                      fontWeight: 700,
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1 }} />
              {config.groups.length > 1 && (
                <button
                  onClick={() => removeGroup(group.id)}
                  style={{
                    fontSize: 10,
                    background: 'transparent',
                    border: `1px solid ${t.btnBorder}`,
                    borderRadius: 3,
                    color: t.textMuted,
                    padding: '1px 6px',
                    cursor: 'pointer',
                    fontFamily: t.font,
                  }}
                >
                  Remove group
                </button>
              )}
            </div>

            {group.rules.length === 0 && (
              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, padding: '4px 2px' }}>
                No rules yet — add one below.
              </div>
            )}

            {group.rules.map((rule) => {
              const op = OPERATIONS.find((o) => o.value === rule.operation) ?? OPERATIONS[0];
              return (
                <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <SemanticFieldPicker
                    theme={t}
                    value={rule.column || undefined}
                    fields={classified.fields}
                    placeholder="Select field"
                    minWidth={180}
                    onChange={(name) => updateRule(group.id, rule.id, { column: name ?? '' })}
                  />
                  <select
                    value={rule.operation}
                    onChange={(e) => updateRule(group.id, rule.id, { operation: e.target.value as FilterOperation })}
                    style={{ ...inputStyle, minWidth: 120 }}
                  >
                    {OPERATIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {op.needsValue && (
                    <input
                      value={rule.value}
                      onChange={(e) => updateRule(group.id, rule.id, { value: e.target.value })}
                      placeholder="Value"
                      style={{ ...inputStyle, flex: 1, minWidth: 100 }}
                    />
                  )}
                  <button
                    onClick={() => removeRule(group.id, rule.id)}
                    title="Remove rule"
                    style={{
                      background: 'transparent',
                      border: `1px solid ${t.btnBorder}`,
                      borderRadius: 3,
                      color: t.textMuted,
                      fontSize: 10,
                      padding: '2px 6px',
                      cursor: 'pointer',
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}

            <div>
              <button
                onClick={() => addRule(group.id)}
                style={{
                  fontSize: 10,
                  fontFamily: t.font,
                  color: t.accent,
                  background: 'transparent',
                  border: `1px dashed ${t.accent}55`,
                  borderRadius: 3,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  letterSpacing: '0.04em',
                }}
              >
                + Add filter
              </button>
            </div>
          </div>
        ))}

        <div>
          <button
            onClick={addGroup}
            style={{
              fontSize: 10,
              fontFamily: t.font,
              color: t.textMuted,
              background: 'transparent',
              border: `1px dashed ${t.btnBorder}`,
              borderRadius: 3,
              padding: '3px 10px',
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >
            + Add filter group
          </button>
        </div>
      </div>

      {/* Rule preview strip */}
      <div
        style={{
          padding: '6px 12px',
          borderTop: `1px solid ${t.cellBorder}`,
          background: `${t.tableHeaderBg}40`,
          fontSize: 10,
          fontFamily: t.fontMono,
          color: t.textMuted,
          letterSpacing: '0.04em',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        {config.mode === 'keep' ? 'KEEP WHERE ' : 'DROP WHERE '}
        {config.groups
          .map((g) => g.rules.map(formatRule).join(` ${g.combinator.toUpperCase()} `))
          .filter(Boolean)
          .map((g) => `(${g})`)
          .join(' AND ') || '—'}
      </div>
    </div>
  );
}
