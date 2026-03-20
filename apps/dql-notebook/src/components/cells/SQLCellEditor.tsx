import React, { useRef, useEffect, useCallback, forwardRef } from 'react';
import { themes } from '../../themes/notebook-theme';

interface SQLCellEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  themeMode: 'dark' | 'light';
  placeholder?: string;
  disabled?: boolean;
}

export const SQLCellEditor = forwardRef<HTMLTextAreaElement, SQLCellEditorProps>(
  ({ value, onChange, onRun, themeMode, placeholder = 'SELECT ...', disabled }, ref) => {
    const t = themes[themeMode];
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) ?? internalRef;

    // Auto-resize textarea
    const autoResize = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      const lineHeight = 20;
      const minLines = 3;
      const maxHeight = 480;
      const minHeight = lineHeight * minLines;
      const newHeight = Math.min(Math.max(ta.scrollHeight, minHeight), maxHeight);
      ta.style.height = `${newHeight}px`;
    }, [textareaRef]);

    useEffect(() => {
      autoResize();
    }, [value, autoResize]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Shift+Enter: run
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          onRun();
          return;
        }

        // Tab: insert 2 spaces
        if (e.key === 'Tab') {
          e.preventDefault();
          const ta = e.currentTarget;
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          const newValue = value.slice(0, start) + '  ' + value.slice(end);
          onChange(newValue);
          // Move cursor after the inserted spaces
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = start + 2;
          });
        }
      },
      [onRun, onChange, value]
    );

    return (
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          autoResize();
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          display: 'block',
          width: '100%',
          minHeight: 60,
          padding: '10px 14px',
          background: t.editorBg,
          color: t.textPrimary,
          border: 'none',
          outline: 'none',
          resize: 'none' as const,
          fontFamily: t.fontMono,
          fontSize: 13,
          lineHeight: '20px',
          tabSize: 2,
          borderRadius: 0,
          overflow: 'hidden',
          caretColor: t.accent,
        }}
      />
    );
  }
);

SQLCellEditor.displayName = 'SQLCellEditor';
