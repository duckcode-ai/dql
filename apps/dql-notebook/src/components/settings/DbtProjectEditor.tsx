import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, GitBranch, RefreshCw } from 'lucide-react';
import { api, type DbtOnboardingPreviewResponse, type DbtOnboardingStatusResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';

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
  const [busy, setBusy] = useState<'loading' | 'preview' | 'apply' | 'refresh' | null>('loading');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    const [next, dbt] = await Promise.all([
      api.getOnboardingStatus(),
      api.getBlockStudioDbtStatus().catch(() => null),
    ]);
    setStatus(next);
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
      await api.applyDbtOnboarding({
        ...(preview.repoUrl
          ? { repoUrl: preview.repoUrl, branch: preview.branch, subPath: preview.subPath }
          : { projectDir: preview.projectDir }),
        manifestPath: preview.manifestPath,
        profilesDir: preview.profilesDir,
        expectedFingerprint: preview.fingerprint,
      });
      await loadStatus();
      const summary = `${preview.counts.models ?? 0} models · ${preview.counts.sources ?? 0} sources · ${preview.counts.metrics ?? 0} metrics`;
      setMessage({ ok: true, text: `Applied ${preview.projectName || preview.projectDir}. ${summary}.` });
      onConfigured?.({ name: preview.projectName || 'dbt project', path: preview.projectDir, summary });
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
      await api.refreshDbtOnboarding();
      await loadStatus();
      setMessage({ ok: true, text: 'dbt artifacts refreshed from the configured project.' });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const configured = projectReady;
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

      <div style={{ border: `1px solid ${configured ? 'var(--status-success-border)' : 'var(--border-subtle)'}`, borderRadius: 12, background: t.cellBg, padding: '14px 16px', display: 'flex', gap: 11, alignItems: 'center' }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: configured ? 'var(--status-success)' : 'var(--status-warning)', background: configured ? 'var(--status-success-bg)' : 'var(--status-warning-bg)' }}>
          {configured ? <CheckCircle2 size={17} /> : <GitBranch size={17} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>{configured ? 'dbt project configured' : 'dbt project missing'}</div>
          <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {configured ? status?.dbt?.repoUrl || status?.dbt?.projectDir || 'Configured dbt project.' : 'Choose a local path or Git repository.'}
          </div>
        </div>
        {configured ? <button type="button" onClick={() => void refresh()} disabled={Boolean(busy)} style={secondary}><RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 6 }} />{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button> : null}
      </div>

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
    </div>
  );
}
