import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useRef, useEffect } from 'react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Cell, CellType } from '../../store/types';
import { parseSemanticDragRef, SEMANTIC_REF_MIME } from '../../editor/semantic-completions';
import { api } from '../../api/client';
import { BlockPicker, type BlockEntry } from '../blocks/BlockPicker';
import { extractSqlFromText } from '../../utils/block-studio';
import { AiSqlDraftDialog, type AiSqlDraftMeta } from '../agent/AiSqlDraftDialog';
import { SaveAsBlockModal } from '../modals/SaveAsBlockModal';
import {
  BlockIcon,
  SQLCellIcon,
  ChartCellIcon,
  PivotCellIcon,
  SingleValueCellIcon,
  ParamCellIcon,
  FilterCellIcon,
  ChatCellIcon,
  FileText,
  Sparkles,
  Table,
} from '@duckcodeailabs/dql-ui/icons';

interface AddCellBarProps {
  afterId?: string;
}

type PaletteType = CellType | 'block' | 'ai_sql';

type PaletteEntry = {
  type: PaletteType;
  label: string;
  shortLabel?: string;
  Icon: React.ComponentType<any>;
  color: string;
  group: 'compute' | 'viz' | 'transform' | 'io' | 'library';
};

// v1.4 pill-menu — color aligned to DQL cell-type palette (New-UI handoff)
const PALETTE: PaletteEntry[] = [
  { type: 'block', label: 'Block', Icon: BlockIcon, color: '#6b8afd', group: 'library' },
  { type: 'chat', label: 'Chat', Icon: ChatCellIcon, color: '#8a8f9b', group: 'compute' },
  { type: 'ai_sql', label: 'AI', Icon: Sparkles, color: '#f0883e', group: 'compute' },
  { type: 'sql', label: 'SQL', Icon: SQLCellIcon, color: '#3b8ef0', group: 'compute' },
  { type: 'markdown', label: 'Text', Icon: FileText, color: '#2fb97a', group: 'compute' },
  { type: 'chart', label: 'Chart', Icon: ChartCellIcon, color: '#b067f7', group: 'viz' },
  { type: 'pivot', label: 'Pivot', Icon: PivotCellIcon, color: '#e5a84d', group: 'viz' },
  { type: 'single_value', label: 'Value', Icon: SingleValueCellIcon, color: '#b067f7', group: 'viz' },
  { type: 'table', label: 'Table', Icon: Table, color: '#5dd1c8', group: 'viz' },
  { type: 'param', label: 'Inputs', Icon: ParamCellIcon, color: '#9aa0ae', group: 'io' },
  { type: 'filter', label: 'Filter', Icon: FilterCellIcon, color: '#f26a6a', group: 'transform' },
];

export function AddCellBar({ afterId }: AddCellBarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [hovered, setHovered] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [aiSqlOpen, setAiSqlOpen] = useState(false);
  const [aiBlockDraft, setAiBlockDraft] = useState<{ cell: Cell; meta: AiSqlDraftMeta } | null>(null);
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

  const insertAiSqlCell = (sql: string, meta: { question: string; title?: string }) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    const cell = makeCell('sql', trimmed);
    cell.name = uniqueAiSqlCellName(meta.title || meta.question, state.cells);
    dispatch({ type: 'ADD_CELL', cell, afterId });
    setAiSqlOpen(false);
    closeAll();
  };

  const createAiBlock = (sql: string, meta: AiSqlDraftMeta) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    const cell = makeCell('sql', trimmed);
    cell.name = uniqueAiSqlCellName(meta.title || meta.question, state.cells);
    setAiBlockDraft({ cell, meta });
    setAiSqlOpen(false);
    closeAll();
  };

  return (
    <div
      ref={containerRef}
      data-testid="add-cell-bar"
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
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        setHovered(true);
        setPopoverOpen(true);
      }}
      style={{
        position: 'relative',
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: popoverOpen ? 'default' : 'pointer',
      }}
    >
      {(hovered || popoverOpen || dropActive) && (
        <button
          aria-label="Add cell"
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
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: blockPickerOpen ? 'min(760px, calc(100vw - 48px))' : 'max-content',
            maxWidth: 'calc(100vw - 48px)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 4,
              flexWrap: 'nowrap',
              alignItems: 'center',
              justifyContent: 'flex-start',
              overflowX: 'auto',
              overflowY: 'hidden',
              maxWidth: '100%',
              paddingBottom: 1,
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
                  if (entry.type === 'ai_sql') {
                    setAiSqlOpen(true);
                    closeAll();
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
      {aiSqlOpen && (
        <AiSqlDraftDialog
          mode="notebook"
          themeMode={state.themeMode}
          contextLabel={state.activeFile?.name ?? state.notebookTitle ?? 'Notebook'}
          upstreamSql={findUpstreamSqlForInsert(state.cells, afterId)}
          onClose={() => setAiSqlOpen(false)}
          onInsertSql={insertAiSqlCell}
          onCreateBlock={createAiBlock}
        />
      )}
      {aiBlockDraft && (
        <SaveAsBlockModal
          cell={aiBlockDraft.cell}
          initialContent={aiBlockDraft.meta.blockSource ?? aiBlockDraft.cell.content}
          initialName={aiBlockDraft.meta.title}
          initialDescription={aiBlockDraft.meta.description}
          initialDomain={aiBlockDraft.meta.domain}
          initialOwner={aiBlockDraft.meta.owner}
          initialTags={aiBlockDraft.meta.tags}
          onClose={() => setAiBlockDraft(null)}
          onSaved={({ path, name }) => {
            dispatch({
              type: 'FILE_ADDED',
              file: { name, path, type: 'block', folder: 'blocks' },
            });
          }}
        />
      )}
    </div>
  );
}

function findUpstreamSqlForInsert(cells: Cell[], afterId?: string): string | undefined {
  const startIndex = afterId
    ? cells.findIndex((cell) => cell.id === afterId)
    : cells.length - 1;
  const fromIndex = startIndex >= 0 ? startIndex : cells.length - 1;
  for (let i = fromIndex; i >= 0; i--) {
    const cell = cells[i];
    if ((cell.type === 'sql' || cell.type === 'dql') && cell.content?.trim()) {
      return cell.content;
    }
  }
  return undefined;
}

function uniqueAiSqlCellName(title: string | undefined, cells: Cell[]): string {
  const fallback = 'ai_sql_draft';
  const base = (title || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || fallback;
  const taken = new Set(cells.map((cell) => cell.name).filter(Boolean));
  let candidate = base;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  return candidate;
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
  const Icon = entry.Icon;
  return (
    <button
      aria-label={entry.type === 'ai_sql' ? 'Ask AI to build SQL' : `Add ${entry.label} cell`}
      data-testid={`add-cell-${entry.type}`}
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
        fontWeight: 600,
        padding: '5px 6px',
        width: 52,
        height: 48,
        flex: '0 0 52px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        transition: 'all 0.12s',
      }}
    >
      <span style={{ color: entry.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={16} strokeWidth={1.85} />
      </span>
      <span
        style={{
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          letterSpacing: 0,
        }}
      >
        {entry.shortLabel ?? entry.label}
      </span>
    </button>
  );
}
