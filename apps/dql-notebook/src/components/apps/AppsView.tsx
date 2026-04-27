import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
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

export function AppsView(): JSX.Element {
  const { state, dispatch } = useNotebook();
  const [appDoc, setAppDoc] = useState<AppDocumentSummary | null>(null);
  const [dashboardDoc, setDashboardDoc] = useState<DashboardDocumentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [audienceFilter, setAudienceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

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
    tags: unique(state.apps.flatMap((app) => app.tags ?? []).filter((tag) => !tag.startsWith('audience:'))),
    owners: unique(state.apps.flatMap((app) => app.owners ?? [])),
    audiences: unique(state.apps.map((app) => app.audience).filter(Boolean) as string[]),
  }), [state.apps]);

  const filteredApps = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return state.apps.filter((app) => {
      if (needle) {
        const haystack = [app.name, app.description ?? '', app.domain, ...(app.tags ?? []), ...(app.owners ?? [])].join(' ').toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (domainFilter && app.domain !== domainFilter) return false;
      if (tagFilter && !(app.tags ?? []).includes(tagFilter)) return false;
      if (ownerFilter && !(app.owners ?? []).includes(ownerFilter)) return false;
      if (audienceFilter && app.audience !== audienceFilter) return false;
      if (statusFilter && app.status !== statusFilter) return false;
      return true;
    });
  }, [state.apps, search, domainFilter, tagFilter, ownerFilter, audienceFilter, statusFilter]);

  const activeApp = useMemo(
    () => state.apps.find((a) => a.id === state.activeAppId) ?? null,
    [state.apps, state.activeAppId],
  );

  if (state.appsLoading && state.apps.length === 0) {
    return <EmptyState message="Loading apps..." onCreate={() => setWizardOpen(true)} />;
  }

  if (state.apps.length === 0) {
    return (
      <>
        <EmptyState
          message="Create your first governed App."
          hint="Package certified blocks into a business dashboard with local persona preview."
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
              Apps Command Center
            </div>
            <button onClick={() => setWizardOpen(true)} style={primaryButtonStyle}>Create App</button>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search apps, tags, owners..." style={inputStyle} />
            <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={inputStyle}>
              <option value="">All domains</option>
              {facets.domains.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} style={inputStyle}>
              <option value="">All tags</option>
              {facets.tags.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} style={inputStyle}>
              <option value="">All owners</option>
              {facets.owners.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <select value={audienceFilter} onChange={(e) => setAudienceFilter(e.target.value)} style={inputStyle}>
                <option value="">Audience</option>
                {facets.audiences.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
                <option value="">Status</option>
                <option value="ready">ready</option>
                <option value="empty">empty</option>
              </select>
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
              onClick={() => dispatch({ type: 'OPEN_APP', appId: a.id })}
            />
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{activeApp?.name ?? '-'}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {activeApp?.domain ? `domain: ${activeApp.domain}` : ''}
              {activeApp?.audience ? ` · audience: ${activeApp.audience}` : ''}
              {activeApp?.description ? ` · ${activeApp.description}` : ''}
            </div>
          </div>
          <PersonaSwitcher app={appDoc?.app ?? null} />
        </header>

        {appDoc && appDoc.dashboards.length > 0 && (
          <nav style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))', overflowX: 'auto' }}>
            {appDoc.dashboards.map((d) => (
              <button key={d.id} onClick={() => dispatch({ type: 'OPEN_DASHBOARD', dashboardId: d.id })} style={tabStyle(d.id === state.activeDashboardId)}>
                {d.title}
                {d.itemCount > 0 ? <span style={{ opacity: 0.6, marginLeft: 6 }}>· {d.itemCount}</span> : null}
              </button>
            ))}
          </nav>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
          {loading ? (
            <EmptyState message="Loading dashboard..." />
          ) : dashboardDoc && state.activeAppId ? (
            <DashboardRenderer appId={state.activeAppId} dashboard={dashboardDoc.dashboard} />
          ) : appDoc && appDoc.dashboards.length === 0 ? (
            <EmptyState message="This App has no dashboards." hint="Create a dashboard from selected certified blocks." onCreate={() => setWizardOpen(true)} />
          ) : (
            <EmptyState message="Select a dashboard." />
          )}
        </div>
      </main>

      {wizardOpen && <CreateAppWizard onClose={() => setWizardOpen(false)} onCreated={(appId, dashboardId) => void refreshApps(appId, dashboardId)} />}
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
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [purpose, setPurpose] = useState('');
  const [audience, setAudience] = useState('executive');
  const [tags, setTags] = useState('');
  const [owner, setOwner] = useState(`${(window as unknown as { DQL_USER?: string }).DQL_USER ?? 'owner'}@local`);
  const [certifiedOnly, setCertifiedOnly] = useState(true);
  const [recommendations, setRecommendations] = useState<AppBlockRecommendation[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagList = useMemo(() => tags.split(',').map((tag) => tag.trim()).filter(Boolean), [tags]);
  const canContinue = step === 0 ? Boolean(name.trim() && domain.trim()) : true;

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
        purpose,
        audience,
        tags: tagList,
        owners: [owner],
        selectedBlockIds: Array.from(selected),
      });
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
            <div style={{ fontSize: 12, opacity: 0.65 }}>Package certified blocks into a governed domain App.</div>
          </div>
          <button onClick={onClose} style={ghostButtonStyle}>Close</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', minHeight: 480 }}>
          <aside style={{ borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))', padding: 12 }}>
            {['Business Context', 'Governance', 'Recommended Blocks', 'Starter Dashboard', 'Review & Create'].map((label, index) => (
              <button key={label} onClick={() => setStep(index as WizardStep)} style={wizardStepStyle(index === step)}>
                <span style={{ fontWeight: 700 }}>{index + 1}</span>
                <span>{label}</span>
              </button>
            ))}
          </aside>

          <section style={{ padding: 16, overflow: 'auto' }}>
            {step === 0 && (
              <div style={formGridStyle}>
                <Field label="App name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Growth CXO" style={inputStyle} /></Field>
                <Field label="Domain"><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="growth" style={inputStyle} /></Field>
                <Field label="Business purpose"><textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Top-line KPIs and operating dashboard for the growth team." style={{ ...inputStyle, minHeight: 86, resize: 'vertical' }} /></Field>
                <Field label="Audience"><input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="executive, ops, analyst" style={inputStyle} /></Field>
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
                <ReviewTable name={name} domain={domain} audience={audience} owner={owner} tags={tagList} selectedCount={selected.size} />
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
        <span style={{ fontSize: 10, opacity: 0.65 }}>{app.status ?? 'ready'}</span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 3 }}>
        {app.domain} · {app.dashboards.length} dashboard{app.dashboards.length === 1 ? '' : 's'}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
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

function ReviewTable({ name, domain, audience, owner, tags, selectedCount }: { name: string; domain: string; audience: string; owner: string; tags: string[]; selectedCount: number }): JSX.Element {
  const rows = [
    ['Name', name || '-'],
    ['Domain', domain || '-'],
    ['Audience', audience || '-'],
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

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
