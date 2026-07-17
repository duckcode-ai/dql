import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeDqlArtifactReference } from '@duckcodeailabs/dql-core/artifacts';
import {
  ArrowRight,
  ArrowUp,
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  FileSearch,
  Save,
  GitBranch,
  LayoutDashboard,
  Lightbulb,
  ListTree,
  Loader2,
  MoreHorizontal,
  Plus,
  Route,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import {
  api,
  type AgentConversationTurn,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunAudience,
  type AgentRunEvent,
  type AgentRunRequestedMode,
  type AgentRunRoute,
  type AgentRunSelectedObject,
  type AgentRunStep,
  type AgentRunStepStatus,
  type AgentRunTrustState,
  type AgentThinkingMode,
  type AppBuildProposal,
  type MixedSourceNotebookPlan,
} from '../../api/client';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { ThinkingModeControl } from './ThinkingModeControl';
import { StructuredAnswerText } from './AgentAnswerCard';
import { AppBuildProposalPanel, defaultProposalSelection } from '../apps/AppBuildProposalPanel';
import { ResultView } from '../output/ResultView';
import { DraftReviewCard } from '../blocks/DraftReviewCard';
import { SaveAsBlockModal } from '../modals/SaveAsBlockModal';
import { BlockParameterControls, isRuntimeEditableParameter } from '../parameters/BlockParameterControls';
export { deriveResultChartConfig } from '../output/ResultView';
import type { QueryResult, AppSummary, CellChartConfig, Cell, BlockParameterDefinition } from '../../store/types';
import { useNotebook } from '../../store/NotebookStore';
import { buildConversationContext } from './agentConversationContext';
import type { AgentConversationDqlArtifact } from '../../llm/types';

export type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'run'; id: string; run: AgentRun };

/**
 * Build the compact client history used when a persisted server thread is not
 * available. Clarification turns must carry the actual question in `answer`;
 * the generic run summary ("Needs clarification...") cannot resolve a reply.
 */
export function agentRunHistoryFromItems(items: ThreadItem[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  return items.map((item) => (
    item.kind === 'user'
      ? { role: 'user' as const, text: item.text }
      : { role: 'assistant' as const, text: item.run.answer?.trim() || item.run.summary }
  )).slice(-12);
}

/** A submitted run that may outlive this mounted panel (tab switch, reload, or navigation). */
interface PendingAgentRun {
  id: string;
  question: string;
  threadId?: string;
  startedAt: string;
}

interface AgentBlockSave {
  runId: string;
  source: string;
  name: string;
  dqlArtifact?: AgentConversationDqlArtifact;
}

const ACTIVE_RUNS_STORAGE_KEY = 'dql.agent.active-runs.v1';

/** An empty-state suggestion chip: the label is shown, the prompt is submitted. */
export type ExamplePrompt = { label: string; prompt: string };

interface UnifiedAgentRunPanelProps {
  themeMode: ThemeMode;
  title?: string;
  scopeHint?: string;
  onClearScope?: () => void;
  /** Override the empty-state suggestion chips so a surface can offer tailored prompts. */
  examplePrompts?: ExamplePrompt[];
  /** Override the empty-state hint line above the suggestion chips. */
  emptyHint?: string;
  notebookPath?: string;
  selectedObject?: AgentRunSelectedObject;
  workspaceContext?: Record<string, unknown>;
  initialMode?: AgentRunRequestedMode;
  initialInput?: string;
  /** Seed the thread (for resuming a saved conversation). */
  initialItems?: ThreadItem[];
  /** Fires whenever the thread changes, so a host can persist the conversation. */
  onItemsChange?: (items: ThreadItem[]) => void;
  /**
   * Resume a server-persisted conversation thread (read at mount). Prior turns
   * hydrate the panel unless `initialItems` already seeded it. Without one, the
   * panel creates a thread on the first question and reports it via
   * `onThreadIdChange`.
   */
  threadId?: string;
  /** Fires when the panel creates a server thread, so a host can persist the id. */
  onThreadIdChange?: (id: string) => void;
  /** 'stakeholder' (consumption-only) hides authoring modes + adds the certify handoff. */
  audience?: AgentRunAudience;
  autoRun?: { text: string; mode?: AgentRunRequestedMode; nonce: number };
  onInsertSql?: (sql: string, title?: string) => void;
  /**
   * DQL-first insertion: the whole governed artifact (compiled SQL body + DQL
   * provenance + executed result + chart config) so the host can create a
   * self-contained, ready-rendered query cell. Preferred over onInsertSql when set.
   */
  onInsertDql?: (payload: InsertDqlPayload) => void;
  /**
   * Optional host handoff for authoring surfaces. Fires once when a completed
   * non-certified run produces a new DQL/SQL artifact, allowing the host to
   * populate an unsaved editor without changing the agent engine or RunCard.
   */
  onArtifactReady?: (payload: InsertDqlPayload, run: AgentRun) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  /** Navigate into an app/dashboard (used by the "Added to app" success link). */
  onOpenApp?: (appId: string, dashboardId?: string) => void;
  /** Reports whether a run is in flight, so a host can avoid unmounting mid-run. */
  onRunningChange?: (running: boolean) => void;
  /** Use Ask's answer-first narrative/result card inside a compact authoring panel. */
  answerFirstCards?: boolean;
  /** Add a contextual DQL insertion action to an answer-first card. */
  insertDqlActionLabel?: string;
  /**
   * Opt into the redesigned "Ask" experience: a wide chat column with a page
   * header, centered 720px transcript of plain-text answers + trust lines +
   * artifact chips, a right-hand inspector that opens on chip click, and
   * select-to-follow-up. Off by default so embedded surfaces (Block Studio Ask,
   * dashboard copilot, notebook chat) keep the compact panel unchanged.
   */
  askLayout?: boolean;
}

/** Payload for DQL-first cell insertion from a governed answer artifact. */
export interface InsertDqlPayload {
  sql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  result?: QueryResult;
  chartConfig?: CellChartConfig;
  title?: string;
  mixedSourcePlan?: MixedSourceNotebookPlan;
}

const ROUTE_LABEL: Record<AgentRunRoute, string> = {
  conversation: 'Chat',
  certified_answer: 'Certified answer',
  semantic_answer: 'Governed semantic answer',
  generated_answer: 'Generated answer',
  research: 'Research plan',
  sql_cell: 'SQL cell',
  dql_block_draft: 'DQL block draft',
  app_build: 'App plan',
  clarify: 'Clarify',
  blocked: 'Blocked',
};

export function UnifiedAgentRunPanel({
  themeMode,
  title = 'AI Copilot',
  scopeHint = 'Auto routes to answer, research, SQL, block, or app',
  onClearScope,
  examplePrompts,
  emptyHint,
  notebookPath,
  selectedObject,
  workspaceContext,
  initialMode = 'auto',
  initialInput = '',
  initialItems,
  onItemsChange,
  threadId: threadIdProp,
  onThreadIdChange,
  audience = 'analyst',
  autoRun,
  onInsertSql,
  onInsertDql,
  onArtifactReady,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
  onRunningChange,
  answerFirstCards = false,
  insertDqlActionLabel,
  askLayout = false,
}: UnifiedAgentRunPanelProps): JSX.Element {
  const t = themes[themeMode];
  // One clean composer everywhere: an auto-routed box — no mode chips. Capability
  // still varies server-side by `audience` (analyst keeps the
  // authoring routes so SQL/blocks generate; stakeholder is consumption-only), but
  // the chrome is uniform. A next-action can pre-route the *next* question (e.g.
  // "Draft this as a block") via this one-shot ref: consumed once at submit and cleared
  // the moment the user edits the prefilled prompt. The default is always auto.
  const pendingModeRef = useRef<AgentRunRequestedMode | undefined>(undefined);
  const [input, setInput] = useState(initialInput);
  const [items, setItems] = useState<ThreadItem[]>(initialItems ?? []);
  const [runningEvents, setRunningEvents] = useState<AgentRunEvent[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [running, setRunning] = useState(false);
  const [backgroundRun, setBackgroundRun] = useState<PendingAgentRun | null>(null);
  const [blockToSave, setBlockToSave] = useState<AgentBlockSave | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The composer "thinking" selection, sticky across refreshes. `auto` defers to
  // the engine's shape-adaptive routing; the user can change it mid-conversation.
  const [thinkingMode, setThinkingMode] = useState<AgentThinkingMode>(() => readStoredThinkingMode());
  const changeThinkingMode = useCallback((mode: AgentThinkingMode) => {
    setThinkingMode(mode);
    try { window.localStorage.setItem(THINKING_MODE_STORAGE_KEY, mode); } catch { /* best-effort */ }
  }, []);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInitialInputRef = useRef(initialInput);
  const lastAutoRunNonceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const pendingRunRef = useRef<PendingAgentRun | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryEpochRef = useRef(0);

  // ── Ask redesign (askLayout) state ────────────────────────────────────────
  // Which artifact is open in the right inspector, and its active tab. Null =
  // inspector closed. Keyed by run+artifact id so it survives new turns.
  const [inspector, setInspector] = useState<{ runId: string; artifactId: string; tab: AskInspectorTab } | null>(null);
  // Select-to-follow-up popover, anchored at a text selection inside a
  // [data-followup] zone (answer text or the inspector result table).
  const [pop, setPop] = useState<{ text: string; source: 'answer' | 'table'; left: number; top: number } | null>(null);
  const [popDraft, setPopDraft] = useState('');
  const popInputRef = useRef<HTMLInputElement>(null);
  const askScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!initialInput || running) return;
    if (initialInput === lastInitialInputRef.current) return;
    lastInitialInputRef.current = initialInput;
    setInput(initialInput);
  }, [initialInput, running]);

  const history = useMemo(() => agentRunHistoryFromItems(items), [items]);

  // Report thread changes to a host (for conversation persistence) without
  // re-subscribing when the callback identity changes each render.
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  const onArtifactReadyRef = useRef(onArtifactReady);
  onArtifactReadyRef.current = onArtifactReady;
  useEffect(() => {
    onItemsChangeRef.current?.(items);
  }, [items]);

  // Server-side conversation thread: created lazily on the first question (unless
  // the host passed one), then sent with every run so the server injects prior
  // turns and persists new ones. Kept in a ref so submit closures always see the
  // latest id; thread failures degrade to the client-built conversation context.
  const threadIdRef = useRef<string | undefined>(threadIdProp);
  const onThreadIdChangeRef = useRef(onThreadIdChange);
  onThreadIdChangeRef.current = onThreadIdChange;

  const appendFinishedRun = useCallback((run: AgentRun, pending: PendingAgentRun) => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    clearActiveAgentRun(run.id);
    if (activeRunIdRef.current === run.id) activeRunIdRef.current = null;
    pendingRunRef.current = null;
    setBackgroundRun(null);
    setRunningEvents(run.events.slice(-8));
    setStreamingAnswer('');
    setItems((current) => {
      if (current.some((item) => item.kind === 'run' && item.run.id === run.id)) return current;
      // A reload can happen after the question was sent but before its local item
      // was rendered. Restore that question ahead of the recovered answer.
      const alreadyHasQuestion = current.some((item) => item.kind === 'user' && item.text === pending.question);
      return [
        ...current,
        ...(alreadyHasQuestion ? [] : [{ kind: 'user' as const, id: `${run.id}-question`, text: pending.question }]),
        { kind: 'run' as const, id: run.id, run },
      ];
    });
    if (run.route !== 'certified_answer') {
      const ready = artifactReadyPayloadFromRun(run);
      if (ready) onArtifactReadyRef.current?.(ready, run);
    }
  }, []);

  const recoverPendingRun = useCallback((pending: PendingAgentRun) => {
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
    const recoveryEpoch = ++recoveryEpochRef.current;
    activeRunIdRef.current = pending.id;
    pendingRunRef.current = pending;
    setBackgroundRun(pending);
    setRunning(true);
    setStreamingAnswer('');
    setRunningEvents([]);

    const check = async () => {
      if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
      try {
        // Runs are saved atomically at completion. A 404 while the server is still
        // working is expected; keep the reconnect loop quiet and lightweight.
        const run = await api.getAgentRun(pending.id);
        if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
        appendFinishedRun(run, pending);
        setRunning(false);
      } catch {
        if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
        recoveryTimerRef.current = window.setTimeout(() => { void check(); }, 1_200);
      }
    };
    void check();
    return () => {
      if (recoveryEpoch === recoveryEpochRef.current) recoveryEpochRef.current += 1;
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [appendFinishedRun]);

  // Resume: when mounted with a threadId, hydrate the conversation from the
  // server-persisted turns. The server thread is the source of truth for
  // ANSWERS: host-seeded `initialItems` can be a stale partial snapshot (the
  // localStorage copy is quota-capped and drops run payloads), so we replace
  // local items whenever the server holds more completed turns than the local
  // copy has answer cards. A richer in-memory session (equal counts) is kept.
  const hydratedThreadRef = useRef(false);
  useEffect(() => {
    if (!threadIdProp || hydratedThreadRef.current) return;
    hydratedThreadRef.current = true;
    threadIdRef.current ??= threadIdProp;
    let cancelled = false;
    api.getAgentThread(threadIdProp)
      .then(({ turns }) => {
        if (cancelled || turns.length === 0) return;
        setItems((current) => {
          const localAnswerCount = current.filter((item) => item.kind === 'run').length;
          return turns.length > localAnswerCount ? threadItemsFromTurns(turns) : current;
        });
      })
      .catch(() => {
        // Unknown/pruned thread (or store unavailable): forget the id so the next
        // question starts a fresh thread instead of writing into the void.
        if (!cancelled && threadIdRef.current === threadIdProp) threadIdRef.current = undefined;
      });
    return () => { cancelled = true; };
  }, [threadIdProp]);

  // The server deliberately keeps an accepted run alive when this view unmounts.
  // Reconnect by run id rather than rerunning the question, so switching tabs,
  // windows, or routes never duplicates work or loses the completed answer.
  useEffect(() => {
    const pending = findActiveAgentRun(threadIdProp ?? threadIdRef.current);
    // The local stream is already healthy for a just-created thread; do not
    // replace its live event feed with polling merely because the host persisted
    // the new thread id.
    if (!pending || abortRef.current) return;
    return recoverPendingRun(pending);
  }, [recoverPendingRun, threadIdProp]);

  useEffect(() => {
    const reconnectWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (abortRef.current) return;
      const pending = pendingRunRef.current ?? findActiveAgentRun(threadIdProp ?? threadIdRef.current);
      if (pending) recoverPendingRun(pending);
    };
    document.addEventListener('visibilitychange', reconnectWhenVisible);
    return () => document.removeEventListener('visibilitychange', reconnectWhenVisible);
  }, [recoverPendingRun, threadIdProp]);

  const submit = async (textOverride?: string, modeOverride?: AgentRunRequestedMode) => {
    const text = (textOverride ?? input).trim();
    if (!text || running) return;
    const activeMode = modeOverride ?? pendingModeRef.current ?? initialMode;
    pendingModeRef.current = undefined;
    const userItem: ThreadItem = { kind: 'user', id: makeId('user'), text };
    setItems((current) => [...current, userItem]);
    setInput('');
    setError(null);
    setRunning(true);
    setRunningEvents([]);
    setStreamingAnswer('');
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = makeId('run');
    let pending: PendingAgentRun = { id: runId, question: text, threadId: threadIdRef.current, startedAt: new Date().toISOString() };
    activeRunIdRef.current = runId;
    pendingRunRef.current = pending;
    setBackgroundRun(pending);
    saveActiveAgentRun(pending);
    let receivedStreamMessage = false;
    let recovering = false;
    try {
      // Thread-scoped persistence: make sure a server thread exists so this run is
      // recorded as a turn. Best-effort — never block the question on it; without
      // a thread the run simply falls back to the client-built context below.
      if (!threadIdRef.current) {
        try {
          const thread = await api.createAgentThread({
            surface: 'notebook',
            title: text,
            ...(notebookPath ? { notebookPath } : {}),
          });
          threadIdRef.current = thread.id;
          onThreadIdChangeRef.current?.(thread.id);
          pending = { ...pending, threadId: thread.id };
          pendingRunRef.current = pending;
          setBackgroundRun(pending);
          saveActiveAgentRun(pending);
        } catch {
          // Conversation store unavailable — proceed without a threadId.
        }
      }
      const runInput = {
        question: text,
        requestedMode: activeMode,
        audience,
        selectedObject: selectedObject ?? (notebookPath ? { kind: 'notebook' as const, path: notebookPath } : undefined),
        workspaceContext: {
          ...(workspaceContext ?? {}),
          ...(notebookPath ? { notebookPath } : {}),
        },
        conversationContext: buildConversationContext(items),
        history,
        thinkingMode,
        runId,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
      };
      const run = await api.createAgentRunStream(runInput, (message) => {
        receivedStreamMessage = true;
        if (message.kind === 'event') {
          setRunningEvents((current) => [...current, message.event].slice(-8));
        } else if (message.kind === 'answer-delta') {
          setStreamingAnswer((current) => current + message.delta);
        } else {
          setRunningEvents(message.run.events.slice(-8));
        }
      }, controller.signal);
      appendFinishedRun(run, pending);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
        setInput(text);
        // If streaming disconnected after the server began reporting progress,
        // let the persisted run finish and quietly reconnect to its final answer.
        if (receivedStreamMessage) {
          recovering = true;
          recoverPendingRun(pending);
        } else {
          clearActiveAgentRun(runId);
          if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
          pendingRunRef.current = null;
          setBackgroundRun(null);
        }
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!recovering) setRunning(false);
    }
  };

  const handleSubmit = () => {
    void submit();
  };

  const handleStop = () => {
    const runId = activeRunIdRef.current;
    // Stop the server-owned run first so a hidden/background process cannot
    // keep spending provider time after the visible composer has stopped.
    if (runId) void api.cancelAgentRun(runId).catch(() => undefined);
    abortRef.current?.abort();
    recoveryEpochRef.current += 1;
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
    clearActiveAgentRun(runId ?? '');
    activeRunIdRef.current = null;
    pendingRunRef.current = null;
    setBackgroundRun(null);
    setStreamingAnswer('');
    setRunningEvents([]);
    setRunning(false);
    setError('Stopped. No answer or draft was saved.');
  };

  const onRunningChangeRef = useRef(onRunningChange);
  onRunningChangeRef.current = onRunningChange;
  useEffect(() => {
    onRunningChangeRef.current?.(running);
  }, [running]);

  useEffect(() => {
    if (!autoRun?.text || running) return;
    if (lastAutoRunNonceRef.current === autoRun.nonce) return;
    lastAutoRunNonceRef.current = autoRun.nonce;
    void submit(autoRun.text, autoRun.mode ?? initialMode);
  }, [autoRun?.nonce, autoRun?.text, autoRun?.mode, initialMode, running]);

  useEffect(() => () => {
    abortRef.current?.abort();
    recoveryEpochRef.current += 1;
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
  }, []);

  // Pre-selected app target when the panel is opened inside an app (the global
  // rail); on the Ask home there is none and the picker lists/creates apps.
  const appContext = {
    appId: typeof workspaceContext?.appId === 'string' ? workspaceContext.appId : undefined,
    dashboardId: typeof workspaceContext?.dashboardId === 'string' ? workspaceContext.dashboardId : undefined,
  };

  const handleNextAction = (run: AgentRun, action: AgentRun['nextActions'][number]) => {
    if (action.id === 'save-dql-block') {
      const dqlArtifact = answerDqlArtifactFromRun(run);
      const source = dqlArtifact?.source?.trim() ?? answerSqlFromRun(run)?.trim();
      if (!source) {
        setError('This answer does not include a reusable DQL or SQL artifact yet.');
        return;
      }
      setBlockToSave({
        runId: run.id,
        source,
        name: dqlArtifact?.name ?? `${run.question.slice(0, 48).trim() || 'saved_answer'}`,
        dqlArtifact,
      });
      return;
    }
    if (action.id === 'research-deeper') {
      void submit(run.question, 'research');
      return;
    }
    // A conversational suggestion chip carries the whole question as its label — run it.
    if (action.id.startsWith('suggest-question')) {
      void submit(action.label, 'auto');
      return;
    }
    pendingModeRef.current = routeToMode(action.route);
    setInput(nextPromptFor(run, action.route));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // ── Ask redesign helpers ──────────────────────────────────────────────────
  // Open the inspector on an artifact chip. Picks a sensible starting tab.
  const openInspector = useCallback((runId: string, artifactId: string, tab: AskInspectorTab = 'trust') => {
    setInspector({ runId, artifactId, tab });
  }, []);

  // Send a follow-up carrying the selected quote as context, then scroll down.
  const sendFollowUp = useCallback((question: string) => {
    const q = question.trim();
    if (!q) return;
    const quote = pop?.text?.trim();
    setPop(null);
    setPopDraft('');
    try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    void submit(quote ? `${q}\n\nRegarding: "${quote}"` : q);
    requestAnimationFrame(() => {
      if (askScrollRef.current) askScrollRef.current.scrollTop = askScrollRef.current.scrollHeight;
    });
  }, [pop, submit]);

  // Text-selection watcher for the follow-up popover (askLayout only). A
  // selection of ≥3 chars inside a [data-followup] zone opens the popover at
  // the selection rect; Esc or an empty selection dismisses it.
  useEffect(() => {
    if (!askLayout) return;
    const onMouseUp = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest('[data-selpop]')) return;
      window.setTimeout(() => {
        const sel = window.getSelection();
        const text = sel && sel.rangeCount ? sel.toString().trim() : '';
        if (!text || text.length < 3) { setPop((p) => (p ? null : p)); return; }
        const anchor = sel!.anchorNode;
        const el = anchor && (anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement);
        const zone = el?.closest('[data-followup]') as HTMLElement | null;
        if (!zone) { setPop((p) => (p ? null : p)); return; }
        const rect = sel!.getRangeAt(0).getBoundingClientRect();
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - 340));
        const top = rect.bottom + 176 > window.innerHeight ? Math.max(12, rect.top - 176) : rect.bottom + 8;
        setPop({ text: text.slice(0, 220), source: (zone.getAttribute('data-followup') as 'answer' | 'table') || 'answer', left, top });
        setPopDraft('');
        requestAnimationFrame(() => popInputRef.current?.focus());
      }, 0);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setPop(null); };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [askLayout]);

  // ── Redesigned Ask experience ─────────────────────────────────────────────
  if (askLayout) {
    const activeInspector = inspector
      ? (() => {
          const item = items.find((it) => it.kind === 'run' && it.run.id === inspector.runId);
          if (!item || item.kind !== 'run') return null;
          const artifact = item.run.artifacts.find((a) => a.id === inspector.artifactId);
          if (!artifact) return null;
          return { run: item.run, artifact };
        })()
      : null;
    return (
      <div style={{ display: 'flex', height: '100%', minHeight: 0, flex: 1, minWidth: 0, width: '100%', background: 'var(--bg-canvas)' }}>
        {blockToSave ? (
          <SaveAsBlockModal
            cell={{
              id: `agent-${blockToSave.runId}`,
              type: blockToSave.dqlArtifact ? 'dql' : 'sql',
              content: blockToSave.source,
              name: blockToSave.name,
              status: 'success',
              ...(blockToSave.dqlArtifact ? { dqlArtifact: blockToSave.dqlArtifact } : {}),
            } satisfies Cell}
            initialContent={blockToSave.source}
            initialName={blockToSave.name}
            onClose={() => setBlockToSave(null)}
            onSaved={() => setBlockToSave(null)}
          />
        ) : null}
        <style>{ASK_KEYFRAMES(t)}</style>

        {/* Chat column */}
        <div style={{ flex: 1, minWidth: 360, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-canvas)' }}>
          <div style={{ height: 46, flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 24px' }}>
            <div style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--accent-dim)', border: '1px solid var(--status-info-border)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={13} />
            </div>
            <span style={{ fontSize: 13.5, fontWeight: 650, color: t.textPrimary, whiteSpace: 'nowrap' }}>{title === 'AI Copilot' ? 'Ask your data' : title}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: t.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>Certified first · semantic next · generated SQL last</span>
          </div>

          <div ref={askScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ width: 'min(720px, 100% - 48px)', margin: '0 auto', padding: '26px 0 12px', display: 'flex', flexDirection: 'column', gap: 26 }}>
              {items.length === 0 && !running ? (
                <div style={{ margin: 'auto 0', display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center', color: t.textSecondary, paddingTop: 40 }}>
                  <div style={largeIconShellStyle(t)}><Sparkles size={20} /></div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.5, maxWidth: 400, color: t.textSecondary }}>{emptyHint ?? DEFAULT_EMPTY_HINT}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
                    {(examplePrompts ?? EXAMPLE_PROMPTS).map((ex) => (
                      <button key={ex.label} type="button" className="dql-hover dql-lift" onClick={() => { setInput(ex.prompt); requestAnimationFrame(() => inputRef.current?.focus()); }} style={suggestionChipStyle(t)}>{ex.label}</button>
                    ))}
                  </div>
                </div>
              ) : null}

              {items.map((item) => item.kind === 'user' ? (
                <div key={item.id} style={askUserBubbleStyle(t)}>{item.text}</div>
              ) : (
                <AskRunCard
                  key={item.id}
                  run={item.run}
                  t={t}
                  themeMode={themeMode}
                  appContext={appContext}
                  selectedArtifactId={inspector?.runId === item.run.id ? inspector.artifactId : undefined}
                  onOpenArtifact={(artifactId, tab) => openInspector(item.run.id, artifactId, tab)}
                  onOpenApp={onOpenApp}
                  onInsertSql={onInsertSql}
                  onInsertDql={onInsertDql}
                  onOpenBlock={onOpenBlock}
                  onOpenResearch={onOpenResearch}
                  onNextAction={(action) => handleNextAction(item.run, action)}
                />
              ))}

              {running && <RunProgress events={runningEvents} t={t} streamingAnswer={streamingAnswer} thinkingMode={thinkingMode} backgroundRun={backgroundRun} />}
            </div>

            <div style={{ width: 'min(720px, 100% - 48px)', margin: 'auto auto 0', padding: '10px 0 16px', position: 'sticky', bottom: 0, background: 'linear-gradient(to top, var(--bg-canvas) 82%, transparent)' }}>
              {error ? <div style={{ color: t.error, fontSize: 12, marginBottom: 8 }}>{error}</div> : null}
              {onClearScope ? (
                <div style={{ width: 'fit-content', maxWidth: '100%', marginBottom: 7, padding: '4px 7px 4px 9px', border: '1px solid var(--border-default)', borderRadius: 999, background: 'var(--bg-2)', color: t.textMuted, fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scopeHint}</span>
                  <button type="button" onClick={onClearScope} aria-label="Clear modeling scope" title="Clear modeling scope" style={{ border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 1 }}><X size={12} /></button>
                </div>
              ) : null}
              <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 14, boxShadow: '0 1px 2px rgba(26,26,26,0.03), 0 6px 22px rgba(26,26,26,0.05)', display: 'flex', flexDirection: 'column' }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => { setInput(event.target.value); pendingModeRef.current = undefined; }}
                  rows={2}
                  placeholder="Ask anything about your data…"
                  onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSubmit(); } }}
                  style={{ border: 'none', background: 'transparent', resize: 'none', outline: 'none', boxShadow: 'none', padding: '13px 15px 4px', fontSize: 13.5, lineHeight: 1.5, color: t.textPrimary, fontFamily: t.font }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 10px 12px' }}>
                  <ThinkingModeControl t={t} value={thinkingMode} onChange={changeThinkingMode} />
                  <div style={{ flex: 1 }} />
                  {running ? (
                    <button type="button" className="dql-hover" onClick={handleStop} title="Stop the active agent run" style={{ height: 34, padding: '0 12px', borderRadius: 10, border: `1px solid ${t.error}`, background: t.btnBg, color: t.error, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: t.font, fontSize: 12.5, fontWeight: 600 }}>
                      <Square size={13} fill="currentColor" /> Stop
                    </button>
                  ) : null}
                  <button type="button" className="dql-hover dql-lift" title="Ask" onClick={handleSubmit} disabled={!input.trim() || running} style={{ width: 34, height: 34, borderRadius: 10, border: 'none', background: (input.trim() && !running) ? 'var(--accent)' : 'var(--bg-4)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: (input.trim() && !running) ? 'pointer' : 'default', boxShadow: (input.trim() && !running) ? '0 1px 5px rgba(107,93,211,0.3)' : 'none' }}>
                    {running ? <Loader2 size={15} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <ArrowUp size={15} />}
                  </button>
                </div>
              </div>
              <div style={{ textAlign: 'center', fontSize: 10.5, color: t.textMuted, marginTop: 8 }}>Every answer is grounded in your certified metrics and dbt lineage.</div>
            </div>
          </div>
        </div>

        {/* Inspector */}
        {activeInspector ? (
          <AskInspector
            run={activeInspector.run}
            artifact={activeInspector.artifact}
            tab={inspector!.tab}
            t={t}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onChangeTab={(tab) => setInspector((prev) => (prev ? { ...prev, tab } : prev))}
            onClose={() => setInspector(null)}
            onSaveBlock={() => handleNextAction(activeInspector.run, { id: 'save-dql-block', label: 'Save as block', route: 'dql_block_draft' })}
          />
        ) : null}

        {pop ? (
          <FollowUpPopover
            t={t}
            text={pop.text}
            source={pop.source}
            left={pop.left}
            top={pop.top}
            draft={popDraft}
            inputRef={popInputRef}
            onDraftChange={setPopDraft}
            onClose={() => setPop(null)}
            onSend={sendFollowUp}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: 1, minWidth: 0, width: '100%', background: t.cellBg }}>
      {blockToSave ? (
        <SaveAsBlockModal
          cell={{
            id: `agent-${blockToSave.runId}`,
            type: blockToSave.dqlArtifact ? 'dql' : 'sql',
            content: blockToSave.source,
            name: blockToSave.name,
            status: 'success',
            ...(blockToSave.dqlArtifact ? { dqlArtifact: blockToSave.dqlArtifact } : {}),
          } satisfies Cell}
          initialContent={blockToSave.source}
          initialName={blockToSave.name}
          onClose={() => setBlockToSave(null)}
          onSaved={() => setBlockToSave(null)}
        />
      ) : null}
      <style>{`
        @keyframes dql-agent-run-spin { to { transform: rotate(360deg); } }
        @keyframes dql-agent-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
        @keyframes dql-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes dql-orb { 0%, 100% { box-shadow: 0 0 0 0 ${t.accent}00; } 50% { box-shadow: 0 0 13px 1px ${t.accent}66; } }
        @keyframes dql-pip { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.55); opacity: 0.5; } }
        @keyframes dql-step-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
        @keyframes dql-glyph { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }
        .dql-hover { transition: filter .15s ease, transform .12s ease, box-shadow .15s ease, background .15s ease, color .15s ease, border-color .15s ease; }
        .dql-hover:hover { filter: brightness(1.07); }
        .dql-hover:active { transform: translateY(0.5px); }
        .dql-lift:hover { transform: translateY(-1px); }
        details > summary::-webkit-details-marker { display: none; }
      `}</style>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.length === 0 && !running ? (
          <div style={{ margin: 'auto 0', display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center', color: t.textSecondary }}>
            <div style={largeIconShellStyle(t)}><Sparkles size={20} /></div>
            <div style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 380, color: t.textSecondary }}>
              {emptyHint ?? DEFAULT_EMPTY_HINT}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
              {(examplePrompts ?? EXAMPLE_PROMPTS).map((ex) => (
                <button key={ex.label} type="button" className="dql-hover dql-lift" onClick={() => { setInput(ex.prompt); requestAnimationFrame(() => inputRef.current?.focus()); }} style={suggestionChipStyle(t)}>
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {items.map((item) => item.kind === 'user' ? (
          <div key={item.id} style={userBubbleStyle(t)}>{item.text}</div>
        ) : answerFirstCards ? (
          <AskRunCard
            key={item.id}
            run={item.run}
            t={t}
            themeMode={themeMode}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
            insertDqlActionLabel={insertDqlActionLabel}
            onOpenBlock={onOpenBlock}
            onOpenResearch={onOpenResearch}
            onNextAction={(action) => handleNextAction(item.run, action)}
          />
        ) : (
          <RunCard
            key={item.id}
            run={item.run}
            t={t}
            themeMode={themeMode}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
            onOpenBlock={onOpenBlock}
            onOpenResearch={onOpenResearch}
            onNextAction={(action) => handleNextAction(item.run, action)}
          />
        ))}

        {running && <RunProgress events={runningEvents} t={t} streamingAnswer={streamingAnswer} thinkingMode={thinkingMode} backgroundRun={backgroundRun} />}
      </div>

      {error ? <div style={{ margin: '0 16px 8px', color: t.error, fontSize: 12 }}>{error}</div> : null}

      <div style={{ padding: '10px 16px 14px', borderTop: `1px solid ${t.headerBorder}`, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: t.textMuted, flex: 1, minWidth: 180, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{scopeHint}</span>
            {onClearScope ? <button type="button" onClick={onClearScope} aria-label="Clear modeling scope" title="Clear modeling scope" style={{ border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 2 }}><X size={12} /></button> : null}
          </div>
          <ThinkingModeControl t={t} value={thinkingMode} onChange={changeThinkingMode} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => { setInput(event.target.value); pendingModeRef.current = undefined; }}
            rows={2}
            placeholder="Ask anything about your data…"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSubmit();
              }
            }}
            style={inputStyle(t)}
          />
          <button
            type="button"
            className="dql-hover dql-lift"
            onClick={handleSubmit}
            disabled={!input.trim() || running}
            style={sendButtonStyle(t, Boolean(input.trim()) && !running)}
          >
            {running ? <Loader2 size={15} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Send size={15} />}
            <span>{running ? 'Working' : 'Ask'}</span>
          </button>
          {running ? <button type="button" className="dql-hover" onClick={handleStop} style={{ ...sendButtonStyle(t, true), background: t.btnBg, borderColor: t.error, color: t.error }} title="Stop the active agent run"><Square size={13} fill="currentColor" /><span>Stop</span></button> : null}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_EMPTY_HINT = 'Ask a question — every answer is grounded in your certified metrics and dbt lineage. Use Research deeper on any answer for a slower investigation.';
const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  { label: 'What is total revenue?', prompt: 'What is total revenue?' },
  { label: 'Why is revenue down by region?', prompt: 'Why is revenue down by region?' },
  { label: 'Top customers by revenue this quarter', prompt: 'Top customers by revenue this quarter' },
  { label: 'How have orders trended over the last 6 months?', prompt: 'How have orders trended over the last 6 months?' },
];

// ── Server-thread resume ─────────────────────────────────────────────────────

/**
 * Host helper: persist the panel's server thread id in localStorage (keyed per
 * surface) so a page refresh resumes the same conversation. Wire the returned
 * `threadId`/`onThreadIdChange` straight into `UnifiedAgentRunPanel` props;
 * `resetThreadId` starts a fresh conversation on the next question.
 */
export function usePersistedAgentThreadId(scope: string): {
  threadId: string | undefined;
  onThreadIdChange: (id: string) => void;
  resetThreadId: () => void;
} {
  const storageKey = `dql.agent.threadId.${scope}`;
  const [threadId, setThreadId] = useState<string | undefined>(() => readStoredThreadId(storageKey));
  useEffect(() => {
    setThreadId(readStoredThreadId(storageKey));
  }, [storageKey]);
  const onThreadIdChange = useCallback((id: string) => {
    setThreadId(id);
    try { window.localStorage.setItem(storageKey, id); } catch { /* best-effort */ }
  }, [storageKey]);
  const resetThreadId = useCallback(() => {
    setThreadId(undefined);
    try { window.localStorage.removeItem(storageKey); } catch { /* best-effort */ }
  }, [storageKey]);
  return { threadId, onThreadIdChange, resetThreadId };
}

function readStoredThreadId(storageKey: string): string | undefined {
  try {
    return window.localStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function readActiveAgentRuns(): PendingAgentRun[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ACTIVE_RUNS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingAgentRun => {
      if (!entry || typeof entry !== 'object') return false;
      const value = entry as Record<string, unknown>;
      return typeof value.id === 'string'
        && typeof value.question === 'string'
        && typeof value.startedAt === 'string'
        && (value.threadId === undefined || typeof value.threadId === 'string');
    });
  } catch {
    return [];
  }
}

function saveActiveAgentRun(run: PendingAgentRun): void {
  try {
    const otherRuns = readActiveAgentRuns().filter((entry) => entry.id !== run.id);
    window.localStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify([...otherRuns, run].slice(-12)));
  } catch {
    // A run continues on the server even if browser storage is unavailable.
  }
}

function clearActiveAgentRun(runId: string): void {
  try {
    const remaining = readActiveAgentRuns().filter((entry) => entry.id !== runId);
    window.localStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(remaining));
  } catch {
    // Best effort only: an old entry is harmless and will be de-duplicated if found.
  }
}

function findActiveAgentRun(threadId?: string): PendingAgentRun | undefined {
  const runs = readActiveAgentRuns().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (threadId) return runs.find((entry) => entry.threadId === threadId);
  return runs.find((entry) => !entry.threadId) ?? runs[0];
}

const THINKING_MODE_STORAGE_KEY = 'dql.agent.thinkingMode';

function readStoredThinkingMode(): AgentThinkingMode {
  try {
    const stored = window.localStorage.getItem(THINKING_MODE_STORAGE_KEY);
    return stored === 'low' || stored === 'medium' || stored === 'high' || stored === 'auto' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

const AGENT_RUN_ROUTES = new Set<AgentRunRoute>([
  'conversation', 'certified_answer', 'semantic_answer', 'generated_answer', 'research',
  'sql_cell', 'dql_block_draft', 'app_build', 'clarify', 'blocked',
]);
const AGENT_RUN_TRUST_STATES = new Set<AgentRunTrustState>([
  'certified', 'governed', 'grounded', 'review_required', 'blocked', 'not_applicable',
]);

/**
 * Rebuild the panel's thread items from server-persisted conversation turns.
 * A stored turn is a compact snapshot (question + answer summary + capped result),
 * not a full AgentRun — so each run is reconstructed minimally: enough for the
 * RunCard (route, trust, answer, result preview) and for
 * `buildConversationContext` to keep working as the no-threadId fallback.
 */
export function threadItemsFromTurns(turns: AgentConversationTurn[]): ThreadItem[] {
  return turns.flatMap((turn): ThreadItem[] => [
    { kind: 'user', id: `${turn.id}-q`, text: turn.question },
    { kind: 'run', id: turn.id, run: runFromConversationTurn(turn) },
  ]);
}

function runFromConversationTurn(turn: AgentConversationTurn): AgentRun {
  const route: AgentRunRoute = AGENT_RUN_ROUTES.has(turn.route as AgentRunRoute)
    ? (turn.route as AgentRunRoute)
    : 'generated_answer';
  const trustState: AgentRunTrustState = AGENT_RUN_TRUST_STATES.has(turn.trustLabel as AgentRunTrustState)
    ? (turn.trustLabel as AgentRunTrustState)
    : turn.certification === 'certified'
      ? 'certified'
      : 'not_applicable';
  const columns = (turn.result?.columns ?? []).filter((column): column is string => typeof column === 'string');
  // Stored samples are positional arrays; rebuild keyed rows for the result view.
  const rows = (turn.result?.rowsSample ?? [])
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  const result = columns.length > 0
    ? { columns, rows, rowCount: turn.result?.rowCount ?? rows.length }
    : undefined;
  const artifact: AgentRunArtifact | undefined = result || turn.sql || turn.sourceCertifiedBlock
    ? {
        id: `${turn.id}-artifact`,
        kind: 'answer',
        title: turn.sourceCertifiedBlock ?? turn.question,
        trustState,
        ref: turn.sourceCertifiedBlock,
        payload: {
          ...(turn.sourceCertifiedBlock ? { sourceCertifiedBlock: turn.sourceCertifiedBlock } : {}),
          ...(turn.certification ? { certification: turn.certification } : {}),
          ...(turn.contextPackId ? { contextPackId: turn.contextPackId } : {}),
          ...(turn.sql ? { sql: turn.sql } : {}),
          ...(result ? { result } : {}),
          ...(turn.contract && Object.keys(turn.contract).length > 0
            ? { contextPack: { questionPlan: { requestedShape: turn.contract } } }
            : {}),
        },
      }
    : undefined;
  return {
    id: turn.id,
    question: turn.question,
    requestedMode: 'auto',
    route,
    status: 'completed',
    trustState,
    stopReason: route === 'conversation'
      ? 'conversational_reply'
      : trustState === 'certified'
        ? 'certified_answer_found'
        : 'artifact_created',
    startedAt: turn.createdAt,
    completedAt: turn.createdAt,
    summary: turn.answerSummary ?? turn.question,
    answer: turn.answerText ?? turn.answerSummary,
    answerKind: route === 'conversation' ? 'conversational' : undefined,
    steps: [],
    artifacts: artifact ? [artifact] : [],
    evaluations: [],
    events: [],
    nextActions: [],
    repairAttempts: 0,
  };
}

function routeActionLabel(route?: AgentRunRoute): string {
  switch (route) {
    case 'conversation': return 'Replying';
    case 'research': return 'Researching across governed data';
    case 'certified_answer': return 'Checking certified blocks';
    case 'generated_answer': return 'Finding the answer';
    case 'app_build': return 'Assembling the app';
    case 'sql_cell': return 'Writing the query';
    case 'dql_block_draft': return 'Drafting the block';
    default: return 'Working';
  }
}

/** The route of the latest routed step, if any (drives conversation-aware chrome). */
function latestRoute(events: AgentRunEvent[]): AgentRunRoute | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].route) return events[i].route;
  }
  return undefined;
}

function currentActionLabel(events: AgentRunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    switch (event.type) {
      case 'repair.attempted': return 'Refining the result';
      case 'escalated': return 'Switching to a deeper approach';
      case 'evaluation.recorded': return 'Checking grounding and trust';
      case 'executor.started':
      case 'route.decided': return routeActionLabel(event.route);
      case 'step.started': {
        const goal = (event.payload as { goal?: string } | undefined)?.goal;
        return goal ? `Working on: ${goal}` : 'Working';
      }
      case 'plan.created': return 'Planning the approach';
      case 'run.started': return 'Starting';
      default: break;
    }
  }
  return 'Working';
}

/**
 * An honest one-liner explaining why a run is deliberately slower, so the wait
 * reads as intent rather than lag. Derived from the route and the user's thinking
 * selection — a research route or High mode trades speed for a cross-checked
 * number. Returns null on the fast paths, where no explanation is needed.
 */
function slowReasonFor(thinkingMode: AgentThinkingMode | undefined, events: AgentRunEvent[]): string | null {
  // Repair / escalation are the most common "why is this taking so long" cases —
  // the first query hit an error and is being regenerated. Say so plainly instead
  // of leaving the technical "repair attempt N" line to carry the whole story.
  if (events.some((event) => event.type === 'repair.attempted')) {
    return 'The first query hit an error — rewriting it and trying again to get the numbers right.';
  }
  if (events.some((event) => event.type === 'escalated')) {
    return 'Switching to a deeper approach for a more reliable answer.';
  }
  if (latestRoute(events) === 'research') return 'Deep investigation — slower by design.';
  if (thinkingMode === 'high') return 'Thorough mode — cross-checking the number takes a little longer.';
  return null;
}

export interface LongRunGuidance {
  title: string;
  detail: string;
}

/** UI-003 — progressive, actionable copy for genuinely long governed work. */
export function longRunGuidanceFor(
  elapsedSeconds: number,
  route?: AgentRunRoute,
  hasRepair = false,
): LongRunGuidance | null {
  if (elapsedSeconds < 12) return null;
  if (elapsedSeconds < 24 && !hasRepair) {
    return {
      title: 'Checking governed context',
      detail: 'AI is checking certified blocks, semantic metrics, domain modeling, and dbt metadata before it generates SQL.',
    };
  }
  if (route === 'research') {
    return {
      title: 'Deep research is validating the analysis',
      detail: 'This can use several AI and SQL steps. Reusable relationships and semantic metrics make future investigations faster; reviewed repeat answers can be saved as blocks and certified.',
    };
  }
  return {
    title: hasRepair ? 'Repairing and validating generated SQL' : 'Generating and validating SQL',
    detail: 'No exact reusable answer covered this question. After review, save this result as a block and certify it for faster repeat questions and lower future AI/token usage. Model repeated joins or reusable metrics once.',
  };
}

/** UI-003 — keep the optimization path visible beside the completed result. */
export function completedRunGuidanceFor(
  elapsedSeconds: number,
  route: AgentRunRoute,
  trustState: AgentRunTrustState,
  repairAttempts: number,
): LongRunGuidance | null {
  if (trustState === 'certified' || (elapsedSeconds < 20 && repairAttempts === 0)) return null;
  if (route !== 'research' && route !== 'generated_answer') return null;
  return {
    title: route === 'research' ? 'Make future research faster' : 'Make this question faster next time',
    detail: 'If this analysis is reusable, save it as a block, review it, then certify it. Add repeated joins to Domain Modeling and reusable measures to the semantic layer to reduce future AI work and token usage.',
  };
}

const ACTIVITY_STAGES: Array<{ key: 'plan' | 'work' | 'verify'; label: string }> = [
  { key: 'plan', label: 'Plan' },
  { key: 'work', label: 'Work' },
  { key: 'verify', label: 'Verify' },
];

/** Which high-level stage the agent is in (0 plan → 1 work → 2 verify). */
function deriveStage(events: AgentRunEvent[]): number {
  let stage = 0;
  for (const event of events) {
    switch (event.type) {
      case 'route.decided':
      case 'executor.started':
      case 'step.started':
      case 'repair.attempted':
      case 'escalated':
        stage = Math.max(stage, 1);
        break;
      case 'evaluation.recorded':
        stage = Math.max(stage, 2);
        break;
      default:
        break;
    }
  }
  return stage;
}

/** An icon matching what the agent is doing right now. */
function phaseIconFor(events: AgentRunEvent[]): typeof Sparkles {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    switch (event.type) {
      case 'evaluation.recorded': return ShieldCheck;
      case 'repair.attempted':
      case 'escalated': return Wrench;
      case 'executor.started':
      case 'route.decided':
        switch (event.route) {
          case 'research': return FileSearch;
          case 'sql_cell': return Code2;
          case 'app_build': return LayoutDashboard;
          case 'dql_block_draft': return Blocks;
          case 'certified_answer':
          case 'generated_answer': return Sparkles;
          default: return Sparkles;
        }
      case 'plan.created': return Lightbulb;
      default: break;
    }
  }
  return Sparkles;
}

interface AgentActivityCard {
  title: string;
  detail: string;
  Icon: typeof Sparkles;
}

function compactActivityDetail(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > 118 ? `${clean.slice(0, 115).trimEnd()}…` : clean;
}

/**
 * Compact, evidence-safe activity cards. These are operational observations the
 * runtime has emitted (not hidden reasoning), so people can see concrete work
 * such as checking certified metrics or reading the live schema.
 */
function activityCardsFor(events: AgentRunEvent[]): AgentActivityCard[] {
  const cardFor = (event: AgentRunEvent): AgentActivityCard | undefined => {
    const detail = compactActivityDetail(event.message);
    if (event.type === 'plan.created') return { title: 'Shaping the request', detail, Icon: Lightbulb };
    if (event.type === 'route.decided') return { title: 'Choosing the safest route', detail, Icon: Route };
    if (event.type === 'evaluation.recorded') return { title: 'Verifying the answer', detail, Icon: ShieldCheck };
    if (event.type === 'repair.attempted' || event.type === 'escalated') return { title: 'Improving reliability', detail, Icon: Wrench };
    if (event.type !== 'executor.started') return undefined;
    if (/certified|semantic|metric|governed/i.test(detail)) return { title: 'Checking governed definitions', detail, Icon: ShieldCheck };
    if (/search|definition|domain|skill|project index|source/i.test(detail)) return { title: 'Searching your project', detail, Icon: FileSearch };
    if (/schema|column|table|relation/i.test(detail)) return { title: 'Inspecting data shape', detail, Icon: ListTree };
    if (/resolv|answer|result/i.test(detail)) return { title: 'Building the answer', detail, Icon: Sparkles };
    return { title: 'Working with your data', detail, Icon: Sparkles };
  };
  const cards: AgentActivityCard[] = [];
  const seen = new Set<string>();
  for (let index = events.length - 1; index >= 0 && cards.length < 3; index -= 1) {
    const card = cardFor(events[index]);
    if (!card || seen.has(card.title)) continue;
    seen.add(card.title);
    cards.unshift(card);
  }
  return cards;
}

/**
 * Live agent activity — boxless. A spinning halo + phase icon, a shimmering
 * action headline, a Plan→Work→Verify tracker, and the latest step line.
 * Expresses *what the agent is doing* rather than a generic progress bar.
 */
function RunProgress({ events, t, streamingAnswer, thinkingMode, backgroundRun }: {
  events: AgentRunEvent[];
  t: Theme;
  streamingAnswer?: string;
  thinkingMode?: AgentThinkingMode;
  backgroundRun?: PendingAgentRun | null;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const action = events.length ? currentActionLabel(events) : backgroundRun ? 'Continuing your request in the background' : 'Starting';
  const stage = deriveStage(events);
  const Icon = phaseIconFor(events);
  const latest = events.length
    ? events[events.length - 1].message
    : backgroundRun ? 'Safe to switch tabs — this run will reconnect as soon as it is ready.' : '';
  const activityCards = activityCardsFor(events);
  // Honest "why is this taking a moment" line — set expectations when the run is
  // deliberately on a slower, more thorough path (a deep investigation, or the
  // user's High thinking selection cross-checking the number).
  const slowReason = slowReasonFor(thinkingMode, events);
  const runStartedAt = backgroundRun?.startedAt ?? events.find((event) => event.type === 'run.started')?.at;
  const startedAtMs = runStartedAt ? Date.parse(runStartedAt) : clock;
  const elapsedSeconds = Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((clock - startedAtMs) / 1_000)) : 0;
  const longRunGuidance = longRunGuidanceFor(
    elapsedSeconds,
    latestRoute(events),
    events.some((event) => event.type === 'repair.attempted'),
  );
  // A conversational turn has no Plan/Work/Verify work to show — just a light
  // "Replying…" line, and the streamed text as it arrives.
  const isConversation = latestRoute(events) === 'conversation';
  if (isConversation) {
    return (
      <div style={{ alignSelf: 'stretch', display: 'flex', gap: 12, padding: '4px 2px 8px', animation: 'dql-agent-fadein 0.3s ease-out' }}>
        <div style={{ position: 'relative', width: 34, height: 34, flex: '0 0 auto' }}>
          <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: `${t.accent}14`, border: `1px solid ${t.accent}33`, color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', animation: 'dql-orb 1.8s ease-in-out infinite' }}>
            <Sparkles size={15} />
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 }}>
          {streamingAnswer
            ? <div style={{ fontSize: 13.5, lineHeight: 1.55, color: t.textPrimary, whiteSpace: 'pre-wrap' }}>{streamingAnswer}</div>
            : <span style={{ fontSize: 13.5, fontWeight: 650, color: t.textSecondary }}>Replying…</span>}
        </div>
      </div>
    );
  }
  return (
    <div style={{ alignSelf: 'stretch', display: 'flex', gap: 12, padding: '4px 2px 8px', animation: 'dql-agent-fadein 0.3s ease-out' }}>
      <div style={{ position: 'relative', width: 34, height: 34, flex: '0 0 auto' }}>
        <span
          style={{
            position: 'absolute', inset: -3, borderRadius: '50%',
            background: `conic-gradient(from 0deg, ${t.accent}00 0%, ${t.accent}00 55%, ${t.accent} 100%)`,
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
            animation: 'dql-agent-run-spin 1s linear infinite',
          }}
        />
        <span
          style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: `${t.accent}14`, border: `1px solid ${t.accent}33`, color: t.accent,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            animation: 'dql-orb 1.8s ease-in-out infinite',
          }}
        >
          <span style={{ display: 'inline-flex', animation: 'dql-glyph 1.8s ease-in-out infinite' }}><Icon size={15} /></span>
        </span>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 1 }}>
        <span
          key={action}
          style={{
            fontSize: 13.5, fontWeight: 750, letterSpacing: '-0.01em',
            backgroundImage: `linear-gradient(100deg, ${t.textPrimary} 25%, ${t.accent} 50%, ${t.textPrimary} 75%)`,
            backgroundSize: '220% 100%', WebkitBackgroundClip: 'text', backgroundClip: 'text',
            color: 'transparent', WebkitTextFillColor: 'transparent',
            animation: 'dql-shimmer 2.4s linear infinite',
          }}
        >
          {action}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {ACTIVITY_STAGES.map((s, i) => {
            const done = i < stage;
            const active = i === stage;
            return (
              <React.Fragment key={s.key}>
                {i > 0 ? <span style={{ width: 13, height: 1.5, borderRadius: 2, background: done || active ? `${t.accent}66` : t.cellBorder }} /> : null}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.02em', color: done ? t.accent : active ? t.textPrimary : t.textMuted }}>
                  {done ? (
                    <CheckCircle2 size={11} />
                  ) : (
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: active ? t.accent : t.cellBorder, animation: active ? 'dql-pip 1s ease-in-out infinite' : 'none' }} />
                  )}
                  {s.label}
                </span>
              </React.Fragment>
            );
          })}
        </div>

        {activityCards.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6, marginTop: 2 }}>
            {activityCards.map((card) => (
              <div key={`${card.title}-${card.detail}`} style={{ minWidth: 0, padding: '7px 8px', border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.cellBg, display: 'grid', gap: 3 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: t.accent, fontSize: 10.5, fontWeight: 800 }}><card.Icon size={11} />{card.title}</span>
                <span style={{ color: t.textMuted, fontSize: 10.5, lineHeight: 1.35 }}>{card.detail}</span>
              </div>
            ))}
          </div>
        ) : null}

        {longRunGuidance && !streamingAnswer ? (
          <div style={{ display: 'grid', gap: 3, marginTop: 2, padding: '8px 9px', border: `1px solid ${t.accent}33`, borderRadius: 7, background: `${t.accent}0a` }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: t.textSecondary, fontSize: 11, fontWeight: 800 }}>
              <Lightbulb size={11} color={t.accent} /> {longRunGuidance.title}
            </span>
            <span style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.45 }}>{longRunGuidance.detail}</span>
          </div>
        ) : slowReason && !streamingAnswer ? (
          <span style={{ fontSize: 11, color: t.textMuted, fontStyle: 'italic', lineHeight: 1.4 }}>{slowReason}</span>
        ) : null}

        {streamingAnswer ? (
          <div style={{ fontSize: 13, lineHeight: 1.55, color: t.textPrimary, whiteSpace: 'pre-wrap', marginTop: 2 }}>{streamingAnswer}</div>
        ) : latest ? (
          <span key={latest} style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.4, animation: 'dql-step-in 0.3s ease-out' }}>{latest}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Render a capped list with a "Show all (N)" toggle instead of silently clipping. */
function ExpandableList<T>({ items, t, renderItem, cap = 4 }: {
  items: T[];
  t: Theme;
  renderItem: (item: T, index: number) => React.ReactNode;
  cap?: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, cap);
  return (
    <>
      {shown.map((item, index) => renderItem(item, index))}
      {items.length > cap ? (
        <button
          type="button"
          className="dql-hover"
          onClick={() => setExpanded((v) => !v)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', color: t.accent, fontSize: 11, padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? 'Show less' : `Show all (${items.length})`}
        </button>
      ) : null}
    </>
  );
}

function RunCard({
  run,
  t,
  themeMode,
  appContext,
  onOpenApp,
  onInsertSql,
  onInsertDql,
  onOpenBlock,
  onOpenResearch,
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  appContext?: { appId?: string; dashboardId?: string };
  onOpenApp?: (appId: string, dashboardId?: string) => void;
  onInsertSql?: (sql: string, title?: string) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onNextAction: (action: AgentRun['nextActions'][number]) => void;
}) {
  const { dispatch } = useNotebook();
  // A conversational reply renders as a plain assistant bubble — no route label,
  // trust badge, checks, or evidence. Just the answer + optional suggestion chips.
  if (run.route === 'conversation') {
    const isGeneralKnowledge = run.answerKind === 'general_knowledge';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-agent-fadein 0.3s ease-out' }}>
        <div style={assistantBubbleStyle(t)}>
          {isGeneralKnowledge ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: t.textMuted, marginBottom: 6, fontWeight: 650 }}>
              <Lightbulb size={11} /> General knowledge — not from your data
            </div>
          ) : null}
          <div style={{ fontSize: 13.5, lineHeight: 1.55, color: t.textPrimary }}>
            {run.answer ? <StructuredAnswerText text={cleanAnswerText(run.answer)} t={t} /> : run.summary}
          </div>
        </div>
        {run.nextActions.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.nextActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="dql-hover dql-lift"
                onClick={() => onNextAction(action)}
                style={suggestionChipStyle(t)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const steps = run.steps ?? [];
  const multiStep = steps.length > 1;
  const isLlmPlan = run.plan?.source === 'llm';
  const evidence = evidenceFromRun(run);
  const trustNote = trustExplainer(run);
  const hasMixedSourcePlan = run.artifacts.some((artifact) =>
    Boolean(extractMixedSourceNotebookPlan(payloadOf(artifact))),
  );
  // A result worth saving: a real answer or research artifact (not blocked/clarify).
  const pinnable = !hasMixedSourcePlan && run.status !== 'blocked' && run.status !== 'needs_clarification'
    && (Boolean(run.answer) || run.artifacts.some((a) => a.kind === 'answer' || a.kind === 'research_run'));
  // Offer a one-click deepening on quick answers (unless the agent already routed deep).
  const isAnswer = run.route === 'certified_answer' || run.route === 'generated_answer';
  const hasResearchAction = run.nextActions.some((a) => a.route === 'research');
  const showResearchDeeper = isAnswer && pinnable && !hasResearchAction;
  const sourceArtifact = answerDqlArtifactFromRun(run);
  const canSaveBlock = pinnable && !sourceArtifact?.sourcePath && Boolean(sourceArtifact?.source ?? answerSqlFromRun(run));
  const startedAtMs = Date.parse(run.startedAt);
  const completedAtMs = Date.parse(run.completedAt);
  const elapsedSeconds = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, Math.round((completedAtMs - startedAtMs) / 1_000))
    : 0;
  const completedGuidance = completedRunGuidanceFor(elapsedSeconds, run.route, run.trustState, run.repairAttempts);
  return (
    <div style={runCardStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusIcon run={run} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 850, color: t.textPrimary }}>{simpleRunTitle(run)}</div>
        </div>
        <TrustBadge run={run} t={t} />
      </div>

      {trustNote ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, color: t.textMuted, lineHeight: 1.4 }}>
          {run.trustState === 'certified' ? <ShieldCheck size={12} color={t.success} style={{ flex: '0 0 auto', marginTop: 1 }} /> : run.trustState === 'governed' || run.trustState === 'grounded' ? <ShieldCheck size={12} color={t.accent} style={{ flex: '0 0 auto', marginTop: 1 }} /> : <ShieldAlert size={12} color={t.warning} style={{ flex: '0 0 auto', marginTop: 1 }} />}
          <span>{trustNote}</span>
        </div>
      ) : null}

      {(isLlmPlan || multiStep || run.repairAttempts > 0) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {isLlmPlan ? <MetaChip t={t} icon={<ListTree size={11} />} label="AI plan" tone="accent" /> : null}
          {multiStep ? <MetaChip t={t} icon={<Route size={11} />} label={`${steps.length} steps`} tone="muted" /> : null}
          {run.repairAttempts > 0 ? <MetaChip t={t} icon={<Wrench size={11} />} label={`${run.repairAttempts} repair${run.repairAttempts > 1 ? 's' : ''}`} tone="warning" /> : null}
        </div>
      ) : null}

      {run.summary && !(run.answer && sameText(cleanPresentationText(run.summary), cleanAnswerText(run.answer))) ? (
        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: t.textSecondary }}>{cleanPresentationText(run.summary)}</div>
      ) : null}
      {run.answer ? <div style={answerBoxStyle(t)}><StructuredAnswerText text={cleanAnswerText(run.answer)} t={t} /></div> : null}

      {evidence.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: t.textMuted }}>Evidence:</span>
          {evidence.map((ev) => (
            <span key={ev.label} style={evidenceChipStyle(t, ev.certified)}>
              {ev.certified ? <ShieldCheck size={11} /> : <FileSearch size={11} />}
              <span>{ev.label}</span>
            </span>
          ))}
        </div>
      ) : null}

      <AppliedLearnings run={run} t={t} />

      {run.artifacts.length > 0 ? (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
          {run.artifacts.map((artifact) => (
            <ArtifactView
              key={artifact.id}
              artifact={artifact}
              t={t}
              themeMode={themeMode}
              onInsertSql={onInsertSql}
              onInsertDql={onInsertDql}
              onOpenBlock={onOpenBlock}
              onOpenResearch={onOpenResearch}
              onOpenApp={onOpenApp}
              onNextAction={onNextAction}
            />
          ))}
        </div>
      ) : null}

      {multiStep ? (
        <StepTrace steps={steps} t={t} />
      ) : (
        <VerificationChecks evaluations={run.evaluations} t={t} />
      )}

      {run.events.length > 0 ? (
        <button
          type="button"
          className="dql-hover"
          onClick={() => dispatch({ type: 'OPEN_AGENT_LOG', run })}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
            background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
            color: t.textMuted, fontSize: 11.5, fontFamily: t.font,
          }}
          title="See what the agent did and where the time went"
        >
          <ListTree size={12} /> View steps · where the time went
        </button>
      ) : null}

      {completedGuidance ? (
        <div style={{ display: 'grid', gap: 3, padding: '8px 9px', border: `1px solid ${t.accent}33`, borderRadius: 7, background: `${t.accent}0a` }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: t.textSecondary, fontSize: 11, fontWeight: 800 }}>
            <Lightbulb size={11} color={t.accent} /> {completedGuidance.title}
          </span>
          <span style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.45 }}>{completedGuidance.detail}</span>
        </div>
      ) : null}

      {(pinnable || showResearchDeeper || run.nextActions.length > 0) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {pinnable ? <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} /> : null}
          {canSaveBlock ? (
            <button type="button" className="dql-hover" onClick={() => onNextAction({ id: 'save-dql-block', label: 'Save as block', route: 'dql_block_draft' })} style={smallButtonStyle(t)}>
              <Save size={11} /> Save as block
            </button>
          ) : null}
          {showResearchDeeper ? (
            <button
              type="button"
              className="dql-hover"
              onClick={() => onNextAction({ id: 'research-deeper', label: 'Research this deeper', route: 'research' })}
              style={smallButtonStyle(t)}
              title="Run a slower, multi-step investigation on this question"
            >
              <FileSearch size={11} />
              Research this deeper
            </button>
          ) : null}
          {/* confirm-app-build is owned by the proposal card itself, not a composer action. */}
          {run.nextActions.filter((a) => a.id !== 'pin-to-app' && a.id !== 'research-deeper' && a.id !== 'confirm-app-build' && a.id !== 'request-certification').map((action) => (
              <button
                key={action.id}
                type="button"
                className="dql-hover"
                onClick={() => onNextAction(action)}
                style={smallButtonStyle(t)}
              >
                {action.label}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Ask redesign — plain-text transcript, artifact chips, inspector, follow-up.
// Adopted from "Ask AI Redesign.dc.html". Reuses the existing run/artifact
// logic (ArtifactView, ResultView, AddToAppButton, trust helpers) so every
// api call and handoff keeps working.
// ══════════════════════════════════════════════════════════════════════════

export type AskInspectorTab = 'dql' | 'sql' | 'lineage' | 'trust';

const ASK_KEYFRAMES = (t: Theme): string => `
  @keyframes dql-agent-run-spin { to { transform: rotate(360deg); } }
  @keyframes dql-agent-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  @keyframes dql-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  @keyframes dql-orb { 0%, 100% { box-shadow: 0 0 0 0 ${t.accent}00; } 50% { box-shadow: 0 0 13px 1px ${t.accent}66; } }
  @keyframes dql-step-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
  .dql-hover { transition: filter .15s ease, transform .12s ease, box-shadow .15s ease, background .15s ease, color .15s ease, border-color .15s ease; }
  .dql-hover:hover { filter: brightness(1.03); }
  .dql-hover:active { transform: translateY(0.5px); }
  .dql-lift:hover { transform: translateY(-1px); }
  .dql-ask-ghost:hover { background: var(--bg-0); color: var(--text-primary) !important; }
  .dql-ask-chip:hover { border-color: var(--accent) !important; box-shadow: 0 1px 6px rgba(107,93,211,0.12); }
  details > summary::-webkit-details-marker { display: none; }
`;

function askUserBubbleStyle(t: Theme): React.CSSProperties {
  return { alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--bg-0)', color: t.textPrimary, borderRadius: '16px 16px 4px 16px', padding: '10px 14px', fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', animation: 'dql-agent-fadein 0.25s ease-out' };
}

function askGhostBtnStyle(t: Theme): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 6, border: 'none', background: 'none', color: t.textMuted, fontSize: 11.5, fontWeight: 550, cursor: 'pointer', fontFamily: t.font };
}

/** Rich artifacts render inline (they own interactive flows); the rest chip out. */
function isRichAskArtifact(artifact: AgentRunArtifact, payload: Record<string, unknown>): boolean {
  return artifact.kind === 'app_proposal'
    || artifact.kind === 'dql_block_draft'
    || artifact.kind === 'research_run'
    || Boolean(extractMixedSourceNotebookPlan(payload));
}

export function askArtifactMeta(artifact: AgentRunArtifact, payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const result = extractResult(payload);
  const kindLabel = artifact.kind === 'answer' ? (result?.rows?.length ? 'Table' : 'Answer')
    : artifact.kind === 'sql_cell' ? 'SQL'
    : artifact.kind === 'dql_block_draft' ? 'DQL block'
    : artifact.kind === 'research_run' ? 'Research'
    : 'Result';
  parts.push(kindLabel);
  const rowCount = result?.rowCount ?? result?.rows?.length;
  if (typeof rowCount === 'number') parts.push(`${rowCount} row${rowCount === 1 ? '' : 's'}`);
  if (typeof result?.executionTime === 'number') {
    parts.push(result.executionTime >= 1000
      ? `${(result.executionTime / 1000).toFixed(1)}s`
      : `${result.executionTime.toFixed(result.executionTime < 10 ? 1 : 0)}ms`);
  }
  parts.push(artifact.trustState === 'certified' ? 'certified block' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'governed' : 'AI-generated');
  return parts.join(' · ');
}

function resultCardTitle(run: AgentRun, artifact: AgentRunArtifact): string {
  const generic = /^(?:certified|governed semantic|review-required|exploratory dbt-grounded) answer$/i.test(artifact.title.trim());
  const source = generic ? run.question : artifact.title;
  const clean = cleanPresentationText(source).replace(/[?.!]+$/, '').trim();
  if (!clean) return 'Answer result';
  const title = clean.charAt(0).toUpperCase() + clean.slice(1);
  return title.length > 88 ? `${title.slice(0, 85).trimEnd()}…` : title;
}

interface AskLineageEntry {
  name: string;
  kind?: string;
  detail?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function lineageEntriesFromRun(run: AgentRun): AskLineageEntry[] {
  const entries: AskLineageEntry[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, fallbackKind?: string) => {
    const record = recordOf(value);
    if (!record) return;
    const name = [record.name, record.label, record.relation, record.objectName]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    if (!name) return;
    const kind = typeof record.kind === 'string' ? record.kind : fallbackKind;
    const key = `${kind ?? ''}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const detail = [record.description, record.provenance, record.sourceTier, record.source]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    entries.push({ name, kind, detail });
  };
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const evidence = recordOf(payload.evidence);
    for (const key of ['lineage', 'sourceTables', 'semanticObjects', 'selectedAssets'] as const) {
      const values = evidence?.[key];
      if (Array.isArray(values)) values.forEach((value) => add(value, key === 'sourceTables' ? 'source' : undefined));
    }
    const plan = recordOf(payload.analysisPlan) ?? recordOf(evidence?.analysisPlan);
    const candidates = plan?.candidateTables;
    if (Array.isArray(candidates)) candidates.forEach((value) => add(value, 'relation'));
  }
  return entries.slice(0, 24);
}

export function preferredAskInspectorTab(run: AgentRun, artifact: AgentRunArtifact): AskInspectorTab {
  const payload = payloadOf(artifact);
  if ((answerDqlArtifactFromRun(run) ?? resolveArtifactDqlView(payload))?.source) return 'dql';
  if (answerSqlFromRun(run) ?? (typeof payload.sql === 'string' ? payload.sql : undefined)) return 'sql';
  if (lineageEntriesFromRun(run).length > 0) return 'lineage';
  return 'trust';
}

function InlineAskResultCard({
  run,
  artifact,
  selected,
  t,
  themeMode,
  onInspect,
}: {
  run: AgentRun;
  artifact: AgentRunArtifact;
  selected: boolean;
  t: Theme;
  themeMode: ThemeMode;
  onInspect: (tab: AskInspectorTab) => void;
}) {
  const payload = payloadOf(artifact);
  const result = extractResult(payload);
  if (!result) return null;
  const chartConfig = inlineAskChartConfig(payload, result);
  const inspectorTab = preferredAskInspectorTab(run, artifact);
  return (
    <section
      data-followup="table"
      aria-label={`${resultCardTitle(run, artifact)} result`}
      style={{ border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`, borderRadius: 12, background: 'var(--bg-2)', overflow: 'hidden', boxShadow: selected ? '0 2px 10px rgba(107,93,211,0.12)' : '0 1px 3px rgba(26,26,26,0.04)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: artifact.trustState === 'certified' ? 'var(--status-success-bg)' : 'var(--accent-dim)', color: artifact.trustState === 'certified' ? 'var(--status-success)' : 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ArtifactIcon kind={artifact.kind} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: t.textPrimary, lineHeight: 1.35 }}>{resultCardTitle(run, artifact)}</div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>{askArtifactMeta(artifact, payload)}</div>
        </div>
        <button type="button" className="dql-ask-ghost" onClick={() => onInspect(inspectorTab)} style={askGhostBtnStyle(t)}>
          <ListTree size={12} /> Inspect
        </button>
      </div>
      <ResultView
        result={result}
        themeMode={themeMode}
        t={t}
        chartConfig={chartConfig}
        embedded
        tabLabels={{ table: 'Results', chart: 'Visualization' }}
      />
    </section>
  );
}

function AskRunCard({
  run,
  t,
  themeMode,
  appContext,
  selectedArtifactId,
  onOpenArtifact,
  onOpenApp,
  onInsertSql,
  onInsertDql,
  insertDqlActionLabel,
  onOpenBlock,
  onOpenResearch,
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  appContext?: { appId?: string; dashboardId?: string };
  selectedArtifactId?: string;
  onOpenArtifact?: (artifactId: string, tab: AskInspectorTab) => void;
  onOpenApp?: (appId: string, dashboardId?: string) => void;
  onInsertSql?: (sql: string, title?: string) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  insertDqlActionLabel?: string;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onNextAction: (action: AgentRun['nextActions'][number]) => void;
}) {
  const { dispatch } = useNotebook();
  const [copied, setCopied] = useState(false);
  const openArtifact = onOpenArtifact ?? (() => dispatch({ type: 'OPEN_AGENT_LOG', run }));

  // Conversational replies stay a plain bubble — no trust line, chips, or actions.
  if (run.route === 'conversation') {
    const isGeneralKnowledge = run.answerKind === 'general_knowledge';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-agent-fadein 0.3s ease-out', maxWidth: '100%' }}>
        {isGeneralKnowledge ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: t.textMuted, fontWeight: 650 }}>
            <Lightbulb size={11} /> General knowledge — not from your data
          </div>
        ) : null}
        <div data-followup="answer" style={{ fontSize: 14.5, lineHeight: 1.65, color: t.textPrimary }}>
          {run.answer ? <StructuredAnswerText text={cleanAnswerText(run.answer)} t={t} /> : run.summary}
        </div>
        {run.nextActions.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.nextActions.map((action) => (
              <button key={action.id} type="button" className="dql-hover dql-lift" onClick={() => onNextAction(action)} style={suggestionChipStyle(t)}>{action.label}</button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const certified = run.trustState === 'certified';
  const passedChecks = run.evaluations.filter((e) => e.severity === 'info').length;
  const evidence = evidenceFromRun(run);
  const inlineResultArtifacts = run.artifacts.filter((artifact) => {
    const payload = payloadOf(artifact);
    return !isRichAskArtifact(artifact, payload) && Boolean(extractResult(payload));
  });
  const inlineResultIds = new Set(inlineResultArtifacts.map((artifact) => artifact.id));
  const chipArtifacts = run.artifacts.filter((a) => !isRichAskArtifact(a, payloadOf(a)) && !inlineResultIds.has(a.id));
  const richArtifacts = run.artifacts.filter((a) => isRichAskArtifact(a, payloadOf(a)));
  const primaryArtifact = inlineResultArtifacts[0] ?? chipArtifacts[0] ?? run.artifacts[0];

  // Reuse RunCard's action gating so the quiet row offers the same real actions.
  const hasMixedSourcePlan = run.artifacts.some((a) => Boolean(extractMixedSourceNotebookPlan(payloadOf(a))));
  const pinnable = !hasMixedSourcePlan && run.status !== 'blocked' && run.status !== 'needs_clarification'
    && (Boolean(run.answer) || run.artifacts.some((a) => a.kind === 'answer' || a.kind === 'research_run'));
  const isAnswer = run.route === 'certified_answer' || run.route === 'semantic_answer' || run.route === 'generated_answer';
  const hasResearchAction = run.nextActions.some((a) => a.route === 'research');
  const showResearchDeeper = isAnswer && pinnable && !hasResearchAction;
  const sourceArtifact = answerDqlArtifactFromRun(run);
  const canSaveBlock = pinnable && !sourceArtifact?.sourcePath && Boolean(sourceArtifact?.source ?? answerSqlFromRun(run));
  const insertionPayload = insertDqlActionLabel && onInsertDql ? artifactReadyPayloadFromRun(run) : undefined;

  const copyAnswer = () => {
    const text = run.answer ? cleanAnswerText(run.answer) : run.summary;
    if (!text) return;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '100%', animation: 'dql-agent-fadein 0.3s ease-out' }}>
      {/* Trust line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {certified ? <ShieldCheck size={14} color={t.success} /> : <Sparkles size={14} color={t.accent} />}
        <span style={{ fontSize: 12, fontWeight: 650, color: t.textSecondary }}>{certified ? 'Certified answer' : 'AI-generated answer'}</span>
        {certified && evidence[0] ? (
          <span style={{ fontSize: 11, color: t.textMuted }}>from <span style={{ color: t.accent, fontWeight: 600 }}>{evidence[0].label}</span></span>
        ) : primaryArtifact && passedChecks > 0 ? (
          <button type="button" onClick={() => openArtifact(primaryArtifact.id, 'trust')} style={{ fontSize: 11, color: t.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: t.font, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={11} color={t.success} /> {passedChecks} check{passedChecks === 1 ? '' : 's'} passed
          </button>
        ) : null}
      </div>

      {/* Answer (plain text, selectable for follow-up) */}
      {run.answer ? (
        <div data-followup="answer" style={{ fontSize: 14.5, lineHeight: 1.65, color: t.textPrimary }}>
          <StructuredAnswerText text={cleanAnswerText(run.answer)} t={t} />
        </div>
      ) : run.summary ? (
        <div data-followup="answer" style={{ fontSize: 14, lineHeight: 1.6, color: t.textSecondary }}>{cleanPresentationText(run.summary)}</div>
      ) : null}

      {/* Executed results live in the transcript; the inspector owns DQL/SQL/lineage/trust. */}
      {inlineResultArtifacts.map((artifact) => (
        <InlineAskResultCard
          key={artifact.id}
          run={run}
          artifact={artifact}
          selected={artifact.id === selectedArtifactId}
          t={t}
          themeMode={themeMode}
          onInspect={(tab) => openArtifact(artifact.id, tab)}
        />
      ))}

      {/* Artifact chips */}
      {chipArtifacts.map((artifact) => {
        const payload = payloadOf(artifact);
        const selected = artifact.id === selectedArtifactId;
        return (
          <button
            key={artifact.id}
            type="button"
            className="dql-ask-chip"
            onClick={() => openArtifact(artifact.id, preferredAskInspectorTab(run, artifact))}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: 'fit-content', maxWidth: '100%', padding: '9px 12px', borderRadius: 10, border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`, background: 'var(--bg-2)', boxShadow: selected ? '0 1px 6px rgba(107,93,211,0.12)' : 'none', cursor: 'pointer', textAlign: 'left', fontFamily: t.font }}
          >
            <span style={{ width: 30, height: 30, borderRadius: 7, background: artifact.trustState === 'certified' ? 'var(--status-success-bg)' : 'var(--accent-dim)', color: artifact.trustState === 'certified' ? 'var(--status-success)' : 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ArtifactIcon kind={artifact.kind} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cleanPresentationText(artifact.title)}</span>
              <span style={{ fontSize: 11, color: t.textMuted }}>{askArtifactMeta(artifact, payload)}</span>
            </span>
            <ChevronRight size={14} color={t.textMuted} style={{ flexShrink: 0, marginLeft: 6 }} />
          </button>
        );
      })}

      {/* Rich artifacts render inline to preserve their interactive flows */}
      {richArtifacts.length > 0 ? (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
          {richArtifacts.map((artifact) => (
            <ArtifactView
              key={artifact.id}
              artifact={artifact}
              t={t}
              themeMode={themeMode}
              onInsertSql={onInsertSql}
              onInsertDql={onInsertDql}
              onOpenBlock={onOpenBlock}
              onOpenResearch={onOpenResearch}
              onOpenApp={onOpenApp}
              onNextAction={onNextAction}
            />
          ))}
        </div>
      ) : null}

      {/* Quiet action row */}
      {(run.answer || insertionPayload || pinnable || canSaveBlock || showResearchDeeper || primaryArtifact) ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', marginTop: -2 }}>
          {insertionPayload && onInsertDql ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onInsertDql(insertionPayload)} style={askGhostBtnStyle(t)}>
              <Plus size={12} /> {insertDqlActionLabel}
            </button>
          ) : null}
          {run.answer ? (
            <button type="button" className="dql-ask-ghost" onClick={copyAnswer} style={askGhostBtnStyle(t)}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
          {pinnable ? <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} /> : null}
          {canSaveBlock ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onNextAction({ id: 'save-dql-block', label: 'Save as block', route: 'dql_block_draft' })} style={askGhostBtnStyle(t)}>
              <Blocks size={12} /> Save as block
            </button>
          ) : null}
          {showResearchDeeper ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onNextAction({ id: 'research-deeper', label: 'Research this deeper', route: 'research' })} style={askGhostBtnStyle(t)}>
              <FileSearch size={12} /> Research deeper
            </button>
          ) : null}
          {primaryArtifact ? (
            <button type="button" className="dql-ask-ghost" onClick={() => openArtifact(primaryArtifact.id, 'trust')} style={askGhostBtnStyle(t)}>
              <ListTree size={12} /> How it was answered
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AskInspector({
  run,
  artifact,
  tab,
  t,
  appContext,
  onOpenApp,
  onChangeTab,
  onClose,
  onSaveBlock,
}: {
  run: AgentRun;
  artifact: AgentRunArtifact;
  tab: AskInspectorTab;
  t: Theme;
  appContext?: { appId?: string; dashboardId?: string };
  onOpenApp?: (appId: string, dashboardId?: string) => void;
  onChangeTab: (tab: AskInspectorTab) => void;
  onClose: () => void;
  onSaveBlock: () => void;
}) {
  const payload = payloadOf(artifact);
  const dqlArtifact = answerDqlArtifactFromRun(run) ?? resolveArtifactDqlView(payload);
  const sql = answerSqlFromRun(run) ?? (typeof payload.sql === 'string' ? payload.sql : undefined);
  const evidence = evidenceFromRun(run);
  const lineage = lineageEntriesFromRun(run);
  const trustNote = trustExplainer(run);
  const certified = artifact.trustState === 'certified';

  const tabs: Array<{ id: AskInspectorTab; label: string }> = [];
  if (dqlArtifact?.source) tabs.push({ id: 'dql', label: 'DQL' });
  if (sql) tabs.push({ id: 'sql', label: 'SQL' });
  if (lineage.length > 0) tabs.push({ id: 'lineage', label: 'Lineage' });
  tabs.push({ id: 'trust', label: 'Trust & steps' });
  const activeTab = tabs.some((x) => x.id === tab) ? tab : tabs[0].id;

  const badgeLabel = certified ? 'Certified' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'Governed' : 'AI-generated';
  const badgeColor = certified ? 'var(--status-success)' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'var(--accent)' : 'var(--status-warning)';
  const badgeBg = certified ? 'var(--status-success-bg)' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'var(--accent-dim)' : 'var(--status-warning-bg)';

  return (
    <div style={{ width: 'clamp(300px, 34vw, 440px)', flexShrink: 0, background: 'var(--bg-2)', borderLeft: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: badgeBg, color: badgeColor, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: '1px solid var(--border-subtle)' }}>
          <ArtifactIcon kind={artifact.kind} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary, lineHeight: 1.35 }}>{resultCardTitle(run, artifact)}</div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>{askArtifactMeta(artifact, payload)}</div>
        </div>
        <span style={{ border: `1px solid ${badgeColor}`, color: badgeColor, background: badgeBg, borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>{badgeLabel}</span>
        <button type="button" onClick={onClose} title="Close" className="dql-ask-ghost" style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'none', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} />
        <button type="button" className="dql-hover" onClick={onSaveBlock} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: t.textSecondary, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>
          <Blocks size={13} /> Save as block
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" title="More" className="dql-hover" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <MoreHorizontal size={14} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        {tabs.map((x) => (
          <button key={x.id} type="button" onClick={() => onChangeTab(x.id)} style={{ padding: '10px 1px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'none', fontFamily: t.font, whiteSpace: 'nowrap', color: activeTab === x.id ? t.textPrimary : t.textMuted, boxShadow: activeTab === x.id ? `inset 0 -2px 0 0 ${t.accent}` : 'none' }}>{x.label}</button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px 20px' }}>
        {activeTab === 'dql' && dqlArtifact?.source ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: t.textMuted }}>Reusable governed artifact — save it as a block to certify.</span>
              <CopyButton text={dqlArtifact.source} t={t} title="Copy DQL" />
            </div>
            <pre style={codeStyle(t)}>{dqlArtifact.source}</pre>
          </>
        ) : null}
        {activeTab === 'sql' && sql ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: t.textMuted }}>Compiled SQL preview — grounded against your dbt schema.</span>
              <CopyButton text={sql} t={t} title="Copy SQL" />
            </div>
            <pre style={codeStyle(t)}>{sql}</pre>
          </>
        ) : null}
        {activeTab === 'lineage' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>Governed semantic objects and physical sources used to produce this result.</div>
            {lineage.map((entry) => (
              <div key={`${entry.kind ?? 'asset'}:${entry.name}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-1)' }}>
                <GitBranch size={13} color={t.accent} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary }}>{entry.name}</div>
                  <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 2 }}>{[entry.kind, entry.detail].filter(Boolean).join(' · ')}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {activeTab === 'trust' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {trustNote ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: certified ? 'var(--status-success-bg)' : 'var(--status-warning-bg)', border: `1px solid ${certified ? 'var(--status-success-border)' : 'var(--status-warning-border)'}` }}>
                {certified ? <ShieldCheck size={13} color="var(--status-success)" style={{ flexShrink: 0, marginTop: 1 }} /> : <ShieldAlert size={13} color="var(--status-warning)" style={{ flexShrink: 0, marginTop: 1 }} />}
                <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>{trustNote}</span>
              </div>
            ) : null}
            {evidence.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Evidence</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {evidence.map((ev) => (
                    <span key={ev.label} style={evidenceChipStyle(t, ev.certified)}>
                      {ev.certified ? <ShieldCheck size={11} /> : <FileSearch size={11} />}<span>{ev.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {run.evaluations.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Verification checks</div>
                <VerificationChecks evaluations={run.evaluations} t={t} />
              </div>
            ) : null}
            {run.steps.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Steps</div>
                <StepTrace steps={run.steps} t={t} />
              </div>
            ) : null}
            <AppliedLearnings run={run} t={t} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FollowUpPopover({
  t,
  text,
  source,
  left,
  top,
  draft,
  inputRef,
  onDraftChange,
  onClose,
  onSend,
}: {
  t: Theme;
  text: string;
  source: 'answer' | 'table';
  left: number;
  top: number;
  draft: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onSend: (question: string) => void;
}) {
  const chip = (label: string, question: string) => (
    <button type="button" onClick={() => onSend(question)} style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-1)', color: t.textSecondary, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 550, cursor: 'pointer', fontFamily: t.font }}>{label}</button>
  );
  return (
    <div data-selpop="true" style={{ position: 'fixed', left, top, zIndex: 90, width: 324, background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: '0 10px 32px rgba(26,26,26,0.16)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-agent-fadein 0.14s ease-out', fontFamily: t.font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkles size={12} color={t.accent} />
        <span style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary }}>Follow up on this</span>
        <span style={{ fontSize: 10, color: t.textMuted }}>{source === 'table' ? 'from the result' : 'from the answer'}</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose} style={{ width: 20, height: 20, borderRadius: 5, border: 'none', background: 'none', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}><X size={12} /></button>
      </div>
      <div style={{ borderLeft: `2px solid ${t.accent}`, background: 'var(--accent-dim)', borderRadius: '0 6px 6px 0', padding: '5px 9px', fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>“{text}”</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSend(draft); } }}
          placeholder="Ask about this…"
          style={{ flex: 1, minWidth: 0, border: '1px solid var(--border-default)', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontFamily: t.font, color: t.textPrimary, background: 'var(--bg-1)', outline: 'none' }}
        />
        <button type="button" onClick={() => onSend(draft)} title="Send follow-up" style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowUp size={13} /></button>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {chip('Why is this?', 'Why is this happening?')}
        {chip('Root cause', 'What is the root cause?')}
        {chip('Break it down', 'Break this down further')}
      </div>
    </div>
  );
}

function defaultAppName(question: string): string {
  const cleaned = question.replace(/^\/\w+\s+/, '').trim().replace(/[?.!]+$/, '');
  const title = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'New app';
  return title.slice(0, 60);
}

/**
 * Hero "Add to app" action. Always available on a pinnable result: opens a small
 * picker to choose an existing app (one click) or create a new one, resolves the
 * target dashboard, then writes the AI pin. Composed entirely from existing APIs.
 */
function AddToAppButton({
  run,
  t,
  appContext,
  onOpenApp,
}: {
  run: AgentRun;
  t: Theme;
  appContext?: { appId?: string; dashboardId?: string };
  onOpenApp?: (appId: string, dashboardId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<AppSummary[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<'list' | 'new'>('list');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ appId: string; dashboardId?: string; name: string } | null>(null);
  // Remember an app created this session so a failed-pin retry reuses it (no orphans).
  const createdRef = useRef<{ appId: string; dashboardId: string } | null>(null);

  const loadApps = async () => {
    setApps(null);
    setLoadError(false);
    try {
      const list = await api.listAppsStrict();
      setApps(list);
      if (list.length === 0) setView('new');
    } catch {
      // A failed load must NOT look like "you have no apps" (would cause duplicates).
      setApps([]);
      setLoadError(true);
    }
  };

  const openPicker = () => {
    setOpen(true);
    setError(null);
    setView('list');
    createdRef.current = null;
    setNewName(defaultAppName(run.question));
    void loadApps();
  };

  const closePicker = () => {
    if (busy) return; // don't dismiss mid-write (would hide the error/result)
    setOpen(false);
    setError(null);
  };

  const pinTo = async (appId: string, dashboardId: string, name: string) => {
    const dqlArtifact = answerDqlArtifactFromRun(run);
    const result = await api.createAiPin(appId, {
      dashboardId,
      title: defaultAppName(run.question),
      answer: run.answer ?? run.summary,
      question: run.question,
      sql: answerSqlFromRun(run),
      certification: run.trustState === 'certified' ? 'certified' : 'ai_generated',
      reviewStatus: run.trustState === 'certified' ? 'certified' : 'needs_review',
      analysisPlan: dqlArtifact ? { dqlArtifact } : undefined,
    });
    if (!result.ok) throw new Error('Could not add to app.');
    setDone({ appId, dashboardId, name });
    setOpen(false);
  };

  const addToExisting = async (app: AppSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let dashboardId = appContext?.appId === app.id ? appContext.dashboardId : undefined;
      if (!dashboardId) {
        const doc = await api.getApp(app.id);
        const home = doc?.app?.homepage;
        dashboardId = home?.type === 'dashboard' ? home.id : doc?.dashboards?.[0]?.id;
        if (!dashboardId) {
          const created = await api.createAppDashboard(app.id, { title: 'Overview' });
          if (!created.ok) throw new Error(created.error);
          dashboardId = created.dashboard.id;
        }
      }
      await pinTo(app.id, dashboardId, app.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add to app.');
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    if (busy) return;
    const name = newName.trim() || defaultAppName(run.question);
    setBusy(true);
    setError(null);
    try {
      // Reuse an app already created this session if the prior pin failed.
      if (!createdRef.current) {
        const created = await api.createApp({ name, domain: 'general', dashboardTitle: 'Overview', tags: [], owners: [], selectedBlockIds: [] });
        createdRef.current = { appId: created.app.id, dashboardId: created.dashboardId };
      }
      await pinTo(createdRef.current.appId, createdRef.current.dashboardId, name);
      createdRef.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the app.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {done ? (
        <button
          type="button"
          className="dql-hover"
          onClick={() => onOpenApp?.(done.appId, done.dashboardId)}
          style={{ ...heroAddButtonStyle(t), background: `${t.success}1a`, color: t.success, border: `1px solid ${t.success}55`, boxShadow: 'none', cursor: onOpenApp ? 'pointer' : 'default' }}
          title={onOpenApp ? 'Open the app' : undefined}
        >
          <CheckCircle2 size={13} />
          Added to {done.name}
          {onOpenApp ? <ArrowRight size={13} /> : null}
        </button>
      ) : null}
      <button type="button" className="dql-hover dql-lift" onClick={openPicker} style={done ? smallButtonStyle(t) : heroAddButtonStyle(t)}>
        <LayoutDashboard size={13} />
        {done ? 'Add to another' : 'Add to app'}
      </button>
      {open ? (
        <>
          <div onClick={closePicker} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={addPopoverStyle(t)}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{view === 'new' ? 'Name the new app' : 'Add to an app'}</span>
              <button type="button" onClick={closePicker} style={{ border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
            </div>
            {error ? <div style={{ fontSize: 11, color: t.error, marginBottom: 7, lineHeight: 1.4 }}>{error}</div> : null}
            {view === 'new' ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createAndAdd(); }}
                  placeholder="App name"
                  style={pickerInputStyle(t)}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  {apps && apps.length > 0 ? <button type="button" className="dql-hover" onClick={() => setView('list')} style={smallButtonStyle(t)}>Back</button> : null}
                  <button type="button" className="dql-hover" disabled={busy || !newName.trim()} onClick={() => void createAndAdd()} style={{ ...heroAddButtonStyle(t), flex: 1, justifyContent: 'center' }}>
                    {busy ? <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Plus size={13} />}
                    Create &amp; add
                  </button>
                </div>
              </div>
            ) : apps === null ? (
              <div style={{ fontSize: 11.5, color: t.textMuted, padding: '8px 2px' }}>Loading apps…</div>
            ) : loadError ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 11.5, color: t.error, lineHeight: 1.4 }}>Couldn't load your apps.</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="dql-hover" onClick={() => void loadApps()} style={smallButtonStyle(t)}>Retry</button>
                  <button type="button" className="dql-hover" onClick={() => setView('new')} style={{ ...newAppRowStyle(t), width: 'auto', flex: 1, marginBottom: 0, justifyContent: 'center' }}>
                    <Plus size={13} /> New app…
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 3, maxHeight: 244, overflow: 'auto' }}>
                <button type="button" className="dql-hover" onClick={() => setView('new')} style={newAppRowStyle(t)}>
                  <Plus size={13} /> New app…
                </button>
                {apps.map((app) => (
                  <button key={app.id} type="button" className="dql-hover" disabled={busy} onClick={() => void addToExisting(app)} style={appRowStyle(t)}>
                    <LayoutDashboard size={13} style={{ flex: '0 0 auto', opacity: 0.7 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{app.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Plain-English trust line so a stakeholder knows what they can rely on. */
/**
 * EXP-002 — the trust explainer must reflect execution truth. An exploratory
 * candidate is not an executed answer merely because dbt-grounded SQL exists.
 */
export function trustExplainer(run: AgentRun): string | null {
  if (run.trustState === 'certified') return 'Answered from a certified block.';
  if (run.route === 'dql_block_draft') return 'Saved as a draft block. Add an owner and DQL will certify it when checks pass.';
  if (run.trustState === 'governed') return 'Built from governed metrics and dimensions.';
  if (run.trustState === 'grounded') return 'Ran cleanly against your data. Save it as a block when it is reusable.';
  if (isExploratoryDbtRun(run)) {
    const payloads = run.artifacts
      .map((artifact) => artifact.payload)
      .filter((payload): payload is Record<string, unknown> => Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)));
    const executed = payloads.some((payload) => {
      const result = payload.result;
      return Boolean(result && typeof result === 'object' && !Array.isArray(result));
    });
    if (executed) {
      return 'Exploratory · DBT-grounded. The query and bounded join probes ran, but no certified relationship path covers it yet.';
    }
    const executionError = payloads.find((payload) => typeof payload.executionError === 'string')?.executionError;
    if (typeof executionError === 'string' && executionError.trim()) {
      return 'Exploratory · DBT-grounded. DQL prepared a review-required query, but its bounded execution failed. Inspect the error and DQL artifact before reuse.';
    }
    return 'Exploratory · DBT-grounded. DQL prepared a review-required query, but it has not executed yet.';
  }
  if (run.trustState === 'review_required') return 'AI-generated answer. Save it as a block when you want to keep it.';
  if (run.trustState === 'blocked') return null;
  return null;
}

function isExploratoryDbtRun(run: AgentRun): boolean {
  return run.artifacts.some((artifact) => {
    const payload = artifact.payload;
    return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).exploratoryCandidate);
  });
}

function simpleRunTitle(run: AgentRun): string {
  if (run.trustState === 'certified') return 'Certified answer';
  if (run.route === 'dql_block_draft') return 'Draft block';
  if (isExploratoryDbtRun(run)) return 'Exploratory DBT-grounded answer';
  if (run.route === 'semantic_answer') return 'Semantic answer';
  if (run.route === 'generated_answer') return 'AI-generated answer';
  return ROUTE_LABEL[run.route];
}

/**
 * The `app_proposal` artifact card: the confirmable pre-create content list from the
 * two-phase app build. Owns the whole confirm flow — per-tile toggles, the Create
 * call to the commit endpoint (a plain REST call keyed by sessionId, same pattern as
 * AddToAppButton), and the created-app success state with an Open link.
 */
function AppProposalArtifact({
  artifact,
  payload,
  t,
  onOpenApp,
}: {
  artifact: AgentRunArtifact;
  payload: Record<string, unknown>;
  t: Theme;
  onOpenApp?: (appId: string, dashboardId?: string) => void;
}) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const proposal = payload.proposal && typeof payload.proposal === 'object'
    ? payload.proposal as AppBuildProposal
    : undefined;
  const proposalHash = typeof payload.proposalHash === 'string' ? payload.proposalHash : undefined;
  const [selected, setSelected] = useState<Set<string>>(() => (proposal ? defaultProposalSelection(proposal) : new Set()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ appId: string; dashboardId?: string; name: string } | null>(null);

  if (!proposal || !sessionId) {
    return (
      <div style={artifactStyle(t)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArtifactIcon kind={artifact.kind} />
          <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary }}>{artifact.title}</div>
        </div>
        <div style={{ fontSize: 11.5, color: t.textMuted }}>This proposal is no longer available. Ask again to rebuild it.</div>
      </div>
    );
  }

  const commit = async () => {
    setBusy(true);
    setError(null);
    const result = await api.commitAppAiBuild(sessionId, { selectedTileIds: Array.from(selected), expectedProposalHash: proposalHash });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreated({
      appId: result.app?.id ?? result.session.appId ?? '',
      dashboardId: result.dashboardId ?? undefined,
      name: result.app?.name ?? artifact.title,
    });
  };

  return (
    <div style={artifactStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ArtifactIcon kind={artifact.kind} />
        <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cleanPresentationText(artifact.title)}
        </div>
      </div>
      {created ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: t.success, fontSize: 12, fontWeight: 750 }}>
            <CheckCircle2 size={13} /> Created {created.name}
          </span>
          {created.appId && onOpenApp ? (
            <button type="button" className="dql-hover" onClick={() => onOpenApp(created.appId, created.dashboardId)} style={smallButtonStyle(t)}>
              Open app
            </button>
          ) : null}
        </div>
      ) : (
        <AppBuildProposalPanel
          proposal={proposal}
          t={t}
          selected={selected}
          onToggle={(tileId) => {
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(tileId)) next.delete(tileId);
              else next.add(tileId);
              return next;
            });
          }}
          onCreate={() => void commit()}
          busy={busy}
          error={error}
          compact
        />
      )}
    </div>
  );
}

function ExecutableDqlResult({
  artifact,
  certifiedBlockName,
  initialResult,
  initialChartConfig,
  payload,
  t,
  themeMode,
}: {
  artifact: AgentConversationDqlArtifact;
  certifiedBlockName?: string;
  initialResult: QueryResult;
  initialChartConfig?: CellChartConfig;
  payload: Record<string, unknown>;
  t: Theme;
  themeMode: ThemeMode;
}) {
  const [parameters, setParameters] = useState<BlockParameterDefinition[]>(() => artifact.parameters ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...(artifact.parameterValues ?? {}),
    ...resolvedParameterValues(payload),
  }));
  const [result, setResult] = useState(initialResult);
  const [chartConfig, setChartConfig] = useState<CellChartConfig | undefined>(initialChartConfig);
  const [loading, setLoading] = useState(Boolean(certifiedBlockName));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!certifiedBlockName) {
      setParameters(artifact.parameters ?? []);
      setValues((current) => ({ ...(artifact.parameterValues ?? {}), ...current }));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api.getCertifiedBlockParameters(certifiedBlockName)
      .then((response) => {
        if (cancelled) return;
        setParameters(response.parameters);
        setValues((current) => ({
          ...Object.fromEntries(response.parameters.flatMap((parameter) => parameter.default === undefined ? [] : [[parameter.name, parameter.default]])),
          ...current,
        }));
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [artifact, certifiedBlockName]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await api.invokeDqlArtifact(artifact, values, undefined, certifiedBlockName);
      setResult(response.result);
      if (response.result.chartConfig && typeof response.result.chartConfig === 'object') {
        setChartConfig(response.result.chartConfig as CellChartConfig);
      }
      if (response.parameters.length > 0) setParameters(response.parameters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  const editable = parameters.some(isRuntimeEditableParameter);
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      {loading ? <div style={{ fontSize: 10.5, color: t.textMuted }}>Loading reusable inputs…</div> : editable ? (
        <div style={{ display: 'grid', gap: 8, padding: 9, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.appBg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.textPrimary }}>Change DQL inputs</div>
              <div style={{ fontSize: 10, color: t.textMuted }}>Reruns this DQL artifact directly. It does not start another AI search.</div>
            </div>
            <button type="button" disabled={running} onClick={() => void run()} style={{ ...smallButtonStyle(t), color: t.accent, opacity: running ? .65 : 1 }}>
              {running ? <Loader2 size={11} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Sparkles size={11} />}
              {running ? 'Running…' : 'Apply'}
            </button>
          </div>
          <BlockParameterControls parameters={parameters} values={values} onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))} t={t} />
        </div>
      ) : null}
      {error ? <div style={{ fontSize: 10.5, color: t.error }}>{error}</div> : null}
      <ResultView result={result} themeMode={themeMode} t={t} chartConfig={chartConfig} />
    </div>
  );
}

function resolvedParameterValues(payload: Record<string, unknown>): Record<string, unknown> {
  const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : undefined;
  const raw = Array.isArray(result?.parameters) ? result.parameters : Array.isArray(payload.parameters) ? payload.parameters : [];
  return Object.fromEntries(raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as { name?: unknown; value?: unknown };
    return typeof record.name === 'string' ? [[record.name, record.value]] : [];
  }));
}

function certifiedBlockName(artifact: AgentRunArtifact, payload: Record<string, unknown>): string | undefined {
  const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : undefined;
  const block = payload.block && typeof payload.block === 'object' && !Array.isArray(payload.block)
    ? payload.block as Record<string, unknown>
    : undefined;
  const candidates = [result?.blockName, payload.sourceCertifiedBlock, block?.name, artifact.ref];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
}

function ArtifactView({
  artifact,
  t,
  themeMode,
  onInsertSql,
  onInsertDql,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
  onNextAction,
}: {
  artifact: AgentRunArtifact;
  t: Theme;
  themeMode: ThemeMode;
  onInsertSql?: (sql: string, title?: string) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onOpenApp?: (appId: string, dashboardId?: string) => void;
  onNextAction?: (action: AgentRun['nextActions'][number]) => void;
}) {
  const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload as Record<string, unknown> : {};
  // Two-phase app build: the proposal card owns the confirm flow (toggles + Create).
  if (artifact.kind === 'app_proposal') {
    return <AppProposalArtifact artifact={artifact} payload={payload} t={t} onOpenApp={onOpenApp} />;
  }
  const resultData = extractResult(payload);
  const dqlArtifact = resolveArtifactDqlView(payload);
  const mixedSourcePlan = extractMixedSourceNotebookPlan(payload);
  const sql = typeof payload.sql === 'string'
    ? payload.sql
    : typeof payload.sqlPreview === 'string'
      ? payload.sqlPreview
      : typeof payload.proposedSql === 'string'
        ? payload.proposedSql
        : undefined;
  const name = typeof payload.name === 'string' ? payload.name : artifact.title;
  const path = typeof payload.path === 'string' ? payload.path : artifact.ref;
  const draftBlock = payload.draftBlock && typeof payload.draftBlock === 'object' && !Array.isArray(payload.draftBlock)
    ? payload.draftBlock as Record<string, unknown>
    : undefined;
  const draftBlockPath = typeof draftBlock?.path === 'string' ? draftBlock.path : undefined;
  const draftBlockName = typeof draftBlock?.name === 'string' ? draftBlock.name : undefined;
  const dqlPath = dqlArtifact?.sourcePath ?? draftBlockPath ?? (artifact.kind === 'dql_block_draft' ? path : undefined);
  const dqlName = dqlArtifact?.name ?? draftBlockName ?? name;
  const dqlOpenLabel = dqlArtifact?.kind === 'sql_block' || artifact.kind === 'dql_block_draft'
    ? 'Open DQL draft'
    : 'Open DQL artifact';
  const plan = payload.plan && typeof payload.plan === 'object' ? payload.plan as Record<string, unknown> : undefined;
  const steps = Array.isArray(plan?.steps) ? plan.steps as Array<Record<string, unknown>> : [];
  const gaps = Array.isArray(plan?.gaps) ? plan.gaps.map(String) : [];
  const researchRunId = typeof payload.researchRunId === 'string'
    ? payload.researchRunId
    : artifact.kind === 'research_run' && typeof artifact.ref === 'string'
      ? artifact.ref
      : undefined;
  const notebookPath = typeof payload.notebookPath === 'string' ? payload.notebookPath : undefined;
  const generatedPaths = Array.isArray(payload.generatedPaths)
    ? payload.generatedPaths.filter((item): item is string => typeof item === 'string')
    : [];
  const narration = payload.narration && typeof payload.narration === 'object' ? payload.narration as Record<string, unknown> : undefined;
  const keyFindings = Array.isArray(narration?.keyFindings)
    ? narration.keyFindings.filter((item): item is string => typeof item === 'string')
    : [];
  const recommendation = typeof narration?.recommendation === 'string' ? narration.recommendation : undefined;
  const certifiedName = artifact.trustState === 'certified' ? certifiedBlockName(artifact, payload) : undefined;

  // A governed DQL block draft renders through the shared draft-review card:
  // DQL-first, grounding + enriched metadata + verdict, draft-first status.
  if (artifact.kind === 'dql_block_draft') {
    const strList = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    const verdict = payload.certifierVerdict && typeof payload.certifierVerdict === 'object'
      ? payload.certifierVerdict as { blocking?: unknown; warnings?: unknown; ready?: unknown }
      : undefined;
    return (
      <DraftReviewCard
        t={t}
        name={typeof payload.name === 'string' ? payload.name : name}
        status="draft"
        description={typeof payload.description === 'string' ? payload.description : undefined}
        dql={dqlArtifact?.source ?? (typeof payload.dqlSource === 'string' ? payload.dqlSource : undefined)}
        sqlPreview={sql}
        grain={typeof payload.grain === 'string' ? payload.grain : undefined}
        outputs={strList(payload.outputs)}
        dimensions={strList(payload.dimensions) ?? dqlArtifact?.dimensions}
        entities={strList(payload.entities)}
        certifierVerdict={verdict ? { blocking: strList(verdict.blocking) ?? [], warnings: strList(verdict.warnings) ?? [], ready: Boolean(verdict.ready) } : undefined}
        actions={
          <>
            {sql && onInsertDql ? (
              <button type="button" onClick={() => onInsertDql({ sql, dqlArtifact, result: resultData, chartConfig: resultData ? extractChartConfig(payload, resultData) : undefined, title: name })} style={smallButtonStyle(t)}>Insert as DQL cell</button>
            ) : sql && onInsertSql ? (
              <button type="button" onClick={() => onInsertSql(sql, name)} style={smallButtonStyle(t)}>Insert SQL preview</button>
            ) : null}
            {dqlPath && onOpenBlock ? (
              <button type="button" onClick={() => onOpenBlock(dqlPath, dqlName)} style={smallButtonStyle(t)}>{dqlOpenLabel}</button>
            ) : null}
          </>
        }
      />
    );
  }

  return (
    <div style={artifactStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ArtifactIcon kind={artifact.kind} />
        <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cleanPresentationText(artifact.title)}
        </div>
      </div>
      {keyFindings.length > 0 ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary }}>Key findings</div>
          <ExpandableList
            items={keyFindings}
            t={t}
            renderItem={(finding, index) => (
              <div key={index} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4, display: 'flex', gap: 6 }}>
                <span style={{ color: t.accent }}>•</span><span>{finding}</span>
              </div>
            )}
          />
        </div>
      ) : steps.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          <ExpandableList
            items={steps}
            t={t}
            renderItem={(step, index) => (
              <div key={index} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.35 }}>
                {index + 1}. {String((step as { thought?: unknown; expectation?: unknown }).thought ?? (step as { expectation?: unknown }).expectation ?? 'Research step')}
              </div>
            )}
          />
        </div>
      ) : null}
      {recommendation ? (
        <div style={{ fontSize: 11.5, color: t.textPrimary, lineHeight: 1.4, display: 'flex', gap: 6 }}>
          <span style={{ color: t.accent }}>→</span><span>{recommendation}</span>
        </div>
      ) : null}
      {resultData ? dqlArtifact ? (
        <ExecutableDqlResult
          artifact={dqlArtifact}
          certifiedBlockName={certifiedName}
          initialResult={resultData}
          initialChartConfig={extractChartConfig(payload, resultData)}
          payload={payload}
          t={t}
          themeMode={themeMode}
        />
      ) : <ResultView result={resultData} themeMode={themeMode} t={t} chartConfig={extractChartConfig(payload, resultData)} /> : null}
      {dqlArtifact ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: t.textSecondary, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Blocks size={12} /><span>View DQL artifact</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {dqlArtifact.source ? <CopyButton text={dqlArtifact.source} t={t} title="Copy DQL" /> : null}
              {!dqlPath && onNextAction ? (
                <button
                  type="button"
                  className="dql-hover"
                  title="Save this DQL as a reusable block"
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); onNextAction({ id: 'save-dql-block', label: 'Save as DQL block', route: 'dql_block_draft' }); }}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: t.accent, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, padding: '2px 4px' }}
                >
                  <Save size={12} /> Save as block
                </button>
              ) : null}
            </span>
          </summary>
          {dqlArtifact.sourcePath ? (
            <div style={{ marginTop: 6, fontSize: 10.5, color: t.textMuted }}>
              {dqlArtifact.sourcePath}
            </div>
          ) : null}
          <pre style={{ ...codeStyle(t), marginTop: 6 }}>{dqlArtifact.source}</pre>
        </details>
      ) : null}
      {sql ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: t.textSecondary, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Code2 size={12} /><span>{artifactSqlDisclosureLabel(Boolean(dqlArtifact))}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CopyButton text={sql} t={t} title="Copy SQL" />
            </span>
          </summary>
          <pre style={{ ...codeStyle(t), marginTop: 6 }}>{sql}</pre>
        </details>
      ) : null}
      {gaps.length > 0 ? (
        <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4 }}>
          Gaps: {gaps.join(', ')}
        </div>
      ) : null}
      {generatedPaths.length > 0 ? (
        <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4 }}>
          Files: {generatedPaths.join(', ')}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {researchRunId && onOpenResearch ? (
          <button type="button" onClick={() => onOpenResearch(researchRunId, notebookPath)} style={smallButtonStyle(t)}>Open research</button>
        ) : null}
        {sql && onInsertDql ? (
          <button
            type="button"
            onClick={() => onInsertDql({
              sql,
              dqlArtifact,
              result: resultData,
              chartConfig: resultData ? extractChartConfig(payload, resultData) : undefined,
              title: name,
              mixedSourcePlan,
            })}
            style={mixedSourcePlan ? {
              ...smallButtonStyle(t),
              background: t.accent,
              borderColor: t.accent,
              color: '#fff',
              fontWeight: 850,
              padding: '7px 11px',
            } : smallButtonStyle(t)}
          >
            {mixedSourcePlan ? 'Add workflow to notebook' : dqlArtifact ? 'Insert as DQL cell' : 'Add SQL to notebook'}
          </button>
        ) : sql && onInsertSql ? (
          <button type="button" onClick={() => onInsertSql(sql, name)} style={smallButtonStyle(t)}>Insert SQL preview</button>
        ) : null}
        {dqlPath && onOpenBlock ? (
          <button type="button" onClick={() => onOpenBlock(dqlPath, dqlName)} style={smallButtonStyle(t)}>{dqlOpenLabel}</button>
        ) : null}
      </div>
    </div>
  );
}

function StatusIcon({ run }: { run: AgentRun }) {
  if (run.trustState === 'certified') return <ShieldCheck size={16} color="#16a34a" />;
  if (run.trustState === 'governed') return <ShieldCheck size={16} color="#2563eb" />;
  if (run.trustState === 'grounded') return <ShieldCheck size={16} color="#2563eb" />;
  if (run.status === 'completed') return <CheckCircle2 size={16} color="#16a34a" />;
  if (run.status === 'blocked') return <Route size={16} color="#ef4444" />;
  return <Route size={16} color="#d97706" />;
}

function ArtifactIcon({ kind }: { kind: AgentRunArtifact['kind'] }) {
  if (kind === 'sql_cell') return <Code2 size={14} />;
  if (kind === 'dql_block_draft') return <Blocks size={14} />;
  if (kind === 'app_draft' || kind === 'app_proposal') return <LayoutDashboard size={14} />;
  if (kind === 'research_run') return <FileSearch size={14} />;
  return <Sparkles size={14} />;
}

function TrustBadge({ run, t }: { run: AgentRun; t: Theme }) {
  const color = run.trustState === 'certified'
    ? t.success
    : run.trustState === 'governed' || run.trustState === 'grounded'
      ? t.accent
      : run.trustState === 'blocked'
        ? t.error
        : run.trustState === 'not_applicable'
          ? t.textMuted
          : t.warning;
  const label = run.trustState === 'certified'
    ? 'Certified'
    : run.route === 'dql_block_draft'
      ? 'Draft'
      : isExploratoryDbtRun(run)
        ? 'Exploratory'
      : run.trustState === 'blocked'
        ? 'Needs input'
        : 'AI-generated';
  return (
    <span style={{ border: `1px solid ${color}55`, color, background: `${color}12`, borderRadius: 999, padding: '3px 7px', fontSize: 10, fontWeight: 850 }}>
      {label}
    </span>
  );
}

/**
 * Verification checks for a single-step run. The governance proof matters, but a
 * stack of green "OK" lines clutters the stakeholder view. Any *flagged* check
 * (review / blocking) stays inline so the reason is visible; the passed checks
 * fold into one quiet, collapsed "N checks verified" disclosure.
 */
function VerificationChecks({ evaluations, t }: { evaluations: AgentRun['evaluations']; t: Theme }) {
  if (evaluations.length === 0) return null;
  const flagged = evaluations.filter((evaluation) => !evaluation.passed);
  const passed = evaluations.filter((evaluation) => evaluation.passed);
  return (
    <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {flagged.map((evaluation) => (
        <EvaluationRow key={evaluation.id} evaluation={evaluation} t={t} />
      ))}
      {passed.length > 0 ? (
        <details>
          <summary
            className="dql-hover"
            style={{ cursor: 'pointer', listStyle: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: t.textMuted, width: 'fit-content' }}
          >
            <ShieldCheck size={12} color={t.success} />
            <span>{passed.length} check{passed.length > 1 ? 's' : ''} verified</span>
          </summary>
          <div style={{ display: 'grid', gap: 5, marginTop: 7 }}>
            {passed.map((evaluation) => (
              <EvaluationRow key={evaluation.id} evaluation={evaluation} t={t} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function EvaluationRow({ evaluation, t }: { evaluation: AgentRun['evaluations'][number]; t: Theme }) {
  const color = evaluation.passed ? t.success : evaluation.severity === 'blocking' ? t.error : t.warning;
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: t.textSecondary, minWidth: 0 }}>
      <span style={{ color, lineHeight: '16px', flex: '0 0 auto', fontWeight: 800 }}>
        {evaluation.passed ? 'OK' : evaluation.severity === 'blocking' ? 'Stop' : 'Review'}
      </span>
      {/* minWidth 0 + anywhere: long unbroken tokens (qualified relation names,
          SQL error fragments) must wrap instead of widening the chat column. */}
      <span style={{ lineHeight: 1.4, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
        {evaluation.message}
        {!evaluation.passed && evaluation.suggestedRepair ? (
          <span style={{ display: 'block', color: t.textMuted, marginTop: 1 }}>↳ {evaluation.suggestedRepair}</span>
        ) : null}
      </span>
    </div>
  );
}

function MetaChip({ t, icon, label, tone }: { t: Theme; icon: React.ReactNode; label: string; tone: 'accent' | 'muted' | 'warning' }) {
  const color = tone === 'accent' ? t.accent : tone === 'warning' ? t.warning : t.textMuted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${color}44`, color, background: `${color}10`, borderRadius: 999, padding: '2px 7px', fontSize: 10, fontWeight: 800 }}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

function stepStatusColor(status: AgentRunStepStatus, t: Theme): string {
  switch (status) {
    case 'passed':
      return t.success;
    case 'repaired':
      return t.accent;
    case 'escalated':
      return t.accent;
    case 'blocked':
      return t.error;
    default:
      return t.warning;
  }
}

function StepTrace({ steps, t }: { steps: AgentRunStep[]; t: Theme }) {
  return (
    <details style={{ border: `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: 8, padding: '6px 9px' }}>
      <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 800, color: t.textSecondary, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
        <ListTree size={13} />
        <span>Plan trace · {steps.length} steps</span>
      </summary>
      <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
        {steps.map((step) => {
          const color = stepStatusColor(step.status, t);
          return (
            <div key={step.id} style={{ display: 'grid', gap: 4, paddingLeft: 8, borderLeft: `2px solid ${color}55` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, fontWeight: 850, color: t.textPrimary }}>{step.index}. {ROUTE_LABEL[step.route]}</span>
                <span style={{ border: `1px solid ${color}55`, color, background: `${color}12`, borderRadius: 999, padding: '1px 6px', fontSize: 9.5, fontWeight: 850, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  {step.status === 'escalated' ? <GitBranch size={10} /> : step.status === 'repaired' ? <Wrench size={10} /> : null}
                  {step.status.split('_').join(' ')}
                </span>
                {step.attempts > 1 ? <span style={{ fontSize: 10, color: t.textMuted }}>{step.attempts} attempts</span> : null}
              </div>
              {step.goal ? <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35 }}>{step.goal}</div> : null}
              {step.evaluations.length > 0 ? (
                <div style={{ display: 'grid', gap: 4 }}>
                  {step.evaluations.map((evaluation) => (
                    <EvaluationRow key={evaluation.id} evaluation={evaluation} t={t} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function routeToMode(route?: AgentRunRoute): AgentRunRequestedMode | undefined {
  if (route === 'research') return 'research';
  if (route === 'sql_cell') return 'sql';
  if (route === 'dql_block_draft') return 'block';
  if (route === 'app_build') return 'app';
  if (route === 'certified_answer' || route === 'semantic_answer' || route === 'generated_answer') return 'ask';
  return undefined;
}

function nextPromptFor(run: AgentRun, route?: AgentRunRoute): string {
  if (route === 'sql_cell') return `Create a SQL cell for: ${run.question}`;
  if (route === 'dql_block_draft') return `Create a DQL block draft for: ${run.question}`;
  if (route === 'app_build') return `Build an app for: ${run.question}`;
  if (route === 'research') return `Research deeper: ${run.question}`;
  return run.question;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Strip the internal "Outcome: <reuse|draft|fix|...>" routing line meant for the
 *  notebook parser, plus markdown emphasis markers — stakeholders should see clean
 *  prose, not pipeline jargon or literal asterisks/backticks. */
function cleanAnswerText(answer: string): string {
  return answer
    .replace(/^\s*Outcome\s*:\s*[^\n]*\n+/i, '')
    .replace(/^\s*Review required:\s*/gim, '')
    .replace(/\breview-required\b/gi, 'AI-generated')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^_(.+?)_$/gm, '$1')
    .trim();
}

function cleanPresentationText(value: string): string {
  return value
    .replace(/^\s*Review required:\s*/gim, '')
    .replace(/\breview-required\b/gi, 'AI-generated')
    .replace(/\bqueued for review\b/gi, 'saved as a draft')
    .trim();
}

/** True when two strings say the same thing modulo whitespace/punctuation/case. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s.,!?'"()`*_-]+/g, ' ').trim();
  return norm(a) === norm(b);
}

/** Pull a QueryResult (columns/rows) out of an artifact payload, for visualization. */
function extractResult(payload: Record<string, unknown>): QueryResult | undefined {
  const candidates: unknown[] = [
    payload.result,
    payload.resultPreview,
    (payload.researchRun as { resultPreview?: unknown } | undefined)?.resultPreview,
    (payload.result as { result?: unknown } | undefined)?.result,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    // A result-shaped object has a rows array and/or a columns array. Anything
    // else isn't a query result.
    if (!Array.isArray(record.rows) && !Array.isArray(record.columns)) continue;
    const rows = Array.isArray(record.rows) ? record.rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object')) : [];
    const columns = Array.isArray(record.columns) && record.columns.length > 0
      ? record.columns.map((c) => (typeof c === 'string' ? c : (c as { name?: string })?.name ?? String(c)))
      : (rows.length > 0 ? Object.keys(rows[0]) : []);
    // Return a legitimately-empty result (0 rows, known columns/rowCount) so it
    // renders as "0 rows matched" instead of vanishing — a run that executed and
    // matched nothing must be distinguishable from one that produced no result.
    if (rows.length === 0 && columns.length === 0 && typeof record.rowCount !== 'number') continue;
    return {
      columns,
      rows,
      rowCount: typeof record.rowCount === 'number' ? record.rowCount : rows.length,
      ...(typeof record.executionTime === 'number' ? { executionTime: record.executionTime } : {}),
    } as QueryResult;
  }
  return undefined;
}

/**
 * Recover the agent's intended chart configuration (type + x/y/color/palette) from
 * an answer artifact so the live result view honors it instead of auto-guessing —
 * parity with AgentAnswerCard. Falls back to `suggestedViz` for the chart type and
 * fills in sensible x/y from the columns when the agent didn't specify them.
 */
function extractChartConfig(payload: Record<string, unknown>, result: QueryResult): CellChartConfig | undefined {
  const resultRecord = payload.result && typeof payload.result === 'object' ? payload.result as Record<string, unknown> : undefined;
  const raw = (resultRecord?.chartConfig && typeof resultRecord.chartConfig === 'object'
    ? resultRecord.chartConfig
    : payload.chartConfig && typeof payload.chartConfig === 'object'
      ? payload.chartConfig
      : {}) as Record<string, unknown>;
  const suggested = typeof payload.suggestedViz === 'string' ? payload.suggestedViz
    : typeof resultRecord?.suggestedViz === 'string' ? resultRecord.suggestedViz
    : undefined;
  const storedDecisionSource = raw.decisionSource === 'authored' || raw.decisionSource === 'agent'
    || raw.decisionSource === 'data' || raw.decisionSource === 'user'
    ? raw.decisionSource
    : undefined;
  const chartRaw = typeof raw.chart === 'string' ? raw.chart : suggested;
  const chart = chartRaw
    ? (chartRaw.toLowerCase().replace(/_/g, '-') === 'single-value' ? 'kpi' : chartRaw)
    : undefined;
  const columns = result.columns;
  const pick = (key: string): string | undefined =>
    typeof raw[key] === 'string' && columns.includes(raw[key] as string) ? raw[key] as string : undefined;
  const config: CellChartConfig = {
    ...(chart ? { chart } : {}),
    ...(chart ? { decisionSource: storedDecisionSource ?? 'agent' as const } : {}),
    ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale } : {}),
    ...(pick('x') ? { x: pick('x') } : {}),
    ...(pick('y') ? { y: pick('y') } : {}),
    ...(pick('color') ? { color: pick('color') } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.colorPalette === 'string' ? { colorPalette: raw.colorPalette as CellChartConfig['colorPalette'] } : {}),
    ...(typeof raw.maxItems === 'number' ? { maxItems: raw.maxItems } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function inlineAskChartConfig(payload: Record<string, unknown>, result: QueryResult): CellChartConfig | undefined {
  const resolved = extractChartConfig(payload, result);
  // A backend recommendation of `table` should not remove Visualization from
  // the transcript when the returned data is chartable. Authored/user table
  // choices stay authoritative; agent/default choices remain suggestions.
  return resolved?.chart === 'table'
    && resolved.decisionSource !== 'authored'
    && resolved.decisionSource !== 'user'
    ? { ...resolved, chart: undefined }
    : resolved;
}

export function resolveArtifactDqlView(payload: Record<string, unknown>): AgentConversationDqlArtifact | undefined {
  const dqlArtifact = normalizeDqlArtifactReference(payload.dqlArtifact);
  if (dqlArtifact) return dqlArtifact;
  const researchRun = payload.researchRun && typeof payload.researchRun === 'object' && !Array.isArray(payload.researchRun)
    ? payload.researchRun as Record<string, unknown>
    : undefined;
  return normalizeDqlArtifactReference(researchRun?.dqlArtifact);
}

export function artifactSqlDisclosureLabel(hasDqlArtifact: boolean): string {
  return hasDqlArtifact ? 'View compiled SQL preview' : 'View SQL preview';
}

/** Small copy-to-clipboard control. Safe inside a <summary> (stops the toggle). */
function CopyButton({ text, t, title = 'Copy' }: { text: string; t: Theme; title?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context) — fail quietly.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className="dql-hover"
      style={{
        border: 'none', background: 'transparent', cursor: 'pointer',
        color: copied ? t.success : t.textMuted, display: 'inline-flex', alignItems: 'center',
        gap: 3, fontSize: 10.5, fontWeight: 650, padding: '2px 4px',
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : null}
    </button>
  );
}

function payloadOf(artifact: AgentRunArtifact): Record<string, unknown> {
  return artifact.payload && typeof artifact.payload === 'object' && !Array.isArray(artifact.payload)
    ? artifact.payload as Record<string, unknown>
    : {};
}

/** Governed sources behind a run, surfaced as trust chips (manifest grounding). */
type AppliedLearning = { kind: 'memory' | 'hint'; id?: string; label: string; detail?: string };

// Pull the memories + approved Hint-Graph corrections that shaped this answer out
// of the answer artifact payload, for the transparency chip.
function appliedLearningsFromRun(run: AgentRun): AppliedLearning[] {
  const out: AppliedLearning[] = [];
  const seen = new Set<string>();
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const memories = Array.isArray(payload.memoryContext) ? payload.memoryContext : [];
    for (const raw of memories) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as { id?: unknown; title?: unknown; content?: unknown };
      const label = typeof m.title === 'string' ? m.title.trim() : '';
      if (!label || seen.has(`m:${label}`)) continue;
      seen.add(`m:${label}`);
      out.push({ kind: 'memory', id: typeof m.id === 'string' ? m.id : undefined, label, detail: typeof m.content === 'string' ? m.content : undefined });
    }
    const hints = Array.isArray(payload.appliedHints) ? payload.appliedHints : [];
    for (const raw of hints) {
      if (!raw || typeof raw !== 'object') continue;
      const h = raw as { title?: unknown; guidance?: unknown };
      const label = typeof h.title === 'string' ? h.title.trim() : '';
      if (!label || seen.has(`h:${label}`)) continue;
      seen.add(`h:${label}`);
      out.push({ kind: 'hint', label, detail: typeof h.guidance === 'string' ? h.guidance : undefined });
    }
  }
  return out.slice(0, 6);
}

// Transparency + control: shows which learned memories/hints the agent recalled
// for this answer, and lets the user stop using a bad auto-captured memory inline.
function AppliedLearnings({ run, t }: { run: AgentRun; t: Theme }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const items = useMemo(
    () => appliedLearningsFromRun(run).filter((it) => !it.id || !dismissed.has(it.id)),
    [run, dismissed],
  );
  if (items.length === 0) return null;
  const stopUsing = async (id: string) => {
    try {
      await api.deleteAgentMemory(id);
      setDismissed((prev) => new Set(prev).add(id));
    } catch {
      /* best-effort — leave it shown if the delete fails */
    }
  };
  return (
    <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={appliedChipStyle(t)}>
        <Lightbulb size={11} />
        <span>Applied {items.length} learning{items.length > 1 ? 's' : ''}</span>
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      {open ? (
        <div style={appliedListStyle(t)}>
          {items.map((it) => (
            <div key={`${it.kind}:${it.label}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={appliedTagStyle(t, it.kind)}>{it.kind === 'hint' ? 'correction' : 'memory'}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11.5, fontWeight: 650, color: t.textPrimary }}>{it.label}</div>
                {it.detail ? <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.4, marginTop: 1 }}>{it.detail}</div> : null}
              </div>
              {it.kind === 'memory' && it.id ? (
                <button type="button" onClick={() => void stopUsing(it.id!)} style={appliedStopStyle(t)}>Stop using</button>
              ) : null}
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: t.textMuted }}>
            Advisory only — learnings never override a certified answer. Manage them under Settings → Agent learning.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function evidenceFromRun(run: AgentRun): Array<{ label: string; certified: boolean }> {
  const out: Array<{ label: string; certified: boolean }> = [];
  const seen = new Set<string>();
  const certifiedRun = run.trustState === 'certified';
  const push = (label: unknown, certified: boolean) => {
    if (typeof label !== 'string' || !label.trim() || seen.has(label)) return;
    seen.add(label);
    out.push({ label, certified });
  };
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    if (artifact.ref) push(artifact.ref, certifiedRun);
    const plan = payload.plan && typeof payload.plan === 'object' ? payload.plan as Record<string, unknown> : undefined;
    if (Array.isArray(plan?.sources)) plan.sources.forEach((source) => push(source, certifiedRun));
    push((payload.sourceCertifiedBlock as string), true);
  }
  return out.slice(0, 4);
}

/** Best-effort SQL behind a run, for the certification handoff. */
function answerSqlFromRun(run: AgentRun): string | undefined {
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const researchRun = payload.researchRun && typeof payload.researchRun === 'object' ? payload.researchRun as Record<string, unknown> : undefined;
    const sql = payload.proposedSql ?? payload.sql ?? payload.sqlPreview ?? researchRun?.generatedSql ?? researchRun?.reviewedSql;
    if (typeof sql === 'string' && sql.trim()) return sql;
  }
  return undefined;
}

function answerDqlArtifactFromRun(run: AgentRun): AgentConversationDqlArtifact | undefined {
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const dqlArtifact = normalizeDqlArtifactReference(payload.dqlArtifact);
    if (dqlArtifact) return dqlArtifact;
    const researchRun = payload.researchRun && typeof payload.researchRun === 'object' && !Array.isArray(payload.researchRun)
      ? payload.researchRun as Record<string, unknown>
      : undefined;
    const researchArtifact = normalizeDqlArtifactReference(researchRun?.dqlArtifact);
    if (researchArtifact) return researchArtifact;
  }
  return undefined;
}

export function artifactReadyPayloadFromRun(run: AgentRun): InsertDqlPayload | undefined {
  if (run.route === 'certified_answer') return undefined;
  const dqlArtifact = answerDqlArtifactFromRun(run);
  const sql = answerSqlFromRun(run);
  if ((!dqlArtifact?.source || dqlArtifact.sourcePath) && !sql) return undefined;
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const result = extractResult(payload);
    const mixedSourcePlan = extractMixedSourceNotebookPlan(payload);
    if (result) {
      return {
        sql,
        dqlArtifact,
        result,
        chartConfig: extractChartConfig(payload, result),
        title: dqlArtifact?.name ?? artifact.title ?? run.question,
        mixedSourcePlan,
      };
    }
    if (mixedSourcePlan) {
      return {
        sql,
        dqlArtifact,
        title: dqlArtifact?.name ?? artifact.title ?? run.question,
        mixedSourcePlan,
      };
    }
  }
  return {
    sql,
    dqlArtifact,
    title: dqlArtifact?.name ?? run.question,
  };
}

function extractMixedSourceNotebookPlan(payload: Record<string, unknown>): MixedSourceNotebookPlan | undefined {
  const value = payload.mixedSourcePlan;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  const required = ['localDataset', 'localAlias', 'localKey', 'warehouseKey', 'warehouseExpression', 'warehouseSql'] as const;
  if (!required.every((key) => typeof plan[key] === 'string' && String(plan[key]).trim())) return undefined;
  return {
    datasetId: typeof plan.datasetId === 'string' ? plan.datasetId : undefined,
    datasetName: typeof plan.datasetName === 'string' ? plan.datasetName : undefined,
    localDataset: String(plan.localDataset),
    localAlias: String(plan.localAlias),
    localKey: String(plan.localKey),
    warehouseKey: String(plan.warehouseKey),
    warehouseExpression: String(plan.warehouseExpression),
    warehouseSql: String(plan.warehouseSql),
    warehouseRelations: Array.isArray(plan.warehouseRelations)
      ? plan.warehouseRelations.filter((value): value is string => typeof value === 'string')
      : undefined,
  };
}

function evidenceChipStyle(t: Theme, certified: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10.5,
    padding: '2px 7px',
    borderRadius: 999,
    background: certified ? `${t.success}14` : t.cellBg,
    color: certified ? t.success : t.textMuted,
    border: `1px solid ${certified ? `${t.success}44` : t.headerBorder}`,
  };
}

function appliedChipStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    fontSize: 10.5,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    background: `${t.accent}14`,
    color: t.accent,
    border: `1px solid ${t.accent}33`,
    cursor: 'pointer',
  };
}

function appliedListStyle(t: Theme): React.CSSProperties {
  return {
    display: 'grid',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    background: t.cellBg,
    border: `1px solid ${t.headerBorder}`,
  };
}

function appliedTagStyle(t: Theme, kind: 'memory' | 'hint'): React.CSSProperties {
  const accent = kind === 'hint';
  return {
    flex: '0 0 auto',
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '2px 6px',
    borderRadius: 4,
    marginTop: 1,
    background: accent ? `${t.accent}1f` : `${t.textMuted}1f`,
    color: accent ? t.accent : t.textMuted,
  };
}

function appliedStopStyle(t: Theme): React.CSSProperties {
  return {
    flex: '0 0 auto',
    fontSize: 10.5,
    border: `1px solid ${t.headerBorder}`,
    background: 'transparent',
    color: t.textMuted,
    borderRadius: 6,
    padding: '2px 7px',
    cursor: 'pointer',
  };
}

function iconShellStyle(t: Theme): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: `${t.accent}14`,
    border: `1px solid ${t.accent}36`,
    color: t.accent,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
  };
}

function largeIconShellStyle(t: Theme): React.CSSProperties {
  return { ...iconShellStyle(t), width: 40, height: 40 };
}

function suggestionChipStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    borderRadius: 999,
    padding: '7px 13px',
    fontSize: 12.5,
    fontWeight: 550,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function inputStyle(t: Theme): React.CSSProperties {
  return {
    flex: 1,
    minHeight: 54,
    maxHeight: 140,
    resize: 'none',
    border: `1px solid ${t.btnBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 12,
    padding: '11px 13px',
    fontSize: 13,
    lineHeight: 1.45,
    fontFamily: t.font,
    outline: 'none',
    boxShadow: 'none',
  };
}

function sendButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    border: 'none',
    background: enabled ? t.accent : t.btnBg,
    color: enabled ? '#fff' : t.textMuted,
    borderRadius: 12,
    height: 54,
    padding: '0 17px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 12.5,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: enabled ? 'pointer' : 'not-allowed',
    boxShadow: enabled ? `0 2px 9px ${t.accent}59` : 'none',
  };
}

function heroAddButtonStyle(t: Theme): React.CSSProperties {
  return {
    border: 'none',
    background: t.accent,
    color: '#fff',
    borderRadius: 8,
    padding: '7px 13px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
    boxShadow: `0 1px 5px ${t.accent}4d`,
  };
}

function addPopoverStyle(t: Theme): React.CSSProperties {
  return {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 0,
    zIndex: 41,
    width: 264,
    background: t.cellBg,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 10,
    boxShadow: '0 12px 32px rgba(0,0,0,0.2)',
    padding: 10,
  };
}

function appRowStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 9px',
    borderRadius: 7,
    border: 'none',
    background: 'transparent',
    color: t.textSecondary,
    fontSize: 12.5,
    fontWeight: 550,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function newAppRowStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 9px',
    borderRadius: 7,
    border: `1px dashed ${t.accent}66`,
    background: `${t.accent}0d`,
    color: t.accent,
    fontSize: 12.5,
    fontWeight: 650,
    fontFamily: t.font,
    cursor: 'pointer',
    marginBottom: 2,
  };
}

function pickerInputStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${t.btnBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12.5,
    fontFamily: t.font,
    outline: 'none',
  };
}

function userBubbleStyle(t: Theme): React.CSSProperties {
  return {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    background: `${t.accent}16`,
    color: t.textPrimary,
    border: `1px solid ${t.accent}32`,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12.5,
    lineHeight: 1.45,
  };
}

function assistantBubbleStyle(t: Theme): React.CSSProperties {
  return {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    color: t.textPrimary,
    border: `1px solid ${t.cellBorder}`,
    background: t.appBg,
    borderRadius: 10,
    padding: '10px 12px',
  };
}

function runCardStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.appBg,
    borderRadius: 8,
    padding: 10,
    display: 'grid',
    gap: 10,
    // A grid's implicit column track floors at the widest child's min-content
    // (e.g. a long SQL line in "View query"), inflating every row past the chat
    // column and leaving a horizontal-scroll white gutter after results/refresh.
    // minmax(0, 1fr) lets children shrink; wide content scrolls in its own box.
    gridTemplateColumns: 'minmax(0, 1fr)',
    minWidth: 0,
    maxWidth: '100%',
  };
}

function artifactStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: 9,
    display: 'grid',
    gap: 8,
    gridTemplateColumns: 'minmax(0, 1fr)',
    minWidth: 0,
    maxWidth: '100%',
  };
}

function answerBoxStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: 9,
    fontSize: 12.5,
    color: t.textPrimary,
    lineHeight: 1.45,
  };
}

function codeStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    maxHeight: 180,
    overflow: 'auto',
    border: `1px solid ${t.headerBorder}`,
    background: t.editorBg,
    color: t.textPrimary,
    borderRadius: 7,
    padding: 9,
    fontSize: 11,
    lineHeight: 1.45,
    fontFamily: t.fontMono,
    whiteSpace: 'pre-wrap',
  };
}

function smallButtonStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    borderRadius: 7,
    padding: '5px 8px',
    fontSize: 11,
    fontWeight: 800,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}
