import React, { useRef, useEffect, useState } from 'react';
import {
  EditorView,
  Decoration,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
} from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, indentWithTab, toggleComment, historyKeymap, history, undo, redo } from '@codemirror/commands';
import { sql } from '@codemirror/lang-sql';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from '@codemirror/language';
import { tags as t_ } from '@lezer/highlight';
import {
  closeBrackets,
  closeBracketsKeymap,
  autocompletion,
  completionKeymap,
} from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import {
  SEMANTIC_REF_MIME,
  clearActiveSemanticEditor,
  insertSemanticReferenceAtCoords,
  parseSemanticDragRef,
  semanticCompletionSource,
  setActiveSemanticEditor,
} from '../../editor/semantic-completions';
import { api } from '../../api/client';

export interface SQLCellEditorHandle {
  undo: () => void;
  redo: () => void;
  resetTo: (value: string) => void;
}

interface SQLCellEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  themeMode: ThemeMode;
  autoFocus?: boolean;
  schema?: Record<string, string[]>;
  errorMessage?: string;
  editorRef?: React.RefObject<SQLCellEditorHandle | null>;
  // When false, lines don't wrap — the editor gains a horizontal scrollbar.
  // Block Studio passes false so long queries aren't char-wrapped when the
  // pane is narrow.
  wrap?: boolean;
}

/**
 * Parse a DuckDB/SQL error message to extract line and column info.
 * Common patterns:
 * - "LINE 2: ..." (DuckDB)
 * - "at line 3, column 5"
 * - "Error at position 42"
 * Returns { line, col } (1-based) or null if not parseable.
 */
function parseErrorLocation(msg: string): { line: number; col: number } | null {
  // DuckDB: "LINE 2: SELECT * FROM ..."
  const lineMatch = msg.match(/LINE\s+(\d+)/i);
  if (lineMatch) {
    const line = parseInt(lineMatch[1], 10);
    // Try to find column from caret indicator (^) often on the next line
    const caretMatch = msg.match(/\n(\s*)\^/);
    const col = caretMatch ? caretMatch[1].length + 1 : 1;
    return { line, col };
  }
  // Generic: "at line X, column Y"
  const lcMatch = msg.match(/at line\s+(\d+),?\s*column\s+(\d+)/i);
  if (lcMatch) {
    return { line: parseInt(lcMatch[1], 10), col: parseInt(lcMatch[2], 10) };
  }
  // Fallback: "line X"
  const simpleLine = msg.match(/line\s+(\d+)/i);
  if (simpleLine) {
    return { line: parseInt(simpleLine[1], 10), col: 1 };
  }
  return null;
}

// Effect to update error decorations
const setErrorEffect = StateEffect.define<{ from: number; to: number; message: string } | null>();

const errorDecoField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorEffect)) {
        if (!e.value) return Decoration.none;
        const { from, to, message } = e.value;
        return Decoration.set([
          Decoration.mark({
            class: 'cm-sql-error',
            attributes: { title: message },
          }).range(from, to),
        ]);
      }
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Luna-token syntax palette. Colors resolve from CSS vars on the active
// data-theme, so the same HighlightStyle re-skins for obsidian/paper/white
// instead of leaking oneDark's neon palette into light themes (which made
// strings render as `#ee4400` orange against a paper background).
const lunaHighlightStyle = HighlightStyle.define([
  { tag: t_.keyword, color: 'var(--sql-keyword)', fontWeight: '600' },
  { tag: [t_.controlKeyword, t_.moduleKeyword], color: 'var(--sql-keyword)', fontWeight: '600' },
  { tag: [t_.string, t_.special(t_.string)], color: 'var(--sql-string)' },
  { tag: t_.number, color: 'var(--sql-number)' },
  { tag: t_.bool, color: 'var(--sql-number)', fontWeight: '600' },
  { tag: t_.null, color: 'var(--sql-number)', fontWeight: '600' },
  { tag: [t_.comment, t_.lineComment, t_.blockComment, t_.docComment], color: 'var(--sql-comment)', fontStyle: 'italic' },
  { tag: [t_.function(t_.variableName), t_.function(t_.propertyName)], color: 'var(--sql-function)' },
  { tag: [t_.typeName, t_.className], color: 'var(--sql-type)' },
  { tag: t_.operator, color: 'var(--sql-punctuation)' },
  { tag: t_.punctuation, color: 'var(--sql-punctuation)' },
  { tag: t_.bracket, color: 'var(--sql-punctuation)' },
  { tag: [t_.variableName, t_.name, t_.propertyName, t_.attributeName], color: 'var(--sql-ident)' },
  { tag: t_.invalid, color: 'var(--color-status-error)' },
]);

const errorTheme = EditorView.baseTheme({
  '.cm-sql-error': {
    textDecoration: 'underline wavy var(--color-status-error)',
    textUnderlineOffset: '3px',
    background: 'color-mix(in srgb, var(--color-status-error) 10%, transparent)',
  },
});

// Luna-token chrome used for every theme. Panel backgrounds, tooltips,
// gutters resolve against the active `data-theme` at paint time, so the
// same theme instance works for obsidian/paper/white.
function makePanelTheme(isDark: boolean) {
  return EditorView.theme(
    {
      '&': {
        background: 'var(--color-bg-sunken)',
        color: 'var(--color-text-primary)',
      },
      '.cm-content': { caretColor: 'var(--color-text-primary)' },
      '.cm-cursor': { borderLeftColor: 'var(--color-text-primary)' },
      '.cm-selectionBackground': {
        background: 'color-mix(in srgb, var(--color-accent-blue) 30%, transparent)',
      },
      '&.cm-focused .cm-selectionBackground': {
        background: 'color-mix(in srgb, var(--color-accent-blue) 30%, transparent)',
      },
      '.cm-gutters': {
        background: 'var(--color-bg-sunken)',
        color: 'var(--color-text-tertiary)',
        border: 'none',
        borderRight: '1px solid var(--color-border-subtle)',
      },
      '.cm-activeLineGutter': { background: 'var(--color-bg-hover)' },
      '.cm-activeLine': { background: 'var(--color-bg-hover)' },
      '.cm-matchingBracket': {
        background: 'color-mix(in srgb, var(--color-accent-blue) 18%, transparent)',
        outline: '1px solid var(--color-accent-blue)',
      },
      '.cm-foldPlaceholder': {
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-border-subtle)',
        color: 'var(--color-text-secondary)',
        borderRadius: 3,
        padding: '0 4px',
      },
      '.cm-tooltip': {
        background: 'var(--color-bg-card)',
        border: '1px solid var(--color-border-primary)',
        color: 'var(--color-text-primary)',
        borderRadius: 6,
        boxShadow: '0 4px 12px color-mix(in srgb, var(--color-bg-primary) 40%, transparent)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete': {
        '& > ul > li': { padding: '3px 8px' },
        '& > ul > li[aria-selected]': {
          background: 'color-mix(in srgb, var(--color-accent-blue) 20%, transparent)',
          color: 'var(--color-accent-blue)',
        },
      },
      '.cm-searchMatch': {
        background: 'color-mix(in srgb, var(--color-status-warning) 25%, transparent)',
        outline: '1px solid var(--color-status-warning)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        background: 'color-mix(in srgb, var(--color-status-warning) 50%, transparent)',
      },
      '.cm-panels': {
        background: 'var(--color-bg-secondary)',
        borderTop: '1px solid var(--color-border-subtle)',
      },
      '.cm-panel': { padding: '6px 8px' },
      '.cm-panel input': {
        background: 'var(--color-bg-sunken)',
        border: '1px solid var(--color-border-subtle)',
        color: 'var(--color-text-primary)',
        borderRadius: 4,
        padding: '2px 6px',
        fontSize: 12,
      },
      '.cm-panel button': {
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-border-subtle)',
        color: 'var(--color-text-primary)',
        borderRadius: 4,
        padding: '2px 8px',
        cursor: 'pointer',
        fontSize: 12,
        marginLeft: 4,
      },
    },
    { dark: isDark }
  );
}

const darkPanelTheme = makePanelTheme(true);
const lightPanelTheme = makePanelTheme(false);

function isDarkFamily(mode: ThemeMode): boolean {
  return mode === 'midnight' || mode === 'obsidian' || mode === 'dark';
}

export function SQLCellEditor({
  value,
  onChange,
  onRun,
  themeMode,
  autoFocus,
  schema,
  errorMessage,
  editorRef,
  wrap = true,
}: SQLCellEditorProps) {
  const t = themes[themeMode];
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  // Compartment lets us swap SQL language/schema without destroying the editor
  const schemaCompartment = useRef(new Compartment());
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  // Expose imperative handle for undo/redo/reset
  useEffect(() => {
    if (!editorRef) return;
    (editorRef as React.MutableRefObject<SQLCellEditorHandle | null>).current = {
      undo: () => { if (viewRef.current) undo(viewRef.current); },
      redo: () => { if (viewRef.current) redo(viewRef.current); },
      resetTo: (newValue: string) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: newValue },
        });
      },
    };
  });

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

    const editorDomHandlers = EditorView.domEventHandlers({
      focus: (_event, view) => {
        setActiveSemanticEditor(view);
      },
      blur: (_event, view) => {
        clearActiveSemanticEditor(view);
      },
    });

    const baseTheme = EditorView.theme({
      '&': {
        background: 'var(--color-bg-surface)',
        color: 'var(--color-text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: '13px',
        minHeight: '80px',
        maxHeight: '480px',
      },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
      '.cm-content': { padding: '10px 0', minHeight: '80px', color: 'var(--color-text-primary)' },
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
      editorDomHandlers,
      baseTheme,
      // Language wrapped in compartment for hot-swapping schema
      schemaCompartment.current.of(initialSqlLang),
      autocompletion({ closeOnBlur: false, override: [semanticCompletionSource] }),
      // Undo/redo history — history() provides the state machine, historyKeymap binds Cmd+Z / Cmd+Shift+Z
      history(),
      // Developer experience extensions
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      foldGutter(),
      // Visual aids
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      ...(wrap ? [EditorView.lineWrapping] : []),
      // Search
      search({ top: true }),
      // Error decoration support
      errorDecoField,
      errorTheme,
      // Theme — single Luna palette for both dark and light. Syntax colors
      // are CSS vars so paper/obsidian/white re-skin without rebuilding.
      // Dark/light flag is passed to the chrome theme so CodeMirror knows
      // which selection palette to mix.
      syntaxHighlighting(lunaHighlightStyle),
      isDarkFamily(themeMode) ? darkPanelTheme : lightPanelTheme,
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

  // Update inline error decorations when errorMessage changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!errorMessage) {
      // Clear error decorations
      view.dispatch({ effects: setErrorEffect.of(null) });
      return;
    }

    const loc = parseErrorLocation(errorMessage);
    const doc = view.state.doc;

    if (loc && loc.line >= 1 && loc.line <= doc.lines) {
      const line = doc.line(loc.line);
      const from = line.from + Math.max(0, loc.col - 1);
      // Underline from error position to end of line (or at least 1 char)
      const to = Math.max(from + 1, line.to);
      view.dispatch({
        effects: setErrorEffect.of({
          from: Math.min(from, doc.length),
          to: Math.min(to, doc.length),
          message: errorMessage,
        }),
      });
    } else {
      // Can't determine line — underline first line as fallback
      if (doc.lines >= 1) {
        const line = doc.line(1);
        view.dispatch({
          effects: setErrorEffect.of({
            from: line.from,
            to: Math.max(line.from + 1, line.to),
            message: errorMessage,
          }),
        });
      }
    }
  }, [errorMessage]);

  return (
    <div
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SEMANTIC_REF_MIME)) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        const view = viewRef.current;
        if (!view) return;
        const payload = parseSemanticDragRef(event.dataTransfer.getData(SEMANTIC_REF_MIME));
        if (!payload) return;
        event.preventDefault();
        setDragActive(false);
        insertSemanticReferenceAtCoords(view, payload.reference, { x: event.clientX, y: event.clientY });
        void api.trackUsage(payload.name);
        window.dispatchEvent(new CustomEvent('dql:semantic-used', { detail: { name: payload.name } }));
      }}
      style={{
        background: 'var(--color-bg-surface)',
        minHeight: 80,
        border: dragActive ? `1px solid ${t.accent}` : '1px solid transparent',
        borderRadius: 6,
        transition: 'border-color 0.15s',
      }}
    >
      <div ref={containerRef} style={{ minHeight: 80 }} />
    </div>
  );
}

SQLCellEditor.displayName = 'SQLCellEditor';
