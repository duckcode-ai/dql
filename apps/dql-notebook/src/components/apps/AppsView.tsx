import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import {
  api,
  type AppConversation,
  type AppBlockRecommendation,
  type AppDocumentSummary,
  type AppNotebookCandidate,
  type AppNotebookPreview,
  type DashboardDocumentResponse,
} from '../../api/client';
import type { AppSummary, NotebookFile, QueryResult, ThemeMode } from '../../store/types';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { aggregate, type Aggregation } from '../../utils/aggregate';
import { themes, type Theme } from '../../themes/notebook-theme';
import { PersonaSwitcher } from './PersonaSwitcher';
import { DashboardRenderer } from './DashboardRenderer';
import { TableOutput } from '../output/TableOutput';
import { ChartOutput, CHART_TYPE_OPTIONS, resolveChartType, type ChartType } from '../output/ChartOutput';
import { renderMarkdown } from '../cells/MarkdownCellEditor';

type AppLibraryFilter = 'all' | 'mine' | 'shared' | 'template' | 'review';
type AppSection = 'dashboards' | 'notebooks' | 'ai' | 'drafts' | 'settings';
type AppExperience = 'view' | 'build';
type AppStartSource = 'empty' | 'notebook' | 'template' | 'import';
type NotebookAttachMode = 'existing' | 'new';
type ReadOnlyVizChoice = Exclude<ChartType, 'table'> | 'pivot';

const READONLY_TYPE_LABELS: Record<string, string> = {
  sql: 'SQL',
  dql: 'DQL',
  markdown: 'Markdown',
  chart: 'Chart',
  table: 'Table',
  pivot: 'Pivot',
  single_value: 'Single value',
  filter: 'Filter',
  param: 'Parameter',
  python: 'Python',
  chat: 'Chat',
  writeback: 'Writeback',
};

const READONLY_TYPE_COLORS: Record<string, string> = {
  sql: '#5b9cf6',
  dql: '#4f46e5',
  markdown: '#6f7785',
  chart: '#b067f7',
  table: '#79c0ff',
  pivot: '#a371f7',
  single_value: '#a371f7',
  filter: '#39d353',
  param: '#f0b429',
  python: '#3572A5',
  chat: '#f78166',
  writeback: '#e36209',
};

export function AppsView(): JSX.Element {
  const { state, dispatch } = useNotebook();
  const [appDoc, setAppDoc] = useState<AppDocumentSummary | null>(null);
  const [dashboardDoc, setDashboardDoc] = useState<DashboardDocumentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [subdomainFilter, setSubdomainFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [audienceFilter, setAudienceFilter] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState('');
  const [certificationFilter, setCertificationFilter] = useState('');
  const [storageFilter, setStorageFilter] = useState<AppLibraryFilter>('all');
  const [appSection, setAppSection] = useState<AppSection>('dashboards');
  const [appExperience, setAppExperience] = useState<AppExperience>('view');
  const [addTabOpen, setAddTabOpen] = useState(false);
  const [addTabTitle, setAddTabTitle] = useState('');
  const [addTabError, setAddTabError] = useState<string | null>(null);
  const [addTabSaving, setAddTabSaving] = useState(false);
  const [attachNotebookOpen, setAttachNotebookOpen] = useState(false);
  const [attachMode, setAttachMode] = useState<NotebookAttachMode>('existing');
  const [attachNotebookPath, setAttachNotebookPath] = useState('');
  const [attachNotebookTitle, setAttachNotebookTitle] = useState('');
  const [attachNotebookRole, setAttachNotebookRole] = useState<'source' | 'analysis' | 'supporting'>('supporting');
  const [attachNotebookVisibility, setAttachNotebookVisibility] = useState<'shared' | 'private' | 'template'>('shared');
  const [notebookCandidates, setNotebookCandidates] = useState<AppNotebookCandidate[]>([]);
  const [notebookCandidateSearch, setNotebookCandidateSearch] = useState('');
  const [newNotebookName, setNewNotebookName] = useState('');
  const [attachNotebookError, setAttachNotebookError] = useState<string | null>(null);
  const [attachNotebookSaving, setAttachNotebookSaving] = useState(false);

  const refreshApps = async (openAppId?: string, dashboardId?: string | null) => {
    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    const apps = await api.listApps();
    dispatch({ type: 'SET_APPS', apps });
    dispatch({ type: 'SET_APPS_LOADING', loading: false });
    if (openAppId) {
      dispatch({ type: 'OPEN_APP', appId: openAppId, dashboardId: dashboardId ?? undefined });
    } else if (apps.length > 0 && !state.activeAppId) {
      dispatch({ type: 'OPEN_APP', appId: apps[0].id });
    }
  };

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    void api.listApps().then((apps) => {
      if (cancelled) return;
      dispatch({ type: 'SET_APPS', apps });
      dispatch({ type: 'SET_APPS_LOADING', loading: false });
      if (apps.length > 0 && !state.activeAppId) dispatch({ type: 'OPEN_APP', appId: apps[0].id });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state.activeAppId) {
      setAppDoc(null);
      setDashboardDoc(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api.getApp(state.activeAppId).then((doc) => {
      if (!cancelled) setAppDoc(doc);
    });
    if (state.activeDashboardId) {
      void api.getDashboard(state.activeAppId, state.activeDashboardId).then((d) => {
        if (!cancelled) {
          setDashboardDoc(d);
          setLoading(false);
        }
      });
    } else {
      setDashboardDoc(null);
      setLoading(false);
    }
    return () => { cancelled = true; };
  }, [state.activeAppId, state.activeDashboardId]);

  useEffect(() => {
    void api.getPersona().then((persona) => dispatch({ type: 'SET_ACTIVE_PERSONA', persona }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const facets = useMemo(() => ({
    domains: unique(state.apps.map((app) => app.domain).filter(Boolean)),
    subdomains: unique(state.apps.map((app) => app.subdomain).filter(Boolean) as string[]),
    groups: unique(state.apps.flatMap((app) => app.groups ?? [])),
    tags: unique(state.apps.flatMap((app) => app.tags ?? []).filter((tag) => !tag.startsWith('audience:'))),
    owners: unique(state.apps.flatMap((app) => app.owners ?? [])),
    audiences: unique(state.apps.map((app) => app.audience).filter(Boolean) as string[]),
  }), [state.apps]);

  const filteredApps = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return state.apps.filter((app) => {
      if (needle) {
        const haystack = [
          app.name,
          app.description ?? '',
          app.domain,
          app.subdomain ?? '',
          ...(app.groups ?? []),
          ...(app.tags ?? []),
          ...(app.owners ?? []),
          ...app.dashboards.map((dashboard) => dashboard.title),
          ...(app.notebooks ?? []).flatMap((notebook) => [notebook.title ?? '', notebook.path]),
          ...(app.drafts ?? []).flatMap((draft) => [draft.name, draft.path]),
        ].join(' ').toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (domainFilter && app.domain !== domainFilter) return false;
      if (subdomainFilter && app.subdomain !== subdomainFilter) return false;
      if (groupFilter && !(app.groups ?? []).includes(groupFilter)) return false;
      if (tagFilter && !(app.tags ?? []).includes(tagFilter)) return false;
      if (ownerFilter && !(app.owners ?? []).includes(ownerFilter)) return false;
      if (audienceFilter && app.audience !== audienceFilter) return false;
      if (lifecycleFilter && app.lifecycle !== lifecycleFilter) return false;
      if (certificationFilter && app.certification !== certificationFilter) return false;
      if (storageFilter === 'review' && app.lifecycle !== 'review') return false;
      if (storageFilter !== 'all' && storageFilter !== 'review' && (app.storage ?? 'shared') !== storageFilter) return false;
      return true;
    });
  }, [state.apps, search, domainFilter, subdomainFilter, groupFilter, tagFilter, ownerFilter, audienceFilter, lifecycleFilter, certificationFilter, storageFilter]);

  const activeApp = useMemo(
    () => state.apps.find((a) => a.id === state.activeAppId) ?? null,
    [state.apps, state.activeAppId],
  );
  const isBuild = appExperience === 'build';

  const switchExperience = (next: AppExperience) => {
    setAppExperience(next);
    if (next === 'view' && (appSection === 'drafts' || appSection === 'settings')) {
      setAppSection('dashboards');
    }
  };

  const openAddDashboardDialog = () => {
    setAddTabTitle('');
    setAddTabError(null);
    setAddTabOpen(true);
  };

  const createDashboardTab = async () => {
    if (!state.activeAppId) return;
    const title = addTabTitle.trim();
    if (!title) {
      setAddTabError('Enter a dashboard page name.');
      return;
    }
    setAddTabSaving(true);
    setAddTabError(null);
    try {
      const result = await api.createAppDashboard(state.activeAppId, { title });
      if (result.ok) {
        setAppExperience('build');
        setAppSection('dashboards');
        setAddTabOpen(false);
        setAddTabTitle('');
        if (appDoc) setDashboardDoc({ app: appDoc.app, dashboard: result.dashboard });
        dispatch({ type: 'OPEN_APP', appId: state.activeAppId, dashboardId: result.dashboard.id });
        await refreshApps(state.activeAppId, result.dashboard.id);
        dispatch({ type: 'OPEN_DASHBOARD', dashboardId: result.dashboard.id });
      } else {
        setAddTabError(result.error ?? 'Could not create dashboard page.');
      }
    } catch (err) {
      setAddTabError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddTabSaving(false);
    }
  };

  const openNotebookFile = async (path: string) => {
    const name = path.split('/').pop() || path;
    const file: NotebookFile = {
      name,
      path,
      type: 'notebook',
      folder: path.split('/').slice(0, -1).join('/') || 'notebooks',
    };
    const { content } = await api.readNotebook(path);
    const { title, cells, metadata } = parseNotebookFile(path, content);
    dispatch({ type: 'FILE_ADDED', file });
    dispatch({ type: 'OPEN_FILE', file, cells, title, metadata });
  };

  const openAttachNotebookDialog = async () => {
    if (!state.activeAppId) return;
    setAttachMode('existing');
    setAttachNotebookPath('');
    setAttachNotebookTitle('');
    setAttachNotebookRole('supporting');
    setAttachNotebookVisibility('shared');
    setNotebookCandidateSearch('');
    setNewNotebookName('');
    setAttachNotebookError(null);
    setAttachNotebookOpen(true);
    setNotebookCandidates(await api.listAppNotebookCandidates(state.activeAppId));
  };

  const attachNotebook = async () => {
    if (!state.activeAppId) return;
    const path = attachNotebookPath.trim();
    const newName = newNotebookName.trim() || attachNotebookTitle.trim();
    if (attachMode === 'existing' && !path) {
      setAttachNotebookError('Choose a notebook or enter a project-relative path.');
      return;
    }
    if (attachMode === 'new' && !newName) {
      setAttachNotebookError('Enter a notebook name.');
      return;
    }
    setAttachNotebookSaving(true);
    setAttachNotebookError(null);
    try {
      if (attachMode === 'new') {
        const created = await api.createAppNotebook(state.activeAppId, {
          name: newName,
          title: attachNotebookTitle.trim() || newName,
          role: attachNotebookRole,
          visibility: attachNotebookVisibility,
        });
        if (!created.ok) {
          setAttachNotebookError(created.error ?? 'Could not create notebook.');
          return;
        }
        await refreshApps(state.activeAppId, state.activeDashboardId);
        setAppSection('notebooks');
        setAttachNotebookOpen(false);
        await openNotebookFile(created.path);
        return;
      } else {
        const result = await api.attachAppNotebook(state.activeAppId, {
          path,
          title: attachNotebookTitle.trim() || undefined,
          role: attachNotebookRole,
          visibility: attachNotebookVisibility,
        });
        if ('ok' in result && result.ok === false) {
          setAttachNotebookError(result.error ?? 'Could not attach notebook.');
          return;
        }
      }
      const doc = await api.getApp(state.activeAppId);
      setAppDoc(doc);
      await refreshApps(state.activeAppId, state.activeDashboardId);
      setAppSection('notebooks');
      setAttachNotebookOpen(false);
      setAttachNotebookPath('');
      setAttachNotebookTitle('');
      setNewNotebookName('');
    } catch (err) {
      setAttachNotebookError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttachNotebookSaving(false);
    }
  };

  if (state.appsLoading && state.apps.length === 0) {
    return <EmptyState message="Loading apps..." onCreate={() => setWizardOpen(true)} />;
  }

  if (state.apps.length === 0) {
    return (
      <>
        <EmptyState
          message="Create your first local App."
          hint="Package dashboard pages, notebooks, AI pins, and drafts into a single OSS App."
          onCreate={() => setWizardOpen(true)}
        />
        {wizardOpen && <CreateAppWizard onClose={() => setWizardOpen(false)} onCreated={(appId, dashboardId) => void refreshApps(appId, dashboardId)} />}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
      <aside style={{ width: 292, borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))', background: 'var(--color-bg-secondary)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
              Apps Library
            </div>
            <button onClick={() => setWizardOpen(true)} style={primaryButtonStyle}>Create App</button>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search apps, dashboard pages, notebooks..." style={inputStyle} />
            <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={inputStyle}>
              <option value="">All domains</option>
              {facets.domains.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <select value={subdomainFilter} onChange={(e) => setSubdomainFilter(e.target.value)} style={inputStyle}>
                <option value="">Subdomain</option>
                {facets.subdomains.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={inputStyle}>
                <option value="">Group</option>
                {facets.groups.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} style={inputStyle}>
                <option value="">All tags</option>
                {facets.tags.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} style={inputStyle}>
                <option value="">All owners</option>
                {facets.owners.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <select value={audienceFilter} onChange={(e) => setAudienceFilter(e.target.value)} style={inputStyle}>
                <option value="">Audience</option>
                {facets.audiences.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <select value={lifecycleFilter} onChange={(e) => setLifecycleFilter(e.target.value)} style={inputStyle}>
                <option value="">Lifecycle</option>
                <option value="draft">draft</option>
                <option value="review">review</option>
                <option value="certified">certified</option>
                <option value="deprecated">deprecated</option>
              </select>
            </div>
            <select value={certificationFilter} onChange={(e) => setCertificationFilter(e.target.value)} style={inputStyle}>
              <option value="">All certification</option>
              <option value="certified">certified</option>
              <option value="uncertified">uncertified</option>
            </select>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
              {(['all', 'mine', 'shared', 'template', 'review'] as const).map((value) => (
                <button key={value} onClick={() => setStorageFilter(value)} style={filterButtonStyle(storageFilter === value)}>
                  {value === 'all' ? 'All' : value === 'template' ? 'Templates' : value === 'mine' ? 'Local' : value === 'review' ? 'Review' : 'Shared'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10, opacity: 0.62 }}>
              <span>My Local</span>
              <span>Shared</span>
              <span>Templates</span>
              <span>Review Queue</span>
            </div>
          </div>
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0, padding: '8px 0' }}>
          {filteredApps.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, opacity: 0.65 }}>No Apps match the current filters.</div>
          ) : filteredApps.map((a) => (
            <AppListItem
              key={a.id}
              app={a}
              active={a.id === state.activeAppId}
              onClick={() => {
                setAppSection('dashboards');
                dispatch({ type: 'OPEN_APP', appId: a.id });
              }}
            />
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', background: 'var(--color-bg)' }}>
        <AppWorkspaceHeader
          activeApp={activeApp}
          appDoc={appDoc}
          experience={appExperience}
          isBuild={isBuild}
          onExperienceChange={switchExperience}
          onAddPage={openAddDashboardDialog}
        />

        {appDoc && (
          <AppSectionTabs
            section={appSection}
            experience={appExperience}
            dashboardCount={appDoc.dashboards.length}
            notebookCount={appDoc.notebooks?.length ?? appDoc.app.notebooks?.length ?? 0}
            aiCount={appDoc.aiPins?.length ?? 0}
            draftCount={appDoc.drafts?.length ?? 0}
            onChange={setAppSection}
          />
        )}

        {appDoc && appSection === 'dashboards' && appDoc.dashboards.length > 0 && (
          <DashboardPageTabs
            dashboards={appDoc.dashboards}
            activeDashboardId={state.activeDashboardId}
            isBuild={isBuild}
            onAddPage={openAddDashboardDialog}
            onOpen={(dashboardId) => {
              setAppSection('dashboards');
              dispatch({ type: 'OPEN_DASHBOARD', dashboardId });
            }}
          />
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: appSection === 'notebooks' ? '12px 16px 18px' : '14px 16px 18px', minHeight: 0 }}>
          {loading ? (
            <EmptyState message="Loading dashboard..." />
          ) : appDoc && appSection === 'notebooks' ? (
            <NotebookRefsPanel
              appDoc={appDoc}
              editable={isBuild}
              onAttach={() => void openAttachNotebookDialog()}
              onOpenNotebook={(path) => void openNotebookFile(path)}
            />
          ) : appDoc && appSection === 'ai' ? (
            <AiSummariesPanel
              appDoc={appDoc}
              editable={isBuild}
              onPromoted={async () => {
                if (!state.activeAppId) return;
                setAppDoc(await api.getApp(state.activeAppId));
                await refreshApps(state.activeAppId, state.activeDashboardId);
              }}
            />
          ) : appDoc && isBuild && appSection === 'drafts' ? (
            <DraftsPanel drafts={appDoc.drafts ?? []} />
          ) : appDoc && isBuild && appSection === 'settings' ? (
            <AppSettingsPanel appDoc={appDoc} />
          ) : dashboardDoc && state.activeAppId ? (
            <DashboardRenderer
              appId={state.activeAppId}
              dashboard={dashboardDoc.dashboard}
              editable={isBuild}
              onDashboardChanged={(next) => {
                setDashboardDoc((current) => current ? { ...current, dashboard: next } : current);
                void refreshApps(state.activeAppId ?? undefined, next.id);
              }}
            />
          ) : appDoc && appDoc.dashboards.length === 0 ? (
            <EmptyState message="This App has no dashboard pages." hint={isBuild ? "Add a dashboard page from Build mode." : "No dashboard page has been published for this App."} />
          ) : (
            <EmptyState message="Select a dashboard." />
          )}
        </div>
      </main>

      {wizardOpen && <CreateAppWizard onClose={() => setWizardOpen(false)} onCreated={(appId, dashboardId) => void refreshApps(appId, dashboardId)} />}
      {addTabOpen && (
        <AddDashboardTabDialog
          title={addTabTitle}
          error={addTabError}
          saving={addTabSaving}
          appName={activeApp?.name ?? 'this App'}
          onChange={setAddTabTitle}
          onCancel={() => {
            if (addTabSaving) return;
            setAddTabOpen(false);
            setAddTabError(null);
          }}
          onCreate={() => void createDashboardTab()}
        />
      )}
      {attachNotebookOpen && (
        <AttachNotebookDialog
          mode={attachMode}
          path={attachNotebookPath}
          title={attachNotebookTitle}
          role={attachNotebookRole}
          visibility={attachNotebookVisibility}
          candidates={notebookCandidates}
          search={notebookCandidateSearch}
          newName={newNotebookName}
          error={attachNotebookError}
          saving={attachNotebookSaving}
          onModeChange={setAttachMode}
          onPathChange={setAttachNotebookPath}
          onTitleChange={setAttachNotebookTitle}
          onRoleChange={setAttachNotebookRole}
          onVisibilityChange={setAttachNotebookVisibility}
          onSearchChange={setNotebookCandidateSearch}
          onNewNameChange={setNewNotebookName}
          onCancel={() => {
            if (attachNotebookSaving) return;
            setAttachNotebookOpen(false);
            setAttachNotebookError(null);
          }}
          onAttach={() => void attachNotebook()}
        />
      )}
    </div>
  );
}

function AddDashboardTabDialog({
  title,
  error,
  saving,
  appName,
  onChange,
  onCancel,
  onCreate,
}: {
  title: string;
  error: string | null;
  saving: boolean;
  appName: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div style={modalBackdropStyle}>
      <div style={{ ...smallModalStyle, gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Add dashboard page</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
            Create a new dashboard page inside {appName}.
          </div>
        </div>
        <Field label="Page name">
          <input
            value={title}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onCreate();
              if (event.key === 'Escape') onCancel();
            }}
            placeholder="Overview, Fraud Ops, Executive Summary"
            autoFocus
            style={inputStyle}
          />
        </Field>
        {error ? <div style={{ color: '#f85149', fontSize: 12 }}>{error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} disabled={saving} style={ghostButtonStyle}>Cancel</button>
          <button onClick={onCreate} disabled={saving || !title.trim()} style={{ ...primaryButtonStyle, opacity: saving || !title.trim() ? 0.65 : 1 }}>
            {saving ? 'Creating...' : 'Create page'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AppWorkspaceHeader({
  activeApp,
  appDoc,
  experience,
  isBuild,
  onExperienceChange,
  onAddPage,
}: {
  activeApp: AppSummary | null;
  appDoc: AppDocumentSummary | null;
  experience: AppExperience;
  isBuild: boolean;
  onExperienceChange: (experience: AppExperience) => void;
  onAddPage: () => void;
}) {
  const dashboardCount = activeApp?.dashboards.length ?? 0;
  const notebookCount = activeApp?.notebooks?.length ?? 0;
  const tags = activeApp?.tags ?? [];
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
        padding: '13px 16px 12px',
        borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))',
        background: 'var(--color-bg, #fff)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 20, lineHeight: 1.15, fontWeight: 750, letterSpacing: 0 }}>
          {activeApp?.name ?? 'Apps'}
        </h1>
        <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.45, color: 'var(--color-text-secondary, rgba(0,0,0,0.62))' }}>
          {activeApp ? domainPath(activeApp) : 'Select an App'}
          {activeApp ? ` · ${dashboardCount} dashboard${dashboardCount === 1 ? '' : 's'}` : ''}
          {activeApp ? ` · ${notebookCount} notebook${notebookCount === 1 ? '' : 's'}` : ''}
          {activeApp?.description ? ` · ${activeApp.description}` : ''}
        </div>
        {tags.length ? (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
            {tags.slice(0, 8).map((tag) => <Pill key={tag}>{tag}</Pill>)}
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <PersonaSwitcher app={appDoc?.app ?? null} />
        <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface, rgba(0,0,0,0.04))', border: '1px solid var(--border-color, rgba(0,0,0,0.10))', borderRadius: 7, padding: 3, gap: 3 }}>
          <button onClick={() => onExperienceChange('view')} style={workspaceModeButtonStyle(experience === 'view')}>View</button>
          <button onClick={() => onExperienceChange('build')} style={workspaceModeButtonStyle(experience === 'build')}>Build</button>
        </div>
        {isBuild ? (
          <button type="button" onClick={onAddPage} disabled={!activeApp} style={ghostButtonStyle}>
            + Add page
          </button>
        ) : null}
      </div>
    </header>
  );
}

function AttachNotebookDialog({
  mode,
  path,
  title,
  role,
  visibility,
  candidates,
  search,
  newName,
  error,
  saving,
  onModeChange,
  onPathChange,
  onTitleChange,
  onRoleChange,
  onVisibilityChange,
  onSearchChange,
  onNewNameChange,
  onCancel,
  onAttach,
}: {
  mode: NotebookAttachMode;
  path: string;
  title: string;
  role: 'source' | 'analysis' | 'supporting';
  visibility: 'shared' | 'private' | 'template';
  candidates: AppNotebookCandidate[];
  search: string;
  newName: string;
  error: string | null;
  saving: boolean;
  onModeChange: (value: NotebookAttachMode) => void;
  onPathChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onRoleChange: (value: 'source' | 'analysis' | 'supporting') => void;
  onVisibilityChange: (value: 'shared' | 'private' | 'template') => void;
  onSearchChange: (value: string) => void;
  onNewNameChange: (value: string) => void;
  onCancel: () => void;
  onAttach: () => void;
}) {
  const filtered = candidates.filter((candidate) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [candidate.title, candidate.path, candidate.role ?? '', candidate.visibility ?? ''].join(' ').toLowerCase().includes(needle);
  });
  return (
    <div style={modalBackdropStyle}>
      <div style={{ ...smallModalStyle, width: 720, maxWidth: 'calc(100vw - 48px)', gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Add notebook</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
            Attach an existing notebook or create a new App notebook.
          </div>
        </div>
        <div style={{ display: 'flex', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, overflow: 'hidden', width: 'fit-content' }}>
          <button type="button" onClick={() => onModeChange('existing')} style={segmentButtonStyle(mode === 'existing')}>Existing</button>
          <button type="button" onClick={() => onModeChange('new')} style={segmentButtonStyle(mode === 'new')}>New notebook</button>
        </div>
        {mode === 'existing' ? (
          <>
            <Field label="Search notebooks">
              <input
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search by title or path"
                autoFocus
                style={inputStyle}
              />
            </Field>
            <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflow: 'auto', border: '1px solid var(--border-color, rgba(0,0,0,0.10))', borderRadius: 6, padding: 6 }}>
              {filtered.length === 0 ? (
                <div style={mutedStyle}>No notebooks found. Use the path field below or create a new notebook.</div>
              ) : filtered.map((candidate) => (
                <button
                  key={candidate.path}
                  type="button"
                  onClick={() => {
                    onPathChange(candidate.path);
                    onTitleChange(candidate.title);
                    if (candidate.role) onRoleChange(candidate.role);
                    if (candidate.visibility) onVisibilityChange(candidate.visibility);
                  }}
                  style={{
                    ...panelCardStyle,
                    textAlign: 'left',
                    borderColor: candidate.path === path ? 'var(--accent, #4f46e5)' : 'var(--border-color, rgba(0,0,0,0.10))',
                    background: candidate.path === path ? 'var(--color-bg-active, rgba(79,70,229,0.08))' : panelCardStyle.background,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontWeight: 700, flex: 1 }}>{candidate.title}</div>
                    {candidate.attached ? <Pill>attached</Pill> : null}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.68, marginTop: 4, fontFamily: 'monospace' }}>{candidate.path}</div>
                </button>
              ))}
            </div>
            <Field label="Advanced path">
              <input
                value={path}
                onChange={(event) => onPathChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onAttach();
                  if (event.key === 'Escape') onCancel();
                }}
                placeholder="notebooks/cards_fraud_ops.dqlnb"
                style={inputStyle}
              />
            </Field>
          </>
        ) : (
          <Field label="New notebook name">
            <input
              value={newName}
              onChange={(event) => onNewNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onAttach();
                if (event.key === 'Escape') onCancel();
              }}
              placeholder="fraud investigation notes"
              autoFocus
              style={inputStyle}
            />
          </Field>
        )}
        <Field label="Optional title">
          <input
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Fraud investigation notebook"
            style={inputStyle}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Role">
            <select value={role} onChange={(event) => onRoleChange(event.target.value as typeof role)} style={inputStyle}>
              <option value="source">Source</option>
              <option value="analysis">Analysis</option>
              <option value="supporting">Supporting</option>
            </select>
          </Field>
          <Field label="Visibility">
            <select value={visibility} onChange={(event) => onVisibilityChange(event.target.value as typeof visibility)} style={inputStyle}>
              <option value="shared">Shared</option>
              <option value="private">Private</option>
              <option value="template">Template</option>
            </select>
          </Field>
        </div>
        {error ? <div style={{ color: '#f85149', fontSize: 12 }}>{error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} disabled={saving} style={ghostButtonStyle}>Cancel</button>
          <button
            onClick={onAttach}
            disabled={saving || (mode === 'existing' ? !path.trim() : !newName.trim() && !title.trim())}
            style={{ ...primaryButtonStyle, opacity: saving || (mode === 'existing' ? !path.trim() : !newName.trim() && !title.trim()) ? 0.65 : 1 }}
          >
            {saving ? 'Saving...' : mode === 'new' ? 'Create notebook' : 'Attach notebook'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AppSectionTabs({
  section,
  experience,
  dashboardCount,
  notebookCount,
  aiCount,
  draftCount,
  onChange,
}: {
  section: AppSection;
  experience: AppExperience;
  dashboardCount: number;
  notebookCount: number;
  aiCount: number;
  draftCount: number;
  onChange: (section: AppSection) => void;
}) {
  const tabs: Array<{ id: AppSection; label: string; count?: number }> = [
    { id: 'dashboards', label: 'Dashboards', count: dashboardCount },
    { id: 'notebooks', label: 'Notebooks', count: notebookCount },
    { id: 'ai', label: 'AI', count: aiCount },
    ...(experience === 'build'
      ? [
          { id: 'drafts' as const, label: 'Drafts', count: draftCount },
          { id: 'settings' as const, label: 'Settings' },
        ]
      : []),
  ];
  return (
    <nav style={{ display: 'flex', gap: 8, padding: '12px 16px 0', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))', overflowX: 'auto', background: 'var(--color-bg, #fff)' }}>
      {tabs.map((tab) => (
        <button key={tab.id} onClick={() => onChange(tab.id)} style={appSectionTabStyle(section === tab.id)}>
          {tab.label}
          {tab.count !== undefined ? <span style={{ opacity: 0.65, marginLeft: 6 }}>{tab.count}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function DashboardPageTabs({
  dashboards,
  activeDashboardId,
  isBuild,
  onOpen,
  onAddPage,
}: {
  dashboards: AppDocumentSummary['dashboards'];
  activeDashboardId?: string | null;
  isBuild: boolean;
  onOpen: (dashboardId: string) => void;
  onAddPage: () => void;
}) {
  return (
    <nav style={{ display: 'flex', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))', overflowX: 'auto', background: 'var(--color-bg, #fff)' }}>
      {dashboards.map((dashboard) => (
        <button
          key={dashboard.id}
          onClick={() => onOpen(dashboard.id)}
          style={dashboardPageTabStyle(dashboard.id === activeDashboardId)}
        >
          {dashboard.title}
          {dashboard.itemCount > 0 ? <span style={{ opacity: 0.72, marginLeft: 6 }}>· {dashboard.itemCount}</span> : null}
        </button>
      ))}
      {isBuild ? (
        <button type="button" onClick={onAddPage} style={addPageTabStyle}>
          +
        </button>
      ) : null}
    </nav>
  );
}

function NotebookRefsPanel({
  appDoc,
  editable,
  onAttach,
  onOpenNotebook,
}: {
  appDoc: AppDocumentSummary;
  editable: boolean;
  onAttach: () => void;
  onOpenNotebook: (path: string) => void;
}) {
  const notebooks = appDoc.notebooks ?? appDoc.app.notebooks ?? [];
  const { state } = useNotebook();
  const [activePath, setActivePath] = useState<string | null>(notebooks[0]?.path ?? null);
  const [preview, setPreview] = useState<AppNotebookPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    if (!activePath || !notebooks.some((notebook) => notebook.path === activePath)) {
      setActivePath(notebooks[0]?.path ?? null);
    }
  }, [activePath, notebooks]);

  useEffect(() => {
    if (!activePath) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api.previewAppNotebook(appDoc.app.id, activePath).then((result) => {
      if (!cancelled) setPreview(result);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appDoc.app.id, activePath]);

  const runActiveNotebook = async () => {
    if (!activePath) return;
    setRunning(true);
    setRunError(null);
    const result = await api.runAppNotebook(appDoc.app.id, activePath);
    setRunning(false);
    if (!result.ok) {
      setRunError(result.error ?? 'Notebook run failed.');
      return;
    }
    setPreview(result.preview);
  };

  return (
    <section style={{ display: 'grid', gap: 12, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.2 }}>Notebooks</h2>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 3 }}>
            Attached analysis workbooks for this App.
          </div>
        </div>
      </div>
      {notebooks.length === 0 && !editable ? (
        <div style={mutedStyle}>No notebooks are attached to this App yet.</div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
            {notebooks.map((notebook) => (
              <button
                key={notebook.path}
                type="button"
                onClick={() => setActivePath(notebook.path)}
                title={notebook.path}
                style={notebookPageTabStyle(notebook.path === activePath)}
              >
                <span>{notebook.title ?? notebook.path}</span>
                {notebook.role ? <span style={{ opacity: 0.72, marginLeft: 6 }}>· {notebook.role}</span> : null}
              </button>
            ))}
            {editable ? (
              <button type="button" onClick={onAttach} title="Add notebook" style={addPageTabStyle}>
                +
              </button>
            ) : null}
          </div>
          {notebooks.length === 0 ? (
            <div style={mutedStyle}>No notebooks are attached yet. Use + to attach or create one.</div>
          ) : (
          <div>
            {loading ? (
              <NotebookReadOnlyShell
                title="Loading notebook..."
                path={activePath ?? ''}
                themeMode={state.themeMode}
                cellCount={0}
                running={running}
                error={runError}
                onRun={() => void runActiveNotebook()}
                onOpen={() => activePath ? onOpenNotebook(activePath) : undefined}
              >
                <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px', color: themes[state.themeMode].textMuted }}>
                  Loading notebook...
                </div>
              </NotebookReadOnlyShell>
            ) : preview ? (
              <NotebookPreview
                preview={preview}
                themeMode={state.themeMode}
                running={running}
                error={runError}
                onRun={() => void runActiveNotebook()}
                onOpen={() => onOpenNotebook(preview.path)}
              />
            ) : (
              <div style={mutedStyle}>Select a notebook to view it.</div>
            )}
          </div>
          )}
        </div>
      )}
    </section>
  );
}

function NotebookPreview({
  preview,
  themeMode,
  running,
  error,
  onRun,
  onOpen,
}: {
  preview: AppNotebookPreview;
  themeMode: ThemeMode;
  running: boolean;
  error: string | null;
  onRun: () => void;
  onOpen: () => void;
}) {
  const t = themes[themeMode];
  return (
    <NotebookReadOnlyShell
      title={preview.title}
      path={preview.path}
      themeMode={themeMode}
      cellCount={preview.cells.length}
      capturedAt={preview.capturedAt}
      running={running}
      error={error}
      onRun={onRun}
      onOpen={onOpen}
    >
      {error ? <div style={{ color: '#f85149', fontSize: 12 }}>{error}</div> : null}
      {preview.metadata ? <ReadOnlyNotebookMetadata metadata={preview.metadata} theme={t} /> : null}
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px 40px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {preview.cells.length === 0 ? (
          <div style={mutedStyle}>This notebook has no cells.</div>
        ) : preview.cells.map((cell) => (
          <NotebookPreviewCell key={cell.id} cell={cell} themeMode={themeMode} />
        ))}
      </div>
    </NotebookReadOnlyShell>
  );
}

function NotebookPreviewCell({ cell, themeMode }: { cell: AppNotebookPreview['cells'][number]; themeMode: ThemeMode }) {
  const t = themes[themeMode];
  const label = cell.name ?? READONLY_TYPE_LABELS[cell.type] ?? cell.type.toUpperCase();
  const showSource = cell.type === 'sql' || cell.type === 'dql' || cell.type === 'python' || cell.type === 'param' || cell.type === 'writeback';
  const color = READONLY_TYPE_COLORS[cell.type] ?? t.accent;
  return (
    <div
      data-readonly-notebook-cell
      style={{
        borderRadius: 8,
        border: `1px solid ${t.cellBorder}`,
        background: t.cellBg,
        boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
        overflow: 'hidden',
      }}
    >
      <div style={{ minHeight: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px' }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 500, color: t.textSecondary, whiteSpace: 'nowrap' }}>{READONLY_TYPE_LABELS[cell.type] ?? cell.type}</span>
        {cell.name ? <span style={{ color: t.textSecondary, fontSize: 12, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{cell.name}</span> : null}
        <div style={{ flex: 1 }} />
        <ReadOnlyInlineStatus cell={cell} theme={t} />
      </div>
      <div>
        {cell.type === 'markdown' ? <MarkdownPreview source={cell.content} theme={t} /> : null}
        {showSource ? <ReadOnlySourceBlock content={cell.content} theme={t} /> : null}
        {cell.error ? <div style={{ borderTop: `1px solid ${t.cellBorder}`, padding: 12, color: t.error, fontSize: 12 }}>{cell.error}</div> : null}
        {cell.result ? <ReadOnlyOutputFrame cell={cell} theme={t} themeMode={themeMode} /> : null}
      </div>
    </div>
  );
}

function NotebookReadOnlyShell({
  title,
  path,
  themeMode,
  cellCount,
  capturedAt,
  running,
  error,
  onRun,
  onOpen,
  children,
}: {
  title: string;
  path: string;
  themeMode: ThemeMode;
  cellCount: number;
  capturedAt?: string;
  running: boolean;
  error: string | null;
  onRun: () => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  const t = themes[themeMode];
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, overflow: 'hidden', background: t.appBg, minHeight: 520 }}>
      <div
        style={{
          minHeight: 34,
          borderBottom: `1px solid ${t.headerBorder}`,
          background: t.cellBg,
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px 0 16px',
          gap: 12,
        }}
      >
        <NotebookBreadcrumb title={title} path={path} theme={t} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, whiteSpace: 'nowrap' }}>
          {cellCount} {cellCount === 1 ? 'cell' : 'cells'}
          {capturedAt ? ` · Last run ${formatDate(capturedAt)}` : ' · No saved run yet'}
        </span>
        {error ? <span style={{ fontSize: 11, color: t.error }}>Run failed</span> : null}
        <button type="button" onClick={onRun} disabled={running} style={{ ...primaryButtonStyle, padding: '5px 9px', opacity: running ? 0.65 : 1 }}>
          {running ? 'Running...' : 'Run notebook'}
        </button>
        <button type="button" onClick={onOpen} style={{ ...ghostButtonStyle, padding: '5px 9px' }}>Open / Edit</button>
      </div>
      <div style={{ paddingTop: 14 }}>{children}</div>
    </div>
  );
}

function NotebookBreadcrumb({ title, path, theme }: { title: string; path: string; theme: Theme }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontFamily: theme.fontMono, color: theme.textMuted, overflow: 'hidden' }}>
      <span style={{ color: theme.textSecondary, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
        {title}
      </span>
      {parts.length > 0 ? <span style={{ color: theme.textMuted, opacity: 0.45 }}>/</span> : null}
      {parts.slice(-2).map((part, index, shown) => (
        <span key={`${part}:${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          {index > 0 ? <span style={{ color: theme.textMuted, opacity: 0.45 }}>/</span> : null}
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: index === shown.length - 1 ? 220 : 120 }}>
            {part}
          </span>
        </span>
      ))}
    </div>
  );
}

function ReadOnlyNotebookMetadata({ metadata, theme }: { metadata: Record<string, unknown>; theme: Theme }) {
  const rawItems: Array<[string, unknown]> = [
    ['Status', metadata.status],
    ['Owner', metadata.owner ?? metadata.author],
    ['Description', metadata.description],
    ['Categories', Array.isArray(metadata.categories) ? metadata.categories.join(', ') : metadata.categories],
  ];
  const items = rawItems.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (items.length === 0) return null;
  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px 12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, color: theme.textMuted }}>
        {items.map(([label, value]) => (
          <span key={label} style={{ fontSize: 11, fontFamily: theme.font, border: `1px solid ${theme.cellBorder}`, borderRadius: 4, padding: '3px 7px', background: theme.cellBg }}>
            <strong style={{ color: theme.textSecondary }}>{label}:</strong> {String(value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function ReadOnlySourceBlock({ content, theme }: { content: string; theme: Theme }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '10px 14px 12px',
        borderTop: `1px solid ${theme.cellBorder}`,
        background: theme.editorBg,
        color: theme.textPrimary,
        fontFamily: theme.fontMono,
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        overflowX: 'auto',
      }}
    >
      {content}
    </pre>
  );
}

function ReadOnlyOutputFrame({ cell, theme, themeMode }: { cell: AppNotebookPreview['cells'][number]; theme: Theme; themeMode: ThemeMode }) {
  const result = cell.result;
  const [vizChoice, setVizChoice] = useState<ReadOnlyVizChoice>(() => initialReadOnlyVizChoice(cell));
  const visualization = renderNotebookVisualizationOutput(cell, themeMode, vizChoice);
  const [mode, setMode] = useState<'table' | 'visualization'>(() => defaultNotebookOutputMode(cell));
  const tableResult = result && cell.type === 'table' ? projectTablePreview(result, cell.tableConfig) : result;
  const vizChoices = readOnlyVisualizationChoices(cell);
  return (
    <div style={{ borderTop: `1px solid ${theme.cellBorder}` }}>
      {result ? (
        <div
          style={{
            minHeight: 28,
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            gap: 10,
            borderBottom: `1px solid ${theme.cellBorder}`,
            background: `${theme.tableHeaderBg}60`,
          }}
        >
          <span style={{ fontSize: 11, fontFamily: theme.font, color: theme.textMuted }}>
            {(result.rowCount ?? result.rows.length).toLocaleString()} rows
            {result.executionTime !== undefined ? ` · ${formatExecutionTime(result.executionTime)}` : ''}
          </span>
          {cell.executedAt ? <span style={{ fontSize: 10, color: theme.textMuted }}>cached</span> : null}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <button
              type="button"
              onClick={() => setMode('table')}
              style={readOnlyOutputTabStyle(mode === 'table', theme)}
            >
              Table
            </button>
            <select
              value={vizChoice}
              onChange={(event) => {
                setVizChoice(event.target.value as ReadOnlyVizChoice);
                setMode('visualization');
              }}
              onClick={() => setMode('visualization')}
              title="Choose visualization type"
              style={readOnlyOutputSelectStyle(mode === 'visualization', theme)}
            >
              {vizChoices.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      <div>
        {mode === 'visualization' && visualization ? (
          visualization
        ) : tableResult ? (
          <TableOutput result={tableResult} themeMode={themeMode} />
        ) : null}
      </div>
    </div>
  );
}

function ReadOnlyInlineStatus({ cell, theme }: { cell: AppNotebookPreview['cells'][number]; theme: Theme }) {
  if (!cell.status || cell.status === 'idle') return null;
  const color = cell.status === 'success' ? theme.success : cell.status === 'error' ? theme.error : theme.warning;
  return (
    <span style={{ fontSize: 10, fontFamily: theme.font, color, border: `1px solid ${color}55`, borderRadius: 3, padding: '1px 6px', lineHeight: '16px' }}>
      {cell.status}
    </span>
  );
}

function renderNotebookVisualizationOutput(cell: AppNotebookPreview['cells'][number], themeMode: ThemeMode, vizChoice: ReadOnlyVizChoice): ReactNode {
  const result = cell.result;
  if (!result) return null;
  if (vizChoice === 'pivot' && cell.type === 'pivot') {
    return <PivotPreview result={result} config={cell.pivotConfig} themeMode={themeMode} />;
  }
  if (vizChoice === 'kpi' && cell.type === 'single_value') {
    return <SingleValuePreview result={result} config={cell.singleValueConfig} />;
  }
  return <ChartOutput result={result} themeMode={themeMode} chartConfig={{ ...(cell.chartConfig ?? {}), chart: vizChoice } as any} />;
}

function defaultNotebookOutputMode(cell: AppNotebookPreview['cells'][number]): 'table' | 'visualization' {
  if (cell.type === 'chart' || cell.type === 'single_value' || cell.type === 'pivot') return 'visualization';
  const chart = String(cell.chartConfig?.chart ?? '').toLowerCase();
  return chart && chart !== 'table' ? 'visualization' : 'table';
}

function initialReadOnlyVizChoice(cell: AppNotebookPreview['cells'][number]): ReadOnlyVizChoice {
  if (cell.type === 'pivot') return 'pivot';
  if (cell.type === 'single_value') return 'kpi';
  const configured = normalizeReadOnlyVizChoice(cell.chartConfig?.chart);
  if (configured) return configured;
  if (cell.result) {
    const resolved = resolveChartType(cell.result, cell.chartConfig as any);
    if (resolved !== 'table') return resolved;
  }
  return 'bar';
}

function normalizeReadOnlyVizChoice(value: unknown): ReadOnlyVizChoice | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/_/g, '-') as ReadOnlyVizChoice;
  if (normalized === 'pivot') return 'pivot';
  return CHART_TYPE_OPTIONS.some((option) => option.value === normalized) ? normalized : null;
}

function readOnlyVisualizationChoices(cell: AppNotebookPreview['cells'][number]): Array<{ value: ReadOnlyVizChoice; label: string }> {
  const choices = CHART_TYPE_OPTIONS.map((option) => ({ value: option.value as ReadOnlyVizChoice, label: option.label }));
  return cell.type === 'pivot' ? [{ value: 'pivot', label: 'Pivot' }, ...choices] : choices;
}

function readOnlyOutputTabStyle(active: boolean, theme: Theme): CSSProperties {
  return {
    padding: '1px 7px',
    fontSize: 10,
    fontFamily: theme.font,
    borderRadius: 3,
    border: `1px solid ${active ? theme.accent : theme.btnBorder}`,
    background: active ? `${theme.accent}20` : 'transparent',
    color: active ? theme.accent : theme.textMuted,
    cursor: 'pointer',
    transition: 'all 0.15s',
  };
}

function readOnlyOutputSelectStyle(active: boolean, theme: Theme): CSSProperties {
  return {
    ...readOnlyOutputTabStyle(active, theme),
    minWidth: 118,
    padding: '1px 22px 1px 7px',
    outline: 'none',
  };
}

function projectTablePreview(result: QueryResult, rawConfig: Record<string, unknown> | undefined): QueryResult {
  const visibleColumns = Array.isArray(rawConfig?.visibleColumns)
    ? rawConfig.visibleColumns.filter((column): column is string => typeof column === 'string')
    : [];
  if (visibleColumns.length === 0) return result;
  const available = new Set(result.columns);
  const keep = visibleColumns.filter((column) => available.has(column));
  if (keep.length === 0) return result;
  return {
    ...result,
    columns: keep,
    rows: result.rows.map((row) => Object.fromEntries(keep.map((column) => [column, row[column]]))),
  };
}

function SingleValuePreview({ result, config }: { result: QueryResult; config?: Record<string, unknown> }) {
  const aggregation = normalizeAggregation(config?.aggregation, 'count');
  const metric = typeof config?.metric === 'string' ? config.metric : undefined;
  const label = typeof config?.label === 'string' && config.label.trim()
    ? config.label
    : `${aggregation.toUpperCase()}${metric ? ` · ${metric}` : ''}`;
  const format = typeof config?.format === 'string' ? config.format : 'number';
  const value = aggregation === 'count'
    ? aggregate(result.rows, 'count')
    : metric && result.columns.includes(metric)
      ? aggregate(result.rows.map((row) => row[metric]), aggregation)
      : null;

  return (
    <div style={{
      border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
      borderRadius: 6,
      padding: '18px 20px',
      display: 'grid',
      gap: 6,
      background: 'var(--surface-subtle, rgba(0,0,0,0.02))',
    }}>
      <div style={{ fontSize: 11, opacity: 0.62, textTransform: 'uppercase', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 34, lineHeight: 1.1, fontWeight: 800 }}>{formatPreviewNumber(value, format)}</div>
      <div style={{ fontSize: 11, opacity: 0.6 }}>{result.rows.length.toLocaleString()} rows</div>
    </div>
  );
}

function PivotPreview({ result, config, themeMode }: { result: QueryResult; config?: Record<string, unknown>; themeMode: ThemeMode }) {
  const rows = stringArray(config?.rows).filter((column) => result.columns.includes(column));
  const columns = stringArray(config?.columns).filter((column) => result.columns.includes(column));
  const values = Array.isArray(config?.values)
    ? config.values
      .map((value) => {
        if (!value || typeof value !== 'object') return null;
        const record = value as Record<string, unknown>;
        const column = typeof record.column === 'string' ? record.column : '';
        if (!result.columns.includes(column)) return null;
        return { column, aggregation: normalizeAggregation(record.aggregation, 'sum') };
      })
      .filter((value): value is { column: string; aggregation: Aggregation } => Boolean(value))
    : [];

  if ((rows.length === 0 && columns.length === 0) || values.length === 0) {
    return <TableOutput result={result} themeMode={themeMode} />;
  }

  const colKeys = new Set<string>();
  const grouped = new Map<string, { rowDims: Record<string, unknown>; buckets: Map<string, Record<string, unknown>[]> }>();
  for (const row of result.rows) {
    const rowKey = keyFor(row, rows);
    const colKey = keyFor(row, columns);
    colKeys.add(colKey);
    const existing = grouped.get(rowKey) ?? { rowDims: Object.fromEntries(rows.map((column) => [column, row[column]])), buckets: new Map() };
    const bucket = existing.buckets.get(colKey) ?? [];
    bucket.push(row);
    existing.buckets.set(colKey, bucket);
    grouped.set(rowKey, existing);
  }

  const sortedColKeys = [...colKeys].sort();
  const headers = sortedColKeys.length > 0 ? sortedColKeys : [''];
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            {rows.map((row) => <th key={row} style={pivotHeadStyle('left')}>{row}</th>)}
            {headers.map((header) => (
              <th key={header || 'value'} style={pivotHeadStyle('right')}>
                {header || 'value'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...grouped.values()].slice(0, 50).map((entry, index) => (
            <tr key={index}>
              {rows.map((row) => <td key={row} style={pivotCellStyle('left')}>{String(entry.rowDims[row] ?? '')}</td>)}
              {headers.map((header) => {
                const bucket = entry.buckets.get(header) ?? [];
                return (
                  <td key={header || 'value'} style={pivotCellStyle('right')}>
                    {values.map((value) => {
                      const aggregated = aggregate(bucket.map((row) => row[value.column]), value.aggregation);
                      return <div key={`${value.aggregation}:${value.column}`}>{formatPreviewNumber(aggregated, 'number')}</div>;
                    })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeAggregation(value: unknown, fallback: Aggregation): Aggregation {
  if (value === 'sum' || value === 'avg' || value === 'count' || value === 'count_distinct' || value === 'min' || value === 'max' || value === 'last') {
    return value;
  }
  return fallback;
}

function keyFor(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((column) => String(row[column] ?? '')).join('|');
}

function formatPreviewNumber(value: number | null, format: string): string {
  if (value === null) return '-';
  if (format === 'currency') return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  if (format === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (format === 'duration') {
    if (value < 60) return `${value.toFixed(1)}s`;
    if (value < 3600) return `${(value / 60).toFixed(1)}m`;
    return `${(value / 3600).toFixed(1)}h`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatExecutionTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function pivotHeadStyle(textAlign: 'left' | 'right'): CSSProperties {
  return {
    textAlign,
    padding: '6px 8px',
    borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.1))',
    opacity: 0.72,
    fontWeight: 700,
  };
}

function pivotCellStyle(textAlign: 'left' | 'right'): CSSProperties {
  return {
    textAlign,
    padding: '5px 8px',
    borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))',
  };
}

function MarkdownPreview({ source, theme }: { source: string; theme: Theme }) {
  return (
    <div style={{ padding: '10px 14px 14px', display: 'grid', gap: 6, lineHeight: 1.45, color: theme.textPrimary }}>
      {renderMarkdown(source, theme)}
    </div>
  );
}

function AiSummariesPanel({ appDoc, editable, onPromoted }: { appDoc: AppDocumentSummary; editable: boolean; onPromoted: () => Promise<void> }) {
  const pins = appDoc.aiPins ?? [];
  const [tab, setTab] = useState<'conversations' | 'pins'>('conversations');
  const [conversations, setConversations] = useState<AppConversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<AppConversation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.listAppConversations(appDoc.app.id).then((items) => {
      if (!cancelled) setConversations(items);
    });
    setActiveConversation(null);
    return () => {
      cancelled = true;
    };
  }, [appDoc.app.id]);
  const promote = async (pinId: string) => {
    setError(null);
    setBusy(pinId);
    const result = await api.promoteAiPin(appDoc.app.id, pinId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? 'Promotion failed.');
      return;
    }
    await onPromoted();
  };
  const removeConversation = async (conversationId: string) => {
    setBusy(conversationId);
    const result = await api.deleteAppConversation(appDoc.app.id, conversationId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? 'Could not delete conversation.');
      return;
    }
    if (activeConversation?.id === conversationId) setActiveConversation(null);
    setConversations((items) => items.filter((item) => item.id !== conversationId));
  };
  const openConversation = async (conversationId: string) => {
    const full = await api.getAppConversation(appDoc.app.id, conversationId);
    setActiveConversation(full);
  };
  return (
    <PanelFrame title="AI">
      <div style={{ display: 'flex', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, overflow: 'hidden', width: 'fit-content' }}>
        <button type="button" onClick={() => setTab('conversations')} style={segmentButtonStyle(tab === 'conversations')}>
          Conversations <span style={{ opacity: 0.65, marginLeft: 4 }}>{conversations.length}</span>
        </button>
        <button type="button" onClick={() => setTab('pins')} style={segmentButtonStyle(tab === 'pins')}>
          Pinned summaries <span style={{ opacity: 0.65, marginLeft: 4 }}>{pins.length}</span>
        </button>
      </div>
      {error ? <div style={{ color: '#f85149', fontSize: 12 }}>{error}</div> : null}
      {tab === 'conversations' ? (
        activeConversation ? (
          <div style={panelCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={() => setActiveConversation(null)} style={miniActionStyle}>Back</button>
              <div style={{ fontWeight: 700, flex: 1 }}>{activeConversation.title}</div>
              <Pill>{`${activeConversation.messages?.length ?? activeConversation.messageCount} messages`}</Pill>
            </div>
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              {(activeConversation.messages ?? []).map((message, index) => (
                <div
                  key={message.id ?? index}
                  style={{
                    border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
                    borderRadius: 6,
                    padding: 10,
                    background: message.role === 'user' ? 'var(--color-bg-active, rgba(79,70,229,0.08))' : 'var(--surface, rgba(0,0,0,0.02))',
                  }}
                >
                  <div style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 800, opacity: 0.62, marginBottom: 4 }}>{message.role === 'user' ? 'You' : 'DQL Agent'}</div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.45 }}>{message.content}</div>
                </div>
              ))}
            </div>
          </div>
        ) : conversations.length === 0 ? (
          <div style={mutedStyle}>Dashboard AI conversations are saved locally and will appear here after you ask AI from a dashboard page.</div>
        ) : conversations.map((conversation) => (
          <div key={conversation.id} style={panelCardStyle}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ fontWeight: 700, flex: 1 }}>{conversation.title}</div>
              <Pill>{`${conversation.messageCount} messages`}</Pill>
              {conversation.dashboardId ? <Pill>{conversation.dashboardId}</Pill> : null}
            </div>
            {conversation.lastMessage ? (
              <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.45, fontSize: 12, opacity: 0.78 }}>{conversation.lastMessage}</div>
            ) : null}
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, opacity: 0.64 }}>Private local history · {formatDate(conversation.updatedAt)}</span>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={() => void openConversation(conversation.id)} style={miniActionStyle}>
                Open
              </button>
              {editable ? (
                <button type="button" onClick={() => void removeConversation(conversation.id)} style={miniActionStyle} disabled={busy === conversation.id}>
                  {busy === conversation.id ? 'Deleting...' : 'Delete'}
                </button>
              ) : null}
            </div>
          </div>
        ))
      ) : pins.length === 0 ? (
        <div style={mutedStyle}>Pinned AI summaries for this App will appear here.</div>
      ) : pins.map((pin) => (
        <div key={pin.id} style={panelCardStyle}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ fontWeight: 700, flex: 1 }}>{pin.title}</div>
            <Pill>{pin.reviewStatus}</Pill>
            <Pill>{pin.certification}</Pill>
          </div>
          <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.45, fontSize: 12 }}>{pin.answer}</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, opacity: 0.64 }}>{pin.dashboardId}{pin.tileId ? ` · ${pin.tileId}` : ''}</span>
            <div style={{ flex: 1 }} />
            {editable && pin.sql && pin.reviewStatus === 'needs_review' ? (
              <button type="button" onClick={() => void promote(pin.id)} style={miniActionStyle} disabled={busy === pin.id}>
                {busy === pin.id ? 'Promoting...' : 'Promote to draft'}
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </PanelFrame>
  );
}

function DraftsPanel({ drafts }: { drafts: NonNullable<AppDocumentSummary['drafts']> }) {
  return (
    <PanelFrame title="Draft Blocks">
      {drafts.length === 0 ? (
        <div style={mutedStyle}>AI-generated or imported DQL drafts promoted into this App appear here.</div>
      ) : drafts.map((draft) => (
        <InfoRow key={draft.path} title={draft.name} meta={draft.reviewStatus ?? 'review'} detail={draft.path} />
      ))}
    </PanelFrame>
  );
}

function AppSettingsPanel({ appDoc }: { appDoc: AppDocumentSummary }) {
  const rows = [
    ['Domain path', domainPath(appDoc.app)],
    ['Visibility', appDoc.app.visibility ?? 'shared'],
    ['Lifecycle', appDoc.app.lifecycle ?? 'draft'],
    ['Audience', appDoc.app.audience ?? '-'],
    ['Owners', appDoc.app.owners.join(', ') || '-'],
    ['Roles', String(appDoc.app.roles.length)],
    ['Policies', String(appDoc.app.policies.length)],
    ['Schedules', String(appDoc.app.schedules?.length ?? 0)],
  ];
  return (
    <PanelFrame title="App Settings">
      <div style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.10))', borderRadius: 6, overflow: 'hidden' }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))' }}>
            <div style={{ padding: 9, fontSize: 11, opacity: 0.62 }}>{label}</div>
            <div style={{ padding: 9, fontSize: 12 }}>{value}</div>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}

function PanelFrame({ title, action, children }: { title: string; action?: JSX.Element; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 12, maxWidth: 920 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        <div style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </section>
  );
}

function InfoRow({ title, meta, detail }: { title: string; meta: string; detail: string }) {
  return (
    <div style={panelCardStyle}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <Pill>{meta}</Pill>
      </div>
      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 5, fontFamily: 'monospace' }}>{detail}</div>
    </div>
  );
}

function CreateAppWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (appId: string, dashboardId: string) => void;
}): JSX.Element {
  const { dispatch } = useNotebook();
  const [startSource, setStartSource] = useState<AppStartSource>('empty');
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [dashboardTitle, setDashboardTitle] = useState('Overview');
  const [subdomain, setSubdomain] = useState('');
  const [groups, setGroups] = useState('');
  const [purpose, setPurpose] = useState('');
  const [notebookPath, setNotebookPath] = useState('');
  const [notebookTitle, setNotebookTitle] = useState('');
  const [audience, setAudience] = useState('');
  const [lifecycle, setLifecycle] = useState<'draft' | 'review' | 'certified' | 'deprecated'>('draft');
  const [visibility, setVisibility] = useState<'shared' | 'private' | 'template'>('shared');
  const [tags, setTags] = useState('');
  const [owner, setOwner] = useState(`${(window as unknown as { DQL_USER?: string }).DQL_USER ?? 'owner'}@local`);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagList = useMemo(() => tags.split(',').map((tag) => tag.trim()).filter(Boolean), [tags]);
  const canCreate = Boolean(name.trim() && domain.trim() && dashboardTitle.trim() && (startSource !== 'notebook' || notebookPath.trim()));

  const create = async () => {
    if (!canCreate || startSource === 'import') return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.createApp({
        name,
        domain,
        dashboardTitle,
        subdomain: subdomain.trim() || undefined,
        groups: groups.split(',').map((group) => group.trim()).filter(Boolean),
        purpose,
        audience: audience.trim() || undefined,
        visibility,
        lifecycle,
        tags: unique([...tagList, ...(startSource === 'empty' ? [] : [`source:${startSource}`])]),
        owners: [owner],
        selectedBlockIds: [],
      });
      if (startSource === 'notebook' && notebookPath.trim()) {
        const attachResult = await api.attachAppNotebook(result.app.id, {
          path: notebookPath.trim(),
          title: notebookTitle.trim() || undefined,
          role: 'analysis',
          visibility: 'shared',
        });
        if ('ok' in attachResult && attachResult.ok === false) {
          onCreated(result.app.id, result.dashboardId);
          setError(`App created, but notebook attach failed: ${attachResult.error}`);
          return;
        }
      }
      onCreated(result.app.id, result.dashboardId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={modalBackdropStyle}>
      <div style={{ ...smallModalStyle, width: 760, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 48px)', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))', padding: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Create App</div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>Create one App with an Overview dashboard page. Add blocks, notebooks, AI pins, and drafts after creation.</div>
          </div>
          <button onClick={onClose} style={ghostButtonStyle}>Close</button>
        </div>

        <div style={{ padding: 16, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Start from</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
              {([
                ['empty', 'Empty App'],
                ['notebook', 'From Notebook'],
                ['template', 'From Template'],
                ['import', 'From Import'],
              ] as Array<[AppStartSource, string]>).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setStartSource(value)} style={sourceButtonStyle(startSource === value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {startSource === 'import' ? (
            <InfoCard title="Use Block Studio Imports" text="Import SQL files in Block Studio first, review and save draft blocks, then return here to create an App and add those blocks from the Build catalog." />
          ) : null}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="App name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily Fraud Ops App" style={inputStyle} /></Field>
            <Field label="First dashboard page"><input value={dashboardTitle} onChange={(e) => setDashboardTitle(e.target.value)} placeholder="Overview" style={inputStyle} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Domain"><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="cards" style={inputStyle} /></Field>
            <Field label="Subdomain"><input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="fraud" style={inputStyle} /></Field>
          </div>
          <Field label="Group / use case"><input value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="daily-ops, executive-review" style={inputStyle} /></Field>
          {startSource === 'notebook' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Notebook path"><input value={notebookPath} onChange={(e) => setNotebookPath(e.target.value)} placeholder="notebooks/cards_fraud_ops.dqlnb" style={inputStyle} /></Field>
              <Field label="Notebook title"><input value={notebookTitle} onChange={(e) => setNotebookTitle(e.target.value)} placeholder="Fraud investigation notebook" style={inputStyle} /></Field>
            </div>
          ) : null}
          <Field label="Purpose"><textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Daily operating view for monitoring fraud risk, investigation queues, and trend movement." style={{ ...inputStyle, minHeight: 76, resize: 'vertical' }} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Audience"><input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="ops, executive, analyst" style={inputStyle} /></Field>
            <Field label="Owner"><input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="owner@local" style={inputStyle} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Visibility">
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)} style={inputStyle}>
                <option value="shared">shared</option>
                <option value="private">private</option>
                <option value="template">template</option>
              </select>
            </Field>
            <Field label="Lifecycle">
              <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as typeof lifecycle)} style={inputStyle}>
                <option value="draft">draft</option>
                <option value="review">review</option>
                <option value="certified">certified</option>
                <option value="deprecated">deprecated</option>
              </select>
            </Field>
          </div>
          <Field label="Tags"><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="fraud, daily, ops" style={inputStyle} /></Field>
          <InfoCard title="After create" text="Open Build mode to add blocks from the catalog, add more dashboard pages, attach notebooks, and pin AI answers." />
          {error && <div style={{ color: '#f85149', fontSize: 12 }}>{error}</div>}
        </div>

        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 16, borderTop: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
          <button onClick={onClose} disabled={loading} style={ghostButtonStyle}>Cancel</button>
          {startSource === 'import' ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                dispatch({ type: 'OPEN_BLOCK_IMPORT' });
              }}
              style={primaryButtonStyle}
            >
              Open Import
            </button>
          ) : (
            <button onClick={create} disabled={loading || !canCreate} style={{ ...primaryButtonStyle, opacity: loading || !canCreate ? 0.65 : 1 }}>
              {loading ? 'Creating...' : 'Create App'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function AppListItem({ app, active, onClick }: { app: AppSummary; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', background: active ? 'var(--surface-hover, rgba(0,0,0,0.06))' : 'transparent', border: 'none', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.04))', cursor: 'pointer', color: 'inherit', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: active ? 700 : 600, flex: 1 }}>{app.name}</span>
        <span style={{ fontSize: 10, opacity: 0.65 }}>{app.lifecycle ?? app.status ?? 'ready'}</span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 3 }}>
        {domainPath(app)} · {app.dashboards.length} dashboard{app.dashboards.length === 1 ? '' : 's'} · {(app.notebooks ?? []).length} notebook{(app.notebooks ?? []).length === 1 ? '' : 's'}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
        <Pill>{app.storage ?? 'shared'}</Pill>
        <Pill>{app.certification ?? 'uncertified'}</Pill>
        {(app.tags ?? []).filter((tag) => !tag.startsWith('audience:')).slice(0, 3).map((tag) => <Pill key={tag}>{tag}</Pill>)}
      </div>
    </button>
  );
}

function BlockRecommendationRow({ block, selected, onToggle }: { block: AppBlockRecommendation; selected: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button onClick={onToggle} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 10, alignItems: 'start', textAlign: 'left', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', background: selected ? 'var(--color-bg-active, rgba(79,70,229,0.10))' : 'transparent', borderRadius: 6, padding: 10, color: 'inherit' }}>
      <input type="checkbox" checked={selected} onChange={onToggle} onClick={(event) => event.stopPropagation()} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{block.name}</div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{block.description || block.path}</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          <Pill>{block.domain}</Pill>
          <Pill>{block.status}</Pill>
          {(block.tags ?? []).slice(0, 4).map((tag) => <Pill key={tag}>{tag}</Pill>)}
        </div>
      </div>
      <div style={{ fontSize: 10, opacity: 0.7, maxWidth: 150 }}>{block.reasons.join(', ')}</div>
    </button>
  );
}

function EmptyState({ message, hint, onCreate }: { message: string; hint?: string; onCreate?: () => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 260, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, opacity: 0.8, fontSize: 14 }}>
      <div>{message}</div>
      {hint ? <div style={{ fontSize: 12, opacity: 0.7 }}>{hint}</div> : null}
      {onCreate ? <button onClick={onCreate} style={primaryButtonStyle}>Create App</button> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 5, fontSize: 12, fontWeight: 600 }}>
      {label}
      {children}
    </label>
  );
}

function InfoCard({ title, text }: { title: string; text: string }): JSX.Element {
  return (
    <div style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.45 }}>{text}</div>
    </div>
  );
}

function RoleGrid(): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
      <InfoCard title="Owner" text="Full App configuration and execution access." />
      <InfoCard title="Analyst" text="Can execute dashboards and review generated drafts." />
      <InfoCard title="Viewer" text="Read-oriented persona for stakeholder preview." />
    </div>
  );
}

function ReviewTable({
  source,
  notebookPath,
  importSourcePath,
  name,
  domain,
  subdomain,
  groups,
  audience,
  lifecycle,
  owner,
  tags,
  selectedCount,
}: {
  source: AppStartSource;
  notebookPath: string;
  importSourcePath: string;
  name: string;
  domain: string;
  subdomain: string;
  groups: string;
  audience: string;
  lifecycle: string;
  owner: string;
  tags: string[];
  selectedCount: number;
}): JSX.Element {
  const rows = [
    ['Source', sourceLabel(source)],
    ...(source === 'notebook' ? [['Notebook', notebookPath || '-']] : []),
    ...(source === 'import' ? [['Import source', importSourcePath || 'Block Studio Imports']] : []),
    ['Name', name || '-'],
    ['Domain', domain || '-'],
    ['Subdomain', subdomain || '-'],
    ['Group', groups || '-'],
    ['Audience', audience || '-'],
    ['Lifecycle', lifecycle || 'draft'],
    ['Owner', owner || '-'],
    ['Tags', tags.join(', ') || '-'],
    ['Selected blocks', String(selectedCount)],
  ];
  return (
    <div style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, overflow: 'hidden' }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'grid', gridTemplateColumns: '150px 1fr', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))' }}>
          <div style={{ padding: 8, fontSize: 11, opacity: 0.65 }}>{label}</div>
          <div style={{ padding: 8, fontSize: 12 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function Pill({ children }: { children: string }): JSX.Element {
  return <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--surface-hover, rgba(0,0,0,0.06))', opacity: 0.82 }}>{children}</span>;
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function domainPath(app: Pick<AppSummary, 'domain' | 'subdomain' | 'groups'>): string {
  return [app.domain, app.subdomain, ...(app.groups ?? [])].filter(Boolean).join(' / ');
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function sourceLabel(source: AppStartSource): string {
  switch (source) {
    case 'notebook':
      return 'From Notebook';
    case 'import':
      return 'From Import';
    case 'template':
      return 'From Template';
    default:
      return 'Empty App';
  }
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  padding: '7px 8px',
};

const primaryButtonStyle: CSSProperties = {
  border: '1px solid var(--accent, #4f46e5)',
  background: 'var(--accent, #4f46e5)',
  color: 'var(--color-text-on-accent, #fff)',
  borderRadius: 5,
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

const ghostButtonStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'transparent',
  color: 'inherit',
  borderRadius: 5,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

const mutedStyle: CSSProperties = { fontSize: 12, opacity: 0.65, padding: 12 };
const formGridStyle: CSSProperties = { display: 'grid', gap: 12, maxWidth: 680 };
const modalBackdropStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 };
const modalStyle: CSSProperties = { width: 'min(980px, 96vw)', maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, boxShadow: '0 18px 60px rgba(0,0,0,0.35)' };
const smallModalStyle: CSSProperties = { width: 'min(420px, 92vw)', display: 'grid', background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, boxShadow: '0 18px 60px rgba(0,0,0,0.35)', padding: 16 };
const panelCardStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
};

const miniActionStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: '4px 8px',
  fontSize: 11,
  cursor: 'pointer',
};

function wizardStepStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    border: 'none',
    borderRadius: 5,
    background: active ? 'var(--color-bg-active, rgba(79,70,229,0.12))' : 'transparent',
    color: 'inherit',
    padding: '8px 9px',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 12,
  };
}

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    border: '1px solid var(--border-color, rgba(0,0,0,0.1))',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  };
}

function appSectionTabStyle(active: boolean): CSSProperties {
  return {
    padding: '8px 13px',
    marginBottom: -1,
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'var(--color-text-secondary, rgba(0,0,0,0.72))',
    border: active ? '1px solid var(--accent, #4f46e5)' : '1px solid transparent',
    borderRadius: '6px 6px 0 0',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
  };
}

function dashboardPageTabStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    background: active ? 'var(--accent, #4f46e5)' : 'var(--surface, rgba(0,0,0,0.015))',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    border: `1px solid ${active ? 'var(--accent, #4f46e5)' : 'var(--border-color, rgba(0,0,0,0.12))'}`,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

function notebookPageTabStyle(active: boolean): CSSProperties {
  return {
    ...dashboardPageTabStyle(active),
    maxWidth: 340,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

const addPageTabStyle: CSSProperties = {
  padding: '5px 10px',
  minWidth: 34,
  background: 'transparent',
  color: 'inherit',
  border: '1px dashed var(--border-color, rgba(0,0,0,0.22))',
  borderRadius: 6,
  fontSize: 15,
  lineHeight: 1,
  cursor: 'pointer',
};

function workspaceModeButtonStyle(active: boolean): CSSProperties {
  return {
    border: 'none',
    borderRadius: 5,
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'var(--color-text-secondary, rgba(0,0,0,0.66))',
    padding: '5px 11px',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
  };
}

function segmentButtonStyle(active: boolean): CSSProperties {
  return {
    border: 'none',
    borderRight: '1px solid var(--border-color, rgba(0,0,0,0.10))',
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
  };
}

function filterButtonStyle(active: boolean): CSSProperties {
  return {
    border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
    borderRadius: 5,
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    padding: '5px 4px',
    fontSize: 11,
    cursor: 'pointer',
  };
}

function sourceButtonStyle(active: boolean): CSSProperties {
  return {
    minHeight: 38,
    border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
    borderRadius: 6,
    background: active ? 'var(--accent, #4f46e5)' : 'var(--surface, transparent)',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    padding: '7px 8px',
    fontSize: 12,
    fontWeight: active ? 700 : 600,
    cursor: 'pointer',
  };
}
