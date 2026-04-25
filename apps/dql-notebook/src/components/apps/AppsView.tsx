import { useEffect, useMemo, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { api, type AppDocumentSummary, type DashboardDocumentResponse } from '../../api/client';
import type { AppSummary } from '../../store/types';
import { PersonaSwitcher } from './PersonaSwitcher';
import { DashboardRenderer } from './DashboardRenderer';

/**
 * Apps consumption surface — list of Apps with the open App's dashboards.
 *
 * Stakeholders see this when `mainView === 'apps'`. Layout:
 *   left:  list of Apps
 *   right: open App's dashboard (rendered via DashboardRenderer) + persona switcher
 */
export function AppsView(): JSX.Element {
  const { state, dispatch } = useNotebook();
  const [appDoc, setAppDoc] = useState<AppDocumentSummary | null>(null);
  const [dashboardDoc, setDashboardDoc] = useState<DashboardDocumentResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Load apps list once
  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    void api.listApps().then((apps) => {
      if (cancelled) return;
      dispatch({ type: 'SET_APPS', apps });
      dispatch({ type: 'SET_APPS_LOADING', loading: false });
      if (apps.length > 0 && !state.activeAppId) {
        dispatch({ type: 'OPEN_APP', appId: apps[0].id });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load active App + Dashboard
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
    return () => {
      cancelled = true;
    };
  }, [state.activeAppId, state.activeDashboardId]);

  // Restore active persona from server on first render
  useEffect(() => {
    void api.getPersona().then((persona) => {
      dispatch({ type: 'SET_ACTIVE_PERSONA', persona });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeApp = useMemo(
    () => state.apps.find((a) => a.id === state.activeAppId) ?? null,
    [state.apps, state.activeAppId],
  );

  if (state.appsLoading && state.apps.length === 0) {
    return <EmptyState message="Loading apps…" />;
  }

  if (state.apps.length === 0) {
    return (
      <EmptyState
        message="No apps yet."
        hint='Create one with: dql app new <id> --domain <domain>'
      />
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Left: app list */}
      <aside
        style={{
          width: 240,
          borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          padding: '12px 0',
          overflowY: 'auto',
        }}
      >
        <div style={{ padding: '0 16px 8px', fontSize: 11, fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Apps
        </div>
        {state.apps.map((a) => (
          <AppListItem
            key={a.id}
            app={a}
            active={a.id === state.activeAppId}
            onClick={() => dispatch({ type: 'OPEN_APP', appId: a.id })}
          />
        ))}
      </aside>

      {/* Right: open App */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{activeApp?.name ?? '—'}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {activeApp?.domain ? `domain: ${activeApp.domain}` : ''}
              {activeApp?.description ? ` · ${activeApp.description}` : ''}
            </div>
          </div>
          <PersonaSwitcher app={appDoc?.app ?? null} />
        </header>

        {/* Dashboard tabs */}
        {appDoc && appDoc.dashboards.length > 0 && (
          <nav
            style={{
              display: 'flex',
              gap: 4,
              padding: '8px 16px',
              borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))',
              overflowX: 'auto',
            }}
          >
            {appDoc.dashboards.map((d) => (
              <button
                key={d.id}
                onClick={() => dispatch({ type: 'OPEN_DASHBOARD', dashboardId: d.id })}
                style={{
                  padding: '6px 12px',
                  background: d.id === state.activeDashboardId ? 'var(--accent, #4f46e5)' : 'transparent',
                  color: d.id === state.activeDashboardId ? '#fff' : 'inherit',
                  border: '1px solid var(--border-color, rgba(0,0,0,0.1))',
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {d.title}
                {d.itemCount > 0 ? <span style={{ opacity: 0.6, marginLeft: 6 }}>· {d.itemCount}</span> : null}
              </button>
            ))}
          </nav>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
          {loading ? (
            <EmptyState message="Loading dashboard…" />
          ) : dashboardDoc ? (
            <DashboardRenderer dashboard={dashboardDoc.dashboard} />
          ) : appDoc && appDoc.dashboards.length === 0 ? (
            <EmptyState
              message="This App has no dashboards."
              hint={`Add one at apps/${activeApp?.id}/dashboards/<id>.dqld`}
            />
          ) : (
            <EmptyState message="Select a dashboard." />
          )}
        </div>
      </main>
    </div>
  );
}

function AppListItem({
  app,
  active,
  onClick,
}: {
  app: AppSummary;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 16px',
        background: active ? 'var(--surface-hover, rgba(0,0,0,0.06))' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: 'inherit',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: active ? 600 : 500 }}>{app.name}</div>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>
        {app.domain} · {app.dashboards.length} dashboard{app.dashboards.length === 1 ? '' : 's'}
      </div>
    </button>
  );
}

function EmptyState({ message, hint }: { message: string; hint?: string }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 8,
        opacity: 0.7,
        fontSize: 14,
      }}
    >
      <div>{message}</div>
      {hint ? <div style={{ fontSize: 12, fontFamily: 'monospace', opacity: 0.7 }}>{hint}</div> : null}
    </div>
  );
}
