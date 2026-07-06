import React, { useEffect, useState } from 'react';
import { Blocks, ChevronDown, ChevronRight, Database, FileText, Layers, Plus, Search } from 'lucide-react';
import { api } from '../../api/client';
import { insertSemanticReference } from '../../editor/semantic-completions';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type { NotebookFile, SchemaTable, SemanticDimension, SemanticMetric } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import type { BlockEntry } from '../blocks/block-types';

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
export function BuildSidebar({ defaultTab, onOpenFile }: { defaultTab?: BuildTab; onOpenFile: (file: NotebookFile) => void }) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [tab, setTab] = useState<BuildTab>(defaultTab ?? 'notebooks');
  const [search, setSearch] = useState('');

  useEffect(() => { if (defaultTab) setTab(defaultTab); }, [defaultTab]);

  // Insert into the focused editor when there is one, else drop a new SQL cell.
  const insertText = (text: string) => {
    if (!insertSemanticReference(text)) {
      dispatch({ type: 'ADD_CELL', cell: makeCell('sql', text) });
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: t.cellBg, fontFamily: t.font }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, padding: '6px 6px 0', borderBottom: `1px solid ${t.headerBorder}` }}>
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              title={label}
              style={{
                flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: 'none', borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
                background: 'transparent', color: active ? t.accent : t.textMuted, cursor: 'pointer',
                fontSize: 11, fontWeight: 700, padding: '6px 4px 7px',
              }}
            >
              <Icon size={13} />{label}
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
        {tab === 'notebooks' && <NotebooksList t={t} onOpenFile={onOpenFile} />}
        {tab === 'semantic' && <SemanticList t={t} search={search} onInsert={insertText} />}
        {tab === 'database' && <DatabaseList t={t} search={search} onInsert={insertText} />}
        {tab === 'blocks' && <BlocksList t={t} search={search} />}
      </div>
    </div>
  );
}

const rowStyle = (t: Theme, active = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box',
  padding: '6px 10px', border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
  background: active ? `${t.accent}14` : 'transparent', cursor: 'pointer', textAlign: 'left',
  fontFamily: t.font, color: t.textPrimary,
});

function SectionHeader({ label, count, t }: { label: string; count: number; t: Theme }) {
  return (
    <div style={{ padding: '8px 10px 4px', fontSize: 9.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.textMuted }}>
      {label} · {count}
    </div>
  );
}

function EmptyNote({ text, t }: { text: string; t: Theme }) {
  return <div style={{ padding: '16px 12px', fontSize: 11.5, color: t.textMuted, textAlign: 'center' }}>{text}</div>;
}

function NotebooksList({ t, onOpenFile }: { t: Theme; onOpenFile: (file: NotebookFile) => void }) {
  const { state, dispatch } = useNotebook();
  const notebooks = state.files
    .filter((f) => f.type === 'notebook')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
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
            <FileText size={13} color={t.textMuted} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
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
  const sl = state.semanticLayer;
  const q = search.trim().toLowerCase();
  const match = (name: string, label?: string) => !q || name.toLowerCase().includes(q) || (label ?? '').toLowerCase().includes(q);
  const metrics = (sl?.metrics ?? []).filter((m) => match(m.name, m.label));
  const dimensions = [...(sl?.dimensions ?? []), ...(sl?.timeDimensions ?? [])].filter((d) => match(d.name, d.label));

  if (!sl?.available && metrics.length === 0 && dimensions.length === 0) {
    return <EmptyNote text="No semantic layer imported yet." t={t} />;
  }
  const row = (kind: 'metric' | 'dim', item: SemanticMetric | SemanticDimension) => (
    <button
      key={`${kind}:${item.name}`}
      type="button"
      onClick={() => onInsert(kind === 'metric' ? `@metric(${item.name})` : `@dim(${item.name})`)}
      style={rowStyle(t)}
      title={item.description || item.name}
    >
      <span style={{ fontSize: 9, fontWeight: 800, color: kind === 'metric' ? t.accent : t.success, width: 26, flexShrink: 0 }}>
        {kind === 'metric' ? 'MET' : 'DIM'}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontFamily: t.fontMono }}>
        {item.name}
      </span>
    </button>
  );
  return (
    <div>
      {metrics.length > 0 && <SectionHeader label="Metrics" count={metrics.length} t={t} />}
      {metrics.map((m) => row('metric', m))}
      {dimensions.length > 0 && <SectionHeader label="Dimensions" count={dimensions.length} t={t} />}
      {dimensions.map((d) => row('dim', d))}
      {metrics.length === 0 && dimensions.length === 0 && <EmptyNote text="No matches." t={t} />}
    </div>
  );
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
                style={{ flex: 1, border: 'none', background: 'transparent', cursor: 'pointer', color: t.textPrimary, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, padding: 0, fontFamily: t.font }}
              >
                <Database size={12} color={t.textMuted} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontFamily: t.fontMono }}>{tb.name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{tb.columns.length}</span>
              </button>
            </div>
            {open && tb.columns.map((col) => (
              <button
                key={col.name}
                type="button"
                onClick={() => onInsert(col.name)}
                title={`Insert column ${col.name}`}
                style={{ ...rowStyle(t), paddingLeft: 30 }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontFamily: t.fontMono, color: t.textSecondary }}>{col.name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{col.type}</span>
              </button>
            ))}
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
  const filtered = blocks.filter((b) => !q || b.name.toLowerCase().includes(q) || (b.description ?? '').toLowerCase().includes(q));

  const open = (block: BlockEntry) => {
    const file = { name: block.path.split('/').pop() ?? block.name, path: block.path, type: 'block' as const, folder: 'blocks' };
    if (!state.files.some((f) => f.path === block.path)) dispatch({ type: 'FILE_ADDED', file });
    void api.openBlockStudio(block.path).then((payload) => dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload }));
  };

  if (loading) return <EmptyNote text="Loading blocks…" t={t} />;
  if (filtered.length === 0) return <EmptyNote text={blocks.length === 0 ? 'No blocks yet.' : 'No matches.'} t={t} />;
  return (
    <div>
      {filtered.map((block) => (
        <button key={block.path} type="button" onClick={() => open(block)} style={rowStyle(t)} title={block.description || block.name}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLOR[block.status] ?? t.textMuted, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600 }}>{block.name}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{block.domain}</span>
        </button>
      ))}
    </div>
  );
}
