import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties} from 'react';
import {
  ArrowLeft, BarChart3, Blocks, Bot, Check, ChevronDown, FileText, Filter,
  Gauge, Heading, LayoutDashboard, Monitor, MoreHorizontal, PanelRight,
  Play, Plus, Redo2, Search, Settings2, ShieldCheck, Smartphone, Sparkles, Table2,
  Trash2, Type, Undo2, Upload, X,
} from 'lucide-react';
import {
  api, DqlApiError,
  type AppBlockRecommendation,
  type AppAutopilotChangeProposal,
  type AppStudioAiProposal,
  type AppStudioBuildDraft,
  type AppStudioDraftOperation,
  type ContextAuthoringProposalV1,
  type DatasetAuthoringChange,
  type DatasetTileSaveAsBlockResponse,
  type SemanticTileConversionPreviewResponse,
  type DashboardDatasetHierarchyDrill,
  type DashboardRunResponse,
} from '../../api/client';
import type {
  DatasetDescriptor,
} from '@duckcodeailabs/dql-core/datasets/descriptor';
import {
  datasetTileVisualizationCompatibility,
  tileQueryOutputAliases,
  type TileQuery,
} from '@duckcodeailabs/dql-core/apps/tile-query';
import type { AppSummary } from '../../store/types';
import type { CellChartConfig } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import { AiSidePanel } from '../agent/AiSidePanel';
import { DatasetSourceAuthoringDialog, DatasetSourceRebindReviewDialog } from './builder/DatasetProposalDialog';
import { DatasetTileBuilder } from './builder/DatasetTileBuilder';
import { FiltersPanel, mergeStudioDateRanges, linkedComponentCount, type StudioFilterConfiguration } from './builder/GlobalFilterBar';
import { DatasetInteractionInspector, DatasetTileQueryInspector } from './builder/InteractionLayer';
import { humanize, messageOf, PanelTitle } from './builder/studio-ui';
import { usePersistedAgentThreadId } from '../agent/usePersistedAgentThreadId';
import { ContextProposalReviewDrawer } from '../modeling/ContextProposalReviewDrawer';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { APP_STUDIO_V2_STYLES } from './app-studio-v2-styles';
import {
  APP_STUDIO_AI_ACTIVITY_LABELS,
  appStudioProposalRetry,
  appStudioReviewAddRetry,
  appStudioRevisionRetry,
  appStudioSourceActionLabel,
  nextAppStudioAiActivityIndex,
  type AppStudioAiActivityRetry,
  type AppStudioSourceActionStatus,
} from './app-studio-ai-activity';
import {
  appStudioProposalRequestSourceIds,
  appStudioProposalSourceAddMode,
  appStudioProposalRequiredSourceIds,
  appStudioPlannerProvenanceLabel,
  availableAppStudioProposalSources,
  summarizeAppStudioAiPlan,
  type AppStudioAiPlanSummary,
} from './app-studio-ai-plan';
import {
  datasetFilterBindingsForSelection,
  discoverAppFilterCandidates,
  filterTileMappingsForField,
  type StudioRuntimeFilterFields,
} from './app-studio-filter-candidates';
import {
  hydrateAppScopedDashboardFilterValues,
  isAppScopedDashboardFilter,
  pagesForDashboardFilterValue,
} from './app-dashboard-filter-scope';
import { formatDatasetGrainEvidenceKeyCheck } from './dataset-grain-evidence';
import {
  appendDatasetHierarchyDrill,
  datasetMarkActions,
  datasetMarkSelectionForRow,
  carriedNavigationVariables,
  popDatasetHierarchyDrill,
  proposeDatasetCrossFilterLinks,
  type DatasetCrossFilterLinkProposal,
  type RuntimeDatasetHierarchyDrillCandidate,
} from './app-dataset-interactions';
import {
  datasetTileNotices,
  isCurrentDatasetTileEvidence,
  presentDatasetTileEvidence,
  type DatasetEvidenceRow,
  type DatasetTileEvidencePresentation,
} from './dataset-tile-evidence';
import {
  blockingPublicationReviewTasks,
  isDatasetBackedAppSource,
  legacySemanticTilesNeedingApproval,
  localPublicationSteps,
  pagesNeedingSettledPreview,
  planLegacySemanticApproval,
  publicationBlockerCount,
  publicationBlockingSources,
  publicationIssueSummaries,
  unresolvedPublicationRequirements,
} from './app-studio-publish-readiness';
import {
  isDatasetSourceRecoveryTask,
  runDatasetSourceRecoveryAction,
} from './app-dataset-source-recovery';
import {
  runDatasetSourceRebindAction,
} from './app-dataset-source-rebind';
import {
  datasetSourceAuthoringModel,
} from './app-dataset-source-authoring';
import {
  mergeStudioPartialPreview,
  settleStudioPreviewRun,
  withoutPagePreviewReceipt,
} from './app-studio-preview-settlement';

// Moved to builder/; re-exported for existing callers and tests.
export { DatasetSourceAuthoringDialog, DatasetSourceRebindReviewDialog, DatasetTileBuilder };

const UnifiedAgentRunPanel = lazy(() => import('../agent/UnifiedAgentRunPanel')
  .then((module) => ({ default: module.UnifiedAgentRunPanel })));

type StudioPanel = 'pages' | 'sources' | 'filters' | 'templates';
type StudioBreakpoint = 'wide' | 'medium' | 'narrow';
type StudioPreviewMode = 'auto' | StudioBreakpoint;
type StudioTemplate = AppStudioBuildDraft['template'];

type StudioFilterAvailability = {
  values: string[];
  truncated: boolean;
  valueCount?: number;
  dateRange?: { min: string; max: string };
};

/**
 * App Studio uses the current preview only to decide whether its repair
 * shortcut is useful. The server repeats the same authority check before it
 * ever dispatches a provider, so this never authorizes a repair by itself.
 */
export type AppAutopilotRepairShortcutAvailability = 'failed_tile' | 'healthy' | 'preview_required';

type AppAutopilotPrompt = { label: string; prompt: string };

export function appAutopilotRepairShortcutAvailability(
  selectedTile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] | null,
  previewRun: DashboardRunResponse | null,
): AppAutopilotRepairShortcutAvailability {
  if (!selectedTile?.sourceId || !selectedTile.query || !previewRun || previewRun.stale || previewRun.partial) {
    return 'preview_required';
  }
  const previewTile = previewRun.tiles.find((tile) => tile.tileId === selectedTile.i && tile.tileType === 'dataset');
  if (previewTile?.status === 'error') return 'failed_tile';
  if (previewTile?.status === 'ok') return 'healthy';
  return 'preview_required';
}

export function appAutopilotExamplePrompts(
  repairAvailability: AppAutopilotRepairShortcutAvailability,
): AppAutopilotPrompt[] {
  const prompts: AppAutopilotPrompt[] = [
    { label: 'Group selected tile', prompt: 'Group the selected chart by Region.' },
    { label: 'Explain selected tile', prompt: 'Explain what the selected Dataset tile can show and which approved fields support it.' },
  ];
  if (repairAvailability === 'failed_tile') {
    prompts.push({ label: 'Repair selected tile', prompt: 'What is the smallest governed repair needed before this selected tile can answer its intended question?' });
  }
  return prompts;
}

function appAutopilotRepairShortcutHint(
  repairAvailability: AppAutopilotRepairShortcutAvailability,
): string {
  if (repairAvailability === 'healthy') {
    return 'The current preview is healthy, so there is no failed Dataset tile to repair. You can still change its title, layout, grouping, or visualization.';
  }
  if (repairAvailability === 'failed_tile') {
    return 'This tile failed in the current preview. AI can prepare a governed repair for you to review.';
  }
  return 'Run a preview before asking AI to repair a failed tile.';
}

/** Runtime-only selection from an actual settled Dataset result. The source
 * identity is retained so the server can reject a stale or mismatched tile. */
type StudioDatasetCrossFilter = {
  fromTileId: string;
  fromSourceId: string;
  fromSourceRevision: string;
  field: string;
  values: unknown[];
};

type AppStudioAiActivity = {
  status: 'running' | 'error';
  retry: AppStudioAiActivityRetry;
  returnToProposal: boolean;
  error?: string;
};

type AppStudioSourceFeedback = {
  sourceId: string;
  status: Exclude<AppStudioSourceActionStatus, 'idle'>;
  view: 'KPI' | 'Chart' | 'Table';
  pageTitle: string;
  message?: string;
};

export interface AppStudioLaunchConfig {
  mode: 'ai' | 'manual';
  prompt: string;
  name: string;
  template: StudioTemplate;
  sourcePolicy: AppStudioBuildDraft['sourcePolicy'];
}

export interface AppStudioV2Props {
  initialMode: 'ai' | 'manual';
  initialPrompt: string;
  initialName?: string;
  initialDraftId?: string | null;
  initialSourcePolicy?: AppStudioBuildDraft['sourcePolicy'];
  initialTemplate?: StudioTemplate;
  startImmediately?: boolean;
  baseAppId?: string | null;
  domain?: string;
  audience?: string;
  themeMode: ThemeMode;
  onBack: () => void;
  onPublished: (app: AppSummary, dashboardId?: string) => void;
  onDraftDeleted: (recovery: { appName: string; recoveryId: string }) => void;
}

const TEMPLATE_OPTIONS: Array<{ id: StudioTemplate; title: string; description: string }> = [
  { id: 'executive_brief', title: 'Executive Brief', description: 'Editorial summary, KPI band, decision evidence, and appendix.' },
  { id: 'operational_dashboard', title: 'Operational Dashboard', description: 'Filters, KPIs, trends, drivers, and operating detail.' },
  { id: 'investigation', title: 'Investigation', description: 'Question, findings, comparisons, caveats, and evidence.' },
  { id: 'blank', title: 'Blank canvas', description: 'Start with one clean responsive page.' },
];

export function AppStudioLaunchSurface({
  config,
  busy = false,
  error,
  onChange,
  onSubmit,
}: {
  config: AppStudioLaunchConfig;
  busy?: boolean;
  error?: string | null;
  onChange: (patch: Partial<AppStudioLaunchConfig>) => void;
  onSubmit: () => void;
}): JSX.Element {
  const canSubmit = config.mode === 'ai' ? Boolean(config.prompt.trim()) : Boolean(config.name.trim());
  return <section className="dql-app-studio-home" aria-labelledby="app-studio-home-title">
    <style>{APP_STUDIO_V2_STYLES}</style>
    <div className="dql-studio-v2-intro">
      <span className="eyebrow"><Sparkles size={14} /> DQL App Studio 2.0</span>
      <h1 id="app-studio-home-title">Start with the decision.<br />Shape the experience together.</h1>
      <p>AI and manual authoring use one private draft, one responsive canvas, and one governed path to Project publication.</p>
    </div>
    <div className="dql-studio-v2-start-card">
      <div className="mode-switch" role="tablist" aria-label="Authoring mode">
        <button type="button" role="tab" aria-selected={config.mode === 'ai'} className={config.mode === 'ai' ? 'on' : ''} onClick={() => onChange({ mode: 'ai', template: config.template === 'blank' ? 'operational_dashboard' : config.template })}><Sparkles size={16} /> Describe with AI</button>
        <button type="button" role="tab" aria-selected={config.mode === 'manual'} className={config.mode === 'manual' ? 'on' : ''} onClick={() => onChange({ mode: 'manual', template: 'blank', name: config.name || 'Untitled Analytics App' })}><LayoutDashboard size={16} /> Start manually</button>
      </div>
      <label className="primary-field">
        <span>{config.mode === 'ai' ? 'What decision should this App support?' : 'What should this App be called?'}</span>
        {config.mode === 'ai'
          ? <textarea value={config.prompt} onChange={(event) => onChange({ prompt: event.target.value })} placeholder="Build a weekly revenue health App for finance leaders with trends, drivers, and customer detail." rows={4} />
          : <input value={config.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="Revenue Operations" />}
      </label>
      {config.mode === 'ai' ? <div className="ai-launch-explainer"><span><Sparkles size={16} /></span><div><strong>AI selects governed data and creates an editable first draft</strong><small>Next, review the actual blocks, semantic sources, components, and gaps before applying anything.</small></div></div> : null}
      <details className="launch-options" open={config.mode === 'manual'}>
        <summary><span>Starting layout</span><strong>{TEMPLATE_OPTIONS.find((option) => option.id === config.template)?.title ?? 'Operational Dashboard'}</strong><ChevronDown size={15} /></summary>
        <div className="template-grid">
          {TEMPLATE_OPTIONS.map((option) => <button key={option.id} type="button" className={config.template === option.id ? 'on' : ''} onClick={() => onChange({ template: option.id })}><span>{templateIcon(option.id)}</span><strong>{option.title}</strong><small>{option.description}</small></button>)}
        </div>
      </details>
      <section className="studio-source-policy-row" aria-label="App source policy">
        <header><span className="policy-mark"><ShieldCheck size={17} /></span><p><strong>Governed sources only</strong><small>Certified blocks and governed semantic sources. Recommended for every App.</small></p></header>
        <label className="studio-review-toggle"><input type="checkbox" checked={config.sourcePolicy === 'include_review_required'} onChange={(event) => onChange({ sourcePolicy: event.target.checked ? 'include_review_required' : 'governed_only' })} /><i aria-hidden="true" /><span><strong>Also allow review-required analysis</strong><small>Stays local and cannot publish until replaced, promoted, or removed.</small></span></label>
      </section>
      {error ? <div className="studio-error" role="alert">{error}</div> : null}
      <button type="button" className="launch-action" onClick={onSubmit} disabled={busy || !canSubmit}>{busy ? 'Preparing local draft…' : config.mode === 'ai' ? <><Sparkles size={17} /> Generate editable App</> : <><LayoutDashboard size={17} /> Open blank Studio</>}</button>
      <small className="launch-next-step">Private local draft first · review sources and preview results · publish only when ready</small>
    </div>
  </section>;
}

function AppStudioAiActivitySurface({
  activity,
  label,
  onBack,
  onReturn,
  onRetry,
}: {
  activity: AppStudioAiActivity;
  label: string;
  onBack: () => void;
  onReturn?: () => void;
  onRetry: () => void;
}): JSX.Element {
  return <section className="dql-studio-v2-loading studio-ai-activity" aria-labelledby="studio-ai-activity-title" aria-busy={activity.status === 'running'}>
    <style>{APP_STUDIO_V2_STYLES}</style>
    <button type="button" className="icon" onClick={onBack} aria-label="Back to Apps"><ArrowLeft size={18} /></button>
    <div>
      <span className="loading-mark"><Sparkles size={20} /></span>
      {activity.status === 'running' ? <>
        <strong id="studio-ai-activity-title">Preparing your editable App proposal</strong>
        <small className="studio-ai-activity-label" role="status" aria-live="polite">{label}</small>
        <small>Sources remain governed or review-required exactly as cataloged. You will review them before the canvas is generated.</small>
      </> : <>
        <strong id="studio-ai-activity-title">The source proposal needs another try</strong>
        <small role="alert">{activity.error ?? 'App Studio could not prepare the source proposal.'}</small>
        <span className="studio-ai-activity-actions">{onReturn ? <button type="button" onClick={onReturn}>Back to source review</button> : null}<button type="button" className="primary" onClick={onRetry}>Try AI proposal again</button></span>
      </>}
    </div>
  </section>;
}

export function AppStudioV2({
  initialMode,
  initialPrompt,
  initialName = '',
  initialDraftId,
  initialSourcePolicy = 'governed_only',
  initialTemplate,
  startImmediately = false,
  baseAppId,
  domain,
  audience,
  themeMode,
  onBack,
  onPublished,
  onDraftDeleted,
}: AppStudioV2Props): JSX.Element {
  const [draft, setDraft] = useState<AppStudioBuildDraft | null>(null);
  const [mode, setMode] = useState<'ai' | 'manual'>(initialMode);
  const [sourcePolicy, setSourcePolicy] = useState<AppStudioBuildDraft['sourcePolicy']>(initialSourcePolicy);
  const [template, setTemplate] = useState<StudioTemplate>(initialTemplate ?? (initialMode === 'manual' ? 'blank' : 'operational_dashboard'));
  const [prompt, setPrompt] = useState(initialPrompt);
  const [name, setName] = useState(initialName);
  const [panel, setPanel] = useState<StudioPanel>('sources');
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 820);
  const [previewMode, setPreviewMode] = useState<StudioPreviewMode>('auto');
  const [workspaceWidth, setWorkspaceWidth] = useState(1260);
  const [activePageId, setActivePageId] = useState('overview');
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<AppBlockRecommendation | null>(null);
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogNextCursor, setCatalogNextCursor] = useState<string | undefined>();
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);
  const [datasetTilesEnabled, setDatasetTilesEnabled] = useState(false);
  const [enablingDatasets, setEnablingDatasets] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AppStudioAiProposal | null>(null);
  const [selectedProposalSourceIds, setSelectedProposalSourceIds] = useState<Set<string>>(new Set());
  const [proposalAddingSourceId, setProposalAddingSourceId] = useState<string | null>(null);
  const [aiActivity, setAiActivity] = useState<AppStudioAiActivity | null>(null);
  const [aiActivityIndex, setAiActivityIndex] = useState(0);
  const [sourceFeedback, setSourceFeedback] = useState<AppStudioSourceFeedback | null>(null);
  const [undoStack, setUndoStack] = useState<AppStudioBuildDraft[]>([]);
  const [redoStack, setRedoStack] = useState<AppStudioBuildDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState('Local draft');
  const [previewRunsByPage, setPreviewRunsByPage] = useState<Record<string, DashboardRunResponse>>({});
  const [previewing, setPreviewing] = useState(false);
  const [savingDatasetTileId, setSavingDatasetTileId] = useState<string | null>(null);
  const [replacingDatasetTileId, setReplacingDatasetTileId] = useState<string | null>(null);
  const [previewingSemanticConversionTileId, setPreviewingSemanticConversionTileId] = useState<string | null>(null);
  const [acceptingSemanticConversionTileId, setAcceptingSemanticConversionTileId] = useState<string | null>(null);
  /** Saved review drafts are local UI affordances, never source authority. */
  const [savedDatasetReviewDrafts, setSavedDatasetReviewDrafts] = useState<Record<string, Extract<DatasetTileSaveAsBlockResponse, { ok: true }>>>({});
  const [semanticTileConversionPreviews, setSemanticTileConversionPreviews] = useState<Record<string, Extract<SemanticTileConversionPreviewResponse, { ok: true }>>>({});
  // App-scoped selections are separate from page values. A page added after a
  // selection should hydrate from this state only when it declares the App
  // control; same-id page-local controls remain local.
  const [previewAppScopedFilterValues, setPreviewAppScopedFilterValues] = useState<Record<string, unknown>>({});
  const [previewVariablesByPage, setPreviewVariablesByPage] = useState<Record<string, Record<string, unknown>>>({});
  const [previewCrossFiltersByPage, setPreviewCrossFiltersByPage] = useState<Record<string, StudioDatasetCrossFilter[]>>({});
  /** Read-only hierarchy exploration state. This is never serialized into the App draft. */
  const [previewHierarchyDrillsByPage, setPreviewHierarchyDrillsByPage] = useState<Record<string, DashboardDatasetHierarchyDrill[]>>({});
  const [filterOptionsByPage, setFilterOptionsByPage] = useState<Record<string, Record<string, StudioFilterAvailability>>>({});
  const [draggingTileId, setDraggingTileId] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [publishReviewOpen, setPublishReviewOpen] = useState(false);
  const [publishIssues, setPublishIssues] = useState<string[]>([]);
  const [datasetAuthoringSource, setDatasetAuthoringSource] = useState<AppBlockRecommendation | null>(null);
  const [datasetAuthoringProposal, setDatasetAuthoringProposal] = useState<ContextAuthoringProposalV1 | null>(null);
  const [datasetRebindPrompt, setDatasetRebindPrompt] = useState<{ sourceId: string; title: string } | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  /** One AI entry point: compose or revise the page, or change the selected tile. */
  const [aiScope, setAiScope] = useState<'page' | 'tile'>('page');
  /** The tile whose query and compiled SQL are shown inline on the canvas. */
  const [dqlTileId, setDqlTileId] = useState<string | null>(null);
  const [copilotExpanded, setCopilotExpanded] = useState(false);
  const [copilotRunning, setCopilotRunning] = useState(false);
  const [autopilotTileSelectionRequested, setAutopilotTileSelectionRequested] = useState(false);
  /** An immutable universal AgentRun artifact, never an App-side chat draft. */
  const [autopilotReview, setAutopilotReview] = useState<AppAutopilotChangeProposal | null>(null);
  const draggingTileIdRef = useRef<string | null>(null);
  const immediateStartRef = useRef(false);
  const previewSequenceRef = useRef(0);
  const previewRunScopeRef = useRef(createAppStudioPreviewRunScope());
  const filterPreviewTimerRef = useRef<number | null>(null);
  const sourceFeedbackTimerRef = useRef<number | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  // The App keeps one durable universal-AI thread. The selected page/tile/run
  // key filters which immutable thread turns are presented as current; it does
  // not create a new thread for every preview or discard audit history.
  const copilotThread = usePersistedAgentThreadId(`app-studio:${draft?.id ?? initialDraftId ?? 'new'}`);

  useEffect(() => {
    const adaptStudioShell = () => {
      const width = window.innerWidth;
      setPanelOpen(width > 820);
    };
    adaptStudioShell();
    window.addEventListener('resize', adaptStudioShell);
    return () => window.removeEventListener('resize', adaptStudioShell);
  }, []);

  useEffect(() => {
    const node = workspaceRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(Math.max(0, Math.floor(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft]);

  useEffect(() => {
    if (aiActivity?.status !== 'running') return;
    setAiActivityIndex(0);
    if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      setAiActivityIndex((current) => nextAppStudioAiActivityIndex(current));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [aiActivity?.status, aiActivity?.retry.requiredSourceIds.join('|')]);

  useEffect(() => {
    let active = true;
    setBusy(Boolean(baseAppId || initialDraftId));
    void api.listAppBuilds().then(async (result) => {
      if (!active) return;
      const localDrafts = result.drafts.filter((item) => item.state !== 'project_published');
      if (initialDraftId) {
        const selected = localDrafts.find((item) => item.id === initialDraftId);
        if (!selected) throw new Error('The local App draft is no longer available.');
        setDraft(selected);
        setName(selected.name);
        setActivePageId(selected.pages[0]?.id ?? 'overview');
        setSavedMessage('Resumed local draft');
        return;
      }
      if (!baseAppId) return;
      const existing = localDrafts.find((item) => item.baseApp?.appId === baseAppId);
      const resolved = existing ?? (await api.createAppBuild({
        baseAppId,
        goal: prompt.trim() || 'Edit this governed App',
        audience,
        domain,
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      })).draft;
      if (!active) return;
      setDraft(resolved);
      setName(resolved.name);
      setActivePageId(resolved.pages[0]?.id ?? 'overview');
      setSavedMessage('Safe local edit draft');
    }).catch((cause) => {
      if (active && (baseAppId || initialDraftId)) setError(messageOf(cause));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [baseAppId, initialDraftId]);

  useEffect(() => {
    if (!draft) return;
    let active = true;
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    const timer = window.setTimeout(() => {
      void api.listAppSourceCandidates(draft.id, {
        query: catalogQuery,
        limit: 50,
      }, controller.signal).then((page) => {
        if (!active) return;
        setCatalog(page.items);
        setCatalogNextCursor(page.nextCursor);
        setCatalogTotal(page.total);
        setDatasetTilesEnabled(page.features?.datasets === true);
      }).catch((cause) => {
        if (active && !controller.signal.aborted) {
          setCatalog([]);
          setCatalogError(messageOf(cause));
        }
      }).finally(() => { if (active) setCatalogLoading(false); });
    }, catalogQuery ? 180 : 0);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [catalogRefreshNonce, draft?.id, draft?.sourcePolicy, catalogQuery]);

  useEffect(() => {
    const handleAskResult = (event: Event) => {
      const detail = (event as CustomEvent<{
        draft?: AppStudioBuildDraft;
        pageId?: string;
        tileId?: string;
      }>).detail;
      if (!detail?.draft || detail.draft.id !== draft?.id) return;
      previewSequenceRef.current += 1;
      setPreviewing(false);
      setPreviewRunsByPage({});
      setPreviewHierarchyDrillsByPage({});
      setFilterOptionsByPage({});
      setDraft(detail.draft);
      setName(detail.draft.name);
      setActivePageId(detail.pageId ?? detail.draft.pages[0]?.id ?? 'overview');
      setSelectedTileId(detail.tileId ?? null);
      setProposal(null);
      setAutopilotReview(null);
      setSavedMessage('Ask result added · loading preview…');
    };
    window.addEventListener('dql-app-build-updated', handleAskResult);
    return () => window.removeEventListener('dql-app-build-updated', handleAskResult);
  }, [draft?.id]);

  const activePage = useMemo(
    () => draft?.pages.find((page) => page.id === activePageId) ?? draft?.pages[0] ?? null,
    [activePageId, draft],
  );
  const previewVariablesForPage = (
    page: AppStudioBuildDraft['pages'][number],
    pageValues = previewVariablesByPage[page.id] ?? {},
    appValues = previewAppScopedFilterValues,
  ): Record<string, unknown> => hydrateAppScopedDashboardFilterValues({
    filters: page.filters ?? [],
    pageValues,
    appValues,
  });
  const previewRun = activePage ? previewRunsByPage[activePage.id] ?? null : null;
  const previewVariables = activePage ? previewVariablesForPage(activePage) : {};
  const previewCrossFilters = activePage ? previewCrossFiltersByPage[activePage.id] ?? [] : [];
  const previewHierarchyDrills = activePage ? previewHierarchyDrillsByPage[activePage.id] ?? [] : [];
  const activeFilterOptions = activePage ? filterOptionsByPage[activePage.id] ?? {} : {};
  const breakpoint: StudioBreakpoint = previewMode === 'auto'
    ? workspaceWidth < 720 ? 'narrow' : workspaceWidth < 1120 ? 'medium' : 'wide'
    : previewMode;
  const visibleItems = useMemo(() => {
    if (!activePage) return [];
    const projection = activePage.layout.responsive?.[breakpoint];
    const columns = breakpoint === 'wide' ? 12 : breakpoint === 'medium' ? 6 : 1;
    return packStudioItems(collapseTemplateIntroductions(projection?.items ?? activePage.layout.items, draft?.template), columns);
  }, [activePage, breakpoint, draft?.template]);
  const selectedTile = activePage?.layout.items.find((item) => item.i === selectedTileId) ?? null;
  const selectedDatasetTile = selectedTile?.sourceId && selectedTile.query ? selectedTile : null;
  const autopilotRepairAvailability = appAutopilotRepairShortcutAvailability(selectedDatasetTile, previewRun);
  const selectAppAutopilotTile = (tileId: string) => {
    setSelectedTileId(tileId);
    setAutopilotTileSelectionRequested(false);
  };
  // Only a selected Dataset tile is a valid App Autopilot target. A heading or
  // narrative component can stay selected for its inspector without making a
  // server response disappear behind a mismatched presentation key.
  const autopilotPresentationScope = appAutopilotPresentationContextKey({
    draftId: draft?.id ?? initialDraftId ?? undefined,
    pageId: activePageId,
    tileId: selectedDatasetTile?.i,
    previewRunId: previewRun?.runId,
  });
  useEffect(() => {
    // A proposal belongs to the exact context in which it was generated. It
    // remains in the immutable AgentRun history, but cannot be applied after a
    // page, tile, or preview switch presents a new current context.
    setAutopilotReview(null);
  }, [autopilotPresentationScope]);
  const filteredCatalog = catalog;
  const runtimeFilterFields = useMemo<StudioRuntimeFilterFields>(() => Object.fromEntries(
    Object.entries(previewRunsByPage).map(([pageId, run]) => [pageId, Object.fromEntries(
      run.tiles.map((tile) => [tile.tileId, tile.filterableColumns ?? []]),
    )]),
  ), [previewRunsByPage]);
  const filterCandidates = useMemo(
    () => discoverAppFilterCandidates(draft?.pages ?? [], catalog, runtimeFilterFields, draft?.sources ?? []),
    [catalog, draft?.pages, draft?.sources, runtimeFilterFields],
  );
  const proposalSummary = useMemo(() => proposal ? summarizeAppStudioAiPlan(proposal) : null, [proposal]);
  const publishStepCount = useMemo(
    () => draft ? publicationBlockerCount(draft, publishIssues) : 0,
    [draft, publishIssues],
  );

  useEffect(() => {
    setSelectedProposalSourceIds(new Set(proposal?.defaultSelectedSourceIds ?? proposalSummary?.sources.map((source) => source.id) ?? []));
  }, [proposal, proposalSummary]);

  useEffect(() => {
    if (!proposalSummary || selectedSource || catalog.length === 0) return;
    const sourceRefs = new Set(proposalSummary.sources.map((source) => source.label.toLowerCase()));
    const match = catalog.find((item) => sourceRefs.has(humanize(item.name).toLowerCase()))
      ?? catalog.find((item) => proposalSummary.components.some((component) => component.source === item.id || component.source === item.name));
    if (match) setSelectedSource(match);
  }, [catalog, proposalSummary, selectedSource]);

  const createDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createAppBuild({
        baseAppId: baseAppId ?? undefined,
        name: name.trim() || undefined,
        goal: prompt.trim() || name.trim() || 'Create a governed analytical App',
        audience,
        domain,
        authoringMode: mode,
        sourcePolicy,
        template,
      });
      setDraft(result.draft);
      setName(result.draft.name);
      setActivePageId(result.draft.pages[0]?.id ?? 'overview');
      setSavedMessage('Saved locally');
      setPreviewRunsByPage({});
      setPreviewVariablesByPage({});
      setFilterOptionsByPage({});
      if (mode === 'ai') {
        setAiActivityIndex(0);
        setAiActivity({ status: 'running', retry: appStudioProposalRetry(prompt, []), returnToProposal: false });
        await requestAiProposal(result.draft, prompt, [], false);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const requestAiProposal = async (
    base = draft,
    nextPrompt = prompt,
    selectedBlockIds?: string[],
    returnToProposal = Boolean(proposal),
  ): Promise<boolean> => {
    if (!base) return false;
    const requiredSourceIds = appStudioProposalRequestSourceIds(selectedBlockIds, selectedSource?.id);
    const retry = appStudioProposalRetry(nextPrompt, requiredSourceIds ?? []);
    setAiActivityIndex(0);
    setAiActivity({ status: 'running', retry, returnToProposal });
    setBusy(true);
    setError(null);
    try {
      const result = await api.proposeAppBuildChanges(base.id, {
        prompt: nextPrompt.trim() || base.frame.goal,
        expectedRevision: base.revision,
        proposalHash: base.proposalHash,
        selectedBlockIds: requiredSourceIds,
      });
      setProposal(result.proposal);
      setAiActivity(null);
      setCopilotOpen(false);
      setSavedMessage('AI plan ready for review');
      return true;
    } catch (cause) {
      const message = messageOf(cause);
      setSavedMessage('AI proposal needs attention');
      setAiActivity({ status: 'error', retry, returnToProposal, error: message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reviseAiProposal = async (
    answers?: Record<string, string>,
    requiredSourceIds = Array.from(selectedProposalSourceIds),
    showActivity = true,
  ): Promise<boolean> => {
    if (!draft || !proposal) return false;
    const exactRequiredIds = Array.from(new Set(requiredSourceIds.filter(Boolean)));
    const retry = appStudioRevisionRetry(answers, exactRequiredIds);
    if (showActivity) {
      setAiActivityIndex(0);
      setAiActivity({ status: 'running', retry, returnToProposal: true });
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.reviseAppBuildProposal(draft.id, proposal.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        answers,
        selectedSourceIds: exactRequiredIds,
      });
      setProposal(result.proposal);
      if (showActivity) setAiActivity(null);
      setSavedMessage('AI proposal revised on the server');
      return true;
    } catch (cause) {
      const message = messageOf(cause);
      if (showActivity) {
        setAiActivity({ status: 'error', retry, returnToProposal: true, error: message });
      } else {
        setError(message);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const generateAiGap = async (requirementId: string) => {
    if (!draft || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.generateAppBuildGap(draft.id, proposal.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        requirementId,
      });
      // A missing source is never converted into an app-local SQL tile. The
      // server returns an immutable, compile-checked Dataset draft proposal;
      // the existing App plan remains untouched until an author explicitly
      // reviews and saves that separate source definition.
      setDatasetAuthoringProposal(result.contextProposal);
      setSavedMessage('Review the typed Dataset draft for this uncovered requirement');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const addSourceToAiProposal = async (
    sourceId: string,
    reviewRequired: boolean,
    source?: AppBlockRecommendation,
  ) => {
    if (!draft || !proposal || !proposalSummary) return;
    const requiredSourceIds = appStudioProposalRequiredSourceIds(selectedProposalSourceIds, sourceId);
    const addMode = appStudioProposalSourceAddMode({
      alreadyProposed: proposalSummary.sources.some((candidate) => candidate.id === sourceId),
      reviewRequired,
      sourcePolicy: draft.sourcePolicy,
    });
    if (source) setSelectedSource(source);
    if (addMode === 'select_existing') {
      setSelectedProposalSourceIds((current) => new Set([...current, sourceId]));
      return;
    }
    setProposalAddingSourceId(sourceId);
    try {
      if (addMode === 'enable_review_and_replan') {
        const retry = appStudioReviewAddRetry(prompt, sourceId, requiredSourceIds);
        setAiActivityIndex(0);
        setAiActivity({ status: 'running', retry, returnToProposal: true });
        const next = await mutate([{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }]);
        if (!next) {
          setAiActivity({
            status: 'error',
            retry,
            returnToProposal: true,
            error: 'The review lane could not be enabled. Your existing proposal is unchanged.',
          });
          return;
        }
        await requestAiProposal(next, prompt, requiredSourceIds, true);
      } else {
        await reviseAiProposal(undefined, requiredSourceIds, false);
      }
    } finally {
      setProposalAddingSourceId(null);
    }
  };

  const retryAiActivity = (activity: AppStudioAiActivity) => {
    const retry = activity.retry;
    if (retry.kind === 'revise') {
      void reviseAiProposal(retry.answers, retry.requiredSourceIds, true);
      return;
    }
    if (retry.kind === 'enable_review_and_propose') {
      void addSourceToAiProposal(retry.sourceId, true);
      return;
    }
    void requestAiProposal(draft, retry.prompt, retry.requiredSourceIds, activity.returnToProposal);
  };

  useEffect(() => {
    if (!startImmediately || initialDraftId || baseAppId || draft || immediateStartRef.current) return;
    immediateStartRef.current = true;
    void createDraft();
  }, [baseAppId, draft, initialDraftId, startImmediately]);

  const mutate = async (operations: AppStudioDraftOperation[], recordHistory = true) => {
    if (!draft || operations.length === 0) return null;
    setBusy(true);
    setSavedMessage('Saving…');
    setError(null);
    try {
      const previous = draft;
      const keepVisiblePreview = operations.every(isPresentationOnlyOperation);
      const result = await api.patchAppBuild(draft.id, draft.revision, operations, draft.proposalHash);
      setDraft(result.draft);
      setAutopilotReview(null);
      if (!keepVisiblePreview) {
        previewSequenceRef.current += 1;
        setPreviewRunsByPage({});
        setPreviewHierarchyDrillsByPage({});
        setFilterOptionsByPage({});
        setSavedDatasetReviewDrafts({});
        setPreviewing(false);
      }
      if (recordHistory) {
        setUndoStack((items) => [...items.slice(-29), previous]);
        setRedoStack([]);
      }
      setSavedMessage('Saved locally');
      return result.draft;
    } catch (cause) {
      setSavedMessage('Save failed');
      setError(messageOf(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Saving a reusable block is intentionally not an App mutation. The route
   * receives only the current tile identity and optimistic guards; it reloads
   * current governed execution evidence on the server before creating a
   * separate review draft.
   */
  const saveDatasetTileAsReusableBlock = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.query) return;
    const run = previewRunsByPage[page.id];
    const runTile = run?.tiles.find((candidate) => candidate.tileId === tile.i);
    if (!run || !runTile || runTile.status !== 'ok' || !isCurrentDatasetTileEvidence(tile, runTile)) {
      setError('Run the current Dataset tile before saving it as a reusable review draft.');
      return;
    }
    setSavingDatasetTileId(tile.i);
    setError(null);
    try {
      const result = await api.saveDatasetTileAsBlock(draft.id, page.id, tile.i, {
        runId: run.runId,
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        name: tile.title?.trim() || undefined,
        domain: page.metadata.domain || undefined,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Reusable block was not saved');
        return;
      }
      setSavedDatasetReviewDrafts((current) => ({ ...current, [`${page.id}:${tile.i}`]: result }));
      setSavedMessage(`Reusable review draft saved at ${result.path}`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Reusable block was not saved');
    } finally {
      setSavingDatasetTileId((current) => current === tile.i ? null : current);
    }
  };

  /**
   * Replacement is deliberately not an ordinary patch: the server reruns the
   * saved block and current Dataset statement inside one read scope, then
   * writes the review-required App mutation atomically.
   */
  const replaceDatasetTileWithSavedBlock = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.query) return;
    const saved = savedDatasetReviewDrafts[`${page.id}:${tile.i}`];
    const run = previewRunsByPage[page.id];
    const runTile = run?.tiles.find((candidate) => candidate.tileId === tile.i);
    if (!saved?.replacementEligible) {
      setError('Save a current representable Dataset tile as a review draft before replacing it.');
      return;
    }
    if (!run || !runTile || runTile.status !== 'ok' || !isCurrentDatasetTileEvidence(tile, runTile)) {
      setError('Run the current Dataset tile before replacing it with a review draft.');
      return;
    }
    setReplacingDatasetTileId(tile.i);
    setError(null);
    try {
      const result = await api.replaceDatasetTileWithBlock(draft.id, page.id, tile.i, {
        runId: run.runId,
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        blockPath: saved.path,
        // The button is explicit about changing the source policy. The server
        // remains the authority for whether this acknowledgement is needed.
        enableReviewRequired: true,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Dataset tile was not replaced');
        return;
      }
      setUndoStack((items) => [...items.slice(-29), draft]);
      setRedoStack([]);
      setDraft(result.draft);
      previewSequenceRef.current += 1;
      setPreviewRunsByPage({});
      setPreviewHierarchyDrillsByPage({});
      setFilterOptionsByPage({});
      setSavedDatasetReviewDrafts({});
      setSavedMessage(`Replaced with review draft after equivalence proof ${result.equivalenceProofFingerprint.slice(0, 18)}…`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Dataset tile was not replaced');
    } finally {
      setReplacingDatasetTileId((current) => current === tile.i ? null : current);
    }
  };

  /**
   * Legacy semantic conversion is a two-step review flow. The first call is
   * non-mutating; the server returns a short-lived proposal only after it
   * proves the two governed paths in one current read scope.
   */
  const previewLegacySemanticConversion = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.semantic || tile.query) return;
    setPreviewingSemanticConversionTileId(tile.i);
    setError(null);
    try {
      const result = await api.previewSemanticTileConversion(draft.id, page.id, tile.i, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Dataset conversion was not previewed');
        return;
      }
      setSemanticTileConversionPreviews((current) => ({ ...current, [`${page.id}:${tile.i}`]: result }));
      setSavedMessage('Dataset conversion is ready for review · the App is unchanged');
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Dataset conversion was not previewed');
    } finally {
      setPreviewingSemanticConversionTileId((current) => current === tile.i ? null : current);
    }
  };

  /** Acceptance reruns proof under current authority before this local draft changes. */
  const acceptLegacySemanticConversion = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.semantic || tile.query) return;
    const preview = semanticTileConversionPreviews[`${page.id}:${tile.i}`];
    if (!preview) {
      setError('Preview the current legacy semantic tile before applying this Dataset conversion.');
      return;
    }
    setAcceptingSemanticConversionTileId(tile.i);
    setError(null);
    try {
      const result = await api.acceptSemanticTileConversion(draft.id, page.id, tile.i, preview.proposalId, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Dataset conversion was not applied');
        return;
      }
      setUndoStack((items) => [...items.slice(-29), draft]);
      setRedoStack([]);
      setDraft(result.draft);
      previewSequenceRef.current += 1;
      setPreviewRunsByPage({});
      setPreviewHierarchyDrillsByPage({});
      setFilterOptionsByPage({});
      setSavedDatasetReviewDrafts({});
      setSemanticTileConversionPreviews({});
      setSavedMessage(`Converted to a Dataset query after equivalence proof ${result.equivalenceProofFingerprint.slice(0, 18)}…`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Dataset conversion was not applied');
    } finally {
      setAcceptingSemanticConversionTileId((current) => current === tile.i ? null : current);
    }
  };

  /** The universal AgentRun artifact is an explicit review boundary. */
  const applyAutopilotChange = async () => {
    if (!draft || !autopilotReview) return;
    setCopilotRunning(true);
    setError(null);
    try {
      const previous = draft;
      const result = await api.applyAppAutopilotChange(autopilotReview.runId, autopilotReview.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        proposalHash: autopilotReview.proposalHash,
      });
      // A query change invalidates the complete draft's settled-preview and
      // preflight authority. Do not leave another page's old result looking
      // current after the server has cleared its draft receipts.
      previewSequenceRef.current += 1;
      setPreviewRunsByPage({});
      setPreviewAppScopedFilterValues({});
      setPreviewVariablesByPage({});
      setPreviewHierarchyDrillsByPage({});
      setPreviewCrossFiltersByPage({});
      setFilterOptionsByPage({});
      setPreviewing(false);
      setDraft(result.draft);
      setName(result.draft.name);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setSelectedTileId(autopilotReview.tileId);
      setAutopilotReview(null);
      setSavedMessage(`${result.deduped ? 'AI tile change was already applied locally' : 'AI tile change applied locally'} · run a fresh preview before publishing`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('AI tile change needs a fresh review or preview');
    } finally {
      setCopilotRunning(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal || !draft) return;
    setBusy(true);
    setError(null);
    setSavedMessage('Composing App…');
    try {
      const previous = draft;
      const result = await api.composeAppBuild(draft.id, {
        mode: 'ai',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        proposalId: proposal.id,
        selectedSourceIds: Array.from(selectedProposalSourceIds),
      });
      const next = result.draft;
      setDraft(next);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setPreviewRunsByPage({});
      setFilterOptionsByPage({});
      setProposal(null);
      setName(next.name);
      const generatedPage = next.pages[0];
      setActivePageId(generatedPage?.id ?? activePageId);
      if (generatedPage && pageHasDataTiles(generatedPage)) {
        setSavedMessage('App generated · loading governed data…');
        await runPreviewForDraft(next, generatedPage.id);
      }
    } catch (cause) {
      setSavedMessage('Compose failed');
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!draft || undoStack.length === 0) return;
    const target = undoStack[undoStack.length - 1];
    const current = draft;
    const next = await mutate(restoreOperations(current, target), false);
    if (!next) return;
    setUndoStack((items) => items.slice(0, -1));
    setRedoStack((items) => [...items, current]);
  };

  const redo = async () => {
    if (!draft || redoStack.length === 0) return;
    const target = redoStack[redoStack.length - 1];
    const current = draft;
    const next = await mutate(restoreOperations(current, target), false);
    if (!next) return;
    setRedoStack((items) => items.slice(0, -1));
    setUndoStack((items) => [...items, current]);
  };

  const addPage = async () => {
    if (!draft) return;
    const index = draft.pages.length + 1;
    const id = `page-${index}`;
    const page: AppStudioBuildDraft['pages'][number] = {
      // The public `upsert_page` reducer owns App-filter inheritance. It
      // promotes this new page to v3 only when a Dataset-bound App control
      // must retain its explicit empty mapping; Studio never copies bindings
      // or decides compatibility in the browser.
      version: 2,
      id,
      metadata: {
        title: `Page ${index}`,
        description: 'Responsive analytical page',
        domain: draft.pages[0]?.metadata.domain,
        audience: draft.frame.audience,
        visibility: 'private',
        lifecycle: 'draft',
      },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80, items: [],
        responsive: {
          wide: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
          medium: { kind: 'grid', cols: 6, rowHeight: 80, items: [] },
          narrow: { kind: 'grid', cols: 1, rowHeight: 80, items: [] },
        },
      },
    };
    const next = await mutate([{ type: 'upsert_page', page }]);
    if (next) setActivePageId(id);
  };

  const selectSource = (source: AppBlockRecommendation) => {
    setSelectedSource(source);
    setError(null);
  };

  /**
   * Source authoring is intentionally separate from adding a field tile. The
   * dialog only accepts a current block Dataset catalog row; semantic models
   * remain provider-owned and cannot be relabelled as a DQL source patch.
   */
  const openDatasetAuthoring = (source: AppBlockRecommendation) => {
    if (!datasetSourceAuthoringModel(source)) {
      setError(source.capabilities?.dataset?.kind === 'semantic'
        ? 'This semantic Dataset is owned by its provider model. Update the governed provider definition, then refresh App sources.'
        : 'Refresh this source before authoring its Dataset definition.');
      return;
    }
    setDatasetAuthoringProposal(null);
    setDatasetAuthoringSource(source);
    setError(null);
  };

  const previewDatasetAuthoringChange = async (change: DatasetAuthoringChange) => {
    if (!draft || !datasetAuthoringSource) return;
    setBusy(true);
    setError(null);
    setSavedMessage('Preparing reviewed Dataset definition…');
    try {
      const proposal = await api.createContextProposal({
        origin: 'manual',
        operations: [{
          id: `dataset-change-${crypto.randomUUID()}`,
          kind: 'dataset_change',
          change,
          evidence: [
            `App Studio source ${datasetAuthoringSource.sourceId ?? datasetAuthoringSource.id}`,
            `Dataset source revision ${datasetAuthoringSource.sourceRevision ?? datasetAuthoringSource.fingerprint}`,
          ],
        }],
      });
      setDatasetAuthoringSource(null);
      setDatasetAuthoringProposal(proposal);
      setSavedMessage('Review the exact Dataset definition change');
    } catch (cause) {
      setSavedMessage('Dataset definition needs attention');
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const finishDatasetAuthoringProposal = (proposal: ContextAuthoringProposalV1) => {
    setDatasetAuthoringProposal(null);
    // Source acceptance writes only the DQL definition. Existing App bindings
    // remain revision-pinned until the author deliberately refreshes them.
    setSelectedSource(null);
    setCatalogRefreshNonce((current) => current + 1);
    setSavedMessage(proposal.status === 'committed'
      ? 'Dataset definition saved as review-required. Refresh this App’s Dataset binding explicitly to use it.'
      : 'Dataset proposal closed without changing this App binding.');
    setPanel('sources');
    setPanelOpen(true);
  };

  /**
   * Refresh is a second, deliberate operation after a reviewed source change.
   * It always resolves the current catalog immediately, so the same action is
   * available after a browser or CLI restart rather than depending on a
   * transient "just accepted" proposal state.
   */
  const refreshDatasetBinding = async (sourceId: string, enableReviewPreview = false) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSavedMessage('Checking the current Dataset definition…');
    try {
      const result = await runDatasetSourceRebindAction({
        draft,
        sourceId,
        enableReviewPreview,
        resolveCandidates: (draftId, sourceIds, options) => api.resolveAppSourceCandidates(draftId, sourceIds, options),
        patchDraft: (draftId, expectedRevision, operations, expectedProposalHash) => (
          api.patchAppBuild(draftId, expectedRevision, operations, expectedProposalHash)
        ),
        onPreviewInvalidated: () => {
          previewSequenceRef.current += 1;
          setPreviewRunsByPage({});
          setFilterOptionsByPage({});
          setPreviewing(false);
        },
      });
      if (!result.ok) {
        if (result.code === 'REVIEW_POLICY_REQUIRED') {
          const title = catalog.find((item) => (item.sourceId ?? item.id) === sourceId)?.name
            ?? draft.sources.find((source) => source.id === sourceId)?.sourceRef
            ?? sourceId;
          setDatasetRebindPrompt({ sourceId, title });
          setSavedMessage('Review policy choice required');
        } else {
          setSavedMessage('Dataset binding still needs attention');
          setError(result.error);
        }
        return;
      }
      const previous = draft;
      setDraft(result.draft);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setPublishIssues([]);
      setDatasetRebindPrompt(null);
      setCatalogRefreshNonce((current) => current + 1);
      setSavedMessage(result.plan.requiresReviewPolicy
        ? 'Dataset binding refreshed for local review preview · Project publication remains blocked'
        : 'Dataset binding refreshed · run a current preview');
    } catch (cause) {
      setSavedMessage('Dataset binding refresh failed');
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const datasetLinkProposal = (page: AppStudioBuildDraft['pages'][number], tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => (
    busy || previewing ? undefined : proposeDatasetCrossFilterLinks({
      page,
      tile,
      descriptorFor: (binding) => draft?.sources.find((source) => source.id === binding.sourceId && source.sourceRevision === binding.sourceRevision)?.capabilities?.dataset,
    })
  );
  // One click saves the proposed mappings as ordinary page interactions; the
  // author can inspect or remove each one in the tile's Interactions panel.
  const linkDatasetTileField = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => {
    if (!activePage) return;
    const proposal = datasetLinkProposal(activePage, tile);
    if (!proposal) return;
    const existing = activePage.interactions?.crossFilter?.mappings ?? [];
    void mutate([{
      type: 'set_interactions',
      pageId: activePage.id,
      interactions: {
        ...(activePage.interactions ?? {}),
        crossFilter: { ...(activePage.interactions?.crossFilter ?? {}), mappings: [...existing, ...proposal.mappings] },
      },
    }]);
  };

  const enableDatasetTiles = async () => {
    setEnablingDatasets(true);
    const result = await api.enableDatasetTiles();
    setEnablingDatasets(false);
    if (!result.ok) {
      setCatalogError(result.error || 'DQL could not turn on field-based tiles for this project.');
      return;
    }
    setCatalogRefreshNonce((current) => current + 1);
    // Tiles that were refused while the feature was off can run now.
    void runPreview();
  };

  const loadMoreSources = async () => {
    if (!draft || !catalogNextCursor || catalogLoading) return;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const page = await api.listAppSourceCandidates(draft.id, {
        query: catalogQuery,
        cursor: catalogNextCursor,
        limit: 50,
      });
      setCatalog((current) => {
        const seen = new Set(current.map((source) => source.id));
        return [...current, ...page.items.filter((source) => !seen.has(source.id))];
      });
      setCatalogNextCursor(page.nextCursor);
      setCatalogTotal(page.total);
      setDatasetTilesEnabled(page.features?.datasets === true);
    } catch (cause) {
      setCatalogError(messageOf(cause));
    } finally {
      setCatalogLoading(false);
    }
  };

  const addComponent = async (
    kind: 'heading' | 'text' | 'kpi' | 'chart' | 'table',
    sourceOverride?: AppBlockRecommendation | null,
    datasetQuery?: TileQuery,
    datasetTitle?: string,
  ) => {
    if (!draft || !activePage) return;
    const source = kind === 'heading' || kind === 'text'
      ? null
      : sourceOverride === undefined ? selectedSource : sourceOverride;
    if (kind !== 'heading' && kind !== 'text' && !source) {
      setPanel('sources');
      setPanelOpen(true);
      setError('Choose a governed source, then use Add to page.');
      return;
    }
    if (source) {
      const sourceId = source.sourceId ?? source.id;
      const view = componentKindLabel(kind as 'kpi' | 'chart' | 'table');
      const enableReviewRequired = source.eligibility?.localPreview === false && draft.sourcePolicy === 'governed_only';
      setSelectedSource(source);
      if (sourceFeedbackTimerRef.current !== null) window.clearTimeout(sourceFeedbackTimerRef.current);
      setSourceFeedback({ sourceId, status: 'adding', view, pageTitle: activePage.metadata.title });
      setBusy(true);
      setSavedMessage('Composing source…');
      setError(null);
      try {
        const previous = draft;
        const result = await api.composeAppBuild(draft.id, {
          mode: 'manual',
          expectedRevision: draft.revision,
          expectedProposalHash: draft.proposalHash,
          enableReviewRequired,
          selections: [{
            sourceId,
            pageId: activePage.id,
            view: kind as 'kpi' | 'chart' | 'table',
            ...(datasetQuery ? { query: datasetQuery } : {}),
            ...(datasetTitle?.trim() ? { title: datasetTitle.trim() } : {}),
          }],
        });
        setDraft(result.draft);
        setUndoStack((items) => [...items.slice(-29), previous]);
        setRedoStack([]);
        setSelectedTileId(result.tileIds[0] ?? null);
        setSourceFeedback({ sourceId, status: 'added', view, pageTitle: activePage.metadata.title });
        sourceFeedbackTimerRef.current = window.setTimeout(() => {
          setSourceFeedback((current) => current?.sourceId === sourceId ? null : current);
          sourceFeedbackTimerRef.current = null;
        }, 1800);
        setSavedMessage(`${kind === 'chart' ? 'Chart' : humanize(kind)} added · loading data…`);
        previewSequenceRef.current += 1;
        setPreviewRunsByPage({});
        setFilterOptionsByPage({});
        await runPreviewForDraft(result.draft, activePage.id);
      } catch (cause) {
        const message = messageOf(cause);
        setSavedMessage('Compose failed');
        setSourceFeedback({ sourceId, status: 'error', view, pageTitle: activePage.metadata.title, message });
        setError(message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (kind !== 'heading' && kind !== 'text') return;
    const tileId = `${kind}-${Date.now().toString(36)}`;
    const width = 12;
    const height = kind === 'heading' ? 1 : 2;
    const nextY = activePage.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] = {
      i: tileId,
      x: 0,
      y: nextY,
      w: width,
      h: height,
      title: kind === 'heading' ? 'Section heading' : 'Narrative',
      text: { markdown: kind === 'heading' ? '## New section' : 'Add context, interpretation, or guidance.' },
      sourceClass: 'narrative',
      viz: { type: kind === 'heading' ? 'heading' : 'text' },
      trustState: 'draft_ready',
      reviewStatus: 'draft_ready',
    };
    const operations: AppStudioDraftOperation[] = [{ type: 'add_tile', pageId: activePage.id, tile }];
    const next = await mutate(operations);
    if (next) {
      setSelectedTileId(tileId);
      setSavedMessage(`${humanize(kind)} added`);
    }
  };

  const arrangePage = async () => {
    if (!activePage || !draft) return;
    const items = packStudioItems(collapseTemplateIntroductions(activePage.layout.items, draft.template), 12);
    const next = await mutate([{ type: 'set_layout', pageId: activePage.id, layout: { ...activePage.layout, items } }]);
    if (next) setSavedMessage('Page arranged · preview preserved');
  };

  const saveFilter = async (configuration: StudioFilterConfiguration) => {
    if (!draft || !activePage) return;
    const selected = new Set(configuration.selectedMappingKeys);
    const mappings = filterTileMappingsForField(draft.pages, catalog, configuration.fieldId, runtimeFilterFields, draft.sources);
    if (!mappings.some((mapping) => mapping.supported)) {
      setError('This field is not available on a compatible component.');
      return;
    }
    const operations: AppStudioDraftOperation[] = [];
    for (const page of draft.pages) {
      const pageMappings = mappings.filter((mapping) => mapping.pageId === page.id);
      const linkedMappings = pageMappings.filter((mapping) => mapping.supported && selected.has(mapping.key));
      const datasetMappings = pageMappings.filter((mapping) => (
        mapping.supported && Boolean(mapping.datasetId && mapping.datasetField)
      ));
      // An App-scoped control is one durable logical definition on every
      // page. A page that has no compatible Dataset still retains that
      // control without a made-up field binding, so the runtime can surface a
      // specific unmapped/excluded state instead of silently dropping the App
      // filter when a page or Dataset is added later.
      const shouldAddToPage = configuration.scope === 'app'
        || ((linkedMappings.length > 0 || datasetMappings.length > 0) && page.id === activePage.id);
      const existingFilter = (page.filters ?? []).some((filter) => filter.id === configuration.id);
      if (shouldAddToPage) {
        // A Dataset may back several field-query components. Preserve the
        // author's exact selection instead of collapsing it into a Dataset-
        // wide mapping, including an explicit empty selection.
        const datasetBindings = datasetFilterBindingsForSelection(datasetMappings, selected);
        operations.push({
          type: 'set_filter',
          pageId: page.id,
          filter: {
            id: configuration.id,
            label: configuration.label.trim() || humanize(configuration.fieldId),
            type: configuration.type,
            bindsTo: configuration.fieldId,
            field: { name: configuration.fieldId },
            required: configuration.required,
            multiple: configuration.type === 'multiselect',
            // A date-only control represents a calendar range. Persist the
            // browser's declared IANA zone so timestamp Dataset fields can
            // compile an exact start-inclusive/end-exclusive interval.
            ...(configuration.type === 'daterange' ? {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            } : {}),
            // A page/app filter must still visit unmapped Dataset tiles so the
            // runtime can expose an explicit "not mapped" badge. Mapping is
            // carried by datasetBindings, never silently narrowed by scope.
            scope: configuration.scope === 'app' ? { app: true } : { page: page.id },
            // Preserve an explicit empty Dataset binding on an App-scoped
            // control. New/unmapped pages must surface an exclusion until an
            // author selects a source-qualified mapping.
            ...(configuration.scope === 'app' || Object.keys(datasetBindings).length ? { datasetBindings } : {}),
            optionSource: { mode: 'distinct_query', field: configuration.fieldId, limit: 100 },
          },
        });
      } else if (existingFilter) {
        operations.push({ type: 'remove_filter', pageId: page.id, filterId: configuration.id });
      }
      for (const tile of page.layout.items.filter((item) => item.block || item.semantic || item.draftAnalysis)) {
        const mapping = pageMappings.find((item) => item.tileId === tile.i);
        const currentBindings = tile.filterBindings ?? [];
        const nextBindings = currentBindings.filter((binding) => binding.filter !== configuration.id);
        if (shouldAddToPage && mapping?.supported && selected.has(mapping.key)) {
          nextBindings.push({
            filter: configuration.id,
            binding: mapping.binding ?? configuration.fieldId,
            mode: mapping.mode ?? 'predicate',
            required: configuration.required,
            capability: 'preflight_required',
          });
        }
        if (JSON.stringify(nextBindings) !== JSON.stringify(currentBindings)) {
          operations.push({ type: 'update_tile', pageId: page.id, tileId: tile.i, patch: { filterBindings: nextBindings } });
        }
      }
    }
    const next = await mutate(operations);
    if (!next) return;
    setPreviewVariablesByPage((current) => Object.fromEntries(Object.entries(current).map(([pageId, variables]) => {
      if (next.pages.find((page) => page.id === pageId)?.filters?.some((filter) => filter.id === configuration.id)) return [pageId, variables];
      const { [configuration.id]: _removed, ...rest } = variables;
      return [pageId, rest];
    })));
    const nextPage = next.pages.find((page) => page.id === activePage.id);
    if (nextPage && pageHasDataTiles(nextPage)) {
      setSavedMessage(`${configuration.label.trim() || humanize(configuration.fieldId)} filter linked · refreshing ${linkedComponentCount(next, configuration.id)} components…`);
      await runPreviewForDraft(next, activePage.id, previewVariablesByPage[activePage.id] ?? {});
    } else {
      setSavedMessage(`${configuration.label.trim() || humanize(configuration.fieldId)} filter saved`);
    }
  };

  const removeFilter = async (filterId: string) => {
    if (!draft || !activePage) return;
    const operations: AppStudioDraftOperation[] = [];
    for (const page of draft.pages) {
      if ((page.filters ?? []).some((filter) => filter.id === filterId)) {
        operations.push({ type: 'remove_filter', pageId: page.id, filterId });
      }
      for (const tile of page.layout.items.filter((item) => item.filterBindings?.some((binding) => binding.filter === filterId))) {
        operations.push({
          type: 'update_tile',
          pageId: page.id,
          tileId: tile.i,
          patch: { filterBindings: (tile.filterBindings ?? []).filter((binding) => binding.filter !== filterId) },
        });
      }
    }
    const nextVariablesByPage = Object.fromEntries(Object.entries(previewVariablesByPage).map(([pageId, variables]) => {
      const { [filterId]: _removed, ...rest } = variables;
      return [pageId, rest];
    }));
    setPreviewVariablesByPage(nextVariablesByPage);
    setPreviewAppScopedFilterValues((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, filterId)) return current;
      const { [filterId]: _removed, ...remaining } = current;
      return remaining;
    });
    setPreviewHierarchyDrillsByPage({});
    setFilterOptionsByPage((current) => Object.fromEntries(Object.entries(current).map(([pageId, options]) => {
      const { [filterId]: _removed, ...rest } = options;
      return [pageId, rest];
    })));
    const next = await mutate(operations);
    const nextPage = next?.pages.find((page) => page.id === activePage.id);
    if (next && nextPage && pageHasDataTiles(nextPage)) {
      setSavedMessage(`${humanize(filterId)} filter removed · refreshing linked components…`);
      await runPreviewForDraft(next, activePage.id, nextVariablesByPage[activePage.id] ?? {});
    } else if (next) {
      setSavedMessage(`${humanize(filterId)} filter removed`);
    }
  };

  const applyTemplate = async (nextTemplate: StudioTemplate) => {
    if (!draft || !activePage) return;
    const operations: AppStudioDraftOperation[] = [
      { type: 'set_template', template: nextTemplate },
      { type: 'upsert_page', page: studioTemplatePage(activePage, nextTemplate, draft.name) },
    ];
    await mutate(operations);
  };

  const moveTileBefore = async (targetTileId: string) => {
    const movingTileId = draggingTileIdRef.current ?? draggingTileId;
    if (!activePage || !movingTileId || movingTileId === targetTileId) return;
    const current = [...activePage.layout.items];
    const from = current.findIndex((item) => item.i === movingTileId);
    const to = current.findIndex((item) => item.i === targetTileId);
    if (from < 0 || to < 0) return;
    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    const ordered = current.map((item, index) => ({ ...item, x: 0, y: index }));
    const next = await mutate([{ type: 'set_layout', pageId: activePage.id, layout: { ...activePage.layout, items: packStudioItems(ordered, 12) } }]);
    draggingTileIdRef.current = null;
    setDraggingTileId(null);
    if (next) setSavedMessage('Layout saved · preview preserved');
  };

  const approveSemanticPreview = async () => {
    if (!draft || !activePage || !previewRun) {
      setError('Run this page successfully before approving governed semantic results.');
      return;
    }
    const approvalTiles = legacySemanticTilesNeedingApproval(draft);
    if (approvalTiles.length === 0) {
      // Dataset source lifecycle is catalog authority. Never manufacture a
      // legacy semantic approval or invalidate settled Dataset receipts here.
      setSavedMessage('No legacy semantic tile needs approval. Dataset source trust stays governed by its current contract.');
      return;
    }
    const approval = planLegacySemanticApproval(draft, activePage, previewRun);
    if (approval.operations.length === 0) {
      const pagesToPreview = approval.pendingPageIds
        .filter((pageId) => pageId !== activePage.id)
        .map((pageId) => draft.pages.find((page) => page.id === pageId)?.metadata.title ?? pageId);
      setError(pagesToPreview.length > 0
        ? `Open ${pagesToPreview.join(', ')} and run its preview before approving its governed semantic result.`
        : `Run ${activePage.metadata.title || activePage.id} successfully before approving its governed semantic result.`);
      return;
    }
    const next = await mutate(approval.operations);
    if (next) setSavedMessage('Semantic results approved · run preview once more');
  };

  const removeLocalAnalysisForPublication = async () => {
    if (!draft) return;
    const sources = publicationBlockingSources(draft)
      .filter((source) => source.kind !== 'governed_semantic' && source.kind !== 'semantic_query');
    if (sources.length === 0) return;
    const sourceIds = new Set(sources.map((source) => source.id));
    const sourceRefs = new Set(sources.flatMap((source) => [source.id, source.sourceRef, source.id.replace(/^[^:]+:/, '')]));
    const removedTiles = draft.pages.flatMap((page) => page.layout.items
      .filter((tile) => {
        const blockRef = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
        const refs = [tile.draftAnalysis?.ref, blockRef].filter((value): value is string => Boolean(value));
        return refs.some((ref) => sourceRefs.has(ref) || sourceRefs.has(ref.replace(/^[^:]+:/, '')));
      })
      .map((tile) => ({ pageId: page.id, tileId: tile.i })));
    const removedTileIds = new Set(removedTiles.map((tile) => tile.tileId));
    const operations: AppStudioDraftOperation[] = [
      ...removedTiles.map((tile): AppStudioDraftOperation => ({ type: 'remove_tile', pageId: tile.pageId, tileId: tile.tileId })),
      ...sources.map((source): AppStudioDraftOperation => ({ type: 'remove_source', sourceId: source.id })),
      ...draft.reviewTasks.filter((task) => (task.sourceId && sourceIds.has(task.sourceId)) || (task.tileId && removedTileIds.has(task.tileId)))
        .map((task): AppStudioDraftOperation => ({ type: 'remove_review_task', taskId: task.id })),
      {
        type: 'set_coverage',
        coverage: draft.coverage.map((coverage) => {
          const nextSourceIds = coverage.sourceIds.filter((id) => !sourceIds.has(id));
          const nextComponentIds = coverage.componentIds.filter((id) => !removedTileIds.has(id));
          return {
            ...coverage,
            sourceIds: nextSourceIds,
            componentIds: nextComponentIds,
            ...(coverage.status === 'covered' && (nextSourceIds.length === 0 || nextComponentIds.length === 0)
              ? { status: 'gap' as const, reasons: [...coverage.reasons, 'Review-required local analysis was removed from the publication draft.'] }
              : {}),
          };
        }),
      },
    ];
    const next = await mutate(operations);
    if (next) {
      setPublishIssues([]);
      setSavedMessage('Local analysis removed · Undo is available');
    }
  };

  const publish = async (publishWhenReady = true, targetDraft = draft) => {
    if (!targetDraft) return;
    setBusy(true);
    setError(null);
    try {
      // The confirmation button commits the exact preflight receipt already
      // shown as ready. Starting another preflight here caused readiness to
      // oscillate when source or preview state changed between two requests.
      if (publishWhenReady && targetDraft.state === 'preflight_ready' && localPublicationSteps(targetDraft).length === 0 && publishIssues.length === 0) {
        const result = await api.publishAppBuild(targetDraft.id, targetDraft.revision, targetDraft.proposalHash);
        setDraft(result.draft);
        setPublishReviewOpen(false);
        onPublished(result.app, result.draft.pages[0]?.id);
        return;
      }
      const preflight = await api.preflightAppBuild(targetDraft.id, targetDraft.revision, targetDraft.proposalHash);
      setDraft(preflight.draft);
      if (!publishWhenReady) {
        setPublishIssues([]);
        setPublishReviewOpen(true);
        return;
      }
      const result = await api.publishAppBuild(preflight.draft.id, preflight.draft.revision, preflight.draft.proposalHash);
      setDraft(result.draft);
      setPublishReviewOpen(false);
      onPublished(result.app, result.draft.pages[0]?.id);
    } catch (cause) {
      const details = cause instanceof DqlApiError && cause.details && typeof cause.details === 'object'
        ? cause.details as { errors?: unknown; draft?: unknown }
        : null;
      const errors = Array.isArray(details?.errors)
        ? details.errors.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (errors.length) {
        if (details?.draft && typeof details.draft === 'object') setDraft(details.draft as AppStudioBuildDraft);
        setPublishIssues(errors);
        setPublishReviewOpen(true);
      } else {
        setError(`Project publication needs attention. ${messageOf(cause)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const removeRequirementFromPublishScope = async (requirementId: string) => {
    if (!draft) return;
    const next = await mutate([{
      type: 'set_requirements',
      requirements: draft.requirements.map((requirement) => (
        requirement.id === requirementId ? { ...requirement, required: false } : requirement
      )),
      coverage: draft.coverage,
    }]);
    if (next) setPublishIssues([]);
  };

  const reviseRequirementWithAi = (question: string) => {
    if (!draft) return;
    const instruction = `Revise this App so it can answer this publish question with governed evidence: ${question}`;
    setPrompt(instruction);
    setPublishReviewOpen(false);
    void requestAiProposal(draft, instruction);
  };

  const answerBuildFrameQuestion = async (questionId: string, answerId: string) => {
    if (!draft) return;
    const clarificationQuestions = (draft.frame.clarificationQuestions ?? []).map((question) => (
      question.id === questionId ? { ...question, answerId } : question
    ));
    const next = await mutate([{ type: 'set_frame', frame: { ...draft.frame, clarificationQuestions } }]);
    if (next) setPublishIssues([]);
  };

  const refreshCertifiedSourceTrust = async () => {
    if (!draft) return;
    const operations: AppStudioDraftOperation[] = [];
    const blockSources = draft.sources.filter((item) => item.kind === 'block' || item.kind === 'certified_block' || item.kind === 'review_block');
    const resolved = await api.resolveAppSourceCandidates(draft.id, blockSources.map((source) => source.id));
    const byId = new Map(resolved.items.map((source) => [source.id, source]));
    const unavailableSources = blockSources.filter((source) => !byId.has(source.id));
    if (unavailableSources.length) {
      setPublishReviewOpen(false);
      setPanel('sources');
      setPanelOpen(true);
      setError(`${unavailableSources.map((source) => humanize(source.sourceRef)).join(', ')} ${unavailableSources.length === 1 ? 'is' : 'are'} no longer certified. Replace or remove ${unavailableSources.length === 1 ? 'this source' : 'these sources'} before publication.`);
      return;
    }
    for (const source of blockSources) {
      const block = byId.get(source.id);
      if (block && block.lifecycle === 'certified' && (source.sourceRevision !== block.sourceRevision || source.trustState !== 'certified' || source.reviewStatus !== 'not_required')) {
        operations.push({
          type: 'upsert_source',
          source: {
            ...source,
            kind: 'block',
            sourceRef: block.path,
            sourcePath: block.path,
            executionRef: block.path,
            qualifiedIdentity: block.qualifiedIdentity,
            snapshotId: block.snapshotId,
            sourceRevision: block.sourceRevision,
            sourceFingerprint: block.sourceRevision,
            lifecycle: 'certified',
            capabilities: block.capabilities,
            trustState: 'certified',
            reviewStatus: 'not_required',
          },
        });
      }
    }
    for (const page of draft.pages) {
      for (const tile of page.layout.items) {
        if (!tile.sourceId) continue;
        const block = byId.get(tile.sourceId);
        if (!block || block.lifecycle !== 'certified') continue;
        if (tile.sourceRevision !== block.sourceRevision || tile.review?.sourceFingerprint !== block.sourceRevision || tile.review?.status !== 'not_required') {
          operations.push({
            type: 'update_tile',
            pageId: page.id,
            tileId: tile.i,
            patch: {
              sourceRevision: block.sourceRevision,
              block: { ref: block.path },
              sourceClass: 'certified_block',
              trustState: 'certified',
              reviewStatus: 'certified',
              review: { ...tile.review, status: 'not_required', sourceFingerprint: block.sourceRevision },
            },
          });
        }
      }
    }
    if (!operations.length) {
      setPublishIssues([]);
      setSavedMessage('Certified sources are already current');
      await publish(false);
      return;
    }
    const next = await mutate(operations);
    if (next) {
      setPublishIssues([]);
      setSavedMessage('Source trust refreshed · run preview again');
    }
  };

  /**
   * A capability-free Dataset placeholder is deliberately non-executable. A
   * Resolve action for its server-created drift task first checks the current
   * catalog, then sends an identity-only upsert that the API canonicalizes.
   * Other review tasks keep their existing explicit local resolution flow.
   */
  const resolveReviewTask = async (task: AppStudioBuildDraft['reviewTasks'][number]) => {
    if (!draft) return;
    if (!isDatasetSourceRecoveryTask(draft, task)) {
      const next = await mutate([{ type: 'set_review_task', task: { ...task, status: 'resolved' } }]);
      if (next) setPublishIssues([]);
      return;
    }
    if (!task.sourceId) return;
    setBusy(true);
    setSavedMessage('Checking current Dataset source…');
    setError(null);
    try {
      const recovery = await runDatasetSourceRecoveryAction({
        draft,
        task,
        resolveCandidates: (draftId, sourceIds) => api.resolveAppSourceCandidates(draftId, sourceIds),
        patchDraft: (draftId, expectedRevision, operations, expectedProposalHash) => (
          api.patchAppBuild(draftId, expectedRevision, operations, expectedProposalHash)
        ),
        onPreviewInvalidated: () => {
          previewSequenceRef.current += 1;
          setPreviewRunsByPage({});
          setFilterOptionsByPage({});
          setPreviewing(false);
        },
      });
      if (!recovery.ok) {
        setSavedMessage('Dataset source still needs repair');
        setError(recovery.error);
        setPanel('sources');
        setPanelOpen(true);
        return;
      }
      // Keep this one request atomic: canonical source authority, derived tile
      // display state, and only the exact drift tasks change together.
      const previous = draft;
      setDraft(recovery.draft);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setPublishIssues([]);
      setSavedMessage('Dataset source restored · run a current preview');
    } catch (cause) {
      setSavedMessage('Dataset source restoration failed');
      setError(messageOf(cause));
      setPanel('sources');
      setPanelOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const deleteLocalDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const deleted = await api.deleteAppBuild(draft.id, draft.revision, draft.proposalHash);
      onDraftDeleted({ appName: draft.name, recoveryId: deleted.recoveryId });
    } catch (cause) {
      setDeleteConfirmOpen(false);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  async function runPreviewForDraft(
    targetDraft: AppStudioBuildDraft,
    pageId: string,
    variablesOverride?: Record<string, unknown>,
    crossFiltersOverride?: StudioDatasetCrossFilter[],
    interaction?: {
      hierarchyDrills?: DashboardDatasetHierarchyDrill[];
      affectedTileIds?: string[];
      /** Explicit user refresh bypasses the optional local result cache. */
      refresh?: boolean;
    },
  ): Promise<AppStudioBuildDraft | null> {
    const page = targetDraft.pages.find((candidate) => candidate.id === pageId);
    if (!page) return null;
    const hierarchyDrills = interaction?.hierarchyDrills ?? [];
    const affectedTileIds = [...new Set([
      ...(interaction?.affectedTileIds ?? []),
      ...hierarchyDrills.map((drill) => drill.tileId),
    ])];
    const boundedInteraction = affectedTileIds.length > 0;
    const priorPreview = previewRunsByPage[page.id];
    const sequence = previewSequenceRef.current + 1;
    previewSequenceRef.current = sequence;
    setActivePageId(page.id);
    setPreviewing(true);
    setError(null);
    // A changed filter/source scope must not continue to present old rows as
    // the current preview while this full run is in flight. An interaction
    // keeps only unrelated tiles visible; its selected tile is removed until
    // the server validates the drill against the current source/query.
    setPreviewRunsByPage((current) => {
      if (!current[page.id]) return current;
      const next = { ...current };
      if (!boundedInteraction) {
        delete next[page.id];
      } else {
        next[page.id] = {
          ...current[page.id]!,
          partial: true,
          facts: [],
          filterOptions: undefined,
          tiles: current[page.id]!.tiles.filter((tile) => !affectedTileIds.includes(tile.tileId)),
        };
      }
      return next;
    });
    if (!boundedInteraction) {
      setPreviewHierarchyDrillsByPage((current) => {
        if (!current[page.id]) return current;
        const { [page.id]: _cleared, ...remaining } = current;
        return remaining;
      });
    }
    try {
      const variables = previewVariablesForPage(
        page,
        variablesOverride ?? previewVariablesByPage[page.id] ?? {},
      );
      const crossFilters = crossFiltersOverride ?? previewCrossFiltersByPage[page.id] ?? [];
      const result = await api.runAppBuildPreview(targetDraft.id, page.id, variables, crossFilters, {
        runScope: previewRunScopeRef.current,
        ...(interaction?.refresh ? { refresh: true } : {}),
        // A preview receipt is eligible for local publication only after every
        // authored component has run in the current draft scope. Hierarchy
        // exploration is deliberately bounded and stays read-only.
        ...(boundedInteraction ? { affectedTileIds } : { fullRun: true }),
        ...(hierarchyDrills.length ? { datasetDrills: hierarchyDrills } : {}),
      });
      if (sequence !== previewSequenceRef.current) return null;
      // Store the runtime envelope before considering publication evidence.
      // A mixed run has safe current rows and governed component errors; the
      // strict receipt API will reject it, but that must not discard sibling
      // results from the Studio.
      const displayed = result.partial && boundedInteraction && priorPreview
        ? mergeStudioPartialPreview(priorPreview, result, page.layout.items)
        : result;
      setPreviewRunsByPage((current) => ({ ...current, [page.id]: displayed }));
      if (result.filterOptions?.length) {
        setFilterOptionsByPage((current) => {
          const pageOptions = { ...(current[page.id] ?? {}) };
          for (const optionSet of result.filterOptions ?? []) {
            const cached = pageOptions[optionSet.filterId];
            pageOptions[optionSet.filterId] = {
              values: Array.from(new Set([
              ...(cached?.values ?? []),
              ...optionSet.values,
              ])).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })),
              truncated: Boolean(cached?.truncated || optionSet.truncated),
              valueCount: optionSet.valueCount ?? cached?.valueCount,
              dateRange: mergeStudioDateRanges(cached?.dateRange, optionSet.dateRange),
            };
          }
          return { ...current, [page.id]: pageOptions };
        });
      }
      const settlement = settleStudioPreviewRun(result);
      if (settlement.kind !== 'receipt_candidate') {
        if (settlement.kind === 'incomplete' && settlement.clearStoredReceipt) {
          setDraft((current) => current
            && current.id === targetDraft.id
            && current.proposalHash === targetDraft.proposalHash
            ? withoutPagePreviewReceipt(current, page.id)
            : current);
        }
        if (settlement.kind === 'incomplete') setPublishIssues([settlement.message]);
        setSavedMessage(settlement.message);
        return null;
      }
      const recorded = await api.patchAppBuild(targetDraft.id, targetDraft.revision, [{
        type: 'set_preview_receipt',
        receipt: {
          id: result.runId,
          pageId: page.id,
          revision: targetDraft.revision,
          snapshotId: result.snapshotId,
          filterFingerprint: result.filterFingerprint,
          resultFingerprint: result.resultFingerprint,
          createdAt: new Date().toISOString(),
        },
      }], targetDraft.proposalHash);
      if (sequence !== previewSequenceRef.current) return null;
      setDraft(recorded.draft);
      setPublishIssues([]);
      setSavedMessage(`Preview settled · ${settlement.readyCount}/${settlement.totalCount} ready`);
      return recorded.draft;
    } catch (cause) {
      if (sequence === previewSequenceRef.current) setError(messageOf(cause));
      return null;
    } finally {
      if (sequence === previewSequenceRef.current) setPreviewing(false);
    }
  }

  const runPreview = async (pageId = activePage?.id, refresh = false) => {
    if (!draft || !pageId) return;
    await runPreviewForDraft(draft, pageId, undefined, undefined, refresh ? { refresh: true } : undefined);
  };

  const runPreviewAndReview = async (pageId: string) => {
    if (!draft || !pageId) return;
    const recorded = await runPreviewForDraft(draft, pageId, undefined, undefined, { refresh: true });
    if (!recorded) return;
    setPublishIssues([]);
    await publish(false, recorded);
  };

  const runAllPreviewsAndReview = async () => {
    if (!draft) return;
    let current = draft;
    const pages = current.pages.filter((page) => pageHasDataTiles(page));
    for (const page of pages) {
      const recorded = await runPreviewForDraft(current, page.id, previewVariablesForPage(page), undefined, { refresh: true });
      if (!recorded) return;
      current = recorded;
    }
    setPublishIssues([]);
    await publish(false, current);
  };

  const applyFilterValue = (filter: NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number], value: unknown) => {
    if (!draft || !activePage) return;
    const pageId = activePage.id;
    const linkedPageIds = new Set(pagesForDashboardFilterValue(draft.pages, pageId, filter));
    const nextVariablesByPage = { ...previewVariablesByPage };
    for (const linkedPageId of linkedPageIds) {
      nextVariablesByPage[linkedPageId] = { ...(nextVariablesByPage[linkedPageId] ?? {}), [filter.id]: value };
    }
    const nextAppScopedValues = isAppScopedDashboardFilter(filter)
      ? { ...previewAppScopedFilterValues, [filter.id]: value }
      : previewAppScopedFilterValues;
    if (isAppScopedDashboardFilter(filter)) setPreviewAppScopedFilterValues(nextAppScopedValues);
    const nextVariables = previewVariablesForPage(
      activePage,
      nextVariablesByPage[pageId] ?? { [filter.id]: value },
      nextAppScopedValues,
    );
    setPreviewVariablesByPage(nextVariablesByPage);
    setPreviewHierarchyDrillsByPage((current) => {
      const next = { ...current };
      for (const linkedPageId of linkedPageIds) delete next[linkedPageId];
      return next;
    });
    setPreviewRunsByPage((current) => {
      const next = { ...current };
      for (const linkedPageId of linkedPageIds) delete next[linkedPageId];
      return next;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    if (filterPreviewTimerRef.current !== null) window.clearTimeout(filterPreviewTimerRef.current);
    const range = filter.type === 'daterange' && value && typeof value === 'object' && !Array.isArray(value)
      ? value as { start?: string; end?: string }
      : null;
    if (range && Boolean(range.start) !== Boolean(range.end)) {
      setSavedMessage(`Choose both ${filter.label ?? humanize(filter.id)} dates`);
      return;
    }
    setSavedMessage(`${filter.label ?? humanize(filter.id)} changed · applying automatically…`);
    filterPreviewTimerRef.current = window.setTimeout(() => {
      filterPreviewTimerRef.current = null;
      void runPreviewForDraft(draft, pageId, nextVariables);
    }, 320);
  };

  const applyDatasetCrossFilter = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number], field: string, values: unknown[]) => {
    if (!draft || !activePage || !tile.query || !tile.sourceId || !tile.sourceRevision) return;
    const output = tileQueryOutputAliases(tile.query).find((candidate) => candidate.kind === 'dimension' && candidate.alias === field);
    const mappings = activePage.interactions?.crossFilter?.mappings.filter((mapping) => mapping.fromTileId === tile.i && mapping.fromField === field) ?? [];
    const distinctValues = [...new Map(values.filter((value) => value !== undefined && value !== null).map((value) => [JSON.stringify(value), value])).values()];
    if (!output || mappings.length === 0 || distinctValues.length === 0) {
      setSavedMessage(`No explicit Dataset mapping is configured for ${humanize(field)}. Open this tile’s interaction settings to map it.`);
      return;
    }
    const nextCrossFilter: StudioDatasetCrossFilter = {
      fromTileId: tile.i,
      fromSourceId: tile.sourceId,
      fromSourceRevision: tile.sourceRevision,
      field: output.alias,
      values: distinctValues,
    };
    const nextForPage = [
      ...previewCrossFilters.filter((candidate) => !(candidate.fromTileId === tile.i && candidate.field === output.alias)),
      nextCrossFilter,
    ];
    setPreviewCrossFiltersByPage((current) => ({ ...current, [activePage.id]: nextForPage }));
    setPreviewHierarchyDrillsByPage((current) => {
      const { [activePage.id]: _cleared, ...remaining } = current;
      return remaining;
    });
    setPreviewRunsByPage((current) => {
      const { [activePage.id]: _stale, ...remaining } = current;
      return remaining;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    setSavedMessage(`${humanize(field)} selection applied to its mapped Dataset tiles.`);
    void runPreviewForDraft(draft, activePage.id, previewVariables, nextForPage);
  };

  const clearDatasetCrossFilters = () => {
    if (!draft || !activePage || previewCrossFilters.length === 0) return;
    setPreviewCrossFiltersByPage((current) => ({ ...current, [activePage.id]: [] }));
    setPreviewHierarchyDrillsByPage((current) => {
      const { [activePage.id]: _cleared, ...remaining } = current;
      return remaining;
    });
    setPreviewRunsByPage((current) => {
      const { [activePage.id]: _stale, ...remaining } = current;
      return remaining;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    setSavedMessage('Selected result marks cleared. Refreshing mapped Dataset tiles…');
    void runPreviewForDraft(draft, activePage.id, previewVariables, []);
  };

  const removeDatasetCrossFilter = (fromTileId: string, field: string) => {
    if (!draft || !activePage) return;
    const nextForPage = previewCrossFilters.filter((filter) => !(filter.fromTileId === fromTileId && filter.field === field));
    setPreviewCrossFiltersByPage((current) => ({ ...current, [activePage.id]: nextForPage }));
    setPreviewHierarchyDrillsByPage((current) => {
      const { [activePage.id]: _cleared, ...remaining } = current;
      return remaining;
    });
    setPreviewRunsByPage((current) => {
      const { [activePage.id]: _stale, ...remaining } = current;
      return remaining;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    setSavedMessage(`${humanize(field)} result mark cleared. Refreshing mapped Dataset tiles…`);
    void runPreviewForDraft(draft, activePage.id, previewVariables, nextForPage);
  };

  const exploreDatasetHierarchy = (
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
    candidate: RuntimeDatasetHierarchyDrillCandidate,
    row: Record<string, unknown>,
  ) => {
    if (!draft || !activePage) return;
    const next = appendDatasetHierarchyDrill(previewHierarchyDrills, tile.i, candidate, row);
    if (!next.drills) {
      setSavedMessage(next.error ?? 'This result mark cannot be used for the declared hierarchy.');
      return;
    }
    setPreviewHierarchyDrillsByPage((current) => ({ ...current, [activePage.id]: next.drills! }));
    setSavedMessage(`Exploring ${humanize(candidate.toField)} · unsaved hierarchy view…`);
    void runPreviewForDraft(draft, activePage.id, previewVariables, previewCrossFilters, {
      hierarchyDrills: next.drills,
      affectedTileIds: next.drills.map((drill) => drill.tileId),
    });
  };

  const returnFromDatasetHierarchy = (tileId: string) => {
    if (!draft || !activePage) return;
    const next = popDatasetHierarchyDrill(previewHierarchyDrills, tileId);
    if (next.length === previewHierarchyDrills.length
      && !previewHierarchyDrills.some((drill) => drill.tileId === tileId)) return;
    const affectedTileIds = [...new Set([tileId, ...next.map((drill) => drill.tileId)])];
    setPreviewHierarchyDrillsByPage((current) => ({ ...current, [activePage.id]: next }));
    setSavedMessage('Returned to the previous declared grouping · unsaved hierarchy view…');
    void runPreviewForDraft(draft, activePage.id, previewVariables, previewCrossFilters, {
      hierarchyDrills: next,
      affectedTileIds,
    });
  };

  const navigateFromDatasetTile = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => {
    if (!draft || !activePage) return;
    const navigation = activePage.interactions?.navigate?.find((candidate) => candidate.fromTile === tile.i);
    const targetPage = navigation ? draft.pages.find((page) => page.id === navigation.toPage) : undefined;
    if (!navigation || !targetPage) {
      setSavedMessage('No detail-page navigation is configured for this tile. Open its interaction settings to add one.');
      return;
    }
    const withMarks = carriedNavigationVariables({
      page: activePage,
      tile,
      carryFilterIds: navigation.carryFilters,
      variables: previewVariables,
      crossFilters: previewCrossFilters,
    });
    const carried = Object.fromEntries(navigation.carryFilters
      .filter((filterId) => withMarks[filterId] !== undefined)
      .map((filterId) => [filterId, withMarks[filterId]]));
    const nextVariables = previewVariablesForPage(targetPage, {
      ...(previewVariablesByPage[targetPage.id] ?? {}),
      ...carried,
    });
    setPreviewVariablesByPage((current) => ({ ...current, [targetPage.id]: nextVariables }));
    setActivePageId(targetPage.id);
    setSelectedTileId(null);
    setSavedMessage(`Opened ${targetPage.metadata.title} with ${Object.keys(carried).length ? 'carried' : 'no'} shared filters.`);
    void runPreviewForDraft(draft, targetPage.id, nextVariables, []);
  };

  useEffect(() => {
    if (!draft || !activePage || proposal || previewing || previewRunsByPage[activePage.id] || !pageHasDataTiles(activePage)) return;
    const timer = window.setTimeout(() => {
      void runPreviewForDraft(draft, activePage.id, previewVariablesForPage(activePage));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activePage?.id, draft?.revision, proposal]);

  useEffect(() => () => {
    if (filterPreviewTimerRef.current !== null) window.clearTimeout(filterPreviewTimerRef.current);
    if (sourceFeedbackTimerRef.current !== null) window.clearTimeout(sourceFeedbackTimerRef.current);
  }, []);

  if (!draft) {
    return <div className="dql-studio-v2-loading">
      <style>{APP_STUDIO_V2_STYLES}</style>
      <button type="button" className="icon" onClick={onBack} aria-label="Back to Apps"><ArrowLeft size={18} /></button>
      <div><span className="loading-mark"><LayoutDashboard size={20} /></span><strong>{error ? 'Studio could not open' : initialDraftId ? 'Opening your local draft…' : baseAppId ? 'Preparing a safe edit draft…' : 'Preparing your Build Frame…'}</strong><small>{error ?? 'Keeping all work local until you explicitly publish it to the Project.'}</small>{error ? <button type="button" onClick={() => { immediateStartRef.current = false; void createDraft(); }}>Try again</button> : null}</div>
    </div>;
  }

  if (aiActivity) {
    return <AppStudioAiActivitySurface
      activity={aiActivity}
      label={APP_STUDIO_AI_ACTIVITY_LABELS[aiActivityIndex] ?? APP_STUDIO_AI_ACTIVITY_LABELS[0]}
      onBack={onBack}
      onReturn={aiActivity.returnToProposal && proposal ? () => setAiActivity(null) : undefined}
      onRetry={() => retryAiActivity(aiActivity)}
    />;
  }

  const selectedSourceKind = selectedSource ? recommendedComponentKind(selectedSource) : null;
  const selectedSourceId = selectedSource?.sourceId ?? selectedSource?.id;
  const selectedSourceFeedback = sourceFeedback?.sourceId === selectedSourceId ? sourceFeedback : null;
  const selectedSourceAction = selectedSource && selectedSourceKind ? appStudioSourceActionLabel({
    view: componentKindLabel(selectedSourceKind),
    status: selectedSourceFeedback?.status ?? 'idle',
    reviewRequired: selectedSource.eligibility?.localPreview === false && draft.sourcePolicy === 'governed_only',
    alreadyUsed: draft.sources.some((source) => source.id === selectedSourceId || source.sourceRef === selectedSource.path),
    pageTitle: selectedSourceFeedback?.pageTitle,
  }) : '';

  return (
    <div className={`dql-studio-v2 ${proposal ? 'proposal-focus' : ''}`}>
      <style>{APP_STUDIO_V2_STYLES}</style>
      <header className="studio-topbar">
        <div className="studio-brand"><button type="button" className="icon" onClick={onBack}><ArrowLeft size={17} /></button><span className="mark"><LayoutDashboard size={16} /></span><div><input value={name || draft.name} onChange={(event) => setName(event.target.value)} onBlur={() => { if (name.trim() && name.trim() !== draft.name) void mutate([{ type: 'set_name', name: name.trim() }]); }} /><small>{savedMessage}</small></div></div>
        {proposal ? <div className="proposal-focus-title"><small>AI APP BUILD · STEP 2</small><strong>Choose proposed sources</strong></div> : <nav className="page-nav" aria-label="App pages">
          {draft.pages.map((page) => <button key={page.id} type="button" className={activePage?.id === page.id ? 'on' : ''} onClick={() => { setActivePageId(page.id); setSelectedTileId(null); }}>{page.metadata.title}</button>)}
          <button type="button" className="icon" onClick={() => void addPage()} aria-label="Add page"><Plus size={15} /></button>
        </nav>}
        {proposal ? <div className="proposal-focus-status"><ShieldCheck size={14} /><span>Private draft · nothing generated yet</span></div> : <div className="studio-actions">
          <button type="button" className="icon" disabled={!undoStack.length || busy} onClick={() => void undo()} title="Undo"><Undo2 size={16} /></button>
          <button type="button" className="icon" disabled={!redoStack.length || busy} onClick={() => void redo()} title="Redo"><Redo2 size={16} /></button>
          <div className="breakpoints">
            <button type="button" className={previewMode === 'auto' ? 'on' : ''} onClick={() => setPreviewMode('auto')} title="Fit to available canvas"><LayoutDashboard size={15} /></button>
            <button type="button" className={previewMode === 'wide' ? 'on' : ''} onClick={() => setPreviewMode('wide')} title="Wide preview"><Monitor size={15} /></button>
            <button type="button" className={previewMode === 'medium' ? 'on' : ''} onClick={() => setPreviewMode('medium')} title="Tablet preview"><PanelRight size={15} /></button>
            <button type="button" className={previewMode === 'narrow' ? 'on' : ''} onClick={() => setPreviewMode('narrow')} title="Phone preview"><Smartphone size={15} /></button>
          </div>
          <button type="button" className={`copilot ${copilotOpen ? 'on' : ''}`} onClick={() => { if (!copilotOpen) setAiScope(selectedDatasetTile ? 'tile' : 'page'); setCopilotOpen((open) => !open); }} aria-pressed={copilotOpen} aria-label="Ask AI"><Bot size={14} /><span>Ask AI</span></button>
          <button type="button" className="preview" onClick={() => void runPreview()} disabled={previewing || busy} aria-label={previewing ? 'Running preview' : 'Run preview'}><Play size={13} /><span>{previewing ? 'Running…' : 'Run preview'}</span></button>
          <button type="button" className="publish" onClick={() => void publish(false)} disabled={busy} aria-label={`Review and publish to Project${publishStepCount ? `, ${publishStepCount} ${publishStepCount === 1 ? 'fix' : 'fixes'} needed` : ''}`}><Upload size={13} /><span>Publish to Project</span>{publishStepCount ? <small>{publishStepCount} {publishStepCount === 1 ? 'fix' : 'fixes'}</small> : null}</button>
          <button type="button" className="icon overflow-button" aria-label="More draft actions" aria-expanded={actionsOpen} onClick={() => setActionsOpen((open) => !open)}><MoreHorizontal size={17} /></button>
          {actionsOpen ? <div className="studio-overflow-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setDeleteConfirmOpen(true); }}><Trash2 size={14} /> Delete local draft</button></div> : null}
        </div>}
      </header>

      {!proposal ? <aside className="studio-left">
        <nav>
          {([
            ['sources', Blocks, 'Sources'], ['pages', LayoutDashboard, 'Pages'],
            ['filters', Filter, 'Filters'], ['templates', FileText, 'Design'],
          ] as const).map(([id, Icon, label]) => <button key={id} type="button" className={panel === id && panelOpen ? 'on' : ''} onClick={() => { if (window.innerWidth <= 820 && panel === id) setPanelOpen((open) => !open); else { setPanel(id); setPanelOpen(true); } }}><Icon size={17} /><span>{label}</span></button>)}
        </nav>
        <section className={`left-content ${panelOpen ? 'open' : ''}`}>
          <button type="button" className="mobile-drawer-close" onClick={() => setPanelOpen(false)} aria-label="Close Studio drawer"><X size={16} /></button>
          {panel === 'pages' ? <PagesPanel draft={draft} activePageId={activePage?.id} onOpen={setActivePageId} onAdd={() => void addPage()} /> : null}
          {panel === 'sources' ? <SourcesPanel usedSources={draft.sources} items={filteredCatalog} selected={selectedSource} query={catalogQuery} loading={catalogLoading} error={catalogError} disabled={busy || previewing} datasetTilesEnabled={datasetTilesEnabled} enablingDatasets={enablingDatasets} onEnableDatasets={() => void enableDatasetTiles()} sourceFeedback={sourceFeedback} onQuery={setCatalogQuery} onSelect={selectSource} onAdd={(item, kind) => void addComponent(kind, item)} onAddDataset={(item, kind, query, title) => void addComponent(kind, item, query, title)} onAuthorDataset={openDatasetAuthoring} onRefreshDatasetBinding={(sourceId) => void refreshDatasetBinding(sourceId)} onAddContent={(kind) => void addComponent(kind, null)} policy={draft.sourcePolicy} total={catalogTotal} hasMore={Boolean(catalogNextCursor)} onLoadMore={() => void loadMoreSources()} onEnableReview={() => void mutate([{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }])} /> : null}
          {panel === 'filters' ? <FiltersPanel draft={draft} activePageId={activePage?.id} catalog={catalog} candidates={filterCandidates} runtimeFilterFields={runtimeFilterFields} previewRunsByPage={previewRunsByPage} previewing={previewing} disabled={busy || previewing} onRunPreview={() => void runPreview()} onSave={(configuration) => void saveFilter(configuration)} onRemove={(id) => void removeFilter(id)} /> : null}
          {panel === 'templates' ? <TemplatesPanel current={draft.template} onApply={(nextTemplate) => void applyTemplate(nextTemplate)} /> : null}
        </section>
      </aside> : null}

      <main ref={workspaceRef} className="studio-workspace">
        {error ? <div className="studio-error floating" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
        {proposal && proposalSummary ? <AiPlanReview
          proposal={proposal}
          summary={proposalSummary}
          catalog={catalog}
          catalogQuery={catalogQuery}
          sourcePolicy={draft.sourcePolicy}
          selectedSourceIds={selectedProposalSourceIds}
          addingSourceId={proposalAddingSourceId}
          busy={busy}
          onRevise={() => void requestAiProposal(draft, prompt, appStudioProposalRequiredSourceIds(selectedProposalSourceIds), true)}
          onApply={() => void applyProposal()}
          onDismiss={() => setProposal(null)}
          onCatalogQuery={setCatalogQuery}
          onAddSource={(source) => void addSourceToAiProposal(source.sourceId ?? source.id, source.eligibility?.localPreview === false, source)}
          onAddProposalSource={(sourceId, reviewRequired) => void addSourceToAiProposal(sourceId, reviewRequired)}
          onAnswerClarification={(questionId, answerId) => void reviseAiProposal({ [questionId]: answerId })}
          onGenerateGap={(requirementId) => void generateAiGap(requirementId)}
          onToggleSource={(sourceId) => setSelectedProposalSourceIds((current) => {
            const next = new Set(current);
            if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId);
            return next;
          })}
        /> : null}
        {!proposal ? <div className={`studio-canvas-frame ${breakpoint} preview-mode-${previewMode}`}>
          <div className="studio-canvas-label"><div><span>{previewMode === 'auto' ? 'Fit canvas' : `${breakpoint.charAt(0).toUpperCase() + breakpoint.slice(1)} preview`} · {breakpoint === 'wide' ? '12 columns' : breakpoint === 'medium' ? '6 columns' : '1 column'}</span><small>Drag components to reorder · saved instantly</small></div><button type="button" onClick={() => void arrangePage()} disabled={!activePage?.layout.items.length || busy} title="Compact gaps and restore a clean reading order"><LayoutDashboard size={13} /> Auto arrange</button></div>
          <section className="studio-canvas" aria-label="App canvas">
            <header className="studio-page-heading"><div><small>APP PAGE</small><span>{activePage?.metadata.title ?? 'Overview'}</span></div><small>{draft.frame.audience || 'Stakeholders'} · {draft.pages[0]?.metadata.domain || 'General'}</small></header>
            {selectedSource && selectedSourceKind ? <div className="studio-source-ready"><div><span className="certified"><ShieldCheck size={14} /></span><p><small>Selected data</small><strong>{humanize(selectedSource.name)}</strong></p></div><span className="studio-source-actions"><button type="button" disabled={busy || previewing} onClick={() => selectedSource.capabilities?.dataset ? (setPanel('sources'), setPanelOpen(true)) : void addComponent(selectedSourceKind, selectedSource)}>{selectedSource.capabilities?.dataset ? <><Settings2 size={14} /> Choose fields</> : <><Plus size={14} /> {selectedSourceAction}</>}</button><button type="button" className="source-clear" onClick={() => setSelectedSource(null)} aria-label="Clear selected data"><X size={14} /></button></span></div> : null}
            {(activePage?.filters ?? []).length ? <div className="studio-page-filterbar">{activePage!.filters!.map((filter) => <StudioFilterControl key={filter.id} filter={filter} availability={activeFilterOptions[filter.id]} value={previewVariables[filter.id] ?? filter.default} applying={previewing} onChange={(value) => applyFilterValue(filter, value)} />)}</div> : null}
            {previewCrossFilters.length ? <div className="studio-mark-filterbar" role="status" aria-label="Selected Dataset result marks"><span>Selected marks</span>{previewCrossFilters.map((filter) => <button key={`${filter.fromTileId}:${filter.field}`} type="button" onClick={() => removeDatasetCrossFilter(filter.fromTileId, filter.field)}>{humanize(filter.field)}: {filter.values.map(String).join(', ')} <X size={11} /></button>)}<button type="button" className="clear" onClick={clearDatasetCrossFilters}>Reset marks</button></div> : null}
            {previewRun?.incomplete ? <div className="studio-preview-incomplete" role="status" aria-label="Incomplete preview">
              <strong>Preview incomplete · {previewRun.tiles.filter((tile) => tile.status === 'ok').length}/{previewRun.tiles.length} components ready</strong>
              <span>{previewRun.incomplete.message}</span>
            </div> : null}
            {autopilotTileSelectionRequested && !selectedDatasetTile ? <div className="studio-autopilot-selection-hint" role="status">
              <strong>Choose a tile to change with AI</strong>
              <span>Use “Edit with AI” on a Dataset tile. Clicking a chart keeps its own behavior and does not select the tile.</span>
            </div> : null}
            <div className="studio-page-grid">
              {visibleItems.map((tile) => (
                <article key={tile.i} role="group" aria-label={`App component: ${tile.title || humanize(tile.i)}`} draggable className={`studio-component-card ${selectedTileId === tile.i ? 'selected' : ''} ${draggingTileId === tile.i ? 'dragging' : ''}`} style={{ '--studio-tile-width': Math.min(tile.w, breakpoint === 'medium' ? 6 : breakpoint === 'narrow' ? 1 : 12), minHeight: breakpoint === 'narrow' ? Math.max(180, tile.h * 58) : Math.max(150, tile.h * 68) } as CSSProperties} onDragStart={() => { draggingTileIdRef.current = tile.i; setDraggingTileId(tile.i); }} onDragEnd={() => { draggingTileIdRef.current = null; setDraggingTileId(null); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void moveTileBefore(tile.i); }} onClick={() => setSelectedTileId(tile.i)}>
                  <header><span className="drag-handle" aria-hidden="true">⠿</span><span className={`trust-dot ${tile.trustState ?? 'draft_ready'}`} /> <strong>{tile.title || humanize(tile.i)}</strong>{tile.sourceId && tile.query ? <button type="button" className={`studio-autopilot-target ${selectedDatasetTile?.i === tile.i ? 'on' : ''}`} aria-pressed={selectedDatasetTile?.i === tile.i} onClick={(event) => { event.stopPropagation(); selectAppAutopilotTile(tile.i); setAiScope('tile'); setCopilotOpen(true); }}>Edit with AI</button> : null}{tile.query ? <button type="button" className={`studio-tile-dql-toggle ${dqlTileId === tile.i ? 'on' : ''}`} aria-pressed={dqlTileId === tile.i} onClick={(event) => { event.stopPropagation(); setDqlTileId((current) => current === tile.i ? null : tile.i); }}>View DQL</button> : null}<small>{tile.viz.type.replace(/_/g, ' ')}</small></header>
                  {unsupportedTileFilters(tile).map((binding) => <div key={binding.filter} className="tile-filter-notice"><Filter size={11} /><span>{binding.unsupportedReason ?? `${humanize(binding.filter)} does not affect this component.`}</span></div>)}
                  {datasetTileNotices(previewRun?.tiles.find((item) => item.tileId === tile.i)).map((notice) => <div key={notice.key} className={`tile-filter-notice ${notice.kind}`} title={notice.detail}><Filter size={11} /><span><strong>{notice.label}</strong> · {notice.detail}</span></div>)}
                  {dqlTileId === tile.i ? <div className="studio-tile-dql" onClick={(event) => event.stopPropagation()}>{(() => { const runTile = previewRun?.tiles.find((item) => item.tileId === tile.i); const evidence = runTile && tile.query && isCurrentDatasetTileEvidence(tile, runTile) ? presentDatasetTileEvidence(runTile) : undefined; return evidence ? <DatasetTileExecutionEvidence presentation={evidence} /> : <p>Run a preview to see the Dataset query and the SQL it compiled to.</p>; })()}</div> : null}
                  {tile.text ? <div className={tile.viz.type === 'heading' ? 'tile-heading' : 'tile-text'}>{tile.text.markdown.replace(/^#+\s*/, '')}</div> : <div className="studio-tile-preview-interactions" onClick={(event) => event.stopPropagation()}><StudioTilePreview tile={tile} run={previewRun?.tiles.find((item) => item.tileId === tile.i)} loading={previewing} themeMode={themeMode} crossFilterFields={datasetCrossFilterFields(activePage!, tile)} activeCrossFilters={previewCrossFilters} onSelectDatasetMark={(field, values) => applyDatasetCrossFilter(tile, field, values)} onDrillDatasetMark={(candidate, row) => exploreDatasetHierarchy(tile, candidate, row)} onDrillBack={() => returnFromDatasetHierarchy(tile.i)} onNavigate={() => navigateFromDatasetTile(tile)} hasNavigation={Boolean(activePage!.interactions?.navigate?.some((interaction) => interaction.fromTile === tile.i))} linkProposal={datasetLinkProposal(activePage!, tile)} onLinkField={() => linkDatasetTileField(tile)} /></div>}
                </article>
              ))}
              {!visibleItems.length ? <div className="empty-canvas"><span><Plus size={22} /></span><strong>Build this page</strong><p>Open Sources on the left, choose governed data, and add its recommended view. You can also add text or a heading.</p><button type="button" onClick={() => { setPanel('sources'); setPanelOpen(true); }}>Open Sources</button></div> : null}
            </div>
          </section>
        </div> : null}
      </main>

      {!proposal ? <aside className={`studio-right ${selectedTile ? 'has-selection' : ''}`}>
        <header><div><Settings2 size={16} /><strong>{selectedTile ? 'Component properties' : 'App Build Frame'}</strong></div><button type="button" className="icon" onClick={() => setSelectedTileId(null)} aria-label={selectedTile ? 'Close component properties' : 'More App settings'}>{selectedTile ? <X size={16} /> : <MoreHorizontal size={16} />}</button></header>
        {selectedTile && activePage ? (
          <ComponentInspector
            tile={selectedTile}
            run={previewRun?.tiles.find((item) => item.tileId === selectedTile.i)}
            pageId={activePage.id}
            page={activePage}
            pages={draft.pages}
            sources={draft.sources}
            dataset={selectedTile.sourceId ? draft.sources.find((source) => source.id === selectedTile.sourceId)?.capabilities?.dataset : undefined}
            disabled={busy || previewing}
            onOpenSources={() => { setPanel('sources'); setPanelOpen(true); }}
            onSaveDatasetTileAsBlock={() => void saveDatasetTileAsReusableBlock(activePage, selectedTile)}
            savingDatasetTileAsBlock={savingDatasetTileId === selectedTile.i}
            savedDatasetReviewDraft={savedDatasetReviewDrafts[`${activePage.id}:${selectedTile.i}`]}
            onReplaceDatasetTileWithBlock={() => void replaceDatasetTileWithSavedBlock(activePage, selectedTile)}
            replacingDatasetTileWithBlock={replacingDatasetTileId === selectedTile.i}
            onPreviewLegacySemanticConversion={() => void previewLegacySemanticConversion(activePage, selectedTile)}
            previewingLegacySemanticConversion={previewingSemanticConversionTileId === selectedTile.i}
            semanticTileConversionPreview={semanticTileConversionPreviews[`${activePage.id}:${selectedTile.i}`]}
            onAcceptLegacySemanticConversion={() => void acceptLegacySemanticConversion(activePage, selectedTile)}
            acceptingLegacySemanticConversion={acceptingSemanticConversionTileId === selectedTile.i}
            onRefreshDatasetTile={() => void runPreview(activePage.id, true)}
            onUpdate={(patch) => void mutate([{ type: 'update_tile', pageId: activePage.id, tileId: selectedTile.i, patch }])}
            onUpdateInteractions={(interactions) => void mutate([{ type: 'set_interactions', pageId: activePage.id, interactions }])}
            onDelete={() => void mutate([{ type: 'remove_tile', pageId: activePage.id, tileId: selectedTile.i }]).then(() => setSelectedTileId(null))}
          />
        ) : (
          <BuildFrameInspector draft={draft} prompt={prompt} previewRun={previewRun} onPrompt={setPrompt} onAskAi={() => { setAiScope('page'); setCopilotOpen(true); }} onSourcePolicy={(nextPolicy) => void mutate([{ type: 'set_source_policy', sourcePolicy: nextPolicy }])} onResolveTask={(task) => void resolveReviewTask(task)} onApproveSemantic={() => void approveSemanticPreview()} />
        )}
      </aside> : null}

      {copilotOpen && !proposal ? <AiSidePanel
        t={themes[themeMode]}
        title="Ask AI"
        subtitle={draft.name}
        dock="overlay"
        expanded={copilotExpanded}
        onToggleExpanded={() => setCopilotExpanded((expanded) => !expanded)}
        onNewChat={() => {
          copilotThread.resetThreadId();
          setAutopilotReview(null);
        }}
        onClose={() => setCopilotOpen(false)}
        running={copilotRunning}
        resizable
        minResizeWidth={390}
        maxResizeWidth={1100}
        ariaLabel="Ask AI"
        className="studio-copilot-panel"
        style={{ top: 58, bottom: 0, height: 'auto' }}
      >
        <div className="studio-ai-scope" role="tablist" aria-label="What should AI work on?">
          <button type="button" role="tab" aria-selected={aiScope === 'page'} className={aiScope === 'page' ? 'on' : ''} onClick={() => setAiScope('page')}>Whole page</button>
          <button type="button" role="tab" aria-selected={aiScope === 'tile'} className={aiScope === 'tile' ? 'on' : ''} onClick={() => setAiScope('tile')}>Selected tile{selectedDatasetTile ? `: ${selectedDatasetTile.title || humanize(selectedDatasetTile.i)}` : ''}</button>
        </div>
        {aiScope === 'page' ? <section className="studio-ai-page-scope">
          <label htmlFor="studio-ai-page-prompt">Describe the page or the change you want</label>
          <textarea id="studio-ai-page-prompt" value={prompt} rows={5} onChange={(event) => setPrompt(event.target.value)} placeholder="Revenue and order trends by region for the weekly business review" />
          <small>AI plans tiles from governed Datasets only. You review the plan before anything changes.</small>
          <button type="button" className="primary" disabled={busy || previewing} onClick={() => void requestAiProposal()}><Sparkles size={13} /> Propose page changes</button>
        </section> : null}
        {aiScope === 'tile' && autopilotReview ? <AppAutopilotReviewCard
          proposal={autopilotReview}
          running={copilotRunning}
          onDiscard={() => {
            setAutopilotReview(null);
            setSavedMessage('AI tile change discarded · the draft is unchanged');
          }}
          onApply={() => void applyAutopilotChange()}
        /> : null}
        {aiScope === 'tile' ? <Suspense fallback={<div className="studio-copilot-loading">Loading…</div>}>
          <UnifiedAgentRunPanel
            themeMode={themeMode}
            title="Edit tile with AI"
            scopeHint={selectedDatasetTile
              ? `Draft · ${activePage?.metadata.title ?? 'Overview'} · ${selectedDatasetTile.title || humanize(selectedDatasetTile.i)}${autopilotRepairAvailability === 'healthy' ? ' · preview healthy' : autopilotRepairAvailability === 'failed_tile' ? ' · failed tile' : ''}`
              : `Draft · ${activePage?.metadata.title ?? 'Overview'} · select a Dataset tile`}
            composerPlaceholder="Explain, repair, or change the selected tile…"
            emptyHint={selectedDatasetTile
              ? `AI reads the saved draft and ${selectedDatasetTile.title || humanize(selectedDatasetTile.i)} before it answers, and proposes a change for you to review. ${appAutopilotRepairShortcutHint(autopilotRepairAvailability)}`
              : 'Choose “Edit with AI” on a Dataset tile first.'}
            audience="analyst"
            initialMode="app"
            selectedObject={{ kind: 'app', id: draft.appId, title: draft.name }}
            workspaceContext={appAutopilotContext(draft, activePage, selectedDatasetTile, previewRun)}
            presentationContextKey={autopilotPresentationScope}
            threadId={copilotThread.threadId}
            onThreadIdChange={copilotThread.onThreadIdChange}
            onRunningChange={setCopilotRunning}
            onSelectAppAutopilotTile={() => {
              setAutopilotTileSelectionRequested(true);
              setSavedMessage('Choose “Edit with AI” on a Dataset tile to continue');
              workspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
            onReviewAppAutopilotChange={(artifact, run) => {
              const proposal = appAutopilotProposalFromArtifact(artifact.payload);
              if (!proposal || proposal.id !== artifact.ref || proposal.artifactId !== artifact.id || proposal.runId !== run.id) {
                setError('AI returned a change that could not be reviewed. Ask it to prepare the change again.');
                return;
              }
              setAutopilotReview(proposal);
              setSavedMessage('AI tile change ready for review · the draft is unchanged');
            }}
            answerFirstCards
            examplePrompts={appAutopilotExamplePrompts(autopilotRepairAvailability)}
          />
        </Suspense> : null}
      </AiSidePanel> : null}
      {publishReviewOpen ? <PublishReadinessDialog
        draft={draft}
        serverIssues={publishIssues}
        busy={busy || previewing}
        previewRun={previewRun}
        onClose={() => setPublishReviewOpen(false)}
        onRetry={() => void publish(true)}
        onRunPreview={(pageId) => void runPreviewAndReview(pageId)}
        onRunAllPreviews={() => void runAllPreviewsAndReview()}
        onRemoveRequirement={(requirementId) => void removeRequirementFromPublishScope(requirementId)}
        onReviseRequirement={reviseRequirementWithAi}
        onAnswerQuestion={(questionId, answerId) => void answerBuildFrameQuestion(questionId, answerId)}
        onResolveTask={(task) => void resolveReviewTask(task)}
        onOpenSources={() => { setPublishReviewOpen(false); setPanel('sources'); setPanelOpen(true); }}
        onOpenFilters={() => { setPublishReviewOpen(false); setPanel('filters'); setPanelOpen(true); }}
        onRefreshSources={() => void refreshCertifiedSourceTrust()}
        onApproveSemantic={() => void approveSemanticPreview()}
        onRemoveLocalAnalysis={() => void removeLocalAnalysisForPublication()}
      /> : null}
      {datasetAuthoringSource ? <DatasetSourceAuthoringDialog
        source={datasetAuthoringSource}
        disabled={busy || previewing}
        onClose={() => setDatasetAuthoringSource(null)}
        onPreview={(change) => void previewDatasetAuthoringChange(change)}
      /> : null}
      {datasetAuthoringProposal ? <ContextProposalReviewDrawer
        proposal={datasetAuthoringProposal}
        theme={themes[themeMode]}
        onClose={() => setDatasetAuthoringProposal(null)}
        onCommitted={finishDatasetAuthoringProposal}
      /> : null}
      {datasetRebindPrompt ? <DatasetSourceRebindReviewDialog
        title={datasetRebindPrompt.title}
        disabled={busy || previewing}
        onCancel={() => setDatasetRebindPrompt(null)}
        onConfirm={() => void refreshDatasetBinding(datasetRebindPrompt.sourceId, true)}
      /> : null}
      {deleteConfirmOpen ? <div className="proposal-scrim" role="dialog" aria-modal="true" aria-label="Delete local App draft"><section className="studio-delete-card"><span className="delete-mark"><Trash2 size={18} /></span><h2>Delete this local draft?</h2><p><strong>{draft.name}</strong> will leave the App list. Its pages, components, and local history move to a recovery bundle so you can Undo.</p><footer><button type="button" onClick={() => setDeleteConfirmOpen(false)} disabled={busy}>Cancel</button><button type="button" className="danger" onClick={() => void deleteLocalDraft()} disabled={busy}>{busy ? 'Deleting…' : 'Delete draft'}</button></footer></section></div> : null}
    </div>
  );
}

function PublishReadinessDialog({
  draft,
  serverIssues,
  busy,
  previewRun,
  onClose,
  onRetry,
  onRunPreview,
  onRunAllPreviews,
  onRemoveRequirement,
  onReviseRequirement,
  onAnswerQuestion,
  onResolveTask,
  onOpenSources,
  onOpenFilters,
  onRefreshSources,
  onApproveSemantic,
  onRemoveLocalAnalysis,
}: {
  draft: AppStudioBuildDraft;
  serverIssues: string[];
  busy: boolean;
  previewRun: DashboardRunResponse | null;
  onClose: () => void;
  onRetry: () => void;
  onRunPreview: (pageId: string) => void;
  onRunAllPreviews: () => void;
  onRemoveRequirement: (requirementId: string) => void;
  onReviseRequirement: (question: string) => void;
  onAnswerQuestion: (questionId: string, answerId: string) => void;
  onResolveTask: (task: AppStudioBuildDraft['reviewTasks'][number]) => void;
  onOpenSources: () => void;
  onOpenFilters: () => void;
  onRefreshSources: () => void;
  onApproveSemantic: () => void;
  onRemoveLocalAnalysis: () => void;
}): JSX.Element {
  const requirements = unresolvedPublicationRequirements(draft);
  const clarifications = (draft.frame.clarificationQuestions ?? []).filter((question) => question.required && !question.answerId);
  const tasks = blockingPublicationReviewTasks(draft);
  const previewPages = pagesNeedingSettledPreview(draft);
  const sources = publicationBlockingSources(draft);
  const semanticTiles = legacySemanticTilesNeedingApproval(draft);
  const datasetSources = sources.filter(isDatasetBackedAppSource);
  const localOnlySources = sources.filter((source) => !isDatasetBackedAppSource(source)
    && source.kind !== 'governed_semantic'
    && source.kind !== 'semantic_query');
  const remainingIssues = publicationIssueSummaries(serverIssues);
  const ready = requirements.length === 0
    && clarifications.length === 0
    && tasks.length === 0
    && previewPages.length === 0
    && sources.length === 0
    && semanticTiles.length === 0
    && remainingIssues.length === 0;
  const blockerCount = publicationBlockerCount(draft, serverIssues);

  return <div className="proposal-scrim" role="dialog" aria-modal="true" aria-labelledby="publish-readiness-title">
    <section className="studio-readiness-card">
      <header>
        <span className={ready ? 'ready' : ''}>{ready ? <Check size={19} /> : <ShieldCheck size={19} />}</span>
        <div><h2 id="publish-readiness-title">{ready ? 'Ready to publish' : `${blockerCount} ${blockerCount === 1 ? 'fix' : 'fixes'} before publishing`}</h2><p>{ready ? 'Every governed publication check passed.' : 'Complete the actions below. Each action updates this review automatically; there is no separate recheck loop.'}</p></div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close publish checklist"><X size={16} /></button>
      </header>
      <div className="readiness-body">
        {clarifications.map((question) => <section className="readiness-item" key={question.id}>
          <span className="step-mark"><Bot size={15} /></span>
          <div><strong>Choose what you mean</strong><p>{question.question}</p><div className="readiness-choices">{question.choices.map((choice) => <button key={choice.id} type="button" onClick={() => onAnswerQuestion(question.id, choice.id)} disabled={busy}>{choice.label}</button>)}</div></div>
        </section>)}
        {requirements.map((requirement) => <section className="readiness-item" key={requirement.id}>
          <span className="step-mark"><Sparkles size={15} /></span>
          <div><strong>Unanswered App question</strong><p>{requirement.question}</p><small>DQL will not pretend that an unrelated tile covers this question.</small><div className="readiness-actions"><button type="button" className="primary" onClick={() => onReviseRequirement(requirement.question)} disabled={busy}><Bot size={13} /> Revise with AI</button><button type="button" onClick={() => onRemoveRequirement(requirement.id)} disabled={busy}>Remove from publish scope</button></div></div>
        </section>)}
        {tasks.map((task) => <section className="readiness-item" key={task.id}>
          <span className="step-mark"><FileText size={15} /></span>
          <div><strong>Scoped review</strong><p>{task.message}</p><div className="readiness-actions"><button type="button" className="primary" onClick={() => onResolveTask(task)} disabled={busy}><Check size={13} /> Mark resolved</button></div></div>
        </section>)}
        {previewPages.map((page) => <section className="readiness-item" key={page.id}>
          <span className="step-mark"><Play size={15} /></span>
          <div><strong>Run {page.metadata.title || page.id}</strong><p>Settle the current data, filters, and component results before publishing this page.</p><div className="readiness-actions"><button type="button" className="primary" onClick={() => onRunPreview(page.id)} disabled={busy}><Play size={13} /> {busy ? 'Running…' : 'Run preview'}</button></div></div>
        </section>)}
        {semanticTiles.length ? <section className="readiness-item">
          <span className="step-mark"><ShieldCheck size={15} /></span>
          <div><strong>Approve governed semantic results</strong><p>{semanticTiles.map(({ page, tile, source }) => `${page.metadata.title || page.id}/${tile.title || source?.sourceRef || tile.i}`).join(', ')}</p><small>Approval binds each tile to the settled snapshot and receipt you reviewed.</small><div className="readiness-actions">{previewRun ? <button type="button" className="primary" onClick={onApproveSemantic} disabled={busy}><ShieldCheck size={13} /> Approve settled result</button> : <button type="button" onClick={() => onRunPreview(draft.pages[0]?.id ?? '')} disabled={busy}><Play size={13} /> Run preview first</button>}<button type="button" onClick={onOpenSources}>Open Sources</button></div></div>
        </section> : null}
        {datasetSources.length ? <section className="readiness-item warning">
          <span className="step-mark"><ShieldCheck size={15} /></span>
          <div><strong>Dataset source needs governed review</strong><p>{datasetSources.map((source) => humanize(source.sourceRef)).join(', ')}</p><small>Dataset publication follows the current source lifecycle and contract. Running a preview does not certify it.</small><div className="readiness-actions"><button type="button" className="primary" onClick={onOpenSources}><Blocks size={13} /> Review Dataset source</button></div></div>
        </section> : null}
        {localOnlySources.length ? <section className="readiness-item warning">
          <span className="step-mark"><FileText size={15} /></span>
          <div><strong>Local analysis cannot publish</strong><p>{localOnlySources.map((source) => humanize(source.sourceRef)).join(', ')}</p><small>Replace it with governed data, or remove it from this draft. Removal is saved locally and can be undone from the Studio toolbar.</small><div className="readiness-actions"><button type="button" className="primary" onClick={onOpenSources}><Blocks size={13} /> Replace with governed data</button><button type="button" onClick={onRemoveLocalAnalysis} disabled={busy}><Trash2 size={13} /> Remove local analysis</button></div></div>
        </section> : null}
        {remainingIssues.map((issue) => <section className="readiness-item" key={issue.id}>
          <span className="step-mark"><Settings2 size={15} /></span>
          <div><strong>{issue.title}</strong><p>{issue.detail}</p><div className="readiness-actions">{issue.action === 'filters' ? <button type="button" className="primary" onClick={onOpenFilters}><Filter size={13} /> Open Filters</button> : issue.action === 'refresh_sources' ? <button type="button" className="primary" onClick={onRefreshSources} disabled={busy}><ShieldCheck size={13} /> Accept current certified source</button> : issue.action === 'preview' ? <button type="button" className="primary" onClick={onRunAllPreviews} disabled={busy}><Play size={13} /> {busy ? 'Refreshing previews…' : 'Refresh all page previews'}</button> : <button type="button" className="primary" onClick={onOpenSources}><Blocks size={13} /> Replace or remove source</button>}</div></div>
        </section>)}
        {ready ? <div className="readiness-ready"><Check size={18} /><div><strong>Governed checks passed</strong><span>The published package will be Git-reviewable and no files are auto-staged or committed.</span></div></div> : null}
      </div>
      <footer><button type="button" onClick={onClose} disabled={busy}>Back to editing</button>{ready ? <button type="button" className="primary" onClick={onRetry} disabled={busy}>{busy ? 'Publishing…' : 'Publish to Project'}</button> : <span className="readiness-footer-hint">Choose a fix above. This review updates as you work.</span>}</footer>
    </section>
  </div>;
}

function AiPlanReview({
  proposal,
  summary,
  catalog,
  catalogQuery,
  sourcePolicy,
  selectedSourceIds,
  addingSourceId,
  busy,
  onRevise,
  onApply,
  onDismiss,
  onCatalogQuery,
  onAddSource,
  onAddProposalSource,
  onAnswerClarification,
  onGenerateGap,
  onToggleSource,
}: {
  proposal: AppStudioAiProposal;
  summary: AppStudioAiPlanSummary;
  catalog: AppBlockRecommendation[];
  catalogQuery: string;
  sourcePolicy: AppStudioBuildDraft['sourcePolicy'];
  selectedSourceIds: ReadonlySet<string>;
  addingSourceId: string | null;
  busy: boolean;
  onRevise: () => void;
  onApply: () => void;
  onDismiss: () => void;
  onCatalogQuery: (query: string) => void;
  onAddSource: (source: AppBlockRecommendation) => void;
  onAddProposalSource: (sourceId: string, reviewRequired: boolean) => void;
  onAnswerClarification: (questionId: string, answerId: string) => void;
  onGenerateGap: (requirementId: string) => void;
  onToggleSource: (sourceId: string) => void;
}): JSX.Element {
  const unresolved = proposal.clarifications.filter((item) => item.required && !item.answerId);
  const requirementOperation = proposal.operations.find((operation) => operation.type === 'set_requirements');
  const uncoveredRequirements = requirementOperation?.type === 'set_requirements'
    ? requirementOperation.requirements.filter((requirement) => requirementOperation.coverage?.some((coverage) => coverage.requirementId === requirement.id && coverage.status === 'gap'))
    : [];
  const selectedComponents = summary.components.filter((component) => !component.sourceId || selectedSourceIds.has(component.sourceId));
  const selectedSources = summary.sources.filter((source) => selectedSourceIds.has(source.id));
  const suggestedSources = summary.sources.filter((source) => !selectedSourceIds.has(source.id));
  const plannerProvenanceLabel = appStudioPlannerProvenanceLabel(proposal);
  const availableSources = availableAppStudioProposalSources(summary, catalog, catalogQuery).slice(0, 10);
  const sourceNeedle = catalogQuery.trim().toLowerCase();
  const matchesSourceQuery = (source: AppStudioAiPlanSummary['sources'][number]) => !sourceNeedle || [
    source.label, source.sourceRef, sourceKindLabel(source.kind), source.rationale ?? '',
    ...summary.components.filter((component) => component.sourceId === source.id).flatMap((component) => [component.title, component.visualization]),
  ].join(' ').toLowerCase().includes(sourceNeedle);
  const visibleSelectedSources = selectedSources.filter(matchesSourceQuery);
  const visibleSuggestedSources = suggestedSources.filter(matchesSourceQuery);
  const viewDescription = (source: AppStudioAiPlanSummary['sources'][number]) => {
    const views = summary.components.filter((component) => component.sourceId === source.id);
    if (!views.length) return 'AI will use this source as governed context.';
    return `Creates ${views.length} ${views.length === 1 ? 'view' : 'views'}: ${views.map((view) => view.title).join(', ')}`;
  };
  const sourceRow = (source: AppStudioAiPlanSummary['sources'][number], selected: boolean) => {
    const blockedByPolicy = source.trustState !== 'certified' && sourcePolicy === 'governed_only';
    const adding = addingSourceId === source.id;
    return <article key={source.id} className={`proposal-source-row ${selected ? 'selected' : ''}`}>
    <span className={`proposal-source-trust ${source.trustState}`}>{source.trustState === 'certified' ? <ShieldCheck size={15} /> : <FileText size={15} />}</span>
    <div><strong>{source.label}</strong><small>{sourceKindLabel(source.kind)} · {source.trustState === 'certified' ? 'Certified' : 'Review required'}</small><p>{viewDescription(source)}</p></div>
    <button type="button" className={selected ? 'remove' : 'add'} disabled={busy} title={blockedByPolicy ? 'Enable the local review lane and rebuild the proposal with this source.' : undefined} onClick={() => selected ? onToggleSource(source.id) : onAddProposalSource(source.id, blockedByPolicy)} aria-label={`${selected ? 'Remove' : blockedByPolicy ? 'Enable review lane and add' : 'Add'} ${source.label}${summary.sources.filter((item) => item.label === source.label).length > 1 ? ` for ${summary.components.filter((component) => component.sourceId === source.id).map((component) => component.title).join(', ') || source.id}` : ''}`}>
      {selected ? <><X size={13} /> Remove</> : adding ? 'Adding…' : blockedByPolicy ? 'Enable review lane & add' : <><Plus size={13} /> Add</>}
    </button>
  </article>;
  };

  return <section className="studio-ai-plan proposal-source-picker" aria-labelledby="proposal-source-title">
    <header>
      <span><Sparkles size={18} /></span>
      <div>
        <small>REVIEW BEFORE GENERATION</small>
        <h1 id="proposal-source-title">Choose proposed sources</h1>
        <p>AI understood: <strong>{summary.frame?.goal ?? 'Build a governed analytics App'}</strong>. Select the data you trust; DQL will generate the App only after you continue.</p>
        {plannerProvenanceLabel ? <small className="proposal-planner-provenance">{plannerProvenanceLabel}</small> : null}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Back to App decision"><X size={16} /></button>
    </header>

    <div className="proposal-source-summary" aria-label="AI proposal summary">
      <span><strong>{selectedSources.length}</strong> selected sources</span>
      <span><strong>{selectedComponents.length}</strong> planned views</span>
      <span><strong>{sourcePolicy === 'governed_only' ? 'Governed only' : 'Review lane enabled'}</strong> source policy</span>
    </div>

    <div className="proposal-source-body">
      <label className="proposal-source-search"><Search size={15} /><input value={catalogQuery} onChange={(event) => onCatalogQuery(event.target.value)} placeholder="Search proposed and available sources" aria-label="Search proposed and available sources" /></label>

      <section className="proposal-source-group" aria-labelledby="selected-proposal-sources">
        <div className="proposal-source-heading"><div><h2 id="selected-proposal-sources">Selected for this App</h2><p>Remove anything you do not want AI to use.</p></div><strong>{selectedSources.length}</strong></div>
        <div className="proposal-source-list">
          {visibleSelectedSources.map((source) => sourceRow(source, true))}
          {!selectedSources.length ? <div className="proposal-source-empty"><Blocks size={18} /><div><strong>Select at least one source</strong><p>Add an AI suggestion or another governed block below.</p></div></div> : null}
          {selectedSources.length > 0 && !visibleSelectedSources.length ? <p className="studio-ai-plan-empty">No selected source matches this search.</p> : null}
        </div>
      </section>

      {visibleSuggestedSources.length ? <section className="proposal-source-group" aria-labelledby="ai-source-suggestions">
        <div className="proposal-source-heading"><div><h2 id="ai-source-suggestions">AI suggestions</h2><p>Sources removed from the selection remain available here.</p></div><strong>{suggestedSources.length}</strong></div>
        <div className="proposal-source-list">{visibleSuggestedSources.map((source) => sourceRow(source, false))}</div>
      </section> : null}

      <section className="proposal-source-group" aria-labelledby="available-proposal-sources">
        <div className="proposal-source-heading"><div><h2 id="available-proposal-sources">More App sources</h2><p>Add a certified block, or explicitly open the local review lane for a draft.</p></div><strong>{availableSources.length}</strong></div>
        <div className="proposal-catalog-list">
          {availableSources.map((source) => <article key={source.id}>
            <span className={source.status === 'certified' ? 'certified' : 'review_required'}>{source.status === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
            <div><strong>{humanize(source.name)}</strong><small>{source.domain || 'General'} · {source.status === 'certified' ? 'Certified block' : 'Review required'}</small><p>{source.description || source.reasons[0] || 'Available governed data source'}</p></div>
            <button type="button" onClick={() => onAddSource(source)} disabled={busy} title={source.eligibility?.localPreview === false ? 'Enable the local review lane and rebuild the proposal with this source.' : undefined}>{addingSourceId === (source.sourceId ?? source.id) ? 'Adding…' : source.eligibility?.localPreview === false ? 'Enable review lane & add' : <><Plus size={13} /> Add</>}</button>
          </article>)}
          {!availableSources.length ? <p className="studio-ai-plan-empty">{catalogQuery.trim() ? 'No additional source matches this search.' : 'All available governed sources are already proposed.'}</p> : null}
        </div>
      </section>

      {sourcePolicy === 'include_review_required' ? <div className="studio-ai-review-lane"><FileText size={14} /><p><strong>Review-required analysis is enabled</strong><small>It stays clearly labeled and cannot be published to the Project until it is replaced, promoted, or removed.</small></p></div> : <div className="studio-ai-review-lane"><FileText size={14} /><p><strong>Draft sources require an explicit review lane</strong><small>Use “Enable review lane &amp; add” on the draft you want. Its trust does not change.</small></p></div>}
      {uncoveredRequirements.length ? <section className="studio-ai-questions"><header><strong>Uncovered requirements</strong><small>{uncoveredRequirements.length} gaps</small></header>{uncoveredRequirements.map((requirement) => <div key={requirement.id}><p>{requirement.question}</p><button type="button" onClick={() => onGenerateGap(requirement.id)} disabled={busy || sourcePolicy !== 'include_review_required'}>{sourcePolicy === 'include_review_required' ? 'Explicitly generate review-required DQL' : 'Enable review lane to generate'}</button></div>)}</section> : null}
      {unresolved.length ? <section className="studio-ai-questions"><header><strong>AI needs one more decision</strong><small>{unresolved.length} required</small></header>{unresolved.map((item) => <fieldset key={item.id}><legend>{item.question}</legend>{item.choices.map((choice) => <button key={choice.id} type="button" onClick={() => onAnswerClarification(item.id, choice.id)} disabled={busy}><strong>{choice.label}</strong>{choice.description ? <small>{choice.description}</small> : null}</button>)}</fieldset>)}<button type="button" onClick={onRevise} disabled={busy}>{busy ? 'Updating…' : 'Re-run proposal'}</button></section> : null}
    </div>

    <footer><span>{selectedSources.length} sources · {selectedComponents.length} views will be generated</span><button type="button" onClick={onDismiss}>Back to decision</button><button type="button" className="primary" onClick={onApply} disabled={busy || unresolved.length > 0 || selectedSources.length === 0}><Sparkles size={14} /> {busy ? 'Generating…' : `Generate App with ${selectedSources.length} ${selectedSources.length === 1 ? 'source' : 'sources'}`}</button></footer>
  </section>;
}

/**
 * The browser sends opaque App identity only. App Autopilot reconstructs the
 * current persisted draft, page, tile, Dataset contract, and any eligible
 * preview reference on the server before a provider sees the request.
 */
export function appAutopilotPresentationContextKey(input: {
  draftId?: string;
  pageId?: string;
  tileId?: string;
  previewRunId?: string;
}): string {
  return `${input.draftId ?? 'new'}:${input.pageId || 'no-page'}:${input.tileId ?? 'no-tile'}:${input.previewRunId ?? 'no-preview'}`;
}

export function appAutopilotContext(
  draft: AppStudioBuildDraft,
  page: AppStudioBuildDraft['pages'][number] | null,
  selectedTile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] | null,
  previewRun: DashboardRunResponse | null,
): Record<string, unknown> {
  return {
    surface: 'app_autopilot',
    appBuildId: draft.id,
    appId: draft.appId,
    ...(page ? { pageId: page.id } : {}),
    ...(selectedTile ? { tileId: selectedTile.i } : {}),
    ...(previewRun ? { previewRunId: previewRun.runId } : {}),
  };
}

function appAutopilotProposalFromArtifact(value: unknown): AppAutopilotChangeProposal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proposal = value as Partial<AppAutopilotChangeProposal>;
  if (proposal.version !== 1
    || typeof proposal.id !== 'string'
    || typeof proposal.runId !== 'string'
    || typeof proposal.artifactId !== 'string'
    || typeof proposal.draftId !== 'string'
    || typeof proposal.pageId !== 'string'
    || typeof proposal.tileId !== 'string'
    || !proposal.intent
    || typeof proposal.intent.action !== 'string'
    || typeof proposal.intent.request !== 'string'
    || typeof proposal.proposalHash !== 'string'
    || proposal.planningMode !== 'universal_agent'
    || !Array.isArray(proposal.operations)
    || !Array.isArray(proposal.diagnostics)) return null;
  return proposal as AppAutopilotChangeProposal;
}

/** Review card for a universal AgentRun artifact, not a second App chat lane. */
export function AppAutopilotReviewCard({
  proposal,
  running,
  onDiscard,
  onApply,
}: {
  proposal: AppAutopilotChangeProposal;
  running: boolean;
  onDiscard: () => void;
  onApply: () => void;
}): JSX.Element {
  const update = proposal.operations[0];
  const query = update?.type === 'update_tile' ? update.patch.query : undefined;
  const grouping = query?.dimensions.map((dimension) => humanize(dimension.alias ?? dimension.field)).join(', ');
  const action = humanize(proposal.intent.action);
  return <section className="studio-copilot-change" aria-label="Typed App change">
    <header><div><small>AI TILE CHANGE</small><strong>Review before it changes the draft</strong></div><span>Draft only</span></header>
    <div className="studio-copilot-change-summary">
      <strong>{humanize(proposal.tileId)}</strong>
      <span>{grouping ? `Proposed grouping: ${grouping}` : `${action}: ${proposal.operations.length} typed App operation${proposal.operations.length === 1 ? '' : 's'} prepared`}</span>
      <small>Prepared through the shared Agent Run and current governed App and Dataset contracts. This has not changed the draft or its source.</small>
    </div>
    {proposal.diagnostics.map((diagnostic) => <p className={`studio-copilot-diagnostic ${diagnostic.severity}`} key={diagnostic.code}>{diagnostic.message}</p>)}
    <footer><button type="button" onClick={onDiscard} disabled={running}>Discard</button><button type="button" className="primary" onClick={onApply} disabled={running}>{running ? 'Applying…' : 'Apply change'}</button></footer>
  </section>;
}

function PagesPanel({ draft, activePageId, onOpen, onAdd }: { draft: AppStudioBuildDraft; activePageId?: string; onOpen: (id: string) => void; onAdd: () => void }): JSX.Element {
  return <><PanelTitle title="Pages" detail="Organize the App story" action={<button type="button" onClick={onAdd}><Plus size={14} /></button>} /><div className="studio-list">{draft.pages.map((page, index) => <button key={page.id} type="button" className={page.id === activePageId ? 'on' : ''} onClick={() => onOpen(page.id)}><span>{index + 1}</span><div><strong>{page.metadata.title}</strong><small>{page.layout.items.length} components</small></div></button>)}</div></>;
}

function SourcesPanel({
  usedSources,
  items,
  selected,
  query,
  loading,
  error,
  disabled,
  datasetTilesEnabled,
  enablingDatasets = false,
  onEnableDatasets,
  sourceFeedback,
  onQuery,
  onSelect,
  onAdd,
  onAddDataset,
  onAuthorDataset,
  onRefreshDatasetBinding,
  onAddContent,
  policy,
  total,
  hasMore,
  onLoadMore,
  onEnableReview,
}: {
  usedSources: AppStudioBuildDraft['sources'];
  items: AppBlockRecommendation[];
  selected: AppBlockRecommendation | null;
  query: string;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  datasetTilesEnabled: boolean;
  enablingDatasets?: boolean;
  onEnableDatasets?: () => void;
  sourceFeedback: AppStudioSourceFeedback | null;
  onQuery: (value: string) => void;
  onSelect: (item: AppBlockRecommendation) => void;
  onAdd: (item: AppBlockRecommendation, kind: 'kpi' | 'chart' | 'table') => void;
  onAddDataset: (item: AppBlockRecommendation, kind: 'kpi' | 'chart' | 'table', query: TileQuery, title?: string) => void;
  onAuthorDataset: (item: AppBlockRecommendation) => void;
  onRefreshDatasetBinding: (sourceId: string) => void;
  onAddContent: (kind: 'heading' | 'text') => void;
  policy: AppStudioBuildDraft['sourcePolicy'];
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
  onEnableReview: () => void;
}): JSX.Element {
  const [viewFilter, setViewFilter] = useState<'all' | 'kpi' | 'chart' | 'table'>('all');
  const usedDataSources = usedSources.filter((source) => source.kind !== 'text');
  const usedIdentifiers = new Set(usedDataSources.flatMap((source) => [source.id, source.sourceRef]));
  const visibleItems = items.filter((item) => viewFilter === 'all' || recommendedComponentKind(item) === viewFilter);
  return <>
    <PanelTitle title="Sources" detail="Choose a Dataset, then build a governed field tile" />
    {!datasetTilesEnabled ? <div className="source-catalog-empty" role="status"><strong>Build tiles from Dataset fields</strong><small>Pick measures and groupings from a governed Dataset instead of pinning a finished block. This writes <code>{'"apps": { "datasets": true }'}</code> to <code>dql.config.json</code>.</small>{onEnableDatasets ? <button type="button" className="primary" disabled={disabled || enablingDatasets} onClick={onEnableDatasets}>{enablingDatasets ? 'Turning on…' : 'Turn on field-based tiles'}</button> : null}</div> : null}
    <label className="source-search-primary">
      <Search size={15} />
      <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search blocks, metrics, or domains" aria-label="Search governed sources" />
      {query ? <button type="button" onClick={() => onQuery('')} aria-label="Clear source search" title="Clear search"><X size={13} /></button> : null}
    </label>
    <details className="used-sources-disclosure">
      <summary>
        <div><strong>In this App</strong><small>{usedDataSources.length ? `${usedDataSources.length} data ${usedDataSources.length === 1 ? 'source' : 'sources'}` : 'No source added yet'}</small></div>
        <span>{usedDataSources.length}</span><ChevronDown size={14} />
      </summary>
      {usedDataSources.length ? <div className="used-source-list">{usedDataSources.map((source) => <div key={source.id}>
        <span className={source.trustState}>{source.trustState === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
        <p><strong title={source.sourceRef}>{humanize(source.sourceRef)}</strong><small>{sourceKindLabel(source.kind)} · {source.trustState === 'certified' ? 'Certified' : 'Review required'}</small></p>
      </div>)}</div> : <div className="source-panel-state compact"><Blocks size={15} /><div><strong>No data source added yet</strong><small>Choose a source below and add a view.</small></div></div>}
    </details>
    {policy === 'include_review_required' ? <div className="source-review-lane"><FileText size={14} /><p><strong>Review-required analysis lane is on</strong><small>Referenced DQL or exploratory SQL appears here with a review label. It remains local and cannot publish until resolved.</small></p></div> : null}
    <div className="source-catalog-toolbar">
      <div className="source-view-tabs" role="tablist" aria-label="Filter sources by recommended view">
        {([['all', 'All'], ['kpi', 'KPI'], ['chart', 'Charts'], ['table', 'Tables']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={viewFilter === value} className={viewFilter === value ? 'on' : ''} onClick={() => setViewFilter(value)}>{label}</button>)}
      </div>
      <small aria-live="polite">{loading ? 'Finding…' : `${visibleItems.length} of ${total} ${total === 1 ? 'result' : 'results'}`}</small>
    </div>
    {loading ? <div className="source-panel-state"><Sparkles size={16} /><div><strong>Finding governed sources</strong><small>Matching certified blocks and semantic data to this App decision.</small></div></div> : null}
    {!loading && error ? <div className="source-panel-state error"><X size={16} /><div><strong>Sources could not load</strong><small>{error}</small></div></div> : null}
    {!loading && !error && visibleItems.length === 0 ? <div className="source-panel-state"><Search size={16} /><div><strong>{query.trim() || viewFilter !== 'all' ? 'No source matches these filters' : 'No governed source matched yet'}</strong><small>{query.trim() || viewFilter !== 'all' ? 'Clear the search or choose All to see every governed source.' : 'Refine the business decision or enable the review-required lane for additional local options.'}</small></div></div> : null}
    <div className="source-catalog-list">{visibleItems.map((item) => {
      const kind = recommendedComponentKind(item);
      const isSelected = selected?.id === item.id;
      const sourceId = item.sourceId ?? item.id;
      const isUsed = usedIdentifiers.has(sourceId) || usedIdentifiers.has(item.id) || usedIdentifiers.has(item.name);
      const blockedByPolicy = item.eligibility?.localPreview === false && policy === 'governed_only';
      const datasetDisabled = Boolean(item.capabilities?.dataset) && !datasetTilesEnabled;
      const rowFeedback = sourceFeedback?.sourceId === sourceId ? sourceFeedback : null;
      const actionStatus: AppStudioSourceActionStatus = rowFeedback?.status ?? 'idle';
      const actionLabel = appStudioSourceActionLabel({
        view: componentKindLabel(kind),
        status: actionStatus,
        reviewRequired: blockedByPolicy,
        alreadyUsed: isUsed,
        pageTitle: rowFeedback?.pageTitle,
      });
      return <article key={item.id} className={`source-catalog-row ${isSelected ? 'on' : ''}`}>
        <button type="button" className="source-catalog-summary" onClick={() => onSelect(item)} aria-label={`View ${item.name} source details`} aria-expanded={isSelected}>
          <span className={item.status === 'certified' ? 'certified' : 'review'}>{item.status === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
          <div><strong title={item.name}>{humanize(item.name)}</strong><small>{humanize(item.domain)} · {sourceCatalogKindLabel(item)} · {item.status === 'certified' ? 'Certified' : 'Review required'}{isUsed ? ' · In App' : ''}</small></div>
        </button>
        <button type="button" className="source-add-view" disabled={disabled || datasetDisabled} title={datasetDisabled ? 'Turn on field-based tiles at the top of this list to build from Dataset fields.' : blockedByPolicy ? 'Enable the review lane and add this draft block in one saved change.' : undefined} onClick={() => item.capabilities?.dataset ? onSelect(item) : onAdd(item, kind)} aria-label={item.capabilities?.dataset ? `Configure fields for ${item.name}` : `${actionLabel}: ${item.name}`}>{item.capabilities?.dataset ? <><Settings2 size={13} /> Configure fields</> : <><Plus size={13} /> {actionLabel}</>}</button>
        {rowFeedback ? <small className={`source-action-feedback ${rowFeedback.status}`} role={rowFeedback.status === 'error' ? 'alert' : 'status'}>{rowFeedback.status === 'error' ? rowFeedback.message : actionLabel}</small> : null}
        {isSelected ? <div className="source-catalog-detail">
          <p>{item.description || `${humanize(item.name)} from the ${humanize(item.domain)} domain.`}</p>
          {blockedByPolicy ? <button type="button" className="review-action" onClick={onEnableReview}><FileText size={12} /> Enable review-required sources</button> : null}
          {(item.filterIds?.length ?? 0) > 0 ? <span><Filter size={12} /> {item.filterIds!.length} supported {item.filterIds!.length === 1 ? 'filter' : 'filters'}</span> : null}
          {item.capabilities?.dataset && datasetTilesEnabled
            ? <><DatasetTileBuilder key={`${item.sourceId ?? item.id}:${item.sourceRevision ?? item.fingerprint}`} source={item} disabled={disabled || blockedByPolicy} onAdd={onAddDataset} />
              {datasetSourceAuthoringModel(item) ? <button type="button" className="dataset-author-source" disabled={disabled} onClick={() => onAuthorDataset(item)}><FileText size={12} /> Author Dataset definition</button> : item.capabilities.dataset.kind === 'semantic' ? <small className="field-help">This Dataset’s fields and measures are owned by its governed semantic provider.</small> : null}
              {isUsed ? <button type="button" className="dataset-author-source" disabled={disabled || !item.sourceId} onClick={() => item.sourceId && onRefreshDatasetBinding(item.sourceId)}><ShieldCheck size={12} /> Refresh this App binding</button> : null}
            </>
            : item.capabilities?.dataset
              ? <div className="source-view-options"><small>Turn on field-based tiles at the top of this list to build from this Dataset's fields.</small></div>
            : <div className="source-view-options" aria-label={`Add ${item.name} with another view`}>
              <button type="button" disabled={disabled} aria-label={blockedByPolicy ? `Enable review lane and add ${item.name} as KPI` : undefined} onClick={() => onAdd(item, 'kpi')}><Gauge size={13} /> KPI</button>
              <button type="button" disabled={disabled} aria-label={blockedByPolicy ? `Enable review lane and add ${item.name} as Chart` : undefined} onClick={() => onAdd(item, 'chart')}><BarChart3 size={13} /> Chart</button>
              <button type="button" disabled={disabled} aria-label={blockedByPolicy ? `Enable review lane and add ${item.name} as Table` : undefined} onClick={() => onAdd(item, 'table')}><Table2 size={13} /> Table</button>
            </div>}
        </div> : null}
      </article>;
    })}</div>
    {hasMore ? <button type="button" className="source-load-more" onClick={onLoadMore} disabled={loading || disabled}>{loading ? 'Loading…' : 'Load 50 more sources'}</button> : null}
    <div className="panel-section-label"><span>Page elements</span><small>No data required</small></div>
    <div className="content-quick-add"><button type="button" disabled={disabled} onClick={() => onAddContent('heading')}><Heading size={15} /><span><strong>Heading</strong><small>Organize the story</small></span><Plus size={13} /></button><button type="button" disabled={disabled} onClick={() => onAddContent('text')}><Type size={15} /><span><strong>Text</strong><small>Add context or guidance</small></span><Plus size={13} /></button></div>
  </>;
}

function TemplatesPanel({ current, onApply }: { current: StudioTemplate; onApply: (id: StudioTemplate) => void }): JSX.Element {
  return <><PanelTitle title="Templates" detail="Professional analytical structures" /><div className="template-list">{TEMPLATE_OPTIONS.map((item) => <button key={item.id} type="button" className={current === item.id ? 'on' : ''} onClick={() => onApply(item.id)}><span>{templateIcon(item.id)}</span><div><strong>{item.title}</strong><small>{item.description}</small></div></button>)}</div></>;
}

function BuildFrameInspector({ draft, prompt, previewRun, onPrompt, onAskAi, onSourcePolicy, onResolveTask, onApproveSemantic }: { draft: AppStudioBuildDraft; prompt: string; previewRun: DashboardRunResponse | null; onPrompt: (value: string) => void; onAskAi: () => void; onSourcePolicy: (value: AppStudioBuildDraft['sourcePolicy']) => void; onResolveTask: (task: AppStudioBuildDraft['reviewTasks'][number]) => void; onApproveSemantic: () => void }): JSX.Element {
  const openTasks = blockingPublicationReviewTasks(draft);
  const semanticNeedsApproval = legacySemanticTilesNeedingApproval(draft).length > 0;
  return <div className="inspector-body"><section><label>Business decision</label><textarea value={prompt} onChange={(event) => onPrompt(event.target.value)} rows={5} /></section><section><label>Source policy</label><select value={draft.sourcePolicy} onChange={(event) => onSourcePolicy(event.target.value as AppStudioBuildDraft['sourcePolicy'])}><option value="governed_only">Governed sources only</option><option value="include_review_required">Include review-required analysis</option></select><small className="field-help">Review-required sources stay local and block Project publication until replaced or promoted.</small></section><section className="frame-facts"><label>Build Frame</label><div><span>Audience</span><strong>{draft.frame.audience || 'Stakeholders'}</strong></div><div><span>Metrics</span><strong>{draft.frame.metrics.join(', ') || 'Needs clarification'}</strong></div><div><span>Dimensions</span><strong>{draft.frame.dimensions.join(', ') || 'Automatic'}</strong></div><div><span>Source policy</span><strong>{draft.sourcePolicy === 'governed_only' ? 'Governed only' : 'Includes review lane'}</strong></div></section>{semanticNeedsApproval ? <section><label>Semantic review</label><button type="button" className="review-action" onClick={onApproveSemantic} disabled={!previewRun}><ShieldCheck size={14} /> {previewRun ? 'Approve this settled result' : 'Run preview to approve'}</button></section> : null}{openTasks.length ? <section className="review-task-list"><label>Review tasks</label>{openTasks.map((task) => <div key={task.id}><span>{task.message}</span><button type="button" onClick={() => onResolveTask(task)}><Check size={12} /> Resolve</button></div>)}</section> : null}<button type="button" className="ask-ai" onClick={onAskAi}><Bot size={16} /> Ask AI to build or revise this page</button><section className="trust-summary"><ShieldCheck size={17} /><div><strong>Nothing publishes silently</strong><p>AI changes are typed diffs. Project publication revalidates live source trust and filter bindings.</p></div></section></div>;
}

export function ComponentInspector({ tile, run, pageId, page, pages, sources, dataset, disabled, onOpenSources, onSaveDatasetTileAsBlock, savingDatasetTileAsBlock, savedDatasetReviewDraft, onReplaceDatasetTileWithBlock = () => undefined, replacingDatasetTileWithBlock = false, onPreviewLegacySemanticConversion = () => undefined, previewingLegacySemanticConversion = false, semanticTileConversionPreview, onAcceptLegacySemanticConversion = () => undefined, acceptingLegacySemanticConversion = false, onRefreshDatasetTile, onUpdate, onUpdateInteractions, onDelete }: { tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]; run?: DashboardRunResponse['tiles'][number]; pageId: string; page: AppStudioBuildDraft['pages'][number]; pages: AppStudioBuildDraft['pages']; sources: AppStudioBuildDraft['sources']; dataset?: DatasetDescriptor; disabled: boolean; onOpenSources: () => void; onSaveDatasetTileAsBlock: () => void; savingDatasetTileAsBlock: boolean; savedDatasetReviewDraft?: Extract<DatasetTileSaveAsBlockResponse, { ok: true }>; onReplaceDatasetTileWithBlock?: () => void; replacingDatasetTileWithBlock?: boolean; onPreviewLegacySemanticConversion?: () => void; previewingLegacySemanticConversion?: boolean; semanticTileConversionPreview?: Extract<SemanticTileConversionPreviewResponse, { ok: true }>; onAcceptLegacySemanticConversion?: () => void; acceptingLegacySemanticConversion?: boolean; onRefreshDatasetTile: () => void; onUpdate: (patch: Partial<typeof tile>) => void; onUpdateInteractions: (interactions: AppStudioBuildDraft['pages'][number]['interactions']) => void; onDelete: () => void }): JSX.Element {
  const [title, setTitle] = useState(tile.title ?? '');
  const [markdown, setMarkdown] = useState(tile.text?.markdown ?? '');
  const [visualizationFeedback, setVisualizationFeedback] = useState<string | null>(null);
  useEffect(() => setTitle(tile.title ?? ''), [tile.i, tile.title]);
  useEffect(() => setMarkdown(tile.text?.markdown ?? ''), [tile.i, tile.text?.markdown]);
  useEffect(() => setVisualizationFeedback(null), [tile.i]);
  const options = tile.viz.options ?? {};
  const columns = run?.result?.columns ?? [];
  const grainKeyCheck = formatDatasetGrainEvidenceKeyCheck(run?.dataset?.grainRuntimeEvidence);
  const currentDatasetEvidence = run && tile.query && isCurrentDatasetTileEvidence(tile, run)
    ? presentDatasetTileEvidence(run)
    : undefined;
  const setOption = (key: string, value: unknown) => onUpdate({ viz: { ...tile.viz, options: { ...options, [key]: value || undefined } } });
  const updateDatasetQuery = (query: TileQuery, recovery?: { visualization: 'table'; message: string }) => {
    if (recovery) {
      setVisualizationFeedback(`${recovery.message} The component was changed to Table; selected fields were kept.`);
      onUpdate({ query, viz: { ...tile.viz, type: recovery.visualization } });
      return;
    }
    setVisualizationFeedback(null);
    onUpdate({ query });
  };
  const updateVisualization = (type: typeof tile.viz.type) => {
    if (tile.query && dataset) {
      const visualization = datasetTileVisualizationCompatibility(tile.query, type);
      if (!visualization.compatible) {
        setVisualizationFeedback(`${visualization.message} Choose Table or change the Dataset field selection first.`);
        return;
      }
    }
    setVisualizationFeedback(null);
    onUpdate({ viz: { ...tile.viz, type } });
  };
  const savedDatasetVisualization = tile.query && dataset
    ? datasetTileVisualizationCompatibility(tile.query, tile.viz.type)
    : undefined;
  return <div className="inspector-body">
    <section><label>Title</label><input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (title.trim() !== (tile.title ?? '')) onUpdate({ title: title.trim() }); }} /></section>
    {tile.text ? <section><label>Content</label><textarea rows={7} value={markdown} onChange={(event) => setMarkdown(event.target.value)} onBlur={() => { if (markdown !== tile.text?.markdown) onUpdate({ text: { markdown } }); }} /><small className="field-help">Safe Markdown only. Executable HTML and JavaScript are not supported.</small></section> : null}
    {tile.query && dataset ? <DatasetTileQueryInspector descriptor={dataset} query={tile.query} visualization={tile.viz.type} disabled={disabled} onChange={updateDatasetQuery} onOpenSources={onOpenSources} /> : null}
    {tile.query && dataset ? <DatasetInteractionInspector tile={tile} page={page} pages={pages} sources={sources} descriptor={dataset} disabled={disabled} onChange={onUpdateInteractions} /> : null}
    <section><label>Visualization</label><select value={tile.viz.type} onChange={(event) => updateVisualization(event.target.value as typeof tile.viz.type)}>{['single_value', 'kpi', 'bar', 'line', 'area', 'scatter', 'heatmap', 'table', 'pivot', 'text', 'heading'].map((type) => <option key={type} value={type}>{humanize(type)}</option>)}</select>{savedDatasetVisualization && !savedDatasetVisualization.compatible ? <small className="dataset-builder-error" role="alert">{savedDatasetVisualization.message} Choose Table to keep all selected fields visible.</small> : null}{visualizationFeedback ? <small className="dataset-interaction-message" role="status">{visualizationFeedback}</small> : null}</section>
    {!tile.text ? <section className="field-mapping"><label>Field mapping</label><div><span>X / category</span><select value={String(options.x ?? '')} onChange={(event) => setOption('x', event.target.value)}><option value="">Auto</option>{columns.map((column) => <option key={column} value={column}>{humanize(column)}</option>)}</select></div><div><span>Y / value</span><select value={String(options.y ?? '')} onChange={(event) => setOption('y', event.target.value)}><option value="">Auto</option>{columns.map((column) => <option key={column} value={column}>{humanize(column)}</option>)}</select></div><small className="field-help">Run preview to load the exact result fields.</small></section> : null}
    {!tile.text ? <section className="format-grid"><label>Formatting</label><div><span>Number</span><select value={String(options.format ?? 'number')} onChange={(event) => setOption('format', event.target.value)}><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="duration">Duration</option></select></div><div><span>Legend</span><select value={String(options.legendPosition ?? 'right')} onChange={(event) => setOption('legendPosition', event.target.value)}><option value="top">Top</option><option value="right">Right</option><option value="bottom">Bottom</option><option value="none">Hidden</option></select></div></section> : null}
    <section><label>Responsive size</label><div className="size-buttons">{[['Compact', 3, 2], ['Standard', 6, 4], ['Wide', 12, 4], ['Tall', 6, 7]].map(([label, w, h]) => <button key={label} type="button" onClick={() => onUpdate({ w: Number(w), h: Number(h) })}>{label}</button>)}</div></section>
    <section className="data-trust"><label>Data & trust</label><div><span className={`trust-dot ${tile.trustState ?? 'draft_ready'}`} /><strong>{humanize(tile.trustState ?? 'draft_ready')}</strong></div><p>{tile.query && dataset ? `Dataset: ${dataset.label} · ${dataset.kind === 'semantic' ? 'governed semantic source' : 'governed block source'}` : tile.block ? `${tile.trustState === 'certified' ? 'Certified' : 'Review-required'} block: ${'blockId' in tile.block ? tile.block.blockId : tile.block.ref}` : tile.semantic ? `Governed semantic query: ${tile.semantic.id}` : tile.draftAnalysis ? `Review-required DQL: ${tile.draftAnalysis.ref}` : 'Local narrative component'}</p>{tile.sourceEvidence?.slice(0, 2).map((evidence, index) => <small key={`${evidence.source}-${index}`}>{evidence.reason}</small>)}{run ? <small>{run.status === 'ok' ? `Settled on ${run.result?.rowCount ?? run.result?.rows.length ?? 0} rows` : run.error}</small> : null}{grainKeyCheck ? <small>Full-source key check: {grainKeyCheck}</small> : null}{run?.dataset?.cacheDelivery ? <div className="dataset-cache-delivery"><small>Cached {new Date(run.dataset.cacheDelivery.cachedAt).toLocaleString()} · this is not fresh publication or reusable-block evidence.</small><button type="button" disabled={disabled} onClick={onRefreshDatasetTile}>Refresh live data</button></div> : null}{tile.query ? <details className="dataset-dql-receipt"><summary>View execution evidence</summary>{currentDatasetEvidence ? <DatasetTileExecutionEvidence presentation={currentDatasetEvidence} /> : <p>{run ? 'This execution evidence no longer matches the selected Dataset source or query. Run a governed preview to inspect the current Dataset query, executed SQL, binding evidence, and provenance.' : 'Run a governed preview to inspect the current Dataset query, executed SQL, binding evidence, and provenance.'}</p>}</details> : null}{tile.query ? <div className="dataset-reusable-block"><strong>Reusable block</strong><p>Save this settled result as a separate review draft. This App tile stays unchanged and the new block is not certified.</p><button type="button" disabled={disabled || savingDatasetTileAsBlock || replacingDatasetTileWithBlock || !currentDatasetEvidence || Boolean(run?.dataset?.cacheDelivery)} onClick={onSaveDatasetTileAsBlock}>{savingDatasetTileAsBlock ? 'Saving review draft…' : 'Save as reusable review draft'}</button>{savedDatasetReviewDraft ? <div className="dataset-review-replacement"><small>Saved review draft: {savedDatasetReviewDraft.path}</small>{savedDatasetReviewDraft.replacementEligible ? <button type="button" disabled={disabled || savingDatasetTileAsBlock || replacingDatasetTileWithBlock || !currentDatasetEvidence || Boolean(run?.dataset?.cacheDelivery)} onClick={onReplaceDatasetTileWithBlock}>{replacingDatasetTileWithBlock ? 'Proving equivalence…' : 'Replace with this review draft'}</button> : <small>{savedDatasetReviewDraft.replacementMessage ?? 'This saved draft is fixed-value only and cannot replace the interactive Dataset tile.'}</small>}</div> : null}{!currentDatasetEvidence ? <small>Run the current Dataset tile before saving it.</small> : null}{run?.dataset?.cacheDelivery ? <small>Refresh live data before saving or replacing this tile.</small> : null}</div> : null}</section>
    {tile.semantic && !tile.query ? <section className="dataset-reusable-block"><strong>Convert to Dataset query</strong><p>Preview an exact field-query mapping for this legacy semantic tile. DQL runs both paths in one fresh read scope before it can apply the change. The original semantic payload is retained as provenance; this does not certify the source.</p><button type="button" disabled={disabled || previewingLegacySemanticConversion || acceptingLegacySemanticConversion} onClick={onPreviewLegacySemanticConversion}>{previewingLegacySemanticConversion ? 'Proving conversion…' : 'Preview Dataset conversion'}</button>{semanticTileConversionPreview ? <div className="dataset-review-replacement"><small>Mapped source: {semanticTileConversionPreview.candidate.sourceId}</small><small>Mapped query: {semanticTileConversionPreview.candidate.query.measures.map((measure) => measure.measure).join(', ')}{semanticTileConversionPreview.candidate.query.dimensions.length ? ` by ${semanticTileConversionPreview.candidate.query.dimensions.map((dimension) => dimension.field).join(', ')}` : ''}</small><button type="button" disabled={disabled || previewingLegacySemanticConversion || acceptingLegacySemanticConversion} onClick={onAcceptLegacySemanticConversion}>{acceptingLegacySemanticConversion ? 'Rechecking and applying…' : 'Apply Dataset conversion'}</button></div> : <small>Preview first. Unsupported bindings, source drift, or an incomplete comparison stay with the original semantic tile.</small>}</section> : null}
    <button type="button" className="delete-component" onClick={onDelete}><Trash2 size={15} /> Remove component</button><small className="inspector-id">{pageId} / {tile.i}</small>
  </div>;
}

function DatasetEvidenceRows({ rows }: { rows: DatasetEvidenceRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return <dl className="dataset-evidence-rows">{rows.map((row) => <div key={`${row.label}:${row.value}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

function DatasetTileExecutionEvidence({ presentation }: { presentation: DatasetTileEvidencePresentation }): JSX.Element {
  return <div className="dataset-execution-evidence">
    <small>Authored Dataset query specification (declarative; not DQL)</small>
    <pre>{presentation.authoredQuerySpec ?? presentation.authoredQuerySpecUnavailable}</pre>
    <small>Executed SQL (server returned)</small>
    <pre>{presentation.executedSql ?? presentation.executedSqlUnavailable}</pre>
    <small>Bound parameter evidence (values redacted)</small>
    <DatasetEvidenceRows rows={presentation.parameterEvidence} />
    <small>Execution provenance</small>
    <DatasetEvidenceRows rows={presentation.provenance} />
    <small>{presentation.receipt.kind === 'semantic_provider_receipt' ? 'Semantic provider execution receipt' : 'Provider execution receipt'}</small>
    {presentation.receipt.rows.length ? <DatasetEvidenceRows rows={presentation.receipt.rows} /> : null}
    {presentation.receipt.notice ? <p>{presentation.receipt.notice}</p> : null}
  </div>;
}

function StaticComponentPreview({ loading }: { loading: boolean }): JSX.Element {
  if (loading) return <div className="preview-state loading"><span className="preview-loading-mark"><Play size={15} /></span><strong>Running governed preview…</strong><span>Loading current data with this App’s filters and source policy.</span></div>;
  return <div className="preview-state idle"><span className="preview-idle-mark"><Play size={15} /></span><strong>Preview is not loaded</strong><span>App Studio runs this automatically when the data tile is added. Use Run preview to refresh an older draft.</span></div>;
}

function StudioFilterControl({
  filter,
  availability,
  value,
  applying,
  onChange,
}: {
  filter: NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number];
  availability?: StudioFilterAvailability;
  value: unknown;
  applying: boolean;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const label = filter.label ?? humanize(filter.id);
  const optionValues = Array.from(new Set([...(filter.options ?? []), ...(availability?.values ?? [])]));
  const [query, setQuery] = useState(String(value ?? ''));
  useEffect(() => setQuery(String(value ?? '')), [value]);
  if (filter.type === 'daterange') {
    const range = value && typeof value === 'object' && !Array.isArray(value) ? value as { start?: string; end?: string } : {};
    const availabilityLabel = applying
      ? 'Checking dates…'
      : availability?.dateRange
        ? `Available ${availability.dateRange.min} – ${availability.dateRange.max}`
        : availability?.valueCount === 0
          ? 'No date values exist for this field'
          : 'Run preview to check available dates';
    return <label className={`studio-filter range ${availability?.valueCount === 0 ? 'empty' : ''}`} aria-busy={applying}><span>{label}</span><input type="date" min={availability?.dateRange?.min} max={availability?.dateRange?.max} aria-label={`${label} start`} value={range.start ?? ''} onChange={(event) => onChange({ ...range, start: event.target.value })} /><i>–</i><input type="date" min={availability?.dateRange?.min} max={availability?.dateRange?.max} aria-label={`${label} end`} value={range.end ?? ''} onChange={(event) => onChange({ ...range, end: event.target.value })} /><small>{availabilityLabel}</small></label>;
  }
  if (filter.type === 'boolean') {
    return <label className="studio-filter boolean" aria-busy={applying}><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
  }
  if (filter.type === 'date') {
    return <label className={`studio-filter ${availability?.valueCount === 0 ? 'empty' : ''}`} aria-busy={applying}><span>{label}</span><input type="date" min={availability?.dateRange?.min} max={availability?.dateRange?.max} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} /><small>{applying ? 'Checking dates…' : availability?.dateRange ? `Available ${availability.dateRange.min} – ${availability.dateRange.max}` : availability?.valueCount === 0 ? 'No date values exist for this field' : 'Run preview to check available dates'}</small></label>;
  }
  if (optionValues.length > 0 && (filter.type === 'select' || filter.type === 'multiselect')) {
    return <StudioFilterDropdown label={label} values={optionValues} value={value} multiple={filter.type === 'multiselect'} applying={applying} truncated={availability?.truncated ?? false} onChange={onChange} />;
  }
  if (optionValues.length > 0 && filter.type === 'search') {
    const listId = `studio-filter-${filter.id.replace(/[^a-z0-9_-]/gi, '-')}-options`;
    return <div className="studio-filter searchable" aria-busy={applying}>
      <label htmlFor={`${listId}-input`}>{label}</label>
      <span className="studio-filter-combobox"><Search size={12} aria-hidden="true" /><input id={`${listId}-input`} type="search" list={listId} value={query} placeholder="All values" autoComplete="off" onChange={(event) => {
        const nextQuery = event.target.value;
        setQuery(nextQuery);
        onChange(nextQuery);
      }} /><ChevronDown size={12} aria-hidden="true" /></span>
      <datalist id={listId}>{optionValues.map((option) => <option key={option} value={option} />)}</datalist>
      <small>{applying ? 'Applying…' : `${optionValues.length}${availability?.truncated ? '+' : ''} ${optionValues.length === 1 && !availability?.truncated ? 'value' : 'values'} · type or choose`}</small>
    </div>;
  }
  return <label className="studio-filter" aria-busy={applying}><span>{label}</span><input type={filter.type === 'number' ? 'number' : 'search'} value={String(value ?? '')} placeholder="All values" onChange={(event) => onChange(filter.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} /><small>{applying ? 'Applying…' : 'Updates automatically'}</small></label>;
}

function StudioFilterDropdown({
  label,
  values,
  value,
  multiple,
  applying,
  truncated,
  onChange,
}: {
  label: string;
  values: string[];
  value: unknown;
  multiple: boolean;
  applying: boolean;
  truncated: boolean;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selected = multiple
    ? new Set(Array.isArray(value) ? value.map(String) : value === undefined || value === null || value === '' ? [] : [String(value)])
    : new Set(value === undefined || value === null || value === '' ? [] : [String(value)]);
  const visible = values.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase()));
  const summary = selected.size === 0
    ? 'All values'
    : multiple
      ? `${selected.size} selected`
      : [...selected][0];
  const selectValue = (option: string) => {
    if (!multiple) {
      onChange(option);
      if (detailsRef.current) detailsRef.current.open = false;
      setQuery('');
      return;
    }
    const next = new Set(selected);
    if (next.has(option)) next.delete(option); else next.add(option);
    onChange([...next]);
  };
  return <details ref={detailsRef} className="studio-filter dropdown" aria-busy={applying}>
    <summary><span><small>{label}</small><strong>{summary}</strong></span><ChevronDown size={12} /></summary>
    <div className="studio-filter-menu">
      <label><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search values" autoComplete="off" /></label>
      <button type="button" className="filter-option-clear" onClick={() => { onChange(multiple ? [] : ''); if (!multiple && detailsRef.current) detailsRef.current.open = false; }}>All values</button>
      <div>{visible.map((option) => <button key={option} type="button" className={selected.has(option) ? 'on' : ''} onClick={() => selectValue(option)}>{multiple ? <span className="filter-option-check">{selected.has(option) ? <Check size={11} /> : null}</span> : null}<span>{option}</span>{!multiple && selected.has(option) ? <Check size={12} /> : null}</button>)}</div>
      {visible.length === 0 ? <small>No matching values</small> : null}
      <footer>{applying ? 'Applying…' : `${values.length}${truncated ? '+' : ''} available values`}</footer>
    </div>
  </details>;
}

export function StudioTilePreview({
  tile,
  run,
  loading,
  themeMode,
  crossFilterFields = [],
  activeCrossFilters = [],
  onSelectDatasetMark,
  onDrillDatasetMark,
  onDrillBack,
  onNavigate,
  hasNavigation = false,
  linkProposal,
  onLinkField,
}: {
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number];
  run?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  themeMode: ThemeMode;
  crossFilterFields?: string[];
  activeCrossFilters?: StudioDatasetCrossFilter[];
  onSelectDatasetMark?: (field: string, values: unknown[]) => void;
  onDrillDatasetMark?: (candidate: RuntimeDatasetHierarchyDrillCandidate, row: Record<string, unknown>) => void;
  onDrillBack?: () => void;
  onNavigate?: () => void;
  hasNavigation?: boolean;
  /** Same-name, same-type fields on page Datasets this tile could filter. */
  linkProposal?: DatasetCrossFilterLinkProposal;
  onLinkField?: () => void;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [height, setHeight] = useState(190);
  const [markActionId, setMarkActionId] = useState<string>('filter');
  useEffect(() => {
    const node = frameRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(220, Math.floor(entry.contentRect.width)));
      setHeight(Math.max(120, Math.floor(entry.contentRect.height)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [run]);
  if (!run) return <StaticComponentPreview loading={loading} />;
  if (run.status !== 'ok' && run.error?.startsWith('APP_DATASETS_FEATURE_DISABLED')) {
    return <div className="preview-state error"><strong>Field-based tiles are off</strong><span>Turn them on from the Sources panel to run this tile.</span></div>;
  }
  if (run.status !== 'ok' || !run.result) return <div className="preview-state error"><strong>{humanize(run.status)}</strong><span>{run.error ?? 'This component could not run with the current source and filters.'}</span></div>;
  const visualization = tile.query
    ? datasetTileVisualizationCompatibility(tile.query, tile.viz.type)
    : undefined;
  if (visualization && !visualization.compatible) {
    return <div className="preview-state error"><strong>Dataset visualization needs attention</strong><span>{visualization.message} Choose Table or change the Dataset field selection before running this component.</span></div>;
  }
  const chart = tile.viz.type === 'single_value' ? 'kpi' : tile.viz.type;
  const chartConfig = { ...(run.chartConfig ?? {}), ...(tile.viz.options ?? {}), chart } as CellChartConfig;
  const hierarchy = run.dataset?.hierarchy;
  const hierarchyCandidates = (hierarchy?.candidates ?? []).filter((candidate) => (
    run.result!.rows.some((row) => row[candidate.fromAlias] !== undefined && row[candidate.fromAlias] !== null)
  ));
  const selectableFields = crossFilterFields.filter((field) => run.result!.columns.includes(field));
  const selectedForTile = activeCrossFilters.filter((filter) => filter.fromTileId === tile.i);
  const markActions = datasetMarkActions(selectableFields, hierarchyCandidates);
  const selectedMarkAction = markActions.find((action) => action.id === markActionId) ?? markActions[0];
  const onRowSelect = selectedMarkAction
    ? (row: Record<string, unknown>) => {
      if (selectedMarkAction.kind === 'drill') {
        const candidate = selectedMarkAction.candidate;
        if (onDrillDatasetMark && row[candidate.fromAlias] !== undefined && row[candidate.fromAlias] !== null) {
          onDrillDatasetMark(candidate, row);
        }
        return;
      }
      const selection = datasetMarkSelectionForRow(selectableFields, row);
      if (selection) onSelectDatasetMark?.(selection.field, selection.values);
    }
    : undefined;
  return (
    <div ref={frameRef} className="live-component-preview" onClick={(event) => event.stopPropagation()}>
      {chart === 'table' || chart === 'pivot'
        ? <TableOutput result={run.result} themeMode={themeMode} maxHeight={height} initialPageSize={10} onRowClick={onRowSelect} />
        : <ChartOutput result={run.result} themeMode={themeMode} chartConfig={{ ...chartConfig, title: undefined }} availableHeight={height} availableWidth={width} onMarkSelect={onRowSelect} />}
      {selectableFields.length ? <div className="dataset-mark-controls" aria-label="Cross-filter selection">
        <span>Select a result mark</span>
        {selectableFields.flatMap((field) => uniquePreviewValues(run.result!.rows, field).slice(0, 6).map((value) => ({ field, value }))).map(({ field, value }) => <button key={`${field}:${String(value)}`} type="button" className={selectedForTile.some((filter) => filter.field === field && filter.values.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) ? 'on' : ''} onClick={() => onSelectDatasetMark?.(field, [value])}>{humanize(field)}: {String(value)}</button>)}
        <small>{chart === 'table' ? 'You can also click a table row.' : 'Values come from this settled result.'}</small>
      </div> : null}
      {hierarchy ? <div className="dataset-mark-controls" aria-label="Hierarchy exploration">
        <span>Explore hierarchy · unsaved</span>
        {markActions.length > 1 ? <label>Click action <select value={selectedMarkAction?.id ?? ''} onChange={(event) => setMarkActionId(event.target.value)}>
          {markActions.map((action) => <option key={action.id} value={action.id}>{action.kind === 'filter' ? 'Filter linked tiles' : `Drill to ${humanize(action.candidate.toField)}`}</option>)}
        </select></label> : null}
        {selectedMarkAction?.kind === 'drill' ? <small>{markActions.length > 1 ? 'Choose the drill action, then ' : ''}Click a {humanize(selectedMarkAction.candidate.fromField)} mark to drill to {humanize(selectedMarkAction.candidate.toField)}.</small> : null}
        {hierarchy.activeSteps.length > 0 && onDrillBack ? <button type="button" onClick={onDrillBack}>Back</button> : null}
      </div> : null}
      {!selectableFields.length && linkProposal && onLinkField ? <div className="dataset-link-hint" role="note">
        <span>Clicking this {chart === 'table' ? 'table' : 'chart'} filters nothing yet.</span>
        <button type="button" onClick={onLinkField} title={`Map ${humanize(linkProposal.fieldLabel)} to: ${linkProposal.targetLabels.join(', ')}`}>Link {humanize(linkProposal.fieldLabel)} to {linkProposal.mappings.length === 1 ? linkProposal.targetLabels[0] : `${linkProposal.mappings.length} Datasets`}</button>
      </div> : null}
      {hasNavigation ? <button type="button" className="dataset-detail-navigation" onClick={onNavigate}>Open configured details</button> : null}
    </div>
  );
}

function datasetCrossFilterFields(
  page: AppStudioBuildDraft['pages'][number],
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
): string[] {
  if (!tile.query) return [];
  const mapped = new Set((page.interactions?.crossFilter?.mappings ?? [])
    .filter((mapping) => mapping.fromTileId === tile.i)
    .map((mapping) => mapping.fromField));
  return tileQueryOutputAliases(tile.query)
    .filter((output) => output.kind === 'dimension' && mapped.has(output.alias))
    .map((output) => output.alias);
}

function uniquePreviewValues(rows: Array<Record<string, unknown>>, field: string): unknown[] {
  const values = new Map<string, unknown>();
  for (const row of rows) {
    const value = row[field];
    if (value === undefined || value === null || typeof value === 'object') continue;
    values.set(JSON.stringify(value), value);
  }
  return [...values.values()];
}

function restoreOperations(current: AppStudioBuildDraft, target: AppStudioBuildDraft): AppStudioDraftOperation[] {
  return [
    { type: 'set_name', name: target.name },
    { type: 'set_template', template: target.template },
    { type: 'set_frame', frame: target.frame },
    { type: 'set_source_policy', sourcePolicy: target.sourcePolicy },
    { type: 'set_requirements', requirements: target.requirements, coverage: target.coverage },
    ...current.sources.filter((source) => !target.sources.some((item) => item.id === source.id)).map((source): AppStudioDraftOperation => ({ type: 'remove_source', sourceId: source.id })),
    ...target.sources.map((source): AppStudioDraftOperation => ({ type: 'upsert_source', source })),
    ...current.pages.filter((page) => !target.pages.some((item) => item.id === page.id)).map((page): AppStudioDraftOperation => ({ type: 'remove_page', pageId: page.id })),
    ...target.pages.map((page): AppStudioDraftOperation => ({ type: 'upsert_page', page })),
    ...current.reviewTasks.filter((task) => !target.reviewTasks.some((item) => item.id === task.id)).map((task): AppStudioDraftOperation => ({ type: 'remove_review_task', taskId: task.id })),
    ...target.reviewTasks.map((task): AppStudioDraftOperation => ({ type: 'set_review_task', task })),
  ];
}

function studioTemplatePage(
  page: AppStudioBuildDraft['pages'][number],
  template: StudioTemplate,
  appName: string,
): AppStudioBuildDraft['pages'][number] {
  const contentItems = page.layout.items.filter((item) => !(item.i.startsWith('template-') && item.i.endsWith('-introduction')));
  if (template === 'blank') {
    return {
      ...page,
      sections: [],
      layout: { ...page.layout, items: packStudioItems(contentItems, 12) },
    };
  }
  const introId = `template-${template}-introduction`;
  const intro = {
    i: introId, x: 0, y: 0, w: 12, h: 2,
    title: template === 'investigation' ? 'Investigation question' : 'Executive context',
    sectionId: 'exec_summary',
    text: { markdown: template === 'executive_brief'
      ? `# ${appName}\n\nSummarize the decision and the governed evidence that supports it.`
      : template === 'operational_dashboard'
        ? `# ${appName}\n\nMonitor performance, changes, drivers, and the details that require action.`
        : `# ${appName}\n\nDocument the question, findings, caveats, and supporting evidence.` },
    viz: { type: 'text' },
    sourceClass: 'narrative' as const,
    trustState: 'draft_ready' as const,
    reviewStatus: 'draft_ready' as const,
  };
  const sections = template === 'investigation'
    ? [
      { id: 'exec_summary', title: 'Question', kind: 'exec_summary' as const, order: 0 },
      { id: 'insight', title: 'Findings and comparisons', kind: 'insight' as const, order: 1 },
      { id: 'appendix', title: 'Caveats and evidence', kind: 'appendix' as const, order: 2 },
    ]
    : [
      { id: 'exec_summary', title: 'Executive summary', kind: 'exec_summary' as const, order: 0 },
      { id: 'kpi_band', title: 'Key metrics', kind: 'kpi_band' as const, order: 1 },
      { id: 'insight', title: template === 'executive_brief' ? 'Decision evidence' : 'Trends and drivers', kind: 'insight' as const, order: 2 },
      { id: 'appendix', title: 'Detail and evidence', kind: 'appendix' as const, order: 3 },
    ];
  return {
    ...page,
    sections,
    layout: { ...page.layout, items: packStudioItems([intro, ...contentItems], 12) },
  };
}

function collapseTemplateIntroductions(
  items: AppStudioBuildDraft['pages'][number]['layout']['items'],
  activeTemplate?: StudioTemplate,
): AppStudioBuildDraft['pages'][number]['layout']['items'] {
  const introductionPrefix = 'template-';
  const introductionSuffix = '-introduction';
  const introductions = items.filter((item) => item.i.startsWith(introductionPrefix) && item.i.endsWith(introductionSuffix));
  if (introductions.length <= 1) return items;
  const preferredId = activeTemplate && activeTemplate !== 'blank' ? `template-${activeTemplate}-introduction` : undefined;
  const preferred = introductions.find((item) => item.i === preferredId) ?? introductions[introductions.length - 1];
  return items.filter((item) => !(item.i.startsWith(introductionPrefix) && item.i.endsWith(introductionSuffix)) || item.i === preferred.i);
}

function packStudioItems(items: AppStudioBuildDraft['pages'][number]['layout']['items'], columns: number): AppStudioBuildDraft['pages'][number]['layout']['items'] {
  const cols = Math.max(1, Math.floor(columns));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.y - right.item.y || left.item.x - right.item.x || left.index - right.index)
    .map(({ item }) => {
    const width = Math.min(cols, Math.max(1, item.w));
    const height = Math.max(1, item.h);
    if (x + width > cols) {
      x = 0;
      y += rowHeight || height;
      rowHeight = 0;
    }
    const packed = { ...item, x, y, w: width, h: height };
    x += width;
    rowHeight = Math.max(rowHeight, height);
    if (x >= cols) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    return packed;
  });
}

function recommendedComponentKind(source: AppBlockRecommendation): 'kpi' | 'chart' | 'table' {
  const view = normalizeViz(source.chartType);
  if (view === 'single_value') return 'kpi';
  if (view === 'table') return 'table';
  return 'chart';
}

function sourceCatalogKindLabel(source: AppBlockRecommendation): string {
  if (source.capabilities?.dataset?.kind === 'semantic') return 'Semantic Dataset';
  if (source.capabilities?.dataset) return 'Dataset';
  if (source.capabilities?.semanticModelId) return 'Governed semantic source';
  return 'Block source';
}

function componentKindLabel(kind: 'kpi' | 'chart' | 'table'): 'KPI' | 'Chart' | 'Table' {
  return kind === 'kpi' ? 'KPI' : kind === 'table' ? 'Table' : 'Chart';
}

function sourceKindLabel(kind: AppStudioBuildDraft['sources'][number]['kind']): string {
  if (kind === 'certified_block') return 'Certified block';
  if (kind === 'governed_semantic' || kind === 'semantic_query') return 'Governed semantic query';
  if (kind === 'review_block') return 'Review-required block';
  if (kind === 'review_dql') return 'Review-required DQL';
  if (kind === 'exploratory_sql') return 'Review-required SQL';
  return 'Page content';
}

function isPresentationOnlyOperation(operation: AppStudioDraftOperation): boolean {
  if (operation.type === 'set_layout') return true;
  if (operation.type !== 'update_tile') return false;
  const allowed = new Set(['title', 'viz', 'display', 'x', 'y', 'w', 'h', 'sectionId']);
  return Object.keys(operation.patch).every((key) => allowed.has(key));
}

function pageHasDataTiles(page: AppStudioBuildDraft['pages'][number]): boolean {
  return page.layout.items.some((item) => Boolean(item.block || item.semantic || item.draftAnalysis || item.query));
}

function unsupportedTileFilters(tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) {
  return (tile.filterBindings ?? []).filter((binding) => binding.capability === 'unsupported' || Boolean(binding.unsupportedReason));
}

function templateIcon(id: StudioTemplate): JSX.Element {
  if (id === 'executive_brief') return <FileText size={18} />;
  if (id === 'operational_dashboard') return <LayoutDashboard size={18} />;
  if (id === 'investigation') return <Search size={18} />;
  return <Plus size={18} />;
}

function normalizeViz(type?: string): 'bar' | 'line' | 'area' | 'table' | 'single_value' {
  const value = type?.toLowerCase() ?? '';
  if (value.includes('line') || value.includes('trend')) return 'line';
  if (value.includes('area')) return 'area';
  if (value.includes('table')) return 'table';
  if (value.includes('kpi') || value.includes('single')) return 'single_value';
  return 'bar';
}

function createAppStudioPreviewRunScope(): string {
  return `studio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

