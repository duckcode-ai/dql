import React, { useEffect, useState, useCallback } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { DiffReport } from '@duckcodeailabs/dql-core/format';
import { GitDiffView } from './GitDiffView';

type Status = Awaited<ReturnType<typeof api.fetchGitStatus>>;
type LogResult = Awaited<ReturnType<typeof api.fetchGitLog>>;

type Tab = 'status' | 'log' | 'diff';

const STATUS_POLL_MS = 2000;

export function GitPanel() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [tab, setTab] = useState<Tab>('status');
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<LogResult | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'status') {
        setStatus(await api.fetchGitStatus());
      } else if (tab === 'log') {
        setLog(await api.fetchGitLog(30));
      } else {
        const result = await api.fetchGitDiff(diffPath ?? undefined);
        setDiff(result.diff);
        setDiffReport(result.diffReport);
      }
    } finally {
      setLoading(false);
    }
  }, [tab, diffPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Quiet poll on the status tab so the file list reflects terminal-side
  // edits within 2s without the user clicking refresh.
  useEffect(() => {
    if (tab !== 'status') return;
    const id = window.setInterval(() => {
      void api.fetchGitStatus().then((next) => {
        setStatus((prev) => (statusEqual(prev, next) ? prev : next));
      });
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [tab]);

  const activeFilePath = state.activeFile?.path ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', color: t.textPrimary, fontFamily: t.font }}>
      <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <TabButton t={t} active={tab === 'status'} onClick={() => setTab('status')}>Status</TabButton>
        <TabButton t={t} active={tab === 'log'} onClick={() => setTab('log')}>Log</TabButton>
        <TabButton t={t} active={tab === 'diff'} onClick={() => setTab('diff')}>Diff</TabButton>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => void refresh()}
          title="Refresh"
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: t.textMuted, padding: '2px 6px', borderRadius: 4, fontSize: 12,
          }}
        >
          ↻
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 10, fontSize: 12 }}>
        {loading && !status && !log && <div style={{ color: t.textMuted }}>Loading…</div>}

        {tab === 'status' && status && (
          <StatusView status={status} t={t} />
        )}

        {tab === 'log' && log && (
          <LogView log={log} t={t} />
        )}

        {tab === 'diff' && (
          <GitDiffView
            diff={diff}
            diffReport={diffReport}
            activeFilePath={activeFilePath}
            diffPath={diffPath}
            onScopeToFile={() => setDiffPath(activeFilePath)}
            onClearScope={() => setDiffPath(null)}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

function statusEqual(a: Status | null, b: Status): boolean {
  if (!a) return false;
  if (a.inRepo !== b.inRepo || a.branch !== b.branch || a.ahead !== b.ahead || a.behind !== b.behind) return false;
  if (a.changes.length !== b.changes.length) return false;
  const ak = a.changes.map((c) => `${c.path}\0${c.status}`).sort();
  const bk = b.changes.map((c) => `${c.path}\0${c.status}`).sort();
  for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
  return true;
}

function StatusView({ status, t }: { status: Status; t: any }) {
  if (!status.inRepo) {
    return <div style={{ color: t.textMuted }}>Not a git repository.</div>;
  }
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={{ color: t.textMuted }}>Branch</span>{' '}
        <span style={{ color: t.accent, fontWeight: 600 }}>{status.branch ?? 'detached'}</span>
        {status.ahead > 0 && <span style={{ marginLeft: 8, color: t.textMuted }}>↑ {status.ahead}</span>}
        {status.behind > 0 && <span style={{ marginLeft: 8, color: t.textMuted }}>↓ {status.behind}</span>}
      </div>
      {status.changes.length === 0 ? (
        <div style={{ color: t.textMuted }}>Working tree clean.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: t.fontMono, fontSize: 11 }}>
          {status.changes.map((c) => (
            <div key={c.path} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: statusColor(c.status, t), width: 22 }}>{c.status.trim() || '??'}</span>
              <span style={{ color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.path}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LogView({ log, t }: { log: LogResult; t: any }) {
  if (!log.inRepo) {
    return <div style={{ color: t.textMuted }}>Not a git repository.</div>;
  }
  if (log.commits.length === 0) {
    return <div style={{ color: t.textMuted }}>No commits.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {log.commits.map((c) => (
        <div key={c.hash} style={{ borderLeft: `2px solid ${t.headerBorder}`, paddingLeft: 8 }}>
          <div style={{ color: t.textPrimary, fontSize: 12 }}>{c.subject}</div>
          <div style={{ color: t.textMuted, fontSize: 10, marginTop: 2, fontFamily: t.fontMono }}>
            {c.hash.slice(0, 7)} · {c.author} · {c.date}
          </div>
        </div>
      ))}
    </div>
  );
}

function TabButton({ active, onClick, children, t }: { active: boolean; onClick: () => void; children: React.ReactNode; t: any }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? t.btnHover : 'transparent',
        color: active ? t.textPrimary : t.textMuted,
        border: 'none',
        padding: '3px 10px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function statusColor(code: string, t: any): string {
  const c = code.trim();
  if (c === 'M' || c === 'MM') return t.warning;
  if (c === 'A' || c === '??') return t.success;
  if (c === 'D') return t.error;
  if (c.startsWith('R')) return t.accent;
  return t.textMuted;
}
