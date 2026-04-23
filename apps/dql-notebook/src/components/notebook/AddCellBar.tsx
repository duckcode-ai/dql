import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useRef, useEffect } from 'react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { CellType } from '../../store/types';
import { parseSemanticDragRef, SEMANTIC_REF_MIME } from '../../editor/semantic-completions';
import { api } from '../../api/client';
import { BlockPicker, type BlockEntry } from '../blocks/BlockPicker';
import { extractSqlFromText } from '../../utils/block-studio';

interface AddCellBarProps {
  afterId?: string;
}

type PaletteEntry = {
  type: CellType | 'block';
  label: string;
  icon: string;
  color: string;
  group: 'compute' | 'viz' | 'transform' | 'io' | 'library';
};

const PALETTE: PaletteEntry[] = [
  { type: 'block', label: 'Block', icon: '◆', color: '#3fb950', group: 'library' },
  { type: 'chat', label: 'Chat', icon: '✶', color: '#f0883e', group: 'compute' },
  { type: 'sql', label: 'SQL', icon: 'SQL', color: '#388bfd', group: 'compute' },
  { type: 'markdown', label: 'Text', icon: 'Tt', color: '#56d364', group: 'compute' },
  { type: 'chart', label: 'Chart', icon: '📊', color: '#a371f7', group: 'viz' },
  { type: 'pivot', label: 'Pivot', icon: '▦', color: '#a371f7', group: 'viz' },
  { type: 'single_value', label: 'Single value', icon: '123', color: '#a371f7', group: 'viz' },
  { type: 'table', label: 'Table', icon: '⊞', color: '#79c0ff', group: 'viz' },
  { type: 'param', label: 'Inputs', icon: '⌸', color: '#e3b341', group: 'io' },
  { type: 'filter', label: 'Filter', icon: '⟲', color: '#ff7b72', group: 'transform' },
];

export function AddCellBar({ afterId }: AddCellBarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [hovered, setHovered] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
        setBlockPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  const closeAll = () => {
    setPopoverOpen(false);
    setBlockPickerOpen(false);
  };

  const addCell = (type: CellType) => {
    const cell = makeCell(type);
    dispatch({ type: 'ADD_CELL', cell, afterId });
    // SQL authors need the schema catalog visible to pick tables/columns.
    if (type === 'sql') dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'schema' });
    closeAll();
  };

  const insertBoundBlockCell = async (block: BlockEntry) => {
    let payload;
    try {
      payload = await api.openBlockStudio(block.path);
    } catch (error) {
      console.error('Failed to bind block cell', error);
      window.alert(`Couldn't load block ${block.path}. Check the console for details.`);
      closeAll();
      return;
    }
    const sqlBody = extractSqlFromText(payload.source) ?? payload.source;
    const cell = makeCell('sql', sqlBody);
    cell.name = block.name;
    cell.blockBinding = { path: block.path, state: 'bound', originalContent: sqlBody };
    dispatch({ type: 'ADD_CELL', cell, afterId });
    closeAll();
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
            minWidth: 760,
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'nowrap',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            {PALETTE.map((entry) => (
              <PaletteTile
                key={entry.type}
                entry={entry}
                active={entry.type === 'block' && blockPickerOpen}
                onClick={() => {
                  if (entry.type === 'block') {
                    setBlockPickerOpen((v) => !v);
                    return;
                  }
                  addCell(entry.type as CellType);
                }}
                t={t}
              />
            ))}
          </div>

          {blockPickerOpen && (
            <div
              style={{
                padding: '6px 2px 2px',
                borderTop: `1px solid ${t.cellBorder}`,
              }}
            >
              <BlockPicker
                themeMode={state.themeMode}
                onPick={(block) => void insertBoundBlockCell(block)}
              />
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
  active = false,
}: {
  entry: PaletteEntry;
  onClick: () => void;
  t: Theme;
  active?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const highlighted = active || hovered;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={entry.label}
      style={{
        background: highlighted ? `${entry.color}18` : 'transparent',
        border: `1px solid ${highlighted ? entry.color : t.cellBorder}`,
        borderRadius: 8,
        cursor: 'pointer',
        color: highlighted ? entry.color : t.textSecondary,
        fontSize: 11,
        fontFamily: t.font,
        fontWeight: 500,
        padding: '8px 6px',
        minWidth: 76,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        transition: 'all 0.12s',
      }}
    >
      <span
        style={{
          fontSize: 14,
          fontFamily: t.fontMono,
          fontWeight: 700,
          color: entry.color,
          letterSpacing: '0.02em',
        }}
      >
        {entry.icon}
      </span>
      <span style={{ letterSpacing: '0.02em' }}>{entry.label}</span>
    </button>
  );
}

