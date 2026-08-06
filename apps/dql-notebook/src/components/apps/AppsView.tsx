import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AlertTriangle,
  BarChart3,
  Blocks,
  BookOpenText,
  Bot,
  CalendarDays,
  Hash,
  List,
  ToggleLeft,
  Type,
  Check,
  ChevronDown,
  Download,
  Eye,
  FileText,
  GitBranch,
  LayoutDashboard,
  LineChart,
  MapPin,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Share2,
  Table2,
  Trash2,
  User,
  Users,
  Wrench,
  Workflow,
} from 'lucide-react';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import {
  api,
  type AppBlockRecommendation,
  type AppDocumentSummary,
  type DashboardDocumentResponse,
  type DashboardRunResponse,
  type AppAiBuildSession,
  type GenerateAppResponse,
  type GeneratedAppPlan,
  type AppAskResponse,
  type LocalAppInvestigation,
} from '../../api/client';
import type { AppSummary, AppWorkspaceExperience, AppWorkspaceSection } from '../../store/types';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH } from '../agent/AiSidePanel';
import { usePersistedAgentThreadId } from '../agent/usePersistedAgentThreadId';
import { AppBuildProposalPanel, defaultProposalSelection, type AppBuildBriefEdits } from './AppBuildProposalPanel';
import { APP_STYLES } from './app-styles';
import { cleanStakeholderCopy, formatBusinessLabel, tidyTitle } from './app-text';
import { AiPinsPanel, DraftsPanel, EmptyPanel, NotebookListPanel, PanelCard, PanelHead, SettingsPanel, StatusSeal } from './AppSidePanels';
import { ResearchPanel } from './ResearchPanel';
import { formatVariableEntryValue, formatVariableValue } from './app-variables';
import type { AppAnalysisHandoff, AppResearchSeed, CreateInvestigationResult } from './app-research-types';
import {
  coerceDashboardFilterValue,
  DashboardFilterControls,
  defaultDashboardFilterValue,
  filterIconForDashboardFilter,
  shallowEqualRecords,
} from './app-dashboard-filters';
import { DashboardRenderer } from './DashboardRenderer';
import { PersonaSwitcher } from './PersonaSwitcher';
import { defaultParameterFilterValue, deriveDashboardFilters } from './dashboard-filters';
import { semanticApprovalState } from './app-semantic-approval';
import { authoredDomainOptions, resolveAuthoredDomainId, type AuthoredDomainOption } from '../domains/authored-domain-options';
import { useOperations } from '../../operations/OperationsProvider';

const UnifiedAgentRunPanel = lazy(() => import('../agent/UnifiedAgentRunPanel')
  .then((module) => ({ default: module.UnifiedAgentRunPanel })));
const StructuredAnswerText = lazy(() => import('../agent/AgentAnswerCard')
  .then((module) => ({ default: module.StructuredAnswerText })));

type AppSurface = 'library' | 'create' | 'workspace';
type AppExperience = AppWorkspaceExperience;
type BuilderMode = 'ai' | 'classic';
type AppBuildTarget = 'personal' | 'shared_project';
type AppSection = AppWorkspaceSection;
type LibraryFilter = 'all' | 'mine' | 'shared' | 'fav';
type DashboardFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type AppAskDecision = Extract<AppAskResponse, { ok: true }>['decision'];
type AppCopilotRoute = 'certified_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer';
type AppCopilotBlockTile = { blockId: string; title: string; viz: string; tileId: string };


interface AppPromptExample {
  title: string;
  domain: string;
  prompt: string;
}

interface AgentSkillCard {
  id: string;
  title: string;
  description: string;
}

const DEFAULT_PROMPT = 'Build an analytics app from my certified DQL blocks and available warehouse tables.';
const ACTIVE_APP_BUILD_STORAGE_KEY = 'dql.apps.active-ai-build.v1';

interface PersistedAppBuild {
  sessionId: string;
  operationId?: string;
  prompt: string;
  existingAppId?: string;
  createdAt: string;
}

function readPersistedAppBuild(): PersistedAppBuild | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_APP_BUILD_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedAppBuild>;
    return typeof value.sessionId === 'string' && typeof value.prompt === 'string' && typeof value.createdAt === 'string'
      ? value as PersistedAppBuild
      : null;
  } catch {
    return null;
  }
}

function persistAppBuild(value: PersistedAppBuild | null): void {
  try {
    if (value) window.localStorage.setItem(ACTIVE_APP_BUILD_STORAGE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(ACTIVE_APP_BUILD_STORAGE_KEY);
  } catch {
    // The server operation still completes when browser storage is unavailable.
  }
}

function createAppBuildSessionId(): string {
  const suffix = typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `app_build_${Date.now()}_${suffix}`;
}

const APP_PROMPT_EXAMPLES: AppPromptExample[] = [
  {
    title: 'Revenue story',
    domain: 'Revenue',
    prompt: 'Build a weekly revenue health app for the COO with risk flags.',
  },
  {
    title: 'Customer 360',
    domain: 'Customer',
    prompt: 'Customer 360: value, engagement, retention, orders, and service risk by segment.',
  },
  {
    title: 'Quality monitor',
    domain: 'Platform',
    prompt: 'Build a data quality monitor with freshness, failing tests, null rates, and model risk notes.',
  },
  {
    title: 'Experiment Readout',
    domain: 'Product',
    prompt: 'Create an experiment readout for product leadership with outcome, guardrails, and decision checklist.',
  },
];

const AGENT_SKILLS: AgentSkillCard[] = [
  {
    id: 'match',
    title: 'Find blocks',
    description: 'Search certified blocks, terms, views, and lineage.',
  },
  {
    id: 'story',
    title: 'Shape story',
    description: 'Order the app around the business decision.',
  },
  {
    id: 'draft',
    title: 'Draft gaps',
    description: 'Keep missing sections visible as draft work instead of hiding them.',
  },
];

const FILTER_LABELS: Record<LibraryFilter, string> = {
  all: 'All',
  mine: 'Mine',
  shared: 'Shared',
  fav: 'Favourites',
};

function normalizeAppTheme(themeMode: string): 'obsidian' | 'paper' | 'white' {
  if (themeMode === 'obsidian' || themeMode === 'dark' || themeMode === 'midnight') return 'obsidian';
  if (themeMode === 'white' || themeMode === 'arctic') return 'white';
  return 'paper';
}

export function AppsView(): JSX.Element {
  const state = useNotebookStore(useShallow((store) => ({
    activeAppExperience: store.activeAppExperience,
    activeAppId: store.activeAppId,
    activeAppSection: store.activeAppSection,
    activeDashboardId: store.activeDashboardId,
    apps: store.apps,
    appsLoading: store.appsLoading,
    authoredDomains: store.authoredDomains,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const { operations, track: trackOperation } = useOperations();
  const appTheme = useMemo(() => normalizeAppTheme(state.themeMode), [state.themeMode]);
  const [surface, setSurface] = useState<AppSurface>(() => state.activeAppId ? 'workspace' : 'library');
  const experience = state.activeAppExperience;
  const section = state.activeAppSection;
  const setExperience = (nextExperience: AppExperience) => {
    dispatch({ type: 'SET_APP_WORKSPACE_STATE', experience: nextExperience });
  };
  const setSection = (nextSection: AppSection) => {
    dispatch({ type: 'SET_APP_WORKSPACE_STATE', section: nextSection });
  };
  const [search, setSearch] = useState('');
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [appDoc, setAppDoc] = useState<AppDocumentSummary | null>(null);
  const [dashboardDoc, setDashboardDoc] = useState<DashboardDocumentResponse | null>(null);
  const [appLoading, setAppLoading] = useState(false);
  const [builderMode, setBuilderMode] = useState<BuilderMode>('ai');
  const [builderTarget, setBuilderTarget] = useState<AppBuildTarget>('shared_project');
  const [builderExploreGaps, setBuilderExploreGaps] = useState(false);
  const [builderPrompt, setBuilderPrompt] = useState(DEFAULT_PROMPT);
  const [builderName, setBuilderName] = useState('');
  // Once the author types a name or audience, the planner stops overwriting it.
  const builderNameTouchedRef = useRef(false);
  const [builderDomain, setBuilderDomain] = useState('');
  const builderDomainOptions = useMemo(() => authoredDomainOptions(state.authoredDomains), [state.authoredDomains]);
  const [builderOwner, setBuilderOwner] = useState('analytics');
  const [builderAudience, setBuilderAudience] = useState('stakeholders');
  const builderAudienceTouchedRef = useRef(false);
  const [builderExistingAppId, setBuilderExistingAppId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedBlocks, setSelectedBlocks] = useState<Set<string>>(() => new Set());
  const [generated, setGenerated] = useState<GenerateAppResponse | null>(null);
  const [buildSession, setBuildSession] = useState<AppAiBuildSession | null>(null);
  const initialPersistedBuildRef = useRef<PersistedAppBuild | null>(readPersistedAppBuild());
  const [durableBuildSessionId, setDurableBuildSessionId] = useState<string | null>(initialPersistedBuildRef.current?.sessionId ?? null);
  const [buildOperationId, setBuildOperationId] = useState<string | null>(initialPersistedBuildRef.current?.operationId ?? null);
  const loadedBuildSessionRef = useRef<string | null>(null);
  const [proposalSelection, setProposalSelection] = useState<Set<string>>(new Set());
  const [proposalEdits, setProposalEdits] = useState<Record<string, { title?: string; viz?: string }>>({});
  const [committing, setCommitting] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [builderSaving, setBuilderSaving] = useState(false);
  const [addPageOpen, setAddPageOpen] = useState(false);
  const [addPageTitle, setAddPageTitle] = useState('');
  const [addPageExploreGaps, setAddPageExploreGaps] = useState(false);
  const [addPageError, setAddPageError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AppSummary | null>(null);
  const [deletingApp, setDeletingApp] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [dashboardFilterValues, setDashboardFilterValues] = useState<Record<string, unknown>>({});
  const [appliedDashboardFilterValues, setAppliedDashboardFilterValues] = useState<Record<string, unknown>>({});
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainExpanded, setExplainExpanded] = useState(false);
  const handleExplainChange = useCallback((open: boolean) => {
    setExplainOpen(open);
    if (!open) setExplainExpanded(false);
  }, []);
  // Redesigned build flow: a nonce bumped by startAiBuilder auto-runs the
  // proposal once the create surface mounts (library send → building stream).
  const [autoBuildNonce, setAutoBuildNonce] = useState(0);
  const autoBuildRanRef = useRef(0);
  const appsQuery = useQuery({
    queryKey: ['apps'],
    queryFn: () => api.listAppsStrict(),
    staleTime: 30_000,
  });
  const personaQuery = useQuery({
    queryKey: ['persona'],
    queryFn: () => api.getPersona(),
    staleTime: 60_000,
  });

  useEffect(() => {
    dispatch({ type: 'SET_APPS_LOADING', loading: appsQuery.isLoading });
    if (appsQuery.data) dispatch({ type: 'SET_APPS', apps: appsQuery.data });
  }, [appsQuery.data, appsQuery.isLoading, dispatch]);

  useEffect(() => {
    if (personaQuery.data) dispatch({ type: 'SET_ACTIVE_PERSONA', persona: personaQuery.data });
  }, [dispatch, personaQuery.data]);

  const applyRecoveredBuildSession = useCallback((session: AppAiBuildSession) => {
    setBuildSession(session);
    setSurface('create');
    setBuilderMode('ai');
    setBuilderPrompt(session.prompt || DEFAULT_PROMPT);
    setBuilderExistingAppId(session.inputs.existingAppId ?? null);
    setBuilderDomain(resolveAuthoredDomainId(session.inputs.domain, state.authoredDomains));
    setBuilderOwner(session.inputs.owner ?? 'analytics');
    setBuilderAudience(session.inputs.audience ?? 'stakeholders');
    setBuilderTarget(session.inputs.mode === 'personal' ? 'personal' : 'shared_project');
    setBuilderExploreGaps(session.inputs.mode === 'personal' && session.inputs.exploreGaps === true);
    if (session.status === 'building') {
      setBuilderSaving(true);
      return;
    }
    setBuilderSaving(false);
    if (session.status === 'error') {
      setBuilderError(session.error ?? 'The App proposal did not complete.');
      return;
    }
    setBuilderError(null);
    setProposalSelection(session.proposal ? defaultProposalSelection(session.proposal) : new Set());
    // This runs on every build-status transition, so seeding must not clobber
    // what the author has typed. Previously a name or tile title entered during
    // the build was silently reverted to the planner's own wording.
    setProposalEdits((current) => Object.fromEntries((session.proposal?.tiles ?? []).map((tile) => [
      tile.id,
      current[tile.id] ?? { title: tile.title, viz: tile.viz },
    ])));
    const plan = session.plan as GeneratedAppPlan | undefined;
    const planName = session.inputs.existingAppId ? plan?.pages[0]?.title : plan?.name;
    if (planName) setBuilderName((current) => (builderNameTouchedRef.current ? current : planName));
    if (plan?.audience) setBuilderAudience((current) => (builderAudienceTouchedRef.current ? current : plan.audience!));
  }, [state.authoredDomains]);

  const activeBuildOperation = useMemo(() => {
    if (!durableBuildSessionId) return null;
    return operations.find((operation) => operation.id === buildOperationId)
      ?? operations.find((operation) => operation.type === 'app_ai_build' && operation.scope === `app-build:${durableBuildSessionId}`)
      ?? null;
  }, [buildOperationId, durableBuildSessionId, operations]);

  useEffect(() => {
    const persisted = initialPersistedBuildRef.current;
    if (!persisted) return;
    initialPersistedBuildRef.current = null;
    setBuilderPrompt(persisted.prompt);
    setBuilderExistingAppId(persisted.existingAppId ?? null);
    setBuilderMode('ai');
    setBuilderSaving(true);
    setSurface('create');
  }, []);

  useEffect(() => {
    if (!durableBuildSessionId) return;
    if (activeBuildOperation?.id && activeBuildOperation.id !== buildOperationId) {
      setBuildOperationId(activeBuildOperation.id);
      const current = readPersistedAppBuild();
      if (current?.sessionId === durableBuildSessionId) persistAppBuild({ ...current, operationId: activeBuildOperation.id });
    }
    if (activeBuildOperation && (activeBuildOperation.status === 'queued' || activeBuildOperation.status === 'running')) {
      setBuilderSaving(true);
      setSurface('create');
    }

    let cancelled = false;
    let timer: number | undefined;
    const recover = async () => {
      const session = await api.getAppAiBuild(durableBuildSessionId);
      if (cancelled) return;
      if (!session || session.status === 'building') {
        if (session) applyRecoveredBuildSession(session);
        if (activeBuildOperation && ['failed', 'cancelled', 'interrupted'].includes(activeBuildOperation.status)) {
          setBuilderSaving(false);
          setBuilderError(activeBuildOperation.error?.message ?? (
            activeBuildOperation.status === 'cancelled'
              ? 'The App proposal was cancelled.'
              : 'The App proposal did not complete.'
          ));
          return;
        }
        timer = window.setTimeout(() => { void recover(); }, 900);
        return;
      }
      if (loadedBuildSessionRef.current === session.id && buildSession?.status === session.status) return;
      loadedBuildSessionRef.current = session.id;
      applyRecoveredBuildSession(session);
    };
    void recover();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeBuildOperation, applyRecoveredBuildSession, buildOperationId, buildSession?.status, durableBuildSessionId]);

  useEffect(() => {
    if (surface !== 'create') return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCatalogLoading(true);
      void api.recommendAppBlocks({
        domain: builderDomain || undefined,
        purpose: builderPrompt,
        audience: 'stakeholder',
        certifiedOnly: true,
      }, controller.signal).then((blocks) => {
        if (!controller.signal.aborted) setCatalog(blocks);
      }).catch(() => undefined).finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [surface, builderMode, builderDomain, builderPrompt]);

  useEffect(() => {
    if (!state.activeAppId || surface !== 'workspace') {
      setAppDoc(null);
      setDashboardDoc(null);
      return;
    }
    let cancelled = false;
    setAppLoading(true);
    const appRequest = api.getApp(state.activeAppId).then((doc) => {
      if (!cancelled) setAppDoc(doc);
    });
    const dashboardRequest = state.activeDashboardId
      ? api.getDashboard(state.activeAppId, state.activeDashboardId).then((doc) => {
          if (!cancelled) setDashboardDoc(doc);
        })
      : Promise.resolve().then(() => { if (!cancelled) setDashboardDoc(null); });
    void Promise.allSettled([appRequest, dashboardRequest]).finally(() => {
      if (!cancelled) setAppLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [state.activeAppId, state.activeDashboardId, surface]);

  const dashboardFilterKey = useMemo(
    () => JSON.stringify(deriveDashboardFilters(dashboardDoc?.dashboard ?? null)),
    [dashboardDoc?.dashboard],
  );
  const dashboardFilters = useMemo(
    () => deriveDashboardFilters(dashboardDoc?.dashboard ?? null),
    [dashboardDoc?.dashboard, dashboardFilterKey],
  );

  useEffect(() => {
    const filters = dashboardFilters;
    setDashboardFilterValues((current) => {
      const next: Record<string, unknown> = {};
      for (const filter of filters) {
        next[filter.id] = current[filter.id] ?? defaultDashboardFilterValue(filter);
      }
      return shallowEqualRecords(current, next) ? current : next;
    });
    setAppliedDashboardFilterValues((current) => {
      const next: Record<string, unknown> = {};
      for (const filter of filters) next[filter.id] = current[filter.id] ?? defaultDashboardFilterValue(filter);
      return shallowEqualRecords(current, next) ? current : next;
    });
  }, [dashboardDoc?.dashboard.id, dashboardFilterKey, dashboardFilters]);

  const refreshApps = async (
    openAppId?: string | null,
    dashboardId?: string | null,
    nextSurface?: AppSurface,
    workspaceState?: { experience?: AppExperience; section?: AppSection },
  ) => {
    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    const apps = await api.listApps();
    dispatch({ type: 'SET_APPS', apps });
    dispatch({ type: 'SET_APPS_LOADING', loading: false });
    if (openAppId) dispatch({ type: 'OPEN_APP', appId: openAppId, dashboardId, ...workspaceState });
    if (nextSurface) setSurface(nextSurface);
  };

  const filteredApps = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return state.apps.filter((app) => {
      if (libraryFilter === 'mine' && (app.storage ?? 'shared') !== 'mine') return false;
      if (libraryFilter === 'shared' && (app.storage ?? 'shared') !== 'shared') return false;
      if (libraryFilter === 'fav' && !favorites.has(app.id)) return false;
      if (!needle) return true;
      const haystack = [
        app.name,
        app.description ?? '',
        app.domain,
        app.audience ?? '',
        app.lifecycle ?? '',
        ...(app.tags ?? []),
        ...(app.owners ?? []),
        ...app.dashboards.map((dashboard) => dashboard.title),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [favorites, libraryFilter, search, state.apps]);

  const activeApp = useMemo(
    () => state.apps.find((app) => app.id === state.activeAppId) ?? null,
    [state.apps, state.activeAppId],
  );
  const handleInvestigationsChanged = useCallback((investigations: LocalAppInvestigation[]) => {
    setAppDoc((current) => {
      if (!current) return current;
      return {
        ...current,
        investigations,
      };
    });
  }, []);

  const openApp = (app: AppSummary, nextExperience: AppExperience = 'view') => {
    dispatch({ type: 'OPEN_APP', appId: app.id, experience: nextExperience, section: 'dashboards' });
    setSurface('workspace');
  };

  const startAiBuilder = (
    prompt = builderPrompt,
    domain?: string,
    target: AppBuildTarget = builderTarget,
    exploreGaps = false,
  ) => {
    persistAppBuild(null);
    setDurableBuildSessionId(null);
    setBuildOperationId(null);
    setBuilderExistingAppId(null);
    setBuilderMode('ai');
    setBuilderTarget(target);
    setBuilderExploreGaps(target === 'personal' && exploreGaps);
    setBuilderPrompt(prompt);
    setBuilderDomain(resolveAuthoredDomainId(domain, state.authoredDomains));
    setSelectedBlocks(new Set());
    setBuilderError(null);
    setGenerated(null);
    setBuildSession(null);
    setProposalEdits({});
    setSurface('create');
    // Redesigned flow: the library composer send goes straight into the
    // building stream (orb + shimmer) and auto-advances to the proposal.
    setAutoBuildNonce((nonce) => nonce + 1);
  };

  const startClassicBuilder = () => {
    persistAppBuild(null);
    setDurableBuildSessionId(null);
    setBuildOperationId(null);
    setBuilderExistingAppId(null);
    setBuilderMode('classic');
    setBuilderError(null);
    setGenerated(null);
    setBuildSession(null);
    setProposalEdits({});
    setSurface('create');
  };

  const toggleSelectedBlock = (blockId: string) => {
    setSelectedBlocks((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  };

  const runGenerate = async (extraBlockIds?: string[]) => {
    // Guard: callers may pass a click event; only real id arrays count.
    const extras = Array.isArray(extraBlockIds) ? extraBlockIds.filter((id) => typeof id === 'string') : [];
    const prompt = builderPrompt.trim();
    if (!prompt) {
      setBuilderError('Describe the app you want to build.');
      return;
    }
    setBuilderSaving(true);
    setBuilderError(null);
    const preferredBlockIds = builderMode === 'classic'
      ? Array.from(selectedBlocks)
      : Array.from(new Set([
          ...Array.from(selectedBlocks),
          ...extras,
        ]));
    // Two-phase build: propose first (no files) — the user reviews the content
    // list with per-tile toggles and confirms before anything is created. The
    // client owns the session id before the request starts, so route changes can
    // reconnect even during the server-acceptance window.
    const sessionId = createAppBuildSessionId();
    const persisted: PersistedAppBuild = {
      sessionId,
      prompt,
      ...(builderExistingAppId ? { existingAppId: builderExistingAppId } : {}),
      createdAt: new Date().toISOString(),
    };
    persistAppBuild(persisted);
    setDurableBuildSessionId(sessionId);
    setBuildOperationId(null);
    loadedBuildSessionRef.current = null;
    setBuildSession(null);
    setGenerated(null);
    try {
      const accepted = await api.proposeAppAiBuildInBackground({
        sessionId,
        prompt,
        existingAppId: builderExistingAppId ?? undefined,
        domain: builderDomain.trim() || undefined,
        owner: builderOwner.trim() || undefined,
        force: false,
        selectedBlockIds: preferredBlockIds,
        plannerMode: 'ai_assisted',
        mode: builderTarget === 'personal' ? 'personal' : 'stakeholder',
        exploreGaps: builderTarget === 'personal' && builderExploreGaps,
      });
      trackOperation(accepted.operation);
      setBuildOperationId(accepted.operation.id);
      persistAppBuild({ ...persisted, operationId: accepted.operation.id });
    } catch (error) {
      setBuilderSaving(false);
      setBuilderError(error instanceof Error ? error.message : String(error));
      persistAppBuild(null);
      setDurableBuildSessionId(null);
      setBuildOperationId(null);
    }
  };

  // Auto-run the proposal after startAiBuilder lands on the create surface.
  // Ref-guarded so React StrictMode double-effects don't propose twice.
  useEffect(() => {
    if (surface !== 'create' || builderMode !== 'ai') return;
    if (autoBuildNonce === 0 || autoBuildRanRef.current === autoBuildNonce) return;
    autoBuildRanRef.current = autoBuildNonce;
    void runGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, builderMode, autoBuildNonce]);

  // "Add more blocks" in the proposal: adding a certified catalog block
  // re-proposes the build with that block pinned, so the new tile arrives
  // through the same governed propose flow (no client-side tile fabrication).
  const addBlockToProposal = (blockId: string) => {
    setSelectedBlocks((current) => {
      const next = new Set(current);
      next.add(blockId);
      return next;
    });
    void runGenerate([blockId]);
  };

  const toggleProposalTile = (tileId: string) => {
    setProposalSelection((current) => {
      const next = new Set(current);
      if (next.has(tileId)) next.delete(tileId);
      else next.add(tileId);
      return next;
    });
  };

  /**
   * Rename the App, or the page currently open inside it.
   *
   * Renaming had no writer at all after creation: `dql.app.json` was written
   * only by create and publish, and the dashboard layout PATCH cannot reach
   * `metadata.title`.
   */
  const runRenameApp = async (name: string, dashboardId?: string) => {
    const appId = state.activeAppId;
    if (!appId || !name.trim()) return;
    const result = await api.renameApp(appId, dashboardId ? { pageTitle: name.trim(), dashboardId } : { name: name.trim() });
    if (!result.ok) {
      setBuilderError(result.error);
      return;
    }
    await refreshApps(appId, dashboardId ?? state.activeDashboardId ?? undefined, 'workspace');
  };

  const runCommitProposal = async (edits?: AppBuildBriefEdits) => {
    if (!buildSession || buildSession.status !== 'proposed') return;
    setCommitting(true);
    setBuilderError(null);
    // Edits made in the shared Build Brief win over the surface's own fields:
    // they are the ones the author was looking at when they pressed Build.
    const name = (edits?.appName ?? edits?.pageTitle ?? builderName).trim();
    const result = await api.commitAppAiBuild(buildSession.id, {
      selectedTileIds: Array.from(proposalSelection),
      expectedProposalHash: buildSession.proposalHash,
      ...(builderExistingAppId
        ? { pageTitle: name || undefined }
        : { appName: name || undefined }),
      audience: (edits?.audience ?? builderAudience).trim() || undefined,
      tileOverrides: { ...proposalEdits, ...(edits?.tileOverrides ?? {}) },
    });
    setCommitting(false);
    if (!result.ok) {
      setBuilderError(result.error);
      return;
    }
    const session = result.session;
    setBuildSession(session);
    persistAppBuild(null);
    setDurableBuildSessionId(null);
    setBuildOperationId(null);
    const response: GenerateAppResponse = {
      ok: true,
      plan: session.plan as GeneratedAppPlan,
      validation: session.validation as GenerateAppResponse['validation'],
      generated: { paths: session.generatedPaths },
      app: result.app,
      dashboardId: result.dashboardId,
    };
    setGenerated(response);
    setExplainOpen(true);
    // You just authored this App, so land in the mode where you can adjust it.
    // Landing in read-only `view` hid the toolbar, the save status, and every
    // tile's edit chrome, which read as "there is no way to edit or save".
    await refreshApps(result.app?.id ?? response.plan.appId, result.dashboardId, 'workspace', { experience: 'build', section: 'dashboards' });
  };

  const runClassicCreate = async () => {
    if (!builderName.trim()) {
      setBuilderError('Name the app before creating it.');
      return;
    }
    if (!builderDomain.trim()) {
      setBuilderError('Choose a domain before creating the app.');
      return;
    }
    setBuilderSaving(true);
    setBuilderError(null);
    try {
      const result = await api.createApp({
        name: builderName.trim(),
        domain: builderDomain.trim(),
        dashboardTitle: 'Overview',
        purpose: builderPrompt.trim(),
        audience: 'stakeholder',
        visibility: 'shared',
        lifecycle: 'draft',
        tags: ['app-builder', builderDomain.trim().toLowerCase()],
        owners: [builderOwner.trim() || 'owner@local'],
        selectedBlockIds: Array.from(selectedBlocks),
      });
      await refreshApps(result.app.id, result.dashboardId, 'workspace', { experience: 'build', section: 'dashboards' });
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilderSaving(false);
    }
  };

  const openGeneratedWorkspace = () => {
    const appId = generated?.app?.id ?? generated?.plan.appId;
    if (!appId) return;
    dispatch({ type: 'OPEN_APP', appId, dashboardId: generated?.dashboardId ?? undefined, experience: 'build', section: 'dashboards' });
    setSurface('workspace');
  };

  const startDashboardPageBuilder = () => {
    if (!state.activeAppId || !appDoc) return;
    const request = addPageTitle.trim();
    if (!request) {
      setAddPageError('Describe the business question this page should answer.');
      return;
    }
    setAddPageError(null);
    persistAppBuild(null);
    setDurableBuildSessionId(null);
    setBuildOperationId(null);
    setBuilderExistingAppId(state.activeAppId);
    setBuilderMode('ai');
    setBuilderPrompt(request);
    setBuilderName('New App page');
    setBuilderDomain(resolveAuthoredDomainId(appDoc.app.domain, state.authoredDomains));
    setBuilderOwner(appDoc.app.owners[0] ?? 'analytics');
    setBuilderAudience(appDoc.app.audience ?? 'stakeholders');
    const target = appDoc.app.publicationIntent
      ?? (appDoc.app.visibility === 'private' ? 'personal' : 'shared_project');
    setBuilderTarget(target);
    setBuilderExploreGaps(target === 'personal' && addPageExploreGaps);
    setSelectedBlocks(new Set());
    setBuilderError(null);
    setGenerated(null);
    setBuildSession(null);
    setProposalEdits({});
    setAddPageOpen(false);
    setAddPageTitle('');
    setAddPageExploreGaps(false);
    setSurface('create');
    setAutoBuildNonce((nonce) => nonce + 1);
  };

  const dashboardVariables = useMemo(() => ({ ...appliedDashboardFilterValues }), [appliedDashboardFilterValues]);

  const handleDashboardFilterChange = useCallback((filter: DashboardFilter, value: unknown) => {
    setDashboardFilterValues((current) => ({
      ...current,
      [filter.id]: coerceDashboardFilterValue(filter, value),
    }));
  }, []);
  const applyDashboardFilters = useCallback(() => {
    setAppliedDashboardFilterValues({ ...dashboardFilterValues });
  }, [dashboardFilterValues]);
  const resetDashboardFilters = useCallback(() => {
    const defaults = Object.fromEntries(dashboardFilters.map((filter) => [filter.id, defaultDashboardFilterValue(filter)]));
    setDashboardFilterValues(defaults);
    setAppliedDashboardFilterValues(defaults);
  }, [dashboardFilters]);

  const confirmDeleteApp = async () => {
    if (!deleteTarget || deletingApp) return;
    setDeletingApp(true);
    setDeleteError(null);
    try {
      await api.deleteApp(deleteTarget.id);
      setFavorites((current) => {
        const next = new Set(current);
        next.delete(deleteTarget.id);
        return next;
      });
      dispatch({ type: 'SET_APPS', apps: state.apps.filter((app) => app.id !== deleteTarget.id) });
      if (state.activeAppId === deleteTarget.id) dispatch({ type: 'CLOSE_APP' });
      setDeleteTarget(null);
      setSurface('library');
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingApp(false);
    }
  };

  return (
    <div className={`dql-apps-waterline dql-apps-theme-${appTheme}`}>
      <style>{APP_STYLES}</style>
      {surface === 'library' ? (
        <AppLibrarySurface
          apps={filteredApps}
          allApps={state.apps}
          loading={state.appsLoading}
          search={search}
          filter={libraryFilter}
          favorites={favorites}
          onSearch={setSearch}
          onFilter={setLibraryFilter}
          onToggleFavorite={(appId) => {
            setFavorites((current) => {
              const next = new Set(current);
              if (next.has(appId)) next.delete(appId);
              else next.add(appId);
              return next;
            });
          }}
          onStartAi={(prompt, target, exploreGaps) => startAiBuilder(prompt, undefined, target, exploreGaps)}
          onStartClassic={startClassicBuilder}
          onOpenApp={openApp}
          onDeleteApp={(app) => {
            setDeleteError(null);
            setDeleteTarget(app);
          }}
        />
      ) : surface === 'create' ? (
        <AppCreateSurface
          mode={builderMode}
          existingAppId={builderExistingAppId}
          appName={builderName}
          prompt={builderPrompt}
          domain={builderDomain}
          domainOptions={builderDomainOptions}
          owner={builderOwner}
          audience={builderAudience}
          promptExamples={APP_PROMPT_EXAMPLES}
          catalog={catalog}
          catalogLoading={catalogLoading}
          selectedBlocks={selectedBlocks}
          generated={generated}
          buildSession={buildSession}
          proposalSelection={proposalSelection}
          proposalEdits={proposalEdits}
          committing={committing}
          themeMode={state.themeMode}
          onToggleProposalTile={toggleProposalTile}
          onProposalEdit={(tileId, edit) => setProposalEdits((current) => ({
            ...current,
            [tileId]: { ...current[tileId], ...edit },
          }))}
          onCommitProposal={(edits) => void runCommitProposal(edits)}
          onAddBlock={addBlockToProposal}
          saving={builderSaving}
          error={builderError}
          onBack={() => setSurface(builderExistingAppId ? 'workspace' : 'library')}
          onModeChange={(nextMode) => {
            setBuilderMode(nextMode);
            if (nextMode === 'ai') setSelectedBlocks(new Set());
          }}
          onAppNameChange={(value) => { builderNameTouchedRef.current = true; setBuilderName(value); }}
          onPromptChange={setBuilderPrompt}
          onDomainChange={setBuilderDomain}
          onOwnerChange={setBuilderOwner}
          onAudienceChange={(value) => { builderAudienceTouchedRef.current = true; setBuilderAudience(value); }}
          onToggleBlock={toggleSelectedBlock}
          onBuild={() => builderMode === 'ai' ? void runGenerate() : void runClassicCreate()}
          onOpenGenerated={openGeneratedWorkspace}
        />
      ) : (
        <AppWorkspaceSurface
          app={activeApp}
          appDoc={appDoc}
          dashboardDoc={dashboardDoc}
          loading={appLoading}
          experience={experience}
          section={section}
          explainOpen={explainOpen}
          explainExpanded={explainExpanded}
          dashboardFilters={dashboardFilters}
          dashboardFilterValues={dashboardFilterValues}
          themeMode={state.themeMode}
          variables={dashboardVariables}
          onBack={() => setSurface('library')}
          onExperienceChange={setExperience}
          onSectionChange={setSection}
          onDashboardFilterChange={handleDashboardFilterChange}
          onApplyDashboardFilters={applyDashboardFilters}
          onResetDashboardFilters={resetDashboardFilters}
          onExplainChange={handleExplainChange}
          onExplainExpandedChange={setExplainExpanded}
          onAddPage={() => {
            setAddPageExploreGaps(false);
            setAddPageOpen(true);
          }}
          onOpenDashboard={(dashboardId) => dispatch({ type: 'OPEN_DASHBOARD', dashboardId })}
          onOpenApp={(appId, dashboardId) => {
            // Opening from "added to App" must show what was just added; a
            // review-required pin is filtered out of the read-only view.
            void refreshApps(appId, dashboardId, 'workspace', { experience: 'build', section: 'dashboards' });
          }}
          onRenameApp={(next, dashboardId) => void runRenameApp(next, dashboardId)}
          onDashboardChanged={(dashboard) => {
            setDashboardDoc((current) => current ? { ...current, dashboard } : current);
            void refreshApps(state.activeAppId, dashboard.id, 'workspace');
          }}
          onInvestigationsChanged={handleInvestigationsChanged}
          onOpenLineageNode={(nodeId) => {
            dispatch({
              type: 'OPEN_LINEAGE_DETAIL',
              nodeId,
              returnTo: state.activeAppId
                ? {
                    view: 'apps',
                    appId: state.activeAppId,
                    dashboardId: state.activeDashboardId,
                    label: activeApp?.name,
                    experience,
                    section,
                  }
                : null,
            });
          }}
        />
      )}
      {addPageOpen && (
        <AddPageDialog
          title={addPageTitle}
          allowExploration={appDoc?.app.publicationIntent === 'personal'
            || (!appDoc?.app.publicationIntent && appDoc?.app.visibility === 'private')}
          exploreGaps={addPageExploreGaps}
          error={addPageError}
          onChange={setAddPageTitle}
          onExploreGapsChange={setAddPageExploreGaps}
          onCancel={() => {
            setAddPageOpen(false);
            setAddPageExploreGaps(false);
            setAddPageError(null);
          }}
          onCreate={startDashboardPageBuilder}
        />
      )}
      {deleteTarget && (
        <DeleteAppDialog
          app={deleteTarget}
          deleting={deletingApp}
          error={deleteError}
          onCancel={() => {
            if (deletingApp) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={() => void confirmDeleteApp()}
        />
      )}
    </div>
  );
}

function AppLibrarySurface({
  apps,
  allApps,
  loading,
  search,
  filter,
  favorites,
  onSearch,
  onFilter,
  onToggleFavorite,
  onStartAi,
  onStartClassic,
  onOpenApp,
  onDeleteApp,
}: {
  apps: AppSummary[];
  allApps: AppSummary[];
  loading: boolean;
  search: string;
  filter: LibraryFilter;
  favorites: Set<string>;
  onSearch: (value: string) => void;
  onFilter: (value: LibraryFilter) => void;
  onToggleFavorite: (appId: string) => void;
  onStartAi: (prompt: string, target: AppBuildTarget, exploreGaps: boolean) => void;
  onStartClassic: () => void;
  onOpenApp: (app: AppSummary, experience?: AppExperience) => void;
  onDeleteApp: (app: AppSummary) => void;
}) {
  const counts = libraryCounts(allApps, favorites);
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_PROMPT);
  const [draftTarget, setDraftTarget] = useState<AppBuildTarget>('shared_project');
  const [exploreGaps, setExploreGaps] = useState(false);
  const submitPrompt = () => {
    const trimmed = draftPrompt.trim();
    if (!trimmed) return;
    onStartAi(trimmed, draftTarget, draftTarget === 'personal' && exploreGaps);
  };
  return (
    <main className="dql-apps-wrap">
      <section className="dql-apps-createhead">
        <h1>Build an app</h1>
        <p>Choose the destination, describe the business goal, and review the Build Brief before DQL writes an App draft.</p>
      </section>

      <section className="dql-apps-composer" aria-label="Build an app with AI">
        <div className="dql-apps-targets" aria-label="App draft target">
          <button type="button" className={draftTarget === 'shared_project' ? 'on' : ''} onClick={() => { setDraftTarget('shared_project'); setExploreGaps(false); }}>
            <Users size={12} /> Shared Project
            <small>Draft privately, then publish when governed</small>
          </button>
          <button type="button" className={draftTarget === 'personal' ? 'on' : ''} onClick={() => setDraftTarget('personal')}>
            <User size={12} /> Personal Draft
            <small>Explore privately with review-required analysis</small>
          </button>
        </div>
        <textarea
          value={draftPrompt}
          onChange={(event) => setDraftPrompt(event.target.value)}
          rows={2}
          aria-label="App build request"
          placeholder="Build an EMEA revenue app for the CFO…"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submitPrompt();
            }
          }}
        />
        <div className="dql-apps-composer-row">
          <span className="dql-apps-composer-chip"><ShieldCheck size={11} /> Certified + semantic sources</span>
          {draftTarget === 'personal' ? (
            <label className="dql-apps-explore-toggle">
              <input type="checkbox" checked={exploreGaps} onChange={(event) => setExploreGaps(event.target.checked)} />
              Explore uncovered gaps
            </label>
          ) : null}
          <i />
          <button type="button" className="dql-apps-composer-blank" onClick={onStartClassic}>
            <LayoutDashboard size={12} /> Create blank
          </button>
          <button type="button" className="dql-apps-composer-send" onClick={submitPrompt} disabled={!draftPrompt.trim()} title="Build">
            <ArrowUp size={15} strokeWidth={2} />
          </button>
        </div>
      </section>
      <div className="dql-apps-try">
        <span>Try:</span>
        {APP_PROMPT_EXAMPLES.slice(0, 3).map((item) => (
          <button key={item.title} type="button" onClick={() => setDraftPrompt(item.prompt)}>
            {item.title}
          </button>
        ))}
      </div>

      <div className="dql-apps-sectionhead">
        <span>App library</span>
        <i />
        <b>{allApps.length} app{allApps.length === 1 ? '' : 's'}</b>
      </div>

      <div className="dql-apps-libbar">
        <div className="dql-apps-filter-tabs">
          {(['all', 'mine', 'shared', 'fav'] as LibraryFilter[]).map((value) => (
            <button key={value} className={filter === value ? 'on' : ''} onClick={() => onFilter(value)}>
              {FILTER_LABELS[value]} <span>{counts[value]}</span>
            </button>
          ))}
        </div>
        <label className="dql-apps-search">
          <Search size={15} strokeWidth={2} aria-hidden="true" />
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search apps, domains, owners..." />
        </label>
      </div>

      {loading && allApps.length === 0 ? (
        <EmptyPanel title="Loading Apps..." detail="Reading local app files from this DQL project." />
      ) : apps.length === 0 ? (
        <EmptyPanel title="No Apps match this view." detail="Change the filter or start a new App above." />
      ) : (
        <div className="dql-apps-grid">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              favorite={favorites.has(app.id)}
              onToggleFavorite={() => onToggleFavorite(app.id)}
              onOpen={() => onOpenApp(app, 'view')}
              onEdit={() => onOpenApp(app, 'build')}
              onDelete={() => onDeleteApp(app)}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function AppCard({
  app,
  favorite,
  onToggleFavorite,
  onOpen,
  onEdit,
  onDelete,
}: {
  app: AppSummary;
  favorite: boolean;
  onToggleFavorite: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const certified = app.certification === 'certified' || app.lifecycle === 'certified';
  const draftCount = app.drafts?.length ?? 0;
  const researchCount = app.investigations ?? 0;
  const aiPinCount = app.aiPins ?? 0;
  const trustLabel = certified ? 'Certified app' : draftCount > 0 || researchCount > 0 || aiPinCount > 0 ? 'Review needed' : 'Draft app';
  return (
    <article className="dql-app-card">
      <div className="dql-app-card-body" onClick={onOpen} role="button" tabIndex={0}>
        <div className="dql-app-card-top">
          <span className="dql-app-eyebrow">{app.domain || 'Domain'}</span>
          <button
            type="button"
            className={`dql-app-star ${favorite ? 'on' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite();
            }}
            aria-label={favorite ? 'Remove favourite' : 'Add favourite'}
          >
            <Star size={14} strokeWidth={1.8} />
          </button>
        </div>
        <StatusSeal tone={certified ? 'certified' : draftCount > 0 ? 'draft' : 'agentic'}>
          {certified ? 'certified' : draftCount > 0 ? 'mixed' : app.lifecycle ?? 'draft'}
        </StatusSeal>
        <h3>{app.name}</h3>
        <p>{cleanStakeholderCopy(app.description || `${app.name} consumption surface for ${app.domain}.`)}</p>
        <div className="dql-app-card-mini">
          <MiniMetric label="Pages" value={String(app.dashboards.length)} />
          <MiniMetric label="Books" value={String(app.notebooks?.length ?? 0)} />
          <MiniMetric label="Drafts" value={String(draftCount)} />
        </div>
        <div className="dql-app-card-signals">
          <span><ShieldCheck size={13} /> {trustLabel}</span>
          <span><Search size={13} /> {researchCount} analysis</span>
          <span><Sparkles size={13} /> {aiPinCount} local insights</span>
        </div>
      </div>
      <div className="dql-app-card-depth">
        <span>{primaryOwner(app)}</span>
        <button type="button" className="dql-app-card-act" onClick={onOpen} title="View app">
          <Eye size={12} /> View
        </button>
        <button type="button" className="dql-app-card-act" onClick={onEdit} title="Edit app">
          <Pencil size={12} /> Edit
        </button>
        <button type="button" className="dql-app-card-act danger" onClick={onDelete} title="Delete app">
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </article>
  );
}

function DeleteAppDialog({
  app,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  app: AppSummary;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const confirmed = confirmation.trim() === app.name;
  return (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1800, background: 'rgba(0,0,0,0.42)', display: 'grid', placeItems: 'center', padding: 24 }}
    >
      <section role="dialog" aria-modal="true" aria-labelledby="delete-app-title" style={{ width: 'min(460px, 100%)', borderRadius: 14, border: '1px solid var(--border-default)', background: 'var(--bg-1)', color: 'var(--text-primary)', boxShadow: '0 22px 60px rgba(0,0,0,0.28)', padding: 20, display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--status-error-bg)', color: 'var(--status-error)', border: '1px solid var(--status-error-border)' }}><Trash2 size={16} /></span>
          <div>
            <h2 id="delete-app-title" style={{ margin: 0, fontSize: 16 }}>Delete {app.name}?</h2>
            <p style={{ margin: '3px 0 0', color: 'var(--text-tertiary)', fontSize: 11.5 }}>The App package will leave the project and move to local DQL trash for recovery.</p>
          </div>
        </div>
        <label style={{ display: 'grid', gap: 6, color: 'var(--text-secondary)', fontSize: 11.5 }}>
          Type <strong style={{ color: 'var(--text-primary)' }}>{app.name}</strong> to confirm
          <input
            autoFocus
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && confirmed && !deleting) onConfirm(); }}
            disabled={deleting}
            style={{ height: 36, borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: 'var(--text-primary)', padding: '0 10px', outline: 'none', font: '12px var(--font-ui)' }}
          />
        </label>
        {error ? <div role="alert" style={{ color: 'var(--status-error)', fontSize: 11.5 }}>{error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} disabled={deleting} style={{ height: 34, borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: 'var(--text-secondary)', padding: '0 13px', cursor: deleting ? 'default' : 'pointer' }}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={!confirmed || deleting} style={{ height: 34, borderRadius: 8, border: 0, background: 'var(--status-error)', color: '#fff', padding: '0 13px', cursor: confirmed && !deleting ? 'pointer' : 'default', opacity: confirmed && !deleting ? 1 : 0.5 }}>{deleting ? 'Deleting…' : 'Delete App'}</button>
        </div>
      </section>
    </div>
  );
}

function AppCreateSurface({
  mode,
  existingAppId,
  appName,
  prompt,
  domain,
  domainOptions,
  owner,
  audience,
  promptExamples,
  catalog,
  catalogLoading,
  selectedBlocks,
  generated,
  buildSession,
  proposalSelection,
  proposalEdits,
  committing,
  themeMode,
  onToggleProposalTile,
  onProposalEdit,
  onCommitProposal,
  saving,
  error,
  onBack,
  onModeChange,
  onAppNameChange,
  onPromptChange,
  onDomainChange,
  onOwnerChange,
  onAudienceChange,
  onToggleBlock,
  onBuild,
  onOpenGenerated,
  onAddBlock,
}: {
  mode: BuilderMode;
  existingAppId: string | null;
  appName: string;
  prompt: string;
  domain: string;
  domainOptions: AuthoredDomainOption[];
  owner: string;
  audience: string;
  promptExamples: AppPromptExample[];
  catalog: AppBlockRecommendation[];
  catalogLoading: boolean;
  selectedBlocks: Set<string>;
  generated: GenerateAppResponse | null;
  buildSession: AppAiBuildSession | null;
  proposalSelection: Set<string>;
  proposalEdits: Record<string, { title?: string; viz?: string }>;
  committing: boolean;
  themeMode: ThemeMode;
  onToggleProposalTile: (tileId: string) => void;
  onProposalEdit: (tileId: string, edit: { title?: string; viz?: string }) => void;
  onCommitProposal: (edits?: AppBuildBriefEdits) => void;
  onAddBlock: (blockId: string) => void;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onModeChange: (mode: BuilderMode) => void;
  onAppNameChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onDomainChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onAudienceChange: (value: string) => void;
  onToggleBlock: (blockId: string) => void;
  onBuild: () => void;
  onOpenGenerated: () => void;
}) {
  const [addMoreOpen, setAddMoreOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const selected = catalog.filter((block) => selectedBlocks.has(block.id));
  const contextDomainLabel = domain.trim() || 'Auto domain';
  const contextOwnerLabel = owner.trim() || 'Local owner';
  const proposal = buildSession?.status === 'proposed' ? buildSession.proposal : undefined;
  const plan = generated?.plan
    ?? (buildSession?.plan as GeneratedAppPlan | undefined)
    ?? planFromSelection(appName, prompt, domain, owner, selected);
  const planTiles = plan.pages[0]?.tiles ?? [];
  const certifiedPlanTiles = planTiles.filter(isCertifiedPlanTile);
  const sessionWarnings = buildSession?.warnings ?? [];
  const scopedReportCount = planScopedReportCount(plan);
  const isPageBuild = Boolean(existingAppId);

  // ── Redesigned AI build flow (Apps Redesign.dc.html) ──────────────────────
  // library send → user bubble → building stream (orb + shimmer + staggered
  // steps while the real propose call runs) → proposal checklist → commit.
  if (mode === 'ai') {
    const tiles = proposal?.tiles ?? [];
    const certifiedTileCount = tiles.filter((tile) => tile.certification === 'certified').length;
    const semanticTileCount = tiles.filter((tile) => tile.certification === 'reviewed_semantic').length;
    const selectedCount = tiles.filter((tile) => proposalSelection.has(tile.id)).length;
    const proposalBlockIds = new Set(tiles.map((tile) => tile.blockId).filter(Boolean));
    const addNeedle = addQuery.trim().toLowerCase();
    const addPool = catalog.filter((block) =>
      !proposalBlockIds.has(block.id)
      && (!addNeedle || block.name.toLowerCase().includes(addNeedle) || (block.description ?? '').toLowerCase().includes(addNeedle)));
    const detectedFilters = (plan.globalFilters?.length ? plan.globalFilters : plan.pages[0]?.filters ?? []).slice(0, 4);
    const glyphFor = (viz: string): string => {
      const v = viz.toLowerCase();
      // One mark per shape: everything that was not a KPI or a table used to
      // share a single glyph, so a brief of six varied tiles looked identical.
      if (v.includes('kpi') || v.includes('metric') || v.includes('single')) return 'Σ';
      if (v.includes('table') || v.includes('pivot')) return '▤';
      if (v.includes('line') || v.includes('trend')) return '⟋';
      if (v.includes('area')) return '◺';
      if (v.includes('pie') || v.includes('donut')) return '◕';
      if (v.includes('scatter')) return '⁘';
      if (v.includes('gauge')) return '◑';
      if (v.includes('funnel')) return '▽';
      if (v.includes('heatmap')) return '▩';
      if (v.includes('text') || v.includes('narrative')) return '¶';
      return '▦';
    };
    const vizLabel = (viz: string): string => {
      const v = viz.toLowerCase();
      if (v.includes('kpi') || v.includes('single')) return 'KPI';
      if (v.includes('table')) return 'Table';
      if (v.includes('line')) return 'Line chart';
      if (v.includes('bar')) return 'Bar chart';
      return viz ? viz.charAt(0).toUpperCase() + viz.slice(1) : 'Auto';
    };
    return (
      <div className="dql-app-flow-scroll">
        <div className="dql-app-flow">
          <div className="dql-app-flow-head">
            <h2>{isPageBuild ? 'Build a new App page' : 'Build an app'}</h2>
            <p>{isPageBuild
              ? 'DQL plans one page from the existing App context, then waits for approval without changing any current page.'
              : 'DQL resolves certified blocks and semantic metrics, then waits for your approval before writing a private App draft.'}</p>
          </div>

          {/* sent prompt */}
          <div className="dql-app-flow-bubble">{prompt}</div>

          {/* building stream */}
          {saving ? (
            <div className="dql-app-buildstream">
              <span className="dql-app-buildorb"><Sparkles size={14} /></span>
              <div className="dql-app-buildbody">
                <span className="dql-app-shimmer">Finding certified blocks…</span>
                <div className="dql-app-buildsteps">
                  <span style={{ animationDelay: '0.2s' }}><Check size={11} className="ok" />Matched domain <code>{contextDomainLabel.toLowerCase()}</code></span>
                  <span style={{ animationDelay: '0.8s' }}><Check size={11} className="ok" />Scanning certified blocks and semantic metrics</span>
                  <span style={{ animationDelay: '1.4s' }}><i className="dot" />Detecting app filters from block parameters…</span>
                </div>
              </div>
            </div>
          ) : null}

          {/* proposal */}
          {!saving && proposal ? (
            <div className="dql-app-buildstream proposal">
              <span className="dql-app-buildorb still"><Sparkles size={14} /></span>
              <div className="dql-app-buildbody wide">
                <div className="dql-app-proposal-lede">
                  <strong>{isPageBuild ? 'Page Build Brief' : 'Build Brief'} · {proposal.intent.target === 'personal' ? 'Personal Draft' : 'Shared Project target'}</strong><br />
                  Found {certifiedTileCount} certified block{certifiedTileCount === 1 ? '' : 's'}{semanticTileCount > 0 ? ` and ${semanticTileCount} governed semantic view${semanticTileCount === 1 ? '' : 's'}` : ''}.
                  {isPageBuild
                    ? ' The approved page is added atomically; existing pages remain unchanged.'
                    : ' Every generated App starts private; review-required sources must pass publication checks before sharing.'}
                </div>
                <label className="dql-app-buildbrief-name">
                  <span>{isPageBuild ? 'Page name' : 'Draft name'}</span>
                  <input value={appName} onChange={(event) => onAppNameChange(event.target.value)} maxLength={120} />
                </label>
                <label className="dql-app-buildbrief-name">
                  <span>Audience</span>
                  <input value={audience} onChange={(event) => onAudienceChange(event.target.value)} maxLength={120} />
                </label>
                <div className="dql-app-proposal-card">
                  {tiles.map((tile) => {
                    const on = proposalSelection.has(tile.id);
                    const certifiedTile = tile.certification === 'certified';
                    const semanticTile = tile.certification === 'reviewed_semantic';
                    return (
                      <button
                        key={tile.id}
                        type="button"
                        className={`dql-app-proposal-row ${on ? '' : 'off'}`}
                        onClick={() => onToggleProposalTile(tile.id)}
                        disabled={Boolean(tile.error)}
                        title={tile.repair?.message ?? tile.error ?? tile.preflight.message}
                      >
                        <span className={`dql-app-prop-check ${on ? 'on' : ''}`}>{on ? <Check size={10} strokeWidth={3.2} /> : null}</span>
                        <span className={`dql-app-prop-glyph ${certifiedTile && glyphFor(tile.viz) === '▤' ? 'green' : ''}`}>{glyphFor(tile.viz)}</span>
                        <span className="dql-app-prop-name">
                          <b>{tile.blockId ?? tile.title}</b>
                          <small>{tile.description ?? tile.question ?? tile.title}</small>
                        </span>
                        <span className={`dql-app-prop-badge ${certifiedTile ? 'certified' : 'draft'}`}>
                          {certifiedTile
                            ? 'Certified'
                            : tile.repair?.status === 'repaired'
                              ? 'Auto-repaired · review'
                              : tile.repair?.status === 'failed'
                                ? 'Repair blocked'
                                : semanticTile ? 'Semantic · review' : 'Exploratory · review'}
                        </span>
                        <span className="dql-app-prop-viz">{vizLabel(tile.viz)}</span>
                        <small>{tile.preflight.status.replace('_', ' ')}</small>
                      </button>
                    );
                  })}
                  {tiles.filter((tile) => tile.repair).map((tile) => (
                    <div key={`repair-${tile.id}`} className="dql-app-flow-gaps">
                      <span>
                        {tile.repair?.status === 'repaired' ? <Wrench size={12} /> : <AlertTriangle size={12} />}
                        {tile.title}: {tile.repair?.message}
                      </span>
                    </div>
                  ))}
                  <button type="button" className="dql-app-addmore" onClick={() => setAddMoreOpen((open) => !open)}>
                    <Plus size={13} strokeWidth={2.2} /> Add more blocks
                  </button>
                  {addMoreOpen ? (
                    <div className="dql-app-addmore-panel">
                      <div className="dql-app-addmore-search">
                        <Search size={12} />
                        <input
                          value={addQuery}
                          onChange={(event) => setAddQuery(event.target.value)}
                          placeholder={`Search ${catalog.length} certified block${catalog.length === 1 ? '' : 's'}…`}
                        />
                      </div>
                      {catalogLoading ? <div className="dql-app-addmore-hint">Loading certified blocks…</div> : null}
                      {addPool.slice(0, 6).map((block) => (
                        <button key={block.id} type="button" className="dql-app-addmore-row" onClick={() => { setAddQuery(''); onAddBlock(block.id); }}>
                          <Plus size={12} strokeWidth={2.2} />
                          <span>{block.name}</span>
                          <small>{block.domain ?? 'certified'} · {block.status}</small>
                        </button>
                      ))}
                      {!catalogLoading && addPool.length === 0 ? <div className="dql-app-addmore-hint">No more matching certified blocks.</div> : null}
                    </div>
                  ) : null}
                </div>

                <details className="dql-app-buildbrief-edit">
                  <summary>Edit tile titles and visualizations</summary>
                  <div>
                    {tiles.filter((tile) => !tile.error).map((tile) => {
                      const edit = proposalEdits[tile.id] ?? { title: tile.title, viz: tile.viz };
                      const visualizations = Array.from(new Set([...(tile.allowedVisualizations ?? []), tile.viz, 'table']));
                      return (
                        <label key={`edit-${tile.id}`}>
                          <input value={edit.title ?? tile.title} onChange={(event) => onProposalEdit(tile.id, { title: event.target.value })} maxLength={120} />
                          <select value={edit.viz ?? tile.viz} onChange={(event) => onProposalEdit(tile.id, { viz: event.target.value })}>
                            {visualizations.map((viz) => <option key={viz} value={viz}>{vizLabel(viz)}</option>)}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </details>

                {detectedFilters.length > 0 ? (
                  <div className="dql-app-detected">
                    <span className="dql-app-detected-label">Detected filters</span>
                    {detectedFilters.map((filter) => (
                      <span key={filter.id} className="dql-app-detected-pill">{filter.label} · <strong>{formatVariableValue(filter.default ?? 'Any')}</strong></span>
                    ))}
                  </div>
                ) : null}

                {proposal.gaps.length > 0 ? (
                  <div className="dql-app-flow-gaps">
                    {proposal.gaps.slice(0, 3).map((gap) => (
                      <span key={gap.id}><AlertTriangle size={12} /> {gap.question}</span>
                    ))}
                  </div>
                ) : null}

                <div className="dql-app-flow-actions">
                  <button type="button" className="dql-app-flow-build" onClick={() => onCommitProposal()} disabled={committing || selectedCount === 0}>
                    <LayoutDashboard size={13} />
                    {committing
                      ? (isPageBuild ? 'Adding page…' : 'Building draft…')
                      : `${isPageBuild ? 'Add page' : 'Build private draft'} with ${selectedCount} tile${selectedCount === 1 ? '' : 's'}`}
                  </button>
                  <button type="button" className="dql-app-flow-reset" onClick={onBack}>{isPageBuild ? 'Back to app' : 'Start over'}</button>
                </div>
              </div>
            </div>
          ) : null}

          {/* propose failed or empty state fallback */}
          {!saving && !proposal ? (
            <div className="dql-app-flow-actions">
              <button type="button" className="dql-app-flow-build" onClick={onBuild}>
                <Sparkles size={13} /> Create Build Brief
              </button>
              <button type="button" className="dql-app-flow-reset" onClick={onBack}>{isPageBuild ? 'Back to app' : 'Start over'}</button>
            </div>
          ) : null}

          {error ? <div className="dql-app-error">{error}</div> : null}
          {sessionWarnings.length > 0 && !saving ? (
            <div className="dql-app-flow-gaps">
              {sessionWarnings.slice(0, 2).map((warning, index) => (
                <span key={`${warning}-${index}`}><AlertTriangle size={12} /> {warning}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="dql-app-create-shell">
      <div className="dql-app-buildbar">
        <button type="button" className="dql-app-back dql-app-back-label" onClick={onBack}>
          <ArrowLeft size={14} />
          <span>Apps</span>
        </button>
        <span className="dql-app-name-input">
          <input value={appName} onChange={(event) => onAppNameChange(event.target.value)} spellCheck={false} />
        </span>
        <StatusSeal tone={generated ? 'agentic' : 'draft'}>{generated ? 'generated' : 'draft'}</StatusSeal>
        {/* This surface only renders in classic mode now — AI mode uses the chat flow above. */}
        <div className="dql-app-mode-seg">
          <button type="button" onClick={() => onModeChange('ai')}>
            <Sparkles size={15} /> Build AI
          </button>
          <button type="button" className="on" onClick={() => onModeChange('classic')}>
            <Blocks size={15} /> Classic
          </button>
        </div>
        <div className="dql-app-build-actions">
          <span className="dql-app-persona"><b>CFO</b> CFO</span>
          {generated ? <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onOpenGenerated}>Open app</button> : null}
          <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onBuild} disabled={saving}>
            {saving ? 'Building...' : 'Create app'}
          </button>
        </div>
      </div>

      <div className="dql-app-create-workspace clean classic">
        <section className="dql-app-ai-start">
          <div className="dql-app-ai-start-main">
            <div className="dql-app-ai-start-copy">
              <h1>Start with one AI input.</h1>
              <p>DQL finds certified blocks, detects app filters, and opens the generated app in a clean stakeholder view.</p>
            </div>

            <div className="dql-app-ai-start-card">
              <textarea
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                rows={5}
                aria-label="App request"
                placeholder="Build an NBA player performance app for stakeholders..."
              />
              <button type="button" className="dql-app-ai-start-send" onClick={onBuild} disabled={saving || !prompt.trim()} title="Build app">
                {saving ? <Workflow size={19} /> : <Send size={19} />}
              </button>
            </div>

            <div className="dql-app-suggestions dql-app-ai-start-examples" aria-label="Prompt examples">
              <span>Examples</span>
              {promptExamples.slice(0, 4).map((item) => (
                <button key={item.title} type="button" onClick={() => {
                  onPromptChange(item.prompt);
                  const option = domainOptions.find((candidate) => (
                    candidate.value.toLowerCase() === item.domain.toLowerCase()
                    || candidate.label.toLowerCase() === item.domain.toLowerCase()
                  ));
                  onDomainChange(option?.value ?? '');
                }}>
                  {item.title}
                </button>
              ))}
            </div>

            <details className="dql-app-ai-context dql-app-ai-start-advanced">
              <summary>
                <span>Advanced controls</span>
                <b>{contextDomainLabel} / {contextOwnerLabel}</b>
                <ChevronDown size={14} />
              </summary>
              <div className="dql-app-ai-context-grid">
                <label>Domain
                  <select value={domain} onChange={(event) => onDomainChange(event.target.value)}>
                    <option value="">Global / cross-domain</option>
                    {domainOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label>Owner<input value={owner} onChange={(event) => onOwnerChange(event.target.value)} /></label>
                <label>Build mode
                  <select value={mode} onChange={(event) => onModeChange(event.target.value as BuilderMode)}>
                    <option value="ai">AI first</option>
                    <option value="classic">Manual block selection</option>
                  </select>
                </label>
              </div>
              {mode === 'classic' ? (
                <BlockIndex
                  title="Manual certified block selection"
                  subtitle={`${selectedBlocks.size} selected`}
                  catalog={catalog}
                  loading={catalogLoading}
                  selectedBlocks={selectedBlocks}
                  onToggleBlock={onToggleBlock}
                />
              ) : null}
            </details>

            {proposal && !generated ? (
              <div style={{ border: `1px solid ${themes[themeMode].cellBorder}`, background: themes[themeMode].appBg, borderRadius: 10, padding: 14 }}>
                <AppBuildProposalPanel
                  proposal={proposal}
                  t={themes[themeMode]}
                  selected={proposalSelection}
                  onToggle={onToggleProposalTile}
                  onCreate={(edits) => onCommitProposal(edits)}
                  defaultName={appName}
                  busy={committing}
                  error={null}
                />
              </div>
            ) : null}

            {generated ? (
              <div className="dql-app-ai-result dql-app-ai-start-result">
                Generated <b>{generated.plan.name}</b> with {generated.validation.certifiedTiles} certified app tile
                {generated.validation.certifiedTiles === 1 ? '' : 's'} and {scopedReportCount} scoped report
                {scopedReportCount === 1 ? '' : 's'}.
                {buildSession ? <small>Session {buildSession.id}</small> : null}
              </div>
            ) : null}

            {error ? <div className="dql-app-error">{error}</div> : null}
          </div>

          <aside className="dql-app-ai-start-context">
            <section className="dql-app-ai-context-card">
              <PanelHead
                title="Certified blocks found"
                meta={plan.coverage
                  ? `${plan.coverage.certifiedTiles} certified · ${plan.coverage.gaps} gap${plan.coverage.gaps === 1 ? '' : 's'}`
                  : `${certifiedPlanTiles.length || catalog.length} matches`}
              />
              <div className="dql-app-ai-evidence-list">
                {(certifiedPlanTiles.length ? certifiedPlanTiles : catalog.slice(0, 4)).map((item, index) => (
                  'name' in item ? (
                    <div key={`catalog-${item.id}-${index}`} className="dql-app-ai-evidence-row">
                      <span><ShieldCheck size={14} /></span>
                      <div><b>{item.name}</b><small>{item.description}</small></div>
                      <StatusSeal tone={item.status === 'certified' ? 'certified' : 'draft'}>{item.status}</StatusSeal>
                    </div>
                  ) : (
                    <div key={`plan-${item.id}-${index}`} className="dql-app-ai-evidence-row">
                      <span><ShieldCheck size={14} /></span>
                      <div><b>{item.title}</b><small>{item.description ?? item.rationale ?? 'Certified DQL block'}</small></div>
                      <StatusSeal tone="certified">Certified</StatusSeal>
                    </div>
                  )
                ))}
                {!certifiedPlanTiles.length && !catalog.length ? <EmptyPanel title="No matches yet." detail="Enter a prompt to retrieve certified blocks." compact /> : null}
              </div>
            </section>

            <section className="dql-app-ai-context-card">
              <PanelHead title="Detected app filters" meta="bound to block params" />
              <div className="dql-app-ai-filter-preview">
                {(plan.globalFilters?.length ? plan.globalFilters : plan.pages[0]?.filters ?? []).slice(0, 4).map((filter) => (
                  <span key={filter.id}><small>{filter.label}</small><b>{formatVariableValue(filter.default ?? 'Any')}</b></span>
                ))}
                {!(plan.globalFilters?.length || plan.pages[0]?.filters?.length) ? (
                  <>
                    <span><small>Domain</small><b>{contextDomainLabel}</b></span>
                    <span><small>Owner</small><b>{contextOwnerLabel}</b></span>
                    <span><small>Top N</small><b>Any</b></span>
                  </>
                ) : null}
              </div>
            </section>

            <section className="dql-app-ai-context-card">
              <PanelHead title="Possible deeper analysis" meta="Copilot asks for context first" />
              <div className="dql-app-ai-gap-list">
                {(plan.missingEvidence?.length ? plan.missingEvidence : sessionWarnings).slice(0, 4).map((warning, index) => (
                  <span key={`${warning}-${index}`}><AlertTriangle size={13} /> {warning}</span>
                ))}
                {!plan.missingEvidence?.length && !sessionWarnings.length ? (
                    <span><AlertTriangle size={13} /> Driver explanations, new grains, and reusable block proposals require typed context before DQL creates SQL.</span>
                ) : null}
              </div>
            </section>
          </aside>
        </section>

      </div>
    </div>
  );
}

async function dashboardDocumentFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function AppWorkspaceSurface({
  app,
  appDoc,
  dashboardDoc,
  loading,
  experience,
  section,
  explainOpen,
  explainExpanded,
  dashboardFilters,
  dashboardFilterValues,
  themeMode,
  variables,
  onBack,
  onExperienceChange,
  onRenameApp,
  onSectionChange,
  onDashboardFilterChange,
  onApplyDashboardFilters,
  onResetDashboardFilters,
  onExplainChange,
  onExplainExpandedChange,
  onAddPage,
  onOpenDashboard,
  onOpenApp,
  onDashboardChanged,
  onInvestigationsChanged,
  onOpenLineageNode,
}: {
  app: AppSummary | null;
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  loading: boolean;
  experience: AppExperience;
  section: AppSection;
  explainOpen: boolean;
  explainExpanded: boolean;
  dashboardFilters: DashboardFilter[];
  dashboardFilterValues: Record<string, unknown>;
  themeMode: ThemeMode;
  variables: Record<string, unknown>;
  onBack: () => void;
  onExperienceChange: (experience: AppExperience) => void;
  onRenameApp: (name: string, dashboardId?: string) => void;
  onSectionChange: (section: AppSection) => void;
  onDashboardFilterChange: (filter: DashboardFilter, value: unknown) => void;
  onApplyDashboardFilters: () => void;
  onResetDashboardFilters: () => void;
  onExplainChange: (value: boolean) => void;
  onExplainExpandedChange: (value: boolean) => void;
  onAddPage: () => void;
  onOpenDashboard: (dashboardId: string) => void;
  onOpenApp: (appId: string, dashboardId?: string) => void;
  onDashboardChanged: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  onInvestigationsChanged: (investigations: LocalAppInvestigation[]) => void;
  onOpenLineageNode: (nodeId: string) => void;
}) {
  const dispatch = useDispatch();
  const certifiedCount = dashboardDoc?.dashboard.layout.items.filter((item) => Boolean(item.block)).length ?? 0;
  const draftCount = appDoc?.drafts?.length ?? 0;
  const dashboardBlockIds = useMemo(() => {
    return getCopilotBlockTiles(dashboardDoc?.dashboard ?? null).map((item) => item.blockId);
  }, [dashboardDoc]);
  const dashboardBlockKey = dashboardBlockIds.join('|');
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(dashboardBlockIds[0] ?? null);
  const [dashboardRun, setDashboardRun] = useState<DashboardRunResponse | null>(null);
  const [askSeed, setAskSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [researchSeed, setResearchSeed] = useState<AppResearchSeed | null>(null);
  const [activeInvestigation, setActiveInvestigation] = useState<LocalAppInvestigation | null>(null);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'downloaded' | 'ready'>('idle');
  const [shareText, setShareText] = useState('');
  const [promoteStatus, setPromoteStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [promoteMessage, setPromoteMessage] = useState('');
  const semanticTileIds = dashboardDoc?.dashboard.layout.items.filter((item) => item.semantic).map((item) => item.i) ?? [];
  const { ready: semanticRunReady, repairedTileIds: repairedSemanticTileIds } = semanticApprovalState(semanticTileIds, dashboardRun);
  const handleDashboardRunChange = useCallback((run: DashboardRunResponse | null) => {
    setDashboardRun(run);
  }, []);
  const handleStartResearch = useCallback((seed: Omit<AppResearchSeed, 'nonce'>) => {
    setResearchSeed({ ...seed, nonce: Date.now() });
    onSectionChange('research');
    onExplainChange(true);
  }, [onExplainChange, onSectionChange]);
  const handleActiveInvestigationChange = useCallback((investigation: LocalAppInvestigation | null) => {
    setActiveInvestigation(investigation);
  }, []);
  const handleResearchSeedHandled = useCallback(() => {
    setResearchSeed(null);
  }, []);
  const handleAskBlock = useCallback((blockId: string, question: string) => {
    setSelectedBlockId(blockId);
    // Stakeholder view: route tile follow-up through the governed agent loop in the
    // global right rail (deep research, repair, escalation). Build/analyst keeps the
    // in-app copilot shim.
    if (experience === 'view') {
      dispatch({
        type: 'OPEN_GLOBAL_AI',
        audience: 'stakeholder',
        context: {
          title: 'App copilot',
          scopeHint: tidyTitle(app?.name) ? `Follow up on ${tidyTitle(app?.name)}` : 'Follow up on this tile',
          selectedObject: { kind: 'block', id: blockId, title: dashboardDoc?.dashboard.metadata.title },
          workspaceContext: {
            appId: app?.id,
            dashboardId: dashboardDoc?.dashboard.id,
            blockId,
          },
          // The app's own suggested questions (uncovered gaps from the AI build).
          suggestedQuestions: (dashboardDoc?.app as { copilot?: { suggestedQuestions?: string[] } } | undefined)?.copilot?.suggestedQuestions,
        },
        autoRun: { text: question, mode: 'auto' },
      });
      return;
    }
    onExplainChange(true);
    setAskSeed({ text: question, nonce: Date.now() });
  }, [dispatch, experience, app?.id, app?.name, dashboardDoc?.dashboard.id, dashboardDoc?.dashboard.metadata.title, onExplainChange]);

  useEffect(() => {
    if (experience !== 'view') return;
    if (section === 'notebooks' || section === 'ai' || section === 'drafts' || section === 'settings') {
      onSectionChange('dashboards');
    }
  }, [experience, section, onSectionChange]);

  useEffect(() => {
    if (dashboardBlockIds.length === 0) {
      if (selectedBlockId !== null) setSelectedBlockId(null);
      return;
    }
    if (!selectedBlockId || !dashboardBlockIds.includes(selectedBlockId)) {
      setSelectedBlockId(dashboardBlockIds[0]);
    }
  }, [dashboardBlockIds, dashboardBlockKey, selectedBlockId]);
  useEffect(() => {
    setDashboardRun(null);
    setActiveInvestigation(null);
  }, [app?.id, dashboardDoc?.dashboard.id]);
  const copilotAvailable = Boolean(app && dashboardDoc && (section === 'dashboards' || section === 'research'));
  const copilotVisible = copilotAvailable && explainOpen;
  const markAction = (status: 'copied' | 'downloaded' | 'ready') => {
    setShareStatus(status);
    if (status !== 'ready') window.setTimeout(() => setShareStatus('idle'), 1800);
  };
  const copyShareLink = async () => {
    const text = buildAppShareText(app, appDoc, dashboardDoc);
    setShareText(text);
    let copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.focus();
      area.select();
      copied = document.execCommand('copy');
      document.body.removeChild(area);
    }
    markAction(copied ? 'copied' : 'ready');
  };
  const downloadBrief = () => {
    const markdown = buildAppBriefMarkdown(app, appDoc, dashboardDoc);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${app?.id ?? appDoc?.app.id ?? 'dql-app'}-brief.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    markAction('downloaded');
  };
  const promoteApp = async () => {
    if (!app?.id) return;
    setPromoteStatus('running');
    setPromoteMessage('');
    const result = await api.promoteApp(app.id, { lifecycle: 'review' });
    if (!result.ok) {
      setPromoteStatus('error');
      setPromoteMessage(result.error);
      return;
    }
    setPromoteStatus('done');
    setPromoteMessage(`${result.paths.length} shared files published from the private draft${result.removedLocalTiles ? `; ${result.removedLocalTiles} local-only insight removed` : ''}.`);
    window.setTimeout(() => setPromoteStatus('idle'), 2400);
  };
  const approveSemanticResults = async () => {
    if (!app?.id || !dashboardDoc || !dashboardRun || semanticTileIds.length === 0) return;
    setPromoteStatus('running');
    setPromoteMessage('');
    const expectedDashboardFingerprint = await dashboardDocumentFingerprint(dashboardDoc.dashboard);
    const result = await api.approveAppSemanticTiles(app.id, dashboardDoc.dashboard.id, {
      runId: dashboardRun.runId,
      tileIds: semanticTileIds,
      expectedDashboardFingerprint,
    });
    if (!result.ok) {
      setPromoteStatus('error');
      setPromoteMessage(result.error);
      return;
    }
    onDashboardChanged(result.dashboard);
    setPromoteStatus('done');
    setPromoteMessage(`${semanticTileIds.length} semantic result${semanticTileIds.length === 1 ? '' : 's'} approved with run ${dashboardRun.runId}.`);
  };
  const onDashboards = section === 'dashboards' && Boolean(dashboardDoc);
  return (
    <div className="dql-app-workspace">
      <div className="dql-app-view-topbar">
        <button type="button" className="dql-app-back dql-app-back-label" onClick={onBack} title="Back to apps">
          <ArrowLeft size={14} />
          <span>Apps</span>
        </button>
        <span className="dql-app-crumb"><b>{app?.id ?? 'app'}</b></span>
        <StatusSeal tone="certified">{draftCount > 0 ? `${certifiedCount} certified` : 'All certified'}</StatusSeal>
        {draftCount > 0 ? <StatusSeal tone="draft">{draftCount} draft</StatusSeal> : null}

        <span className="dql-app-topbar-divider" aria-hidden="true" />

        <div className="dql-app-modeseg" role="group" aria-label="App mode">
          <button
            type="button"
            className={experience === 'view' ? 'on' : ''}
            onClick={() => onExperienceChange('view')}
            title="Clean stakeholder view"
          >
            <Eye size={12} /> View
          </button>
          <button
            type="button"
            className={experience === 'build' ? 'on' : ''}
            onClick={() => onExperienceChange('build')}
            title="Rearrange tiles and edit this app"
          >
            <Pencil size={12} /> Edit
          </button>
        </div>

        <div className="dql-app-view-actions">
          <PersonaSwitcher app={appDoc?.app ?? null} />
          {experience === 'build' ? (
            semanticTileIds.length > 0 ? (
              <button
                type="button"
                className="dql-apps-btn dql-apps-btn-line"
                onClick={() => void approveSemanticResults()}
                disabled={promoteStatus === 'running' || !semanticRunReady}
                title={semanticRunReady
                  ? 'Approve the successful semantic run for publication'
                  : repairedSemanticTileIds.length > 0
                    ? 'AI-repaired semantic previews are review-required and cannot be approved as governed semantic results'
                    : 'Run this dashboard successfully before semantic approval'}
              >
                <Check size={14} /> Approve semantic ({semanticTileIds.length})
              </button>
            ) : null
          ) : null}
          {experience === 'build' ? (
            <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void promoteApp()} disabled={promoteStatus === 'running'}>
              <ShieldCheck size={14} /> {promoteStatus === 'running' ? 'Checking' : 'Publish'}
            </button>
          ) : null}
          <button type="button" className="dql-apps-btn dql-apps-btn-line dql-apps-btn-icon" title={shareStatus === 'copied' ? 'Copied handoff' : 'Share local app handoff'} onClick={() => void copyShareLink()}>
            {shareStatus === 'copied' ? <Check size={15} /> : <Share2 size={15} />}
          </button>
          <button type="button" className="dql-apps-btn dql-apps-btn-line dql-apps-btn-icon" title={shareStatus === 'downloaded' ? 'Brief saved' : 'Download app brief'} onClick={downloadBrief}>
            {shareStatus === 'downloaded' ? <Check size={15} /> : <Download size={15} />}
          </button>
          {shareStatus === 'ready' ? (
            <div className="dql-app-share-popover">
              <b>Local handoff</b>
              <textarea readOnly value={shareText} onFocus={(event) => event.currentTarget.select()} />
            </div>
          ) : null}
          {promoteStatus === 'done' || promoteStatus === 'error' ? (
            <div className={`dql-app-promote-popover ${promoteStatus === 'error' ? 'error' : ''}`}>
              {promoteMessage}
            </div>
          ) : null}
        </div>
      </div>

      <main className="dql-app-view-wrap">
        <div className="dql-app-title-row">
          <div className="dql-app-title-copy">
            <div className="dql-app-title-meta">
              <span><LayoutDashboard size={14} /> {app?.domain ?? dashboardDoc?.dashboard.metadata.domain ?? 'DQL App'}</span>
              {onDashboards ? <span className="dql-app-title-context">{tidyTitle(app?.name) || 'App'}</span> : null}
              {experience === 'build' ? <StatusSeal tone="draft">Customizing</StatusSeal> : null}
            </div>
            {/* Editable in place while customizing: `dql.app.json` and the page
                title previously had no writer after creation at all. */}
            {experience === 'build' && app ? (
              <AppTitleInput
                key={`${app.id}:${onDashboards ? dashboardDoc?.dashboard.id ?? '' : 'app'}`}
                value={tidyTitle(onDashboards ? dashboardDoc?.dashboard.metadata.title : app.name) || 'App'}
                label={onDashboards ? 'Page name' : 'App name'}
                onCommit={(next) => void onRenameApp(next, onDashboards ? dashboardDoc?.dashboard.id : undefined)}
              />
            ) : (
              <h1>{tidyTitle(onDashboards ? dashboardDoc?.dashboard.metadata.title : app?.name) || 'App'}</h1>
            )}
            <p>{cleanStakeholderCopy((onDashboards ? dashboardDoc?.dashboard.metadata.description : app?.description) ?? 'Local DQL App')}</p>
          </div>
          <div className="dql-app-nav-row">
            <AppWorkspaceTabs
              appDoc={appDoc}
              section={section}
              experience={experience}
              onChange={onSectionChange}
            />
            {section === 'dashboards' && appDoc?.dashboards.length ? (
              <DashboardPagePicker
                dashboards={appDoc.dashboards}
                activeDashboardId={dashboardDoc?.dashboard.id}
                isBuild={experience === 'build'}
                onOpen={onOpenDashboard}
                onAdd={onAddPage}
              />
            ) : null}
            {copilotAvailable ? (
              <button
                type="button"
                className={`dql-apps-btn dql-apps-btn-line dql-apps-btn-icon ${explainOpen ? 'on' : ''}`}
                title={explainOpen ? 'Hide AI copilot' : 'Show AI copilot'}
                onClick={() => onExplainChange(!explainOpen)}
              >
                <Bot size={15} />
              </button>
            ) : null}
            {onDashboards ? (
              <>
                <button
                  type="button"
                  className="dql-apps-btn dql-apps-btn-line dql-apps-btn-icon"
                  title="Open dashboard lineage"
                  onClick={() => { if (app && dashboardDoc) onOpenLineageNode(`dashboard:${app.id}/${dashboardDoc.dashboard.id}`); }}
                >
                  <GitBranch size={15} />
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className={`dql-app-view-layout ${copilotVisible ? '' : 'no-explain'}`}>
          <div className="dql-app-main-column">
            {section === 'dashboards' && dashboardDoc && dashboardFilters.length > 0 ? (
              <section className="dql-app-filter-row" aria-label="Dashboard filters">
                <div className="dql-app-filter-row-copy">
                  <b>Filters</b>
                  <span>Set the business scope, then apply once to refresh the full story.</span>
                </div>
                <DashboardFilterControls
                  filters={dashboardFilters}
                  values={dashboardFilterValues}
                  onChange={onDashboardFilterChange}
                />
                <div className="dql-app-filter-row-actions">
                  <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onResetDashboardFilters}>Reset</button>
                  <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onApplyDashboardFilters}>Apply filters</button>
                </div>
              </section>
            ) : null}
            {loading ? (
              <EmptyPanel title="Loading app..." detail="Reading dashboard files and running local blocks." />
            ) : section === 'dashboards' && dashboardDoc && app ? (
              <DashboardRenderer
                appId={app.id}
                dashboard={dashboardDoc.dashboard}
                editable={experience === 'build'}
                embeddedHeader
                variables={variables}
                selectedBlockId={selectedBlockId}
                onBlockFocus={setSelectedBlockId}
                onAskBlock={handleAskBlock}
                onOpenLineageNode={onOpenLineageNode}
                copilotOpen={explainOpen}
                onCopilotChange={onExplainChange}
                onDashboardChanged={onDashboardChanged}
                onRunChange={handleDashboardRunChange}
              />
            ) : section === 'notebooks' ? (
              <NotebookListPanel appDoc={appDoc} />
            ) : section === 'research' ? (
              <ResearchPanel
                appDoc={appDoc}
                dashboardDoc={dashboardDoc}
                seed={researchSeed}
                themeMode={themeMode}
                onSeedHandled={handleResearchSeedHandled}
                onDashboardChanged={onDashboardChanged}
                onInvestigationsChanged={onInvestigationsChanged}
                onActiveInvestigationChange={handleActiveInvestigationChange}
              />
            ) : section === 'ai' ? (
              <AiPinsPanel appDoc={appDoc} />
            ) : section === 'drafts' ? (
              <DraftsPanel appDoc={appDoc} />
            ) : section === 'settings' ? (
              <SettingsPanel appDoc={appDoc} />
            ) : (
              <EmptyPanel title="No dashboard page selected." detail="Choose a dashboard page or add one in Build mode." />
            )}
          </div>
          {copilotVisible ? (
            <UnifiedAppAiPanel
              app={app}
              appDoc={appDoc}
              dashboardDoc={dashboardDoc}
              dashboardRun={dashboardRun}
              variables={variables}
              selectedBlockId={selectedBlockId}
              askSeed={askSeed}
              themeMode={themeMode}
              expanded={explainExpanded}
              onToggleExpanded={() => onExplainExpandedChange(!explainExpanded)}
              onClose={() => onExplainChange(false)}
              onOpenApp={onOpenApp}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function BlockIndex({
  title,
  subtitle,
  catalog,
  loading,
  selectedBlocks,
  onToggleBlock,
}: {
  title: string;
  subtitle: string;
  catalog: AppBlockRecommendation[];
  loading: boolean;
  selectedBlocks: Set<string>;
  onToggleBlock: (blockId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const blocks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter((block) => [
      block.name,
      block.domain,
      block.status,
      block.description,
      block.owner ?? '',
      ...(block.tags ?? []),
    ].join(' ').toLowerCase().includes(needle));
  }, [catalog, query]);
  return (
    <div className="dql-app-palette">
      <div className="dql-app-palette-title">
        <span><Blocks size={14} /> {title}</span>
        <b>{subtitle}</b>
      </div>
      <label className="dql-app-palette-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search blocks, domains, tags"
        />
      </label>
      {loading ? <EmptyPanel title="Loading blocks..." detail="Finding certified blocks for this domain." compact /> : null}
      {!loading && blocks.length === 0 ? <EmptyPanel title="No blocks found." detail="Try another domain or search term." compact /> : null}
      {blocks.slice(0, 24).map((block, index) => {
        const selected = selectedBlocks.has(block.id);
        return (
          <button key={`${block.id}-${index}`} type="button" className={selected ? 'selected' : ''} onClick={() => onToggleBlock(block.id)}>
            <span className="dql-app-palette-icon"><LineChart size={14} /></span>
            <span>
              <b>{block.name}</b>
              <small>{block.domain} / {block.chartType ?? 'table'}</small>
            </span>
            <i>{selected ? 'using' : block.status}</i>
          </button>
        );
      })}
      {blocks.length > 24 ? <div className="dql-app-palette-more">{blocks.length - 24} more matches</div> : null}
    </div>
  );
}

/**
 * An `h1` that becomes an input while customizing.
 *
 * Renaming commits on blur or Enter, never per keystroke, and Escape restores
 * the saved value so a half-typed name cannot be written by accident.
 */
function AppTitleInput({ value, label, onCommit }: { value: string; label: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      className="dql-app-title-input"
      aria-label={label}
      title={`${label} — press Enter to save`}
      value={draft}
      maxLength={120}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { const next = draft.trim(); if (next && next !== value) onCommit(next); else setDraft(value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); }
      }}
    />
  );
}

function AppWorkspaceTabs({
  appDoc,
  section,
  experience,
  onChange,
}: {
  appDoc: AppDocumentSummary | null;
  section: AppSection;
  experience: AppExperience;
  onChange: (section: AppSection) => void;
}) {
  const reportCount = appDoc?.investigations?.length ?? 0;
  const tabs: Array<{ id: AppSection; label: string; count?: number; icon: ReactNode }> = experience === 'view'
    ? [
      // Stakeholder view = just the dashboard story + tiles. Follow-up and research
      // happen in the global right-rail copilot, not in-app tabs.
      { id: 'dashboards', label: 'App', count: appDoc?.dashboards.length ?? 0, icon: <LayoutDashboard size={14} /> },
    ]
    : [
      { id: 'dashboards', label: 'App', count: appDoc?.dashboards.length ?? 0, icon: <LayoutDashboard size={14} /> },
      { id: 'research', label: 'Analysis', count: reportCount, icon: <Search size={14} /> },
      { id: 'notebooks', label: 'Notebooks', count: appDoc?.notebooks?.length ?? appDoc?.app.notebooks?.length ?? 0, icon: <BookOpenText size={14} /> },
      { id: 'ai', label: 'Pins', count: appDoc?.aiPins?.length ?? 0, icon: <Bot size={14} /> },
      { id: 'drafts', label: 'Drafts', count: appDoc?.drafts?.length ?? 0, icon: <FileText size={14} /> },
      { id: 'settings', label: 'Settings', icon: <Workflow size={14} /> },
    ];
  return (
    <nav className="dql-app-section-tabs" aria-label="App sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={section === tab.id ? 'on' : ''}
          data-app-section={tab.id}
          onClick={() => onChange(tab.id)}
          title={tab.label}
          aria-label={`${tab.label}${tab.count !== undefined ? ` ${tab.count}` : ''}`}
        >
          <i className="dql-app-tab-icon">{tab.icon}</i>
          <span className="dql-app-tab-label">{tab.label}</span>
          {tab.count !== undefined ? <b>{tab.count}</b> : null}
        </button>
      ))}
    </nav>
  );
}

function DashboardPagePicker({
  dashboards,
  activeDashboardId,
  isBuild,
  onOpen,
  onAdd,
}: {
  dashboards: AppDocumentSummary['dashboards'];
  activeDashboardId?: string | null;
  isBuild: boolean;
  onOpen: (dashboardId: string) => void;
  onAdd: () => void;
}) {
  const activeDashboard = dashboards.find((dashboard) => dashboard.id === activeDashboardId) ?? dashboards[0];
  return (
    <div className="dql-app-page-picker" aria-label="Dashboard page">
      <span><LineChart size={14} /> Page</span>
      <select
        value={activeDashboard?.id ?? ''}
        onChange={(event) => onOpen(event.target.value)}
        title={activeDashboard?.title ?? 'Dashboard page'}
      >
        {dashboards.map((dashboard) => (
          <option key={dashboard.id} value={dashboard.id}>
            {dashboard.title} ({dashboard.itemCount})
          </option>
        ))}
      </select>
      {isBuild ? (
        <button type="button" onClick={onAdd} title="Add dashboard page">
          <Plus size={14} />
        </button>
      ) : null}
    </div>
  );
}

function UnifiedAppAiPanel({
  app,
  appDoc,
  dashboardDoc,
  dashboardRun,
  variables,
  selectedBlockId,
  askSeed,
  themeMode,
  expanded,
  onToggleExpanded,
  onClose,
  onOpenApp,
}: {
  app: AppSummary | null;
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  dashboardRun: DashboardRunResponse | null;
  variables: Record<string, unknown>;
  selectedBlockId: string | null;
  askSeed?: { text: string; nonce: number } | null;
  themeMode: ThemeMode;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  onOpenApp: (appId: string, dashboardId?: string) => void;
}) {
  const t = themes[themeMode];
  const dashboard = dashboardDoc?.dashboard ?? null;
  const blockTiles = useMemo(() => getCopilotBlockTiles(dashboard, dashboardRun), [dashboard, dashboardRun]);
  const selectedBlock = blockTiles.find((item) => item.blockId === selectedBlockId) ?? null;
  const selectedTileRun = selectedBlock
    ? dashboardRun?.tiles.find((tile) => tile.tileId === selectedBlock.tileId || tile.blockId === selectedBlock.blockId)
    : null;
  const appId = app?.id ?? appDoc?.app.id ?? 'app';
  const dashboardId = dashboard?.id ?? 'dashboard';
  const agentThread = usePersistedAgentThreadId(`app:${appId}:${dashboardId}`);
  const [appAiRunning, setAppAiRunning] = useState(false);
  const appTitle = formatBusinessLabel(app?.name ?? appDoc?.app.name ?? dashboard?.metadata.title ?? 'App workspace');
  const dashboardTitle = formatBusinessLabel(dashboard?.metadata.title ?? 'Dashboard');
  const scopeHint = selectedBlock
    ? `Focused on ${formatBusinessLabel(selectedBlock.title)} in ${dashboardTitle}`
    : `Scoped to ${dashboardTitle}`;
  const selectedObject = selectedBlock
    ? { kind: 'block' as const, id: selectedBlock.blockId, title: selectedBlock.title }
    : dashboard
      ? { kind: 'dashboard' as const, id: dashboard.id, title: dashboard.metadata.title }
      : { kind: 'app' as const, id: appId, title: appTitle };
  const workspaceContext = useMemo(() => ({
    surface: 'apps',
    appId,
    appName: app?.name ?? appDoc?.app.name,
    appDomain: app?.domain ?? appDoc?.app.domain,
    appDescription: app?.description ?? appDoc?.app.description,
    dashboardId: dashboard?.id,
    dashboardTitle: dashboard?.metadata.title,
    dashboardDescription: dashboard?.metadata.description,
    dashboardFilters: variables,
    selectedBlock: selectedBlock ? {
      blockId: selectedBlock.blockId,
      tileId: selectedBlock.tileId,
      title: selectedBlock.title,
      visualization: selectedBlock.viz,
      status: selectedTileRun?.status,
      certificationStatus: selectedTileRun?.certificationStatus,
      rowCount: selectedTileRun?.result?.rowCount,
      columns: selectedTileRun?.result?.columns?.slice(0, 12),
      sampleRows: sampleDashboardRows(selectedTileRun?.result?.rows, selectedTileRun?.result?.columns),
    } : undefined,
  }), [app, appDoc, appId, dashboard, selectedBlock, selectedTileRun, variables]);

  return (
    <AiSidePanel
      t={t}
      title="App AI"
      subtitle={appTitle}
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
      resizable
      minResizeWidth={390}
      maxResizeWidth={1200}
      fitViewportHeight
      heightResizable
      minResizeHeight={520}
      onClose={onClose}
      onNewChat={agentThread.resetThreadId}
      running={appAiRunning}
      ariaLabel="App AI"
      className="dql-app-explain-panel dql-app-assistant-panel"
    >
      <Suspense fallback={<div style={{ padding: 16, fontSize: 12, color: t.textSecondary }}>Loading App AI…</div>}>
        <UnifiedAgentRunPanel
          key={`${appId}:${dashboardId}`}
          themeMode={themeMode}
          title="App AI"
          scopeHint={scopeHint}
          audience="stakeholder"
          selectedObject={selectedObject}
          workspaceContext={workspaceContext}
          initialMode="auto"
          autoRun={askSeed?.text ? { text: askSeed.text, mode: 'ask', nonce: askSeed.nonce } : undefined}
          threadId={agentThread.threadId}
          onThreadIdChange={agentThread.onThreadIdChange}
          onRunningChange={setAppAiRunning}
          onOpenApp={onOpenApp}
          answerFirstCards
          examplePrompts={[
            { label: 'Explain this dashboard', prompt: 'Explain the most important business story in this dashboard and what action it suggests.' },
            { label: 'Find the main driver', prompt: 'What is the main driver behind the current result? Use the active app filters and governed evidence.' },
            { label: 'Check this result', prompt: 'Validate the current result against its certified block, semantic definitions, and lineage.' },
          ]}
        />
      </Suspense>
    </AiSidePanel>
  );
}

type GeneratedPlanTile = GeneratedAppPlan['pages'][number]['tiles'][number];

function isCertifiedPlanTile(tile: GeneratedPlanTile): boolean {
  return tile.kind === 'certified_block' && tile.certification === 'certified';
}

function planScopedReportCount(plan: GeneratedAppPlan): number {
  const rootReports = Array.isArray(plan.scopedReports) ? plan.scopedReports.length : 0;
  const planningReports = Array.isArray(plan.planning?.scopedReports) ? plan.planning.scopedReports.length : 0;
  if (rootReports > 0 || planningReports > 0) return Math.max(rootReports, planningReports);
  return Array.isArray(plan.missingEvidence) ? plan.missingEvidence.length : 0;
}

function getDashboardItemBlockId(item: DashboardDocumentResponse['dashboard']['layout']['items'][number]): string | null {
  if (!item.block) return null;
  return 'blockId' in item.block ? item.block.blockId ?? null : item.block.ref ?? null;
}

function getCopilotBlockTiles(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  run?: DashboardRunResponse | null,
): AppCopilotBlockTile[] {
  if (!dashboard) return [];
  const runByTile = new Map((run?.tiles ?? []).map((tile) => [tile.tileId, tile]));
  const runByBlock = new Map((run?.tiles ?? []).filter((tile) => tile.blockId).map((tile) => [tile.blockId, tile]));
  const preferredTopics = new Set(dashboard.layout.items
    .filter((item) => getDashboardItemBlockId(item) && isPreferredCopilotContextItem(item))
    .map((item) => copilotBusinessTopicSignature(`${item.title ?? ''} ${getDashboardItemBlockId(item) ?? ''}`))
    .filter(Boolean));
  const ranked = dashboard.layout.items
    .map((item, index) => {
      const blockId = getDashboardItemBlockId(item);
      if (!blockId) return null;
      const topicKey = copilotBusinessTopicSignature(`${item.title ?? ''} ${blockId}`);
      if (topicKey && preferredTopics.has(topicKey) && !isPreferredCopilotContextItem(item)) return null;
      const tileRun = runByTile.get(item.i) ?? runByBlock.get(blockId);
      return {
        block: {
          blockId,
          title: item.title ?? blockId,
          viz: item.viz.type,
          tileId: item.i,
        },
        duplicateKeys: copilotBlockTileDuplicateKeys(item, tileRun, blockId),
        score: copilotBlockTileScore(item, tileRun, index),
      };
    })
    .filter((item): item is { block: AppCopilotBlockTile; duplicateKeys: string[]; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score);

  const seen = new Set<string>();
  const blocks: AppCopilotBlockTile[] = [];
  for (const item of ranked) {
    if (item.duplicateKeys.some((key) => seen.has(key))) continue;
    for (const key of item.duplicateKeys) seen.add(key);
    blocks.push(item.block);
  }
  return blocks;
}

function isPreferredCopilotContextItem(item: DashboardLayoutItem): boolean {
  if (item.parameterBindings?.length) return true;
  return Boolean(item.filterBindings?.some((binding) =>
    !binding.unsupportedReason && (binding.mode === 'parameter' || binding.mode === 'predicate' || Boolean(binding.binding)),
  ));
}

function copilotBlockTileDuplicateKeys(
  item: DashboardLayoutItem,
  tile: DashboardRunResponse['tiles'][number] | undefined,
  blockId: string,
): string[] {
  const keys = [`block:${blockId}`];
  const resultKey = copilotResultFingerprint(tile?.result);
  if (resultKey) keys.push(`result:${resultKey}`);
  const topicKey = copilotBusinessTopicSignature(`${item.title ?? ''} ${blockId}`);
  if (topicKey) keys.push(`topic:${topicKey}`);
  return keys;
}

function copilotResultFingerprint(result: DashboardRunResponse['tiles'][number]['result'] | undefined): string {
  if (!result?.columns?.length || !result.rows?.length) return '';
  const columns = result.columns.slice(0, 6).map((column) => column.toLowerCase());
  const rowValues = result.rows.slice(0, 3).map((row) =>
    columns.map((column) => formatCopilotFingerprintValue(row[column] ?? row[result.columns.find((candidate) => candidate.toLowerCase() === column) ?? column])).join(','),
  );
  return [...columns, ...rowValues].join('|');
}

function formatCopilotFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '';
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

function copilotBusinessTopicSignature(value: string): string {
  const text = value
    .toLowerCase()
    .replace(/\b(codex|e2e|qa|draft|imported|pasted|raw|sql|block)\b/g, ' ')
    .replace(/\b20\d{10,}\b/g, ' ');
  const entity = /\b(player|players|scorer|scorers|athlete)\b/.test(text)
    ? 'player'
    : /\b(customer|account|user)\b/.test(text)
      ? 'customer'
      : /\b(team|teams)\b/.test(text)
        ? 'team'
        : '';
  const intent = /\b(top|bottom|rank|ranking|leader|leaderboard|scorer|scorers)\b/.test(text)
    ? 'ranking'
    : /\b(availability|freshness|record|records|quality|coverage)\b/.test(text)
      ? 'availability'
      : /\b(trend|weekly|monthly|daily|over time)\b/.test(text)
        ? 'trend'
        : '';
  const metric = /\b(point|points|pts|score|scoring|scorer|scorers)\b/.test(text)
    ? 'points'
    : /\b(field goal|fgm|fga|field-goal|field_goals?)\b/.test(text)
      ? 'field_goals'
      : /\b(count|records|games played)\b/.test(text)
        ? 'count'
        : /\b(availability|freshness|quality|coverage)\b/.test(text)
          ? 'quality'
          : '';
  if (!entity || !intent || !metric) return '';
  return `${entity}|${intent}|${metric}`;
}

function copilotBlockTileScore(
  item: DashboardLayoutItem,
  tile: DashboardRunResponse['tiles'][number] | undefined,
  index: number,
): number {
  let score = 10000 - index;
  if (item.parameterBindings?.length) score += 50000;
  if (item.filterBindings?.length) score += 20000;
  if (tile?.status === 'ok') score += 15000;
  if (tile?.result?.rows?.length) score += 8000;
  if (tile?.certificationStatus === 'certified') score += 5000;
  if (String(item.trustState ?? item.display?.trustState ?? '').toLowerCase() === 'certified') score += 3000;
  if (/codex\s+e2e|test|pasted/i.test(String(item.title ?? ''))) score -= 6000;
  return score;
}

function sampleDashboardRows(rows?: Array<Record<string, unknown>>, columns?: string[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const selectedColumns = Array.isArray(columns) && columns.length > 0 ? columns.slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  return rows.slice(0, 5).map((row) => Object.fromEntries(selectedColumns.map((column) => [column, row[column]])));
}

function formatCopilotRouteLabel(route: AppCopilotRoute): string {
  if (route === 'certified_answer') return 'Answered from trusted logic';
  if (route === 'generated_answer') return 'Generated — review required';
  if (route === 'investigation') return 'Needs analysis';
  if (route === 'app_change_proposal') return 'App change idea';
  if (route === 'metadata_answer') return 'Metadata answer';
  return formatBusinessLabel(String(route));
}

function formatActionBriefLabel(mode: 'research' | 'evidence' | 'block'): string {
  if (mode === 'evidence') return 'Proof request';
  if (mode === 'block') return 'Reusable logic';
  return 'Business memo';
}

function reportTitleForAction(mode: 'research' | 'evidence' | 'block', question: string): string {
  const label = mode === 'evidence' ? 'Proof' : mode === 'block' ? 'Reusable Logic' : 'Business Memo';
  return `${label}: ${question}`;
}

function buildAppShareText(
  app: AppSummary | null,
  appDoc: AppDocumentSummary | null,
  dashboardDoc: DashboardDocumentResponse | null,
): string {
  const appId = app?.id ?? appDoc?.app.id ?? 'app';
  const appName = app?.name ?? appDoc?.app.name ?? 'DQL App';
  const dashboard = dashboardDoc?.dashboard.metadata.title ?? appDoc?.dashboards[0]?.title ?? 'Overview';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'local DQL';
  return [
    appName,
    `App ID: ${appId}`,
    `Dashboard: ${dashboard}`,
    `Domain: ${app?.domain ?? appDoc?.app.domain ?? dashboardDoc?.dashboard.metadata.domain ?? 'unknown'}`,
    `Open locally: ${origin}`,
  ].join('\n');
}

function buildAppBriefMarkdown(
  app: AppSummary | null,
  appDoc: AppDocumentSummary | null,
  dashboardDoc: DashboardDocumentResponse | null,
): string {
  const appModel = appDoc?.app;
  const title = app?.name ?? appModel?.name ?? 'DQL App';
  const dashboards = appDoc?.dashboards ?? [];
  const notebooks = appDoc?.notebooks ?? appModel?.notebooks ?? [];
  const drafts = appDoc?.drafts ?? [];
  const aiPins = appDoc?.aiPins ?? [];
  const dashboard = dashboardDoc?.dashboard;
  const blocks = dashboard?.layout.items
    .map((item) => item.block ? (item.block.blockId ?? item.block.ref ?? item.title ?? item.i) : null)
    .filter((value): value is string => Boolean(value)) ?? [];
  const lines = [
    `# ${title}`,
    '',
    app?.description ?? dashboard?.metadata.description ?? appModel?.description ?? 'Local DQL App brief.',
    '',
    '## App Metadata',
    '',
    `- App ID: ${app?.id ?? appModel?.id ?? 'unknown'}`,
    `- Domain: ${app?.domain ?? appModel?.domain ?? dashboard?.metadata.domain ?? 'unknown'}`,
    `- Lifecycle: ${app?.lifecycle ?? appModel?.lifecycle ?? dashboard?.metadata.lifecycle ?? 'draft'}`,
    `- Audience: ${app?.audience ?? appModel?.audience ?? dashboard?.metadata.audience ?? 'stakeholder'}`,
    `- Owners: ${(app?.owners ?? appModel?.owners ?? []).join(', ') || 'owner@local'}`,
    '',
    '## Pages',
    '',
    ...(dashboards.length ? dashboards.map((item) => `- ${item.title} (${item.itemCount} tiles)`) : ['- No dashboard pages found.']),
    '',
    '## Governed Blocks',
    '',
    ...(blocks.length ? blocks.map((name) => `- ${name}`) : ['- No block-backed tiles found.']),
    '',
    '## Supporting Assets',
    '',
    `- Notebooks: ${notebooks.length}`,
    `- Pinned insights: ${aiPins.length}`,
    `- Drafts needing review: ${drafts.length}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><b>{value}</b></span>;
}

function AddPageDialog({
  title,
  allowExploration,
  exploreGaps,
  error,
  onChange,
  onExploreGapsChange,
  onCancel,
  onCreate,
}: {
  title: string;
  allowExploration: boolean;
  exploreGaps: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onExploreGapsChange: (value: boolean) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="dql-app-modal-backdrop">
      <div className="dql-app-modal">
        <h3>Build a new App page</h3>
        <p>Describe the business question. AI will propose exactly one page for review before changing the App.</p>
        <label>What should this page answer?
          <textarea
            value={title}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
            rows={4}
            placeholder="Show quarterly revenue drivers by region and segment for leadership."
          />
        </label>
        {allowExploration ? (
          <button
            type="button"
            className={`dql-app-page-explore ${exploreGaps ? 'on' : ''}`}
            onClick={() => onExploreGapsChange(!exploreGaps)}
            aria-pressed={exploreGaps}
          >
            <span>{exploreGaps ? <Check size={11} strokeWidth={3} /> : null}</span>
            <b>Explore uncovered gaps with AI SQL</b>
            <small>Personal App only · bounded preview · review required</small>
          </button>
        ) : (
          <small className="dql-app-page-source-policy">Shared-project pages use certified blocks and governed semantic metrics.</small>
        )}
        {error ? <div className="dql-app-error">{error}</div> : null}
        <div>
          <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onCancel}>Cancel</button>
          <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onCreate}>Create Build Brief</button>
        </div>
      </div>
    </div>
  );
}

function planFromSelection(
  name: string,
  prompt: string,
  domain: string,
  owner: string,
  selected: AppBlockRecommendation[],
): GeneratedAppPlan {
  const tiles = selected.map((block, index) => ({
    id: block.id || `tile-${index + 1}`,
    title: block.name,
    kind: 'certified_block' as const,
    description: block.description,
    blockId: block.name,
    sourceNodeId: block.id,
    viz: block.chartType ?? 'table',
    certification: 'certified' as const,
    reviewStatus: 'certified' as const,
    rationale: 'Selected from the certified block palette.',
  }));
  return {
    version: 2,
    mode: 'stakeholder',
    publicationIntent: 'shared_project',
    requirements: [{ id: 'primary', question: prompt, role: 'detail', measures: [], dimensions: [], filters: [] }],
    requirementCoverage: tiles.map((tile) => ({
      requirementId: 'primary',
      status: 'covered' as const,
      source: 'certified_block' as const,
      tileId: tile.id,
      sourceId: tile.sourceNodeId,
      trustState: 'certified',
      reasons: ['Explicitly selected certified block.'],
    })),
    storyEvidencePlan: { version: 1, goal: prompt, audience: 'stakeholder', eligibleTileIds: tiles.map((tile) => tile.id) },
    appId: slugify(name) || 'new-app',
    name,
    prompt,
    skills: AGENT_SKILLS.map((skill) => ({
      id: skill.id,
      title: skill.title,
      description: skill.description,
    })),
    domain,
    audience: 'stakeholder',
    businessGoal: prompt,
    owner,
    lifecycle: 'draft',
    tags: ['app-builder'],
    pages: [{ id: 'overview', title: 'Overview', filters: [], tiles }],
    caveats: [],
    reviewTasks: [],
  };
}

function libraryCounts(apps: AppSummary[], favorites: Set<string>): Record<LibraryFilter, number> {
  return {
    all: apps.length,
    mine: apps.filter((app) => app.storage === 'mine').length,
    shared: apps.filter((app) => (app.storage ?? 'shared') === 'shared').length,
    fav: favorites.size,
  };
}

function primaryOwner(app: AppSummary): string {
  return app.owners?.[0] ?? 'owner@local';
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
  return Math.abs(hash).toString(16).slice(0, 7).padStart(7, '0');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
