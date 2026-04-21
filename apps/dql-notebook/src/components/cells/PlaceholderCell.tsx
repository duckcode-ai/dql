import React from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, ThemeMode } from '../../store/types';

interface PlaceholderCellProps {
  cell: Cell;
  themeMode: ThemeMode;
  title: string;
  subtitle: string;
  color: string;
  badge?: string;
}

/**
 * Shared scaffold for cell types whose full renderer is not yet implemented.
 * Renders a typed, themed card so the palette is immediately usable; the
 * dedicated renderer replaces this in follow-up tracks (C for chart builder,
 * D for transform cells, etc.).
 */
export function PlaceholderCell({ cell, themeMode, title, subtitle, color, badge }: PlaceholderCellProps) {
  const t: Theme = themes[themeMode];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: '14px 16px',
        gap: 8,
        fontFamily: t.font,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: t.fontMono,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color,
            textTransform: 'uppercase',
            padding: '2px 6px',
            borderRadius: 3,
            background: `${color}18`,
          }}
        >
          {title}
        </span>
        {cell.name && (
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>
        )}
        {badge && (
          <span
            style={{
              fontSize: 9,
              fontFamily: t.fontMono,
              fontWeight: 600,
              letterSpacing: '0.1em',
              color: t.textMuted,
              textTransform: 'uppercase',
              marginLeft: 'auto',
              padding: '2px 6px',
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 3,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>{subtitle}</div>
    </div>
  );
}
