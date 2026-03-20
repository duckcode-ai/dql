import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { SchemaColumn } from '../../store/types';

const TYPE_COLORS: Record<string, string> = {
  varchar: '#388bfd',
  text: '#388bfd',
  string: '#388bfd',
  char: '#388bfd',
  integer: '#56d364',
  int: '#56d364',
  bigint: '#56d364',
  smallint: '#56d364',
  float: '#56d364',
  double: '#56d364',
  decimal: '#56d364',
  numeric: '#56d364',
  real: '#56d364',
  date: '#e3b341',
  timestamp: '#e3b341',
  datetime: '#e3b341',
  time: '#e3b341',
  boolean: '#f778ba',
  bool: '#f778ba',
  json: '#79c0ff',
  jsonb: '#79c0ff',
  uuid: '#d2a8ff',
  bytea: '#ffa657',
  binary: '#ffa657',
};

function getTypeColor(type: string, accent: string): string {
  const lower = type.toLowerCase().split('(')[0].trim();
  return TYPE_COLORS[lower] ?? accent;
}

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

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          borderBottom: `1px solid ${t.headerBorder}`,
        }}
      >
        <span style={{ flex: 1, fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {state.schemaTables.length} tables
        </span>
        <button
          onClick={handleRefresh}
          onMouseEnter={() => setRefreshHover(true)}
          onMouseLeave={() => setRefreshHover(false)}
          title="Refresh schema"
          style={{
            background: refreshHover ? t.btnHover : 'transparent',
            border: `1px solid ${refreshHover ? t.btnBorder : 'transparent'}`,
            borderRadius: 4,
            cursor: 'pointer',
            color: refreshHover ? t.textSecondary : t.textMuted,
            fontSize: 11,
            fontFamily: t.font,
            padding: '2px 6px',
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
      </div>

      {/* Content */}
      {state.schemaLoading ? (
        <Skeleton t={t} />
      ) : state.schemaTables.length === 0 ? (
        <div
          style={{
            padding: '24px 14px',
            color: t.textMuted,
            fontSize: 12,
            fontFamily: t.font,
            textAlign: 'center',
            fontStyle: 'italic',
          }}
        >
          No tables found.
          <br />
          Connect a data source to explore schema.
        </div>
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {state.schemaTables.map((table) => (
            <TableRow key={table.name} table={table} t={t} />
          ))}
        </div>
      )}
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

  return (
    <div>
      <button
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => dispatch({ type: 'TOGGLE_SCHEMA_TABLE', tableName: table.name })}
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
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ color: t.accent, flexShrink: 0 }}>
          <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v1.5A1.75 1.75 0 0 1 14.25 5H1.75A1.75 1.75 0 0 1 0 3.25Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25Zm-1.75 6C0 6.784.784 6 1.75 6h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 11H1.75A1.75 1.75 0 0 1 0 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25Zm-1.75 6c0-.966.784-1.75 1.75-1.75h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25Z" />
        </svg>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {table.name}
        </span>
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
          {table.columns.map((col) => (
            <ColumnRow key={col.name} col={col} t={t} />
          ))}
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
