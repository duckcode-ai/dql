import React, { useEffect, useMemo, useState } from 'react';
import { Blocks, Box, Calendar, ChevronDown, ChevronRight, Database, FileText, Hash, KeyRound, Layers, Link2, Plus, Search, Type } from 'lucide-react';
import { api } from '../../api/client';
import { insertSemanticReference } from '../../editor/semantic-completions';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type { NotebookFile, SchemaTable } from '../../store/types';
import { DataSourceIcon, describeSchemaObject } from './DataSourceIcon';
import type { Theme } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import type { BlockEntry } from '../blocks/block-types';
import { BlockStatusBadge } from '../blocks/BlockStatusBadge';
import { SemanticTreeView } from './CatalogTree';
import { blockDomains, filterBlocksForDomain } from './block-domain-filter';
import { buildNotebookSemanticBlock } from './semantic-notebook-source';
import { buildSemanticTreeFromLayer } from '../../utils/semantic-tree';

export type BuildTab = 'notebooks' | 'semantic' | 'database' | 'blocks';

const TABS: { id: BuildTab; label: string; icon: React.ComponentType<any> }[] = [
  { id: 'notebooks', label: 'Notebooks', icon: FileText },
  { id: 'semantic', label: 'Semantic', icon: Layers },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'blocks', label: 'Blocks', icon: Blocks },
];

// Paper-handoff status dots: certified green · draft amber · review blue.
const STATUS_COLOR: Record<string, string> = {
  certified: 'var(--status-success)', published: 'var(--status-success)', deprecated: 'var(--status-error)',
  draft: 'var(--status-warning)', pending: 'var(--status-warning)', review: '#4a74c9', in_review: '#4a74c9',
};

/**
 * Unified, database-studio-style sidebar for the Build section. Four clean tabs —
 * Notebooks (list + new), Semantic (metrics/dimensions), Database (tables/columns),
 * Blocks — with no studio/setup chrome. Click a notebook to open it; click a
 * metric/dimension/table/column to insert it into the active editor (or a new SQL
 * cell); click a block to open it in the builder.
 */
export function BuildSidebar({ defaultTab, onOpenFile, tabs, onInsertText, blockDomain = '', onBlockDomainChange, onNewBlock, footer, footerStatus = 'ready', onCollapse }: {
  defaultTab?: BuildTab;
  onOpenFile?: (file: NotebookFile) => void;
  /** Which tabs to show (default all four). Block Studio omits 'notebooks'. */
  tabs?: BuildTab[];
  /** Override the insert action (e.g. Block Studio appends to the block draft). */
  onInsertText?: (text: string) => void;
  /** Domain scope for the Blocks tab. An empty value selects the first available domain. */
  blockDomain?: string;
  onBlockDomainChange?: (domain: string) => void;
  /** Shows a "+" new-block button beside the search input (Block Studio). */
  onNewBlock?: () => void;
  /** Optional status footer line (e.g. "dbt synced · 42 models · 5 metrics"). */
  footer?: React.ReactNode;
  footerStatus?: 'ready' | 'loading' | 'warning';
  /** Renders a collapse chevron at the end of the tab bar. */
  onCollapse?: () => void;
}) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  // Respect the host's tab order (the prototype puts Blocks first in Block Studio).
  const visibleTabs = tabs
    ? tabs.map((id) => TABS.find((x) => x.id === id)).filter((x): x is typeof TABS[number] => Boolean(x))
    : TABS;
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
                flex: visibleTabs.length > 3 ? '1 1 auto' : 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
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
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse explorer"
            style={{ border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', fontSize: 13, padding: '0 6px', flexShrink: 0 }}
          >
            ‹
          </button>
        ) : null}
      </div>

      {/* Search (all tabs except notebooks, which has its own + button) */}
      {tab !== 'notebooks' && (
        <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, display: 'flex', gap: 6 }}>
          <div style={{ position: 'relative', flex: 1 }}>
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
          {onNewBlock ? (
            <button
              type="button"
              onClick={onNewBlock}
              title="New block"
              style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 6, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'notebooks' && onOpenFile && <NotebooksList t={t} onOpenFile={onOpenFile} />}
        {tab === 'semantic' && <SemanticList t={t} search={search} onInsert={insertText} notebookMode={!onInsertText} />}
        {tab === 'database' && <DatabaseList t={t} search={search} onInsert={insertText} />}
        {tab === 'blocks' && <BlocksList t={t} search={search} domain={blockDomain} onDomainChange={onBlockDomainChange} />}
      </div>

      {footer ? (
        <div style={{ padding: '9px 12px', borderTop: `1px solid ${t.headerBorder}`, fontSize: 10.5, color: t.textMuted, display: 'flex', alignItems: 'center', gap: 6, fontFamily: t.font }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: footerStatus === 'ready' ? 'var(--status-success)' : 'var(--status-warning)', flexShrink: 0 }} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{footer}</span>
        </div>
      ) : null}
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

/**
 * Best-effort relational role for a column from its name (the schema only carries
 * name + type). `<table>_id` / `id` reads as a primary key; any other `*_id`/`*_key`
 * reads as a foreign key — so relations surface with a key/link icon when present.
 */
function columnRelation(colName: string, tableName: string): 'pk' | 'fk' | undefined {
  const c = colName.toLowerCase();
  if (!(/(?:_id|_key|_uuid|_fk|_pk)$/.test(c) || c === 'id' || c === 'pk')) return undefined;
  const table = tableName.toLowerCase().replace(/^(?:dim|fct|fact|stg|staging|raw|base)_/, '');
  const singular = table.replace(/s$/, '');
  if (c === 'id' || c === 'pk' || c === `${table}_id` || c === `${singular}_id` || c === `${table}id` || c === `${singular}id`) return 'pk';
  return 'fk';
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

function SemanticList({ t, search, onInsert, notebookMode }: { t: Theme; search: string; onInsert: (text: string) => void; notebookMode: boolean }) {
  const { state, dispatch } = useNotebook();
  const tree = useMemo(() => buildSemanticTreeFromLayer(state.semanticLayer), [
    state.semanticLayer.provider,
    state.semanticLayer.metrics,
    state.semanticLayer.measures,
    state.semanticLayer.dimensions,
    state.semanticLayer.timeDimensions,
    state.semanticLayer.entities,
    state.semanticLayer.hierarchies,
    state.semanticLayer.semanticModels,
    state.semanticLayer.savedQueries,
  ]);
  const loading = state.semanticLayer.loading;
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set());
  const [selectedDimensions, setSelectedDimensions] = useState<Set<string>>(new Set());
  const [compatibleDimensions, setCompatibleDimensions] = useState<Set<string> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ sql: string; rows: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const metricsByName = new Map(state.semanticLayer.metrics.map((metric) => [metric.name, metric]));

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    if (selectedMetrics.size === 0) {
      setCompatibleDimensions(null);
      setSelectedDimensions(new Set());
      return;
    }
    setCompatibleDimensions(null);
    void api.getCompatibleDimensions(Array.from(selectedMetrics)).then((dimensions) => {
      if (!active) return;
      const names = new Set(dimensions.map((dimension) => dimension.name));
      setCompatibleDimensions(names);
      setSelectedDimensions((current) => new Set(Array.from(current).filter((name) => names.has(name))));
    });
    return () => { active = false; };
  }, [Array.from(selectedMetrics).sort().join('|')]);

  const toggleSelection = (kind: 'metric' | 'dimension', name: string) => {
    const update = kind === 'metric' ? setSelectedMetrics : setSelectedDimensions;
    update((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const canSelect = (kind: 'metric' | 'dimension', name: string): { allowed: boolean; reason?: string } => {
    if (kind === 'metric') {
      const capability = metricsByName.get(name)?.execution;
      return capability && capability.status !== 'ready'
        ? { allowed: false, reason: capability.reason || 'This metric requires semantic runtime setup.' }
        : { allowed: true };
    }
    if (selectedMetrics.size === 0) return { allowed: false, reason: 'Select a metric first.' };
    if (!compatibleDimensions) return { allowed: false, reason: 'Checking compatibility…' };
    return compatibleDimensions.has(name)
      ? { allowed: true }
      : { allowed: false, reason: 'This dimension has no governed join path to every selected metric.' };
  };

  const selectedKeys = new Set([
    ...Array.from(selectedMetrics).map((name) => `metric:${name}`),
    ...Array.from(selectedDimensions).map((name) => `dimension:${name}`),
  ]);

  const runPreview = async () => {
    if (selectedMetrics.size === 0) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await api.previewSemanticBuilder({
        metrics: Array.from(selectedMetrics),
        dimensions: Array.from(selectedDimensions),
        limit: 50,
      });
      if ('error' in result) {
        setPreview(null);
        setError(result.error);
        return;
      }
      setPreview({ sql: result.sql, rows: result.result.rowCount ?? result.result.rows.length });
    } finally {
      setPreviewing(false);
    }
  };

  const addSemanticCell = () => {
    if (selectedMetrics.size === 0) return;
    dispatch({ type: 'ADD_CELL', cell: makeCell('dql', buildNotebookSemanticBlock(Array.from(selectedMetrics), Array.from(selectedDimensions))) });
    setSelectedMetrics(new Set());
    setSelectedDimensions(new Set());
    setPreview(null);
    setError(null);
  };

  if (loading && !tree) return <EmptyNote text="Loading semantic layer…" t={t} />;
  if (!tree || (tree.children?.length ?? 0) === 0) return <EmptyNote text="No semantic layer imported yet." t={t} />;
  return <div>
    {notebookMode && (
      <div style={{ display: 'grid', gap: 7, padding: 8, borderBottom: `1px solid ${t.headerBorder}`, background: 'var(--bg-1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, fontSize: 10.5, color: t.textMuted }}>
            {selectedMetrics.size > 0
              ? `${selectedMetrics.size} metric${selectedMetrics.size === 1 ? '' : 's'} · ${selectedDimensions.size} dimension${selectedDimensions.size === 1 ? '' : 's'}`
              : 'Select metrics, then compatible dimensions'}
          </span>
          <button type="button" onClick={() => void runPreview()} disabled={previewing || selectedMetrics.size === 0} style={{ border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, borderRadius: 5, padding: '4px 7px', fontSize: 10, cursor: selectedMetrics.size ? 'pointer' : 'not-allowed', opacity: selectedMetrics.size ? 1 : .5 }}>
            {previewing ? 'Running…' : 'Preview & run'}
          </button>
          <button type="button" onClick={addSemanticCell} disabled={selectedMetrics.size === 0} style={{ border: 'none', background: t.accent, color: '#fff', borderRadius: 5, padding: '5px 7px', fontSize: 10, fontWeight: 700, cursor: selectedMetrics.size ? 'pointer' : 'not-allowed', opacity: selectedMetrics.size ? 1 : .5 }}>
            Add cell
          </button>
        </div>
        {preview && (
          <div style={{ display: 'grid', gap: 4, padding: '6px 7px', borderRadius: 6, border: '1px solid var(--status-success)', background: 'var(--status-success-bg)', color: t.textSecondary, fontSize: 10 }}>
            <span>Preview succeeded · {preview.rows} row{preview.rows === 1 ? '' : 's'}</span>
            <code style={{ display: 'block', maxHeight: 48, overflow: 'hidden', whiteSpace: 'pre-wrap', fontSize: 9, color: t.textMuted }}>{preview.sql}</code>
          </div>
        )}
        {error && <div role="alert" style={{ padding: '6px 7px', borderRadius: 6, border: `1px solid ${t.error}40`, background: `${t.error}10`, color: t.error, fontSize: 10, lineHeight: 1.35 }}>{error}</div>}
        {state.semanticLayer.metrics.some((metric) => metric.execution && metric.execution.status !== 'ready') && (
          <div style={{ fontSize: 9.5, color: t.textMuted }}>Complex metrics remain discoverable. Configure dbt Cloud Semantic Layer or a compatible local MetricFlow runtime in Project &amp; dbt to run them.</div>
        )}
      </div>
    )}
    <SemanticTreeView
      tree={tree}
      themeMode={state.themeMode}
      search={search}
      onInsert={onInsert}
      selectionMode={notebookMode}
      selected={selectedKeys}
      onToggleSelection={toggleSelection}
      canSelect={canSelect}
    />
  </div>;
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
                <DataSourceIcon
                  table={tb}
                  colors={{ accent: t.accent, success: t.success, warning: t.warning, muted: t.textMuted }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontFamily: t.fontMono }}>{tb.name}</span>
                <span style={{ fontSize: 8.5, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>{describeSchemaObject(tb).label}</span>
                <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{tb.columns.length}</span>
              </button>
            </div>
            {open && tb.columns.map((col) => {
              const relation = columnRelation(col.name, tb.name);
              return (
                <button
                  key={col.name}
                  type="button"
                  onClick={() => onInsert(col.name)}
                  title={relation === 'pk' ? `Primary key · insert ${col.name}` : relation === 'fk' ? `Foreign key · insert ${col.name}` : `Insert column ${col.name}`}
                  style={{ ...rowStyle(t), paddingLeft: 32, gap: 7 }}
                >
                  {/* Prototype ER glyphs: mono PK/FK text in the key column. */}
                  <span style={{ flexShrink: 0, width: 18, fontSize: 8.5, fontWeight: 700, fontFamily: t.fontMono, color: relation === 'pk' ? 'var(--pk)' : relation === 'fk' ? 'var(--fk)' : t.textMuted }}>
                    {relation === 'pk' ? 'PK' : relation === 'fk' ? 'FK' : ''}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontFamily: t.fontMono, color: t.textSecondary }}>{col.name}</span>
                  <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0, fontFamily: t.fontMono }}>{col.type}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function BlocksList({ t, search, domain, onDomainChange }: { t: Theme; search: string; domain: string; onDomainChange?: (domain: string) => void }) {
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

  const domains = blockDomains(blocks);
  const selectedDomain = domain || domains[0] || '';
  const domainOptions = selectedDomain && !domains.includes(selectedDomain) ? [selectedDomain, ...domains] : domains;
  const filtered = filterBlocksForDomain(blocks, selectedDomain, search);

  useEffect(() => {
    if (!domain && domains[0]) onDomainChange?.(domains[0]);
  }, [domain, domains.join('|'), onDomainChange]);

  const open = (block: BlockEntry) => {
    const file = { name: block.path.split('/').pop() ?? block.name, path: block.path, type: 'block' as const, folder: 'blocks' };
    if (!state.files.some((f) => f.path === block.path)) dispatch({ type: 'FILE_ADDED', file });
    void api.openBlockStudio(block.path).then((payload) => dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload }));
  };

  if (loading) return <EmptyNote text="Loading blocks…" t={t} />;
  if (blocks.length === 0) return <EmptyNote text="No blocks yet." t={t} />;
  return <div>
    <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gap: 5 }}>
      <label htmlFor="block-domain-filter" style={{ color: t.textMuted, fontSize: 9, fontWeight: 750, letterSpacing: '.06em', textTransform: 'uppercase' }}>Domain</label>
      <select
        id="block-domain-filter"
        aria-label="Block domain"
        value={selectedDomain}
        onChange={(event) => onDomainChange?.(event.target.value)}
        style={{ width: '100%', background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6, color: t.textPrimary, fontFamily: t.font, fontSize: 12, padding: '7px 8px' }}
      >
        {domainOptions.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <span style={{ color: t.textMuted, fontSize: 10 }}>{filtered.length} {selectedDomain} block{filtered.length === 1 ? '' : 's'}</span>
    </div>
    {filtered.length === 0
      ? <EmptyNote text={search ? `No ${selectedDomain} blocks match this search.` : `No blocks in ${selectedDomain} yet.`} t={t} />
      : filtered.map((block) => <BlockRow key={block.path} block={block} t={t} onOpen={() => open(block)} />)}
  </div>;
}

// Prototype block row: blocks glyph · mono name over a meta line · status dot.
// A single click opens the block's detail overview (description lives there).
function BlockRow({ block, t, onOpen }: { block: BlockEntry; t: Theme; onOpen: () => void }) {
  const status = String(block.status ?? 'draft');
  const dot = STATUS_COLOR[status] ?? t.warning;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={block.description || `${block.name} — open`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
        padding: '7px 10px', border: 'none', borderRadius: 7, margin: '1px 0',
        background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: t.font,
      }}
    >
      <Blocks size={14} color={t.textMuted} strokeWidth={1.75} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.name}</span>
        <span style={{ fontSize: 10.5, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[block.domain, status].filter(Boolean).join(' · ')}</span>
      </span>
      <span title={status} style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: dot }} />
    </button>
  );
}
