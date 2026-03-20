import React, { useCallback, useRef } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { ActivityBar } from './ActivityBar';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { DevPanel } from './DevPanel';
import { NotebookEditor } from '../notebook/NotebookEditor';
import { NewNotebookModal } from '../modals/NewNotebookModal';
import { api } from '../../api/client';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { makeCell } from '../../store/NotebookStore';
import type { NotebookFile } from '../../store/types';

export function AppShell() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const cellRefs = useRef<Record<string, HTMLDivElement>>({});

  const handleOpenFile = useCallback(
    async (file: NotebookFile) => {
      try {
        const { content } = await api.readNotebook(file.path);
        const { title, cells } = parseNotebookFile(file.path, content);
        dispatch({ type: 'OPEN_FILE', file, cells, title });
        // Ensure files panel is visible
        if (state.sidebarPanel !== 'files') {
          dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
        }
      } catch (err) {
        console.error('Failed to open file:', err);
        // Open with an empty cell as fallback
        dispatch({
          type: 'OPEN_FILE',
          file,
          cells: [makeCell('sql')],
          title: file.name,
        });
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
          <NotebookEditor
            onOpenFile={handleOpenFile}
            registerCellRef={registerCellRef}
          />
          <DevPanel />
        </div>
      </div>

      {/* Modals */}
      {state.newNotebookModalOpen && <NewNotebookModal onFileOpened={handleOpenFile} />}
    </div>
  );
}
