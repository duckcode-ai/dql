import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  BarChart3,
  Blocks,
  BookOpenText,
  Bot,
  CalendarDays,
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
  Workflow,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
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
import { StructuredAnswerText } from '../agent/AgentAnswerCard';
import { AppBuildProposalPanel, defaultProposalSelection } from './AppBuildProposalPanel';
import { DashboardRenderer } from './DashboardRenderer';
import { PersonaSwitcher } from './PersonaSwitcher';

type AppSurface = 'library' | 'create' | 'workspace';
type AppExperience = AppWorkspaceExperience;
type BuilderMode = 'ai' | 'classic';
type AppSection = AppWorkspaceSection;
type LibraryFilter = 'all' | 'mine' | 'shared' | 'fav';
type DashboardFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type AppAskDecision = Extract<AppAskResponse, { ok: true }>['decision'];
type AppAnalysisHandoff = {
  mode: 'research' | 'evidence' | 'block';
  question: string;
  context: string;
  decision?: Partial<AppAskDecision> & { reason?: string; nextAction?: string };
};
type AppCopilotRoute = 'certified_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer';
type AppCopilotBlockTile = { blockId: string; title: string; viz: string; tileId: string };

interface AppResearchSeed {
  question: string;
  title?: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  context?: unknown;
  intent?: LocalAppInvestigation['intent'];
  generatedSql?: string;
  nonce: number;
}

type CreateInvestigationResult = Awaited<ReturnType<typeof api.createAppInvestigation>>;
const inFlightResearchSeedRequests = new Map<string, Promise<CreateInvestigationResult>>();

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
  const { state, dispatch } = useNotebook();
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
  const [builderPrompt, setBuilderPrompt] = useState(DEFAULT_PROMPT);
  const [builderName, setBuilderName] = useState('Business Analytics');
  const [builderDomain, setBuilderDomain] = useState('');
  const [builderOwner, setBuilderOwner] = useState('analytics');
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedBlocks, setSelectedBlocks] = useState<Set<string>>(() => new Set());
  const [generated, setGenerated] = useState<GenerateAppResponse | null>(null);
  const [buildSession, setBuildSession] = useState<AppAiBuildSession | null>(null);
  const [proposalSelection, setProposalSelection] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [builderSaving, setBuilderSaving] = useState(false);
  const [addPageOpen, setAddPageOpen] = useState(false);
  const [addPageTitle, setAddPageTitle] = useState('');
  const [addPageError, setAddPageError] = useState<string | null>(null);
  const [dashboardFilterValues, setDashboardFilterValues] = useState<Record<string, unknown>>({});
  const [smartView, setSmartView] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    void api.listApps().then((apps) => {
      if (cancelled) return;
      dispatch({ type: 'SET_APPS', apps });
      dispatch({ type: 'SET_APPS_LOADING', loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    void api.getPersona().then((persona) => dispatch({ type: 'SET_ACTIVE_PERSONA', persona }));
  }, [dispatch]);

  useEffect(() => {
    if (surface !== 'create') return;
    let cancelled = false;
    setCatalogLoading(true);
    void api.recommendAppBlocks({
      domain: builderDomain || undefined,
      purpose: builderPrompt,
      audience: 'stakeholder',
      certifiedOnly: true,
    }).then((blocks) => {
      if (!cancelled) setCatalog(blocks);
    }).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });
    return () => {
      cancelled = true;
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
    void api.getApp(state.activeAppId).then((doc) => {
      if (!cancelled) setAppDoc(doc);
    });
    if (state.activeDashboardId) {
      void api.getDashboard(state.activeAppId, state.activeDashboardId).then((doc) => {
        if (!cancelled) setDashboardDoc(doc);
      }).finally(() => {
        if (!cancelled) setAppLoading(false);
      });
    } else {
      setDashboardDoc(null);
      setAppLoading(false);
    }
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

  const startAiBuilder = (prompt = builderPrompt, domain?: string) => {
    setBuilderMode('ai');
    setBuilderPrompt(prompt);
    setBuilderDomain(domain ?? '');
    setSelectedBlocks(new Set());
    setBuilderError(null);
    setGenerated(null);
    setBuildSession(null);
    setSurface('create');
    window.setTimeout(() => { void runGenerate(prompt); }, 240);
  };

  const startClassicBuilder = () => {
    setBuilderMode('classic');
    setBuilderError(null);
    setGenerated(null);
    setBuildSession(null);
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

  const runGenerate = async (promptOverride?: string) => {
    const prompt = (promptOverride ?? builderPrompt).trim();
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
          ...catalog
            .filter((block) => block.status === 'certified')
            .slice(0, 6)
            .map((block) => block.id),
        ]));
    // Two-phase build: propose first (no files) — the user reviews the content
    // list with per-tile toggles and confirms before anything is created.
    const [sessionResult] = await Promise.all([
      api.proposeAppAiBuild({
        prompt,
        domain: builderDomain.trim() || undefined,
        owner: builderOwner.trim() || undefined,
        force: false,
        selectedBlockIds: preferredBlockIds,
        plannerMode: 'ai_assisted',
      }),
      new Promise((resolve) => window.setTimeout(resolve, 1_400)),
    ]);
    setBuilderSaving(false);
    if (!sessionResult.ok) {
      setBuilderError(sessionResult.error);
      if (sessionResult.session) setBuildSession(sessionResult.session);
      return;
    }
    const session = sessionResult.session;
    setBuildSession(session);
    setGenerated(null);
    setProposalSelection(session.proposal ? defaultProposalSelection(session.proposal) : new Set());
    const planName = (session.plan as GeneratedAppPlan | undefined)?.name;
    if (planName) setBuilderName(planName);
  };

  const toggleProposalTile = (tileId: string) => {
    setProposalSelection((current) => {
      const next = new Set(current);
      if (next.has(tileId)) next.delete(tileId);
      else next.add(tileId);
      return next;
    });
  };

  const runCommitProposal = async () => {
    if (!buildSession || buildSession.status !== 'proposed') return;
    setCommitting(true);
    setBuilderError(null);
    const result = await api.commitAppAiBuild(buildSession.id, {
      selectedTileIds: Array.from(proposalSelection),
    });
    setCommitting(false);
    if (!result.ok) {
      setBuilderError(result.error);
      return;
    }
    const session = result.session;
    setBuildSession(session);
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
    await refreshApps(result.app?.id ?? response.plan.appId, result.dashboardId, 'workspace', { experience: 'view', section: 'dashboards' });
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

  const createDashboardPage = async () => {
    if (!state.activeAppId) return;
    const title = addPageTitle.trim();
    if (!title) {
      setAddPageError('Enter a dashboard page name.');
      return;
    }
    setAddPageError(null);
    const result = await api.createAppDashboard(state.activeAppId, { title });
    if (!result.ok) {
      setAddPageError(result.error);
      return;
    }
    setAddPageOpen(false);
    setAddPageTitle('');
    dispatch({
      type: 'OPEN_APP',
      appId: state.activeAppId,
      dashboardId: result.dashboard.id,
      experience,
      section,
    });
    await refreshApps(state.activeAppId, result.dashboard.id, 'workspace');
  };

  const dashboardVariables = useMemo(() => ({
    ...dashboardFilterValues,
    smartView,
  }), [dashboardFilterValues, smartView]);

  const handleDashboardFilterChange = useCallback((filter: DashboardFilter, value: unknown) => {
    setDashboardFilterValues((current) => ({
      ...current,
      [filter.id]: coerceDashboardFilterValue(filter, value),
    }));
  }, []);

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
          onStartAi={(prompt) => startAiBuilder(prompt)}
          onStartClassic={startClassicBuilder}
          onOpenApp={openApp}
        />
      ) : surface === 'create' ? (
        <AppCreateSurface
          mode={builderMode}
          appName={builderName}
          prompt={builderPrompt}
          domain={builderDomain}
          owner={builderOwner}
          promptExamples={APP_PROMPT_EXAMPLES}
          catalog={catalog}
          catalogLoading={catalogLoading}
          selectedBlocks={selectedBlocks}
          generated={generated}
          buildSession={buildSession}
          proposalSelection={proposalSelection}
          committing={committing}
          themeMode={state.themeMode}
          onToggleProposalTile={toggleProposalTile}
          onCommitProposal={() => void runCommitProposal()}
          saving={builderSaving}
          error={builderError}
          onBack={() => setSurface('library')}
          onStartOver={() => { setBuildSession(null); setGenerated(null); setProposalSelection(new Set()); setBuilderError(null); }}
          onModeChange={(nextMode) => {
            setBuilderMode(nextMode);
            if (nextMode === 'ai') setSelectedBlocks(new Set());
          }}
          onAppNameChange={setBuilderName}
          onPromptChange={setBuilderPrompt}
          onDomainChange={setBuilderDomain}
          onOwnerChange={setBuilderOwner}
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
          dashboardFilters={dashboardFilters}
          dashboardFilterValues={dashboardFilterValues}
          smartView={smartView}
          themeMode={state.themeMode}
          variables={dashboardVariables}
          onBack={() => setSurface('library')}
          onExperienceChange={setExperience}
          onSectionChange={setSection}
          onDashboardFilterChange={handleDashboardFilterChange}
          onSmartViewChange={setSmartView}
          onExplainChange={setExplainOpen}
          onAddPage={() => setAddPageOpen(true)}
          onOpenDashboard={(dashboardId) => dispatch({ type: 'OPEN_DASHBOARD', dashboardId })}
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
          error={addPageError}
          onChange={setAddPageTitle}
          onCancel={() => {
            setAddPageOpen(false);
            setAddPageError(null);
          }}
          onCreate={() => void createDashboardPage()}
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
  onStartAi: (prompt: string) => void;
  onStartClassic: () => void;
  onOpenApp: (app: AppSummary, experience?: AppExperience) => void;
}) {
  const counts = libraryCounts(allApps, favorites);
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_PROMPT);
  const submitPrompt = () => {
    const trimmed = draftPrompt.trim();
    if (!trimmed) return;
    onStartAi(trimmed);
  };
  return (
    <main className="dql-apps-wrap">
      <section className="dql-apps-createhead">
        <h1>Build an app</h1>
        <p>Start with one stakeholder request. DQL finds certified blocks, app filters, and analysis gaps before opening the generated app view.</p>
      </section>

      <section className="dql-apps-ai-entry" aria-label="Build an app with AI">
        <div className="dql-apps-ai-entry-head">
          <span><Sparkles size={14} /> AI app builder</span>
          <b>Certified blocks first</b>
        </div>
        <div className="dql-apps-ai-entry-box">
          <textarea
            value={draftPrompt}
            onChange={(event) => setDraftPrompt(event.target.value)}
            rows={3}
            aria-label="App build request"
            placeholder="Build an NBA player performance app for stakeholders..."
          />
          <button type="button" onClick={submitPrompt} disabled={!draftPrompt.trim()} title="Review matched context">
            <Send size={16} /> Continue
          </button>
        </div>
        <div className="dql-apps-ai-entry-foot">
          <div>
            {APP_PROMPT_EXAMPLES.slice(0, 3).map((item) => (
              <button key={item.title} type="button" onClick={() => setDraftPrompt(item.prompt)}>
                {item.title}
              </button>
            ))}
          </div>
          <button type="button" className="dql-apps-ai-entry-secondary" onClick={onStartClassic}>
            <LayoutDashboard size={14} /> Create blank
            <ArrowRight size={13} />
          </button>
        </div>
      </section>

      <div className="dql-apps-sectionhead">
        <span>App library</span>
        <i />
        <b>{allApps.length} total</b>
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
              onOpen={(experience) => onOpenApp(app, experience)}
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
}: {
  app: AppSummary;
  favorite: boolean;
  onToggleFavorite: () => void;
  onOpen: (experience: AppExperience) => void;
}) {
  const certified = app.certification === 'certified' || app.lifecycle === 'certified';
  const draftCount = app.drafts?.length ?? 0;
  const researchCount = app.investigations ?? 0;
  const aiPinCount = app.aiPins ?? 0;
  const trustLabel = certified ? 'Certified app' : draftCount > 0 || researchCount > 0 || aiPinCount > 0 ? 'Review needed' : 'Draft app';
  return (
    <article className="dql-app-card">
      <div className="dql-app-card-body" onClick={() => onOpen('view')} role="button" tabIndex={0}>
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
        <div className="dql-app-card-actions">
          <button type="button" onClick={() => onOpen('view')}><Eye size={12} /> View</button>
          <button type="button" onClick={() => onOpen('build')}><Pencil size={12} /> Edit</button>
        </div>
      </div>
    </article>
  );
}

function AppCreateSurface({
  mode,
  appName,
  prompt,
  domain,
  owner,
  promptExamples,
  catalog,
  catalogLoading,
  selectedBlocks,
  generated,
  buildSession,
  proposalSelection,
  committing,
  themeMode,
  onToggleProposalTile,
  onCommitProposal,
  saving,
  error,
  onBack,
  onStartOver,
  onModeChange,
  onAppNameChange,
  onPromptChange,
  onDomainChange,
  onOwnerChange,
  onToggleBlock,
  onBuild,
  onOpenGenerated,
}: {
  mode: BuilderMode;
  appName: string;
  prompt: string;
  domain: string;
  owner: string;
  promptExamples: AppPromptExample[];
  catalog: AppBlockRecommendation[];
  catalogLoading: boolean;
  selectedBlocks: Set<string>;
  generated: GenerateAppResponse | null;
  buildSession: AppAiBuildSession | null;
  proposalSelection: Set<string>;
  committing: boolean;
  themeMode: ThemeMode;
  onToggleProposalTile: (tileId: string) => void;
  onCommitProposal: () => void;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onStartOver: () => void;
  onModeChange: (mode: BuilderMode) => void;
  onAppNameChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onDomainChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onToggleBlock: (blockId: string) => void;
  onBuild: () => void;
  onOpenGenerated: () => void;
}) {
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
  if (saving && mode === 'ai' && !proposal && !generated) {
    return (
      <div className="dql-app-building-stage">
        <button type="button" className="dql-app-back dql-app-back-label" onClick={onBack}><ArrowLeft size={14} /><span>Apps</span></button>
        <div className="dql-app-building-thread">
          <div className="dql-app-building-prompt">{prompt}</div>
          <div className="dql-app-building-progress">
            <span className="dql-app-building-orb"><Sparkles size={16} /></span>
            <div>
              <h2>Finding certified blocks…</h2>
              <p>Building a governed proposal from the real project catalog.</p>
              <ol>
                <li><Check size={12} /> Matched domain <b>{contextDomainLabel}</b></li>
                <li><Check size={12} /> Searching certified blocks and trusted dimensions</li>
                <li><Workflow size={12} /> Detecting app filters from block parameters…</li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (proposal && !generated) {
    const proposalFilters = plan.globalFilters?.length ? plan.globalFilters : plan.pages[0]?.filters ?? [];
    return <div className="dql-app-building-stage dql-app-proposal-stage">
      <button type="button" className="dql-app-back dql-app-back-label" onClick={onBack}><ArrowLeft size={14} /><span>Apps</span></button>
      <div className="dql-app-building-thread dql-app-proposal-thread">
        <div className="dql-app-building-prompt">{prompt}</div>
        <section className="dql-app-proposal-card">
          <div className="dql-app-proposal-title"><span className="dql-app-building-orb"><Sparkles size={15} /></span><div><h1>Review the proposed app</h1><p>DQL matched certified blocks and detected reusable app filters. Choose exactly what should be created.</p></div></div>
          <AppBuildProposalPanel proposal={proposal} t={themes[themeMode]} selected={proposalSelection} onToggle={onToggleProposalTile} onCreate={onCommitProposal} busy={committing} error={error} />
          <details className="dql-app-proposal-more"><summary><Plus size={13} /> Add more blocks</summary><div>{catalog.filter((block) => !proposal.tiles.some((tile) => tile.blockId === block.id)).slice(0, 8).map((block) => <button key={block.id} type="button" onClick={() => onToggleBlock(block.id)} className={selectedBlocks.has(block.id) ? 'selected' : ''}><span>{selectedBlocks.has(block.id) ? <Check size={11} /> : <Plus size={11} />}</span><b>{block.name}</b><small>{block.status}</small></button>)}{!catalog.length && <span className="dql-app-proposal-empty">No additional certified blocks are available for this scope.</span>}</div></details>
          <div className="dql-app-proposal-filters"><b>Detected filters</b><div>{proposalFilters.slice(0, 5).map((filter) => <span key={filter.id}><small>{filter.label}</small>{formatVariableValue(filter.default ?? 'Any')}</span>)}{proposalFilters.length === 0 && <><span><small>Domain</small>{contextDomainLabel}</span><span><small>Owner</small>{contextOwnerLabel}</span><span><small>Top N</small>Any</span></>}</div></div>
          <button type="button" className="dql-apps-btn dql-apps-btn-line dql-app-proposal-reset" onClick={onStartOver}>Start over</button>
        </section>
      </div>
    </div>;
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
        <div className="dql-app-mode-seg">
          <button type="button" className={mode === 'ai' ? 'on' : ''} onClick={() => onModeChange('ai')}>
            <Sparkles size={15} /> Build AI
          </button>
          <button type="button" className={mode === 'classic' ? 'on' : ''} onClick={() => onModeChange('classic')}>
            <Blocks size={15} /> Classic
          </button>
        </div>
        <div className="dql-app-build-actions">
          <span className="dql-app-persona"><b>CFO</b> CFO</span>
          {generated ? <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onOpenGenerated}>Open app</button> : null}
          <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onBuild} disabled={saving}>
            {saving ? 'Building...' : mode === 'ai' ? 'Generate app' : 'Create app'}
          </button>
        </div>
      </div>

      <div className={`dql-app-create-workspace clean ${mode === 'classic' ? 'classic' : 'ai'}`}>
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
                  onDomainChange(item.domain);
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
                <label>Domain<input value={domain} onChange={(event) => onDomainChange(event.target.value)} /></label>
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
                  onCreate={onCommitProposal}
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

function AppWorkspaceSurface({
  app,
  appDoc,
  dashboardDoc,
  loading,
  experience,
  section,
  explainOpen,
  dashboardFilters,
  dashboardFilterValues,
  smartView,
  themeMode,
  variables,
  onBack,
  onExperienceChange,
  onSectionChange,
  onDashboardFilterChange,
  onSmartViewChange,
  onExplainChange,
  onAddPage,
  onOpenDashboard,
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
  dashboardFilters: DashboardFilter[];
  dashboardFilterValues: Record<string, unknown>;
  smartView: boolean;
  themeMode: ThemeMode;
  variables: Record<string, unknown>;
  onBack: () => void;
  onExperienceChange: (experience: AppExperience) => void;
  onSectionChange: (section: AppSection) => void;
  onDashboardFilterChange: (filter: DashboardFilter, value: unknown) => void;
  onSmartViewChange: (value: boolean) => void;
  onExplainChange: (value: boolean) => void;
  onAddPage: () => void;
  onOpenDashboard: (dashboardId: string) => void;
  onDashboardChanged: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  onInvestigationsChanged: (investigations: LocalAppInvestigation[]) => void;
  onOpenLineageNode: (nodeId: string) => void;
}) {
  const { dispatch } = useNotebook();
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
    setPromoteMessage(`${result.paths.length} shared files updated${result.removedLocalTiles ? `, ${result.removedLocalTiles} local AI tile removed` : ''}.`);
    window.setTimeout(() => setPromoteStatus('idle'), 2400);
  };
  const onDashboards = section === 'dashboards' && Boolean(dashboardDoc);
  return (
    <div className="dql-app-workspace">
      <div className="dql-app-view-topbar">
        <button type="button" className="dql-app-back" onClick={onBack} title="Back to apps"><ArrowLeft size={16} /></button>
        <span className="dql-app-crumb"><b>{app?.id ?? 'app'}</b></span>
        <StatusSeal tone="certified">{certifiedCount} certified</StatusSeal>
        {draftCount > 0 ? <StatusSeal tone="draft">{draftCount} draft</StatusSeal> : null}

        <span className="dql-app-topbar-divider" aria-hidden="true" />

        <div className="dql-app-topbar-filters">
          <DashboardFilterControls
            filters={dashboardFilters}
            values={dashboardFilterValues}
            onChange={onDashboardFilterChange}
          />
          <Toggle label="Smart view" checked={smartView} onChange={onSmartViewChange} />
        </div>

        <div className="dql-app-view-actions">
          <PersonaSwitcher app={appDoc?.app ?? null} />
          <div className="dql-app-view-edit" aria-label="App mode">
            <button type="button" className={experience === 'view' ? 'on' : ''} onClick={() => onExperienceChange('view')}><Eye size={13} /> View</button>
            <button type="button" className={experience === 'build' ? 'on' : ''} onClick={() => onExperienceChange('build')}><Pencil size={13} /> Edit</button>
          </div>
          {experience === 'build' ? (
            <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void promoteApp()} disabled={promoteStatus === 'running'}>
              <ShieldCheck size={14} /> {promoteStatus === 'running' ? 'Promoting' : 'Promote'}
            </button>
          ) : null}
          <button type="button" className="dql-apps-btn dql-apps-btn-line" title={shareStatus === 'copied' ? 'Copied handoff' : 'Share local app handoff'} onClick={() => void copyShareLink()}>
            {shareStatus === 'copied' ? <Check size={15} /> : <Share2 size={15} />} Share
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
            <h1>{tidyTitle(onDashboards ? dashboardDoc?.dashboard.metadata.title : app?.name) || 'App'}</h1>
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
                className={`dql-apps-btn dql-apps-btn-line ${explainOpen ? 'on' : ''}`}
                title={explainOpen ? 'Hide AI copilot' : 'Show AI copilot'}
                onClick={() => onExplainChange(!explainOpen)}
              >
                <Bot size={15} /> Copilot
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
            <AppCopilotPanel
              app={app}
              appDoc={appDoc}
              dashboardDoc={dashboardDoc}
              dashboardRun={dashboardRun}
              variables={variables}
              selectedBlockId={selectedBlockId}
              askSeed={askSeed}
              activeInvestigation={section === 'research' ? activeInvestigation : null}
              themeMode={themeMode}
              onSelectBlock={setSelectedBlockId}
              onStartResearch={handleStartResearch}
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

function AppCopilotPanel({
  app,
  appDoc,
  dashboardDoc,
  dashboardRun,
  variables,
  selectedBlockId,
  askSeed,
  activeInvestigation,
  themeMode,
  onSelectBlock,
  onStartResearch,
}: {
  app: AppSummary | null;
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  dashboardRun: DashboardRunResponse | null;
  variables: Record<string, unknown>;
  selectedBlockId: string | null;
  askSeed?: { text: string; nonce: number } | null;
  activeInvestigation?: LocalAppInvestigation | null;
  themeMode: ThemeMode;
  onSelectBlock: (blockId: string | null) => void;
  onStartResearch: (seed: Omit<AppResearchSeed, 'nonce'>) => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [directQuestion, setDirectQuestion] = useState('');
  const [directBusy, setDirectBusy] = useState(false);
  const [directAnswer, setDirectAnswer] = useState<Awaited<ReturnType<typeof api.askApp>> | null>(null);
  const [directError, setDirectError] = useState<string | null>(null);
  const [submittedQuestion, setSubmittedQuestion] = useState('');
  const [pendingAction, setPendingAction] = useState<{
    mode: 'research' | 'evidence' | 'block';
    question: string;
    title: string;
    submitLabel: string;
    help: string;
  } | null>(null);
  const [analysisHandoff, setAnalysisHandoff] = useState<AppAnalysisHandoff | null>(null);
  const [contextDraft, setContextDraft] = useState('');
  const [contextError, setContextError] = useState<string | null>(null);
  const answerTheme = themes[themeMode];
  const blockTiles = useMemo(() => {
    return getCopilotBlockTiles(dashboardDoc?.dashboard ?? null, dashboardRun);
  }, [dashboardDoc, dashboardRun]);
  const selectedBlock = blockTiles.find((item) => item.blockId === selectedBlockId) ?? blockTiles[0] ?? null;
  const tileRunFor = (block: Pick<AppCopilotBlockTile, 'blockId' | 'tileId'> | null | undefined) => block
    ? dashboardRun?.tiles.find((tile) => tile.tileId === block.tileId || tile.blockId === block.blockId)
    : null;
  const contextForBlock = (block: AppCopilotBlockTile | null) => {
    if (!block) return null;
    const tileRun = tileRunFor(block);
    return {
      ...block,
      blockPath: tileRun?.blockPath,
      status: tileRun?.status,
      certificationStatus: tileRun?.certificationStatus,
      rowCount: tileRun?.result?.rowCount,
      columns: tileRun?.result?.columns?.slice(0, 8),
      sampleRows: sampleDashboardRows(tileRun?.result?.rows, tileRun?.result?.columns),
    };
  };
  const selectedTileRun = tileRunFor(selectedBlock);
  const selectedBlockContext = contextForBlock(selectedBlock);
  const activeAnalysisHandoff = useMemo(() => (
    activeInvestigation ? appAnalysisHandoffFromInvestigation(activeInvestigation) : null
  ), [activeInvestigation]);

  const dashboardMeta = dashboardDoc?.dashboard.metadata;
  const domainLabel = formatBusinessLabel(app?.domain ?? dashboardMeta?.domain ?? 'Business');
  const focusTitle = formatBusinessLabel(selectedBlock?.title ?? dashboardMeta?.title ?? app?.name ?? 'Dashboard');
  const businessOutcome = dashboardMeta?.businessOutcome
    ?? app?.description
    ?? dashboardMeta?.description
    ?? 'Understand business movement, decision relevance, and the next operating action.';
  const decisionUse = dashboardMeta?.decisionUse
    ?? 'Review performance, isolate drivers, and decide the next operating action.';
  const audience = dashboardMeta?.audience ?? app?.audience ?? 'Leadership';
  const owner = dashboardMeta?.businessOwner ?? app?.owners?.[0] ?? 'Local owner';
  const cadence = dashboardMeta?.reviewCadence ?? 'On demand';
  const selectedRows = selectedTileRun?.result?.rowCount ?? selectedTileRun?.result?.rows?.length;
  const selectedColumns = selectedTileRun?.result?.columns?.length ?? 0;
  const focusStatus = selectedTileRun?.status === 'ok'
    ? 'Current result loaded'
    : selectedTileRun?.status === 'error'
      ? 'Needs attention'
      : selectedTileRun?.status === 'unauthorized'
        ? 'Access limited'
        : dashboardRun
          ? 'Waiting for result'
          : 'Ready to ask';
  const focusDetail = selectedBlock
    ? 'The selected tile grounds the answer. Deeper analysis still needs typed business context before SQL is created.'
    : 'Ask across the dashboard. The copilot answers in business language first and keeps source trace in the appendix.';
  const businessFacts = [
    { label: 'Audience', value: audience },
    { label: 'Owner', value: owner },
    { label: 'Cadence', value: cadence },
  ];
  const draftCount = appDoc?.drafts?.length ?? 0;
  const focusMetric = typeof selectedRows === 'number'
    ? `${selectedRows.toLocaleString()} rows${selectedColumns ? ` / ${selectedColumns} fields` : ''}`
    : focusStatus;
  const activeFilters = useMemo(() => Object.entries(variables ?? {})
    .filter(([key]) => key !== 'smartView')
    .map(([key, value]) => `${formatBusinessLabel(key)}: ${formatVariableEntryValue(key, value)}`), [variables]);
  const activeFilterSummary = activeFilters.length ? activeFilters.join(', ') : 'No dashboard filters set';

  const availableBlockContext = blockTiles.map((block) => ({
    blockId: block.blockId,
    title: block.title,
    viz: block.viz,
    status: tileRunFor(block)?.status,
    rowCount: tileRunFor(block)?.result?.rowCount,
  }));
  const buildContextPayload = (blockContext: ReturnType<typeof contextForBlock> = selectedBlockContext) => ({
    scope: 'dashboard',
    contextPolicy: {
      retrieval: 'question_first',
      focusBlockUse: blockContext ? 'soft_context_only' : 'none',
      rule: 'Use the selected tile to understand the app, but do not restrict retrieval or SQL generation to that block unless the question explicitly asks about this tile.',
    },
    responseStyle: {
      audience: 'CXO and business stakeholder',
      firstResponse: 'Start with a plain-language business answer and recommended action.',
      evidenceRule: 'Keep block ids, SQL, lineage, and implementation details in proof sections unless the user asks for them.',
    },
    appId: app?.id,
    appName: app?.name,
    dashboardId: dashboardDoc?.dashboard.id,
    dashboardTitle: dashboardDoc?.dashboard.metadata.title,
    domain: app?.domain ?? dashboardDoc?.dashboard.metadata.domain,
    businessOutcome,
    decisionUse,
    audience,
    owner,
    reviewCadence: cadence,
    activeFilters: variables,
    focusBlock: blockContext,
    availableBlocks: availableBlockContext,
  });
  const parseCopilotCommand = (value: string): { mode: 'ask' | 'research' | 'evidence' | 'block'; context: string } => {
    const trimmed = value.trim();
    const commands: Array<{ mode: 'ask' | 'research' | 'evidence' | 'block'; pattern: RegExp }> = [
      { mode: 'research', pattern: /^\/research\b/i },
      { mode: 'research', pattern: /^\/report\b/i },
      { mode: 'research', pattern: /^\/analy[sz]e\b/i },
      { mode: 'research', pattern: /^\/analysis\b/i },
      { mode: 'evidence', pattern: /^\/validate\b/i },
      { mode: 'evidence', pattern: /^\/verify\b/i },
      { mode: 'evidence', pattern: /^\/evidence\b/i },
      { mode: 'evidence', pattern: /^\/proof\b/i },
      { mode: 'block', pattern: /^\/add\s+block\b/i },
      { mode: 'block', pattern: /^\/create\s+block\b/i },
      { mode: 'block', pattern: /^\/draft\s+block\b/i },
      { mode: 'block', pattern: /^\/block\b/i },
      { mode: 'ask', pattern: /^\/ask\b/i },
    ];

    for (const command of commands) {
      if (command.pattern.test(trimmed)) {
        return { mode: command.mode, context: trimmed.replace(command.pattern, '').trim() };
      }
    }

    return { mode: 'ask', context: trimmed };
  };
  const defaultContextForAction = (mode: 'research' | 'evidence' | 'block', question: string): string => {
    if (mode === 'block') {
      return `Reusable block goal: ${question}
Parameters or filters:
Output grain:
Business use:`;
    }
    if (mode === 'evidence') {
      return `Proof question: ${question}
Claim or number to validate:
Accepted filters:
Decision that depends on this proof:`;
    }
    return `Analysis goal: ${question}
Comparison or segment:
Timeframe:
Decision this should support:`;
  };
  const actionComposerConfig = (mode: 'research' | 'evidence' | 'block') => ({
    research: {
      title: 'Add analysis context',
      submitLabel: 'Create memo',
      help: 'Add the comparison, segment, timeframe, or decision context. DQL opens a main-canvas analyst memo with numbers and narrative, with SQL and trace details kept in the appendix.',
    },
    evidence: {
      title: 'Add proof context',
      submitLabel: 'Create proof brief',
      help: 'Name the claim, number, filter, or source you want checked. The answer stays narrative-first, with SQL and trace details kept in the appendix.',
    },
    block: {
      title: 'Describe reusable logic',
      submitLabel: 'Create logic brief',
      help: 'Describe the reusable business question, dynamic filters, output grain, and why this should become a DQL block.',
    },
  }[mode]);
  const openContextComposer = (
    mode: 'research' | 'evidence' | 'block',
    questionOverride?: string,
    options?: { preserveAnswer?: boolean },
  ) => {
    const question = (questionOverride ?? directQuestion).trim()
      || (directAnswer?.ok ? directAnswer.followUps[0] : '')
      || 'Investigate this app result';
    if (!options?.preserveAnswer) {
      setDirectAnswer(null);
      setAnalysisHandoff(null);
      setDirectError(null);
      setSubmittedQuestion('');
    }
    const config = actionComposerConfig(mode);
    setPendingAction({ mode, question, ...config });
    setContextDraft(defaultContextForAction(mode, question));
    setContextError(null);
  };
  const closeContextComposer = () => {
    setPendingAction(null);
    setContextError(null);
  };
  const askAppDirect = async (questionOverride?: string) => {
    const rawQuestion = (questionOverride ?? directQuestion).trim();
    if (!rawQuestion || !app?.id) return;
    const command = parseCopilotCommand(rawQuestion);
    if (command.mode !== 'ask') {
      openContextComposer(command.mode, command.context || rawQuestion);
      return;
    }
    const question = command.context || rawQuestion;
    setDirectBusy(true);
    setDirectError(null);
    setAnalysisHandoff(null);
    setSubmittedQuestion(question);
    const response = await api.askApp(app.id, {
      question,
      dashboardId: dashboardDoc?.dashboard.id,
      tileId: selectedBlock?.tileId,
      blockId: selectedBlock?.blockId,
      context: buildContextPayload(selectedBlockContext),
      variables,
      runInvestigation: false,
    });
    setDirectBusy(false);
    setDirectAnswer(response);
    setPendingAction(null);
    if (!response.ok) {
      setDirectError(response.error);
      return;
    }
    if (response.route === 'investigation') {
      const config = actionComposerConfig('research');
      setPendingAction({ mode: 'research', question, ...config });
      setContextDraft(defaultContextForAction('research', question));
      setContextError(null);
    }
  };
  useEffect(() => {
    if (!askSeed?.text) return;
    setDirectQuestion(askSeed.text);
    void askAppDirect(askSeed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askSeed?.nonce]);
  const submitContextualAction = () => {
    if (!pendingAction) return;
    const userContext = contextDraft.trim();
    if (!userContext) {
      setContextError('Add the question or analysis context first.');
      return;
    }
    const researchBlockContext = selectedBlockContext;
    const researchContextPayload = buildContextPayload(researchBlockContext);
    const modeIntent = pendingAction.mode === 'evidence' ? 'trust_gap_review' : researchIntentFromPrompt(userContext);
    onStartResearch({
      question: pendingAction.question,
      title: reportTitleForAction(pendingAction.mode, pendingAction.question),
      dashboardId: dashboardDoc?.dashboard.id,
      sourceTileId: selectedBlock?.tileId,
      sourceBlockId: selectedBlock?.blockId,
      context: {
        ...researchContextPayload,
        actionMode: pendingAction.mode,
        userProvidedContext: userContext,
        activeFilterSummary,
        originatingAnswer: directAnswer?.ok ? {
          route: directAnswer.route,
          answer: directAnswer.answer,
          followUps: directAnswer.followUps,
          citations: directAnswer.citations,
          decision: directAnswer.decision,
        } : undefined,
        routeDecision: directAnswer?.ok ? directAnswer.decision : undefined,
      },
      intent: modeIntent,
    });
    setAnalysisHandoff({
      mode: pendingAction.mode,
      question: pendingAction.question,
      context: userContext,
      decision: directAnswer?.ok ? directAnswer.decision : undefined,
    });
    setSubmittedQuestion(pendingAction.question);
    setDirectAnswer(null);
    closeContextComposer();
  };
  const promptStarters = [
    {
      label: 'Explain',
      mode: 'ask' as const,
      icon: <MessageSquareText size={14} />,
      prompt: selectedBlock
        ? `/ask Explain ${selectedBlock.title} for an executive audience. Start with the business meaning, decision relevance, and recommended action.`
        : '/ask Explain this dashboard for an executive audience. Start with the business story, decision impact, and recommended action.',
    },
    {
      label: 'Investigate',
      mode: 'research' as const,
      icon: <LineChart size={14} />,
      prompt: selectedBlock
        ? `Drill into the main drivers behind ${selectedBlock.title}. Use current app filters and compare the top contributing fields.`
        : 'Drill into the main drivers behind this dashboard. Use current filters and compare the top contributing fields.',
    },
    {
      label: 'Create block draft',
      mode: 'block' as const,
      icon: <ShieldCheck size={14} />,
      prompt: selectedBlock
        ? `Turn ${selectedBlock.title} into a reusable parameterized DQL block if the analysis validates the logic.`
        : 'Create a reusable parameterized DQL block from the reviewed app analysis.',
    },
  ];
  const answerFollowUps = directAnswer?.ok
    ? (directAnswer.route === 'investigation' || directAnswer.route === 'app_change_proposal'
      ? ['Add analysis context', 'Check proof', 'Create block draft']
      : directAnswer.followUps.slice(0, 3))
    : [];
  const handleAnswerFollowUp = (followUp: string) => {
    if (!directAnswer?.ok) return;
    if (directAnswer.route === 'certified_answer' || directAnswer.route === 'metadata_answer') {
      setDirectQuestion(followUp);
      void askAppDirect(followUp);
      return;
    }
    const mode = /validate|proof|evidence/i.test(followUp)
      ? 'evidence'
      : /draft|block|logic/i.test(followUp)
        ? 'block'
        : 'research';
    openContextComposer(mode, followUp, { preserveAnswer: true });
  };
  const visibleAnalysisHandoff = analysisHandoff ?? activeAnalysisHandoff;
  return (
    <aside className="dql-app-explain-panel dql-app-assistant-panel">
      <div className="dql-app-assistant-top">
        <div className="dql-app-assistant-title-row">
          <div className="dql-app-assistant-icon"><Bot size={15} /></div>
          <div className="dql-app-assistant-heading">
            <span className="dql-app-assistant-kicker">App Copilot</span>
            <h3 title={app?.name ?? dashboardMeta?.title ?? focusTitle}>{formatBusinessLabel(app?.name ?? dashboardMeta?.title ?? 'App workspace')}</h3>
          </div>
          <button
            type="button"
            className={`dql-app-assistant-context-btn ${evidenceOpen ? 'on' : ''}`}
            onClick={() => setEvidenceOpen((value) => !value)}
            title="Show app grounding context"
          >
            Context
            <ChevronDown size={13} />
          </button>
        </div>
        <label className="dql-app-assistant-focus">
          <span>Focus</span>
          <select
            value={selectedBlock?.blockId ?? ''}
            onChange={(event) => onSelectBlock(event.target.value || null)}
            title="Choose what the copilot answers about"
          >
            <option value="">Whole dashboard</option>
            {blockTiles.map((block) => (
              <option key={block.tileId} value={block.blockId}>
                {formatBusinessLabel(block.title)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {evidenceOpen ? (
        <div className="dql-app-assistant-context">
          <p>{decisionUse}</p>
          <p>{businessOutcome}</p>
          <div>
            {businessFacts.map((item) => <KeyValueInline key={item.label} label={item.label} value={item.value} />)}
            <KeyValueInline label="Result" value={focusMetric} />
            <KeyValueInline label="Trace rule" value={focusDetail} />
            <KeyValueInline label="Drafts" value={String(draftCount)} />
          </div>
        </div>
      ) : null}

      <div className={`dql-app-one-ai-panel ${pendingAction ? 'is-framing' : ''}`}>
        <div className="dql-app-one-ai-status">
          <span><ShieldCheck size={13} /> Context</span>
          <div>
            <b>{activeFilterSummary}</b>
            <b>{selectedBlock?.title ?? 'Whole dashboard'}</b>
            <b>{focusMetric}</b>
          </div>
        </div>

        <div className="dql-app-copilot-thread">
          {!directAnswer && !visibleAnalysisHandoff && !pendingAction ? (
            <div className="dql-app-copilot-welcome">
              <span>Ask in plain language</span>
              <p>Short follow-ups answer here. Driver, comparison, validation, and reusable-logic questions ask for your scope first, then open a full memo in the main canvas.</p>
            </div>
          ) : null}

          {submittedQuestion && !pendingAction ? (
            <div className="dql-app-user-message">
              <span>You</span>
              <p>{submittedQuestion}</p>
            </div>
          ) : null}

          {directAnswer?.ok && !pendingAction ? (
            <div className="dql-app-direct-answer">
              <div>
                <StatusSeal tone={directAnswer.trustState === 'certified' ? 'certified' : 'draft'}>{formatCopilotRouteLabel(directAnswer.route)}</StatusSeal>
                <span>{formatBusinessLabel(directAnswer.reviewStatus)}</span>
              </div>
              <StructuredAnswerText text={directAnswer.answer} t={answerTheme} compact />
              {answerFollowUps.length ? (
                <div className="dql-app-direct-followups">
                  {answerFollowUps.map((followUp) => (
                    <button key={followUp} type="button" onClick={() => handleAnswerFollowUp(followUp)}>
                      {followUp}
                    </button>
                  ))}
                </div>
              ) : null}
              {directAnswer.route === 'investigation' || directAnswer.route === 'app_change_proposal' ? (
                <div className="dql-app-copilot-next-step">
                  <span>{directAnswer.decision.mode === 'app_change' ? 'App change proposal' : 'Add context first'}</span>
                  <p>{directAnswer.decision.reason} {directAnswer.decision.nextAction}</p>
                  <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={() => openContextComposer(directAnswer.decision.mode === 'app_change' ? 'evidence' : 'research', undefined, { preserveAnswer: true })}>
                    <Search size={13} /> {directAnswer.decision.mode === 'app_change' ? 'Check change' : 'Add context'}
                  </button>
                  {directAnswer.decision.mode !== 'app_change' ? (
                    <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => openContextComposer('block', undefined, { preserveAnswer: true })}>
                      <FileText size={13} /> Create block draft
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {visibleAnalysisHandoff && !pendingAction ? (
            <div className="dql-app-analysis-handoff">
              <span>{visibleAnalysisHandoff.mode === 'block' ? 'Logic brief opened' : visibleAnalysisHandoff.mode === 'evidence' ? 'Proof brief opened' : 'Analysis memo opened'}</span>
              <p>{visibleAnalysisHandoff.decision?.reason ?? 'The main canvas is using the typed context, active filters, certified result, and proof boundary for this analysis.'}</p>
              <small>{visibleAnalysisHandoff.decision?.nextAction ?? 'Review the main-canvas memo, then pin the insight or create a draft block only after validation.'}</small>
              <div>
                <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => {
                  openContextComposer(visibleAnalysisHandoff.mode, visibleAnalysisHandoff.question);
                  setContextDraft(visibleAnalysisHandoff.context);
                }}>
                  Refine context
                </button>
                {visibleAnalysisHandoff.mode !== 'block' ? (
                  <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => openContextComposer('block', visibleAnalysisHandoff.question)}>
                    Create block draft
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {pendingAction ? (
            <div className="dql-app-context-composer">
              <div className="dql-app-context-composer-head">
                <StatusSeal tone="agentic">{formatActionBriefLabel(pendingAction.mode)}</StatusSeal>
                <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={closeContextComposer}>Close</button>
              </div>
              <h4>{pendingAction.title}</h4>
              <p>{pendingAction.help}</p>
              <textarea
                value={contextDraft}
                onChange={(event) => {
                  setContextDraft(event.target.value);
                  if (contextError) setContextError(null);
                }}
                rows={7}
                aria-label={`${formatActionBriefLabel(pendingAction.mode)} context`}
              />
              <div className="dql-app-context-chips">
                <span>{activeFilterSummary}</span>
                <span>{selectedBlock?.title ?? 'Whole dashboard'}</span>
                <span>{focusMetric}</span>
              </div>
              {contextError ? <div className="dql-app-error">{contextError}</div> : null}
              <div className="dql-app-context-actions">
                <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={closeContextComposer}>Cancel</button>
                <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={submitContextualAction}>
                  {pendingAction.submitLabel}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="dql-app-direct-ask">
          <div className="dql-app-direct-ask-row">
            <textarea
              value={directQuestion}
              onChange={(event) => setDirectQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void askAppDirect();
                }
              }}
              rows={2}
              placeholder="Ask a follow-up. Use /ask for a short answer, /research for an analyst memo, or /block for reusable logic..."
            />
            <button type="button" onClick={() => void askAppDirect()} disabled={directBusy || !directQuestion.trim()}>
              <Send size={13} /> {directBusy ? 'Asking' : 'Ask'}
            </button>
          </div>
          <div className="dql-app-direct-quick">
            {promptStarters.map((starter) => (
              <button key={starter.label} type="button" onClick={() => {
                if (starter.mode === 'ask') {
                  setDirectQuestion(starter.prompt);
                  return;
                }
                openContextComposer(starter.mode, starter.prompt);
              }}>
                {starter.icon}{starter.label}
              </button>
            ))}
          </div>
          {directError ? <div className="dql-app-error">{directError}</div> : null}
        </div>
      </div>
    </aside>
  );
}

function ResearchPanel({
  appDoc,
  dashboardDoc,
  seed,
  themeMode,
  onSeedHandled,
  onDashboardChanged,
  onInvestigationsChanged,
  onActiveInvestigationChange,
}: {
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  seed: AppResearchSeed | null;
  themeMode: ThemeMode;
  onSeedHandled: () => void;
  onDashboardChanged: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  onInvestigationsChanged: (investigations: LocalAppInvestigation[]) => void;
  onActiveInvestigationChange: (investigation: LocalAppInvestigation | null) => void;
}) {
  const appId = appDoc?.app.id;
  const activeDashboardId = dashboardDoc?.dashboard.id;
  const t = themes[themeMode];
  const [items, setItems] = useState<LocalAppInvestigation[]>(() => appDoc?.investigations ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<'preview' | 'sql' | 'assumptions' | 'context'>('preview');
  const [sqlDraft, setSqlDraft] = useState('');
  const [showResearchHistory, setShowResearchHistory] = useState(false);
  const [reportNavigatorOpen, setReportNavigatorOpen] = useState(false);
  const [pendingAnalysisTitle, setPendingAnalysisTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!appId) {
      setItems([]);
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api.listAppInvestigations(appId).then((investigations) => {
      if (cancelled) return;
      setError(null);
      setItems(investigations);
      const sorted = sortResearchInvestigations(investigations);
      setSelectedId((current) => current ?? sorted.find((item) => item.status === 'ready')?.id ?? sorted[0]?.id ?? null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  useEffect(() => {
    onInvestigationsChanged(items);
  }, [items, onInvestigationsChanged]);

  useEffect(() => {
    if (!seed || !appId) return;
    let cancelled = false;
    const investigationInput = {
      dashboardId: seed.dashboardId ?? activeDashboardId,
      sourceTileId: seed.sourceTileId,
      sourceBlockId: seed.sourceBlockId,
      title: seed.title,
      question: seed.question,
      intent: seed.intent,
      context: seed.context,
      generatedSql: seed.generatedSql,
      run: true,
    };
    const pendingTitle = cleanResearchScopeText(seed.title ?? seed.question) || 'requested follow-up';
    const seedKey = `${appId}:${JSON.stringify(investigationInput)}`;
    const create = async () => {
      setBusy('create');
      setPendingAnalysisTitle(pendingTitle);
      setError(null);
      let request = inFlightResearchSeedRequests.get(seedKey);
      if (!request) {
        request = api.createAppInvestigation(appId, investigationInput);
        inFlightResearchSeedRequests.set(seedKey, request);
        void request.finally(() => {
          window.setTimeout(() => inFlightResearchSeedRequests.delete(seedKey), 5000);
        });
      }
      const result = await request;
      if (cancelled) return;
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        setPendingAnalysisTitle(null);
        onSeedHandled();
        return;
      }
      const created = result.investigation;
      const applyInvestigation = (investigation: LocalAppInvestigation) => {
        setItems((current) => upsertInvestigation(current, investigation));
        setSelectedId(investigation.id);
        setEvidenceTab('preview');
        setReportNavigatorOpen(false);
        if (investigation.status !== 'draft' && investigation.status !== 'running') {
          setPendingAnalysisTitle(null);
        }
      };
      applyInvestigation(created);
      if (created.status !== 'draft' && created.status !== 'running') {
        onSeedHandled();
        return;
      }
      setBusy(created.id);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 1000);
        });
        if (cancelled) return;
        const refreshed = await api.getAppInvestigation(appId, created.id);
        if (cancelled) return;
        if (refreshed && refreshed.status !== 'draft' && refreshed.status !== 'running') {
          setBusy(null);
          applyInvestigation(refreshed);
          onSeedHandled();
          return;
        }
      }
      onSeedHandled();
      setBusy(null);
      setPendingAnalysisTitle(null);
      setError('Analysis is still running. Reopen it or refresh to load the latest proof.');
    };
    const timer = window.setTimeout(() => void create(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [seed?.nonce, appId, activeDashboardId, onSeedHandled]);

  const sortedItems = useMemo(() => sortResearchInvestigations(items), [items]);
  const selected = sortedItems.find((item) => item.id === selectedId)
    ?? sortedItems.find((item) => item.status === 'ready')
    ?? sortedItems[0]
    ?? null;
  useEffect(() => {
    onActiveInvestigationChange(selected);
    return () => onActiveInvestigationChange(null);
  }, [selected, onActiveInvestigationChange]);
  const recentHistory = sortedItems
    .filter((item) => item.id !== selected?.id)
    .filter((item) => showResearchHistory || item.status !== 'error')
    .slice(0, showResearchHistory ? 40 : 5);
  const hiddenHistoryCount = Math.max(0, sortedItems.length - (selected ? 1 : 0) - recentHistory.length);
  const selectedReport = selected ? buildResearchReport(selected) : null;
  const selectedMemo = selectedReport ? buildResearchMemo(selectedReport) : '';
  const creatingReport = busy === 'create' || Boolean(pendingAnalysisTitle);
  const pendingReportVisible = creatingReport && Boolean(pendingAnalysisTitle);
  const creatingInitialReport = creatingReport && !selected;

  useEffect(() => {
    setSqlDraft(selected?.generatedSql ?? '');
  }, [selected?.id, selected?.generatedSql]);

  const rerunResearch = async (investigation: LocalAppInvestigation, sqlOverride?: string): Promise<LocalAppInvestigation | null> => {
    if (!appId) return null;
    setBusy(investigation.id);
    setError(null);
    const reviewedSql = sqlOverride?.trim();
    const result = await api.runAppInvestigation(appId, investigation.id, reviewedSql ? { generatedSql: reviewedSql } : undefined);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setItems((current) => upsertInvestigation(current, result.investigation));
    setEvidenceTab('preview');
    return result.investigation;
  };

  const rebuildResearchSql = async (investigation: LocalAppInvestigation): Promise<LocalAppInvestigation | null> => {
    if (!appId) return null;
    setBusy(`rebuild:${investigation.id}`);
    setError(null);
    const result = await api.runAppInvestigation(appId, investigation.id, { repairMode: 'rebuild_from_certified' });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setItems((current) => upsertInvestigation(current, result.investigation));
    setEvidenceTab(result.investigation.error ? 'sql' : 'preview');
    return result.investigation;
  };

  const pinResearch = async (investigation: LocalAppInvestigation): Promise<LocalAppInvestigation | null> => {
    if (!appId) return null;
    setBusy(`pin:${investigation.id}`);
    setError(null);
    const result = await api.pinAppInvestigation(appId, investigation.id, {
      dashboardId: investigation.dashboardId ?? activeDashboardId,
      title: investigation.title,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setItems((current) => upsertInvestigation(current, result.investigation));
    setSelectedId(result.investigation.id);
    if (result.dashboard) onDashboardChanged(result.dashboard);
    return result.investigation;
  };

  const promoteResearch = async (investigation: LocalAppInvestigation) => {
    if (!appId) return;
    if (!investigation.generatedSql) {
      setError('Add reviewed SQL before creating a draft block.');
      return;
    }
    const pinned = investigation.pinnedAiPinId ? investigation : await pinResearch(investigation);
    const pinId = pinned?.pinnedAiPinId;
    if (!pinId) return;
    setBusy(`promote:${investigation.id}`);
    setError(null);
    const result = await api.promoteAiPin(appId, pinId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? 'Draft block could not be created.');
      return;
    }
    const refreshed = await api.getAppInvestigation(appId, investigation.id);
    if (refreshed) setItems((current) => upsertInvestigation(current, refreshed));
  };

  const promoteReviewedResearch = async (investigation: LocalAppInvestigation) => {
    const reviewedSql = sqlDraft.trim();
    let target = investigation;
    if (reviewedSql && reviewedSql !== (investigation.generatedSql ?? '').trim()) {
      const rerun = await rerunResearch(investigation, reviewedSql);
      if (!rerun) return;
      target = rerun;
    }
    await promoteResearch(target);
  };

  const pinReviewedResearch = async (investigation: LocalAppInvestigation) => {
    const reviewedSql = sqlDraft.trim();
    let target = investigation;
    if (reviewedSql && reviewedSql !== (investigation.generatedSql ?? '').trim()) {
      const rerun = await rerunResearch(investigation, reviewedSql);
      if (!rerun) return null;
      target = rerun;
    }
    return pinResearch(target);
  };

  if (!appDoc) return <EmptyPanel title="No App selected." detail="Choose an App before writing analysis." />;

  return (
    <div className={`dql-app-research-shell ${reportNavigatorOpen || (!selected && !creatingInitialReport) ? 'history-open' : 'history-collapsed'}`}>
      <section className="dql-app-research-list">
        <div className="dql-app-research-head">
          <span><Search size={14} /> Analysis</span>
          <div>
            <b>{items.length}</b>
            {selected ? (
              <button type="button" onClick={() => setReportNavigatorOpen(false)} title="Close analysis history">
                Close
              </button>
            ) : null}
          </div>
        </div>
        {loading ? <EmptyPanel title="Loading analysis..." detail="Reading local app analysis." compact /> : null}
        {error ? <div className="dql-app-error">{error}</div> : null}
        {!loading && items.length === 0 ? (
          <EmptyPanel title="No analysis yet." detail="Start from Copilot so the analysis keeps the original question, filters, and selected result context." compact />
        ) : null}
        <div className="dql-app-research-items">
          {selected ? (
            <>
              <div className="dql-app-research-group-label">Current analysis</div>
              <ResearchListButton
                item={selected}
                selected
                onClick={() => {
                  setError(null);
                  setSelectedId(selected.id);
                  setEvidenceTab('preview');
                  setReportNavigatorOpen(false);
                }}
              />
            </>
          ) : null}
          {recentHistory.length ? (
            <div className="dql-app-research-group-label">Recent history</div>
          ) : null}
          {recentHistory.map((item) => (
            <ResearchListButton
              key={item.id}
              item={item}
              selected={selected?.id === item.id}
              onClick={() => {
                setError(null);
                setSelectedId(item.id);
                setEvidenceTab('preview');
                setReportNavigatorOpen(false);
              }}
            />
          ))}
          {hiddenHistoryCount > 0 ? (
            <button
              type="button"
              className="dql-app-research-history-toggle"
              onClick={() => setShowResearchHistory((value) => !value)}
            >
              <span>{showResearchHistory ? 'Hide older runs' : `Show ${hiddenHistoryCount} older run${hiddenHistoryCount === 1 ? '' : 's'}`}</span>
              <small>{showResearchHistory ? 'Keep the current analysis focused' : 'Includes failed and superseded analysis attempts'}</small>
            </button>
          ) : null}
        </div>
      </section>

      <section className="dql-app-research-detail">
        {pendingReportVisible ? (
          <>
            <div className="dql-app-report-toolbar">
              <div>
                <span>New memo</span>
                <b>{pendingAnalysisTitle}</b>
              </div>
              {items.length ? (
                <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => setReportNavigatorOpen((value) => !value)}>
                  <Search size={13} /> {reportNavigatorOpen ? 'Hide history' : `Analysis history (${items.length})`}
                </button>
              ) : null}
            </div>
            {error ? <div className="dql-app-error">{error}</div> : null}
            <div className="dql-app-research-creating active">
              <Workflow size={24} />
              <span>Preparing business memo</span>
              <h2>Writing business memo...</h2>
              <p>DQL is opening a scoped memo for "{pendingAnalysisTitle}". The previous memo stays in history while this answer is built from the typed context, active filters, certified block evidence, and preview proof.</p>
              <div className="dql-app-research-creating-steps">
                <small>Reading current filters</small>
                <small>Checking certified block context</small>
                <small>Building narrative and proof appendix</small>
              </div>
            </div>
          </>
        ) : selected && selectedReport ? (
          <>
            <div className="dql-app-report-toolbar">
              <div>
                <span>Current memo</span>
                <b>{formatResearchListTitle(selected)}</b>
              </div>
              <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => setReportNavigatorOpen((value) => !value)}>
                <Search size={13} /> {reportNavigatorOpen ? 'Hide history' : `Memo history (${items.length})`}
              </button>
            </div>
            {creatingReport || busy === selected.id || selected.status === 'running' ? (
              <div className={`dql-app-research-status ${creatingReport ? 'opening' : ''}`}>
                <Workflow size={14} />
                <div>
                  <span>{creatingReport ? 'Opening a new business memo...' : 'Refreshing the memo from certified evidence, active filters, and optional preview proof...'}</span>
                  {pendingAnalysisTitle ? <small>{pendingAnalysisTitle}</small> : null}
                </div>
              </div>
            ) : null}
            {error ? <div className="dql-app-error">{error}</div> : null}

            <article className="dql-app-research-report">
              <header className="dql-app-report-hero">
                <div className="dql-app-report-status-row">
                  <span><Search size={13} /> Business memo</span>
                  <StatusSeal tone={selected.status === 'error' ? 'draft' : 'agentic'}>{selected.reviewStatus}</StatusSeal>
                </div>
                <h2>{selectedReport.title}</h2>
                <p>{selectedReport.scope}</p>
                <div className="dql-app-report-context-line">
                  {selectedReport.contextFacts.map((fact) => (
                    <span key={fact.label}><b>{fact.label}</b>{fact.value}</span>
                  ))}
                </div>
                <div className="dql-app-report-actions">
                  <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void pinReviewedResearch(selected)} disabled={busy === `pin:${selected.id}`}>
                    <MapPin size={13} /> {selected.pinnedAiPinId ? 'Pinned to app' : 'Pin insight'}
                  </button>
                  <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={() => void promoteReviewedResearch(selected)} disabled={!(sqlDraft.trim() || selected.generatedSql) || busy === `promote:${selected.id}`}>
                    <FileText size={13} /> {busy === `promote:${selected.id}` ? 'Drafting...' : 'Create draft block'}
                  </button>
                  <details className="dql-app-report-review-actions">
                    <summary>Reviewer tools</summary>
                    <div>
                      <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void rerunResearch(selected, sqlDraft)} disabled={busy === selected.id}>
                        <Workflow size={13} /> {busy === selected.id ? 'Refreshing...' : 'Refresh memo'}
                      </button>
                      {selectedReport.previewIssue?.canRebuild ? (
                        <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void rebuildResearchSql(selected)} disabled={busy === `rebuild:${selected.id}`}>
                          <Workflow size={13} /> {busy === `rebuild:${selected.id}` ? 'Rebuilding...' : 'Rebuild SQL'}
                        </button>
                      ) : null}
                    </div>
                  </details>
                </div>
                {selectedReport.previewIssue ? (
                  <div className="dql-app-report-warning">
                    <AlertTriangle size={14} />
                    <span>{selectedReport.previewIssue.message}</span>
                  </div>
                ) : null}
              </header>

              <section className="dql-app-report-section dql-app-report-paper">
                {selectedReport.sections.length ? (
                  <ResearchReportSections sections={selectedReport.sections} />
                ) : (
                  <StructuredAnswerText text={selectedMemo} t={t} compact />
                )}
              </section>

              {selectedReport.keyNumbers.length || selectedReport.drivers.length ? (
                <section className={`dql-app-report-section dql-app-report-evidence-story ${selectedReport.keyNumbers.length && selectedReport.drivers.length ? '' : 'single'}`}>
                  {selectedReport.keyNumbers.length ? (
                    <div>
                      <h3>{selectedReport.intent === 'segment_compare' ? 'Segment numbers' : selectedReport.intent === 'diagnose_change' ? 'Movement numbers' : 'Key numbers'}</h3>
                      <div className="dql-app-report-numbers">
                        {selectedReport.keyNumbers.map((metric) => (
                          <div key={metric.label} className="dql-app-report-number">
                            <span>{metric.label}</span>
                            <b>{metric.value}</b>
                            <small>{metric.detail}</small>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {selectedReport.drivers.length ? (
                    <div>
                      <h3>{selectedReport.intent === 'anomaly_investigation' ? 'Exception view' : selectedReport.intent === 'entity_drilldown' ? 'Entity view' : 'Driver view'}</h3>
                      <ResearchDriverChart drivers={selectedReport.drivers} />
                    </div>
                  ) : null}
                </section>
              ) : null}

              <details className="dql-app-report-section dql-app-report-appendix">
                <summary>
                  <span>Technical appendix</span>
                  <small>SQL, preview rows, caveats, routing, and source context for analyst review</small>
                  <ChevronDown size={15} />
                </summary>
                <div className="dql-app-research-evidence-head">
                  <div>
                    <h3>SQL and proof</h3>
                    <p>Use this appendix only when you need to inspect routing, repair generated SQL, or validate source context before pinning this memo to the app.</p>
                  </div>
                  <div className="dql-app-research-tabs">
                    {(['preview', 'sql', 'assumptions', 'context'] as const).map((tab) => (
                      <button key={tab} type="button" className={evidenceTab === tab ? 'on' : ''} onClick={() => setEvidenceTab(tab)}>
                        {tab === 'assumptions' ? 'Caveats' : formatBusinessLabel(tab)}
                      </button>
                    ))}
                  </div>
                </div>
                <ResearchEvidence
                  investigation={selected}
                  tab={evidenceTab}
                  sqlDraft={sqlDraft}
                  onSqlDraftChange={setSqlDraft}
                />
              </details>
            </article>
          </>
        ) : (
          <>
            {error ? <div className="dql-app-error">{error}</div> : null}
            {creatingInitialReport ? (
              <div className="dql-app-research-creating">
                <Workflow size={22} />
                <span>Preparing business memo</span>
                <h2>Writing business memo...</h2>
                <p>{pendingAnalysisTitle ? `DQL is opening a scoped memo for "${pendingAnalysisTitle}".` : 'DQL is using the Copilot context, active filters, certified block evidence, and any available preview proof to create the main-canvas memo.'}</p>
              </div>
            ) : (
              <EmptyPanel title="Start analysis from Copilot." detail="Ask a follow-up, add context, then review the analysis here." />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ResearchListButton({
  item,
  selected,
  onClick,
}: {
  item: LocalAppInvestigation;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        selected ? 'on' : '',
        `status-${item.status}`,
      ].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      <span>{formatResearchListTitle(item)}</span>
      <small>{formatResearchListMeta(item)}</small>
    </button>
  );
}

function NotebookListPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  const notebooks = appDoc?.notebooks ?? appDoc?.app.notebooks ?? [];
  if (!notebooks.length) return <EmptyPanel title="No notebooks attached." detail="Attach analysis notebooks in Build mode when this App needs supporting work." />;
  return (
    <div className="dql-app-simple-list">
      {notebooks.map((notebook) => (
        <PanelCard key={notebook.path} icon={<BookOpenText size={16} />}>
          <b>{notebook.title ?? notebook.path.split('/').pop()}</b>
          <span>{notebook.role} / {notebook.visibility} / {notebook.path}</span>
        </PanelCard>
      ))}
    </div>
  );
}

function AiPinsPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  const pins = appDoc?.aiPins ?? [];
  if (!pins.length) return <EmptyPanel title="No pinned insights yet." detail="Use Copilot from a dashboard page, create analysis, then add useful reviewed insights to this App." />;
  return (
    <div className="dql-app-simple-list">
      {pins.map((pin) => (
        <PanelCard key={pin.id} icon={<Bot size={16} />}>
          <b>{pin.title}</b>
          <span>{pin.certification} / {pin.reviewStatus}</span>
        </PanelCard>
      ))}
    </div>
  );
}

function DraftsPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  const drafts = appDoc?.drafts ?? [];
  if (!drafts.length) return <EmptyPanel title="No drafts." detail="Generated and promoted draft blocks will appear here for review." />;
  return (
    <div className="dql-app-simple-list">
      {drafts.map((draft) => (
        <PanelCard key={draft.path} icon={<FileText size={16} />}>
          <b>{draft.name}</b>
          <span>{draft.reviewStatus ?? 'needs review'} / {draft.path}</span>
        </PanelCard>
      ))}
    </div>
  );
}

function SettingsPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  if (!appDoc) return <EmptyPanel title="No App selected." detail="Choose an App to inspect its settings." />;
  return (
    <div className="dql-app-settings-grid">
      <PanelCard icon={<ShieldCheck size={16} />}><b>Owners</b><span>{appDoc.app.owners.join(', ')}</span></PanelCard>
      <PanelCard icon={<Workflow size={16} />}><b>Lifecycle</b><span>{appDoc.app.lifecycle ?? 'draft'}</span></PanelCard>
      <PanelCard icon={<Blocks size={16} />}><b>Policies</b><span>{appDoc.app.policies.length} local access policies</span></PanelCard>
      <PanelCard icon={<LayoutDashboard size={16} />}><b>Homepage</b><span>{appDoc.app.homepage?.type ?? 'dashboard'}</span></PanelCard>
    </div>
  );
}

function PanelHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="dql-app-panel-head">
      <span>{title}</span>
      {meta ? <b>{meta}</b> : null}
    </div>
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

function DashboardFilterControls({
  filters,
  values,
  onChange,
}: {
  filters: DashboardFilter[];
  values: Record<string, unknown>;
  onChange: (filter: DashboardFilter, value: unknown) => void;
}) {
  if (filters.length === 0) {
    return <span className="dql-app-filter-empty">No filters</span>;
  }
  return (
    <>
      {filters.map((filter) => (
        <DashboardFilterInput
          key={filter.id}
          filter={filter}
          value={values[filter.id] ?? defaultDashboardFilterValue(filter)}
          onChange={(value) => onChange(filter, value)}
        />
      ))}
    </>
  );
}

function DashboardFilterInput({
  filter,
  value,
  onChange,
}: {
  filter: DashboardFilter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = formatBusinessLabel(filter.id);
  const valueText = filterInputValue(filter, value);
  // Categorical filters bound to a tile: fetch the column's distinct values and
  // upgrade the free-text box to a real dropdown (low-cardinality only).
  const sourceBlockId = (filter as { sourceBlockId?: string }).sourceBlockId;
  const column = filter.bindsTo || filter.id;
  const wantsOptions = (filter.type === 'text' || filter.type === 'select') && Boolean(sourceBlockId) && !filter.options?.length;
  const [fetchedOptions, setFetchedOptions] = useState<string[] | null>(null);
  useEffect(() => {
    if (!wantsOptions || !sourceBlockId) return;
    let cancelled = false;
    void api.dashboardFilterOptions(sourceBlockId, column).then((res) => {
      if (!cancelled && res && res.options.length > 0 && !res.truncated) setFetchedOptions(res.options);
    });
    return () => { cancelled = true; };
  }, [sourceBlockId, column, wantsOptions]);
  if (fetchedOptions && fetchedOptions.length > 0) {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={valueText}
        onChange={onChange}
        options={[['', `All ${label.toLowerCase()}`], ...fetchedOptions.map((opt) => [opt, opt] as [string, string])]}
      />
    );
  }
  if (filter.type === 'select') {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={valueText}
        onChange={onChange}
        options={filterOptions(filter)}
      />
    );
  }
  if (filter.type === 'boolean') {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={String(Boolean(value))}
        onChange={(next) => onChange(next === 'true')}
        options={[
          ['true', 'Yes'],
          ['false', 'No'],
        ]}
      />
    );
  }
  if (filter.type === 'daterange') {
    const range = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { start?: unknown; end?: unknown })
      : {};
    const start = typeof range.start === 'string' ? range.start : '';
    const end = typeof range.end === 'string' ? range.end : '';
    // Emit a range ONLY when both ends are set (runtime needs both for BETWEEN);
    // a partial range is sent as undefined so the filter is simply skipped.
    const emit = (nextStart: string, nextEnd: string) =>
      onChange(nextStart && nextEnd ? { start: nextStart, end: nextEnd } : undefined);
    return (
      <label className="dql-app-filter-select dql-app-filter-range" title={filter.bindsTo ? `${label} -> ${filter.bindsTo}` : label} aria-label={label}>
        <span className="dql-app-filter-icon">{filterIconForDashboardFilter(filter)}</span>
        <input type="date" value={start} aria-label={`${label} from`} onChange={(event) => emit(event.target.value, end)} />
        <span className="dql-app-filter-range-sep">–</span>
        <input type="date" value={end} aria-label={`${label} to`} onChange={(event) => emit(start, event.target.value)} />
      </label>
    );
  }
  return (
    <label className="dql-app-filter-select" title={filter.bindsTo ? `${label} -> ${filter.bindsTo}` : label} aria-label={label}>
      <span className="dql-app-filter-icon">{filterIconForDashboardFilter(filter)}</span>
      <input
        type={filter.type === 'number' ? 'number' : filter.type === 'date' ? 'date' : 'text'}
        value={valueText}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function filterIconForDashboardFilter(filter: DashboardFilter): ReactNode {
  if (filter.type === 'date' || filter.type === 'daterange' || /season|year|date|time|period/i.test(filter.id)) {
    return <CalendarDays size={13} />;
  }
  return <BarChart3 size={13} />;
}

function deriveDashboardFilters(dashboard: DashboardDocumentResponse['dashboard'] | null): DashboardFilter[] {
  if (!dashboard) return [];
  const filters = new Map<string, DashboardFilter>();
  for (const filter of dashboard.filters ?? []) {
    if (isUsefulDashboardFilter(filter)) filters.set(filter.id, { ...filter });
  }
  const blockIdOf = (item: DashboardLayoutItem): string | undefined =>
    item.block?.blockId ?? item.block?.ref;
  for (const item of dashboard.layout.items ?? []) {
    const bid = blockIdOf(item);
    for (const binding of item.parameterBindings ?? []) {
      const id = binding.filter || binding.field || binding.param;
      if (!id) continue;
      const existing = filters.get(id);
      if (existing) {
        // Remember a tile that backs this filter, so its values can be fetched.
        if (bid && !(existing as { sourceBlockId?: string }).sourceBlockId) {
          (existing as { sourceBlockId?: string }).sourceBlockId = bid;
        }
        continue;
      }
      if (isCoveredByExistingDashboardFilter(filters, binding)) continue;
      filters.set(id, { ...filterFromParameterBinding(binding), sourceBlockId: bid } as DashboardFilter);
    }
  }
  return Array.from(filters.values());
}

function isUsefulDashboardFilter(filter: DashboardFilter): boolean {
  if (filter.type === 'select' && !filter.options?.length && filter.default === undefined) return false;
  return true;
}

function filterFromParameterBinding(
  binding: NonNullable<DashboardLayoutItem['parameterBindings']>[number],
): DashboardFilter {
  const id = binding.filter || binding.field || binding.param;
  return {
    id,
    type: parameterFilterType(id, binding.parameterType),
    default: binding.default ?? defaultParameterFilterValue(id),
    bindsTo: binding.param,
  };
}

function isCoveredByExistingDashboardFilter(
  filters: Map<string, DashboardFilter>,
  binding: NonNullable<DashboardLayoutItem['parameterBindings']>[number],
): boolean {
  return Array.from(filters.values()).some((filter) => {
    if (binding.filter && filter.id === binding.filter) return true;
    if (binding.field && filter.bindsTo === binding.field) return true;
    return Boolean(binding.param && filter.bindsTo === binding.param);
  });
}

function parameterFilterType(id: string, parameterType?: string): DashboardFilter['type'] {
  if (parameterType === 'number' || parameterType === 'number[]') return 'number';
  if (parameterType === 'boolean') return 'boolean';
  if (parameterType === 'date' || parameterType === 'date[]') return 'date';
  // Time-ish columns get a date-RANGE picker (the runtime applies BETWEEN). Covers
  // the common dbt/warehouse naming (`ordered_at`, `_at`, `_date`, `_time`, `_ts`).
  if (/(_at$|_date$|_time$|_ts$|date|time|day|week|month|quarter|period)/i.test(id)) return 'daterange';
  if (/(top[_-]?n|limit|count|number|year|season)/i.test(id)) return 'number';
  return 'text';
}

function defaultParameterFilterValue(id: string): unknown {
  const normalized = id.toLowerCase();
  if (/(top[_-]?n|limit)/.test(normalized)) return 5;
  if (/(season|year).*start|start.*(season|year)/.test(normalized)) return 2016;
  if (/(season|year).*end|end.*(season|year)/.test(normalized)) return 2017;
  return '';
}

function filterOptions(filter: DashboardFilter): Array<[string, string]> {
  const options = filter.options?.length ? filter.options : [filter.default].filter((value) => value !== undefined);
  return options.map((option) => [String(option), formatBusinessLabel(String(option))]);
}

function defaultDashboardFilterValue(filter: DashboardFilter): unknown {
  if (filter.default !== undefined) return filter.default;
  if (filter.type === 'number') return defaultParameterFilterValue(filter.id);
  if (filter.type === 'boolean') return false;
  if (filter.type === 'select') return filter.options?.[0] ?? '';
  return '';
}

function filterInputValue(filter: DashboardFilter, value: unknown): string {
  if (value === undefined || value === null) return String(defaultDashboardFilterValue(filter) ?? '');
  if (filter.type === 'daterange' && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function coerceDashboardFilterValue(filter: DashboardFilter, value: unknown): unknown {
  if (filter.type === 'number') {
    if (typeof value === 'string' && value.trim() === '') return '';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (filter.type === 'boolean') return value === true || value === 'true';
  if (filter.type === 'select' && typeof filter.default === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  return value;
}

function shallowEqualRecords(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function FilterSelect({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="dql-app-filter-select" title={label} aria-label={label}>
      {icon ? <span className="dql-app-filter-icon">{icon}</span> : <span>{label}</span>}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" className={`dql-app-toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <i /> {label}
    </button>
  );
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

function tidyTitle(value?: string | null): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.–—-]+$/, '')
    .trim();
}

function formatBusinessLabel(value?: string | null): string {
  const clean = String(value ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Business';
  return clean.split(' ').map((word) => {
    const lower = word.toLowerCase();
    if (lower === 'ai') return 'AI';
    if (lower === 'cxo') return 'CXO';
    if (lower === 'kpi') return 'KPI';
    if (lower === 'vs' || lower === 'vs.') return 'vs.';
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  }).join(' ');
}

function cleanStakeholderCopy(value: string): string {
  return value
    .replace(/\bDraft gaps stay in Research until reviewed\.?/gi, 'Follow-up analysis stays out of the stakeholder view until reviewed.')
    .replace(/\bresearch path\b/gi, 'analysis path')
    .replace(/\bresearch suggestions\b/gi, 'analysis suggestions')
    .replace(/\bfollow-up research\b/gi, 'follow-up analysis')
    .replace(/\bevidence chips\b/gi, 'proof chips')
    .replace(/\bevidence, lineage\b/gi, 'proof and lineage')
    .replace(/\bevidence and lineage\b/gi, 'proof and lineage')
    .replace(/\bsource evidence\b/gi, 'source proof')
    .replace(/\bOpen Research\b/g, 'Open Analysis')
    .replace(/\bResearch\b/g, 'Analysis');
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

function formatVariableValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'All';
  if (Array.isArray(value)) return value.map(formatVariableValue).join(', ');
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatVariableEntryValue(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => formatVariableEntryValue(key, item)).join(', ');
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (/(season|year)/i.test(key) && Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200) {
    return String(numeric);
  }
  return formatVariableValue(value);
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

function StatusSeal({ children, tone = 'certified' }: { children: ReactNode; tone?: 'certified' | 'draft' | 'agentic' }) {
  return <span className={`dql-app-seal ${tone}`}>{children}</span>;
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><b>{value}</b></span>;
}

function KeyValueInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="dql-app-keyvalue-inline">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function researchScopeFromContext(rawContext: unknown, fallbackQuestion: string): string {
  const fallback = cleanResearchScopeText(fallbackQuestion) || 'Review this app result.';
  const text = typeof rawContext === 'string' ? rawContext.trim() : '';
  if (!text) return fallback;

  const labeledScope = extractLabeledResearchScope(text);
  if (labeledScope) return labeledScope;

  const withoutMetadata = text
    .replace(/\bCurrent app filters:\s*[\s\S]*$/i, '')
    .replace(/\bCertified block to start from:\s*[\s\S]*$/i, '')
    .replace(/\bSource result:\s*[\s\S]*$/i, '')
    .replace(/\bUser intent:\s*[\s\S]*$/i, '');
  return cleanResearchScopeText(withoutMetadata) || fallback;
}

function extractLabeledResearchScope(text: string): string {
  const labelPattern = /(?:^|\n)\s*(Analysis goal|Analysis question|Report question|Research question|Proof question|Evidence question|Validation question|Reusable block goal|Business question|Question):\s*/i;
  const match = labelPattern.exec(text);
  if (!match) return '';
  const start = (match.index ?? 0) + match[0].length;
  const rest = text.slice(start);
  const stop = rest.search(/(?:^|\n)\s*(Current app filters|Certified block to start from|Source result|User intent|Review status|Trust status):/i);
  const scope = stop >= 0 ? rest.slice(0, stop) : rest;
  return cleanResearchScopeText(scope);
}

function cleanResearchScopeText(value: string): string {
  const cleaned = value
    .replace(/^\/(ask|research|report|analy[sz]e|analysis|proof|evidence|validate|verify|add\s+block|create\s+block|draft\s+block|block)\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 280) return cleaned;
  const clipped = cleaned.slice(0, 280).replace(/\s+\S*$/, '').trim();
  return clipped ? `${clipped}...` : cleaned.slice(0, 280);
}

function buildResearchReport(investigation: LocalAppInvestigation) {
  const metrics = asUiRecord(investigation.metrics);
  const context = asUiRecord(investigation.context);
  const evidence = asUiRecord(investigation.evidence);
  const planner = asUiRecord(evidence.planner);
  const routeDecision = analysisRouteDecisionForReport(context, evidence, planner);
  const focusBlock = asUiRecord(context.focusBlock);
  const preview = firstResearchPreview(investigation);
  const previewResult = asUiRecord(preview?.result);
  const previewRows = Array.isArray(previewResult.rows) ? previewResult.rows.length : 0;
  const contextQuestion = researchScopeFromContext(context.userProvidedContext, investigation.question);
  const actionMode = typeof context.actionMode === 'string' ? context.actionMode : undefined;
  const sourceName = String(metrics.context ?? focusBlock.title ?? investigation.sourceBlockId ?? 'selected app result');
  const activeFilters = String(context.activeFilterSummary ?? formatActiveFilterContext(asUiRecord(context.activeFilters)));
  const reportType = researchIntentTitle(investigation.intent, actionMode);
  const title = researchReportDisplayTitle(investigation, contextQuestion, actionMode, sourceName);
  const scope = researchReportScopeLine(reportType, contextQuestion, sourceName, activeFilters);
  const summary = investigation.summary?.trim()
    || `DQL wrote review-required analysis for ${sourceName}: ${investigation.question}. The selected app result is available, but this analysis still needs human review before it becomes governed business logic.`;
  const recommendation = investigation.recommendation?.trim()
    || 'Use this as analyst-reviewed analysis first. Confirm the metric grain, filters, source tables, and caveats before adding it to the app or drafting a reusable DQL block.';
  const keyNumbers = [
    {
      label: String(metrics.currentLabel ?? 'Current'),
      value: formatResearchValue(metrics.currentValue),
      detail: String(metrics.currentDetail ?? 'current selected result'),
    },
    {
      label: String(metrics.baselineLabel ?? 'Baseline'),
      value: formatResearchValue(metrics.baselineValue),
      detail: String(metrics.baselineDetail ?? 'comparison or prior value'),
    },
    {
      label: String(metrics.deltaLabel ?? 'Delta'),
      value: formatResearchValue(metrics.delta),
      detail: String(metrics.deltaDetail ?? 'change or gap to explain'),
    },
    { label: 'Preview', value: previewRows ? `${previewRows} rows` : 'not captured', detail: 'bounded preview sample' },
  ].filter(isMeaningfulReportMetric);
  const drivers = buildResearchReportDrivers(investigation);
  const hasReportEvidence = previewRows > 0 || keyNumbers.length > 0 || drivers.length > 0 || Object.keys(metrics).length > 0;
  const normalizedSections = normalizeResearchReportSections(investigation.reportSections)
    .filter((section) => shouldShowResearchReportSection(section, investigation.error, hasReportEvidence));
  return {
    title,
    intent: investigation.intent,
    actionMode,
    scope,
    summary,
    recommendation,
    routeDecision,
    sections: normalizedSections,
    previewIssue: previewIssueForReport(investigation.error, typeof planner.sqlErrorKind === 'string' ? planner.sqlErrorKind : undefined, hasReportEvidence),
    contextFacts: [
      { label: 'Type', value: reportType },
      { label: 'Source', value: sourceName },
      { label: 'Filters', value: activeFilters },
      { label: 'Review', value: formatBusinessLabel(investigation.reviewStatus) },
    ],
    keyNumbers,
    drivers,
  };
}

function analysisRouteDecisionForReport(
  context: Record<string, unknown>,
  evidence: Record<string, unknown>,
  planner: Record<string, unknown>,
): { mode: string; reason: string; nextAction: string; confidence?: number } | null {
  const originatingAnswer = asUiRecord(context.originatingAnswer);
  const raw = asUiRecord(context.routeDecision);
  const fallback = asUiRecord(originatingAnswer.decision);
  const evidenceDecision = asUiRecord(evidence.routeDecision);
  const plannerDecision = asUiRecord(planner.routeDecision);
  const decision = Object.keys(raw).length ? raw
    : Object.keys(fallback).length ? fallback
      : Object.keys(evidenceDecision).length ? evidenceDecision
        : Object.keys(plannerDecision).length ? plannerDecision
          : {};
  const reason = typeof decision.reason === 'string' ? decision.reason.trim() : '';
  const nextAction = typeof decision.nextAction === 'string' ? decision.nextAction.trim() : '';
  if (!reason && !nextAction) return null;
  const mode = typeof decision.mode === 'string' && decision.mode.trim()
    ? formatBusinessLabel(decision.mode)
    : 'Analysis';
  const confidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence)
    ? Math.round(Math.max(0, Math.min(1, decision.confidence)) * 100)
    : undefined;
  return { mode, reason, nextAction, confidence };
}

function appAnalysisHandoffFromInvestigation(investigation: LocalAppInvestigation): AppAnalysisHandoff {
  const context = asUiRecord(investigation.context);
  const evidence = asUiRecord(investigation.evidence);
  const planner = asUiRecord(evidence.planner);
  const routeDecision = analysisRouteDecisionForReport(context, evidence, planner);
  const actionMode = context.actionMode === 'block'
    ? 'block'
    : context.actionMode === 'evidence'
      ? 'evidence'
      : 'research';
  const userContext = typeof context.userProvidedContext === 'string' && context.userProvidedContext.trim()
    ? context.userProvidedContext.trim()
    : investigation.question;
  const question = researchScopeFromContext(userContext, investigation.question)
    || stripResearchTitlePrefix(investigation.title)
    || stripResearchTitlePrefix(investigation.question)
    || 'Refine this analysis';
  return {
    mode: actionMode,
    question,
    context: userContext,
    decision: routeDecision
      ? {
        reason: routeDecision.reason,
        nextAction: routeDecision.nextAction,
      }
      : undefined,
  };
}

function previewIssueForReport(error?: string, kind?: string, hasCertifiedEvidence = false): { message: string; canRebuild: boolean } | null {
  const detail = error?.trim();
  if (!detail) return null;
  if (hasCertifiedEvidence && (kind === 'runtime_unavailable' || kind === 'unknown' || /\bAI provider did not return a governed answer\b/i.test(detail))) {
    return null;
  }
  if (kind === 'runtime_unavailable') {
    return {
      message: 'Preview could not run because the warehouse or execution runtime is unavailable. Resume or choose an active warehouse, then refresh the report. The SQL may not need to change.',
      canRebuild: false,
    };
  }
  if (kind === 'timeout') {
    return {
      message: 'Preview timed out. Narrow filters or simplify the SQL in the trace appendix, then refresh before promoting this report.',
      canRebuild: false,
    };
  }
  if (kind === 'safety') {
    return {
      message: 'DQL blocked this preview because the SQL is not safe read-only analytical SQL. Rebuild from the certified block or edit it as a SELECT/WITH query before refreshing.',
      canRebuild: true,
    };
  }
  return {
    message: 'SQL preview needs review. Edit the SQL in the trace appendix or rebuild it from the certified block context before promoting this report.',
    canRebuild: true,
  };
}

function shouldShowResearchReportSection(
  section: NonNullable<LocalAppInvestigation['reportSections']>[number],
  error: string | undefined,
  hasReportEvidence: boolean,
): boolean {
  const sectionId = String(section.id ?? '').toLowerCase();
  if (section.kind === 'review_boundary' || sectionId === 'review-boundary') {
    return false;
  }
  if (sectionId === 'preview-unavailable' && hasReportEvidence) {
    return false;
  }
  if (
    sectionId === 'sql-repair-path' &&
    hasReportEvidence &&
    /\bAI provider did not return a governed answer\b/i.test(error ?? '')
  ) {
    return false;
  }
  return true;
}

function isMeaningfulReportMetric(metric: { label: string; value: string; detail: string }): boolean {
  const value = metric.value.trim().toLowerCase();
  return Boolean(value) && value !== 'n/a' && value !== 'not captured' && value !== 'not available';
}

function researchReportDisplayTitle(
  investigation: LocalAppInvestigation,
  contextQuestion: string,
  actionMode: string | undefined,
  sourceName: string,
): string {
  const cleanQuestion = stripResearchTitlePrefix(contextQuestion)
    || stripResearchTitlePrefix(investigation.title)
    || stripResearchTitlePrefix(investigation.question);
  const label = actionMode === 'block'
    ? 'Reusable logic'
    : actionMode === 'evidence'
      ? 'Proof brief'
      : 'Analysis';
  const fallback = formatBusinessLabel(sourceName);
  const core = cleanQuestion || fallback;
  return `${label}: ${truncateReportTitle(core)}`;
}

function researchReportScopeLine(
  reportType: string,
  contextQuestion: string,
  sourceName: string,
  activeFilters: string,
): string {
  const question = stripResearchTitlePrefix(contextQuestion);
  const parts = [
    question ? `Question: ${question}` : '',
    `Source: ${sourceName}`,
    activeFilters && activeFilters !== 'No app filters set' ? `Filters: ${activeFilters}` : '',
    `Status: ${reportType} / review-required`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function stripResearchTitlePrefix(value?: string | null): string {
  return cleanResearchScopeText(String(value ?? ''))
    .replace(/^(analysis|report|research|proof|proof brief|reusable logic|reusable logic brief|change analysis|driver analysis|segment comparison|entity drilldown|anomaly review|validation result)\s*:\s*/i, '')
    .replace(/^(analysis goal|analysis question|report question|research question|proof question|evidence question|validation question|reusable block goal|business question|question)\s*:\s*/i, '')
    .trim();
}

function truncateReportTitle(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= 96) return clean;
  const clipped = clean.slice(0, 96).replace(/\s+\S*$/, '').trim();
  return `${clipped || clean.slice(0, 96)}...`;
}

function researchIntentTitle(intent: LocalAppInvestigation['intent'], actionMode?: string): string {
  if (actionMode === 'evidence') return 'Proof Brief';
  if (actionMode === 'block') return 'Reusable Logic Brief';
  if (intent === 'diagnose_change') return 'Change Analysis';
  if (intent === 'segment_compare') return 'Segment Comparison';
  if (intent === 'entity_drilldown') return 'Entity Drilldown';
  if (intent === 'anomaly_investigation') return 'Anomaly Review';
  if (intent === 'trust_gap_review') return 'Proof Review';
  return 'Driver Analysis';
}

function buildResearchReportDrivers(investigation: LocalAppInvestigation): Array<{ title: string; value: string; explanation: string }> {
  const cards = (investigation.driverCards ?? [])
    .map(asUiRecord)
    .filter((item) => Object.keys(item).length > 0);
  if (cards.length) {
    return cards.slice(0, 8).map((record, index) => ({
      title: String(record.title ?? `Driver ${index + 1}`),
      value: String(record.contribution ?? record.value ?? record.metric ?? 'Proof'),
      explanation: String(record.explanation ?? 'Review this driver against the source rows and metric grain.'),
    }));
  }
  const preview = firstResearchPreview(investigation);
  const result = asUiRecord(preview?.result);
  const rows = Array.isArray(result.rows) ? result.rows.map(asUiRecord).filter((row) => Object.keys(row).length > 0) : [];
  return rows.slice(0, 5).map((row, index) => {
    const keys = Object.keys(row);
    const titleKey = keys.find((key) => /name|player|customer|account|segment|team/i.test(key)) ?? keys[0] ?? `row_${index + 1}`;
    const valueKey = keys.find((key) => /point|revenue|total|score|value|delta|count/i.test(key) && key !== titleKey) ?? keys[1] ?? titleKey;
    return {
      title: String(row[titleKey] ?? `Preview row ${index + 1}`),
      value: formatResearchValue(row[valueKey]),
      explanation: `This row is part of the bounded preview sample for ${formatBusinessLabel(valueKey)}.`,
    };
  });
}

function buildResearchMemo(report: ReturnType<typeof buildResearchReport>): string {
  if (report.sections.length > 0) {
    return report.sections.map((section) => {
      const bullets = section.bullets?.length
        ? `\n\n${section.bullets.map((bullet) => `- ${bullet}`).join('\n')}`
        : '';
      return `## ${section.title}\n${section.body}${bullets}`;
    }).join('\n\n');
  }
  const topNumber = report.keyNumbers.find((metric) => metric.value !== 'not available' && metric.label !== 'Preview');
  const comparison = report.keyNumbers.find((metric) => /baseline|comparison|next/i.test(metric.label) && metric.value !== 'not available');
  const gap = report.keyNumbers.find((metric) => /delta|gap|change/i.test(metric.label) && metric.value !== 'not available');
  const leadDriver = report.drivers[0];
  const nextDriver = report.drivers[1];
  const source = report.contextFacts.find((fact) => fact.label === 'Source')?.value;
  const filters = report.contextFacts.find((fact) => fact.label === 'Filters')?.value;
  const evidenceLine = [
    topNumber ? `${topNumber.label}: ${topNumber.value} (${topNumber.detail})` : '',
    comparison ? `${comparison.label}: ${comparison.value} (${comparison.detail})` : '',
    gap ? `${gap.label}: ${gap.value} (${gap.detail})` : '',
  ].filter(Boolean).join('; ');
  const driverLine = leadDriver
    ? `${leadDriver.title} is the strongest visible driver in this bounded preview${leadDriver.value ? ` (${leadDriver.value})` : ''}.${nextDriver ? ` The next visible comparison is ${nextDriver.title}${nextDriver.value ? ` (${nextDriver.value})` : ''}.` : ''}`
    : 'The report does not yet have ranked drivers. Add a clearer metric, time grain, or segment field before treating the analysis as complete.';
  const contextLine = [
    source ? `source: ${source}` : '',
    filters ? `filters: ${filters}` : '',
  ].filter(Boolean).join('; ');
  const decisionHeading = report.actionMode === 'block'
    ? '## Reusable logic decision'
    : report.actionMode === 'evidence' || report.intent === 'trust_gap_review'
      ? '## Validation result'
      : '## Business interpretation';
  const decisionText = report.actionMode === 'block'
    ? 'This is a candidate reusable block design, not a certified answer yet. Preserve the business question, parameter defaults, allowed filters, output grain, and proof path before certification.'
    : report.actionMode === 'evidence' || report.intent === 'trust_gap_review'
      ? `The claim should be treated as validated only inside this bounded analysis context${contextLine ? ` (${contextLine})` : ''}. Use the appendix when a reviewer needs SQL, preview rows, caveats, or source trace.`
      : `${driverLine} Treat the conclusion as a directional stakeholder explanation until the analyst confirms SQL, grain, filters, joins, and lineage.`;
  const sections: string[] = [
    '## Executive answer',
    report.summary,
    decisionHeading,
    decisionText,
  ];
  if (evidenceLine) {
    sections.push('## Key numbers', `The bounded preview shows ${evidenceLine}. These numbers are useful for review and stakeholder framing but still need source validation before promotion.`);
  }
  sections.push(
    '## Recommended next step',
    report.recommendation,
    '## Review boundary',
    'This report is AI-generated and review-required. Use it to guide analysis, then validate SQL, grain, filters, joins, and source proof before pinning it to the app or turning it into a reusable DQL block.',
  );
  return sections.join('\n\n');
}

function ResearchReportSections({
  sections,
}: {
  sections: ReturnType<typeof buildResearchReport>['sections'];
}) {
  return (
    <div className="dql-app-report-dynamic-sections">
      {sections.map((section) => (
        <section key={section.id} className={`dql-app-report-dynamic-section tone-${section.tone ?? 'neutral'}`}>
          <div className="dql-app-report-dynamic-head">
            <span>{reportSectionKicker(section)}</span>
            <h3>{section.title}</h3>
          </div>
          <MemoSectionBody text={section.body} />
          {section.bullets?.length ? (
            <ul>
              {section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function MemoSectionBody({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;
  return (
    <div className="dql-app-report-memo-body">
      {paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </div>
  );
}

function reportSectionKicker(section: NonNullable<LocalAppInvestigation['reportSections']>[number]): string {
  switch (section.kind) {
    case 'executive_answer':
      return 'Answer';
    case 'business_interpretation':
      return 'Interpretation';
    case 'key_numbers':
      return 'Numbers';
    case 'validation':
      return 'Proof';
    case 'reusable_logic':
      return 'Reusable logic';
    case 'recommended_next_step':
      return 'Next step';
    case 'review_boundary':
      return 'Review boundary';
    default:
      if (/focus/i.test(section.title)) return 'Scope';
      if (/repair|preview|sql/i.test(section.title)) return 'Appendix note';
      return 'Report note';
  }
}

function normalizeResearchReportSections(value: LocalAppInvestigation['reportSections']): Array<NonNullable<LocalAppInvestigation['reportSections']>[number]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((section): section is NonNullable<LocalAppInvestigation['reportSections']>[number] => {
      return Boolean(section)
        && typeof section.title === 'string'
        && section.title.trim().length > 0
        && typeof section.body === 'string'
        && section.body.trim().length > 0;
    })
    .slice(0, 8)
    .map((section, index) => ({
      ...section,
      id: section.id || `section-${index + 1}`,
      title: section.title.trim(),
      body: section.body.trim(),
      bullets: Array.isArray(section.bullets) ? section.bullets.filter(Boolean).slice(0, 8) : undefined,
      evidenceRefs: Array.isArray(section.evidenceRefs) ? section.evidenceRefs.filter(Boolean).slice(0, 8) : undefined,
    }));
}

function ResearchDriverChart({ drivers }: { drivers: Array<{ title: string; value: string; explanation: string }> }) {
  if (!drivers.length) {
    return <p className="dql-app-report-muted">No ranked drivers are available yet. Refresh the report after adding a clearer metric, time grain, or comparison group.</p>;
  }
  const rows = drivers.slice(0, 6).map((driver) => ({
    ...driver,
    numericValue: Math.abs(numberFromReportValue(driver.value)),
  }));
  const maxValue = Math.max(...rows.map((row) => row.numericValue), 0);
  return (
    <div className="dql-app-report-driver-chart" aria-label="Report driver chart">
      {rows.map((driver, index) => {
        const width = maxValue > 0 ? Math.max(8, Math.round((driver.numericValue / maxValue) * 100)) : 28;
        return (
          <div key={`${driver.title}-${index}`} className="dql-app-report-driver-bar">
            <div>
              <b>{driver.title}</b>
              <span>{driver.value}</span>
            </div>
            <i style={{ '--driver-width': `${width}%` } as CSSProperties} />
            <p>{driver.explanation}</p>
          </div>
        );
      })}
    </div>
  );
}

function numberFromReportValue(value: string): number {
  const match = value.replace(/,/g, '').match(/-?\+?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const number = Number(match[0].replace(/^\+/, ''));
  return Number.isFinite(number) ? number : 0;
}

function formatActiveFilterContext(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters).filter(([key]) => key !== 'smartView');
  if (!entries.length) return 'No app filters set';
  return entries.map(([key, value]) => `${formatBusinessLabel(key)} ${formatVariableEntryValue(key, value)}`).join(', ');
}

function ResearchEvidence({
  investigation,
  tab,
  sqlDraft,
  onSqlDraftChange,
}: {
  investigation: LocalAppInvestigation;
  tab: 'preview' | 'sql' | 'assumptions' | 'context';
  sqlDraft: string;
  onSqlDraftChange: (value: string) => void;
}) {
  if (tab === 'sql') {
    return (
      <div className="dql-app-research-sql-review">
        <textarea
          value={sqlDraft}
          onChange={(event) => onSqlDraftChange(event.target.value)}
          spellCheck={false}
          placeholder="Generated SQL will appear here for review."
        />
        {investigation.error ? <div className="dql-app-error">{investigation.error}</div> : null}
      </div>
    );
  }
  const evidence = asUiRecord(investigation.evidence);
  if (tab === 'assumptions') {
    const assumptions = Array.isArray(evidence.assumptions) ? evidence.assumptions : [];
    const trust = asUiRecord(evidence.trustStatus);
    return (
      <div className="dql-app-research-assumptions">
        {assumptions.length ? assumptions.map((item, index) => <p key={index}>{String(item)}</p>) : <p>Refresh the report to capture assumptions.</p>}
        <KeyValueInline label="Trust" value={String(trust.label ?? 'AI-generated report')} />
        <KeyValueInline label="Review" value={investigation.reviewStatus} />
      </div>
    );
  }
  if (tab === 'context') {
    return (
      <pre className="dql-app-research-code">
        {JSON.stringify({
          certifiedContext: evidence.certifiedContext,
          trustStatus: evidence.trustStatus,
          planner: evidence.planner,
        }, null, 2)}
      </pre>
    );
  }
  return <ResearchPreviewTable investigation={investigation} />;
}

function ResearchPreviewTable({ investigation }: { investigation: LocalAppInvestigation }) {
  const preview = firstResearchPreview(investigation);
  if (!preview) return <EmptyPanel title="No preview rows yet." detail="Refresh the report with SQL or selected tile results to capture proof." compact />;
  const result = asUiRecord(preview.result);
  const rows = Array.isArray(result.rows) ? result.rows.map(asUiRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 8) : [];
  const columns = Array.isArray(result.columns) ? result.columns.map(String).slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  if (!rows.length || !columns.length) return <EmptyPanel title="No preview rows yet." detail="The report captured proof, but no row preview was available." compact />;
  return (
    <div className="dql-app-research-table">
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{formatBusinessLabel(column)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function firstResearchPreview(investigation: LocalAppInvestigation): Record<string, unknown> | null {
  const previews = Array.isArray(investigation.resultPreviews) ? investigation.resultPreviews : [];
  return previews.map(asUiRecord).find((preview) => Boolean(preview.result)) ?? null;
}

function upsertInvestigation(items: LocalAppInvestigation[], next: LocalAppInvestigation): LocalAppInvestigation[] {
  const without = items.filter((item) => item.id !== next.id);
  return sortResearchInvestigations([next, ...without]);
}

function sortResearchInvestigations(items: LocalAppInvestigation[]): LocalAppInvestigation[] {
  return [...items].sort((a, b) => researchTimestamp(b) - researchTimestamp(a));
}

function researchTimestamp(item: LocalAppInvestigation): number {
  const value = new Date(item.updatedAt || item.lastRunAt || item.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function formatResearchListTitle(item: LocalAppInvestigation): string {
  const cleaned = item.title
    .replace(/^\s*(write\s+the\s+report\s+brief|the\s+research\s+question|research\s+question)\s*:\s*/i, '')
    .replace(/^\s*research\b/i, 'Analysis')
    .replace(/^\s*report\b/i, 'Analysis')
    .trim();
  const title = formatBusinessLabel(cleaned || item.title);
  if (title.length <= 64) return title;
  return `${title.slice(0, 61).trim()}...`;
}

function formatResearchListMeta(item: LocalAppInvestigation): string {
  const status = item.status === 'error'
    ? 'Needs SQL review'
    : item.status === 'ready'
      ? 'Ready'
      : item.status === 'running'
        ? 'Running'
        : 'Draft';
  const time = formatResearchAge(item.updatedAt || item.lastRunAt || item.createdAt);
  return `${formatBusinessLabel(item.intent)} / ${status}${time ? ` / ${time}` : ''}`;
}

function formatResearchAge(value?: string): string {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function researchIntentFromPrompt(text: string): LocalAppInvestigation['intent'] {
  const value = text.toLowerCase();
  if (/\b(trust|rely|certif|lineage|gap|caveat)\b/.test(value)) return 'trust_gap_review';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(value)) return 'anomaly_investigation';
  if (/\b(compare|versus| vs |segment|cohort)\b/.test(value)) return 'segment_compare';
  if (/\b(customer|account|user|client|alice|johnson|entity)\b/.test(value)) return 'entity_drilldown';
  if (/\b(why|changed|change|drop|decline|increase|decrease)\b/.test(value)) return 'diagnose_change';
  return 'driver_breakdown';
}

function formatResearchValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : Number(value.toFixed(2)).toLocaleString();
  }
  if (typeof value === 'string' && value.trim()) return value;
  return 'n/a';
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatResearchValue(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function asUiRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function PanelCard({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="dql-app-panel-card">
      <span>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

function EmptyPanel({ title, detail, compact = false }: { title: string; detail: string; compact?: boolean }) {
  return (
    <div className={`dql-app-empty ${compact ? 'compact' : ''}`}>
      <LayoutDashboard size={compact ? 24 : 34} strokeWidth={1.5} />
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  );
}

function AddPageDialog({
  title,
  error,
  onChange,
  onCancel,
  onCreate,
}: {
  title: string;
  error: string | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="dql-app-modal-backdrop">
      <div className="dql-app-modal">
        <h3>Add dashboard page</h3>
        <p>Create a new page inside this local App package.</p>
        <label>Page name<input value={title} onChange={(event) => onChange(event.target.value)} autoFocus placeholder="Executive Overview" /></label>
        {error ? <div className="dql-app-error">{error}</div> : null}
        <div>
          <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onCancel}>Cancel</button>
          <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onCreate}>Create page</button>
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
    version: 1,
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

const APP_STYLES = `
.dql-apps-waterline {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--bg-1);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.45;
  text-rendering: geometricPrecision;
}

.dql-apps-waterline * {
  letter-spacing: 0;
}

.dql-apps-wrap {
  width: min(1240px, calc(100% - 52px));
  margin: 0 auto;
  padding: 30px 0 72px;
}

.dql-apps-createhead h1 {
  margin: 0;
  font-size: 32px;
  line-height: 1.05;
  font-weight: 850;
}

.dql-apps-createhead p {
  margin: 10px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.55;
  max-width: 720px;
}

.dql-apps-btn {
  height: 32px;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font: 750 12px var(--font-ui);
  cursor: pointer;
  white-space: nowrap;
}

.dql-apps-btn:disabled { opacity: 0.62; cursor: not-allowed; }
.dql-apps-btn-primary { background: var(--accent); color: #fff; }
.dql-apps-btn-line { background: var(--bg-2); border-color: var(--border-default); color: var(--text-primary); }
.dql-apps-btn-icon { width: 32px; padding: 0; flex: none; }
.dql-apps-btn-icon:hover,
.dql-apps-btn-icon.on { color: var(--accent); border-color: rgba(79, 99, 215, 0.34); background: var(--accent-dim); }
.dql-apps-btn-dark { width: 100%; background: var(--text-primary); border-color: #1f2937; color: #fff; margin-top: 12px; }

.dql-apps-ai-entry {
  margin-top: 18px;
  border: 1px solid rgba(79, 99, 215, 0.26);
  border-radius: 12px;
  background: var(--bg-2);
  box-shadow: var(--shadow-card);
  padding: 16px;
  display: grid;
  gap: 12px;
}

.dql-apps-ai-entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dql-apps-ai-entry-head span,
.dql-apps-ai-entry-head b {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 850 11px var(--font-ui);
}

.dql-apps-ai-entry-head span {
  color: var(--accent);
}

.dql-apps-ai-entry-head b {
  color: var(--status-success);
}

.dql-apps-ai-entry-box {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 12px;
}

.dql-apps-ai-entry-box textarea {
  width: 100%;
  min-height: 112px;
  resize: vertical;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: var(--bg-3);
  color: var(--text-primary);
  outline: 0;
  padding: 13px 14px;
  font: 540 15px/1.5 var(--font-ui);
}

.dql-apps-ai-entry-box textarea:focus {
  border-color: rgba(79, 99, 215, 0.52);
  box-shadow: 0 0 0 3px rgba(79, 99, 215, 0.1);
}

.dql-apps-ai-entry-box button {
  height: 46px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  padding: 0 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font: 800 12.5px var(--font-ui);
  cursor: pointer;
  box-shadow: 0 12px 26px rgba(79, 99, 215, 0.2);
}

.dql-apps-ai-entry-box button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dql-apps-ai-entry-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dql-apps-ai-entry-foot > div {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dql-apps-ai-entry-foot button {
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-secondary);
  padding: 6px 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: 750 11.5px var(--font-ui);
  cursor: pointer;
}

.dql-apps-ai-entry-foot button:hover {
  color: var(--accent);
  border-color: rgba(79, 99, 215, 0.32);
  background: var(--accent-dim);
}

.dql-apps-ai-entry-secondary {
  flex: none;
  color: var(--text-primary) !important;
}

.dql-apps-sectionhead {
  margin: 30px 0 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary);
}

.dql-apps-sectionhead span,
.dql-app-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-apps-sectionhead i { flex: 1; border-top: 1px solid var(--border-subtle); }
.dql-apps-sectionhead b { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); }

.dql-apps-libbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.dql-apps-filter-tabs {
  display: flex;
  gap: 3px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-3);
  padding: 4px;
  flex-wrap: wrap;
}

.dql-apps-filter-tabs button {
  border: 0;
  background: transparent;
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--text-secondary);
  font: 800 12px var(--font-ui);
}

.dql-apps-filter-tabs button.on { background: var(--bg-2); color: var(--text-primary); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08); }
.dql-apps-filter-tabs span { margin-left: 5px; color: var(--accent); font-family: var(--font-mono); font-size: 10px; }

.dql-apps-search {
  flex: 1;
  min-width: 220px;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-2);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  padding: 0 12px;
  color: var(--text-tertiary);
}

.dql-apps-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font: 13px var(--font-ui);
}

.dql-apps-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.dql-app-card {
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  overflow: hidden;
  box-shadow: var(--shadow-card);
}

.dql-app-card-body {
  padding: 16px;
  cursor: pointer;
}

.dql-app-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 9px;
}

.dql-app-star {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-2);
  color: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.dql-app-star.on { color: var(--accent); background: var(--accent-dim); border-color: rgba(37, 99, 235, 0.35); }
.dql-app-card h3 { margin: 13px 0 0; font-size: 17px; line-height: 1.2; }
.dql-app-card p { min-height: 54px; margin: 7px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }

.dql-app-card-mini {
  margin-top: 13px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.dql-app-card-mini span {
  border-radius: 6px;
  background: var(--bg-3);
  padding: 7px 9px;
}

.dql-app-card-mini small {
  display: block;
  font-family: var(--font-mono);
  font-size: 7.5px;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.dql-app-card-mini b { display: block; margin-top: 1px; font-size: 15px; }

.dql-app-card-signals {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  color: var(--text-secondary);
  font: 700 10px var(--font-mono);
}

.dql-app-card-signals span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-3);
  white-space: nowrap;
}

.dql-app-card-depth {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-3);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
}

.dql-app-card-depth span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-card-depth button { border: 0; background: transparent; color: var(--accent); cursor: pointer; font: 800 11px var(--font-ui); }

.dql-app-block-cite i,
.dql-app-plan-item > i {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--status-success);
  flex: none;
}

.dql-app-block-cite i.draft,
.dql-app-plan-item > i.draft { background: var(--status-warning); }

.dql-app-seal {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 999px;
  min-height: 22px;
  padding: 2px 9px;
  width: fit-content;
  border: 1px solid rgba(22, 163, 74, 0.26);
  background: var(--status-success-bg);
  color: var(--status-success);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-seal::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.dql-app-seal.draft { border-color: rgba(202, 138, 4, 0.30); background: var(--status-warning-bg); color: var(--status-warning); }
.dql-app-seal.agentic { border-color: rgba(37, 99, 235, 0.32); background: var(--accent-dim); color: var(--accent); }

.dql-app-create-shell,
.dql-app-workspace {
  height: 100%;
  min-height: 0;
  display: grid;
}

.dql-app-create-shell { grid-template-rows: auto 1fr; overflow: hidden; }
.dql-app-workspace { grid-template-rows: auto auto 1fr; }

.dql-app-buildbar,
.dql-app-view-topbar {
  min-height: 54px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 18px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-2);
  flex-wrap: wrap;
}

.dql-app-back {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  cursor: pointer;
  flex: none;
}

.dql-app-back:hover { color: var(--text-primary); border-color: var(--border-default); }

.dql-app-back-label {
  width: auto;
  min-width: 72px;
  padding: 0 11px 0 9px;
  gap: 6px;
  justify-content: flex-start;
  color: var(--text-primary);
  font: 750 12px var(--font-ui);
}

.dql-app-back-label span {
  line-height: 1;
}

.dql-app-topbar-divider {
  width: 1px;
  height: 22px;
  background: var(--border-subtle);
  flex: none;
}

.dql-app-topbar-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dql-app-filter-icon {
  display: inline-flex;
  align-items: center;
  color: var(--text-tertiary);
}

.dql-app-name-input input {
  width: 240px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 8px;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font: 800 16px var(--font-ui);
}

.dql-app-name-input input:focus { border-color: var(--accent); background: var(--bg-3); }
.dql-app-mode-seg {
  margin: 0 auto;
  display: flex;
  gap: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-3);
  padding: 3px;
}

.dql-app-mode-seg button {
  min-width: 78px;
  border: 0;
  background: transparent;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  padding: 6px 12px;
  color: var(--text-secondary);
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-mode-seg button.on { background: var(--text-primary); color: #fff; }

.dql-app-customize-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--text-primary);
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-customize-btn:hover {
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--accent-dim);
  color: var(--accent);
}

.dql-app-customize-btn.on {
  border-color: var(--text-primary);
  background: var(--text-primary);
  color: #fff;
}
.dql-app-build-actions,
.dql-app-view-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dql-app-view-actions { position: relative; }

.dql-app-share-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 20;
  width: min(340px, 80vw);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-2);
  box-shadow: var(--shadow-card);
  padding: 10px;
  display: grid;
  gap: 7px;
}

.dql-app-share-popover b {
  color: var(--text-primary);
  font: 850 12px var(--font-ui);
}

.dql-app-share-popover textarea {
  width: 100%;
  min-height: 92px;
  resize: none;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-3);
  color: var(--text-primary);
  padding: 8px;
  font: 11px/1.45 var(--font-mono);
  box-sizing: border-box;
}

.dql-app-promote-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 21;
  max-width: min(360px, 80vw);
  border: 1px solid rgba(22, 163, 74, 0.28);
  border-radius: 8px;
  background: var(--status-success-bg);
  color: var(--text-primary);
  box-shadow: var(--shadow-card);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.4;
}

.dql-app-promote-popover.error {
  border-color: rgba(202, 138, 4, 0.28);
  background: var(--status-warning-bg);
}

.dql-app-persona {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 3px 9px 3px 4px;
  color: var(--text-secondary);
  font-size: 12px;
}

.dql-app-persona b {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
}

.dql-app-create-workspace {
  min-height: 0;
  display: grid;
  grid-template-columns: 380px minmax(420px, 1fr) 300px;
}

.dql-app-create-workspace.classic { grid-template-columns: 286px minmax(420px, 1fr) 320px; }
.dql-app-create-workspace.clean {
  display: block;
  min-height: calc(100vh - 56px);
  overflow: auto;
  padding: 26px;
  background: var(--bg-1);
}

.dql-app-ai-start {
  max-width: 1260px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
  gap: 18px;
  align-items: start;
}

.dql-app-ai-start-main {
  min-width: 0;
  display: grid;
  gap: 14px;
}

.dql-app-ai-start-copy h1 {
  margin: 0 0 7px;
  color: var(--text-primary);
  font-size: clamp(30px, 4vw, 52px);
  line-height: 0.98;
  letter-spacing: 0;
}

.dql-app-ai-start-copy p {
  margin: 0;
  max-width: 650px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.55;
}

.dql-app-ai-start-card {
  position: relative;
  border: 1px solid rgba(79, 99, 215, 0.32);
  border-radius: 12px;
  background: var(--bg-2);
  box-shadow: var(--shadow-card);
  padding: 18px 76px 18px 18px;
}

.dql-app-ai-start-card textarea {
  width: 100%;
  min-height: 124px;
  resize: vertical;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  padding: 0;
  font: 520 18px/1.45 var(--font-ui);
}

.dql-app-ai-start-send {
  position: absolute;
  right: 18px;
  bottom: 18px;
  width: 46px;
  height: 46px;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: white;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 14px 30px rgba(79, 99, 215, 0.24);
}

.dql-app-ai-start-send:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dql-app-ai-start-examples {
  padding-left: 2px;
}

.dql-app-ai-start-advanced {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  padding: 0 12px;
}

.dql-app-ai-start-advanced .dql-app-palette {
  max-height: 340px;
  margin: 0 0 12px;
}

.dql-app-ai-start-result {
  margin: 0;
}

.dql-app-ai-start-context {
  display: grid;
  gap: 12px;
}

.dql-app-ai-context-card {
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-2);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.04);
  overflow: hidden;
}

.dql-app-ai-evidence-list {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.dql-app-ai-evidence-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: start;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-3);
  padding: 10px;
}

.dql-app-ai-evidence-row > span:first-child {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--status-success-bg);
  color: var(--status-success);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dql-app-ai-evidence-row b {
  display: block;
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.25;
}

.dql-app-ai-evidence-row small {
  display: block;
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dql-app-ai-filter-preview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 12px;
}

.dql-app-ai-filter-preview span {
  min-height: 70px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-3);
  padding: 10px;
}

.dql-app-ai-filter-preview small {
  display: block;
  color: var(--text-tertiary);
  font: 800 9.5px var(--font-mono);
  text-transform: uppercase;
  margin-bottom: 8px;
}

.dql-app-ai-filter-preview b {
  color: var(--accent);
  font-size: 18px;
  line-height: 1.1;
}

.dql-app-ai-gap-list {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.dql-app-ai-gap-list span {
  display: flex;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

.dql-app-ai-gap-list svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--status-warning);
}

.dql-app-ai-generated-section {
  max-width: 1260px;
  margin: 18px auto 0;
  display: grid;
  gap: 12px;
}

.dql-app-ai-generated-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
}

.dql-app-ai-generated-head h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 20px;
}

.dql-app-ai-generated-head p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 12.5px;
}

.dql-app-ai-generated-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  gap: 14px;
  align-items: start;
}

.dql-app-ai-plan-compact {
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-2);
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.04);
}

.dql-app-plan-list.compact {
  max-height: 520px;
}
.dql-app-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-3);
}

.dql-app-panel:last-child { border-right: 0; }
.dql-app-panel-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 15px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-2);
}

.dql-app-panel-head span { font-weight: 850; font-size: 14px; }
.dql-app-panel-head b { margin-left: auto; color: var(--text-tertiary); font: 500 10px var(--font-mono); text-transform: uppercase; letter-spacing: 0; }

.dql-app-agent-scroll,
.dql-app-plan-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.dql-app-agent-panel.ai-clean { background: var(--bg-2); }
.dql-app-ai-brief {
  padding: 18px 16px 2px;
  display: grid;
  gap: 8px;
}

.dql-app-ai-brief > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-primary);
  font: 850 13px var(--font-ui);
}

.dql-app-ai-brief > span svg { color: var(--accent); }
.dql-app-ai-brief p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.dql-app-ai-result {
  margin-top: 5px;
  border: 1px solid rgba(22, 163, 74, 0.26);
  border-radius: 7px;
  background: var(--status-success-bg);
  color: var(--text-primary);
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-ai-result small {
  display: block;
  margin-top: 3px;
  color: var(--text-secondary);
  font: 700 10px var(--font-mono);
}

.dql-app-composer {
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-2);
  padding: 12px;
  display: grid;
  gap: 9px;
}

.dql-app-composer.ai-clean {
  border-top: 0;
  padding: 10px 16px 16px;
  gap: 9px;
}

.dql-app-suggestions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.dql-app-suggestions > span {
  color: var(--text-tertiary);
  font: 750 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-suggestions button,
.dql-app-suggests button {
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  padding: 2px 0;
  cursor: pointer;
  font: 750 11.5px var(--font-ui);
}

.dql-app-suggestions button:hover,
.dql-app-suggests button:hover {
  color: var(--accent);
}

.dql-app-composer textarea,
.dql-app-form-grid input,
.dql-app-select-label select,
.dql-app-modal input {
  width: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-3);
  color: var(--text-primary);
  outline: 0;
  padding: 8px 10px;
  font: 12.5px var(--font-ui);
}

.dql-app-composer textarea { resize: vertical; min-height: 92px; line-height: 1.45; }
.dql-app-composer.ai-clean textarea {
  min-height: 130px;
  background: var(--bg-2);
  border-color: var(--border-default);
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 13.5px;
}
.dql-app-form-grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dql-app-form-grid label,
.dql-app-select-label,
.dql-app-modal label {
  display: grid;
  gap: 5px;
  color: var(--text-secondary);
  font: 700 10px var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
}

.dql-app-ai-context {
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
}

.dql-app-ai-context summary {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  cursor: pointer;
  list-style: none;
}

.dql-app-ai-context summary::-webkit-details-marker { display: none; }

.dql-app-ai-context summary span {
  color: var(--text-secondary);
  font: 800 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-ai-context summary b {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font: 750 11px var(--font-ui);
}

.dql-app-ai-context summary svg {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  transition: transform 140ms ease;
}

.dql-app-ai-context[open] summary svg { transform: rotate(180deg); }

.dql-app-ai-context-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  padding: 0 0 10px;
  border-top: 1px solid var(--border-subtle);
}

.dql-app-ai-context-grid label {
  display: grid;
  gap: 5px;
  color: var(--text-secondary);
  font: 700 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-ai-context-grid input,
.dql-app-ai-context-grid select {
  width: 100%;
  height: 34px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-3);
  color: var(--text-primary);
  outline: 0;
  padding: 0 10px;
  font: 12.5px var(--font-ui);
}

.dql-app-ai-send-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 3px;
}

.dql-app-ai-send-row span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font: 750 11px var(--font-ui);
}

.dql-app-ai-send-row span svg {
  color: var(--status-success);
}

.dql-app-preview-panel { background: var(--bg-1); }
.dql-app-preview-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 20px 40px; }
.dql-app-preview-card {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  overflow: hidden;
}

.dql-app-preview-head {
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-preview-head h2 { margin: 0; font-size: 19px; }
.dql-app-preview-filters {
  display: flex;
  gap: 7px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-3);
}

.dql-app-preview-filters span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-secondary);
  padding: 4px 9px;
  font-size: 11px;
}

.dql-app-preview-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 18px;
  min-height: 300px;
}

.dql-app-preview-empty {
  grid-column: 1 / -1;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-tertiary);
  text-align: center;
}

.dql-app-preview-tile {
  grid-column: span 4;
  min-height: 136px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.dql-app-preview-tile.wide { grid-column: span 6; }
.dql-app-preview-tile.draft { border-color: rgba(202, 138, 4, 0.34); }
.dql-app-preview-tile-head,
.dql-app-preview-tile-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-preview-tile-head b { font-size: 12px; }
.dql-app-preview-tile-head span,
.dql-app-preview-tile-foot {
  color: var(--text-tertiary);
  font: 700 9px var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
}

.dql-app-preview-tile-head span { margin-left: auto; }
.dql-app-preview-tile-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 10px;
}

.dql-app-preview-tile-body strong { font-size: 26px; }
.dql-app-preview-tile-body small { color: var(--text-secondary); }
.dql-app-preview-source {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}
.dql-app-preview-source > span {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-dim);
  color: var(--accent);
}
.dql-app-preview-source b {
  display: block;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.2;
}
.dql-app-preview-source p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dql-app-preview-viz-row {
  display: flex;
  gap: 4px;
  padding: 0 10px 8px;
  align-items: center;
}
.dql-app-preview-viz-row button {
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.dql-app-preview-viz-row button.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.dql-app-preview-viz-row button:disabled {
  cursor: default;
  opacity: 0.58;
}
.dql-app-preview-tile-foot { border-bottom: 0; border-top: 1px solid var(--border-subtle); }
.dql-app-preview-tile-foot b { margin-left: auto; color: var(--status-success); }
.dql-app-preview-tile.draft .dql-app-preview-tile-foot b { color: var(--status-warning); }
.dql-app-review-backlog {
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-3);
  padding: 14px 18px 18px;
}
.dql-app-review-backlog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--text-secondary);
}
.dql-app-review-backlog-head span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 850 12px var(--font-ui);
  color: var(--text-primary);
}
.dql-app-review-backlog-head b {
  margin-left: auto;
  min-width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--status-warning-bg);
  color: var(--status-warning);
  font: 800 10px var(--font-mono);
}
.dql-app-review-backlog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.dql-app-review-backlog-item {
  border: 1px solid rgba(202, 138, 4, 0.22);
  border-radius: 8px;
  background: var(--bg-2);
  padding: 11px;
  display: grid;
  gap: 9px;
}
.dql-app-review-backlog-item b {
  display: block;
  font-size: 12.5px;
  line-height: 1.25;
}
.dql-app-review-backlog-item p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.4;
}
.dql-app-review-backlog-item > div:last-child {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.dql-app-review-backlog-item span {
  border: 1px solid rgba(79, 99, 215, 0.18);
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  padding: 3px 7px;
  font: 750 10px var(--font-ui);
}
.dql-app-planner-flow {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  padding: 11px;
  margin-bottom: 12px;
}
.dql-app-planner-flow-title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--accent);
  font: 850 12px var(--font-ui);
}
.dql-app-planner-flow p {
  margin: 7px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.42;
}
.dql-app-planner-flow-steps {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.dql-app-planner-flow-steps span {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 7px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.35;
}
.dql-app-planner-flow-steps b {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-dim);
  color: var(--accent);
  font: 850 10px var(--font-mono);
}
.dql-app-plan-group-label {
  margin: 14px 0 4px;
  color: var(--text-tertiary);
  font: 850 10px var(--font-mono);
  text-transform: uppercase;
}
.dql-app-plan-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-plan-item span { flex: 1; min-width: 0; }
.dql-app-plan-item b { display: block; font: 700 11.5px var(--font-mono); }
.dql-app-plan-item small { display: block; color: var(--text-tertiary); font-size: 10px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-plan-item em { color: var(--text-tertiary); font: 700 9px var(--font-mono); text-transform: uppercase; font-style: normal; }

.dql-app-plan-session,
.dql-app-plan-warning,
.dql-app-plan-task {
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  padding: 8px 9px;
  background: var(--bg-3);
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.35;
}

.dql-app-plan-session span {
  display: block;
  color: var(--text-primary);
  font-weight: 800;
}

.dql-app-plan-session small {
  display: block;
  margin-top: 2px;
  color: var(--text-tertiary);
}

.dql-app-plan-warning {
  border-color: rgba(202, 138, 4, 0.24);
  background: var(--status-warning-bg);
}

.dql-app-plan-task {
  display: flex;
  align-items: flex-start;
  gap: 7px;
}

.dql-app-plan-foot {
  margin-top: auto;
  padding: 14px;
  border-top: 2px solid var(--accent);
  background: var(--accent-dim);
}

.dql-app-leader {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-secondary);
  margin: 5px 0;
}

.dql-app-leader i { flex: 1; border-bottom: 1.5px dotted var(--border-default); transform: translateY(-3px); }
.dql-app-leader b { font-family: var(--font-mono); color: var(--text-primary); }
.dql-app-leader.certified b { color: var(--status-success); }
.dql-app-leader.draft b { color: var(--status-warning); }

.dql-app-error {
  border: 1px solid rgba(220, 38, 38, 0.24);
  border-radius: 6px;
  background: rgba(220, 38, 38, 0.06);
  color: #b91c1c;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
  margin-top: 10px;
}

.dql-app-palette { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.dql-app-agent-scroll .dql-app-palette {
  margin-top: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-3);
  padding: 10px;
  max-height: 360px;
}

.dql-app-palette-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.dql-app-palette-title span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-primary);
  font: 850 12px var(--font-ui);
}

.dql-app-palette-title b {
  margin-left: auto;
  color: var(--text-tertiary);
  font: 700 9.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-palette-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-2);
  color: var(--text-secondary);
  padding: 8px 10px;
  margin-bottom: 10px;
  font-size: 12px;
}

.dql-app-palette-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font: 12px var(--font-ui);
}

.dql-app-palette button {
  width: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-2);
  color: var(--text-primary);
  padding: 9px 10px;
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  cursor: pointer;
}

.dql-app-palette button.selected { border-color: var(--accent); background: var(--accent-dim); }
.dql-app-palette-icon {
  width: 25px;
  height: 25px;
  border-radius: 6px;
  background: #f1f5f9;
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.dql-app-palette span:nth-child(2) { flex: 1; min-width: 0; }
.dql-app-palette b { display: block; font: 700 11px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-palette small { display: block; color: var(--text-tertiary); font-size: 10px; }
.dql-app-palette i { color: var(--status-success); font: 700 9px var(--font-mono); text-transform: uppercase; font-style: normal; }
.dql-app-palette-more {
  color: var(--text-tertiary);
  text-align: center;
  font: 700 10px var(--font-mono);
  padding: 8px 0 2px;
}

.dql-app-view-topbar { position: relative; z-index: 4; }
.dql-app-view-topbar {
  min-height: 48px;
  padding: 7px 22px;
  box-shadow: 0 1px 0 var(--border-subtle);
  background: var(--bg-2);
  backdrop-filter: blur(10px);
}

.dql-app-crumb { color: var(--text-secondary); font: 700 11.5px var(--font-mono); }
.dql-app-filterbar {
  position: relative;
  z-index: 3;
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 26px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-2);
  flex-wrap: wrap;
}

.dql-app-filter-select {
  height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-3);
  padding: 0 10px;
}

.dql-app-filter-select span {
  color: var(--text-tertiary);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-filter-select select,
.dql-app-filter-select input {
  border: 0;
  background: transparent;
  color: var(--text-primary);
  outline: 0;
  font: 750 12.5px var(--font-ui);
  min-width: 0;
  max-width: 110px;
}

.dql-app-filter-select input[type="number"] {
  width: 64px;
}

.dql-app-filter-empty {
  color: var(--text-tertiary);
  font: 750 11px var(--font-ui);
}

.dql-app-filter-note {
  margin-left: auto;
  color: var(--text-tertiary);
  font: 700 11px var(--font-ui);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dql-app-toggle {
  border: 0;
  background: transparent;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  font: 800 12px var(--font-ui);
}

.dql-app-toggle i {
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: #cbd5e1;
  position: relative;
}

.dql-app-toggle i::after {
  content: "";
  width: 14px;
  height: 14px;
  border-radius: 999px;
  position: absolute;
  top: 2px;
  left: 2px;
  background: #fff;
  transition: transform 140ms ease;
}

.dql-app-toggle.on i { background: var(--accent); }
.dql-app-toggle.on i::after { transform: translateX(14px); }

.dql-app-view-wrap {
  position: relative;
  z-index: 1;
  width: min(1560px, calc(100% - 40px));
  margin: 0 auto;
  padding: 12px 0 60px;
}

.dql-app-title-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.dql-app-title-copy {
  flex: 1 1 420px;
  min-width: 0;
}

.dql-app-title-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.dql-app-title-meta > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font: 750 11.5px var(--font-ui);
  text-transform: capitalize;
}

.dql-app-title-row h1 {
  margin: 0;
  font-size: 26px;
  line-height: 1.1;
  font-weight: 820;
}

.dql-app-title-row p {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.45;
  max-width: 720px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dql-app-title-context {
  display: inline-flex;
  align-items: center;
  color: var(--text-tertiary);
  font: 700 11.5px var(--font-mono);
}
.dql-app-title-context::before { content: "·"; margin-right: 8px; color: var(--border-default); }

.dql-app-nav-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.dql-app-section-tabs,
.dql-app-page-picker {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dql-app-section-tabs {
  overflow-x: auto;
}

.dql-app-section-tabs button,
.dql-app-page-picker {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-secondary);
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  font: 750 12px var(--font-ui);
}

.dql-app-section-tabs {
  gap: 6px;
}

.dql-app-section-tabs button {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  min-height: 32px;
  padding: 6px 9px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-section-tabs button {
  min-width: 38px;
  justify-content: center;
}

.dql-app-section-tabs .dql-app-tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-style: normal;
}

.dql-app-section-tabs .dql-app-tab-label {
  display: none;
}

.dql-app-section-tabs button.on .dql-app-tab-label {
  display: inline;
}

.dql-app-section-tabs button.on,
.dql-app-section-tabs button:hover {
  color: var(--text-primary);
  background: var(--accent-dim);
}

.dql-app-section-tabs button.on {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.dql-app-section-tabs b {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10px;
}

.dql-app-page-picker {
  padding: 0 5px 0 10px;
  white-space: nowrap;
  max-width: min(440px, 100%);
}

.dql-app-page-picker > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-tertiary);
  font: 800 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-page-picker select {
  min-width: 210px;
  max-width: 310px;
  height: 30px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font: 800 12px var(--font-ui);
  text-overflow: ellipsis;
}

.dql-app-page-picker button {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: var(--accent-dim);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.dql-app-dashboard-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dql-app-view-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: start;
}

.dql-app-view-layout.no-explain { grid-template-columns: minmax(0, 1fr); }
.dql-app-main-column { min-width: 0; }

.dql-app-explain-panel {
  position: sticky;
  top: 110px;
  width: clamp(420px, 29vw, 500px);
  min-width: 390px;
  max-width: min(520px, 40vw);
  min-height: 580px;
  height: calc(100vh - 142px);
  max-height: calc(100vh - 142px);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  background: var(--bg-2);
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.14);
}

.dql-app-copilot-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dql-app-assistant-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-3));
}

.dql-app-assistant-top {
  display: grid;
  gap: 11px;
  padding: 15px 16px;
  border-bottom: 1px solid var(--border-subtle);
  flex: none;
  background: var(--bg-2);
}

.dql-app-assistant-title-row {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.dql-app-assistant-icon {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  background: var(--accent-dim);
  border: 1px solid rgba(79, 99, 215, 0.28);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dql-app-assistant-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dql-app-assistant-kicker {
  color: var(--text-secondary);
  font: 800 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-assistant-heading h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-assistant-focus {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.dql-app-assistant-focus span {
  color: var(--text-secondary);
  font: 800 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-assistant-focus select {
  width: 100%;
  height: 36px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-primary);
  padding: 0 10px;
  font: 750 12px var(--font-ui);
  cursor: pointer;
}

.dql-app-assistant-context-btn {
  flex: none;
  height: 30px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-3);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  cursor: pointer;
  font: 800 11px var(--font-ui);
}

.dql-app-assistant-context-btn.on,
.dql-app-assistant-context-btn:hover {
  color: var(--accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--accent-dim);
}

.dql-app-assistant-context-btn.on svg { transform: rotate(180deg); }

.dql-app-assistant-context {
  display: grid;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-3);
}

.dql-app-assistant-context p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-assistant-context > div {
  display: grid;
  gap: 6px;
}

.dql-app-one-ai-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--bg-2);
}

.dql-app-one-ai-status {
  margin: 0;
  display: grid;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-3) 72%, var(--bg-2));
  flex: none;
}

.dql-app-one-ai-status span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--status-success);
  font: 850 11px var(--font-ui);
}

.dql-app-one-ai-status > div {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.dql-app-one-ai-status > div::-webkit-scrollbar {
  display: none;
}

.dql-app-one-ai-status b {
  flex: none;
  min-width: 0;
  max-width: 190px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-tertiary);
  font: 750 10.5px var(--font-ui);
  padding: 4px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-copilot-thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 0 20px;
}

.dql-app-direct-ask {
  margin-top: 0;
  z-index: 4;
  border-top: 1px solid var(--border-subtle);
  padding: 14px 16px 16px;
  display: grid;
  gap: 8px;
  flex: none;
  background: color-mix(in srgb, var(--bg-2) 92%, transparent);
  backdrop-filter: blur(10px);
  box-shadow: 0 -12px 28px rgba(15, 23, 42, 0.05);
}

.dql-app-direct-ask-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
}

.dql-app-direct-ask-row textarea {
  width: 100%;
  min-height: 96px;
  max-height: 150px;
  resize: vertical;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  background: var(--bg-2);
  color: var(--text-primary);
  padding: 12px 13px;
  font: 500 13.5px/1.45 var(--font-ui);
  outline: none;
}

.dql-app-direct-ask-row textarea:focus {
  border-color: rgba(79, 99, 215, 0.48);
  box-shadow: 0 0 0 3px rgba(79, 99, 215, 0.1);
}

.dql-app-direct-ask-row button,
.dql-app-direct-quick button {
  border: 1px solid var(--border-default);
  border-radius: 12px;
  background: var(--bg-2);
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  font-weight: 750;
}

.dql-app-direct-ask-row button {
  min-height: 48px;
  padding-inline: 13px;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.dql-app-direct-ask-row button:disabled {
  opacity: 0.55;
}

.dql-app-direct-quick {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.dql-app-direct-quick button {
  color: var(--text-secondary);
  font-size: 11.5px;
  padding: 7px 9px;
  white-space: nowrap;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-copilot-welcome {
  margin: 2px 16px 0;
  border: 1px dashed var(--border-default);
  border-radius: 12px;
  background: var(--bg-2);
  padding: 12px;
  display: grid;
  gap: 6px;
}

.dql-app-user-message {
  align-self: flex-end;
  max-width: calc(100% - 42px);
  margin: 0 16px 0 42px;
  border: 1px solid rgba(79, 99, 215, 0.28);
  border-radius: 14px 14px 5px 14px;
  background: var(--accent);
  color: #fff;
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(79, 99, 215, 0.16);
}

.dql-app-user-message span {
  display: block;
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
  opacity: .72;
}

.dql-app-user-message p {
  margin: 4px 0 0;
  color: inherit;
  font-size: 12.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.dql-app-copilot-welcome span {
  color: var(--accent);
  font: 850 10.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-welcome p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.48;
}

.dql-app-direct-answer {
  border: 1px solid var(--border-subtle);
  border-radius: 14px 14px 14px 5px;
  background: var(--bg-2);
  margin: 0 42px 0 16px;
  padding: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
}

.dql-app-direct-answer > div:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.dql-app-direct-answer p {
  margin: 0;
  color: var(--text-primary);
  font-size: 12.5px;
  line-height: 1.45;
}

.dql-app-direct-followups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.dql-app-direct-followups span,
.dql-app-direct-followups button {
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 3px 7px;
  color: var(--text-secondary);
  font-size: 10.5px;
  background: var(--bg-2);
}

.dql-app-direct-followups button {
  cursor: pointer;
  font-weight: 750;
}

.dql-app-direct-followups button:hover {
  color: var(--accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--accent-dim);
}

.dql-app-copilot-action-grid {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.dql-app-copilot-next-step {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  border: 1px solid rgba(79, 99, 215, 0.18);
  border-radius: 11px;
  background: color-mix(in srgb, var(--accent-dim) 58%, var(--bg-2));
  padding: 10px;
}

.dql-app-copilot-next-step > span {
  color: var(--accent);
  font: 850 10.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-copilot-next-step p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-analysis-handoff {
  margin: 0 16px;
  border: 1px solid rgba(22, 163, 74, 0.2);
  border-radius: 12px;
  background: rgba(22, 163, 74, 0.06);
  padding: 12px;
  display: grid;
  gap: 7px;
}

.dql-app-analysis-handoff > span {
  color: #15803d;
  font: 850 10.5px var(--font-mono);
  letter-spacing: .02em;
  text-transform: uppercase;
}

.dql-app-analysis-handoff p {
  margin: 0;
  color: var(--text-primary);
  font-size: 12.5px;
  line-height: 1.45;
}

.dql-app-analysis-handoff small {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-analysis-handoff > div {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 2px;
}

.dql-app-context-composer {
  margin: 0 16px;
  border: 1px solid rgba(79, 99, 215, 0.28);
  border-radius: 14px;
  background: var(--bg-2);
  box-shadow: 0 16px 44px rgba(79, 99, 215, 0.11);
  padding: 12px;
  display: grid;
  gap: 9px;
}

.dql-app-context-composer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dql-app-context-composer h4 {
  margin: 0;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.25;
}

.dql-app-context-composer p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-context-composer textarea {
  width: 100%;
  min-height: 158px;
  resize: vertical;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-3);
  color: var(--text-primary);
  outline: 0;
  padding: 10px;
  font: 12.5px/1.5 var(--font-ui);
}

.dql-app-context-composer textarea:focus {
  border-color: rgba(79, 99, 215, 0.54);
  box-shadow: 0 0 0 3px rgba(79, 99, 215, 0.1);
}

.dql-app-context-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dql-app-context-chips span {
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--text-secondary);
  padding: 4px 8px;
  font: 750 10px var(--font-ui);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-context-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dql-app-copilot-hero {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, var(--bg-2), var(--bg-3));
}

.dql-app-copilot-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-secondary);
  font: 750 10px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-kicker svg { color: var(--accent); }
.dql-app-copilot-hero h3 {
  margin: 6px 0 0;
  color: var(--text-primary);
  font-size: 19px;
  line-height: 1.15;
}

.dql-app-copilot-hero p {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.42;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dql-app-copilot-decision {
  margin-top: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-2);
  padding: 7px 9px;
}

.dql-app-copilot-decision small,
.dql-app-copilot-facts small {
  display: block;
  color: var(--text-secondary);
  font: 750 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-decision b {
  display: block;
  margin-top: 3px;
  color: var(--text-primary);
  font-size: 11.5px;
  line-height: 1.32;
}

.dql-app-copilot-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-top: 7px;
}

.dql-app-copilot-facts span {
  min-width: 0;
  border-radius: 7px;
  background: var(--bg-3);
  padding: 6px 8px;
}

.dql-app-copilot-facts b {
  display: block;
  margin-top: 2px;
  color: var(--text-primary);
  font-size: 10.5px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-copilot-chat {
  flex: 1;
  min-height: 210px;
  padding: 9px 12px 12px;
}

.dql-app-explain-head { padding: 14px 16px 12px; border-bottom: 1px solid var(--border-subtle); }
.dql-app-explain-head span,
.dql-app-ex-label {
  color: var(--text-secondary);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-explain-head h3 { margin: 3px 0 0; font-size: 17px; }
.dql-app-explain-head p { margin: 5px 0 0; color: var(--text-secondary); font-size: 11.5px; line-height: 1.45; }
.dql-app-ex-section { padding: 13px 16px; border-bottom: 1px solid var(--border-subtle); }
.dql-app-ex-section.compact { padding-top: 11px; padding-bottom: 11px; }
.dql-app-copilot-controls {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-copilot-focus {
  display: grid;
  gap: 5px;
}

.dql-app-copilot-focus span {
  color: var(--text-secondary);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-focus select {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: 1px solid var(--border-default);
  border-radius: 7px;
  background: var(--bg-3);
  color: var(--text-primary);
  padding: 0 10px;
  font: 800 12px var(--font-ui);
}

.dql-app-copilot-empty {
  margin-top: 7px;
  color: var(--text-tertiary);
  font-size: 11px;
}

.dql-app-copilot-brief {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-copilot-brief > div {
  min-width: 0;
  flex: 1;
}

.dql-app-copilot-brief span {
  display: inline-flex;
  color: var(--status-success);
  font: 750 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-brief b {
  display: block;
  margin-top: 4px;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.25;
}

.dql-app-copilot-brief p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.35;
}

.dql-app-copilot-result-pill {
  flex: none;
  border-radius: 999px;
  border: 1px solid rgba(22, 163, 74, 0.24);
  background: var(--status-success-bg);
  color: var(--status-success) !important;
  padding: 4px 8px;
  white-space: nowrap;
}

.dql-app-copilot-prompts {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-copilot-prompts button {
  min-width: 0;
  height: 31px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-secondary);
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-copilot-prompts button:hover {
  color: var(--accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--accent-dim);
}

.dql-app-copilot-prompts svg {
  flex: 0 0 auto;
}

.dql-app-copilot-evidence {
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-copilot-evidence summary {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  cursor: pointer;
  color: var(--text-secondary);
  font: 800 11px var(--font-ui);
  list-style: none;
}

.dql-app-copilot-evidence summary::-webkit-details-marker { display: none; }
.dql-app-copilot-evidence summary span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dql-app-copilot-evidence summary small {
  margin-left: auto;
  min-width: 0;
  max-width: 160px;
  color: var(--text-tertiary);
  font: 700 10px var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-copilot-evidence > div {
  display: grid;
  gap: 6px;
  padding: 0 12px 11px;
}

.dql-app-keyvalue-inline {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  font-size: 11px;
}

.dql-app-keyvalue-inline span {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.dql-app-keyvalue-inline b {
  min-width: 0;
  color: var(--text-secondary);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dql-app-block-cite {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 0;
  font-size: 11.5px;
}

.dql-app-block-cite span { flex: 1; min-width: 0; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-block-cite b { color: var(--text-tertiary); font: 10px var(--font-mono); }
.dql-app-flow { margin-top: 8px; }
.dql-app-flow-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 11.5px;
}

.dql-app-flow-node span {
  width: 28px;
  height: 23px;
  border-radius: 6px;
  background: var(--accent-dim);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 700 8px var(--font-mono);
}

.dql-app-flow-node b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-flow-node small { color: var(--text-tertiary); font: 9px var(--font-mono); }
.dql-app-flow i {
  display: block;
  width: 2px;
  height: 9px;
  background: var(--accent);
  margin-left: 13px;
}

.dql-app-suggests { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.dql-app-focus-list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.dql-app-focus-list > span {
  color: var(--text-tertiary);
  font-size: 12px;
}

.dql-app-focus-list button {
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  cursor: pointer;
  text-align: left;
}

.dql-app-focus-list button.on {
  color: var(--text-primary);
  border-color: rgba(79, 99, 215, 0.42);
  background: var(--accent-dim);
}

.dql-app-focus-list button svg {
  flex: 0 0 auto;
  color: var(--accent);
}

.dql-app-focus-list button span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 800 11.5px var(--font-ui);
}

.dql-app-focus-list button b {
  color: var(--text-tertiary);
  font: 700 8.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-rail-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.dql-app-rail-title > span { flex: 1; }

.dql-app-rail-title button {
  height: 26px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-drilldown-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}

.dql-app-drilldown-grid button {
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-secondary);
  padding: 8px 6px;
  display: grid;
  justify-items: center;
  gap: 5px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-drilldown-grid button:hover {
  color: var(--accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--accent-dim);
}

.dql-app-rail-chat {
  height: 100%;
  min-height: 0;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-2);
}

.dql-app-rail-chat.expanded {
  position: fixed;
  z-index: 80;
  right: 24px;
  top: 76px;
  bottom: 24px;
  width: min(760px, calc(100vw - 80px));
  height: auto;
  box-shadow: 0 18px 60px rgba(15, 23, 42, 0.24);
}

.dql-app-gapcard {
  margin: 12px;
  border-radius: 7px;
  background: var(--status-warning-bg);
  padding: 11px 12px;
}

.dql-app-gapcard p { margin: 6px 0 0; color: var(--text-secondary); font-size: 11.5px; line-height: 1.45; }
.dql-app-research-shell {
  display: grid;
  gap: 14px;
  min-height: 620px;
}

.dql-app-research-shell.history-open {
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
}

.dql-app-research-shell.history-collapsed {
  grid-template-columns: minmax(0, 1fr);
}

.dql-app-research-shell.history-collapsed .dql-app-research-list {
  display: none;
}

.dql-app-research-list {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
}

.dql-app-research-list {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.dql-app-research-detail {
  padding: 0;
  min-width: 0;
  overflow: auto;
  background: transparent;
}

.dql-app-research-head,
.dql-app-research-titlebar,
.dql-app-research-evidence-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dql-app-research-head span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 850;
}

.dql-app-research-head > div {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.dql-app-research-head b {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
}

.dql-app-research-head button {
  height: 26px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--text-secondary);
  padding: 0 9px;
  cursor: pointer;
  font: 800 10px var(--font-ui);
}

.dql-app-research-head button:hover {
  color: var(--accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--accent-dim);
}

.dql-app-research-new {
  height: 32px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-3);
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font: 800 12px var(--font-ui);
  cursor: pointer;
}

.dql-app-research-new:disabled { opacity: 0.65; cursor: not-allowed; }
.dql-app-research-items { display: grid; gap: 6px; overflow: auto; }
.dql-app-research-group-label {
  margin: 4px 2px 1px;
  color: var(--text-tertiary);
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}
.dql-app-research-items button {
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  padding: 9px;
  cursor: pointer;
  min-width: 0;
}

.dql-app-research-items button.on,
.dql-app-research-items button:hover {
  border-color: var(--border-subtle);
  background: var(--bg-3);
}

.dql-app-research-items button.status-error:not(.on) {
  color: var(--text-secondary);
  opacity: 0.72;
}

.dql-app-research-items button.status-error small {
  color: var(--status-warning);
}

.dql-app-research-items button.status-ready small {
  color: var(--status-success);
}

.dql-app-research-history-toggle {
  border-style: dashed !important;
  background: var(--bg-3) !important;
  color: var(--text-secondary) !important;
}

.dql-app-research-items span,
.dql-app-research-items small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-research-items span { font-weight: 800; font-size: 12px; }
.dql-app-research-items small { margin-top: 3px; color: var(--text-secondary); font-size: 10.5px; }
.dql-app-research-titlebar { align-items: flex-start; margin-bottom: 14px; }
.dql-app-research-titlebar h2 {
  margin: 2px 0 0;
  font-size: 20px;
  line-height: 1.2;
}

.dql-app-research-status {
  margin: 0 0 12px;
  border: 1px solid rgba(37, 99, 235, 0.26);
  border-radius: 8px;
  background: var(--accent-dim);
  color: var(--accent);
  padding: 10px 12px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font: 800 12px var(--font-ui);
}

.dql-app-research-status.opening {
  border-color: rgba(79, 99, 215, 0.28);
  background: color-mix(in srgb, var(--accent-dim) 72%, var(--bg-2));
}

.dql-app-research-status > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.dql-app-research-status small {
  color: var(--text-secondary);
  font: 700 11px/1.35 var(--font-ui);
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-report-toolbar {
  max-width: 1120px;
  margin: 0 auto 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dql-app-report-toolbar > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.dql-app-report-toolbar span {
  color: var(--text-tertiary);
  font: 850 9.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-report-toolbar b {
  min-width: 0;
  color: var(--text-primary);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-research-creating {
  max-width: 760px;
  min-height: 340px;
  margin: 40px auto;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--bg-2);
  box-shadow: var(--shadow-card);
  color: var(--text-secondary);
  padding: 42px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  text-align: center;
}

.dql-app-research-creating.active {
  max-width: 920px;
  min-height: 420px;
  border-color: rgba(79, 99, 215, 0.24);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent-dim) 24%, var(--bg-2)), var(--bg-2) 48%),
    var(--bg-2);
}

.dql-app-research-creating svg {
  color: var(--accent);
}

.dql-app-research-creating > span {
  color: var(--accent);
  font: 850 10.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-research-creating h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 24px;
}

.dql-app-research-creating p {
  margin: 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.6;
}

.dql-app-research-creating-steps {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
  max-width: 680px;
}

.dql-app-research-creating-steps small {
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--text-secondary);
  padding: 5px 9px;
  font: 750 11px var(--font-ui);
}

.dql-app-research-report {
  max-width: 1040px;
  margin: 0 auto;
  border: 0;
  border-radius: 0;
  background: var(--bg-2);
  box-shadow: none;
  overflow: visible;
}

.dql-app-report-hero {
  padding: 26px 34px 20px;
  border-bottom: 0;
  background: var(--bg-2);
}

.dql-app-report-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.dql-app-report-status-row > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-secondary);
  font: 850 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-report-hero h2 {
  margin: 18px 0 0;
  color: var(--text-primary);
  font-size: clamp(25px, 2.4vw, 34px);
  line-height: 1.08;
  max-width: 860px;
  text-wrap: balance;
}

.dql-app-report-hero p {
  margin: 14px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.6;
  max-width: 850px;
}

.dql-app-report-context-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.dql-app-report-context-line span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-secondary);
  padding: 6px 10px;
  font-size: 11.5px;
  max-width: 100%;
}

.dql-app-report-context-line b {
  color: var(--text-primary);
  font-weight: 850;
}

.dql-app-report-route {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 14px;
  border: 1px solid rgba(79, 99, 215, 0.18);
  border-radius: 10px;
  background: rgba(79, 99, 215, 0.055);
  padding: 10px 12px;
  max-width: 900px;
}

.dql-app-report-route > svg {
  color: var(--accent);
  flex: 0 0 auto;
  margin-top: 2px;
}

.dql-app-report-route span {
  display: block;
  color: var(--accent);
  font: 850 10.5px var(--font-mono);
  letter-spacing: .02em;
  text-transform: uppercase;
}

.dql-app-report-route p {
  margin: 5px 0 0;
  color: var(--text-primary);
  font-size: 12.5px;
  line-height: 1.45;
}

.dql-app-report-route small {
  display: block;
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.dql-app-report-review-actions {
  position: relative;
}

.dql-app-report-review-actions summary {
  list-style: none;
  height: 32px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-secondary);
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  font: 800 11.5px var(--font-ui);
}

.dql-app-report-review-actions summary::-webkit-details-marker {
  display: none;
}

.dql-app-report-review-actions[open] summary,
.dql-app-report-review-actions summary:hover {
  color: var(--accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--accent-dim);
}

.dql-app-report-review-actions > div {
  position: absolute;
  z-index: 5;
  right: 0;
  top: calc(100% + 6px);
  min-width: 220px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-2);
  box-shadow: var(--shadow-card);
  padding: 8px;
  display: grid;
  gap: 7px;
}

.dql-app-report-review-actions > div .dql-apps-btn {
  justify-content: flex-start;
  width: 100%;
}

.dql-app-report-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  border: 1px solid rgba(217, 119, 6, 0.24);
  border-radius: 9px;
  background: rgba(251, 191, 36, 0.12);
  color: #92400e;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-warning svg {
  flex: none;
  margin-top: 1px;
}

.dql-app-report-section {
  padding: 24px 34px;
  border-bottom: 0;
}

.dql-app-report-section:last-child {
  border-bottom: 0;
}

.dql-app-report-section h3 {
  margin: 0 0 12px;
  color: var(--text-primary);
  font-size: 17px;
  line-height: 1.25;
}

.dql-app-report-paper {
  color: var(--text-primary);
  font-size: 14.5px;
  line-height: 1.78;
  padding: 26px 54px 20px;
}

.dql-app-report-paper h2,
.dql-app-report-paper h3 {
  margin: 18px 0 8px;
  color: var(--text-primary);
  font-size: 18px;
  line-height: 1.22;
}

.dql-app-report-paper h2:first-child,
.dql-app-report-paper h3:first-child {
  margin-top: 0;
}

.dql-app-report-paper p,
.dql-app-report-paper ul,
.dql-app-report-paper ol {
  max-width: 900px;
}

.dql-app-report-dynamic-sections {
  display: grid;
  gap: 30px;
}

.dql-app-report-dynamic-section {
  border-left: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.dql-app-report-dynamic-head {
  display: grid;
  gap: 5px;
}

.dql-app-report-dynamic-head span {
  color: var(--text-secondary);
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-report-dynamic-head h3 {
  margin: 0;
  font-size: 20px;
  line-height: 1.18;
}

.dql-app-report-memo-body {
  display: grid;
  gap: 10px;
  max-width: 900px;
}

.dql-app-report-memo-body p {
  margin: 0;
  color: var(--text-primary);
  font-size: 14.5px;
  line-height: 1.72;
}

.dql-app-report-dynamic-section ul {
  margin: 4px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 7px;
  max-width: 820px;
}

.dql-app-report-dynamic-section li {
  color: var(--text-primary);
  font-size: 14.5px;
  line-height: 1.6;
}

.dql-app-report-evidence-story {
  display: grid;
  grid-template-columns: minmax(280px, 0.9fr) minmax(360px, 1.1fr);
  gap: 24px;
  align-items: start;
  margin: 6px 34px 12px;
  border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent);
  border-radius: 12px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-3) 64%, var(--bg-2)), var(--bg-2));
}

.dql-app-report-evidence-story.single {
  grid-template-columns: minmax(0, 1fr);
}

.dql-app-report-evidence-story .dql-app-report-numbers {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.dql-app-report-prose {
  font-size: 14px;
  line-height: 1.65;
}

.dql-app-report-callout {
  margin-top: 16px;
  border-left: 3px solid var(--accent);
  background: var(--bg-3);
  padding: 12px 14px;
  color: var(--text-secondary);
}

.dql-app-report-numbers {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.dql-app-report-number {
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--bg-2);
  padding: 13px;
  min-width: 0;
}

.dql-app-report-number span,
.dql-app-report-number small {
  display: block;
  color: var(--text-secondary);
}

.dql-app-report-number span {
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-report-number b {
  display: block;
  margin-top: 7px;
  color: var(--text-primary);
  font-size: 23px;
  line-height: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-report-number small {
  margin-top: 7px;
  font-size: 11.5px;
  line-height: 1.35;
}

.dql-app-report-drivers {
  display: grid;
  gap: 12px;
}

.dql-app-report-driver {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding: 13px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-report-driver:last-child { border-bottom: 0; }

.dql-app-report-driver > span {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 850 12px var(--font-mono);
}

.dql-app-report-driver b {
  display: inline;
  color: var(--text-primary);
  font-size: 14px;
}

.dql-app-report-driver em {
  margin-left: 8px;
  color: var(--accent);
  font: 850 12px var(--font-mono);
  font-style: normal;
}

.dql-app-report-driver p,
.dql-app-report-muted {
  margin: 7px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.55;
}

.dql-app-report-driver-chart {
  display: grid;
  gap: 13px;
}

.dql-app-report-driver-bar {
  display: grid;
  gap: 7px;
}

.dql-app-report-driver-bar > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.dql-app-report-driver-bar b {
  min-width: 0;
  color: var(--text-primary);
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-report-driver-bar span {
  flex: none;
  color: var(--accent);
  font: 850 11px var(--font-mono);
}

.dql-app-report-driver-bar i {
  display: block;
  width: var(--driver-width);
  min-width: 28px;
  height: 9px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), rgba(79, 99, 215, 0.42));
}

.dql-app-report-driver-bar p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-appendix {
  padding: 0;
}

.dql-app-report-appendix summary {
  list-style: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 14px;
  align-items: center;
  cursor: pointer;
  padding: 18px 30px;
}

.dql-app-report-appendix summary::-webkit-details-marker {
  display: none;
}

.dql-app-report-appendix summary span {
  color: var(--text-primary);
  font: 850 14px var(--font-ui);
}

.dql-app-report-appendix summary small {
  grid-column: 1 / 2;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

.dql-app-report-appendix summary svg {
  grid-row: 1 / span 2;
  grid-column: 2;
  color: var(--text-secondary);
  transition: transform 140ms ease;
}

.dql-app-report-appendix[open] summary {
  border-bottom: 1px solid var(--border-subtle);
}

.dql-app-report-appendix[open] summary svg {
  transform: rotate(180deg);
}

.dql-app-report-appendix .dql-app-research-evidence-head {
  align-items: flex-start;
  margin: 18px 30px 10px;
}

.dql-app-report-appendix .dql-app-research-evidence-head h3 {
  margin-bottom: 4px;
}

.dql-app-report-appendix .dql-app-research-evidence-head p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-appendix .dql-app-research-table,
.dql-app-report-appendix .dql-app-research-sql-review,
.dql-app-report-appendix .dql-app-research-assumptions,
.dql-app-report-appendix .dql-app-research-code {
  margin-left: 30px;
  margin-right: 30px;
}

.dql-app-report-appendix > :last-child {
  margin-bottom: 24px;
}

.dql-app-research-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.dql-app-research-tabs button,
.dql-app-research-next button {
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-secondary);
  font: 800 11px var(--font-ui);
  padding: 5px 9px;
  cursor: pointer;
}

.dql-app-research-tabs button.on,
.dql-app-research-tabs button:hover,
.dql-app-research-next button:hover {
  color: var(--accent);
  border-color: rgba(37, 99, 235, 0.34);
  background: var(--accent-dim);
}

.dql-app-research-code {
  margin: 10px 0 0;
  max-height: 320px;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-2);
  padding: 11px;
  color: var(--text-primary);
  font: 11px/1.5 var(--font-mono);
  white-space: pre-wrap;
}

.dql-app-research-sql-review {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}

.dql-app-research-sql-review textarea {
  min-height: 260px;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-2);
  color: var(--text-primary);
  padding: 11px;
  font: 11px/1.5 var(--font-mono);
  outline: none;
}

.dql-app-research-sql-review textarea:focus {
  border-color: rgba(37, 99, 235, 0.42);
  box-shadow: 0 0 0 3px var(--accent-dim);
}

.dql-app-research-assumptions {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.dql-app-research-assumptions p {
  margin: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-2);
  padding: 9px;
  color: var(--text-secondary);
  font-size: 12px;
}

.dql-app-research-table {
  margin-top: 10px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
}

.dql-app-research-table table {
  width: 100%;
  border-collapse: collapse;
  min-width: 520px;
}

.dql-app-research-table th,
.dql-app-research-table td {
  padding: 8px 9px;
  border-bottom: 1px solid var(--border-subtle);
  text-align: left;
  font-size: 11.5px;
  white-space: nowrap;
}

.dql-app-research-table th {
  color: var(--text-secondary);
  background: var(--bg-3);
  font-weight: 850;
}

.dql-app-research-next {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.dql-app-simple-list,
.dql-app-settings-grid { display: grid; gap: 10px; }
.dql-app-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dql-app-panel-card {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-2);
  padding: 13px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.dql-app-panel-card > span {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  background: var(--accent-dim);
  flex: none;
}

.dql-app-panel-card b { display: block; }
.dql-app-panel-card span:last-child { color: var(--text-secondary); font-size: 12px; }
.dql-app-empty {
  min-height: 260px;
  border: 1px dashed var(--border-default);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-tertiary);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  padding: 28px;
}

.dql-app-empty.compact { min-height: 120px; padding: 18px; }
.dql-app-empty b { color: var(--text-primary); }
.dql-app-empty span { max-width: 440px; font-size: 12px; line-height: 1.45; }
.dql-app-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(15, 23, 42, 0.36);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.dql-app-modal {
  width: min(480px, 94vw);
  border-radius: 8px;
  background: var(--bg-2);
  box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28);
  padding: 18px;
  display: grid;
  gap: 12px;
}

.dql-app-modal h3 { margin: 0; }
.dql-app-modal p { margin: 0; color: var(--text-secondary); font-size: 12px; }
.dql-app-modal > div:last-child { display: flex; justify-content: flex-end; gap: 8px; }

/* Approved Apps redesign: compact library cards and an explicit build stage. */
.dql-apps-createhead h1 { font-size: 24px; font-weight: 700; letter-spacing: -.025em; }
.dql-apps-createhead p { max-width: 640px; margin-top: 6px; font-size: 12.5px; }
.dql-apps-ai-entry { max-width: 880px; padding: 14px; border-color: color-mix(in srgb, var(--accent) 32%, var(--border-default)); box-shadow: 0 1px 4px color-mix(in srgb, var(--text-primary) 5%, transparent); }
.dql-apps-ai-entry-box textarea { min-height: 72px; resize: none; background: var(--bg-2); font-size: 13.5px; }
.dql-apps-ai-entry-box button { height: 38px; border-radius: 9px; box-shadow: 0 1px 5px color-mix(in srgb, var(--accent) 30%, transparent); }
.dql-apps-grid { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.dql-app-card { border-radius: 10px; box-shadow: 0 1px 4px color-mix(in srgb, var(--text-primary) 5%, transparent); transition: transform .15s ease, box-shadow .15s ease; }
.dql-app-card:hover { transform: translateY(-1px); box-shadow: 0 4px 18px color-mix(in srgb, var(--text-primary) 7%, transparent); }
.dql-app-card h3 { margin-top: 10px; font-size: 14px; font-weight: 700; }
.dql-app-card p { min-height: 40px; font-size: 11.5px; }
.dql-app-card-signals { display: none; }
.dql-app-card-mini { display: flex; gap: 12px; color: var(--text-tertiary); }
.dql-app-card-mini span { display: inline-flex; align-items: center; gap: 4px; padding: 0; background: transparent; }
.dql-app-card-mini small { font-family: var(--font-ui); font-size: 10px; text-transform: none; }
.dql-app-card-mini b { margin: 0; font: 600 10.5px var(--font-mono); }
.dql-app-card-actions { display: flex; align-items: center; gap: 4px; }
.dql-app-card-depth .dql-app-card-actions button { display: inline-flex; align-items: center; gap: 4px; padding: 5px 7px; border-radius: 6px; color: var(--text-secondary); font-weight: 600; }
.dql-app-card-depth .dql-app-card-actions button:hover { background: var(--bg-2); color: var(--accent); }
.dql-app-view-edit { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-1); }
.dql-app-view-edit button { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 5px; color: var(--text-tertiary); font-size: 11.5px; }
.dql-app-view-edit button.on { background: var(--accent-dim); color: var(--accent); }

.dql-app-building-stage { position: relative; min-height: 100%; overflow: auto; padding: 18px 24px; background: var(--bg-1); }
.dql-app-building-stage > .dql-app-back { position: sticky; top: 0; z-index: 2; background: var(--bg-2); }
.dql-app-building-thread { width: min(720px, calc(100% - 32px)); margin: 48px auto; display: grid; gap: 28px; }
.dql-app-building-prompt { justify-self: end; max-width: 82%; padding: 10px 14px; border-radius: 16px 16px 4px 16px; background: var(--bg-3); color: var(--text-primary); font-size: 13.5px; line-height: 1.5; }
.dql-app-building-progress { display: flex; gap: 12px; align-items: flex-start; }
.dql-app-building-orb { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 34px; height: 34px; border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); border-radius: 50%; background: var(--accent-dim); color: var(--accent); animation: dql-app-orb 1.8s ease-in-out infinite; }
.dql-app-building-progress h2 { margin: 3px 0 4px; background: linear-gradient(100deg, var(--text-primary) 25%, var(--accent) 50%, var(--text-primary) 75%); background-size: 220% 100%; color: transparent; font-size: 14px; font-weight: 700; -webkit-background-clip: text; background-clip: text; animation: dql-app-shimmer 2.2s linear infinite; }
.dql-app-building-progress p { margin: 0; color: var(--text-tertiary); font-size: 11.5px; }
.dql-app-building-progress ol { display: grid; gap: 8px; margin: 16px 0 0; padding: 0; list-style: none; }
.dql-app-building-progress li { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 11.5px; animation: dql-app-stage-in .24s ease-out both; }
.dql-app-building-progress li:nth-child(2) { animation-delay: .18s; }
.dql-app-building-progress li:nth-child(3) { animation-delay: .36s; }
.dql-app-building-progress li svg { color: var(--status-success); }
.dql-app-proposal-thread { margin-top: 24px; gap: 18px; }
.dql-app-proposal-card { position: relative; display: grid; gap: 16px; padding: 18px; border: 1px solid var(--border-default); border-radius: 13px; background: var(--bg-2); box-shadow: 0 8px 28px color-mix(in srgb, var(--text-primary) 6%, transparent); }
.dql-app-proposal-title { display: flex; gap: 11px; align-items: flex-start; }
.dql-app-proposal-title h1 { margin: 2px 0 3px; color: var(--text-primary); font-size: 15px; }
.dql-app-proposal-title p { margin: 0; color: var(--text-tertiary); font-size: 11.5px; line-height: 1.45; }
.dql-app-proposal-more { border-top: 1px solid var(--border-subtle); padding-top: 12px; }
.dql-app-proposal-more summary { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); font-size: 11.5px; font-weight: 700; cursor: pointer; list-style: none; }
.dql-app-proposal-more summary::-webkit-details-marker { display: none; }
.dql-app-proposal-more > div { display: grid; gap: 5px; margin-top: 8px; }
.dql-app-proposal-more > div > button { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; border: 1px solid var(--border-subtle); border-radius: 7px; background: var(--bg-1); color: var(--text-primary); padding: 7px 9px; text-align: left; }
.dql-app-proposal-more > div > button.selected { border-color: var(--accent); background: var(--accent-dim); }
.dql-app-proposal-more > div > button span { display: grid; place-items: center; width: 16px; height: 16px; border: 1px solid var(--border-default); border-radius: 4px; color: var(--accent); }
.dql-app-proposal-more > div > button b { font-size: 11.5px; }
.dql-app-proposal-more > div > button small, .dql-app-proposal-empty { color: var(--text-muted); font-size: 10px; }
.dql-app-proposal-filters { display: grid; gap: 7px; border-top: 1px solid var(--border-subtle); padding-top: 12px; }
.dql-app-proposal-filters > b { color: var(--text-tertiary); font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; }
.dql-app-proposal-filters > div { display: flex; flex-wrap: wrap; gap: 6px; }
.dql-app-proposal-filters span { display: inline-flex; gap: 6px; border: 1px solid var(--border-default); border-radius: 999px; background: var(--bg-1); color: var(--text-secondary); padding: 4px 9px; font-size: 10.5px; }
.dql-app-proposal-filters small { color: var(--text-muted); }
.dql-app-proposal-reset { justify-self: start; }
@keyframes dql-app-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@keyframes dql-app-orb { 50% { box-shadow: 0 0 13px 1px color-mix(in srgb, var(--accent) 40%, transparent); } }
@keyframes dql-app-stage-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

@media (max-width: 1120px) {
  .dql-apps-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dql-app-create-workspace,
  .dql-app-create-workspace.classic {
    grid-template-columns: 1fr;
    align-content: start;
    overflow: auto;
  }
  .dql-app-create-workspace .dql-app-panel {
    min-height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .dql-app-ai-start,
  .dql-app-ai-generated-grid {
    grid-template-columns: 1fr;
  }
  .dql-app-filterbar {
    flex-wrap: nowrap;
    gap: 6px;
    padding: 7px 22px;
    overflow-x: auto;
  }
  .dql-app-filter-note {
    width: 30px;
    height: 30px;
    justify-content: center;
    gap: 0;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    background: var(--bg-3);
    font-size: 0;
    flex: 0 0 auto;
  }
  .dql-app-filter-note svg {
    width: 14px;
    height: 14px;
  }
  .dql-app-filter-select,
  .dql-app-toggle {
    flex: 0 0 auto;
  }
  .dql-app-toggle {
    gap: 6px;
    font-weight: 750;
  }
  .dql-app-review-backlog-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .dql-app-view-layout { grid-template-columns: 1fr; }
  .dql-app-view-topbar {
    align-content: flex-start;
    align-items: flex-start;
    min-height: 132px;
    row-gap: 8px;
  }
  .dql-app-topbar-divider {
    display: none;
  }
  .dql-app-topbar-filters {
    flex: 1 1 100%;
    order: 2;
  }
  .dql-app-view-actions {
    flex: 1 1 100%;
    justify-content: flex-start;
    margin-left: 0;
    order: 3;
  }
  .dql-app-research-shell {
    grid-template-columns: 1fr;
  }
  .dql-app-research-detail {
    order: 1;
  }
  .dql-app-research-list {
    order: 2;
  }
  .dql-app-explain-panel {
    position: static;
    width: 100%;
    max-width: none;
    height: min(680px, calc(100vh - 24px));
    resize: none;
    max-height: none;
  }
}

@media (max-width: 760px) {
  .dql-apps-wrap,
  .dql-app-view-wrap {
    width: min(100% - 16px, calc(100vw - 104px));
    max-width: calc(100vw - 104px);
    margin: 0 auto;
    padding-bottom: 48px;
  }
  .dql-apps-libbar,
  .dql-app-buildbar,
  .dql-app-view-topbar,
  .dql-app-filterbar {
    align-items: stretch;
    flex-direction: column;
    overflow-x: visible;
  }
  .dql-app-filter-note {
    width: auto;
    height: auto;
    margin-left: 0;
    justify-content: flex-start;
    gap: 6px;
    font-size: 11px;
  }
  .dql-apps-grid,
  .dql-app-form-grid.two,
  .dql-app-settings-grid,
  .dql-app-ai-filter-preview { grid-template-columns: 1fr; }
  .dql-apps-ai-entry-box {
    grid-template-columns: 1fr;
  }
  .dql-apps-ai-entry-box button {
    width: 100%;
  }
  .dql-apps-ai-entry-foot {
    align-items: stretch;
    flex-direction: column;
  }
  .dql-apps-ai-entry-secondary {
    justify-content: center;
  }
  .dql-app-create-workspace.clean {
    padding: 16px;
  }
  .dql-app-ai-start-card {
    padding: 15px;
  }
  .dql-app-ai-start-card textarea {
    min-height: 150px;
    font-size: 15px;
    padding-bottom: 48px;
  }
  .dql-app-ai-start-send {
    right: 14px;
    bottom: 14px;
  }
  .dql-app-ai-generated-head {
    align-items: stretch;
    flex-direction: column;
  }
  .dql-app-mode-seg { margin: 0; width: 100%; }
  .dql-app-mode-seg button { flex: 1; }
  .dql-app-build-actions,
  .dql-app-view-actions { margin-left: 0; width: 100%; flex-wrap: wrap; }
  .dql-app-nav-row {
    width: 100%;
    justify-content: flex-start;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .dql-app-section-tabs {
    flex: 0 0 auto;
    max-width: none;
  }
  .dql-app-section-tabs button {
    min-width: auto;
    white-space: nowrap;
  }
  .dql-app-section-tabs .dql-app-tab-label {
    display: inline;
  }
  .dql-app-explain-panel {
    order: -1;
    min-width: 0;
    height: min(620px, calc(100vh - 160px));
    min-height: 420px;
    margin-bottom: 12px;
  }
  .dql-app-assistant-top {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .dql-app-assistant-heading {
    flex: 1 1 calc(100% - 46px);
  }
  .dql-app-assistant-focus {
    flex: 1 1 100%;
  }
  .dql-app-assistant-focus select {
    width: 100%;
    max-width: none;
  }
  .dql-app-assistant-context-btn {
    position: static;
    justify-self: end;
  }
  .dql-app-direct-ask-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .dql-app-direct-ask-row button {
    width: 100%;
  }
  .dql-app-page-picker {
    flex: 0 0 min(100%, 360px);
  }
  .dql-app-page-picker select { min-width: 0; max-width: 100%; }
  .dql-app-report-hero {
    padding: 18px 16px 16px;
  }
  .dql-app-report-status-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .dql-app-report-hero h2 {
    font-size: 26px;
    line-height: 1.08;
    overflow-wrap: anywhere;
  }
  .dql-app-report-section {
    padding: 18px 16px;
  }
  .dql-app-report-paper {
    padding: 18px 18px 14px;
  }
  .dql-app-report-evidence-story {
    margin: 4px 16px 10px;
  }
  .dql-app-report-appendix {
    padding: 0;
  }
  .dql-app-report-appendix summary {
    padding: 16px;
  }
  .dql-app-report-appendix .dql-app-research-evidence-head,
  .dql-app-report-appendix .dql-app-research-table,
  .dql-app-report-appendix .dql-app-research-sql-review,
  .dql-app-report-appendix .dql-app-research-assumptions,
  .dql-app-report-appendix .dql-app-research-code {
    margin-left: 16px;
    margin-right: 16px;
  }
  .dql-app-direct-quick,
  .dql-app-report-evidence-story,
  .dql-app-report-numbers {
    grid-template-columns: 1fr;
  }
  .dql-app-report-evidence-story .dql-app-report-numbers {
    grid-template-columns: 1fr;
  }
  .dql-app-report-context-line span {
    white-space: normal;
  }
  .dql-app-preview-tile,
  .dql-app-preview-tile.wide { grid-column: 1 / -1; }
  .dql-app-drilldown-grid {
    grid-template-columns: 1fr;
  }
}
`;
