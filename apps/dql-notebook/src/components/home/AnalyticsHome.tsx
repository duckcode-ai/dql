import React, { useCallback, useMemo, useState } from 'react';
import { Sparkles, Plus, MessageSquare, Trash2 } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { UnifiedAgentRunPanel, type ThreadItem } from '../agent/UnifiedAgentRunPanel';

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

interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: ThreadItem[];
}

const STORAGE_KEY = 'dql-ask-conversations';
const MAX_CONVERSATIONS = 40;

function makeConversationId(): string {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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
    return (parsed as Conversation[]).map((c) => ({ ...c, items: normalizeItems(c.items) }));
  } catch {
    return [];
  }
}

// Returns the set actually persisted, so callers keep in-memory state in sync with
// disk (a quota fallback writes fewer than it was given — don't keep 40 in memory).
function persistConversations(conversations: Conversation[]): Conversation[] {
  const capped = conversations.slice(0, MAX_CONVERSATIONS);
  if (typeof window === 'undefined') return capped;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
    return capped;
  } catch {
    // Quota exceeded (large result payloads) — keep only the most recent few.
    const trimmed = capped.slice(0, 8);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* give up — history is best-effort */
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
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [activeId, setActiveId] = useState<string>(() => makeConversationId());
  // Switching conversations remounts the panel (key=activeId), which aborts an
  // in-flight run and loses the answer — so block switching while a run is running.
  const [isRunning, setIsRunning] = useState(false);

  const activeItems = useMemo(
    () => conversations.find((c) => c.id === activeId)?.items ?? [],
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
        };
        const next = [convo, ...prev.filter((c) => c.id !== activeId)].slice(0, MAX_CONVERSATIONS);
        return persistConversations(next);
      });
    },
    [activeId],
  );

  const newChat = useCallback(() => { if (!isRunning) setActiveId(makeConversationId()); }, [isRunning]);
  const selectConversation = useCallback((id: string) => { if (!isRunning) setActiveId(id); }, [isRunning]);

  const deleteConversation = useCallback(
    (id: string) => {
      if (isRunning) return;
      setConversations((prev) => persistConversations(prev.filter((c) => c.id !== id)));
      if (id === activeId) setActiveId(makeConversationId());
    },
    [activeId, isRunning],
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

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden', background: t.appBg }}>
      <ConversationSidebar
        t={t}
        conversations={conversations}
        activeId={activeId}
        busy={isRunning}
        onNewChat={newChat}
        onSelect={selectConversation}
        onDelete={deleteConversation}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 24px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: `${t.accent}14`, border: `1px solid ${t.accent}36`, color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={16} />
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: t.textPrimary }}>Ask your data</div>
              <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 2 }}>
                Governed answers and deep research — grounded in your certified metrics and dbt lineage.
              </div>
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 'min(860px, 100%)', minHeight: 0, display: 'flex' }}>
            <UnifiedAgentRunPanel
              key={activeId}
              themeMode={state.themeMode}
              title="Analytics copilot"
              scopeHint="Ask a question or request deep research"
              audience="stakeholder"
              initialMode="auto"
              initialItems={activeItems}
              onItemsChange={handleItemsChange}
              onRunningChange={setIsRunning}
              onOpenResearch={openResearch}
              onOpenApp={openApp}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ConversationSidebar({
  t,
  conversations,
  activeId,
  busy,
  onNewChat,
  onSelect,
  onDelete,
}: {
  t: Theme;
  conversations: Conversation[];
  activeId: string;
  busy?: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const switchTitle = busy ? 'Finish the current question first' : undefined;
  const [hoverId, setHoverId] = useState<string | null>(null);
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
      <div style={{ padding: '0 8px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>
        Recent
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {conversations.length === 0 ? (
          <div style={{ padding: '10px 8px', fontSize: 11.5, color: t.textMuted, lineHeight: 1.5 }}>
            No past chats yet. Your conversations show up here so you can pick up where you left off.
          </div>
        ) : (
          conversations.map((conv) => {
            const active = conv.id === activeId;
            const hovered = hoverId === conv.id;
            return (
              <div
                key={conv.id}
                onMouseEnter={() => setHoverId(conv.id)}
                onMouseLeave={() => setHoverId((cur) => (cur === conv.id ? null : cur))}
                style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(conv.id)}
                  disabled={busy && !active}
                  title={busy && !active ? switchTitle : conv.title}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 7,
                    border: 'none',
                    background: active ? `${t.accent}1f` : hovered ? `${t.textPrimary}0d` : 'transparent',
                    color: active ? t.accent : t.textSecondary,
                    cursor: busy && !active ? 'not-allowed' : 'pointer',
                    opacity: busy && !active ? 0.5 : 1,
                    textAlign: 'left',
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  <MessageSquare size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.title}</span>
                  <span style={{ flexShrink: 0, fontSize: 10, color: t.textMuted, fontWeight: 400 }}>{relativeTime(conv.updatedAt)}</span>
                </button>
                {hovered ? (
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    onClick={() => onDelete(conv.id)}
                    style={{
                      position: 'absolute',
                      right: 4,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      borderRadius: 5,
                      border: 'none',
                      background: t.cellBg,
                      color: t.textMuted,
                      cursor: 'pointer',
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
