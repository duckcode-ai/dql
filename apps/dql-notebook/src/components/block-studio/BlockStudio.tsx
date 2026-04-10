import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { insertSemanticReference } from '../../editor/semantic-completions';
import { useNotebook } from '../../store/NotebookStore';
import type {
  BlockStudioDiagnostic,
  DatabaseSchemaNode,
  SemanticObjectDetail,
  SemanticTreeNode,
} from '../../store/types';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { SQLCellEditor } from '../cells/SQLCellEditor';
import { ChartOutput, CHART_TYPE_OPTIONS } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { MetricDetailPanel } from '../sidebar/MetricDetailPanel';
import { SemanticSearchBar } from '../sidebar/SemanticSearchBar';
import { SemanticTreeNode as TreeRow } from '../sidebar/SemanticTreeNode';
import {
  buildSemanticRef,
  parseBlockFields,
  setBlockName,
  setBlockStringField,
  setBlockTags,
  upsertVisualizationConfig,
} from '../../utils/block-studio';

type ExplorerTab = 'semantic' | 'database';
type ResultTab = 'validate' | 'results' | 'visualization' | 'save';

interface FlatSemanticRow {
  node: SemanticTreeNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

const TREE_ROW_HEIGHT = 31;
const TREE_OVERSCAN = 10;

export function BlockStudio() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [explorerTab, setExplorerTab] = useState<ExplorerTab>('semantic');
  const [resultTab, setResultTab] = useState<ResultTab>('validate');
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [cubeFilter, setCubeFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedSemanticId, setSelectedSemanticId] = useState<string | null>(null);
  const [selectedSemanticObject, setSelectedSemanticObject] = useState<SemanticObjectDetail | null>(null);
  const [databaseTree, setDatabaseTree] = useState<DatabaseSchemaNode[]>([]);
  const [expandedDbNodes, setExpandedDbNodes] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const semanticTreeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG_LOADING', loading: true });
    void api.getBlockStudioCatalog()
      .then((catalog) => {
        dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG', catalog });
        setDatabaseTree(catalog.databaseTree);
      })
      .finally(() => dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG_LOADING', loading: false }));
  }, [dispatch]);

  useEffect(() => {
    if (!selectedSemanticId || selectedSemanticId.startsWith('provider:') || selectedSemanticId.startsWith('domain:') || selectedSemanticId.startsWith('group:')) {
      setSelectedSemanticObject(null);
      return;
    }
    void api.getSemanticObject(selectedSemanticId)
      .then(setSelectedSemanticObject)
      .catch(() => setSelectedSemanticObject(null));
  }, [selectedSemanticId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!state.blockStudioDraft.trim()) return;
      void api.validateBlockStudio(state.blockStudioDraft, state.activeBlockPath)
        .then((validation) => dispatch({ type: 'SET_BLOCK_STUDIO_VALIDATION', validation }))
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [state.blockStudioDraft, state.activeBlockPath, dispatch]);

  const semanticTree = state.blockStudioCatalog?.semanticTree ?? null;
  const providerOptions = useMemo(() => collectFacetValues(semanticTree, 'provider'), [semanticTree]);
  const cubeOptions = useMemo(() => collectFacetValues(semanticTree, 'cube'), [semanticTree]);
  const ownerOptions = useMemo(() => collectFacetValues(semanticTree, 'owner'), [semanticTree]);

  const filteredSemanticTree = useMemo(() => {
    if (!semanticTree) return null;
    return filterSemanticTree(semanticTree, {
      query,
      provider: providerFilter,
      domain: domainFilter,
      cube: cubeFilter,
      owner: ownerFilter,
      tag: tagFilter,
      type: typeFilter,
    });
  }, [semanticTree, query, providerFilter, domainFilter, cubeFilter, ownerFilter, tagFilter, typeFilter]);

  const flatSemanticRows = useMemo(
    () => flattenSemanticRows(filteredSemanticTree?.children ?? [], expanded),
    [filteredSemanticTree, expanded],
  );
  const totalTreeHeight = flatSemanticRows.length * TREE_ROW_HEIGHT;
  const visibleRows = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
    const endIndex = Math.min(flatSemanticRows.length, Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + TREE_OVERSCAN);
    return {
      offsetTop: startIndex * TREE_ROW_HEIGHT,
      rows: flatSemanticRows.slice(startIndex, endIndex),
    };
  }, [flatSemanticRows, scrollTop, viewportHeight]);

  useEffect(() => {
    const element = semanticTreeRef.current;
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
  }, []);

  const draftMetadata = useMemo(() => {
    const parsed = parseBlockFields(state.blockStudioDraft);
    if (!state.blockStudioMetadata) return parsed;
    return {
      ...parsed,
      name: parsed?.name || state.blockStudioMetadata.name,
      domain: parsed?.domain || state.blockStudioMetadata.domain,
      description: parsed?.description || state.blockStudioMetadata.description,
      owner: parsed?.owner || state.blockStudioMetadata.owner,
      tags: parsed?.tags?.length ? parsed.tags : state.blockStudioMetadata.tags,
      blockType: parsed?.blockType || 'custom',
    };
  }, [state.blockStudioDraft, state.blockStudioMetadata]);

  const handleDraftChange = (draft: string) => {
    dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft });
  };

  const handleRun = async () => {
    setRunning(true);
    try {
      const preview = await api.runBlockStudio(state.blockStudioDraft, state.activeBlockPath);
      dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview });
      setResultTab('results');
    } finally {
      setRunning(false);
    }
  };

  const handleSave = async () => {
    if (!state.blockStudioMetadata) return;
    setSaving(true);
    try {
      const payload = await api.saveBlockStudio({
        path: state.activeBlockPath,
        source: state.blockStudioDraft,
        metadata: {
          name: state.blockStudioMetadata.name,
          domain: state.blockStudioMetadata.domain,
          description: state.blockStudioMetadata.description,
          owner: state.blockStudioMetadata.owner,
          tags: state.blockStudioMetadata.tags,
        },
      });
      dispatch({
        type: 'OPEN_BLOCK_STUDIO',
        file: {
          name: `${payload.metadata.name}.dql`,
          path: payload.path,
          type: 'block',
          folder: 'blocks',
        },
        payload,
      });
      const existing = state.files.some((file) => file.path === payload.path);
      if (!existing) {
        dispatch({
          type: 'FILE_ADDED',
          file: {
            name: `${payload.metadata.name}.dql`,
            path: payload.path,
            type: 'block',
            folder: 'blocks',
          },
        });
      }
      setResultTab('save');
    } finally {
      setSaving(false);
    }
  };

  const handleSemanticInsert = (item: SemanticObjectDetail) => {
    if (item.kind === 'metric' || item.kind === 'dimension') {
      const ref = buildSemanticRef(item.kind === 'metric' ? 'metric' : 'dimension', item.name);
      if (!insertSemanticReference(ref)) {
        handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, ref));
      }
      return;
    }
    if (item.kind === 'segment' && item.sql) {
      handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, `/* segment:${item.name} */ (${item.sql})`));
      return;
    }
    if (item.kind === 'pre_aggregation') {
      handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, `/* pre_aggregation:${item.name} */`));
    }
  };

  const handleDatabaseInsert = (snippet: string) => {
    handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, snippet));
  };

  const ensureDbColumns = async (node: DatabaseSchemaNode) => {
    if (!node.path || node.kind !== 'table' || (node.children && node.children.length > 0)) return;
    const columns = await api.describeTable(node.path);
    setDatabaseTree((prev) => updateDatabaseTree(prev, node.id, {
      ...node,
      children: columns.map((column) => ({
        id: `db-column:${node.path}:${column.name}`,
        label: column.name,
        kind: 'column' as const,
        path: node.path,
        type: column.type,
      })),
    }));
  };

  const currentChart = state.blockStudioValidation?.chartConfig ?? state.blockStudioPreview?.chartConfig ?? { chart: 'table' };

  return (
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr) 360px', overflow: 'hidden', background: t.appBg }}>
      <div style={{ borderRight: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: t.sidebarBg }}>
        <div style={{ display: 'flex', padding: 10, gap: 8, borderBottom: `1px solid ${t.headerBorder}` }}>
          <ExplorerTabButton active={explorerTab === 'semantic'} onClick={() => setExplorerTab('semantic')} label="Semantic Layer" />
          <ExplorerTabButton active={explorerTab === 'database'} onClick={() => setExplorerTab('database')} label="Database" />
        </div>

        {explorerTab === 'semantic' ? (
          <>
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
              domains={state.semanticLayer.domains}
              tags={state.semanticLayer.tags}
              onQueryChange={setQuery}
              onProviderChange={setProviderFilter}
              onCubeChange={setCubeFilter}
              onOwnerChange={setOwnerFilter}
              onDomainChange={setDomainFilter}
              onTagChange={setTagFilter}
              onTypeChange={setTypeFilter}
              t={t}
            />
            <div
              ref={semanticTreeRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              style={{ flex: 1, overflowY: 'auto', borderBottom: `1px solid ${t.headerBorder}` }}
            >
              <div style={{ height: totalTreeHeight, position: 'relative' }}>
                <div style={{ position: 'absolute', top: visibleRows.offsetTop, left: 0, right: 0 }}>
                  {visibleRows.rows.map((row) => (
                    <SemanticRow
                      key={row.node.id}
                      row={row}
                      selectedId={selectedSemanticId}
                      setSelectedId={setSelectedSemanticId}
                      expanded={expanded}
                      setExpanded={setExpanded}
                      onInsert={handleSemanticInsert}
                      favorites={new Set(state.semanticLayer.favorites)}
                      dispatch={dispatch}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            </div>
            <MetricDetailPanel
              item={selectedSemanticObject}
              favorite={Boolean(selectedSemanticObject && state.semanticLayer.favorites.includes(selectedSemanticObject.name))}
              onInsert={() => selectedSemanticObject && handleSemanticInsert(selectedSemanticObject)}
              onPreview={() => {
                if (selectedSemanticObject?.sql) {
                  handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, selectedSemanticObject.sql));
                }
              }}
              onCopySql={() => {
                if (selectedSemanticObject?.sql) void navigator.clipboard.writeText(selectedSemanticObject.sql);
              }}
              onToggleFavorite={() => {
                if (!selectedSemanticObject || (selectedSemanticObject.kind !== 'metric' && selectedSemanticObject.kind !== 'dimension')) return;
                void api.toggleFavorite(selectedSemanticObject.name)
                  .then((favorites) => dispatch({ type: 'SET_SEMANTIC_FAVORITES', favorites }));
              }}
              t={t}
            />
          </>
        ) : (
          <DatabaseExplorer
            tree={databaseTree}
            expanded={expandedDbNodes}
            setExpanded={setExpandedDbNodes}
            onEnsureColumns={ensureDbColumns}
            onInsert={handleDatabaseInsert}
            t={t}
          />
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
            Source
          </span>
          <div style={{ flex: 1 }} />
          <TemplateButton label="Semantic Skeleton" onClick={() => handleDraftChange(buildSemanticSkeleton(state.blockStudioMetadata?.name ?? 'New Block'))} />
          <TemplateButton label="Custom Skeleton" onClick={() => handleDraftChange(buildCustomSkeleton(state.blockStudioMetadata?.name ?? 'New Block'))} />
          <TemplateButton label="Run" onClick={() => void handleRun()} busy={running} />
          <TemplateButton label="Save" onClick={() => void handleSave()} busy={saving} />
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <SQLCellEditor
            value={state.blockStudioDraft}
            onChange={handleDraftChange}
            onRun={() => void handleRun()}
            themeMode={state.themeMode}
            autoFocus
            errorMessage={state.blockStudioValidation?.diagnostics.find((item) => item.severity === 'error')?.message}
          />
        </div>
      </div>

      <div style={{ borderLeft: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: t.cellBg }}>
        <div style={{ display: 'flex', padding: 10, gap: 8, borderBottom: `1px solid ${t.headerBorder}`, flexWrap: 'wrap' }}>
          <ExplorerTabButton active={resultTab === 'validate'} onClick={() => setResultTab('validate')} label="Validate" />
          <ExplorerTabButton active={resultTab === 'results'} onClick={() => setResultTab('results')} label="Results" />
          <ExplorerTabButton active={resultTab === 'visualization'} onClick={() => setResultTab('visualization')} label="Visualization" />
          <ExplorerTabButton active={resultTab === 'save'} onClick={() => setResultTab('save')} label="Save" />
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {resultTab === 'validate' && (
            <DiagnosticsPanel diagnostics={state.blockStudioValidation?.diagnostics ?? []} t={t} />
          )}
          {resultTab === 'results' && (
            state.blockStudioPreview ? (
              <div style={{ display: 'grid', gap: 12, padding: 12 }}>
                <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>{state.blockStudioPreview.sql}</div>
                <ChartOutput
                  result={state.blockStudioPreview.result}
                  chartConfig={state.blockStudioPreview.chartConfig}
                  themeMode={state.themeMode}
                />
                <TableOutput result={state.blockStudioPreview.result} themeMode={state.themeMode} />
              </div>
            ) : (
              <EmptyPanel message="Run the block to preview results and visualization." />
            )
          )}
          {resultTab === 'visualization' && (
            <VisualizationPanel
              chartConfig={currentChart}
              onChange={(next) => handleDraftChange(upsertVisualizationConfig(state.blockStudioDraft, next))}
              t={t}
            />
          )}
          {resultTab === 'save' && (
            <SavePanel
              metadata={state.blockStudioMetadata}
              draftMetadata={draftMetadata}
              onChange={(next) => {
                if (!state.blockStudioMetadata) return;
                dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, ...next } });
                let draft = state.blockStudioDraft;
                if (typeof next.name === 'string') draft = setBlockName(draft, next.name);
                if (typeof next.domain === 'string') draft = setBlockStringField(draft, 'domain', next.domain);
                if (typeof next.owner === 'string') draft = setBlockStringField(draft, 'owner', next.owner);
                if (typeof next.description === 'string') draft = setBlockStringField(draft, 'description', next.description);
                if (next.tags) draft = setBlockTags(draft, next.tags);
                handleDraftChange(draft);
              }}
              onSave={() => void handleSave()}
              saving={saving}
              t={t}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ExplorerTabButton({ active, onClick, label, busy }: { active: boolean; onClick: () => void; label: string; busy?: boolean }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? `${t.accent}18` : t.btnBg,
        border: `1px solid ${active ? t.accent : t.btnBorder}`,
        borderRadius: 6,
        color: active ? t.accent : t.textSecondary,
        cursor: 'pointer',
        fontSize: 11,
        fontFamily: t.font,
        padding: '6px 10px',
        opacity: busy ? 0.7 : 1,
      }}
    >
      {busy ? `${label}…` : label}
    </button>
  );
}

function TemplateButton(props: { label: string; onClick: () => void; busy?: boolean }) {
  return <ExplorerTabButton active={false} {...props} />;
}

function DiagnosticsPanel({ diagnostics, t }: { diagnostics: BlockStudioDiagnostic[]; t: Theme }) {
  if (diagnostics.length === 0) {
    return <EmptyPanel message="No validation messages." />;
  }
  return (
    <div style={{ display: 'grid', gap: 8, padding: 12 }}>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.code ?? diagnostic.message}-${index}`}
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${diagnostic.severity === 'error' ? t.error : diagnostic.severity === 'warning' ? t.warning : t.cellBorder}`,
            background: diagnostic.severity === 'error' ? `${t.error}12` : diagnostic.severity === 'warning' ? `${t.warning}12` : t.pillBg,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: diagnostic.severity === 'error' ? t.error : diagnostic.severity === 'warning' ? t.warning : t.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {diagnostic.severity}
          </div>
          <div style={{ fontSize: 12, color: t.textPrimary, marginTop: 4 }}>{diagnostic.message}</div>
        </div>
      ))}
    </div>
  );
}

function VisualizationPanel({
  chartConfig,
  onChange,
  t,
}: {
  chartConfig: { chart?: string; x?: string; y?: string; color?: string; title?: string };
  onChange: (config: { chart?: string; x?: string; y?: string; color?: string; title?: string }) => void;
  t: Theme;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
  };

  return (
    <div style={{ display: 'grid', gap: 10, padding: 12 }}>
      <select value={chartConfig.chart ?? 'table'} onChange={(event) => onChange({ ...chartConfig, chart: event.target.value })} style={inputStyle}>
        <option value="table">Table</option>
        {CHART_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <input value={chartConfig.x ?? ''} onChange={(event) => onChange({ ...chartConfig, x: event.target.value })} placeholder="x binding" style={inputStyle} />
      <input value={chartConfig.y ?? ''} onChange={(event) => onChange({ ...chartConfig, y: event.target.value })} placeholder="y binding" style={inputStyle} />
      <input value={chartConfig.color ?? ''} onChange={(event) => onChange({ ...chartConfig, color: event.target.value })} placeholder="color binding" style={inputStyle} />
      <input value={chartConfig.title ?? ''} onChange={(event) => onChange({ ...chartConfig, title: event.target.value })} placeholder="title" style={inputStyle} />
    </div>
  );
}

function SavePanel({
  metadata,
  draftMetadata,
  onChange,
  onSave,
  saving,
  t,
}: {
  metadata: { name: string; domain: string; description: string; owner: string; tags: string[] } | null;
  draftMetadata: ReturnType<typeof parseBlockFields> | null;
  onChange: (next: Partial<{ name: string; domain: string; description: string; owner: string; tags: string[] }>) => void;
  onSave: () => void;
  saving: boolean;
  t: Theme;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
  };

  const values = {
    name: draftMetadata?.name || metadata?.name || '',
    domain: draftMetadata?.domain || metadata?.domain || 'uncategorized',
    description: draftMetadata?.description || metadata?.description || '',
    owner: draftMetadata?.owner || metadata?.owner || '',
    tags: draftMetadata?.tags || metadata?.tags || [],
  };

  return (
    <div style={{ display: 'grid', gap: 10, padding: 12 }}>
      <input value={values.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="Block name" style={inputStyle} />
      <input value={values.domain} onChange={(event) => onChange({ domain: event.target.value })} placeholder="Domain" style={inputStyle} />
      <input value={values.owner} onChange={(event) => onChange({ owner: event.target.value })} placeholder="Owner" style={inputStyle} />
      <input value={values.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="Description" style={inputStyle} />
      <input value={values.tags.join(', ')} onChange={(event) => onChange({ tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder="Tags" style={inputStyle} />
      <button
        onClick={onSave}
        style={{
          background: t.accent,
          border: `1px solid ${t.accent}`,
          borderRadius: 6,
          color: '#fff',
          cursor: 'pointer',
          fontSize: 12,
          fontFamily: t.font,
          padding: '8px 12px',
        }}
      >
        {saving ? 'Saving…' : 'Save Block'}
      </button>
    </div>
  );
}

function EmptyPanel({ message }: { message: string }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return <div style={{ padding: 16, fontSize: 12, color: t.textMuted }}>{message}</div>;
}

function DatabaseExplorer({
  tree,
  expanded,
  setExpanded,
  onEnsureColumns,
  onInsert,
  t,
}: {
  tree: DatabaseSchemaNode[];
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onEnsureColumns: (node: DatabaseSchemaNode) => Promise<void>;
  onInsert: (snippet: string) => void;
  t: Theme;
}) {
  const renderNode = (node: DatabaseSchemaNode, depth: number = 0): React.ReactNode => {
    const hasChildren = node.kind !== 'column';
    const isExpanded = expanded[node.id] ?? depth < 1;
    return (
      <div key={node.id}>
        <TreeRow
          label={node.label}
          depth={depth}
          expanded={hasChildren ? isExpanded : undefined}
          onToggle={hasChildren ? () => {
            setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }));
            if (!isExpanded) void onEnsureColumns(node);
          } : undefined}
          badge={node.kind === 'column' ? node.type : node.kind}
          onClick={() => {
            if (node.kind === 'table' && node.path) onInsert(node.path);
            if (node.kind === 'column') onInsert(node.label);
          }}
          t={t}
        />
        {hasChildren && isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingTop: 6 }}>
      {tree.map((node) => renderNode(node))}
    </div>
  );
}

function SemanticRow({
  row,
  selectedId,
  setSelectedId,
  expanded,
  setExpanded,
  onInsert,
  favorites,
  dispatch,
  t,
}: {
  row: FlatSemanticRow;
  selectedId: string | null;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onInsert: (item: SemanticObjectDetail) => void;
  favorites: Set<string>;
  dispatch: ReturnType<typeof useNotebook>['dispatch'];
  t: Theme;
}) {
  const { node, depth, hasChildren, isExpanded } = row;
  const refName = node.id.split(':').slice(1).join(':');
  if (hasChildren) {
    return (
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
    );
  }

  return (
    <TreeRow
      label={node.label}
      depth={depth}
      badge={node.kind}
      selected={selectedId === node.id}
      onClick={() => setSelectedId(node.id)}
      onDoubleClick={() => {
        void api.getSemanticObject(node.id).then(onInsert).catch(() => undefined);
      }}
      onFavoriteToggle={node.kind === 'metric' || node.kind === 'dimension'
        ? () => void api.toggleFavorite(refName).then((next) => dispatch({ type: 'SET_SEMANTIC_FAVORITES', favorites: next }))
        : undefined}
      favorite={node.kind === 'metric' || node.kind === 'dimension' ? favorites.has(refName) : undefined}
      t={t}
    />
  );
}

function appendSnippetToDraft(source: string, snippet: string): string {
  const queryMatch = source.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (queryMatch) {
    return source.replace(queryMatch[0], `query = """${queryMatch[1].trimEnd()}\n${snippet}\n"""`);
  }
  if (/^\s*block\s+"/i.test(source.trim())) {
    return source.replace(/\n\}\s*$/, `\n\n  query = """\n${snippet}\n  """\n}\n`);
  }
  return `${source.trimEnd()}\n${snippet}\n`;
}

function buildSemanticSkeleton(name: string): string {
  return `block "${name}" {
  domain = "uncategorized"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  metric = "total_revenue"

  visualization {
    chart = "table"
  }
}
`;
}

function buildCustomSkeleton(name: string): string {
  return `block "${name}" {
  domain = "uncategorized"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT 1 AS value
"""

  visualization {
    chart = "table"
  }
}
`;
}

function collectFacetValues(node: SemanticTreeNode | null, key: string): string[] {
  if (!node) return [];
  const values = new Set<string>();
  const visit = (current: SemanticTreeNode) => {
    const value = current.meta?.[key];
    if (typeof value === 'string' && value.trim()) values.add(value.trim());
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function filterSemanticTree(node: SemanticTreeNode, filters: { query: string; provider: string; domain: string; cube: string; owner: string; tag: string; type: string }): SemanticTreeNode | null {
  const q = filters.query.trim().toLowerCase();
  const metaValues = Object.values(node.meta ?? {})
    .filter((value): value is string | number | boolean => value != null)
    .map((value) => String(value).toLowerCase());
  const matchesQuery = !q || node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q) || metaValues.some((value) => value.includes(q));
  const matchesType = !filters.type || node.kind === filters.type || node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group';
  const matchesDomain = !filters.domain || node.kind === 'provider' || node.kind === 'group' || node.meta?.domain === filters.domain || (node.kind === 'domain' && node.label === filters.domain);
  const matchesProvider = !filters.provider || node.meta?.provider === filters.provider || node.id === `provider:${filters.provider}`;
  const matchesCube = !filters.cube || node.meta?.cube === filters.cube;
  const matchesOwner = !filters.owner || node.meta?.owner === filters.owner;
  const matchesTag = !filters.tag || String(node.meta?.tags ?? '').split(',').filter(Boolean).includes(filters.tag);

  const children = (node.children ?? [])
    .map((child) => filterSemanticTree(child, filters))
    .filter((child): child is SemanticTreeNode => Boolean(child));

  if (children.length > 0) {
    return { ...node, children, count: node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group' ? children.length : node.count };
  }

  return matchesQuery && matchesType && matchesDomain && matchesProvider && matchesCube && matchesOwner && matchesTag
    ? { ...node, children: [] }
    : null;
}

function flattenSemanticRows(nodes: SemanticTreeNode[], expanded: Record<string, boolean>, depth: number = 0): FlatSemanticRow[] {
  const rows: FlatSemanticRow[] = [];
  for (const node of nodes) {
    const hasChildren = Boolean(node.children && node.children.length > 0);
    const isExpanded = expanded[node.id] ?? depth < 2;
    rows.push({ node, depth, hasChildren, isExpanded });
    if (hasChildren && isExpanded) {
      rows.push(...flattenSemanticRows(node.children ?? [], expanded, depth + 1));
    }
  }
  return rows;
}

function updateDatabaseTree(tree: DatabaseSchemaNode[], nodeId: string, replacement: DatabaseSchemaNode): DatabaseSchemaNode[] {
  return tree.map((node) => {
    if (node.id === nodeId) return replacement;
    if (!node.children) return node;
    return { ...node, children: updateDatabaseTree(node.children, nodeId, replacement) };
  });
}
