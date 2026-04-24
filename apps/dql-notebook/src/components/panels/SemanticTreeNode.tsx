import React, { useState } from 'react';
import type { Theme } from '../../themes/notebook-theme';

interface SemanticTreeNodeProps {
  label: string;
  depth?: number;
  badge?: string;
  badgeColor?: string;
  count?: number;
  expanded?: boolean;
  favorite?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onToggle?: () => void;
  onFavoriteToggle?: () => void;
  onDragStart?: React.DragEventHandler<HTMLButtonElement>;
  title?: string;
  muted?: boolean;
  t: Theme;
}

export function SemanticTreeNode({
  label,
  depth = 0,
  badge,
  badgeColor,
  count,
  expanded,
  favorite,
  selected,
  onClick,
  onDoubleClick,
  onToggle,
  onFavoriteToggle,
  onDragStart,
  title,
  muted,
  t,
}: SemanticTreeNodeProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={title}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `5px 8px 5px ${10 + depth * 14}px`,
        background: selected ? `${t.accent}18` : hovered ? t.sidebarItemHover : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: muted ? t.textMuted : t.textPrimary,
        fontSize: 12,
        fontFamily: t.font,
        textAlign: 'left',
      }}
    >
      {onToggle ? (
        <span
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          style={{
            display: 'inline-flex',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            color: t.textMuted,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M3 2l4 3-4 3V2Z" />
          </svg>
        </span>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {badge && (
        <span
          style={{
            fontSize: 9,
            fontFamily: t.fontMono,
            color: badgeColor ?? t.accent,
            background: `${badgeColor ?? t.accent}18`,
            borderRadius: 4,
            padding: '1px 4px',
            flexShrink: 0,
          }}
        >
          {badge}
        </span>
      )}
      {typeof count === 'number' && (
        <span style={{ fontSize: 10, color: t.textMuted, background: t.pillBg, borderRadius: 999, padding: '1px 6px', flexShrink: 0 }}>
          {count}
        </span>
      )}
      {typeof favorite === 'boolean' && (
        <span
          onClick={(event) => {
            event.stopPropagation();
            onFavoriteToggle?.();
          }}
          style={{ color: favorite ? '#e3b341' : t.textMuted, display: 'inline-flex', flexShrink: 0 }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.25l1.938 3.927 4.335.63-3.136 3.056.74 4.318L8 11.143l-3.877 2.038.74-4.318L1.727 5.807l4.335-.63L8 1.25Z" />
          </svg>
        </span>
      )}
    </button>
  );
}
