import React, { useCallback, useRef, useState, useEffect } from 'react';
import { CommandPalette } from '../palette/CommandPalette';
import { InspectorPanel } from './InspectorPanel';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { ActivityBar } from './ActivityBar';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { DevPanel } from './DevPanel';
import { HomePage } from '../home/HomePage';
import { AnalyticsHome } from '../home/AnalyticsHome';
import { GlobalAiRail } from '../agent/GlobalAiRail';
import { NotebookEditor } from '../notebook/NotebookEditor';
import { NewNotebookModal } from '../modals/NewNotebookModal';
import { NewBlockModal } from '../modals/NewBlockModal';
import { BlockStudio } from '../block-studio/BlockStudio';
import { BusinessArtifactView } from '../panels/BusinessArtifactView';
import { LineageDetailView } from '../panels/LineageDetailView';
import { LineageDAG } from '../panels/LineageDAG';
import { ConnectionPanel } from '../panels/ConnectionPanel';
import { ReferencePanel } from '../panels/ReferencePanel';
import { GitPage } from '../git/GitPage';
import { ReadinessPage } from '../readiness/ReadinessPage';
import { AgentLogPage } from '../agent/AgentLogPage';
import { GovernedContextPage } from '../domains/GovernedContextPage';
import { DbtFirstModelingPage } from '../modeling/DbtFirstModelingPage';
import { AppsView } from '../apps/AppsView';
import { LineageDrawer } from '../lineage/LineageDrawer';
import { AiBuildDialog } from '../agent/AiBuildDialog';
import { api } from '../../api/client';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { makeCell } from '../../store/NotebookStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useRunSnapshotAutosave } from '../../hooks/useRunSnapshotAutosave';
import type { NotebookFile } from '../../store/types';

export function AppShell() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const cellRefs = useRef<Record<string, HTMLDivElement>>({});
  const blockWorkspaceOpen = state.mainView === 'block_studio' || state.mainView === 'imports';

  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global keyboard shortcuts
  useKeyboardShortcuts();
  // Debounced autosave of cell results to <notebook>.run.json
  useRunSnapshotAutosave();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_INSPECTOR' });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [dispatch]);

  const handleOpenFile = useCallback(
    async (file: NotebookFile) => {
      try {
        if (file.type === 'term' || file.type === 'business_view') {
          if (state.sidebarPanel !== 'files') dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
          dispatch({ type: 'OPEN_BUSINESS_ARTIFACT', file });
          return;
        }
        if (file.type === 'block') {
          const payload = await api.openBlockStudio(file.path);
          dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
          return;
        }
        const { content } = await api.readNotebook(file.path);
        const { title, cells, metadata } = parseNotebookFile(file.path, content);

        const snap = file.path.endsWith('.dqlnb') ? await api.fetchRunSnapshot(file.path) : null;
        let hydrated = cells;
        if (snap?.found && snap.snapshot) {
          const byId = new Map(snap.snapshot.cells.map((e) => [e.cellId, e]));
          hydrated = cells.map((c) => {
            const entry = byId.get(c.id);
            if (!entry) return c;
            return {
              ...c,
              status: entry.status ?? c.status,
              result: entry.result ?? c.result,
              error: entry.error ?? c.error,
              executionCount: entry.executionCount ?? c.executionCount,
              fromSnapshot: entry.result != null,
            };
          });
        }

        dispatch({ type: 'OPEN_FILE', file, cells: hydrated, title, metadata });
        // Ensure files panel is visible
        if (state.sidebarPanel !== 'files') {
          dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
        }
      } catch (err) {
        console.error('Failed to open file:', err);
        if (file.type === 'block') {
          try {
            const { content } = await api.readNotebook(file.path);
            dispatch({
              type: 'OPEN_BLOCK_STUDIO',
              file,
              payload: {
                path: file.path,
                source: content,
                companionPath: null,
                metadata: {
                  name: file.name.replace(/\.dql$/i, ''),
                  path: file.path,
                  domain: file.path.split('/').slice(1, -1).join('/') || 'uncategorized',
                  description: '',
                  owner: '',
                  tags: [],
                },
                validation: {
                  valid: false,
                  diagnostics: [{ severity: 'warning', message: 'Opened block without studio metadata. Save once to normalize it.' }],
                  semanticRefs: { metrics: [], dimensions: [], segments: [] },
                },
              },
            });
            return;
          } catch (fallbackErr) {
            console.error('Failed to open block fallback:', fallbackErr);
          }
        } else {
          dispatch({
            type: 'OPEN_FILE',
            file,
            cells: [makeCell('sql')],
            title: file.name,
          });
        }
      }
    },
    [dispatch, state.sidebarPanel]
  );

  const handleNavigateToCell = useCallback((cellId: string) => {
    const el = cellRefs.current[cellId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const registerCellRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      cellRefs.current[id] = el;
    } else {
      delete cellRefs.current[id];
    }
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        background: t.appBg,
        fontFamily: t.font,
        color: t.textPrimary,
        overflow: 'hidden',
      }}
    >
      {/* Header spans full width */}
      <Header />

      {/* Body row: ActivityBar + Sidebar + Main.
          v1.3 Track 5 — ActivityBar + Sidebar hidden in App mode. */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {state.appMode === 'studio' && <ActivityBar />}

        {state.appMode === 'studio' && state.sidebarOpen && !blockWorkspaceOpen && (
          <Sidebar
            onOpenFile={handleOpenFile}
          />
        )}

        {/* Main content column */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          {state.mainView === 'home' ? (
            <HomePage />
          ) : state.mainView === 'ask' ? (
            <AnalyticsHome />
          ) : state.mainView === 'business_artifact' ? (
            <BusinessArtifactView />
          ) : state.mainView === 'lineage' ? (
            <LineageWorkspace />
          ) : state.mainView === 'lineage_detail' ? (
            <LineageDetailView />
          ) : state.mainView === 'connection' || state.mainView === 'settings' ? (
            <ConnectionWorkspace>
              <ConnectionPanel variant="page" />
            </ConnectionWorkspace>
          ) : state.mainView === 'reference' ? (
            <FullPageSection
              title="Quick Reference"
              description="Browse the complete DQL guide, semantic workflows, and authoring patterns in a documentation-style view."
            >
              <ReferencePanel themeMode={state.themeMode} />
            </FullPageSection>
          ) : state.mainView === 'git' ? (
            <GitPage />
          ) : state.mainView === 'readiness' ? (
            <ReadinessPage />
          ) : state.mainView === 'skills' ? (
            <GovernedContextPage initialTab="skills" />
          ) : state.mainView === 'domains' || state.mainView === 'modeling' ? (
            <DbtFirstModelingPage />
          ) : state.mainView === 'apps' ? (
            <AppsView />
          ) : state.mainView === 'agent_log' ? (
            <FullPageSection
              title="Agent steps"
              description="What the agent did to answer this question, and where the time went — route, tools, checks, and per-step timing."
            >
              <AgentLogPage />
            </FullPageSection>
          ) : (
            <>
              {state.mainView === 'imports' || state.mainView === 'block_studio' ? (
                <BlockStudio key="block-editor" />
              ) : (
                <>
                  <NotebookEditor
                    onOpenFile={handleOpenFile}
                    registerCellRef={registerCellRef}
                  />
                  {state.appMode === 'studio' && <DevPanel />}
                </>
              )}
            </>
          )}
        </div>

        {state.appMode === 'studio' && state.lineageDrawerOpen && !state.lineageFullscreen && !state.dashboardMode && (
          <LineageDrawer />
        )}

        {state.appMode === 'studio' && state.inspectorOpen && !state.lineageFullscreen && !state.lineageDrawerOpen && !state.dashboardMode && (
          <InspectorPanel />
        )}

        {/* App copilot rail — only on the Apps surface (tile follow-up). Analyst
            surfaces (Notebook, Block Studio) have their own AI; Ask is its own chat.
            Scoping here avoids a redundant second AI on those pages. */}
        {state.globalAi.open && state.mainView === 'apps' && <GlobalAiRail />}

      </div>

      {/* Modals */}
      {state.newNotebookModalOpen && <NewNotebookModal onFileOpened={handleOpenFile} />}
      {state.newBlockModalOpen && <NewBlockModal onFileOpened={handleOpenFile} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* Spec 14 — shared AI Build surface for the non-notebook front doors. */}
      <AiBuildDialog />
    </div>
  );
}

function ConnectionWorkspace({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
      {children}
    </div>
  );
}

function LineageWorkspace() {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <LineageDAG />
    </div>
  );
}

function FullPageSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ padding: '18px 24px 12px', borderBottom: '1px solid rgba(127, 127, 127, 0.16)' }}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6, maxWidth: 760, lineHeight: 1.5 }}>
          {description}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
