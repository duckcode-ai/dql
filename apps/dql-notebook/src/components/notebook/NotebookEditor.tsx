import type { Theme } from '../../themes/notebook-theme';
import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { WelcomeScreen } from './WelcomeScreen';
import { CellList } from './CellList';
import { DashboardView } from './DashboardView';
import { DocumentMetadataRow } from './DocumentMetadataRow';
import { NotebookResearchPanel } from './NotebookResearchPanel';
import type { NotebookFile } from '../../store/types';

interface NotebookEditorProps {
  onOpenFile: (file: NotebookFile) => void;
  registerCellRef: (id: string, el: HTMLDivElement | null) => void;
}

type ResearchQueueBadge = {
  actionable: number;
  blocked: number;
  staleOpen: number;
  expiredOpen: number;
};

const EMPTY_RESEARCH_QUEUE_BADGE: ResearchQueueBadge = {
  actionable: 0,
  blocked: 0,
  staleOpen: 0,
  expiredOpen: 0,
};

export function NotebookEditor({ onOpenFile, registerCellRef }: NotebookEditorProps) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchSourceRequest, setResearchSourceRequest] = useState<{ cellId: string; requestId: number } | null>(null);
  const [researchOpenNextRequestId, setResearchOpenNextRequestId] = useState<number | undefined>(undefined);
  const [researchOwnerOpenRequest, setResearchOwnerOpenRequest] = useState<{ owner: string; requestId: number } | null>(null);
  const [researchRefreshKey, setResearchRefreshKey] = useState(0);
  const [researchQueue, setResearchQueue] = useState<ResearchQueueBadge>(EMPTY_RESEARCH_QUEUE_BADGE);
  const activeNotebookPath = state.activeFile?.path;
  const openFileForResearch = useCallback((file: NotebookFile, options?: { ownerFilter?: string }) => {
    setResearchSourceRequest(null);
    const requestId = Date.now();
    if (options?.ownerFilter) {
      setResearchOwnerOpenRequest({ owner: options.ownerFilter, requestId });
      setResearchOpenNextRequestId(undefined);
    } else {
      setResearchOwnerOpenRequest(null);
      setResearchOpenNextRequestId(requestId);
    }
    setResearchOpen(true);
    onOpenFile(file);
  }, [onOpenFile]);

  useEffect(() => {
    if (!activeNotebookPath) {
      setResearchQueue(EMPTY_RESEARCH_QUEUE_BADGE);
      return;
    }

    let cancelled = false;
    api.listNotebookResearch({ path: activeNotebookPath, activeOnly: true, limit: 1 })
      .then((page) => {
        if (cancelled) return;
        const next = page.counts.nextActions;
        setResearchQueue({
          actionable:
            next.fix_blockers
            + next.review_sql
            + next.review_context
            + next.run_preview
            + next.reuse_existing
            + next.create_dql_draft
            + next.open_certification
            + next.complete_review,
          blocked: page.counts.blocked,
          staleOpen: page.counts.staleOpen,
          expiredOpen: page.counts.expiredOpen,
        });
      })
      .catch(() => {
        if (!cancelled) setResearchQueue(EMPTY_RESEARCH_QUEUE_BADGE);
      });

    return () => {
      cancelled = true;
    };
  }, [activeNotebookPath, researchOpen, researchRefreshKey, state.queryLog.length]);

  if (!state.activeFile) {
    return <WelcomeScreen onOpenFile={onOpenFile} onOpenResearchFile={openFileForResearch} />;
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
        researchOpen={researchOpen}
        researchQueue={researchQueue}
        onToggleResearch={() => setResearchOpen((open) => !open)}
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
            researchRefreshKey={researchRefreshKey}
            onStartResearch={(cellId) => {
              setResearchSourceRequest({ cellId, requestId: Date.now() });
              setResearchOpenNextRequestId(undefined);
              setResearchOwnerOpenRequest(null);
              setResearchOpen(true);
            }}
          />
        </div>
        <NotebookResearchPanel
          open={researchOpen}
          onClose={() => setResearchOpen(false)}
          t={t}
          initialSourceCellId={researchSourceRequest?.cellId}
          initialRequestId={researchSourceRequest?.requestId}
          initialOpenNextRequestId={researchOpenNextRequestId}
          initialOwnerFilter={researchOwnerOpenRequest?.owner}
          initialOwnerRequestId={researchOwnerOpenRequest?.requestId}
          onOpenNotebookFile={onOpenFile}
          onResearchChanged={() => setResearchRefreshKey(Date.now())}
        />
      </div>
    </div>
  );
}

function NotebookToolbar({
  t,
  researchOpen,
  researchQueue,
  onToggleResearch,
}: {
  t: Theme;
  researchOpen: boolean;
  researchQueue: ResearchQueueBadge;
  onToggleResearch: () => void;
}) {
  const { state } = useNotebook();

  // Format last saved placeholder (we don't track real save times yet)
  const cellCount = state.cells.length;
  const researchQueueTone = researchQueue.blocked > 0 || researchQueue.expiredOpen > 0
    ? t.error
    : researchQueue.staleOpen > 0
      ? t.warning
      : t.accent;
  const researchQueueTitle = researchQueue.actionable > 0
    ? [
        `${researchQueue.actionable} research ${researchQueue.actionable === 1 ? 'item' : 'items'} waiting`,
        researchQueue.blocked > 0 ? `${researchQueue.blocked} blocked` : undefined,
        researchQueue.expiredOpen > 0 ? `${researchQueue.expiredOpen} open 30d+` : undefined,
        researchQueue.staleOpen > 0 ? `${researchQueue.staleOpen} stale` : undefined,
      ].filter(Boolean).join(' · ')
    : 'Open notebook research';

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
        title={researchQueueTitle}
        onClick={onToggleResearch}
        style={{
          height: 26,
          border: `1px solid ${researchOpen ? t.accent : t.btnBorder}`,
          background: researchOpen ? `${t.accent}16` : t.btnBg,
          color: researchOpen ? t.accent : t.textSecondary,
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
        Research
        {researchQueue.actionable > 0 && (
          <span
            aria-label={researchQueueTitle}
            style={{
              minWidth: 18,
              height: 18,
              borderRadius: 999,
              padding: '0 6px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: `1px solid ${researchQueueTone}`,
              background: `${researchQueueTone}14`,
              color: researchQueueTone,
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1,
            }}
          >
            {researchQueue.actionable > 99 ? '99+' : researchQueue.actionable}
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
