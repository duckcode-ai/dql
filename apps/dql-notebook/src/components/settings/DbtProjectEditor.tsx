import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  api,
  type DbtOnboardingJob,
  type DbtOnboardingPreviewResponse,
  type DbtOnboardingStatusResponse,
  type SemanticRuntimeSettingsResponse,
} from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { dbtPreparationFromResponse } from './dbt-preparation-model';

function looksLikeGitRepository(value: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/i.test(value.trim());
}

function sourcePayload(source: string) {
  const value = source.trim();
  if (!value) return {};
  return looksLikeGitRepository(value) ? { repoUrl: value } : { projectDir: value };
}

export type DbtProjectConfigured = {
  name: string;
  path: string;
  summary: string;
  readiness: 'preparing' | 'ready';
  readinessDetail?: string;
};

export function DbtProjectEditor({
  compact = false,
  onConfigured,
}: {
  compact?: boolean;
  onConfigured?: (project: DbtProjectConfigured) => void;
}) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [status, setStatus] = useState<DbtOnboardingStatusResponse | null>(null);
  const [projectReady, setProjectReady] = useState(false);
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<DbtOnboardingPreviewResponse | null>(null);
  const [preparation, setPreparation] = useState<DbtOnboardingJob | null>(null);
  const [busy, setBusy] = useState<'loading' | 'preview' | 'apply' | 'refresh' | null>('loading');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [semanticRuntime, setSemanticRuntime] = useState<SemanticRuntimeSettingsResponse | null>(null);
  const [semanticHost, setSemanticHost] = useState('');
  const [semanticEnvironmentId, setSemanticEnvironmentId] = useState('');
  const [semanticToken, setSemanticToken] = useState('');
  const [semanticBusy, setSemanticBusy] = useState<'test' | 'apply' | null>(null);
  const [semanticMessage, setSemanticMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadSemanticRuntime = useCallback(async () => {
    const runtime = await api.getSemanticRuntimeSettings();
    setSemanticRuntime(runtime);
    setSemanticHost(runtime.dbtCloud.host ?? '');
    setSemanticEnvironmentId(runtime.dbtCloud.environmentId ?? '');
    setSemanticToken('');
    return runtime;
  }, []);

  const loadStatus = useCallback(async () => {
    const [next, dbt] = await Promise.all([
      api.getOnboardingStatus(),
      api.getBlockStudioDbtStatus().catch(() => null),
    ]);
    setStatus(next);
    setPreparation(next.preparation ?? null);
    const configured = next.dbt?.configured === true || Boolean(dbt?.configured && dbt.artifacts.manifest.exists);
    setProjectReady(configured);
    const configuredSource = next.dbt?.repoUrl || next.dbt?.projectDir || dbt?.projectPath || '';
    setSource(configured ? configuredSource : '');
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    void loadStatus()
      .catch((error) => alive && setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) }))
      .finally(() => alive && setBusy(null));
    return () => { alive = false; };
  }, [loadStatus]);

  useEffect(() => {
    let alive = true;
    void loadSemanticRuntime().catch((error) => {
      if (alive) setSemanticMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    });
    return () => { alive = false; };
  }, [loadSemanticRuntime]);

  useEffect(() => {
    if (!preparation || (preparation.status !== 'queued' && preparation.status !== 'running')) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await api.getOnboardingJob(preparation.id);
        if (!alive) return;
        const next = dbtPreparationFromResponse(response);
        if (!next) return;
        setPreparation(next);
        if (next.status === 'completed') {
          await loadStatus();
          if (alive) setMessage({ ok: true, text: next.message || 'dbt metadata and governed search indexes are ready.' });
        } else if (next.status === 'failed' || next.status === 'cancelled') {
          setMessage({ ok: false, text: next.error || next.message || `dbt preparation ${next.status}.` });
        } else {
          timer = window.setTimeout(() => void poll(), 650);
        }
      } catch (error) {
        if (alive) setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
      }
    };
    timer = window.setTimeout(() => void poll(), 350);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadStatus, preparation?.id, preparation?.status]);

  const inspect = async () => {
    setBusy('preview');
    setMessage(null);
    try {
      const next = await api.previewDbtOnboarding(sourcePayload(source));
      setPreview(next);
      setMessage({
        ok: true,
        text: `Preview ready: ${next.counts.models ?? 0} models, ${next.counts.sources ?? 0} sources, ${next.counts.metrics ?? 0} metrics. Nothing has changed yet.`,
      });
    } catch (error) {
      setPreview(null);
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy('apply');
    setMessage(null);
    try {
      const applied = await api.applyDbtOnboarding({
        ...(preview.repoUrl
          ? { repoUrl: preview.repoUrl, branch: preview.branch, subPath: preview.subPath }
          : { projectDir: preview.projectDir }),
        manifestPath: preview.manifestPath,
        profilesDir: preview.profilesDir,
        expectedFingerprint: preview.fingerprint,
      });
      const nextPreparation = dbtPreparationFromResponse(applied);
      if (nextPreparation) setPreparation(nextPreparation);
      const nextStatus = await loadStatus();
      const observedPreparation = nextStatus.preparation ?? nextPreparation;
      const summary = `${preview.counts.models ?? 0} models · ${preview.counts.sources ?? 0} sources · ${preview.counts.metrics ?? 0} metrics`;
      setMessage({
        ok: true,
        text: observedPreparation?.status === 'completed'
          ? observedPreparation.message || `Connected ${preview.projectName || preview.projectDir}. Governed search is ready.`
          : observedPreparation
          ? `Connected ${preview.projectName || preview.projectDir}. DQL is preparing ${summary} for fast governed search in the background.`
          : `Applied ${preview.projectName || preview.projectDir}. ${summary}.`,
      });
      onConfigured?.({
        name: preview.projectName || 'dbt project',
        path: preview.projectDir,
        summary,
        readiness: observedPreparation?.status === 'completed' ? 'ready' : 'preparing',
        readinessDetail: observedPreparation?.message,
      });
      setPreview(null);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    setMessage(null);
    try {
      const current = await api.previewDbtOnboarding({});
      const refreshed = await api.refreshDbtOnboarding({ expectedFingerprint: current.fingerprint });
      const nextPreparation = dbtPreparationFromResponse(refreshed);
      if (nextPreparation) setPreparation(nextPreparation);
      const nextStatus = await loadStatus();
      const observedPreparation = nextStatus.preparation ?? nextPreparation;
      setMessage({
        ok: true,
        text: observedPreparation?.status === 'completed'
          ? observedPreparation.message || 'dbt artifacts and governed search indexes are ready.'
          : observedPreparation
            ? 'dbt artifacts refreshed. Governed search indexes are updating in the background.'
            : 'dbt artifacts refreshed from the configured project.',
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const semanticPayload = () => ({
    preference: 'auto' as const,
    dbtCloud: {
      host: semanticHost,
      environmentId: semanticEnvironmentId,
      serviceToken: semanticToken,
    },
  });

  const testSemanticRuntime = async () => {
    setSemanticBusy('test');
    setSemanticMessage(null);
    try {
      const result = await api.testDbtCloudSemanticRuntime(semanticPayload());
      setSemanticMessage({ ok: result.ok, text: result.message || result.error || 'dbt Cloud Semantic Layer test failed.' });
    } finally {
      setSemanticBusy(null);
    }
  };

  const applySemanticRuntime = async () => {
    setSemanticBusy('apply');
    setSemanticMessage(null);
    try {
      const result = await api.applyDbtCloudSemanticRuntime(semanticPayload());
      setSemanticRuntime(result);
      setSemanticToken('');
      setSemanticMessage({ ok: true, text: result.dbtCloud.testMessage || 'dbt Cloud Semantic Layer tested and activated.' });
    } catch (error) {
      setSemanticMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSemanticBusy(null);
    }
  };

  const configured = projectReady;
  const preparing = preparation?.status === 'queued' || preparation?.status === 'running';
  const preparationFailed = preparation?.status === 'failed' || preparation?.status === 'cancelled';
  const projectStatusTitle = preparationFailed
    ? 'dbt project needs attention'
    : preparing
      ? 'Preparing governed search'
      : configured
        ? 'dbt project ready'
        : 'dbt project missing';
  const projectStatusDetail = preparation?.message
    ?? (configured ? status?.dbt?.repoUrl || status?.dbt?.projectDir || 'Configured dbt project.' : 'Choose a local path or Git repository.');
  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', height: 36, borderRadius: 8,
    border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.textPrimary,
    padding: '0 11px', fontFamily: t.fontMono, fontSize: 12, outline: 'none',
  };
  const secondary: React.CSSProperties = {
    height: 32, padding: '0 13px', borderRadius: 8, border: `1px solid ${t.headerBorder}`,
    background: t.cellBg, color: t.textSecondary, fontFamily: t.font, fontSize: 12,
    fontWeight: 650, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
  };

  return (
    <div style={{ width: 'min(680px, 100%)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!compact ? (
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, color: t.textPrimary }}>Project &amp; dbt</div>
          <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5 }}>
            Preview a local project or Git repository before DQL replaces the active dbt configuration.
          </div>
        </div>
      ) : null}

      <div style={{ border: `1px solid ${preparationFailed ? 'var(--status-error-border)' : preparing ? 'var(--status-info-border)' : configured ? 'var(--status-success-border)' : 'var(--border-subtle)'}`, borderRadius: 12, background: t.cellBg, padding: '14px 16px', display: 'flex', gap: 11, alignItems: 'center' }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: preparationFailed ? 'var(--status-error)' : preparing ? 'var(--status-info)' : configured ? 'var(--status-success)' : 'var(--status-warning)', background: preparationFailed ? 'var(--status-error-bg)' : preparing ? 'var(--status-info-bg)' : configured ? 'var(--status-success-bg)' : 'var(--status-warning-bg)' }}>
          {preparationFailed ? <AlertCircle size={17} /> : preparing ? <LoaderCircle className="dql-dbt-preparing-icon" size={17} /> : configured ? <CheckCircle2 size={17} /> : <GitBranch size={17} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>{projectStatusTitle}</div>
          <div style={{ fontSize: 11.5, color: preparationFailed ? 'var(--status-error)' : t.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {projectStatusDetail}
          </div>
          {preparing ? <div aria-label="dbt preparation progress" style={{ width: 'min(360px, 100%)', height: 3, borderRadius: 999, background: 'var(--border-subtle)', marginTop: 7, overflow: 'hidden' }}><span style={{ display: 'block', width: `${Math.max(8, preparation?.progress ?? 8)}%`, height: '100%', borderRadius: 999, background: t.accent, transition: 'width 180ms ease' }} /></div> : null}
        </div>
        {configured ? <button type="button" onClick={() => void refresh()} disabled={Boolean(busy)} style={secondary}><RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 6 }} />{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button> : null}
      </div>

      <style>{`@keyframes dql-dbt-preparing-spin { to { transform: rotate(360deg); } } .dql-dbt-preparing-icon { animation: dql-dbt-preparing-spin 1s linear infinite; } @media (prefers-reduced-motion: reduce) { .dql-dbt-preparing-icon { animation: none; } }`}</style>

      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: 16, display: 'grid', gap: 10 }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 650, color: t.textSecondary }}>Local dbt project path or Git repository URL</span>
          <input value={source} onChange={(event) => { setSource(event.target.value); setPreview(null); }} placeholder=". or https://github.com/org/analytics.git" style={input} />
        </label>
        {preview ? (
          <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: '10px 11px', color: t.textSecondary, fontSize: 11.5, lineHeight: 1.5 }}>
            <strong style={{ color: t.textPrimary }}>{preview.projectName || preview.projectDir}</strong><br />
            {preview.counts.models ?? 0} models · {preview.counts.sources ?? 0} sources · {preview.counts.metrics ?? 0} metrics<br />
            <span style={{ fontFamily: t.fontMono }}>{preview.manifestPath}</span>
          </div>
        ) : null}
        {message ? <div role={message.ok ? 'status' : 'alert'} style={{ fontSize: 11.5, lineHeight: 1.5, color: message.ok ? 'var(--status-success)' : 'var(--status-error)' }}>{message.text}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={() => void inspect()} disabled={Boolean(busy)} style={secondary}>{busy === 'preview' ? 'Inspecting…' : 'Preview'}</button>
          {preview ? <button type="button" onClick={() => void apply()} disabled={Boolean(busy)} style={{ ...secondary, border: 'none', background: t.accent, color: '#fff' }}>{busy === 'apply' ? 'Applying…' : 'Apply project'}</button> : null}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: 16, display: 'grid', gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>Semantic execution adapters</div>
          <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5 }}>
            Adapter code is included with DQL. Auto uses dbt Cloud when tested, then local MetricFlow, and safely falls back to the native compiler for simple metrics.
          </div>
        </div>

        <div style={{ display: 'grid', gap: 7 }}>
          {(semanticRuntime?.runtime.adapters ?? []).map((adapter) => (
            <div key={adapter.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, border: '1px solid var(--border-subtle)', borderRadius: 9, padding: '9px 10px' }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, marginTop: 4, background: adapter.ready ? 'var(--status-success)' : adapter.configured ? 'var(--status-warning)' : 'var(--text-muted)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: t.textPrimary }}>{adapter.label}</span>
                  {semanticRuntime?.runtime.active === adapter.id ? <span style={{ fontSize: 9, fontWeight: 700, color: t.accent }}>ACTIVE</span> : null}
                </div>
                <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 2, lineHeight: 1.4 }}>{adapter.detail}</div>
              </div>
              <span style={{ fontSize: 9.5, color: adapter.ready ? 'var(--status-success)' : t.textMuted }}>{adapter.ready ? 'Ready' : adapter.configured ? 'Configured' : 'Available'}</span>
            </div>
          ))}
        </div>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: t.textSecondary }}>dbt Cloud Semantic Layer</summary>
          <div style={{ display: 'grid', gap: 9, marginTop: 11 }}>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 650, color: t.textSecondary }}>Host</span>
              <input value={semanticHost} onChange={(event) => setSemanticHost(event.target.value)} placeholder="semantic-layer.cloud.getdbt.com" style={input} />
            </label>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 650, color: t.textSecondary }}>Environment ID</span>
              <input value={semanticEnvironmentId} onChange={(event) => setSemanticEnvironmentId(event.target.value)} placeholder="123456" style={input} />
            </label>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 650, color: t.textSecondary }}>Service token</span>
              <input type="password" value={semanticToken} onChange={(event) => setSemanticToken(event.target.value)} placeholder={semanticRuntime?.dbtCloud.serviceTokenPreview || 'Semantic Layer service token'} autoComplete="off" style={input} />
              <span style={{ fontSize: 9.5, color: t.textMuted }}>Requires Semantic Layer and Metadata permissions. Leave blank to preserve the stored token.</span>
            </label>
            {semanticMessage ? <div role={semanticMessage.ok ? 'status' : 'alert'} style={{ fontSize: 11, color: semanticMessage.ok ? 'var(--status-success)' : 'var(--status-error)' }}>{semanticMessage.text}</div> : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => void testSemanticRuntime()} disabled={Boolean(semanticBusy)} style={secondary}>{semanticBusy === 'test' ? 'Testing…' : 'Test draft'}</button>
              <button type="button" onClick={() => void applySemanticRuntime()} disabled={Boolean(semanticBusy)} style={{ ...secondary, border: 'none', background: t.accent, color: '#fff' }}>{semanticBusy === 'apply' ? 'Testing & saving…' : 'Test & save'}</button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
