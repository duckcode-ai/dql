import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Plus, MessageSquare, Trash2, Loader2, ShieldCheck, Star, Pencil } from 'lucide-react';
import { api, type AgentConversationThread } from '../../api/client';
import { makeCell, useDispatch, useNotebookStore } from '../../store/NotebookStore';
import type { Cell } from '../../store/types';
import { initialDomainScope, persistDomainScope, type DomainScope } from './domain-scope';
import { themes, type Theme } from '../../themes/notebook-theme';
import { focusInsertedNotebookCell } from '../../utils/notebook-cell-focus';
import {
  correctionProvenanceForDraft,
  useOpenAnswerInNotebook,
} from '../../utils/answer-to-notebook';
import {
  UnifiedAgentRunPanel,
  type InsertDqlPayload,
  type SqlNotebookDraftMeta,
  type ThreadItem,
} from '../agent/UnifiedAgentRunPanel';

/**
 * Analytics Home — the stakeholder ChatGPT-style entry. Text→SQL questions run
 * through the governed agent loop; answers, research reports, and app drafts render
 * as rich messages. Authoring stays in the Notebook; this surface is consumption.
 *
 * Conversations are persisted locally (per browser) so a stakeholder can start a
 * new chat, browse past chats, and resume one — like ChatGPT. The agent runs
 * themselves are already governed + stored server-side; this just keeps the
 * conversation threads grouped and resumable.
 */

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: ThreadItem[];
  /** Server-side conversation thread id — the runs' turns persist server-side too. */
  threadId?: string;
  /** Pinned by the user; pinned chats are listed in their own group. */
  favorite?: boolean;
}

const STORAGE_KEY = 'dql-ask-conversations';
const ACTIVE_CONVERSATION_STORAGE_KEY = 'dql-ask-active-conversation';
const DELETED_THREAD_STORAGE_KEY = 'dql-ask-deleted-thread-queue';
const MAX_CONVERSATIONS = 100;

function askNotebookCellName(value: string | undefined): string {
  const clean = (value ?? 'AI analysis')
    .replace(/[^a-zA-Z0-9_ -]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return clean || 'ai_analysis';
}

/** Build the exact editable Notebook cell used by Ask failure-repair handoffs. */
export function askNotebookCellFromPayload(payload: InsertDqlPayload): Cell | undefined {
  const dqlSource = payload.dqlArtifact?.source?.trim();
  const sql = payload.sql?.trim();
  const content = dqlSource || sql;
  if (!content) return undefined;
  const cell = makeCell(dqlSource ? 'dql' : 'sql', content);
  cell.name = askNotebookCellName(payload.title ?? payload.dqlArtifact?.name);
  if (payload.result) {
    cell.result = payload.result;
    cell.status = 'success';
    cell.executionCount = 1;
  }
  if (payload.chartConfig) cell.chartConfig = payload.chartConfig;
  cell.correctionProvenance = correctionProvenanceForDraft({
    question: payload.question,
    generatedSql: payload.sql ?? payload.dqlArtifact?.compiledSql,
    generatedDql: dqlSource,
    sourceRunId: payload.sourceRunId,
  });
  if (payload.dqlArtifact) {
    cell.dqlArtifact = {
      source: payload.dqlArtifact.source,
      sql: payload.sql,
      name: payload.dqlArtifact.name,
      sourcePath: payload.dqlArtifact.sourcePath,
      kind: payload.dqlArtifact.kind,
      metrics: payload.dqlArtifact.metrics,
      dimensions: payload.dqlArtifact.dimensions,
      parameters: payload.dqlArtifact.parameters,
      parameterValues: payload.dqlArtifact.parameterValues,
      persistence: payload.dqlArtifact.persistence,
      trustState: payload.dqlArtifact.trustState,
      compiledSql: payload.dqlArtifact.compiledSql ?? payload.sql,
      reviewState: payload.dqlArtifact.trustState === 'certified' ? 'certified' : 'review_required',
      ...(payload.question ? { question: payload.question } : {}),
    };
    cell.dqlParameterValues = payload.dqlArtifact.parameterValues;
  }
  return cell;
}

function makeConversationId(): string {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function recoveredConversationId(threadId: string): string {
  return `conv_server_${threadId}`;
}

/**
 * Browser storage is only a rendering cache. Rebuild the sidebar from durable
 * project threads so a new port, browser profile, or frontend upgrade does not
 * make existing conversations appear to be gone.
 */
export function mergePersistedAskConversations(
  local: Conversation[],
  threads: AgentConversationThread[],
  deletedThreadIds: ReadonlySet<string> = new Set(),
): Conversation[] {
  const visibleThreads = threads.filter((thread) => !deletedThreadIds.has(thread.id));
  const localByThread = new Map(
    local.flatMap((conversation) => conversation.threadId ? [[conversation.threadId, conversation] as const] : []),
  );
  const recovered = visibleThreads.map((thread): Conversation => {
    const existing = localByThread.get(thread.id);
    return {
      id: existing?.id ?? recoveredConversationId(thread.id),
      // A server title is authoritative: it is what the user typed when they
      // renamed the chat. Only fall back to the local one when the server has
      // none (a thread whose title was never set).
      title: thread.title?.trim()
        || (existing?.title && existing.title !== 'New chat' ? existing.title : 'Recovered chat'),
      createdAt: existing?.createdAt ?? thread.createdAt,
      updatedAt: thread.updatedAt > (existing?.updatedAt ?? '') ? thread.updatedAt : existing?.updatedAt ?? thread.updatedAt,
      items: existing?.items ?? [],
      threadId: thread.id,
      favorite: thread.favorite ?? existing?.favorite ?? false,
    };
  });
  const recoveredIds = new Set(visibleThreads.map((thread) => thread.id));
  return [
    ...recovered,
    ...local.filter((conversation) =>
      (!conversation.threadId || !recoveredIds.has(conversation.threadId))
      && (!conversation.threadId || !deletedThreadIds.has(conversation.threadId))),
  ]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_CONVERSATIONS);
}

function loadDeletedThreadIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DELETED_THREAD_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistDeletedThreadIds(ids: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DELETED_THREAD_STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_CONVERSATIONS)));
  } catch {
    // The queue is a race-safety layer; server deletion remains authoritative.
  }
}

function queueDeletedThreadId(threadId: string): void {
  const ids = loadDeletedThreadIds();
  ids.add(threadId);
  persistDeletedThreadIds(ids);
}

function clearDeletedThreadId(threadId: string): void {
  const ids = loadDeletedThreadIds();
  ids.delete(threadId);
  persistDeletedThreadIds(ids);
}

// Defensive: persisted/edited runs from any source must have the arrays RunCard
// reads (nextActions/artifacts/evaluations/steps) or rendering throws on resume.
function normalizeItems(items: unknown): ThreadItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((it) => {
    if (!it || typeof it !== 'object') return [];
    const item = it as Record<string, unknown>;
    if (item.kind === 'run' && item.run && typeof item.run === 'object') {
      const run = item.run as Record<string, unknown>;
      run.nextActions = Array.isArray(run.nextActions) ? run.nextActions : [];
      run.artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
      run.evaluations = Array.isArray(run.evaluations) ? run.evaluations : [];
      run.steps = Array.isArray(run.steps) ? run.steps : [];
    }
    return [it as ThreadItem];
  });
}

function loadConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const deletedThreadIds = loadDeletedThreadIds();
    return (parsed as Conversation[])
      .filter((conversation) => !conversation.threadId || !deletedThreadIds.has(conversation.threadId))
      .map((c) => ({ ...c, items: normalizeItems(c.items) }));
  } catch {
    return [];
  }
}

function loadActiveConversationId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

// Strip fields that only matter during a LIVE run before writing to disk. Event
// streams (and their payloads) dominate the serialized size and blow the
// localStorage quota after a handful of chats — which used to silently drop the
// answer cards from history. Answers themselves are recoverable from the
// server-persisted thread (threadId), so the local copy is a fast-path cache.
function slimForPersist(conversations: Conversation[]): Conversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    items: conversation.items.map((item) =>
      item.kind === 'run' ? { ...item, run: { ...item.run, events: [] } } : item,
    ),
  }));
}

// Returns the set actually persisted, so callers keep in-memory state in sync with
// disk (a quota fallback writes fewer than it was given — don't keep 40 in memory).
function persistConversations(conversations: Conversation[]): Conversation[] {
  const capped = conversations.slice(0, MAX_CONVERSATIONS);
  if (typeof window === 'undefined') return capped;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slimForPersist(capped)));
    return capped;
  } catch {
    // Quota exceeded (large result payloads) — keep only the most recent few.
    const trimmed = capped.slice(0, 8);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slimForPersist(trimmed)));
    } catch {
      /* give up — history is best-effort; answers remain on the server thread */
    }
    return trimmed;
  }
}

function deriveTitle(items: ThreadItem[]): string {
  const firstUser = items.find((item) => item.kind === 'user');
  const text = firstUser && firstUser.kind === 'user' ? firstUser.text.trim() : '';
  if (!text) return 'New chat';
  return text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}

export function AnalyticsHome() {
  const state = useNotebookStore(useShallow((store) => ({
    activeFile: store.activeFile,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const openAnswerInNotebook = useOpenAnswerInNotebook();
  const t = themes[state.themeMode];
  const [domainContext, setDomainContext] = useState<DomainScope | undefined>(() => initialDomainScope());

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [historyLoading, setHistoryLoading] = useState(true);
  const startedWithLocalHistory = useMemo(() => conversations.length > 0, []);
  // Keep the selected thread across a page remount/reload. The panel's pending-run
  // handoff uses this server thread id to reconnect rather than asking again.
  const [activeId, setActiveId] = useState<string>(() => {
    const stored = loadActiveConversationId();
    return stored && conversations.some((conversation) => conversation.id === stored)
      ? stored
      : makeConversationId();
  });
  // Switching conversations remounts the panel. A running panel now persists its
  // run id and reconnects on remount, but keeping the selected conversation stable
  // still avoids an unnecessary context switch while an answer is in progress.
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    try { window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, activeId); } catch { /* best-effort */ }
  }, [activeId]);

  useEffect(() => {
    // A page may close after the browser copy was removed but before the DELETE
    // response arrived. Retry that bounded queue before canonical history is
    // allowed to repopulate the sidebar.
    for (const threadId of loadDeletedThreadIds()) {
      void api.deleteAgentThread(threadId)
        .then(() => clearDeletedThreadId(threadId))
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Keep the request-start tombstones for this response even if a concurrent
    // retry DELETE succeeds first. Otherwise an older in-flight GET could
    // briefly resurrect the just-deleted thread from its stale response body.
    const deletedAtRequestStart = loadDeletedThreadIds();
    void api.listAgentThreads({ limit: MAX_CONVERSATIONS })
      .then(({ threads }) => {
        if (cancelled) return;
        // New clients label Ask threads explicitly. Older Ask threads used the
        // generic notebook label without a notebook path, so include those for
        // lossless upgrade recovery.
        const askThreads = threads.filter((thread) =>
          thread.surface === 'ask'
          || (thread.surface === 'notebook' && !thread.notebookPath));
        const deletedThreadIds = new Set([
          ...deletedAtRequestStart,
          ...loadDeletedThreadIds(),
        ]);
        const visibleAskThreads = askThreads.filter((thread) => !deletedThreadIds.has(thread.id));
        setConversations((current) => persistConversations(
          mergePersistedAskConversations(current, visibleAskThreads, deletedThreadIds),
        ));
        if (!startedWithLocalHistory && visibleAskThreads[0]) {
          setActiveId(recoveredConversationId(visibleAskThreads[0].id));
        }
      })
      .catch(() => {
        // Local browser history remains available if the server store cannot
        // be opened. The next mount retries canonical thread discovery.
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [startedWithLocalHistory]);

  const activeItems = useMemo(
    () => conversations.find((c) => c.id === activeId)?.items ?? [],
    [conversations, activeId],
  );
  const activeThreadId = useMemo(
    () => conversations.find((c) => c.id === activeId)?.threadId,
    [conversations, activeId],
  );

  const handleItemsChange = useCallback(
    (items: ThreadItem[]) => {
      if (items.length === 0) return;
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === activeId);
        // A re-report on mount (resuming) carries the same length — don't reorder.
        if (existing && existing.items.length >= items.length) return prev;
        const now = new Date().toISOString();
        const convo: Conversation = {
          id: activeId,
          title: deriveTitle(items),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          items,
          threadId: existing?.threadId,
        };
        const next = [convo, ...prev.filter((c) => c.id !== activeId)].slice(0, MAX_CONVERSATIONS);
        return persistConversations(next);
      });
    },
    [activeId],
  );

  // Remember the server thread backing this conversation, so resuming it (or a
  // page refresh) continues the same server-persisted thread.
  const handleThreadIdChange = useCallback(
    (threadId: string) => {
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === activeId);
        const now = new Date().toISOString();
        if (!existing) {
          return persistConversations([
            { id: activeId, title: 'New chat', createdAt: now, updatedAt: now, items: [], threadId },
            ...prev,
          ]);
        }
        return persistConversations(prev.map((c) => (c.id === activeId ? { ...c, threadId } : c)));
      });
    },
    [activeId],
  );

  /**
   * Rename and pin write through to the server thread when there is one, so the
   * change survives a refresh and other surfaces see it. Local state updates
   * first: these are instant, low-stakes edits and should not wait on a round
   * trip. A thread that has not been created yet (no question asked) simply
   * keeps the change locally.
   */
  const renameConversation = useCallback((id: string, title: string) => {
    const clean = title.trim();
    if (!clean) return;
    setConversations((current) => persistConversations(current.map((conversation) =>
      conversation.id === id ? { ...conversation, title: clean } : conversation)));
    const threadId = conversations.find((conversation) => conversation.id === id)?.threadId;
    if (threadId) void api.updateAgentThread(threadId, { title: clean }).catch(() => undefined);
  }, [conversations]);

  const toggleConversationFavorite = useCallback((id: string) => {
    const target = conversations.find((conversation) => conversation.id === id);
    const next = !target?.favorite;
    setConversations((current) => persistConversations(current.map((conversation) =>
      conversation.id === id ? { ...conversation, favorite: next } : conversation)));
    if (target?.threadId) void api.updateAgentThread(target.threadId, { favorite: next }).catch(() => undefined);
  }, [conversations]);

  const newChat = useCallback(() => { if (!isRunning) setActiveId(makeConversationId()); }, [isRunning]);
  const selectConversation = useCallback((id: string) => { if (!isRunning) setActiveId(id); }, [isRunning]);

  const deleteConversation = useCallback(
    (id: string) => {
      if (isRunning) return;
      const threadId = conversations.find((conversation) => conversation.id === id)?.threadId;
      if (threadId) {
        queueDeletedThreadId(threadId);
        void api.deleteAgentThread(threadId)
          .then(() => clearDeletedThreadId(threadId))
          .catch(() => undefined);
      }
      setConversations((prev) => persistConversations(prev.filter((c) => c.id !== id)));
      if (id === activeId) setActiveId(makeConversationId());
    },
    [activeId, conversations, isRunning],
  );

  const openApp = (appId: string, dashboardId?: string) => {
    dispatch({ type: 'OPEN_APP', appId, dashboardId });
  };

  const openResearch = (researchRunId: string, notebookPath?: string) => {
    dispatch({
      type: 'OPEN_GLOBAL_AI',
      audience: 'stakeholder',
      context: {
        title: 'Research',
        scopeHint: 'Follow up on this research',
        selectedObject: { kind: 'research', id: researchRunId, path: notebookPath },
      },
    });
  };

  const openEditableNotebookCell = useCallback((payload: InsertDqlPayload) => {
    // With no notebook open, ADD_CELL writes into a store the NotebookEditor is
    // not rendering (it shows the welcome screen whenever there is no active
    // file), so the answer silently vanished. Create and open a notebook that
    // already contains it instead.
    if (!state.activeFile || state.activeFile.type === 'block') {
      void openAnswerInNotebook(payload);
      return;
    }
    const cell = askNotebookCellFromPayload(payload);
    if (!cell) return;
    dispatch({ type: 'ADD_CELL', cell });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'notebook' });
    focusInsertedNotebookCell(cell.id);
  }, [dispatch, openAnswerInNotebook, state.activeFile]);

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden', background: t.appBg }}>
      <ConversationSidebar
        t={t}
        conversations={conversations}
        activeId={activeId}
        busy={isRunning}
        loading={historyLoading}
        onNewChat={newChat}
        onSelect={selectConversation}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onToggleFavorite={toggleConversationFavorite}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <UnifiedAgentRunPanel
          key={activeId}
          themeMode={state.themeMode}
          title="Ask your data"
          askLayout
          scopeHint={domainContext ? `Scoped to ${domainContext.domain}${domainContext.modelAreaId ? ` · ${domainContext.modelAreaId.split('::').at(-1)?.replace(/_/g, ' ')}` : ''}${domainContext.purpose ? ` for ${domainContext.purpose}` : ''}` : 'Ask a question or request deep research'}
          onClearScope={domainContext ? () => { setDomainContext(undefined); persistDomainScope(undefined); } : undefined}
          workspaceContext={domainContext}
          audience="stakeholder"
          initialMode="auto"
          initialItems={activeItems}
          onItemsChange={handleItemsChange}
          threadId={activeThreadId}
          onThreadIdChange={handleThreadIdChange}
          onRunningChange={setIsRunning}
          onOpenResearch={openResearch}
          onOpenApp={openApp}
          onInsertSql={(sql, title, meta?: SqlNotebookDraftMeta) => openEditableNotebookCell({
            sql,
            title,
            question: meta?.question,
            sourceRunId: meta?.sourceRunId,
          })}
          onInsertDql={openEditableNotebookCell}
          insertDqlActionLabel="Open in notebook"
        />
      </div>
    </div>
  );
}

function ConversationSidebar({
  t,
  conversations,
  activeId,
  busy,
  loading,
  onNewChat,
  onSelect,
  onDelete,
  onRename,
  onToggleFavorite,
}: {
  t: Theme;
  conversations: Conversation[];
  activeId: string;
  busy?: boolean;
  loading?: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const switchTitle = busy ? 'Finish the current question first' : undefined;
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const favorites = conversations.filter((conversation) => conversation.favorite);
  const rest = conversations.filter((conversation) => !conversation.favorite);

  const beginRename = (conversation: Conversation): void => {
    setRenamingId(conversation.id);
    setDraftTitle(conversation.title);
  };
  const commitRename = (): void => {
    if (renamingId && draftTitle.trim()) onRename(renamingId, draftTitle);
    setRenamingId(null);
  };

  const renderConversationRow = (conv: Conversation): JSX.Element => {
    const active = conv.id === activeId;
    const hovered = hoverId === conv.id;
    const renaming = renamingId === conv.id;
    return (
      <div
        key={conv.id}
        onMouseEnter={() => setHoverId(conv.id)}
        onMouseLeave={() => setHoverId((cur) => (cur === conv.id ? null : cur))}
        style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
      >
        {renaming ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
              if (event.key === 'Escape') { event.preventDefault(); setRenamingId(null); }
            }}
            aria-label="Conversation name"
            style={{
              flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: 7,
              border: `1px solid ${t.accent}`, background: t.appBg,
              color: t.textPrimary, fontSize: 12.5, fontWeight: 600,
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => onSelect(conv.id)}
            onDoubleClick={() => beginRename(conv)}
            disabled={busy && !active}
            title={busy && !active ? switchTitle : `${conv.title} — double-click to rename`}
            style={{
              flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', borderRadius: 7, border: 'none',
              background: active ? `${t.accent}1f` : hovered ? `${t.textPrimary}0d` : 'transparent',
              color: active ? t.accent : t.textSecondary,
              cursor: busy && !active ? 'not-allowed' : 'pointer',
              opacity: busy && !active ? 0.5 : 1,
              textAlign: 'left', fontSize: 12.5, fontWeight: active ? 600 : 500,
              paddingRight: hovered ? 56 : 10,
            }}
          >
            {active && busy
              ? <Loader2 size={13} style={{ flexShrink: 0, color: t.accent, animation: 'dql-agent-run-spin 0.8s linear infinite' }} />
              : conv.favorite
                ? <Star size={13} style={{ flexShrink: 0, color: t.accent }} fill="currentColor" />
                : <MessageSquare size={13} style={{ flexShrink: 0, opacity: 0.7 }} />}
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {active && busy ? 'Working…' : conv.title}
            </span>
            {!hovered ? (
              <span style={{ flexShrink: 0, fontSize: 10, color: active && busy ? t.accent : t.textMuted, fontWeight: active && busy ? 650 : 400 }}>
                {active && busy ? 'Live' : relativeTime(conv.updatedAt)}
              </span>
            ) : null}
          </button>
        )}
        {hovered && !renaming ? (
          <div style={{ position: 'absolute', right: 4, display: 'inline-flex', gap: 2 }}>
            <RowAction t={t} label={conv.favorite ? 'Unpin conversation' : 'Pin conversation'} onClick={() => onToggleFavorite(conv.id)}>
              <Star size={12} fill={conv.favorite ? 'currentColor' : 'none'} />
            </RowAction>
            <RowAction t={t} label="Rename conversation" onClick={() => beginRename(conv)}>
              <Pencil size={12} />
            </RowAction>
            <RowAction t={t} label="Delete conversation" onClick={() => onDelete(conv.id)}>
              <Trash2 size={12} />
            </RowAction>
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <aside
      style={{
        width: 248,
        flexShrink: 0,
        borderRight: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: 12 }}>
        <button
          type="button"
          onClick={onNewChat}
          disabled={busy}
          title={switchTitle}
          style={{
            width: '100%',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'center',
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${t.accent}`,
            background: t.accent,
            color: 'var(--accent-on, #fff)',
            fontSize: 13,
            fontWeight: 650,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.55 : 1,
          }}
        >
          <Plus size={15} strokeWidth={2.4} /> New chat
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loading && conversations.length === 0 ? (
          <div style={{ padding: '10px 8px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: t.textMuted }}>
            <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} />
            Restoring project chats…
          </div>
        ) : conversations.length === 0 ? (
          <div style={{ padding: '10px 8px', fontSize: 11.5, color: t.textMuted, lineHeight: 1.5 }}>
            No past chats yet. Your conversations show up here so you can pick up where you left off.
          </div>
        ) : (
          <>
            {favorites.length > 0 ? (
              <>
                <GroupLabel t={t}>Favourites</GroupLabel>
                {favorites.map((conv) => renderConversationRow(conv))}
                <GroupLabel t={t}>Recent</GroupLabel>
              </>
            ) : (
              <GroupLabel t={t}>Recent</GroupLabel>
            )}
            {rest.map((conv) => renderConversationRow(conv))}
          </>
        )}
      </div>
      <div style={{ padding: '10px 12px', borderTop: `1px solid ${t.headerBorder}`, display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: t.textMuted }}>
        <ShieldCheck size={12} style={{ flexShrink: 0, color: t.success }} />
        <span>Private project history · not committed to Git</span>
      </div>
    </aside>
  );
}

/** Section heading in the conversation sidebar. */
function GroupLabel({ t, children }: { t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ padding: '8px 8px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>
      {children}
    </div>
  );
}

/** Small hover action on a conversation row. */
function RowAction({ t, label, onClick, children }: {
  t: Theme;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 5, border: 'none',
        background: t.cellBg, color: t.textMuted, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
