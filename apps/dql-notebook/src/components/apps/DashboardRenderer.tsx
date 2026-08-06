import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Activity, AlertTriangle, BarChart3, Bot, ChartArea, ChartColumnBig, ChartColumnIncreasing, ChartColumnStacked, ChartScatter, CheckCircle2, Donut, Filter, Gauge, GitBranch, Grid3x3, GripVertical, Hash, LineChart, Loader2, Maximize2, PieChart, Plus, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Trash2, Wand2, Workflow, Wrench, X } from 'lucide-react';
import { api, type AppBlockRecommendation, type DashboardDocumentResponse, type DashboardRunResponse, type DashboardStoryBrief } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { CellChartConfig, QueryResult, ThemeMode } from '../../store/types';
import { ChartOutput, CHART_TYPE_OPTIONS, type ChartType } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { usePersistedAgentThreadId } from '../agent/usePersistedAgentThreadId';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH, AI_SIDE_PANEL_WIDTH } from '../agent/AiSidePanel';
import { renderMarkdown } from '../cells/MarkdownCellEditor';
import { inferColumnKind, columnKindToChartRole, type ChartColumnRole } from '../../utils/column-kind';
import { classifyColumns } from '../../utils/semantic-fields';
import { NODE_TYPE_COLORS, TYPE_LABELS, TYPE_TITLES } from '../lineage/lineage-constants';
import { themes, type ThemeMode as NotebookThemeMode } from '../../themes/notebook-theme';
import { mergeDashboardTileChartConfig, normalizeDashboardChartType, summarizeDashboardKpiResult } from './dashboard-chart-config';
import {
  chartToDashboardViz, coerceLayoutIntent, coerceReviewStatus, coerceTrustState, compactChartConfig,
  componentForDashboardViz, displayWithVisualization, getDashboardItemBlockId, getDqlGenUi, isRecord,
  normalizeViz, roleForDisplayComponent, textTileDisplay, uniqueStrings, type DqlGenUiMetadata,
} from './dashboard-tile-model';
import { autoLayoutDashboardItems, autoLayoutRank, layoutScore, packDashboardItems, reorderTileForDrop } from './dashboard-layout';
import {
  autoTileSizeForItem, autoTileSizeForViz, clamp, narrowTileMinHeight, normalizeSizePreset,
  presetMatches, tileSizeForPreset, tileSizePatch, TILE_SIZE_PRESETS, type TileSizePresetId,
} from './dashboard-tile-sizing';
import {
  buildDashboardStory, isStakeholderHiddenReviewTile, prepareStakeholderItems, storyFilterChips,
} from './dashboard-presentation';
import {
  escapeRegExp, evidenceMetricRank, formatDashboardValue, formatGenUiLabel, isNumericColumn,
  pickEvidenceLabelColumn, resultValueSamples, type DashboardStory,
} from './dashboard-format';

/** Single client chart vocabulary; see `normalizeDashboardChartType`. */
function normalizeChartType(value: unknown): ChartType {
  return normalizeDashboardChartType(value) as ChartType;
}
import { useOpenAnswerInNotebook } from '../../utils/answer-to-notebook';
import { formatDisplayValue } from '../../utils/value-format';
import type { InsertDqlPayload } from '../agent/UnifiedAgentRunPanel';

const UnifiedAgentRunPanel = lazy(() => import('../agent/UnifiedAgentRunPanel')
  .then((module) => ({ default: module.UnifiedAgentRunPanel })));

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type DashboardRunTile = DashboardRunResponse['tiles'][number];
const SIDE_PANEL_HEIGHT = 'clamp(320px, calc(100vh - 220px), 760px)';
const APP_CHART_TYPE_OPTIONS: Array<{ value: ChartType; label: string }> = [
  { value: 'table', label: 'Table' },
  ...CHART_TYPE_OPTIONS,
];

function sampleRows(rows?: Array<Record<string, unknown>>, columns?: string[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const selectedColumns = Array.isArray(columns) && columns.length > 0 ? columns.slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  return rows.slice(0, 5).map((row) => Object.fromEntries(selectedColumns.map((column) => [column, row[column]])));
}



/**
 * Grid renderer for `.dqld` dashboards backed by the live dashboard run API.
 */
export function DashboardRenderer({
  appId,
  dashboard,
  variables,
  editable = false,
  embeddedHeader = false,
  onDashboardChanged,
  selectedBlockId,
  onBlockFocus,
  onAskBlock,
  onOpenLineageNode,
  copilotOpen,
  onCopilotChange,
  onRunChange,
}: {
  appId: string;
  dashboard: DashboardDocumentResponse['dashboard'];
  variables?: Record<string, unknown>;
  editable?: boolean;
  embeddedHeader?: boolean;
  onDashboardChanged?: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  selectedBlockId?: string | null;
  onBlockFocus?: (blockId: string) => void;
  onAskBlock?: (blockId: string, question: string) => void;
  onOpenLineageNode?: (nodeId: string) => void;
  copilotOpen?: boolean;
  onCopilotChange?: (open: boolean) => void;
  onRunChange?: (run: DashboardRunResponse | null) => void;
}): JSX.Element {
  const { state } = useNotebook();
  const t = themes[state.themeMode as NotebookThemeMode];
  const [run, setRun] = useState<DashboardRunResponse | null>(null);
  const [businessStory, setBusinessStory] = useState<DashboardStoryBrief | null>(null);
  const latestRunIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Monotonic id so only the newest dashboard run may write state. */
  const runRequestRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // Server-persisted conversation thread, keyed per app dashboard so a page
  // refresh resumes the same Dashboard AI conversation.
  const agentThread = usePersistedAgentThreadId(`app:${appId}:${dashboard.id}`);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [lineageOpen, setLineageOpen] = useState(false);
  const [lineage, setLineage] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingLayoutItems, setPendingLayoutItems] = useState<DashboardLayoutItem[] | null>(null);
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  const [retryingTileId, setRetryingTileId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [textDialogKind, setTextDialogKind] = useState<'text' | 'heading' | null>(null);
  const [textDialogValue, setTextDialogValue] = useState('');
  const [dragPreview, setDragPreview] = useState<{ tileId: string; x: number; y: number; w: number; h: number } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [narrowGrid, setNarrowGrid] = useState(false);
  const cols = dashboard.layout.cols;
  const rowHeight = dashboard.layout.rowHeight;
  const openAnswerInNotebook = useOpenAnswerInNotebook();
  const variablesKey = useMemo(() => JSON.stringify(variables ?? {}), [variables]);
  const runVariables = useMemo<Record<string, unknown>>(() => JSON.parse(variablesKey), [variablesKey]);
  const tileResults = useMemo(() => {
    const map = new Map<string, DashboardRunResponse['tiles'][number]>();
    for (const tile of run?.tiles ?? []) map.set(tile.tileId, tile);
    return map;
  }, [run]);
  const workingLayoutItems = pendingLayoutItems ?? dashboard.layout.items;
  const workingDashboard = useMemo(() => ({
    ...dashboard,
    layout: { ...dashboard.layout, items: workingLayoutItems },
  }), [dashboard, workingLayoutItems]);
  const baseVisibleItems = useMemo(
    () => editable ? workingLayoutItems : dashboard.layout.items.filter((item) => !isStakeholderHiddenReviewTile(item)),
    [dashboard.layout.items, editable, workingLayoutItems],
  );
  const visibleItems = useMemo(
    () => editable ? baseVisibleItems : prepareStakeholderItems(baseVisibleItems, tileResults, cols),
    [baseVisibleItems, cols, editable, tileResults],
  );
  const hiddenReviewTileCount = dashboard.layout.items.length - baseVisibleItems.length;
  const hiddenPresentationTileCount = baseVisibleItems.length - visibleItems.length;
  // Server-narrated story sections (AI-built apps). In view mode they replace both
  // the client-computed story strip and the flat grid; edit mode keeps the classic
  // grid so drag/drop tooling is untouched. Old dashboards have no sections.
  const storySections = useMemo(
    () => (!editable && !dashboard.story && dashboard.sections && dashboard.sections.length > 0
      ? [...dashboard.sections].sort((a, b) => a.order - b.order)
      : null),
    [dashboard.sections, dashboard.story, editable],
  );
  // Story mode intentionally SHOWS review-required tiles: the appendix exists to
  // surface AI-generated analysis, clearly badged — so it bypasses the stakeholder
  // review-tile hiding that governs classic grids.
  const storyItems = useMemo(
    () => (storySections ? dashboard.layout.items : null),
    [dashboard.layout.items, storySections],
  );
  const dashboardStory = useMemo(
    () => (editable || storySections ? null : buildDashboardStory(visibleItems, tileResults, runVariables)),
    [editable, runVariables, storySections, tileResults, visibleItems],
  );

  useEffect(() => {
    setPendingLayoutItems(null);
    setLayoutNotice(null);
  }, [dashboard.id]);

  useEffect(() => {
    // Sequence the run rather than using a boolean `cancelled` flag.
    //
    // The old cleanup skipped `setLoading(false)` for a superseded run, so
    // leaving the App (or any dependency change) while a run was in flight left
    // `loading` stuck at true — and `TileBody` renders "Loading data..." for
    // every tile that has no cached result whenever `loading` is true. Coming
    // back to the App then showed tiles loading forever.
    //
    // Now only the newest request may write state, and it always clears the
    // loading flag; a superseded response is ignored without freezing the UI.
    const requestId = runRequestRef.current + 1;
    runRequestRef.current = requestId;
    const isCurrent = () => runRequestRef.current === requestId;
    setLoading(true);
    setError(null);
    void api.runDashboard(appId, dashboard.id, runVariables).then((result) => {
      if (!isCurrent()) return;
      setRun(result);
      setBusinessStory(result?.story ?? null);
      latestRunIdRef.current = result?.runId ?? null;
      onRunChange?.(result);
      if (!result) setError('Dashboard run failed.');
      if (result?.runId) {
        void api.getDashboardStory(appId, dashboard.id, result.runId).then((storyResult) => {
          if (!isCurrent() || !storyResult || latestRunIdRef.current !== storyResult.runId) return;
          if (storyResult.snapshotId !== result.snapshotId || storyResult.filterFingerprint !== result.filterFingerprint || storyResult.resultFingerprint !== result.resultFingerprint || storyResult.personaFingerprint !== result.personaFingerprint) return;
          setBusinessStory(storyResult.story);
        });
      }
    }).catch((err) => {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : String(err));
      onRunChange?.(null);
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
  }, [appId, dashboard.id, dashboard.layout.items.length, onRunChange, runVariables, state.activePersona?.userId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ appId?: string; dashboardId?: string }>).detail;
      if (detail?.appId !== appId || detail.dashboardId !== dashboard.id) return;
      void api.getDashboard(appId, dashboard.id).then((next) => {
        if (next?.dashboard) onDashboardChanged?.(next.dashboard);
      });
      void api.runDashboard(appId, dashboard.id, runVariables).then((nextRun) => {
        if (nextRun) {
          setRun(nextRun);
          setBusinessStory(nextRun.story);
          latestRunIdRef.current = nextRun.runId;
          onRunChange?.(nextRun);
        }
      });
    };
    window.addEventListener('dql-app-dashboard-updated', handler);
    return () => window.removeEventListener('dql-app-dashboard-updated', handler);
  }, [appId, dashboard.id, onDashboardChanged, onRunChange, runVariables]);

  useEffect(() => {
    const update = () => setNarrowGrid(window.innerWidth < 760);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const chatContext = useMemo(() => {
    const tiles = dashboard.layout.items.map((item) => {
      const tile = tileResults.get(item.i);
      const blockRef = item.block
        ? ('blockId' in item.block ? item.block.blockId : item.block.ref)
        : item.semantic ? `semantic:${item.semantic.id}`
          : item.draftAnalysis ? `draft:${item.draftAnalysis.ref}`
          : item.aiPin ? `aiPin:${item.aiPin.id}` : 'text';
      return {
        title: item.title,
        blockRef,
        viz: item.viz.type,
        certificationStatus: tile?.certificationStatus,
        status: tile?.status,
        rowCount: tile?.result?.rowCount,
        columns: tile?.result?.columns?.slice(0, 8),
        sampleRows: sampleRows(tile?.result?.rows, tile?.result?.columns),
      };
    });
    return JSON.stringify({
      scope: 'dashboard',
      appId,
      dashboardId: dashboard.id,
      title: dashboard.metadata.title,
      description: dashboard.metadata.description,
      domain: dashboard.metadata.domain,
      filters: dashboard.filters,
      variables: runVariables,
      run: run ? {
        runId: run.runId,
        snapshotId: run.snapshotId,
        filterFingerprint: run.filterFingerprint,
        resultFingerprint: run.resultFingerprint,
        personaFingerprint: run.personaFingerprint,
        story: run.story,
        facts: run.facts,
      } : null,
      tiles,
    }, null, 2);
  }, [appId, dashboard, run, runVariables, tileResults]);

  const saveItems = useCallback(async (
    items: DashboardDocumentResponse['dashboard']['layout']['items'],
    successMessage = 'Changes saved',
  ) => {
    setSaving(true);
    setError(null);
    const next = {
      ...dashboard,
      layout: {
        ...dashboard.layout,
        items,
      },
    };
    try {
      const result = await api.patchDashboardLayout(appId, dashboard.id, next.layout);
      if (result.ok) {
        setPendingLayoutItems(null);
        setLayoutNotice(successMessage);
        onDashboardChanged?.(result.dashboard);
      } else {
        setError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }, [appId, dashboard, onDashboardChanged]);

  /**
   * Geometry is staged while a layout preview is pending; content is not.
   *
   * This used to stage *everything* once "Auto layout" set a pending preview —
   * a tile rename, a viz change, even a delete would sit in React state and
   * never reach the server until Apply was clicked, with no indication the work
   * was unsaved. Only positions are provisional during a preview; a content
   * edit must save immediately and be carried into the pending preview so
   * applying the layout does not revert it.
   */
  const stageOrSaveItems = useCallback(async (items: DashboardLayoutItem[], kind: 'geometry' | 'content' = 'geometry') => {
    if (pendingLayoutItems && kind === 'geometry') {
      setPendingLayoutItems(items);
      setLayoutNotice('Layout preview ready');
      return;
    }
    if (pendingLayoutItems) setPendingLayoutItems(items);
    await saveItems(items);
  }, [pendingLayoutItems, saveItems]);

  const openCatalog = useCallback(async () => {
    setCatalogOpen(true);
    const result = await api.getAppEditorCatalog(appId);
    setCatalog(result?.blocks ?? []);
  }, [appId]);

  const addBlockTile = useCallback(async (block: AppBlockRecommendation) => {
    const vizType = normalizeViz(block.chartType);
    const recommendation = await api.recommendDashboardTile(appId, dashboard.id, {
      blockRef: block.name,
      appAudience: dashboard.metadata.audience,
      prompt: `${dashboard.metadata.title} ${block.name} ${block.description}`,
      defaultVisualization: vizType,
    });
    const size = autoTileSizeForViz(vizType, cols);
    const tile = {
      i: nextTileId(workingDashboard, block.name),
      ...nextTilePosition(workingDashboard, size),
      block: { blockId: block.name },
      viz: { type: vizType },
      ...(recommendation.ok ? {
        display: recommendation.display,
        filterBindings: 'filterBindings' in recommendation ? recommendation.filterBindings : undefined,
        parameterBindings: 'parameterBindings' in recommendation ? recommendation.parameterBindings : undefined,
        sourceEvidence: 'sourceEvidence' in recommendation ? recommendation.sourceEvidence : undefined,
        trustState: 'trustState' in recommendation ? recommendation.trustState : recommendation.display.trustState,
        reviewStatus: 'reviewStatus' in recommendation ? recommendation.reviewStatus : recommendation.display.reviewStatus,
      } : {}),
      title: block.name,
    };
    await stageOrSaveItems([...workingLayoutItems, tile], 'content');
    setCatalogOpen(false);
  }, [appId, cols, dashboard.id, dashboard.metadata.audience, dashboard.metadata.title, stageOrSaveItems, workingDashboard, workingLayoutItems]);

  const addTextTile = useCallback(async () => {
    setTextDialogKind('text');
    setTextDialogValue('');
  }, []);

  const addHeadingTile = useCallback(async () => {
    setTextDialogKind('heading');
    setTextDialogValue('');
  }, []);

  const saveTextTile = useCallback(async () => {
    const value = textDialogValue.trim();
    if (!value || !textDialogKind) return;
    if (textDialogKind === 'heading') {
      await stageOrSaveItems([
        ...workingLayoutItems,
        {
          i: nextTileId(workingDashboard, 'section'),
          ...nextTilePosition(workingDashboard, tileSizeForPreset('wide', cols, 'heading')),
          text: { markdown: value },
          viz: { type: 'heading' },
          display: textTileDisplay('heading', value),
          title: value,
        },
      ], 'content');
    } else {
      const title = value.split(/\r?\n/)[0]?.slice(0, 60) || 'Summary';
      await stageOrSaveItems([
        ...workingLayoutItems,
        {
          i: nextTileId(workingDashboard, 'text'),
          ...nextTilePosition(workingDashboard, tileSizeForPreset('standard', cols, 'text')),
          text: { markdown: value },
          viz: { type: 'text' },
          display: textTileDisplay('text', title),
          title,
        },
      ]);
    }
    setTextDialogKind(null);
    setTextDialogValue('');
  }, [cols, stageOrSaveItems, textDialogKind, textDialogValue, workingDashboard, workingLayoutItems]);

  const patchTile = useCallback(async (tileId: string, patch: Partial<DashboardLayoutItem> | null) => {
    const items = patch === null
      ? workingLayoutItems.filter((item) => item.i !== tileId)
      : workingLayoutItems.map((item) => item.i === tileId ? { ...item, ...patch } : item);
    // A removal, or any patch touching something other than position/size, is
    // content and must save even while a layout preview is pending.
    const geometryOnly = patch !== null
      && Object.keys(patch).every((key) => key === 'x' || key === 'y' || key === 'w' || key === 'h');
    await stageOrSaveItems(packDashboardItems(items, cols), geometryOnly ? 'geometry' : 'content');
  }, [cols, stageOrSaveItems, workingLayoutItems]);

  const moveTileToPoint = useCallback(async (tileId: string, point: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    const item = workingLayoutItems.find((candidate) => candidate.i === tileId);
    if (!grid || !item) return;
    const rect = grid.getBoundingClientRect();
    const gap = 12;
    const colWidth = (rect.width - gap * (cols - 1)) / cols;
    const stepX = colWidth + gap;
    const stepY = rowHeight + gap;
    const rawX = Math.round((point.clientX - rect.left) / stepX);
    const rawY = Math.round((point.clientY - rect.top) / stepY);
    const moved = {
      ...item,
      x: clamp(rawX, 0, Math.max(0, cols - item.w)),
      y: Math.max(0, rawY),
    };
    setDragPreview(null);
    const ordered = reorderTileForDrop(workingLayoutItems, moved, cols);
    await stageOrSaveItems(packDashboardItems(ordered, cols));
  }, [cols, rowHeight, stageOrSaveItems, workingLayoutItems]);

  const updateDragPreview = useCallback((tileId: string, point: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    const item = workingLayoutItems.find((candidate) => candidate.i === tileId);
    if (!grid || !item) return;
    const rect = grid.getBoundingClientRect();
    const gap = 12;
    const colWidth = (rect.width - gap * (cols - 1)) / cols;
    const rawX = Math.round((point.clientX - rect.left) / (colWidth + gap));
    const rawY = Math.round((point.clientY - rect.top) / (rowHeight + gap));
    setDragPreview({
      tileId,
      x: clamp(rawX, 0, Math.max(0, cols - item.w)),
      y: Math.max(0, rawY),
      w: item.w,
      h: item.h,
    });
  }, [cols, rowHeight, workingLayoutItems]);

  const clearDragPreview = useCallback(() => setDragPreview(null), []);

  const autoLayout = useCallback(() => {
    if (workingLayoutItems.length === 0) return;
    setPendingLayoutItems(autoLayoutDashboardItems(workingLayoutItems, cols));
    setLayoutNotice('Layout preview ready');
  }, [cols, workingLayoutItems]);

  const applyPendingLayout = useCallback(async () => {
    if (!pendingLayoutItems) return;
    await saveItems(pendingLayoutItems, 'Layout applied');
  }, [pendingLayoutItems, saveItems]);

  const cancelPendingLayout = useCallback(() => {
    setPendingLayoutItems(null);
    setLayoutNotice('Layout preview cancelled');
  }, []);

  const retryTile = useCallback(async (tileId: string) => {
    setRetryingTileId(tileId);
    const retried = await api.retryDashboardTile(appId, dashboard.id, tileId, runVariables);
    setRetryingTileId(null);
    const retriedTile = retried?.tiles.find((candidate) => candidate.tileId === tileId);
    if (!retried || !retriedTile) {
      setError('This App tile could not be retried.');
      return;
    }
    const merged = run
      ? { ...run, tiles: run.tiles.map((candidate) => candidate.tileId === tileId ? retriedTile : candidate) }
      : retried;
    setRun(merged);
    setBusinessStory(null);
    onRunChange?.(merged);
  }, [appId, dashboard.id, onRunChange, run, runVariables]);

  const openTileInNotebook = useCallback(async (item: DashboardLayoutItem, tile: DashboardRunTile) => {
    const artifact = tile.artifact;
    const payload: InsertDqlPayload = {
      title: item.title ?? artifact?.name ?? tile.title ?? 'App analysis',
      sql: artifact?.sql,
      result: tile.result,
      chartConfig: mergeDashboardTileChartConfig(item, tile.chartConfig as CellChartConfig | undefined),
      sourceRunId: run?.runId,
      question: `App tile: ${item.title ?? tile.title ?? item.i}`,
      executionTarget: artifact?.executionTarget,
      ...(artifact?.dql ? {
        dqlArtifact: {
          kind: artifact.sourceKind === 'certified_block' ? 'certified_block' : 'sql_block',
          source: artifact.dql,
          name: artifact.name,
          sourcePath: artifact.sourcePath,
          persistence: artifact.sourcePath ? 'saved' : 'transient',
          trustState: artifact.trustState,
          compiledSql: artifact.sql,
        },
      } : {}),
    };
    await openAnswerInNotebook(payload);
  }, [openAnswerInNotebook, run?.runId]);

  const loadLineage = useCallback(async () => {
    setLineageOpen((value) => !value);
    if (!lineage) {
      const result = await api.fetchScopedLineage({
        domain: dashboard.metadata.domain,
        appId,
        dashboardId: dashboard.id,
      });
      setLineage(result);
    }
  }, [appId, dashboard.id, dashboard.metadata.domain, lineage]);

  const openLineage = useCallback(() => {
    if (onOpenLineageNode) {
      onOpenLineageNode(`dashboard:${appId}/${dashboard.id}`);
      return;
    }
    void loadLineage();
  }, [appId, dashboard.id, loadLineage, onOpenLineageNode]);

  const effectiveCopilotOpen = onCopilotChange ? Boolean(copilotOpen) : chatOpen;
  const openCopilot = useCallback(() => {
    setAddMenuOpen(false);
    if (onCopilotChange) {
      onCopilotChange(true);
      return;
    }
    setChatOpen(true);
  }, [onCopilotChange]);
  const toggleCopilot = useCallback(() => {
    setAddMenuOpen(false);
    if (onCopilotChange) {
      onCopilotChange(!copilotOpen);
      return;
    }
    setChatOpen((value) => !value);
  }, [copilotOpen, onCopilotChange]);

  return (
    <div style={{ display: 'block', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      {/* Saving is automatic, so it has to be legible. This sits outside the
          editing toolbar: a write can land while the App is being viewed (an
          Ask result added from elsewhere), and a failed save used to be
          invisible because the error only rendered inside empty tiles. */}
      <SaveStatus saving={saving} error={error} pending={Boolean(pendingLayoutItems)} notice={layoutNotice} onDismissError={() => setError(null)} />
      {/* The stakeholder view deliberately hides review-required and duplicate
          tiles, which is right for published viewing — but it used to be
          announced only when EVERY tile was hidden. Adding an AI result to a
          page that already had tiles therefore looked like nothing had been
          saved. Say so whenever anything is hidden. */}
      {!editable && visibleItems.length > 0 && (hiddenReviewTileCount + hiddenPresentationTileCount) > 0 ? (
        <div role="status" style={saveStatusStyle('var(--text-tertiary)')}>
          <ShieldCheck size={13} />
          {hiddenReviewTileCount + hiddenPresentationTileCount} tile
          {hiddenReviewTileCount + hiddenPresentationTileCount === 1 ? ' is' : 's are'} hidden from this
          stakeholder view because {hiddenReviewTileCount > 0 ? 'they still need review' : 'a certified tile already answers the same question'}. Switch to Edit to see everything on this page.
        </div>
      ) : null}
      {(!embeddedHeader || editable) && (
      <div style={dashboardToolbarStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
        {embeddedHeader ? null : (
          <>
            <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.18, fontWeight: 780 }}>{dashboard.metadata.title}</h2>
            {dashboard.metadata.description ? (
              <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4, maxWidth: 680, lineHeight: 1.4 }}>
                {dashboard.metadata.description}
              </div>
            ) : null}
          </>
        )}
        </div>
        {editable && dashboard.layout.items.length > 0 && (
          <AddTileMenu
            open={addMenuOpen}
            onToggle={() => setAddMenuOpen((value) => !value)}
            buttonStyle={addTileIconButtonStyle}
            onCertifiedBlock={() => {
              setAddMenuOpen(false);
              void openCatalog();
            }}
            onText={() => {
              setAddMenuOpen(false);
              void addTextTile();
            }}
            onHeading={() => {
              setAddMenuOpen(false);
              void addHeadingTile();
            }}
            onAi={openCopilot}
          />
        )}
        {editable && dashboard.layout.items.length > 1 && !pendingLayoutItems && (
          <button
            type="button"
            onClick={autoLayout}
            disabled={saving}
            style={toolbarButtonStyle(false)}
            title="Auto-arrange every tile into a clean, gap-free grid"
          >
            <Wand2 size={15} strokeWidth={2} />
            Auto layout
          </button>
        )}
        {editable && pendingLayoutItems ? (
          <>
            <button
              type="button"
              onClick={() => void applyPendingLayout()}
              disabled={saving}
              style={toolbarButtonStyle(true)}
            >
              {saving ? 'Applying…' : 'Apply layout'}
            </button>
            <button type="button" onClick={cancelPendingLayout} disabled={saving} style={toolbarButtonStyle(false)}>
              Cancel
            </button>
          </>
        ) : null}
        {!embeddedHeader && (
          <>
            <button
              type="button"
              onClick={toggleCopilot}
              style={toolbarButtonStyle(effectiveCopilotOpen)}
            >
              <Bot size={14} strokeWidth={2} />
              {effectiveCopilotOpen ? 'Hide copilot' : 'AI Copilot'}
            </button>
            <button type="button" onClick={openLineage} style={toolbarButtonStyle(false)} title="Open focused dashboard lineage">
              <GitBranch size={14} strokeWidth={2} />
              Lineage
            </button>
          </>
        )}
      </div>
      )}
      {editable && <div style={dashboardEditHintStyle}>Drag tiles, select a block for Copilot context, or use the tile controls for sizing and chart settings.</div>}

      {!editable && businessStory ? (
        <BusinessStoryPanel story={businessStory} onResearch={openCopilot} onEvidence={openLineage} />
      ) : dashboardStory ? <DashboardStoryStrip story={dashboardStory} /> : null}

      {visibleItems.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--border-color, rgba(0,0,0,0.15))',
            borderRadius: 8,
            padding: 36,
            textAlign: 'center',
            fontSize: 13,
            minHeight: 260,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
            {hiddenReviewTileCount > 0 || hiddenPresentationTileCount > 0 ? 'No stakeholder-ready tiles yet' : 'Build this dashboard page'}
          </div>
          <div style={{ maxWidth: 520, opacity: 0.68, lineHeight: 1.45 }}>
            {hiddenReviewTileCount > 0
              ? 'Generated analysis and trust placeholders are hidden from the stakeholder view. Open Customize or Analysis to review them, then add certified blocks or pinned insights.'
              : hiddenPresentationTileCount > 0
                ? 'Static duplicate tiles are hidden from the stakeholder view because a filter-aware certified tile can answer the same question.'
              : 'Add certified domain blocks, narrative text, or use the scoped AI drawer and pin an answer into this layout.'}
          </div>
          <div style={{ marginTop: 18, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <AddTileMenu
              open={addMenuOpen}
              onToggle={() => setAddMenuOpen((value) => !value)}
              buttonLabel="Add tile"
              buttonStyle={primaryBuilderButtonStyle}
              onCertifiedBlock={() => {
                setAddMenuOpen(false);
                void openCatalog();
              }}
              onText={() => {
                setAddMenuOpen(false);
                void addTextTile();
              }}
              onHeading={() => {
                setAddMenuOpen(false);
                void addHeadingTile();
              }}
              onAi={openCopilot}
            />
          </div>
        </div>
      ) : storySections ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {storySections.map((section) => {
            const appendixSectionId = storySections.find((entry) => entry.kind === 'appendix')?.id;
            const insightFallbackId = storySections.find((entry) => entry.kind === 'insight')?.id ?? storySections[0].id;
            const resolveSection = (item: typeof dashboard.layout.items[number]) => {
              if (item.sectionId && storySections.some((entry) => entry.id === item.sectionId)) return item.sectionId;
              // An untagged review-required tile must never land in the exec/insight
              // sections — route it to the review appendix (or fall back to insight).
              if ((item.trustState === 'review_required' || item.reviewStatus === 'review_required') && appendixSectionId) {
                return appendixSectionId;
              }
              return insightFallbackId;
            };
            const sectionItems = (storyItems ?? visibleItems).filter((item) => resolveSection(item) === section.id);
            if (sectionItems.length === 0) return null;
            // Re-anchor this section's rows at 0 so each section is its own grid.
            const minY = Math.min(...sectionItems.map((item) => item.y));
            const isAppendix = section.kind === 'appendix';
            return (
              <section key={section.id} aria-label={section.title}>
                {section.kind !== 'exec_summary' ? (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--dql-app-text, #0f172a)' }}>{section.title}</h3>
                      {isAppendix ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid rgba(217,119,6,0.4)', color: '#b45309', background: 'rgba(217,119,6,0.08)', borderRadius: 999, padding: '1px 8px', fontSize: 10, fontWeight: 800 }}>
                          needs review
                        </span>
                      ) : null}
                    </div>
                    {section.narrative ? (
                      <p style={{ margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--dql-app-text-muted, #64748b)', maxWidth: 860 }}>{section.narrative}</p>
                    ) : null}
                  </div>
                ) : null}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: narrowGrid ? 'minmax(0, 1fr)' : `repeat(${cols}, 1fr)`,
                    gridAutoRows: narrowGrid ? 'auto' : `${rowHeight}px`,
                    gap: 12,
                    ...(isAppendix ? { opacity: 0.96 } : {}),
                  }}
                >
                  {sectionItems.map((item) => (
                    <DashboardTile
                      key={item.i}
                      item={{ ...item, y: item.y - minY }}
                      tile={tileResults.get(item.i)}
                      loading={loading}
                      error={error}
                      themeMode={state.themeMode}
                      editable={false}
                      narrow={narrowGrid}
                      cols={cols}
                      selected={Boolean(getDashboardItemBlockId(item) && getDashboardItemBlockId(item) === selectedBlockId)}
                      onFocusBlock={onBlockFocus}
                      onAskBlock={onAskBlock}
                      onMove={() => undefined}
                      onDragMove={() => undefined}
                      onDragEnd={() => undefined}
                      onPatch={(patch) => void patchTile(item.i, patch)}
                      onRetry={() => void retryTile(item.i)}
                      retrying={retryingTileId === item.i}
                      retryDisabled={Boolean(retryingTileId && retryingTileId !== item.i)}
                      onOpenNotebook={(nextTile) => void openTileInNotebook(item, nextTile)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div
          ref={gridRef}
          style={{
            display: 'grid',
            gridTemplateColumns: narrowGrid ? 'minmax(0, 1fr)' : `repeat(${cols}, 1fr)`,
            gridAutoRows: narrowGrid ? 'auto' : `${rowHeight}px`,
            gap: 12,
          }}
        >
          {dragPreview && !narrowGrid && (
            <div
              aria-hidden="true"
              style={{
                gridColumn: `${dragPreview.x + 1} / span ${dragPreview.w}`,
                gridRow: `${dragPreview.y + 1} / span ${dragPreview.h}`,
                border: '2px dashed var(--dql-app-accent, var(--accent, #4f46e5))',
                background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.10))',
                borderRadius: 10,
                pointerEvents: 'none',
                zIndex: 10,
              }}
            />
          )}
          {visibleItems.map((item) => (
            <DashboardTile
              key={item.i}
              item={item}
              tile={tileResults.get(item.i)}
              loading={loading}
              error={error}
              themeMode={state.themeMode}
              editable={editable}
              narrow={narrowGrid}
              cols={cols}
              selected={Boolean(getDashboardItemBlockId(item) && getDashboardItemBlockId(item) === selectedBlockId)}
              onFocusBlock={onBlockFocus}
              onAskBlock={onAskBlock}
              onMove={(point) => void moveTileToPoint(item.i, point)}
              onDragMove={(point) => updateDragPreview(item.i, point)}
              onDragEnd={clearDragPreview}
              onPatch={(patch) => void patchTile(item.i, patch)}
              onRetry={() => void retryTile(item.i)}
              retrying={retryingTileId === item.i}
              retryDisabled={Boolean(retryingTileId && retryingTileId !== item.i)}
              onOpenNotebook={(nextTile) => void openTileInNotebook(item, nextTile)}
            />
          ))}
        </div>
      )}
      {!editable && run ? <ReviewAppendix run={run} variables={runVariables} /> : null}
      </div>

      {lineageOpen && !onOpenLineageNode && (
        <aside style={{ width: 340, minWidth: 300, maxWidth: '34vw', border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 8, overflow: 'auto', alignSelf: 'flex-start', height: SIDE_PANEL_HEIGHT, position: 'sticky', top: 12, padding: 12 }}>
          <ScopedLineagePanel lineage={lineage} />
        </aside>
      )}

      {chatOpen && !onCopilotChange && (
        <AiSidePanel
          t={t}
          title="Dashboard AI"
          subtitle="Scoped to this App dashboard first"
          expanded={chatExpanded}
          onToggleExpanded={() => setChatExpanded((value) => !value)}
          onClose={() => { setChatOpen(false); setChatExpanded(false); }}
          floating
          ariaLabel="Dashboard AI"
          style={dashboardChatDrawerStyle(chatExpanded)}
        >
          <Suspense fallback={<div style={{ padding: 16, fontSize: 12, color: t.textSecondary }}>Loading Dashboard AI…</div>}>
            <UnifiedAgentRunPanel
              key={`${appId}:${dashboard.id}`}
              themeMode={state.themeMode}
              title="Dashboard AI"
              scopeHint="Scoped to this App dashboard first"
              audience="stakeholder"
              workspaceContext={{ appId, dashboardId: dashboard.id, dashboardContext: chatContext }}
              initialMode="auto"
              threadId={agentThread.threadId}
              onThreadIdChange={agentThread.onThreadIdChange}
            />
          </Suspense>
        </AiSidePanel>
      )}

      {catalogOpen && (
        <BlockCatalogDialog
          blocks={catalog}
          search={catalogSearch}
          onSearch={setCatalogSearch}
          onClose={() => setCatalogOpen(false)}
          onAdd={(block) => void addBlockTile(block)}
        />
      )}
      {textDialogKind && (
        <TextTileDialog
          kind={textDialogKind}
          value={textDialogValue}
          onChange={setTextDialogValue}
          onClose={() => {
            setTextDialogKind(null);
            setTextDialogValue('');
          }}
          onSave={() => void saveTextTile()}
        />
      )}
    </div>
  );
}

function DashboardTile({
  item,
  tile,
  loading,
  error,
  themeMode,
  editable,
  narrow,
  cols,
  selected,
  onFocusBlock,
  onAskBlock,
  onMove,
  onDragMove,
  onDragEnd,
  onPatch,
  onRetry,
  retrying = false,
  retryDisabled = false,
  onOpenNotebook,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
  editable: boolean;
  narrow: boolean;
  cols: number;
  selected?: boolean;
  onFocusBlock?: (blockId: string) => void;
  onAskBlock?: (blockId: string, question: string) => void;
  onMove: (point: { clientX: number; clientY: number }) => void;
  onDragMove?: (point: { clientX: number; clientY: number }) => void;
  onDragEnd?: () => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  onOpenNotebook?: (tile: DashboardRunTile) => void;
}): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'how' | 'dql' | 'sql'>('how');
  const blockId = getDashboardItemBlockId(item);
  const canAsk = Boolean(!editable && blockId && onAskBlock);
  const blockRef = blockId
    ? `block:${blockId}`
    : item.semantic
      ? `semantic:${item.semantic.id}`
    : item.draftAnalysis
      ? `draft:${item.draftAnalysis.ref}`
    : item.aiPin
      ? `aiPin:${item.aiPin.id}`
      : 'text';
  const [viewerViz, setViewerViz] = useState<ChartType>(() => normalizeChartType(item.viz.type));
  useEffect(() => setViewerViz(normalizeChartType(item.viz.type)), [item.i, item.viz.type]);
  const activeChart = editable ? normalizeChartType(item.viz.type) : viewerViz;
  const renderedItem = useMemo<DashboardLayoutItem>(() => editable || activeChart === normalizeChartType(item.viz.type)
    ? item
    : {
        ...item,
        viz: {
          ...item.viz,
          type: chartToDashboardViz(activeChart),
          options: { ...(item.viz.options ?? {}), chart: activeChart },
        },
      }, [activeChart, editable, item]);
  const vizType = normalizeViz(String(renderedItem.viz.type ?? 'table'));
  const genUi = getDqlGenUi(item);
  const generatedComponent = genUi?.component;
  const generatedTitle = item.title || genUi?.insightTitle || blockRef;
  const aiPinTrust = tile?.tileType === 'aiPin'
    ? tile.aiPin?.certification === 'certified' ? 'certified' : 'review_required'
    : undefined;
  const repair = tile?.repair;
  const generatedTrust = repair
    ? 'review_required'
    : tile?.artifact?.trustState ?? genUi?.trustState ?? aiPinTrust ?? (tile?.certificationStatus === 'certified' ? 'certified' : undefined);
  const isGeneratedUi = Boolean(genUi);
  const isCompactMetric = item.h <= 2 && (vizType === 'single_value' || vizType === 'kpi' || vizType === 'gauge');
  const [hovered, setHovered] = useState(false);
  const showEditChrome = editable && (hovered || selected || settingsOpen);

  /**
   * Rename the tile from its own header.
   *
   * The only rename used to live inside the "Chart and field settings" panel,
   * behind a hover-revealed slider icon — three hidden steps, under a label
   * about charts. Renaming is the most common edit, so it belongs on the title
   * itself. `insightTitle` is a shadow copy frozen at build time; leaving it
   * stale lets a renamed tile still render its original name elsewhere.
   */
  const renameTile = (next: string) => {
    const title = next.trim();
    if (!title || title === item.title) return;
    const currentGenUi = getDqlGenUi(item);
    onPatch({
      title,
      ...(currentGenUi
        ? { viz: { ...item.viz, options: { ...(item.viz.options ?? {}), dqlGenUi: { ...currentGenUi, insightTitle: title } } } }
        : {}),
    });
  };
  const generatedVizOptions = getGeneratedVizOptions(item, genUi);
  const showVizSwitcher = Boolean(tile?.result && generatedVizOptions.length > 1);
  const canInspect = Boolean(tile && tile.tileType !== 'text' && (tile.artifact || tile.result || tile.citation || tile.repair));
  const showAskHint = Boolean(canAsk && (hovered || selected));
  const switchGeneratedViz = (chart: ChartType) => {
    if (!editable) {
      setViewerViz(chart);
      return;
    }
    const dashboardViz = chartToDashboardViz(chart);
    const options = item.viz.options ?? {};
    const currentGenUi = getDqlGenUi(item);
    onPatch({
      viz: {
        ...item.viz,
        type: dashboardViz,
        options: {
          ...options,
          chart,
          ...(currentGenUi ? { dqlGenUi: { ...currentGenUi, defaultVisualization: dashboardViz } } : {}),
        },
      },
      display: displayWithVisualization(item, dashboardViz, currentGenUi),
    });
  };
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (narrow) return;
    const tileEl = tileRef.current;
    if (!tileEl) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = tileEl.getBoundingClientRect();
    const grabOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const start = {
      x: event.clientX,
      y: event.clientY,
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      setDragOffset({
        x: moveEvent.clientX - start.x,
        y: moveEvent.clientY - start.y,
      });
      onDragMove?.({
        clientX: moveEvent.clientX - grabOffset.x,
        clientY: moveEvent.clientY - grabOffset.y,
      });
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setDragOffset(null);
      onDragEnd?.();
      onMove({
        clientX: upEvent.clientX - grabOffset.x,
        clientY: upEvent.clientY - grabOffset.y,
      });
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  };
  return (
    <div
      ref={tileRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (blockId) onFocusBlock?.(blockId);
      }}
      style={{
        gridColumn: narrow ? '1 / -1' : `${item.x + 1} / span ${item.w}`,
        gridRow: narrow ? 'auto' : `${item.y + 1} / span ${item.h}`,
        transform: dragOffset ? `translate(${dragOffset.x}px, ${dragOffset.y}px) scale(1.02)` : undefined,
        opacity: dragOffset ? 0.92 : 1,
        zIndex: dragOffset ? 30 : undefined,
        position: 'relative',
        background: isGeneratedUi
          ? tileSurfaceForGenUi(generatedComponent)
          : 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
        border: selected || dragOffset
          ? '1.5px solid var(--dql-app-accent, var(--accent, #4f46e5))'
          : isGeneratedUi
            ? '1px solid var(--dql-app-line-2, var(--border-color, rgba(15,23,42,0.10)))'
            : '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.08)))',
        borderRadius: 8,
        padding: isCompactMetric ? 12 : 14,
        paddingBottom: showAskHint ? (isCompactMetric ? 42 : 46) : (isCompactMetric ? 12 : 14),
        display: 'flex',
        flexDirection: 'column',
        gap: isCompactMetric ? 4 : isGeneratedUi ? 10 : 6,
        minHeight: narrow ? narrowTileMinHeight(item, genUi) : 0,
        overflow: 'visible',
        boxShadow: dragOffset
          ? '0 16px 40px rgba(0,0,0,0.22)'
          : selected ? '0 0 0 3px var(--dql-app-accent-soft, rgba(79,70,229,0.12))' : undefined,
        cursor: dragOffset ? 'grabbing' : blockId ? 'pointer' : undefined,
        transition: dragOffset ? undefined : 'box-shadow 120ms ease, transform 120ms ease',
      }}
    >
      {showAskHint ? (
        <button
          type="button"
          style={askHintStyle}
          onClick={(event) => {
            event.stopPropagation();
            if (blockId) onFocusBlock?.(blockId);
            if (blockId) onAskBlock?.(blockId, defaultTileCopilotQuestion(item.title ?? blockId));
          }}
          title="Open app Copilot for this tile"
        >
          <Sparkles size={11} strokeWidth={2} /> Ask AI
        </button>
      ) : null}
      {editable && !narrow ? (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            zIndex: 3,
            opacity: showEditChrome ? 1 : 0,
            pointerEvents: showEditChrome ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
            <button
              type="button"
              title="Drag to move tile"
              onPointerDown={startDrag}
              style={dragHandleButtonStyle}
            >
              <GripVertical size={14} strokeWidth={2.2} />
            </button>
        </div>
      ) : null}
      {editable ? (
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              zIndex: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              opacity: showEditChrome ? 1 : 0,
              pointerEvents: showEditChrome ? 'auto' : 'none',
              transition: 'opacity 120ms ease',
            }}
          >
            {!isCompactMetric ? (
              <span
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--surface-hover, rgba(0,0,0,0.06))',
                  opacity: 0.85,
                }}
              >
                {item.viz.type}
              </span>
            ) : null}
            <TileEditorControls
              item={item}
              cols={cols}
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((value) => !value)}
              onPatch={onPatch}
            />
          </div>
        ) : null}
      {isGeneratedUi ? (
        <div
          style={{
            minHeight: isCompactMetric ? 26 : 42,
            paddingLeft: showEditChrome ? 30 : 0,
            paddingRight: showEditChrome ? (isCompactMetric ? 82 : 134) : 0,
            transition: 'padding 120ms ease',
            display: 'grid',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editable ? (
                <div style={{ fontSize: isCompactMetric ? 12 : 13, fontWeight: 780, lineHeight: 1.25, minWidth: 0 }}>
                  <TileTitleInput value={generatedTitle ?? ''} compact={isCompactMetric} onCommit={(next) => renameTile(next)} />
                </div>
              ) : (
                <div
                  title={generatedTitle}
                  style={{
                    fontSize: isCompactMetric ? 12 : 13,
                    fontWeight: 780,
                    lineHeight: 1.25,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}
                >
                  {generatedTitle}
                </div>
              )}
              <div style={generatedMetaRowStyle}>
                {generatedTrust ? <TrustPill trust={generatedTrust} /> : null}
                {repair ? (
                  <span style={generatedMetaPillStyle} title={repair.message}>
                    <Wrench size={9} /> {repair.status === 'repaired' ? `${repair.mode === 'ai' ? 'AI ' : ''}repaired · review` : 'repair blocked'}
                  </span>
                ) : null}
                {genUi ? <span style={generatedMetaPillStyle}>{componentLabelForGenUi(genUi)}</span> : null}
                {genUi?.layoutIntent ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(String(genUi.layoutIntent))}</span> : null}
              </div>
            </div>
            {showVizSwitcher ? (
              <GeneratedVizSwitcher
                value={activeChart}
                options={generatedVizOptions}
                onChange={switchGeneratedViz}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div
          style={{
            minHeight: isCompactMetric ? 22 : 26,
            paddingLeft: showEditChrome ? 30 : 0,
            paddingRight: showEditChrome ? (isCompactMetric ? 82 : 134) : 0,
            transition: 'padding 120ms ease',
          }}
        >
          <div style={{ fontSize: isCompactMetric ? 12 : 13, fontWeight: 720, lineHeight: 1.25, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {editable ? (
              <TileTitleInput
                value={item.title ?? blockRef ?? ''}
                compact={isCompactMetric}
                onCommit={(next) => renameTile(next)}
              />
            ) : <span>{item.title ?? blockRef}</span>}
            {showVizSwitcher ? (
              <span style={{ float: 'right', marginLeft: 8 }}>
                <GeneratedVizSwitcher value={activeChart} options={generatedVizOptions} onChange={switchGeneratedViz} />
              </span>
            ) : null}
          </div>
          {aiPinTrust || repair ? (
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {aiPinTrust ? <TrustPill trust={aiPinTrust} /> : null}
              {aiPinTrust ? <span style={generatedMetaPillStyle}>AI generated</span> : null}
              {repair ? (
                <span style={generatedMetaPillStyle} title={repair.message}>
                  <Wrench size={9} /> {repair.status === 'repaired' ? `${repair.mode === 'ai' ? 'AI ' : ''}repaired · review` : 'repair blocked'}
                </span>
              ) : null}
            </div>
          ) : !isCompactMetric ? (
            <div style={{ marginTop: 5, fontSize: 10.5, opacity: 0.58, fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blockRef}</div>
          ) : null}
        </div>
      )}
      {editable && settingsOpen ? (
        <TileSettingsPanel
          item={item}
          tile={tile}
          cols={cols}
          onPatch={onPatch}
        />
      ) : null}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: isCompactMetric ? 0 : 2,
          fontSize: 12,
          opacity: tile?.status === 'ok' ? 1 : 0.7,
          fontStyle: tile?.status === 'ok' ? 'normal' : 'italic',
        }}
      >
        <TileBody
          item={renderedItem}
          tile={tile}
          loading={loading}
          error={error}
          themeMode={themeMode}
          genUi={genUi}
          editable={editable}
          onEditText={(markdown) => onPatch({ text: { ...(item.text ?? {}), markdown } })}
          onRetry={onRetry}
          retrying={retrying}
          retryDisabled={retryDisabled}
        />
      </div>
      {!editable ? <TileInsightCaption tile={tile} themeMode={themeMode} /> : null}
      {!editable && canInspect ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, paddingTop: 2 }}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setInspectorOpen((value) => !value);
            }}
            style={tileEvidenceButtonStyle}
          >
            {inspectorOpen ? 'Hide details' : 'How it works'}
          </button>
        </div>
      ) : null}
      {!editable && inspectorOpen && tile ? (
        <TileEvidencePanel
          item={item}
          tile={tile}
          tab={inspectorTab}
          onTab={setInspectorTab}
          onOpenNotebook={onOpenNotebook}
          onClose={() => setInspectorOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Data-driven one-line insight under a tile (leader + share), computed from results. */
function TileInsightCaption({ tile, themeMode }: { tile?: DashboardRunResponse['tiles'][number]; themeMode: ThemeMode }): JSX.Element | null {
  const t = themes[themeMode];
  const caption = useMemo(() => computeTileInsight(tile), [tile]);
  if (!caption) return null;
  return (
    <div style={{ padding: '4px 10px 8px', fontSize: 11.5, color: t.textMuted, lineHeight: 1.4, display: 'flex', gap: 5, alignItems: 'baseline' }}>
      <span style={{ color: t.accent }}>•</span>
      <span>{caption}</span>
    </div>
  );
}

export function computeTileInsight(tile?: DashboardRunResponse['tiles'][number]): string | null {
  const rows = tile?.result?.rows;
  const columns = tile?.result?.columns;
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columns) || columns.length === 0) return null;
  const sample = rows[0] as Record<string, unknown>;
  const toNum = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n = Number(v.replace(/[$,%\s]/g, '')); return Number.isFinite(n) && v.trim() ? n : undefined; }
    return undefined;
  };
  const valueCol = columns.find((c) => toNum(sample?.[c]) !== undefined);
  const labelCol = columns.find((c) => c !== valueCol && typeof sample?.[c] === 'string');
  if (!valueCol) return null;
  const valueSamples = rows.map((row) => row[valueCol]);
  const labelSamples = labelCol ? rows.map((row) => row[labelCol]) : [];
  const metricLabel = formatGenUiLabel(valueCol);
  if (rows.length === 1) {
    const v = toNum((rows[0] as Record<string, unknown>)[valueCol]);
    return v !== undefined ? `${metricLabel}: ${formatDashboardValue(valueCol, v, valueSamples, { compact: true })}.` : null;
  }
  const ranked = (rows as Array<Record<string, unknown>>)
    .map((r) => ({
      label: labelCol ? formatDashboardValue(labelCol, r[labelCol], labelSamples) : 'top',
      value: toNum(r[valueCol]) ?? 0,
    }))
    .sort((a, b) => b.value - a.value);
  const total = ranked.reduce((s, e) => s + e.value, 0);
  const top = ranked[0];
  if (!top) return null;
  const formattedTopValue = formatDashboardValue(valueCol, top.value, valueSamples, { compact: true });
  return total > 0
    ? `${top.label} leads ${metricLabel} at ${formattedTopValue} (${Math.round((top.value / total) * 100)}%).`
    : `${top.label} leads ${metricLabel} at ${formattedTopValue}.`;
}

/**
 * A narrative tile's words, edited in place.
 *
 * Click to edit, blur or Escape to go back to rendered markdown, so the tile
 * still reads as prose rather than as a form. Escape reverts; blur saves.
 */
function TileTextEditor({ markdown, variant, themeMode, onCommit }: { markdown: string; variant: 'text' | 'heading'; themeMode: ThemeMode; onCommit: (next: string) => void }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
  useEffect(() => { setDraft(markdown); }, [markdown]);
  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        title="Click to edit this text"
        onClick={() => setEditing(true)}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditing(true); } }}
        style={{ cursor: 'text', minHeight: 24, borderRadius: 6, outline: 'none' }}
      >
        {markdown.trim()
          ? <MarkdownTile markdown={markdown} variant={variant} themeMode={themeMode} />
          : <span style={{ opacity: 0.55, fontSize: 12 }}>Click to write this section…</span>}
      </div>
    );
  }
  return (
    <textarea
      autoFocus
      aria-label={variant === 'heading' ? 'Heading text' : 'Tile text'}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => { setEditing(false); if (draft !== markdown) onCommit(draft); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { setDraft(markdown); setEditing(false); }
      }}
      style={{
        width: '100%', minHeight: 72, resize: 'vertical', boxSizing: 'border-box',
        font: variant === 'heading' ? '700 17px/1.3 inherit' : 'inherit',
        color: 'inherit', background: 'var(--bg-1, #fff)',
        border: '1px solid var(--accent, #4f46e5)', borderRadius: 7, padding: '7px 9px', outline: 'none',
      }}
    />
  );
}

/**
 * The tile's name, edited where it is read.
 *
 * Styled to sit flush with the heading it replaces so the header does not jump
 * between view and edit, but it carries a real label and shows an affordance on
 * hover — the previous field had neither, and sat under a "Chart and field
 * settings" heading that gave no reason to look there for a name.
 */
function TileTitleInput({ value, compact, onCommit }: { value: string; compact: boolean; onCommit: (next: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      aria-label="Tile name"
      title="Tile name — press Enter to save"
      value={draft}
      maxLength={140}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const next = draft.trim();
        if (next && next !== value) onCommit(next);
        else setDraft(value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation(); // never let typing reach the tile's drag handlers
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        font: 'inherit',
        color: 'inherit',
        background: focused ? 'var(--bg-1, #fff)' : 'transparent',
        border: `1px solid ${focused ? 'var(--accent, #4f46e5)' : 'transparent'}`,
        borderRadius: 6,
        padding: compact ? '0 4px' : '1px 5px',
        margin: compact ? '0 0 0 -4px' : '0 0 0 -5px',
        maxWidth: '100%',
        width: `${Math.max(6, Math.min(48, draft.length + 1))}ch`,
        outline: 'none',
        cursor: focused ? 'text' : 'pointer',
      }}
      onMouseEnter={(event) => { if (!focused) event.currentTarget.style.borderColor = 'var(--border-subtle, #d8d8d8)'; }}
      onMouseLeave={(event) => { if (!focused) event.currentTarget.style.borderColor = 'transparent'; }}
    />
  );
}

function GeneratedVizSwitcher({
  value,
  options,
  onChange,
}: {
  value: ChartType;
  options: Array<{ value: ChartType; label: string }>;
  onChange: (value: ChartType) => void;
}) {
  // A server-side allow-list can reach nine visualizations, and rendering one
  // button each turned every tile header into a wall of near-identical glyphs.
  // Show a few — always including the current one — and put the rest behind a
  // labelled select.
  const INLINE_LIMIT = 4;
  const inline = options.slice(0, INLINE_LIMIT);
  if (!inline.some((option) => option.value === value)) {
    const current = options.find((option) => option.value === value);
    if (current) inline.splice(INLINE_LIMIT - 1, 1, current);
  }
  const overflow = options.filter((option) => !inline.some((item) => item.value === option.value));

  return (
    <div style={generatedVizSwitcherStyle} aria-label="Visualization">
      {inline.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.label}
          aria-label={option.label}
          aria-pressed={value === option.value}
          onClick={(event) => {
            event.stopPropagation();
            onChange(option.value);
          }}
          style={generatedVizButtonStyle(value === option.value)}
        >
          {iconForChartType(option.value)}
        </button>
      ))}
      {overflow.length > 0 ? (
        <select
          aria-label="More visualizations"
          title="More visualizations"
          value=""
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value as ChartType);
          }}
          style={generatedVizOverflowStyle}
        >
          <option value="">More…</option>
          {overflow.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

const generatedVizOverflowStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 10.5,
  cursor: 'pointer',
  maxWidth: 74,
};

function TrustPill({ trust }: { trust: string }) {
  const certified = trust === 'certified';
  const label = certified ? 'Certified' : trust === 'review_required' ? 'Review required' : 'Draft ready';
  return (
    <span style={trustPillStyle(certified)}>
      {certified ? <ShieldCheck size={10} strokeWidth={2.4} /> : <AlertTriangle size={10} strokeWidth={2.4} />}
      {label}
    </span>
  );
}

function DashboardStoryStrip({ story }: { story: DashboardStory }): JSX.Element {
  return (
    <section style={dashboardStoryStripStyle} aria-label="Current dashboard story">
      <div style={dashboardStoryHeaderStyle}>
        <div style={dashboardStoryIconStyle}>
          <Sparkles size={15} strokeWidth={2.2} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={dashboardStoryKickerStyle}>Story from current results</div>
          <h3 style={dashboardStoryTitleStyle}>{story.title}</h3>
        </div>
        {story.trust ? <TrustPill trust={story.trust} /> : null}
      </div>
      <p style={dashboardStorySummaryStyle}>{story.summary}</p>
      <div style={dashboardStoryChipRowStyle}>
        <span style={dashboardStorySourceChipStyle}>{story.sourceTitle}</span>
        {story.filters.map((filter) => (
          <span key={`${filter.label}:${filter.value}`} style={dashboardStoryChipStyle}>
            {filter.label}: {filter.value}
          </span>
        ))}
        {story.chips.map((chip) => (
          <span key={chip} style={dashboardStoryChipStyle}>{chip}</span>
        ))}
      </div>
    </section>
  );
}

function BusinessStoryPanel({
  story,
  onEvidence,
  onResearch,
}: {
  story: DashboardStoryBrief;
  onEvidence: () => void;
  onResearch: () => void;
}): JSX.Element {
  return (
    <section style={{ ...dashboardStoryStripStyle, padding: '20px 22px', marginBottom: 16 }} aria-label="Business Story">
      <div style={dashboardStoryHeaderStyle}>
        <div style={dashboardStoryIconStyle}><Sparkles size={15} strokeWidth={2.2} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={dashboardStoryKickerStyle}>Business Story · current filters</div>
          <h2 style={{ ...dashboardStoryTitleStyle, fontSize: 19 }}>{story.headline}</h2>
        </div>
        <TrustPill trust={story.trustState} />
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 12, maxWidth: 920 }}>
        {story.paragraphs.slice(0, 2).map((paragraph, index) => (
          <p key={index} style={{ ...dashboardStorySummaryStyle, margin: 0, fontSize: 14, lineHeight: 1.65 }}>
            {storyInlineText(paragraph)}
          </p>
        ))}
        {story.implication ? (
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, fontWeight: 650 }}>What this means: {storyInlineText(story.implication)}</p>
        ) : null}
      </div>
      <div style={{ ...dashboardStoryChipRowStyle, marginTop: 14 }}>
        <span style={dashboardStorySourceChipStyle}>{story.generatedBy === 'ai' ? 'AI wording · verified facts' : 'Verified result summary'}</span>
        <span style={dashboardStoryChipStyle}>{story.evidenceRefs.length} evidence source{story.evidenceRefs.length === 1 ? '' : 's'}</span>
        {story.caveat ? <span style={dashboardStoryChipStyle}>{story.caveat}</span> : null}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onEvidence} style={storyActionButtonStyle}>View evidence</button>
        <button type="button" onClick={onResearch} style={storyActionButtonStyle}>Research deeper</button>
      </div>
    </section>
  );
}

function ReviewAppendix({
  run,
  variables,
}: {
  run: DashboardRunResponse;
  variables: Record<string, unknown>;
}): JSX.Element {
  const issues = run.tiles.filter((tile) => tile.status !== 'ok');
  const activeFilters = Object.entries(variables).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return (
    <details style={reviewAppendixStyle} aria-label="Evidence and review appendix">
      <summary style={reviewAppendixSummaryStyle}>
        Evidence & review appendix
        <span style={{ opacity: 0.62, fontWeight: 600 }}>
          {run.story.evidenceRefs.length} sources · {issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : 'all visible sources ran'}
        </span>
      </summary>
      <div style={{ display: 'grid', gap: 12, padding: '0 16px 16px' }}>
        <div style={reviewAppendixGridStyle}>
          <div><strong>Run</strong><br /><span>{run.runId}</span></div>
          <div><strong>Snapshot</strong><br /><span>{run.snapshotId}</span></div>
          <div><strong>Trust</strong><br /><span>{run.story.trustState}</span></div>
          <div><strong>Filters</strong><br /><span>{activeFilters.length ? activeFilters.map(([key, value]) => `${key}: ${String(value)}`).join(' · ') : 'Current unfiltered scope'}</span></div>
        </div>
        <div>
          <strong style={{ fontSize: 12 }}>Evidence used by the story</strong>
          <div style={{ ...dashboardStoryChipRowStyle, marginTop: 7 }}>
            {run.story.evidenceRefs.map((ref) => <span key={ref} style={dashboardStoryChipStyle}>{ref}</span>)}
          </div>
        </div>
        {issues.length ? (
          <div>
            <strong style={{ fontSize: 12 }}>Items requiring review</strong>
            <ul style={{ margin: '7px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.55 }}>
              {issues.map((tile) => <li key={tile.tileId}>{tile.title ?? tile.tileId}: {tile.error ?? tile.status}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function storyInlineText(value: string): Array<string | JSX.Element> {
  return value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

const reviewAppendixStyle: CSSProperties = {
  marginTop: 16,
  border: '1px solid var(--dql-app-line, var(--border-color, rgba(15,23,42,0.10)))',
  borderRadius: 8,
  background: 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
  color: 'var(--dql-app-text, var(--text-primary, #0f172a))',
};

const reviewAppendixSummaryStyle: CSSProperties = {
  cursor: 'pointer',
  padding: '12px 16px',
  fontSize: 12.5,
  fontWeight: 760,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const reviewAppendixGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
  gap: 10,
  fontSize: 11.5,
  lineHeight: 1.45,
  color: 'var(--dql-app-text-muted, var(--text-secondary, #64748b))',
};

const askHintStyle: CSSProperties = {
  position: 'absolute',
  bottom: 10,
  right: 10,
  zIndex: 5,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 8px',
  borderRadius: 999,
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--dql-app-accent, var(--accent, #4f46e5))',
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.12))',
  border: '1px solid var(--dql-app-accent, rgba(79,70,229,0.4))',
  cursor: 'pointer',
  lineHeight: 1.2,
  fontFamily: 'inherit',
};

function defaultTileCopilotQuestion(title: string): string {
  return `/ask Explain ${title} for a stakeholder. Start with the business meaning, current result, active filters, caveats, and recommended next action.`;
}

function TileBody({
  item,
  tile,
  loading,
  error,
  themeMode,
  genUi,
  editable = false,
  onEditText,
  onRetry,
  retrying,
  retryDisabled,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
  genUi?: DqlGenUiMetadata | null;
  editable?: boolean;
  onEditText?: (markdown: string) => void;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
}): JSX.Element {
  if (loading && !tile) return <span>Loading data...</span>;
  if (tile?.tileType === 'text') {
    if (genUi) {
      return (
        <GeneratedTextTile
          title={item.title ?? genUi.insightTitle ?? 'Generated section'}
          markdown={tile.text?.markdown ?? ''}
          genUi={genUi}
          themeMode={themeMode}
        />
      );
    }
    const markdown = tile.text?.markdown ?? '';
    // Narrative tiles are written for readers, so their words are exactly what
    // an author needs to revise. Editing them required hand-editing the .dqld.
    if (editable && onEditText) {
      return (
        <TileTextEditor
          markdown={markdown}
          variant={tile.viz?.type === 'heading' ? 'heading' : 'text'}
          themeMode={themeMode}
          onCommit={onEditText}
        />
      );
    }
    return <MarkdownTile markdown={markdown} variant={tile.viz?.type === 'heading' ? 'heading' : 'text'} themeMode={themeMode} />;
  }
  if (error && !tile) return <span>{error}</span>;
  if (!tile) return <span>No run result.</span>;
  if (tile.status === 'unauthorized') return <span>Not authorized.</span>;
  if (tile.status === 'unresolved') return <span>{tile.error ?? 'Block reference unresolved.'}</span>;
  if (tile.status === 'error') return (
    <div style={{ display: 'grid', gap: 8, justifyItems: 'center', textAlign: 'center', padding: 8 }}>
      <span>{tile.error ?? 'Tile failed.'}</span>
      {tile.repair?.status === 'failed' ? <small>{tile.repair.message}</small> : null}
      {onRetry ? (
        <button
          type="button"
          disabled={retrying || retryDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
          style={tileRepairButtonStyle}
        >
          <Wrench size={12} /> {retrying ? 'Fixing…' : 'Fix and retry'}
        </button>
      ) : null}
    </div>
  );
  if (!tile.result) {
    return tile.tileType === 'aiPin' && tile.aiPin
      ? <AiPinSummary pin={tile.aiPin} themeMode={themeMode} />
      : <span>No result.</span>;
  }

  const chartConfig = mergeDashboardTileChartConfig(item, tile.chartConfig as CellChartConfig | undefined);
  const chart = String(chartConfig.chart ?? tile.viz?.type ?? '').toLowerCase();
  let dataView: JSX.Element;
  if (chart === 'table' || item.viz.type === 'table' || item.viz.type === 'pivot') {
    if (tile.tileType !== 'aiPin' && (genUi?.component === 'EvidenceTable' || genUi?.component === 'PivotTable')) {
      dataView = <GeneratedEvidenceTable result={tile.result} genUi={genUi} themeMode={themeMode} />;
    } else {
      dataView = <div style={{ width: '100%', alignSelf: 'stretch' }}><TableOutput result={tile.result} themeMode={themeMode} /></div>;
    }
  } else {
    const chartResult = chart === 'kpi'
      ? summarizeDashboardKpiResult(tile.result, chartConfig.y)
      : tile.result;
    dataView = <div style={{ width: '100%', alignSelf: 'stretch' }}><ChartOutput result={chartResult} themeMode={themeMode} chartConfig={chartConfig} /></div>;
  }
  return tile.tileType === 'aiPin' && tile.aiPin
    ? <AiPinSummary pin={tile.aiPin} themeMode={themeMode} dataView={dataView} />
    : dataView;
}

function TileEvidencePanel({
  item,
  tile,
  tab,
  onTab,
  onOpenNotebook,
  onClose,
}: {
  item: DashboardLayoutItem;
  tile: DashboardRunTile;
  tab: 'how' | 'dql' | 'sql';
  onTab: (tab: 'how' | 'dql' | 'sql') => void;
  onOpenNotebook?: (tile: DashboardRunTile) => void;
  onClose: () => void;
}): JSX.Element {
  const artifact = tile.artifact;
  const canOpenNotebook = Boolean(tile.result && (artifact?.dql || artifact?.sql));
  const sourceLabel = artifact?.sourceKind === 'certified_block'
    ? 'Certified block'
    : artifact?.sourceKind === 'semantic_query'
      ? 'Governed semantic query'
      : artifact?.sourceKind === 'draft_analysis'
        ? 'App analysis'
        : artifact?.sourceKind === 'ai_pin'
          ? 'Saved AI insight'
          : tile.tileType ?? 'App tile';
  return (
    <div style={tileEvidenceBackdropStyle} role="presentation" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`How ${item.title ?? tile.title ?? item.i} works`}
        style={tileEvidencePanelStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{item.title ?? tile.title ?? artifact?.name ?? 'App tile'}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>{sourceLabel} · {artifact?.trustState === 'certified' && !tile.repair ? 'Certified' : 'Review required'}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" style={iconTileButtonStyle}><X size={14} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 10 }}>
          {(['how', 'dql', 'sql'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => onTab(candidate)}
              style={tileEvidenceTabStyle(tab === candidate)}
            >
              {candidate === 'how' ? 'How it works' : candidate.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ minHeight: 180, maxHeight: '56vh', overflow: 'auto' }}>
          {tab === 'how' ? (
            <div style={{ display: 'grid', gap: 12, fontSize: 12.5, lineHeight: 1.5 }}>
              <EvidenceRow label="Source" value={artifact?.sourcePath ?? tile.citation?.path ?? tile.citation?.name ?? sourceLabel} />
              <EvidenceRow label="Result" value={tile.result ? `${tile.result.rowCount} rows · ${tile.result.columns.length} columns` : tile.status} />
              {artifact?.explanation?.length ? (
                <div>
                  <b>Execution</b>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {artifact.explanation.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </div>
              ) : null}
              {tile.filters ? (
                <EvidenceRow
                  label="Filters"
                  value={`${tile.filters.applied.map((filter) => filter.filter).join(', ') || 'None applied'}${tile.filters.skipped.length ? ` · ${tile.filters.skipped.length} skipped` : ''}`}
                />
              ) : null}
              {tile.invocation ? (
                <EvidenceRow
                  label="Parameters"
                  value={tile.invocation.resolvedParameters.map((parameter) => `${parameter.name} (${parameter.source})`).join(', ') || 'None'}
                />
              ) : null}
              {tile.repair ? <EvidenceRow label="Repair" value={tile.repair.message} /> : null}
              <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-2)', color: 'var(--text-secondary)' }}>
                Parameter values are intentionally omitted here. Open the editable Notebook cell to inspect or change the full execution contract.
              </div>
            </div>
          ) : (
            <pre style={tileEvidenceCodeStyle}>
              {tab === 'dql'
                ? artifact?.dql ?? 'This tile does not expose DQL source. Its governed semantic intent is composed into SQL at runtime.'
                : artifact?.sql ?? 'Executed SQL is not available for this saved result.'}
            </pre>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Close</button>
          {canOpenNotebook ? (
            <button type="button" onClick={() => onOpenNotebook?.(tile)} style={toolbarButtonStyle(true)}>
              Open in Notebook
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 12 }}>
      <b>{label}</b>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

function TileEditorControls({
  item,
  cols,
  settingsOpen,
  onToggleSettings,
  onPatch,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  cols: number;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}) {
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const applyPreset = (preset: TileSizePresetId) => {
    setSizeMenuOpen(false);
    onPatch(tileSizePatch(item, cols, preset));
  };
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          title="Choose tile size"
          onClick={() => setSizeMenuOpen((value) => !value)}
          style={iconTileButtonStyle}
        >
          <Maximize2 size={13} strokeWidth={2} />
        </button>
        {sizeMenuOpen ? (
          <TileSizeMenu
            onPick={applyPreset}
            onClose={() => setSizeMenuOpen(false)}
          />
        ) : null}
      </div>
      <button
        type="button"
        title="Chart and field settings"
        onClick={onToggleSettings}
        style={iconTileButtonStyle}
      >
        <SlidersHorizontal size={13} strokeWidth={2} color={settingsOpen ? 'var(--accent, #4f46e5)' : undefined} />
      </button>
      <button
        type="button"
        title="Remove tile"
        onClick={() => onPatch(null)}
        style={iconTileButtonStyle}
      >
        <Trash2 size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

function TileSizeMenu({
  onPick,
  onClose,
}: {
  onPick: (preset: TileSizePresetId) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={tileSizeMenuStyle}
      onMouseLeave={onClose}
    >
      {TILE_SIZE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => onPick(preset.id)}
          style={tileSizeMenuItemStyle}
        >
          <span style={{ fontSize: 12, fontWeight: 750 }}>{preset.label}</span>
          <span style={{ fontSize: 11, opacity: 0.66 }}>{preset.description}</span>
        </button>
      ))}
    </div>
  );
}

function TileSettingsPanel({
  item,
  tile,
  cols,
  onPatch,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  cols: number;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}) {
  const result = tile?.result;
  const chartConfig = mergeDashboardTileChartConfig(item, tile?.chartConfig as CellChartConfig | undefined);
  const chart = normalizeChartType(chartConfig.chart);
  const genUi = getDqlGenUi(item);
  const [recommendBusy, setRecommendBusy] = useState(false);
  const [recommendNote, setRecommendNote] = useState<string | null>(null);
  const [recommendError, setRecommendError] = useState<string | null>(null);
  const classified = useMemo(() => classifyColumns(result), [result]);
  const columnKinds = useMemo(() => {
    const map = new Map<string, ChartColumnRole>();
    if (!result) return map;
    const metricSet = new Set(classified.metrics);
    const dimSet = new Set(classified.dimensions);
    for (const column of result.columns) {
      if (metricSet.has(column)) map.set(column, 'measure');
      else if (dimSet.has(column)) map.set(column, 'dimension');
      else map.set(column, columnKindToChartRole(inferColumnKind(column, result.rows)));
    }
    return map;
  }, [result, classified]);
  const measures = result?.columns.filter((column) => columnKinds.get(column) === 'measure') ?? [];
  const dimensions = result?.columns.filter((column) => columnKinds.get(column) !== 'measure') ?? [];

  // The title is the one field typed character by character; everything else in
  // this panel is a discrete choice that can save immediately.
  // Seed from what the tile actually displays. `chartConfig.title` can carry a
  // block-level default, so preferring it showed a different name in the editor
  // than in the header — and saving then silently renamed the tile.
  const savedTitle = item.title ?? chartConfig.title ?? '';
  const [titleDraft, setTitleDraft] = useState(savedTitle);
  useEffect(() => { setTitleDraft(savedTitle); }, [savedTitle]);
  const commitTitleDraft = () => {
    const next = titleDraft.trim();
    if (next === savedTitle) return;
    patchConfig({ title: next || undefined });
  };

  const patchConfig = (patch: Partial<CellChartConfig>) => {
    const next = compactChartConfig({ ...chartConfig, ...patch });
    const dashboardViz = chartToDashboardViz(next.chart);
    const currentGenUi = getDqlGenUi(item);
    const options: Record<string, unknown> = { ...next };
    if (currentGenUi) {
      options.dqlGenUi = {
        ...currentGenUi,
        defaultVisualization: dashboardViz,
        ...(next.title ? { insightTitle: next.title } : {}),
      };
    }
    onPatch({
      title: next.title || item.title,
      viz: {
        ...item.viz,
        type: dashboardViz,
        options,
      },
      display: displayWithVisualization(item, dashboardViz, currentGenUi),
    });
  };

  const applyRecommendation = async () => {
    setRecommendBusy(true);
    setRecommendError(null);
    setRecommendNote(null);
    const blockRef = getDashboardItemBlockId(item) ?? item.title;
    const response = await api.recommendVisualization({
      ...(blockRef ? { blockRef } : {}),
      resultSchema: result ? { columns: result.columns } : undefined,
      rowSample: result?.rows.slice(0, 5) as Array<Record<string, unknown>> | undefined,
      prompt: [item.title, genUi?.rationale].filter(Boolean).join(' '),
      allowedVisualizations: genUi?.allowedVisualizations,
    });
    setRecommendBusy(false);
    if (!response.ok) {
      setRecommendError(response.error);
      return;
    }
    const chart = normalizeChartType(response.display.defaultVisualization);
    const dashboardViz = chartToDashboardViz(chart);
    const hints = response.display.fieldHints ?? {};
    const next = compactChartConfig({
      ...chartConfig,
      chart,
      title: chartConfig.title ?? item.title,
      x: hints.x ?? hints.label ?? chartConfig.x,
      y: hints.y ?? hints.value ?? chartConfig.y,
      color: hints.color ?? chartConfig.color,
    });
    onPatch({
      title: next.title || item.title,
      viz: {
        ...item.viz,
        type: dashboardViz,
        options: { ...next } as Record<string, unknown>,
      },
      display: response.display,
    });
    const evidence = response.evidence.map((entry) => entry.source).slice(0, 3).join(', ');
    const warning = response.warnings[0];
    setRecommendNote(warning ? `${response.display.component}: ${warning}` : `${response.display.component}${evidence ? ` from ${evidence}` : ''}`);
  };

  return (
    <div style={tileSettingsPanelStyle}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', opacity: 0.58 }}>Tile size</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TILE_SIZE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              onClick={() => onPatch(tileSizePatch(item, cols, preset.id))}
              style={sizePresetChipStyle(presetMatches(item, cols, preset.id))}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      <div style={tileDisplayContractStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', opacity: 0.58 }}>Display contract</div>
            <div style={{ marginTop: 3, fontSize: 11, lineHeight: 1.35, opacity: 0.76 }}>
              {genUi?.rationale ?? item.display?.rationale ?? 'Choose a governed visualization for this app tile.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void applyRecommendation()}
            disabled={recommendBusy}
            style={recommendButtonStyle(recommendBusy)}
            title="Recommend visualization from block hints and result fields"
          >
            <Wand2 size={12} strokeWidth={2.2} />
            {recommendBusy ? 'Thinking' : 'AI recommend'}
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {genUi?.component ? <span style={generatedMetaPillStyle}>{componentLabelForGenUi(genUi)}</span> : null}
          {genUi?.defaultVisualization ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(String(genUi.defaultVisualization))}</span> : null}
          {genUi?.reviewStatus ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(String(genUi.reviewStatus))}</span> : null}
        </div>
        {recommendNote ? <div style={recommendNoteStyle}>{recommendNote}</div> : null}
        {recommendError ? <div style={recommendErrorStyle}>{recommendError}</div> : null}
      </div>
      <div style={tileSettingsGridStyle}>
        <label style={tileSettingsLabelStyle}>
          Title
          {/* Local while typing, saved on blur or Enter. Patching per keystroke
              issued a full layout PATCH and re-packed the grid on every
              character, so tiles visibly jumped around as you renamed one. */}
          <input
            aria-label="Tile name"
            title="Tile name — also editable directly on the tile header"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => commitTitleDraft()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.currentTarget.blur(); }
              if (event.key === 'Escape') { setTitleDraft(savedTitle); event.currentTarget.blur(); }
            }}
            style={tileSettingsInputStyle}
          />
        </label>
        <label style={tileSettingsLabelStyle}>
          Chart
          <select
            value={chart}
            onChange={(event) => patchConfig({ chart: event.target.value as ChartType })}
            style={tileSettingsInputStyle}
          >
            {APP_CHART_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <FieldSelect label="X" value={chartConfig.x} columns={result?.columns ?? []} onChange={(value) => patchConfig({ x: value })} />
        <FieldSelect label="Y" value={chartConfig.y} columns={result?.columns ?? []} onChange={(value) => patchConfig({ y: value })} />
        <FieldSelect label="Color" value={chartConfig.color} columns={result?.columns ?? []} onChange={(value) => patchConfig({ color: value })} />
        <FieldSelect label="Facet" value={chartConfig.facet} columns={result?.columns ?? []} onChange={(value) => patchConfig({ facet: value })} />
      </div>
      {result ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <ColumnPickList title="Measures" columns={measures} onPick={(column) => patchConfig({ y: column })} />
          <ColumnPickList title="Dimensions" columns={dimensions} onPick={(column) => patchConfig({ x: column })} />
        </div>
      ) : (
        <div style={{ fontSize: 11, opacity: 0.64 }}>Run results are needed before field slots can be inferred.</div>
      )}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  columns,
  onChange,
}: {
  label: string;
  value?: string;
  columns: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label style={tileSettingsLabelStyle}>
      {label}
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)} style={tileSettingsInputStyle}>
        <option value="">Auto</option>
        {columns.map((column) => <option key={column} value={column}>{column}</option>)}
      </select>
    </label>
  );
}

function ColumnPickList({
  title,
  columns,
  onPick,
}: {
  title: string;
  columns: string[];
  onPick: (column: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', opacity: 0.58 }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {columns.length === 0 ? <span style={{ fontSize: 11, opacity: 0.55 }}>None</span> : columns.slice(0, 10).map((column) => (
          <button key={column} type="button" onClick={() => onPick(column)} style={fieldChipStyle}>
            {column}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddTileMenu({
  open,
  onToggle,
  onCertifiedBlock,
  onText,
  onHeading,
  onAi,
  buttonLabel,
  buttonStyle,
}: {
  open: boolean;
  onToggle: () => void;
  onCertifiedBlock: () => void;
  onText: () => void;
  onHeading: () => void;
  onAi: () => void;
  buttonLabel?: string;
  buttonStyle?: CSSProperties;
}) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={onToggle} title="Add tile" style={buttonStyle ?? toolbarButtonStyle(open)}>
        <Plus size={15} strokeWidth={2.2} />
        {buttonLabel ? <span>{buttonLabel}</span> : null}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 30,
            width: 260,
            border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
            borderRadius: 8,
            background: 'var(--color-bg, #fff)',
            boxShadow: '0 14px 38px rgba(0,0,0,0.16)',
            padding: 6,
            display: 'grid',
            gap: 4,
            textAlign: 'left',
          }}
        >
          <AddTileMenuItem title="Certified block" description="Chart, table, or KPI from this App domain" onClick={onCertifiedBlock} />
          <AddTileMenuItem title="Text / summary" description="Narrative, notes, caveats, or CXO context" onClick={onText} />
          <AddTileMenuItem title="Section heading" description="Separate an App page into readable groups" onClick={onHeading} />
          <AddTileMenuItem title="Copilot insight" description="Open scoped AI, then pin the reviewed answer to this App" onClick={onAi} />
        </div>
      )}
    </div>
  );
}

function AddTileMenuItem({
  title,
  description,
  onClick,
}: {
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={addMenuItemStyle}>
      <span style={{ fontSize: 12, fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: 11, opacity: 0.66 }}>{description}</span>
    </button>
  );
}

function GeneratedTextTile({
  title,
  markdown,
  genUi,
  themeMode,
}: {
  title: string;
  markdown: string;
  genUi: DqlGenUiMetadata;
  themeMode: ThemeMode;
}) {
  const theme = themes[themeMode as NotebookThemeMode];
  const summary = extractGeneratedSummary(markdown, title);
  const isTrust = genUi.component === 'TrustCallout';
  const isResearch = genUi.component === 'ResearchActions';
  return (
    <div style={generatedTextTileStyle(isTrust)}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <span style={generatedTextIconStyle(isTrust)}>
          {isTrust ? <AlertTriangle size={15} /> : isResearch ? <Sparkles size={15} /> : <ShieldCheck size={15} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 780, lineHeight: 1.25 }}>{title ?? genUi.insightTitle}</div>
          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.45, color: theme.textSecondary }}>
            {summary}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {genUi.trustState ? <TrustPill trust={genUi.trustState} /> : null}
        {genUi.reviewStatus ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(genUi.reviewStatus)}</span> : null}
      </div>
      {genUi.followUpActions?.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {genUi.followUpActions.slice(0, 3).map((action) => (
            <span key={action} style={generatedActionChipStyle}>
              {formatGenUiLabel(action)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GeneratedEvidenceTable({
  result,
  genUi,
  themeMode,
}: {
  result: QueryResult;
  genUi: DqlGenUiMetadata;
  themeMode: ThemeMode;
}) {
  const theme = themes[themeMode as NotebookThemeMode];
  const rows = result.rows ?? [];
  const columns = result.columns ?? [];
  const labelColumn = pickEvidenceLabelColumn(columns, rows, genUi.fieldHints?.label);
  const statusColumn = columns.find((column) => /\b(status|quality|trust|certification|review)\b/i.test(column));
  const metricColumns = columns
    .filter((column) => column !== labelColumn && column !== statusColumn)
    .filter((column) => evidenceMetricRank(column) < 90 || isNumericColumn(column, rows))
    .sort((a, b) => evidenceMetricRank(a) - evidenceMetricRank(b))
    .slice(0, 2);
  const detailColumns = columns
    .filter((column) => column !== labelColumn && column !== statusColumn && !metricColumns.includes(column))
    .slice(0, 2);
  const rowCount = result.rowCount ?? rows.length;
  const valueSamples = resultValueSamples(columns, rows);

  return (
    <div style={generatedEvidenceStyle}>
      <div style={{ fontSize: 11.5, color: theme.textSecondary }}>
        {rowCount} {rowCount === 1 ? 'row' : 'rows'} across {columns.length} {columns.length === 1 ? 'field' : 'fields'}
      </div>
      <div style={generatedEvidenceRowsStyle}>
        {rows.slice(0, 4).map((row, index) => {
          const label = labelColumn ? formatDashboardValue(labelColumn, row[labelColumn], valueSamples.get(labelColumn) ?? []) : `Row ${index + 1}`;
          const status = statusColumn ? formatDashboardValue(statusColumn, row[statusColumn], valueSamples.get(statusColumn) ?? []) : null;
          return (
            <div key={index} style={generatedEvidenceRowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 760, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
                {detailColumns.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
                    {detailColumns.map((column) => (
                      <span key={column} style={generatedEvidenceMiniPillStyle}>
                        {formatGenUiLabel(column)}: {formatDashboardValue(column, row[column], valueSamples.get(column) ?? [])}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-start', minWidth: 0 }}>
                {metricColumns.map((column) => (
                  <span key={column} style={generatedEvidenceMetricStyle}>
                    <span style={{ opacity: 0.62 }}>{formatGenUiLabel(column)}</span>
                    <strong>{formatDashboardValue(column, row[column], valueSamples.get(column) ?? [])}</strong>
                  </span>
                ))}
                {status ? <span style={generatedEvidenceStatusStyle}>{status}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
      {rows.length > 4 ? (
        <div style={{ fontSize: 11, color: theme.textSecondary }}>
          Showing first 4 rows in generated view. Switch tile settings for full table controls.
        </div>
      ) : null}
    </div>
  );
}

function MarkdownTile({ markdown, variant = 'text', themeMode }: { markdown: string; variant?: 'text' | 'heading'; themeMode: ThemeMode }) {
  const theme = themes[themeMode as NotebookThemeMode];
  return (
    <div
      style={{
        width: '100%',
        alignSelf: 'stretch',
        overflow: 'auto',
        whiteSpace: 'normal',
        lineHeight: 1.45,
        fontStyle: 'normal',
        opacity: 1,
        fontSize: variant === 'heading' ? 18 : undefined,
        fontWeight: variant === 'heading' ? 800 : undefined,
        display: variant === 'heading' ? 'flex' : undefined,
        alignItems: variant === 'heading' ? 'center' : undefined,
      }}
    >
      {renderMarkdown(markdown, theme)}
    </div>
  );
}

function AiPinSummary({
  pin,
  themeMode,
  dataView,
}: {
  pin: NonNullable<DashboardRunResponse['tiles'][number]['aiPin']>;
  themeMode: ThemeMode;
  dataView?: ReactNode;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const theme = themes[themeMode as NotebookThemeMode] ?? themes.light;
  const refresh = async () => {
    setMessage('Refreshing...');
    const result = await api.refreshAiPin(pin.appId, pin.id);
    setMessage(result.ok ? 'Refreshed.' : result.error ?? 'Refresh failed.');
    window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: { appId: pin.appId, dashboardId: pin.dashboardId } }));
  };
  const promote = async () => {
    setMessage('Creating draft...');
    const result = await api.promoteAiPin(pin.appId, pin.id);
    setMessage(result.ok ? `Draft created: ${result.blockPath}` : result.error ?? 'Promotion failed.');
    window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: { appId: pin.appId, dashboardId: pin.dashboardId } }));
  };
  return (
    <div style={{ width: '100%', alignSelf: 'stretch', overflow: 'auto', fontStyle: 'normal', lineHeight: 1.5, display: 'grid', gap: 10 }}>
      {dataView ? dataView : (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: pin.certification === 'certified' ? '#15803d' : '#b45309', background: pin.certification === 'certified' ? 'rgba(22,163,74,0.1)' : 'rgba(245,158,11,0.12)', border: `1px solid ${pin.certification === 'certified' ? 'rgba(22,163,74,0.22)' : 'rgba(245,158,11,0.24)'}`, borderRadius: 999, padding: '3px 7px' }}>
              {pin.certification === 'certified' ? 'Certified' : 'Review required'}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--color-text-muted, rgba(0,0,0,0.58))' }}>Pinned report insight</span>
          </div>
          <div style={{ minWidth: 0 }}>
            {renderMarkdown(pin.answer, theme)}
          </div>
          {pin.result?.rows?.length ? <AiPinEvidencePreview result={pin.result} /> : null}
        </>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {pin.sql && <button type="button" onClick={() => void refresh()} style={miniButtonStyle}>Refresh</button>}
        {pin.sql && pin.reviewStatus === 'needs_review' && <button type="button" onClick={() => void promote()} style={miniButtonStyle}>Promote</button>}
        {pin.refreshCadence === 'daily' && <span style={{ fontSize: 11, opacity: 0.62 }}>daily</span>}
      </div>
      {message && <div style={{ marginTop: 6, fontSize: 11, opacity: 0.72 }}>{message}</div>}
      {pin.lastRefreshError && <div style={{ marginTop: 8, color: '#f85149' }}>{pin.lastRefreshError}</div>}
    </div>
  );
}

function AiPinEvidencePreview({ result }: { result: QueryResult }) {
  const columns = (result.columns?.length ? result.columns : Object.keys(result.rows?.[0] ?? {})).slice(0, 4);
  const rows = (result.rows ?? []).slice(0, 3);
  const valueSamples = resultValueSamples(columns, result.rows ?? []);
  if (!columns.length || !rows.length) return null;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ color: 'var(--color-text-muted, rgba(0,0,0,0.58))', fontSize: 11, fontWeight: 750 }}>Supporting rows</div>
      <div style={{ overflow: 'auto', border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} style={{ textAlign: 'left', padding: '5px 7px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))', color: 'var(--color-text-muted, rgba(0,0,0,0.58))' }}>
                  {formatGenUiLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column} style={{ padding: '5px 7px', borderBottom: index === rows.length - 1 ? 'none' : '1px solid var(--border-color, rgba(0,0,0,0.06))' }}>
                    {formatDashboardValue(column, row[column], valueSamples.get(column) ?? [])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextTileDialog({
  kind,
  value,
  onChange,
  onClose,
  onSave,
}: {
  kind: 'text' | 'heading';
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const isHeading = kind === 'heading';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(520px, 92vw)', display: 'grid', gap: 12, background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, boxShadow: '0 18px 60px rgba(0,0,0,0.35)', padding: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{isHeading ? 'Add heading' : 'Add text tile'}</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
            {isHeading ? 'Create a section heading on this dashboard page.' : 'Create a narrative text tile on this dashboard page.'}
          </div>
        </div>
        {isHeading ? (
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSave();
              if (event.key === 'Escape') onClose();
            }}
            placeholder="Executive summary"
            autoFocus
            style={dialogInputStyle}
          />
        ) : (
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave();
            }}
            placeholder="Add context, assumptions, or decisions..."
            rows={6}
            autoFocus
            style={{ ...dialogInputStyle, resize: 'vertical', lineHeight: 1.45 }}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Cancel</button>
          <button type="button" onClick={onSave} disabled={!value.trim()} style={{ ...primaryBuilderButtonStyle, opacity: value.trim() ? 1 : 0.65 }}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function BlockCatalogDialog({
  blocks,
  search,
  onSearch,
  onClose,
  onAdd,
}: {
  blocks: AppBlockRecommendation[];
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  onAdd: (block: AppBlockRecommendation) => void;
}) {
  const filtered = blocks.filter((block) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [block.name, block.description, block.domain, ...(block.tags ?? [])].join(' ').toLowerCase().includes(needle);
  });
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(860px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, overflow: 'hidden', boxShadow: '0 18px 60px rgba(0,0,0,0.35)' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.1))', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Add Certified Block</div>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Close</button>
        </div>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search domain blocks..."
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, padding: '8px 10px', background: 'var(--surface, transparent)', color: 'inherit' }}
          />
        </div>
        <div style={{ overflow: 'auto', padding: 12, display: 'grid', gap: 8 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 18, fontSize: 12, opacity: 0.66 }}>No certified blocks match this App scope.</div>
          ) : filtered.map((block) => (
            <button
              key={block.id}
              type="button"
              onClick={() => onAdd(block)}
              style={{ textAlign: 'left', border: '1px solid var(--border-color, rgba(0,0,0,0.1))', borderRadius: 7, background: 'transparent', color: 'inherit', padding: 10, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{block.name}</span>
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 999, background: 'rgba(63,185,80,0.14)', color: '#2ea043' }}>{block.status}</span>
                <span style={{ fontSize: 10, opacity: 0.68 }}>{block.domain}</span>
                <span style={{ fontSize: 10, opacity: 0.68 }}>{block.chartType ?? 'table'}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>{block.description || block.path}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScopedLineagePanel({ lineage }: { lineage: any | null }) {
  const nodes = lineage?.graph?.nodes ?? [];
  const edges = lineage?.graph?.edges ?? [];
  const breadcrumbs = lineage?.breadcrumbs ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', opacity: 0.62, marginBottom: 6 }}>App Lineage</div>
        <div style={{ fontSize: 12, opacity: 0.72 }}>Terms and business views connect the App back to DQL blocks, dbt models, and source tables.</div>
      </div>
      {breadcrumbs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {breadcrumbs.map((node: any, index: number) => (
            <div key={`${node.id}-${index}`} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, fontSize: 12 }}>
              <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>{node.type}</span>
              <span>{node.name}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <LineageStat label="Nodes" value={nodes.length} />
        <LineageStat label="Edges" value={edges.length} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {nodes.slice(0, 18).map((node: any) => (
          <div key={node.id} style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6, padding: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  color: '#0d1117',
                  background: NODE_TYPE_COLORS[node.type] ?? '#8b949e',
                  borderRadius: 3,
                  padding: '1px 4px',
                  fontSize: 9,
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                {TYPE_LABELS[node.type] ?? node.type.slice(0, 4).toUpperCase()}
              </span>
              <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</div>
            </div>
            <div style={{ fontSize: 11, opacity: 0.62, fontFamily: 'monospace', marginTop: 4 }}>
              {TYPE_TITLES[node.type] ?? node.type} · {node.id}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineageStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6, padding: 8 }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

export function getGeneratedVizOptions(
  item: DashboardLayoutItem,
  genUi?: DqlGenUiMetadata | null,
): Array<{ value: ChartType; label: string }> {
  const allowed = new Set<string>([
    'table',
    String(item.viz.type ?? 'table'),
    ...(genUi?.allowedVisualizations ?? []),
  ]);
  const values = Array.from(allowed)
    .map((value) => normalizeChartType(value))
    .filter((value, index, arr) => arr.indexOf(value) === index);
  return values
    .map((value) => APP_CHART_TYPE_OPTIONS.find((option) => option.value === value) ?? { value, label: formatGenUiLabel(value) });
}

function tileSurfaceForGenUi(component?: string): string {
  if (component === 'TrustCallout') return 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,251,235,0.72))';
  if (component === 'RankingPanel' || component === 'TrendPanel' || component === 'PivotTable') return 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,252,0.86))';
  if (component === 'BusinessBrief') return 'var(--dql-app-surface, rgba(255,255,255,0.90))';
  return 'var(--dql-app-surface, var(--surface, rgba(255,255,255,0.84)))';
}

/**
 * Persistent save state for a dashboard that autosaves.
 *
 * There is no Save button by design — layout and tile edits write immediately.
 * That is only a defensible design if the state is always visible, which it was
 * not: the old notice was an 11px 0.68-opacity string rendered only in edit
 * mode, and a failed save had no surface at all.
 */
function SaveStatus({
  saving,
  error,
  pending,
  notice,
  onDismissError,
}: {
  saving: boolean;
  error: string | null;
  pending: boolean;
  notice: string | null;
  onDismissError: () => void;
}): JSX.Element | null {
  if (error) {
    return (
      <div role="alert" style={saveStatusStyle('var(--status-error, #c45555)')}>
        <AlertTriangle size={13} />
        <span style={{ flex: 1, minWidth: 0 }}>Save failed — {error}</span>
        <button type="button" onClick={onDismissError} style={saveStatusDismissStyle}>Dismiss</button>
      </div>
    );
  }
  if (saving) {
    return <div role="status" style={saveStatusStyle('var(--text-secondary)')}><Loader2 size={13} /> Saving…</div>;
  }
  if (pending) {
    return (
      <div role="status" style={saveStatusStyle('var(--status-warning, #b8860b)')}>
        <AlertTriangle size={13} /> Layout preview not saved — Apply or Cancel to continue.
      </div>
    );
  }
  if (!notice) return null;
  return <div role="status" style={saveStatusStyle('var(--text-tertiary)')}><CheckCircle2 size={13} /> {notice}</div>;
}

const saveStatusStyle = (color: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '5px 12px',
  fontSize: 11.5,
  color,
  borderBottom: '1px solid var(--border-subtle)',
});

const saveStatusDismissStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 700,
  textDecoration: 'underline',
  padding: 0,
};

/**
 * A distinct glyph per chart type.
 *
 * This had four branches for sixteen types, so ten of them — including KPI,
 * gauge, scatter and every stacked/grouped variant — drew the same bar icon.
 * `GeneratedVizSwitcher` renders one button per allowed visualization, so a
 * single tile could show seven identical bar glyphs in a row.
 */
export function iconForChartType(type: ChartType): JSX.Element {
  const props = { size: 13, strokeWidth: 2.2 } as const;
  switch (type) {
    case 'line': return <LineChart {...props} />;
    case 'area': return <ChartArea {...props} />;
    case 'pie': return <PieChart {...props} />;
    case 'donut': return <Donut {...props} />;
    case 'table': return <Table2 {...props} />;
    case 'kpi': return <Hash {...props} />;
    case 'gauge': return <Gauge {...props} />;
    case 'scatter': return <ChartScatter {...props} />;
    case 'heatmap': return <Grid3x3 {...props} />;
    case 'histogram': return <ChartColumnIncreasing {...props} />;
    case 'stacked-bar': return <ChartColumnStacked {...props} />;
    case 'grouped-bar': return <ChartColumnBig {...props} />;
    case 'funnel': return <Filter {...props} />;
    case 'waterfall': return <Activity {...props} />;
    case 'sankey': return <Workflow {...props} />;
    default: return <BarChart3 {...props} />;
  }
}

function componentLabelForGenUi(genUi: DqlGenUiMetadata): string {
  switch (genUi.component) {
    case 'BusinessBrief':
      return 'Business summary';
    case 'KpiMetric':
      return 'KPI';
    case 'TrendPanel':
      return 'Trend';
    case 'RankingPanel':
      return 'Ranking';
    case 'EvidenceTable':
      return 'Evidence';
    case 'PivotTable':
      return 'Pivot';
    case 'TrustCallout':
      return 'Trust';
    case 'ResearchActions':
      return 'Analysis';
    case 'NarrativePanel':
      return 'Narrative';
    default:
      return genUi.role ? formatGenUiLabel(genUi.role) : 'Generated';
  }
}

function extractGeneratedSummary(markdown: string, title: string): string {
  const titlePattern = new RegExp(`^###\\s*${escapeRegExp(title)}\\s*`, 'i');
  const cleaned = markdown
    .replace(titlePattern, '')
    .replace(/\*\*Trust:\*\*.*$/gim, '')
    .replace(/\*\*Review status:\*\*.*$/gim, '')
    .replace(/\*\*Next actions:\*\*[\s\S]*$/im, '')
    .replace(/\*\*Review tasks:\*\*[\s\S]*$/im, '')
    .trim();
  const paragraph = cleaned.split(/\n{2,}/).map((part) => part.trim()).find(Boolean);
  return paragraph || 'Generated app section pending analyst review.';
}

function toolbarButtonStyle(active: boolean): CSSProperties {
  return {
    border: '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.12)))',
    borderRadius: 8,
    background: active ? 'var(--dql-app-accent-soft, var(--surface-hover, rgba(0,0,0,0.06)))' : 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
    color: 'inherit',
    padding: '7px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 720,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
  };
}

function toolbarIconButtonStyle(active: boolean): CSSProperties {
  return { ...toolbarButtonStyle(active), width: 34, height: 34, padding: 0, justifyContent: 'center' };
}

const addTileIconButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  border: '1px solid var(--dql-app-accent, #4f46e5)',
  borderRadius: 8,
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.12))',
  color: 'var(--dql-app-accent, #4f46e5)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dashboardToolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 10,
};

const tileEvidenceButtonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 7,
  background: 'var(--bg-1)',
  color: 'var(--text-secondary)',
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: 10.5,
  fontWeight: 720,
};

const tileRepairButtonStyle: CSSProperties = {
  ...tileEvidenceButtonStyle,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  color: 'var(--accent)',
  borderColor: 'var(--accent-dim)',
};

const tileEvidenceBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 120,
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  background: 'rgba(0, 0, 0, 0.38)',
};

const tileEvidencePanelStyle: CSSProperties = {
  width: 'min(780px, calc(100vw - 32px))',
  maxHeight: 'min(760px, calc(100vh - 48px))',
  overflow: 'hidden',
  display: 'grid',
  gap: 12,
  padding: 16,
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  background: 'var(--bg-0)',
  color: 'var(--text-primary)',
  boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
};

function tileEvidenceTabStyle(active: boolean): CSSProperties {
  return {
    border: active ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
    borderRadius: 7,
    background: active ? 'var(--accent-dim)' : 'var(--bg-1)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    padding: '5px 9px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 750,
  };
}

const tileEvidenceCodeStyle: CSSProperties = {
  margin: 0,
  minHeight: 180,
  padding: 14,
  borderRadius: 8,
  background: 'var(--bg-2)',
  color: 'var(--text-primary)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 12,
  lineHeight: 1.55,
};

const dashboardEditHintStyle: CSSProperties = {
  marginBottom: 12,
  color: 'var(--dql-app-muted, var(--color-text-secondary, rgba(0,0,0,0.64)))',
  fontSize: 12,
  lineHeight: 1.45,
};

const dashboardStoryStripStyle: CSSProperties = {
  border: '1px solid var(--dql-app-line-2, var(--border-color, rgba(15,23,42,0.10)))',
  borderRadius: 10,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,252,0.88))',
  boxShadow: '0 8px 24px rgba(15,23,42,0.05)',
  padding: 14,
  marginBottom: 12,
  display: 'grid',
  gap: 9,
};

const dashboardStoryHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  minWidth: 0,
};

const dashboardStoryIconStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.10))',
  color: 'var(--dql-app-accent, #4f46e5)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const dashboardStoryKickerStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 820,
  letterSpacing: 0,
  textTransform: 'uppercase',
  color: 'var(--dql-app-muted, rgba(15,23,42,0.58))',
};

const dashboardStoryTitleStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 15,
  lineHeight: 1.25,
  fontWeight: 820,
  color: 'var(--dql-app-text, inherit)',
};

const dashboardStorySummaryStyle: CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  lineHeight: 1.48,
  color: 'var(--dql-app-muted, rgba(15,23,42,0.72))',
};

const dashboardStoryChipRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const dashboardStoryChipStyle: CSSProperties = {
  border: '1px solid var(--dql-app-line, var(--border-color, rgba(15,23,42,0.10)))',
  borderRadius: 999,
  background: 'var(--dql-app-surface, rgba(255,255,255,0.78))',
  color: 'var(--dql-app-muted, rgba(15,23,42,0.68))',
  padding: '3px 8px',
  fontSize: 11,
  fontWeight: 720,
  lineHeight: 1.2,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const dashboardStorySourceChipStyle: CSSProperties = {
  ...dashboardStoryChipStyle,
  color: 'var(--dql-app-accent, #4f46e5)',
  borderColor: 'rgba(79,70,229,0.22)',
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.08))',
};

const storyActionButtonStyle: CSSProperties = {
  border: '1px solid var(--dql-app-line-2, var(--border-color, rgba(15,23,42,0.14)))',
  borderRadius: 8,
  background: 'var(--dql-app-surface, var(--surface, #fff))',
  color: 'var(--dql-app-text, var(--text-primary, #0f172a))',
  padding: '6px 10px',
  fontSize: 11.5,
  fontWeight: 720,
  cursor: 'pointer',
};

function dashboardChatDrawerStyle(expanded: boolean): CSSProperties {
  return {
    position: 'fixed',
    right: 24,
    top: 76,
    bottom: 24,
    zIndex: 70,
    width: expanded
      ? `min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, calc(100vw - 96px))`
      : `min(${AI_SIDE_PANEL_WIDTH}px, calc(100vw - 64px))`,
    minWidth: 0,
  };
}

const dialogInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 6,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  padding: '8px 10px',
};

const primaryBuilderButtonStyle: CSSProperties = {
  border: '1px solid var(--accent, #4f46e5)',
  borderRadius: 6,
  background: 'var(--accent, #4f46e5)',
  color: 'var(--color-text-on-accent, #fff)',
  padding: '7px 11px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
};

const addMenuItemStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  padding: '9px 10px',
  cursor: 'pointer',
  textAlign: 'left',
  display: 'grid',
  gap: 2,
};

const tileSettingsPanelStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 6,
  padding: 8,
  background: 'var(--color-bg, rgba(255,255,255,0.72))',
  display: 'grid',
  gap: 8,
  fontStyle: 'normal',
};

const tileSettingsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 6,
};

const tileSettingsLabelStyle: CSSProperties = {
  display: 'grid',
  gap: 3,
  fontSize: 10,
  fontWeight: 700,
  opacity: 0.78,
};

const tileSettingsInputStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  padding: '5px 6px',
  fontSize: 11,
};

const tileDisplayContractStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
  borderRadius: 6,
  background: 'var(--surface, rgba(248,250,252,0.62))',
  padding: 8,
};

function recommendButtonStyle(busy: boolean): CSSProperties {
  return {
    border: '1px solid var(--accent, rgba(79,70,229,0.55))',
    background: busy ? 'rgba(79,70,229,0.10)' : 'rgba(79,70,229,0.08)',
    color: 'var(--accent, #4f46e5)',
    borderRadius: 5,
    padding: '5px 7px',
    fontSize: 11,
    fontWeight: 750,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.72 : 1,
    whiteSpace: 'nowrap',
  };
}

const recommendNoteStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: 'var(--dql-app-muted, rgba(15,23,42,0.68))',
};

const recommendErrorStyle: CSSProperties = {
  ...recommendNoteStyle,
  color: 'var(--error-color, #b91c1c)',
};

const fieldChipStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 4,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: '2px 5px',
  fontSize: 10,
  cursor: 'pointer',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const generatedMetaRowStyle: CSSProperties = {
  marginTop: 7,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 5,
  alignItems: 'center',
  minWidth: 0,
};

const generatedMetaPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 18,
  borderRadius: 999,
  border: '1px solid var(--border-color, rgba(15,23,42,0.10))',
  background: 'rgba(148,163,184,0.10)',
  color: 'var(--dql-app-muted, rgba(15,23,42,0.70))',
  padding: '2px 7px',
  fontSize: 10,
  fontWeight: 720,
  lineHeight: 1.1,
};

function trustPillStyle(certified: boolean): CSSProperties {
  return {
    ...generatedMetaPillStyle,
    border: certified ? '1px solid rgba(22,163,74,0.26)' : '1px solid rgba(217,119,6,0.28)',
    background: certified ? 'rgba(22,163,74,0.10)' : 'rgba(245,158,11,0.12)',
    color: certified ? '#15803d' : '#b45309',
    gap: 4,
  };
}

const generatedVizSwitcherStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  border: '1px solid var(--border-color, rgba(15,23,42,0.12))',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.74)',
  flexShrink: 0,
};

function generatedVizButtonStyle(active: boolean): CSSProperties {
  return {
    width: 24,
    height: 24,
    border: 'none',
    borderRadius: 4,
    background: active ? 'var(--dql-app-accent, var(--accent, #4f46e5))' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  };
}

function generatedTextTileStyle(isTrust: boolean): CSSProperties {
  return {
    width: '100%',
    alignSelf: 'stretch',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    fontStyle: 'normal',
    opacity: 1,
    lineHeight: 1.45,
    borderRadius: 6,
    padding: isTrust ? 10 : 0,
    background: isTrust ? 'rgba(245,158,11,0.08)' : 'transparent',
  };
}

function generatedTextIconStyle(isTrust: boolean): CSSProperties {
  return {
    width: 30,
    height: 30,
    borderRadius: 7,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: isTrust ? 'rgba(245,158,11,0.14)' : 'rgba(79,70,229,0.10)',
    color: isTrust ? '#b45309' : 'var(--dql-app-accent, var(--accent, #4f46e5))',
  };
}

const generatedActionChipStyle: CSSProperties = {
  ...generatedMetaPillStyle,
  background: 'rgba(79,70,229,0.08)',
  color: 'var(--dql-app-accent, var(--accent, #4f46e5))',
  border: '1px solid rgba(79,70,229,0.16)',
};

const generatedEvidenceStyle: CSSProperties = {
  width: '100%',
  alignSelf: 'stretch',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
  fontStyle: 'normal',
  opacity: 1,
  lineHeight: 1.35,
};

const generatedEvidenceRowsStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
};

const generatedEvidenceRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 7,
  alignItems: 'start',
  border: '1px solid var(--border-color, rgba(15,23,42,0.09))',
  borderRadius: 7,
  background: 'rgba(255,255,255,0.56)',
  padding: '7px 8px',
};

const generatedEvidenceMiniPillStyle: CSSProperties = {
  ...generatedMetaPillStyle,
  minHeight: 16,
  borderRadius: 5,
  padding: '1px 5px',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const generatedEvidenceMetricStyle: CSSProperties = {
  display: 'grid',
  gap: 1,
  minWidth: 82,
  textAlign: 'left',
  fontSize: 10.5,
};

const generatedEvidenceStatusStyle: CSSProperties = {
  ...generatedMetaPillStyle,
  minHeight: 18,
  background: 'rgba(22,163,74,0.09)',
  border: '1px solid rgba(22,163,74,0.18)',
  color: '#15803d',
};

const iconTileButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 5,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, rgba(255,255,255,0.72))',
  color: 'inherit',
  cursor: 'pointer',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dragHandleButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, rgba(255,255,255,0.72))',
  color: 'inherit',
  cursor: 'grab',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const tileSizeMenuStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 40,
  width: 240,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 8,
  background: 'var(--color-bg, #fff)',
  boxShadow: '0 14px 38px rgba(0,0,0,0.16)',
  padding: 6,
  display: 'grid',
  gap: 4,
};

const tileSizeMenuItemStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  padding: '8px 9px',
  cursor: 'pointer',
  textAlign: 'left',
  display: 'grid',
  gap: 2,
};

function sizePresetChipStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? 'var(--accent, #4f46e5)' : 'var(--border-color, rgba(0,0,0,0.12))'}`,
    borderRadius: 999,
    background: active ? 'var(--color-bg-active, rgba(79,70,229,0.12))' : 'var(--surface, rgba(0,0,0,0.02))',
    color: active ? 'var(--accent, #4f46e5)' : 'inherit',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: active ? 750 : 600,
    cursor: 'pointer',
  };
}

const segmentedControlStyle: CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  overflow: 'hidden',
  background: 'var(--surface, rgba(255,255,255,0.66))',
};

function segmentPillStyle(active: boolean): CSSProperties {
  return {
    width: 24,
    height: 24,
    border: 'none',
    borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))',
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    padding: 0,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: active ? 800 : 600,
  };
}

const miniButtonStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 4,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: '3px 7px',
  cursor: 'pointer',
  fontSize: 11,
};

function nextTilePosition(
  dashboard: DashboardDocumentResponse['dashboard'],
  size: { w: number; h: number } = { w: 6, h: 3 },
): { x: number; y: number; w: number; h: number } {
  const y = dashboard.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { x: 0, y, w: size.w, h: size.h };
}

function nextTileId(dashboard: DashboardDocumentResponse['dashboard'], raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tile';
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// Gap-free 2D first-fit packer: places each tile (in order) at the topmost,
// then leftmost, free slot so later tiles backfill whitespace left by wider
// tiles above them. Keeps a clean, dense enterprise grid.
