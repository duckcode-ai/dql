import React, { useState, useEffect, useRef } from 'react';
import { themes } from '../../themes/notebook-theme';
import { SNIPPETS } from '../../utils/snippets';
import type { ThemeMode } from '../../store/types';

interface SnippetPickerProps {
  onInsert: (code: string) => void;
  themeMode: ThemeMode;
  cellType: 'sql' | 'dql' | 'markdown';
}

export function SnippetPicker({ onInsert, themeMode, cellType }: SnippetPickerProps) {
  const t = themes[themeMode];
  const [open, setOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter snippets by cell type
  const filtered = SNIPPETS.filter((s) => {
    if (cellType === 'dql') return s.category === 'DQL';
    return s.category === 'SQL' || s.category === 'Analysis';
  });

  // Group by category
  const categories = Array.from(new Set(filtered.map((s) => s.category)));

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleInsert(code: string) {
    onInsert(code);
    setOpen(false);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger button */}
      <button
        title="Insert template snippet"
        onClick={() => setOpen((o) => !o)}
        style={{
          height: 22,
          padding: '0 8px',
          fontSize: 10,
          fontFamily: t.font,
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: open ? t.accent : t.textMuted,
          background: open ? `${t.accent}15` : 'transparent',
          border: `1px solid ${open ? t.accent + '50' : t.btnBorder}`,
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          transition: 'all 0.15s',
          whiteSpace: 'nowrap',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
        </svg>
        Templates
      </button>

      {/* Popover */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 300,
            width: 300,
            maxHeight: 360,
            overflowY: 'auto',
            background: t.modalBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            padding: '6px 0',
          }}
        >
          {categories.map((cat) => (
            <div key={cat}>
              {/* Category label */}
              <div
                style={{
                  padding: '6px 12px 4px',
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: t.font,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: t.textMuted,
                }}
              >
                {cat}
              </div>

              {/* Snippet rows */}
              {filtered
                .filter((s) => s.category === cat)
                .map((snippet) => (
                  <button
                    key={snippet.id}
                    onMouseEnter={() => setHoveredId(snippet.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => handleInsert(snippet.code)}
                    style={{
                      width: '100%',
                      padding: '7px 12px',
                      textAlign: 'left',
                      background: hoveredId === snippet.id ? t.sidebarItemHover : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      transition: 'background 0.1s',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        fontFamily: t.font,
                        color: t.textPrimary,
                        lineHeight: 1.4,
                      }}
                    >
                      {snippet.label}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: t.font,
                        color: t.textMuted,
                        lineHeight: 1.4,
                      }}
                    >
                      {snippet.description}
                    </span>
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
