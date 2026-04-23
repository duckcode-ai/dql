import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { useQueryExecution } from '../../hooks/useQueryExecution';
import { SQLCellEditor, type SQLCellEditorHandle } from './SQLCellEditor';
import { MarkdownCellEditor } from './MarkdownCellEditor';
import { ParamCell } from './ParamCell';
import { PlaceholderCell } from './PlaceholderCell';
import { DataframeChip } from './DataframeChip';
import { ChartCell } from './ChartCell';
import { FilterCell } from './FilterCell';
import { SingleValueCell } from './SingleValueCell';
import { PivotCell } from './PivotCell';
import { TableCell } from './TableCell';
import { ChatCell } from './ChatCell';
import { SnippetPicker } from './SnippetPicker';
import { SaveAsBlockModal } from '../modals/SaveAsBlockModal';
import { deriveBlockSource } from '../../utils/derive-block-source';
import { TableOutput } from '../output/TableOutput';
import { ChartOutput, detectChartType, resolveChartType, renderChart, CHART_TYPE_OPTIONS } from '../output/ChartOutput';
import type { ChartType } from '../output/ChartOutput';
import { ErrorOutput } from '../output/ErrorOutput';
import { CellLineage } from './CellLineage';
import type { Cell, BlockBinding } from '../../store/types';
import { format as formatSQL } from 'sql-formatter';
import { api } from '../../api/client';
import { extractSqlFromText } from '../../utils/block-studio';

interface CellProps {
  cell: Cell;
  index: number;
}

function GutterWrap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 2 }}>
      <div style={{ width: 40, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const TYPE_LABELS: Record<string, string> = {
  sql: 'SQL',
  markdown: 'MD',
  dql: 'DQL',
  param: 'PARAM',
  chart: 'CHART',
  pivot: 'PIVOT',
  single_value: 'SINGLE VALUE',
  filter: 'FILTER',
  table: 'TABLE',
  map: 'MAP',
  writeback: 'WRITEBACK',
  python: 'PYTHON',
  chat: 'CHAT',
};

const TYPE_COLORS: Record<string, string> = {
  sql: '#388bfd',
  markdown: '#56d364',
  dql: '#e3b341',
  param: '#e3b341',
  chart: '#a371f7',
  pivot: '#a371f7',
  single_value: '#a371f7',
  filter: '#ff7b72',
  table: '#79c0ff',
  map: '#7ce38b',
  writeback: '#d2a8ff',
  python: '#3572a5',
  chat: '#f0883e',
};

interface PlaceholderMeta {
  title: string;
  subtitle: string;
  color: string;
  badge?: string;
}

const PLACEHOLDER_META: Partial<Record<string, PlaceholderMeta>> = {
  map: {
    title: 'Map',
    subtitle: 'Geospatial visualization — lat/lon points and choropleths from an upstream dataframe. Lands in v0.11 on the dql-compiler geo pipeline.',
    color: '#7ce38b',
    badge: 'v0.11',
  },
  writeback: {
    title: 'Writeback',
    subtitle: 'Governed output sink — writes a dataframe back to your warehouse with block tests gating the commit. Lands in v0.11.',
    color: '#d2a8ff',
    badge: 'v0.11',
  },
  python: {
    title: 'Python',
    subtitle: 'Python cell via Pyodide sidecar.',
    color: '#3572a5',
    badge: 'v0.11',
  },
};

const BOUND_ACCENT = '#56d364';
const FORKED_ACCENT = '#e3b341';

function getCellBorderColor(cell: Cell, t: Theme): string {
  if (cell.blockBinding) {
    return cell.blockBinding.state === 'forked' ? FORKED_ACCENT : BOUND_ACCENT;
  }
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
  let timeLabel = '';

  if (cell.status === 'running') {
    label = '[*]';
    color = t.cellBorderRunning;
  } else if (cell.status === 'error') {
    label = '[!]';
    color = t.error;
  } else if (cell.executionCount !== undefined) {
    label = `[${cell.executionCount}]`;
    color = t.textMuted;
    if (cell.result?.executionTime !== undefined) {
      const ms = cell.result.executionTime;
      timeLabel = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    }
  } else {
    label = '[ ]';
    color = t.textMuted;
  }

  return (
    <div
      style={{
        width: 40,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        flexShrink: 0,
        gap: 2,
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
        {cell.status === 'running' ? (
          <span style={{ display: 'inline-block', animation: 'spin 0.8s linear infinite' }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke={color} strokeWidth="1.5" strokeDasharray="14 7" />
            </svg>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </span>
        ) : label}
      </span>
      {timeLabel && (
        <span style={{ fontFamily: t.fontMono, fontSize: 8, color: t.textMuted, lineHeight: 1, userSelect: 'none' }}>
          {timeLabel}
        </span>
      )}
    </div>
  );
}

interface BlockFields {
  domain: string;
  owner: string;
  description: string;
  tags: string[];
  blockType: string;
}

function parseBlockFields(content: string): BlockFields | null {
  if (!/^\s*block\s+"/i.test(content.trim())) return null;
  const str = (key: string) =>
    content.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const tagsMatch = content.match(/\btags\s*=\s*\[([^\]]*)\]/i);
  const tags = tagsMatch
    ? (tagsMatch[1].match(/"([^"]*)"/g) ?? []).map((s: string) => s.slice(1, -1))
    : [];
  return {
    domain: str('domain'),
    owner: str('owner'),
    description: str('description'),
    blockType: str('type') || 'custom',
    tags,
  };
}

function setBlockStringField(content: string, key: string, value: string): string {
  const re = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
  return re.test(content) ? content.replace(re, `$1"${value.replace(/"/g, '\\"')}"`) : content;
}

function setBlockTags(content: string, tags: string[]): string {
  const tagStr = tags.map((t: string) => `"${t}"`).join(', ');
  const re = /(\btags\s*=\s*)\[[^\]]*\]/i;
  return re.test(content) ? content.replace(re, `$1[${tagStr}]`) : content;
}

function BlockBindingChip({
  binding,
  t,
  onRevert,
  onUnbind,
}: {
  binding: BlockBinding;
  t: Theme;
  onRevert: () => void | Promise<void>;
  onUnbind: () => void;
}) {
  const isForked = binding.state === 'forked';
  const accent = isForked ? FORKED_ACCENT : BOUND_ACCENT;
  const label = isForked ? 'FORKED' : 'BOUND';
  const helpText = isForked
    ? 'Local edits have diverged from the block file — Revert to discard, or Save as Block to promote as a new version.'
    : 'This cell mirrors the block file. Edit to fork locally.';
  return (
    <div
      title={helpText}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        borderBottom: `1px solid ${t.cellBorder}`,
        background: `${accent}10`,
        fontFamily: t.fontMono,
        fontSize: 11,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: accent,
          background: `${accent}24`,
          border: `1px solid ${accent}55`,
          borderRadius: 3,
          padding: '1px 5px',
        }}
      >
        {label}
      </span>
      <span style={{ color: t.textSecondary }}>{binding.path}</span>
      {binding.version && <span style={{ color: t.textMuted }}>· v{binding.version}</span>}
      {!isForked && (
        <span title="Bound cells track the block file — edits fork locally" style={{ color: t.textMuted }}>
          🔒
        </span>
      )}
      <div style={{ flex: 1 }} />
      {isForked && (
        <button
          onClick={onRevert}
          title="Discard local edits and restore the block file body"
          style={binderBtnStyle(t, accent)}
        >
          Revert
        </button>
      )}
      <button
        onClick={onUnbind}
        title="Detach this cell from the block file"
        style={binderBtnStyle(t, t.btnBorder)}
      >
        Unbind
      </button>
    </div>
  );
}

function binderBtnStyle(t: Theme, border: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 4,
    color: t.textSecondary,
    fontSize: 10,
    fontFamily: t.font,
    fontWeight: 600,
    letterSpacing: '0.04em',
    padding: '1px 7px',
    cursor: 'pointer',
  };
}

function BlockGovernanceBar({
  content,
  onChange,
  t,
}: {
  content: string;
  onChange: (next: string) => void;
  t: Theme;
}) {
  const fields = parseBlockFields(content);
  if (!fields) return null;

  const fieldStyle = {
    background: t.editorBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 3,
    color: t.textSecondary,
    fontSize: 11,
    fontFamily: t.fontMono,
    padding: '2px 6px',
    outline: 'none',
  };

  const labelStyle = {
    fontSize: 9,
    fontWeight: 700,
    color: t.textMuted,
    fontFamily: t.font,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    marginRight: 4,
    flexShrink: 0,
  };

  const groupStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap' as const,
        gap: '4px 12px',
        padding: '5px 10px',
        borderBottom: `1px solid ${t.cellBorder}`,
        background: `${t.tableHeaderBg}40`,
      }}
    >
      <div style={groupStyle}>
        <span style={labelStyle}>domain</span>
        <input
          style={{ ...fieldStyle, width: 80 }}
          value={fields.domain}
          placeholder="e.g. finance"
          onChange={e => onChange(setBlockStringField(content, 'domain', e.target.value))}
        />
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>owner</span>
        <input
          style={{ ...fieldStyle, width: 90 }}
          value={fields.owner}
          placeholder="e.g. data-team"
          onChange={e => onChange(setBlockStringField(content, 'owner', e.target.value))}
        />
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>tags</span>
        <input
          style={{ ...fieldStyle, width: 110 }}
          value={fields.tags.join(', ')}
          placeholder="revenue, kpi"
          onChange={e => {
            const tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            onChange(setBlockTags(content, tags));
          }}
        />
      </div>
      <div style={{ ...groupStyle, flex: 1 }}>
        <span style={labelStyle}>description</span>
        <input
          style={{ ...fieldStyle, flex: 1, minWidth: 120 }}
          value={fields.description}
          placeholder="What this block measures"
          onChange={e => onChange(setBlockStringField(content, 'description', e.target.value))}
        />
      </div>
    </div>
  );
}

export function CellComponent({ cell, index }: CellProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const { executeCell, executeDependents, cancelCell } = useQueryExecution();

  const [cellHovered, setCellHovered] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(cell.name ?? '');
  const [showOutput, setShowOutput] = useState(true);
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('table');
  const [selectedChartType, setSelectedChartType] = useState<ChartType | null>(null);
  const [chartDropdownOpen, setChartDropdownOpen] = useState(false);
  const [chartConfigOpen, setChartConfigOpen] = useState(false);
  const [saveAsBlockOpen, setSaveAsBlockOpen] = useState(false);

  const derivedBlock = useMemo(
    () => (saveAsBlockOpen ? deriveBlockSource(cell, state.cells) : null),
    [saveAsBlockOpen, cell, state.cells]
  );
  const canSaveAsBlock =
    cell.type === 'sql' || cell.type === 'dql' || cell.type === 'chart'
    || cell.type === 'pivot' || cell.type === 'single_value'
    || cell.type === 'filter' || cell.type === 'table';

  const borderColor = getCellBorderColor(cell, t);
  const isExecutable = cell.type !== 'markdown' && cell.type !== 'param';

  // Editor ref for imperative undo/reset
  const editorRef = useRef<SQLCellEditorHandle | null>(null);
  // Track the last-saved content for "Reset to saved" functionality
  const savedContentRef = useRef<string>(cell.content);
  const [isDirty, setIsDirty] = useState(false);

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

  useEffect(() => {
    if (cell.status === 'success' && cell.result) {
      const chartType = resolveChartType(cell.result, cell.chartConfig);
      setSelectedChartType(chartType !== 'table' ? chartType : null);
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
      const updates: Partial<Cell> = { content };
      const binding = cell.blockBinding;
      if (binding?.originalContent !== undefined) {
        const diverged = content.trim() !== binding.originalContent.trim();
        const nextState = diverged ? 'forked' : 'bound';
        if (nextState !== binding.state) {
          updates.blockBinding = { ...binding, state: nextState };
        }
      }
      dispatch({ type: 'UPDATE_CELL', id: cell.id, updates });
      setIsDirty(content !== savedContentRef.current);
    },
    [cell.id, cell.blockBinding, dispatch]
  );

  const handleReset = useCallback(() => {
    const original = savedContentRef.current;
    dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { content: original } });
    editorRef.current?.resetTo(original);
    setIsDirty(false);
  }, [cell.id, dispatch]);

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
    setTimeout(() => executeCell(cell.id), 80);
  }, [handleFormat, executeCell, cell.id]);

  const onCellUpdate = useCallback(
    (updates: Partial<Cell>) => dispatch({ type: 'UPDATE_CELL', id: cell.id, updates }),
    [dispatch, cell.id]
  );

  if (cell.type === 'param') {
    return (
      <GutterWrap>
        <ParamCell cell={cell} themeMode={state.themeMode} onApplyParam={executeDependents} />
      </GutterWrap>
    );
  }
  if (cell.type === 'pivot') {
    return (
      <GutterWrap>
        <PivotCell cell={cell} cells={state.cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </GutterWrap>
    );
  }
  if (cell.type === 'single_value') {
    return (
      <GutterWrap>
        <SingleValueCell cell={cell} cells={state.cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </GutterWrap>
    );
  }
  if (cell.type === 'filter') {
    return (
      <GutterWrap>
        <FilterCell cell={cell} cells={state.cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </GutterWrap>
    );
  }
  if (cell.type === 'chart') {
    return (
      <GutterWrap>
        <ChartCell cell={cell} cells={state.cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </GutterWrap>
    );
  }
  if (cell.type === 'table') {
    return (
      <GutterWrap>
        <TableCell cell={cell} cells={state.cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </GutterWrap>
    );
  }
  if (cell.type === 'chat') {
    return (
      <GutterWrap>
        <ChatCell cell={cell} cells={state.cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </GutterWrap>
    );
  }

  const placeholder = PLACEHOLDER_META[cell.type];
  if (placeholder) {
    return (
      <GutterWrap>
        <PlaceholderCell
          cell={cell}
          themeMode={state.themeMode}
          title={placeholder.title}
          subtitle={placeholder.subtitle}
          color={placeholder.color}
          badge={placeholder.badge}
        />
      </GutterWrap>
    );
  }

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
      {saveAsBlockOpen && derivedBlock && (
        <SaveAsBlockModal
          cell={cell}
          initialContent={derivedBlock.derivedFromUpstream ? derivedBlock.content : undefined}
          initialName={derivedBlock.suggestedName}
          initialDescription={derivedBlock.suggestedDescription}
          onClose={() => setSaveAsBlockOpen(false)}
          onSaved={({ path, name }) => {
            dispatch({
              type: 'FILE_ADDED',
              file: {
                name,
                path,
                type: 'block',
                folder: 'blocks',
              },
            });
          }}
        />
      )}
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
            title={cell.type === 'dql' ? 'DQL cell — write a governed block (type, owner, description, tests) or use @metric()/@dim() refs' : cell.type === 'sql' ? 'SQL cell — write raw SQL, reference other cells with {{name}}' : undefined}
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

              {/* Reset button — shown when cell content has unsaved changes */}
              {isDirty && (cell.type === 'sql' || cell.type === 'dql') && (
                <button
                  title="Reset to last saved version (discard changes)"
                  onClick={handleReset}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${t.btnBorder}`,
                    borderRadius: 4,
                    color: '#f85149',
                    fontSize: 10,
                    fontFamily: t.font,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    padding: '1px 7px',
                    cursor: 'pointer',
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#f85149';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = t.btnBorder;
                  }}
                >
                  ↺ Reset
                </button>
              )}

              {cellHovered && canSaveAsBlock && (
                <button
                  title="Save this cell as a reusable block"
                  onClick={() => setSaveAsBlockOpen(true)}
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
                  Save as Block
                </button>
              )}

          {(cell.type === 'sql' || cell.type === 'dql') && (
            <DataframeChip
              cells={state.cells}
              index={index}
              content={cell.content}
              themeMode={state.themeMode}
              onInsertHandle={(name) => {
                const token = `{{${name}}}`;
                const current = cell.content ?? '';
                if (current.includes(token)) return;
                const next = current.trim().length === 0
                  ? `SELECT * FROM ${token}`
                  : `${current.replace(/\s*$/, '')} ${token}`;
                handleContentChange(next);
              }}
            />
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

              {/* Run / Cancel button */}
              {isExecutable && cell.status === 'running' ? (
                <HeaderActionBtn title="Cancel execution" onClick={() => cancelCell(cell.id)} t={t} danger>
                  <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
                    <rect x="2" y="2" width="6" height="6" rx="1" />
                  </svg>
                </HeaderActionBtn>
              ) : isExecutable ? (
                <HeaderActionBtn title="Run cell (Shift+Enter)" onClick={handleRun} t={t} accent>
                  <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
                    <path d="M1.5 1.5l7 3.5-7 3.5V1.5Z" />
                  </svg>
                </HeaderActionBtn>
              ) : null}

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

        {/* Governance bar — shown for DQL cells that contain a block declaration */}
        {cell.type === 'dql' && (
          <BlockGovernanceBar
            content={cell.content}
            onChange={handleContentChange}
            t={t}
          />
        )}

        {cell.blockBinding && (
          <BlockBindingChip
            binding={cell.blockBinding}
            t={t}
            onRevert={async () => {
              const binding = cell.blockBinding;
              if (!binding) return;
              try {
                const payload = await api.openBlockStudio(binding.path);
                const sqlBody = extractSqlFromText(payload.source) ?? payload.source;
                dispatch({
                  type: 'UPDATE_CELL',
                  id: cell.id,
                  updates: {
                    content: sqlBody,
                    blockBinding: { ...binding, state: 'bound', originalContent: sqlBody },
                  },
                });
                editorRef.current?.resetTo(sqlBody);
              } catch (error) {
                console.error('Failed to revert bound cell', error);
              }
            }}
            onUnbind={() => {
              dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { blockBinding: undefined } });
            }}
          />
        )}

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
            errorMessage={cell.status === 'error' ? cell.error : undefined}
            editorRef={editorRef}
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
              {cell.fromSnapshot && cell.result && (
                <span
                  title="Result loaded from the last saved run; re-run to refresh."
                  style={{
                    fontSize: 10,
                    fontFamily: t.font,
                    color: t.textMuted,
                    border: `1px solid ${t.btnBorder}`,
                    borderRadius: 3,
                    padding: '0 6px',
                    lineHeight: '16px',
                  }}
                >
                  cached
                </span>
              )}
              {cell.error && (
                <span style={{ fontSize: 11, fontFamily: t.font, color: t.error }}>
                  Error
                </span>
              )}
              <div style={{ flex: 1 }} />

              {/* Chart type selector + Table toggle */}
              {cell.result && showOutput && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, position: 'relative' }}>
                  {/* Table button */}
                  <button
                    onClick={() => { setViewMode('table'); setChartDropdownOpen(false); }}
                    style={{
                      padding: '1px 7px', fontSize: 10, fontFamily: t.font, borderRadius: 3,
                      border: `1px solid ${viewMode === 'table' ? t.accent : t.btnBorder}`,
                      background: viewMode === 'table' ? `${t.accent}20` : 'transparent',
                      color: viewMode === 'table' ? t.accent : t.textMuted,
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    Table
                  </button>
                  {/* Chart type dropdown trigger */}
                  <div style={{ position: 'relative' }}>
                    <button
                      onClick={() => {
                        if (viewMode === 'chart' && chartDropdownOpen) {
                          setChartDropdownOpen(false);
                        } else {
                          setViewMode('chart');
                          setChartDropdownOpen((p) => !p);
                        }
                      }}
                      style={{
                        padding: '1px 7px', fontSize: 10, fontFamily: t.font, borderRadius: 3,
                        border: `1px solid ${viewMode === 'chart' ? t.accent : t.btnBorder}`,
                        background: viewMode === 'chart' ? `${t.accent}20` : 'transparent',
                        color: viewMode === 'chart' ? t.accent : t.textMuted,
                        cursor: 'pointer', transition: 'all 0.15s',
                        display: 'flex', alignItems: 'center', gap: 3,
                      }}
                    >
                      {selectedChartType ? CHART_TYPE_OPTIONS.find((o) => o.value === selectedChartType)?.label ?? 'Chart' : 'Chart'}
                      <svg width="6" height="6" viewBox="0 0 8 8" fill="currentColor">
                        <path d="M1 2.5l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </button>
                    {chartDropdownOpen && (
                      <ChartTypeDropdown
                        selected={selectedChartType}
                        onSelect={(ct) => {
                          setSelectedChartType(ct);
                          setViewMode('chart');
                          setChartDropdownOpen(false);
                        }}
                        onClose={() => setChartDropdownOpen(false)}
                        t={t}
                      />
                    )}
                  </div>
                  {/* Config gear */}
                  {viewMode === 'chart' && (
                    <button
                      onClick={() => setChartConfigOpen((p) => !p)}
                      title="Chart configuration"
                      style={{
                        padding: '1px 5px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                        border: `1px solid ${chartConfigOpen ? t.accent : t.btnBorder}`,
                        background: chartConfigOpen ? `${t.accent}20` : 'transparent',
                        color: chartConfigOpen ? t.accent : t.textMuted,
                        transition: 'all 0.15s', display: 'flex', alignItems: 'center',
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.386.506.798.704 1.23.315.698.043 1.44-.476 1.89l-.815.806a.338.338 0 0 0-.079.262c.02.267.02.538 0 .805a.338.338 0 0 0 .079.262l.815.806c.52.45.79 1.192.476 1.89a7.22 7.22 0 0 1-.704 1.23c-.428.609-1.176.806-1.82.63l-1.103-.303c-.066-.019-.176-.011-.299.071a5.09 5.09 0 0 1-.668.386c-.133.066-.194.158-.212.224l-.288 1.107c-.169.645-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.29-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.09 5.09 0 0 1-.668-.387c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a7.12 7.12 0 0 1-.704-1.23c-.315-.698-.043-1.44.476-1.89l.815-.806a.338.338 0 0 0 .079-.262 6.08 6.08 0 0 1 0-.805.338.338 0 0 0-.079-.262l-.815-.806c-.52-.45-.79-1.192-.476-1.89a7.22 7.22 0 0 1 .704-1.23c.428-.609 1.176-.806 1.82-.63l1.103.303c.066.019.176.011.299-.071.214-.143.437-.272.668-.386.133-.066.194-.158.212-.224L6.54 1.29C6.71.645 7.256.095 7.999.031 8.236.01 8.474 0 8.713 0H8ZM8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
                      </svg>
                    </button>
                  )}
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
                  viewMode === 'chart' && selectedChartType ? (
                    <>
                      {renderChart(selectedChartType, cell.result, state.themeMode, cell.chartConfig)}
                      {chartConfigOpen && (
                        <ChartConfigPanel
                          columns={cell.result.columns}
                          chartConfig={cell.chartConfig}
                          onChange={(cfg) => dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { chartConfig: { ...cell.chartConfig, ...cfg } } })}
                          t={t}
                        />
                      )}
                    </>
                  ) : (
                    <TableOutput result={cell.result} themeMode={state.themeMode} />
                  )
                )}
              </>
            )}
          </div>
        )}

        {/* Inline lineage panel for SQL/DQL cells */}
        {isExecutable && (
          <CellLineage
            cellContent={cell.content}
            cellType={cell.type as 'sql' | 'dql'}
            cellName={cell.name}
            themeMode={state.themeMode}
            t={t}
            onFocusNode={(nodeId) => {
              dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
              if (!state.lineageFullscreen) dispatch({ type: 'TOGGLE_LINEAGE_FULLSCREEN' });
            }}
          />
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

function ChartTypeDropdown({
  selected,
  onSelect,
  onClose,
  t,
}: {
  selected: ChartType | null;
  onSelect: (ct: ChartType) => void;
  onClose: () => void;
  t: Theme;
}) {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Close on outside click after a small delay
      setTimeout(() => onClose(), 0);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 24,
        right: 0,
        zIndex: 200,
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: 4,
        minWidth: 130,
        maxHeight: 280,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      {CHART_TYPE_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onSelect(value)}
          onMouseEnter={() => setHoveredItem(value)}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            background: selected === value ? `${t.accent}20` : hoveredItem === value ? t.btnHover : 'transparent',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            color: selected === value ? t.accent : t.textSecondary,
            fontSize: 11,
            fontFamily: t.font,
            fontWeight: selected === value ? 600 : 400,
            padding: '4px 10px',
            textAlign: 'left' as const,
            transition: 'background 0.1s',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ChartConfigPanel({
  columns,
  chartConfig,
  onChange,
  t,
}: {
  columns: string[];
  chartConfig?: import('../../store/types').CellChartConfig;
  onChange: (cfg: Partial<import('../../store/types').CellChartConfig>) => void;
  t: Theme;
}) {
  const selectStyle = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.fontMono,
    padding: '3px 6px',
    outline: 'none',
    minWidth: 100,
    flex: 1,
  };

  const labelStyle = {
    fontSize: 9,
    fontWeight: 700 as const,
    color: t.textMuted,
    fontFamily: t.font,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    minWidth: 40,
    flexShrink: 0,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 16px',
        padding: '8px 12px',
        borderTop: `1px solid ${t.cellBorder}`,
        background: `${t.tableHeaderBg}40`,
      }}
    >
      {/* X axis */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>X axis</span>
        <select style={selectStyle} value={chartConfig?.x ?? ''} onChange={(e) => onChange({ x: e.target.value || undefined })}>
          <option value="">Auto</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {/* Y axis */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>Y axis</span>
        <select style={selectStyle} value={chartConfig?.y ?? ''} onChange={(e) => onChange({ y: e.target.value || undefined })}>
          <option value="">Auto</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {/* Color */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>Color</span>
        <select style={selectStyle} value={chartConfig?.color ?? ''} onChange={(e) => onChange({ color: e.target.value || undefined })}>
          <option value="">None</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 150 }}>
        <span style={labelStyle}>Title</span>
        <input
          style={{ ...selectStyle, fontFamily: t.font }}
          value={chartConfig?.title ?? ''}
          placeholder="Chart title"
          onChange={(e) => onChange({ title: e.target.value || undefined })}
        />
      </div>
    </div>
  );
}
