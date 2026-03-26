import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { serializeDqlNotebook } from '../../utils/parse-workbook';
import { useQueryExecution } from '../../hooks/useQueryExecution';
import { downloadDashboard } from '../../utils/export-dashboard';
import { downloadWorkbookDql } from '../../utils/export-workbook-dql';

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
  const [exportHover, setExportHover] = useState(false);
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportDropdownOpen) return;
    function handler(e: MouseEvent) {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) {
        setExportDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportDropdownOpen]);

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
      // Block files save as raw content; notebooks serialize to JSON
      const content = state.activeFile.type === 'block'
        ? (state.cells[0]?.content ?? '')
        : serializeDqlNotebook(state.notebookTitle, state.cells);
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

  // Cmd/Ctrl+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Auto-save: trigger save after 2s of inactivity when dirty
  useEffect(() => {
    if (!state.autoSave || !state.notebookDirty || !state.activeFile) return;
    const timer = setTimeout(() => {
      handleSave();
    }, 2000);
    return () => clearTimeout(timer);
  }, [state.autoSave, state.notebookDirty, state.activeFile, state.cells, handleSave]);

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
        {state.activeFile && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: state.activeFile.type === 'block' ? '#e3b341' : t.accent,
              background: `${state.activeFile.type === 'block' ? '#e3b341' : t.accent}18`,
              borderRadius: 4,
              padding: '2px 6px',
              fontFamily: t.font,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              flexShrink: 0,
            }}
          >
            {state.activeFile.type}
          </span>
        )}
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
          title="Save (Cmd+S)"
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

        {/* Auto-save toggle */}
        <button
          onClick={() => dispatch({ type: 'SET_AUTO_SAVE', enabled: !state.autoSave })}
          title={state.autoSave ? 'Auto-save on' : 'Auto-save off'}
          style={{
            ...btnBase,
            background: state.autoSave ? `${t.accent}20` : t.btnBg,
            color: state.autoSave ? t.accent : t.textMuted,
            padding: '0 6px',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.03em',
            border: `1px solid ${state.autoSave ? t.accent : t.btnBorder}`,
          }}
        >
          AUTO
        </button>

        {/* Dashboard mode toggle */}
        <button
          onClick={() => dispatch({ type: 'TOGGLE_DASHBOARD_MODE' })}
          disabled={!state.activeFile}
          title={state.dashboardMode ? 'Switch to editor mode' : 'Switch to dashboard mode'}
          style={{
            ...btnBase,
            background: state.dashboardMode ? `${t.accent}20` : t.btnBg,
            color: state.dashboardMode ? t.accent : t.textSecondary,
            border: `1px solid ${state.dashboardMode ? t.accent : t.btnBorder}`,
            opacity: !state.activeFile ? 0.4 : 1,
            padding: '0 8px',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            {state.dashboardMode ? (
              <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5Z" />
            ) : (
              <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v3.585a.746.746 0 0 1 0 .83v8.085A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25V5h13V1.75a.25.25 0 0 0-.25-.25ZM1.5 6.5v7.75c0 .138.112.25.25.25H7v-8Zm7 8h5.75a.25.25 0 0 0 .25-.25V6.5h-6Z" />
            )}
          </svg>
          {state.dashboardMode ? 'Editor' : 'Dashboard'}
        </button>

        {/* Separator */}
        <div style={{ width: 1, height: 20, background: t.headerBorder }} />

        {/* Export dropdown */}
        <div ref={exportDropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (state.activeFile) setExportDropdownOpen((o) => !o);
            }}
            disabled={!state.activeFile}
            onMouseEnter={() => setExportHover(true)}
            onMouseLeave={() => setExportHover(false)}
            title="Export options"
            style={{
              ...btnBase,
              background: (exportHover || exportDropdownOpen) && state.activeFile ? t.btnHover : t.btnBg,
              color: t.textSecondary,
              opacity: !state.activeFile ? 0.4 : 1,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z" />
              <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.97a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.779a.749.749 0 1 1 1.06-1.06l1.97 1.97Z" />
            </svg>
            Export
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ marginLeft: 1 }}>
              <path d="M1 2.5l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>

          {exportDropdownOpen && (
            <div
              style={{
                position: 'absolute',
                top: 32,
                right: 0,
                zIndex: 200,
                background: t.modalBg,
                border: `1px solid ${t.cellBorder}`,
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                padding: 4,
                minWidth: 160,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <ExportMenuItem
                label="Export HTML"
                description="Standalone dashboard"
                t={t}
                onClick={() => {
                  downloadDashboard(state.notebookTitle || 'dashboard', state.cells);
                  setExportDropdownOpen(false);
                }}
              />
              <ExportMenuItem
                label="Export .dql"
                description="DQL workbook file"
                t={t}
                onClick={() => {
                  downloadWorkbookDql(state.notebookTitle || 'notebook', state.cells);
                  setExportDropdownOpen(false);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExportMenuItem({
  label,
  description,
  t,
  onClick,
}: {
  label: string;
  description: string;
  t: Theme;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? t.btnHover : 'transparent',
        border: 'none',
        borderRadius: 5,
        cursor: 'pointer',
        padding: '6px 10px',
        textAlign: 'left' as const,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        transition: 'background 0.12s',
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 500, color: t.textPrimary, fontFamily: t.font }}>
        {label}
      </span>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>{description}</span>
    </button>
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
