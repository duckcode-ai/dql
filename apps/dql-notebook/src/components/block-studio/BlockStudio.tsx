import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Bot, CheckCircle2, Code2, Database, FileInput, ShieldCheck, type LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type {
  BlockStudioDiagnostic,
  DatabaseSchemaNode,
  SemanticLayerState,
  SemanticObjectDetail,
  SemanticTreeNode,
  BlockStudioImportSession,
  BlockStudioImportSessionSummary,
  BlockStudioImportCandidate,
  BlockStudioOpenPayload,
  BlockStudioDbtStatus,
} from '../../store/types';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { SQLCellEditor } from '../cells/SQLCellEditor';
import { ChartOutput, CHART_TYPE_OPTIONS, resolveChartType } from '../output/ChartOutput';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';
import { LineagePathSection, LayerSummary } from '../lineage/LineagePathBreadcrumb';
import type { CompletePathResult } from '../lineage/lineage-constants';
import { TableOutput } from '../output/TableOutput';
import { BlockLibraryPanel } from '../panels/BlockLibraryPanel';
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

type ExplorerTab = 'blocks' | 'semantic' | 'database';
type ResultTab = 'results' | 'lineage' | 'save' | 'history';

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
  const [explorerTab, setExplorerTab] = useState<ExplorerTab>('blocks');
  const [resultTab, setResultTab] = useState<ResultTab>('results');
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
  const [leftPaneWidth, setLeftPaneWidth] = useState(340);
  const [bottomPaneHeight, setBottomPaneHeight] = useState(320);
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(false);
  const [bottomPaneCollapsed, setBottomPaneCollapsed] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 900 : false);
  const [importSession, setImportSession] = useState<BlockStudioImportSession | null>(null);
  const [importSessions, setImportSessions] = useState<BlockStudioImportSessionSummary[]>([]);
  const [importSessionsLoading, setImportSessionsLoading] = useState(false);
  const [semanticInsertChoice, setSemanticInsertChoice] = useState<SemanticObjectDetail | null>(null);
  const [databaseInsertWarning, setDatabaseInsertWarning] = useState<string | null>(null);
  const [certifying, setCertifying] = useState(false);
  const [certificationResult, setCertificationResult] = useState<{
    ok?: boolean;
    checklist?: {
      metadata: boolean;
      validation: boolean;
      run: boolean;
      tests: boolean;
      chart: boolean;
      lineage: boolean;
      aiReviewed: boolean;
      blockers: string[];
      checkedAt?: string;
    };
    certification?: {
      certified: boolean;
      errors: Array<{ rule: string; message: string }>;
      warnings: Array<{ rule: string; message: string }>;
    };
    error?: string;
  } | null>(null);
  const semanticTreeRef = useRef<HTMLDivElement | null>(null);
  const lastActiveBlockPathRef = useRef<string | null>(state.activeBlockPath);

  useEffect(() => {
    dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG_LOADING', loading: true });
    setCatalogError(null);
    void Promise.allSettled([
      api.getBlockStudioCatalog(),
      api.getBlockStudioDbtStatus(),
    ])
      .then(([catalogResult, dbtResult]) => {
        if (catalogResult.status === 'fulfilled') {
          dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG', catalog: catalogResult.value });
          setDatabaseTree(catalogResult.value.databaseTree);
        } else {
          setCatalogError('Failed to load schema. Check your connection and try refreshing.');
        }
        dispatch({
          type: 'SET_BLOCK_STUDIO_DBT_STATUS',
          status: dbtResult.status === 'fulfilled' ? dbtResult.value : null,
        });
      })
      .finally(() => dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG_LOADING', loading: false }));
  }, [dispatch]);

  const refreshImportSessions = useCallback(async () => {
    setImportSessionsLoading(true);
    try {
      const result = await api.listBlockStudioImports();
      setImportSessions(result.sessions ?? []);
    } catch {
      setImportSessions([]);
    } finally {
      setImportSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshImportSessions();
  }, [refreshImportSessions]);

  useEffect(() => {
    const previous = lastActiveBlockPathRef.current;
    const current = state.activeBlockPath;
    if (current && current !== previous) {
      dispatch({ type: 'CLOSE_BLOCK_IMPORT' });
    }
    lastActiveBlockPathRef.current = current;
  }, [state.activeBlockPath, dispatch]);

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
    measures: state.semanticLayer.measures.length,
    dimensions: state.semanticLayer.dimensions.length,
    timeDimensions: state.semanticLayer.timeDimensions.length,
    entities: state.semanticLayer.entities.length,
    hierarchies: state.semanticLayer.hierarchies.length,
    savedQueries: state.semanticLayer.savedQueries.length,
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
    const updateCompactLayout = () => setCompactLayout(window.innerWidth < 900);
    updateCompactLayout();
    window.addEventListener('resize', updateCompactLayout);
    return () => window.removeEventListener('resize', updateCompactLayout);
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
      status: parsed?.status || state.blockStudioMetadata.reviewStatus || 'draft',
    };
  }, [state.blockStudioDraft, state.blockStudioMetadata]);
  const activeBlockName = draftMetadata?.name ?? state.blockStudioMetadata?.name ?? null;
  const blockType = draftMetadata?.blockType ?? 'custom';
  const isSemanticBlock = blockType === 'semantic';
  const hasActiveDraft = Boolean(state.blockStudioDraft.trim() || state.blockStudioMetadata || state.activeBlockPath);

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
      setResultTab('results');
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
          sourceKind: state.blockStudioMetadata.sourceKind,
          sourcePath: state.blockStudioMetadata.sourcePath,
          importId: state.blockStudioMetadata.importId,
          candidateId: state.blockStudioMetadata.candidateId,
          lineage: state.blockStudioMetadata.lineage,
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

  const handleMoveToReview = async () => {
    if (!state.activeBlockPath || !state.blockStudioMetadata) return;
    setStatusUpdating(true);
    try {
      const result = await api.updateBlockStatus(state.activeBlockPath, 'review');
      if (result.ok && result.status) {
        dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, reviewStatus: result.status } });
        dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft: setBlockStringField(state.blockStudioDraft, 'status', result.status) });
        setCertificationResult(null);
      }
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleCertify = async () => {
    if (!state.activeBlockPath || !state.blockStudioDraft.trim()) return;
    setCertifying(true);
    try {
      const result = await api.certifyBlockStudio({ source: state.blockStudioDraft, path: state.activeBlockPath });
      setCertificationResult(result);
      if (result.ok && result.status && state.blockStudioMetadata) {
        dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, reviewStatus: result.status } });
        dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft: setBlockStringField(state.blockStudioDraft, 'status', result.status) });
      }
      setResultTab('save');
    } catch (error: any) {
      let parsed: any = null;
      try { parsed = JSON.parse(error?.message ?? ''); } catch { /* no-op */ }
      setCertificationResult(parsed ?? { ok: false, error: error?.message ?? 'Certification failed' });
      setResultTab('save');
    } finally {
      setCertifying(false);
    }
  };

  const handleImportCandidateSelect = (candidate: BlockStudioImportCandidate) => {
    const payload = {
      path: '',
      source: candidate.dqlSource,
      metadata: {
        name: candidate.name,
        path: null,
        domain: candidate.domain,
        description: candidate.description,
        owner: candidate.owner,
        tags: candidate.tags,
        reviewStatus: candidate.reviewStatus,
        sourceKind: candidate.sourceKind,
        sourcePath: candidate.sourcePath,
        importId: importSession?.id,
        candidateId: candidate.id,
        lineage: candidate.lineage.sourceTables,
      },
      companionPath: null,
      validation: candidate.validation ?? {
        valid: true,
        diagnostics: [],
        semanticRefs: { metrics: [], dimensions: [], segments: [] },
        executableSql: null,
      },
    };
    dispatch({
      type: 'OPEN_BLOCK_STUDIO',
      file: {
        name: `${candidate.name}.dql`,
        path: '',
        type: 'block',
        folder: 'blocks',
        isNew: true,
      },
      payload,
    });
    dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview: candidate.preview });
    setResultTab('results');
    dispatch({ type: 'CLOSE_BLOCK_IMPORT' });
  };

  const handleImportCandidateSaved = (candidate: BlockStudioImportCandidate, block: BlockStudioOpenPayload) => {
    const existing = state.files.some((file) => file.path === block.path);
    if (!existing) {
      dispatch({
        type: 'FILE_ADDED',
        file: {
          name: `${block.metadata.name}.dql`,
          path: block.path,
          type: 'block',
          folder: 'blocks',
        },
      });
    }
    if (importSession) {
      setImportSession({
        ...importSession,
        candidates: importSession.candidates.map((item) => item.id === candidate.id ? candidate : item),
      });
    }
    void refreshImportSessions();
  };

  const handleSemanticInsert = (item: SemanticObjectDetail) => {
    setDatabaseInsertWarning(null);
    if (item.kind === 'metric' || item.kind === 'dimension') {
      if (isSemanticBlock) {
        handleDraftChange(upsertSemanticSelection(state.blockStudioDraft, {
          kind: item.kind === 'metric' ? 'metric' : 'dimension',
          name: item.name,
        }));
        setSemanticInsertChoice(null);
      } else {
        setSemanticInsertChoice(item);
      }
      dispatch({ type: 'ADD_SEMANTIC_RECENT', name: item.name });
      return;
    }
    if (!isSemanticBlock) {
      setSemanticInsertChoice(item);
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
    setSemanticInsertChoice(null);
    if (isSemanticBlock) {
      setDatabaseInsertWarning('Database tables and SELECT snippets belong in SQL blocks. Use a SQL Block for raw SELECT work, or keep this Semantic Block on metrics and dimensions.');
      return;
    }
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
      const next = Math.min(560, Math.max(300, startWidth + moveEvent.clientX - startX));
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
      const next = Math.min(500, Math.max(180, startHeight - (moveEvent.clientY - startY)));
      setBottomPaneHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const rootGridColumns = compactLayout || leftPaneCollapsed
    ? 'minmax(0, 1fr)'
    : `${leftPaneWidth}px 6px minmax(0, 1fr)`;
  const rootGridRows = compactLayout
    ? leftPaneCollapsed
      ? bottomPaneCollapsed
        ? 'minmax(0, 1fr) 0 0'
        : `minmax(0, 1fr) 6px ${bottomPaneHeight}px`
      : bottomPaneCollapsed
        ? 'minmax(220px, 34vh) minmax(0, 1fr) 0 0'
        : `minmax(220px, 34vh) minmax(320px, 1fr) 6px ${bottomPaneHeight}px`
    : bottomPaneCollapsed
      ? 'minmax(0, 1fr) 0 0'
      : `minmax(0, 1fr) 6px ${bottomPaneHeight}px`;
  const editorGridColumn = compactLayout ? '1' : '3';
  const editorGridRow = compactLayout ? (leftPaneCollapsed ? '1' : '2') : '1';
  const bottomResizeGridColumn = compactLayout ? '1' : '3';
  const bottomResizeGridRow = compactLayout ? (leftPaneCollapsed ? '2' : '3') : '2';
  const bottomPaneGridColumn = compactLayout ? '1' : '3';
  const bottomPaneGridRow = compactLayout ? (leftPaneCollapsed ? '3' : '4') : '3';

  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: rootGridColumns,
        gridTemplateRows: rootGridRows,
        overflow: 'hidden',
        background: t.appBg,
      }}
    >
      <div style={{ gridColumn: '1', gridRow: compactLayout ? '1' : '1 / 4', borderRight: leftPaneCollapsed ? 'none' : `1px solid ${t.headerBorder}`, borderBottom: compactLayout && !leftPaneCollapsed ? `1px solid ${t.headerBorder}` : 'none', display: leftPaneCollapsed ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden', background: t.sidebarBg, minWidth: 0 }}>
        {/* v1.3.3 Hex cleanup — single compact header row; drop wordy
            description and the empty 3-up stat cards in favor of an
            inline count chip. */}
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${t.headerBorder}` }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: t.textMuted, textTransform: 'uppercase' as const, fontFamily: t.font }}>
            Source
          </span>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            Blocks, semantics, and database objects
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
          <SegmentedTab active={explorerTab === 'blocks'} onClick={() => setExplorerTab('blocks')} label="Blocks" t={t} />
          <SegmentedTab active={explorerTab === 'semantic'} onClick={() => setExplorerTab('semantic')} label="Semantic" t={t} />
          <SegmentedTab active={explorerTab === 'database'} onClick={() => setExplorerTab('database')} label="Database" t={t} />
        </div>

        {explorerTab === 'blocks' ? (
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <BlockLibraryPanel />
          </div>
        ) : explorerTab === 'semantic' ? (
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
          gridColumn: '2',
          gridRow: '1 / 4',
          display: leftPaneCollapsed || compactLayout ? 'none' : 'block',
          cursor: 'col-resize',
          background: t.headerBorder,
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', gridColumn: editorGridColumn, gridRow: editorGridRow }}>
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
            {isSemanticBlock ? 'Semantic Builder' : 'SQL Builder'}
          </span>
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            color: isSemanticBlock ? '#2ea043' : t.accent,
            background: `${isSemanticBlock ? '#2ea043' : t.accent}18`,
            borderRadius: 999,
            padding: '3px 8px',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            {isSemanticBlock ? 'metric block' : 'sql block'}
          </span>
          {state.blockStudioMetadata?.reviewStatus && (
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              color: STATUS_COLORS[state.blockStudioMetadata.reviewStatus] ?? t.textMuted,
              background: `${STATUS_COLORS[state.blockStudioMetadata.reviewStatus] ?? t.textMuted}18`,
              borderRadius: 999,
              padding: '3px 8px',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {state.blockStudioMetadata.reviewStatus}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <TemplateButton label="Import SQL" onClick={() => dispatch({ type: 'OPEN_BLOCK_IMPORT' })} />
          <TemplateButton label="Run" onClick={() => void handleRun()} busy={running} />
          <TemplateButton label="Save Draft" onClick={() => void handleSave()} busy={saving} />
          {state.activeBlockPath && (
            <>
              <TemplateButton label="Move to Review" onClick={() => void handleMoveToReview()} busy={statusUpdating} />
              <TemplateButton label="Certify" onClick={() => void handleCertify()} busy={certifying} />
            </>
          )}
          {saveError && (
            <span style={{ fontSize: 11, color: '#f85149', fontFamily: t.font, padding: '4px 8px', background: '#f8514918', borderRadius: 6 }}>
              {saveError}
            </span>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {!hasActiveDraft ? (
            <BlockStudioStartPage
              dbtStatus={state.blockStudioDbtStatus}
              semanticStats={semanticStats}
              databaseStats={databaseStats}
              onCreateSql={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL', blockType: 'custom' })}
              onCreateSemantic={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL', blockType: 'semantic' })}
              onImport={() => dispatch({ type: 'OPEN_BLOCK_IMPORT' })}
              onAskAi={() => {
                setResultTab('results');
                dispatch({
                  type: 'SET_BLOCK_STUDIO_VALIDATION',
                  validation: {
                    valid: true,
                    diagnostics: [{ severity: 'info', message: 'AI block generation will use the selected dbt model, semantic metric, or current prompt context when provider settings are configured.' }],
                    semanticRefs: { metrics: [], dimensions: [], segments: [] },
                    executableSql: null,
                  },
                });
              }}
              t={t}
            />
          ) : isSemanticBlock ? (
            <SemanticBlockBuilder
              source={state.blockStudioDraft}
              semanticLayer={state.semanticLayer}
              chartConfig={currentChart}
              onChange={handleDraftChange}
              t={t}
            />
          ) : (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {(semanticInsertChoice || databaseInsertWarning) && (
                <BuilderNotice
                  semanticChoice={semanticInsertChoice}
                  databaseWarning={databaseInsertWarning}
                  onDismiss={() => { setSemanticInsertChoice(null); setDatabaseInsertWarning(null); }}
                  onInsertAdvanced={() => {
                    if (!semanticInsertChoice) return;
                    const ref = buildSemanticRef(semanticInsertChoice.kind === 'metric' ? 'metric' : 'dimension', semanticInsertChoice.name);
                    handleDraftChange(appendSemanticRefToQuery(state.blockStudioDraft, ref));
                    setSemanticInsertChoice(null);
                  }}
                  onCreateSemantic={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL', blockType: 'semantic' })}
                  t={t}
                />
              )}
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: t.cellBg }}>
                <SQLCellEditor
                  value={state.blockStudioDraft}
                  onChange={handleDraftChange}
                  onRun={() => void handleRun()}
                  themeMode={state.themeMode}
                  autoFocus
                  wrap={false}
                  fillHeight
                  errorMessage={state.blockStudioValidation?.diagnostics.find((item) => item.severity === 'error')?.message}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        onMouseDown={bottomPaneCollapsed ? undefined : startBottomResize}
        style={{
          gridColumn: bottomResizeGridColumn,
          gridRow: bottomResizeGridRow,
          display: bottomPaneCollapsed ? 'none' : 'block',
          cursor: 'row-resize',
          background: t.headerBorder,
        }}
      />

      <div style={{ gridColumn: bottomPaneGridColumn, gridRow: bottomPaneGridRow, borderTop: bottomPaneCollapsed ? 'none' : `1px solid ${t.headerBorder}`, display: bottomPaneCollapsed ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden', background: t.cellBg }}>
        {/* Compact bottom workspace: keep only tabs that are actively useful
            during block authoring. Validation and test details still run in
            the background and certification flow, but do not compete for
            attention as primary tabs. */}
        <div style={{ padding: '10px 14px', display: 'flex', gap: 6, alignItems: 'center', borderBottom: `1px solid ${t.headerBorder}`, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: t.textMuted, textTransform: 'uppercase' as const, fontFamily: t.font, marginRight: 4 }}>
            Output
          </span>
          <ExplorerTabButton active={resultTab === 'results'} onClick={() => setResultTab('results')} label="Results" />
          <ExplorerTabButton active={resultTab === 'lineage'} onClick={() => setResultTab('lineage')} label="Lineage" />
          <span style={{ width: 1, height: 18, background: t.headerBorder, margin: '0 6px' }} />
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: t.textMuted, textTransform: 'uppercase' as const, fontFamily: t.font, marginRight: 4 }}>
            Governance
          </span>
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
              <EmptyPanel message="Run the block to preview results." />
            )
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
                dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId });
              }}
              onOpenInspector={() => {
                if (activeBlockName) {
                  const nodeId = `block:${activeBlockName}`;
                  dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
                  dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId });
                }
              }}
              t={t}
            />
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
                        dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft: setBlockStringField(state.blockStudioDraft, 'status', newStatus) });
                      }
                    }}
                    t={t}
                  />
                </div>
              )}
              {certificationResult && (
                <CertificationChecklistPanel result={certificationResult} t={t} />
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

      {state.blockStudioImportOpen && (
        <BlockStudioImportOverlay
          t={t}
          onClose={() => dispatch({ type: 'CLOSE_BLOCK_IMPORT' })}
        >
          <BlockStudioImportWorkspace
            session={importSession}
            sessions={importSessions}
            sessionsLoading={importSessionsLoading}
            onSessionChange={setImportSession}
            onRefreshSessions={refreshImportSessions}
            onClose={() => dispatch({ type: 'CLOSE_BLOCK_IMPORT' })}
            onSelectCandidate={handleImportCandidateSelect}
            onSavedCandidate={handleImportCandidateSaved}
            defaultDomain={draftMetadata?.domain || state.blockStudioMetadata?.domain || 'imported'}
            defaultOwner={draftMetadata?.owner || state.blockStudioMetadata?.owner || ''}
            t={t}
          />
        </BlockStudioImportOverlay>
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

function BlockStudioImportOverlay({
  children,
  onClose,
  t,
}: {
  children: React.ReactNode;
  onClose: () => void;
  t: Theme;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        background: 'rgba(0, 0, 0, 0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: 'min(1180px, calc(100vw - 64px))',
          height: 'min(760px, calc(100vh - 96px))',
          background: t.appBg,
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 10,
          boxShadow: '0 24px 80px rgba(0,0,0,0.36)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          title="Close import"
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            zIndex: 4,
            background: t.btnBg,
            border: `1px solid ${t.btnBorder}`,
            borderRadius: 6,
            color: t.textSecondary,
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            width: 30,
            height: 30,
          }}
        >
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

function BlockStudioStartPage({
  dbtStatus,
  semanticStats,
  databaseStats,
  onCreateSql,
  onCreateSemantic,
  onImport,
  onAskAi,
  t,
}: {
  dbtStatus: BlockStudioDbtStatus | null;
  semanticStats: {
    metrics: number;
    measures: number;
    dimensions: number;
    timeDimensions: number;
    entities: number;
    hierarchies: number;
    savedQueries: number;
  };
  databaseStats: { schemas: number; tables: number; columns: number };
  onCreateSql: () => void;
  onCreateSemantic: () => void;
  onImport: () => void;
  onAskAi: () => void;
  t: Theme;
}) {
  const cards = [
    {
      title: 'SQL block',
      detail: 'Model or table to reusable SELECT.',
      action: onCreateSql,
      label: 'Create',
      Icon: Code2,
    },
    {
      title: 'Semantic block',
      detail: 'Metric to governed answer block.',
      action: onCreateSemantic,
      label: 'Build',
      Icon: Blocks,
    },
    {
      title: 'Import SQL',
      detail: 'Convert existing queries to DQL.',
      action: onImport,
      label: 'Import',
      Icon: FileInput,
    },
    {
      title: 'Ask AI',
      detail: 'Draft from dbt project context.',
      action: onAskAi,
      label: 'Draft',
      Icon: Bot,
    },
  ];
  const dbtReady = Boolean(dbtStatus?.artifacts.manifest.exists);
  const semanticMetricCount = dbtStatus?.counts.metrics ?? semanticStats.metrics;
  const semanticObjectCount = semanticMetricCount + (dbtStatus?.counts.savedQueries ?? semanticStats.savedQueries);
  const sourceSummary = dbtStatus
    ? `${dbtStatus.counts.models} models · ${semanticMetricCount} metrics`
    : 'Waiting for dbt artifacts';
  const projectLabel = dbtStatus?.projectName || dbtStatus?.projectPath?.split('/').filter(Boolean).pop() || 'dbt project';

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 22, display: 'grid', gap: 14, alignContent: 'start', background: t.appBg }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Build a DQL block</div>
          <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45, marginTop: 5, maxWidth: 560, fontFamily: t.font }}>
            Start from dbt models, semantic metrics, existing SQL, or an AI draft.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', border: `1px solid ${dbtReady ? '#2ea04340' : t.headerBorder}`, borderRadius: 8, background: dbtReady ? '#2ea0430d' : t.cellBg }}>
          <CheckCircle2 size={15} strokeWidth={2} color={dbtReady ? '#2ea043' : t.textMuted} aria-hidden="true" />
          <span style={{ fontSize: 11, color: dbtReady ? '#2ea043' : t.textMuted, fontWeight: 700, fontFamily: t.font }}>
            {dbtReady ? 'dbt ready' : 'dbt pending'}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        {cards.map((card) => (
          <CompactStartTile
            key={card.title}
            title={card.title}
            detail={card.detail}
            label={card.label}
            Icon={card.Icon}
            onClick={card.action}
            t={t}
          />
        ))}
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <ReadinessChip Icon={Database} label={projectLabel} value={sourceSummary} tone={dbtReady ? 'success' : 'neutral'} t={t} />
        <ReadinessChip Icon={Database} label="Database" value={`${databaseStats.tables} tables`} tone={databaseStats.tables > 0 ? 'success' : 'neutral'} t={t} />
        <ReadinessChip Icon={Blocks} label="Semantic layer" value={`${semanticObjectCount} objects`} tone={semanticObjectCount > 0 ? 'success' : 'neutral'} t={t} />
        <ReadinessChip Icon={ShieldCheck} label="Governance" value="Run · validate · certify" tone="neutral" t={t} />
      </section>
    </div>
  );
}

function CompactStartTile({
  title,
  detail,
  label,
  Icon,
  onClick,
  t,
}: {
  title: string;
  detail: string;
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  t: Theme;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: t.cellBg,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 8,
        padding: 12,
        cursor: 'pointer',
        color: t.textPrimary,
        display: 'grid',
        gridTemplateColumns: '30px minmax(0, 1fr)',
        gap: 10,
        minHeight: 94,
        fontFamily: t.font,
        alignItems: 'start',
      }}
    >
      <span style={{ width: 30, height: 30, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${t.accent}14`, color: t.accent }}>
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <span style={{ display: 'grid', gap: 5, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: t.textPrimary }}>{title}</span>
        <span style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35 }}>{detail}</span>
        <span style={{ color: t.accent, fontSize: 11, fontWeight: 800 }}>{label}</span>
      </span>
    </button>
  );
}

function ReadinessChip({
  Icon,
  label,
  value,
  tone,
  t,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  tone: 'success' | 'neutral';
  t: Theme;
}) {
  const color = tone === 'success' ? '#2ea043' : t.textMuted;
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ color, display: 'inline-flex', flexShrink: 0 }}>
        <Icon size={15} strokeWidth={2} aria-hidden="true" />
      </span>
      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ fontSize: 12, color: t.textPrimary, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
      </span>
    </div>
  );
}

function DbtStatusRows({ status, t }: { status: BlockStudioDbtStatus | null; t: Theme }) {
  if (!status) {
    return <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>Checking dbt project status…</div>;
  }
  const artifactRows = [
    ['manifest.json', status.artifacts.manifest],
    ['catalog.json', status.artifacts.catalog],
    ['semantic_manifest.json', status.artifacts.semanticManifest],
    ['run_results.json', status.artifacts.runResults],
  ] as const;
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      <InfoLine label="Project" value={status.projectName || status.projectPath || 'not detected'} t={t} />
      <InfoLine label="Provider" value={status.provider || 'none'} t={t} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <ImportPill label={`${status.counts.models} models`} tone="info" t={t} />
        <ImportPill label={`${status.counts.sources} sources`} tone="info" t={t} />
        <ImportPill label={`${status.counts.metrics} metrics`} tone="info" t={t} />
        <ImportPill label={`${status.counts.savedQueries} saved queries`} tone="info" t={t} />
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {artifactRows.map(([label, artifact]) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: '180px 70px minmax(0, 1fr)', gap: 8, alignItems: 'center', fontSize: 12, fontFamily: t.font }}>
            <span style={{ color: t.textSecondary }}>{label}</span>
            <span style={{ color: artifact.exists ? '#2ea043' : '#d29922', fontWeight: 800 }}>{artifact.exists ? 'ready' : 'missing'}</span>
            <span title={artifact.path} style={{ color: t.textMuted, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.path}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: status.artifacts.manifest.exists ? t.textMuted : '#d29922', lineHeight: 1.45, fontFamily: t.font }}>
        {status.setupHint}
      </div>
    </div>
  );
}

function SemanticBlockBuilder({
  source,
  semanticLayer,
  chartConfig,
  onChange,
  t,
}: {
  source: string;
  semanticLayer: SemanticLayerState;
  chartConfig: { chart?: string; x?: string; y?: string; color?: string; title?: string };
  onChange: (next: string) => void;
  t: Theme;
}) {
  const values = parseSemanticBlockValues(source);
  const allDimensions = [...semanticLayer.dimensions, ...semanticLayer.timeDimensions];
  const inputStyle = importInputStyle(t);
  const setMetric = (metric: string) => onChange(setSemanticMetricField(source, metric));
  const setDimensions = (dimensions: string[]) => onChange(setDqlArrayField(source, 'dimensions', dimensions));
  const toggleDimension = (dimension: string) => {
    const next = values.dimensions.includes(dimension)
      ? values.dimensions.filter((item) => item !== dimension)
      : [...values.dimensions, dimension];
    setDimensions(next);
  };
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, display: 'grid', gap: 14, alignContent: 'start', background: t.appBg }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 0.6fr)', gap: 12 }}>
        <PanelBox title="Metric and grain" t={t}>
          <FieldLabel label="Metric" t={t}>
            <select value={values.metric} onChange={(event) => setMetric(event.target.value)} style={inputStyle}>
              <option value="">Select a governed metric…</option>
              {semanticLayer.metrics.map((metric) => (
                <option key={metric.name} value={metric.name}>{metric.label || metric.name}</option>
              ))}
            </select>
          </FieldLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 8 }}>
            <FieldLabel label="Time dimension" t={t}>
              <select value={values.timeDimension} onChange={(event) => onChange(setSemanticScalarField(source, 'time_dimension', event.target.value))} style={inputStyle}>
                <option value="">None</option>
                {semanticLayer.timeDimensions.map((dimension) => (
                  <option key={dimension.name} value={dimension.name}>{dimension.label || dimension.name}</option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="Grain" t={t}>
              <select value={values.granularity} onChange={(event) => onChange(setSemanticScalarField(source, 'granularity', event.target.value))} style={inputStyle}>
                <option value="">None</option>
                {['day', 'week', 'month', 'quarter', 'year'].map((grain) => <option key={grain} value={grain}>{grain}</option>)}
              </select>
            </FieldLabel>
          </div>
          {semanticLayer.metrics.length === 0 && (
            <div style={{ fontSize: 12, color: '#d29922', lineHeight: 1.45 }}>No semantic metrics are loaded. Run `dbt parse` or import a semantic layer, then refresh Block Studio.</div>
          )}
        </PanelBox>

        <PanelBox title="Chart intent" t={t}>
          <FieldLabel label="Chart type" t={t}>
            <select value={chartConfig.chart ?? 'table'} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, chart: event.target.value }))} style={inputStyle}>
              <option value="table">Table</option>
              {CHART_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </FieldLabel>
          <FieldLabel label="Title" t={t}>
            <input value={chartConfig.title ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, title: event.target.value }))} placeholder="Chart title" style={inputStyle} />
          </FieldLabel>
        </PanelBox>
      </div>

      <PanelBox title="Dimensions" t={t}>
        {allDimensions.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textMuted }}>No dimensions are loaded yet.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {allDimensions.slice(0, 80).map((dimension) => {
              const selected = values.dimensions.includes(dimension.name);
              return (
                <button
                  key={dimension.name}
                  onClick={() => toggleDimension(dimension.name)}
                  style={{
                    background: selected ? `${t.accent}18` : t.btnBg,
                    border: `1px solid ${selected ? t.accent : t.btnBorder}`,
                    borderRadius: 999,
                    color: selected ? t.accent : t.textSecondary,
                    cursor: 'pointer',
                    fontSize: 11,
                    fontFamily: t.font,
                    padding: '5px 9px',
                  }}
                >
                  {dimension.label || dimension.name}
                </button>
              );
            })}
          </div>
        )}
      </PanelBox>

      <PanelBox title="Generated DQL" t={t}>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: t.textSecondary, fontSize: 11, lineHeight: 1.45, fontFamily: t.fontMono }}>{source}</pre>
      </PanelBox>
    </div>
  );
}

function BuilderNotice({
  semanticChoice,
  databaseWarning,
  onDismiss,
  onInsertAdvanced,
  onCreateSemantic,
  t,
}: {
  semanticChoice: SemanticObjectDetail | null;
  databaseWarning: string | null;
  onDismiss: () => void;
  onInsertAdvanced: () => void;
  onCreateSemantic: () => void;
  t: Theme;
}) {
  const message = semanticChoice
    ? `${semanticChoice.kind === 'metric' ? 'Metric' : 'Dimension'} "${semanticChoice.name}" belongs in a Semantic Block. SQL Blocks can still use advanced @metric/@dim refs when you choose that explicitly.`
    : databaseWarning ?? '';
  return (
    <div style={{ padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}`, background: `${t.accent}10`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.4, flex: 1, minWidth: 260 }}>{message}</span>
      {semanticChoice && (
        <>
          <button onClick={onCreateSemantic} style={secondaryImportButtonStyle(t)}>Create Semantic Block</button>
          <button onClick={onInsertAdvanced} style={primaryImportButtonStyle(t)}>Insert advanced ref</button>
        </>
      )}
      <button onClick={onDismiss} style={secondaryImportButtonStyle(t)}>Dismiss</button>
    </div>
  );
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

type ImportSourceMode = 'path' | 'paste' | 'upload' | 'tableau' | 'powerbi';

function BlockStudioImportWorkspace({
  session,
  sessions,
  sessionsLoading,
  onSessionChange,
  onRefreshSessions,
  onClose,
  onSelectCandidate,
  onSavedCandidate,
  defaultDomain,
  defaultOwner,
  t,
}: {
  session: BlockStudioImportSession | null;
  sessions: BlockStudioImportSessionSummary[];
  sessionsLoading: boolean;
  onSessionChange: (session: BlockStudioImportSession | null) => void;
  onRefreshSessions: () => Promise<void>;
  onClose: () => void;
  onSelectCandidate: (candidate: BlockStudioImportCandidate) => void;
  onSavedCandidate: (candidate: BlockStudioImportCandidate, block: BlockStudioOpenPayload) => void;
  defaultDomain: string;
  defaultOwner: string;
  t: Theme;
}) {
  const [mode, setMode] = useState<ImportSourceMode>('path');
  const [path, setPath] = useState('');
  const [pasteSql, setPasteSql] = useState('');
  const [uploadSources, setUploadSources] = useState<Array<{ path: string; content: string }>>([]);
  const [domain, setDomain] = useState(defaultDomain);
  const [owner, setOwner] = useState(defaultOwner);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'one'; id: string } | { kind: 'all' } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [showAllCandidates, setShowAllCandidates] = useState(false);

  const selectedCandidate = useMemo(() => {
    if (!session) return null;
    return session.candidates.find((candidate) => candidate.id === selectedId) ?? session.candidates[0] ?? null;
  }, [session, selectedId]);

  useEffect(() => {
    if (!session?.candidates.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !session.candidates.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(session.candidates[0].id);
    }
  }, [session, selectedId]);

  const readyCount = session?.candidates.filter((candidate) => candidate.validation?.valid !== false && candidate.reviewStatus !== 'rejected').length ?? 0;
  const savedCount = session?.candidates.filter((candidate) => candidate.reviewStatus === 'saved').length ?? 0;
  const warningCount = session?.candidates.reduce((sum, candidate) => sum + ((candidate.warnings ?? candidate.lineage.warnings).length), 0) ?? 0;
  const candidateMatches = useMemo(() => {
    const normalized = candidateSearch.trim().toLowerCase();
    const source = session?.candidates ?? [];
    if (!normalized) return source;
    return source.filter((candidate) => [
      candidate.name,
      candidate.domain,
      candidate.sourcePath,
      candidate.description,
      ...candidate.lineage.sourceTables,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [candidateSearch, session]);
  const visibleCandidates = showAllCandidates || candidateSearch.trim()
    ? candidateMatches
    : candidateMatches.slice(0, 10);

  const createSession = async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === 'tableau' || mode === 'powerbi') {
        setError(mode === 'tableau'
          ? 'Tableau local file import is designed for the next migration-helper pass. SQL import is the active OSS path now.'
          : 'Power BI PBIP/PBIR/TMDL import is designed for the next migration-helper pass. SQL import is the active OSS path now.');
        return;
      }
      const payload = mode === 'path'
        ? { path, inputMode: 'path' as const, sourceKind: 'raw-sql' as const, domain, owner }
        : {
            inputMode: mode,
            sourceKind: 'raw-sql' as const,
            domain,
            owner,
            sources: mode === 'paste'
              ? [{ path: 'pasted.sql', content: pasteSql }]
              : uploadSources,
          };
      const next = await api.createBlockStudioImport(payload);
      onSessionChange(next);
      setSelectedId(next.candidates[0]?.id ?? null);
      await onRefreshSessions();
    } catch (err: any) {
      setError(err?.message ?? 'Import session failed.');
    } finally {
      setLoading(false);
    }
  };

  const resumeSession = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.getBlockStudioImport(id);
      onSessionChange(next);
      setSelectedId(next.candidates.find((candidate) => candidate.reviewStatus !== 'saved' && candidate.reviewStatus !== 'rejected')?.id ?? next.candidates[0]?.id ?? null);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to resume import session.');
    } finally {
      setLoading(false);
    }
  };

  const deleteSession = async (id: string) => {
    setPendingDelete({ kind: 'one', id });
  };

  const clearSessions = async () => {
    if (sessions.length === 0) return;
    setPendingDelete({ kind: 'all' });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const action = pendingDelete;
    setLoading(true);
    setError(null);
    try {
      if (action.kind === 'one') {
        await api.deleteBlockStudioImport(action.id);
      } else {
        await api.clearBlockStudioImports();
      }
      if (action.kind === 'all' || session?.id === action.id) {
        onSessionChange(null);
        setSelectedId(null);
      }
      setPendingDelete(null);
      await onRefreshSessions();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update import history.');
    } finally {
      setLoading(false);
    }
  };

  const updateCandidate = (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    onSessionChange({
      ...session,
      candidates: session.candidates.map((item) => item.id === candidate.id ? candidate : item),
    });
  };

  const runCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const next = await api.runBlockStudioImportCandidate(session.id, candidate.id);
      updateCandidate(next);
      setSelectedId(next.id);
    } catch (err: any) {
      setError(err?.message ?? 'Candidate run failed.');
    } finally {
      setLoading(false);
    }
  };

  const saveCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.saveBlockStudioImportCandidate(session.id, candidate.id);
      updateCandidate(result.candidate);
      onSavedCandidate(result.candidate, result.block);
      await onRefreshSessions();
    } catch (err: any) {
      const message = err?.message ?? 'Candidate save failed.';
      setError(message.includes('409') || message.includes('already exists')
        ? 'A block with this name already exists. Rename this candidate, then save again.'
        : message);
    } finally {
      setLoading(false);
    }
  };

  const saveAll = async () => {
    if (!session) return;
    setSavingAll(true);
    setError(null);
    try {
      const result = await api.saveAllBlockStudioImportCandidates(session.id);
      onSessionChange(result.session);
      await onRefreshSessions();
      if (result.errors.length > 0) {
        setError(`${result.saved.length} saved. ${result.errors.length} candidate(s) need attention.`);
      }
    } catch (err: any) {
      setError(err?.message ?? 'Save all failed.');
    } finally {
      setSavingAll(false);
    }
  };

  const rejectCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    const next = await api.updateBlockStudioImportCandidate(session.id, candidate.id, { reviewStatus: 'rejected' });
    updateCandidate(next);
    void onRefreshSessions();
  };

  const selectNextUnsaved = () => {
    if (!session) return;
    const next = session.candidates.find((candidate) => candidate.reviewStatus !== 'saved' && candidate.reviewStatus !== 'rejected');
    if (next) setSelectedId(next.id);
  };

  const handleFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    const sqlFiles = list.filter((file) => file.name.toLowerCase().endsWith('.sql'));
    const sources = await Promise.all(sqlFiles.map(async (file) => ({ path: file.name, content: await file.text() })));
    setUploadSources(sources);
  };

  return (
    <div style={{ position: 'relative', height: '100%', display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', minHeight: 0, background: t.appBg }}>
      <aside style={{ borderRight: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column', minHeight: 0, background: t.cellBg }}>
        <div style={{ padding: 16, borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Import SQL</span>
            <span style={{ flex: 1 }} />
            <button onClick={onClose} style={secondaryImportButtonStyle(t)}>Close</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4 }}>
            {(['path', 'paste', 'upload'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                style={{
                  ...secondaryImportButtonStyle(t),
                  padding: '6px 4px',
                  color: mode === value ? t.accent : t.textSecondary,
                  borderColor: mode === value ? t.accent : t.btnBorder,
                  background: mode === value ? `${t.accent}14` : t.btnBg,
                }}
              >
                {value === 'path' ? 'File / folder' : value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          {mode === 'path' && (
            <FieldLabel label="SQL file or folder path" t={t}>
              <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="./queries or ./legacy.sql" style={importInputStyle(t)} />
            </FieldLabel>
          )}
          {mode === 'paste' && (
            <FieldLabel label="Paste SQL" t={t}>
              <textarea value={pasteSql} onChange={(event) => setPasteSql(event.target.value)} placeholder="select ...; go&#10;select ..." style={{ ...importInputStyle(t), minHeight: 108, resize: 'vertical', fontFamily: t.fontMono }} />
            </FieldLabel>
          )}
          {mode === 'upload' && (
            <FieldLabel label="Upload .sql files" t={t}>
              <input type="file" multiple accept=".sql,text/sql,text/plain" onChange={(event) => void handleFiles(event.target.files)} style={importInputStyle(t)} />
              <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>{uploadSources.length} SQL file(s) ready</span>
            </FieldLabel>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <FieldLabel label="Domain" t={t}>
              <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="imported" style={importInputStyle(t)} />
            </FieldLabel>
            <FieldLabel label="Owner" t={t}>
              <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="analytics" style={importInputStyle(t)} />
            </FieldLabel>
          </div>
          <button
            onClick={() => void createSession()}
            disabled={loading || mode === 'tableau' || mode === 'powerbi' || (mode === 'path' && !path.trim()) || (mode === 'paste' && !pasteSql.trim()) || (mode === 'upload' && uploadSources.length === 0)}
            style={{ ...primaryImportButtonStyle(t), padding: '8px 12px', opacity: loading ? 0.65 : 1 }}
          >
            {loading ? 'Working...' : 'Preview SQL'}
          </button>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.45 }}>
            Flow: choose SQL, review each detected query, then save draft blocks. Split uses semicolon and GO batch separators.
          </div>
          <details style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, border: `1px dashed ${t.headerBorder}`, borderRadius: 8, padding: '8px 10px' }}>
            <summary style={{ cursor: 'pointer', color: t.textSecondary, fontWeight: 700 }}>Tableau / Power BI migration helpers</summary>
            <div style={{ marginTop: 8, lineHeight: 1.45 }}>
              Local Tableau `.twb/.twbx` and Power BI PBIP/PBIR/TMDL import are planned. OSS v1 keeps SQL import active first and preserves unsupported BI formulas as future warnings.
            </div>
          </details>
        </div>

        <div style={{ padding: 12, borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setHistoryOpen((open) => !open)} style={{ ...secondaryImportButtonStyle(t), padding: '5px 8px' }}>
              {historyOpen ? 'Hide recent imports' : 'Recent imports'}
            </button>
            <span style={{ flex: 1 }} />
            {historyOpen && <button onClick={() => void onRefreshSessions()} style={secondaryImportButtonStyle(t)}>Refresh</button>}
            {historyOpen && sessions.length > 0 && <button onClick={() => void clearSessions()} style={secondaryImportButtonStyle(t)}>Clear all</button>}
          </div>
          {historyOpen && (sessionsLoading ? (
            <div style={{ fontSize: 12, color: t.textMuted }}>Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div style={{ fontSize: 12, color: t.textMuted }}>No saved import previews yet.</div>
          ) : (
            <div style={{ display: 'grid', gap: 6, maxHeight: 190, overflow: 'auto' }}>
              {sessions.slice(0, 8).map((item) => (
                <div key={item.id} style={{
                  border: `1px solid ${session?.id === item.id ? t.accent : t.btnBorder}`,
                  borderRadius: 8,
                  background: session?.id === item.id ? `${t.accent}10` : t.btnBg,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  alignItems: 'stretch',
                  overflow: 'hidden',
                }}>
                  <button onClick={() => void resumeSession(item.id)} style={{
                    background: 'transparent',
                    border: 'none',
                    color: t.textSecondary,
                    cursor: 'pointer',
                    fontFamily: t.font,
                    padding: '8px 9px',
                    textAlign: 'left',
                    display: 'grid',
                    gap: 3,
                    minWidth: 0,
                  }}>
                    <span style={{ fontFamily: t.fontMono, fontSize: 10 }}>{item.id}</span>
                    <span style={{ fontSize: 11 }}>{item.candidateCount} candidates · {item.savedCount} saved · {item.warningCount} warnings</span>
                    <span style={{ fontSize: 10, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.inputPath}</span>
                  </button>
                  <button
                    onClick={() => void deleteSession(item.id)}
                    title="Delete local import preview"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      borderLeft: `1px solid ${t.headerBorder}`,
                      color: t.textMuted,
                      cursor: 'pointer',
                      fontFamily: t.font,
                      padding: '0 8px',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'grid', alignContent: 'start', gap: 8 }}>
          {!session ? (
            <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.5 }}>Create or open an import preview to review detected SQL queries.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <ImportPill label={`${session.candidates.length} candidates`} tone="info" t={t} />
                <ImportPill label={`${readyCount} ready`} tone="ok" t={t} />
                <ImportPill label={`${savedCount} saved`} tone="ok" t={t} />
                {warningCount > 0 && <ImportPill label={`${warningCount} warnings`} tone="warn" t={t} />}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={selectNextUnsaved} style={secondaryImportButtonStyle(t)}>Open next unsaved</button>
                <button onClick={() => void saveAll()} disabled={savingAll} style={primaryImportButtonStyle(t)}>{savingAll ? 'Saving...' : 'Save all valid'}</button>
              </div>
              <input
                value={candidateSearch}
                onChange={(event) => setCandidateSearch(event.target.value)}
                placeholder="Search candidates, tables, files..."
                style={importInputStyle(t)}
              />
              {visibleCandidates.map((candidate) => {
                const selected = candidate.id === selectedCandidate?.id;
                const warnings = candidate.warnings ?? candidate.lineage.warnings;
                return (
                  <button
                    key={candidate.id}
                    onClick={() => setSelectedId(candidate.id)}
                    style={{
                      border: `1px solid ${selected ? t.accent : t.headerBorder}`,
                      borderRadius: 8,
                      background: selected ? `${t.accent}10` : t.appBg,
                      color: t.textPrimary,
                      padding: 10,
                      display: 'grid',
                      gap: 6,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candidate.name}</span>
                      <ImportPill label={candidate.reviewStatus} tone={candidate.reviewStatus === 'saved' ? 'ok' : candidate.reviewStatus === 'rejected' ? 'warn' : 'info'} t={t} />
                    </span>
                    <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>{candidate.lineage.statementIndex}/{candidate.lineage.totalStatements} · {candidate.sourcePath}</span>
                    <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <ImportPill label={`${Math.round(candidate.confidence * 100)}%`} tone="info" t={t} />
                      <ImportPill label={candidate.validation?.valid === false ? 'review' : 'valid'} tone={candidate.validation?.valid === false ? 'warn' : 'ok'} t={t} />
                      {warnings.length > 0 && <ImportPill label={`${warnings.length} warning`} tone="warn" t={t} />}
                    </span>
                  </button>
                );
              })}
              {!showAllCandidates && !candidateSearch.trim() && candidateMatches.length > 10 && (
                <button onClick={() => setShowAllCandidates(true)} style={secondaryImportButtonStyle(t)}>
                  Show all {candidateMatches.length} candidates
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      <section style={{ minWidth: 0, minHeight: 0, overflow: 'auto', padding: 14 }}>
        {error && (
          <div style={{ padding: '10px 12px', color: '#f85149', background: '#f8514914', border: `1px solid #f8514933`, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
            {error}
          </div>
        )}
        {!session || !selectedCandidate ? (
          <ImportGuide t={t} />
        ) : (
          <ImportCandidateDetail
            session={session}
            candidate={selectedCandidate}
            loading={loading}
            onCandidateUpdated={updateCandidate}
            onRun={runCandidate}
            onSave={saveCandidate}
            onReject={rejectCandidate}
            onReviewInEditor={onSelectCandidate}
            t={t}
          />
        )}
      </section>
      {pendingDelete && (
        <ImportConfirmPanel
          t={t}
          busy={loading}
          title={pendingDelete.kind === 'all' ? 'Clear import history?' : 'Delete import preview?'}
          message={pendingDelete.kind === 'all'
            ? `This removes ${sessions.length} local import preview${sessions.length === 1 ? '' : 's'} from .dql/imports. Saved draft blocks stay in the project.`
            : 'This removes the selected local import preview from .dql/imports. Saved draft blocks stay in the project.'}
          confirmLabel={pendingDelete.kind === 'all' ? 'Clear history' : 'Delete preview'}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}

function ImportConfirmPanel({
  title,
  message,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  t,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: Theme;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.22)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 20,
      }}
    >
      <div
        style={{
          width: 'min(420px, 92vw)',
          background: t.cellBg,
          color: t.textPrimary,
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 8,
          boxShadow: '0 18px 48px rgba(0, 0, 0, 0.30)',
          padding: 16,
          display: 'grid',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: t.font }}>{title}</div>
        <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.5, fontFamily: t.font }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} disabled={busy} style={secondaryImportButtonStyle(t)}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...primaryImportButtonStyle(t), opacity: busy ? 0.65 : 1 }}>
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportCandidateDetail({
  session,
  candidate,
  loading,
  onCandidateUpdated,
  onRun,
  onSave,
  onReject,
  onReviewInEditor,
  t,
}: {
  session: BlockStudioImportSession;
  candidate: BlockStudioImportCandidate;
  loading: boolean;
  onCandidateUpdated: (candidate: BlockStudioImportCandidate) => void;
  onRun: (candidate: BlockStudioImportCandidate) => Promise<void>;
  onSave: (candidate: BlockStudioImportCandidate) => Promise<void>;
  onReject: (candidate: BlockStudioImportCandidate) => Promise<void>;
  onReviewInEditor: (candidate: BlockStudioImportCandidate) => void;
  t: Theme;
}) {
  const [name, setName] = useState(candidate.name);
  const [domain, setDomain] = useState(candidate.domain);
  const [owner, setOwner] = useState(candidate.owner);
  const [description, setDescription] = useState(candidate.description);
  const [tags, setTags] = useState(candidate.tags.join(', '));
  const [sql, setSql] = useState(candidate.sql);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    setName(candidate.name);
    setDomain(candidate.domain);
    setOwner(candidate.owner);
    setDescription(candidate.description);
    setTags(candidate.tags.join(', '));
    setSql(candidate.sql);
    setEditError(null);
  }, [candidate.id, candidate.name, candidate.domain, candidate.owner, candidate.description, candidate.tags, candidate.sql]);

  const saveEdits = async () => {
    setEditError(null);
    try {
      const next = await api.updateBlockStudioImportCandidate(session.id, candidate.id, {
        name,
        domain,
        owner,
        description,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        sql,
      });
      onCandidateUpdated(next);
    } catch (err: any) {
      setEditError(err?.message ?? 'Could not update candidate.');
    }
  };

  const assist = async (action: string) => {
    setAiBusy(action);
    setEditError(null);
    try {
      const next = await api.assistBlockStudioImportCandidate(session.id, candidate.id, action);
      onCandidateUpdated(next);
    } catch (err: any) {
      setEditError(err?.message ?? 'AI assist failed.');
    } finally {
      setAiBusy(null);
    }
  };

  const warnings = candidate.warnings ?? candidate.lineage.warnings;
  const inputStyle = importInputStyle(t);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: t.textPrimary }}>{candidate.name}</div>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, marginTop: 3 }}>{candidate.sourcePath} · statement {candidate.lineage.statementIndex}/{candidate.lineage.totalStatements}</div>
        </div>
        <button onClick={() => void onRun(candidate)} disabled={loading} style={secondaryImportButtonStyle(t)}>Run preview</button>
        <button onClick={() => onReviewInEditor(candidate)} style={primaryImportButtonStyle(t)}>Review in editor</button>
        <button onClick={() => void onSave(candidate)} disabled={loading || candidate.reviewStatus === 'saved'} style={primaryImportButtonStyle(t)}>{candidate.reviewStatus === 'saved' ? 'Saved' : 'Save draft'}</button>
        <button onClick={() => void onReject(candidate)} disabled={candidate.reviewStatus === 'rejected'} style={secondaryImportButtonStyle(t)}>Reject</button>
      </div>

      {editError && <div style={{ fontSize: 12, color: '#f85149', background: '#f8514914', borderRadius: 8, padding: 10 }}>{editError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 38%)', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <PanelBox title="Block Details" t={t}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <FieldLabel label="Name" t={t}><input value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Domain" t={t}><input value={domain} onChange={(event) => setDomain(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Owner" t={t}><input value={owner} onChange={(event) => setOwner(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Tags" t={t}><input value={tags} onChange={(event) => setTags(event.target.value)} style={inputStyle} /></FieldLabel>
            </div>
            <FieldLabel label="Description" t={t}><input value={description} onChange={(event) => setDescription(event.target.value)} style={inputStyle} /></FieldLabel>
            <button onClick={() => void saveEdits()} style={primaryImportButtonStyle(t)}>Apply edits</button>
          </PanelBox>

          <PanelBox title="Original SQL" t={t}>
            <textarea value={sql} onChange={(event) => setSql(event.target.value)} style={{ ...inputStyle, minHeight: 210, fontFamily: t.fontMono, resize: 'vertical' }} />
          </PanelBox>

          <PanelBox title="Draft DQL Block" t={t}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.45, color: t.textSecondary, fontFamily: t.fontMono }}>{candidate.dqlSource}</pre>
          </PanelBox>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <PanelBox title="How DQL Was Generated" t={t}>
            <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
              This is an audit view for the selected SQL query. It explains what DQL created locally before you save the draft block.
            </div>
            <InfoLine label="Method" value="Deterministic local conversion" t={t} />
            <InfoLine label="Block" value={candidate.name} t={t} />
            <InfoLine label="Domain" value={candidate.domain} t={t} />
            <InfoLine label="Visualization" value="table" t={t} />
            <InfoLine label="Default test" value="assert row_count > 0" t={t} />
            <InfoLine label="Split strategy" value={candidate.splitStrategy ?? 'semicolon-go'} t={t} />
            <div style={{ display: 'grid', gap: 5 }}>
              <div style={{ fontSize: 10, color: t.textMuted, textTransform: 'uppercase', fontWeight: 800 }}>Detected tables</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {candidate.lineage.sourceTables.length ? candidate.lineage.sourceTables.map((table) => <ImportPill key={table} label={table} tone="info" t={t} />) : <span style={{ fontSize: 12, color: t.textMuted }}>None detected</span>}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 5 }}>
              <div style={{ fontSize: 10, color: t.textMuted, textTransform: 'uppercase', fontWeight: 800 }}>Parameters</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {candidate.lineage.parameters.length ? candidate.lineage.parameters.map((param) => <ImportPill key={param} label={param} tone="warn" t={t} />) : <span style={{ fontSize: 12, color: t.textMuted }}>None detected</span>}
              </div>
            </div>
            {warnings.length > 0 && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ fontSize: 10, color: '#d29922', textTransform: 'uppercase', fontWeight: 800 }}>Warnings</div>
                {warnings.map((warning, index) => <div key={index} style={{ fontSize: 12, color: '#d29922', lineHeight: 1.4 }}>{warning}</div>)}
              </div>
            )}
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 10, color: t.textMuted, textTransform: 'uppercase', fontWeight: 800 }}>Notes</div>
              {(candidate.conversionNotes ?? []).map((note, index) => <div key={index} style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.4 }}>{note}</div>)}
            </div>
          </PanelBox>

          <PanelBox title="Optional AI Suggestions" t={t}>
            <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
              Optional helper for naming, explanation, validation fixes, chart ideas, and stronger tests. It only uses this selected candidate context and records suggestions for review.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[
                ['explain', 'Explain'],
                ['fix-validation', 'Fix validation'],
                ['infer-chart', 'Infer chart'],
                ['propose-tests', 'Propose tests'],
              ].map(([action, label]) => (
                <button key={action} onClick={() => void assist(action)} disabled={Boolean(aiBusy)} style={secondaryImportButtonStyle(t)}>
                  {aiBusy === action ? 'Working...' : label}
                </button>
              ))}
            </div>
            {(candidate.aiAssistance ?? []).length > 0 && (
              <div style={{ display: 'grid', gap: 8 }}>
                {(candidate.aiAssistance ?? []).slice().reverse().map((item, index) => (
                  <div key={`${item.createdAt}-${index}`} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 9, background: t.appBg }}>
                    <div style={{ fontSize: 10, color: t.textMuted, fontWeight: 800, textTransform: 'uppercase' }}>{item.action} · {item.status}</div>
                    <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45, marginTop: 5 }}>{item.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </PanelBox>
        </div>
      </div>
    </div>
  );
}

function BlockStudioImportModal({
  session,
  onSessionChange,
  onClose,
  onSelectCandidate,
  onSavedCandidate,
  defaultDomain,
  defaultOwner,
  t,
}: {
  session: BlockStudioImportSession | null;
  onSessionChange: (session: BlockStudioImportSession | null) => void;
  onClose: () => void;
  onSelectCandidate: (candidate: BlockStudioImportCandidate) => void;
  onSavedCandidate: (candidate: BlockStudioImportCandidate, block: BlockStudioOpenPayload) => void;
  defaultDomain: string;
  defaultOwner: string;
  t: Theme;
}) {
  const [path, setPath] = useState('');
  const [domain, setDomain] = useState(defaultDomain);
  const [owner, setOwner] = useState(defaultOwner);
  const [loading, setLoading] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readyCount = session?.candidates.filter((candidate) => candidate.validation?.valid !== false).length ?? 0;
  const savedCount = session?.candidates.filter((candidate) => candidate.reviewStatus === 'saved').length ?? 0;
  const activeStep = !session ? 1 : savedCount > 0 ? 3 : 2;

  const updateCandidate = (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    onSessionChange({
      ...session,
      candidates: session.candidates.map((item) => item.id === candidate.id ? candidate : item),
    });
  };

  const handlePreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.previewBlockStudioImport({
        path,
        sourceKind: 'raw-sql',
        domain,
        owner,
      });
      onSessionChange(next);
    } catch (err: any) {
      setError(err?.message ?? 'Import preview failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleRunCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    setRunningId(candidate.id);
    setError(null);
    try {
      const next = await api.runBlockStudioImportCandidate(session.id, candidate.id);
      updateCandidate(next);
    } catch (err: any) {
      setError(err?.message ?? 'Candidate run failed.');
    } finally {
      setRunningId(null);
    }
  };

  const handleSaveCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    setSavingId(candidate.id);
    setError(null);
    try {
      const result = await api.saveBlockStudioImportCandidate(session.id, candidate.id);
      updateCandidate(result.candidate);
      onSavedCandidate(result.candidate, result.block);
    } catch (err: any) {
      const message = err?.message ?? 'Candidate save failed.';
      setError(message.includes('409') || message.includes('already exists')
        ? 'A block with this name already exists. Use Review in editor to rename it, then save.'
        : message);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: 820,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 72px)',
          background: t.cellBg,
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 10,
          boxShadow: '0 24px 70px rgba(0,0,0,0.35)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${t.headerBorder}`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>Import SQL into Block Studio</div>
            <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, marginTop: 2 }}>Scan existing SQL, review candidates, then save draft DQL blocks.</div>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
            title="Close import"
          >
            ×
          </button>
        </div>

        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, background: `${t.appBg}99` }}>
          <ImportStep index={1} active={activeStep === 1} complete={Boolean(session)} title="Choose source" detail="SQL file or folder" t={t} />
          <ImportStep index={2} active={activeStep === 2} complete={savedCount > 0} title="Review candidates" detail={session ? `${session.candidates.length} found · ${readyCount} ready` : 'Validate metadata'} t={t} />
          <ImportStep index={3} active={activeStep === 3} complete={savedCount > 0} title="Save drafts" detail={savedCount > 0 ? `${savedCount} saved` : 'Open or save as block'} t={t} />
        </div>

        <div style={{ padding: 14, borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px 150px auto', gap: 8, alignItems: 'end' }}>
          <FieldLabel label="SQL file or folder" t={t}>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/path/to/sql or ./queries"
              style={importInputStyle(t)}
            />
          </FieldLabel>
          <FieldLabel label="Domain" t={t}>
            <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="imported" style={importInputStyle(t)} />
          </FieldLabel>
          <FieldLabel label="Owner" t={t}>
            <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="analytics" style={importInputStyle(t)} />
          </FieldLabel>
          <button
            onClick={() => void handlePreview()}
            disabled={loading || !path.trim()}
            style={{
              background: t.accent,
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              color: '#fff',
              cursor: loading || !path.trim() ? 'not-allowed' : 'pointer',
              fontSize: 12,
              fontWeight: 700,
              fontFamily: t.font,
              padding: '8px 12px',
              opacity: loading || !path.trim() ? 0.6 : 1,
            }}
          >
            {loading ? 'Scanning…' : 'Preview'}
          </button>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', color: '#f85149', background: '#f8514914', borderBottom: `1px solid ${t.headerBorder}`, fontSize: 12, fontFamily: t.font }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {!session ? (
            <ImportGuide t={t} />
          ) : session.candidates.length === 0 ? (
            <EmptyPanel message="No import candidates found." />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 12, display: 'grid', gap: 6, background: t.appBg }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>{session.id}</span>
                  <ImportPill label={`${session.candidates.length} candidates`} tone="info" t={t} />
                  <ImportPill label={`${readyCount} ready`} tone="ok" t={t} />
                  {savedCount > 0 && <ImportPill label={`${savedCount} saved`} tone="ok" t={t} />}
                </div>
                <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
                  Source: <span style={{ fontFamily: t.fontMono }}>{session.inputPath}</span>
                </div>
              </div>
              {session.candidates.map((candidate) => {
                const valid = candidate.validation?.valid !== false;
                const rowCount = candidate.preview?.result?.rowCount ?? candidate.preview?.result?.rows?.length;
                return (
                  <div
                    key={candidate.id}
                    style={{
                      border: `1px solid ${t.headerBorder}`,
                      borderRadius: 8,
                      background: t.appBg,
                      padding: 12,
                      display: 'grid',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>{candidate.name}</div>
                        <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, marginTop: 3 }}>{candidate.sourcePath}</div>
                      </div>
                      <ImportPill label={`${Math.round(candidate.confidence * 100)}%`} tone="info" t={t} />
                      <ImportPill label={valid ? 'valid' : 'review'} tone={valid ? 'ok' : 'warn'} t={t} />
                      <ImportPill label={candidate.reviewStatus} tone={candidate.reviewStatus === 'saved' ? 'ok' : 'info'} t={t} />
                      {candidate.lineage.totalStatements > 1 && (
                        <ImportPill label={`${candidate.lineage.statementIndex}/${candidate.lineage.totalStatements}`} tone="info" t={t} />
                      )}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {candidate.lineage.sourceTables.length > 0 ? candidate.lineage.sourceTables.map((table) => (
                        <span key={table} style={{ fontSize: 11, color: t.textSecondary, background: t.pillBg, borderRadius: 999, padding: '3px 8px', fontFamily: t.fontMono }}>
                          {table}
                        </span>
                      )) : (
                        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>No source tables detected</span>
                      )}
                    </div>
                    {candidate.lineage.parameters.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>Parameters:</span>
                        {candidate.lineage.parameters.map((param) => (
                          <span key={param} style={{ fontSize: 11, color: '#d29922', background: '#d2992218', borderRadius: 999, padding: '3px 8px', fontFamily: t.fontMono }}>
                            {param}
                          </span>
                        ))}
                      </div>
                    )}
                    {candidate.lineage.warnings.length > 0 && (
                      <div style={{ fontSize: 11, color: '#d29922', fontFamily: t.font }}>
                        {candidate.lineage.warnings.join(' · ')}
                      </div>
                    )}
                    {candidate.validation?.diagnostics?.some((diagnostic) => diagnostic.severity === 'error') && (
                      <div style={{ fontSize: 11, color: '#f85149', fontFamily: t.font }}>
                        {candidate.validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => diagnostic.message).join(' · ')}
                      </div>
                    )}
                    {candidate.preview && (
                      <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span>Preview ready</span>
                        {typeof rowCount === 'number' && <span>· {rowCount} rows</span>}
                        <span>· Open it to inspect SQL, data, visualization, and metadata.</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button
                        onClick={() => void handleRunCandidate(candidate)}
                        disabled={runningId === candidate.id}
                        style={secondaryImportButtonStyle(t)}
                      >
                        {runningId === candidate.id ? 'Running…' : 'Run preview'}
                      </button>
                      <button
                        onClick={() => onSelectCandidate(candidate)}
                        style={primaryImportButtonStyle(t)}
                      >
                        Review in editor
                      </button>
                      <button
                        onClick={() => void handleSaveCandidate(candidate)}
                        disabled={savingId === candidate.id || candidate.reviewStatus === 'saved'}
                        style={{
                          ...primaryImportButtonStyle(t),
                          opacity: savingId === candidate.id || candidate.reviewStatus === 'saved' ? 0.55 : 1,
                          cursor: savingId === candidate.id || candidate.reviewStatus === 'saved' ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {candidate.reviewStatus === 'saved' ? 'Saved' : savingId === candidate.id ? 'Saving…' : 'Save draft'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ImportStep({ index, active, complete, title, detail, t }: { index: number; active: boolean; complete: boolean; title: string; detail: string; t: Theme }) {
  const color = complete ? '#2ea043' : active ? t.accent : t.textMuted;
  return (
    <div
      style={{
        border: `1px solid ${active ? t.accent : t.headerBorder}`,
        borderRadius: 8,
        padding: '9px 10px',
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        gap: 8,
        alignItems: 'center',
        background: active ? `${t.accent}10` : t.cellBg,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          display: 'inline-grid',
          placeItems: 'center',
          background: `${color}18`,
          color,
          fontSize: 11,
          fontWeight: 800,
          fontFamily: t.font,
        }}
      >
        {complete ? '✓' : index}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>{title}</span>
        <span style={{ display: 'block', fontSize: 10, color: t.textMuted, fontFamily: t.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>
      </span>
    </div>
  );
}

function ImportGuide({ t }: { t: Theme }) {
  const items = [
    ['1', 'Choose source', 'Enter a local .sql file or a folder with SQL files.'],
    ['2', 'Review candidates', 'DQL detects statements, tables, parameters, and draft metadata.'],
    ['3', 'Save draft blocks', 'Open in Block Studio for edits or save directly as draft blocks.'],
  ];
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <EmptyPanel message="Choose a SQL file or folder to create import candidates." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        {items.map(([index, title, detail]) => (
          <div key={title} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.appBg, padding: 12, display: 'grid', gap: 6 }}>
            <span style={{ width: 22, height: 22, borderRadius: 999, display: 'inline-grid', placeItems: 'center', background: `${t.accent}18`, color: t.accent, fontSize: 11, fontWeight: 800, fontFamily: t.font }}>
              {index}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>{title}</span>
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.4 }}>{detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldLabel({ label, children, t }: { label: string; children: React.ReactNode; t: Theme }) {
  return (
    <label style={{ display: 'grid', gap: 5 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: '0.05em', textTransform: 'uppercase', fontFamily: t.font }}>{label}</span>
      {children}
    </label>
  );
}

function PanelBox({ title, children, t }: { title: string; children: React.ReactNode; t: Theme }) {
  return (
    <section style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: t.font }}>{title}</div>
      {children}
    </section>
  );
}

function InfoLine({ label, value, t }: { label: string; value: string; t: Theme }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 8, fontSize: 12, fontFamily: t.font }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <span title={value} style={{ color: t.textSecondary, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

function ImportPill({ label, tone, t }: { label: string; tone: 'ok' | 'warn' | 'info'; t: Theme }) {
  const color = tone === 'ok' ? '#2ea043' : tone === 'warn' ? '#d29922' : t.accent;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}18`, borderRadius: 999, padding: '3px 7px', fontFamily: t.font, textTransform: 'uppercase' }}>
      {label}
    </span>
  );
}

function importInputStyle(t: Theme): React.CSSProperties {
  return {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
    minWidth: 0,
  };
}

function secondaryImportButtonStyle(t: Theme): React.CSSProperties {
  return {
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    color: t.textSecondary,
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: t.font,
    padding: '6px 10px',
  };
}

function primaryImportButtonStyle(t: Theme): React.CSSProperties {
  return {
    ...secondaryImportButtonStyle(t),
    background: `${t.accent}18`,
    border: `1px solid ${t.accent}`,
    color: t.accent,
    fontWeight: 700,
  };
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
  onOpenInspector,
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
  onOpenInspector: () => void;
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
            onClick={onOpenInspector}
            style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textPrimary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
          >
            Open Focused Lineage
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
          onClick={onOpenInspector}
          style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textPrimary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
        >
          Open Focused Lineage
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
  review: ['draft'],
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

function CertificationChecklistPanel({
  result,
  t,
}: {
  result: {
    ok?: boolean;
    checklist?: {
      metadata: boolean;
      validation: boolean;
      run: boolean;
      tests: boolean;
      chart: boolean;
      lineage: boolean;
      aiReviewed: boolean;
      blockers: string[];
      checkedAt?: string;
    };
    certification?: {
      certified: boolean;
      errors: Array<{ rule: string; message: string }>;
      warnings: Array<{ rule: string; message: string }>;
    };
    error?: string;
  };
  t: Theme;
}) {
  const checklist = result.checklist;
  const items = checklist ? [
    ['Metadata', checklist.metadata],
    ['Validation', checklist.validation],
    ['Run', checklist.run],
    ['Tests', checklist.tests],
    ['Chart', checklist.chart],
    ['Lineage', checklist.lineage],
    ['AI reviewed', checklist.aiReviewed],
  ] as const : [];
  return (
    <div style={{ margin: '12px 12px 0', border: `1px solid ${result.ok ? '#3fb95055' : '#d2992255'}`, borderRadius: 8, background: result.ok ? '#3fb9500d' : '#d299220d', padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: result.ok ? '#3fb950' : '#d29922', fontFamily: t.font }}>
          {result.ok ? 'Certification passed' : 'Certification needs attention'}
        </span>
        {checklist?.checkedAt && <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>{checklist.checkedAt}</span>}
      </div>
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {items.map(([label, ok]) => (
            <span key={label} style={{ fontSize: 11, fontWeight: 700, color: ok ? '#3fb950' : '#d29922', background: ok ? '#3fb95018' : '#d2992218', borderRadius: 999, padding: '4px 8px' }}>
              {ok ? '✓' : '!'} {label}
            </span>
          ))}
        </div>
      )}
      {result.error && <div style={{ fontSize: 12, color: '#f85149' }}>{result.error}</div>}
      {(checklist?.blockers?.length ?? 0) > 0 && (
        <div style={{ display: 'grid', gap: 5 }}>
          {checklist!.blockers.map((blocker, index) => <div key={index} style={{ fontSize: 12, color: '#d29922', lineHeight: 1.4 }}>{blocker}</div>)}
        </div>
      )}
      {(result.certification?.warnings?.length ?? 0) > 0 && (
        <div style={{ display: 'grid', gap: 5 }}>
          {result.certification!.warnings.map((warning) => <div key={`${warning.rule}-${warning.message}`} style={{ fontSize: 12, color: t.textMuted }}>{warning.rule}: {warning.message}</div>)}
        </div>
      )}
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

function parseSemanticBlockValues(source: string): { metric: string; dimensions: string[]; timeDimension: string; granularity: string } {
  const str = (key: string) => source.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  return {
    metric: str('metric') || parseDqlArrayField(source, 'metrics')[0] || '',
    dimensions: parseDqlArrayField(source, 'dimensions'),
    timeDimension: str('time_dimension'),
    granularity: str('granularity'),
  };
}

function parseDqlArrayField(source: string, key: string): string[] {
  const match = source.match(new RegExp(`\\b${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'i'));
  if (!match) return [];
  return (match[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)).filter(Boolean);
}

function setSemanticMetricField(source: string, metric: string): string {
  let next = source.replace(/\n\s*metrics\s*=\s*\[[\s\S]*?\]/i, '');
  return setSemanticScalarField(next, 'metric', metric);
}

function setSemanticScalarField(source: string, key: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const re = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
  if (re.test(source)) {
    return source.replace(re, `$1"${escaped}"`);
  }
  return insertSemanticField(source, `  ${key} = "${escaped}"`);
}

function setDqlArrayField(source: string, key: string, values: string[]): string {
  const unique = Array.from(new Set(values.filter(Boolean)));
  const rendered = `${key} = [${unique.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')}]`;
  const re = new RegExp(`\\b${key}\\s*=\\s*\\[[\\s\\S]*?\\]`, 'i');
  if (re.test(source)) {
    return source.replace(re, rendered);
  }
  return insertSemanticField(source, `  ${rendered}`);
}

function insertSemanticField(source: string, field: string): string {
  if (/visualization\s*\{/i.test(source)) {
    return source.replace(/\n\s*visualization\s*\{/i, `\n${field}\n\n  visualization {`);
  }
  return source.replace(/\n\}\s*$/, `\n${field}\n}\n`);
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
  if (
    layer.metrics.length === 0 &&
    layer.measures.length === 0 &&
    layer.dimensions.length === 0 &&
    layer.timeDimensions.length === 0 &&
    layer.entities.length === 0 &&
    layer.hierarchies.length === 0 &&
    layer.semanticModels.length === 0 &&
    layer.savedQueries.length === 0
  ) {
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

  for (const measure of layer.measures) {
    const domain = measure.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `measure:${measure.name}`,
      label: measure.label || measure.name,
      kind: 'measure',
      meta: { provider, domain, cube: measure.cube ?? measure.table, owner: measure.owner ?? '', tags: measure.tags.join(','), agg: measure.agg },
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

  for (const dimension of layer.timeDimensions) {
    const domain = dimension.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `time_dimension:${dimension.name}`,
      label: dimension.label || dimension.name,
      kind: 'time_dimension',
      meta: { provider, domain, cube: dimension.cube ?? dimension.table, owner: dimension.owner ?? '', tags: dimension.tags.join(',') },
    });
  }

  for (const entity of layer.entities) {
    const domain = entity.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `entity:${entity.name}`,
      label: entity.label || entity.name,
      kind: 'entity',
      meta: { provider, domain, cube: entity.cube ?? entity.table, owner: entity.owner ?? '', tags: entity.tags.join(','), type: entity.type },
    });
  }

  for (const model of layer.semanticModels) {
    const domain = model.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `semantic_model:${model.name}`,
      label: model.label || model.name,
      kind: 'semantic_model',
      meta: { provider, domain, table: model.table, owner: model.owner ?? '', tags: model.tags.join(',') },
    });
  }

  for (const savedQuery of layer.savedQueries) {
    const domain = savedQuery.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `saved_query:${savedQuery.name}`,
      label: savedQuery.label || savedQuery.name,
      kind: 'saved_query',
      meta: { provider, domain, owner: savedQuery.owner ?? '', tags: savedQuery.tags.join(',') },
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
      const measures = items.filter((item) => item.kind === 'measure');
      const dimensions = items.filter((item) => item.kind === 'dimension');
      const timeDimensions = items.filter((item) => item.kind === 'time_dimension');
      const entities = items.filter((item) => item.kind === 'entity');
      const hierarchies = items.filter((item) => item.kind === 'hierarchy');
      const semanticModels = items.filter((item) => item.kind === 'semantic_model');
      const savedQueries = items.filter((item) => item.kind === 'saved_query');
      const children: SemanticTreeNode[] = [];
      const pushGroup = (kind: SemanticTreeNode['kind'], label: string, groupItems: SemanticTreeNode[]) => {
        if (groupItems.length === 0) return;
        children.push({
          id: `group:${domain}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          label,
          kind: 'group',
          count: groupItems.length,
          meta: { provider, domain, objectKind: kind },
          children: groupItems.sort((a, b) => a.label.localeCompare(b.label)),
        });
      };
      if (metrics.length > 0) {
        pushGroup('metric', 'Metrics', metrics);
      }
      pushGroup('measure', 'Measures', measures);
      if (dimensions.length > 0) {
        pushGroup('dimension', 'Dimensions', dimensions);
      }
      pushGroup('time_dimension', 'Time Dimensions', timeDimensions);
      pushGroup('entity', 'Entities', entities);
      if (hierarchies.length > 0) {
        pushGroup('hierarchy', 'Hierarchies', hierarchies);
      }
      pushGroup('semantic_model', 'Semantic Models', semanticModels);
      pushGroup('saved_query', 'Saved Queries', savedQueries);
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
