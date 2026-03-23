import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { useQueryExecution } from '../../hooks/useQueryExecution';
import { SQLCellEditor } from './SQLCellEditor';
import { MarkdownCellEditor } from './MarkdownCellEditor';
import { ParamCell } from './ParamCell';
import { SnippetPicker } from './SnippetPicker';
import { TableOutput } from '../output/TableOutput';
import { ChartOutput, detectChartType, resolveChartType } from '../output/ChartOutput';
import { ErrorOutput } from '../output/ErrorOutput';
import type { Cell } from '../../store/types';
import { format as formatSQL } from 'sql-formatter';

interface CellProps {
  cell: Cell;
  index: number;
}

const TYPE_LABELS: Record<string, string> = {
  sql: 'SQL',
  markdown: 'MD',
  dql: 'DQL',
  param: 'PARAM',
};

const TYPE_COLORS: Record<string, string> = {
  sql: '#388bfd',
  markdown: '#56d364',
  dql: '#e3b341',
  param: '#e3b341',
};

function getCellBorderColor(cell: Cell, t: Theme): string {
  switch (cell.status) {
    case 'running':
      return t.cellBorderRunning;
    case 'success':
      return t.success;
    case 'error':
      return t.error;
    default:
      return t.cellBorder;
  }
}

function ExecutionBadge({ cell, t }: { cell: Cell; t: Theme }) {
  let label = '';
  let color = t.textMuted;

  if (cell.status === 'running') {
    label = '[*]';
    color = t.cellBorderRunning;
  } else if (cell.status === 'error') {
    label = '[!]';
    color = t.error;
  } else if (cell.executionCount !== undefined) {
    label = `[${cell.executionCount}]`;
    color = t.textMuted;
  } else {
    label = '[ ]';
    color = t.textMuted;
  }

  return (
    <div
      style={{
        width: 40,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 12,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontFamily: t.fontMono,
          fontSize: 11,
          color,
          lineHeight: 1.4,
          userSelect: 'none',
          transition: 'color 0.2s',
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function CellComponent({ cell, index }: CellProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const { executeCell, executeDependents } = useQueryExecution();

  const [cellHovered, setCellHovered] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(cell.name ?? '');
  const [showOutput, setShowOutput] = useState(true);
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('table');

  const borderColor = getCellBorderColor(cell, t);
  const isExecutable = cell.type !== 'markdown' && cell.type !== 'param';

  // Build schema map for SQL autocomplete: { tableName: ['col1', 'col2'] }
  // useMemo ensures stable reference — only changes when schemaTables content changes
  const editorSchema = useMemo(
    () =>
      state.schemaTables.length > 0
        ? Object.fromEntries(
            state.schemaTables.map((tbl) => [tbl.name, tbl.columns.map((c) => c.name)])
          )
        : undefined,
    [state.schemaTables]
  );

  // Param cells get their own fully self-contained rendering
  if (cell.type === 'param') {
    return (
      <div
        onMouseEnter={() => setCellHovered(true)}
        onMouseLeave={() => setCellHovered(false)}
        style={{ display: 'flex', gap: 0, marginBottom: 2 }}
      >
        {/* Gutter placeholder */}
        <div style={{ width: 40, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <ParamCell cell={cell} themeMode={state.themeMode} onApplyParam={executeDependents} />
        </div>
      </div>
    );
  }

  // When result first arrives (status → success), resolve chart type (explicit config > heuristic)
  useEffect(() => {
    if (cell.status === 'success' && cell.result) {
      const chartType = resolveChartType(cell.result, cell.chartConfig);
      setViewMode(chartType !== 'table' ? 'chart' : 'table');
    }
  }, [cell.status, cell.result, cell.chartConfig]);

  const handleRun = useCallback(() => {
    if (isExecutable) {
      executeCell(cell.id);
    }
  }, [cell.id, executeCell, isExecutable]);

  const handleContentChange = useCallback(
    (content: string) => {
      dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { content } });
    },
    [cell.id, dispatch]
  );

  const handleFormat = useCallback(() => {
    if (!cell.content.trim()) return;
    try {
      const formatted = formatSQL(cell.content, {
        language: 'sql',
        tabWidth: 2,
        keywordCase: 'upper',
        linesBetweenQueries: 1,
      });
      dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { content: formatted } });
    } catch {
      // If formatter fails (e.g. invalid SQL), leave as-is
    }
  }, [cell.content, cell.id, dispatch]);

  const handleFixAndRun = useCallback(() => {
    handleFormat();
    // Small delay so the formatted content propagates before running
    setTimeout(() => executeCell(cell.id), 80);
  }, [handleFormat, executeCell, cell.id]);

  const handleDelete = () => {
    dispatch({ type: 'DELETE_CELL', id: cell.id });
  };

  const handleMoveUp = () => {
    dispatch({ type: 'MOVE_CELL', id: cell.id, direction: 'up' });
  };

  const handleMoveDown = () => {
    dispatch({ type: 'MOVE_CELL', id: cell.id, direction: 'down' });
  };

  const commitName = () => {
    setNameEditing(false);
    dispatch({
      type: 'UPDATE_CELL',
      id: cell.id,
      updates: { name: nameDraft.trim() || undefined },
    });
  };

  const hasOutput = (cell.result || cell.error) && cell.type !== 'markdown';
  // canChart: explicit chartConfig overrides heuristic detection
  const canChart = cell.result
    ? resolveChartType(cell.result, cell.chartConfig) !== 'table'
    : false;

  return (
    <div
      onMouseEnter={() => setCellHovered(true)}
      onMouseLeave={() => setCellHovered(false)}
      style={{
        display: 'flex',
        gap: 0,
        marginBottom: 2,
      }}
    >
      {/* Gutter */}
      <ExecutionBadge cell={cell} t={t} />

      {/* Cell body */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          borderRadius: 8,
          border: `1px solid ${cellHovered || cell.status !== 'idle' ? borderColor : t.cellBorder}`,
          borderLeft: `2px solid ${borderColor}`,
          background: t.cellBg,
          overflow: 'hidden',
          transition: 'border-color 0.2s',
        }}
      >
        {/* Cell header */}
        <div
          style={{
            height: 32,
            display: 'flex',
            alignItems: 'center',
            padding: '0 8px 0 10px',
            gap: 8,
            borderBottom: `1px solid ${t.cellBorder}`,
            background: `${t.tableHeaderBg}80`,
          }}
        >
          {/* Type badge */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: t.fontMono,
              letterSpacing: '0.08em',
              color: TYPE_COLORS[cell.type] ?? t.accent,
              background: `${TYPE_COLORS[cell.type] ?? t.accent}18`,
              border: `1px solid ${TYPE_COLORS[cell.type] ?? t.accent}40`,
              borderRadius: 4,
              padding: '1px 6px',
              flexShrink: 0,
              textTransform: 'uppercase' as const,
            }}
          >
            {TYPE_LABELS[cell.type]}
          </span>

          {/* Templates button — shown on hover for sql/dql cells */}
          {cellHovered && (cell.type === 'sql' || cell.type === 'dql') && (
            <SnippetPicker
              themeMode={state.themeMode}
              cellType={cell.type}
              onInsert={(code) => handleContentChange(code)}
            />
          )}

          {/* Format button — shown on hover for sql/dql cells */}
          {cellHovered && (cell.type === 'sql' || cell.type === 'dql') && (
            <button
              title="Format SQL (clean up whitespace & keywords)"
              onClick={handleFormat}
              style={{
                background: 'transparent',
                border: `1px solid ${t.btnBorder}`,
                borderRadius: 4,
                color: t.textMuted,
                fontSize: 10,
                fontFamily: t.font,
                fontWeight: 600,
                letterSpacing: '0.04em',
                padding: '1px 7px',
                cursor: 'pointer',
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = t.textSecondary;
                (e.currentTarget as HTMLButtonElement).style.borderColor = t.accent;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = t.textMuted;
                (e.currentTarget as HTMLButtonElement).style.borderColor = t.btnBorder;
              }}
            >
              Format
            </button>
          )}

          {/* Cell name */}
          {nameEditing ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') setNameEditing(false);
              }}
              style={{
                background: 'transparent',
                border: `1px solid ${t.cellBorderActive}`,
                borderRadius: 4,
                color: t.textSecondary,
                fontSize: 12,
                fontFamily: t.fontMono,
                padding: '1px 6px',
                outline: 'none',
                width: 140,
              }}
            />
          ) : (
            cell.name && (
              <span
                onClick={() => {
                  setNameDraft(cell.name ?? '');
                  setNameEditing(true);
                }}
                title="Click to rename"
                style={{
                  color: t.textSecondary,
                  fontSize: 12,
                  fontFamily: t.fontMono,
                  cursor: 'text',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                  maxWidth: 200,
                }}
              >
                {cell.name}
              </span>
            )
          )}

          <div style={{ flex: 1 }} />

          {/* Action buttons — shown on hover */}
          {cellHovered && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              {/* Rename button (if no name yet) */}
              {!cell.name && !nameEditing && (
                <HeaderActionBtn
                  title="Name this cell"
                  onClick={() => {
                    setNameDraft('');
                    setNameEditing(true);
                  }}
                  t={t}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
                  </svg>
                </HeaderActionBtn>
              )}

              {/* Run button */}
              {isExecutable && (
                <HeaderActionBtn title="Run cell (Shift+Enter)" onClick={handleRun} t={t} accent>
                  <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
                    <path d="M1.5 1.5l7 3.5-7 3.5V1.5Z" />
                  </svg>
                </HeaderActionBtn>
              )}

              {/* Move up */}
              <HeaderActionBtn title="Move up" onClick={handleMoveUp} t={t}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1-1.06 1.06L8.75 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z" />
                </svg>
              </HeaderActionBtn>

              {/* Move down */}
              <HeaderActionBtn title="Move down" onClick={handleMoveDown} t={t}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M12.53 8.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L2.97 9.28a.75.75 0 0 1 1.06-1.06l2.72 2.97V3.75a.75.75 0 0 1 1.5 0v7.44l2.72-2.97a.75.75 0 0 1 1.06 0Z" />
                </svg>
              </HeaderActionBtn>

              {/* Delete */}
              <HeaderActionBtn title="Delete cell" onClick={handleDelete} t={t} danger>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z" />
                </svg>
              </HeaderActionBtn>
            </div>
          )}
        </div>

        {/* Editor area */}
        {cell.type === 'markdown' ? (
          <MarkdownCellEditor
            value={cell.content}
            onChange={handleContentChange}
            themeMode={state.themeMode}
          />
        ) : (
          <SQLCellEditor
            value={cell.content}
            onChange={handleContentChange}
            onRun={handleRun}
            themeMode={state.themeMode}
            schema={editorSchema}
          />
        )}

        {/* Output area */}
        {hasOutput && (
          <div
            style={{
              borderTop: `1px solid ${t.cellBorder}`,
            }}
          >
            {/* Output meta bar */}
            <div
              style={{
                height: 28,
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px',
                gap: 10,
                borderBottom: cell.result && showOutput ? `1px solid ${t.cellBorder}` : 'none',
                background: `${t.tableHeaderBg}60`,
              }}
            >
              {cell.result && (
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: t.font,
                    color: t.textMuted,
                  }}
                >
                  {(cell.result.rowCount ?? cell.result.rows.length).toLocaleString()} rows
                  {cell.result.executionTime !== undefined && (
                    <> · {cell.result.executionTime < 1000
                      ? `${cell.result.executionTime}ms`
                      : `${(cell.result.executionTime / 1000).toFixed(2)}s`}
                    </>
                  )}
                </span>
              )}
              {cell.error && (
                <span style={{ fontSize: 11, fontFamily: t.font, color: t.error }}>
                  Error
                </span>
              )}
              <div style={{ flex: 1 }} />

              {/* Chart / Table toggle (when result is chartable) */}
              {cell.result && canChart && showOutput && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  {(['chart', 'table'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setViewMode(mode)}
                      style={{
                        padding: '1px 7px',
                        fontSize: 10,
                        fontFamily: t.font,
                        borderRadius: 3,
                        border: `1px solid ${viewMode === mode ? t.accent : t.btnBorder}`,
                        background: viewMode === mode ? `${t.accent}20` : 'transparent',
                        color: viewMode === mode ? t.accent : t.textMuted,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        textTransform: 'capitalize',
                      }}
                    >
                      {mode === 'chart' ? 'Chart' : 'Table'}
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => setShowOutput((s) => !s)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: t.textMuted,
                  fontSize: 11,
                  fontFamily: t.font,
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="currentColor"
                  style={{ transform: showOutput ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
                >
                  <path d="M1 3l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" />
                </svg>
                {showOutput ? 'Hide' : 'Show'}
              </button>
            </div>

            {showOutput && (
              <>
                {cell.error && (
                  <ErrorOutput
                    message={cell.error}
                    themeMode={state.themeMode}
                    onFix={isExecutable ? handleFixAndRun : undefined}
                    schemaTables={state.schemaTables}
                  />
                )}
                {cell.result && !cell.error && (
                  viewMode === 'chart' && canChart ? (
                    <ChartOutput result={cell.result} themeMode={state.themeMode} chartConfig={cell.chartConfig} />
                  ) : (
                    <TableOutput result={cell.result} themeMode={state.themeMode} />
                  )
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


function HeaderActionBtn({
  title,
  onClick,
  children,
  t,
  accent,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  t: Theme;
  accent?: boolean;
  danger?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 24,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hovered
          ? danger
            ? `${t.error}18`
            : accent
            ? `${t.accent}18`
            : t.btnHover
          : 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        color: hovered
          ? danger
            ? t.error
            : accent
            ? t.accent
            : t.textSecondary
          : t.textMuted,
        transition: 'all 0.15s',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}
