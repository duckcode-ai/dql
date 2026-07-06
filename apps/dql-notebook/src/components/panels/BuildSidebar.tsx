import React, { useEffect, useState } from 'react';
import { Blocks, Box, Calendar, ChevronDown, ChevronRight, Database, FileText, Hash, Layers, Plus, Search, Type } from 'lucide-react';
import { api } from '../../api/client';
import { insertSemanticReference } from '../../editor/semantic-completions';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type { NotebookFile, SchemaTable, SemanticTreeNode } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import type { BlockEntry } from '../blocks/block-types';
import { SemanticTreeView } from './CatalogTree';

export type BuildTab = 'notebooks' | 'semantic' | 'database' | 'blocks';

const TABS: { id: BuildTab; label: string; icon: React.ComponentType<any> }[] = [
  { id: 'notebooks', label: 'Notebooks', icon: FileText },
  { id: 'semantic', label: 'Semantic', icon: Layers },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'blocks', label: 'Blocks', icon: Blocks },
];

const STATUS_COLOR: Record<string, string> = {
  certified: '#16a34a', published: '#16a34a', deprecated: '#ef4444',
  draft: '#d97706', pending: '#d97706', review: '#2563eb',
};

/**
 * Unified, database-studio-style sidebar for the Build section. Four clean tabs —
 * Notebooks (list + new), Semantic (metrics/dimensions), Database (tables/columns),
 * Blocks — with no studio/setup chrome. Click a notebook to open it; click a
 * metric/dimension/table/column to insert it into the active editor (or a new SQL
 * cell); click a block to open it in the builder.
 */
export function BuildSidebar({ defaultTab, onOpenFile, tabs, onInsertText }: {
  defaultTab?: BuildTab;
  onOpenFile?: (file: NotebookFile) => void;
  /** Which tabs to show (default all four). Block Studio omits 'notebooks'. */
  tabs?: BuildTab[];
  /** Override the insert action (e.g. Block Studio appends to the block draft). */
  onInsertText?: (text: string) => void;
}) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const visibleTabs = tabs ? TABS.filter((x) => tabs.includes(x.id)) : TABS;
  const [tab, setTab] = useState<BuildTab>(defaultTab ?? visibleTabs[0]?.id ?? 'notebooks');
  const [search, setSearch] = useState('');

  useEffect(() => { if (defaultTab) setTab(defaultTab); }, [defaultTab]);

  // Host-provided insert wins; otherwise insert into the focused editor, else a new SQL cell.
  const insertText = onInsertText ?? ((text: string) => {
    if (!insertSemanticReference(text)) {
      dispatch({ type: 'ADD_CELL', cell: makeCell('sql', text) });
    }
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: t.cellBg, fontFamily: t.font }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, padding: '6px 6px 0', borderBottom: `1px solid ${t.headerBorder}` }}>
        {visibleTabs.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              title={label}
              style={{
                flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: 'none', borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
                background: 'transparent', color: active ? t.accent : t.textMuted, cursor: 'pointer',
                fontSize: 11, fontWeight: 700, padding: '6px 3px 7px',
              }}
            >
              <Icon size={13} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            </button>
          );
        })}
      </div>

      {/* Search (all tabs except notebooks, which has its own + button) */}
      {tab !== 'notebooks' && (
        <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}` }}>
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: t.textMuted }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${tab}…`}
              style={{
                width: '100%', boxSizing: 'border-box', background: t.inputBg, border: `1px solid ${t.inputBorder}`,
                borderRadius: 6, color: t.textPrimary, fontSize: 12, fontFamily: t.font, padding: '6px 8px 6px 26px', outline: 'none',
              }}
            />
          </div>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'notebooks' && onOpenFile && <NotebooksList t={t} onOpenFile={onOpenFile} />}
        {tab === 'semantic' && <SemanticList t={t} search={search} onInsert={insertText} />}
        {tab === 'database' && <DatabaseList t={t} search={search} onInsert={insertText} />}
        {tab === 'blocks' && <BlocksList t={t} search={search} />}
      </div>
    </div>
  );
}

const rowStyle = (t: Theme, active = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0, boxSizing: 'border-box',
  padding: '6px 10px', border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
  background: active ? `${t.accent}14` : 'transparent', cursor: 'pointer', textAlign: 'left',
  fontFamily: t.font, color: t.textPrimary,
});

function EmptyNote({ text, t }: { text: string; t: Theme }) {
  return <div style={{ padding: '16px 12px', fontSize: 11.5, color: t.textMuted, textAlign: 'center' }}>{text}</div>;
}

/** A data-type-aware icon for a database column, database-studio style. */
function columnTypeIcon(type: string): React.ComponentType<any> {
  const s = (type ?? '').toLowerCase();
  if (/int|float|numeric|decimal|double|real|number|bigint|money|serial/.test(s)) return Hash;
  if (/date|time|timestamp|interval/.test(s)) return Calendar;
  return Type;
}

function NotebooksList({ t, onOpenFile }: { t: Theme; onOpenFile: (file: NotebookFile) => void }) {
  const { state, dispatch } = useNotebook();
  const notebooks = Array.from(
    new Map(state.files.filter((f) => f.type === 'notebook').map((f) => [f.path, f])).values(),
  ).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div>
      <button
        type="button"
        onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box',
          padding: '8px 10px', border: 'none', borderBottom: `1px solid ${t.headerBorder}`,
          background: 'transparent', color: t.accent, cursor: 'pointer', fontFamily: t.font, fontSize: 12, fontWeight: 700,
        }}
      >
        <Plus size={14} /> New notebook
      </button>
      {notebooks.length === 0 ? (
        <EmptyNote text="No notebooks yet. Create one to start building." t={t} />
      ) : (
        notebooks.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => onOpenFile(file)}
            style={rowStyle(t, state.activeFile?.path === file.path)}
            title={file.path}
          >
            <FileText size={13} color={t.textMuted} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
              {file.name.replace(/\.dqln?$|\.ipynb$/i, '')}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function SemanticList({ t, search, onInsert }: { t: Theme; search: string; onInsert: (text: string) => void }) {
  const { state } = useNotebook();
  const [tree, setTree] = useState<SemanticTreeNode | null>(null);
  const [loading, setLoading] = useState(true);

  // The sidebar owns the semantic-layer fetch (the old SemanticPanel did this on
  // mount). Without it, nothing shows in the notebook. Cheap + cached server-side.
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getSemanticTree()
      .then((next) => { if (active) setTree(next); })
      .catch(() => { if (active) setTree(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  if (loading && !tree) return <EmptyNote text="Loading semantic layer…" t={t} />;
  if (!tree || (tree.children?.length ?? 0) === 0) return <EmptyNote text="No semantic layer imported yet." t={t} />;
  return <SemanticTreeView tree={tree} themeMode={state.themeMode} search={search} onInsert={onInsert} />;
}

function DatabaseList({ t, search, onInsert }: { t: Theme; search: string; onInsert: (text: string) => void }) {
  const { state } = useNotebook();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const q = search.trim().toLowerCase();
  const tables = (state.schemaTables ?? []).filter((tb: SchemaTable) =>
    !q || tb.name.toLowerCase().includes(q) || tb.columns.some((c) => c.name.toLowerCase().includes(q)));

  if (tables.length === 0) {
    return <EmptyNote text={q ? 'No matches.' : 'Connect a database to browse tables.'} t={t} />;
  }
  const toggle = (name: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return (
    <div>
      {tables.map((tb) => {
        const open = expanded.has(tb.name);
        return (
          <div key={tb.path || tb.name}>
            <div style={{ ...rowStyle(t), justifyContent: 'flex-start' }}>
              <button
                type="button"
                onClick={() => toggle(tb.name)}
                title={open ? 'Collapse' : 'Expand columns'}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: t.textMuted, display: 'flex', padding: 0 }}
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <button
                type="button"
                onClick={() => onInsert(`SELECT * FROM ${tb.path || tb.name} LIMIT 100`)}
                title="Insert a SELECT for this table"
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: t.textPrimary, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 7, padding: 0, fontFamily: t.font }}
              >
                <Database size={13} color={t.accent} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontFamily: t.fontMono }}>{tb.name}</span>
                <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{tb.columns.length}</span>
              </button>
            </div>
            {open && tb.columns.map((col) => {
              const ColIcon = columnTypeIcon(col.type);
              return (
                <button
                  key={col.name}
                  type="button"
                  onClick={() => onInsert(col.name)}
                  title={`Insert column ${col.name}`}
                  style={{ ...rowStyle(t), paddingLeft: 32, gap: 7 }}
                >
                  <ColIcon size={12} color={t.textMuted} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontFamily: t.fontMono, color: t.textSecondary }}>{col.name}</span>
                  <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{col.type}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function BlocksList({ t, search }: { t: Theme; search: string }) {
  const { state, dispatch } = useNotebook();
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const blockFileKey = state.files.filter((f) => f.type === 'block').map((f) => f.path).sort().join('|');

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getBlockLibrary()
      .then((r) => { if (active) setBlocks(r.blocks); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [blockFileKey]);

  const q = search.trim().toLowerCase();
  const uniqueBlocks = Array.from(new Map(blocks.map((b) => [b.path, b])).values());
  const filtered = uniqueBlocks.filter((b) => !q || b.name.toLowerCase().includes(q) || (b.description ?? '').toLowerCase().includes(q));

  const open = (block: BlockEntry) => {
    const file = { name: block.path.split('/').pop() ?? block.name, path: block.path, type: 'block' as const, folder: 'blocks' };
    if (!state.files.some((f) => f.path === block.path)) dispatch({ type: 'FILE_ADDED', file });
    void api.openBlockStudio(block.path).then((payload) => dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload }));
  };

  if (loading) return <EmptyNote text="Loading blocks…" t={t} />;
  if (filtered.length === 0) return <EmptyNote text={blocks.length === 0 ? 'No blocks yet.' : 'No matches.'} t={t} />;
  return <div>{filtered.map((block) => <BlockRow key={block.path} block={block} t={t} onOpen={() => open(block)} />)}</div>;
}

function BlockRow({ block, t, onOpen }: { block: BlockEntry; t: Theme; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      {/* Same object-display pattern as Database/Semantic: name row → expand. */}
      <div style={{ ...rowStyle(t), justifyContent: 'flex-start' }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse' : 'Expand'}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: t.textMuted, display: 'flex', padding: 0 }}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: t.textPrimary, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 7, padding: 0, fontFamily: t.font }}
        >
          <Box size={13} color={STATUS_COLOR[block.status] ?? t.textMuted} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600 }}>{block.name}</span>
          <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{block.domain}</span>
        </button>
      </div>
      {open && (
        <div style={{ padding: '6px 12px 10px 30px', borderBottom: `1px solid ${t.cellBorder}`, background: `${t.tableHeaderBg}30`, display: 'grid', gap: 6 }}>
          {block.description && <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4 }}>{block.description}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10.5, color: t.textMuted }}>
            <span style={{ textTransform: 'capitalize', color: STATUS_COLOR[block.status] ?? t.textMuted, fontWeight: 700 }}>{block.status}</span>
            {block.owner && <span>· {block.owner}</span>}
            {block.lastModified && <span>· {new Date(block.lastModified).toLocaleDateString()}</span>}
          </div>
          <button
            type="button"
            onClick={onOpen}
            style={{ justifySelf: 'start', border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.accent, cursor: 'pointer', borderRadius: 6, fontSize: 10.5, fontWeight: 700, fontFamily: t.font, padding: '3px 9px' }}
          >
            Open in builder
          </button>
        </div>
      )}
    </div>
  );
}
