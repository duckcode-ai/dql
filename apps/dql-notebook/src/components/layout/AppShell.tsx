import React, { useCallback, useRef } from 'react';
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
import { api } from '../../api/client';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { makeCell } from '../../store/NotebookStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import type { NotebookFile } from '../../store/types';

export function AppShell() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const cellRefs = useRef<Record<string, HTMLDivElement>>({});

  // Global keyboard shortcuts
  useKeyboardShortcuts();

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
            onNavigateToCell={handleNavigateToCell}
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
      </div>

      {/* Modals */}
      {state.newNotebookModalOpen && <NewNotebookModal onFileOpened={handleOpenFile} />}
      {state.newBlockModalOpen && <NewBlockModal onFileOpened={handleOpenFile} />}
    </div>
  );
}
