import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { ThemeMode } from '../../store/types';
import { STATUS_COLORS, type BlockEntry } from './block-types';

export type { BlockEntry } from './block-types';

interface BlockPickerProps {
  themeMode: ThemeMode;
  onPick: (block: BlockEntry) => void;
  autoFocus?: boolean;
  /** Compact popover layout (used by AddCellBar). Sidebar passes false for full card layout. */
  compact?: boolean;
}

export function BlockPicker({ themeMode, onPick, autoFocus = true, compact = true }: BlockPickerProps) {
  const t = themes[themeMode];
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getBlockLibrary()
      .then((result) => { if (!cancelled) setBlocks(result.blocks); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (autoFocus) {
      const timer = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  const domains = useMemo(() => [...new Set(blocks.map((b) => b.domain))].sort(), [blocks]);
  const statuses = useMemo(() => [...new Set(blocks.map((b) => b.status))].sort(), [blocks]);

  const filtered = useMemo(() => blocks.filter((b) => {
    if (search) {
      const needle = search.toLowerCase();
      if (!b.name.toLowerCase().includes(needle) && !b.description.toLowerCase().includes(needle)) return false;
    }
    if (domainFilter && b.domain !== domainFilter) return false;
    if (statusFilter && b.status !== statusFilter) return false;
    return true;
  }), [blocks, search, domainFilter, statusFilter]);

  const selectStyle: React.CSSProperties = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.font,
    padding: '4px 6px',
    outline: 'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: compact ? 340 : undefined }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search blocks..."
          style={{ ...selectStyle, flex: 1, padding: '6px 8px' }}
        />
        <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={selectStyle}>
          <option value="">All domains</option>
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">Any</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div
        style={{
          maxHeight: compact ? 220 : 420,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 4,
        }}
      >
        {loading ? (
          <EmptyNote t={t}>Loading blocks...</EmptyNote>
        ) : filtered.length === 0 ? (
          <EmptyNote t={t}>{blocks.length === 0 ? 'No blocks yet. Save a cell as a block to get started.' : 'No blocks match your filters.'}</EmptyNote>
        ) : (
          filtered.map((block) => (
            <BlockRow
              key={block.path}
              block={block}
              onClick={() => onPick(block)}
              t={t}
              compact={compact}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyNote({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <div style={{ padding: 16, textAlign: 'center', fontSize: 11, color: t.textMuted, fontFamily: t.font, fontStyle: 'italic' }}>
      {children}
    </div>
  );
}

function BlockRow({
  block,
  onClick,
  t,
  compact,
}: {
  block: BlockEntry;
  onClick: () => void;
  t: Theme;
  compact: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const statusColor = STATUS_COLORS[block.status] ?? t.textMuted;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? `${t.accent}14` : 'transparent',
        border: 'none',
        borderBottom: `1px solid ${t.cellBorder}`,
        cursor: 'pointer',
        padding: compact ? '8px 10px' : '10px 12px',
        textAlign: 'left' as const,
        fontFamily: t.font,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary }}>{block.name}</span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: statusColor,
            background: `${statusColor}18`,
            padding: '1px 6px',
            borderRadius: 4,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {block.status}
        </span>
      </div>
      {block.description && (
        <div
          style={{
            fontSize: 11,
            color: t.textMuted,
            lineHeight: 1.3,
            marginBottom: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {block.description}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: t.textMuted }}>
        <span style={{ background: t.pillBg, padding: '1px 6px', borderRadius: 4 }}>{block.domain || 'no domain'}</span>
        {block.owner && <span>by {block.owner}</span>}
      </div>
    </button>
  );
}
