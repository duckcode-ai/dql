import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  BookOpenText,
  Bot,
  Check,
  ChevronDown,
  Download,
  FileText,
  LayoutDashboard,
  LineChart,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Share2,
  Workflow,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import {
  api,
  type AppBlockRecommendation,
  type AppDocumentSummary,
  type DashboardDocumentResponse,
  type DashboardRunResponse,
  type GenerateAppResponse,
  type GeneratedAppPlan,
} from '../../api/client';
import type { AppSummary, AppWorkspaceExperience, AppWorkspaceSection } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { AgentChatPanel } from '../agent/AgentChatPanel';
import { DashboardRenderer } from './DashboardRenderer';
import { PersonaSwitcher } from './PersonaSwitcher';

type AppSurface = 'library' | 'create' | 'workspace';
type AppExperience = AppWorkspaceExperience;
type BuilderMode = 'ai' | 'classic';
type AppSection = AppWorkspaceSection;
type LibraryFilter = 'all' | 'mine' | 'shared' | 'fav' | 'review';

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

const DEFAULT_PROMPT = 'Revenue overview for the cards team: monthly trend, top products, and how new vs returning customers contribute.';

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
    description: 'Mark missing sections for review instead of hiding them.',
  },
  {
    id: 'review',
    title: 'Route review',
    description: 'Keep generated parts visibly reviewable.',
  },
];

const FILTER_LABELS: Record<LibraryFilter, string> = {
  all: 'All',
  mine: 'Mine',
  shared: 'Shared',
  fav: 'Favourites',
  review: 'Review',
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
  const [builderName, setBuilderName] = useState('Jaffle Analytics');
  const [builderDomain, setBuilderDomain] = useState('Revenue');
  const [builderOwner, setBuilderOwner] = useState('analytics@jaffle.shop');
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedBlocks, setSelectedBlocks] = useState<Set<string>>(() => new Set());
  const [generated, setGenerated] = useState<GenerateAppResponse | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [builderSaving, setBuilderSaving] = useState(false);
  const [addPageOpen, setAddPageOpen] = useState(false);
  const [addPageTitle, setAddPageTitle] = useState('');
  const [addPageError, setAddPageError] = useState<string | null>(null);
  const [period, setPeriod] = useState('last_12_months');
  const [segment, setSegment] = useState('all_customers');
  const [region, setRegion] = useState('all');
  const [smartView, setSmartView] = useState(false);
  const [explainOpen, setExplainOpen] = useState(true);

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
      if (libraryFilter === 'review' && app.lifecycle !== 'review') return false;
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

  const openApp = (app: AppSummary, nextExperience: AppExperience = 'view') => {
    dispatch({ type: 'OPEN_APP', appId: app.id, experience: nextExperience, section: 'dashboards' });
    setSurface('workspace');
  };

  const startAiBuilder = (prompt = builderPrompt, domain?: string) => {
    setBuilderMode('ai');
    setBuilderPrompt(prompt);
    if (domain) setBuilderDomain(domain);
    setSelectedBlocks(new Set());
    setBuilderError(null);
    setGenerated(null);
    setSurface('create');
  };

  const startClassicBuilder = () => {
    setBuilderMode('classic');
    setBuilderError(null);
    setGenerated(null);
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

  const runGenerate = async () => {
    const prompt = builderPrompt.trim();
    if (!prompt) {
      setBuilderError('Describe the app you want to build.');
      return;
    }
    setBuilderSaving(true);
    setBuilderError(null);
    const result = await api.generateApp({
      prompt,
      domain: builderDomain.trim() || undefined,
      owner: builderOwner.trim() || undefined,
      force: false,
      selectedBlockIds: Array.from(selectedBlocks),
    });
    setBuilderSaving(false);
    if (!result.ok) {
      setBuilderError(result.error);
      return;
    }
    setGenerated(result);
    setBuilderName(result.plan.name);
    await refreshApps(result.app?.id ?? result.plan.appId, result.dashboardId, 'create');
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
    period,
    segment,
    region,
    smartView,
  }), [period, region, segment, smartView]);

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
          saving={builderSaving}
          error={builderError}
          onBack={() => setSurface('library')}
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
          period={period}
          segment={segment}
          region={region}
          smartView={smartView}
          themeMode={state.themeMode}
          variables={dashboardVariables}
          onBack={() => setSurface('library')}
          onExperienceChange={setExperience}
          onSectionChange={setSection}
          onPeriodChange={setPeriod}
          onSegmentChange={setSegment}
          onRegionChange={setRegion}
          onSmartViewChange={setSmartView}
          onExplainChange={setExplainOpen}
          onAddPage={() => setAddPageOpen(true)}
          onOpenDashboard={(dashboardId) => dispatch({ type: 'OPEN_DASHBOARD', dashboardId })}
          onDashboardChanged={(dashboard) => {
            setDashboardDoc((current) => current ? { ...current, dashboard } : current);
            void refreshApps(state.activeAppId, dashboard.id, 'workspace');
          }}
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
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const counts = libraryCounts(allApps, favorites);
  return (
    <main className="dql-apps-wrap">
      <section className="dql-apps-createhead">
        <h1>Build an app</h1>
        <p>
          Turn certified blocks, business views, notebooks, and lineage into a stakeholder-grade App. Ask AI to shape
          the story dynamically or compose the canvas by hand.
        </p>
      </section>

      <form
        className="dql-apps-startbar"
        onSubmit={(event) => {
          event.preventDefault();
          onStartAi(prompt);
        }}
      >
        <Sparkles size={19} strokeWidth={1.8} aria-hidden="true" />
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the app you want: weekly revenue health for the COO with risk flags"
        />
        <button type="submit" className="dql-apps-btn dql-apps-btn-primary">Build with AI</button>
      </form>

      <div className="dql-apps-startgrid">
        <StartOption
          icon={<Sparkles size={19} strokeWidth={1.9} />}
          title="Build with AI"
          description="Describe the use case. The agent finds certified context, shapes the story, and writes reviewable files."
          meta="local agent"
          action="Open AI builder"
          onClick={() => onStartAi(prompt)}
        />
        <StartOption
          icon={<Blocks size={19} strokeWidth={1.9} />}
          title="Classic builder"
          description="Pick certified blocks and compose a 12-column dashboard canvas with the same governed app files."
          meta="certified blocks"
          action="Open canvas"
          onClick={onStartClassic}
        />
        <StartOption
          icon={<Workflow size={19} strokeWidth={1.9} />}
          title="Agent skills"
          description="The builder matches blocks, orders the narrative, drafts missing sections, and routes review."
          meta="dynamic plan"
          action="Ask AI"
          onClick={() => onStartAi(prompt)}
        />
      </div>

      <div className="dql-apps-sectionhead">
        <span>App library</span>
        <i />
        <b>{allApps.length} total</b>
      </div>

      <div className="dql-apps-libbar">
        <div className="dql-apps-filter-tabs">
          {(['all', 'mine', 'shared', 'fav', 'review'] as LibraryFilter[]).map((value) => (
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
            />
          ))}
        </div>
      )}
    </main>
  );
}

function StartOption({
  icon,
  title,
  description,
  meta,
  action,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  meta: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="dql-apps-start-option" onClick={onClick}>
      <span className="dql-apps-option-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      <span className="dql-apps-option-meta"><span>{meta}</span><b>{action} <ArrowRight size={13} /></b></span>
    </button>
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
  onOpen: () => void;
}) {
  const certified = app.certification === 'certified' || app.lifecycle === 'certified';
  const draftCount = app.drafts?.length ?? 0;
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
        <p>{app.description || `${app.name} consumption surface for ${app.domain}.`}</p>
        <div className="dql-app-card-mini">
          <MiniMetric label="Pages" value={String(app.dashboards.length)} />
          <MiniMetric label="Books" value={String(app.notebooks?.length ?? 0)} />
          <MiniMetric label="Drafts" value={String(draftCount)} />
        </div>
        <div className="dql-app-spark" aria-hidden="true">
          {[28, 34, 32, 42, 38, 48, 54, 50, 59, 64].map((value, index) => (
            <i key={index} style={{ height: `${value}%` }} />
          ))}
        </div>
      </div>
      <div className="dql-app-card-depth">
        <span>{primaryOwner(app)}</span>
        <button type="button" onClick={onOpen}>Open</button>
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
  saving,
  error,
  onBack,
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
  saving: boolean;
  error: string | null;
  onBack: () => void;
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
  const plan = generated?.plan ?? planFromSelection(appName, prompt, domain, owner, selected);
  const validation = generated?.validation ?? {
    ok: selected.length > 0,
    certifiedTiles: selected.length,
    draftTiles: mode === 'ai' ? 2 : 0,
    issues: [],
  };
  return (
    <div className="dql-app-create-shell">
      <div className="dql-app-buildbar">
        <button type="button" className="dql-app-back" onClick={onBack}>
          <ArrowLeft size={14} /> Apps
        </button>
        <span className="dql-app-name-input">
          <input value={appName} onChange={(event) => onAppNameChange(event.target.value)} spellCheck={false} />
        </span>
        <StatusSeal tone={generated ? 'agentic' : 'draft'}>{generated ? 'generated' : 'draft'}</StatusSeal>
        <div className="dql-app-mode-seg">
          <button type="button" className={mode === 'ai' ? 'on' : ''} onClick={() => onModeChange('ai')}>
            <Sparkles size={15} /> Ask AI
          </button>
          <button type="button" className={mode === 'classic' ? 'on' : ''} onClick={() => onModeChange('classic')}>
            <Blocks size={15} /> Classic
          </button>
        </div>
        <div className="dql-app-build-actions">
          <span className="dql-app-persona"><b>CFO</b> CFO</span>
          {generated ? <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onOpenGenerated}>Preview</button> : null}
          <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onBuild} disabled={saving}>
            {saving ? 'Building...' : mode === 'ai' ? 'Send to AI' : 'Create app'}
          </button>
        </div>
      </div>

      <div className={`dql-app-create-workspace ${mode === 'classic' ? 'classic' : 'ai'}`}>
        <section className={`dql-app-panel dql-app-agent-panel ${mode === 'ai' ? 'ai-clean' : ''}`}>
          <PanelHead title={mode === 'ai' ? 'Build with the agent' : 'Palette'} meta={mode === 'ai' ? 'local ledger-grounded' : 'certified blocks'} />
          {mode === 'ai' ? (
            <>
              <div className="dql-app-ai-brief">
                <span><Sparkles size={15} /> AI App Builder</span>
                <p>Describe the app outcome. DQL finds certified context and drafts review gaps.</p>
                {generated ? (
                  <div className="dql-app-ai-result">
                    Generated <b>{generated.plan.name}</b> with {generated.validation.certifiedTiles} certified tile
                    {generated.validation.certifiedTiles === 1 ? '' : 's'} and {generated.validation.draftTiles} draft tile
                    {generated.validation.draftTiles === 1 ? '' : 's'}.
                  </div>
                ) : null}
              </div>
              <div className="dql-app-composer ai-clean">
                <textarea
                  value={prompt}
                  onChange={(event) => onPromptChange(event.target.value)}
                  rows={4}
                  aria-label="App request"
                  placeholder="Ask DQL to build a stakeholder app from certified blocks and business context..."
                />
                <div className="dql-app-suggestions" aria-label="Prompt examples">
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
                <details className="dql-app-ai-context">
                  <summary>
                    <span>Context</span>
                    <b>{contextDomainLabel} / {contextOwnerLabel}</b>
                    <ChevronDown size={14} />
                  </summary>
                  <div className="dql-app-ai-context-grid">
                    <label>Domain<input value={domain} onChange={(event) => onDomainChange(event.target.value)} /></label>
                    <label>Owner<input value={owner} onChange={(event) => onOwnerChange(event.target.value)} /></label>
                  </div>
                </details>
                <div className="dql-app-ai-send-row">
                  <span><ShieldCheck size={13} /> Certified context first</span>
                  <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onBuild} disabled={saving}>
                    <Send size={13} /> {saving ? 'Building...' : 'Send to AI'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <BlockIndex
              title="Certified blocks"
              subtitle={`${selectedBlocks.size} selected`}
              catalog={catalog}
              loading={catalogLoading}
              selectedBlocks={selectedBlocks}
              onToggleBlock={onToggleBlock}
            />
          )}
        </section>

        <section className="dql-app-panel dql-app-preview-panel">
          <PanelHead title={mode === 'ai' ? 'Live preview' : 'Canvas'} meta={generated ? 'generated' : selected.length ? `${selected.length} selected` : 'empty'} />
          <div className="dql-app-preview-scroll">
            <div className="dql-app-preview-card">
              <div className="dql-app-preview-head">
                <h2>{generated?.plan.name ?? appName}</h2>
                <StatusSeal tone={generated ? 'agentic' : 'draft'}>{generated ? 'ready to refine' : 'ready when you are'}</StatusSeal>
              </div>
              <div className="dql-app-preview-filters">
                <span>Last 12 months <ChevronDown size={12} /></span>
                <span>All customers <ChevronDown size={12} /></span>
                <span>All regions <ChevronDown size={12} /></span>
              </div>
              <div className="dql-app-preview-grid">
                {plan.pages[0]?.tiles.length ? (
                  plan.pages[0].tiles.map((tile, index) => <PreviewTile key={tile.id} tile={tile} index={index} />)
                ) : (
                  <div className="dql-app-preview-empty">
                    <LayoutDashboard size={38} strokeWidth={1.4} />
                    <div>{mode === 'ai' ? 'Describe the app outcome, then send it to AI.' : 'Select blocks to compose the app.'}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="dql-app-panel dql-app-plan-panel">
          <PanelHead title="Build plan" meta={generated ? generated.plan.appId : 'draft'} />
          <div className="dql-app-plan-list">
            {plan.pages[0]?.tiles.map((tile) => <PlanItem key={tile.id} tile={tile} />)}
            {plan.pages[0]?.tiles.length === 0 ? <EmptyPanel title="No plan yet." detail="Run the builder to create a plan." compact /> : null}
          </div>
          <div className="dql-app-plan-foot">
            <Leader label="tiles traced to ledger" value={`${validation.certifiedTiles} / ${(plan.pages[0]?.tiles.length ?? 0)}`} />
            <Leader label="certified" value={String(validation.certifiedTiles)} tone="certified" />
            <Leader label="drafted / routed" value={String(validation.draftTiles)} tone="draft" />
            {error ? <div className="dql-app-error">{error}</div> : null}
            {generated ? (
              <button type="button" className="dql-apps-btn dql-apps-btn-dark" onClick={onOpenGenerated}>
                Open and refine app
              </button>
            ) : (
              <button type="button" className="dql-apps-btn dql-apps-btn-dark" onClick={onBuild} disabled={saving}>
                {saving ? 'Building...' : mode === 'ai' ? 'Generate plan' : 'Create from selected blocks'}
              </button>
            )}
          </div>
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
  period,
  segment,
  region,
  smartView,
  themeMode,
  variables,
  onBack,
  onExperienceChange,
  onSectionChange,
  onPeriodChange,
  onSegmentChange,
  onRegionChange,
  onSmartViewChange,
  onExplainChange,
  onAddPage,
  onOpenDashboard,
  onDashboardChanged,
  onOpenLineageNode,
}: {
  app: AppSummary | null;
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  loading: boolean;
  experience: AppExperience;
  section: AppSection;
  explainOpen: boolean;
  period: string;
  segment: string;
  region: string;
  smartView: boolean;
  themeMode: ThemeMode;
  variables: Record<string, unknown>;
  onBack: () => void;
  onExperienceChange: (experience: AppExperience) => void;
  onSectionChange: (section: AppSection) => void;
  onPeriodChange: (value: string) => void;
  onSegmentChange: (value: string) => void;
  onRegionChange: (value: string) => void;
  onSmartViewChange: (value: boolean) => void;
  onExplainChange: (value: boolean) => void;
  onAddPage: () => void;
  onOpenDashboard: (dashboardId: string) => void;
  onDashboardChanged: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  onOpenLineageNode: (nodeId: string) => void;
}) {
  const certifiedCount = dashboardDoc?.dashboard.layout.items.filter((item) => Boolean(item.block)).length ?? 0;
  const draftCount = appDoc?.drafts?.length ?? 0;
  const dashboardBlockIds = useMemo(() => {
    return dashboardDoc?.dashboard.layout.items
      .map((item) => getDashboardItemBlockId(item))
      .filter((value): value is string => Boolean(value)) ?? [];
  }, [dashboardDoc]);
  const dashboardBlockKey = dashboardBlockIds.join('|');
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(dashboardBlockIds[0] ?? null);
  const [dashboardRun, setDashboardRun] = useState<DashboardRunResponse | null>(null);
  const [askSeed, setAskSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'downloaded' | 'ready'>('idle');
  const [shareText, setShareText] = useState('');
  const handleDashboardRunChange = useCallback((run: DashboardRunResponse | null) => {
    setDashboardRun(run);
  }, []);
  const handleAskBlock = useCallback((blockId: string, question: string) => {
    setSelectedBlockId(blockId);
    onExplainChange(true);
    setAskSeed({ text: question, nonce: Date.now() });
  }, [onExplainChange]);

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
  }, [app?.id, dashboardDoc?.dashboard.id]);
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
  return (
    <div className="dql-app-workspace">
      <div className="dql-app-view-topbar">
        <button type="button" className="dql-app-back" onClick={onBack}><ArrowLeft size={14} /> Apps</button>
        <span className="dql-app-crumb">/ <b>{app?.id ?? 'app'}</b></span>
        <StatusSeal tone="certified">{certifiedCount} certified</StatusSeal>
        {draftCount > 0 ? <StatusSeal tone="draft">{draftCount} draft</StatusSeal> : null}
        <button
          type="button"
          className={`dql-app-customize-btn ${experience === 'build' ? 'on' : ''}`}
          onClick={() => onExperienceChange(experience === 'build' ? 'view' : 'build')}
          title={experience === 'build' ? 'Finish customizing and return to the clean view' : 'Rearrange tiles and edit this app'}
        >
          {experience === 'build' ? <><Check size={14} /> Done</> : <><Pencil size={14} /> Customize</>}
        </button>
        <div className="dql-app-view-actions">
          <PersonaSwitcher app={appDoc?.app ?? null} />
          <button type="button" className="dql-apps-btn dql-apps-btn-line" title="Copy local app handoff" onClick={() => void copyShareLink()}>
            <Share2 size={14} /> {shareStatus === 'copied' ? 'Copied' : shareStatus === 'ready' ? 'Copy text' : 'Share'}
          </button>
          <button type="button" className="dql-apps-btn dql-apps-btn-line" title="Download app brief" onClick={downloadBrief}>
            <Download size={14} /> {shareStatus === 'downloaded' ? 'Saved' : 'Brief'}
          </button>
          {shareStatus === 'ready' ? (
            <div className="dql-app-share-popover">
              <b>Local handoff</b>
              <textarea readOnly value={shareText} onFocus={(event) => event.currentTarget.select()} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="dql-app-filterbar">
        <FilterSelect label="Period" value={period} onChange={onPeriodChange} options={[
          ['last_30_days', 'Last 30 days'],
          ['last_quarter', 'Last quarter'],
          ['last_12_months', 'Last 12 months'],
          ['year_to_date', 'Year to date'],
        ]} />
        <FilterSelect label="Segment" value={segment} onChange={onSegmentChange} options={[
          ['all_customers', 'All customers'],
          ['new', 'New'],
          ['returning', 'Returning'],
          ['enterprise', 'Enterprise'],
        ]} />
        <FilterSelect label="Region" value={region} onChange={onRegionChange} options={[
          ['all', 'All'],
          ['north', 'North'],
          ['south', 'South'],
          ['east', 'East'],
          ['west', 'West'],
        ]} />
        <span className="dql-app-filter-note" title="Certified dashboard parameters rerun local blocks">
          <ShieldCheck size={14} /> Certified params
        </span>
        <Toggle label="Smart view" checked={smartView} onChange={onSmartViewChange} />
      </div>

      <main className="dql-app-view-wrap">
        <div className="dql-app-title-row">
          <div className="dql-app-title-copy">
            <div className="dql-app-title-meta">
              <span><LayoutDashboard size={14} /> {app?.domain ?? dashboardDoc?.dashboard.metadata.domain ?? 'DQL App'}</span>
              {experience === 'build' ? <StatusSeal tone="draft">Customizing</StatusSeal> : null}
            </div>
            <h1>{app?.name ?? 'App'}</h1>
            <p>{app?.description ?? dashboardDoc?.dashboard.metadata.description ?? 'Local DQL App'}</p>
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
          </div>
        </div>

        <div className={`dql-app-view-layout ${explainOpen && section === 'dashboards' ? '' : 'no-explain'}`}>
          <div className="dql-app-main-column">
            {loading ? (
              <EmptyPanel title="Loading app..." detail="Reading dashboard files and running local blocks." />
            ) : section === 'dashboards' && dashboardDoc && app ? (
              <DashboardRenderer
                appId={app.id}
                dashboard={dashboardDoc.dashboard}
                editable={experience === 'build'}
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
          {explainOpen && section === 'dashboards' ? (
            <AppCopilotPanel
              app={app}
              appDoc={appDoc}
              dashboardDoc={dashboardDoc}
              dashboardRun={dashboardRun}
              selectedBlockId={selectedBlockId}
              askSeed={askSeed}
              themeMode={themeMode}
              onSelectBlock={setSelectedBlockId}
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
      {blocks.slice(0, 24).map((block) => {
        const selected = selectedBlocks.has(block.id);
        return (
          <button key={block.id} type="button" className={selected ? 'selected' : ''} onClick={() => onToggleBlock(block.id)}>
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
  const tabs: Array<{ id: AppSection; label: string; count?: number; icon: ReactNode }> = [
    { id: 'dashboards', label: 'Dashboards', count: appDoc?.dashboards.length ?? 0, icon: <LayoutDashboard size={14} /> },
    { id: 'notebooks', label: 'Notebooks', count: appDoc?.notebooks?.length ?? appDoc?.app.notebooks?.length ?? 0, icon: <BookOpenText size={14} /> },
    { id: 'ai', label: 'AI', count: appDoc?.aiPins?.length ?? 0, icon: <Bot size={14} /> },
    ...(experience === 'build' ? [
      { id: 'drafts' as const, label: 'Drafts', count: appDoc?.drafts?.length ?? 0, icon: <FileText size={14} /> },
      { id: 'settings' as const, label: 'Settings', icon: <Workflow size={14} /> },
    ] : []),
  ];
  return (
    <nav className="dql-app-section-tabs" aria-label="App sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={section === tab.id ? 'on' : ''}
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
  selectedBlockId,
  askSeed,
  themeMode,
  onSelectBlock,
}: {
  app: AppSummary | null;
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  dashboardRun: DashboardRunResponse | null;
  selectedBlockId: string | null;
  askSeed?: { text: string; nonce: number } | null;
  themeMode: ThemeMode;
  onSelectBlock: (blockId: string | null) => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const blockTiles = useMemo(() => {
    return dashboardDoc?.dashboard.layout.items
      .map((item) => {
        const blockId = getDashboardItemBlockId(item);
        if (!blockId) return null;
        return {
          blockId,
          title: item.title ?? blockId,
          viz: item.viz.type,
          tileId: item.i,
        };
      })
      .filter((item): item is { blockId: string; title: string; viz: string; tileId: string } => Boolean(item)) ?? [];
  }, [dashboardDoc]);
  const selectedBlock = blockTiles.find((item) => item.blockId === selectedBlockId) ?? blockTiles[0] ?? null;
  const selectedTileRun = selectedBlock
    ? dashboardRun?.tiles.find((tile) => tile.tileId === selectedBlock.tileId || tile.blockId === selectedBlock.blockId)
    : null;
  const selectedBlockContext = selectedBlock
    ? {
        ...selectedBlock,
        status: selectedTileRun?.status,
        certificationStatus: selectedTileRun?.certificationStatus,
        rowCount: selectedTileRun?.result?.rowCount,
        columns: selectedTileRun?.result?.columns?.slice(0, 8),
        sampleRows: sampleDashboardRows(selectedTileRun?.result?.rows, selectedTileRun?.result?.columns),
      }
    : null;

  const dashboardMeta = dashboardDoc?.dashboard.metadata;
  const domainLabel = formatBusinessLabel(app?.domain ?? dashboardMeta?.domain ?? 'Business');
  const focusTitle = formatBusinessLabel(selectedBlock?.title ?? dashboardMeta?.title ?? app?.name ?? 'Dashboard');
  const businessOutcome = dashboardMeta?.businessOutcome
    ?? app?.description
    ?? dashboardMeta?.description
    ?? 'Understand what is changing, why it matters, and what action should happen next.';
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
    ? 'Business answer first; data and lineage stay in evidence.'
    : 'Ask across the dashboard. The copilot will answer in business language first, then expose evidence when you need the trace.';
  const businessFacts = [
    { label: 'Audience', value: audience },
    { label: 'Owner', value: owner },
    { label: 'Cadence', value: cadence },
  ];
  const draftCount = appDoc?.drafts?.length ?? 0;
  const focusMetric = typeof selectedRows === 'number'
    ? `${selectedRows.toLocaleString()} rows${selectedColumns ? ` / ${selectedColumns} fields` : ''}`
    : focusStatus;

  const contextJson = JSON.stringify({
    scope: selectedBlockContext ? 'selected-dashboard-block' : 'dashboard',
    responseStyle: {
      audience: 'CXO and business stakeholder',
      firstResponse: 'Start with a plain-language business answer and recommended action.',
      evidenceRule: 'Keep block ids, SQL, lineage, and implementation details in evidence sections unless the user asks for them.',
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
    selectedBlock: selectedBlockContext,
    availableBlocks: blockTiles.map((block) => ({
      blockId: block.blockId,
      title: block.title,
      viz: block.viz,
      status: dashboardRun?.tiles.find((tile) => tile.tileId === block.tileId || tile.blockId === block.blockId)?.status,
      rowCount: dashboardRun?.tiles.find((tile) => tile.tileId === block.tileId || tile.blockId === block.blockId)?.result?.rowCount,
    })),
  }, null, 2);
  const promptStarters = [
    {
      label: 'Explain impact',
      icon: <MessageSquareText size={14} />,
      prompt: selectedBlock
        ? `Explain ${selectedBlock.title} for an executive audience. Start with what it means for the business, why it matters, and what action to consider. Keep technical evidence secondary.`
        : 'Explain this dashboard for an executive audience. Start with the business story, decision impact, and what action to consider. Keep technical evidence secondary.',
    },
    {
      label: 'Drill into drivers',
      icon: <LineChart size={14} />,
      prompt: selectedBlock
        ? `Drill into the main drivers behind ${selectedBlock.title}. Use the current result sample and return the clearest business breakdown before any technical details.`
        : 'Drill into the main drivers behind this dashboard. Use current result samples and return the clearest business breakdown before any technical details.',
    },
    {
      label: 'Improve story',
      icon: <Sparkles size={14} />,
      prompt: selectedBlock
        ? `Suggest how to make ${selectedBlock.title} easier for leadership to read, decide from, and trust.`
        : 'Suggest how to make this dashboard easier for leadership to read, decide from, and trust.',
    },
    {
      label: 'Find trust gaps',
      icon: <ShieldCheck size={14} />,
      prompt: selectedBlock
        ? `What business context, data quality, certification, or review gaps should we fix before leaders rely on ${selectedBlock.title}?`
        : 'What business context, data quality, certification, or review gaps should we fix before leaders rely on this app?',
    },
  ];
  return (
    <aside className="dql-app-explain-panel dql-app-assistant-panel">
      <div className="dql-app-assistant-top">
        <div className="dql-app-assistant-icon"><Bot size={15} /></div>
        <div className="dql-app-assistant-heading">
          <span className="dql-app-assistant-kicker">AI assistant</span>
          <h3 title={focusTitle}>{focusTitle}</h3>
        </div>
        <div className="dql-app-assistant-focus">
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
        </div>
        <button
          type="button"
          className={`dql-app-assistant-context-btn ${evidenceOpen ? 'on' : ''}`}
          onClick={() => setEvidenceOpen((value) => !value)}
          title="Show business context"
        >
          Context
          <ChevronDown size={13} />
        </button>
      </div>

      {evidenceOpen ? (
        <div className="dql-app-assistant-context">
          <p>{decisionUse}</p>
          <p>{businessOutcome}</p>
          <div>
            {businessFacts.map((item) => <KeyValueInline key={item.label} label={item.label} value={item.value} />)}
            <KeyValueInline label="Result" value={focusMetric} />
            <KeyValueInline label="Evidence" value={focusDetail} />
            <KeyValueInline label="Drafts" value={String(draftCount)} />
          </div>
        </div>
      ) : null}

      <div className="dql-app-assistant-chat">
        <AgentChatPanel
          title={selectedBlock ? selectedBlock.title : 'Ask the app copilot'}
          scopeHint="Business answer first"
          upstreamContext={contextJson}
          themeMode={themeMode}
          hideSqlByDefault
          suggestions={promptStarters}
          autoAsk={askSeed ?? undefined}
          emptyHint="Ask what changed, why it matters, what action to take, or what evidence needs review."
          inputPlaceholder="Ask a business question..."
          variant="executive"
          embedded
          showHeader={false}
          addToAppTarget={app && dashboardDoc ? { appId: app.id, dashboardId: dashboardDoc.dashboard.id } : undefined}
          conversationTarget={app && dashboardDoc ? { appId: app.id, dashboardId: dashboardDoc.dashboard.id } : undefined}
        />
      </div>
    </aside>
  );
}

function NotebookListPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  const notebooks = appDoc?.notebooks ?? appDoc?.app.notebooks ?? [];
  if (!notebooks.length) return <EmptyPanel title="No notebooks attached." detail="Attach analysis notebooks in Build mode when this App needs supporting research." />;
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
  if (!pins.length) return <EmptyPanel title="No AI pins yet." detail="Ask AI from a dashboard page and pin useful answers into this App." />;
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

function PreviewTile({ tile, index }: { tile: GeneratedAppPlan['pages'][number]['tiles'][number]; index: number }) {
  const wide = tile.viz === 'line' || tile.viz === 'bar';
  return (
    <div className={`dql-app-preview-tile ${tile.certification === 'uncertified' ? 'draft' : ''} ${wide ? 'wide' : ''}`}>
      <div className="dql-app-preview-tile-head">
        <b>{tile.title}</b>
        <span>{tile.viz}</span>
      </div>
      <div className="dql-app-preview-tile-body">
        {tile.viz === 'single_value' || tile.viz === 'kpi' ? (
          <>
            <strong>{index % 2 === 0 ? '$48.2K' : '61.9K'}</strong>
            <small>{tile.description ?? 'Certified KPI tile'}</small>
          </>
        ) : (
          <div className="dql-app-mini-bars">
            {[72, 42, 64, 36, 86].map((value, barIndex) => <i key={barIndex} style={{ width: `${value}%` }} />)}
          </div>
        )}
      </div>
      <div className="dql-app-preview-tile-foot">
        <span>{tile.kind.replace(/_/g, ' ')}</span>
        <b>{tile.certification === 'certified' ? 'certified' : 'draft'}</b>
      </div>
    </div>
  );
}

function PlanItem({ tile }: { tile: GeneratedAppPlan['pages'][number]['tiles'][number] }) {
  return (
    <div className="dql-app-plan-item">
      <i className={tile.certification === 'uncertified' ? 'draft' : ''} />
      <span><b>{tile.title}</b><small>{tile.rationale ?? tile.description ?? tile.kind.replace(/_/g, ' ')}</small></span>
      <em>{tile.viz}</em>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="dql-app-filter-select">
      <span>{label}</span>
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

function sampleDashboardRows(rows?: Array<Record<string, unknown>>, columns?: string[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const selectedColumns = Array.isArray(columns) && columns.length > 0 ? columns.slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  return rows.slice(0, 5).map((row) => Object.fromEntries(selectedColumns.map((column) => [column, row[column]])));
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
    `- AI pins: ${aiPins.length}`,
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

function Leader({ label, value, tone }: { label: string; value: string; tone?: 'certified' | 'draft' }) {
  return (
    <div className={`dql-app-leader ${tone ?? ''}`}>
      <span>{label}</span><i /><b>{value}</b>
    </div>
  );
}

function KeyValueInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="dql-app-keyvalue-inline">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
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
    review: apps.filter((app) => app.lifecycle === 'review').length,
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
  --dql-app-canvas: var(--color-bg-primary, #f7f8fb);
  --dql-app-surface: var(--color-bg-card, #ffffff);
  --dql-app-surface-muted: var(--color-bg-secondary, #f8fafc);
  --dql-app-control: var(--color-bg-sunken, #f4f6f9);
  --dql-app-line: var(--color-border-subtle, rgba(15, 23, 42, 0.10));
  --dql-app-line-2: var(--color-border-primary, rgba(15, 23, 42, 0.16));
  --dql-app-ink: var(--color-text-primary, #0f172a);
  --dql-app-muted: var(--color-text-secondary, #64748b);
  --dql-app-faint: var(--color-text-tertiary, #94a3b8);
  --dql-app-accent: var(--color-accent-blue, #2563eb);
  --dql-app-accent-soft: rgba(37, 99, 235, 0.10);
  --dql-app-deep: #111827;
  --dql-app-green: var(--color-status-success, #16a34a);
  --dql-app-green-soft: rgba(22, 163, 74, 0.08);
  --dql-app-orange: var(--color-status-warning, #ca8a04);
  --dql-app-orange-soft: rgba(202, 138, 4, 0.10);
  --dql-app-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 10px 28px rgba(15, 23, 42, 0.06);
  --surface: var(--dql-app-surface);
  --surface-hover: var(--dql-app-control);
  --border-color: var(--dql-app-line);
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--dql-app-canvas);
  color: var(--dql-app-ink);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.45;
  text-rendering: geometricPrecision;
}

.dql-apps-waterline * {
  letter-spacing: 0;
}

.dql-apps-theme-paper {
  --dql-app-canvas: #f7f4ed;
  --dql-app-surface: #fffefa;
  --dql-app-surface-muted: #f3f0ea;
  --dql-app-control: #f8f6f1;
  --dql-app-line: rgba(57, 48, 36, 0.12);
  --dql-app-line-2: rgba(57, 48, 36, 0.18);
  --dql-app-ink: #171717;
  --dql-app-muted: #5f636b;
  --dql-app-faint: #8b909a;
  --dql-app-accent: #4f63d7;
  --dql-app-accent-soft: rgba(79, 99, 215, 0.11);
}

.dql-apps-theme-white {
  --dql-app-canvas: #f7f8fb;
  --dql-app-surface: #ffffff;
  --dql-app-surface-muted: #f2f5f8;
  --dql-app-control: #f7f9fc;
  --dql-app-line: rgba(15, 23, 42, 0.10);
  --dql-app-line-2: rgba(15, 23, 42, 0.16);
  --dql-app-ink: #0f172a;
  --dql-app-muted: #5d6878;
  --dql-app-faint: #8a94a5;
  --dql-app-accent: #2563eb;
  --dql-app-accent-soft: rgba(37, 99, 235, 0.10);
}

.dql-apps-theme-obsidian {
  --dql-app-canvas: #0f141c;
  --dql-app-surface: #151b24;
  --dql-app-surface-muted: #111720;
  --dql-app-control: #1b2430;
  --dql-app-line: rgba(226, 232, 240, 0.10);
  --dql-app-line-2: rgba(226, 232, 240, 0.16);
  --dql-app-ink: #eef3fb;
  --dql-app-muted: #aab4c3;
  --dql-app-faint: #7f8b9b;
  --dql-app-accent: #84a5ff;
  --dql-app-accent-soft: rgba(132, 165, 255, 0.16);
  --dql-app-deep: #05070b;
  --dql-app-shadow: none;
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
  color: var(--dql-app-muted);
  font-size: 14px;
  line-height: 1.55;
  max-width: 720px;
}

.dql-apps-startbar {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 58px;
  background: var(--dql-app-surface);
  border: 1px solid var(--dql-app-line-2);
  border-radius: 10px;
  padding: 8px 9px 8px 16px;
  box-shadow: var(--dql-app-shadow);
}

.dql-apps-startbar svg { color: var(--dql-app-accent); flex: none; }
.dql-apps-startbar input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--dql-app-ink);
  font: 500 15px var(--font-ui);
  outline: none;
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
.dql-apps-btn-primary { background: var(--dql-app-accent); color: #fff; }
.dql-apps-btn-line { background: var(--dql-app-surface); border-color: var(--dql-app-line-2); color: var(--dql-app-ink); }
.dql-apps-btn-dark { width: 100%; background: var(--dql-app-deep); border-color: #1f2937; color: #fff; margin-top: 12px; }

.dql-apps-startgrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 14px;
}

.dql-apps-start-option {
  min-height: 214px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  box-shadow: var(--dql-app-shadow);
  padding: 18px;
  cursor: pointer;
  color: var(--dql-app-ink);
}

.dql-apps-start-option:hover { border-color: var(--dql-app-accent); transform: translateY(-1px); }
.dql-apps-start-option strong { font-size: 16px; }
.dql-apps-start-option p { margin: 0; color: var(--dql-app-muted); font-size: 12.5px; line-height: 1.55; }
.dql-apps-option-icon {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dql-app-accent);
  background: var(--dql-app-accent-soft);
}

.dql-apps-option-meta {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--dql-app-faint);
}

.dql-apps-option-meta span {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
  font-size: 9px;
}

.dql-apps-option-meta b {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dql-app-accent);
  font-size: 12px;
}

.dql-apps-sectionhead {
  margin: 30px 0 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--dql-app-muted);
}

.dql-apps-sectionhead span,
.dql-app-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-apps-sectionhead i { flex: 1; border-top: 1px solid var(--dql-app-line); }
.dql-apps-sectionhead b { font-family: var(--font-mono); font-size: 10px; color: var(--dql-app-faint); }

.dql-apps-libbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.dql-apps-filter-tabs {
  display: flex;
  gap: 3px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-control);
  padding: 4px;
  flex-wrap: wrap;
}

.dql-apps-filter-tabs button {
  border: 0;
  background: transparent;
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--dql-app-muted);
  font: 800 12px var(--font-ui);
}

.dql-apps-filter-tabs button.on { background: var(--dql-app-surface); color: var(--dql-app-ink); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08); }
.dql-apps-filter-tabs span { margin-left: 5px; color: var(--dql-app-accent); font-family: var(--font-mono); font-size: 10px; }

.dql-apps-search {
  flex: 1;
  min-width: 220px;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--dql-app-surface);
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  padding: 0 12px;
  color: var(--dql-app-faint);
}

.dql-apps-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dql-app-ink);
  font: 13px var(--font-ui);
}

.dql-apps-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.dql-app-card {
  min-width: 0;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  overflow: hidden;
  box-shadow: var(--dql-app-shadow);
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
  border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  color: var(--dql-app-faint);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.dql-app-star.on { color: var(--dql-app-accent); background: var(--dql-app-accent-soft); border-color: rgba(37, 99, 235, 0.35); }
.dql-app-card h3 { margin: 13px 0 0; font-size: 17px; line-height: 1.2; }
.dql-app-card p { min-height: 54px; margin: 7px 0 0; color: var(--dql-app-muted); font-size: 12px; line-height: 1.5; }

.dql-app-card-mini {
  margin-top: 13px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.dql-app-card-mini span {
  border-radius: 6px;
  background: var(--dql-app-control);
  padding: 7px 9px;
}

.dql-app-card-mini small {
  display: block;
  font-family: var(--font-mono);
  font-size: 7.5px;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--dql-app-muted);
}

.dql-app-card-mini b { display: block; margin-top: 1px; font-size: 15px; }

.dql-app-spark {
  height: 34px;
  margin-top: 12px;
  display: flex;
  align-items: end;
  gap: 4px;
}

.dql-app-spark i {
  flex: 1;
  min-width: 3px;
  border-radius: 999px 999px 0 0;
  background: linear-gradient(180deg, var(--dql-app-accent), rgba(37, 99, 235, 0.22));
}

.dql-app-card-depth {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--dql-app-muted);
}

.dql-app-card-depth span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-card-depth button { border: 0; background: transparent; color: var(--dql-app-accent); cursor: pointer; font: 800 11px var(--font-ui); }

.dql-app-block-cite i,
.dql-app-plan-item > i {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dql-app-green);
  flex: none;
}

.dql-app-block-cite i.draft,
.dql-app-plan-item > i.draft { background: var(--dql-app-orange); }

.dql-app-seal {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 999px;
  min-height: 22px;
  padding: 2px 9px;
  width: fit-content;
  border: 1px solid rgba(22, 163, 74, 0.26);
  background: var(--dql-app-green-soft);
  color: var(--dql-app-green);
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

.dql-app-seal.draft { border-color: rgba(202, 138, 4, 0.30); background: var(--dql-app-orange-soft); color: var(--dql-app-orange); }
.dql-app-seal.agentic { border-color: rgba(37, 99, 235, 0.32); background: var(--dql-app-accent-soft); color: var(--dql-app-accent); }

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
  gap: 12px;
  padding: 9px 18px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
}

.dql-app-back {
  border: 0;
  background: transparent;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dql-app-muted);
  cursor: pointer;
  font: 800 12px var(--font-ui);
}

.dql-app-name-input input {
  width: 240px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 8px;
  outline: 0;
  background: transparent;
  color: var(--dql-app-ink);
  font: 800 16px var(--font-ui);
}

.dql-app-name-input input:focus { border-color: var(--dql-app-accent); background: var(--dql-app-control); }
.dql-app-mode-seg {
  margin: 0 auto;
  display: flex;
  gap: 2px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-control);
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
  color: var(--dql-app-muted);
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-mode-seg button.on { background: var(--dql-app-deep); color: #fff; }

.dql-app-customize-btn {
  margin: 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 14px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-customize-btn:hover {
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
}

.dql-app-customize-btn.on {
  border-color: var(--dql-app-deep);
  background: var(--dql-app-deep);
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
  border: 1px solid var(--dql-app-line-2);
  border-radius: 8px;
  background: var(--dql-app-surface);
  box-shadow: var(--dql-app-shadow);
  padding: 10px;
  display: grid;
  gap: 7px;
}

.dql-app-share-popover b {
  color: var(--dql-app-ink);
  font: 850 12px var(--font-ui);
}

.dql-app-share-popover textarea {
  width: 100%;
  min-height: 92px;
  resize: none;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  padding: 8px;
  font: 11px/1.45 var(--font-mono);
  box-sizing: border-box;
}

.dql-app-persona {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  padding: 3px 9px 3px 4px;
  color: var(--dql-app-muted);
  font-size: 12px;
}

.dql-app-persona b {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dql-app-accent);
  color: #fff;
  font-size: 9px;
}

.dql-app-create-workspace {
  min-height: 0;
  display: grid;
  grid-template-columns: 380px minmax(420px, 1fr) 300px;
}

.dql-app-create-workspace.classic { grid-template-columns: 286px minmax(420px, 1fr) 320px; }
.dql-app-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
}

.dql-app-panel:last-child { border-right: 0; }
.dql-app-panel-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 15px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
}

.dql-app-panel-head span { font-weight: 850; font-size: 14px; }
.dql-app-panel-head b { margin-left: auto; color: var(--dql-app-faint); font: 500 10px var(--font-mono); text-transform: uppercase; letter-spacing: 0; }

.dql-app-agent-scroll,
.dql-app-plan-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.dql-app-agent-panel.ai-clean { background: var(--dql-app-surface); }
.dql-app-ai-brief {
  padding: 18px 16px 2px;
  display: grid;
  gap: 8px;
}

.dql-app-ai-brief > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dql-app-ink);
  font: 850 13px var(--font-ui);
}

.dql-app-ai-brief > span svg { color: var(--dql-app-accent); }
.dql-app-ai-brief p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.dql-app-ai-result {
  margin-top: 5px;
  border: 1px solid rgba(22, 163, 74, 0.26);
  border-radius: 7px;
  background: var(--dql-app-green-soft);
  color: var(--dql-app-ink);
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-composer {
  border-top: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
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
  color: var(--dql-app-faint);
  font: 750 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-suggestions button,
.dql-app-suggests button {
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--dql-app-muted);
  padding: 2px 0;
  cursor: pointer;
  font: 750 11.5px var(--font-ui);
}

.dql-app-suggestions button:hover,
.dql-app-suggests button:hover {
  color: var(--dql-app-accent);
}

.dql-app-composer textarea,
.dql-app-form-grid input,
.dql-app-select-label select,
.dql-app-modal input {
  width: 100%;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  outline: 0;
  padding: 8px 10px;
  font: 12.5px var(--font-ui);
}

.dql-app-composer textarea { resize: vertical; min-height: 92px; line-height: 1.45; }
.dql-app-composer.ai-clean textarea {
  min-height: 130px;
  background: var(--dql-app-surface);
  border-color: var(--dql-app-line-2);
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
  color: var(--dql-app-muted);
  font: 700 10px var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
}

.dql-app-ai-context {
  border-top: 1px solid var(--dql-app-line);
  border-bottom: 1px solid var(--dql-app-line);
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
  color: var(--dql-app-muted);
  font: 800 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-ai-context summary b {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dql-app-ink);
  font: 750 11px var(--font-ui);
}

.dql-app-ai-context summary svg {
  flex: 0 0 auto;
  color: var(--dql-app-faint);
  transition: transform 140ms ease;
}

.dql-app-ai-context[open] summary svg { transform: rotate(180deg); }

.dql-app-ai-context-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  padding: 0 0 10px;
  border-top: 1px solid var(--dql-app-line);
}

.dql-app-ai-context-grid label {
  display: grid;
  gap: 5px;
  color: var(--dql-app-muted);
  font: 700 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-ai-context-grid input,
.dql-app-ai-context-grid select {
  width: 100%;
  height: 34px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface-muted);
  color: var(--dql-app-ink);
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
  color: var(--dql-app-muted);
  font: 750 11px var(--font-ui);
}

.dql-app-ai-send-row span svg {
  color: var(--dql-app-green);
}

.dql-app-preview-panel { background: var(--dql-app-canvas); }
.dql-app-preview-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 20px 40px; }
.dql-app-preview-card {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  overflow: hidden;
}

.dql-app-preview-head {
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-preview-head h2 { margin: 0; font-size: 19px; }
.dql-app-preview-filters {
  display: flex;
  gap: 7px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
}

.dql-app-preview-filters span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dql-app-line);
  border-radius: 6px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 4px 9px;
  font-size: 11px;
}

.dql-app-preview-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 18px;
  min-height: 380px;
}

.dql-app-preview-empty {
  grid-column: 1 / -1;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--dql-app-faint);
  text-align: center;
}

.dql-app-preview-tile {
  grid-column: span 4;
  min-height: 136px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
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
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-preview-tile-head b { font-size: 12px; }
.dql-app-preview-tile-head span,
.dql-app-preview-tile-foot {
  color: var(--dql-app-faint);
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
.dql-app-preview-tile-body small { color: var(--dql-app-muted); }
.dql-app-preview-tile-foot { border-bottom: 0; border-top: 1px solid var(--dql-app-line); }
.dql-app-preview-tile-foot b { margin-left: auto; color: var(--dql-app-green); }
.dql-app-preview-tile.draft .dql-app-preview-tile-foot b { color: var(--dql-app-orange); }

.dql-app-mini-bars i {
  display: block;
  height: 8px;
  border-radius: 999px;
  background: var(--dql-app-accent);
  margin: 6px 0;
}

.dql-app-preview-tile.draft .dql-app-mini-bars i { background: var(--dql-app-orange); }
.dql-app-plan-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-plan-item span { flex: 1; min-width: 0; }
.dql-app-plan-item b { display: block; font: 700 11.5px var(--font-mono); }
.dql-app-plan-item small { display: block; color: var(--dql-app-faint); font-size: 10px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-plan-item em { color: var(--dql-app-faint); font: 700 9px var(--font-mono); text-transform: uppercase; font-style: normal; }

.dql-app-plan-foot {
  margin-top: auto;
  padding: 14px;
  border-top: 2px solid var(--dql-app-accent);
  background: var(--dql-app-accent-soft);
}

.dql-app-leader {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11.5px;
  color: var(--dql-app-muted);
  margin: 5px 0;
}

.dql-app-leader i { flex: 1; border-bottom: 1.5px dotted var(--dql-app-line-2); transform: translateY(-3px); }
.dql-app-leader b { font-family: var(--font-mono); color: var(--dql-app-ink); }
.dql-app-leader.certified b { color: var(--dql-app-green); }
.dql-app-leader.draft b { color: var(--dql-app-orange); }

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
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface-muted);
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
  color: var(--dql-app-ink);
  font: 850 12px var(--font-ui);
}

.dql-app-palette-title b {
  margin-left: auto;
  color: var(--dql-app-faint);
  font: 700 9.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-palette-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
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
  color: var(--dql-app-ink);
  font: 12px var(--font-ui);
}

.dql-app-palette button {
  width: 100%;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface);
  color: var(--dql-app-ink);
  padding: 9px 10px;
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  cursor: pointer;
}

.dql-app-palette button.selected { border-color: var(--dql-app-accent); background: var(--dql-app-accent-soft); }
.dql-app-palette-icon {
  width: 25px;
  height: 25px;
  border-radius: 6px;
  background: #f1f5f9;
  color: var(--dql-app-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.dql-app-palette span:nth-child(2) { flex: 1; min-width: 0; }
.dql-app-palette b { display: block; font: 700 11px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-palette small { display: block; color: var(--dql-app-faint); font-size: 10px; }
.dql-app-palette i { color: var(--dql-app-green); font: 700 9px var(--font-mono); text-transform: uppercase; font-style: normal; }
.dql-app-palette-more {
  color: var(--dql-app-faint);
  text-align: center;
  font: 700 10px var(--font-mono);
  padding: 8px 0 2px;
}

.dql-app-view-topbar { position: sticky; top: 0; z-index: 4; }
.dql-app-view-topbar {
  min-height: 48px;
  padding: 7px 22px;
  box-shadow: 0 1px 0 var(--dql-app-line);
}

.dql-app-crumb { color: var(--dql-app-muted); font: 700 11.5px var(--font-mono); }
.dql-app-filterbar {
  position: relative;
  z-index: 3;
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 26px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  flex-wrap: wrap;
}

.dql-app-filter-select {
  height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-control);
  padding: 0 10px;
}

.dql-app-filter-select span {
  color: var(--dql-app-faint);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-filter-select select {
  border: 0;
  background: transparent;
  color: var(--dql-app-ink);
  outline: 0;
  font: 750 12.5px var(--font-ui);
}

.dql-app-filter-note {
  margin-left: auto;
  color: var(--dql-app-faint);
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
  color: var(--dql-app-muted);
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

.dql-app-toggle.on i { background: var(--dql-app-accent); }
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
  color: var(--dql-app-muted);
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
  color: var(--dql-app-muted);
  font-size: 13px;
  line-height: 1.45;
  max-width: 720px;
}

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
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
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
  color: var(--dql-app-muted);
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
  color: var(--dql-app-ink);
  background: var(--dql-app-accent-soft);
}

.dql-app-section-tabs button.on {
  box-shadow: inset 0 0 0 1px var(--dql-app-accent);
}

.dql-app-section-tabs b {
  color: var(--dql-app-accent);
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
  color: var(--dql-app-faint);
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
  color: var(--dql-app-ink);
  font: 800 12px var(--font-ui);
  text-overflow: ellipsis;
}

.dql-app-page-picker button {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
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
  width: clamp(340px, 27vw, 450px);
  min-width: 320px;
  max-width: min(540px, 42vw);
  min-height: 520px;
  height: min(680px, calc(100vh - 176px));
  max-height: calc(100vh - 176px);
  resize: both;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  overflow: auto;
  box-shadow: var(--dql-app-shadow);
}

.dql-app-copilot-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dql-app-assistant-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dql-app-surface);
}

.dql-app-assistant-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-assistant-icon {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--dql-app-accent-soft);
  border: 1px solid rgba(79, 99, 215, 0.28);
  color: var(--dql-app-accent);
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
  color: var(--dql-app-muted);
  font: 800 9px var(--font-mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.dql-app-assistant-heading h3 {
  margin: 0;
  color: var(--dql-app-ink);
  font-size: 14px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-assistant-focus {
  flex: none;
  min-width: 0;
}

.dql-app-assistant-focus select {
  max-width: 150px;
  height: 30px;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-ink);
  padding: 0 8px;
  font: 700 11.5px var(--font-ui);
  cursor: pointer;
}

.dql-app-assistant-context-btn {
  flex: none;
  height: 30px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-control);
  color: var(--dql-app-muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  cursor: pointer;
  font: 800 11px var(--font-ui);
}

.dql-app-assistant-context-btn.on,
.dql-app-assistant-context-btn:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-assistant-context-btn.on svg { transform: rotate(180deg); }

.dql-app-assistant-context {
  display: grid;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
}

.dql-app-assistant-context p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-assistant-context > div {
  display: grid;
  gap: 6px;
}

.dql-app-assistant-chat {
  flex: 1;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  padding: 0 16px 14px;
}

.dql-app-assistant-chat > div {
  flex: 1;
  min-height: 0;
}

.dql-app-copilot-hero {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--dql-app-line);
  background: linear-gradient(180deg, var(--dql-app-surface), var(--dql-app-surface-muted));
}

.dql-app-copilot-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dql-app-muted);
  font: 750 10px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-kicker svg { color: var(--dql-app-accent); }
.dql-app-copilot-hero h3 {
  margin: 6px 0 0;
  color: var(--dql-app-ink);
  font-size: 19px;
  line-height: 1.15;
}

.dql-app-copilot-hero p {
  margin: 6px 0 0;
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.42;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dql-app-copilot-decision {
  margin-top: 8px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface);
  padding: 7px 9px;
}

.dql-app-copilot-decision small,
.dql-app-copilot-facts small {
  display: block;
  color: var(--dql-app-muted);
  font: 750 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-decision b {
  display: block;
  margin-top: 3px;
  color: var(--dql-app-ink);
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
  background: var(--dql-app-control);
  padding: 6px 8px;
}

.dql-app-copilot-facts b {
  display: block;
  margin-top: 2px;
  color: var(--dql-app-ink);
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

.dql-app-explain-head { padding: 14px 16px 12px; border-bottom: 1px solid var(--dql-app-line); }
.dql-app-explain-head span,
.dql-app-ex-label {
  color: var(--dql-app-muted);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-explain-head h3 { margin: 3px 0 0; font-size: 17px; }
.dql-app-explain-head p { margin: 5px 0 0; color: var(--dql-app-muted); font-size: 11.5px; line-height: 1.45; }
.dql-app-ex-section { padding: 13px 16px; border-bottom: 1px solid var(--dql-app-line); }
.dql-app-ex-section.compact { padding-top: 11px; padding-bottom: 11px; }
.dql-app-copilot-controls {
  padding: 8px 12px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-focus {
  display: grid;
  gap: 5px;
}

.dql-app-copilot-focus span {
  color: var(--dql-app-muted);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-focus select {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  padding: 0 10px;
  font: 800 12px var(--font-ui);
}

.dql-app-copilot-empty {
  margin-top: 7px;
  color: var(--dql-app-faint);
  font-size: 11px;
}

.dql-app-copilot-brief {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-brief > div {
  min-width: 0;
  flex: 1;
}

.dql-app-copilot-brief span {
  display: inline-flex;
  color: var(--dql-app-green);
  font: 750 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-brief b {
  display: block;
  margin-top: 4px;
  color: var(--dql-app-ink);
  font-size: 13px;
  line-height: 1.25;
}

.dql-app-copilot-brief p {
  margin: 4px 0 0;
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.35;
}

.dql-app-copilot-result-pill {
  flex: none;
  border-radius: 999px;
  border: 1px solid rgba(22, 163, 74, 0.24);
  background: var(--dql-app-green-soft);
  color: var(--dql-app-green) !important;
  padding: 4px 8px;
  white-space: nowrap;
}

.dql-app-copilot-prompts {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-prompts button {
  min-width: 0;
  height: 31px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-copilot-prompts button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-copilot-prompts svg {
  flex: 0 0 auto;
}

.dql-app-copilot-evidence {
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-evidence summary {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  cursor: pointer;
  color: var(--dql-app-muted);
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
  color: var(--dql-app-faint);
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
  color: var(--dql-app-faint);
  font-family: var(--font-mono);
}

.dql-app-keyvalue-inline b {
  min-width: 0;
  color: var(--dql-app-muted);
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
.dql-app-block-cite b { color: var(--dql-app-faint); font: 10px var(--font-mono); }
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
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 700 8px var(--font-mono);
}

.dql-app-flow-node b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-flow-node small { color: var(--dql-app-faint); font: 9px var(--font-mono); }
.dql-app-flow i {
  display: block;
  width: 2px;
  height: 9px;
  background: var(--dql-app-accent);
  margin-left: 13px;
}

.dql-app-suggests { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.dql-app-focus-list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.dql-app-focus-list > span {
  color: var(--dql-app-faint);
  font-size: 12px;
}

.dql-app-focus-list button {
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  cursor: pointer;
  text-align: left;
}

.dql-app-focus-list button.on {
  color: var(--dql-app-ink);
  border-color: rgba(79, 99, 215, 0.42);
  background: var(--dql-app-accent-soft);
}

.dql-app-focus-list button svg {
  flex: 0 0 auto;
  color: var(--dql-app-accent);
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
  color: var(--dql-app-faint);
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
  border: 1px solid var(--dql-app-line);
  border-radius: 6px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
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
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 8px 6px;
  display: grid;
  justify-items: center;
  gap: 5px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-drilldown-grid button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-rail-chat {
  height: 100%;
  min-height: 0;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 8px;
  overflow: hidden;
  background: var(--dql-app-surface);
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
  background: var(--dql-app-orange-soft);
  padding: 11px 12px;
}

.dql-app-gapcard p { margin: 6px 0 0; color: var(--dql-app-muted); font-size: 11.5px; line-height: 1.45; }
.dql-app-simple-list,
.dql-app-settings-grid { display: grid; gap: 10px; }
.dql-app-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dql-app-panel-card {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
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
  color: var(--dql-app-accent);
  background: var(--dql-app-accent-soft);
  flex: none;
}

.dql-app-panel-card b { display: block; }
.dql-app-panel-card span:last-child { color: var(--dql-app-muted); font-size: 12px; }
.dql-app-empty {
  min-height: 260px;
  border: 1px dashed var(--dql-app-line-2);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-faint);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  padding: 28px;
}

.dql-app-empty.compact { min-height: 120px; padding: 18px; }
.dql-app-empty b { color: var(--dql-app-ink); }
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
  background: var(--dql-app-surface);
  box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28);
  padding: 18px;
  display: grid;
  gap: 12px;
}

.dql-app-modal h3 { margin: 0; }
.dql-app-modal p { margin: 0; color: var(--dql-app-muted); font-size: 12px; }
.dql-app-modal > div:last-child { display: flex; justify-content: flex-end; gap: 8px; }

@media (max-width: 1120px) {
  .dql-apps-grid,
  .dql-apps-startgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dql-app-create-workspace,
  .dql-app-create-workspace.classic {
    grid-template-columns: 1fr;
    align-content: start;
    overflow: auto;
  }
  .dql-app-create-workspace .dql-app-panel {
    min-height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--dql-app-line);
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
    border: 1px solid var(--dql-app-line);
    border-radius: 8px;
    background: var(--dql-app-control);
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
}

@media (max-width: 900px) {
  .dql-app-view-layout { grid-template-columns: 1fr; }
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
  .dql-app-view-wrap { width: min(100% - 20px, 560px); }
  .dql-apps-startbar,
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
  .dql-apps-startgrid,
  .dql-apps-grid,
  .dql-app-form-grid.two,
  .dql-app-settings-grid { grid-template-columns: 1fr; }
  .dql-app-mode-seg { margin: 0; width: 100%; }
  .dql-app-mode-seg button { flex: 1; }
  .dql-app-build-actions,
  .dql-app-view-actions { margin-left: 0; width: 100%; flex-wrap: wrap; }
  .dql-app-nav-row { width: 100%; justify-content: flex-start; }
  .dql-app-page-picker select { min-width: 0; max-width: 100%; }
  .dql-app-preview-tile,
  .dql-app-preview-tile.wide { grid-column: 1 / -1; }
  .dql-app-drilldown-grid {
    grid-template-columns: 1fr;
  }
}
`;
