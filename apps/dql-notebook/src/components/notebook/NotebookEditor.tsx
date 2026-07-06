import type { Theme } from '../../themes/notebook-theme';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, History, Sparkles, X } from 'lucide-react';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api, type NotebookResearchRun } from '../../api/client';
import { WelcomeScreen } from './WelcomeScreen';
import { CellList } from './CellList';
import { DashboardView } from './DashboardView';
import { DocumentMetadataRow } from './DocumentMetadataRow';
import { useOpenBlockInStudio } from '../agent/AiBuildResult';
import { UnifiedAgentRunPanel, usePersistedAgentThreadId, type InsertDqlPayload } from '../agent/UnifiedAgentRunPanel';
import {
  emitNotebookResearchChanged,
} from '../../utils/notebook-research';
import type { Cell, NotebookFile } from '../../store/types';

interface NotebookEditorProps {
  onOpenFile: (file: NotebookFile) => void;
  registerCellRef: (id: string, el: HTMLDivElement | null) => void;
}

type AiHistoryBadge = {
  total: number;
  active: number;
  blocked: number;
};

const EMPTY_AI_HISTORY_BADGE: AiHistoryBadge = {
  total: 0,
  active: 0,
  blocked: 0,
};

export function NotebookEditor({ onOpenFile, registerCellRef }: NotebookEditorProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [aiOpen, setAiOpen] = useState(false);
  const [aiHistoryOpen, setAiHistoryOpen] = useState(false);
  const [aiSourceCellId, setAiSourceCellId] = useState<string | null>(null);
  const [aiInitialInput, setAiInitialInput] = useState('');
  const [aiAutoAsk, setAiAutoAsk] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [aiHistoryRefreshKey, setAiHistoryRefreshKey] = useState(0);
  const [aiHistoryBadge, setAiHistoryBadge] = useState<AiHistoryBadge>(EMPTY_AI_HISTORY_BADGE);
  const activeNotebookPath = state.activeFile?.path;

  const aiSourceCell = useMemo(
    () => state.cells.find((cell) => cell.id === aiSourceCellId) ?? null,
    [aiSourceCellId, state.cells],
  );
  const aiContext = useMemo(
    () => buildNotebookAiContext({
      notebookPath: activeNotebookPath,
      notebookTitle: state.notebookTitle,
      cell: aiSourceCell,
      cells: state.cells,
    }),
    [activeNotebookPath, aiSourceCell, state.cells, state.notebookTitle],
  );

  const openFileForAiHistory = useCallback((file: NotebookFile) => {
    setAiSourceCellId(null);
    setAiInitialInput('');
    setAiAutoAsk(undefined);
    setAiOpen(true);
    setAiHistoryOpen(true);
    onOpenFile(file);
  }, [onOpenFile]);

  useEffect(() => {
    if (!activeNotebookPath) {
      setAiHistoryBadge(EMPTY_AI_HISTORY_BADGE);
      return;
    }

    let cancelled = false;
    api.listNotebookResearch({ path: activeNotebookPath, limit: 1 })
      .then((page) => {
        if (cancelled) return;
        setAiHistoryBadge({
          total: page.counts.total,
          active: page.counts.needsReview + page.counts.errors + page.counts.draftReady + page.counts.certificationReady,
          blocked: page.counts.blocked,
        });
      })
      .catch(() => {
        if (!cancelled) setAiHistoryBadge(EMPTY_AI_HISTORY_BADGE);
      });

    return () => {
      cancelled = true;
    };
  }, [activeNotebookPath, aiHistoryOpen, aiHistoryRefreshKey, state.queryLog.length]);

  // The AddCellBar "AI" tile opens the governed Notebook AI drawer at its insertion
  // position (routed through the same DQL-first cascade as Ask AI), replacing the
  // old regex SQL-draft dialog. Decoupled via a window event (no prop threading
  // through CellList), mirroring the existing dql:semantic-used pattern.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ afterId?: string }>).detail;
      setAiSourceCellId(detail?.afterId ?? null);
      setAiInitialInput('');
      setAiAutoAsk(undefined);
      setAiHistoryOpen(false);
      setAiOpen(true);
    };
    window.addEventListener('dql:open-notebook-ai', handler);
    return () => window.removeEventListener('dql:open-notebook-ai', handler);
  }, []);

  const openAiForCell = useCallback((cellId: string, prompt?: string, options?: { autoAsk?: boolean }) => {
    const text = prompt?.trim() ?? '';
    setAiSourceCellId(cellId);
    setAiInitialInput(options?.autoAsk ? '' : text);
    setAiAutoAsk(options?.autoAsk && text ? { text, nonce: Date.now() } : undefined);
    setAiHistoryOpen(false);
    setAiOpen(true);
  }, []);

  const insertAiSqlCell = useCallback((sql: string, title?: string) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    const cell = makeCell('sql', trimmed);
    cell.name = safeCellName(title ?? 'AI SQL draft');
    dispatch({ type: 'ADD_CELL', cell, afterId: aiSourceCellId ?? undefined });
    setAiSourceCellId(cell.id);
    setAiOpen(true);
  }, [aiSourceCellId, dispatch]);

  // DQL-first insertion (default): create a self-contained query cell seeded with
  // the governed answer's compiled SQL body + executed result + chart config, and
  // carry the DQL artifact as provenance (surfaced + save-as-block on the cell).
  const insertGeneratedDqlCell = useCallback((payload: InsertDqlPayload) => {
    const sql = (payload.sql ?? payload.dqlArtifact?.source ?? '').trim();
    if (!sql) return;
    const cell = makeCell('sql', sql);
    cell.name = safeCellName(payload.title ?? payload.dqlArtifact?.name ?? 'AI analysis');
    if (payload.result) {
      cell.result = payload.result;
      cell.status = 'success';
      cell.executionCount = 1;
    }
    if (payload.chartConfig) cell.chartConfig = payload.chartConfig;
    if (payload.dqlArtifact) {
      cell.dqlArtifact = {
        source: payload.dqlArtifact.source,
        sql: payload.sql,
        name: payload.dqlArtifact.name,
        sourcePath: payload.dqlArtifact.sourcePath,
        kind: payload.dqlArtifact.kind,
        metrics: payload.dqlArtifact.metrics,
        dimensions: payload.dqlArtifact.dimensions,
      };
    }
    dispatch({ type: 'ADD_CELL', cell, afterId: aiSourceCellId ?? undefined });
    setAiSourceCellId(cell.id);
    setAiOpen(true);
  }, [aiSourceCellId, dispatch]);

  const askFromHistory = useCallback((run: NotebookResearchRun) => {
    setAiSourceCellId(run.sourceCellId ?? null);
    setAiInitialInput(run.question);
    setAiAutoAsk(undefined);
    setAiHistoryOpen(false);
    setAiOpen(true);
  }, []);

  const openResearchFromAgentRun = useCallback(async (runId: string, notebookPath?: string) => {
    if (notebookPath && notebookPath !== activeNotebookPath) {
      const file = state.files.find((candidate) => candidate.path === notebookPath);
      if (file) onOpenFile(file);
    }
    try {
      const run = await api.getNotebookResearch(runId);
      setAiSourceCellId(run.sourceCellId ?? null);
      setAiInitialInput(run.question);
      emitNotebookResearchChanged({
        notebookPath: run.notebookPath,
        sourceCellId: run.sourceCellId,
        runId: run.id,
        reason: 'agent-run-open-research',
      });
    } catch {
      emitNotebookResearchChanged({
        notebookPath,
        runId,
        reason: 'agent-run-open-research',
      });
    }
    setAiAutoAsk(undefined);
    setAiHistoryRefreshKey(Date.now());
    setAiHistoryOpen(true);
    setAiOpen(true);
  }, [activeNotebookPath, onOpenFile, state.files]);

  if (!state.activeFile) {
    return <WelcomeScreen onOpenFile={onOpenFile} onOpenResearchFile={openFileForAiHistory} />;
  }

  // Dashboard / presentation mode
  if (state.dashboardMode) {
    return <DashboardView />;
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: t.appBg,
      }}
    >
      {/* Notebook toolbar */}
      <NotebookToolbar
        t={t}
        aiOpen={aiOpen}
        historyOpen={aiHistoryOpen}
        historyBadge={aiHistoryBadge}
        onToggleAi={() => {
          setAiSourceCellId(null);
          setAiInitialInput('');
          setAiAutoAsk(undefined);
          setAiOpen((open) => !open);
        }}
        onToggleHistory={() => {
          setAiOpen(true);
          setAiHistoryOpen((open) => !open);
        }}
      />

      <div
        style={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* Scrollable cell area */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
            padding: '0 0 40px',
          }}
        >
          <DocumentMetadataRow />
          <CellList
            registerCellRef={registerCellRef}
            researchRefreshKey={aiHistoryRefreshKey}
            onStartResearch={openAiForCell}
          />
        </div>
        {aiOpen && (
          <NotebookAiDrawer
            t={t}
            notebookPath={activeNotebookPath}
            sourceCell={aiSourceCell}
            upstreamContext={aiContext}
            initialInput={aiInitialInput}
            autoAsk={aiAutoAsk}
            historyOpen={aiHistoryOpen}
            historyRefreshKey={aiHistoryRefreshKey}
            onClose={() => setAiOpen(false)}
            onToggleHistory={() => setAiHistoryOpen((open) => !open)}
            onInsertSql={insertAiSqlCell}
            onInsertDql={insertGeneratedDqlCell}
            onAskFromHistory={askFromHistory}
            onOpenResearch={openResearchFromAgentRun}
          />
        )}
      </div>
    </div>
  );
}

function NotebookToolbar({
  t,
  aiOpen,
  historyOpen,
  historyBadge,
  onToggleAi,
  onToggleHistory,
}: {
  t: Theme;
  aiOpen: boolean;
  historyOpen: boolean;
  historyBadge: AiHistoryBadge;
  onToggleAi: () => void;
  onToggleHistory: () => void;
}) {
  const { state } = useNotebook();

  // Format last saved placeholder (we don't track real save times yet)
  const cellCount = state.cells.length;
  const historyTone = historyBadge.blocked > 0
    ? t.error
    : historyBadge.active > 0
      ? t.warning
      : t.accent;
  const historyTitle = historyBadge.total > 0
    ? [
        `${historyBadge.total} AI histor${historyBadge.total === 1 ? 'y item' : 'y items'}`,
        historyBadge.active > 0 ? `${historyBadge.active} open` : undefined,
        historyBadge.blocked > 0 ? `${historyBadge.blocked} blocked` : undefined,
      ].filter(Boolean).join(' · ')
    : 'Open notebook AI history';

  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 12,
      }}
    >
      {/* Breadcrumb */}
      <Breadcrumb t={t} />

      <div style={{ flex: 1 }} />

      <button
        type="button"
        title={aiOpen ? 'Hide notebook AI' : 'Ask AI about this notebook'}
        onClick={onToggleAi}
        style={{
          height: 26,
          border: `1px solid ${aiOpen ? t.accent : t.btnBorder}`,
          background: aiOpen ? `${t.accent}16` : t.btnBg,
          color: aiOpen ? t.accent : t.textSecondary,
          borderRadius: 6,
          padding: '0 9px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 700,
          fontFamily: t.font,
          cursor: 'pointer',
        }}
      >
        <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
        Notebook AI
      </button>

      <button
        type="button"
        title={historyTitle}
        onClick={onToggleHistory}
        style={{
          height: 26,
          border: `1px solid ${historyOpen ? historyTone : t.btnBorder}`,
          background: historyOpen ? `${historyTone}12` : t.btnBg,
          color: historyOpen ? historyTone : t.textSecondary,
          borderRadius: 6,
          padding: '0 9px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 700,
          fontFamily: t.font,
          cursor: 'pointer',
        }}
      >
        <History size={14} strokeWidth={2} aria-hidden="true" />
        History
        {historyBadge.total > 0 && (
          <span
            aria-label={historyTitle}
            style={{
              minWidth: 18,
              height: 18,
              borderRadius: 999,
              padding: '0 6px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: `1px solid ${historyTone}`,
              background: `${historyTone}14`,
              color: historyTone,
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1,
            }}
          >
            {historyBadge.total > 99 ? '99+' : historyBadge.total}
          </span>
        )}
      </button>

      {/* Meta info */}
      <span
        style={{
          fontSize: 11,
          color: t.textMuted,
          fontFamily: t.font,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span>
          {cellCount} {cellCount === 1 ? 'cell' : 'cells'}
        </span>
        {state.notebookDirty && (
          <span style={{ color: t.warning }}>● unsaved</span>
        )}
      </span>
    </div>
  );
}

function NotebookAiDrawer({
  t,
  notebookPath,
  sourceCell,
  upstreamContext,
  initialInput,
  autoAsk,
  historyOpen,
  historyRefreshKey,
  onClose,
  onToggleHistory,
  onInsertSql,
  onInsertDql,
  onAskFromHistory,
  onOpenResearch,
}: {
  t: Theme;
  notebookPath?: string;
  sourceCell: Cell | null;
  upstreamContext?: string;
  initialInput: string;
  autoAsk?: { text: string; nonce: number };
  historyOpen: boolean;
  historyRefreshKey: number;
  onClose: () => void;
  onToggleHistory: () => void;
  onInsertSql: (sql: string, title?: string) => void;
  onInsertDql: (payload: InsertDqlPayload) => void;
  onAskFromHistory: (run: NotebookResearchRun) => void;
  onOpenResearch: (id: string, notebookPath?: string) => void | Promise<void>;
}) {
  const { state } = useNotebook();
  const openBlockInStudio = useOpenBlockInStudio();
  // Server-persisted conversation thread, keyed per notebook so a page refresh
  // resumes the same conversation.
  const agentThread = usePersistedAgentThreadId(`notebook:${notebookPath ?? 'notebook'}`);
  const sourceTitle = sourceCell
    ? `${sourceCell.type.toUpperCase()} cell${sourceCell.name ? ` · ${sourceCell.name}` : ''}`
    : 'Whole notebook';
  const scopeHint = sourceCell
    ? 'This cell + dbt, semantic metadata, certified blocks, prior AI history'
    : 'Whole notebook + dbt, semantic metadata, certified blocks, prior AI history';
  const buildContext = sourceCell?.type === 'sql' && sourceCell.content.trim()
    ? { cellSql: sourceCell.content }
    : undefined;
  const agentRunSelectedObject = sourceCell
    ? { kind: 'cell' as const, id: sourceCell.id, title: sourceCell.name, path: notebookPath }
    : notebookPath
      ? { kind: 'notebook' as const, path: notebookPath, title: state.notebookTitle || 'Notebook' }
      : undefined;
  const agentRunWorkspaceContext = {
    ...(buildContext ?? {}),
    notebookPath,
    notebookTitle: state.notebookTitle,
    sourceCellId: sourceCell?.id,
    sourceCellName: sourceCell?.name,
    sourceCellType: sourceCell?.type,
  };

  return (
    <aside
      style={{
        width: 440,
        maxWidth: '42vw',
        minWidth: 360,
        flex: '0 0 auto',
        borderLeft: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
      aria-label="Notebook AI"
    >
      <div
        style={{
          minHeight: 48,
          padding: '9px 12px',
          borderBottom: `1px solid ${t.headerBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: `${t.accent}14`,
            border: `1px solid ${t.accent}36`,
            color: t.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
          }}
        >
          <Sparkles size={16} strokeWidth={2.2} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 850, color: t.textPrimary, fontFamily: t.font }}>Notebook AI</div>
          <div
            title={sourceTitle}
            style={{
              fontSize: 11,
              color: t.textMuted,
              fontFamily: t.font,
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sourceTitle}
          </div>
        </div>
        <button type="button" onClick={onToggleHistory} title={historyOpen ? 'Hide AI history' : 'Show AI history'} style={drawerIconButtonStyle(t, historyOpen)}>
          <History size={14} />
        </button>
        <button type="button" onClick={onClose} title="Close AI" style={drawerIconButtonStyle(t, false)}>
          <X size={14} />
        </button>
      </div>

      {historyOpen && (
        <NotebookAiHistoryPanel
          t={t}
          notebookPath={notebookPath}
          sourceCellId={sourceCell?.id}
          refreshKey={historyRefreshKey}
          onAskFromHistory={onAskFromHistory}
        />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <UnifiedAgentRunPanel
          key={`auto:${notebookPath ?? 'notebook'}:${sourceCell?.id ?? 'all'}`}
          themeMode={state.themeMode}
          title="Notebook AI"
          scopeHint={scopeHint}
          notebookPath={notebookPath}
          selectedObject={agentRunSelectedObject}
          workspaceContext={agentRunWorkspaceContext}
          initialMode="auto"
          initialInput={autoAsk ? '' : initialInput}
          autoRun={autoAsk ? { text: autoAsk.text, mode: 'ask', nonce: autoAsk.nonce } : undefined}
          threadId={agentThread.threadId}
          onThreadIdChange={agentThread.onThreadIdChange}
          onInsertSql={onInsertSql}
          onInsertDql={onInsertDql}
          onOpenBlock={(path, name) => { void openBlockInStudio(path, name ?? path); }}
          onOpenResearch={(id, path) => { void onOpenResearch(id, path); }}
        />
      </div>
    </aside>
  );
}

function NotebookAiHistoryPanel({
  t,
  notebookPath,
  sourceCellId,
  refreshKey,
  onAskFromHistory,
}: {
  t: Theme;
  notebookPath?: string;
  sourceCellId?: string;
  refreshKey: number;
  onAskFromHistory: (run: NotebookResearchRun) => void;
}) {
  const [runs, setRuns] = useState<NotebookResearchRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!notebookPath) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listNotebookResearch({
      path: notebookPath,
      sourceCellId,
      sort: 'updated_desc',
      limit: 12,
    })
      .then((page) => {
        if (!cancelled) setRuns(page.runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookPath, refreshKey, sourceCellId]);

  return (
    <div
      style={{
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.appBg,
        maxHeight: 260,
        overflow: 'auto',
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Clock3 size={14} color={t.textMuted} />
        <div style={{ fontSize: 11, fontWeight: 850, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          AI history
        </div>
        <div style={{ flex: 1 }} />
        {loading && <span style={{ fontSize: 11, color: t.textMuted }}>Loading</span>}
      </div>
      {error && <div style={{ fontSize: 11, color: t.error, lineHeight: 1.4 }}>{error}</div>}
      {!loading && !error && runs.length === 0 && (
        <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
          No saved AI history for this {sourceCellId ? 'cell' : 'notebook'} yet.
        </div>
      )}
      <div style={{ display: 'grid', gap: 7 }}>
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => onAskFromHistory(run)}
            style={{
              border: `1px solid ${t.cellBorder}`,
              background: t.cellBg,
              color: t.textPrimary,
              borderRadius: 8,
              padding: '8px 9px',
              textAlign: 'left',
              cursor: 'pointer',
              display: 'grid',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {run.title || run.question}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: historyRunTone(run, t), fontWeight: 850 }}>
                {formatHistoryStatus(run)}
              </span>
            </div>
            <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {run.question}
            </div>
            <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
              {formatHistoryDate(run.updatedAt)}
              {run.generatedSql || run.reviewedSql ? ' · SQL saved' : ''}
              {run.dqlPromotionAction ? ` · ${run.dqlPromotionAction.split('_').join(' ')}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function buildNotebookAiContext(input: {
  notebookPath?: string;
  notebookTitle?: string;
  cell: Cell | null;
  cells: Cell[];
}): string {
  const lines: string[] = [];
  lines.push('Notebook AI contract:');
  lines.push([
    '- Use the same path for research, SQL generation, SQL repair, DQL reuse checks, and DQL draft planning.',
    '- Always check certified DQL blocks, draft blocks, dbt/semantic metadata, and runtime schema before proposing new SQL.',
    '- Return one clear outcome: Reuse certified block, Use existing draft, Review SQL preview, Fix SQL, Create DQL draft, Needs review, or Cannot answer yet.',
    '- For review-required DQL artifacts, prefer reusable parameterizable SQL preview logic over hard-coded literals when the business question implies a reusable block.',
    '- Keep DQL certification manual; do not claim SQL previews or drafts are certified.',
    '- Explain business purpose, grain, filters/parameters, technical lineage, duplicate/reuse evidence, preview status, and next action.',
  ].join('\n'));
  lines.push(`Notebook: ${input.notebookTitle || input.notebookPath || 'Untitled notebook'}`);
  if (input.notebookPath) lines.push(`Path: ${input.notebookPath}`);
  if (input.cell) {
    lines.push(`Selected cell: ${input.cell.type.toUpperCase()}${input.cell.name ? ` ${input.cell.name}` : ''}`);
    if (input.cell.error) lines.push(`Current error: ${input.cell.error}`);
    if (input.cell.result) {
      lines.push(`Result columns: ${input.cell.result.columns.join(', ')}`);
      lines.push(`Result rows: ${input.cell.result.rowCount ?? input.cell.result.rows.length}`);
    }
    lines.push('Selected cell content:');
    lines.push(input.cell.content);
  } else {
    const executableCells = input.cells
      .filter((cell) => cell.type === 'sql' || cell.type === 'dql')
      .slice(0, 8)
      .map((cell, index) => `${index + 1}. ${cell.type.toUpperCase()}${cell.name ? ` ${cell.name}` : ''}: ${compactText(cell.content, 600)}`);
    if (executableCells.length > 0) {
      lines.push('Notebook SQL/DQL cells:');
      lines.push(executableCells.join('\n'));
    }
  }
  return lines.join('\n\n');
}

function compactText(value: string | undefined, limit: number): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > limit ? `${clean.slice(0, Math.max(0, limit - 3))}...` : clean;
}

function safeCellName(value: string): string {
  const clean = value
    .replace(/[^a-zA-Z0-9_ -]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return clean || 'ai_sql_draft';
}

function formatHistoryDate(value?: string): string {
  if (!value) return 'Saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatHistoryStatus(run: NotebookResearchRun): string {
  if (run.status === 'error') return 'error';
  if (run.reviewStatus === 'certified') return 'certified';
  if (run.reviewStatus === 'draft_created') return 'draft';
  if (run.reviewStatus === 'completed') return 'done';
  return 'review';
}

function historyRunTone(run: NotebookResearchRun, t: Theme): string {
  if (run.status === 'error' || run.reviewChecklist?.blockers.length) return t.error;
  if (run.reviewStatus === 'certified' || run.reviewStatus === 'completed') return t.success;
  if (run.reviewStatus === 'draft_created') return t.accent;
  return t.warning;
}

function drawerIconButtonStyle(t: Theme, active: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: `1px solid ${active ? t.accent : t.btnBorder}`,
    background: active ? `${t.accent}16` : t.btnBg,
    color: active ? t.accent : t.textSecondary,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  };
}

function Breadcrumb({ t }: { t: Theme }) {
  const { state } = useNotebook();
  if (!state.activeFile) return null;

  const parts = state.activeFile.path.split('/').filter(Boolean);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        fontFamily: t.fontMono,
        color: t.textMuted,
        overflow: 'hidden',
      }}
    >
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span style={{ color: t.textMuted, opacity: 0.5 }}>/</span>
          )}
          <span
            style={{
              color: i === parts.length - 1 ? t.textSecondary : t.textMuted,
              fontWeight: i === parts.length - 1 ? 500 : 400,
              whiteSpace: 'nowrap' as const,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: i === parts.length - 1 ? 200 : 100,
            }}
          >
            {part}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
