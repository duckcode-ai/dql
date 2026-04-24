import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Cell } from '../../store/types';

interface OutlinePanelProps {
  onNavigate: (cellId: string) => void;
}

function getOutlineLabel(cell: Cell): string | null {
  if (cell.type === 'markdown') {
    // Extract first heading
    const match = cell.content.match(/^#{1,6}\s+(.+)$/m);
    if (match) return match[1];
    // Fall back to first non-empty line
    const firstLine = cell.content.split('\n').find((l) => l.trim());
    return firstLine?.trim() || null;
  }
  if (cell.name) return cell.name;
  return null;
}

function getHeadingLevel(cell: Cell): number {
  if (cell.type !== 'markdown') return 0;
  const match = cell.content.match(/^(#{1,6})\s/m);
  return match ? match[1].length : 0;
}

function CellIcon({ cell, t }: { cell: Cell; t: Theme }) {
  if (cell.type === 'markdown') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ color: t.textMuted, flexShrink: 0 }}>
        <path d="M14.85 3H7.39L6.74.translateX(.5.25C6.45.11 6.23 0 6 0H1.75A1.75 1.75 0 0 0 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25V4.75A1.75 1.75 0 0 0 14.25 3ZM1.5 1.75a.25.25 0 0 1 .25-.25H6l.5 1.5H1.5Z" />
        <path d="M2 2h12v12H2z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  const color = cell.type === 'sql' ? t.accent : t.warning;
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ color, flexShrink: 0 }}>
      <path d="M0 5.75C0 4.784.784 4 1.75 4h12.5c.966 0 1.75.784 1.75 1.75v4.5A1.75 1.75 0 0 1 14.25 12H1.75A1.75 1.75 0 0 1 0 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v4.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-4.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  );
}

export function OutlinePanel({ onNavigate }: OutlinePanelProps) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  if (!state.activeFile) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
          textAlign: 'center',
        }}
      >
        <div>
          <svg
            width="32"
            height="32"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{ color: t.textMuted, marginBottom: 8 }}
          >
            <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM1.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z" />
          </svg>
          <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
            Open a notebook to see its outline.
          </div>
        </div>
      </div>
    );
  }

  const items = state.cells
    .map((cell) => ({ cell, label: getOutlineLabel(cell) }))
    .filter((item): item is { cell: Cell; label: string } => item.label !== null);

  if (items.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
          color: t.textMuted,
          fontSize: 12,
          fontFamily: t.font,
          fontStyle: 'italic',
          textAlign: 'center',
        }}
      >
        No named cells or headings yet.
        <br />
        Name your cells or add markdown headings.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
      {items.map(({ cell, label }) => {
        const level = getHeadingLevel(cell);
        const indent = cell.type === 'markdown' ? Math.max(0, (level - 1) * 12) : 0;
        return (
          <OutlineItem
            key={cell.id}
            cell={cell}
            label={label}
            indent={indent}
            onClick={() => onNavigate(cell.id)}
            t={t}
          />
        );
      })}
    </div>
  );
}

function OutlineItem({
  cell,
  label,
  indent,
  onClick,
  t,
}: {
  cell: Cell;
  label: string;
  indent: number;
  onClick: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `4px 10px 4px ${14 + indent}px`,
        background: hovered ? t.sidebarItemHover : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: hovered ? t.textPrimary : t.textSecondary,
        fontSize: 12,
        fontFamily: cell.type === 'markdown' ? t.font : t.fontMono,
        textAlign: 'left' as const,
        transition: 'background 0.1s, color 0.1s',
        overflow: 'hidden',
      }}
    >
      <CellIcon cell={cell} t={t} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          fontWeight: cell.type === 'markdown' && getHeadingLevel(cell) === 1 ? 600 : 400,
        }}
      >
        {label}
      </span>
    </button>
  );
}
