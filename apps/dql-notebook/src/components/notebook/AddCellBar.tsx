import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useRef, useEffect } from 'react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { CellType } from '../../store/types';
import { parseSemanticDragRef, SEMANTIC_REF_MIME } from '../../editor/semantic-completions';
import { api } from '../../api/client';

interface AddCellBarProps {
  afterId?: string;
}

type PaletteEntry = {
  type: CellType;
  label: string;
  icon: string;
  color: string;
  available: boolean;          // false = "coming soon" tile
  group: 'compute' | 'viz' | 'transform' | 'io';
};

const PALETTE: PaletteEntry[] = [
  { type: 'sql', label: 'SQL', icon: 'SQL', color: '#388bfd', available: true, group: 'compute' },
  { type: 'python', label: 'Python', icon: 'Py', color: '#3572a5', available: false, group: 'compute' },
  { type: 'markdown', label: 'Text', icon: 'Tt', color: '#56d364', available: true, group: 'compute' },
  { type: 'chart', label: 'Chart', icon: '📊', color: '#a371f7', available: true, group: 'viz' },
  { type: 'pivot', label: 'Pivot', icon: '▦', color: '#a371f7', available: true, group: 'viz' },
  { type: 'single_value', label: 'Single value', icon: '123', color: '#a371f7', available: true, group: 'viz' },
  { type: 'table', label: 'Table', icon: '⊞', color: '#79c0ff', available: true, group: 'viz' },
  { type: 'param', label: 'Inputs', icon: '⌸', color: '#e3b341', available: true, group: 'io' },
  { type: 'filter', label: 'Filter', icon: '⟲', color: '#ff7b72', available: true, group: 'transform' },
  { type: 'map', label: 'Map', icon: '◉', color: '#7ce38b', available: false, group: 'viz' },
  { type: 'writeback', label: 'Writeback', icon: '⇧', color: '#d2a8ff', available: false, group: 'io' },
];

const MORE_ENTRIES: PaletteEntry[] = [
  { type: 'dql', label: 'DQL block', icon: '◇', color: '#e3b341', available: true, group: 'compute' },
];

export function AddCellBar({ afterId }: AddCellBarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [hovered, setHovered] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [blockSearchOpen, setBlockSearchOpen] = useState(false);
  const [blockQuery, setBlockQuery] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const blockSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
        setMoreOpen(false);
        setBlockSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  const addCell = (type: CellType) => {
    const cell = makeCell(type);
    dispatch({ type: 'ADD_CELL', cell, afterId });
    setPopoverOpen(false);
    setMoreOpen(false);
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
    setMoreOpen(false);
    setBlockSearchOpen(false);
    setBlockQuery('');
  };

  return (
    <div
      ref={containerRef}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SEMANTIC_REF_MIME)) return;
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        const payload = parseSemanticDragRef(event.dataTransfer.getData(SEMANTIC_REF_MIME));
        if (!payload) return;
        event.preventDefault();
        setDropActive(false);
        const cell = makeCell('sql', payload.reference);
        dispatch({ type: 'ADD_CELL', cell, afterId });
        void api.trackUsage(payload.name);
        window.dispatchEvent(new CustomEvent('dql:semantic-used', { detail: { name: payload.name } }));
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDropActive(false);
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
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          height: 1,
          background: dropActive ? t.accent : hovered || popoverOpen ? t.cellBorderActive : 'transparent',
          transition: 'background 0.15s',
        }}
      />

      {(hovered || popoverOpen || dropActive) && (
        <button
          onClick={() => setPopoverOpen((p) => !p)}
          style={{
            position: 'relative',
            zIndex: 2,
            height: 22,
            padding: '0 10px',
            borderRadius: 11,
            border: `1px solid ${dropActive ? t.accent : t.cellBorderActive}`,
            background: dropActive ? `${t.accent}28` : `${t.accent}18`,
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
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minWidth: 720,
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              alignItems: 'flex-start',
            }}
          >
            {PALETTE.map((entry) => (
              <PaletteTile
                key={entry.type}
                entry={entry}
                onClick={() => {
                  if (!entry.available) return;
                  addCell(entry.type);
                }}
                t={t}
              />
            ))}
            <MoreButton
              open={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              t={t}
            />
          </div>

          {moreOpen && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                padding: '6px 2px 2px',
                borderTop: `1px solid ${t.cellBorder}`,
                alignItems: 'center',
              }}
            >
              {MORE_ENTRIES.map((entry) => (
                <PaletteTile
                  key={entry.type}
                  entry={entry}
                  onClick={() => addCell(entry.type)}
                  t={t}
                />
              ))}
              <button
                onClick={() => {
                  setBlockSearchOpen((v) => !v);
                  setTimeout(() => blockSearchRef.current?.focus(), 50);
                }}
                style={{
                  background: blockSearchOpen ? `${t.accent}18` : 'transparent',
                  border: `1px solid ${t.cellBorder}`,
                  borderRadius: 6,
                  color: t.textSecondary,
                  cursor: 'pointer',
                  fontFamily: t.font,
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '6px 10px',
                }}
              >
                Reference block…
              </button>
            </div>
          )}

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
                  padding: '6px 10px',
                  outline: 'none',
                }}
              />
              <div style={{ maxHeight: 180, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
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

function PaletteTile({
  entry,
  onClick,
  t,
}: {
  entry: PaletteEntry;
  onClick: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const disabled = !entry.available;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={disabled}
      title={disabled ? `${entry.label} — coming soon` : entry.label}
      style={{
        background: disabled
          ? 'transparent'
          : hovered
            ? `${entry.color}18`
            : 'transparent',
        border: `1px solid ${disabled ? t.cellBorder : hovered ? entry.color : t.cellBorder}`,
        borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? t.textMuted : hovered ? entry.color : t.textSecondary,
        fontSize: 11,
        fontFamily: t.font,
        fontWeight: 500,
        padding: '8px 10px',
        minWidth: 84,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        transition: 'all 0.12s',
        opacity: disabled ? 0.5 : 1,
        position: 'relative',
      }}
    >
      <span
        style={{
          fontSize: 14,
          fontFamily: t.fontMono,
          fontWeight: 700,
          color: disabled ? t.textMuted : entry.color,
          letterSpacing: '0.02em',
        }}
      >
        {entry.icon}
      </span>
      <span style={{ letterSpacing: '0.02em' }}>{entry.label}</span>
      {disabled && (
        <span
          style={{
            position: 'absolute',
            top: 3,
            right: 4,
            fontSize: 8,
            color: t.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          soon
        </span>
      )}
    </button>
  );
}

function MoreButton({
  open,
  onClick,
  t,
}: {
  open: boolean;
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
        background: open || hovered ? `${t.accent}12` : 'transparent',
        border: `1px solid ${open ? t.accent : t.cellBorder}`,
        borderRadius: 8,
        cursor: 'pointer',
        color: hovered || open ? t.accent : t.textSecondary,
        fontSize: 11,
        fontFamily: t.font,
        fontWeight: 500,
        padding: '8px 10px',
        minWidth: 84,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        transition: 'all 0.12s',
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>⋯</span>
      <span>More</span>
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
        padding: '6px 8px',
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
