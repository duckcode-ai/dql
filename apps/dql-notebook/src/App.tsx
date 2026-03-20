import React, { useEffect } from 'react';
import { NotebookProvider, useNotebook } from './store/NotebookStore';
import { AppShell } from './components/layout/AppShell';
import { themes } from './themes/notebook-theme';
import { api } from './api/client';
import { useHotReload } from './hooks/useHotReload';

function AppInner() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  // Inject global CSS reset and scrollbar styles
  useEffect(() => {
    const id = 'dql-global-styles';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: ${t.font};
        overflow: hidden;
        background: ${t.appBg};
        color: ${t.textPrimary};
      }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb {
        background: ${t.scrollbarThumb};
        border-radius: 3px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: ${t.textMuted};
      }
      ::selection {
        background: ${t.accent}40;
        color: ${t.textPrimary};
      }
    `;
  }, [t]);

  // Load notebooks on mount
  useEffect(() => {
    dispatch({ type: 'SET_FILES_LOADING', loading: true });
    api.listNotebooks().then((files) => {
      dispatch({ type: 'SET_FILES', files });
      dispatch({ type: 'SET_FILES_LOADING', loading: false });
    });
  }, [dispatch]);

  // Load schema on mount
  useEffect(() => {
    dispatch({ type: 'SET_SCHEMA_LOADING', loading: true });
    api.getSchema().then((tables) => {
      dispatch({ type: 'SET_SCHEMA', tables });
      dispatch({ type: 'SET_SCHEMA_LOADING', loading: false });
    });
  }, [dispatch]);

  // Hot reload — watches project files via SSE and refreshes state
  useHotReload();

  return <AppShell />;
}

export function App() {
  return (
    <NotebookProvider>
      <AppInner />
    </NotebookProvider>
  );
}
