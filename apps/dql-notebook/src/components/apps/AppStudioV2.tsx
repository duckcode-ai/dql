import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowLeft, BarChart3, Blocks, Bot, Check, ChevronDown, FileText, Filter,
  Gauge, Heading, LayoutDashboard, Monitor, MoreHorizontal, PanelRight,
  Play, Plus, Redo2, Search, Settings2, ShieldCheck, Smartphone, Sparkles, Table2,
  Trash2, Type, Undo2, Upload, X,
} from 'lucide-react';
import {
  api, DqlApiError,
  type AppBlockRecommendation,
  type AppStudioAiProposal,
  type AppStudioBuildDraft,
  type AppStudioDraftOperation,
  type DashboardRunResponse,
} from '../../api/client';
import type { AppSummary } from '../../store/types';
import type { CellChartConfig } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import { AiSidePanel } from '../agent/AiSidePanel';
import { usePersistedAgentThreadId } from '../agent/usePersistedAgentThreadId';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { APP_STUDIO_V2_STYLES } from './app-studio-v2-styles';
import { availableAppStudioProposalSources, summarizeAppStudioAiPlan, type AppStudioAiPlanSummary } from './app-studio-ai-plan';
import {
  discoverAppFilterCandidates,
  defaultStudioFilterType,
  filterTileMappingsForField,
  studioFilterMappingKey,
  type StudioFilterCandidate,
  type StudioRuntimeFilterFields,
  type StudioFilterTileMapping,
} from './app-studio-filter-candidates';
import {
  blockingPublicationReviewTasks,
  localPublicationSteps,
  pagesNeedingSettledPreview,
  publicationBlockingSources,
  publicationIssueSummaries,
  unresolvedPublicationRequirements,
} from './app-studio-publish-readiness';

const UnifiedAgentRunPanel = lazy(() => import('../agent/UnifiedAgentRunPanel')
  .then((module) => ({ default: module.UnifiedAgentRunPanel })));

type StudioPanel = 'pages' | 'sources' | 'filters' | 'templates';
type StudioBreakpoint = 'wide' | 'medium' | 'narrow';
type StudioPreviewMode = 'auto' | StudioBreakpoint;
type StudioTemplate = AppStudioBuildDraft['template'];
type StudioDashboardFilter = NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number];
type StudioFilterControlType = StudioDashboardFilter['type'];
type StudioFilterScope = 'page' | 'app';

type StudioFilterConfiguration = {
  id: string;
  fieldId: string;
  label: string;
  type: StudioFilterControlType;
  scope: StudioFilterScope;
  required: boolean;
  selectedMappingKeys: string[];
};

type StudioFilterAvailability = {
  values: string[];
  truncated: boolean;
  valueCount?: number;
  dateRange?: { min: string; max: string };
};

type StudioFieldAvailability = {
  checkedComponents: number;
  compatibleComponents: number;
  valueCount: number;
  dateRange?: { min: string; max: string };
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
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AppStudioAiProposal | null>(null);
  const [selectedProposalSourceIds, setSelectedProposalSourceIds] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<AppStudioBuildDraft[]>([]);
  const [redoStack, setRedoStack] = useState<AppStudioBuildDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState('Local draft');
  const [previewRunsByPage, setPreviewRunsByPage] = useState<Record<string, DashboardRunResponse>>({});
  const [previewing, setPreviewing] = useState(false);
  const [previewVariablesByPage, setPreviewVariablesByPage] = useState<Record<string, Record<string, unknown>>>({});
  const [filterOptionsByPage, setFilterOptionsByPage] = useState<Record<string, Record<string, StudioFilterAvailability>>>({});
  const [draggingTileId, setDraggingTileId] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [publishReviewOpen, setPublishReviewOpen] = useState(false);
  const [publishIssues, setPublishIssues] = useState<string[]>([]);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotExpanded, setCopilotExpanded] = useState(false);
  const [copilotRunning, setCopilotRunning] = useState(false);
  const draggingTileIdRef = useRef<string | null>(null);
  const immediateStartRef = useRef(false);
  const previewSequenceRef = useRef(0);
  const filterPreviewTimerRef = useRef<number | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
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
  }, [draft?.id, draft?.sourcePolicy, catalogQuery]);

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
      setFilterOptionsByPage({});
      setDraft(detail.draft);
      setName(detail.draft.name);
      setActivePageId(detail.pageId ?? detail.draft.pages[0]?.id ?? 'overview');
      setSelectedTileId(detail.tileId ?? null);
      setProposal(null);
      setSavedMessage('Ask result added · loading preview…');
    };
    window.addEventListener('dql-app-build-updated', handleAskResult);
    return () => window.removeEventListener('dql-app-build-updated', handleAskResult);
  }, [draft?.id]);

  const activePage = useMemo(
    () => draft?.pages.find((page) => page.id === activePageId) ?? draft?.pages[0] ?? null,
    [activePageId, draft],
  );
  const previewRun = activePage ? previewRunsByPage[activePage.id] ?? null : null;
  const previewVariables = activePage ? previewVariablesByPage[activePage.id] ?? {} : {};
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
  const readinessSteps = useMemo(() => draft ? localPublicationSteps(draft) : [], [draft]);
  const serverReadinessSteps = useMemo(() => publicationIssueSummaries(publishIssues), [publishIssues]);
  const publishStepCount = readinessSteps.length + serverReadinessSteps.length;
  const publishReady = draft?.state === 'preflight_ready' && publishStepCount === 0;

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
      if (mode === 'ai') await requestAiProposal(result.draft, prompt);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const requestAiProposal = async (base = draft, nextPrompt = prompt, selectedBlockIds?: string[]) => {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.proposeAppBuildChanges(base.id, {
        prompt: nextPrompt.trim() || base.frame.goal,
        expectedRevision: base.revision,
        proposalHash: base.proposalHash,
        selectedBlockIds: selectedBlockIds ?? (selectedSource ? [selectedSource.id] : undefined),
      });
      setProposal(result.proposal);
      setCopilotOpen(false);
      setSavedMessage('AI plan ready for review');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const reviseAiProposal = async (answers?: Record<string, string>, additionalSourceIds?: string[]) => {
    if (!draft || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.reviseAppBuildProposal(draft.id, proposal.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        answers,
        selectedSourceIds: Array.from(selectedProposalSourceIds),
        additionalSourceIds,
      });
      setProposal(result.proposal);
      setSavedMessage('AI proposal revised on the server');
    } catch (cause) {
      setError(messageOf(cause));
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
      setProposal(result.proposal);
      setSavedMessage('Review-required gap added to the proposal');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const addSourceToAiProposal = async (source: AppBlockRecommendation) => {
    if (!draft || !proposal || !proposalSummary) return;
    if (source.eligibility && !source.eligibility.localPreview) {
      setError('Enable review-required sources before adding this draft block to the proposal.');
      return;
    }
    const sourceId = source.sourceId ?? source.id;
    if (proposalSummary.sources.some((item) => item.id === sourceId || item.sourceRef === source.path)) {
      setSelectedProposalSourceIds((current) => new Set([...current, sourceId]));
      return;
    }
    await reviseAiProposal(undefined, [sourceId]);
    setSelectedSource(source);
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
      if (!keepVisiblePreview) {
        previewSequenceRef.current += 1;
        setPreviewRunsByPage({});
        setFilterOptionsByPage({});
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
    } catch (cause) {
      setCatalogError(messageOf(cause));
    } finally {
      setCatalogLoading(false);
    }
  };

  const addComponent = async (kind: 'heading' | 'text' | 'kpi' | 'chart' | 'table', sourceOverride?: AppBlockRecommendation | null) => {
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
      if (source.eligibility && !source.eligibility.localPreview) {
        setError('Enable review-required sources to add this draft block to the local App.');
        return;
      }
      setSelectedSource(source);
      setBusy(true);
      setSavedMessage('Composing source…');
      setError(null);
      try {
        const previous = draft;
        const result = await api.composeAppBuild(draft.id, {
          mode: 'manual',
          expectedRevision: draft.revision,
          expectedProposalHash: draft.proposalHash,
          selections: [{ sourceId: source.sourceId ?? source.id, pageId: activePage.id, view: kind as 'kpi' | 'chart' | 'table' }],
        });
        setDraft(result.draft);
        setUndoStack((items) => [...items.slice(-29), previous]);
        setRedoStack([]);
        setSelectedTileId(result.tileIds[0] ?? null);
        setSavedMessage(`${kind === 'chart' ? 'Chart' : humanize(kind)} added · loading data…`);
        previewSequenceRef.current += 1;
        setPreviewRunsByPage({});
        setFilterOptionsByPage({});
        await runPreviewForDraft(result.draft, activePage.id);
      } catch (cause) {
        setSavedMessage('Compose failed');
        setError(messageOf(cause));
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
    const selectedMappings = mappings.filter((mapping) => mapping.supported && selected.has(mapping.key));
    if (selectedMappings.length === 0) {
      setError('Link this filter to at least one compatible component.');
      return;
    }
    const operations: AppStudioDraftOperation[] = [];
    for (const page of draft.pages) {
      const pageMappings = mappings.filter((mapping) => mapping.pageId === page.id);
      const linkedMappings = pageMappings.filter((mapping) => mapping.supported && selected.has(mapping.key));
      const shouldAddToPage = linkedMappings.length > 0
        && (configuration.scope === 'app' || page.id === activePage.id);
      const existingFilter = (page.filters ?? []).some((filter) => filter.id === configuration.id);
      if (shouldAddToPage) {
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
            scope: { page: page.id, tileIds: linkedMappings.map((mapping) => mapping.tileId) },
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
    const operations: AppStudioDraftOperation[] = [];
    for (const source of draft.sources.filter((item) => item.kind === 'governed_semantic' || item.kind === 'semantic_query')) {
      operations.push({ type: 'upsert_source', source: { ...source, snapshotId: previewRun.snapshotId, receiptId: previewRun.runId, reviewStatus: 'approved' } });
    }
    for (const tile of activePage.layout.items.filter((item) => item.semantic && previewRun.tiles.some((runTile) => runTile.tileId === item.i && runTile.status === 'ok'))) {
      operations.push({
        type: 'update_tile', pageId: activePage.id, tileId: tile.i,
        patch: {
          semantic: { ...tile.semantic!, snapshotId: previewRun.snapshotId },
          review: {
            status: 'approved',
            sourceFingerprint: tile.semantic!.definitionFingerprint,
            preflightReceiptId: previewRun.runId,
            reviewedAt: new Date().toISOString(),
            reviewedBy: 'local-author',
          },
        },
      });
    }
    const next = await mutate(operations);
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

  async function runPreviewForDraft(targetDraft: AppStudioBuildDraft, pageId: string, variablesOverride?: Record<string, unknown>): Promise<AppStudioBuildDraft | null> {
    const page = targetDraft.pages.find((candidate) => candidate.id === pageId);
    if (!page) return null;
    const sequence = previewSequenceRef.current + 1;
    previewSequenceRef.current = sequence;
    setActivePageId(page.id);
    setPreviewing(true);
    setError(null);
    try {
      const variables = variablesOverride ?? previewVariablesByPage[page.id] ?? {};
      const result = await api.runAppBuildPreview(targetDraft.id, page.id, variables);
      if (sequence !== previewSequenceRef.current) return null;
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
      setPreviewRunsByPage((current) => ({ ...current, [page.id]: result }));
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
      setSavedMessage(`Preview settled · ${result.tiles.filter((tile) => tile.status === 'ok').length}/${result.tiles.length} ready`);
      return recorded.draft;
    } catch (cause) {
      if (sequence === previewSequenceRef.current) setError(messageOf(cause));
      return null;
    } finally {
      if (sequence === previewSequenceRef.current) setPreviewing(false);
    }
  }

  const runPreview = async (pageId = activePage?.id) => {
    if (!draft || !pageId) return;
    await runPreviewForDraft(draft, pageId);
  };

  const runPreviewAndReview = async (pageId: string) => {
    if (!draft || !pageId) return;
    const recorded = await runPreviewForDraft(draft, pageId);
    if (!recorded) return;
    setPublishIssues([]);
    await publish(false, recorded);
  };

  const runAllPreviewsAndReview = async () => {
    if (!draft) return;
    let current = draft;
    const pages = current.pages.filter((page) => pageHasDataTiles(page));
    for (const page of pages) {
      const recorded = await runPreviewForDraft(current, page.id, previewVariablesByPage[page.id] ?? {});
      if (!recorded) return;
      current = recorded;
    }
    setPublishIssues([]);
    await publish(false, current);
  };

  const applyFilterValue = (filter: NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number], value: unknown) => {
    if (!draft || !activePage) return;
    const pageId = activePage.id;
    const linkedPageIds = new Set(draft.pages.filter((page) => page.filters?.some((candidate) => candidate.id === filter.id)).map((page) => page.id));
    const nextVariablesByPage = { ...previewVariablesByPage };
    for (const linkedPageId of linkedPageIds) {
      nextVariablesByPage[linkedPageId] = { ...(nextVariablesByPage[linkedPageId] ?? {}), [filter.id]: value };
    }
    const nextVariables = nextVariablesByPage[pageId] ?? { [filter.id]: value };
    setPreviewVariablesByPage(nextVariablesByPage);
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

  useEffect(() => {
    if (!draft || !activePage || proposal || previewing || previewRunsByPage[activePage.id] || !pageHasDataTiles(activePage)) return;
    const timer = window.setTimeout(() => {
      void runPreviewForDraft(draft, activePage.id, previewVariablesByPage[activePage.id] ?? {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activePage?.id, draft?.revision, proposal]);

  useEffect(() => () => {
    if (filterPreviewTimerRef.current !== null) window.clearTimeout(filterPreviewTimerRef.current);
  }, []);

  if (!draft) {
    return <div className="dql-studio-v2-loading">
      <style>{APP_STUDIO_V2_STYLES}</style>
      <button type="button" className="icon" onClick={onBack} aria-label="Back to Apps"><ArrowLeft size={18} /></button>
      <div><span className="loading-mark"><LayoutDashboard size={20} /></span><strong>{error ? 'Studio could not open' : initialDraftId ? 'Opening your local draft…' : baseAppId ? 'Preparing a safe edit draft…' : 'Preparing your Build Frame…'}</strong><small>{error ?? 'Keeping all work local until you explicitly publish it to the Project.'}</small>{error ? <button type="button" onClick={() => { immediateStartRef.current = false; void createDraft(); }}>Try again</button> : null}</div>
    </div>;
  }

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
          <button type="button" className={`review-state ${publishReady ? '' : 'needs-review'}`} onClick={() => void publish(false)} disabled={busy} title="Open the guided publication review"><ShieldCheck size={14} /> {publishReady ? 'Governed checks passed' : publishStepCount ? `${publishStepCount} ${publishStepCount === 1 ? 'fix' : 'fixes'} before publish` : 'Review before publish'}</button>
          <button type="button" className={`copilot ${copilotOpen ? 'on' : ''}`} onClick={() => setCopilotOpen((open) => !open)} aria-pressed={copilotOpen} aria-label="Open App Copilot"><Bot size={14} /><span>App Copilot</span></button>
          <button type="button" className="preview" onClick={() => void runPreview()} disabled={previewing || busy} aria-label={previewing ? 'Running preview' : 'Run preview'}><Play size={13} /><span>{previewing ? 'Running…' : 'Run preview'}</span></button>
          <button type="button" className="publish" onClick={() => void publish(false)} disabled={busy} aria-label="Review and publish to Project"><Upload size={13} /><span>Publish to Project</span></button>
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
          {panel === 'sources' ? <SourcesPanel usedSources={draft.sources} items={filteredCatalog} selected={selectedSource} query={catalogQuery} loading={catalogLoading} error={catalogError} disabled={busy || previewing} onQuery={setCatalogQuery} onSelect={selectSource} onAdd={(item, kind) => void addComponent(kind, item)} onAddContent={(kind) => void addComponent(kind, null)} policy={draft.sourcePolicy} total={catalogTotal} hasMore={Boolean(catalogNextCursor)} onLoadMore={() => void loadMoreSources()} onEnableReview={() => void mutate([{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }])} /> : null}
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
          busy={busy}
          onRevise={() => void requestAiProposal(draft, prompt)}
          onApply={() => void applyProposal()}
          onDismiss={() => setProposal(null)}
          onCatalogQuery={setCatalogQuery}
          onAddSource={addSourceToAiProposal}
          onAnswerClarification={(questionId, answerId) => void reviseAiProposal({ [questionId]: answerId })}
          onGenerateGap={(requirementId) => void generateAiGap(requirementId)}
          onEnableReview={() => void mutate([{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }]).then((next) => {
            if (!next) return;
            setProposal(null);
            void requestAiProposal(next, prompt);
          })}
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
            {selectedSource ? <div className="studio-source-ready"><div><span className="certified"><ShieldCheck size={14} /></span><p><small>Selected data</small><strong>{humanize(selectedSource.name)}</strong></p></div><span className="studio-source-actions"><button type="button" onClick={() => void addComponent(recommendedComponentKind(selectedSource), selectedSource)}><Plus size={14} /> Add {componentKindLabel(recommendedComponentKind(selectedSource))}</button><button type="button" className="source-clear" onClick={() => setSelectedSource(null)} aria-label="Clear selected data"><X size={14} /></button></span></div> : null}
            {(activePage?.filters ?? []).length ? <div className="studio-page-filterbar">{activePage!.filters!.map((filter) => <StudioFilterControl key={filter.id} filter={filter} availability={activeFilterOptions[filter.id]} value={previewVariables[filter.id] ?? filter.default} applying={previewing} onChange={(value) => applyFilterValue(filter, value)} />)}</div> : null}
            <div className="studio-page-grid">
              {visibleItems.map((tile) => (
                <article key={tile.i} role="button" tabIndex={0} draggable className={`studio-component-card ${selectedTileId === tile.i ? 'selected' : ''} ${draggingTileId === tile.i ? 'dragging' : ''}`} style={{ '--studio-tile-width': Math.min(tile.w, breakpoint === 'medium' ? 6 : breakpoint === 'narrow' ? 1 : 12), minHeight: breakpoint === 'narrow' ? Math.max(180, tile.h * 58) : Math.max(150, tile.h * 68) } as CSSProperties} onDragStart={() => { draggingTileIdRef.current = tile.i; setDraggingTileId(tile.i); }} onDragEnd={() => { draggingTileIdRef.current = null; setDraggingTileId(null); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void moveTileBefore(tile.i); }} onClick={() => setSelectedTileId(tile.i)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedTileId(tile.i); }}>
                  <header><span className="drag-handle" aria-hidden="true">⠿</span><span className={`trust-dot ${tile.trustState ?? 'draft_ready'}`} /> <strong>{tile.title || humanize(tile.i)}</strong><small>{tile.viz.type.replace(/_/g, ' ')}</small></header>
                  {unsupportedTileFilters(tile).map((binding) => <div key={binding.filter} className="tile-filter-notice"><Filter size={11} /><span>{binding.unsupportedReason ?? `${humanize(binding.filter)} does not affect this component.`}</span></div>)}
                  {tile.text ? <div className={tile.viz.type === 'heading' ? 'tile-heading' : 'tile-text'}>{tile.text.markdown.replace(/^#+\s*/, '')}</div> : <StudioTilePreview tile={tile} run={previewRun?.tiles.find((item) => item.tileId === tile.i)} loading={previewing} themeMode={themeMode} />}
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
          <ComponentInspector tile={selectedTile} run={previewRun?.tiles.find((item) => item.tileId === selectedTile.i)} pageId={activePage.id} onUpdate={(patch) => void mutate([{ type: 'update_tile', pageId: activePage.id, tileId: selectedTile.i, patch }])} onDelete={() => void mutate([{ type: 'remove_tile', pageId: activePage.id, tileId: selectedTile.i }]).then(() => setSelectedTileId(null))} />
        ) : (
          <BuildFrameInspector draft={draft} prompt={prompt} previewRun={previewRun} onPrompt={setPrompt} onAskAi={() => void requestAiProposal()} onSourcePolicy={(nextPolicy) => void mutate([{ type: 'set_source_policy', sourcePolicy: nextPolicy }])} onResolveTask={(task) => void mutate([{ type: 'set_review_task', task: { ...task, status: 'resolved' } }])} onApproveSemantic={() => void approveSemanticPreview()} />
        )}
      </aside> : null}

      {copilotOpen && !proposal ? <AiSidePanel
        t={themes[themeMode]}
        title="App Copilot"
        subtitle={draft.name}
        dock="overlay"
        expanded={copilotExpanded}
        onToggleExpanded={() => setCopilotExpanded((expanded) => !expanded)}
        onNewChat={copilotThread.resetThreadId}
        onClose={() => setCopilotOpen(false)}
        running={copilotRunning}
        resizable
        minResizeWidth={390}
        maxResizeWidth={1100}
        ariaLabel="App Copilot"
        className="studio-copilot-panel"
        style={{ top: 58, bottom: 0, height: 'auto' }}
      >
        <Suspense fallback={<div className="studio-copilot-loading">Loading App Copilot…</div>}>
          <UnifiedAgentRunPanel
            themeMode={themeMode}
            title="App Copilot"
            scopeHint={`Draft · ${activePage?.metadata.title ?? 'Overview'}`}
            composerPlaceholder="Ask about this App, its sources, filters, results, or a deeper business question…"
            emptyHint="Ask a detailed question about the current draft. Copilot uses the App Build Frame, selected governed sources, filters, and settled preview evidence."
            audience="stakeholder"
            initialMode="auto"
            selectedObject={selectedSource
              ? { kind: 'block', id: selectedSource.id, title: selectedSource.name }
              : { kind: 'app', id: draft.appId, title: draft.name }}
            workspaceContext={appStudioCopilotContext(draft, activePage, selectedSource, selectedTile, previewRun)}
            threadId={copilotThread.threadId}
            onThreadIdChange={copilotThread.onThreadIdChange}
            onRunningChange={setCopilotRunning}
            answerFirstCards
            examplePrompts={[
              { label: 'Explain the planned story', prompt: 'Explain the business story this App currently tells, the evidence behind it, and what is still missing.' },
              { label: 'Check source wiring', prompt: 'Which governed source supports each component and filter in this App? Call out unsupported or review-required wiring.' },
              { label: 'Go deeper', prompt: 'What deeper driver question should I investigate next based on this App and its current preview evidence?' },
            ]}
          />
        </Suspense>
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
        onResolveTask={(task) => void mutate([{ type: 'set_review_task', task: { ...task, status: 'resolved' } }]).then((next) => { if (next) setPublishIssues([]); })}
        onOpenSources={() => { setPublishReviewOpen(false); setPanel('sources'); setPanelOpen(true); }}
        onOpenFilters={() => { setPublishReviewOpen(false); setPanel('filters'); setPanelOpen(true); }}
        onRefreshSources={() => void refreshCertifiedSourceTrust()}
        onApproveSemantic={() => void approveSemanticPreview()}
        onRemoveLocalAnalysis={() => void removeLocalAnalysisForPublication()}
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
  const semanticSources = sources.filter((source) => source.kind === 'governed_semantic' || source.kind === 'semantic_query');
  const localOnlySources = sources.filter((source) => source.kind !== 'governed_semantic' && source.kind !== 'semantic_query');
  const remainingIssues = publicationIssueSummaries(serverIssues);
  const ready = requirements.length === 0
    && clarifications.length === 0
    && tasks.length === 0
    && previewPages.length === 0
    && sources.length === 0
    && remainingIssues.length === 0;
  const blockerCount = requirements.length
    + clarifications.length
    + tasks.length
    + previewPages.length
    + sources.length
    + remainingIssues.length;

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
        {semanticSources.length ? <section className="readiness-item">
          <span className="step-mark"><ShieldCheck size={15} /></span>
          <div><strong>Approve governed semantic results</strong><p>{semanticSources.map((source) => humanize(source.sourceRef)).join(', ')}</p><small>Approval binds the source to the settled snapshot you reviewed.</small><div className="readiness-actions">{previewRun ? <button type="button" className="primary" onClick={onApproveSemantic} disabled={busy}><ShieldCheck size={13} /> Approve settled result</button> : <button type="button" onClick={() => onRunPreview(draft.pages[0]?.id ?? '')} disabled={busy}><Play size={13} /> Run preview first</button>}<button type="button" onClick={onOpenSources}>Open Sources</button></div></div>
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
  busy,
  onRevise,
  onApply,
  onDismiss,
  onCatalogQuery,
  onAddSource,
  onAnswerClarification,
  onGenerateGap,
  onEnableReview,
  onToggleSource,
}: {
  proposal: AppStudioAiProposal;
  summary: AppStudioAiPlanSummary;
  catalog: AppBlockRecommendation[];
  catalogQuery: string;
  sourcePolicy: AppStudioBuildDraft['sourcePolicy'];
  selectedSourceIds: ReadonlySet<string>;
  busy: boolean;
  onRevise: () => void;
  onApply: () => void;
  onDismiss: () => void;
  onCatalogQuery: (query: string) => void;
  onAddSource: (source: AppBlockRecommendation) => void;
  onAnswerClarification: (questionId: string, answerId: string) => void;
  onGenerateGap: (requirementId: string) => void;
  onEnableReview: () => void;
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
    return <article key={source.id} className={`proposal-source-row ${selected ? 'selected' : ''}`}>
    <span className={`proposal-source-trust ${source.trustState}`}>{source.trustState === 'certified' ? <ShieldCheck size={15} /> : <FileText size={15} />}</span>
    <div><strong>{source.label}</strong><small>{sourceKindLabel(source.kind)} · {source.trustState === 'certified' ? 'Certified' : 'Review required'}</small><p>{viewDescription(source)}</p></div>
    <button type="button" className={selected ? 'remove' : 'add'} disabled={!selected && blockedByPolicy} title={blockedByPolicy ? 'Enable review-required sources to add this draft block locally.' : undefined} onClick={() => onToggleSource(source.id)} aria-label={`${selected ? 'Remove' : 'Add'} ${source.label}${summary.sources.filter((item) => item.label === source.label).length > 1 ? ` for ${summary.components.filter((component) => component.sourceId === source.id).map((component) => component.title).join(', ') || source.id}` : ''}`}>
      {selected ? <><X size={13} /> Remove</> : blockedByPolicy ? 'Review lane required' : <><Plus size={13} /> Add</>}
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
        <div className="proposal-source-heading"><div><h2 id="available-proposal-sources">More governed sources</h2><p>Add another certified block before AI generates the App.</p></div><strong>{availableSources.length}</strong></div>
        <div className="proposal-catalog-list">
          {availableSources.map((source) => <article key={source.id}>
            <span className={source.status === 'certified' ? 'certified' : 'review_required'}>{source.status === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
            <div><strong>{humanize(source.name)}</strong><small>{source.domain || 'General'} · {source.status === 'certified' ? 'Certified block' : 'Review required'}</small><p>{source.description || source.reasons[0] || 'Available governed data source'}</p></div>
            <button type="button" onClick={() => onAddSource(source)} disabled={busy || source.eligibility?.localPreview === false} title={source.eligibility?.localPreview === false ? 'Enable review-required sources to use this block locally.' : undefined}><Plus size={13} /> {source.eligibility?.localPreview === false ? 'Review lane required' : 'Add'}</button>
          </article>)}
          {!availableSources.length ? <p className="studio-ai-plan-empty">{catalogQuery.trim() ? 'No additional source matches this search.' : 'All available governed sources are already proposed.'}</p> : null}
        </div>
      </section>

      {sourcePolicy === 'include_review_required' ? <div className="studio-ai-review-lane"><FileText size={14} /><p><strong>Review-required analysis is enabled</strong><small>It stays clearly labeled and cannot be published to the Project until it is replaced, promoted, or removed.</small></p></div> : <div className="studio-ai-review-lane"><FileText size={14} /><p><strong>Draft sources are visible but not addable</strong><small>Enable the local review lane to use them without changing their trust.</small></p><button type="button" onClick={onEnableReview} disabled={busy}>Enable review lane</button></div>}
      {uncoveredRequirements.length ? <section className="studio-ai-questions"><header><strong>Uncovered requirements</strong><small>{uncoveredRequirements.length} gaps</small></header>{uncoveredRequirements.map((requirement) => <div key={requirement.id}><p>{requirement.question}</p><button type="button" onClick={() => onGenerateGap(requirement.id)} disabled={busy || sourcePolicy !== 'include_review_required'}>{sourcePolicy === 'include_review_required' ? 'Explicitly generate review-required DQL' : 'Enable review lane to generate'}</button></div>)}</section> : null}
      {unresolved.length ? <section className="studio-ai-questions"><header><strong>AI needs one more decision</strong><small>{unresolved.length} required</small></header>{unresolved.map((item) => <fieldset key={item.id}><legend>{item.question}</legend>{item.choices.map((choice) => <button key={choice.id} type="button" onClick={() => onAnswerClarification(item.id, choice.id)} disabled={busy}><strong>{choice.label}</strong>{choice.description ? <small>{choice.description}</small> : null}</button>)}</fieldset>)}<button type="button" onClick={onRevise} disabled={busy}>{busy ? 'Updating…' : 'Re-run proposal'}</button></section> : null}
    </div>

    <footer><span>{selectedSources.length} sources · {selectedComponents.length} views will be generated</span><button type="button" onClick={onDismiss}>Back to decision</button><button type="button" className="primary" onClick={onApply} disabled={busy || unresolved.length > 0 || selectedSources.length === 0}><Sparkles size={14} /> {busy ? 'Generating…' : `Generate App with ${selectedSources.length} ${selectedSources.length === 1 ? 'source' : 'sources'}`}</button></footer>
  </section>;
}

function appStudioCopilotContext(
  draft: AppStudioBuildDraft,
  page: AppStudioBuildDraft['pages'][number] | null,
  selectedSource: AppBlockRecommendation | null,
  selectedTile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] | null,
  previewRun: DashboardRunResponse | null,
): Record<string, unknown> {
  return {
    surface: 'app-studio',
    appBuildId: draft.id,
    appId: draft.appId,
    appName: draft.name,
    authoringMode: draft.authoringMode,
    sourcePolicy: draft.sourcePolicy,
    state: draft.state,
    buildFrame: draft.frame,
    requirements: draft.requirements,
    coverage: draft.coverage,
    sources: draft.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      sourceRef: source.sourceRef,
      trustState: source.trustState,
      reviewStatus: source.reviewStatus,
    })),
    page: page ? {
      id: page.id,
      title: page.metadata.title,
      filters: page.filters,
      components: page.layout.items.map((item) => ({ id: item.i, title: item.title, visualization: item.viz.type, trustState: item.trustState })),
    } : undefined,
    selectedSource: selectedSource ? { id: selectedSource.id, name: selectedSource.name, domain: selectedSource.domain, status: selectedSource.status } : undefined,
    selectedComponent: selectedTile ? { id: selectedTile.i, title: selectedTile.title, visualization: selectedTile.viz.type, trustState: selectedTile.trustState } : undefined,
    preview: previewRun ? {
      runId: previewRun.runId,
      snapshotId: previewRun.snapshotId,
      filterFingerprint: previewRun.filterFingerprint,
      tiles: previewRun.tiles.map((tile) => ({
        tileId: tile.tileId,
        status: tile.status,
        rowCount: tile.result?.rowCount,
        columns: tile.result?.columns?.slice(0, 12),
        error: tile.error,
      })),
    } : { status: 'not_run' },
    reviewTasks: draft.reviewTasks.filter((task) => task.status === 'open'),
  };
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
  onQuery,
  onSelect,
  onAdd,
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
  onQuery: (value: string) => void;
  onSelect: (item: AppBlockRecommendation) => void;
  onAdd: (item: AppBlockRecommendation, kind: 'kpi' | 'chart' | 'table') => void;
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
    <PanelTitle title="Sources" detail="Search governed data and add a view" />
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
      const isUsed = usedIdentifiers.has(item.id) || usedIdentifiers.has(item.name);
      const blockedByPolicy = item.eligibility?.localPreview === false && policy === 'governed_only';
      return <article key={item.id} className={`source-catalog-row ${isSelected ? 'on' : ''}`}>
        <button type="button" className="source-catalog-summary" onClick={() => onSelect(item)} aria-label={`View ${item.name} source details`} aria-expanded={isSelected}>
          <span className={item.status === 'certified' ? 'certified' : 'review'}>{item.status === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
          <div><strong title={item.name}>{humanize(item.name)}</strong><small>{humanize(item.domain)} · {item.status === 'certified' ? 'Certified block' : 'Review required'}{isUsed ? ' · In App' : ''}</small></div>
        </button>
        <button type="button" className="source-add-view" disabled={disabled || blockedByPolicy} title={blockedByPolicy ? 'Enable review-required sources to add this draft block locally.' : undefined} onClick={() => onAdd(item, kind)} aria-label={`Add ${item.name} as ${componentKindLabel(kind)}`}><Plus size={13} /> {blockedByPolicy ? 'Review lane required' : `Add ${componentKindLabel(kind)}`}</button>
        {isSelected ? <div className="source-catalog-detail">
          <p>{item.description || `${humanize(item.name)} from the ${humanize(item.domain)} domain.`}</p>
          {blockedByPolicy ? <button type="button" className="review-action" onClick={onEnableReview}><FileText size={12} /> Enable review-required sources</button> : null}
          {(item.filterIds?.length ?? 0) > 0 ? <span><Filter size={12} /> {item.filterIds!.length} supported {item.filterIds!.length === 1 ? 'filter' : 'filters'}</span> : null}
          <div className="source-view-options" aria-label={`Add ${item.name} with another view`}>
            <button type="button" disabled={disabled || blockedByPolicy} onClick={() => onAdd(item, 'kpi')}><Gauge size={13} /> KPI</button>
            <button type="button" disabled={disabled || blockedByPolicy} onClick={() => onAdd(item, 'chart')}><BarChart3 size={13} /> Chart</button>
            <button type="button" disabled={disabled || blockedByPolicy} onClick={() => onAdd(item, 'table')}><Table2 size={13} /> Table</button>
          </div>
        </div> : null}
      </article>;
    })}</div>
    {hasMore ? <button type="button" className="source-load-more" onClick={onLoadMore} disabled={loading || disabled}>{loading ? 'Loading…' : 'Load 50 more sources'}</button> : null}
    <div className="panel-section-label"><span>Page elements</span><small>No data required</small></div>
    <div className="content-quick-add"><button type="button" disabled={disabled} onClick={() => onAddContent('heading')}><Heading size={15} /><span><strong>Heading</strong><small>Organize the story</small></span><Plus size={13} /></button><button type="button" disabled={disabled} onClick={() => onAddContent('text')}><Type size={15} /><span><strong>Text</strong><small>Add context or guidance</small></span><Plus size={13} /></button></div>
  </>;
}

function FiltersPanel({
  draft,
  activePageId,
  catalog,
  candidates,
  runtimeFilterFields,
  previewRunsByPage,
  previewing,
  disabled,
  onRunPreview,
  onSave,
  onRemove,
}: {
  draft: AppStudioBuildDraft;
  activePageId?: string;
  catalog: AppBlockRecommendation[];
  candidates: StudioFilterCandidate[];
  runtimeFilterFields: StudioRuntimeFilterFields;
  previewRunsByPage: Record<string, DashboardRunResponse>;
  previewing: boolean;
  disabled: boolean;
  onRunPreview: () => void;
  onSave: (configuration: StudioFilterConfiguration) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const [configuration, setConfiguration] = useState<StudioFilterConfiguration | null>(null);
  const [fieldQuery, setFieldQuery] = useState('');
  const activePage = draft.pages.find((page) => page.id === activePageId) ?? draft.pages[0];
  const logicalFilters = useMemo(() => {
    const byId = new Map<string, { filter: StudioDashboardFilter; pageIds: string[] }>();
    for (const page of draft.pages) {
      for (const filter of page.filters ?? []) {
        const current = byId.get(filter.id);
        if (current) current.pageIds.push(page.id);
        else byId.set(filter.id, { filter, pageIds: [page.id] });
      }
    }
    return [...byId.values()];
  }, [draft.pages]);
  const existingIds = new Set(logicalFilters.map((item) => item.filter.id));
  const visibleCandidates = candidates.filter((candidate) => {
    const needle = fieldQuery.trim().toLowerCase();
    return !needle || [candidate.id, ...candidate.sourceNames].join(' ').toLowerCase().includes(needle);
  });
  const mappings = useMemo(
    () => configuration?.fieldId ? filterTileMappingsForField(draft.pages, catalog, configuration.fieldId, runtimeFilterFields, draft.sources) : [],
    [catalog, configuration?.fieldId, draft.pages, draft.sources, runtimeFilterFields],
  );
  const visibleMappings = configuration?.scope === 'page'
    ? mappings.filter((mapping) => mapping.pageId === activePage?.id)
    : mappings;
  const selectedMappings = new Set(configuration?.selectedMappingKeys ?? []);
  const selectedVisibleCount = visibleMappings.filter((mapping) => mapping.supported && selectedMappings.has(mapping.key)).length;
  const supportedVisibleCount = visibleMappings.filter((mapping) => mapping.supported).length;
  const fieldAvailability = useMemo(
    () => configuration?.fieldId
      ? studioFieldAvailability(configuration.fieldId, visibleMappings.filter((mapping) => mapping.supported), previewRunsByPage)
      : null,
    [configuration?.fieldId, previewRunsByPage, visibleMappings],
  );
  const dateControl = configuration?.type === 'daterange' || configuration?.type === 'date';
  const dateAvailabilityChecked = Boolean(dateControl
    && fieldAvailability
    && fieldAvailability.compatibleComponents > 0
    && fieldAvailability.checkedComponents === fieldAvailability.compatibleComponents);
  const dateFieldHasNoValues = Boolean(dateAvailabilityChecked && fieldAvailability?.valueCount === 0);

  const chooseField = (candidate: StudioFilterCandidate) => {
    const candidateMappings = filterTileMappingsForField(draft.pages, catalog, candidate.id, runtimeFilterFields, draft.sources);
    setConfiguration({
      id: candidate.id,
      fieldId: candidate.id,
      label: humanize(candidate.id),
      type: defaultStudioFilterType(candidate.id),
      scope: 'app',
      required: false,
      selectedMappingKeys: candidateMappings.filter((mapping) => mapping.supported).map((mapping) => mapping.key),
    });
  };
  const editFilter = (item: { filter: StudioDashboardFilter; pageIds: string[] }) => {
    const fieldId = item.filter.field?.name ?? item.filter.bindsTo ?? item.filter.id;
    const filterMappings = filterTileMappingsForField(draft.pages, catalog, fieldId, runtimeFilterFields, draft.sources);
    const linked = filterMappings.filter((mapping) => {
      const page = draft.pages.find((candidate) => candidate.id === mapping.pageId);
      const pageFilter = page?.filters?.find((filter) => filter.id === item.filter.id);
      if (!pageFilter) return false;
      if (pageFilter.scope?.tileIds) return pageFilter.scope.tileIds.includes(mapping.tileId);
      return page?.layout.items.find((tile) => tile.i === mapping.tileId)?.filterBindings
        ?.some((binding) => binding.filter === item.filter.id && binding.capability !== 'unsupported') ?? false;
    });
    setConfiguration({
      id: item.filter.id,
      fieldId,
      label: item.filter.label ?? humanize(item.filter.id),
      type: item.filter.type,
      scope: item.pageIds.length > 1 ? 'app' : 'page',
      required: item.filter.required ?? false,
      selectedMappingKeys: linked.map((mapping) => mapping.key),
    });
  };
  const setAllVisibleMappings = (checked: boolean) => {
    if (!configuration) return;
    const visibleKeys = new Set(visibleMappings.filter((mapping) => mapping.supported).map((mapping) => mapping.key));
    const next = new Set(configuration.selectedMappingKeys);
    for (const key of visibleKeys) checked ? next.add(key) : next.delete(key);
    setConfiguration({ ...configuration, selectedMappingKeys: [...next] });
  };
  const toggleMapping = (mapping: StudioFilterTileMapping) => {
    if (!configuration || !mapping.supported) return;
    const next = new Set(configuration.selectedMappingKeys);
    if (next.has(mapping.key)) next.delete(mapping.key); else next.add(mapping.key);
    setConfiguration({ ...configuration, selectedMappingKeys: [...next] });
  };

  if (configuration) {
    const editingExisting = existingIds.has(configuration.id);
    return <>
      <PanelTitle title={editingExisting ? 'Configure filter' : 'New filter'} detail="Choose a governed field and link its components" action={<button type="button" onClick={() => { setConfiguration(null); setFieldQuery(''); }} aria-label="Back to filters"><ArrowLeft size={14} /></button>} />
      {!configuration.fieldId ? <>
        <label className="filter-field-search"><Search size={14} /><input autoFocus value={fieldQuery} onChange={(event) => setFieldQuery(event.target.value)} placeholder="Search governed columns" /></label>
        <div className="filter-field-results">
          {visibleCandidates.filter((candidate) => !existingIds.has(candidate.id)).map((candidate) => <button key={candidate.id} type="button" onClick={() => chooseField(candidate)}>
            <span><Filter size={14} /></span><div><strong>{humanize(candidate.id)}</strong><small>{candidate.sourceNames.map(humanize).join(', ')}</small><em>{candidate.affectedTileCount} compatible · {candidate.pageCount} {candidate.pageCount === 1 ? 'page' : 'pages'}</em></div><ChevronDown size={13} />
          </button>)}
        </div>
        {visibleCandidates.filter((candidate) => !existingIds.has(candidate.id)).length === 0 ? <p className="panel-empty">No additional governed filter fields match this search.</p> : null}
      </> : <div className="filter-builder">
        <section className="filter-builder-field"><span><ShieldCheck size={15} /></span><div><small>GOVERNED FIELD</small><strong>{humanize(configuration.fieldId)}</strong></div>{!editingExisting ? <button type="button" onClick={() => setConfiguration({ ...configuration, fieldId: '', selectedMappingKeys: [] })}>Change</button> : null}</section>
        <label><span>Display label</span><input value={configuration.label} onChange={(event) => setConfiguration({ ...configuration, label: event.target.value })} /></label>
        <label><span>Control</span><select value={configuration.type} onChange={(event) => setConfiguration({ ...configuration, type: event.target.value as StudioFilterControlType })}>{filterControlOptions(configuration.fieldId).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {dateControl ? <section className={`filter-availability ${dateFieldHasNoValues ? 'empty' : fieldAvailability?.dateRange ? 'ready' : ''}`}>
          <span>{dateFieldHasNoValues ? <X size={14} /> : fieldAvailability?.dateRange ? <Check size={14} /> : <Play size={14} />}</span>
          <div><strong>{previewing ? 'Checking available dates…' : dateFieldHasNoValues ? 'No date values found' : fieldAvailability?.dateRange ? `${fieldAvailability.dateRange.min} – ${fieldAvailability.dateRange.max}` : 'Check available dates'}</strong><small>{previewing ? 'The settled preview is checking the selected field.' : dateFieldHasNoValues ? 'This field has no usable dates in the current governed result. Choose another field or refresh the data.' : fieldAvailability?.dateRange ? `${fieldAvailability.valueCount} dated rows found across ${fieldAvailability.checkedComponents} linked ${fieldAvailability.checkedComponents === 1 ? 'component' : 'components'}.` : 'Run the current page once before creating this date control.'}</small></div>
          {!previewing && !fieldAvailability?.dateRange ? <button type="button" onClick={onRunPreview} disabled={disabled}><Play size={12} /> Run preview</button> : null}
        </section> : null}
        <fieldset><legend>Apply to</legend><div className="filter-scope-switch"><button type="button" className={configuration.scope === 'page' ? 'on' : ''} onClick={() => setConfiguration({ ...configuration, scope: 'page' })}>This page</button><button type="button" className={configuration.scope === 'app' ? 'on' : ''} onClick={() => setConfiguration({ ...configuration, scope: 'app' })}>All compatible pages</button></div><small>{configuration.scope === 'app' ? 'One dashboard control is added to every page with a compatible tile.' : `Only ${activePage?.metadata.title ?? 'this page'} receives this control.`}</small></fieldset>
        <fieldset className="filter-mapping"><legend>Linked components</legend><header><span>{selectedVisibleCount}/{supportedVisibleCount} compatible linked</span><button type="button" onClick={() => setAllVisibleMappings(selectedVisibleCount !== supportedVisibleCount)}>{selectedVisibleCount === supportedVisibleCount ? 'Clear compatible' : 'Link all compatible'}</button></header>
          <div>{draft.pages.filter((page) => configuration.scope === 'app' || page.id === activePage?.id).map((page) => {
            const pageMappings = visibleMappings.filter((mapping) => mapping.pageId === page.id);
            if (!pageMappings.length) return null;
            return <section key={page.id}><small>{page.metadata.title}</small>{pageMappings.map((mapping) => <label key={mapping.key} className={mapping.supported ? '' : 'unsupported'} title={mapping.reason}>
              <input type="checkbox" checked={mapping.supported && selectedMappings.has(mapping.key)} disabled={!mapping.supported} onChange={() => toggleMapping(mapping)} /><span><strong>{humanize(mapping.tileTitle)}</strong><small>{mapping.supported ? `${humanize(mapping.sourceName)} · ${mapping.mode === 'semantic' ? 'semantic' : 'column'} binding` : mapping.reason}</small></span>{mapping.supported ? <Check size={13} /> : <X size={13} />}
            </label>)}</section>;
          })}</div>
        </fieldset>
        <label className="filter-required"><input type="checkbox" checked={configuration.required} onChange={(event) => setConfiguration({ ...configuration, required: event.target.checked })} /><span><strong>Require a value</strong><small>Publication and runs require this filter to be set.</small></span></label>
        <div className="filter-builder-actions"><button type="button" onClick={() => setConfiguration(null)}>Cancel</button><button type="button" className="primary" disabled={disabled || !configuration.label.trim() || selectedVisibleCount === 0 || dateFieldHasNoValues} onClick={() => { onSave(configuration); setConfiguration(null); }}>{editingExisting ? 'Save filter' : 'Create filter'}</button></div>
      </div>}
    </>;
  }

  return <>
    <PanelTitle title="Filters" detail="Dashboard controls linked to governed columns" action={<button type="button" disabled={disabled || candidates.length === 0} onClick={() => setConfiguration({ id: '', fieldId: '', label: '', type: 'select', scope: 'app', required: false, selectedMappingKeys: [] })} aria-label="Create filter"><Plus size={14} /></button>} />
    <div className="filter-workflow" aria-label="How App filters work"><span><b>1</b>Choose a governed column</span><span><b>2</b>Link all or selected components</span><span><b>3</b>Use the control directly on the canvas</span><small>Changing a filter refreshes every linked tile together.</small></div>
    {logicalFilters.length > 0 ? <div className="panel-section-label"><span>Dashboard filters</span><small>{logicalFilters.length} configured</small></div> : null}
    <div className="filter-contract-list">{logicalFilters.map((item) => {
      const fieldId = item.filter.field?.name ?? item.filter.bindsTo ?? item.filter.id;
      const linked = linkedComponentCount(draft, item.filter.id);
      return <article key={item.filter.id}><button type="button" className="filter-contract-summary" onClick={() => editFilter(item)}><span><Filter size={14} /></span><div><strong>{item.filter.label ?? humanize(item.filter.id)}</strong><small>{humanize(fieldId)} · {humanize(item.filter.type)}</small><em>{linked} linked {linked === 1 ? 'component' : 'components'} · {item.pageIds.length > 1 ? 'App-wide' : humanize(draft.pages.find((page) => page.id === item.pageIds[0])?.metadata.title ?? 'Page')}</em></div><Settings2 size={14} /></button><button type="button" className="filter-remove" onClick={() => onRemove(item.filter.id)} aria-label={`Delete ${item.filter.label ?? humanize(item.filter.id)} filter`} title="Delete filter"><Trash2 size={13} /></button></article>;
    })}</div>
    {logicalFilters.length === 0 ? <div className="filter-empty"><span><Filter size={18} /></span><strong>Create a dashboard filter</strong><p>Pick a governed column, choose a dropdown or search control, then link every compatible tile.</p><button type="button" disabled={disabled || candidates.length === 0} onClick={() => setConfiguration({ id: '', fieldId: '', label: '', type: 'select', scope: 'app', required: false, selectedMappingKeys: [] })}><Plus size={13} /> New filter</button></div> : null}
    {candidates.length === 0 ? <p className="panel-empty">Add a governed KPI, chart, or table first. Certified filter columns and semantic dimensions will appear here.</p> : logicalFilters.length > 0 ? <button type="button" className="filter-add-another" disabled={disabled} onClick={() => setConfiguration({ id: '', fieldId: '', label: '', type: 'select', scope: 'app', required: false, selectedMappingKeys: [] })}><Plus size={13} /> Add another filter</button> : null}
  </>;
}

function TemplatesPanel({ current, onApply }: { current: StudioTemplate; onApply: (id: StudioTemplate) => void }): JSX.Element {
  return <><PanelTitle title="Templates" detail="Professional analytical structures" /><div className="template-list">{TEMPLATE_OPTIONS.map((item) => <button key={item.id} type="button" className={current === item.id ? 'on' : ''} onClick={() => onApply(item.id)}><span>{templateIcon(item.id)}</span><div><strong>{item.title}</strong><small>{item.description}</small></div></button>)}</div></>;
}

function BuildFrameInspector({ draft, prompt, previewRun, onPrompt, onAskAi, onSourcePolicy, onResolveTask, onApproveSemantic }: { draft: AppStudioBuildDraft; prompt: string; previewRun: DashboardRunResponse | null; onPrompt: (value: string) => void; onAskAi: () => void; onSourcePolicy: (value: AppStudioBuildDraft['sourcePolicy']) => void; onResolveTask: (task: AppStudioBuildDraft['reviewTasks'][number]) => void; onApproveSemantic: () => void }): JSX.Element {
  const openTasks = blockingPublicationReviewTasks(draft);
  const semanticNeedsApproval = draft.sources.some((source) => (source.kind === 'governed_semantic' || source.kind === 'semantic_query') && source.reviewStatus !== 'approved');
  return <div className="inspector-body"><section><label>Business decision</label><textarea value={prompt} onChange={(event) => onPrompt(event.target.value)} rows={5} /></section><section><label>Source policy</label><select value={draft.sourcePolicy} onChange={(event) => onSourcePolicy(event.target.value as AppStudioBuildDraft['sourcePolicy'])}><option value="governed_only">Governed sources only</option><option value="include_review_required">Include review-required analysis</option></select><small className="field-help">Review-required sources stay local and block Project publication until replaced or promoted.</small></section><section className="frame-facts"><label>Build Frame</label><div><span>Audience</span><strong>{draft.frame.audience || 'Stakeholders'}</strong></div><div><span>Metrics</span><strong>{draft.frame.metrics.join(', ') || 'Needs clarification'}</strong></div><div><span>Dimensions</span><strong>{draft.frame.dimensions.join(', ') || 'Automatic'}</strong></div><div><span>Source policy</span><strong>{draft.sourcePolicy === 'governed_only' ? 'Governed only' : 'Includes review lane'}</strong></div></section>{semanticNeedsApproval ? <section><label>Semantic review</label><button type="button" className="review-action" onClick={onApproveSemantic} disabled={!previewRun}><ShieldCheck size={14} /> {previewRun ? 'Approve this settled result' : 'Run preview to approve'}</button></section> : null}{openTasks.length ? <section className="review-task-list"><label>Review tasks</label>{openTasks.map((task) => <div key={task.id}><span>{task.message}</span><button type="button" onClick={() => onResolveTask(task)}><Check size={12} /> Resolve</button></div>)}</section> : null}<button type="button" className="ask-ai" onClick={onAskAi}><Bot size={16} /> Ask AI to compose or revise</button><section className="trust-summary"><ShieldCheck size={17} /><div><strong>Nothing publishes silently</strong><p>AI changes are typed diffs. Project publication revalidates live source trust and filter bindings.</p></div></section></div>;
}

function ComponentInspector({ tile, run, pageId, onUpdate, onDelete }: { tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]; run?: DashboardRunResponse['tiles'][number]; pageId: string; onUpdate: (patch: Partial<typeof tile>) => void; onDelete: () => void }): JSX.Element {
  const [title, setTitle] = useState(tile.title ?? '');
  const [markdown, setMarkdown] = useState(tile.text?.markdown ?? '');
  useEffect(() => setTitle(tile.title ?? ''), [tile.i, tile.title]);
  useEffect(() => setMarkdown(tile.text?.markdown ?? ''), [tile.i, tile.text?.markdown]);
  const options = tile.viz.options ?? {};
  const columns = run?.result?.columns ?? [];
  const setOption = (key: string, value: unknown) => onUpdate({ viz: { ...tile.viz, options: { ...options, [key]: value || undefined } } });
  return <div className="inspector-body">
    <section><label>Title</label><input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (title.trim() !== (tile.title ?? '')) onUpdate({ title: title.trim() }); }} /></section>
    {tile.text ? <section><label>Content</label><textarea rows={7} value={markdown} onChange={(event) => setMarkdown(event.target.value)} onBlur={() => { if (markdown !== tile.text?.markdown) onUpdate({ text: { markdown } }); }} /><small className="field-help">Safe Markdown only. Executable HTML and JavaScript are not supported.</small></section> : null}
    <section><label>Visualization</label><select value={tile.viz.type} onChange={(event) => onUpdate({ viz: { ...tile.viz, type: event.target.value as typeof tile.viz.type } })}>{['single_value', 'bar', 'line', 'area', 'scatter', 'heatmap', 'table', 'pivot', 'text', 'heading'].map((type) => <option key={type} value={type}>{humanize(type)}</option>)}</select></section>
    {!tile.text ? <section className="field-mapping"><label>Field mapping</label><div><span>X / category</span><select value={String(options.x ?? '')} onChange={(event) => setOption('x', event.target.value)}><option value="">Auto</option>{columns.map((column) => <option key={column} value={column}>{humanize(column)}</option>)}</select></div><div><span>Y / value</span><select value={String(options.y ?? '')} onChange={(event) => setOption('y', event.target.value)}><option value="">Auto</option>{columns.map((column) => <option key={column} value={column}>{humanize(column)}</option>)}</select></div><small className="field-help">Run preview to load the exact result fields.</small></section> : null}
    {!tile.text ? <section className="format-grid"><label>Formatting</label><div><span>Number</span><select value={String(options.format ?? 'number')} onChange={(event) => setOption('format', event.target.value)}><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="duration">Duration</option></select></div><div><span>Legend</span><select value={String(options.legendPosition ?? 'right')} onChange={(event) => setOption('legendPosition', event.target.value)}><option value="top">Top</option><option value="right">Right</option><option value="bottom">Bottom</option><option value="none">Hidden</option></select></div></section> : null}
    <section><label>Responsive size</label><div className="size-buttons">{[['Compact', 3, 2], ['Standard', 6, 4], ['Wide', 12, 4], ['Tall', 6, 7]].map(([label, w, h]) => <button key={label} type="button" onClick={() => onUpdate({ w: Number(w), h: Number(h) })}>{label}</button>)}</div></section>
    <section className="data-trust"><label>Data & trust</label><div><span className={`trust-dot ${tile.trustState ?? 'draft_ready'}`} /><strong>{humanize(tile.trustState ?? 'draft_ready')}</strong></div><p>{tile.block ? `${tile.trustState === 'certified' ? 'Certified' : 'Review-required'} block: ${'blockId' in tile.block ? tile.block.blockId : tile.block.ref}` : tile.semantic ? `Governed semantic query: ${tile.semantic.id}` : tile.draftAnalysis ? `Review-required DQL: ${tile.draftAnalysis.ref}` : 'Local narrative component'}</p>{tile.sourceEvidence?.slice(0, 2).map((evidence, index) => <small key={`${evidence.source}-${index}`}>{evidence.reason}</small>)}{run ? <small>{run.status === 'ok' ? `Settled on ${run.result?.rowCount ?? run.result?.rows.length ?? 0} rows` : run.error}</small> : null}</section>
    <button type="button" className="delete-component" onClick={onDelete}><Trash2 size={15} /> Remove component</button><small className="inspector-id">{pageId} / {tile.i}</small>
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

function StudioTilePreview({
  tile,
  run,
  loading,
  themeMode,
}: {
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number];
  run?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  themeMode: ThemeMode;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [height, setHeight] = useState(190);
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
  if (run.status !== 'ok' || !run.result) return <div className="preview-state error"><strong>{humanize(run.status)}</strong><span>{run.error ?? 'This component could not run with the current source and filters.'}</span></div>;
  const chart = tile.viz.type === 'single_value' ? 'kpi' : tile.viz.type;
  const chartConfig = { ...(run.chartConfig ?? {}), ...(tile.viz.options ?? {}), chart } as CellChartConfig;
  return (
    <div ref={frameRef} className="live-component-preview" onClick={(event) => event.stopPropagation()}>
      {chart === 'table' || chart === 'pivot'
        ? <TableOutput result={run.result} themeMode={themeMode} maxHeight={height} initialPageSize={10} />
        : <ChartOutput result={run.result} themeMode={themeMode} chartConfig={{ ...chartConfig, title: undefined }} availableHeight={height} availableWidth={width} />}
    </div>
  );
}

function PanelTitle({ title, detail, action }: { title: string; detail: string; action?: ReactNode }): JSX.Element {
  return <header className="panel-title"><div><strong>{title}</strong><small>{detail}</small></div>{action}</header>;
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

function componentKindLabel(kind: 'kpi' | 'chart' | 'table'): string {
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
  return page.layout.items.some((item) => Boolean(item.block || item.semantic || item.draftAnalysis));
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

function filterControlOptions(fieldId: string): Array<{ value: StudioFilterControlType; label: string }> {
  const common: Array<{ value: StudioFilterControlType; label: string }> = [
    { value: 'select', label: 'Searchable dropdown' },
    { value: 'multiselect', label: 'Searchable multi-select' },
  ];
  if (defaultStudioFilterType(fieldId) === 'daterange') {
    return [
      { value: 'daterange', label: 'Date range' },
      { value: 'date', label: 'Single date' },
      ...common,
    ];
  }
  if (/count|amount|total|score|quantity|price|revenue|cost|limit|top_?n/i.test(fieldId)) {
    return [{ value: 'number', label: 'Number' }, ...common];
  }
  if (/^(is_|has_)|_flag$|enabled|active/i.test(fieldId)) {
    return [{ value: 'boolean', label: 'Yes / no' }, ...common];
  }
  return common;
}

function studioFieldAvailability(
  fieldId: string,
  mappings: StudioFilterTileMapping[],
  previewRunsByPage: Record<string, DashboardRunResponse>,
): StudioFieldAvailability {
  let checkedComponents = 0;
  let valueCount = 0;
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;
  for (const mapping of mappings) {
    const tile = previewRunsByPage[mapping.pageId]?.tiles.find((candidate) => candidate.tileId === mapping.tileId);
    if (tile?.status !== 'ok' || !tile.result) continue;
    const requested = normalizeStudioField(mapping.binding ?? fieldId);
    const column = tile.result.columns.find((candidate) => normalizeStudioField(candidate) === requested);
    if (!column) continue;
    checkedComponents += 1;
    for (const row of tile.result.rows) {
      const timestamp = Date.parse(String(row[column] ?? ''));
      if (!Number.isFinite(timestamp)) continue;
      valueCount += 1;
      minTimestamp = Math.min(minTimestamp, timestamp);
      maxTimestamp = Math.max(maxTimestamp, timestamp);
    }
  }
  return {
    checkedComponents,
    compatibleComponents: mappings.length,
    valueCount,
    ...(valueCount > 0 ? {
      dateRange: {
        min: new Date(minTimestamp).toISOString().slice(0, 10),
        max: new Date(maxTimestamp).toISOString().slice(0, 10),
      },
    } : {}),
  };
}

function normalizeStudioField(value: string): string {
  return value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.').at(-1)?.replace(/[^a-z0-9]/g, '') ?? '';
}

function mergeStudioDateRanges(
  current?: { min: string; max: string },
  incoming?: { min: string; max: string },
): { min: string; max: string } | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return {
    min: current.min < incoming.min ? current.min : incoming.min,
    max: current.max > incoming.max ? current.max : incoming.max,
  };
}

function linkedComponentCount(draft: AppStudioBuildDraft, filterId: string): number {
  return draft.pages.reduce((count, page) => {
    const filter = page.filters?.find((candidate) => candidate.id === filterId);
    if (!filter) return count;
    return count + page.layout.items.filter((tile) => {
      if (filter.scope?.tileIds && !filter.scope.tileIds.includes(tile.i)) return false;
      return tile.filterBindings?.some((binding) => binding.filter === filterId && binding.capability !== 'unsupported') ?? false;
    }).length;
  }, 0);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
