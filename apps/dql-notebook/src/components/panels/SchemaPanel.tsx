import type { Theme } from '../../themes/notebook-theme';
import React, { useMemo, useState } from 'react';
import { PanelFrame, PanelToolbar, PanelEmpty } from '@duckcodeailabs/dql-ui';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { SchemaColumn, GovernanceStatus } from '../../store/types';
import { getTypeColor } from '../../utils/type-colors';

function Skeleton({ t }: { t: Theme }) {
  return (
    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 28,
            borderRadius: 4,
            background: t.pillBg,
            opacity: 0.6,
            animation: 'pulse 1.5s ease-in-out infinite',
          }}
        />
      ))}
      <style>{`@keyframes pulse { 0%,100%{opacity:.6} 50%{opacity:.3} }`}</style>
    </div>
  );
}

export function SchemaPanel() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [refreshHover, setRefreshHover] = useState(false);
  const [query, setQuery] = useState('');

  const handleRefresh = async () => {
    dispatch({ type: 'SET_SCHEMA_LOADING', loading: true });
    try {
      const tables = await api.getSchema();
      dispatch({ type: 'SET_SCHEMA', tables });
    } catch (err) {
      console.error('Schema refresh failed:', err);
    } finally {
      dispatch({ type: 'SET_SCHEMA_LOADING', loading: false });
    }
  };

  const filteredTables = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return state.schemaTables;
    return state.schemaTables.filter((table) => {
      const matchesTable = [table.name, table.path, table.objectType]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalized));
      const matchesColumn = table.columns.some((column) => column.name.toLowerCase().includes(normalized) || column.type.toLowerCase().includes(normalized));
      return matchesTable || matchesColumn;
    });
  }, [query, state.schemaTables]);

  const groupedTables = useMemo(() => {
    const groups = new Map<string, typeof filteredTables>();
    for (const table of filteredTables) {
      const [schema, ...rest] = table.name.split('.');
      const schemaName = rest.length > 0 ? schema : table.source === 'file' ? 'files' : 'default';
      const existing = groups.get(schemaName) ?? [];
      existing.push(table);
      groups.set(schemaName, existing);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredTables]);

  const stats = {
    schemas: groupedTables.length,
    tables: state.schemaTables.length,
    columns: state.schemaTables.reduce((sum, table) => sum + table.columns.length, 0),
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '7px 10px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const refreshAction = (
    <button
      onClick={handleRefresh}
      onMouseEnter={() => setRefreshHover(true)}
      onMouseLeave={() => setRefreshHover(false)}
      title="Refresh schema"
      style={{
        background: refreshHover ? t.btnHover : 'transparent',
        border: `1px solid ${t.btnBorder}`,
        borderRadius: 6,
        cursor: 'pointer',
        color: refreshHover ? t.textSecondary : t.textMuted,
        fontSize: 11,
        fontFamily: t.font,
        padding: '6px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        transition: 'all 0.15s',
      }}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
      </svg>
      Refresh
    </button>
  );

  const toolbar = (
    <PanelToolbar>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search schemas, tables, columns..."
        style={{ ...inputStyle, flex: 1, minWidth: 100 }}
      />
    </PanelToolbar>
  );

  return (
    <PanelFrame
      title="Database Catalog"
      subtitle="Schemas, tables, views, and columns from the active connection."
      actions={refreshAction}
      toolbar={toolbar}
      bodyPadding={0}
    >
      <div style={{ padding: 10, borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <CatalogStat label="Schemas" value={stats.schemas} t={t} />
        <CatalogStat label="Tables" value={stats.tables} t={t} />
        <CatalogStat label="Columns" value={stats.columns} t={t} />
      </div>

      {state.schemaLoading ? (
        <Skeleton t={t} />
      ) : state.schemaTables.length === 0 ? (
        <PanelEmpty
          title="No tables found"
          description="Connect a data source to explore schema."
        />
      ) : filteredTables.length === 0 ? (
        <PanelEmpty title="No matches" description="No database objects match the current search." />
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {groupedTables.map(([schemaName, tables]) => (
            <div key={schemaName}>
              <div
                style={{
                  padding: '8px 10px 4px',
                  fontSize: 10,
                  fontWeight: 700,
                  color: t.textMuted,
                  fontFamily: t.font,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {schemaName} · {tables.length}
              </div>
              {tables.map((table) => (
                <TableRow key={table.name} table={table} t={t} />
              ))}
            </div>
          ))}
        </div>
      )}
    </PanelFrame>
  );
}

function CatalogStat({ label, value, t }: { label: string; value: number; t: Theme }) {
  return (
    <div
      style={{
        background: t.cellBg,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 8,
        padding: '8px 10px',
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, fontFamily: t.font, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: t.textPrimary, fontFamily: t.font, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function TableRow({
  table,
  t,
}: {
  table: import('../../store/types').SchemaTable;
  t: Theme;
}) {
  const { dispatch } = useNotebook();
  const [hovered, setHovered] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);

  const handleToggle = async () => {
    dispatch({ type: 'TOGGLE_SCHEMA_TABLE', tableName: table.name });

    // Lazy-load columns on first expand when no columns exist
    if (!table.expanded && table.columns.length === 0) {
      setLoadingColumns(true);
      try {
        const columns = await api.describeTable(table.path);
        if (columns.length > 0) {
          dispatch({ type: 'SET_TABLE_COLUMNS', tableName: table.name, columns });
        }
      } catch (err) {
        console.error('describeTable failed:', err);
      } finally {
        setLoadingColumns(false);
      }
    }
  };

  return (
    <div>
      <button
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={handleToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          background: hovered ? t.sidebarItemHover : 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.textPrimary,
          fontSize: 12,
          fontFamily: t.font,
          fontWeight: 500,
          textAlign: 'left' as const,
          transition: 'background 0.1s',
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          style={{
            transform: table.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
            color: t.textMuted,
          }}
        >
          <path d="M3 2l4 3-4 3V2Z" />
        </svg>
        {(table as any).source === 'database' ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ color: '#56d364', flexShrink: 0 }}>
            <path d="M1 3.5c0-1.865 2.91-3 6-3s6 1.135 6 3v9c0 1.865-2.91 3-6 3s-6-1.135-6-3Zm1.5.5c.484.85 2.28 1.5 4.5 1.5s4.016-.65 4.5-1.5V6c-.484.85-2.28 1.5-4.5 1.5S2.984 6.85 2.5 6Zm0 4c.484.85 2.28 1.5 4.5 1.5s4.016-.65 4.5-1.5v2c-.484.85-2.28 1.5-4.5 1.5S2.984 10.85 2.5 10Z" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ color: t.accent, flexShrink: 0 }}>
            <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v1.5A1.75 1.75 0 0 1 14.25 5H1.75A1.75 1.75 0 0 1 0 3.25Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25Zm-1.75 6C0 6.784.784 6 1.75 6h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 11H1.75A1.75 1.75 0 0 1 0 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25Zm-1.75 6c0-.966.784-1.75 1.75-1.75h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25Z" />
          </svg>
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {table.name}
        </span>
        {table.objectType && (
          <span
            style={{
              fontSize: 9,
              fontFamily: t.fontMono,
              color: t.accent,
              background: `${t.accent}18`,
              borderRadius: 4,
              padding: '1px 4px',
              flexShrink: 0,
            }}
          >
            {table.objectType.toLowerCase().includes('view') ? 'view' : 'table'}
          </span>
        )}
        {table.governance?.status && (
          <GovernanceBadge status={table.governance.status} t={t} />
        )}
        {table.columns.length > 0 && (
          <span
            style={{
              fontSize: 10,
              color: t.textMuted,
              background: t.pillBg,
              borderRadius: 8,
              padding: '1px 5px',
              flexShrink: 0,
            }}
          >
            {table.columns.length}
          </span>
        )}
      </button>

      {table.expanded && (
        <div style={{ paddingLeft: 26 }}>
          {/* Governance details */}
          {table.governance && (table.governance.owner || table.governance.domain) && (
            <div style={{ padding: '3px 10px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {table.governance.domain && (
                <span style={{ fontSize: 9, fontFamily: t.font, color: t.textMuted }}>
                  <span style={{ fontWeight: 600 }}>domain:</span> {table.governance.domain}
                </span>
              )}
              {table.governance.owner && (
                <span style={{ fontSize: 9, fontFamily: t.font, color: t.textMuted }}>
                  <span style={{ fontWeight: 600 }}>owner:</span> {table.governance.owner}
                </span>
              )}
            </div>
          )}
          {loadingColumns ? (
            <div
              style={{
                padding: '4px 10px',
                fontSize: 11,
                color: t.textMuted,
                fontFamily: t.font,
                fontStyle: 'italic',
              }}
            >
              ...
            </div>
          ) : table.columns.length === 0 ? (
            <div
              style={{
                padding: '4px 10px',
                fontSize: 11,
                color: t.textMuted,
                fontFamily: t.font,
                fontStyle: 'italic',
              }}
            >
              No columns
            </div>
          ) : (
            table.columns.map((col) => (
              <ColumnRow key={col.name} col={col} t={t} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ColumnRow({ col, t }: { col: SchemaColumn; t: Theme }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 10px 3px 8px',
        background: hovered ? t.sidebarItemHover : 'transparent',
        cursor: 'default',
        transition: 'background 0.1s',
      }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ color: t.textMuted, flexShrink: 0 }}>
        <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
      </svg>
      <span
        style={{
          flex: 1,
          fontSize: 11,
          fontFamily: t.fontMono,
          color: t.textSecondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {col.name}
      </span>
      <span
        style={{
          fontSize: 10,
          fontFamily: t.fontMono,
          color: getTypeColor(col.type, t.accent),
          background: `${getTypeColor(col.type, t.accent)}18`,
          borderRadius: 4,
          padding: '1px 5px',
          flexShrink: 0,
        }}
      >
        {col.type.toLowerCase()}
      </span>
    </div>
  );
}

const GOVERNANCE_STYLES: Record<GovernanceStatus, { color: string; label: string; icon: string }> = {
  certified: { color: '#56d364', label: 'Certified', icon: '✓' },
  review: { color: '#e3b341', label: 'In Review', icon: '◎' },
  draft: { color: '#8b949e', label: 'Draft', icon: '○' },
  deprecated: { color: '#f85149', label: 'Deprecated', icon: '✗' },
  pending_recertification: { color: '#ffa657', label: 'Re-cert', icon: '↻' },
};

function GovernanceBadge({ status, t }: { status: GovernanceStatus; t: Theme }) {
  const style = GOVERNANCE_STYLES[status];
  if (!style) return null;
  return (
    <span
      title={style.label}
      style={{
        fontSize: 8,
        fontWeight: 700,
        fontFamily: t.font,
        color: style.color,
        background: `${style.color}18`,
        border: `1px solid ${style.color}40`,
        borderRadius: 3,
        padding: '0 4px',
        flexShrink: 0,
        letterSpacing: '0.04em',
        lineHeight: '14px',
      }}
    >
      {style.icon} {style.label.toUpperCase()}
    </span>
  );
}
