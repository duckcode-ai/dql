/**
 * GitPage — full-page Source Control view.
 *
 * Mirrors the New-UI/project/hex-git.jsx wireframe: top header (branch chip,
 * remote URL, sync status, Pull/Push), left file tree (search, filter,
 * Staged/Changes sections, file rows), right diff viewer, bottom commit bar.
 *
 * All write operations route through api.gitStage / gitCommit / gitPush etc.
 * which shell out to the system `git` binary on the backend.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GitBranch, GitCommit, RefreshCw, ArrowUp, ArrowDown,
  Search, ChevronDown, X, Plus, Check,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';

type Status = Awaited<ReturnType<typeof api.fetchGitStatus>>;
type RawChange = Status['changes'][number];

interface FileEntry {
  path: string;
  /** Single-letter status: M / A / D / R / ? (untracked) */
  status: 'M' | 'A' | 'D' | 'R' | '?';
  staged: boolean;
  /** True when both index and worktree have changes (e.g. porcelain "MM"). */
  partiallyStaged: boolean;
}

type StatusFilter = 'all' | 'M' | 'A' | 'D' | 'R' | '?';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All changes' },
  { key: 'M', label: 'Modified' },
  { key: 'A', label: 'Added' },
  { key: 'D', label: 'Deleted' },
  { key: 'R', label: 'Renamed' },
  { key: '?', label: 'Untracked' },
];

// Map first-char (index) and second-char (worktree) of porcelain status into
// our simplified single-letter category. We bucket renames-with-mods into 'R'
// and treat untracked as '?'.
function classify(code: string): 'M' | 'A' | 'D' | 'R' | '?' {
  const c = code;
  if (c.trim() === '??') return '?';
  if (c[0] === 'R' || c[1] === 'R') return 'R';
  if (c.includes('A')) return 'A';
  if (c.includes('D')) return 'D';
  return 'M';
}

function expandChanges(raw: RawChange[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const c of raw) {
    const idx = c.status[0] ?? ' ';
    const work = c.status[1] ?? ' ';
    const status = classify(c.status);
    if (c.status === '??') {
      out.push({ path: c.path, status: '?', staged: false, partiallyStaged: false });
      continue;
    }
    const indexDirty = idx !== ' ' && idx !== '?';
    const workDirty = work !== ' ' && work !== '?';
    if (indexDirty && workDirty) {
      // Same path appears in both lists so the user can stage/unstage each side.
      out.push({ path: c.path, status, staged: true, partiallyStaged: true });
      out.push({ path: c.path, status, staged: false, partiallyStaged: true });
    } else if (indexDirty) {
      out.push({ path: c.path, status, staged: true, partiallyStaged: false });
    } else {
      out.push({ path: c.path, status, staged: false, partiallyStaged: false });
    }
  }
  return out;
}

interface ToastMsg { kind: 'ok' | 'err'; text: string }

export function GitPage() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [status, setStatus] = useState<Status | null>(null);
  const [branchInfo, setBranchInfo] = useState<{ current: string | null; branches: string[] }>({ current: null, branches: [] });
  const [remote, setRemote] = useState<{ url: string | null; name: string | null }>({ url: null, name: null });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedStaged, setSelectedStaged] = useState(false);
  const [diff, setDiff] = useState<{ diff: string; before: string | null; after: string | null } | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const branchMenuRef = useRef<HTMLDivElement>(null);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, b, r] = await Promise.all([
        api.fetchGitStatus(),
        api.fetchGitBranches(),
        api.fetchGitRemote(),
      ]);
      setStatus(s);
      setBranchInfo({ current: b.current, branches: b.branches });
      setRemote({ url: r.url, name: r.name });
    } finally {
      window.setTimeout(() => setRefreshing(false), 350);
    }
  }, []);

  useEffect(() => { void refreshAll(); }, [refreshAll]);

  // Quiet poll so external git activity (terminal commits, branch switches)
  // shows up in the UI without the user clicking refresh.
  useEffect(() => {
    const id = window.setInterval(() => { void refreshAll(); }, 4000);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  // Close the branch menu when clicking outside of it.
  useEffect(() => {
    if (!branchMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setBranchMenuOpen(false);
        setNewBranchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [branchMenuOpen]);

  // Re-fetch the diff for the selected file when selection changes or after
  // any operation refreshes status. Don't clear the diff while loading so
  // the panel doesn't flicker.
  useEffect(() => {
    if (!selectedPath) { setDiff(null); return; }
    let cancelled = false;
    void api.fetchGitDiff(selectedPath, selectedStaged).then((d) => {
      if (!cancelled) setDiff(d);
    });
    return () => { cancelled = true; };
  }, [selectedPath, selectedStaged, status]);

  const entries = useMemo(() => expandChanges(status?.changes ?? []), [status?.changes]);
  const stagedFiles = entries.filter((e) => e.staged);
  const unstagedFiles = entries.filter((e) => !e.staged);

  const filterFn = useCallback((f: FileEntry) => {
    if (statusFilter !== 'all' && f.status !== statusFilter) return false;
    if (query && !f.path.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }, [statusFilter, query]);

  const filteredStaged = stagedFiles.filter(filterFn);
  const filteredUnstaged = unstagedFiles.filter(filterFn);

  // Auto-pick first file when none selected
  useEffect(() => {
    if (selectedPath) {
      const stillExists = entries.some((e) => e.path === selectedPath && e.staged === selectedStaged);
      if (stillExists) return;
    }
    const first = filteredUnstaged[0] ?? filteredStaged[0];
    if (first) {
      setSelectedPath(first.path);
      setSelectedStaged(first.staged);
    } else {
      setSelectedPath(null);
    }
  }, [entries, selectedPath, selectedStaged, filteredStaged, filteredUnstaged]);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const runOp = useCallback(async <T,>(label: string, op: () => Promise<{ ok: boolean; error?: string } & T>, successMsg?: string) => {
    setBusy(label);
    try {
      const res = await op();
      if (res.ok) {
        if (successMsg) flash('ok', successMsg);
        await refreshAll();
      } else {
        flash('err', res.error ?? `${label} failed`);
      }
      return res;
    } finally {
      setBusy(null);
    }
  }, [flash, refreshAll]);

  const onStage = (path: string) => runOp('stage', () => api.gitStage([path]));
  const onUnstage = (path: string) => runOp('unstage', () => api.gitUnstage([path]));
  const onDiscard = (path: string) => {
    if (!window.confirm(`Discard local changes to ${path}? This cannot be undone.`)) return;
    void runOp('discard', () => api.gitDiscard([path]), 'Discarded local changes');
  };
  const onStageAll = () => runOp('stage', async () => {
    const paths = unstagedFiles.map((e) => e.path);
    if (paths.length === 0) return { ok: true };
    return api.gitStage(paths);
  });
  const onCommit = async () => {
    const msg = commitMsg.trim();
    if (!msg) return flash('err', 'Commit message required');
    const stageAll = stagedFiles.length === 0;
    const res = await runOp('commit', () => api.gitCommit(msg, stageAll), 'Committed');
    if (res.ok) setCommitMsg('');
  };
  const onCommitAndPush = async () => {
    const msg = commitMsg.trim();
    if (!msg) return flash('err', 'Commit message required');
    const stageAll = stagedFiles.length === 0;
    const c = await runOp('commit', () => api.gitCommit(msg, stageAll));
    if (!c.ok) return;
    setCommitMsg('');
    await runOp('push', () => api.gitPush(), 'Pushed to remote');
  };
  const onPull = () => runOp('pull', () => api.gitPull(), 'Pulled from remote');
  const onPush = () => runOp('push', () => api.gitPush(), 'Pushed to remote');
  const onCheckout = (name: string) => {
    setBranchMenuOpen(false);
    void runOp('checkout', () => api.gitCheckout(name), `Switched to ${name}`);
  };
  const onCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setBranchMenuOpen(false);
    setNewBranchOpen(false);
    setNewBranchName('');
    void runOp('branch', () => api.gitCreateBranch(name, true), `Created and switched to ${name}`);
  };

  const selectedEntry = entries.find((e) => e.path === selectedPath && e.staged === selectedStaged) ?? null;

  if (status && !status.inRepo) {
    return <NotARepo t={t} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: t.appBg }}>
      <TopBar
        t={t}
        branchCurrent={branchInfo.current}
        branches={branchInfo.branches}
        ahead={status?.ahead ?? 0}
        behind={status?.behind ?? 0}
        remoteUrl={remote.url}
        refreshing={refreshing}
        busy={busy}
        onPull={onPull}
        onPush={onPush}
        onRefresh={() => void refreshAll()}
        onCheckout={onCheckout}
        branchMenuOpen={branchMenuOpen}
        setBranchMenuOpen={setBranchMenuOpen}
        newBranchOpen={newBranchOpen}
        setNewBranchOpen={setNewBranchOpen}
        newBranchName={newBranchName}
        setNewBranchName={setNewBranchName}
        onCreateBranch={onCreateBranch}
        branchMenuRef={branchMenuRef}
      />

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <FileTree
          t={t}
          stagedFiles={filteredStaged}
          unstagedFiles={filteredUnstaged}
          totalCount={entries.length}
          selectedPath={selectedPath}
          selectedStaged={selectedStaged}
          onSelect={(path, staged) => { setSelectedPath(path); setSelectedStaged(staged); }}
          query={query}
          setQuery={setQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          onStage={onStage}
          onUnstage={onUnstage}
          onStageAll={onStageAll}
          ahead={status?.ahead ?? 0}
          behind={status?.behind ?? 0}
          branchCurrent={branchInfo.current}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: t.appBg }}>
          {selectedEntry && diff ? (
            <>
              <FileDiffHeader
                t={t}
                entry={selectedEntry}
                onStage={() => onStage(selectedEntry.path)}
                onUnstage={() => onUnstage(selectedEntry.path)}
                onDiscard={() => onDiscard(selectedEntry.path)}
                stagedView={selectedStaged}
              />
              <DiffPane t={t} diff={diff.diff} />
            </>
          ) : (
            <DiffEmpty t={t} hasFiles={entries.length > 0} />
          )}
          <CommitBar
            t={t}
            commitMsg={commitMsg}
            setCommitMsg={setCommitMsg}
            stagedCount={stagedFiles.length}
            unstagedCount={unstagedFiles.length}
            onCommit={onCommit}
            onCommitAndPush={onCommitAndPush}
            busy={busy}
          />
        </div>
      </div>

      {toast && <Toast t={t} kind={toast.kind} text={toast.text} />}
    </div>
  );
}

// ---------- Top Bar ----------

interface TopBarProps {
  t: Theme;
  branchCurrent: string | null;
  branches: string[];
  ahead: number;
  behind: number;
  remoteUrl: string | null;
  refreshing: boolean;
  busy: string | null;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
  onCheckout: (name: string) => void;
  branchMenuOpen: boolean;
  setBranchMenuOpen: (v: boolean) => void;
  newBranchOpen: boolean;
  setNewBranchOpen: (v: boolean) => void;
  newBranchName: string;
  setNewBranchName: (v: string) => void;
  onCreateBranch: () => void;
  branchMenuRef: React.RefObject<HTMLDivElement>;
}

function TopBar(p: TopBarProps) {
  const { t } = p;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 20px',
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.appBg,
        flexShrink: 0, whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          fontFamily: t.fontMono, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          padding: '3px 7px', borderRadius: 3,
          background: `${t.accent}1f`, color: t.accent,
          border: `1px solid ${t.accent}40`,
        }}
      >
        GIT
      </span>
      <span style={{ fontSize: 14, fontWeight: 500, color: t.textPrimary }}>Source control</span>

      <div ref={p.branchMenuRef} style={{ position: 'relative' }}>
        <button
          onClick={() => p.setBranchMenuOpen(!p.branchMenuOpen)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: t.cellBg, border: `1px solid ${t.cellBorder}`,
            color: t.textPrimary, padding: '3px 8px', borderRadius: 4,
            fontSize: 11, fontFamily: t.fontMono, cursor: 'pointer',
          }}
        >
          <GitBranch size={11} strokeWidth={1.75} />
          {p.branchCurrent ?? 'detached'}
          <ChevronDown size={10} strokeWidth={1.75} style={{ opacity: 0.6 }} />
        </button>
        {p.branchMenuOpen && (
          <div
            style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              minWidth: 220, maxHeight: 360, overflow: 'auto',
              background: t.cellBg, border: `1px solid ${t.cellBorder}`,
              borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
              padding: '6px 0', zIndex: 100,
            }}
          >
            {p.branches.map((b) => (
              <button
                key={b}
                onClick={() => p.onCheckout(b)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 10px',
                  background: 'transparent', border: 'none',
                  fontFamily: t.fontMono, fontSize: 12, color: t.textPrimary,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.btnHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {b === p.branchCurrent
                  ? <Check size={11} strokeWidth={2} color={t.success} />
                  : <span style={{ width: 11, display: 'inline-block' }} />}
                {b}
              </button>
            ))}
            <div style={{ borderTop: `1px solid ${t.cellBorder}`, margin: '4px 0' }} />
            {p.newBranchOpen ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}>
                <input
                  autoFocus
                  value={p.newBranchName}
                  onChange={(e) => p.setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') p.onCreateBranch();
                    if (e.key === 'Escape') { p.setNewBranchOpen(false); p.setNewBranchName(''); }
                  }}
                  placeholder="new-branch-name"
                  style={{
                    flex: 1, background: t.appBg, color: t.textPrimary,
                    border: `1px solid ${t.cellBorder}`, borderRadius: 4,
                    padding: '4px 7px', fontSize: 12, fontFamily: t.fontMono, outline: 'none',
                  }}
                />
                <button onClick={p.onCreateBranch} style={miniBtn(t, 'primary')}>Create</button>
              </div>
            ) : (
              <button
                onClick={() => p.setNewBranchOpen(true)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px',
                  background: 'transparent', border: 'none',
                  fontSize: 12, color: t.accent,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.btnHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Plus size={11} strokeWidth={1.75} />
                Create new branch…
              </button>
            )}
          </div>
        )}
      </div>

      {p.remoteUrl && (
        <>
          <span style={{ fontSize: 11, color: t.textMuted }}>·</span>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.remoteUrl}>
            {prettyRemote(p.remoteUrl)}
          </span>
        </>
      )}

      <span style={{ fontSize: 11, color: t.textMuted }}>·</span>
      <span style={{ fontSize: 11, color: t.success, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.success }} />
        ready
      </span>

      <div style={{ flex: 1 }} />

      <button onClick={p.onRefresh} title="Refresh" style={{
        background: 'transparent', border: `1px solid ${t.btnBorder}`,
        padding: '6px 8px', borderRadius: 5, cursor: 'pointer', color: t.textMuted,
      }}>
        <RefreshCw size={12} strokeWidth={1.75} style={{ animation: p.refreshing ? 'dql-spin 0.6s linear' : undefined }} />
      </button>
      <style>{`@keyframes dql-spin { to { transform: rotate(360deg); } }`}</style>

      <button onClick={p.onPull} disabled={!!p.busy} style={topBtn(t)}>
        <ArrowDown size={12} strokeWidth={1.75} color={t.warning} />
        Pull
        {p.behind > 0 && <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, marginLeft: 2 }}>{p.behind}</span>}
      </button>
      <button onClick={p.onPush} disabled={!!p.busy} style={topBtn(t, true)}>
        <ArrowUp size={12} strokeWidth={1.75} />
        Push
        {p.ahead > 0 && <span style={{ fontFamily: t.fontMono, fontSize: 10, opacity: 0.75, marginLeft: 2 }}>{p.ahead}</span>}
      </button>
    </div>
  );
}

function topBtn(t: Theme, primary = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    background: primary ? t.accent : t.cellBg,
    color: primary ? '#fff' : t.textPrimary,
    border: `1px solid ${primary ? t.accent : t.btnBorder}`,
    padding: '5px 12px', borderRadius: 6,
    fontSize: 12, fontFamily: t.font, fontWeight: primary ? 500 : 400,
    cursor: 'pointer', whiteSpace: 'nowrap',
  };
}

function miniBtn(t: Theme, kind: 'primary' | 'default' = 'default'): React.CSSProperties {
  return {
    background: kind === 'primary' ? t.accent : t.cellBg,
    color: kind === 'primary' ? '#fff' : t.textPrimary,
    border: `1px solid ${kind === 'primary' ? t.accent : t.btnBorder}`,
    padding: '4px 9px', borderRadius: 4,
    fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: t.font,
  };
}

function prettyRemote(url: string): string {
  return url.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

// ---------- File Tree ----------

interface FileTreeProps {
  t: Theme;
  stagedFiles: FileEntry[];
  unstagedFiles: FileEntry[];
  totalCount: number;
  selectedPath: string | null;
  selectedStaged: boolean;
  onSelect: (path: string, staged: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onStageAll: () => void;
  ahead: number;
  behind: number;
  branchCurrent: string | null;
}

function FileTree(p: FileTreeProps) {
  const { t } = p;
  return (
    <div
      style={{
        width: 300, flexShrink: 0,
        background: t.sidebarBg,
        borderRight: `1px solid ${t.headerBorder}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: t.textMuted,
        }}>
          Source control
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary }}>
            Changes
          </span>
          <span style={{ fontSize: 11, color: t.textMuted }}>{p.totalCount} files</span>
          <div style={{ flex: 1 }} />
          {p.unstagedFiles.length > 0 && (
            <button onClick={p.onStageAll} style={miniBtn(t)}>Stage all</button>
          )}
        </div>

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: t.cellBg, border: `1px solid ${t.cellBorder}`,
            borderRadius: 6, padding: '5px 9px', marginBottom: 7,
          }}
        >
          <Search size={11} strokeWidth={1.75} color={t.textMuted} />
          <input
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
            placeholder="Filter by path…"
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: t.textPrimary, fontSize: 12, flex: 1, width: '100%',
              fontFamily: t.font,
            }}
          />
          {p.query && (
            <button
              onClick={() => p.setQuery('')}
              style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', padding: 0 }}
            >
              <X size={11} strokeWidth={1.75} />
            </button>
          )}
        </div>

        <select
          value={p.statusFilter}
          onChange={(e) => p.setStatusFilter(e.target.value as StatusFilter)}
          style={{
            width: '100%', background: t.cellBg, color: t.textPrimary,
            border: `1px solid ${t.cellBorder}`, borderRadius: 6,
            padding: '5px 9px', fontSize: 12, cursor: 'pointer',
            fontFamily: t.font,
          }}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        <SectionHeader t={t} label="Staged" count={p.stagedFiles.length} />
        {p.stagedFiles.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 10px', fontStyle: 'italic' }}>
            No staged changes
          </div>
        ) : (
          p.stagedFiles.map((f) => (
            <FileRow
              key={`staged-${f.path}`}
              t={t}
              file={f}
              active={p.selectedPath === f.path && p.selectedStaged === true}
              onClick={() => p.onSelect(f.path, true)}
              actionLabel="Unstage"
              onAction={() => p.onUnstage(f.path)}
            />
          ))
        )}

        <div style={{ height: 8 }} />
        <SectionHeader t={t} label="Changes" count={p.unstagedFiles.length} />
        {p.unstagedFiles.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 10px', fontStyle: 'italic' }}>
            {p.totalCount === 0 ? 'Working tree clean' : 'No unstaged changes'}
          </div>
        ) : (
          p.unstagedFiles.map((f) => (
            <FileRow
              key={`unstaged-${f.path}`}
              t={t}
              file={f}
              active={p.selectedPath === f.path && p.selectedStaged === false}
              onClick={() => p.onSelect(f.path, false)}
              actionLabel="Stage"
              onAction={() => p.onStage(f.path)}
            />
          ))
        )}
      </div>

      <div
        style={{
          padding: '10px 14px', borderTop: `1px solid ${t.headerBorder}`,
          fontSize: 10, color: t.textMuted,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <GitBranch size={11} strokeWidth={1.75} />
        <span style={{ fontFamily: t.fontMono, color: t.textPrimary }}>
          {p.branchCurrent ?? 'detached'}
        </span>
        <span>·</span>
        {p.behind > 0 && <span style={{ color: t.warning }}>↓{p.behind}</span>}
        {p.ahead > 0 && <span style={{ color: t.success }}>↑{p.ahead}</span>}
        {p.behind === 0 && p.ahead === 0 && <span>up to date</span>}
      </div>
    </div>
  );
}

function SectionHeader({ t, label, count }: { t: Theme; label: string; count: number }) {
  return (
    <div style={{
      fontSize: 10, color: t.textMuted, fontWeight: 600,
      letterSpacing: '0.07em', textTransform: 'uppercase',
      padding: '6px 8px 4px',
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span>{label}</span>
      <span style={{ color: t.textMuted, opacity: 0.7 }}>·</span>
      <span style={{ color: t.textMuted }}>{count}</span>
    </div>
  );
}

interface FileRowProps {
  t: Theme;
  file: FileEntry;
  active: boolean;
  onClick: () => void;
  actionLabel: string;
  onAction: () => void;
}

function FileRow({ t, file, active, onClick, actionLabel, onAction }: FileRowProps) {
  const [hover, setHover] = useState(false);
  const dir = file.path.split('/').slice(0, -1).join('/');
  const base = file.path.split('/').pop() ?? file.path;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        borderRadius: 5, marginBottom: 1, cursor: 'pointer',
        background: active ? `${t.accent}18` : hover ? t.btnHover : 'transparent',
        border: active ? `1px solid ${t.accent}45` : '1px solid transparent',
      }}
    >
      <StatusBadge t={t} status={file.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: t.textPrimary, fontFamily: t.fontMono,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {base}
        </div>
        {dir && (
          <div style={{
            fontSize: 10, color: t.textMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {dir}
          </div>
        )}
      </div>
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onAction(); }}
          style={{
            background: t.cellBg, border: `1px solid ${t.btnBorder}`,
            color: t.textPrimary, padding: '2px 7px', borderRadius: 3,
            fontSize: 10, cursor: 'pointer', flexShrink: 0,
            fontFamily: t.font,
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function StatusBadge({ t, status }: { t: Theme; status: FileEntry['status'] }) {
  const colorMap: Record<FileEntry['status'], string> = {
    M: t.warning,
    A: t.success,
    D: t.error,
    R: t.accent,
    '?': t.textMuted,
  };
  const c = colorMap[status];
  return (
    <span
      style={{
        width: 18, height: 18, borderRadius: 3, flexShrink: 0,
        background: `${c}1a`, color: c, border: `1px solid ${c}40`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 700, fontFamily: t.fontMono,
      }}
    >
      {status}
    </span>
  );
}

// ---------- File Diff Header ----------

interface FileDiffHeaderProps {
  t: Theme;
  entry: FileEntry;
  stagedView: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}

function FileDiffHeader({ t, entry, stagedView, onStage, onUnstage, onDiscard }: FileDiffHeaderProps) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px',
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        flexShrink: 0,
      }}
    >
      <StatusBadge t={t} status={entry.status} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: t.textPrimary, fontFamily: t.fontMono }}>
          {entry.path}
        </div>
        <div style={{ fontSize: 11, color: t.textMuted, display: 'flex', gap: 8 }}>
          <span>{stagedView ? 'Staged changes' : 'Unstaged changes'}</span>
          {entry.partiallyStaged && (
            <>
              <span>·</span>
              <span style={{ color: t.warning }}>partially staged</span>
            </>
          )}
        </div>
      </div>
      {!stagedView && (
        <>
          <button onClick={onDiscard} style={miniBtn(t)}>Discard</button>
          <button onClick={onStage} style={miniBtn(t, 'primary')}>Stage</button>
        </>
      )}
      {stagedView && (
        <button onClick={onUnstage} style={miniBtn(t)}>Unstage</button>
      )}
    </div>
  );
}

// ---------- Diff Pane ----------

function DiffPane({ t, diff }: { t: Theme; diff: string }) {
  if (!diff.trim()) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: t.textMuted, fontSize: 13, background: t.appBg,
      }}>
        No textual diff (binary file or empty change)
      </div>
    );
  }
  return (
    <div
      style={{
        flex: 1, overflow: 'auto', background: t.cellBg,
        fontFamily: t.fontMono, fontSize: 12, lineHeight: '20px',
      }}
    >
      {parseDiff(diff).map((line, i) => (
        <DiffLine key={i} t={t} line={line} />
      ))}
    </div>
  );
}

interface ParsedLine {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNum: number | null;
  newNum: number | null;
}

function parseDiff(diff: string): ParsedLine[] {
  // We skip the diff/index/+++/--- headers (kind 'meta' is filtered out).
  // Hunks reset old/new line counters; subsequent lines increment them
  // per their kind. Stops at 1000 lines so a giant diff doesn't tank
  // rendering — users with huge diffs can fall back to terminal git.
  const out: ParsedLine[] = [];
  let oldN = 0, newN = 0;
  const lines = diff.split('\n');
  let count = 0;
  for (const line of lines) {
    if (count++ > 1000) {
      out.push({ kind: 'meta', text: '… diff truncated (over 1000 lines)', oldNum: null, newNum: null });
      break;
    }
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('+++ ') || line.startsWith('--- ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldN = Number(m[1]); newN = Number(m[2]); }
      out.push({ kind: 'hunk', text: line, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), oldNum: null, newNum: newN++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNum: oldN++, newNum: null });
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'meta', text: line, oldNum: null, newNum: null });
    } else {
      out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNum: oldN++, newNum: newN++ });
    }
  }
  return out;
}

function DiffLine({ t, line }: { t: Theme; line: ParsedLine }) {
  if (line.kind === 'hunk') {
    return (
      <div
        style={{
          display: 'grid', gridTemplateColumns: '80px 1fr',
          background: `${t.accent}14`,
          borderTop: `1px solid ${t.accent}30`,
          borderBottom: `1px solid ${t.accent}30`,
          color: t.accent,
        }}
      >
        <div style={{ padding: '2px 10px', textAlign: 'right', borderRight: `1px solid ${t.accent}30`, color: t.textMuted }}>⋯</div>
        <div style={{ padding: '2px 12px', whiteSpace: 'pre' }}>{line.text}</div>
      </div>
    );
  }
  if (line.kind === 'meta') {
    return <div style={{ padding: '2px 12px', color: t.textMuted, fontStyle: 'italic' }}>{line.text}</div>;
  }
  const colors = {
    add: { bg: `${t.success}18`, gutter: `${t.success}55`, ch: '+', chColor: t.success },
    del: { bg: `${t.error}18`, gutter: `${t.error}55`, ch: '−', chColor: t.error },
    ctx: { bg: 'transparent', gutter: t.cellBorder, ch: ' ', chColor: t.textMuted },
  }[line.kind];
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '40px 40px 20px 1fr',
        background: colors.bg,
        borderLeft: `3px solid ${colors.gutter}`,
      }}
    >
      <div style={{ padding: '0 6px', color: t.textMuted, textAlign: 'right', userSelect: 'none' }}>
        {line.oldNum ?? ''}
      </div>
      <div style={{ padding: '0 6px', color: t.textMuted, textAlign: 'right', userSelect: 'none', borderRight: `1px solid ${t.cellBorder}` }}>
        {line.newNum ?? ''}
      </div>
      <div style={{ padding: '0 4px', color: colors.chColor, textAlign: 'center', userSelect: 'none' }}>
        {colors.ch}
      </div>
      <div style={{ padding: '0 10px', whiteSpace: 'pre', color: t.textPrimary, overflow: 'hidden' }}>
        {line.text}
      </div>
    </div>
  );
}

function DiffEmpty({ t, hasFiles }: { t: Theme; hasFiles: boolean }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 8,
      color: t.textMuted, fontSize: 13, background: t.appBg,
    }}>
      <GitCommit size={28} strokeWidth={1.5} color={t.textMuted} style={{ opacity: 0.4 }} />
      {hasFiles ? 'Select a file to view its diff' : 'Working tree clean — no changes to review'}
    </div>
  );
}

// ---------- Commit Bar ----------

interface CommitBarProps {
  t: Theme;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  stagedCount: number;
  unstagedCount: number;
  onCommit: () => void;
  onCommitAndPush: () => void;
  busy: string | null;
}

function CommitBar({ t, commitMsg, setCommitMsg, stagedCount, unstagedCount, onCommit, onCommitAndPush, busy }: CommitBarProps) {
  const willStageAll = stagedCount === 0 && unstagedCount > 0;
  const noChanges = stagedCount === 0 && unstagedCount === 0;
  const hint = willStageAll
    ? `Will stage all ${unstagedCount} change${unstagedCount === 1 ? '' : 's'} and commit`
    : stagedCount > 0
      ? `Committing ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`
      : 'Nothing to commit';
  return (
    <div
      style={{
        padding: '12px 20px',
        borderTop: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ fontSize: 10, color: t.textMuted, letterSpacing: '0.04em' }}>{hint}</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onCommit();
            }
          }}
          placeholder="Commit message (⌘↵ to commit)…"
          style={{
            flex: 1,
            background: t.appBg, color: t.textPrimary,
            border: `1px solid ${t.cellBorder}`, borderRadius: 6,
            padding: '7px 10px', fontSize: 12, outline: 'none',
            fontFamily: t.font,
          }}
        />
        <button
          onClick={onCommit}
          disabled={!!busy || noChanges || !commitMsg.trim()}
          style={{
            ...miniBtn(t),
            padding: '7px 12px', fontSize: 12, opacity: noChanges || !commitMsg.trim() ? 0.45 : 1,
          }}
        >
          Commit
        </button>
        <button
          onClick={onCommitAndPush}
          disabled={!!busy || noChanges || !commitMsg.trim()}
          style={{
            background: t.success, color: '#fff',
            border: `1px solid ${t.success}`,
            padding: '7px 14px', borderRadius: 6,
            fontSize: 12, fontWeight: 500, cursor: 'pointer',
            opacity: (noChanges || !commitMsg.trim()) ? 0.5 : 1,
            fontFamily: t.font,
          }}
        >
          Commit & Push
        </button>
      </div>
    </div>
  );
}

// ---------- Toast / NotARepo ----------

function Toast({ t, kind, text }: { t: Theme; kind: 'ok' | 'err'; text: string }) {
  const color = kind === 'ok' ? t.success : t.error;
  return (
    <div style={{
      position: 'absolute', bottom: 80, right: 24,
      background: t.cellBg, border: `1px solid ${color}55`,
      borderLeft: `3px solid ${color}`, borderRadius: 6,
      padding: '8px 14px', fontSize: 12, color: t.textPrimary,
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)', maxWidth: 420, zIndex: 200,
    }}>
      {text}
    </div>
  );
}

function NotARepo({ t }: { t: Theme }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 12, padding: 40, background: t.appBg,
    }}>
      <GitBranch size={36} strokeWidth={1.5} color={t.textMuted} style={{ opacity: 0.5 }} />
      <div style={{ fontSize: 16, fontWeight: 600, color: t.textPrimary }}>Not a git repository</div>
      <div style={{ fontSize: 13, color: t.textMuted, maxWidth: 420, textAlign: 'center' }}>
        Initialize this folder with <code style={{ fontFamily: t.fontMono }}>git init</code> to start tracking changes.
      </div>
    </div>
  );
}
