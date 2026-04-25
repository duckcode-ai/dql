import React, { useEffect } from 'react';
import { ThemeProvider, TooltipProvider } from '@duckcodeailabs/dql-ui';
import { NotebookProvider, useNotebook } from './store/NotebookStore';
import { AppShell } from './components/shell/AppShell';
import { themes } from './themes/notebook-theme';
import { api } from './api/client';
import { useHotReload } from './hooks/useHotReload';

function AppInner() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  // Inject global CSS reset and scrollbar styles. Resolve against Luna CSS
  // vars so switching `data-theme` re-skins the body without a re-inject.
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
        font-family: var(--font-ui, ${t.font});
        overflow: hidden;
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb {
        background: var(--color-border-secondary);
        border-radius: 3px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: var(--color-text-tertiary);
      }
      ::selection {
        background: color-mix(in srgb, var(--color-accent-blue) 25%, transparent);
        color: var(--color-text-primary);
      }
      .dql-meta-pill:hover {
        background: var(--dql-pill-hover-bg) !important;
        border-color: var(--dql-pill-hover-border) !important;
      }
    `;
  }, [t]);

  // v1.3.2 — three Luna themes (obsidian / paper / white). Legacy
  // 'dark'/'light'/'midnight'/'arctic' alias onto the live set so persisted
  // state from earlier v1.3 releases still loads.
  useEffect(() => {
    const luna =
      state.themeMode === 'dark' || state.themeMode === 'midnight' ? 'obsidian'
      : state.themeMode === 'light' ? 'paper'
      : state.themeMode === 'arctic' ? 'white'
      : state.themeMode;
    document.documentElement.setAttribute('data-theme', luna);
  }, [state.themeMode]);

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

  return (
    <ThemeProvider theme={state.themeMode} applyGlobal>
      <TooltipProvider delayDuration={200} skipDelayDuration={400}>
        <AppShell />
      </TooltipProvider>
    </ThemeProvider>
  );
}

export function App() {
  return (
    <NotebookProvider>
      <AppInner />
    </NotebookProvider>
  );
}
