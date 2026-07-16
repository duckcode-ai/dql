import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, BarChart3, Bot, GitBranch, GripVertical, LineChart, Maximize2, PieChart, Plus, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Trash2, Wand2, X } from 'lucide-react';
import { api, type AppBlockRecommendation, type DashboardDocumentResponse, type DashboardRunResponse, type DashboardStoryBrief } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { CellChartConfig, QueryResult, ThemeMode } from '../../store/types';
import { ChartOutput, CHART_TYPE_OPTIONS, type ChartType } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { UnifiedAgentRunPanel, usePersistedAgentThreadId } from '../agent/UnifiedAgentRunPanel';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH, AI_SIDE_PANEL_WIDTH } from '../agent/AiSidePanel';
import { renderMarkdown } from '../cells/MarkdownCellEditor';
import { inferColumnKind, columnKindToChartRole, type ChartColumnRole } from '../../utils/column-kind';
import { classifyColumns } from '../../utils/semantic-fields';
import { NODE_TYPE_COLORS, TYPE_LABELS, TYPE_TITLES } from '../lineage/lineage-constants';
import { themes, type ThemeMode as NotebookThemeMode } from '../../themes/notebook-theme';

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type DashboardRunTile = DashboardRunResponse['tiles'][number];
type DashboardStory = {
  title: string;
  summary: string;
  sourceTitle: string;
  trust: string | null;
  filters: Array<{ label: string; value: string }>;
  chips: string[];
};

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

type TileSizePresetId = 'auto' | 'compact' | 'standard' | 'wide' | 'tall' | 'full';

const TILE_SIZE_PRESETS: Array<{ id: TileSizePresetId; label: string; description: string }> = [
  { id: 'auto', label: 'Auto fit', description: 'Choose a practical size from the tile content' },
  { id: 'compact', label: 'Compact', description: 'Small KPI or short summary' },
  { id: 'standard', label: 'Standard', description: 'Default chart or table card' },
  { id: 'wide', label: 'Wide', description: 'Full-row trend or comparison' },
  { id: 'tall', label: 'Tall', description: 'More vertical room for tables and dense charts' },
  { id: 'full', label: 'Full page', description: 'Large focused view across the page' },
];

interface DqlGenUiMetadata {
  version?: number;
  component?: 'BusinessBrief' | 'KpiMetric' | 'TrendPanel' | 'RankingPanel' | 'EvidenceTable' | 'PivotTable' | 'TrustCallout' | 'ResearchActions' | 'NarrativePanel' | string;
  role?: string;
  layoutIntent?: TileSizePresetId | string;
  defaultVisualization?: string;
  allowedVisualizations?: string[];
  fieldHints?: Record<string, string>;
  insightTitle?: string;
  trustState?: 'certified' | 'review_required' | 'draft_ready' | string;
  reviewStatus?: string;
  sourceNodeId?: string;
  followUpActions?: string[];
  rationale?: string;
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
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [textDialogKind, setTextDialogKind] = useState<'text' | 'heading' | null>(null);
  const [textDialogValue, setTextDialogValue] = useState('');
  const [dragPreview, setDragPreview] = useState<{ tileId: string; x: number; y: number; w: number; h: number } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [narrowGrid, setNarrowGrid] = useState(false);
  const cols = dashboard.layout.cols;
  const rowHeight = dashboard.layout.rowHeight;
  const variablesKey = useMemo(() => JSON.stringify(variables ?? {}), [variables]);
  const runVariables = useMemo<Record<string, unknown>>(() => JSON.parse(variablesKey), [variablesKey]);
  const tileResults = useMemo(() => {
    const map = new Map<string, DashboardRunResponse['tiles'][number]>();
    for (const tile of run?.tiles ?? []) map.set(tile.tileId, tile);
    return map;
  }, [run]);
  const baseVisibleItems = useMemo(
    () => editable ? dashboard.layout.items : dashboard.layout.items.filter((item) => !isStakeholderHiddenReviewTile(item)),
    [dashboard.layout.items, editable],
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
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.runDashboard(appId, dashboard.id, runVariables).then((result) => {
      if (cancelled) return;
      setRun(result);
      setBusinessStory(result?.story ?? null);
      latestRunIdRef.current = result?.runId ?? null;
      onRunChange?.(result);
      if (!result) setError('Dashboard run failed.');
      if (result?.runId) {
        void api.getDashboardStory(appId, dashboard.id, result.runId).then((storyResult) => {
          if (cancelled || !storyResult || latestRunIdRef.current !== storyResult.runId) return;
          if (storyResult.snapshotId !== result.snapshotId || storyResult.filterFingerprint !== result.filterFingerprint || storyResult.resultFingerprint !== result.resultFingerprint || storyResult.personaFingerprint !== result.personaFingerprint) return;
          setBusinessStory(storyResult.story);
        });
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        onRunChange?.(null);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
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

  const saveItems = useCallback(async (items: DashboardDocumentResponse['dashboard']['layout']['items']) => {
    setSaving(true);
    const next = {
      ...dashboard,
      layout: {
        ...dashboard.layout,
        items,
      },
    };
    const result = await api.patchDashboardLayout(appId, dashboard.id, next.layout);
    setSaving(false);
    if (result.ok) {
      onDashboardChanged?.(result.dashboard);
    } else {
      setError(result.error);
    }
  }, [appId, dashboard, onDashboardChanged]);

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
      i: nextTileId(dashboard, block.name),
      ...nextTilePosition(dashboard, size),
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
    await saveItems([...dashboard.layout.items, tile]);
    setCatalogOpen(false);
  }, [appId, cols, dashboard, saveItems]);

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
      await saveItems([
        ...dashboard.layout.items,
        {
          i: nextTileId(dashboard, 'section'),
          ...nextTilePosition(dashboard, tileSizeForPreset('wide', cols, 'heading')),
          text: { markdown: value },
          viz: { type: 'heading' },
          display: textTileDisplay('heading', value),
          title: value,
        },
      ]);
    } else {
      const title = value.split(/\r?\n/)[0]?.slice(0, 60) || 'Summary';
      await saveItems([
        ...dashboard.layout.items,
        {
          i: nextTileId(dashboard, 'text'),
          ...nextTilePosition(dashboard, tileSizeForPreset('standard', cols, 'text')),
          text: { markdown: value },
          viz: { type: 'text' },
          display: textTileDisplay('text', title),
          title,
        },
      ]);
    }
    setTextDialogKind(null);
    setTextDialogValue('');
  }, [cols, dashboard, saveItems, textDialogKind, textDialogValue]);

  const patchTile = useCallback(async (tileId: string, patch: Partial<DashboardLayoutItem> | null) => {
    const items = patch === null
      ? dashboard.layout.items.filter((item) => item.i !== tileId)
      : dashboard.layout.items.map((item) => item.i === tileId ? { ...item, ...patch } : item);
    await saveItems(packDashboardItems(items, cols));
  }, [cols, dashboard.layout.items, saveItems]);

  const moveTileToPoint = useCallback(async (tileId: string, point: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    const item = dashboard.layout.items.find((candidate) => candidate.i === tileId);
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
    const ordered = reorderTileForDrop(dashboard.layout.items, moved, cols);
    await saveItems(packDashboardItems(ordered, cols));
  }, [cols, dashboard.layout.items, rowHeight, saveItems]);

  const updateDragPreview = useCallback((tileId: string, point: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    const item = dashboard.layout.items.find((candidate) => candidate.i === tileId);
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
  }, [cols, dashboard.layout.items, rowHeight]);

  const clearDragPreview = useCallback(() => setDragPreview(null), []);

  const autoLayout = useCallback(async () => {
    const items = dashboard.layout.items;
    if (items.length === 0) return;
    const ordered = [...items]
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const rank = autoLayoutRank(a.item) - autoLayoutRank(b.item);
        return rank !== 0 ? rank : a.index - b.index;
      })
      .map(({ item }) => {
        const size = autoTileSizeForItem(item, cols);
        return { ...item, w: size.w, h: size.h };
      });
    await saveItems(packDashboardItems(ordered, cols));
  }, [cols, dashboard.layout.items, saveItems]);

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
        {editable && dashboard.layout.items.length > 1 && (
          <button
            type="button"
            onClick={() => void autoLayout()}
            disabled={saving}
            style={toolbarIconButtonStyle(false)}
            title="Auto-arrange every tile into a clean, gap-free grid"
          >
            <Wand2 size={15} strokeWidth={2} />
          </button>
        )}
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
}): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const blockId = getDashboardItemBlockId(item);
  const canAsk = Boolean(!editable && blockId && onAskBlock);
  const blockRef = blockId
    ? `block:${blockId}`
    : item.semantic
      ? `semantic:${item.semantic.id}`
    : item.aiPin
      ? `aiPin:${item.aiPin.id}`
      : 'text';
  const vizType = normalizeViz(String(item.viz.type ?? 'table'));
  const genUi = getDqlGenUi(item);
  const generatedComponent = genUi?.component;
  const generatedTitle = genUi?.insightTitle || item.title || blockRef;
  const aiPinTrust = tile?.tileType === 'aiPin'
    ? tile.aiPin?.certification === 'certified' ? 'certified' : 'review_required'
    : undefined;
  const generatedTrust = genUi?.trustState ?? aiPinTrust ?? (tile?.certificationStatus === 'certified' ? 'certified' : undefined);
  const isGeneratedUi = Boolean(genUi);
  const isCompactMetric = item.h <= 2 && (vizType === 'single_value' || vizType === 'kpi' || vizType === 'gauge');
  const [hovered, setHovered] = useState(false);
  const showEditChrome = editable && (hovered || selected || settingsOpen);
  const generatedVizOptions = getGeneratedVizOptions(item, genUi);
  const showAskHint = Boolean(canAsk && (hovered || selected));
  const switchGeneratedViz = (chart: ChartType) => {
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
              <div style={{ fontSize: isCompactMetric ? 12 : 13, fontWeight: 780, lineHeight: 1.25, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {generatedTitle}
              </div>
              <div style={generatedMetaRowStyle}>
                {generatedTrust ? <TrustPill trust={generatedTrust} /> : null}
                {genUi ? <span style={generatedMetaPillStyle}>{componentLabelForGenUi(genUi)}</span> : null}
                {genUi?.layoutIntent ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(String(genUi.layoutIntent))}</span> : null}
              </div>
            </div>
            {editable && generatedVizOptions.length > 1 ? (
              <GeneratedVizSwitcher
                value={normalizeChartType(item.viz.type)}
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
            {item.title ?? blockRef}
          </div>
          {aiPinTrust ? (
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <TrustPill trust={aiPinTrust} />
              <span style={generatedMetaPillStyle}>AI generated</span>
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
        <TileBody item={item} tile={tile} loading={loading} error={error} themeMode={themeMode} genUi={genUi} />
      </div>
      {!editable ? <TileInsightCaption tile={tile} themeMode={themeMode} /> : null}
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

function computeTileInsight(tile?: DashboardRunResponse['tiles'][number]): string | null {
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
  if (rows.length === 1) {
    const v = toNum((rows[0] as Record<string, unknown>)[valueCol]);
    return v !== undefined ? `${valueCol}: ${fmtNum(v)}.` : null;
  }
  const ranked = (rows as Array<Record<string, unknown>>)
    .map((r) => ({ label: labelCol ? String(r[labelCol] ?? '—') : 'top', value: toNum(r[valueCol]) ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const total = ranked.reduce((s, e) => s + e.value, 0);
  const top = ranked[0];
  if (!top) return null;
  return total > 0
    ? `${top.label} leads ${valueCol} at ${fmtNum(top.value)} (${Math.round((top.value / total) * 100)}%).`
    : `${top.label} leads ${valueCol} at ${fmtNum(top.value)}.`;
}

function fmtNum(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
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
  return (
    <div style={generatedVizSwitcherStyle} aria-label="Visualization">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.label}
          onClick={(event) => {
            event.stopPropagation();
            onChange(option.value);
          }}
          style={generatedVizButtonStyle(value === option.value)}
        >
          {iconForChartType(option.value)}
        </button>
      ))}
    </div>
  );
}

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
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
  genUi?: DqlGenUiMetadata | null;
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
    return <MarkdownTile markdown={tile.text?.markdown ?? ''} variant={tile.viz?.type === 'heading' ? 'heading' : 'text'} themeMode={themeMode} />;
  }
  if (tile?.tileType === 'aiPin' && tile.aiPin) {
    return <AiPinSummary pin={tile.aiPin} result={tile.result} themeMode={themeMode} />;
  }
  if (error && !tile) return <span>{error}</span>;
  if (!tile) return <span>No run result.</span>;
  if (tile.status === 'unauthorized') return <span>Not authorized.</span>;
  if (tile.status === 'unresolved') return <span>{tile.error ?? 'Block reference unresolved.'}</span>;
  if (tile.status === 'error') return <span>{tile.error ?? 'Tile failed.'}</span>;
  if (!tile.result) return <span>No result.</span>;

  const chartConfig = mergeTileChartConfig(item, tile.chartConfig as CellChartConfig | undefined);
  const chart = String(chartConfig.chart ?? tile.viz?.type ?? '').toLowerCase();
  if (chart === 'table' || item.viz.type === 'table' || item.viz.type === 'pivot') {
    if (genUi?.component === 'EvidenceTable' || genUi?.component === 'PivotTable') {
      return <GeneratedEvidenceTable result={tile.result} genUi={genUi} themeMode={themeMode} />;
    }
    return <div style={{ width: '100%', alignSelf: 'stretch' }}><TableOutput result={tile.result} themeMode={themeMode} /></div>;
  }
  return <div style={{ width: '100%', alignSelf: 'stretch' }}><ChartOutput result={tile.result} themeMode={themeMode} chartConfig={chartConfig} /></div>;
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
  const chartConfig = mergeTileChartConfig(item, tile?.chartConfig as CellChartConfig | undefined);
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

  const patchConfig = (patch: Partial<CellChartConfig>) => {
    const next = compactChartConfig({ ...chartConfig, ...patch });
    const dashboardViz = chartToDashboardViz(next.chart);
    const currentGenUi = getDqlGenUi(item);
    const options: Record<string, unknown> = { ...next };
    if (currentGenUi) {
      options.dqlGenUi = { ...currentGenUi, defaultVisualization: dashboardViz };
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
          <input
            value={chartConfig.title ?? item.title ?? ''}
            onChange={(event) => patchConfig({ title: event.target.value || undefined })}
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
          <div style={{ fontSize: 13, fontWeight: 780, lineHeight: 1.25 }}>{genUi.insightTitle ?? title}</div>
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

  return (
    <div style={generatedEvidenceStyle}>
      <div style={{ fontSize: 11.5, color: theme.textSecondary }}>
        {rowCount} {rowCount === 1 ? 'row' : 'rows'} across {columns.length} {columns.length === 1 ? 'field' : 'fields'}
      </div>
      <div style={generatedEvidenceRowsStyle}>
        {rows.slice(0, 4).map((row, index) => {
          const label = labelColumn ? formatEvidenceValue(row[labelColumn]) : `Row ${index + 1}`;
          const status = statusColumn ? formatEvidenceValue(row[statusColumn]) : null;
          return (
            <div key={index} style={generatedEvidenceRowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 760, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
                {detailColumns.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
                    {detailColumns.map((column) => (
                      <span key={column} style={generatedEvidenceMiniPillStyle}>
                        {formatGenUiLabel(column)}: {formatEvidenceValue(row[column])}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-start', minWidth: 0 }}>
                {metricColumns.map((column) => (
                  <span key={column} style={generatedEvidenceMetricStyle}>
                    <span style={{ opacity: 0.62 }}>{formatGenUiLabel(column)}</span>
                    <strong>{formatEvidenceValue(row[column])}</strong>
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
  result,
  themeMode,
}: {
  pin: NonNullable<DashboardRunResponse['tiles'][number]['aiPin']>;
  result?: QueryResult;
  themeMode: ThemeMode;
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
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: pin.certification === 'certified' ? '#15803d' : '#b45309', background: pin.certification === 'certified' ? 'rgba(22,163,74,0.1)' : 'rgba(245,158,11,0.12)', border: `1px solid ${pin.certification === 'certified' ? 'rgba(22,163,74,0.22)' : 'rgba(245,158,11,0.24)'}`, borderRadius: 999, padding: '3px 7px' }}>
          {pin.certification === 'certified' ? 'Certified' : 'Review required'}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--color-text-muted, rgba(0,0,0,0.58))' }}>Pinned report insight</span>
      </div>
      <div style={{ minWidth: 0 }}>
        {renderMarkdown(pin.answer, theme)}
      </div>
      {result?.rows?.length ? <AiPinEvidencePreview result={result} /> : null}
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
                    {formatEvidenceValue(row[column])}
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

function getDashboardItemBlockId(item: DashboardLayoutItem): string | null {
  if (!item.block) return null;
  return 'blockId' in item.block ? item.block.blockId ?? null : item.block.ref ?? null;
}

function mergeTileChartConfig(
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number],
  base?: CellChartConfig,
): CellChartConfig {
  const options = (item.viz.options ?? {}) as Partial<CellChartConfig>;
  return {
    ...(base ?? {}),
    ...options,
    chart: normalizeChartType(String(options.chart ?? base?.chart ?? item.viz.type)),
    title: options.title ?? base?.title ?? item.title,
    colorPalette: options.colorPalette ?? base?.colorPalette ?? 'corporate',
  };
}

function normalizeChartType(value: unknown): ChartType {
  const normalized = String(value ?? 'table').toLowerCase().replace(/_/g, '-');
  if (normalized === 'single-value') return 'kpi';
  if (APP_CHART_TYPE_OPTIONS.some((option) => option.value === normalized)) return normalized as ChartType;
  return 'table';
}

function chartToDashboardViz(value: unknown): string {
  const chart = normalizeChartType(value);
  if (chart === 'table') return 'table';
  return chart.replace(/-/g, '_');
}

function compactChartConfig(config: CellChartConfig): CellChartConfig {
  const out: CellChartConfig = {};
  for (const [key, value] of Object.entries(config) as Array<[keyof CellChartConfig, unknown]>) {
    if (value === undefined || value === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  if (!out.chart) out.chart = 'table';
  return out;
}

function getDqlGenUi(item: DashboardLayoutItem): DqlGenUiMetadata | null {
  if (isRecord(item.display)) {
    const display = item.display;
    const component = typeof display.component === 'string' ? display.component : undefined;
    return {
      version: 1,
      component,
      role: roleForDisplayComponent(component),
      layoutIntent: typeof display.layoutIntent === 'string' ? display.layoutIntent : undefined,
      defaultVisualization: typeof display.defaultVisualization === 'string' ? display.defaultVisualization : undefined,
      allowedVisualizations: Array.isArray(display.allowedVisualizations) ? display.allowedVisualizations.filter((value): value is string => typeof value === 'string') : undefined,
      fieldHints: isRecord(display.fieldHints)
        ? Object.fromEntries(Object.entries(display.fieldHints).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : undefined,
      insightTitle: item.title,
      trustState: typeof display.trustState === 'string' ? display.trustState : undefined,
      reviewStatus: typeof display.reviewStatus === 'string' ? display.reviewStatus : undefined,
      rationale: typeof display.rationale === 'string' ? display.rationale : undefined,
    };
  }
  const raw = (item.viz.options as Record<string, unknown> | undefined)?.dqlGenUi;
  if (!isRecord(raw)) return null;
  return {
    version: typeof raw.version === 'number' ? raw.version : undefined,
    component: typeof raw.component === 'string' ? raw.component : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    layoutIntent: typeof raw.layoutIntent === 'string' ? raw.layoutIntent : undefined,
    defaultVisualization: typeof raw.defaultVisualization === 'string' ? raw.defaultVisualization : undefined,
    allowedVisualizations: Array.isArray(raw.allowedVisualizations) ? raw.allowedVisualizations.filter((value): value is string => typeof value === 'string') : undefined,
    fieldHints: isRecord(raw.fieldHints)
      ? Object.fromEntries(Object.entries(raw.fieldHints).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined,
    insightTitle: typeof raw.insightTitle === 'string' ? raw.insightTitle : undefined,
    trustState: typeof raw.trustState === 'string' ? raw.trustState : undefined,
    reviewStatus: typeof raw.reviewStatus === 'string' ? raw.reviewStatus : undefined,
    sourceNodeId: typeof raw.sourceNodeId === 'string' ? raw.sourceNodeId : undefined,
    followUpActions: Array.isArray(raw.followUpActions) ? raw.followUpActions.filter((value): value is string => typeof value === 'string') : undefined,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined,
  };
}

function textTileDisplay(
  viz: 'text' | 'heading',
  title: string,
): NonNullable<DashboardLayoutItem['display']> {
  return {
    mode: 'manual',
    component: viz === 'heading' ? 'NarrativePanel' : 'BusinessBrief',
    defaultVisualization: viz,
    allowedVisualizations: [viz],
    layoutIntent: viz === 'heading' ? 'wide' : 'standard',
    rationale: title ? `Manual narrative tile for "${title}" on this app surface.` : 'Manual narrative tile for this app surface.',
    trustState: 'review_required',
    reviewStatus: 'review_required',
  };
}

function displayWithVisualization(
  item: DashboardLayoutItem,
  dashboardViz: string,
  genUi?: DqlGenUiMetadata | null,
): DashboardLayoutItem['display'] | undefined {
  const allowed = uniqueStrings([
    dashboardViz,
    ...(item.display?.allowedVisualizations ?? []),
    ...(genUi?.allowedVisualizations ?? []),
  ]);
  const component = item.display?.component ?? componentForDashboardViz(dashboardViz);
  return {
    mode: item.display?.mode ?? (genUi ? 'ai_generated' : item.block ? 'block_hint' : 'manual'),
    component,
    defaultVisualization: dashboardViz,
    allowedVisualizations: allowed.length ? allowed : [dashboardViz],
    ...(item.display?.fieldHints || genUi?.fieldHints ? { fieldHints: item.display?.fieldHints ?? genUi?.fieldHints } : {}),
    layoutIntent: coerceLayoutIntent(item.display?.layoutIntent ?? genUi?.layoutIntent),
    rationale: item.display?.rationale ?? genUi?.rationale ?? 'Visualization selected for this consumer surface.',
    trustState: coerceTrustState(item.display?.trustState ?? genUi?.trustState),
    reviewStatus: coerceReviewStatus(item.display?.reviewStatus ?? genUi?.reviewStatus),
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())));
}

function componentForDashboardViz(viz: string): NonNullable<DashboardLayoutItem['display']>['component'] {
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return 'KpiMetric';
  if (viz === 'line' || viz === 'area') return 'TrendPanel';
  if (viz === 'bar' || viz === 'grouped_bar' || viz === 'stacked_bar' || viz === 'donut' || viz === 'pie') return 'RankingPanel';
  if (viz === 'pivot') return 'PivotTable';
  if (viz === 'text' || viz === 'heading') return 'NarrativePanel';
  return 'EvidenceTable';
}

function roleForDisplayComponent(component?: string): string | undefined {
  if (component === 'BusinessBrief') return 'business_summary';
  if (component === 'KpiMetric') return 'kpi';
  if (component === 'TrendPanel') return 'trend';
  if (component === 'RankingPanel') return 'breakdown';
  if (component === 'TrustCallout') return 'trust';
  if (component === 'ResearchActions') return 'research';
  if (component === 'NarrativePanel') return 'narrative';
  return component ? 'evidence' : undefined;
}

function isStakeholderHiddenReviewTile(item: DashboardLayoutItem): boolean {
  if (getDashboardItemBlockId(item) || item.aiPin) return false;
  const genUi = getDqlGenUi(item);
  const component = genUi?.component ?? item.display?.component;
  const role = genUi?.role ?? roleForDisplayComponent(component);
  const trustState = coerceTrustState(String(genUi?.trustState ?? item.display?.trustState ?? 'review_required'));
  if (component === 'TrustCallout' || component === 'ResearchActions' || role === 'trust' || role === 'research') return true;
  if (component !== 'NarrativePanel' && component !== 'BusinessBrief') return false;
  if (trustState === 'certified') return false;
  const text = [
    item.title,
    item.text?.markdown,
    item.display?.rationale,
    genUi?.rationale,
    genUi?.insightTitle,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(draft ready|review-required|review required|missing evidence|missing proof|trust gap|research drilldown|promote to a certified block|generated review placeholder|generated section)\b/.test(text);
}

function prepareStakeholderItems(
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
  cols: number,
): DashboardLayoutItem[] {
  const deduped = items.filter((item) => {
    return !isReviewRequiredAiPinStakeholderTile(item, tileResults.get(item.i))
      && !isRedundantStaticStakeholderTile(item, items, tileResults)
      && !isDuplicateAiPinStakeholderTile(item, items, tileResults);
  });
  const ranked = [...deduped].sort((a, b) => {
    const priority = stakeholderTilePriority(b, tileResults.get(b.i), cols) - stakeholderTilePriority(a, tileResults.get(a.i), cols);
    return priority !== 0 ? priority : layoutScore(a, cols) - layoutScore(b, cols);
  });
  return packDashboardItems(ranked, cols);
}

function isReviewRequiredAiPinStakeholderTile(item: DashboardLayoutItem, tile?: DashboardRunTile): boolean {
  if (!item.aiPin) return false;
  const certification = tile?.aiPin?.certification;
  const reviewStatus = tile?.aiPin?.reviewStatus;
  return certification !== 'certified' && reviewStatus !== 'certified';
}

function isDuplicateAiPinStakeholderTile(
  item: DashboardLayoutItem,
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
): boolean {
  if (!item.aiPin) return false;
  const fingerprint = aiPinStakeholderFingerprint(item, tileResults.get(item.i));
  if (!fingerprint) return false;
  const index = items.findIndex((candidate) => candidate.i === item.i);
  return items.some((candidate, candidateIndex) => {
    if (candidate.i === item.i || candidateIndex >= index || !candidate.aiPin) return false;
    return aiPinStakeholderFingerprint(candidate, tileResults.get(candidate.i)) === fingerprint;
  });
}

function aiPinStakeholderFingerprint(item: DashboardLayoutItem, tile?: DashboardRunTile): string {
  const pin = tile?.aiPin;
  const plan = pin?.analysisPlan && typeof pin.analysisPlan === 'object'
    ? pin.analysisPlan as Record<string, unknown>
    : null;
  const question = normalizeAiPinText(pin?.question) || normalizeAiPinText(item.title);
  const sourceBlock = normalizeAiPinText(plan?.sourceBlockId);
  const sourceTile = normalizeAiPinText(plan?.sourceTileId);
  const result = pin?.result ? aiPinResultFingerprint(pin.result) : '';
  if (!question && !sourceBlock && !sourceTile) return '';
  return [question, sourceBlock, sourceTile, result].filter(Boolean).join('|');
}

function normalizeAiPinText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aiPinResultFingerprint(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const record = result as { columns?: unknown; rows?: unknown };
  const columns = Array.isArray(record.columns) ? record.columns.map((column) => String(column).toLowerCase()).join(',') : '';
  const rows = Array.isArray(record.rows) ? record.rows.slice(0, 8).map((row) => stableFingerprintValue(row)).join(';') : '';
  return columns || rows ? `${columns}:${rows}` : '';
}

function stableFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableFingerprintValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${key}:${stableFingerprintValue(record[key])}`).join(',')}}`;
}

function stakeholderTilePriority(item: DashboardLayoutItem, tile: DashboardRunTile | undefined, cols: number): number {
  let score = 0;
  if (item.parameterBindings?.length) score += 5000;
  if (tile?.filters?.applied?.length) score += 4000;
  if (tile?.certificationStatus === 'certified') score += 1800;
  if (getDashboardItemBlockId(item)) score += 900;
  if (tile?.status === 'ok' && tile.result?.rows?.length) score += 500;
  score -= autoLayoutRank(item) * 80;
  score -= layoutScore(item, cols) / 1000;
  return score;
}

function isRedundantStaticStakeholderTile(
  item: DashboardLayoutItem,
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
): boolean {
  if (item.parameterBindings?.length || item.aiPin || !getDashboardItemBlockId(item)) return false;
  const tile = tileResults.get(item.i);
  const fingerprint = tile?.result ? stakeholderResultFingerprint(tile.result) : null;
  if (!fingerprint) return false;
  return items.some((candidate) => {
    if (candidate.i === item.i || !isFilterAwareStakeholderItem(candidate, tileResults.get(candidate.i))) return false;
    const candidateTile = tileResults.get(candidate.i);
    const candidateFingerprint = candidateTile?.result ? stakeholderResultFingerprint(candidateTile.result) : null;
    return Boolean(candidateFingerprint && sameStakeholderFingerprint(fingerprint, candidateFingerprint));
  });
}

function isFilterAwareStakeholderItem(item: DashboardLayoutItem, tile?: DashboardRunTile): boolean {
  return Boolean(item.parameterBindings?.length || tile?.filters?.applied?.length);
}

function stakeholderResultFingerprint(result: QueryResult): { columns: string; label: string; metric: string; metricValue: string } | null {
  const rows = result.rows ?? [];
  if (!rows.length) return null;
  const columns = result.columns?.length ? result.columns : Object.keys(rows[0] ?? {});
  if (!columns.length) return null;
  const labelColumn = pickStoryLabelColumn(columns, rows);
  const metricColumn = pickStoryMetricColumn(columns, rows);
  const first = rows[0];
  return {
    columns: columns.map((column) => column.toLowerCase()).sort().join('|'),
    label: labelColumn ? canonicalStakeholderValue(first[labelColumn]) : '',
    metric: metricColumn?.toLowerCase() ?? '',
    metricValue: metricColumn ? canonicalStakeholderValue(first[metricColumn]) : '',
  };
}

function sameStakeholderFingerprint(
  left: NonNullable<ReturnType<typeof stakeholderResultFingerprint>>,
  right: NonNullable<ReturnType<typeof stakeholderResultFingerprint>>,
): boolean {
  return left.columns === right.columns
    && left.label === right.label
    && left.metric === right.metric
    && left.metricValue === right.metricValue;
}

function canonicalStakeholderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildDashboardStory(
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
  variables: Record<string, unknown>,
): DashboardStory | null {
  const candidate = items
    .map((item, index) => ({ item, tile: tileResults.get(item.i), index }))
    .filter((entry): entry is { item: DashboardLayoutItem; tile: DashboardRunTile; index: number } => {
      return entry.tile?.status === 'ok'
        && Boolean(entry.tile.result)
        && Array.isArray(entry.tile.result?.rows)
        && entry.tile.result.rows.length > 0;
    })
    .sort((a, b) => {
      const scoreA = storyTileScore(a.item, a.tile, a.index);
      const scoreB = storyTileScore(b.item, b.tile, b.index);
      return scoreB - scoreA;
    })[0];
  if (!candidate?.tile.result) return null;

  const result = candidate.tile.result;
  const rows = result.rows;
  const columns = result.columns ?? Object.keys(rows[0] ?? {});
  if (!columns.length) return null;

  const genUi = getDqlGenUi(candidate.item);
  const labelColumn = pickStoryLabelColumn(columns, rows, genUi?.fieldHints?.label);
  const metricColumn = pickStoryMetricColumn(columns, rows, genUi?.fieldHints?.value ?? genUi?.fieldHints?.y);
  const first = rows[0];
  const second = rows[1];
  const firstLabel = labelColumn ? formatEvidenceValue(first[labelColumn]) : 'The leading result';
  const secondLabel = second && labelColumn ? formatEvidenceValue(second[labelColumn]) : null;
  const firstMetric = metricColumn ? toStoryNumber(first[metricColumn]) : null;
  const secondMetric = metricColumn && second ? toStoryNumber(second[metricColumn]) : null;
  const metricLabel = metricColumn ? storyMetricLabel(metricColumn) : null;
  const filters = storyFilterChips(variables);
  const filterPhrase = filters.length ? 'under the selected app filters' : 'in the current dashboard view';
  const sourceTitle = candidate.item.title ?? candidate.tile.title ?? getDashboardItemBlockId(candidate.item) ?? 'Dashboard result';
  const rowCount = result.rowCount ?? rows.length;
  const trust = candidate.tile.certificationStatus === 'certified'
    ? 'certified'
    : coerceTrustState(String(candidate.item.display?.trustState ?? genUi?.trustState ?? 'review_required'));
  const title = metricLabel ? `${formatGenUiLabel(metricLabel)} snapshot` : 'Dashboard snapshot';

  let summary: string;
  if (metricLabel && firstMetric !== null) {
    const leading = `${firstLabel} leads ${metricLabel} with ${formatEvidenceValue(firstMetric)}`;
    if (secondLabel && secondMetric !== null && Number.isFinite(firstMetric - secondMetric)) {
      const gap = Math.abs(firstMetric - secondMetric);
      summary = `${leading}, ahead of ${secondLabel} by ${formatEvidenceValue(gap)} ${filterPhrase}.`;
    } else {
      summary = `${leading} ${filterPhrase}.`;
    }
  } else {
    summary = `${sourceTitle} returned ${rowCount} ${rowCount === 1 ? 'row' : 'rows'} ${filterPhrase}.`;
  }

  return {
    title,
    summary,
    sourceTitle,
    trust,
    filters,
    chips: [
      `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`,
      columns.length ? `${columns.length} fields` : '',
    ].filter(Boolean),
  };
}

function storyTileScore(item: DashboardLayoutItem, tile: DashboardRunTile, index: number): number {
  const genUi = getDqlGenUi(item);
  const component = genUi?.component ?? item.display?.component;
  const result = tile.result;
  let score = 1000 - index;
  if (tile.certificationStatus === 'certified') score += 500;
  if (getDashboardItemBlockId(item)) score += 180;
  if (tile.filters?.applied?.length) score += 260;
  if (item.parameterBindings?.length) score += 220;
  if (component === 'RankingPanel' || component === 'EvidenceTable' || component === 'KpiMetric') score += 120;
  if (item.viz.type === 'table' || item.viz.type === 'bar' || item.viz.type === 'kpi') score += 70;
  if (result && pickStoryMetricColumn(result.columns, result.rows)) score += 80;
  if (result && pickStoryLabelColumn(result.columns, result.rows)) score += 50;
  return score;
}

function pickStoryLabelColumn(columns: string[], rows: QueryResult['rows'], hint?: string): string | undefined {
  const hinted = pickHintedColumn(columns, hint);
  if (hinted) return hinted;
  return columns.find((column) => /\b(player|customer|account|team|segment|category|name|label|title|entity)\b/i.test(column))
    ?? columns.find((column) => !isNumericColumn(column, rows) && !/\b(date|time|year|month|id)\b/i.test(column))
    ?? columns.find((column) => !isNumericColumn(column, rows));
}

function pickStoryMetricColumn(columns: string[], rows: QueryResult['rows'], hint?: string): string | undefined {
  const hinted = pickHintedColumn(columns, hint);
  if (hinted && isNumericColumn(hinted, rows)) return hinted;
  return columns
    .filter((column) => isNumericColumn(column, rows))
    .sort((a, b) => storyMetricRank(a) - storyMetricRank(b))[0];
}

function pickHintedColumn(columns: string[], hint?: string): string | undefined {
  const normalizedHint = hint?.toLowerCase().trim();
  if (!normalizedHint) return undefined;
  return columns.find((column) => {
    const lower = column.toLowerCase();
    return lower === normalizedHint || lower.includes(normalizedHint) || normalizedHint.includes(lower);
  });
}

function storyMetricRank(column: string): number {
  const lower = column.toLowerCase();
  if (/(total|revenue|amount|points|score|value|sales|arr|mrr)/.test(lower)) return 1;
  if (/(count|orders|games|customers|rows|volume)/.test(lower)) return 2;
  if (/(rate|pct|percent|ratio|margin|average|avg)/.test(lower)) return 3;
  if (/(rank|position|index)/.test(lower)) return 20;
  if (/(date|year|month|day|week|id)/.test(lower)) return 90;
  return 30;
}

function storyMetricLabel(column: string): string {
  return formatGenUiLabel(column).toLowerCase();
}

function storyFilterChips(variables: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(variables)
    .filter(([key, value]) => {
      if (/^(smartView|persona|dashboardId|appId)$/i.test(key)) return false;
      if (key.startsWith('__')) return false;
      if (value === null || value === undefined || value === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return typeof value !== 'object' || Array.isArray(value);
    })
    .slice(0, 6)
    .map(([key, value]) => ({
      label: formatGenUiLabel(key),
      value: Array.isArray(value) ? value.map((entry) => formatStoryFilterValue(key, entry)).join(', ') : formatStoryFilterValue(key, value),
    }));
}

function formatStoryFilterValue(key: string, value: unknown): string {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (/(season|year)/i.test(key) && Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200) {
    return String(numeric);
  }
  return formatEvidenceValue(value);
}

function toStoryNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function coerceLayoutIntent(value?: string): NonNullable<DashboardLayoutItem['display']>['layoutIntent'] {
  return value === 'compact' || value === 'standard' || value === 'wide' || value === 'tall' || value === 'full' || value === 'auto'
    ? value
    : 'auto';
}

function coerceTrustState(value?: string): NonNullable<DashboardLayoutItem['display']>['trustState'] {
  return value === 'certified' || value === 'draft_ready' || value === 'review_required' ? value : 'review_required';
}

function coerceReviewStatus(value?: string): NonNullable<DashboardLayoutItem['display']>['reviewStatus'] {
  return value === 'certified' || value === 'draft_ready' || value === 'review_required' ? value : 'review_required';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getGeneratedVizOptions(
  item: DashboardLayoutItem,
  genUi?: DqlGenUiMetadata | null,
): Array<{ value: ChartType; label: string }> {
  const allowed = new Set<string>([
    String(item.viz.type ?? 'table'),
    ...(genUi?.allowedVisualizations ?? []),
  ]);
  const values = Array.from(allowed)
    .map((value) => normalizeChartType(value))
    .filter((value, index, arr) => arr.indexOf(value) === index);
  return values
    .map((value) => APP_CHART_TYPE_OPTIONS.find((option) => option.value === value) ?? { value, label: formatGenUiLabel(value) })
    .filter((option) => option.value !== 'table' || values.length === 1 || item.block);
}

function tileSurfaceForGenUi(component?: string): string {
  if (component === 'TrustCallout') return 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,251,235,0.72))';
  if (component === 'RankingPanel' || component === 'TrendPanel' || component === 'PivotTable') return 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,252,0.86))';
  if (component === 'BusinessBrief') return 'var(--dql-app-surface, rgba(255,255,255,0.90))';
  return 'var(--dql-app-surface, var(--surface, rgba(255,255,255,0.84)))';
}

function iconForChartType(type: ChartType): JSX.Element {
  if (type === 'line' || type === 'area') return <LineChart size={13} strokeWidth={2.2} />;
  if (type === 'pie' || type === 'donut') return <PieChart size={13} strokeWidth={2.2} />;
  if (type === 'table') return <Table2 size={13} strokeWidth={2.2} />;
  return <BarChart3 size={13} strokeWidth={2.2} />;
}

function formatGenUiLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

function pickEvidenceLabelColumn(columns: string[], rows: QueryResult['rows'], hint?: string): string | undefined {
  if (columns.length === 0) return undefined;
  const normalizedHint = hint?.toLowerCase();
  if (normalizedHint) {
    const hinted = columns.find((column) => {
      const lower = column.toLowerCase();
      return lower === normalizedHint || lower.includes(normalizedHint) || normalizedHint.includes(lower);
    });
    if (hinted) return hinted;
  }
  return columns.find((column) => /\b(name|label|title|dataset|table|block|player|customer|account)\b/i.test(column))
    ?? columns.find((column) => !isNumericColumn(column, rows))
    ?? columns[0];
}

function evidenceMetricRank(column: string): number {
  const lower = column.toLowerCase();
  if (/(total|count|records|rows|volume)/.test(lower)) return 1;
  if (/(rate|percent|pct|score|quality|freshness)/.test(lower)) return 2;
  if (/(amount|revenue|arr|value)/.test(lower)) return 3;
  if (/(date|time|season)/.test(lower)) return 6;
  if (/(^|_)id($|_)/.test(lower)) return 20;
  return 100;
}

function isNumericColumn(column: string, rows: QueryResult['rows']): boolean {
  const sample = rows.slice(0, 8).map((row) => row[column]).filter((value) => value !== null && value !== undefined && value !== '');
  if (sample.length === 0) return false;
  return sample.every((value) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))));
}

function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'N/A';
  if (typeof value === 'number') return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value) : String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value);
  const numeric = Number(text);
  if (text.trim() !== '' && Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(text.trim())) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(numeric);
  }
  return text.replace(/_/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function autoTileSizeForViz(vizType: string, cols: number): { w: number; h: number } {
  const normalized = normalizeViz(vizType);
  if (normalized === 'heading') return tileSizeForPreset('wide', cols, 'heading');
  if (normalized === 'text') return tileSizeForPreset('standard', cols, 'text');
  if (normalized === 'single_value' || normalized === 'kpi' || normalized === 'gauge') {
    return tileSizeForPreset('compact', cols, normalized);
  }
  if (normalized === 'table' || normalized === 'pivot') return tileSizeForPreset('tall', cols, normalized);
  if (normalized === 'line' || normalized === 'area') return tileSizeForPreset('wide', cols, normalized);
  return tileSizeForPreset('standard', cols, normalized);
}

function autoTileSizeForItem(item: DashboardLayoutItem, cols: number): { w: number; h: number } {
  const genUi = getDqlGenUi(item);
  const preset = normalizeSizePreset(genUi?.layoutIntent);
  if (preset && preset !== 'auto') return tileSizeForPreset(preset, cols, String(item.viz.type ?? 'table'));
  return autoTileSizeForViz(normalizeViz(String(item.viz.type ?? 'table')), cols);
}

function narrowTileMinHeight(item: DashboardLayoutItem, genUi?: DqlGenUiMetadata | null): number {
  if (item.viz.type === 'heading') return 90;
  if (genUi?.component === 'BusinessBrief' || genUi?.component === 'NarrativePanel' || item.viz.type === 'text') return 180;
  if (genUi?.component === 'TrustCallout' || genUi?.component === 'ResearchActions') return 210;
  if (genUi?.component === 'EvidenceTable' || genUi?.component === 'PivotTable') return 330;
  if (genUi?.component === 'KpiMetric') return 150;
  return Math.max(280, Math.min(420, item.h * 76));
}

function tileSizeForPreset(preset: TileSizePresetId, cols: number, vizType = 'table'): { w: number; h: number } {
  const safeCols = Math.max(1, cols);
  const half = Math.max(1, Math.ceil(safeCols / 2));
  const third = Math.max(1, Math.ceil(safeCols / 3));
  if (preset === 'auto') return autoTileSizeForViz(vizType, safeCols);
  if (preset === 'compact') return { w: third, h: 2 };
  if (preset === 'wide') return { w: safeCols, h: vizType === 'heading' ? 1 : 4 };
  if (preset === 'tall') return { w: half, h: 6 };
  if (preset === 'full') return { w: safeCols, h: 7 };
  return { w: half, h: vizType === 'text' ? 2 : 4 };
}

function tileSizePatch(item: DashboardLayoutItem, cols: number, preset: TileSizePresetId): Partial<DashboardLayoutItem> {
  const vizType = String(item.viz.type ?? 'table');
  const size = preset === 'auto'
    ? autoTileSizeForItem(item, cols)
    : tileSizeForPreset(preset, cols, vizType);
  return {
    w: size.w,
    h: size.h,
    x: clamp(item.x, 0, Math.max(0, cols - size.w)),
  };
}

function presetMatches(item: DashboardLayoutItem, cols: number, preset: TileSizePresetId): boolean {
  const size = preset === 'auto'
    ? autoTileSizeForItem(item, cols)
    : tileSizeForPreset(preset, cols, String(item.viz.type ?? 'table'));
  return item.w === size.w && item.h === size.h;
}

function normalizeSizePreset(value?: string): TileSizePresetId | null {
  if (value === 'auto' || value === 'compact' || value === 'standard' || value === 'wide' || value === 'tall' || value === 'full') return value;
  return null;
}

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
function packDashboardItems(items: DashboardLayoutItem[], cols: number): DashboardLayoutItem[] {
  const safeCols = Math.max(1, cols);
  const occupied: boolean[][] = [];
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    for (let dy = 0; dy < h; dy++) {
      const row = occupied[y + dy];
      if (!row) continue;
      for (let dx = 0; dx < w; dx++) {
        if (row[x + dx]) return false;
      }
    }
    return true;
  };
  const mark = (x: number, y: number, w: number, h: number): void => {
    for (let dy = 0; dy < h; dy++) {
      const yy = y + dy;
      if (!occupied[yy]) occupied[yy] = new Array(safeCols).fill(false);
      for (let dx = 0; dx < w; dx++) occupied[yy][x + dx] = true;
    }
  };
  return items.map((item) => {
    const w = clamp(Math.round(item.w || 1), 1, safeCols);
    const h = Math.max(1, Math.round(item.h || 1));
    let px = 0;
    let py = 0;
    outer: for (let y = 0; ; y++) {
      for (let x = 0; x + w <= safeCols; x++) {
        if (fits(x, y, w, h)) {
          px = x;
          py = y;
          break outer;
        }
      }
    }
    mark(px, py, w, h);
    return { ...item, x: px, y: py, w, h };
  });
}

function reorderTileForDrop(items: DashboardLayoutItem[], moved: DashboardLayoutItem, cols: number): DashboardLayoutItem[] {
  const others = items
    .filter((item) => item.i !== moved.i)
    .sort((a, b) => layoutScore(a, cols) - layoutScore(b, cols));
  const targetScore = layoutScore(moved, cols);
  const insertAt = others.findIndex((item) => layoutScore(item, cols) > targetScore);
  if (insertAt === -1) return [...others, moved];
  return [
    ...others.slice(0, insertAt),
    moved,
    ...others.slice(insertAt),
  ];
}

function layoutScore(item: DashboardLayoutItem, cols: number): number {
  return item.y * cols + item.x;
}

// Clean enterprise reading order for Auto layout:
// headings → KPIs → charts → tables/pivots → text.
function autoLayoutRank(item: DashboardLayoutItem): number {
  const genUi = getDqlGenUi(item);
  if (genUi?.role === 'business_summary') return 0;
  if (genUi?.role === 'kpi') return 1;
  if (genUi?.component === 'RankingPanel' || genUi?.component === 'TrendPanel') return 2;
  if (genUi?.component === 'EvidenceTable' || genUi?.component === 'PivotTable') return 3;
  if (genUi?.component === 'TrustCallout' || genUi?.component === 'ResearchActions') return 4;
  if (genUi?.role === 'narrative') return 5;
  const viz = normalizeViz(String(item.viz.type ?? 'table'));
  if (viz === 'heading') return 0;
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return 1;
  if (viz === 'line' || viz === 'area' || viz === 'bar' || viz === 'pie' || viz === 'funnel' || viz === 'map') return 2;
  if (viz === 'table' || viz === 'pivot') return 3;
  if (viz === 'text') return 4;
  return 2;
}

function normalizeViz(chartType?: string): string {
  const value = (chartType ?? 'table').toLowerCase().replace(/-/g, '_');
  if (value === 'single_value' || value === 'kpi' || value === 'gauge' || value === 'line' || value === 'bar' || value === 'area'
    || value === 'pie' || value === 'pivot' || value === 'map' || value === 'funnel' || value === 'heading' || value === 'text') {
    return value;
  }
  return 'table';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
