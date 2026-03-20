import React, { useRef, useEffect } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { themes } from '../../themes/notebook-theme';

interface SQLCellEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  themeMode: 'dark' | 'light';
  autoFocus?: boolean;
}

export function SQLCellEditor({ value, onChange, onRun, themeMode, autoFocus }: SQLCellEditorProps) {
  const t = themes[themeMode];
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep stable refs to avoid stale closures in extensions
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  // Recreate editor when themeMode changes
  useEffect(() => {
    if (!containerRef.current) return;

    const runKeymap = keymap.of([
      {
        key: 'Shift-Enter',
        run: () => {
          onRunRef.current();
          return true;
        },
      },
      {
        key: 'Ctrl-Enter',
        mac: 'Cmd-Enter',
        run: () => {
          onRunRef.current();
          return true;
        },
      },
      indentWithTab,
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
        maxHeight: '400px',
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'inherit',
      },
      '.cm-content': {
        padding: '10px 0',
        minHeight: '80px',
      },
      '.cm-focused': {
        outline: 'none',
      },
      '.cm-editor': {
        border: 'none',
      },
    });

    const extensions = [
      runKeymap,
      updateListener,
      baseTheme,
      sql(),
      lineNumbers(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      ...(themeMode === 'dark' ? [oneDark] : []),
    ];

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    if (autoFocus) {
      view.focus();
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally only re-run when themeMode changes (recreates editor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode]);

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
      style={{
        background: t.editorBg,
        minHeight: 80,
      }}
    />
  );
}

SQLCellEditor.displayName = 'SQLCellEditor';
