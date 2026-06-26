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
import { NotebookEditor } from '../notebook/NotebookEditor';
import { NewNotebookModal } from '../modals/NewNotebookModal';
import { NewBlockModal } from '../modals/NewBlockModal';
import { BlockStudio } from '../block-studio/BlockStudio';
import { BusinessArtifactView } from '../panels/BusinessArtifactView';
import { LineageDetailView } from '../panels/LineageDetailView';
import { ConnectionPanel } from '../panels/ConnectionPanel';
import { ReferencePanel } from '../panels/ReferencePanel';
import { GitPage } from '../git/GitPage';
import { AppsView } from '../apps/AppsView';
import { LineageDrawer } from '../lineage/LineageDrawer';
import { api } from '../../api/client';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { makeCell } from '../../store/NotebookStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useRunSnapshotAutosave } from '../../hooks/useRunSnapshotAutosave';
import type { NotebookFile } from '../../store/types';
import { LineageNodeIcon } from '@duckcodeailabs/dql-ui/icons';
import type { CloudContextTab } from '../../cloud/cloud-mode';
import {
  getDqlCloudRoute,
  isDqlCloudBuildMode,
  isDqlCloudMode,
  type DqlCloudRoute,
} from '../../cloud/cloud-mode';
import { CloudWorkbenchToolbar } from '../cloud/CloudWorkbenchToolbar';
import { CloudContextDrawer } from '../cloud/CloudContextDrawer';
import { CloudFocusHeader } from '../cloud/CloudFocusHeader';
import { CloudBlockViewer } from '../cloud/CloudBlockViewer';
import { CloudObjectDetail } from '../cloud/CloudObjectDetail';
import { LineageDAG } from '../panels/LineageDAG';

export function AppShell() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const cellRefs = useRef<Record<string, HTMLDivElement>>({});
  const blockWorkspaceOpen = state.mainView === 'block_studio' || state.mainView === 'imports';
  const openedCloudNotebookRef = useRef<string | null>(null);
  const cloudMode = isDqlCloudMode();
  const [cloudRoute, setCloudRoute] = useState<DqlCloudRoute>(() => getDqlCloudRoute());
  const cloudBuildMode =
    isDqlCloudBuildMode() && (cloudRoute.kind === 'workbench' || cloudRoute.kind === 'notebook');

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cloudContextOpen, setCloudContextOpen] = useState(false);
  const [cloudContextTab, setCloudContextTab] = useState<CloudContextTab>('semantic');

  // Global keyboard shortcuts
  useKeyboardShortcuts();
  // Debounced autosave of cell results to <notebook>.run.json
  useRunSnapshotAutosave();

  useEffect(() => {
    if (!cloudMode) return;
    const updateRoute = () => setCloudRoute(getDqlCloudRoute());
    updateRoute();
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, [cloudMode]);

  useEffect(() => {
    if (!cloudMode || cloudRoute.kind !== 'lineage') return;
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId: cloudRoute.focus ?? cloudRoute.focusKey ?? null });
  }, [cloudMode, cloudRoute, dispatch]);

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

  useEffect(() => {
    if (!cloudBuildMode) return;
    if (state.mainView !== 'notebook') dispatch({ type: 'SET_MAIN_VIEW', view: 'notebook' });
    if (state.sidebarPanel !== 'files') dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
    if (!state.sidebarOpen) dispatch({ type: 'TOGGLE_SIDEBAR' });
    if (state.devPanelOpen) dispatch({ type: 'TOGGLE_DEV_PANEL' });
  }, [cloudBuildMode, dispatch, state.devPanelOpen, state.mainView, state.sidebarOpen, state.sidebarPanel]);

  useEffect(() => {
    if (!cloudBuildMode) return;
    if (state.schemaTables.length === 0 && !state.schemaLoading) {
      dispatch({ type: 'SET_SCHEMA_LOADING', loading: true });
      void api.getSchema()
        .then((tables) => dispatch({ type: 'SET_SCHEMA', tables }))
        .catch((error) => console.warn('Cloud schema preload failed:', error))
        .finally(() => dispatch({ type: 'SET_SCHEMA_LOADING', loading: false }));
    }
    if (!state.semanticLayer.available && !state.semanticLayer.loading) {
      dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
      void api.getSemanticLayer()
        .then((layer) => dispatch({ type: 'SET_SEMANTIC_LAYER', layer }))
        .catch((error) => console.warn('Cloud semantic preload failed:', error))
        .finally(() => dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false }));
    }
  }, [
    cloudBuildMode,
    dispatch,
    state.schemaLoading,
    state.schemaTables.length,
    state.semanticLayer.available,
    state.semanticLayer.loading,
  ]);

  const openCloudContext = useCallback((tab: CloudContextTab) => {
    setCloudContextTab(tab);
    setCloudContextOpen(true);
  }, []);

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

  useEffect(() => {
    if (!cloudMode || cloudRoute.kind !== 'notebook' || !cloudRoute.path) return;
    if (openedCloudNotebookRef.current === cloudRoute.path) return;
    openedCloudNotebookRef.current = cloudRoute.path;
    const fallbackName = cloudRoute.path.split('/').pop() || 'Notebook';
    void handleOpenFile({
      name: cloudRoute.name || fallbackName,
      path: cloudRoute.path,
      type: 'notebook',
      folder: 'notebooks',
    });
  }, [cloudMode, cloudRoute, handleOpenFile]);

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
      {/* Header spans full width. Cloud Build uses a purpose-built workbench toolbar instead. */}
      {!cloudMode && <Header />}

      {/* Body row: ActivityBar + Sidebar + Main.
          v1.3 Track 5 — ActivityBar + Sidebar hidden in App mode. */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {state.appMode === 'studio' && !cloudMode && <ActivityBar />}

        {cloudBuildMode && (
          <Sidebar
            fixed
            onOpenFile={handleOpenFile}
          />
        )}

        {state.appMode === 'studio' && state.sidebarOpen && !blockWorkspaceOpen && !cloudMode && (
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
          {cloudMode && cloudRoute.kind === 'lineage' ? (
            <>
              <CloudFocusHeader
                title="Lineage"
                subtitle={cloudRoute.focus ? `Focused lineage for ${cloudRoute.focus}.` : 'Focused DQL lineage from the connected Cloud project.'}
                themeMode={state.themeMode}
              />
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <LineageDAG />
              </div>
            </>
          ) : cloudMode && cloudRoute.kind === 'block' ? (
            <CloudBlockViewer
              path={cloudRoute.path}
              name={cloudRoute.name}
              themeMode={state.themeMode}
            />
          ) : cloudMode && cloudRoute.kind === 'object' ? (
            <CloudObjectDetail
              objectType={cloudRoute.objectType}
              objectKey={cloudRoute.objectKey}
              label={cloudRoute.label}
            />
          ) : cloudMode && cloudRoute.kind === 'apps' ? (
            <AppsView />
          ) : cloudBuildMode ? (
            <>
              <CloudWorkbenchToolbar />
              <NotebookEditor
                onOpenFile={handleOpenFile}
                registerCellRef={registerCellRef}
              />
            </>
          ) : state.mainView === 'home' ? (
            <HomePage />
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
          ) : state.mainView === 'apps' ? (
            <AppsView />
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

        {cloudBuildMode && (
          <CloudContextDrawer
            open={cloudContextOpen}
            activeTab={cloudContextTab}
            onTabChange={setCloudContextTab}
            onClose={() => setCloudContextOpen(false)}
          />
        )}

        {state.appMode === 'studio' && !cloudMode && state.lineageDrawerOpen && !state.lineageFullscreen && !state.dashboardMode && (
          <LineageDrawer />
        )}

        {state.appMode === 'studio' && !cloudMode && state.inspectorOpen && !state.lineageFullscreen && !state.lineageDrawerOpen && !state.dashboardMode && (
          <InspectorPanel />
        )}

      </div>

      {/* Modals */}
      {state.newNotebookModalOpen && <NewNotebookModal onFileOpened={handleOpenFile} />}
      {state.newBlockModalOpen && <NewBlockModal onFileOpened={handleOpenFile} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function ConnectionWorkspace({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: '22px 28px 32px',
        }}
      >
        <div
          style={{
            marginBottom: 16,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 18,
          }}
        >
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>Connections</div>
            <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6, maxWidth: 660, lineHeight: 1.5 }}>
              Manage database connections, model providers, MCP servers, OpenAI connectors, and runtime checks from one place before building blocks or asking AI.
            </div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function LineageWorkspace() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: t.appBg,
        padding: 28,
      }}
    >
      <div
        style={{
          width: 'min(520px, 100%)',
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 8,
          background: t.cellBg,
          padding: 22,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 7,
            background: `${t.accent}18`,
            color: t.accent,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <LineageNodeIcon size={18} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: t.textPrimary, fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
            Select a lineage item
          </div>
          <div style={{ color: t.textMuted, fontSize: 12, lineHeight: 1.55 }}>
            Focused upstream and downstream context opens here.
          </div>
        </div>
      </div>
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
