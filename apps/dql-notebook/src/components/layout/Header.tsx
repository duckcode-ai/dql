import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { serializeDqlNotebook } from '../../utils/parse-workbook';
import { useQueryExecution } from '../../hooks/useQueryExecution';

function DQLLogo({ t }: { t: Theme }) {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: 'linear-gradient(135deg, #388bfd 0%, #1f6feb 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          color: '#ffffff',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: t.fontMono,
          letterSpacing: '-0.5px',
        }}
      >
        DQL
      </span>
    </div>
  );
}

export function Header() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const { executeAll } = useQueryExecution();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [runHover, setRunHover] = useState(false);
  const [saveHover, setSaveHover] = useState(false);
  const [themeHover, setThemeHover] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  const startEditTitle = () => {
    setTitleDraft(state.notebookTitle);
    setEditingTitle(true);
  };

  const commitTitle = () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft !== state.notebookTitle) {
      dispatch({ type: 'SET_NOTEBOOK_DIRTY', dirty: true });
    }
  };

  const handleSave = useCallback(async () => {
    if (!state.activeFile) return;
    dispatch({ type: 'SET_SAVING', saving: true });
    try {
      const content = serializeDqlNotebook(state.notebookTitle, state.cells);
      await api.saveNotebook(state.activeFile.path, content);
      dispatch({ type: 'SET_NOTEBOOK_DIRTY', dirty: false });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      dispatch({ type: 'SET_SAVING', saving: false });
    }
  }, [state.activeFile, state.notebookTitle, state.cells, dispatch]);

  const toggleTheme = () => {
    dispatch({ type: 'SET_THEME', mode: state.themeMode === 'dark' ? 'light' : 'dark' });
  };

  const btnBase = {
    height: 28,
    padding: '0 10px',
    borderRadius: 6,
    border: `1px solid ${t.btnBorder}`,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: t.font,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    transition: 'background 0.15s, color 0.15s',
    whiteSpace: 'nowrap' as const,
  };

  return (
    <div
      style={{
        height: 48,
        flexShrink: 0,
        background: t.headerBg,
        borderBottom: `1px solid ${t.headerBorder}`,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 8,
        userSelect: 'none',
      }}
    >
      {/* Left: Logo + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <DQLLogo t={t as any} />
        <div
          style={{
            width: 1,
            height: 20,
            background: t.headerBorder,
            flexShrink: 0,
          }}
        />
        {state.activeFile ? (
          editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              style={{
                background: 'transparent',
                border: `1px solid ${t.cellBorderActive}`,
                borderRadius: 4,
                color: t.textPrimary,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: t.font,
                padding: '2px 6px',
                outline: 'none',
                minWidth: 120,
                maxWidth: 320,
              }}
            />
          ) : (
            <span
              onClick={startEditTitle}
              title="Click to rename"
              style={{
                color: t.textPrimary,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: t.font,
                cursor: 'text',
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                padding: '2px 4px',
                borderRadius: 4,
                border: '1px solid transparent',
              }}
            >
              {state.notebookTitle || 'Untitled'}
              {state.notebookDirty && (
                <span style={{ color: t.textMuted, marginLeft: 4 }}>●</span>
              )}
            </span>
          )
        ) : (
          <span
            style={{
              color: t.textSecondary,
              fontSize: 13,
              fontFamily: t.font,
              padding: '2px 4px',
            }}
          >
            DQL Notebook
          </span>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right: actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Run All */}
        <button
          onClick={executeAll}
          disabled={!state.activeFile}
          onMouseEnter={() => setRunHover(true)}
          onMouseLeave={() => setRunHover(false)}
          style={{
            ...btnBase,
            background: runHover && state.activeFile ? t.accent : t.accent,
            color: '#ffffff',
            border: `1px solid ${t.accent}`,
            opacity: !state.activeFile ? 0.4 : runHover ? 0.9 : 1,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M1.5 1.5l7 3.5-7 3.5V1.5Z" />
          </svg>
          Run All
        </button>

        {/* Separator */}
        <div style={{ width: 1, height: 20, background: t.headerBorder }} />

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          onMouseEnter={() => setThemeHover(true)}
          onMouseLeave={() => setThemeHover(false)}
          title={state.themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            ...btnBase,
            background: themeHover ? t.btnHover : t.btnBg,
            color: t.textSecondary,
            padding: '0 8px',
            fontSize: 14,
          }}
        >
          {state.themeMode === 'dark' ? '☀' : '☾'}
        </button>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={!state.activeFile || state.savingFile}
          onMouseEnter={() => setSaveHover(true)}
          onMouseLeave={() => setSaveHover(false)}
          style={{
            ...btnBase,
            background: saveHover && state.activeFile ? t.btnHover : t.btnBg,
            color: savedFlash ? t.success : t.textSecondary,
            opacity: !state.activeFile ? 0.4 : 1,
          }}
        >
          {state.savingFile ? (
            <>
              <SpinnerIcon />
              Saving…
            </>
          ) : savedFlash ? (
            <>✓ Saved</>
          ) : (
            <>Save</>
          )}
        </button>
      </div>
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      style={{ animation: 'spin 0.8s linear infinite' }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 7" />
    </svg>
  );
}
