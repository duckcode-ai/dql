import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { insertSemanticReference } from '../../editor/semantic-completions';
import { useNotebook } from '../../store/NotebookStore';
import type {
  BlockStudioDiagnostic,
  DatabaseSchemaNode,
  SemanticLayerState,
  SemanticObjectDetail,
  SemanticTreeNode,
} from '../../store/types';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { SQLCellEditor } from '../cells/SQLCellEditor';
import { ChartOutput, CHART_TYPE_OPTIONS, resolveChartType } from '../output/ChartOutput';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';
import { LineagePathSection, LayerSummary } from '../lineage/LineagePathBreadcrumb';
import type { CompletePathResult } from '../lineage/lineage-constants';
import { TableOutput } from '../output/TableOutput';
import { MetricDetailPanel } from '../panels/MetricDetailPanel';
import { SemanticSearchBar } from '../panels/SemanticSearchBar';
import { SemanticTreeNode as TreeRow } from '../panels/SemanticTreeNode';
import {
  appendSemanticRefToQuery,
  buildSemanticRef,
  parseBlockFields,
  setBlockName,
  setBlockStringField,
  setBlockTags,
  upsertSemanticSelection,
  upsertVisualizationConfig,
} from '../../utils/block-studio';
import { getTypeColor } from '../../utils/type-colors';

type ExplorerTab = 'semantic' | 'database';
type ResultTab = 'validate' | 'results' | 'visualization' | 'lineage' | 'save' | 'history' | 'tests';

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
  const [databaseQuery, setDatabaseQuery] = useState('');
  const [loadingDbNodes, setLoadingDbNodes] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<Array<{ hash: string; date: string; author: string; message: string }>>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [testResults, setTestResults] = useState<Array<{ field: string; operator: string; expected: string; passed: boolean; actual?: string }> | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageDetail, setLineageDetail] = useState<{
    node: { id: string; type: string; name: string; domain?: string } | null;
    incoming: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
    outgoing: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
  } | null>(null);
  const [lineageGraph, setLineageGraph] = useState<{ nodes: Array<{ id: string; type: string; name: string; domain?: string; layer?: string }>; edges: Array<{ source: string; target: string; type: string }> } | null>(null);
  const [lineagePaths, setLineagePaths] = useState<CompletePathResult | null>(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [leftPaneWidth, setLeftPaneWidth] = useState(300);
  const [bottomPaneHeight, setBottomPaneHeight] = useState(420);
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(false);
  const [bottomPaneCollapsed, setBottomPaneCollapsed] = useState(false);
  const semanticTreeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG_LOADING', loading: true });
    setCatalogError(null);
    void api.getBlockStudioCatalog()
      .then((catalog) => {
        dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG', catalog });
        setDatabaseTree(catalog.databaseTree);
      })
      .catch(() => {
        setCatalogError('Failed to load schema. Check your connection and try refreshing.');
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
  const effectiveSemanticTree = useMemo(
    () => hasSemanticNodes(semanticTree) ? semanticTree : buildFallbackSemanticTree(state.semanticLayer),
    [semanticTree, state.semanticLayer],
  );
  const providerOptions = useMemo(() => collectFacetValues(effectiveSemanticTree, 'provider'), [effectiveSemanticTree]);
  const cubeOptions = useMemo(() => collectFacetValues(effectiveSemanticTree, 'cube'), [effectiveSemanticTree]);
  const ownerOptions = useMemo(() => collectFacetValues(effectiveSemanticTree, 'owner'), [effectiveSemanticTree]);

  const filteredSemanticTree = useMemo(() => {
    if (!effectiveSemanticTree) return null;
    return filterSemanticTree(effectiveSemanticTree, {
      query,
      provider: providerFilter,
      domain: domainFilter,
      cube: cubeFilter,
      owner: ownerFilter,
      tag: tagFilter,
      type: typeFilter,
    });
  }, [effectiveSemanticTree, query, providerFilter, domainFilter, cubeFilter, ownerFilter, tagFilter, typeFilter]);

  const flatSemanticRows = useMemo(
    () => flattenSemanticRows(filteredSemanticTree?.children ?? [], expanded),
    [filteredSemanticTree, expanded],
  );
  const filteredDatabaseTree = useMemo(
    () => filterDatabaseTree(databaseTree, databaseQuery),
    [databaseTree, databaseQuery],
  );
  const databaseStats = useMemo(
    () => summarizeDatabaseTree(databaseTree),
    [databaseTree],
  );
  const semanticStats = {
    metrics: state.semanticLayer.metrics.length,
    dimensions: state.semanticLayer.dimensions.length,
    hierarchies: state.semanticLayer.hierarchies.length,
  };
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

  useEffect(() => {
    setScrollTop(0);
    if (semanticTreeRef.current) semanticTreeRef.current.scrollTop = 0;
  }, [query, providerFilter, domainFilter, cubeFilter, ownerFilter, tagFilter, typeFilter]);

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
  const activeBlockName = draftMetadata?.name ?? state.blockStudioMetadata?.name ?? null;

  useEffect(() => {
    if (!activeBlockName) return;
    const nodeId = `block:${activeBlockName}`;
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
    setLineageLoading(true);
    void Promise.all([
      api.fetchLineageNode(nodeId),
      api.queryLineage({ focus: nodeId }),
      api.fetchLineagePaths(nodeId),
    ])
      .then(([detail, focused, paths]) => {
        setLineageDetail(detail);
        setLineageGraph(focused.graph ?? null);
        setLineagePaths(paths);
      })
      .catch(() => {
        setLineageDetail(null);
        setLineageGraph(null);
        setLineagePaths(null);
      })
      .finally(() => setLineageLoading(false));
  }, [activeBlockName, dispatch]);

  const handleDraftChange = (draft: string) => {
    dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft });
  };

  const handleRun = async () => {
    setRunning(true);
    try {
      const preview = await api.runBlockStudio(state.blockStudioDraft, state.activeBlockPath);
      dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview });
      setResultTab('results');
    } catch (error) {
      dispatch({
        type: 'SET_BLOCK_STUDIO_VALIDATION',
        validation: {
          valid: false,
          chartConfig: state.blockStudioValidation?.chartConfig,
          executableSql: state.blockStudioValidation?.executableSql ?? null,
          semanticRefs: state.blockStudioValidation?.semanticRefs ?? { metrics: [], dimensions: [], segments: [] },
          diagnostics: [
            {
              severity: 'error',
              code: 'block_run_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      });
      setResultTab('validate');
    } finally {
      setRunning(false);
    }
  };

  const handleSave = async () => {
    // If no metadata yet (new block), open the New Block modal to collect a name
    if (!state.blockStudioMetadata) {
      dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' });
      return;
    }
    setSaving(true);
    setSaveError(null);
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
    } catch (err: any) {
      const msg = err?.message ?? 'Save failed';
      setSaveError(msg.includes('409') || msg.includes('BLOCK_EXISTS') ? 'A block with this name already exists. Rename and try again.' : msg);
      setTimeout(() => setSaveError(null), 5000);
    } finally {
      setSaving(false);
    }
  };

  const handleSemanticInsert = (item: SemanticObjectDetail) => {
    if (item.kind === 'metric' || item.kind === 'dimension') {
      const ref = buildSemanticRef(item.kind === 'metric' ? 'metric' : 'dimension', item.name);
      const blockType = parseBlockFields(state.blockStudioDraft)?.blockType ?? 'custom';
      if (blockType === 'semantic') {
        handleDraftChange(upsertSemanticSelection(state.blockStudioDraft, {
          kind: item.kind === 'metric' ? 'metric' : 'dimension',
          name: item.name,
        }));
      } else if (!insertSemanticReference(ref)) {
        handleDraftChange(appendSemanticRefToQuery(state.blockStudioDraft, ref));
      }
      dispatch({ type: 'ADD_SEMANTIC_RECENT', name: item.name });
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
    setLoadingDbNodes((prev) => new Set(prev).add(node.id));
    try {
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
    } finally {
      setLoadingDbNodes((prev) => { const next = new Set(prev); next.delete(node.id); return next; });
    }
  };

  const refreshDatabaseTree = useCallback(async () => {
    try {
      const catalog = await api.getBlockStudioCatalog();
      if (catalog?.databaseTree) {
        setDatabaseTree(catalog.databaseTree);
      }
      dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG', catalog });
    } catch { /* non-fatal */ }
  }, [dispatch]);

  const currentChart = state.blockStudioValidation?.chartConfig ?? state.blockStudioPreview?.chartConfig ?? { chart: 'table' };
  const activeResultChartType = state.blockStudioPreview
    ? resolveChartType(state.blockStudioPreview.result, state.blockStudioPreview.chartConfig)
    : 'table';
  const startLeftResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftPaneWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(520, Math.max(280, startWidth + moveEvent.clientX - startX));
      setLeftPaneWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startBottomResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomPaneHeight;
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(520, Math.max(180, startHeight - (moveEvent.clientY - startY)));
      setBottomPaneHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: leftPaneCollapsed ? '0 0 minmax(0, 1fr)' : `${leftPaneWidth}px 6px minmax(0, 1fr)`,
        gridTemplateRows: bottomPaneCollapsed ? 'minmax(0, 1fr) 0 0' : `minmax(0, 1fr) 6px ${bottomPaneHeight}px`,
        overflow: 'hidden',
        background: t.appBg,
      }}
    >
      <div style={{ borderRight: leftPaneCollapsed ? 'none' : `1px solid ${t.headerBorder}`, display: leftPaneCollapsed ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden', background: t.sidebarBg, minWidth: 0 }}>
        {/* v1.3.3 Hex cleanup — single compact header row; drop wordy
            description and the empty 3-up stat cards in favor of an
            inline count chip. */}
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${t.headerBorder}` }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: t.textMuted, textTransform: 'uppercase' as const, fontFamily: t.font }}>
            Explorer
          </span>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            {semanticStats.metrics} metrics · {semanticStats.dimensions} dims · {semanticStats.hierarchies} hier
          </span>
          <div style={{ flex: 1 }} />
          {state.semanticLayer.provider && (
            <span style={{ fontSize: 9, fontWeight: 700, color: t.accent, background: `${t.accent}18`, borderRadius: 999, padding: '2px 7px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {state.semanticLayer.provider}
            </span>
          )}
          <button
            onClick={() => setLeftPaneCollapsed(true)}
            style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 14, fontFamily: t.font, padding: 0, lineHeight: 1 }}
            title="Collapse explorer"
          >
            ‹
          </button>
        </div>

        {/* v1.3.3 Hex cleanup — Semantic/Database as compact segmented
            pair with inline underline (no bordered button boxes). */}
        <div style={{ display: 'flex', padding: '0 14px', gap: 16, borderBottom: `1px solid ${t.headerBorder}` }}>
          <SegmentedTab active={explorerTab === 'semantic'} onClick={() => setExplorerTab('semantic')} label="Semantic" t={t} />
          <SegmentedTab active={explorerTab === 'database'} onClick={() => setExplorerTab('database')} label="Database" t={t} />
        </div>

        {explorerTab === 'semantic' ? (
          <>
            <div style={{ padding: 12, borderBottom: `1px solid ${t.headerBorder}`, background: `${t.cellBg}66` }}>
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
            </div>
            <div
              ref={semanticTreeRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              style={{ flex: 1, overflowY: 'auto', borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg }}
            >
              {catalogError ? (
                <div style={{ padding: 16, display: 'grid', gap: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 12, color: '#f85149', fontFamily: t.font }}>{catalogError}</div>
                  <button
                    onClick={() => { setCatalogError(null); void refreshDatabaseTree(); }}
                    style={{ fontSize: 11, color: t.accent, background: `${t.accent}18`, border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontFamily: t.font }}
                  >
                    Retry
                  </button>
                </div>
              ) : state.blockStudioCatalogLoading ? (
                <EmptyPanel message="Loading semantic catalog…" />
              ) : flatSemanticRows.length === 0 ? (
                <EmptyPanel message="No semantic objects match the current filters." />
              ) : (
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
              )}
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
            tree={filteredDatabaseTree}
            totalTree={databaseTree}
            expanded={expandedDbNodes}
            setExpanded={setExpandedDbNodes}
            onEnsureColumns={ensureDbColumns}
            onInsert={handleDatabaseInsert}
            query={databaseQuery}
            onQueryChange={setDatabaseQuery}
            stats={databaseStats}
            connectionName={state.blockStudioCatalog?.connection.current ?? 'default'}
            loadingNodes={loadingDbNodes}
            onRefresh={refreshDatabaseTree}
            t={t}
          />
        )}
      </div>

      <div
        onMouseDown={leftPaneCollapsed ? undefined : startLeftResize}
        style={{
          display: leftPaneCollapsed ? 'none' : 'block',
          cursor: 'col-resize',
          background: t.headerBorder,
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', gridColumn: '3', gridRow: '1' }}>
        {/* v1.3.3 Hex cleanup — tight single-row editor toolbar to match
            the explorer header; drop wordy subtitle. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg }}>
          {leftPaneCollapsed && (
            <button
              onClick={() => setLeftPaneCollapsed(false)}
              style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 14, fontFamily: t.font, padding: 0, lineHeight: 1 }}
              title="Open explorer"
            >
              ›
            </button>
          )}
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: t.textMuted, textTransform: 'uppercase' as const, fontFamily: t.font }}>
            Source
          </span>
          <div style={{ flex: 1 }} />
          <TemplateButton label="Run" onClick={() => void handleRun()} busy={running} />
          <TemplateButton label="Save" onClick={() => void handleSave()} busy={saving} />
          {saveError && (
            <span style={{ fontSize: 11, color: '#f85149', fontFamily: t.font, padding: '4px 8px', background: '#f8514918', borderRadius: 6 }}>
              {saveError}
            </span>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <SQLCellEditor
            value={state.blockStudioDraft}
            onChange={handleDraftChange}
            onRun={() => void handleRun()}
            themeMode={state.themeMode}
            autoFocus
            wrap={false}
            errorMessage={state.blockStudioValidation?.diagnostics.find((item) => item.severity === 'error')?.message}
          />
        </div>
      </div>

      <div
        onMouseDown={bottomPaneCollapsed ? undefined : startBottomResize}
        style={{
          gridColumn: '1 / -1',
          gridRow: '2',
          display: bottomPaneCollapsed ? 'none' : 'block',
          cursor: 'row-resize',
          background: t.headerBorder,
        }}
      />

      <div style={{ gridColumn: '1 / -1', gridRow: '3', borderTop: bottomPaneCollapsed ? 'none' : `1px solid ${t.headerBorder}`, display: bottomPaneCollapsed ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden', background: t.cellBg }}>
        {/* v1.3.3 Hex handoff — compact tab row grouping Output tabs
            (Results/Viz/Lineage) on the left and Governance tabs
            (Validate/Tests/History/Save) on the right, separated by a
            subtle divider. Replaces the bulky "Preview & Governance"
            title block. */}
        <div style={{ padding: '10px 14px', display: 'flex', gap: 6, alignItems: 'center', borderBottom: `1px solid ${t.headerBorder}`, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: t.textMuted, textTransform: 'uppercase' as const, fontFamily: t.font, marginRight: 4 }}>
            Output
          </span>
          <ExplorerTabButton active={resultTab === 'results'} onClick={() => setResultTab('results')} label="Results" />
          <ExplorerTabButton active={resultTab === 'visualization'} onClick={() => setResultTab('visualization')} label="Visualization" />
          <ExplorerTabButton active={resultTab === 'lineage'} onClick={() => setResultTab('lineage')} label="Lineage" />
          <span style={{ width: 1, height: 18, background: t.headerBorder, margin: '0 6px' }} />
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: t.textMuted, textTransform: 'uppercase' as const, fontFamily: t.font, marginRight: 4 }}>
            Governance
          </span>
          <ExplorerTabButton active={resultTab === 'validate'} onClick={() => setResultTab('validate')} label="Validate" />
          <ExplorerTabButton active={resultTab === 'tests'} onClick={() => setResultTab('tests')} label="Tests" />
          <ExplorerTabButton active={resultTab === 'history'} onClick={() => {
            setResultTab('history');
            if (!historyLoaded && state.activeBlockPath) {
              api.getBlockHistory(state.activeBlockPath).then((r) => { setHistoryEntries(r.entries); setHistoryLoaded(true); });
            }
          }} label="History" />
          <ExplorerTabButton active={resultTab === 'save'} onClick={() => setResultTab('save')} label="Metadata" />
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setBottomPaneCollapsed(true)}
            style={{ background: 'transparent', border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textMuted, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '4px 8px' }}
            title="Hide pane"
          >
            ▾ Hide
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {resultTab === 'results' && (
            state.blockStudioPreview ? (
              <div style={{ display: 'grid', gap: 12, padding: 12 }}>
                <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>{state.blockStudioPreview.sql}</div>
                {activeResultChartType === 'table' ? (
                  <TableOutput result={state.blockStudioPreview.result} themeMode={state.themeMode} />
                ) : (
                  <ChartOutput
                    result={state.blockStudioPreview.result}
                    chartConfig={state.blockStudioPreview.chartConfig}
                    themeMode={state.themeMode}
                  />
                )}
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
          {resultTab === 'lineage' && (
            <BlockLineagePanel
              blockName={activeBlockName}
              loading={lineageLoading}
              detail={lineageDetail}
              graph={lineageGraph}
              paths={lineagePaths}
              onSelectNode={(nodeId) => {
                dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
                if (!state.lineageFullscreen) dispatch({ type: 'TOGGLE_LINEAGE_FULLSCREEN' });
              }}
              onOpenFull={() => {
                if (activeBlockName) {
                  dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId: `block:${activeBlockName}` });
                  if (!state.lineageFullscreen) dispatch({ type: 'TOGGLE_LINEAGE_FULLSCREEN' });
                }
              }}
              t={t}
            />
          )}
          {resultTab === 'tests' && (
            <TestsPanel
              source={state.blockStudioDraft}
              blockPath={state.activeBlockPath}
              testResults={testResults}
              running={testRunning}
              onRunTests={async () => {
                if (!state.activeBlockPath) return;
                setTestRunning(true);
                try {
                  const result = await api.runBlockTests(state.blockStudioDraft, state.activeBlockPath);
                  setTestResults(result.assertions ?? []);
                } catch { setTestResults([]); }
                finally { setTestRunning(false); }
              }}
              t={t}
            />
          )}
          {resultTab === 'validate' && (
            <DiagnosticsPanel diagnostics={state.blockStudioValidation?.diagnostics ?? []} t={t} />
          )}
          {resultTab === 'history' && (
            <HistoryPanel entries={historyEntries} t={t} />
          )}
          {resultTab === 'save' && (
            <div style={{ display: 'grid', gap: 12 }}>
              {state.activeBlockPath && state.blockStudioMetadata && (
                <div style={{ padding: '12px 12px 0' }}>
                  <StatusWorkflow
                    currentStatus={state.blockStudioMetadata.reviewStatus ?? 'draft'}
                    blockPath={state.activeBlockPath}
                    onStatusChanged={(newStatus) => {
                      if (state.blockStudioMetadata) {
                        dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, reviewStatus: newStatus } });
                      }
                    }}
                    t={t}
                  />
                </div>
              )}
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
                t={t}
              />
            </div>
          )}
        </div>
      </div>

      {bottomPaneCollapsed && (
        <div style={{ position: 'absolute', right: 16, bottom: 16 }}>
          <button
            onClick={() => setBottomPaneCollapsed(false)}
            style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textSecondary, cursor: 'pointer', fontSize: 12, fontFamily: t.font, padding: '8px 12px' }}
          >
            Open Results
          </button>
        </div>
      )}
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

function SegmentedTab({ active, onClick, label, t }: { active: boolean; onClick: () => void; label: string; t: Theme }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
        color: active ? t.textPrimary : t.textMuted,
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        fontFamily: t.font,
        padding: '10px 2px',
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}

function StudioStatCard({ label, value, t }: { label: string; value: number; t: Theme }) {
  return (
    <div
      style={{
        background: t.cellBg,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 10,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, fontFamily: t.font, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: t.textPrimary, fontFamily: t.font, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
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


function BlockLineagePanel({
  blockName,
  loading,
  detail,
  graph,
  paths,
  onSelectNode,
  onOpenFull,
  t,
}: {
  blockName: string | null;
  loading: boolean;
  detail: {
    node: { id: string; type: string; name: string; domain?: string } | null;
    incoming: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
    outgoing: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
  } | null;
  graph: {
    nodes: Array<{ id: string; type: string; name: string; domain?: string; layer?: string }>;
    edges: Array<{ source: string; target: string; type: string }>;
  } | null;
  paths: CompletePathResult | null;
  onSelectNode: (nodeId: string) => void;
  onOpenFull: () => void;
  t: Theme;
}) {
  if (!blockName) {
    return <EmptyPanel message="Lineage will appear once the block has a name." />;
  }

  if (loading) {
    return <EmptyPanel message="Loading block lineage…" />;
  }

  if (!detail?.node) {
    return (
      <div style={{ padding: 12, display: 'grid', gap: 12 }}>
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
          No lineage node was found for this block yet. Save the block or compile the project if you expect it to appear in the graph.
        </div>
        <div>
          <button
            onClick={onOpenFull}
            style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textPrimary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
          >
            Open Full Lineage
          </button>
        </div>
      </div>
    );
  }

  const focalNodeId = `block:${blockName}`;

  return (
    <div style={{ padding: 12, display: 'grid', gap: 12, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>
            {detail.node.name}
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            {detail.node.domain ? `Domain: ${detail.node.domain}` : 'Block lineage focus'}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={onOpenFull}
          style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textPrimary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
        >
          Open Full Lineage
        </button>
      </div>

      {/* Layer Summary */}
      {paths?.layerSummary && <LayerSummary layerSummary={paths.layerSummary} t={t} />}

      {/* Embedded Mini-Graph */}
      {graph && graph.nodes.length > 0 && (
        <MiniLineageGraph
          nodes={graph.nodes}
          edges={graph.edges}
          focalNodeId={focalNodeId}
          height={360}
          onNodeClick={onSelectNode}
          layoutMode="flow"
        />
      )}

      {/* Complete Paths (from API) */}
      {paths && (paths.upstreamPaths.length > 0 || paths.downstreamPaths.length > 0) && (
        <div style={{ display: 'grid', gap: 10 }}>
          {paths.upstreamPaths.length > 0 && (
            <LineagePathSection
              title="Source to Block"
              paths={paths.upstreamPaths}
              onNodeClick={onSelectNode}
              focalNodeId={focalNodeId}
              t={t}
            />
          )}
          {paths.downstreamPaths.length > 0 && (
            <LineagePathSection
              title="Block to Consumption"
              paths={paths.downstreamPaths}
              onNodeClick={onSelectNode}
              focalNodeId={focalNodeId}
              t={t}
            />
          )}
        </div>
      )}

      {/* v1.3.3 Hex cleanup — dropped the collapsible Upstream/Downstream
          1-hop list. The mini-graph (visual) and Source-to-Block /
          Block-to-Consumption chains above already cover the same data;
          the 1-hop list was a third duplicate view. */}
    </div>
  );
}

function SavePanel({
  metadata,
  draftMetadata,
  onChange,
  t,
}: {
  metadata: { name: string; domain: string; description: string; owner: string; tags: string[] } | null;
  draftMetadata: ReturnType<typeof parseBlockFields> | null;
  onChange: (next: Partial<{ name: string; domain: string; description: string; owner: string; tags: string[] }>) => void;
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
    </div>
  );
}

function EmptyPanel({ message }: { message: string }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return <div style={{ padding: 16, fontSize: 12, color: t.textMuted }}>{message}</div>;
}

const STATUS_COLORS: Record<string, string> = {
  draft: '#8b949e',
  review: '#d29922',
  certified: '#3fb950',
  deprecated: '#f85149',
};

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['review'],
  review: ['certified', 'draft'],
  certified: ['deprecated'],
  deprecated: ['draft'],
};

function StatusWorkflow({
  currentStatus,
  blockPath,
  onStatusChanged,
  t,
}: {
  currentStatus: string;
  blockPath: string | null;
  onStatusChanged: (newStatus: string) => void;
  t: Theme;
}) {
  const [updating, setUpdating] = useState(false);
  const transitions = STATUS_TRANSITIONS[currentStatus] ?? [];

  const handleTransition = async (newStatus: string) => {
    if (!blockPath) return;
    setUpdating(true);
    try {
      const result = await api.updateBlockStatus(blockPath, newStatus);
      if (result.ok && result.status) {
        onStatusChanged(result.status);
      }
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 12px', background: t.pillBg, borderRadius: 8,
    }}>
      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>Status:</span>
      <span style={{
        fontSize: 11, fontWeight: 600,
        color: STATUS_COLORS[currentStatus] ?? t.textMuted,
        background: `${STATUS_COLORS[currentStatus] ?? t.textMuted}18`,
        padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase',
        letterSpacing: '0.04em', fontFamily: t.font,
      }}>{currentStatus}</span>
      <span style={{ flex: 1 }} />
      {transitions.map((status) => (
        <button key={status} onClick={() => void handleTransition(status)} disabled={updating} style={{
          background: status === 'certified' ? '#3fb950' : status === 'deprecated' ? '#f85149' : t.btnBg,
          border: `1px solid ${status === 'certified' ? '#3fb950' : status === 'deprecated' ? '#f85149' : t.btnBorder}`,
          borderRadius: 4, color: status === 'certified' || status === 'deprecated' ? '#fff' : t.textSecondary,
          cursor: updating ? 'not-allowed' : 'pointer', fontSize: 10, fontWeight: 600,
          fontFamily: t.font, padding: '3px 10px', textTransform: 'capitalize',
          opacity: updating ? 0.5 : 1,
        }}>
          {updating ? '...' : status === 'certified' ? 'Certify' : status === 'deprecated' ? 'Deprecate' : `Move to ${status}`}
        </button>
      ))}
    </div>
  );
}

function TestsPanel({
  source,
  blockPath,
  testResults,
  running,
  onRunTests,
  t,
}: {
  source: string;
  blockPath: string | null;
  testResults: Array<{ field: string; operator: string; expected: string; passed: boolean; actual?: string }> | null;
  running: boolean;
  onRunTests: () => void;
  t: Theme;
}) {
  // Quick parse for test assertions from source
  const assertionMatches = [...source.matchAll(/assert\s+(\w+)\s*(>=?|<=?|==|!=|IN)\s*(\S+)/g)];
  const assertions = assertionMatches.map((m) => ({ field: m[1], operator: m[2], expected: m[3] }));

  return (
    <div style={{ padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
          Test Assertions
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onRunTests} disabled={running || !blockPath} style={{
          background: t.accent, border: 'none', borderRadius: 6, color: '#fff',
          cursor: running || !blockPath ? 'not-allowed' : 'pointer',
          fontSize: 11, fontWeight: 600, fontFamily: t.font, padding: '5px 14px',
          opacity: running || !blockPath ? 0.5 : 1,
        }}>
          {running ? 'Running...' : 'Run Tests'}
        </button>
      </div>

      {assertions.length === 0 && (
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          No test assertions found. Add assertions in your block:
          <pre style={{
            margin: '8px 0 0', padding: '8px 10px', background: t.editorBg,
            border: `1px solid ${t.cellBorder}`, borderRadius: 6,
            fontSize: 10, fontFamily: t.fontMono, color: t.textSecondary,
          }}>
{`tests {
  assert row_count > 0
  assert max_value <= 1000000
}`}
          </pre>
        </div>
      )}

      {assertions.map((a, i) => {
        const result = testResults?.[i];
        const passed = result?.passed;
        return (
          <div key={i} style={{
            padding: '8px 12px', borderRadius: 8,
            border: `1px solid ${result ? (passed ? '#3fb95040' : '#f8514940') : t.cellBorder}`,
            background: result ? (passed ? '#3fb95008' : '#f8514908') : 'transparent',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {result && (
              <span style={{
                fontSize: 14, color: passed ? '#3fb950' : '#f85149', fontWeight: 700,
              }}>{passed ? '\u2713' : '\u2717'}</span>
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: t.textPrimary, fontFamily: t.fontMono }}>
                {a.field} {a.operator} {a.expected}
              </div>
              {result && !passed && result.actual && (
                <div style={{ fontSize: 11, color: '#f85149', fontFamily: t.font, marginTop: 2 }}>
                  Actual: {result.actual}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {testResults && testResults.length > 0 && (
        <div style={{
          padding: '8px 12px', background: t.pillBg, borderRadius: 8,
          fontSize: 12, fontFamily: t.font, color: t.textSecondary,
        }}>
          {testResults.filter((r) => r.passed).length}/{testResults.length} passed
        </div>
      )}
    </div>
  );
}

function HistoryPanel({
  entries,
  t,
}: {
  entries: Array<{ hash: string; date: string; author: string; message: string }>;
  t: Theme;
}) {
  if (entries.length === 0) {
    return <EmptyPanel message="No version history available. Commit changes to build history." />;
  }

  return (
    <div style={{ padding: 12, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
        Version History
      </div>
      {entries.map((entry) => (
        <div key={entry.hash} style={{
          padding: '8px 12px', border: `1px solid ${t.cellBorder}`,
          borderRadius: 8, background: t.inputBg,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: 10, fontFamily: t.fontMono, color: t.accent,
              background: `${t.accent}12`, padding: '1px 6px', borderRadius: 4,
            }}>
              {entry.hash.slice(0, 7)}
            </span>
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
              {new Date(entry.date).toLocaleDateString()}
            </span>
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, marginLeft: 'auto' }}>
              {entry.author}
            </span>
          </div>
          <div style={{ fontSize: 12, color: t.textPrimary, fontFamily: t.font }}>
            {entry.message}
          </div>
        </div>
      ))}
    </div>
  );
}

function DatabaseExplorer({
  tree,
  totalTree,
  expanded,
  setExpanded,
  onEnsureColumns,
  onInsert,
  query,
  onQueryChange,
  stats,
  connectionName,
  loadingNodes,
  onRefresh,
  t,
}: {
  tree: DatabaseSchemaNode[];
  totalTree: DatabaseSchemaNode[];
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onEnsureColumns: (node: DatabaseSchemaNode) => Promise<void>;
  onInsert: (snippet: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  stats: { schemas: number; tables: number; columns: number };
  connectionName: string;
  loadingNodes: Set<string>;
  onRefresh: () => void;
  t: Theme;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 8,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const renderNode = (node: DatabaseSchemaNode, depth: number = 0): React.ReactNode => {
    const hasChildren = node.kind !== 'column';
    const isExpanded = expanded[node.id] ?? depth < 1;
    const isLoading = loadingNodes.has(node.id);
    const childCount = node.kind === 'schema'
      ? node.children?.length
      : node.kind === 'table'
        ? node.children?.length
        : undefined;

    // Color-coded badge for column types
    const badgeText = node.kind === 'column' ? node.type : node.kind;
    const badgeColor = node.kind === 'column' && node.type ? getTypeColor(node.type, t.accent) : undefined;

    return (
      <div key={node.id}>
        <TreeRow
          label={isLoading ? `${node.label} …` : node.label}
          depth={depth}
          count={childCount}
          expanded={hasChildren ? isExpanded : undefined}
          onToggle={hasChildren ? () => {
            setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }));
            if (!isExpanded) void onEnsureColumns(node);
          } : undefined}
          badge={badgeText}
          badgeColor={badgeColor}
          onClick={() => {
            if (node.kind === 'table' && node.path) onInsert(node.path);
            // Qualified column insert: table.column instead of bare column
            if (node.kind === 'column') {
              const tableName = node.path ? node.path.split('.').pop() : '';
              onInsert(tableName ? `${tableName}.${node.label}` : node.label);
            }
          }}
          onDoubleClick={() => {
            if (node.kind === 'table' && node.path) onInsert(`SELECT *\nFROM ${node.path}\nLIMIT 100`);
          }}
          t={t}
        />
        {hasChildren && isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div style={{ padding: 12, display: 'grid', gap: 12, borderBottom: `1px solid ${t.headerBorder}`, background: `${t.cellBg}66` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>Database Browser</div>
            <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
              Browse the active connection, inspect schemas and columns, then insert tables or starter queries into the block.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={onRefresh}
              title="Refresh schema"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                color: t.textMuted, fontSize: 14, lineHeight: 1,
              }}
            >
              ↻
            </button>
            <span style={{ fontSize: 10, fontWeight: 700, color: t.accent, background: `${t.accent}18`, borderRadius: 999, padding: '5px 9px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {connectionName}
            </span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          <StudioStatCard label="Schemas" value={stats.schemas} t={t} />
          <StudioStatCard label="Tables" value={stats.tables} t={t} />
          <StudioStatCard label="Columns" value={stats.columns} t={t} />
        </div>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search schemas, tables, columns..."
          style={inputStyle}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: tree.length > 0 ? '6px 0 0' : 0 }}>
        {totalTree.length === 0 ? (
          <EmptyPanel message="No schemas were found for the active connection yet." />
        ) : tree.length === 0 ? (
          <EmptyPanel message="No database objects match the current search." />
        ) : (
          tree.map((node) => renderNode(node))
        )}
      </div>
    </>
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
    const isExpanded = expanded[node.id] ?? depth < 3;
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

function filterDatabaseTree(tree: DatabaseSchemaNode[], query: string): DatabaseSchemaNode[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return tree;

  const filterNode = (node: DatabaseSchemaNode): DatabaseSchemaNode | null => {
    const matches = [node.label, node.path, node.type]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized));

    const children = (node.children ?? [])
      .map((child) => filterNode(child))
      .filter((child): child is DatabaseSchemaNode => Boolean(child));

    if (matches || children.length > 0) {
      return { ...node, children };
    }
    return null;
  };

  return tree
    .map((node) => filterNode(node))
    .filter((node): node is DatabaseSchemaNode => Boolean(node));
}

function summarizeDatabaseTree(tree: DatabaseSchemaNode[]): { schemas: number; tables: number; columns: number } {
  let schemas = 0;
  let tables = 0;
  let columns = 0;

  const visit = (node: DatabaseSchemaNode) => {
    if (node.kind === 'schema') schemas += 1;
    if (node.kind === 'table') tables += 1;
    if (node.kind === 'column') columns += 1;
    for (const child of node.children ?? []) visit(child);
  };

  for (const node of tree) visit(node);
  return { schemas, tables, columns };
}

function hasSemanticNodes(tree: SemanticTreeNode | null): boolean {
  return Boolean(tree && tree.children && tree.children.length > 0);
}

function buildFallbackSemanticTree(layer: SemanticLayerState): SemanticTreeNode | null {
  if (layer.metrics.length === 0 && layer.dimensions.length === 0 && layer.hierarchies.length === 0) {
    return null;
  }

  const provider = layer.provider ?? 'dql';
  const domainMap = new Map<string, SemanticTreeNode[]>();

  const pushToDomain = (domain: string, entry: SemanticTreeNode) => {
    const next = domainMap.get(domain) ?? [];
    next.push(entry);
    domainMap.set(domain, next);
  };

  for (const metric of layer.metrics) {
    const domain = metric.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `metric:${metric.name}`,
      label: metric.label || metric.name,
      kind: 'metric',
      meta: {
        provider,
        domain,
        cube: metric.table,
        owner: metric.owner ?? '',
        tags: metric.tags.join(','),
      },
    });
  }

  for (const dimension of layer.dimensions) {
    const domain = dimension.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `dimension:${dimension.name}`,
      label: dimension.label || dimension.name,
      kind: 'dimension',
      meta: {
        provider,
        domain,
        cube: dimension.table,
        owner: dimension.owner ?? '',
        tags: dimension.tags.join(','),
      },
    });
  }

  for (const hierarchy of layer.hierarchies) {
    const domain = hierarchy.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `hierarchy:${hierarchy.name}`,
      label: hierarchy.label || hierarchy.name,
      kind: 'hierarchy',
      meta: {
        provider,
        domain,
      },
    });
  }

  const domainNodes = Array.from(domainMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, items]) => {
      const metrics = items.filter((item) => item.kind === 'metric');
      const dimensions = items.filter((item) => item.kind === 'dimension');
      const hierarchies = items.filter((item) => item.kind === 'hierarchy');
      const children: SemanticTreeNode[] = [];
      if (metrics.length > 0) {
        children.push({
          id: `group:${domain}:metrics`,
          label: 'Metrics',
          kind: 'group',
          count: metrics.length,
          meta: { provider, domain },
          children: metrics.sort((a, b) => a.label.localeCompare(b.label)),
        });
      }
      if (dimensions.length > 0) {
        children.push({
          id: `group:${domain}:dimensions`,
          label: 'Dimensions',
          kind: 'group',
          count: dimensions.length,
          meta: { provider, domain },
          children: dimensions.sort((a, b) => a.label.localeCompare(b.label)),
        });
      }
      if (hierarchies.length > 0) {
        children.push({
          id: `group:${domain}:hierarchies`,
          label: 'Hierarchies',
          kind: 'group',
          count: hierarchies.length,
          meta: { provider, domain },
          children: hierarchies.sort((a, b) => a.label.localeCompare(b.label)),
        });
      }
      return {
        id: `domain:${provider}:${domain}`,
        label: domain,
        kind: 'domain' as const,
        count: children.length,
        meta: { provider, domain },
        children,
      };
    });

  return {
    id: 'root:semantic',
    label: 'Semantic Layer',
    kind: 'group',
    children: [
      {
        id: `provider:${provider}`,
        label: provider.toUpperCase(),
        kind: 'provider',
        count: domainNodes.length,
        meta: { provider },
        children: domainNodes,
      },
    ],
  };
}
