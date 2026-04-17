import React, { useCallback, useRef, useState, useEffect } from 'react';
import { CommandPalette } from '../palette/CommandPalette';
import { InspectorPanel } from './InspectorPanel';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { ActivityBar } from './ActivityBar';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { DevPanel } from './DevPanel';
import { NotebookEditor } from '../notebook/NotebookEditor';
import { NewNotebookModal } from '../modals/NewNotebookModal';
import { NewBlockModal } from '../modals/NewBlockModal';
import { BlockStudio } from '../block-studio/BlockStudio';
import { LineageDAG } from '../sidebar/LineageDAG';
import { ConnectionPanel } from '../sidebar/ConnectionPanel';
import { ReferencePanel } from '../sidebar/ReferencePanel';
import { api } from '../../api/client';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { makeCell } from '../../store/NotebookStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import type { NotebookFile } from '../../store/types';

export function AppShell() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const cellRefs = useRef<Record<string, HTMLDivElement>>({});

  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global keyboard shortcuts
  useKeyboardShortcuts();

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
        if (file.type === 'block') {
          const payload = await api.openBlockStudio(file.path);
          dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
          return;
        }
        const { content } = await api.readNotebook(file.path);
        const { title, cells } = parseNotebookFile(file.path, content);
        dispatch({ type: 'OPEN_FILE', file, cells, title });
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

      {/* Body row: ActivityBar + Sidebar + Main */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <ActivityBar />

        {state.sidebarOpen && (
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
          {state.lineageFullscreen ? (
            <LineageDAG />
          ) : state.mainView === 'connection' ? (
            <FullPageSection
              title="Connections"
              description="Manage database connections, edit driver settings, and test connectivity in a full-page workspace."
            >
              <ConnectionPanel />
            </FullPageSection>
          ) : state.mainView === 'reference' ? (
            <FullPageSection
              title="Quick Reference"
              description="Browse the complete DQL guide, semantic workflows, and authoring patterns in a documentation-style view."
            >
              <ReferencePanel themeMode={state.themeMode} />
            </FullPageSection>
          ) : (
            <>
              {state.mainView === 'block_studio' ? (
                <BlockStudio />
              ) : (
                <>
                  <NotebookEditor
                    onOpenFile={handleOpenFile}
                    registerCellRef={registerCellRef}
                  />
                  <DevPanel />
                </>
              )}
            </>
          )}
        </div>

        {state.inspectorOpen && !state.lineageFullscreen && !state.dashboardMode && (
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
