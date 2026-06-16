import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { AppSummary } from '../../store/types';
import { TrustBadge, type TrustState } from '@duckcodeailabs/dql-ui';

export function ReviewPage(): JSX.Element {
  const { state, dispatch } = useNotebook();

  useEffect(() => {
    let cancelled = false;
    if (state.apps.length > 0) return;
    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    void api.listApps().then((apps) => {
      if (cancelled) return;
      dispatch({ type: 'SET_APPS', apps });
      dispatch({ type: 'SET_APPS_LOADING', loading: false });
    });
    return () => { cancelled = true; };
  }, [dispatch, state.apps.length]);

  const reviewItems = useMemo(() => {
    return state.apps
      .filter((app) => app.lifecycle === 'review' || (app.drafts?.length ?? 0) > 0 || (app.aiPins ?? 0) > 0)
      .sort((a, b) => reviewWeight(b) - reviewWeight(a) || a.name.localeCompare(b.name));
  }, [state.apps]);

  return (
    <div style={{ padding: 20, display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <ReviewStat label="Apps in review" value={state.apps.filter((app) => app.lifecycle === 'review').length} tone="review" />
        <ReviewStat label="Draft blocks" value={state.apps.reduce((sum, app) => sum + (app.drafts?.length ?? 0), 0)} tone="draft" />
        <ReviewStat label="AI pins" value={state.apps.reduce((sum, app) => sum + (app.aiPins ?? 0), 0)} tone="ai_generated" />
        <ReviewStat label="Certified Apps" value={state.apps.filter((app) => app.lifecycle === 'certified').length} tone="certified" />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {state.appsLoading && state.apps.length === 0 ? (
          <div style={emptyStyle}>Loading review queue...</div>
        ) : reviewItems.length === 0 ? (
          <div style={emptyStyle}>No Apps or drafts are waiting for review.</div>
        ) : reviewItems.map((app) => (
          <ReviewAppRow
            key={app.id}
            app={app}
            onOpen={() => dispatch({ type: 'OPEN_APP', appId: app.id })}
          />
        ))}
      </div>
    </div>
  );
}

function ReviewAppRow({ app, onOpen }: { app: AppSummary; onOpen: () => void }) {
  const trustState = app.certification === 'certified' ? 'certified' : app.lifecycle === 'review' ? 'review' : 'draft';
  const draftCount = app.drafts?.length ?? 0;
  const aiCount = app.aiPins ?? 0;
  return (
    <button type="button" onClick={onOpen} style={{ ...rowStyle, borderLeftColor: trustAccent(trustState), borderLeftWidth: 3 }}>
      <div style={{ display: 'grid', gap: 5, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 750 }}>{app.name}</span>
          <TrustBadge state={trustState} />
          <Pill>{app.visibility ?? app.storage ?? 'shared'}</Pill>
        </div>
        <div style={{ fontSize: 12, opacity: 0.68 }}>
          {[app.domain, app.subdomain, ...(app.groups ?? [])].filter(Boolean).join(' / ')}
          {app.audience ? ` · ${app.audience}` : ''}
        </div>
        {(draftCount > 0 || aiCount > 0) && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, opacity: 0.72 }}>
            {draftCount > 0 ? <span>{draftCount} draft{draftCount === 1 ? '' : 's'} need review</span> : null}
            {aiCount > 0 ? <span>{aiCount} AI pin{aiCount === 1 ? '' : 's'} need promotion</span> : null}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Metric label="dashboards" value={app.dashboards.length} />
        <Metric label="notebooks" value={app.notebooks?.length ?? 0} />
        <Metric label="drafts" value={app.drafts?.length ?? 0} />
        <Metric label="AI pins" value={app.aiPins ?? 0} />
      </div>
    </button>
  );
}

function ReviewStat({ label, value, tone }: { label: string; value: number; tone: TrustState }) {
  return (
    <div style={{ ...statStyle, borderTop: `2px solid ${trustAccent(tone)}` }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span style={{ fontSize: 11, opacity: 0.72 }}>
      <strong style={{ fontSize: 13, opacity: 1 }}>{value}</strong> {label}
    </span>
  );
}

function Pill({ children }: { children: string }) {
  return <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'var(--surface-hover, rgba(0,0,0,0.06))', opacity: 0.82 }}>{children}</span>;
}

function reviewWeight(app: AppSummary): number {
  return (app.lifecycle === 'review' ? 100 : 0) + (app.drafts?.length ?? 0) * 10 + (app.aiPins ?? 0);
}

function trustAccent(state: TrustState): string {
  if (state === 'certified') return 'var(--status-success, #1f883d)';
  if (state === 'no_answer') return 'var(--status-error, #cf222e)';
  if (state === 'deprecated') return 'var(--text-tertiary, #8a8d96)';
  return 'var(--status-warning, #9a6700)';
}

const rowStyle: CSSProperties = {
  width: '100%',
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: 12,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 12,
  textAlign: 'left',
  cursor: 'pointer',
};

const statStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
};

const emptyStyle: CSSProperties = {
  border: '1px dashed var(--border-color, rgba(0,0,0,0.16))',
  borderRadius: 8,
  padding: 24,
  fontSize: 13,
  opacity: 0.7,
};
