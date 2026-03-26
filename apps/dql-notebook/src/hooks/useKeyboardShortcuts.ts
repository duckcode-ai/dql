import { useEffect } from 'react';
import { useNotebook } from '../store/NotebookStore';
import { useQueryExecution } from './useQueryExecution';

/**
 * Global keyboard shortcuts for the notebook.
 *
 * - Cmd/Ctrl+B: Toggle sidebar
 * - Cmd/Ctrl+Shift+Enter: Run all cells
 * - Cmd/Ctrl+J: Toggle dev panel
 * - Cmd/Ctrl+D: Toggle dashboard mode
 * - Escape: Close any open modals / exit dashboard
 */
export function useKeyboardShortcuts() {
  const { state, dispatch } = useNotebook();
  const { executeAll } = useQueryExecution();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+B: Toggle sidebar
      if (isMod && e.key === 'b' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_SIDEBAR' });
        return;
      }

      // Cmd/Ctrl+Shift+Enter: Run all cells
      if (isMod && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        if (state.activeFile) {
          executeAll();
        }
        return;
      }

      // Cmd/Ctrl+J: Toggle dev panel
      if (isMod && e.key === 'j' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_DEV_PANEL' });
        return;
      }

      // Cmd/Ctrl+D: Toggle dashboard mode
      if (isMod && e.key === 'd' && !e.shiftKey) {
        e.preventDefault();
        if (state.activeFile) {
          dispatch({ type: 'TOGGLE_DASHBOARD_MODE' });
        }
        return;
      }

      // Escape: Close modals / exit dashboard
      if (e.key === 'Escape') {
        if (state.dashboardMode) {
          dispatch({ type: 'TOGGLE_DASHBOARD_MODE' });
          return;
        }
        if (state.newNotebookModalOpen) {
          dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
          return;
        }
        if (state.newBlockModalOpen) {
          dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' });
          return;
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [dispatch, executeAll, state.activeFile, state.newNotebookModalOpen, state.newBlockModalOpen, state.dashboardMode]);
}
