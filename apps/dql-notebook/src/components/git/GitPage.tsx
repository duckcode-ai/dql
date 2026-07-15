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
  Search, ChevronDown, X, Plus, Check, ExternalLink, ShieldCheck,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api, type GitGovernedContextGroup } from '../../api/client';

type Status = Awaited<ReturnType<typeof api.fetchGitStatus>>;
type RawChange = Status['changes'][number];
type GovernedContext = Awaited<ReturnType<typeof api.fetchGitGovernedContext>>;

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
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [reviewMode, setReviewMode] = useState<'plain' | 'code'>('plain');
  const [governedContext, setGovernedContext] = useState<GovernedContext | null>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, b, r, context] = await Promise.all([
        api.fetchGitStatus(),
        api.fetchGitBranches(),
        api.fetchGitRemote(),
        api.fetchGitGovernedContext(),
      ]);
      // Keep a background poll invisible when nothing actually changed. In
      // particular, do not replace the selected-file status every four seconds.
      setStatus((previous) => sameGitStatus(previous, s) ? previous : s);
      setBranchInfo((previous) => previous.current === b.current && sameStringList(previous.branches, b.branches)
        ? previous
        : { current: b.current, branches: b.branches });
      setRemote((previous) => previous.url === r.url && previous.name === r.name ? previous : { url: r.url, name: r.name });
      setGovernedContext(context);
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

  const selectedFileStatus = useMemo(
    () => (status?.changes ?? []).map((change) => `${change.status}:${change.path}`).sort().join('|'),
    [status],
  );

  // A selected diff changes only when its file/status changes, not whenever the
  // quiet Git poll receives an identical status response. This removes the
  // distracting blank/loading flicker while someone is reviewing a file.
  useEffect(() => {
    if (!selectedPath) {
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setDiff(null);
    void api.fetchGitDiff(selectedPath, selectedStaged)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) setDiffError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedPath, selectedStaged, selectedFileStatus]);

  const entries = useMemo(() => expandChanges(status?.changes ?? []), [status?.changes]);
  const stagedFiles = entries.filter((e) => e.staged);
  const unstagedFiles = entries.filter((e) => !e.staged);

  const filterFn = useCallback((f: FileEntry) => {
    if (statusFilter !== 'all' && f.status !== statusFilter) return false;
    if (query && !f.path.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }, [statusFilter, query]);

  const filteredStaged = stagedFiles.filter(filterFn).sort(compareArtifactEntries);
  const filteredUnstaged = unstagedFiles.filter(filterFn).sort(compareArtifactEntries);

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
  const onRequestReview = async () => {
    const title = commitMsg.trim();
    if (!title) return flash('err', 'Review title required');
    // Only the explicitly included set enters the guided review. This keeps
    // an unstaged local edit from riding along with an otherwise safe request.
    const paths = Array.from(new Set(stagedFiles.map((entry) => entry.path)));
    if (paths.length === 0) return flash('err', 'No changes to request review for');
    const review = await runOp('request review', () => api.gitCreateReview({
      paths,
      title,
      body: 'Created from DQL Source Control. Review the governed analytics changes before merging.',
      base: 'main',
    }));
    if (!review.ok) return;
    setCommitMsg('');
    setReviewUrl(review.prUrl ?? null);
    flash('ok', review.warning ?? `Review branch ${review.branch ?? ''} is ready${review.prUrl ? '.' : '; create the PR from your Git host.'}`);
  };
  const onEnableGovernedTracking = async () => {
    const result = await runOp('enable governed tracking', () => api.enableGitGovernedContextTracking());
    if (result.ok) flash('ok', 'Domains and project skills are now included in source control.');
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
  const prUrl = useMemo(
    () => reviewUrl ?? githubCompareUrl(remote.url, branchInfo.current),
    [remote.url, branchInfo.current, reviewUrl],
  );

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
        prUrl={prUrl}
        onCheckout={onCheckout}
        branchMenuOpen={branchMenuOpen}
        setBranchMenuOpen={setBranchMenuOpen}
        newBranchOpen={newBranchOpen}
        setNewBranchOpen={setNewBranchOpen}
        newBranchName={newBranchName}
        setNewBranchName={setNewBranchName}
        onCreateBranch={onCreateBranch}
        branchMenuRef={branchMenuRef}
        advancedOpen={advancedOpen}
        onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
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
          {selectedEntry ? (
            <>
              <FileDiffHeader
                t={t}
                entry={selectedEntry}
                onStage={() => onStage(selectedEntry.path)}
                onUnstage={() => onUnstage(selectedEntry.path)}
                onDiscard={() => onDiscard(selectedEntry.path)}
                stagedView={selectedStaged}
                reviewMode={reviewMode}
                onReviewMode={setReviewMode}
              />
              <DiffBody
                t={t}
                diff={diff?.diff ?? ''}
                entry={selectedEntry}
                loading={diffLoading}
                error={diffError}
                reviewMode={reviewMode}
              />
            </>
          ) : (
            <DiffEmpty t={t} hasFiles={entries.length > 0} />
          )}
        </div>
        <ShareFlow
          t={t}
          commitMsg={commitMsg}
          setCommitMsg={setCommitMsg}
          includedCount={stagedFiles.length}
          totalCount={entries.length}
          branch={branchInfo.current}
          reviewUrl={reviewUrl}
          onCommit={onCommit}
          onCommitAndPush={onCommitAndPush}
          onRequestReview={onRequestReview}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
          busy={busy}
          context={governedContext}
          onEnableTracking={onEnableGovernedTracking}
        />
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
  prUrl: string | null;
  onCheckout: (name: string) => void;
  branchMenuOpen: boolean;
  setBranchMenuOpen: (v: boolean) => void;
  newBranchOpen: boolean;
  setNewBranchOpen: (v: boolean) => void;
  newBranchName: string;
  setNewBranchName: (v: string) => void;
  onCreateBranch: () => void;
  branchMenuRef: React.RefObject<HTMLDivElement>;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
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
      <span style={{ fontSize: 12.5, fontWeight: 650, color: t.textSecondary }}>Your workspace · <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textPrimary }}>{p.branchCurrent ?? 'local workspace'}</span></span>
      <span style={{ fontSize: 11, color: p.behind > 0 ? t.warning : t.success }}>{p.behind > 0 ? `${p.behind} update${p.behind === 1 ? '' : 's'} available` : p.ahead > 0 ? `${p.ahead} update${p.ahead === 1 ? '' : 's'} ready to share` : 'Everything up to date'}</span>

      <div ref={p.branchMenuRef} style={{ position: 'relative', display: p.advancedOpen ? 'block' : 'none' }}>
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

      <div style={{ flex: 1 }} />

      <button onClick={p.onRefresh} title="Refresh" style={{
        background: 'transparent', border: `1px solid ${t.btnBorder}`,
        padding: '6px 8px', borderRadius: 5, cursor: 'pointer', color: t.textMuted,
      }}>
        <RefreshCw size={12} strokeWidth={1.75} style={{ animation: p.refreshing ? 'dql-spin 0.6s linear' : undefined }} />
      </button>
      <style>{`@keyframes dql-spin { to { transform: rotate(360deg); } }`}</style>

      <button onClick={p.onPull} disabled={!!p.busy} style={topBtn(t)} title="Bring in the latest approved shared work">
        <ArrowDown size={12} strokeWidth={1.75} />
        Update from main
        {p.behind > 0 && <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, marginLeft: 2 }}>{p.behind}</span>}
      </button>
      <button onClick={p.onToggleAdvanced} style={topBtn(t)} title="Advanced versioning tools">{p.advancedOpen ? 'Hide advanced' : 'Advanced'}</button>
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

function githubCompareUrl(remoteUrl: string | null, branch: string | null): string | null {
  if (!remoteUrl || !branch || branch === 'main' || branch === 'master' || branch === 'HEAD') return null;
  const pretty = prettyRemote(remoteUrl);
  const match = /(?:^|\/)github\.com\/([^/]+\/[^/]+)$/.exec(pretty);
  if (!match) return null;
  return `https://github.com/${match[1]}/compare/${encodeURIComponent(branch)}?expand=1`;
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameGitStatus(left: Status | null, right: Status): boolean {
  return Boolean(left)
    && left!.inRepo === right.inRepo
    && left!.branch === right.branch
    && left!.ahead === right.ahead
    && left!.behind === right.behind
    && left!.changes.length === right.changes.length
    && left!.changes.every((change, index) => change.path === right.changes[index]?.path && change.status === right.changes[index]?.status);
}

function GitFlowGuide({
  t,
  changeCount,
  branch,
  advancedOpen,
  onToggleAdvanced,
  context,
  onEnableTracking,
}: {
  t: Theme;
  changeCount: number;
  branch: string | null;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  context: GovernedContext | null;
  onEnableTracking: () => void;
}) {
  const steps = [
    { label: 'Review changes', detail: changeCount === 0 ? 'Everything is up to date' : `${changeCount} change${changeCount === 1 ? '' : 's'} ready to review` },
    { label: 'Describe your update', detail: 'Use plain language' },
    { label: 'Request review', detail: 'Creates a branch and pull request' },
  ];
  return (
    <div style={{ display: 'grid', gap: 9, padding: '9px 20px', background: t.sidebarBg, borderBottom: `1px solid ${t.headerBorder}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 170 }}>
        <div style={{ fontSize: 12, fontWeight: 720, color: t.textPrimary }}>Share changes safely</div>
        <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>Nothing merges automatically.</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 300, flexWrap: 'wrap' }}>
        {steps.map((step, index) => (
          <React.Fragment key={step.label}>
            {index > 0 && <span style={{ color: t.textMuted, fontSize: 12 }}>→</span>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${t.accent}18`, color: t.accent, fontSize: 10, fontWeight: 750 }}>{index + 1}</span>
              <div>
                <div style={{ fontSize: 11, color: t.textPrimary, fontWeight: 650 }}>{step.label}</div>
                <div style={{ fontSize: 9, color: t.textMuted }}>{step.detail}</div>
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
      <button type="button" onClick={onToggleAdvanced} style={miniBtn(t)}>
        {advancedOpen ? 'Hide Git details' : 'Git details'}
      </button>
      {branch && branch !== 'main' && branch !== 'master' && <span style={{ fontSize: 10, color: t.success }}>Review branch: {branch}</span>}
      </div>
      {context && <GovernedContextSummary t={t} context={context} onEnableTracking={onEnableTracking} />}
    </div>
  );
}

function GovernedContextSummary({ t, context, onEnableTracking }: { t: Theme; context: GovernedContext; onEnableTracking: () => void }) {
  const groupSummary = (label: string, group: GitGovernedContextGroup) => {
    if (group.total === 0) return `${label}: none yet`;
    if (group.ignored > 0) return `${label}: ${group.total} found · ${group.ignored} hidden from Git`;
    if (group.changed > 0 || group.untracked > 0) return `${label}: ${group.total} · ${group.changed + group.untracked} need review`;
    return `${label}: ${group.total} tracked`;
  };
  const needsRepair = context.domains.ignored > 0 || context.skills.ignored > 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: needsRepair ? `${t.warning}10` : `${t.success}0d`, border: `1px solid ${needsRepair ? `${t.warning}45` : `${t.success}35`}`, borderRadius: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: '0.05em', textTransform: 'uppercase', color: needsRepair ? t.warning : t.success }}>Governed context</span>
      <span style={{ fontSize: 11, color: t.textPrimary }}>{groupSummary('Domains', context.domains)}</span>
      <span style={{ color: t.textMuted }}>·</span>
      <span style={{ fontSize: 11, color: t.textPrimary }}>{groupSummary('Skills', context.skills)}</span>
      <div style={{ flex: 1 }} />
      {needsRepair ? (
        <>
          <span style={{ fontSize: 10, color: t.textMuted }}>A legacy local folder is hiding shared guidance.</span>
          <button type="button" onClick={onEnableTracking} style={miniBtn(t, 'primary')}>Move skills to source control</button>
        </>
      ) : (
        <span style={{ fontSize: 10, color: t.textMuted }}>Shared project source</span>
      )}
    </div>
  );
}

type ArtifactGroupId = 'business' | 'apps' | 'notebooks' | 'generated' | 'local';

interface ArtifactGroup {
  id: ArtifactGroupId;
  label: string;
  tone: 'good' | 'neutral' | 'warn' | 'danger';
  rank: number;
}

function artifactGroupForPath(path: string): ArtifactGroup {
  if (path.startsWith('.dql/local/') || /ai[-_]?pin|saved[-_]?view|layout[-_]?override/i.test(path)) {
    return { id: 'local', label: 'Local/private', tone: 'danger', rank: 4 };
  }
  if (path.startsWith('.dql/cache/') || path.startsWith('.dql/imports/') || path.startsWith('data/') || path === 'dql-manifest.json' || /\.run\.json$/i.test(path) || /\.(sqlite|duckdb|duckdb\.wal)$/i.test(path)) {
    return { id: 'generated', label: 'Generated', tone: 'warn', rank: 3 };
  }
  if (/\.dqlnb$/i.test(path)) {
    return { id: 'notebooks', label: 'Curated notebook', tone: 'neutral', rank: 2 };
  }
  if (/\/apps\/[^/]+\/dql\.app\.json$/.test(path) || /^apps\/[^/]+\/dql\.app\.json$/.test(path) || /\/dashboards\/[^/]+\.dqld$/.test(path) || /^apps\/[^/]+\/dashboards\/[^/]+\.dqld$/.test(path)) {
    return { id: 'apps', label: 'Shared app', tone: 'neutral', rank: 1 };
  }
  if (path.startsWith('skills/') || path.startsWith('.dql/skills/') || /^domains\/[^/]+\/domain\.dql$/i.test(path)) {
    return { id: 'business', label: 'Governed context', tone: 'good', rank: 0 };
  }
  if (/\.dql$/i.test(path) || path.startsWith('semantic-layer/') || /\.(ya?ml)$/i.test(path) || path === 'dql.config.json' || path === 'package.json') {
    return { id: 'business', label: 'Business logic', tone: 'good', rank: 0 };
  }
  return { id: 'apps', label: 'Shared source', tone: 'neutral', rank: 1 };
}

function compareArtifactEntries(a: FileEntry, b: FileEntry): number {
  const groupA = artifactGroupForPath(a.path);
  const groupB = artifactGroupForPath(b.path);
  return groupA.rank - groupB.rank || a.path.localeCompare(b.path);
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
          Workspace changes
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary }}>
            Your changes
          </span>
          <span style={{ fontSize: 11, color: t.textMuted }}>{p.totalCount} files</span>
          <div style={{ flex: 1 }} />
          {p.unstagedFiles.length > 0 && (
            <button onClick={p.onStageAll} style={miniBtn(t)}>Include all</button>
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
        <SectionHeader t={t} label="Included" count={p.stagedFiles.length} />
        {p.stagedFiles.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 10px', fontStyle: 'italic' }}>
            No files included yet
          </div>
        ) : (
          p.stagedFiles.map((f) => (
            <FileRow
              key={`staged-${f.path}`}
              t={t}
              file={f}
              active={p.selectedPath === f.path && p.selectedStaged === true}
              onClick={() => p.onSelect(f.path, true)}
              actionLabel="Remove"
              onAction={() => p.onUnstage(f.path)}
            />
          ))
        )}

        <div style={{ height: 8 }} />
        <SectionHeader t={t} label="Needs review" count={p.unstagedFiles.length} />
        {p.unstagedFiles.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 10px', fontStyle: 'italic' }}>
            {p.totalCount === 0 ? 'Everything is up to date' : 'No additional files to review'}
          </div>
        ) : (
          p.unstagedFiles.map((f) => (
            <FileRow
              key={`unstaged-${f.path}`}
              t={t}
              file={f}
              active={p.selectedPath === f.path && p.selectedStaged === false}
              onClick={() => p.onSelect(f.path, false)}
              actionLabel="Include"
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
  const group = artifactGroupForPath(file.path);
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
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={artifactGroupPillStyle(t, group)}>{group.label}</span>
        </div>
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

function artifactGroupPillStyle(t: Theme, group: ArtifactGroup): React.CSSProperties {
  const color = group.tone === 'good'
    ? t.success
    : group.tone === 'warn'
      ? t.warning
      : group.tone === 'danger'
        ? t.error
        : t.textMuted;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '100%',
    border: `1px solid ${color}35`,
    background: `${color}12`,
    color,
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: 9,
    fontWeight: 650,
    lineHeight: '14px',
    whiteSpace: 'nowrap',
  };
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
  reviewMode: 'plain' | 'code';
  onReviewMode: (mode: 'plain' | 'code') => void;
}

function FileDiffHeader({ t, entry, stagedView, onStage, onUnstage, onDiscard, reviewMode, onReviewMode }: FileDiffHeaderProps) {
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
          <span>{stagedView ? 'Included in your next update' : 'Needs review'}</span>
          {entry.partiallyStaged && (
            <>
              <span>·</span>
              <span style={{ color: t.warning }}>partially staged</span>
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.appBg }}>
        <button onClick={() => onReviewMode('plain')} style={reviewToggle(t, reviewMode === 'plain')}>What changed</button>
        <button onClick={() => onReviewMode('code')} style={reviewToggle(t, reviewMode === 'code')}>Code view</button>
      </div>
      {!stagedView && (
        <>
          <button onClick={onDiscard} style={miniBtn(t)}>Discard</button>
          <button onClick={onStage} style={miniBtn(t, 'primary')}>Include</button>
        </>
      )}
      {stagedView && (
        <button onClick={onUnstage} style={miniBtn(t)}>Remove</button>
      )}
    </div>
  );
}

// ---------- Diff Pane ----------

function DiffBody({
  t,
  diff,
  entry,
  loading,
  error,
  reviewMode,
}: {
  t: Theme;
  diff: string;
  entry: FileEntry;
  loading: boolean;
  error: string | null;
  reviewMode: 'plain' | 'code';
}) {
  if (loading) {
    return <DiffStatus t={t} title="Loading diff" body="Preparing the selected change for review." />;
  }
  if (error) {
    return <DiffStatus t={t} title="Could not load diff" body={error} tone="error" />;
  }
  return reviewMode === 'plain' ? <PlainDiffSummary t={t} diff={diff} entry={entry} /> : <DiffPane t={t} diff={diff} entry={entry} />;
}

function PlainDiffSummary({ t, diff, entry }: { t: Theme; diff: string; entry: FileEntry }) {
  const parsed = parseDiff(diff);
  const added = parsed.filter((line) => line.kind === 'add').length;
  const removed = parsed.filter((line) => line.kind === 'del').length;
  const summaries = [
    added > 0 ? { icon: '+', tone: t.success, text: `Added ${added} line${added === 1 ? '' : 's'} of reviewed workspace content.` } : null,
    removed > 0 ? { icon: '−', tone: t.warning, text: `Updated or replaced ${removed} existing line${removed === 1 ? '' : 's'}.` } : null,
    { icon: '✓', tone: t.accent, text: `${artifactKind(entry.path)} remains inside the same governed project scope.` },
  ].filter(Boolean) as Array<{ icon: string; tone: string; text: string }>;
  return <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, background: t.appBg }}><div style={{ maxWidth: 590, display: 'grid', gap: 10 }}><div style={{ color: t.textMuted, fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase' }}>Summary of this change</div><div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 10, background: t.cellBg, overflow: 'hidden' }}>{summaries.map((item) => <div key={item.text} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 13px', borderBottom: `1px solid ${t.headerBorder}`, color: t.textPrimary, fontSize: 12.5, lineHeight: 1.5 }}><span style={{ width: 18, height: 18, flex: '0 0 auto', borderRadius: 5, display: 'grid', placeItems: 'center', color: item.tone, background: `${item.tone}16`, fontWeight: 800 }}>{item.icon}</span>{item.text}</div>)}</div><div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', border: `1px solid ${t.success}40`, background: `${t.success}0d`, borderRadius: 10, padding: '10px 13px', color: t.success, fontSize: 11.5, lineHeight: 1.5 }}><ShieldCheck size={13} style={{ flex: '0 0 auto', marginTop: 1 }} /><span>Safe to review — only the files you explicitly include will be shared. Unselected work stays in your workspace.</span></div></div></div>;
}

function artifactKind(path: string): string { if (path.includes('/blocks/')) return 'This block'; if (path.includes('/domains/')) return 'This domain definition'; if (path.includes('/apps/')) return 'This app'; if (path.includes('/notebooks/')) return 'This notebook'; return 'This file'; }
function reviewToggle(t: Theme, active: boolean): React.CSSProperties { return { border: 0, borderRadius: 5, padding: '4px 10px', background: active ? t.cellBg : 'transparent', color: active ? t.textPrimary : t.textMuted, fontSize: 10.5, fontWeight: 650, cursor: 'pointer', boxShadow: active ? '0 1px 3px rgba(0,0,0,.08)' : undefined }; }

function DiffPane({ t, diff, entry }: { t: Theme; diff: string; entry: FileEntry }) {
  if (!diff.trim()) {
    return (
      <DiffStatus
        t={t}
        title="No text hunks to review"
        body={
          entry.status === '?'
            ? 'This new item does not expose a readable text preview yet. Include it to share the complete file.'
            : 'This file changed, but there are no line-level text details for this selection.'
        }
      />
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

function DiffStatus({
  t,
  title,
  body,
  tone = 'muted',
}: {
  t: Theme;
  title: string;
  body: string;
  tone?: 'muted' | 'error';
}) {
  const color = tone === 'error' ? t.error : t.textMuted;
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: t.appBg,
      padding: 32,
    }}>
      <div style={{
        maxWidth: 420,
        border: `1px solid ${tone === 'error' ? `${t.error}55` : t.cellBorder}`,
        background: t.cellBg,
        borderRadius: 8,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: tone === 'error' ? t.error : t.textPrimary }}>
          {title}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, color }}>
          {body}
        </div>
      </div>
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
    if (
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('Binary file ') ||
      line.startsWith('# ')
    ) {
      out.push({ kind: 'meta', text: line, oldNum: null, newNum: null });
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

interface ShareFlowProps {
  t: Theme;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  includedCount: number;
  totalCount: number;
  branch: string | null;
  reviewUrl: string | null;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onRequestReview: () => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  busy: string | null;
  context: GovernedContext | null;
  onEnableTracking: () => void;
}

function ShareFlow({ t, commitMsg, setCommitMsg, includedCount, totalCount, branch, reviewUrl, onCommit, onCommitAndPush, onRequestReview, advancedOpen, onToggleAdvanced, busy, context, onEnableTracking }: ShareFlowProps) {
  const noChanges = totalCount === 0;
  const steps = [
    { title: 'Pick what to share', body: `${includedCount} of ${totalCount} change${totalCount === 1 ? '' : 's'} selected in the left panel.`, complete: includedCount > 0 },
    { title: 'Describe your change', body: 'Use plain language so a teammate understands the intent.', complete: Boolean(commitMsg.trim()) },
    { title: 'Share to your branch', body: `Saves only the selected work to ${branch ?? 'a review branch'}; main stays untouched.`, complete: Boolean(reviewUrl) },
    { title: 'Ask for review', body: reviewUrl ? 'The review request is ready for a teammate.' : 'A teammate approves before anything reaches main.', complete: Boolean(reviewUrl) },
  ];
  return (
    <div
      style={{
        width: 'clamp(280px, 26vw, 350px)',
        padding: 0,
        borderLeft: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        flexShrink: 0,
        display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto',
      }}
    >
      <div style={{ padding: '14px 16px 12px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{ fontSize: 13, fontWeight: 750, color: t.textPrimary }}>Share your work</div>
        <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>Four guided steps — no command line needed.</div>
      </div>
      <div style={{ padding: '14px 16px 18px', display: 'flex', flexDirection: 'column' }}>
        {steps.map((step, index) => (
          <div key={step.title} style={{ display: 'flex', gap: 11 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <span style={{ width: 24, height: 24, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 750, background: step.complete ? `${t.success}18` : `${t.accent}12`, color: step.complete ? t.success : t.accent, border: `1.5px solid ${step.complete ? `${t.success}55` : `${t.accent}45`}` }}>{step.complete ? <Check size={13} strokeWidth={2.4} /> : index + 1}</span>
              {index < steps.length - 1 && <span style={{ width: 1.5, flex: 1, minHeight: 22, background: t.headerBorder, margin: '4px 0' }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingBottom: index === steps.length - 1 ? 2 : 18 }}>
              <div style={{ fontSize: 12.5, fontWeight: 680, color: t.textPrimary }}>{step.title}</div>
              <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.5, marginTop: 2 }}>{step.body}</div>
              {index === 1 && !reviewUrl && <textarea value={commitMsg} onChange={(event) => setCommitMsg(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void onRequestReview(); } }} rows={3} placeholder="What did you change, in plain words?" style={{ width: '100%', boxSizing: 'border-box', marginTop: 7, border: `1px solid ${t.cellBorder}`, background: t.appBg, color: t.textPrimary, borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.5, fontFamily: t.font, outline: 'none', resize: 'vertical' }} />}
              {index === 2 && !reviewUrl && <button onClick={onRequestReview} disabled={!!busy || noChanges || !commitMsg.trim()} style={{ ...topBtn(t, true), marginTop: 8, opacity: (busy || noChanges || !commitMsg.trim()) ? 0.5 : 1 }}>{busy ? 'Sharing…' : 'Share & request review'}</button>}
              {index === 3 && reviewUrl && <a href={reviewUrl} target="_blank" rel="noreferrer" style={{ ...topBtn(t, true), display: 'inline-flex', marginTop: 8, textDecoration: 'none' }}><ExternalLink size={12} /> View review request</a>}
            </div>
          </div>
        ))}
        <button onClick={onToggleAdvanced} style={{ ...miniBtn(t), alignSelf: 'flex-start', marginTop: 12 }}>{advancedOpen ? 'Hide advanced' : 'Advanced'}</button>
      </div>
      {advancedOpen && (
        <div style={{ display: 'grid', gap: 8, margin: '0 16px 16px', padding: 10, border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.appBg }}>
          <span style={{ fontSize: 10, color: t.textMuted }}>Optional direct Git actions. Neither action merges changes.</span>
          <div style={{ display: 'flex', gap: 8 }}><button onClick={onCommit} disabled={!!busy || noChanges || !commitMsg.trim()} style={{ ...miniBtn(t), opacity: noChanges || !commitMsg.trim() ? 0.45 : 1 }}>Save locally</button>
          <button onClick={onCommitAndPush} disabled={!!busy || noChanges || !commitMsg.trim()} style={{ ...miniBtn(t), opacity: noChanges || !commitMsg.trim() ? 0.45 : 1 }}>Commit & push</button></div>
        </div>
      )}
      {context && <div style={{ margin: 'auto 12px 12px' }}><GovernedContextSummary t={t} context={context} onEnableTracking={onEnableTracking} /></div>}
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
      <div style={{ fontSize: 16, fontWeight: 600, color: t.textPrimary }}>This folder is not versioned yet</div>
      <div style={{ fontSize: 13, color: t.textMuted, maxWidth: 420, textAlign: 'center' }}>
        Initialize source control for this workspace before reviewing and sharing changes.
      </div>
    </div>
  );
}
