import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowLeft, BarChart3, Blocks, Bot, Check, ChevronDown, FileText, Filter,
  Gauge, Heading, LayoutDashboard, Monitor, MoreHorizontal, PanelRight,
  Play, Plus, Redo2, Search, Settings2, ShieldCheck, Smartphone, Sparkles, Table2,
  Trash2, Type, Undo2, Upload, X,
} from 'lucide-react';
import {
  api,
  type AppBlockRecommendation,
  type AppStudioAiProposal,
  type AppStudioBuildDraft,
  type AppStudioDraftOperation,
  type DashboardRunResponse,
} from '../../api/client';
import type { AppSummary } from '../../store/types';
import type { CellChartConfig } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { APP_STUDIO_V2_STYLES } from './app-studio-v2-styles';
import { discoverPageFilterCandidates, type StudioFilterCandidate } from './app-studio-filter-candidates';

type StudioPanel = 'pages' | 'sources' | 'filters' | 'templates';
type StudioBreakpoint = 'wide' | 'medium' | 'narrow';
type StudioPreviewMode = 'auto' | StudioBreakpoint;
type StudioTemplate = AppStudioBuildDraft['template'];

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
      <div className="launch-label">Choose a starting layout</div>
      <div className="template-grid">
        {TEMPLATE_OPTIONS.map((option) => <button key={option.id} type="button" className={config.template === option.id ? 'on' : ''} onClick={() => onChange({ template: option.id })}><span>{templateIcon(option.id)}</span><strong>{option.title}</strong><small>{option.description}</small></button>)}
      </div>
      <div className="studio-source-policy-row">
        <div><span className="policy-mark"><ShieldCheck size={17} /></span><p><strong>Governed sources by default</strong><small>Certified blocks and governed semantic sources</small></p></div>
        <label className="studio-review-toggle"><input type="checkbox" checked={config.sourcePolicy === 'include_review_required'} onChange={(event) => onChange({ sourcePolicy: event.target.checked ? 'include_review_required' : 'governed_only' })} /><i aria-hidden="true" /><span><strong>Include review-required analysis</strong><small>Clearly labeled and blocked from publication until resolved</small></span></label>
      </div>
      {error ? <div className="studio-error" role="alert">{error}</div> : null}
      <button type="button" className="launch-action" onClick={onSubmit} disabled={busy || !canSubmit}>{busy ? 'Preparing local draft…' : config.mode === 'ai' ? <><Sparkles size={17} /> Create Build Frame</> : <><LayoutDashboard size={17} /> Open Studio</>}</button>
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
  const [proposal, setProposal] = useState<AppStudioAiProposal | null>(null);
  const [undoStack, setUndoStack] = useState<AppStudioBuildDraft[]>([]);
  const [redoStack, setRedoStack] = useState<AppStudioBuildDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState('Local draft');
  const [previewRun, setPreviewRun] = useState<DashboardRunResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewVariables, setPreviewVariables] = useState<Record<string, unknown>>({});
  const [draggingTileId, setDraggingTileId] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const draggingTileIdRef = useRef<string | null>(null);
  const immediateStartRef = useRef(false);
  const workspaceRef = useRef<HTMLElement>(null);

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
    void api.recommendAppBlocks({
      domain: draft.pages[0]?.metadata.domain,
      purpose: draft.frame.goal,
      audience: draft.frame.audience,
      certifiedOnly: draft.sourcePolicy === 'governed_only',
    }).then((items) => { if (active) setCatalog(items); }).catch(() => { if (active) setCatalog([]); });
    return () => { active = false; };
  }, [draft?.id, draft?.sourcePolicy, draft?.frame.goal]);

  const activePage = useMemo(
    () => draft?.pages.find((page) => page.id === activePageId) ?? draft?.pages[0] ?? null,
    [activePageId, draft],
  );
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
  const filteredCatalog = useMemo(() => {
    const needle = catalogQuery.trim().toLowerCase();
    return catalog.filter((item) => !needle || [item.name, item.domain, item.description, ...item.tags].join(' ').toLowerCase().includes(needle));
  }, [catalog, catalogQuery]);
  const filterCandidates = useMemo(
    () => discoverPageFilterCandidates(activePage, catalog),
    [activePage, catalog],
  );

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
      setPreviewRun(null);
      if (mode === 'ai') await requestAiProposal(result.draft, prompt);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const requestAiProposal = async (base = draft, nextPrompt = prompt) => {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.proposeAppBuildChanges(base.id, {
        prompt: nextPrompt.trim() || base.frame.goal,
        expectedRevision: base.revision,
        proposalHash: base.proposalHash,
        selectedBlockIds: selectedSource ? [selectedSource.id] : undefined,
      });
      setProposal(result.proposal);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
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
      if (!keepVisiblePreview) setPreviewRun(null);
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
    const next = await mutate(proposal.operations);
    if (next) {
      setProposal(null);
      setName(next.name);
      setActivePageId(next.pages[0]?.id ?? activePageId);
    }
  };

  const answerProposalClarification = (questionId: string, choiceId: string, label: string) => {
    setPrompt((value) => `${value.trim()}${value.trim().endsWith('.') ? '' : '.'} ${label}.`);
    setProposal((current) => current ? {
      ...current,
      clarifications: current.clarifications.map((question) => question.id === questionId ? { ...question, answerId: choiceId } : question),
      operations: current.operations.map((operation) => operation.type === 'set_frame' ? {
        ...operation,
        frame: {
          ...operation.frame,
          clarificationQuestions: (operation.frame.clarificationQuestions ?? []).map((question) => question.id === questionId ? { ...question, answerId: choiceId } : question),
        },
      } : operation),
    } : current);
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

  const sourceOperation = (source: AppBlockRecommendation): AppStudioDraftOperation | null => {
    if (!draft) return null;
    const review = source.status !== 'certified';
    if (review && draft.sourcePolicy === 'governed_only') {
      setError('This source requires the “Include review-required analysis” policy.');
      return null;
    }
    return {
      type: 'upsert_source',
      source: {
        id: `${review ? 'review-block' : 'block'}:${source.id}`,
        kind: review ? 'review_block' : 'certified_block',
        sourceRef: source.id,
        sourceFingerprint: source.fingerprint,
        trustState: review ? 'review_required' : 'certified',
        reviewStatus: review ? 'required' : 'not_required',
      },
    };
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
    const sourceOp = source ? sourceOperation(source) : null;
    if (source && !sourceOp) return;
    if (source) setSelectedSource(source);
    const tileId = `${kind}-${Date.now().toString(36)}`;
    const width = kind === 'kpi' ? 3 : kind === 'heading' || kind === 'text' ? 12 : 6;
    const height = kind === 'heading' ? 1 : kind === 'kpi' ? 2 : kind === 'text' ? 2 : 4;
    const nextY = activePage.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] = {
      i: tileId,
      x: 0,
      y: nextY,
      w: width,
      h: height,
      title: kind === 'heading' ? 'Section heading' : kind === 'text' ? 'Narrative' : source!.name,
      ...(kind === 'heading' || kind === 'text'
        ? { text: { markdown: kind === 'heading' ? '## New section' : 'Add context, interpretation, or guidance.' }, sourceClass: 'narrative' as const }
        : {
          block: { blockId: source!.id },
          sourceClass: source!.status === 'certified' ? 'certified_block' as const : 'exploratory_analysis' as const,
          filterBindings: (source!.filterIds ?? []).map((filter) => ({ filter, binding: filter, mode: 'predicate' as const, capability: 'preflight_required' as const })),
        }),
      viz: { type: kind === 'heading' ? 'heading' : kind === 'text' ? 'text' : kind === 'kpi' ? 'single_value' : kind === 'table' ? 'table' : normalizeViz(source?.chartType) },
      trustState: source?.status === 'certified' ? 'certified' : kind === 'heading' || kind === 'text' ? 'draft_ready' : 'review_required',
      reviewStatus: source?.status === 'certified' ? 'certified' : kind === 'heading' || kind === 'text' ? 'draft_ready' : 'review_required',
    };
    const operations: AppStudioDraftOperation[] = [
      ...(sourceOp ? [sourceOp] : []),
      { type: 'add_tile', pageId: activePage.id, tile },
    ];
    const next = await mutate(operations);
    if (next) {
      setSelectedTileId(tileId);
      const filterCount = source?.filterIds?.length ?? 0;
      setSavedMessage(filterCount > 0
        ? `${kind === 'chart' ? 'Chart' : humanize(kind)} added · ${filterCount} ${filterCount === 1 ? 'filter' : 'filters'} available`
        : `${kind === 'chart' ? 'Chart' : humanize(kind)} added`);
    }
  };

  const arrangePage = async () => {
    if (!activePage || !draft) return;
    const items = packStudioItems(collapseTemplateIntroductions(activePage.layout.items, draft.template), 12);
    const next = await mutate([{ type: 'set_layout', pageId: activePage.id, layout: { ...activePage.layout, items } }]);
    if (next) setSavedMessage('Page arranged · preview preserved');
  };

  const addFilter = async (filterId: string) => {
    if (!activePage) return;
    const operations: AppStudioDraftOperation[] = [{
      type: 'set_filter', pageId: activePage.id,
      filter: { id: filterId, label: humanize(filterId), type: filterType(filterId), bindsTo: filterId },
    }];
    for (const tile of activePage.layout.items.filter((item) => item.block || item.semantic || item.draftAnalysis)) {
      const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
      const source = blockId ? catalog.find((item) => item.id === blockId) : null;
      const supported = Boolean(source?.filterIds?.includes(filterId));
      const bindings = [...(tile.filterBindings ?? []).filter((item) => item.filter !== filterId), {
        filter: filterId,
        ...(supported ? { binding: filterId, mode: 'predicate' as const } : {}),
        capability: supported ? 'preflight_required' as const : 'unsupported' as const,
        ...(!supported ? { unsupportedReason: `${humanize(filterId)} is not exposed by ${tile.title || humanize(tile.i)}.` } : {}),
      }];
      operations.push({ type: 'update_tile', pageId: activePage.id, tileId: tile.i, patch: { filterBindings: bindings } });
    }
    const next = await mutate(operations);
    if (next) setSavedMessage(`${humanize(filterId)} filter added · choose a value, then run data preview`);
  };

  const removeFilter = async (filterId: string) => {
    if (!activePage) return;
    const operations: AppStudioDraftOperation[] = [{ type: 'remove_filter', pageId: activePage.id, filterId }];
    for (const tile of activePage.layout.items.filter((item) => item.filterBindings?.some((binding) => binding.filter === filterId))) {
      operations.push({
        type: 'update_tile',
        pageId: activePage.id,
        tileId: tile.i,
        patch: { filterBindings: (tile.filterBindings ?? []).filter((binding) => binding.filter !== filterId) },
      });
    }
    const next = await mutate(operations);
    if (next) setSavedMessage(`${humanize(filterId)} filter removed`);
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

  const publish = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const preflight = await api.preflightAppBuild(draft.id, draft.revision, draft.proposalHash);
      setDraft(preflight.draft);
      const result = await api.publishAppBuild(preflight.draft.id, preflight.draft.revision, preflight.draft.proposalHash);
      setDraft(result.draft);
      onPublished(result.app, result.draft.pages[0]?.id);
    } catch (cause) {
      setError(`Project publication needs attention. ${messageOf(cause)}`);
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

  const runPreview = async () => {
    if (!draft || !activePage) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await api.runAppBuildPreview(draft.id, activePage.id, previewVariables);
      const recorded = await api.patchAppBuild(draft.id, draft.revision, [{
        type: 'set_preview_receipt',
        receipt: {
          id: result.runId,
          pageId: activePage.id,
          revision: draft.revision,
          snapshotId: result.snapshotId,
          filterFingerprint: result.filterFingerprint,
          resultFingerprint: result.resultFingerprint,
          createdAt: new Date().toISOString(),
        },
      }], draft.proposalHash);
      setDraft(recorded.draft);
      setPreviewRun(result);
      setSavedMessage(`Preview settled · ${result.tiles.filter((tile) => tile.status === 'ok').length}/${result.tiles.length} ready`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPreviewing(false);
    }
  };

  if (!draft) {
    return <div className="dql-studio-v2-loading">
      <style>{APP_STUDIO_V2_STYLES}</style>
      <button type="button" className="icon" onClick={onBack} aria-label="Back to Apps"><ArrowLeft size={18} /></button>
      <div><span className="loading-mark"><LayoutDashboard size={20} /></span><strong>{error ? 'Studio could not open' : initialDraftId ? 'Opening your local draft…' : baseAppId ? 'Preparing a safe edit draft…' : 'Preparing your Build Frame…'}</strong><small>{error ?? 'Keeping all work local until you explicitly publish it to the Project.'}</small>{error ? <button type="button" onClick={() => { immediateStartRef.current = false; void createDraft(); }}>Try again</button> : null}</div>
    </div>;
  }

  return (
    <div className="dql-studio-v2">
      <style>{APP_STUDIO_V2_STYLES}</style>
      <header className="studio-topbar">
        <div className="studio-brand"><button type="button" className="icon" onClick={onBack}><ArrowLeft size={17} /></button><span className="mark"><LayoutDashboard size={16} /></span><div><input value={name || draft.name} onChange={(event) => setName(event.target.value)} onBlur={() => { if (name.trim() && name.trim() !== draft.name) void mutate([{ type: 'set_name', name: name.trim() }]); }} /><small>{savedMessage}</small></div></div>
        <nav className="page-nav" aria-label="App pages">
          {draft.pages.map((page) => <button key={page.id} type="button" className={activePage?.id === page.id ? 'on' : ''} onClick={() => { setActivePageId(page.id); setSelectedTileId(null); }}>{page.metadata.title}</button>)}
          <button type="button" className="icon" onClick={() => void addPage()} aria-label="Add page"><Plus size={15} /></button>
        </nav>
        <div className="studio-actions">
          <button type="button" className="icon" disabled={!undoStack.length || busy} onClick={() => void undo()} title="Undo"><Undo2 size={16} /></button>
          <button type="button" className="icon" disabled={!redoStack.length || busy} onClick={() => void redo()} title="Redo"><Redo2 size={16} /></button>
          <div className="breakpoints">
            <button type="button" className={previewMode === 'auto' ? 'on' : ''} onClick={() => setPreviewMode('auto')} title="Fit to available canvas"><LayoutDashboard size={15} /></button>
            <button type="button" className={previewMode === 'wide' ? 'on' : ''} onClick={() => setPreviewMode('wide')} title="Wide preview"><Monitor size={15} /></button>
            <button type="button" className={previewMode === 'medium' ? 'on' : ''} onClick={() => setPreviewMode('medium')} title="Tablet preview"><PanelRight size={15} /></button>
            <button type="button" className={previewMode === 'narrow' ? 'on' : ''} onClick={() => setPreviewMode('narrow')} title="Phone preview"><Smartphone size={15} /></button>
          </div>
          <span className={`review-state ${draft.reviewTasks.some((task) => task.status === 'open') ? 'needs-review' : ''}`}><ShieldCheck size={14} /> {draft.reviewTasks.some((task) => task.status === 'open') ? 'Review required' : 'Local draft'}</span>
          <button type="button" className="preview" onClick={() => void runPreview()} disabled={previewing || busy} aria-label={previewing ? 'Running preview' : 'Run preview'}><Play size={13} /><span>{previewing ? 'Running…' : 'Run preview'}</span></button>
          <button type="button" className="publish" onClick={() => void publish()} disabled={busy} aria-label="Publish to Project"><Upload size={13} /><span>Publish to Project</span></button>
          <button type="button" className="icon overflow-button" aria-label="More draft actions" aria-expanded={actionsOpen} onClick={() => setActionsOpen((open) => !open)}><MoreHorizontal size={17} /></button>
          {actionsOpen ? <div className="studio-overflow-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setDeleteConfirmOpen(true); }}><Trash2 size={14} /> Delete local draft</button></div> : null}
        </div>
      </header>

      <aside className="studio-left">
        <nav>
          {([
            ['sources', Plus, 'Add'], ['pages', LayoutDashboard, 'Pages'],
            ['filters', Filter, 'Filters'], ['templates', FileText, 'Design'],
          ] as const).map(([id, Icon, label]) => <button key={id} type="button" className={panel === id && panelOpen ? 'on' : ''} onClick={() => { if (window.innerWidth <= 820 && panel === id) setPanelOpen((open) => !open); else { setPanel(id); setPanelOpen(true); } }}><Icon size={17} /><span>{label}</span></button>)}
        </nav>
        <section className={`left-content ${panelOpen ? 'open' : ''}`}>
          <button type="button" className="mobile-drawer-close" onClick={() => setPanelOpen(false)} aria-label="Close Studio drawer"><X size={16} /></button>
          {panel === 'pages' ? <PagesPanel draft={draft} activePageId={activePage?.id} onOpen={setActivePageId} onAdd={() => void addPage()} /> : null}
          {panel === 'sources' ? <SourcesPanel items={filteredCatalog} selected={selectedSource} query={catalogQuery} onQuery={setCatalogQuery} onSelect={selectSource} onAdd={(item, kind) => void addComponent(kind, item)} onAddContent={(kind) => void addComponent(kind, null)} policy={draft.sourcePolicy} /> : null}
          {panel === 'filters' ? <FiltersPanel page={activePage} candidates={filterCandidates} onAdd={(id) => void addFilter(id)} onRemove={(id) => void removeFilter(id)} /> : null}
          {panel === 'templates' ? <TemplatesPanel current={draft.template} onApply={(nextTemplate) => void applyTemplate(nextTemplate)} /> : null}
        </section>
      </aside>

      <main ref={workspaceRef} className="studio-workspace">
        {error ? <div className="studio-error floating" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
        <div className={`studio-canvas-frame ${breakpoint} preview-mode-${previewMode}`}>
          <div className="studio-canvas-label"><div><span>{previewMode === 'auto' ? 'Fit canvas' : `${breakpoint.charAt(0).toUpperCase() + breakpoint.slice(1)} preview`} · {breakpoint === 'wide' ? '12 columns' : breakpoint === 'medium' ? '6 columns' : '1 column'}</span><small>Drag components to reorder · saved instantly</small></div><button type="button" onClick={() => void arrangePage()} disabled={!activePage?.layout.items.length || busy} title="Compact gaps and restore a clean reading order"><LayoutDashboard size={13} /> Auto arrange</button></div>
          <section className="studio-canvas" aria-label="App canvas">
            <header className="studio-page-heading"><div><small>APP PAGE</small><span>{activePage?.metadata.title ?? 'Overview'}</span></div><small>{draft.frame.audience || 'Stakeholders'} · {draft.pages[0]?.metadata.domain || 'General'}</small></header>
            {selectedSource ? <div className="studio-source-ready"><div><span className="certified"><ShieldCheck size={14} /></span><p><small>Selected data</small><strong>{humanize(selectedSource.name)}</strong></p></div><span className="studio-source-actions"><button type="button" onClick={() => void addComponent(recommendedComponentKind(selectedSource), selectedSource)}><Plus size={14} /> Add {componentKindLabel(recommendedComponentKind(selectedSource))}</button><button type="button" className="source-clear" onClick={() => setSelectedSource(null)} aria-label="Clear selected data"><X size={14} /></button></span></div> : null}
            {(activePage?.filters ?? []).length ? <div className="studio-page-filterbar">{activePage!.filters!.map((filter) => <StudioFilterControl key={filter.id} filter={filter} value={previewVariables[filter.id] ?? filter.default} onChange={(value) => { setPreviewVariables((current) => ({ ...current, [filter.id]: value })); setPreviewRun(null); }} />)}</div> : null}
            <div className="studio-page-grid">
              {visibleItems.map((tile) => (
                <article key={tile.i} role="button" tabIndex={0} draggable className={`studio-component-card ${selectedTileId === tile.i ? 'selected' : ''} ${draggingTileId === tile.i ? 'dragging' : ''}`} style={{ '--studio-tile-width': Math.min(tile.w, breakpoint === 'medium' ? 6 : breakpoint === 'narrow' ? 1 : 12), minHeight: breakpoint === 'narrow' ? Math.max(180, tile.h * 58) : Math.max(150, tile.h * 68) } as CSSProperties} onDragStart={() => { draggingTileIdRef.current = tile.i; setDraggingTileId(tile.i); }} onDragEnd={() => { draggingTileIdRef.current = null; setDraggingTileId(null); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void moveTileBefore(tile.i); }} onClick={() => setSelectedTileId(tile.i)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedTileId(tile.i); }}>
                  <header><span className="drag-handle" aria-hidden="true">⠿</span><span className={`trust-dot ${tile.trustState ?? 'draft_ready'}`} /> <strong>{tile.title || humanize(tile.i)}</strong><small>{tile.viz.type.replace(/_/g, ' ')}</small></header>
                  {unsupportedTileFilters(tile).map((binding) => <div key={binding.filter} className="tile-filter-notice"><Filter size={11} /><span>{binding.unsupportedReason ?? `${humanize(binding.filter)} does not affect this component.`}</span></div>)}
                  {tile.text ? <div className={tile.viz.type === 'heading' ? 'tile-heading' : 'tile-text'}>{tile.text.markdown.replace(/^#+\s*/, '')}</div> : <StudioTilePreview tile={tile} run={previewRun?.tiles.find((item) => item.tileId === tile.i)} themeMode={themeMode} />}
                </article>
              ))}
              {!visibleItems.length ? <div className="empty-canvas"><span><Plus size={22} /></span><strong>Build this page</strong><p>Choose Add on the left, select governed data, and add its recommended view. You can also add text or a heading.</p><button type="button" onClick={() => { setPanel('sources'); setPanelOpen(true); }}>Add data or content</button></div> : null}
            </div>
          </section>
        </div>
      </main>

      <aside className={`studio-right ${selectedTile ? 'has-selection' : ''}`}>
        <header><div><Settings2 size={16} /><strong>{selectedTile ? 'Component properties' : 'App Build Frame'}</strong></div><button type="button" className="icon" onClick={() => setSelectedTileId(null)} aria-label={selectedTile ? 'Close component properties' : 'More App settings'}>{selectedTile ? <X size={16} /> : <MoreHorizontal size={16} />}</button></header>
        {selectedTile && activePage ? (
          <ComponentInspector tile={selectedTile} run={previewRun?.tiles.find((item) => item.tileId === selectedTile.i)} pageId={activePage.id} onUpdate={(patch) => void mutate([{ type: 'update_tile', pageId: activePage.id, tileId: selectedTile.i, patch }])} onDelete={() => void mutate([{ type: 'remove_tile', pageId: activePage.id, tileId: selectedTile.i }]).then(() => setSelectedTileId(null))} />
        ) : (
          <BuildFrameInspector draft={draft} prompt={prompt} previewRun={previewRun} onPrompt={setPrompt} onAskAi={() => void requestAiProposal()} onSourcePolicy={(nextPolicy) => void mutate([{ type: 'set_source_policy', sourcePolicy: nextPolicy }])} onResolveTask={(task) => void mutate([{ type: 'set_review_task', task: { ...task, status: 'resolved' } }])} onApproveSemantic={() => void approveSemanticPreview()} />
        )}
      </aside>

      {proposal ? (
        <div className="proposal-scrim" role="dialog" aria-modal="true" aria-label="AI App proposal">
          <section className="proposal-card">
            <header><span><Sparkles size={17} /></span><div><strong>AI composition ready</strong><small>Preview the typed changes before applying them to your local draft.</small></div><button type="button" className="icon" onClick={() => setProposal(null)}>×</button></header>
            <div className="proposal-summary"><div><strong>{proposal.summary.requirements}</strong><span>questions</span></div><div><strong>{proposal.summary.covered}</strong><span>covered</span></div><div><strong>{proposal.summary.certifiedSources}</strong><span>certified</span></div><div><strong>{proposal.summary.gaps}</strong><span>visible gaps</span></div></div>
            {proposal.clarifications.length ? <div className="proposal-clarifications"><strong>Clarify before applying</strong>{proposal.clarifications.map((item) => <div key={item.id}><span>{item.question}</span>{item.choices.map((choice) => <button key={choice.id} type="button" className={item.answerId === choice.id ? 'on' : ''} onClick={() => answerProposalClarification(item.id, choice.id, choice.label)}>{item.answerId === choice.id ? <Check size={11} /> : null}{choice.label}</button>)}</div>)}</div> : null}
            <div className="proposal-change-list"><span><Check size={14} /> Build Frame and analytical requirements</span><span><Check size={14} /> Responsive pages and components</span><span><Check size={14} /> Source identity, trust, and filter bindings</span></div>
            <footer><button type="button" onClick={() => setProposal(null)}>Keep editing</button><button type="button" className="primary" onClick={() => void applyProposal()} disabled={busy || proposal.clarifications.some((item) => item.required && !item.answerId)}><Sparkles size={15} /> Apply to local draft</button></footer>
          </section>
        </div>
      ) : null}
      {deleteConfirmOpen ? <div className="proposal-scrim" role="dialog" aria-modal="true" aria-label="Delete local App draft"><section className="studio-delete-card"><span className="delete-mark"><Trash2 size={18} /></span><h2>Delete this local draft?</h2><p><strong>{draft.name}</strong> will leave the App list. Its pages, components, and local history move to a recovery bundle so you can Undo.</p><footer><button type="button" onClick={() => setDeleteConfirmOpen(false)} disabled={busy}>Cancel</button><button type="button" className="danger" onClick={() => void deleteLocalDraft()} disabled={busy}>{busy ? 'Deleting…' : 'Delete draft'}</button></footer></section></div> : null}
    </div>
  );
}

function PagesPanel({ draft, activePageId, onOpen, onAdd }: { draft: AppStudioBuildDraft; activePageId?: string; onOpen: (id: string) => void; onAdd: () => void }): JSX.Element {
  return <><PanelTitle title="Pages" detail="Organize the App story" action={<button type="button" onClick={onAdd}><Plus size={14} /></button>} /><div className="studio-list">{draft.pages.map((page, index) => <button key={page.id} type="button" className={page.id === activePageId ? 'on' : ''} onClick={() => onOpen(page.id)}><span>{index + 1}</span><div><strong>{page.metadata.title}</strong><small>{page.layout.items.length} components</small></div></button>)}</div></>;
}

function SourcesPanel({
  items,
  selected,
  query,
  onQuery,
  onSelect,
  onAdd,
  onAddContent,
  policy,
}: {
  items: AppBlockRecommendation[];
  selected: AppBlockRecommendation | null;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (item: AppBlockRecommendation) => void;
  onAdd: (item: AppBlockRecommendation, kind: 'kpi' | 'chart' | 'table') => void;
  onAddContent: (kind: 'heading' | 'text') => void;
  policy: AppStudioBuildDraft['sourcePolicy'];
}): JSX.Element {
  const recommended = selected ? recommendedComponentKind(selected) : null;
  return <>
    <PanelTitle title="Add to page" detail="Data, charts, and explanatory content" />
    <div className="studio-add-steps" aria-label="How to add data"><span><b>1</b> Choose data</span><i /><span><b>2</b> Add a view</span></div>
    {selected && recommended ? <section className="selected-source-card">
      <header><span className={selected.status === 'certified' ? 'certified' : 'review'}>{selected.status === 'certified' ? <ShieldCheck size={15} /> : <FileText size={15} />}</span><div><small>Selected data</small><strong title={selected.name}>{humanize(selected.name)}</strong></div></header>
      <p>{selected.description || `${humanize(selected.name)} from the ${humanize(selected.domain)} domain.`}</p>
      {(selected.filterIds?.length ?? 0) > 0 ? <div className="source-filter-availability"><Filter size={13} /><span>{selected.filterIds!.length} {selected.filterIds!.length === 1 ? 'filter' : 'filters'} will be available after you add a view.</span></div> : null}
      <button type="button" className="add-recommended" onClick={() => onAdd(selected, recommended)}><Plus size={14} /> Add {componentKindLabel(recommended)}</button>
      <div className="source-view-options" aria-label="Other component types">
        <button type="button" onClick={() => onAdd(selected, 'kpi')}><Gauge size={13} /> KPI</button>
        <button type="button" onClick={() => onAdd(selected, 'chart')}><BarChart3 size={13} /> Chart</button>
        <button type="button" onClick={() => onAdd(selected, 'table')}><Table2 size={13} /> Table</button>
      </div>
    </section> : <div className="source-prompt"><Blocks size={17} /><div><strong>Select governed data</strong><small>Then DQL will recommend the right component for this page.</small></div></div>}
    <div className="panel-section-label"><span>Governed data</span><small>{policy === 'governed_only' ? 'Certified only' : 'Review lane included'}</small></div>
    <label className="studio-search"><Search size={14} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search data and metrics" /></label>
    <div className="source-list">{items.slice(0, 30).map((item) => {
      const kind = recommendedComponentKind(item);
      return <div key={item.id} className={`source-row ${selected?.id === item.id ? 'on' : ''}`}>
        <button type="button" className="source-select" onClick={() => onSelect(item)} aria-label={`Select ${item.name}`}>
          <span className={item.status === 'certified' ? 'certified' : 'review'}>{item.status === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
          <div><strong title={item.name}>{humanize(item.name)}</strong><small>{humanize(item.domain)} · {componentKindLabel(kind)}</small></div>
        </button>
        <button type="button" className="source-quick-add" onClick={() => onAdd(item, kind)} aria-label={`Add ${item.name} as ${componentKindLabel(kind)}`} title={`Add ${componentKindLabel(kind)}`}><Plus size={14} /></button>
      </div>;
    })}</div>
    <div className="panel-section-label"><span>Page content</span><small>No data source needed</small></div>
    <div className="content-quick-add"><button type="button" onClick={() => onAddContent('heading')}><Heading size={15} /><span><strong>Heading</strong><small>Organize the story</small></span><Plus size={13} /></button><button type="button" onClick={() => onAddContent('text')}><Type size={15} /><span><strong>Text</strong><small>Add context or guidance</small></span><Plus size={13} /></button></div>
  </>;
}

function FiltersPanel({ page, candidates, onAdd, onRemove }: { page: AppStudioBuildDraft['pages'][number] | null; candidates: StudioFilterCandidate[]; onAdd: (id: string) => void; onRemove: (id: string) => void }): JSX.Element {
  const existing = new Set((page?.filters ?? []).map((item) => item.id));
  const available = candidates.filter((candidate) => !existing.has(candidate.id));
  const dataTiles = page?.layout.items.filter((tile) => tile.block || tile.semantic || tile.draftAnalysis) ?? [];
  return <><PanelTitle title="Filters" detail="Controls from data already on this page" />
    <div className="filter-workflow" aria-label="How App filters work"><span><b>1</b>Add a filter</span><span><b>2</b>Choose a value on canvas</span><span><b>3</b>Run data preview</span></div>
    {(page?.filters ?? []).length > 0 ? <div className="panel-section-label"><span>On this page</span><small>{page!.filters!.length} active</small></div> : null}
    <div className="filter-list">{(page?.filters ?? []).map((filter) => {
    const affected = dataTiles.filter((tile) => tile.filterBindings?.some((binding) => binding.filter === filter.id && binding.capability !== 'unsupported')).length;
    return <div key={filter.id}><span><Filter size={14} /></span><div><strong>{filter.label ?? humanize(filter.id)}</strong><small>{filter.type.replace(/_/g, ' ')} · affects {affected}/{dataTiles.length} data components</small></div><button type="button" className="filter-remove" onClick={() => onRemove(filter.id)} aria-label={`Remove ${filter.label ?? humanize(filter.id)} filter`} title="Remove filter"><X size={13} /></button></div>;
  })}</div>
    {available.length > 0 ? <><div className="panel-section-label"><span>Available from this page</span><small>No source selection needed</small></div><div className="filter-list">{available.map((candidate) => <button key={candidate.id} type="button" onClick={() => onAdd(candidate.id)}><span><Plus size={14} /></span><div><strong>Add {humanize(candidate.id)}</strong><small>{candidate.sourceNames.map(humanize).join(', ')} · affects {candidate.affectedTileCount} {candidate.affectedTileCount === 1 ? 'component' : 'components'}</small></div></button>)}</div></> : null}
    {!dataTiles.length ? <p className="panel-empty">Add a governed KPI, chart, or table first. Its supported filters will appear here automatically.</p> : available.length === 0 && !(page?.filters ?? []).length ? <p className="panel-empty">The data on this page does not expose filter fields yet.</p> : available.length === 0 ? <p className="panel-empty compact">All available page filters are already added.</p> : null}</>;
}

function TemplatesPanel({ current, onApply }: { current: StudioTemplate; onApply: (id: StudioTemplate) => void }): JSX.Element {
  return <><PanelTitle title="Templates" detail="Professional analytical structures" /><div className="template-list">{TEMPLATE_OPTIONS.map((item) => <button key={item.id} type="button" className={current === item.id ? 'on' : ''} onClick={() => onApply(item.id)}><span>{templateIcon(item.id)}</span><div><strong>{item.title}</strong><small>{item.description}</small></div></button>)}</div></>;
}

function BuildFrameInspector({ draft, prompt, previewRun, onPrompt, onAskAi, onSourcePolicy, onResolveTask, onApproveSemantic }: { draft: AppStudioBuildDraft; prompt: string; previewRun: DashboardRunResponse | null; onPrompt: (value: string) => void; onAskAi: () => void; onSourcePolicy: (value: AppStudioBuildDraft['sourcePolicy']) => void; onResolveTask: (task: AppStudioBuildDraft['reviewTasks'][number]) => void; onApproveSemantic: () => void }): JSX.Element {
  const openTasks = draft.reviewTasks.filter((task) => task.status === 'open');
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
    <section className="data-trust"><label>Data & trust</label><div><span className={`trust-dot ${tile.trustState ?? 'draft_ready'}`} /><strong>{humanize(tile.trustState ?? 'draft_ready')}</strong></div><p>{tile.block ? `Governed block: ${'blockId' in tile.block ? tile.block.blockId : tile.block.ref}` : tile.semantic ? `Semantic source: ${tile.semantic.id}` : 'Local narrative component'}</p>{run ? <small>{run.status === 'ok' ? `Settled on ${run.result?.rowCount ?? run.result?.rows.length ?? 0} rows` : run.error}</small> : null}</section>
    <button type="button" className="delete-component" onClick={onDelete}><Trash2 size={15} /> Remove component</button><small className="inspector-id">{pageId} / {tile.i}</small>
  </div>;
}

function StaticComponentPreview({ type }: { type: string }): JSX.Element {
  if (type === 'single_value' || type === 'kpi') return <div className="preview-kpi"><strong>—</strong><span>Run preview to load value</span></div>;
  if (type === 'table' || type === 'pivot') return <div className="preview-table">{[0, 1, 2, 3].map((row) => <i key={row}><span /><span /><span /></i>)}</div>;
  return <div className="preview-chart"><i style={{ height: '34%' }} /><i style={{ height: '58%' }} /><i style={{ height: '46%' }} /><i style={{ height: '78%' }} /><i style={{ height: '66%' }} /><i style={{ height: '92%' }} /></div>;
}

function StudioFilterControl({
  filter,
  value,
  onChange,
}: {
  filter: NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number];
  value: unknown;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const label = filter.label ?? humanize(filter.id);
  if (filter.type === 'daterange') {
    const range = value && typeof value === 'object' && !Array.isArray(value) ? value as { start?: string; end?: string } : {};
    return <label className="studio-filter range"><span>{label}</span><input type="date" aria-label={`${label} start`} value={range.start ?? ''} onChange={(event) => onChange({ ...range, start: event.target.value })} /><i>–</i><input type="date" aria-label={`${label} end`} value={range.end ?? ''} onChange={(event) => onChange({ ...range, end: event.target.value })} /></label>;
  }
  if (filter.type === 'boolean') {
    return <label className="studio-filter boolean"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
  }
  if ((filter.options ?? []).length > 0) {
    return <label className="studio-filter"><span>{label}</span><select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}><option value="">All</option>{filter.options!.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
  }
  return <label className="studio-filter"><span>{label}</span><input type={filter.type === 'number' ? 'number' : 'search'} value={String(value ?? '')} placeholder="All" onChange={(event) => onChange(filter.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} /></label>;
}

function StudioTilePreview({
  tile,
  run,
  themeMode,
}: {
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number];
  run?: DashboardRunResponse['tiles'][number];
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
  if (!run) return <StaticComponentPreview type={tile.viz.type} />;
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

function isPresentationOnlyOperation(operation: AppStudioDraftOperation): boolean {
  if (operation.type === 'set_layout') return true;
  if (operation.type !== 'update_tile') return false;
  const allowed = new Set(['title', 'viz', 'display', 'x', 'y', 'w', 'h', 'sectionId']);
  return Object.keys(operation.patch).every((key) => allowed.has(key));
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

function filterType(id: string): 'daterange' | 'number' | 'search' | 'select' {
  if (/date|time|month|week|quarter|year/i.test(id)) return 'daterange';
  if (/count|amount|limit|top_?n|score/i.test(id)) return 'number';
  if (/name|email|search|_id$/i.test(id)) return 'search';
  return 'select';
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
