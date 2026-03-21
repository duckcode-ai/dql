import React, { useRef, useEffect } from 'react';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab, toggleComment, historyKeymap } from '@codemirror/commands';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import {
  closeBrackets,
  closeBracketsKeymap,
  autocompletion,
  completionKeymap,
} from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { themes } from '../../themes/notebook-theme';

interface SQLCellEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  themeMode: 'dark' | 'light';
  autoFocus?: boolean;
  schema?: Record<string, string[]>;
}

// Light theme for CodeMirror — GitHub-inspired
const lightTheme = EditorView.theme(
  {
    '&': { background: '#f6f8fa', color: '#1f2328' },
    '.cm-content': { caretColor: '#1f2328' },
    '.cm-cursor': { borderLeftColor: '#1f2328' },
    '.cm-selectionBackground': { background: '#b3d4fc' },
    '&.cm-focused .cm-selectionBackground': { background: '#b3d4fc' },
    '.cm-gutters': {
      background: '#f0f2f5',
      color: '#8c959f',
      border: 'none',
      borderRight: '1px solid #d0d7de',
    },
    '.cm-activeLineGutter': { background: '#e8f0fe' },
    '.cm-activeLine': { background: '#eaf0fb' },
    '.cm-matchingBracket': {
      background: '#c8e6c9',
      outline: '1px solid #66bb6a',
    },
    '.cm-foldPlaceholder': {
      background: '#eaeef2',
      border: '1px solid #d0d7de',
      color: '#57606a',
      borderRadius: 3,
      padding: '0 4px',
    },
    '.cm-tooltip': {
      background: '#ffffff',
      border: '1px solid #d0d7de',
      borderRadius: 6,
      boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      '& > ul > li': { padding: '3px 8px' },
      '& > ul > li[aria-selected]': { background: '#dbeafe', color: '#0550ae' },
    },
    '.cm-searchMatch': { background: '#fff3b0', outline: '1px solid #f5c518' },
    '.cm-searchMatch.cm-searchMatch-selected': { background: '#f5c518' },
    '.cm-panels': { background: '#f0f2f5', borderTop: '1px solid #d0d7de' },
    '.cm-panel': { padding: '6px 8px' },
    '.cm-panel input': {
      background: '#fff',
      border: '1px solid #d0d7de',
      borderRadius: 4,
      padding: '2px 6px',
      fontSize: 12,
    },
    '.cm-panel button': {
      background: '#f6f8fa',
      border: '1px solid #d0d7de',
      borderRadius: 4,
      padding: '2px 8px',
      cursor: 'pointer',
      fontSize: 12,
      marginLeft: 4,
    },
  },
  { dark: false }
);

// Dark theme overrides for search/autocomplete panels
const darkPanelTheme = EditorView.theme(
  {
    '.cm-panels': { background: '#161b22', borderTop: '1px solid #30363d' },
    '.cm-panel input': {
      background: '#0d1117',
      border: '1px solid #30363d',
      color: '#e6edf3',
      borderRadius: 4,
      padding: '2px 6px',
      fontSize: 12,
    },
    '.cm-panel button': {
      background: '#21262d',
      border: '1px solid #30363d',
      color: '#e6edf3',
      borderRadius: 4,
      padding: '2px 8px',
      cursor: 'pointer',
      fontSize: 12,
      marginLeft: 4,
    },
    '.cm-tooltip': {
      background: '#1c2128',
      border: '1px solid #30363d',
      borderRadius: 6,
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      '& > ul > li[aria-selected]': { background: '#1f3858', color: '#58a6ff' },
    },
    '.cm-matchingBracket': {
      background: '#1f3858',
      outline: '1px solid #388bfd',
    },
    '.cm-searchMatch': { background: '#3d3000', outline: '1px solid #e3b341' },
    '.cm-searchMatch.cm-searchMatch-selected': { background: '#6a4e00' },
  },
  { dark: true }
);

export function SQLCellEditor({
  value,
  onChange,
  onRun,
  themeMode,
  autoFocus,
  schema,
}: SQLCellEditorProps) {
  const t = themes[themeMode];
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  // Compartment lets us swap SQL language/schema without destroying the editor
  const schemaCompartment = useRef(new Compartment());
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  // Create editor once per themeMode change only (NOT when schema changes)
  useEffect(() => {
    if (!containerRef.current) return;

    const runKeymap = keymap.of([
      {
        key: 'Shift-Enter',
        run: () => { onRunRef.current(); return true; },
      },
      {
        key: 'Ctrl-Enter',
        mac: 'Cmd-Enter',
        run: () => { onRunRef.current(); return true; },
      },
      // Toggle line comment: Cmd+/ or Ctrl+/
      {
        key: 'Ctrl-/',
        mac: 'Cmd-/',
        run: toggleComment,
      },
      indentWithTab,
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...foldKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const baseTheme = EditorView.theme({
      '&': {
        background: t.editorBg,
        fontFamily: t.fontMono,
        fontSize: '13px',
        minHeight: '80px',
        maxHeight: '480px',
      },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
      '.cm-content': { padding: '10px 0', minHeight: '80px' },
      '.cm-focused': { outline: 'none' },
      '.cm-editor': { border: 'none' },
      '.cm-gutters': { minWidth: 40 },
      '.cm-foldGutter': { cursor: 'pointer' },
    });

    // Initial SQL language with current schema (wrapped in compartment)
    const initialSqlLang = schema
      ? sql({ schema, upperCaseKeywords: false })
      : sql({ upperCaseKeywords: false });

    const extensions = [
      runKeymap,
      updateListener,
      baseTheme,
      // Language wrapped in compartment for hot-swapping schema
      schemaCompartment.current.of(initialSqlLang),
      autocompletion({ closeOnBlur: false }),
      // Developer experience extensions
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      foldGutter(),
      // Visual aids
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      EditorView.lineWrapping,
      // Search
      search({ top: true }),
      // Theme
      ...(themeMode === 'dark'
        ? [oneDark, darkPanelTheme]
        : [lightTheme, syntaxHighlighting(defaultHighlightStyle)]),
    ];

    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    if (autoFocus) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode]);

  // Hot-swap schema via compartment — no editor destroy/recreate, no focus loss
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const newSqlLang = schema
      ? sql({ schema, upperCaseKeywords: false })
      : sql({ upperCaseKeywords: false });
    view.dispatch({
      effects: schemaCompartment.current.reconfigure(newSqlLang),
    });
  }, [schema]);

  // Sync external value changes without recreating the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      style={{ background: t.editorBg, minHeight: 80 }}
    />
  );
}

SQLCellEditor.displayName = 'SQLCellEditor';
