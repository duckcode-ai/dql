import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import {
  api,
  type AppBlockRecommendation,
  type AppDocumentSummary,
  type DashboardDocumentResponse,
} from '../../api/client';
import type { AppSummary } from '../../store/types';
import { PersonaSwitcher } from './PersonaSwitcher';
import { DashboardRenderer } from './DashboardRenderer';

type WizardStep = 0 | 1 | 2 | 3 | 4;
type AppLibraryFilter = 'all' | 'mine' | 'shared' | 'template' | 'review';
type AppSection = 'dashboards' | 'notebooks' | 'ai' | 'drafts' | 'settings';
type AppExperience = 'stakeholder' | 'analyst';
type AppStartSource = 'blank' | 'notebook' | 'sql' | 'template';

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
  const [appExperience, setAppExperience] = useState<AppExperience>('stakeholder');

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
  const isAnalyst = appExperience === 'analyst';

  const switchExperience = (next: AppExperience) => {
    setAppExperience(next);
    if (next === 'stakeholder' && (appSection === 'drafts' || appSection === 'settings')) {
      setAppSection('dashboards');
    }
  };

  const createDashboardTab = async () => {
    if (!state.activeAppId) return;
    const title = window.prompt('New App tab name');
    if (!title?.trim()) return;
    const result = await api.createAppDashboard(state.activeAppId, { title: title.trim() });
    if (result.ok) {
      setAppExperience('analyst');
      if (appDoc) setDashboardDoc({ app: appDoc.app, dashboard: result.dashboard });
      dispatch({ type: 'OPEN_APP', appId: state.activeAppId, dashboardId: result.dashboard.id });
      await refreshApps(state.activeAppId, result.dashboard.id);
      dispatch({ type: 'OPEN_DASHBOARD', dashboardId: result.dashboard.id });
    } else {
      window.alert(result.error);
    }
  };

  const attachNotebook = async () => {
    if (!state.activeAppId) return;
    const path = window.prompt('Project-relative notebook path, for example notebooks/cards_fraud_ops.dqlnb');
    if (!path?.trim()) return;
    const result = await api.attachAppNotebook(state.activeAppId, {
      path: path.trim(),
      role: 'supporting',
      visibility: 'shared',
    });
    if ('ok' in result && result.ok === false) {
      window.alert(result.error);
      return;
    }
    const doc = await api.getApp(state.activeAppId);
    setAppDoc(doc);
    await refreshApps(state.activeAppId, state.activeDashboardId);
    setAppSection('notebooks');
  };

  if (state.appsLoading && state.apps.length === 0) {
    return <EmptyState message="Loading apps..." onCreate={() => setWizardOpen(true)} />;
  }

  if (state.apps.length === 0) {
    return (
      <>
        <EmptyState
          message="Create your first local App."
          hint="Package blocks, dashboards, notebooks, AI pins, and drafts into a single OSS App."
          onCreate={() => setWizardOpen(true)}
        />
        {wizardOpen && <CreateAppWizard onClose={() => setWizardOpen(false)} onCreated={(appId, dashboardId) => void refreshApps(appId, dashboardId)} />}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <aside style={{ width: 292, borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
              Apps Library
            </div>
            <button onClick={() => setWizardOpen(true)} style={primaryButtonStyle}>Create App</button>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search apps, dashboards, notebooks..." style={inputStyle} />
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

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{activeApp?.name ?? '-'}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {activeApp ? domainPath(activeApp) : ''}
              {activeApp?.audience ? ` · audience: ${activeApp.audience}` : ''}
              {activeApp?.visibility ? ` · ${activeApp.visibility}` : ''}
              {activeApp?.lifecycle ? ` · ${activeApp.lifecycle}` : ''}
              {activeApp?.description ? ` · ${activeApp.description}` : ''}
            </div>
            {activeApp?.tags?.length ? (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                {activeApp.tags.slice(0, 6).map((tag) => <Pill key={tag}>{tag}</Pill>)}
              </div>
            ) : null}
          </div>
          <PersonaSwitcher app={appDoc?.app ?? null} />
          <div style={{ display: 'flex', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, overflow: 'hidden' }}>
            <button onClick={() => switchExperience('stakeholder')} style={segmentButtonStyle(appExperience === 'stakeholder')}>Stakeholder</button>
            <button onClick={() => switchExperience('analyst')} style={segmentButtonStyle(appExperience === 'analyst')}>Analyst Studio</button>
          </div>
          {isAnalyst ? (
            <button onClick={() => void createDashboardTab()} disabled={!state.activeAppId} style={ghostButtonStyle}>
              + Add tab
            </button>
          ) : null}
        </header>

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
          <nav style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))', overflowX: 'auto' }}>
            {appDoc.dashboards.map((d) => (
              <button key={d.id} onClick={() => {
                setAppSection('dashboards');
                dispatch({ type: 'OPEN_DASHBOARD', dashboardId: d.id });
              }} style={tabStyle(d.id === state.activeDashboardId)}>
                {d.title}
                {d.itemCount > 0 ? <span style={{ opacity: 0.6, marginLeft: 6 }}>· {d.itemCount}</span> : null}
              </button>
            ))}
          </nav>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
          {loading ? (
            <EmptyState message="Loading dashboard..." />
          ) : appDoc && appSection === 'notebooks' ? (
            <NotebookRefsPanel appDoc={appDoc} editable={isAnalyst} onAttach={() => void attachNotebook()} />
          ) : appDoc && appSection === 'ai' ? (
            <AiSummariesPanel
              appDoc={appDoc}
              editable={isAnalyst}
              onPromoted={async () => {
                if (!state.activeAppId) return;
                setAppDoc(await api.getApp(state.activeAppId));
                await refreshApps(state.activeAppId, state.activeDashboardId);
              }}
            />
          ) : appDoc && isAnalyst && appSection === 'drafts' ? (
            <DraftsPanel drafts={appDoc.drafts ?? []} />
          ) : appDoc && isAnalyst && appSection === 'settings' ? (
            <AppSettingsPanel appDoc={appDoc} />
          ) : dashboardDoc && state.activeAppId ? (
            <DashboardRenderer
              appId={state.activeAppId}
              dashboard={dashboardDoc.dashboard}
              editable={isAnalyst}
              onDashboardChanged={(next) => {
                setDashboardDoc((current) => current ? { ...current, dashboard: next } : current);
                void refreshApps(state.activeAppId ?? undefined, next.id);
              }}
            />
          ) : appDoc && appDoc.dashboards.length === 0 ? (
            <EmptyState message="This App has no dashboards." hint={isAnalyst ? "Add a dashboard tab from Analyst Studio." : "No dashboard tab has been published for this App."} />
          ) : (
            <EmptyState message="Select a dashboard." />
          )}
        </div>
      </main>

      {wizardOpen && <CreateAppWizard onClose={() => setWizardOpen(false)} onCreated={(appId, dashboardId) => void refreshApps(appId, dashboardId)} />}
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
    { id: 'ai', label: 'AI summaries', count: aiCount },
    ...(experience === 'analyst'
      ? [
          { id: 'drafts' as const, label: 'Drafts', count: draftCount },
          { id: 'settings' as const, label: 'Settings' },
        ]
      : []),
  ];
  return (
    <nav style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))', overflowX: 'auto' }}>
      {tabs.map((tab) => (
        <button key={tab.id} onClick={() => onChange(tab.id)} style={tabStyle(section === tab.id)}>
          {tab.label}
          {tab.count !== undefined ? <span style={{ opacity: 0.65, marginLeft: 6 }}>{tab.count}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function NotebookRefsPanel({ appDoc, editable, onAttach }: { appDoc: AppDocumentSummary; editable: boolean; onAttach: () => void }) {
  const notebooks = appDoc.notebooks ?? appDoc.app.notebooks ?? [];
  return (
    <PanelFrame title="Attached Notebooks" action={editable ? <button type="button" onClick={onAttach} style={ghostButtonStyle}>Attach notebook</button> : undefined}>
      {notebooks.length === 0 ? (
        <div style={mutedStyle}>No notebooks are attached to this App yet.</div>
      ) : notebooks.map((notebook) => (
        <InfoRow key={notebook.path} title={notebook.title ?? notebook.path} meta={`${notebook.role} · ${notebook.visibility}`} detail={notebook.path} />
      ))}
    </PanelFrame>
  );
}

function AiSummariesPanel({ appDoc, editable, onPromoted }: { appDoc: AppDocumentSummary; editable: boolean; onPromoted: () => Promise<void> }) {
  const pins = appDoc.aiPins ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const promote = async (pinId: string) => {
    setBusy(pinId);
    const result = await api.promoteAiPin(appDoc.app.id, pinId);
    setBusy(null);
    if (!result.ok) {
      window.alert(result.error ?? 'Promotion failed.');
      return;
    }
    await onPromoted();
  };
  return (
    <PanelFrame title="AI Summaries">
      {pins.length === 0 ? (
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
  const [step, setStep] = useState<WizardStep>(0);
  const [startSource, setStartSource] = useState<AppStartSource>('blank');
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [groups, setGroups] = useState('');
  const [purpose, setPurpose] = useState('');
  const [notebookPath, setNotebookPath] = useState('');
  const [notebookTitle, setNotebookTitle] = useState('');
  const [importSourcePath, setImportSourcePath] = useState('');
  const [audience, setAudience] = useState('executive');
  const [lifecycle, setLifecycle] = useState<'draft' | 'review' | 'certified' | 'deprecated'>('draft');
  const [tags, setTags] = useState('');
  const [owner, setOwner] = useState(`${(window as unknown as { DQL_USER?: string }).DQL_USER ?? 'owner'}@local`);
  const [certifiedOnly, setCertifiedOnly] = useState(true);
  const [recommendations, setRecommendations] = useState<AppBlockRecommendation[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagList = useMemo(() => tags.split(',').map((tag) => tag.trim()).filter(Boolean), [tags]);
  const canContinue = step === 0
    ? Boolean(name.trim() && domain.trim() && (startSource !== 'notebook' || notebookPath.trim()))
    : true;

  useEffect(() => {
    if (step !== 2) return;
    setLoading(true);
    void api.recommendAppBlocks({ domain, tags: tagList, purpose, audience, certifiedOnly })
      .then((blocks) => {
        setRecommendations(blocks);
        setSelected(new Set(blocks.slice(0, 6).map((block) => block.id)));
      })
      .finally(() => setLoading(false));
  }, [step, domain, tagList.join(','), purpose, audience, certifiedOnly]);

  const create = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.createApp({
        name,
        domain,
        subdomain: subdomain.trim() || undefined,
        groups: groups.split(',').map((group) => group.trim()).filter(Boolean),
        purpose,
        audience,
        visibility: 'shared',
        lifecycle,
        tags: unique([...tagList, ...(startSource === 'blank' ? [] : [`source:${startSource}`])]),
        owners: [owner],
        selectedBlockIds: Array.from(selected),
      });
      if (startSource === 'notebook' && notebookPath.trim()) {
        const attachResult = await api.attachAppNotebook(result.app.id, {
          path: notebookPath.trim(),
          title: notebookTitle.trim() || undefined,
          role: 'analysis',
          visibility: 'shared',
        });
        if ('ok' in attachResult && attachResult.ok === false) {
          window.alert(`App created, but notebook attach failed: ${attachResult.error}`);
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
      <div style={modalStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))', padding: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Create App</div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>Package dashboards, notebooks, AI pins, and draft blocks into a local App.</div>
          </div>
          <button onClick={onClose} style={ghostButtonStyle}>Close</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', minHeight: 480 }}>
          <aside style={{ borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))', padding: 12 }}>
            {['App Source', 'Governance', 'Recommended Blocks', 'Starter Dashboard', 'Review & Create'].map((label, index) => (
              <button key={label} onClick={() => setStep(index as WizardStep)} style={wizardStepStyle(index === step)}>
                <span style={{ fontWeight: 700 }}>{index + 1}</span>
                <span>{label}</span>
              </button>
            ))}
          </aside>

          <section style={{ padding: 16, overflow: 'auto' }}>
            {step === 0 && (
              <div style={formGridStyle}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>Start from</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
                    {([
                      ['blank', 'Blank'],
                      ['notebook', 'Notebook'],
                      ['sql', 'SQL import'],
                      ['template', 'Template'],
                    ] as Array<[AppStartSource, string]>).map(([value, label]) => (
                      <button key={value} type="button" onClick={() => setStartSource(value)} style={sourceButtonStyle(startSource === value)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <Field label="App name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Growth CXO" style={inputStyle} /></Field>
                <Field label="Domain"><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="growth" style={inputStyle} /></Field>
                <Field label="Subdomain"><input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="fraud, merchant-risk, deposits" style={inputStyle} /></Field>
                <Field label="Group / use case"><input value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="daily-ops, executive-review" style={inputStyle} /></Field>
                {startSource === 'notebook' ? (
                  <>
                    <Field label="Notebook path"><input value={notebookPath} onChange={(e) => setNotebookPath(e.target.value)} placeholder="notebooks/cards_fraud_ops.dqlnb" style={inputStyle} /></Field>
                    <Field label="Notebook title"><input value={notebookTitle} onChange={(e) => setNotebookTitle(e.target.value)} placeholder="Fraud investigation notebook" style={inputStyle} /></Field>
                  </>
                ) : null}
                {startSource === 'sql' ? (
                  <Field label="SQL source"><input value={importSourcePath} onChange={(e) => setImportSourcePath(e.target.value)} placeholder="imports/cards/fraud.sql" style={inputStyle} /></Field>
                ) : null}
                <Field label="Business purpose"><textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Top-line KPIs and operating dashboard for the growth team." style={{ ...inputStyle, minHeight: 86, resize: 'vertical' }} /></Field>
                <Field label="Audience"><input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="executive, ops, analyst" style={inputStyle} /></Field>
                <Field label="Lifecycle">
                  <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as typeof lifecycle)} style={inputStyle}>
                    <option value="draft">draft</option>
                    <option value="review">review</option>
                    <option value="certified">certified</option>
                    <option value="deprecated">deprecated</option>
                  </select>
                </Field>
                <Field label="Tags"><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="cxo, weekly, revenue" style={inputStyle} /></Field>
                <Field label="Owner"><input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="owner@local" style={inputStyle} /></Field>
              </div>
            )}

            {step === 1 && (
              <div style={{ display: 'grid', gap: 12 }}>
                <InfoCard title="Single-user OSS governance" text="The wizard scaffolds owner, analyst, and viewer roles in dql.app.json. Persona switching previews real policy/RLS enforcement without adding login, SSO, or multi-tenant auth." />
                <RoleGrid />
              </div>
            )}

            {step === 2 && (
              <div style={{ display: 'grid', gap: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <input type="checkbox" checked={certifiedOnly} onChange={(e) => setCertifiedOnly(e.target.checked)} />
                  Certified blocks only
                </label>
                {loading ? <div style={mutedStyle}>Finding matching blocks...</div> : recommendations.length === 0 ? (
                  <div style={mutedStyle}>No matching blocks found. The App can still be created with an empty dashboard.</div>
                ) : recommendations.map((block) => (
                  <BlockRecommendationRow
                    key={block.id}
                    block={block}
                    selected={selected.has(block.id)}
                    onToggle={() => setSelected((current) => toggleSet(current, block.id))}
                  />
                ))}
              </div>
            )}

            {step === 3 && (
              <div style={{ display: 'grid', gap: 12 }}>
                <InfoCard title="Generated dashboard" text="The wizard will create dashboards/overview.dqld and place approved blocks into a responsive grid. Certified shared blocks stay under root blocks/." />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 8 }}>
                  {recommendations.filter((block) => selected.has(block.id)).map((block) => (
                    <div key={block.id} style={{ gridColumn: block.chartType === 'single_value' || block.chartType === 'kpi' ? 'span 3' : 'span 6', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, padding: 10, minHeight: 80 }}>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{block.name}</div>
                      <div style={{ fontSize: 11, opacity: 0.65 }}>{block.chartType ?? 'table'} · {block.status}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {step === 4 && (
              <div style={{ display: 'grid', gap: 12 }}>
                <InfoCard title="Files to create" text={`apps/${slugify(name) || '<app-id>'}/dql.app.json, README.md, dashboards/overview.dqld, notebooks/, and drafts/.`} />
                <ReviewTable
                  source={startSource}
                  notebookPath={notebookPath}
                  importSourcePath={importSourcePath}
                  name={name}
                  domain={domain}
                  subdomain={subdomain}
                  groups={groups}
                  audience={audience}
                  lifecycle={lifecycle}
                  owner={owner}
                  tags={unique([...tagList, ...(startSource === 'blank' ? [] : [`source:${startSource}`])])}
                  selectedCount={selected.size}
                />
                {error && <div style={{ color: '#f85149', fontSize: 12 }}>{error}</div>}
              </div>
            )}
          </section>
        </div>

        <footer style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: 16, borderTop: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
          <button onClick={() => setStep((current) => Math.max(0, current - 1) as WizardStep)} disabled={step === 0} style={ghostButtonStyle}>Back</button>
          {step < 4 ? (
            <button onClick={() => setStep((current) => Math.min(4, current + 1) as WizardStep)} disabled={!canContinue} style={primaryButtonStyle}>Next</button>
          ) : (
            <button onClick={create} disabled={loading || !name.trim() || !domain.trim()} style={primaryButtonStyle}>{loading ? 'Creating...' : 'Create App'}</button>
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
    <button onClick={onToggle} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 10, alignItems: 'start', textAlign: 'left', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', background: selected ? 'rgba(79,70,229,0.10)' : 'transparent', borderRadius: 6, padding: 10, color: 'inherit' }}>
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
    ...(source === 'sql' ? [['SQL source', importSourcePath || '-']] : []),
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

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function sourceLabel(source: AppStartSource): string {
  switch (source) {
    case 'notebook':
      return 'Notebook';
    case 'sql':
      return 'SQL import';
    case 'template':
      return 'Template';
    default:
      return 'Blank';
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
  color: '#fff',
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
    background: active ? 'rgba(79,70,229,0.12)' : 'transparent',
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
    color: active ? '#fff' : 'inherit',
    border: '1px solid var(--border-color, rgba(0,0,0,0.1))',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  };
}

function segmentButtonStyle(active: boolean): CSSProperties {
  return {
    border: 'none',
    borderRight: '1px solid var(--border-color, rgba(0,0,0,0.10))',
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? '#fff' : 'inherit',
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
    color: active ? '#fff' : 'inherit',
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
    color: active ? '#fff' : 'inherit',
    padding: '7px 8px',
    fontSize: 12,
    fontWeight: active ? 700 : 600,
    cursor: 'pointer',
  };
}
