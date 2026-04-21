import React, { useMemo, useRef, useState, useEffect } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, ThemeMode } from '../../store/types';
import { findHandleNames } from '../../utils/handles';

interface DataframeChipProps {
  cells: Cell[];
  index: number;
  content: string;
  themeMode: ThemeMode;
  onInsertHandle: (handleName: string) => void;
}

function describeCellType(cell: Cell): string {
  if (cell.type === 'param') return 'param';
  return cell.type.toUpperCase();
}

export function DataframeChip({ cells, index, content, themeMode, onInsertHandle }: DataframeChipProps) {
  const t: Theme = themes[themeMode];
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const upstream = useMemo(() => {
    return cells
      .slice(0, index)
      .filter((c) => c.name && c.name.trim().length > 0);
  }, [cells, index]);

  const active = useMemo(() => findHandleNames(content), [content]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const primaryLabel = active.length === 0
    ? 'df'
    : active.length === 1
      ? `df: ${active[0]}`
      : `df: ${active[0]} +${active.length - 1}`;

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Insert an upstream dataframe handle ({{name}})"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          fontFamily: t.fontMono,
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: active.length > 0 ? t.accent : t.textMuted,
          background: active.length > 0 ? `${t.accent}14` : 'transparent',
          border: `1px solid ${active.length > 0 ? `${t.accent}55` : t.btnBorder}`,
          borderRadius: 4,
          padding: '1px 6px',
          cursor: 'pointer',
          textTransform: 'lowercase',
          transition: 'border-color 0.15s, color 0.15s',
        }}
      >
        {primaryLabel}
        <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 20,
            minWidth: 220,
            maxWidth: 280,
            background: t.cellBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 6,
            boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontFamily: t.font,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: t.textMuted,
              textTransform: 'uppercase',
              padding: '4px 8px 2px',
            }}
          >
            Upstream dataframes
          </div>
          {upstream.length === 0 && (
            <div
              style={{
                fontSize: 11,
                fontFamily: t.font,
                color: t.textMuted,
                padding: '6px 8px 8px',
                lineHeight: 1.4,
              }}
            >
              No named upstream cells yet. Name a cell (click its header) to expose it here.
            </div>
          )}
          {upstream.map((c) => {
            const isActive = c.name ? active.includes(c.name) : false;
            return (
              <button
                key={c.id}
                onClick={() => {
                  if (c.name) onInsertHandle(c.name);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  background: isActive ? `${t.accent}14` : 'transparent',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: t.textPrimary,
                  fontFamily: t.fontMono,
                  fontSize: 11,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = t.tableRowHover;
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    fontFamily: t.fontMono,
                    fontWeight: 700,
                    color: t.textMuted,
                    minWidth: 36,
                  }}
                >
                  {describeCellType(c)}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </span>
                {isActive && (
                  <span style={{ fontSize: 9, color: t.accent, fontWeight: 700, letterSpacing: '0.08em' }}>IN USE</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
