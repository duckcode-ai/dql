import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { insertSemanticReference, serializeSemanticDragRef } from '../../editor/semantic-completions';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type {
  SemanticLayerState,
  SemanticObjectDetail,
  SemanticTreeNode,
} from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import { MetricDetailPanel } from './MetricDetailPanel';
import { SemanticSearchBar } from './SemanticSearchBar';
import { SemanticTreeNode as TreeRow } from './SemanticTreeNode';

function PanelSectionHeader({ label, count, t }: { label: string; count?: number; t: Theme }) {
  return (
    <div
      style={{
        padding: '8px 10px 4px',
        fontSize: 10,
        fontWeight: 700,
        color: t.textMuted,
        fontFamily: t.font,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}
    >
      {label}
      {typeof count === 'number' ? ` · ${count}` : ''}
    </div>
  );
}

function SetupState({
  t,
  provider,
  onImport,
  onRefresh,
}: {
  t: Theme;
  provider: string | null;
  onImport: (provider: 'dbt' | 'cubejs' | 'snowflake') => void;
  onRefresh: () => void;
}) {
  const codeStyle = { background: t.pillBg, padding: '1px 4px', borderRadius: 3, fontSize: 10, fontFamily: t.fontMono } as const;
  const suggestedProvider = provider === 'cubejs' || provider === 'snowflake' ? provider : 'dbt';

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', fontFamily: t.font }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, marginBottom: 8 }}>Semantic layer not loaded</div>
      <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.6, marginBottom: 10 }}>
        Import your provider metadata into <code style={codeStyle}>semantic-layer/</code> or refresh the current project state.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => onImport(suggestedProvider)}
          style={{ background: t.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 14px' }}
        >
          Import {suggestedProvider}
        </button>
        <button
          onClick={onRefresh}
          style={{ background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 6, color: t.textSecondary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 12px' }}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function GuidedBuilderPanel({
  t,
  semanticLayer,
  onClose,
  onSaved,
}: {
  t: Theme;
  semanticLayer: SemanticLayerState;
  onClose: () => void;
  onSaved: (result: { path: string; content: string; companionPath: string }) => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('new_semantic_block');
  const [domain, setDomain] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [tags, setTags] = useState('');
  const [chart, setChart] = useState('table');
  const [blockType, setBlockType] = useState<'semantic' | 'custom'>('semantic');
  const [metrics, setMetrics] = useState<string[]>([]);
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [timeDimensionName, setTimeDimensionName] = useState('');
  const [granularity, setGranularity] = useState('month');
  const [preview, setPreview] = useState<{ sql: string; joins: string[]; tables: string[]; result: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingCompatibleDimensions, setLoadingCompatibleDimensions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compatibleDimensions, setCompatibleDimensions] = useState(semanticLayer.dimensions);

  useEffect(() => {
    let cancelled = false;
    if (metrics.length === 0) {
      setCompatibleDimensions(semanticLayer.dimensions);
      return;
    }
    setLoadingCompatibleDimensions(true);
    void api.getCompatibleDimensions(metrics)
      .then((dimensions) => {
        if (!cancelled) {
          setCompatibleDimensions(dimensions);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingCompatibleDimensions(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [metrics, semanticLayer.dimensions]);

  const timeDimensions = compatibleDimensions.filter((dimension) => dimension.type === 'date');
  const categoricalDimensions = compatibleDimensions.filter((dimension) => dimension.type !== 'date');

  const toggle = (value: string, values: string[], setValues: React.Dispatch<React.SetStateAction<string[]>>) => {
    setValues((prev) => prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '7px 10px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const handlePreview = async () => {
    if (metrics.length === 0) {
      setError('Select at least one metric.');
      return;
    }
    setLoading(true);
    setError(null);
    const response = await api.previewSemanticBuilder({
      metrics,
      dimensions,
      timeDimension: timeDimensionName ? { name: timeDimensionName, granularity } : undefined,
    });
    setLoading(false);
    if ('error' in response) {
      setError(response.error);
      return;
    }
    setPreview(response);
    setStep(3);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Block name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveSemanticBuilder({
        name: name.trim(),
        domain: domain.trim() || undefined,
        description: description.trim() || undefined,
        owner: owner.trim() || undefined,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        metrics,
        dimensions,
        timeDimension: timeDimensionName ? { name: timeDimensionName, granularity } : undefined,
        chart,
        blockType,
      });
      onSaved(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 200,
        background: `${t.sidebarBg}f4`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>Guided Block Builder</div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 16 }}>×</button>
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${t.headerBorder}` }}>
        {[1, 2, 3, 4].map((index) => (
          <div
            key={index}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '6px 0',
              borderRadius: 6,
              background: step === index ? `${t.accent}18` : t.pillBg,
              color: step === index ? t.accent : t.textMuted,
              fontSize: 10,
              fontFamily: t.font,
              fontWeight: 600,
            }}
          >
            Step {index}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'grid', gap: 12 }}>
        {step === 1 && (
          <>
            <PanelSectionHeader label="Choose Metrics" count={metrics.length} t={t} />
            <div style={{ display: 'grid', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {semanticLayer.metrics.map((metric) => (
                <label key={metric.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: t.textPrimary, fontFamily: t.font }}>
                  <input type="checkbox" checked={metrics.includes(metric.name)} onChange={() => toggle(metric.name, metrics, setMetrics)} />
                  <span style={{ flex: 1 }}>{metric.label || metric.name}</span>
                  <span style={{ color: t.textMuted, fontFamily: t.fontMono }}>{metric.domain || 'uncategorized'}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <PanelSectionHeader label="Dimensions" count={dimensions.length} t={t} />
            {loadingCompatibleDimensions && (
              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>Resolving compatible dimensions…</div>
            )}
            <div style={{ display: 'grid', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
              {categoricalDimensions.map((dimension) => (
                <label key={dimension.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: t.textPrimary, fontFamily: t.font }}>
                  <input type="checkbox" checked={dimensions.includes(dimension.name)} onChange={() => toggle(dimension.name, dimensions, setDimensions)} />
                  <span style={{ flex: 1 }}>{dimension.label || dimension.name}</span>
                  <span style={{ color: t.textMuted, fontFamily: t.fontMono }}>{dimension.table}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 11, color: t.textSecondary, fontFamily: t.font }}>Time grain</div>
              <select value={timeDimensionName} onChange={(event) => setTimeDimensionName(event.target.value)} style={inputStyle}>
                <option value="">No time dimension</option>
                {timeDimensions.map((dimension) => (
                  <option key={dimension.name} value={dimension.name}>{dimension.label || dimension.name}</option>
                ))}
              </select>
              {timeDimensionName && (
                <select value={granularity} onChange={(event) => setGranularity(event.target.value)} style={inputStyle}>
                  <option value="day">day</option>
                  <option value="week">week</option>
                  <option value="month">month</option>
                  <option value="quarter">quarter</option>
                  <option value="year">year</option>
                </select>
              )}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <PanelSectionHeader label="Preview SQL" t={t} />
            {preview && (
              <>
                <pre style={{ margin: 0, padding: '10px', background: t.editorBg, border: `1px solid ${t.cellBorder}`, borderRadius: 6, fontSize: 10, color: t.textSecondary, fontFamily: t.fontMono, whiteSpace: 'pre-wrap' }}>
                  {preview.sql}
                </pre>
                <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
                  {preview.tables.length} table(s) · {preview.result.rowCount ?? preview.result.rows.length} row(s)
                </div>
              </>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <div style={{ display: 'grid', gap: 8 }}>
              <input value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} placeholder="Block name" />
              <input value={domain} onChange={(event) => setDomain(event.target.value)} style={inputStyle} placeholder="Domain" />
              <input value={description} onChange={(event) => setDescription(event.target.value)} style={inputStyle} placeholder="Description" />
              <input value={owner} onChange={(event) => setOwner(event.target.value)} style={inputStyle} placeholder="Owner" />
              <input value={tags} onChange={(event) => setTags(event.target.value)} style={inputStyle} placeholder="Tags (comma separated)" />
              <select value={chart} onChange={(event) => setChart(event.target.value)} style={inputStyle}>
                <option value="table">table</option>
                <option value="bar">bar</option>
                <option value="line">line</option>
                <option value="kpi">kpi</option>
              </select>
              <select value={blockType} onChange={(event) => setBlockType(event.target.value as 'semantic' | 'custom')} style={inputStyle}>
                <option value="semantic">semantic block</option>
                <option value="custom">custom block</option>
              </select>
            </div>
          </>
        )}

        {error && <div style={{ color: t.error, fontSize: 11, fontFamily: t.font }}>{error}</div>}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '10px 12px', borderTop: `1px solid ${t.headerBorder}` }}>
        <button
          onClick={() => setStep((value) => Math.max(1, value - 1))}
          disabled={step === 1}
          style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textSecondary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 12px' }}
        >
          Back
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          {step < 2 && (
            <button
              onClick={() => setStep(2)}
              style={{ background: t.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 12px' }}
            >
              Next
            </button>
          )}
          {step === 2 && (
            <button
              onClick={() => void handlePreview()}
              disabled={loading}
              style={{ background: t.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 12px' }}
            >
              {loading ? 'Previewing…' : 'Preview'}
            </button>
          )}
          {step === 3 && (
            <button
              onClick={() => setStep(4)}
              style={{ background: t.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 12px' }}
            >
              Continue
            </button>
          )}
          {step === 4 && (
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ background: t.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 12px' }}
            >
              {saving ? 'Saving…' : 'Save Block'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface TreeFilters {
  query: string;
  provider: string;
  domain: string;
  cube: string;
  owner: string;
  tag: string;
  type: string;
}

interface FlatTreeRow {
  node: SemanticTreeNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

const TREE_ROW_HEIGHT = 31;
const TREE_OVERSCAN = 10;

function filterTree(node: SemanticTreeNode, filters: TreeFilters): SemanticTreeNode | null {
  const q = filters.query.trim().toLowerCase();
  const metaValues = Object.values(node.meta ?? {})
    .filter((value): value is string | number | boolean => value != null)
    .map((value) => String(value).toLowerCase());
  const matchesQuery = !q || node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q) || metaValues.some((value) => value.includes(q));
  const matchesType = !filters.type || node.kind === filters.type || node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group';
  const matchesDomain = !filters.domain || node.kind === 'provider' || node.kind === 'group' || (node.meta?.domain === filters.domain || (node.kind === 'domain' && node.label === filters.domain));
  const matchesProvider = !filters.provider || node.meta?.provider === filters.provider || (node.kind === 'provider' && node.id === `provider:${filters.provider}`);
  const matchesCube = !filters.cube || node.meta?.cube === filters.cube || (node.kind === 'cube' && (node.meta?.cube === filters.cube || node.label === filters.cube));
  const matchesOwner = !filters.owner || node.meta?.owner === filters.owner;
  const matchesTag = !filters.tag || String(node.meta?.tags ?? '').split(',').filter(Boolean).includes(filters.tag);

  const children = (node.children ?? [])
    .map((child) => filterTree(child, filters))
    .filter((child): child is SemanticTreeNode => Boolean(child));

  if (children.length > 0) {
    return { ...node, children, count: node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group' ? children.length : node.count };
  }

  return matchesQuery && matchesType && matchesDomain && matchesProvider && matchesCube && matchesOwner && matchesTag
    ? { ...node, children: [] }
    : null;
}

function countTreeLeaves(node: SemanticTreeNode): number {
  if (!node.children || node.children.length === 0) return node.kind === 'group' || node.kind === 'provider' || node.kind === 'domain' ? 0 : 1;
  return node.children.reduce((sum, child) => sum + countTreeLeaves(child), 0);
}

function collectFacetValues(node: SemanticTreeNode | null, key: string): string[] {
  if (!node) return [];
  const values = new Set<string>();
  const visit = (current: SemanticTreeNode) => {
    const value = current.meta?.[key];
    if (typeof value === 'string' && value.trim()) {
      values.add(value.trim());
    }
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function flattenTreeRows(nodes: SemanticTreeNode[], expanded: Record<string, boolean>, depth: number = 0): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  for (const node of nodes) {
    const hasChildren = Boolean(node.children && node.children.length > 0);
    const isExpanded = expanded[node.id] ?? (depth < 2);
    rows.push({ node, depth, hasChildren, isExpanded });
    if (hasChildren && isExpanded) {
      rows.push(...flattenTreeRows(node.children ?? [], expanded, depth + 1));
    }
  }
  return rows;
}

export function SemanticPanel() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const sl = state.semanticLayer;

  const [tree, setTree] = useState<SemanticTreeNode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<SemanticObjectDetail | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [cubeFilter, setCubeFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);

  const handleRefresh = async () => {
    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    try {
      const [layer, nextTree] = await Promise.all([
        api.getSemanticLayer(),
        api.getSemanticTree().catch(() => null),
      ]);
      dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
      setTree(nextTree);
    } finally {
      dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false });
    }
  };

  useEffect(() => {
    if ((sl.metrics.length === 0 && sl.dimensions.length === 0 && !sl.loading) || !tree) {
      void handleRefresh();
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedItem(null);
      return;
    }
    if (selectedId.startsWith('provider:') || selectedId.startsWith('domain:') || selectedId.startsWith('group:')) {
      setSelectedItem(null);
      return;
    }
    void api.getSemanticObject(selectedId)
      .then(setSelectedItem)
      .catch(() => setSelectedItem(null));
  }, [selectedId]);

  const filteredTree = useMemo(() => {
    if (!tree) return null;
    const base = filterTree(tree, {
      query,
      provider: providerFilter,
      domain: domainFilter,
      cube: cubeFilter,
      owner: ownerFilter,
      tag: tagFilter,
      type: typeFilter,
    });
    return base;
  }, [tree, query, providerFilter, domainFilter, cubeFilter, ownerFilter, tagFilter, typeFilter]);

  const favoritesSet = useMemo(() => new Set(sl.favorites), [sl.favorites]);
  const metricsByName = useMemo(() => new Map(sl.metrics.map((metric) => [metric.name, metric])), [sl.metrics]);
  const dimensionsByName = useMemo(() => new Map(sl.dimensions.map((dimension) => [dimension.name, dimension])), [sl.dimensions]);
  const providerOptions = useMemo(() => collectFacetValues(tree, 'provider'), [tree]);
  const cubeOptions = useMemo(() => collectFacetValues(tree, 'cube'), [tree]);
  const ownerOptions = useMemo(() => collectFacetValues(tree, 'owner'), [tree]);
  const flatRows = useMemo(() => flattenTreeRows(filteredTree?.children ?? [], expanded), [filteredTree, expanded]);
  const totalTreeHeight = flatRows.length * TREE_ROW_HEIGHT;
  const visibleWindow = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
    const endIndex = Math.min(flatRows.length, Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + TREE_OVERSCAN);
    return {
      startIndex,
      endIndex,
      offsetTop: startIndex * TREE_ROW_HEIGHT,
      rows: flatRows.slice(startIndex, endIndex),
    };
  }, [flatRows, scrollTop, viewportHeight]);

  useEffect(() => {
    const element = treeContainerRef.current;
    if (!element) return;
    const updateHeight = () => setViewportHeight(element.clientHeight || 400);
    updateHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateHeight);
      return () => window.removeEventListener('resize', updateHeight);
    }
    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(element);
    return () => observer.disconnect();
  }, [filteredTree]);

  useEffect(() => {
    setScrollTop(0);
    if (treeContainerRef.current) {
      treeContainerRef.current.scrollTop = 0;
    }
  }, [query, providerFilter, domainFilter, cubeFilter, ownerFilter, tagFilter, typeFilter]);

  const insertMetricOrDimension = async (item: SemanticObjectDetail) => {
    const reference = item.kind === 'metric' ? `@metric(${item.name})` : `@dim(${item.name})`;
    if (!insertSemanticReference(reference)) {
      dispatch({ type: 'ADD_CELL', cell: makeCell('sql', reference) });
    }
    dispatch({ type: 'ADD_SEMANTIC_RECENT', name: item.name });
  };

  const renderLeaf = (node: SemanticTreeNode, depth: number) => {
    const refKind = node.kind === 'metric' || node.kind === 'dimension' ? node.kind : null;
    const refName = node.id.split(':').slice(1).join(':');

    return (
      <TreeRow
        key={node.id}
        label={node.label}
        depth={depth}
        badge={node.kind === 'metric' || node.kind === 'dimension' || node.kind === 'segment' || node.kind === 'pre_aggregation' ? node.kind : undefined}
        selected={selectedId === node.id}
        onClick={() => setSelectedId(node.id)}
        onDoubleClick={() => {
          if (node.kind === 'metric' || node.kind === 'dimension') {
            const object = node.kind === 'metric'
              ? metricsByName.get(node.id.slice('metric:'.length))
              : dimensionsByName.get(node.id.slice('dimension:'.length));
            if (object) {
              const ref = node.kind === 'metric' ? `@metric(${object.name})` : `@dim(${object.name})`;
              if (!insertSemanticReference(ref)) {
                dispatch({ type: 'ADD_CELL', cell: makeCell('sql', ref) });
              }
            }
          }
        }}
        onFavoriteToggle={refKind
          ? () => void api.toggleFavorite(refName).then((favorites) => dispatch({ type: 'SET_SEMANTIC_FAVORITES', favorites }))
          : undefined}
        favorite={refKind ? favoritesSet.has(refName) : undefined}
        onDragStart={refKind
          ? (event) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData('text/plain', refName);
              event.dataTransfer.setData('application/dql-semantic-ref', serializeSemanticDragRef(refKind, refName));
            }
          : undefined}
        t={t}
      />
    );
  };

  const renderTreeRow = (row: FlatTreeRow): React.ReactNode => {
    const { node, depth, hasChildren, isExpanded } = row;
    if (!hasChildren) return renderLeaf(node, depth);
    return (
      <div key={node.id}>
        <TreeRow
          label={node.label}
          depth={depth}
          count={node.children?.length}
          expanded={isExpanded}
          onToggle={() => setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }))}
          onClick={() => setSelectedId(node.id)}
          selected={selectedId === node.id}
          t={t}
        />
      </div>
    );
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.syncSemanticLayer();
      await handleRefresh();
    } finally {
      setSyncing(false);
    }
  };

  if (!sl.available && !sl.loading) {
    return (
      <SetupState
        t={t}
        provider={sl.provider}
        onImport={(provider) => void api.importSemanticLayer({ provider }).then(() => handleRefresh())}
        onRefresh={() => void handleRefresh()}
      />
    );
  }

  const treeLeafCount = filteredTree ? countTreeLeaves(filteredTree) : 0;

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {builderOpen && (
        <GuidedBuilderPanel
          t={t}
          semanticLayer={sl}
          onClose={() => setBuilderOpen(false)}
          onSaved={(result) => {
            dispatch({
              type: 'FILE_ADDED',
              file: {
                name: result.path.split('/').pop() ?? result.path,
                path: result.path,
                type: 'block',
                folder: 'blocks',
              },
            });
          }}
        />
      )}

      <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: `1px solid ${t.headerBorder}` }}>
        {sl.provider && (
          <span style={{ fontSize: 9, fontWeight: 600, color: t.accent, background: `${t.accent}18`, borderRadius: 4, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {sl.provider}
          </span>
        )}
        <span style={{ flex: 1, fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {sl.metrics.length} metrics · {sl.dimensions.length} dimensions
          {sl.lastSyncTime ? ` · synced ${new Date(sl.lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <button onClick={() => setBuilderOpen(true)} style={{ background: t.accent, border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: t.font, padding: '2px 8px' }}>
          Build
        </button>
        <button
          onClick={() => void handleSync()}
          style={{ background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4, color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '2px 6px' }}
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button
          onClick={() => void handleRefresh()}
          style={{ background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4, color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '2px 6px' }}
        >
          {sl.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <SemanticSearchBar
        query={query}
        provider={providerFilter}
        cube={cubeFilter}
        owner={ownerFilter}
        domain={domainFilter}
        tag={tagFilter}
        type={typeFilter}
        providers={providerOptions}
        cubes={cubeOptions}
        owners={ownerOptions}
        domains={sl.domains}
        tags={sl.tags}
        onQueryChange={setQuery}
        onProviderChange={setProviderFilter}
        onCubeChange={setCubeFilter}
        onOwnerChange={setOwnerFilter}
        onDomainChange={setDomainFilter}
        onTagChange={setTagFilter}
        onTypeChange={setTypeFilter}
        t={t}
      />

      <PanelSectionHeader label="Semantic Tree" count={treeLeafCount} t={t} />
      <div
        ref={treeContainerRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ flex: 1, overflowY: 'auto' }}
      >
        <div style={{ height: totalTreeHeight, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: visibleWindow.offsetTop,
              left: 0,
              right: 0,
            }}
          >
            {visibleWindow.rows.map((row) => renderTreeRow(row))}
          </div>
        </div>
      </div>

      <MetricDetailPanel
        item={selectedItem}
        favorite={Boolean(selectedItem && favoritesSet.has(selectedItem.name))}
        onInsert={() => selectedItem && (selectedItem.kind === 'metric' || selectedItem.kind === 'dimension') && void insertMetricOrDimension(selectedItem)}
        onPreview={() => {
          if (!selectedItem?.sql) return;
          const sql = selectedItem.kind === 'cube' && selectedItem.table
            ? `SELECT * FROM ${selectedItem.table} LIMIT 25`
            : selectedItem.sql;
          dispatch({ type: 'ADD_CELL', cell: makeCell('sql', sql) });
        }}
        onCopySql={() => {
          if (selectedItem?.sql) {
            void navigator.clipboard.writeText(selectedItem.sql);
          }
        }}
        onToggleFavorite={() => {
          if (selectedItem && (selectedItem.kind === 'metric' || selectedItem.kind === 'dimension')) {
            void api.toggleFavorite(selectedItem.name).then((favorites) => dispatch({ type: 'SET_SEMANTIC_FAVORITES', favorites }));
          }
        }}
        t={t}
      />
    </div>
  );
}
