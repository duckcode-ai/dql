import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  GitBranch, GitCommit, RefreshCw, ArrowUp, ArrowDown,
  FileEdit, FilePlus, FileX, FileQuestion, ArrowRightLeft, FileCheck,
} from 'lucide-react';
import { PanelFrame, PanelToolbar, PanelEmpty } from '@duckcodeailabs/dql-ui';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { DiffReport } from '@duckcodeailabs/dql-core/format';
import { GitDiffView } from './GitDiffView';

type Status = Awaited<ReturnType<typeof api.fetchGitStatus>>;
type LogResult = Awaited<ReturnType<typeof api.fetchGitLog>>;
type Change = Status['changes'][number];

type Tab = 'status' | 'log' | 'diff';

const STATUS_POLL_MS = 2000;

// Group definitions for the Status view. Each change is bucketed by its
// first non-space char in the porcelain status code.
type Group = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

const GROUP_META: Record<Group, { label: string; color: (t: Theme) => string; Icon: React.ComponentType<any> }> = {
  modified:  { label: 'Modified',  color: (t) => t.warning, Icon: FileEdit },
  added:     { label: 'Added',     color: (t) => t.success, Icon: FilePlus },
  deleted:   { label: 'Deleted',   color: (t) => t.error,   Icon: FileX },
  renamed:   { label: 'Renamed',   color: (t) => t.accent,  Icon: ArrowRightLeft },
  untracked: { label: 'Untracked', color: (t) => t.textMuted, Icon: FileQuestion },
};

const GROUP_ORDER: Group[] = ['modified', 'added', 'renamed', 'deleted', 'untracked'];

function groupOf(code: string): Group {
  const c = code.trim();
  if (c === '??') return 'untracked';
  if (c.startsWith('R')) return 'renamed';
  if (c.includes('D')) return 'deleted';
  if (c.includes('A')) return 'added';
  return 'modified';
}

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
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setRefreshing(true);
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
      window.setTimeout(() => setRefreshing(false), 400);
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

  const actions = (
    <button
      onClick={() => void refresh()}
      title="Refresh"
      aria-label="Refresh"
      style={{
        background: 'transparent', border: `1px solid ${t.btnBorder}`, cursor: 'pointer',
        color: t.textMuted, padding: '3px 6px', borderRadius: 4, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <RefreshCw
        size={12}
        strokeWidth={1.75}
        style={{ animation: refreshing ? 'dql-spin 0.6s linear' : undefined }}
      />
      <style>{`@keyframes dql-spin { to { transform: rotate(360deg); } }`}</style>
    </button>
  );

  const toolbar = (
    <PanelToolbar>
      <TabButton t={t} active={tab === 'status'} onClick={() => setTab('status')}>Status</TabButton>
      <TabButton t={t} active={tab === 'log'} onClick={() => setTab('log')}>History</TabButton>
      <TabButton t={t} active={tab === 'diff'} onClick={() => setTab('diff')}>Diff</TabButton>
    </PanelToolbar>
  );

  return (
    <PanelFrame title="Git" actions={actions} toolbar={toolbar} bodyPadding={12}>
      {loading && !status && !log && <PanelEmpty title="Loading…" />}

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
    </PanelFrame>
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

// ---------- Status View ----------

function StatusView({ status, t }: { status: Status; t: Theme }) {
  const grouped = useMemo(() => {
    const map: Record<Group, Change[]> = {
      modified: [], added: [], deleted: [], renamed: [], untracked: [],
    };
    for (const c of status.changes) map[groupOf(c.status)].push(c);
    for (const g of GROUP_ORDER) map[g].sort((a, b) => a.path.localeCompare(b.path));
    return map;
  }, [status.changes]);

  if (!status.inRepo) {
    return <NotARepoCard t={t} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <BranchCard status={status} t={t} />

      {status.changes.length === 0 ? (
        <CleanCard t={t} />
      ) : (
        GROUP_ORDER.map((g) => {
          const items = grouped[g];
          if (items.length === 0) return null;
          return <ChangeGroup key={g} group={g} items={items} t={t} />;
        })
      )}
    </div>
  );
}

function BranchCard({ status, t }: { status: Status; t: Theme }) {
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid ${t.accent}`,
        borderRadius: 7,
      }}
    >
      <GitBranch size={16} strokeWidth={1.75} color={t.accent} />
      <span style={{ fontSize: 13, fontWeight: 600, color: t.textPrimary, fontFamily: t.fontMono }}>
        {status.branch ?? 'detached'}
      </span>
      <div style={{ flex: 1 }} />
      {ahead > 0 && (
        <span title={`${ahead} commit(s) ahead of upstream`} style={badge(t.success, t)}>
          <ArrowUp size={11} strokeWidth={2} /> {ahead}
        </span>
      )}
      {behind > 0 && (
        <span title={`${behind} commit(s) behind upstream`} style={badge(t.warning, t)}>
          <ArrowDown size={11} strokeWidth={2} /> {behind}
        </span>
      )}
      {ahead === 0 && behind === 0 && (
        <span style={{ ...badge(t.textMuted, t), opacity: 0.7 }}>up to date</span>
      )}
    </div>
  );
}

function CleanCard({ t }: { t: Theme }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '14px 12px',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 7,
        color: t.textMuted, fontSize: 12, fontFamily: t.font,
      }}
    >
      <FileCheck size={14} strokeWidth={1.75} color={t.success} />
      Working tree clean
    </div>
  );
}

function NotARepoCard({ t }: { t: Theme }) {
  return (
    <div
      style={{
        padding: '14px 12px',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 7,
        color: t.textMuted, fontSize: 12, fontFamily: t.font,
      }}
    >
      Not a git repository
    </div>
  );
}

function ChangeGroup({ group, items, t }: { group: Group; items: Change[]; t: Theme }) {
  const meta = GROUP_META[group];
  const color = meta.color(t);
  const Icon = meta.Icon;
  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font,
        }}
      >
        <Icon size={11} strokeWidth={1.75} />
        <span>{meta.label}</span>
        <span style={{
          marginLeft: 2, padding: '0 5px', borderRadius: 8,
          background: `${color}1a`, color, fontWeight: 700,
          fontSize: 9, letterSpacing: '0.04em',
        }}>
          {items.length}
        </span>
      </div>
      <div
        style={{
          display: 'flex', flexDirection: 'column',
          background: t.cellBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 7,
          overflow: 'hidden',
        }}
      >
        {items.map((c, i) => (
          <ChangeRow key={c.path} change={c} t={t} color={color} divider={i < items.length - 1} />
        ))}
      </div>
    </div>
  );
}

function ChangeRow({ change, t, color, divider }: { change: Change; t: Theme; color: string; divider: boolean }) {
  const code = change.status.trim() || '??';
  return (
    <div
      title={change.path}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        borderBottom: divider ? `1px solid ${t.cellBorder}` : 'none',
        fontFamily: t.fontMono, fontSize: 11,
      }}
    >
      <span
        style={{
          width: 22, textAlign: 'center', flexShrink: 0,
          color, fontWeight: 700, fontSize: 10, letterSpacing: '0.02em',
        }}
      >
        {code}
      </span>
      <span style={{
        color: t.textPrimary, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
      }}>
        {change.path}
      </span>
    </div>
  );
}

// ---------- Log View ----------

function LogView({ log, t }: { log: LogResult; t: Theme }) {
  if (!log.inRepo) return <NotARepoCard t={t} />;
  if (log.commits.length === 0) {
    return (
      <div style={{
        padding: '14px 12px', background: t.cellBg, border: `1px solid ${t.cellBorder}`,
        borderRadius: 7, color: t.textMuted, fontSize: 12, fontFamily: t.font,
      }}>
        No commits yet
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 7,
        overflow: 'hidden',
      }}
    >
      {log.commits.map((c, i) => (
        <div
          key={c.hash}
          style={{
            display: 'flex', gap: 10, padding: '8px 12px',
            borderBottom: i < log.commits.length - 1 ? `1px solid ${t.cellBorder}` : 'none',
          }}
        >
          <GitCommit size={13} strokeWidth={1.75} color={t.accent} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              color: t.textPrimary, fontSize: 12, fontFamily: t.font,
              fontWeight: 500, lineHeight: 1.35, wordBreak: 'break-word',
            }}>
              {c.subject}
            </div>
            <div style={{
              color: t.textMuted, fontSize: 10, marginTop: 3,
              display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
            }}>
              <span style={{ fontFamily: t.fontMono, color: t.accent }}>{c.hash.slice(0, 7)}</span>
              <span>·</span>
              <span style={{ fontFamily: t.font }}>{c.author}</span>
              <span>·</span>
              <span style={{ fontFamily: t.fontMono }}>{c.date}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Tabs ----------

function TabButton({ active, onClick, children, t }: { active: boolean; onClick: () => void; children: React.ReactNode; t: Theme }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? t.btnHover : 'transparent',
        color: active ? t.textPrimary : t.textMuted,
        border: 'none',
        padding: '4px 12px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        cursor: 'pointer',
        fontFamily: t.font,
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {children}
    </button>
  );
}

function badge(color: string, t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    padding: '1px 7px',
    fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
    borderRadius: 10,
    background: `${color}1a`,
    color,
    fontFamily: t.font,
  };
}
