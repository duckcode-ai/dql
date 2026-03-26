import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useRef, useEffect } from 'react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { CellType } from '../../store/types';

interface AddCellBarProps {
  afterId?: string;
}

const CELL_TYPE_LABELS: { type: CellType; label: string; color: string }[] = [
  { type: 'sql', label: 'SQL', color: '#388bfd' },
  { type: 'markdown', label: 'Markdown', color: '#56d364' },
  { type: 'dql', label: 'DQL', color: '#e3b341' },
  { type: 'param', label: 'Param', color: '#e3b341' },
];

export function AddCellBar({ afterId }: AddCellBarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [hovered, setHovered] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [blockSearchOpen, setBlockSearchOpen] = useState(false);
  const [blockQuery, setBlockQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const blockSearchRef = useRef<HTMLInputElement>(null);

  // Close popover when clicking outside
  useEffect(() => {
    if (!popoverOpen) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  const addCell = (type: CellType) => {
    const cell = makeCell(type);
    dispatch({ type: 'ADD_CELL', cell, afterId });
    setPopoverOpen(false);
    setBlockSearchOpen(false);
  };

  const blockFiles = state.files.filter((f) => f.type === 'block');
  const filteredBlocks = blockQuery
    ? blockFiles.filter((f) => f.name.toLowerCase().includes(blockQuery.toLowerCase()))
    : blockFiles;

  const insertBlockRef = (file: { path: string }) => {
    const cell = makeCell('sql', `-- Block: ${file.path}\n@include('${file.path}')`);
    dispatch({ type: 'ADD_CELL', cell, afterId });
    setPopoverOpen(false);
    setBlockSearchOpen(false);
    setBlockQuery('');
  };

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
      }}
      style={{
        position: 'relative',
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
      }}
    >
      {/* Horizontal line */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          height: 1,
          background: hovered || popoverOpen ? t.cellBorderActive : 'transparent',
          transition: 'background 0.15s',
        }}
      />

      {/* + button */}
      {(hovered || popoverOpen) && (
        <button
          onClick={() => setPopoverOpen((p) => !p)}
          style={{
            position: 'relative',
            zIndex: 2,
            height: 22,
            padding: '0 10px',
            borderRadius: 11,
            border: `1px solid ${t.cellBorderActive}`,
            background: `${t.accent}18`,
            color: t.accent,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: t.font,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            transition: 'background 0.15s',
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>+</span>
          Add cell
        </button>
      )}

      {/* Popover */}
      {popoverOpen && (
        <div
          style={{
            position: 'absolute',
            top: 26,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            background: t.modalBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ display: 'flex', gap: 4 }}>
            {CELL_TYPE_LABELS.map(({ type, label, color }) => (
              <CellTypeButton
                key={type}
                label={label}
                color={color}
                onClick={() => addCell(type)}
                t={t}
              />
            ))}
            <CellTypeButton
              label="Block"
              color="#d2a8ff"
              onClick={() => {
                setBlockSearchOpen((p) => !p);
                setTimeout(() => blockSearchRef.current?.focus(), 50);
              }}
              t={t}
            />
          </div>

          {/* Block search panel */}
          {blockSearchOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 2px' }}>
              <input
                ref={blockSearchRef}
                value={blockQuery}
                onChange={(e) => setBlockQuery(e.target.value)}
                placeholder="Search blocks..."
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 4,
                  color: t.textPrimary,
                  fontSize: 11,
                  fontFamily: t.font,
                  padding: '4px 8px',
                  outline: 'none',
                }}
              />
              <div style={{ maxHeight: 160, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {filteredBlocks.length === 0 ? (
                  <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, padding: '4px 8px', fontStyle: 'italic' }}>
                    {blockFiles.length === 0 ? 'No blocks yet' : 'No matches'}
                  </div>
                ) : (
                  filteredBlocks.map((file) => (
                    <BlockSearchItem key={file.path} file={file} onClick={() => insertBlockRef(file)} t={t} />
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CellTypeButton({
  label,
  color,
  onClick,
  t,
}: {
  label: string;
  color: string;
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
        background: hovered ? `${color}18` : 'transparent',
        border: `1px solid ${hovered ? color : t.cellBorder}`,
        borderRadius: 6,
        cursor: 'pointer',
        color: hovered ? color : t.textSecondary,
        fontSize: 11,
        fontFamily: t.fontMono,
        fontWeight: 600,
        padding: '4px 10px',
        letterSpacing: '0.04em',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap' as const,
      }}
    >
      {label}
    </button>
  );
}

function BlockSearchItem({
  file,
  onClick,
  t,
}: {
  file: { name: string; path: string };
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
        background: hovered ? t.sidebarItemHover : 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        color: t.textPrimary,
        fontSize: 11,
        fontFamily: t.font,
        padding: '4px 8px',
        textAlign: 'left' as const,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        transition: 'background 0.1s',
      }}
    >
      <span style={{ fontWeight: 500 }}>{file.name.replace(/\.dql$/, '')}</span>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>{file.path}</span>
    </button>
  );
}
