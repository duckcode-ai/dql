import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { DevPanelTab } from '../../store/types';

function formatTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function DevPanel() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [toggleHover, setToggleHover] = useState(false);

  const errorLogs = state.queryLog.filter((e) => e.error);

  const setTab = (tab: DevPanelTab) => dispatch({ type: 'SET_DEV_PANEL_TAB', tab });

  return (
    <div
      style={{
        height: state.devPanelOpen ? 180 : 0,
        flexShrink: 0,
        background: t.sidebarBg,
        borderTop: `1px solid ${t.headerBorder}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'height 0.2s ease',
        position: 'relative',
      }}
    >
      {state.devPanelOpen && (
        <>
          {/* Tab bar */}
          <div
            style={{
              height: 32,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              borderBottom: `1px solid ${t.headerBorder}`,
              padding: '0 8px',
              gap: 2,
            }}
          >
            {(['logs', 'errors'] as DevPanelTab[]).map((tab) => (
              <TabButton
                key={tab}
                label={
                  tab === 'errors'
                    ? `Errors${errorLogs.length > 0 ? ` (${errorLogs.length})` : ''}`
                    : `Logs (${state.queryLog.length})`
                }
                active={state.devPanelTab === tab}
                onClick={() => setTab(tab)}
                t={t}
              />
            ))}
            <div style={{ flex: 1 }} />
            <button
              onClick={() =>
                dispatch({
                  type: 'SET_CELLS',
                  cells: state.cells,
                })
              }
              title="Clear logs"
              style={{
                background: 'transparent',
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: 'none',
                borderBottom: 'none',
                cursor: 'pointer',
                color: t.textMuted,
                fontSize: 11,
                fontFamily: t.font,
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              Clear
            </button>
          </div>

          {/* Content */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '4px 0',
            }}
          >
            {state.devPanelTab === 'logs' &&
              (state.queryLog.length === 0 ? (
                <EmptyState t={t} message="No queries executed yet." />
              ) : (
                [...state.queryLog].reverse().map((entry) => (
                  <LogRow key={entry.id} entry={entry} t={t} />
                ))
              ))}

            {state.devPanelTab === 'errors' &&
              (errorLogs.length === 0 ? (
                <EmptyState t={t} message="No errors." />
              ) : (
                [...errorLogs].reverse().map((entry) => (
                  <LogRow key={entry.id} entry={entry} t={t} />
                ))
              ))}
          </div>
        </>
      )}

      {/* Toggle button — always rendered, anchored to bottom-right of content area */}
      <button
        onClick={() => dispatch({ type: 'TOGGLE_DEV_PANEL' })}
        onMouseEnter={() => setToggleHover(true)}
        onMouseLeave={() => setToggleHover(false)}
        title={state.devPanelOpen ? 'Close panel' : 'Open dev panel'}
        style={{
          position: 'absolute',
          bottom: state.devPanelOpen ? 4 : -28,
          right: 8,
          height: 22,
          padding: '0 8px',
          borderRadius: '4px 4px 0 0',
          borderTop: `1px solid ${t.headerBorder}`,
          borderLeft: `1px solid ${t.headerBorder}`,
          borderRight: `1px solid ${t.headerBorder}`,
          borderBottom: state.devPanelOpen ? `1px solid ${t.sidebarBg}` : `1px solid ${t.headerBorder}`,
          background: toggleHover ? t.btnHover : t.sidebarBg,
          color: t.textMuted,
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: t.font,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          transition: 'background 0.15s, bottom 0.2s ease',
          zIndex: 10,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d={state.devPanelOpen ? 'M1 7l4-4 4 4' : 'M1 3l4 4 4-4'} strokeWidth="1.5" stroke="currentColor" fill="none" />
        </svg>
        Dev
      </button>
    </div>
  );
}

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  t: Theme;
}

function TabButton({ label, active, onClick, t }: TabButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'transparent',
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: active ? `2px solid ${t.accent}` : '2px solid transparent',
        cursor: 'pointer',
        color: active ? t.textPrimary : hovered ? t.textSecondary : t.textMuted,
        fontSize: 12,
        fontFamily: t.font,
        fontWeight: active ? 500 : 400,
        padding: '4px 8px',
        height: 32,
        transition: 'color 0.15s',
      }}
    >
      {label}
    </button>
  );
}

function EmptyState({ t, message }: { t: Theme; message: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: t.textMuted,
        fontSize: 12,
        fontFamily: t.font,
        fontStyle: 'italic',
      }}
    >
      {message}
    </div>
  );
}

function LogRow({
  entry,
  t,
}: {
  entry: import('../../store/types').QueryLogEntry;
  t: Theme;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '3px 12px',
        fontSize: 11,
        fontFamily: t.fontMono,
        color: entry.error ? t.error : t.textSecondary,
        borderLeft: entry.error ? `2px solid ${t.error}` : '2px solid transparent',
      }}
    >
      <span style={{ color: t.textMuted, flexShrink: 0 }}>{formatTime(entry.ts)}</span>
      <span style={{ flexShrink: 0, color: t.textPrimary, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.cellName}
      </span>
      {entry.error ? (
        <span style={{ color: t.error, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.error}
        </span>
      ) : (
        <>
          <span style={{ color: t.textMuted }}>{entry.rows.toLocaleString()} rows</span>
          <span style={{ color: t.textMuted }}>{formatMs(entry.time)}</span>
        </>
      )}
    </div>
  );
}
