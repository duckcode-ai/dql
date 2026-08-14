import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  Database,
  FileSearch,
  Save,
  GitBranch,
  LayoutDashboard,
  Lightbulb,
  ListTree,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
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
  DqlApiError,
  type AgentConversationTurn,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunAudience,
  type AgentRunClarificationOption,
  type AgentRunEvent,
  type AgentRunRequestedMode,
  type AgentRunRoute,
  type AgentRunSelectedObject,
  type AgentRunStatus,
  type AgentRunStep,
  type AgentRunStepStatus,
  type AgentRunStopReason,
  type AgentRunTrustState,
  type AgentThinkingMode,
  type AppBuildProposal,
  type AppStudioBuildDraft,
  type MixedSourceNotebookPlan,
} from '../../api/client';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { controlStyle } from '../../themes/control-tokens';
import { ThinkingModeControl } from './ThinkingModeControl';
import { StructuredAnswerText } from './AgentAnswerCard';
import { AppBuildProposalPanel, defaultProposalSelection, type AppBuildBriefEdits } from '../apps/AppBuildProposalPanel';
import { ResultView } from '../output/ResultView';
import { DraftReviewCard } from '../blocks/DraftReviewCard';
import { SaveAsBlockModal } from '../modals/SaveAsBlockModal';
import { BlockParameterControls, isRuntimeEditableParameter } from '../parameters/BlockParameterControls';
export { deriveResultChartConfig } from '../output/ResultView';
import type { QueryResult, AppSummary, CellChartConfig, Cell, BlockParameterDefinition, ExecutionTarget } from '../../store/types';
import { useNotebook } from '../../store/NotebookStore';
import { buildConversationContext } from './agentConversationContext';
import type { AgentConversationDqlArtifact } from '../../llm/types';
import { addAskResultFilter, askArtifactStateKey, askResultFilterCandidates } from '../../utils/ask-runtime-parameters';

export type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'run'; id: string; run: AgentRun };

/** Replace only the failed presentation; the immutable source remains in the run store. */
export function replacePresentedAgentRun(items: ThreadItem[], sourceRunId: string, repairedRun: AgentRun): ThreadItem[] {
  return items.map((item) => item.kind === 'run' && item.run.id === sourceRunId
    ? { kind: 'run', id: repairedRun.id, run: repairedRun }
    : item);
}

/**
 * Build the compact client history used when a persisted server thread is not
 * available. Clarification turns must carry the actual question in `answer`;
 * the generic run summary ("Needs clarification...") cannot resolve a reply.
 */
export function agentRunHistoryFromItems(items: ThreadItem[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  const history: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const item of items) {
    if (item.kind === 'user') {
      history.push({ role: 'user', text: item.text });
      continue;
    }
    const failed = item.run.status === 'blocked' || item.run.artifacts?.some((artifact) => {
      const payload = payloadOf(artifact);
      return Boolean(payload.executionError || payload.warehouseFailure || payload.analyticalFailure);
    });
    if (failed) {
      // A failed turn cannot become fallback prompt authority. Remove its paired
      // user message too; the next submission already carries the new question.
      if (history.at(-1)?.role === 'user') history.pop();
      continue;
    }
    history.push({ role: 'assistant', text: item.run.answer?.trim() || item.run.summary });
  }
  return history.slice(-12);
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

export interface SqlNotebookDraftMeta {
  question?: string;
  sourceRunId?: string;
}

interface UnifiedAgentRunPanelProps {
  themeMode: ThemeMode;
  title?: string;
  scopeHint?: string;
  /** Surface-specific composer guidance for authoring modes. */
  composerPlaceholder?: string;
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
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  /**
   * DQL-first insertion: the whole governed artifact (compiled SQL body + DQL
   * provenance + executed result + chart config) so the host can create a
   * self-contained, ready-rendered query cell. Preferred over onInsertSql when set.
   */
  onInsertDql?: (payload: InsertDqlPayload) => void;
  /** Replace the host-selected notebook cell after an explicit user action. */
  onReplaceDql?: (payload: InsertDqlPayload) => void;
  /**
   * Optional host handoff for authoring surfaces. Fires once when a completed
   * non-certified run produces a new DQL/SQL artifact, allowing the host to
   * populate an unsaved editor without changing the agent engine or RunCard.
   */
  onArtifactReady?: (payload: InsertDqlPayload, run: AgentRun) => void;
  /** Explicit handoff for immutable Modeling/Skills authoring proposals. */
  onReviewAuthoringProposal?: (artifact: AgentRun['artifacts'][number], run: AgentRun) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  /** Navigate into an app/dashboard (used by the "Added to app" success link). */
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  /** Reports whether a run is in flight, so a host can avoid unmounting mid-run. */
  onRunningChange?: (running: boolean) => void;
  /** Use Ask's answer-first narrative/result card inside a compact authoring panel. */
  answerFirstCards?: boolean;
  /** Add a contextual DQL insertion action to an answer-first card. */
  insertDqlActionLabel?: string;
  /** Add a second explicit action for replacing the selected notebook cell. */
  replaceDqlActionLabel?: string;
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
  /** Canonical run identity used for stable explicit draft commits. */
  sourceRunId?: string;
  /** The question this artifact answered, so an authoring host can recompose it. */
  question?: string;
  /** Preserve the exact Ask execution target when the artifact moves to Notebook. */
  executionTarget?: Cell['executionTarget'];
}

const ROUTE_LABEL: Record<AgentRunRoute, string> = {
  conversation: 'Chat',
  certified_answer: 'Certified answer',
  semantic_answer: 'Governed semantic answer',
  generated_answer: 'Generated answer',
  research: 'Research plan',
  sql_cell: 'SQL cell',
  dql_block_draft: 'DQL block draft',
  modeling_draft: 'Modeling proposal',
  skill_draft: 'Skill proposal',
  app_build: 'App plan',
  clarify: 'Clarify',
  blocked: 'Blocked',
};

export function UnifiedAgentRunPanel({
  themeMode,
  title = 'AI Copilot',
  scopeHint = 'Auto routes to answer, research, SQL, block, or app',
  composerPlaceholder = 'Ask anything about your data…',
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
  onReplaceDql,
  onArtifactReady,
  onReviewAuthoringProposal,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
  onRunningChange,
  answerFirstCards = false,
  insertDqlActionLabel,
  replaceDqlActionLabel,
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
  const [researchResultRowsOptIn, setResearchResultRowsOptIn] = useState(false);
  const [executionConnectionNames, setExecutionConnectionNames] = useState<string[]>([]);
  const [executionConnectionName, setExecutionConnectionName] = useState<string>();
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
  const streamingDeltaBufferRef = useRef('');
  const streamingFrameRef = useRef<number | null>(null);
  const resetStreamingAnswer = useCallback(() => {
    streamingDeltaBufferRef.current = '';
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
    setStreamingAnswer('');
  }, []);
  const appendStreamingDelta = useCallback((delta: string) => {
    streamingDeltaBufferRef.current += delta;
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = window.requestAnimationFrame(() => {
      streamingFrameRef.current = null;
      const buffered = streamingDeltaBufferRef.current;
      streamingDeltaBufferRef.current = '';
      if (buffered) setStreamingAnswer((current) => current + buffered);
    });
  }, []);
  useEffect(() => () => {
    if (streamingFrameRef.current !== null) window.cancelAnimationFrame(streamingFrameRef.current);
  }, []);
  const contextualExecutionTarget = workspaceContext?.executionTarget;
  const contextualExecutionConnectionName = contextualExecutionTarget
    && typeof contextualExecutionTarget === 'object'
    && !Array.isArray(contextualExecutionTarget)
    && (contextualExecutionTarget as Record<string, unknown>).target === 'connection'
    && typeof (contextualExecutionTarget as Record<string, unknown>).connectionName === 'string'
    ? String((contextualExecutionTarget as Record<string, unknown>).connectionName)
    : undefined;
  // A notebook working against imported datasets runs on the LOCAL DuckDB
  // workspace. Ask could only ever emit `{target:'connection'}`, so it sent the
  // same question to the default warehouse — where those dataset tables do not
  // exist — and refused a query the notebook beside it runs happily.
  const contextualLocalTarget = contextualExecutionTarget
    && typeof contextualExecutionTarget === 'object'
    && !Array.isArray(contextualExecutionTarget)
    && (contextualExecutionTarget as Record<string, unknown>).target === 'local';

  useEffect(() => {
    let cancelled = false;
    void api.getConnections()
      .then((info) => {
        if (cancelled) return;
        const names = Object.keys(info.connections ?? {}).sort((left, right) => left.localeCompare(right));
        setExecutionConnectionNames(names);
        setExecutionConnectionName(selectAgentExecutionConnection(
          names,
          info.default,
          contextualExecutionConnectionName,
        ));
      })
      .catch(() => {
        if (!cancelled) {
          setExecutionConnectionNames([]);
          setExecutionConnectionName(undefined);
        }
      });
    return () => { cancelled = true; };
  }, [contextualExecutionConnectionName]);

  const changeExecutionConnection = useCallback((name: string) => {
    setExecutionConnectionName(name);
  }, []);

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
    resetStreamingAnswer();
    setItems((current) => {
      if (current.some((item) => item.kind === 'run' && item.run.id === run.id)) {
        return current.map((item) => item.kind === 'run' && item.run.id === run.id
          ? { ...item, id: run.id, run }
          : item);
      }
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
  }, [resetStreamingAnswer]);

  const adoptRepairedRun = useCallback((sourceRunId: string, repairedRun: AgentRun) => {
    setItems((current) => replacePresentedAgentRun(current, sourceRunId, repairedRun));
    setInspector((current) => {
      if (!current || current.runId !== sourceRunId) return current;
      const artifact = repairedRun.artifacts[0];
      return artifact ? { runId: repairedRun.id, artifactId: artifact.id, tab: current.tab } : null;
    });
    setError(null);
    const ready = artifactReadyPayloadFromRun(repairedRun);
    if (ready) onArtifactReadyRef.current?.(ready, repairedRun);
  }, []);

  const recoverPendingRun = useCallback((pending: PendingAgentRun) => {
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
    const recoveryEpoch = ++recoveryEpochRef.current;
    activeRunIdRef.current = pending.id;
    pendingRunRef.current = pending;
    setBackgroundRun(pending);
    setRunning(true);
    resetStreamingAnswer();
    setRunningEvents([]);

    const check = async () => {
      if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
      try {
        const state = await api.getAgentRunState(pending.id);
        if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
        if (state.lifecycleState === 'terminal') {
          appendFinishedRun(state.run, pending);
          setRunning(false);
          return;
        }
        setRunningEvents(state.progress.events.slice(-8));
        recoveryTimerRef.current = window.setTimeout(() => { void check(); }, 600);
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
      .then(({ turns, runs }) => {
        if (cancelled || turns.length === 0) return;
        setItems((current) => {
          const localAnswerCount = current.filter((item) => item.kind === 'run').length;
          const canonical = threadItemsFromTurns(turns, runs);
          if (turns.length >= localAnswerCount) return canonical;
          const canonicalRuns = new Map(canonical.flatMap((item) =>
            item.kind === 'run' ? [[item.run.id, item.run] as const] : []));
          return current.map((item) => item.kind === 'run' && canonicalRuns.has(item.run.id)
            ? { ...item, run: canonicalRuns.get(item.run.id)! }
            : item);
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

  const submit = async (
    textOverride?: string,
    modeOverride?: AgentRunRequestedMode,
    selectedEvidenceId?: string,
    clarificationSourceQuestion?: string,
    researchSourceRun?: AgentRun,
  ) => {
    const text = (textOverride ?? input).trim();
    if (!text || running) return;
    const activeMode = modeOverride ?? pendingModeRef.current ?? initialMode;
    const resultRowsOptInForRun = activeMode === 'research' && researchResultRowsOptIn;
    // Consent is intentionally one-shot and never inherited by the next run.
    setResearchResultRowsOptIn(false);
    pendingModeRef.current = undefined;
    const userItem: ThreadItem = { kind: 'user', id: makeId('user'), text };
    setItems((current) => [...current, userItem]);
    setInput('');
    setError(null);
    setRunning(true);
    setRunningEvents([]);
    resetStreamingAnswer();
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
            surface: askLayout
              ? 'ask'
              : typeof workspaceContext?.surface === 'string'
                ? workspaceContext.surface
                : notebookPath
                  ? 'notebook'
                  : 'agent',
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
      const priorAuthoringRun = (activeMode === 'modeling' || activeMode === 'skill')
        ? [...items].reverse().find((item): item is Extract<ThreadItem, { kind: 'run' }> => item.kind === 'run' && item.run.artifacts.some((artifact) => artifact.kind === (activeMode === 'modeling' ? 'modeling_change_proposal' : 'skill_change_proposal')))?.run
        : undefined;
      const priorAuthoringArtifact = priorAuthoringRun?.artifacts.find((artifact) => artifact.kind === (activeMode === 'modeling' ? 'modeling_change_proposal' : 'skill_change_proposal'));
      const runInput = {
        question: text,
        ...(selectedEvidenceId ? { selectedEvidenceId } : {}),
        ...(clarificationSourceQuestion ? { clarificationSourceQuestion } : {}),
        requestedMode: activeMode,
        audience,
        selectedObject: selectedObject ?? (notebookPath ? { kind: 'notebook' as const, path: notebookPath } : undefined),
        ...(researchSourceRun?.executionTarget
          ? { executionTarget: researchSourceRun.executionTarget }
          : contextualLocalTarget
          ? { executionTarget: { target: 'local' as const } }
          : executionConnectionName
            ? { executionTarget: { target: 'connection' as const, connectionName: executionConnectionName } }
            : {}),
        workspaceContext: {
          ...(workspaceContext ?? {}),
          ...(notebookPath ? { notebookPath } : {}),
          ...(researchSourceRun ? { researchSource: researchSourceFromRun(researchSourceRun) } : {}),
          ...(priorAuthoringRun && priorAuthoringArtifact ? {
            sourceRunId: priorAuthoringRun.id,
            sourceArtifactId: priorAuthoringArtifact.id,
            revision: (priorAuthoringRun.derivation?.revision ?? 1) + 1,
          } : {}),
        },
        conversationContext: buildConversationContext(items),
        history,
        thinkingMode,
        researchResultRowsOptIn: resultRowsOptInForRun,
        runId,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
      };
      const run = await api.createAgentRunStream(runInput, (message) => {
        receivedStreamMessage = true;
        if (message.kind === 'event') {
          setRunningEvents((current) => [...current, message.event].slice(-8));
        } else if (message.kind === 'answer-delta') {
          appendStreamingDelta(message.delta);
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
    resetStreamingAnswer();
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
    // Route changes only detach this view. The server-owned run and its fetch
    // handshake must continue; only the explicit Stop action cancels provider work.
    recoveryEpochRef.current += 1;
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
  }, []);

  // Pre-selected app target when the panel is opened inside an app (the global
  // rail); on the Ask home there is none and the picker lists/creates apps.
  const appContext = {
    appId: typeof workspaceContext?.appId === 'string' ? workspaceContext.appId : undefined,
    dashboardId: typeof workspaceContext?.dashboardId === 'string' ? workspaceContext.dashboardId : undefined,
    dashboardTitle: typeof workspaceContext?.dashboardTitle === 'string' ? workspaceContext.dashboardTitle : undefined,
  };

  const handleNextAction = (run: AgentRun, action: AgentRun['nextActions'][number]) => {
    if (action.id === 'review-modeling-proposal' || action.id === 'review-skill-proposal') {
      const expectedKind = action.id === 'review-modeling-proposal'
        ? 'modeling_change_proposal'
        : 'skill_change_proposal';
      const artifact = run.artifacts.find((candidate) => candidate.kind === expectedKind);
      if (!artifact) {
        setError('This authoring run does not include a reviewable proposal.');
        return;
      }
      if (onReviewAuthoringProposal) onReviewAuthoringProposal(artifact, run);
      else if (artifact.ref) {
        try { window.sessionStorage.setItem('dql-context-proposal-handoff', artifact.ref); } catch { /* best effort */ }
        window.dispatchEvent(new CustomEvent('dql:open-context-proposal', { detail: { proposalId: artifact.ref, kind: artifact.kind } }));
      }
      return;
    }
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
      void submit(run.question, 'research', undefined, undefined, run);
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
        <style>{ASK_KEYFRAMES}</style>

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
                  threadId={threadIdRef.current}
                  appContext={appContext}
                  selectedArtifactId={inspector?.runId === item.run.id ? inspector.artifactId : undefined}
                  onOpenArtifact={(artifactId, tab) => openInspector(item.run.id, artifactId, tab)}
                  onOpenApp={onOpenApp}
                  onInsertSql={onInsertSql}
                  onInsertDql={onInsertDql}
                  onOpenBlock={onOpenBlock}
                  onOpenResearch={onOpenResearch}
                  onSelectClarification={(option) => {
                    const selection = clarificationSelectionInput(option);
                    void submit(selection.question, undefined, selection.selectedEvidenceId, item.run.question);
                  }}
                  onNextAction={(action) => handleNextAction(item.run, action)}
                  onRepairedRun={adoptRepairedRun}
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
                  placeholder={composerPlaceholder}
                  onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSubmit(); } }}
                  style={{ border: 'none', background: 'transparent', resize: 'none', outline: 'none', boxShadow: 'none', padding: '13px 15px 4px', fontSize: 13.5, lineHeight: 1.5, color: t.textPrimary, fontFamily: t.font }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 10px 12px' }}>
                  <ThinkingModeControl t={t} value={thinkingMode} onChange={changeThinkingMode} />
                  <ResearchRowsConsent
                    checked={researchResultRowsOptIn}
                    onChange={setResearchResultRowsOptIn}
                    t={t}
                  />
                  <AgentExecutionConnectionControl
                    names={executionConnectionNames}
                    value={executionConnectionName}
                    onChange={changeExecutionConnection}
                    t={t}
                  />
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
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
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
        @keyframes dql-agent-thinking-dot { 0%, 65%, 100% { opacity: .28; transform: translateY(0); } 32% { opacity: 1; transform: translateY(-2px); } }
        @keyframes dql-agent-activity-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
        .dql-agent-thinking-dot { animation: dql-agent-thinking-dot 1.05s ease-in-out infinite; }
        .dql-agent-activity { animation: dql-agent-activity-in .22s ease-out; }
        .dql-hover { transition: filter .15s ease, transform .12s ease, box-shadow .15s ease, background .15s ease, color .15s ease, border-color .15s ease; }
        .dql-hover:hover { filter: brightness(1.07); }
        .dql-hover:active { transform: translateY(0.5px); }
        .dql-lift:hover { transform: translateY(-1px); }
        details > summary::-webkit-details-marker { display: none; }
        @media (prefers-reduced-motion: reduce) { .dql-agent-thinking-dot, .dql-agent-activity { animation: none !important; } }
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
            threadId={threadIdRef.current}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
            onReplaceDql={onReplaceDql}
            insertDqlActionLabel={insertDqlActionLabel}
            replaceDqlActionLabel={replaceDqlActionLabel}
            onOpenBlock={onOpenBlock}
            onOpenResearch={onOpenResearch}
            onSelectClarification={(option) => {
              const selection = clarificationSelectionInput(option);
              void submit(selection.question, undefined, selection.selectedEvidenceId, item.run.question);
            }}
            onNextAction={(action) => handleNextAction(item.run, action)}
            onRepairedRun={adoptRepairedRun}
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
            onSelectClarification={(option) => {
              const selection = clarificationSelectionInput(option);
              void submit(selection.question, undefined, selection.selectedEvidenceId, item.run.question);
            }}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AgentExecutionConnectionControl
              names={executionConnectionNames}
              value={executionConnectionName}
              onChange={changeExecutionConnection}
              t={t}
            />
            <ThinkingModeControl t={t} value={thinkingMode} onChange={changeThinkingMode} />
            <ResearchRowsConsent
              checked={researchResultRowsOptIn}
              onChange={setResearchResultRowsOptIn}
              t={t}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => { setInput(event.target.value); pendingModeRef.current = undefined; }}
            rows={2}
            placeholder={composerPlaceholder}
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
export { usePersistedAgentThreadId } from './usePersistedAgentThreadId';

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
  return runs.find((entry) => !entry.threadId);
}

const THINKING_MODE_STORAGE_KEY = 'dql.agent.thinkingMode';
export function selectAgentExecutionConnection(
  names: string[],
  defaultName?: string,
  preferredName?: string,
): string | undefined {
  if (preferredName && names.includes(preferredName)) return preferredName;
  if (defaultName && names.includes(defaultName)) return defaultName;
  return names[0];
}

function ResearchRowsConsent({
  checked,
  onChange,
  t,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  t: Theme;
}): JSX.Element {
  return (
    <label
      title="One-run consent: Research may send at most 20 redacted narration rows and 200 redacted local-analysis rows. Ask and repair always send zero rows."
      style={{
        minHeight: 30,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 7px',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        background: 'var(--bg-2)',
        color: t.textMuted,
        fontSize: 10.5,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        aria-label="Allow redacted result rows for this Research run"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Research rows (this run)
    </label>
  );
}

function AgentExecutionConnectionControl({
  names,
  value,
  onChange,
  t,
}: {
  names: string[];
  value?: string;
  onChange: (name: string) => void;
  t: Theme;
}): JSX.Element | null {
  if (names.length === 0 || !value) return null;
  return (
    <label
      title="Database connection used for metadata, compilation, and execution in this conversation"
      style={{
        height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 7px',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        background: 'var(--bg-2)',
        color: t.textMuted,
        fontSize: 11,
      }}
    >
      <Database size={12} />
      <select
        aria-label="Ask AI database connection"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          maxWidth: 150,
          border: 0,
          outline: 0,
          background: 'transparent',
          color: t.textSecondary,
          font: 'inherit',
          cursor: names.length > 1 ? 'pointer' : 'default',
        }}
      >
        {names.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
  );
}

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
  'sql_cell', 'dql_block_draft', 'modeling_draft', 'skill_draft', 'app_build', 'clarify', 'blocked',
]);
const AGENT_RUN_TRUST_STATES = new Set<AgentRunTrustState>([
  'certified', 'governed', 'grounded', 'review_required', 'blocked', 'not_applicable',
]);
const AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  'completed', 'needs_review', 'needs_clarification', 'blocked',
]);
const AGENT_RUN_STOP_REASONS = new Set<AgentRunStopReason>([
  'conversational_reply',
  'certified_answer_found',
  'governed_semantic_answer',
  'generated_review_required',
  'artifact_created',
  'needs_clarification',
  'human_review_required',
  'blocked',
]);

/**
 * Rebuild the panel's thread items from server-persisted conversation turns.
 * A stored turn is a compact snapshot (question + answer summary + capped result),
 * not a full AgentRun — so each run is reconstructed minimally: enough for the
 * RunCard (route, trust, answer, result preview) and for
 * `buildConversationContext` to keep working as the no-threadId fallback.
 */
export { askFailureOrigin, askFailureDetail, ASK_FAILURE_PRESENTATION };

export function threadItemsFromTurns(turns: AgentConversationTurn[], runs: AgentRun[] = []): ThreadItem[] {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const persistedRunIds = new Set(turns.flatMap((turn) => turn.agentRunId ? [turn.agentRunId] : []));
  const repairedSourceRunIds = new Set(runs.flatMap((run) => {
    const derivation = run.derivation;
    return derivation?.kind === 'analytical_repair'
      && persistedRunIds.has(run.id)
      && typeof derivation.sourceRunId === 'string'
      ? [derivation.sourceRunId]
      : [];
  }));
  // A repair is persisted as an immutable derived turn for audit. Present it as
  // the replacement answer instead of replaying the failed question twice.
  return turns.filter((turn) => !turn.agentRunId || !repairedSourceRunIds.has(turn.agentRunId)).flatMap((turn): ThreadItem[] => {
    const run = turn.agentRunId ? runsById.get(turn.agentRunId) : undefined;
    return [
      { kind: 'user', id: `${turn.id}-q`, text: turn.question },
      { kind: 'run', id: run?.id ?? turn.id, run: run ?? runFromConversationTurn(turn) },
    ];
  });
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
  const status: AgentRunStatus = AGENT_RUN_STATUSES.has(turn.runStatus as AgentRunStatus)
    ? (turn.runStatus as AgentRunStatus)
    : 'completed';
  const stopReason: AgentRunStopReason = AGENT_RUN_STOP_REASONS.has(turn.stopReason as AgentRunStopReason)
    ? (turn.stopReason as AgentRunStopReason)
    : status === 'blocked'
      ? 'blocked'
      : status === 'needs_clarification'
        ? 'needs_clarification'
        : status === 'needs_review'
          ? 'human_review_required'
          : route === 'conversation'
            ? 'conversational_reply'
            : trustState === 'certified'
              ? 'certified_answer_found'
              : 'artifact_created';
  const columns = (turn.result?.columns ?? []).filter((column): column is string => typeof column === 'string');
  // Stored samples are positional arrays; rebuild keyed rows for the result view.
  const rows = (turn.result?.rowsSample ?? [])
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  const result = columns.length > 0
    ? { columns, rows, rowCount: turn.result?.rowCount ?? rows.length }
    : undefined;
  const artifact: AgentRunArtifact | undefined = result || turn.sql || turn.dqlArtifact || turn.sourceCertifiedBlock
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
          ...(turn.dqlArtifact ? { dqlArtifact: turn.dqlArtifact } : {}),
          ...(turn.cascade ? { cascade: turn.cascade } : {}),
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
    status,
    trustState,
    stopReason,
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

function routeMatchLabel(route?: AgentRunRoute): string {
  switch (route) {
    case 'certified_answer': return 'Found a compatible certified block';
    case 'semantic_answer': return 'Found a compatible semantic metric';
    case 'generated_answer': return 'Identified the relevant tables and columns';
    case 'research': return 'Identified evidence for deeper analysis';
    case 'app_build': return 'Found governed assets for the app';
    case 'sql_cell': return 'Identified the query context';
    case 'dql_block_draft': return 'Identified reusable governed logic';
    case 'modeling_draft': return 'Resolved current models and relationship evidence';
    case 'skill_draft': return 'Resolved current domain guidance and governed references';
    case 'clarify': return 'Identified a missing business detail';
    default: return 'Identified the best answer path';
  }
}

function routeExecutionLabel(route: AgentRunRoute | undefined, events: AgentRunEvent[]): string {
  if (events.some((event) => event.type === 'repair.attempted')) return 'Refining the query and trying again';
  if (events.some((event) => event.type === 'escalated')) return 'Expanding the evidence search';
  switch (route) {
    case 'certified_answer':
    case 'semantic_answer': return 'Running the governed query';
    case 'generated_answer': return 'Building and running a grounded query';
    case 'research': return 'Researching the strongest evidence';
    case 'app_build': return 'Assembling the app from governed assets';
    case 'sql_cell': return 'Building and checking the SQL';
    case 'dql_block_draft': return 'Drafting the governed logic';
    case 'modeling_draft': return 'Building a reviewable modeling proposal';
    case 'skill_draft': return 'Building a reviewable Skill proposal';
    case 'clarify': return 'Preparing a focused clarification';
    default: return 'Preparing the answer';
  }
}

/** The route of the latest routed step, if any (drives conversation-aware chrome). */
function latestRoute(events: AgentRunEvent[]): AgentRunRoute | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].route) return events[i].route;
  }
  return undefined;
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
  if (!route && elapsedSeconds < 24 && !hasRepair) {
    return {
      title: 'Still resolving the governed evidence',
      detail: 'The bounded request is still selecting its answer path. DQL will stop at the normal deadline instead of silently switching to a longer workflow.',
    };
  }
  if (route === 'research') {
    return {
      title: 'Deep research is validating the analysis',
      detail: 'This can use several AI and SQL steps. Reusable relationships and semantic metrics make future investigations faster; reviewed repeat answers can be saved as blocks and certified.',
    };
  }
  return {
    title: hasRepair ? 'Applying one bounded query repair' : 'Finishing the bounded query path',
    detail: 'DQL is compiling or running the selected governed path. An ordinary lookup stops at its deadline instead of silently restarting as Research.',
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

export interface LiveAgentActivity {
  id: 'search' | 'match' | 'execute' | 'verify' | 'background';
  label: string;
  state: 'complete' | 'active';
}

/**
 * A small, evidence-safe activity trail for the live response. Technical engine
 * phases such as planning and validation are intentionally translated into what
 * the user can observe: searching, matching, querying, and checking the result.
 */
export function liveAgentActivityFor(events: AgentRunEvent[], reconnecting = false): LiveAgentActivity[] {
  if (events.length === 0 && reconnecting) {
    return [{ id: 'background', label: 'Continuing this request in the background', state: 'active' }];
  }
  const route = latestRoute(events);
  if (route === 'conversation') return [];
  const hasRoute = events.some((event) => event.type === 'route.decided');
  const hasExecution = events.some((event) =>
    event.type === 'executor.started'
    || event.type === 'step.started'
    || event.type === 'repair.attempted'
    || event.type === 'escalated'
  );
  const hasEvaluation = events.some((event) => event.type === 'evaluation.recorded');
  const activity: LiveAgentActivity[] = [{
    id: 'search',
    label: 'Resolving governed evidence and business meaning',
    state: hasRoute ? 'complete' : 'active',
  }];
  if (hasRoute) {
    activity.push({
      id: 'match',
      label: routeMatchLabel(route),
      state: hasExecution || hasEvaluation ? 'complete' : 'active',
    });
  }
  if (hasExecution || hasEvaluation) {
    activity.push({
      id: 'execute',
      label: routeExecutionLabel(route, events),
      state: hasEvaluation ? 'complete' : 'active',
    });
  }
  if (hasEvaluation) {
    activity.push({
      id: 'verify',
      label: 'Checking the result against governed evidence',
      state: 'active',
    });
  }
  return activity;
}

/**
 * Live agent activity — a transient, boxless activity trail. It reports the
 * evidence and execution path without exposing the old planner/validator state
 * machine, and disappears as soon as the final answer is available.
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
  const runStartedAt = backgroundRun?.startedAt ?? events.find((event) => event.type === 'run.started')?.at;
  const startedAtMs = runStartedAt ? Date.parse(runStartedAt) : clock;
  const elapsedSeconds = Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((clock - startedAtMs) / 1_000)) : 0;
  const longRunGuidance = longRunGuidanceFor(
    elapsedSeconds,
    latestRoute(events),
    events.some((event) => event.type === 'repair.attempted'),
  );
  // The activity trail is transient. As soon as answer text starts streaming,
  // replace it with the answer itself; when the run completes this component is
  // unmounted, leaving no planning/validation chrome beside the final response.
  if (streamingAnswer) {
    return (
      <div style={{ alignSelf: 'stretch', padding: '4px 2px 8px', fontSize: 13.5, lineHeight: 1.55, color: t.textPrimary, whiteSpace: 'pre-wrap', animation: 'dql-agent-fadein 0.22s ease-out' }}>
        {streamingAnswer}
      </div>
    );
  }
  const isConversation = latestRoute(events) === 'conversation';
  if (isConversation) {
    return (
      <div role="status" aria-live="polite" style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'center', gap: 9, padding: '5px 2px 9px', color: t.textSecondary, animation: 'dql-agent-fadein 0.22s ease-out' }}>
        <AgentThinkingDots />
        <span style={{ fontSize: 13, lineHeight: 1.4 }}>Replying…</span>
      </div>
    );
  }
  const activity = liveAgentActivityFor(events, Boolean(backgroundRun));
  const waitHint = elapsedSeconds >= 12
    ? longRunGuidance?.title
    : thinkingMode === 'high'
      ? 'Thorough mode is cross-checking the result.'
      : null;
  return (
    <div role="status" aria-live="polite" aria-label="Agent activity" style={{ alignSelf: 'stretch', display: 'grid', gap: 7, padding: '5px 2px 10px', animation: 'dql-agent-fadein 0.22s ease-out' }}>
      {activity.map((item) => (
        <div key={item.id} className="dql-agent-activity" style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 18, color: item.state === 'active' ? t.textPrimary : t.textMuted }}>
          <span aria-hidden="true" style={{ width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', color: item.state === 'active' ? t.accent : t.textMuted }}>
            {item.state === 'active' ? <AgentThinkingDots /> : <Check size={13} strokeWidth={2.2} />}
          </span>
          <span style={{ fontSize: 12.5, lineHeight: 1.4, fontWeight: item.state === 'active' ? 620 : 450 }}>
            {item.label}{item.state === 'active' ? '…' : ''}
          </span>
        </div>
      ))}
      {waitHint ? <span style={{ paddingLeft: 25, fontSize: 10.5, lineHeight: 1.4, color: t.textMuted }}>{waitHint}</span> : null}
    </div>
  );
}

function AgentThinkingDots(): JSX.Element {
  return (
    <span aria-hidden="true" style={{ width: 16, height: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      {[0, 1, 2].map((index) => (
        <span key={index} className="dql-agent-thinking-dot" style={{ width: 3, height: 3, borderRadius: 999, background: 'var(--accent)', animationDelay: `${index * 120}ms` }} />
      ))}
    </span>
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
  onSelectClarification,
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onSelectClarification?: (option: AgentRunClarificationOption) => void;
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
  // A result worth saving: a real answer or research artifact (not blocked/clarify).
  const pinnable = isAgentRunPinnable(run);
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

      <ClarificationChoiceList run={run} t={t} onSelect={onSelectClarification} />

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
              sourceRunId={run.id}
              sourceQuestion={run.question}
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

export type AskInspectorTab = 'how' | 'dql' | 'sql' | 'lineage' | 'trust';

/**
 * Failed analytical runs keep the complete research scaffold visible even when
 * compilation stopped before producing one of the text artifacts. This makes a
 * remounted Ask/Notebook/Block run explain what is absent instead of silently
 * removing its DQL or SQL section. Acceptance: UI-012, UI-013, E2E-015.
 */
export function askInspectorTabsForState(input: {
  analytical: boolean;
  blocked: boolean;
  hasDql: boolean;
  hasSql: boolean;
  hasLineage: boolean;
}): Array<{ id: AskInspectorTab; label: string }> {
  const tabs: Array<{ id: AskInspectorTab; label: string }> = [];
  if (input.analytical) tabs.push({ id: 'how', label: 'How it answered' });
  if (input.hasDql || (input.analytical && input.blocked)) tabs.push({ id: 'dql', label: 'DQL' });
  if (input.hasSql || (input.analytical && input.blocked)) tabs.push({ id: 'sql', label: 'SQL' });
  if (input.hasLineage) tabs.push({ id: 'lineage', label: 'Lineage' });
  tabs.push({ id: 'trust', label: 'Trust & steps' });
  return tabs;
}

const ASK_KEYFRAMES = `
  @keyframes dql-agent-run-spin { to { transform: rotate(360deg); } }
  @keyframes dql-agent-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  @keyframes dql-agent-thinking-dot { 0%, 65%, 100% { opacity: .28; transform: translateY(0); } 32% { opacity: 1; transform: translateY(-2px); } }
  @keyframes dql-agent-activity-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
  .dql-agent-thinking-dot { animation: dql-agent-thinking-dot 1.05s ease-in-out infinite; }
  .dql-agent-activity { animation: dql-agent-activity-in .22s ease-out; }
  .dql-hover { transition: filter .15s ease, transform .12s ease, box-shadow .15s ease, background .15s ease, color .15s ease, border-color .15s ease; }
  .dql-hover:hover { filter: brightness(1.03); }
  .dql-hover:active { transform: translateY(0.5px); }
  .dql-lift:hover { transform: translateY(-1px); }
  .dql-ask-ghost:hover { background: var(--bg-0); color: var(--text-primary) !important; }
  .dql-ask-chip:hover { border-color: var(--accent) !important; box-shadow: 0 1px 6px rgba(107,93,211,0.12); }
  details > summary::-webkit-details-marker { display: none; }
  @media (prefers-reduced-motion: reduce) { .dql-agent-thinking-dot, .dql-agent-activity { animation: none !important; } }
`;

function askUserBubbleStyle(t: Theme): React.CSSProperties {
  return { alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--bg-0)', color: t.textPrimary, borderRadius: '16px 16px 4px 16px', padding: '10px 14px', fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', animation: 'dql-agent-fadein 0.25s ease-out' };
}

function askGhostBtnStyle(t: Theme): React.CSSProperties {
  return controlStyle(t, { variant: 'ghost', size: 'sm' });
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
  if (hasAnalyticalInspectorContract(payload)) return 'how';
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
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [expanded]);
  if (!result) return null;
  const chartConfig = inlineAskChartConfig(payload, result);
  const inspectorTab = preferredAskInspectorTab(run, artifact);
  const dqlArtifact = answerDqlArtifactFromRun(run) ?? resolveArtifactDqlView(payload);
  const certifiedName = artifact.trustState === 'certified' ? certifiedBlockName(artifact, payload) : undefined;
  const card = (
    <section
      data-followup="table"
      aria-label={`${resultCardTitle(run, artifact)} result`}
      style={{
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
        borderRadius: 12,
        background: 'var(--bg-2)',
        overflow: 'hidden',
        boxShadow: expanded ? '0 24px 80px rgba(15,23,42,0.28)' : selected ? '0 2px 10px rgba(107,93,211,0.12)' : '0 1px 3px rgba(26,26,26,0.04)',
        ...(expanded ? { width: 'min(1440px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 48px)' } : {}),
      }}
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
        <button
          type="button"
          className="dql-ask-ghost"
          aria-label={expanded ? 'Return result to Copilot' : 'Expand result'}
          title={expanded ? 'Return result to Copilot' : 'Expand this result for wide tables'}
          onClick={() => setExpanded((value) => !value)}
          style={askGhostBtnStyle(t)}
        >
          {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          {expanded ? 'Restore' : 'Expand result'}
        </button>
      </div>
      {dqlArtifact ? (
        <ExecutableDqlResult
          artifact={dqlArtifact}
          certifiedBlockName={certifiedName}
          initialResult={result}
          initialChartConfig={chartConfig}
          payload={payload}
          executionTarget={run.executionTarget}
          t={t}
          themeMode={themeMode}
          embedded
          expanded={expanded}
        />
      ) : (
        <ResultView
          result={result}
          themeMode={themeMode}
          t={t}
          chartConfig={chartConfig}
          embedded
          tabLabels={{ table: 'Results', chart: 'Visualization' }}
          contentMaxHeight={expanded ? 'calc(100vh - 172px)' : undefined}
          tableMaxHeight={expanded ? 'calc(100vh - 250px)' : undefined}
        />
      )}
    </section>
  );

  if (!expanded || typeof document === 'undefined') return card;
  return (
    <>
      <div style={{ minHeight: 96, border: '1px dashed var(--border-default)', borderRadius: 12, display: 'grid', placeItems: 'center', color: t.textMuted, fontSize: 11.5 }}>
        Result is open in the expanded viewer.
      </div>
      {createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${resultCardTitle(run, artifact)} expanded result`}
          onClick={() => setExpanded(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(15,23,42,0.48)', backdropFilter: 'blur(3px)' }}
        >
          <div onClick={(event) => event.stopPropagation()} style={{ minWidth: 0, maxWidth: '100%' }}>
            {card}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

interface AskRunCardProps {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  threadId?: string;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  selectedArtifactId?: string;
  onOpenArtifact?: (artifactId: string, tab: AskInspectorTab) => void;
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onReplaceDql?: (payload: InsertDqlPayload) => void;
  insertDqlActionLabel?: string;
  replaceDqlActionLabel?: string;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onSelectClarification?: (option: AgentRunClarificationOption) => void;
  onNextAction: (action: AgentRun['nextActions'][number]) => void;
  onRepairedRun: (sourceRunId: string, repairedRun: AgentRun) => void;
}

function AskRunCard(props: AskRunCardProps) {
  const {
  run,
  t,
  themeMode,
  threadId,
  appContext,
  selectedArtifactId,
  onOpenArtifact,
  onOpenApp,
  onInsertSql,
  onInsertDql,
  onReplaceDql,
  insertDqlActionLabel,
  replaceDqlActionLabel,
  onOpenBlock,
  onOpenResearch,
  onSelectClarification,
  onNextAction,
  onRepairedRun,
  } = props;
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
  const blocked = run.status === 'blocked';
  const needsClarification = run.status === 'needs_clarification';
  const presentationAnswer = blocked || needsClarification ? undefined : run.answer;
  const outcomeLabel = blocked
    ? 'Couldn’t run this query'
    : needsClarification
      ? 'Needs clarification'
      : certified
        ? 'Certified answer'
        : 'AI-generated answer';
  // The card supplies its own headline, so the body wants the most SPECIFIC text
  // available: the producer's own message beats the canned per-code headline,
  // which is the same sentence for everything unclassified.
  const failureMessage = blocked ? askFailureDetail(run) : undefined;
  const captureWarning = askRunCaptureWarning(run);
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
  const pinnable = isAgentRunPinnable(run);
  const isAnswer = run.route === 'certified_answer' || run.route === 'semantic_answer' || run.route === 'generated_answer';
  const hasResearchAction = run.nextActions.some((a) => a.route === 'research');
  const showResearchDeeper = isAnswer && pinnable && !hasResearchAction;
  const sourceArtifact = answerDqlArtifactFromRun(run);
  const canSaveBlock = pinnable && !sourceArtifact?.sourcePath && Boolean(sourceArtifact?.source ?? answerSqlFromRun(run));
  const insertionPayload = (insertDqlActionLabel && onInsertDql) || (replaceDqlActionLabel && onReplaceDql)
    ? artifactReadyPayloadFromRun(run)
    : undefined;

  const copyAnswer = () => {
    const text = presentationAnswer ? cleanAnswerText(presentationAnswer) : failureMessage ?? run.summary;
    if (!text) return;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '100%', animation: 'dql-agent-fadein 0.3s ease-out' }}>
      {/* Trust line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {blocked
          ? <ShieldAlert size={14} color={t.error} />
          : certified
            ? <ShieldCheck size={14} color={t.success} />
            : <Sparkles size={14} color={t.accent} />}
        <span style={{ fontSize: 12, fontWeight: 650, color: blocked ? t.error : t.textSecondary }}>{outcomeLabel}</span>
        {certified && evidence[0] ? (
          <span style={{ fontSize: 11, color: t.textMuted }}>from <span style={{ color: t.accent, fontWeight: 600 }}>{evidence[0].label}</span></span>
        ) : !blocked && primaryArtifact && passedChecks > 0 ? (
          <button type="button" onClick={() => openArtifact(primaryArtifact.id, 'trust')} style={{ fontSize: 11, color: t.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: t.font, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={11} color={t.success} /> {passedChecks} check{passedChecks === 1 ? '' : 's'} passed
          </button>
        ) : null}
      </div>

      {/* Answer (plain text, selectable for follow-up) */}
      {presentationAnswer ? (
        <div data-followup="answer" style={{ fontSize: 14.5, lineHeight: 1.65, color: t.textPrimary }}>
          <StructuredAnswerText text={cleanAnswerText(presentationAnswer)} t={t} />
        </div>
      ) : failureMessage ? (
        <AskFailureCard
          run={run}
          detail={failureMessage}
          threadId={threadId}
          onRepaired={(repaired) => onRepairedRun(run.id, repaired)}
          t={t}
        />
      ) : run.summary ? (
        <div data-followup="answer" style={{ fontSize: 14, lineHeight: 1.6, color: t.textSecondary }}>{cleanPresentationText(run.summary)}</div>
      ) : null}

      {captureWarning ? (
        <div role="status" style={{ fontSize: 11.5, lineHeight: 1.5, color: t.warning, borderLeft: `2px solid ${t.warning}`, paddingLeft: 8 }}>
          Capture warning: {cleanPresentationText(captureWarning)} The query result is still valid.
        </div>
      ) : null}

      <ClarificationChoiceList run={run} t={t} onSelect={onSelectClarification} />

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
              insertDqlActionLabel={insertDqlActionLabel}
              sourceRunId={run.id}
              sourceQuestion={run.question}
              onOpenBlock={onOpenBlock}
              onOpenResearch={onOpenResearch}
              onOpenApp={onOpenApp}
              onNextAction={onNextAction}
            />
          ))}
        </div>
      ) : null}

      {/* Quiet action row */}
      {(presentationAnswer || failureMessage || insertionPayload || pinnable || canSaveBlock || showResearchDeeper || primaryArtifact) ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', marginTop: -2 }}>
          {insertionPayload && onInsertDql ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onInsertDql(insertionPayload)} style={askGhostBtnStyle(t)}>
              <Plus size={12} /> {insertDqlActionLabel}
            </button>
          ) : null}
          {insertionPayload && onReplaceDql && replaceDqlActionLabel ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onReplaceDql(insertionPayload)} style={askGhostBtnStyle(t)}>
              <Pencil size={12} /> {replaceDqlActionLabel}
            </button>
          ) : null}
          {presentationAnswer || failureMessage ? (
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
            <button type="button" className="dql-ask-ghost" onClick={() => openArtifact(primaryArtifact.id, hasAnalyticalInspectorContract(payloadOf(primaryArtifact)) ? 'how' : 'trust')} style={askGhostBtnStyle(t)}>
              <ListTree size={12} /> How it was answered
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ClarificationChoiceList({
  run,
  t,
  onSelect,
}: {
  run: AgentRun;
  t: Theme;
  onSelect?: (option: AgentRunClarificationOption) => void;
}) {
  if (run.status !== 'needs_clarification' || !run.clarificationOptions?.length || !onSelect) return null;
  return (
    <div aria-label="Choose a governed meaning" style={{ display: 'grid', gap: 7, maxWidth: 620 }}>
      {run.clarificationOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          className="dql-hover dql-lift"
          onClick={() => onSelect(option)}
          title={`Use governed evidence ${option.id}`}
          style={{ display: 'grid', gap: 3, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: t.textPrimary, cursor: 'pointer', textAlign: 'left', fontFamily: t.font }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>{option.label}</span>
          {option.description ? <span style={{ fontSize: 11, lineHeight: 1.4, color: t.textMuted }}>{option.description}</span> : null}
        </button>
      ))}
    </div>
  );
}

interface AnalyticalInspectorContract {
  plan?: Record<string, unknown>;
  frame?: Record<string, unknown>;
  graph?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  facts?: Record<string, unknown>;
  narrative?: Record<string, unknown>;
  freshness?: Record<string, unknown>;
  failure?: Record<string, unknown>;
  semantic?: Record<string, unknown>;
  diagnostic?: Record<string, unknown>;
}

/**
 * A run that stopped outside the v2 analytical lane — a refusal ("could not
 * compose a governed query", "drafted a query but the table was not in the
 * retrieved metadata"), or a raw execution error — still has a reason worth
 * showing. Rebuild the minimum failure record from whatever the envelope carried
 * so "How it was answered" opens with a real account instead of vanishing
 * exactly when the user needs to see why it stopped.
 */
function fallbackAnalyticalFailure(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const executionError = payload.executionError;
  if (typeof executionError === 'string' && executionError.trim()) {
    return { stage: 'execution', message: executionError };
  }
  const errorRecord = recordOf(executionError);
  if (errorRecord) return { stage: 'execution', ...errorRecord };
  const refusalCode = typeof payload.refusalCode === 'string' ? payload.refusalCode : undefined;
  if (refusalCode) {
    const details = recordOf(payload.refusalDetails);
    const message = typeof details?.message === 'string' && details.message.trim()
      ? details.message
      : typeof payload.answer === 'string' && payload.answer.trim()
        ? payload.answer
        : 'No answer was accepted for this question.';
    return { stage: 'answer', code: refusalCode, message };
  }
  return undefined;
}

export function hasAnalyticalInspectorContract(payload: Record<string, unknown>): boolean {
  return Boolean(
    recordOf(payload.resolvedAnalyticalPlan)
    || recordOf(payload.analyticalExecutionGraph)
    || recordOf(payload.analyticalExecutionReceipt)
    || recordOf(payload.analyticalFailure)
    || recordOf(payload.semanticExecutionTrace)
    || recordOf(payload.diagnosticReceipt)
    || fallbackAnalyticalFailure(payload),
  );
}

export function analyticalInspectorContract(payload: Record<string, unknown>): AnalyticalInspectorContract | undefined {
  if (!hasAnalyticalInspectorContract(payload)) return undefined;
  const diagnostic = recordOf(payload.diagnosticReceipt);
  // `diagnostic.plan` is the orchestration step plan, not the analytical plan.
  // Treating it as a ResolvedAnalyticalPlan made a pre-planning failure claim
  // "Ranking: Not requested" even for "top customers". Only the explicit,
  // snapshot-bound analytical contract may populate frame semantics.
  const plan = recordOf(payload.resolvedAnalyticalPlan)
    ?? recordOf(diagnostic?.resolvedAnalyticalPlan);
  return {
    plan,
    frame: recordOf(plan?.analyticalFrame),
    graph: recordOf(payload.analyticalExecutionGraph),
    receipt: recordOf(payload.analyticalExecutionReceipt),
    facts: recordOf(payload.analyticalFacts),
    narrative: recordOf(payload.analyticalNarrative),
    freshness: recordOf(payload.analyticalFreshnessObservation),
    failure: recordOf(payload.analyticalFailure) ?? recordOf(diagnostic?.failure) ?? fallbackAnalyticalFailure(payload),
    semantic: recordOf(payload.semanticExecutionTrace),
    diagnostic,
  };
}

export function analyticalInspectorSections(): string[] {
  return ['Performance & provider egress', 'Plan', 'DQL', 'Compiled SQL', 'Lineage', 'Trust & evidence', 'Actual steps', 'Failure & repair'];
}

export function analyticalRepairActionLabels(safeActions: string[]): string[] {
  return [
    safeActions.includes('retry_same_plan') ? 'Retry same plan' : undefined,
    safeActions.includes('refresh_snapshot') ? 'Refresh snapshot and prepare retry' : undefined,
    safeActions.includes('request_access') || safeActions.includes('change_authorized_connection')
      ? 'Change connection or request access'
      : undefined,
    safeActions.includes('edit_dql') ? 'Open DQL to repair' : undefined,
    safeActions.includes('open_sql_notebook') ? 'Open SQL in Notebook' : undefined,
    safeActions.includes('reapply_semantic_runtime') ? 'Reapply semantic runtime settings' : undefined,
  ].filter((label): label is string => Boolean(label));
}

export function agentRunPerformanceRows(run: AgentRun): Array<[string, string]> | undefined {
  const telemetry = run.telemetry;
  if (!telemetry) return undefined;
  const egressRowCount = (run.providerEgressReceipts ?? []).reduce((sum, item) => sum + item.resultRowCount, 0);
  const totalDurationMs = telemetry.stageDurationsMs.total;
  const warehouseDurationMs = telemetry.warehouseDurationMs;
  const orchestrationDurationMs = totalDurationMs === undefined || warehouseDurationMs === undefined
    ? undefined
    : Math.max(0, totalDurationMs - warehouseDurationMs);
  const planIds = Array.from(new Set((run.artifacts ?? []).flatMap((artifact) => {
    const payload = payloadOf(artifact);
    const plan = recordOf(payload.resolvedAnalyticalPlan)
      ?? recordOf(recordOf(payload.diagnosticReceipt)?.resolvedAnalyticalPlan);
    const receipt = recordOf(payload.analyticalExecutionReceipt);
    return [plan?.planId, receipt?.planId].filter((value): value is string => typeof value === 'string' && value.length > 0);
  })));
  const artifactIds = Array.from(new Set((run.artifacts ?? [])
    .map((artifact) => artifact.id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)));
  return [
    ['Total', formatTelemetryDuration(telemetry.stageDurationsMs.total)],
    ['Warehouse', telemetry.warehouseDurationMs === undefined ? 'Not recorded' : formatTelemetryDuration(telemetry.warehouseDurationMs)],
    ['Orchestration', orchestrationDurationMs === undefined ? 'Not recorded' : formatTelemetryDuration(orchestrationDurationMs)],
    ['Stages', Object.entries(telemetry.stageDurationsMs)
      .filter(([stage]) => stage !== 'total')
      .map(([stage, duration]) => `${stage}: ${formatTelemetryDuration(duration)}`)
      .join(' · ')],
    ['Calls', `${telemetry.providerRoundTrips} provider · ${telemetry.toolCalls} tool · ${telemetry.sqlExecutions} SQL · ${telemetry.repairs} repair`],
    ['Provider rows', egressRowCount === 0
      ? `0 result rows sent to providers (${telemetry.egressReceipts} content-free receipt${telemetry.egressReceipts === 1 ? '' : 's'})`
      : `${egressRowCount} bounded, redacted Research result row${egressRowCount === 1 ? '' : 's'} sent with explicit run consent`],
    ['Plan ID', planIds.length > 0 ? planIds.join(', ') : 'Not recorded'],
    ['Artifact IDs', artifactIds.length > 0 ? artifactIds.join(', ') : 'None'],
    ['Fallback', telemetry.fallbackReason ?? 'None'],
  ];
}

function AnalyticalHowAnswered({
  run,
  contract,
  dqlArtifact,
  sql,
  lineage,
  t,
  onInsertSql,
  onInsertDql,
  onSaveBlock,
}: {
  run: AgentRun;
  contract: AnalyticalInspectorContract;
  dqlArtifact?: AgentConversationDqlArtifact;
  sql?: string;
  lineage: AskLineageEntry[];
  t: Theme;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onSaveBlock: () => void;
}) {
  const { dispatch } = useNotebook();
  const plan = contract.plan;
  const frame = contract.frame;
  const graph = contract.graph;
  const receipt = contract.receipt;
  const semantic = contract.semantic;
  const semanticFailure = recordOf(semantic?.failure);
  const failure = contract.failure ?? semanticFailure;
  const semanticAuthoringRequest = recordOf(semantic?.authoringRequest);
  const semanticRuntimeRequest = recordOf(semantic?.runtimeRequest);
  const semanticBindings = recordList(semantic?.bindings);
  const semanticSteps = recordList(semantic?.steps);
  const semanticTargetBinding = recordOf(semantic?.targetBinding);
  const semanticSnapshot = recordOf(semanticTargetBinding?.semanticSnapshot);
  const semanticExecutionTarget = recordOf(semanticTargetBinding?.executionTarget);
  const semanticTargetContext = recordOf(semanticExecutionTarget?.redactedContext);
  const semanticCompileTarget = recordOf(semanticTargetBinding?.compileTarget);
  const semanticReceipt = recordOf(semantic?.executionReceipt);
  const semanticCandidates = recordList(semanticFailure?.candidates);
  const timeContext = recordOf(frame?.timeContext);
  const comparison = recordOf(frame?.comparison);
  const ranking = recordOf(frame?.ranking);
  const dimensions = recordList(frame?.dimensions);
  const members = recordList(frame?.memberBindings);
  const periods = recordList(timeContext?.periods);
  const outputs = recordList(frame?.requestedOutputs);
  const graphNodes = recordList(graph?.nodes);
  const safeActions = Array.from(new Set([
    ...stringList(failure?.safeActions),
    ...stringList(semanticFailure?.safeActions),
  ]));
  const failedBindings = recordList(failure?.failedBindings);
  const semanticSqlExcerpt = recordOf(semanticFailure?.sqlExcerpt);
  const result = run.artifacts.map((artifact) => extractResult(payloadOf(artifact))).find(Boolean);
  const performanceRows = agentRunPerformanceRows(run);
  const sourceTitle = dqlArtifact?.name ?? run.question;
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const repairResultMessage = (
    label: string,
    response: Awaited<ReturnType<typeof api.deriveAnalyticalRepair>>,
  ) => {
    const transition = response.derivation.trustTransition;
    return `${label} as immutable derivation ${response.derivation.derivationId}. Trust: ${transition.previous} → ${transition.next}${transition.requiresReview ? ' (review required)' : ''}.`;
  };
  const openDqlRepair = async () => {
    if (!dqlArtifact?.source || !onInsertDql) return;
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action: 'edit_dql', dqlSource: dqlArtifact.source });
      onInsertDql({
        sql,
        dqlArtifact,
        result,
        title: sourceTitle,
        sourceRunId: run.id,
        question: run.question,
      });
      setRepairMessage(repairResultMessage('Opened DQL in Notebook', response));
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const openSqlRepair = async () => {
    if (!sql || !onInsertSql) return;
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action: 'open_sql_notebook', sqlText: sql });
      onInsertSql(sql, `${sourceTitle} repair`, {
        question: run.question,
        sourceRunId: run.id,
      });
      setRepairMessage(repairResultMessage('Opened SQL in Notebook', response));
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const deriveSimpleRepair = async (action: 'retry_same_plan' | 'refresh_snapshot') => {
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action });
      const label = action === 'retry_same_plan'
        ? 'Prepared the same bounded plan for retry'
        : 'Refreshed the governed snapshot and prepared the same plan for retry';
      setRepairMessage(repairResultMessage(label, response));
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const openAccessRepair = async () => {
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action: 'request_access' });
      setRepairMessage(repairResultMessage('Recorded the access/connection repair and opened Database settings', response));
      dispatch({ type: 'SET_SETTINGS_TAB', tab: 'database' });
      dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const openSemanticRuntimeSetup = () => {
    dispatch({ type: 'SET_SETTINGS_TAB', tab: 'project' });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
    setRepairMessage('Opened Project & dbt settings. Test and apply the intended dbt Cloud Semantic Layer environment to refresh its verified metric inventory.');
  };

  return (
    <div style={{ display: 'grid', gap: 9 }} aria-label="How it answered">
      {/*
        Outcome first. The real execution error used to sit at the BOTTOM of this
        panel, below Plan, DQL, SQL, Lineage, Trust and Steps, so a failed run
        showed six sections of diagnostics before saying what actually went
        wrong. Success or the warehouse's own message now leads.
      */}
      <div
        role="status"
        style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8,
          border: `1px solid ${failure ? 'var(--status-error-border)' : 'var(--status-success-border)'}`,
          background: failure ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
        }}
      >
        {failure
          ? <ShieldAlert size={13} color="var(--status-error)" style={{ flexShrink: 0, marginTop: 2 }} />
          : <ShieldCheck size={13} color="var(--status-success)" style={{ flexShrink: 0, marginTop: 2 }} />}
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: failure ? 'var(--status-error)' : 'var(--status-success)' }}>
            {failure ? 'Execution failed' : 'Answered successfully'}
          </div>
          {failure ? (
            <>
              {/* The engine's own words, not a paraphrase — that is what makes
                  a failure actionable. */}
              <div style={{ marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: t.fontMono, fontSize: 11 }}>
                {typeof failure.message === 'string' && failure.message.trim()
                  ? failure.message
                  : 'The engine did not report a message. Open the DQL and SQL tabs to inspect what ran.'}
              </div>
              <div style={{ marginTop: 4, fontSize: 10.5, color: t.textMuted }}>
                {[failure.code, failure.phase ? `during ${failure.phase}` : ''].filter(Boolean).map(displayValue).join(' · ')}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 2 }}>
              {typeof receipt?.rowCount === 'number'
                ? `Returned ${receipt.rowCount} row${receipt.rowCount === 1 ? '' : 's'}.`
                : 'The query ran and returned a result.'}
            </div>
          )}
        </div>
      </div>

      <AnalyticalInspectorSection index={1} label="Performance & provider egress" t={t} open>
        {performanceRows ? (
          <InspectorRows rows={performanceRows} t={t} />
        ) : (
          <InspectorEmpty t={t}>Performance details were not recorded for this legacy run.</InspectorEmpty>
        )}
      </AnalyticalInspectorSection>

      <AnalyticalInspectorSection index={2} label="Plan" t={t} open={!failure}>
        <InspectorRows rows={[
          ['Question type', displayValue(frame?.questionType ?? plan?.questionType)],
          ['Selected route', displayValue(graph?.route ?? plan?.recommendedRoute)],
          ['Metric', stringList(frame?.metricConceptIds).join(', ')],
          ['Entity grain', stringList(frame?.entityGrainIds).join(', ')],
          ['Dimensions', dimensions.map((item) => `${displayValue(item.dimensionId)} (${displayValue(item.role)})`).join(', ')],
          ['Member filters', members.map((item) => `${displayValue(item.dimensionId)}: ${Array.isArray(item.canonicalValues) ? item.canonicalValues.length : 0} bound value(s)`).join(', ')],
          ['Time policy', [timeContext?.timeRole, timeContext?.grain, timeContext?.timezone, timeContext?.completenessPolicy].map(displayValue).filter(Boolean).join(' · ')],
          ['Periods', periods.map((item) => `${displayValue(item.id)}: ${displayValue(item.start)} → ${displayValue(item.end)}`).join('\n')],
          ['Comparison', comparison ? `${displayValue(comparison.basePeriodId)} vs ${stringList(comparison.comparisonPeriodIds).join(', ')} · ${displayValue(comparison.alignment)}` : frame ? 'Not requested' : 'Not available — analytical planning did not complete'],
          ['Ranking', ranking ? `${displayValue(ranking.direction)} · top ${displayValue(ranking.limit)} · ${displayValue(ranking.tiePolicy)}` : frame ? 'Not requested' : 'Not available — analytical planning did not complete'],
          ['Outputs', outputs.map((item) => `${displayValue(item.id)} (${displayValue(item.kind)})`).join(', ')],
          ['Semantic metrics', stringList(semanticAuthoringRequest?.metrics).join(', ')],
          ['Semantic dimensions', stringList(semanticAuthoringRequest?.dimensions).join(', ')],
        ]} t={t} />
      </AnalyticalInspectorSection>

      {/*
        DQL, Compiled SQL and Lineage each have their OWN tab. Repeating them
        here meant a user read the same script twice and could not tell whether
        the two copies were the same thing — which is exactly the confusion this
        panel should remove. Diagnostics that exist nowhere else stay below.
      */}
      <AnalyticalInspectorSection index={3} label="Trust & evidence" t={t}>
        <InspectorRows rows={[
          ['Trust state', run.trustState],
          ['Snapshot', displayValue(plan?.snapshotId ?? graph?.snapshotId)],
          ['Plan fingerprint', displayValue(plan?.fingerprint ?? graph?.planFingerprint)],
          ['Graph fingerprint', displayValue(graph?.fingerprint)],
          ['Receipt', displayValue(receipt?.receiptId)],
          ['Result fingerprint', displayValue(receipt?.resultFingerprint)],
          ['Freshness observed through', displayValue(contract.freshness?.observedThrough)],
          ['Fact set', displayValue(contract.facts?.fingerprint)],
          ['Semantic adapter', displayValue(semantic?.adapter)],
          ['Semantic compile status', displayValue(semantic?.status)],
          ['Target proof', displayValue(recordOf(semanticTargetBinding?.proof)?.status)],
          ['Target binding', displayValue(semanticTargetBinding?.bindingFingerprint)],
          ['Compile target', displayValue(semanticCompileTarget?.kind)],
          ['Local semantic snapshot', displayValue(semanticSnapshot?.semanticCatalogFingerprint ?? semanticSnapshot?.sourceFingerprint)],
          ['Runtime metric inventory proof', displayValue(semanticCompileTarget?.semanticCatalogFingerprint)],
          ['Execution target', [
            semanticExecutionTarget?.driver,
            semanticTargetContext?.account,
            semanticTargetContext?.database,
            semanticTargetContext?.schema,
            semanticTargetContext?.role,
            semanticTargetContext?.warehouse,
          ].map(displayValue).filter(Boolean).join(' · ')],
          ['Semantic receipt', displayValue(semanticReceipt?.receiptId)],
          ['Warehouse query ID', displayValue(semanticReceipt?.queryId)],
          ['Executed SQL proof', displayValue(semanticReceipt?.executedSqlFingerprint)],
          ['Runtime metrics', stringList(semanticRuntimeRequest?.metrics).join(', ')],
          ['Runtime dimensions', stringList(semanticRuntimeRequest?.dimensions).join(', ')],
          ['Member bindings', semanticBindings.map((binding) =>
            `${displayValue(binding.authoringReference)} → ${displayValue(binding.runtimeReference)}`
            + `${stringList(binding.entityPath).length ? ` via ${stringList(binding.entityPath).join(' → ')}` : ''}`
            + ` (${displayValue(binding.status)})`).join('\n')],
        ]} t={t} mono />
      </AnalyticalInspectorSection>

      <AnalyticalInspectorSection index={4} label="Actual steps" t={t}>
        <div style={{ display: 'grid', gap: 6 }}>
          {semanticSteps.map((step, index) => (
            <div key={`semantic:${displayValue(step.id) || index}`} style={{ fontSize: 11.5, color: t.textSecondary }}>
              <strong style={{ color: displayValue(step.status) === 'failed' ? 'var(--status-error)' : t.textPrimary }}>
                {index + 1}. {displayValue(step.label)}
              </strong>
              {' '}— {displayValue(step.status)} · {displayValue(step.detail)}
            </div>
          ))}
          {run.steps.map((step) => (
            <div key={step.id} style={{ fontSize: 11.5, color: t.textSecondary }}>
              <strong style={{ color: t.textPrimary }}>{step.index + 1}. {step.goal}</strong> — {step.status}, {step.attempts} attempt{step.attempts === 1 ? '' : 's'}
            </div>
          ))}
          {graphNodes.map((node, index) => (
            <div key={displayValue(node.id) || index} style={{ fontSize: 11.5, color: t.textSecondary }}>
              <span style={{ color: t.accent, fontFamily: t.fontMono }}>{index + 1}. {displayValue(node.kind)}</span>
              {' '}· {displayValue(node.id)}
            </div>
          ))}
          {semanticSteps.length === 0 && run.steps.length === 0 && graphNodes.length === 0 ? <InspectorEmpty t={t}>No executable steps were recorded.</InspectorEmpty> : null}
        </div>
      </AnalyticalInspectorSection>

      <AnalyticalInspectorSection index={5} label="Failure & repair" t={t} open={Boolean(failure)}>
        {failure ? (
          <div style={{ display: 'grid', gap: 9 }}>
            {/* The engine's message now leads the whole panel, so only the
                diagnostics that exist nowhere else belong here. */}
            <InspectorRows rows={[
              ['Failure ID', displayValue(failure.failureId)],
              ['Recoverability', displayValue(failure.recoverability)],
              ['Failed bindings', failedBindings.map((item) => `${displayValue(item.qualifiedId ?? item.role)} (${displayValue(item.reasonCode)})`).join(', ')],
              ['Safe actions', safeActions.join(', ')],
              ['DQL fingerprint', displayValue(failure.dqlFingerprint)],
              ['SQL fingerprint', displayValue(failure.sqlFingerprint)],
              ['Semantic failure code', displayValue(semanticFailure?.code)],
              ['Failing identifier', displayValue(semanticFailure?.identifier)],
              ['Compiled SQL proof', displayValue(semanticFailure?.compiledSqlFingerprint)],
              ['Path candidates', semanticCandidates.map((candidate) =>
                `${displayValue(candidate.label)}\n${displayValue(candidate.runtimeReference)}`).join('\n')],
            ]} t={t} mono />
            {displayValue(semanticSqlExcerpt?.text) ? (
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: t.textSecondary, marginBottom: 5 }}>
                  Failing SQL context · lines {displayValue(semanticSqlExcerpt?.startLine)}–{displayValue(semanticSqlExcerpt?.endLine)}
                </div>
                <pre style={codeStyle(t)}>{displayValue(semanticSqlExcerpt?.text)}</pre>
              </div>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Safe repair actions">
              {safeActions.includes('edit_dql') && onInsertDql ? (
                <button type="button" onClick={() => void openDqlRepair()} style={smallButtonStyle(t)}>
                  <Wrench size={12} /> Open DQL to repair
                </button>
              ) : null}
              {safeActions.includes('open_sql_notebook') && onInsertSql ? (
                <button type="button" onClick={() => void openSqlRepair()} style={smallButtonStyle(t)}>
                  <Code2 size={12} /> Open SQL in Notebook
                </button>
              ) : null}
              {safeActions.includes('retry_same_plan') ? (
                <button type="button" onClick={() => void deriveSimpleRepair('retry_same_plan')} style={smallButtonStyle(t)}>
                  <RefreshCw size={12} /> Retry same plan
                </button>
              ) : null}
              {safeActions.includes('refresh_snapshot') ? (
                <button type="button" onClick={() => void deriveSimpleRepair('refresh_snapshot')} style={smallButtonStyle(t)}>
                  <RefreshCw size={12} /> Refresh snapshot and prepare retry
                </button>
              ) : null}
              {safeActions.includes('request_access') || safeActions.includes('change_authorized_connection') ? (
                <button type="button" onClick={() => void openAccessRepair()} style={smallButtonStyle(t)}>
                  <ShieldAlert size={12} /> Change connection or request access
                </button>
              ) : null}
              {safeActions.includes('reapply_semantic_runtime') ? (
                <button type="button" onClick={openSemanticRuntimeSetup} style={smallButtonStyle(t)}>
                  <RefreshCw size={12} /> Reapply semantic runtime settings
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <InspectorEmpty t={t}>No failure was recorded for this run.</InspectorEmpty>
            {dqlArtifact?.sourcePath ? null : dqlArtifact?.source ? (
              <button type="button" onClick={onSaveBlock} style={smallButtonStyle(t)}><Save size={12} /> Save as draft block</button>
            ) : null}
          </div>
        )}
      </AnalyticalInspectorSection>
      {repairMessage ? <div role="status" style={{ fontSize: 10.5, color: repairMessage.toLowerCase().includes('created') ? 'var(--status-success)' : 'var(--status-error)' }}>{repairMessage}</div> : null}
    </div>
  );
}

function AnalyticalInspectorSection({
  index,
  label,
  t,
  open = false,
  children,
}: {
  index: number;
  label: string;
  t: Theme;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-1)', overflow: 'hidden' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '8px 10px', display: 'flex', gap: 7, alignItems: 'center', fontSize: 11.5, fontWeight: 700, color: t.textPrimary }}>
        <span style={{ width: 18, height: 18, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10 }}>{index}</span>
        {label}
      </summary>
      <div style={{ display: 'grid', gap: 8, padding: '0 10px 10px' }}>{children}</div>
    </details>
  );
}

function InspectorRows({ rows, t, mono = false }: { rows: Array<[string, string]>; t: Theme; mono?: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.filter(([, value]) => value).map(([label, value]) => (
        <div key={label} style={{ display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: 8, alignItems: 'start' }}>
          <span style={{ fontSize: 10.5, color: t.textMuted }}>{label}</span>
          <span style={{ fontSize: 10.5, color: t.textSecondary, fontFamily: mono ? t.fontMono : t.font, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function InspectorEmpty({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: t.textMuted }}>{children}</div>;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => recordOf(item) ? [recordOf(item)!] : []) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function formatTelemetryDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Not recorded';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms`;
}

export function clarificationSelectionInput(option: AgentRunClarificationOption): {
  question: string;
  selectedEvidenceId: string;
} {
  return { question: option.question ?? option.label, selectedEvidenceId: option.id };
}

/**
 * Compact, immutable baseline handed to an explicit Research-deeper run.
 * Research may attempt a richer governed query, but it must retain the exact
 * successful Ask SQL/DQL, result sample, and target as its safe fallback rather
 * than recomposing the baseline on an unrelated default connection.
 */
export function researchSourceFromRun(run: AgentRun): Record<string, unknown> {
  const result = run.artifacts
    .map((artifact) => extractResult(payloadOf(artifact)))
    .find((candidate): candidate is QueryResult => Boolean(candidate));
  const sourceRef = run.artifacts.find((artifact) => artifact.ref)?.ref;
  return {
    runId: run.id,
    question: run.question,
    trustState: run.trustState,
    executionTarget: run.executionTarget,
    sourceCertifiedBlock: sourceRef,
    sql: answerSqlFromRun(run),
    dqlArtifact: answerDqlArtifactFromRun(run),
    ...(result ? {
      result: {
        columns: result.columns,
        rows: result.rows.slice(0, 24),
        rowCount: result.rowCount,
      },
    } : {}),
  };
}

export function isAgentRunPinnable(run: AgentRun): boolean {
  const hasMixedSourcePlan = run.artifacts.some((artifact) =>
    Boolean(extractMixedSourceNotebookPlan(payloadOf(artifact))),
  );
  return !hasMixedSourcePlan
    && run.status !== 'blocked'
    && run.status !== 'needs_clarification'
    // A run that produced only a DQL artifact — "the DQL from Ask AI" — is
    // exactly what people want on a page, but it used to render no Add-to-App
    // button at all because it carries no `answer` artifact. This mirrors the
    // `canSaveBlock` gate, which already accepted that case.
    && (run.artifacts.some((artifact) => artifact.kind === 'answer' || artifact.kind === 'research_run')
      || Boolean(answerDqlArtifactFromRun(run) ?? answerSqlFromRun(run)));
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
  onInsertSql,
  onInsertDql,
}: {
  run: AgentRun;
  artifact: AgentRunArtifact;
  tab: AskInspectorTab;
  t: Theme;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  onChangeTab: (tab: AskInspectorTab) => void;
  onClose: () => void;
  onSaveBlock: () => void;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
}) {
  const payload = payloadOf(artifact);
  const dqlArtifact = answerDqlArtifactFromRun(run) ?? resolveArtifactDqlView(payload);
  const sql = answerSqlFromRun(run) ?? (typeof payload.sql === 'string' ? payload.sql : undefined);
  const resultData = extractResult(payload);
  const insertTitle = resultCardTitle(run, artifact);
  const evidence = evidenceFromRun(run);
  const lineage = lineageEntriesFromRun(run);
  const trustNote = trustExplainer(run);
  const certified = artifact.trustState === 'certified';
  const blocked = run.status === 'blocked' || artifact.trustState === 'blocked';
  const pinnable = isAgentRunPinnable(run);
  const analytical = analyticalInspectorContract(payload);

  const tabs = askInspectorTabsForState({
    analytical: Boolean(analytical),
    blocked,
    hasDql: Boolean(dqlArtifact?.source),
    hasSql: Boolean(sql),
    hasLineage: lineage.length > 0,
  });
  const activeTab = tabs.some((x) => x.id === tab) ? tab : tabs[0].id;

  const badgeLabel = blocked ? 'Blocked' : certified ? 'Certified' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'Governed' : 'AI-generated';
  const badgeColor = blocked ? 'var(--status-error)' : certified ? 'var(--status-success)' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'var(--accent)' : 'var(--status-warning)';
  const badgeBg = blocked ? 'var(--status-error-bg)' : certified ? 'var(--status-success-bg)' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'var(--accent-dim)' : 'var(--status-warning-bg)';

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
        {pinnable ? <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} /> : null}
        {pinnable ? (
          <button type="button" className="dql-hover" onClick={onSaveBlock} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: t.textSecondary, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>
            <Blocks size={13} /> Save as block
          </button>
        ) : null}
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
        {activeTab === 'how' && analytical ? (
          <AnalyticalHowAnswered
            run={run}
            contract={analytical}
            dqlArtifact={dqlArtifact}
            sql={sql}
            lineage={lineage}
            t={t}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
            onSaveBlock={onSaveBlock}
          />
        ) : null}
        {activeTab === 'dql' ? (
          dqlArtifact?.source ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: t.textMuted }}>Reusable governed artifact — save it as a block to certify.</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {onInsertDql ? (
                    <button
                      type="button"
                      onClick={() => onInsertDql({
                        sql,
                        dqlArtifact,
                        result: resultData,
                        chartConfig: resultData ? extractChartConfig(payload, resultData) : undefined,
                        title: insertTitle,
                        sourceRunId: run.id,
                        question: run.question,
                      })}
                      style={smallButtonStyle(t)}
                    >
                      Open DQL in notebook
                    </button>
                  ) : null}
                  <CopyButton text={dqlArtifact.source} t={t} title="Copy DQL" />
                </div>
              </div>
              <pre style={codeStyle(t)}>{dqlArtifact.source}</pre>
            </>
          ) : (
            <InspectorEmpty t={t}>The selected plan failed before a DQL source could be materialized. Review the Plan and Failure & repair sections.</InspectorEmpty>
          )
        ) : null}
        {activeTab === 'sql' ? (
          sql ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: t.textMuted }}>Attempted compiled SQL — open it in Notebook to inspect or repair.</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {onInsertSql ? (
                    <button
                      type="button"
                      onClick={() => onInsertSql(sql, insertTitle, {
                        question: run.question,
                        sourceRunId: run.id,
                      })}
                      style={smallButtonStyle(t)}
                    >
                      Open SQL in notebook
                    </button>
                  ) : null}
                  <CopyButton text={sql} t={t} title="Copy SQL" />
                </div>
              </div>
              <pre style={codeStyle(t)}>{sql}</pre>
            </>
          ) : (
            <InspectorEmpty t={t}>Compilation stopped before SQL was produced. The DQL, plan, trust evidence, and failure steps are still retained.</InspectorEmpty>
          )
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
 * Keep Ask-to-App failures actionable. A raw 405 here means the browser bundle
 * is talking to a Notebook runtime that predates the unified App Build API (or
 * was not restarted after rebuilding). Falling back to the legacy `/api/apps`
 * write would bypass the private-draft contract, so fail closed and explain the
 * one safe recovery instead.
 */
export function askAppWriteErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if ((error instanceof DqlApiError && error.status === 405) || /method not allowed/i.test(message)) {
    return 'This Notebook server is older than the App Studio shown in your browser. Restart dql notebook, reload this page, and try again. No Project files were published.';
  }
  return message || fallback;
}

export function appPinDestinationLabel(appName: string, dashboardTitle?: string): string {
  return dashboardTitle?.trim() ? `${appName} › ${dashboardTitle.trim()}` : appName;
}

export interface AskAppDestination {
  id: string;
  kind: 'draft' | 'project';
  appId: string;
  name: string;
  draft?: AppStudioBuildDraft;
  pageId?: string;
  pageTitle?: string;
}

/** Coalesce Project Apps that already have a local edit draft into one choice. */
export function askAppDestinations(apps: AppSummary[], drafts: AppStudioBuildDraft[]): AskAppDestination[] {
  const localDrafts = drafts.filter((draft) => draft.state !== 'project_published');
  const draftedProjectIds = new Set(localDrafts.flatMap((draft) => draft.baseApp?.appId ? [draft.baseApp.appId] : []));
  return [
    ...localDrafts.map((draft): AskAppDestination => ({
      id: `draft:${draft.id}`,
      kind: 'draft',
      appId: draft.appId,
      name: draft.name,
      draft,
      pageId: draft.pages[0]?.id,
      pageTitle: draft.pages[0]?.metadata.title,
    })),
    ...apps.filter((app) => !draftedProjectIds.has(app.id)).map((app): AskAppDestination => {
      const pageId = app.homepage?.type === 'dashboard' ? app.homepage.id : app.dashboards[0]?.id;
      return {
        id: `project:${app.id}`,
        kind: 'project',
        appId: app.id,
        name: app.name,
        pageId,
        pageTitle: app.dashboards.find((dashboard) => dashboard.id === pageId)?.title,
      };
    }),
  ];
}

/**
 * Save an Ask result into the unified local AppBuildDraft. The result remains
 * editable in Studio; certified answers keep their block identity and all
 * other answers are materialized as review-required local evidence.
 */
function AddToAppButton({
  run,
  t,
  appContext,
  onOpenApp,
}: {
  run: AgentRun;
  t: Theme;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [destinations, setDestinations] = useState<AskAppDestination[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<'list' | 'new'>('list');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The tile name, editable before adding rather than silently derived. */
  const [tileName, setTileName] = useState('');
  const [done, setDone] = useState<{
    appId: string;
    draftId: string;
    pageId?: string;
    name: string;
    pageTitle?: string;
    tileTitle: string;
    kind: 'certified' | 'review' | 'narrative' | 'existing';
  } | null>(null);
  const createdRef = useRef<AppStudioBuildDraft | null>(null);

  const loadApps = async () => {
    setDestinations(null);
    setLoadError(false);
    const [projectApps, appBuilds] = await Promise.allSettled([api.listAppsStrict(), api.listAppBuilds()]);
    if (projectApps.status === 'rejected' && appBuilds.status === 'rejected') {
      setDestinations([]);
      setLoadError(true);
      return;
    }
    const choices = askAppDestinations(
      projectApps.status === 'fulfilled' ? projectApps.value : [],
      appBuilds.status === 'fulfilled' ? appBuilds.value.drafts : [],
    );
    setDestinations(choices);
    if (choices.length === 0) setView('new');
  };

  const openPicker = () => {
    setOpen(true);
    setError(null);
    setView('list');
    createdRef.current = null;
    setNewName(defaultAppName(run.question));
    setTileName(defaultAppName(run.question));
    void loadApps();
  };

  const closePicker = () => {
    if (busy) return; // don't dismiss mid-write (would hide the error/result)
    setOpen(false);
    setError(null);
  };

  const addToDraft = async (draft: AppStudioBuildDraft, name: string, requestedPageId?: string, pageTitle?: string) => {
    const tileTitle = tileName.trim() || defaultAppName(run.question);
    const dqlArtifact = answerDqlArtifactFromRun(run);
    const certifiedBlock = certifiedBlockNameFromRun(run);
    const result = await api.addAskResultToAppBuild(draft.id, {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      pageId: requestedPageId,
      title: tileTitle,
      question: run.question,
      answer: run.answer ?? run.summary,
      certifiedBlockId: certifiedBlock,
      dqlSource: dqlArtifact?.source,
      sql: answerSqlFromRun(run),
      visualization: runChartConfig(run)?.chart,
    });
    setDone({
      appId: result.draft.appId,
      draftId: result.draft.id,
      pageId: result.pageId,
      name,
      pageTitle: result.draft.pages.find((page) => page.id === result.pageId)?.metadata.title ?? pageTitle,
      tileTitle,
      kind: result.deduped ? 'existing' : certifiedBlock ? 'certified' : (dqlArtifact?.source || answerSqlFromRun(run)) ? 'review' : 'narrative',
    });
    window.dispatchEvent(new CustomEvent('dql-app-build-updated', {
      detail: { draft: result.draft, pageId: result.pageId, tileId: result.tileId },
    }));
    setOpen(false);
  };

  const ensureDraft = async (destination: AskAppDestination): Promise<AppStudioBuildDraft> => {
    if (destination.draft) return destination.draft;
    const latest = await api.listAppBuilds();
    const existing = latest.drafts.find((draft) => draft.state !== 'project_published' && draft.baseApp?.appId === destination.appId);
    if (existing) return existing;
    return (await api.createAppBuild({
      baseAppId: destination.appId,
      goal: `Edit ${destination.name} with an Ask result`,
      authoringMode: 'ai',
      sourcePolicy: certifiedBlockNameFromRun(run) ? 'governed_only' : 'include_review_required',
      template: 'blank',
      entrypoint: 'ask',
    })).draft;
  };

  const addToExisting = async (destination: AskAppDestination) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await ensureDraft(destination);
      const pageId = appContext?.appId === destination.appId ? appContext.dashboardId : destination.pageId;
      await addToDraft(draft, destination.name, pageId, destination.pageTitle);
    } catch (e) {
      setError(askAppWriteErrorMessage(e, 'Could not add to app.'));
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
        createdRef.current = (await api.createAppBuild({
          name,
          goal: run.question,
          authoringMode: 'ai',
          sourcePolicy: certifiedBlockNameFromRun(run) ? 'governed_only' : 'include_review_required',
          template: 'blank',
          entrypoint: 'ask',
        })).draft;
      }
      await addToDraft(createdRef.current, name, createdRef.current.pages[0]?.id, createdRef.current.pages[0]?.metadata.title);
      createdRef.current = null;
    } catch (e) {
      setError(askAppWriteErrorMessage(e, 'Could not create the app.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {done ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto',
            alignItems: 'center',
            gap: 8,
            minWidth: 260,
            maxWidth: 440,
            padding: '8px 9px',
            borderRadius: 9,
            background: `${t.success}12`,
            color: t.success,
            border: `1px solid ${t.success}55`,
          }}
        >
          <span style={{ width: 26, height: 26, borderRadius: 999, display: 'grid', placeItems: 'center', background: `${t.success}20` }}>
            <CheckCircle2 size={15} />
          </span>
          <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
            <b style={{ fontSize: 11.5 }}>
              {done.kind === 'existing'
                ? 'Already on this page'
                : done.kind === 'certified'
                  ? 'Saved as a certified tile'
                  : done.kind === 'review'
                    ? 'Saved — review required'
                    : 'Saved as editable narrative'}
            </b>
            <span title={appPinDestinationLabel(done.name, done.pageTitle)} style={{ fontSize: 10.5, color: t.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {appPinDestinationLabel(done.name, done.pageTitle)} · editable draft
            </span>
            <span title={done.tileTitle} style={{ fontSize: 10, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Tile: {done.tileTitle}
            </span>
            {done.kind === 'review' || done.kind === 'narrative' ? (
              <span style={{ fontSize: 10, color: t.textMuted, lineHeight: 1.35 }}>
                Stays local and cannot publish until reviewed, promoted, or removed.
              </span>
            ) : null}
          </span>
          {onOpenApp ? (
            <button
              type="button"
              className="dql-hover"
              onClick={() => onOpenApp(done.appId, done.pageId, done.draftId)}
              style={{ ...smallButtonStyle(t), color: t.success, whiteSpace: 'nowrap' }}
              title="Open the App page containing this tile"
            >
              Open App <ArrowRight size={12} />
            </button>
          ) : null}
        </div>
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
              <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{view === 'new' ? 'Name the new App draft' : 'Save to an editable App'}</span>
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
                  {destinations && destinations.length > 0 ? <button type="button" className="dql-hover" onClick={() => setView('list')} style={smallButtonStyle(t)}>Back</button> : null}
                  <button type="button" className="dql-hover" disabled={busy || !newName.trim()} onClick={() => void createAndAdd()} style={{ ...heroAddButtonStyle(t), flex: 1, justifyContent: 'center' }}>
                    {busy ? <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Plus size={13} />}
                    Create draft &amp; add
                  </button>
                </div>
              </div>
            ) : destinations === null ? (
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
                {/* Name the tile before it lands. It used to be derived from the
                    question with no way to change it afterwards. */}
                <label style={{ display: 'grid', gap: 3, marginBottom: 5 }}>
                  <span style={{ fontSize: 10.5, color: t.textMuted }}>Tile name</span>
                  <input
                    value={tileName}
                    onChange={(e) => setTileName(e.target.value)}
                    placeholder={defaultAppName(run.question)}
                    maxLength={120}
                    style={pickerInputStyle(t)}
                  />
                </label>
                <button type="button" className="dql-hover" onClick={() => setView('new')} style={newAppRowStyle(t)}>
                  <Plus size={13} /> New app…
                </button>
                {destinations.map((destination) => (
                  <button key={destination.id} type="button" className="dql-hover" disabled={busy} onClick={() => void addToExisting(destination)} style={appRowStyle(t)}>
                    <LayoutDashboard size={13} style={{ flex: '0 0 auto', opacity: 0.7 }} />
                    <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 1, overflow: 'hidden', textAlign: 'left' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{destination.name}</span>
                      <small style={{ color: t.textMuted }}>{destination.kind === 'draft' ? 'Local editable draft' : 'Project App · creates a safe edit draft'}</small>
                    </span>
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
  if (run.route === 'dql_block_draft') return 'Prepared an ownerless review draft. Add it to Block Studio when you are ready to save it.';
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
  // Authoring routes produce a source proposal, not an answer. Telling the user
  // to "save it as a block" there is both wrong and the reason Modeling AI still
  // read as Ask AI: a modeling/skill draft is saved to its YAML after review.
  if (run.route === 'modeling_draft') return 'AI-drafted modeling proposal. Review the exact source diff, then save it as a draft — nothing is written or joinable yet.';
  if (run.route === 'skill_draft') return 'AI-drafted Skill proposal. Review it, then save it as a draft — it will not guide any agent until you activate it.';
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
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
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

  const commit = async (edits: AppBuildBriefEdits) => {
    setBusy(true);
    setError(null);
    // The chat path used to send only the selection, so a name or tile title
    // typed in this brief was silently discarded even though the API accepts it.
    const result = await api.commitAppAiBuild(sessionId, {
      selectedTileIds: Array.from(selected),
      expectedProposalHash: proposalHash,
      ...(edits.appName ? { appName: edits.appName } : {}),
      ...(edits.pageTitle ? { pageTitle: edits.pageTitle } : {}),
      ...(edits.audience ? { audience: edits.audience } : {}),
      ...(Object.keys(edits.tileOverrides).length > 0 ? { tileOverrides: edits.tileOverrides } : {}),
    });
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
          onCreate={(edits) => void commit(edits)}
          defaultName={artifact.title}
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
  executionTarget,
  t,
  themeMode,
  embedded = false,
  expanded = false,
}: {
  artifact: AgentConversationDqlArtifact;
  certifiedBlockName?: string;
  initialResult: QueryResult;
  initialChartConfig?: CellChartConfig;
  payload: Record<string, unknown>;
  executionTarget?: ExecutionTarget;
  t: Theme;
  themeMode: ThemeMode;
  embedded?: boolean;
  expanded?: boolean;
}) {
  const [activeArtifact, setActiveArtifact] = useState<AgentConversationDqlArtifact>(artifact);
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
  const [addingFilter, setAddingFilter] = useState(false);
  const [filterColumn, setFilterColumn] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const runInFlightRef = useRef(false);
  const upstreamArtifactRef = useRef(artifact);
  upstreamArtifactRef.current = artifact;
  const artifactStateKey = askArtifactStateKey(artifact);

  useEffect(() => {
    const upstreamArtifact = upstreamArtifactRef.current;
    setActiveArtifact(upstreamArtifact);
    setAddingFilter(false);
    if (!certifiedBlockName) {
      setParameters(upstreamArtifact.parameters ?? []);
      setValues({
        ...(upstreamArtifact.parameterValues ?? {}),
        ...resolvedParameterValues(payload),
      });
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
  }, [artifactStateKey, certifiedBlockName]);

  const run = async () => {
    if (runInFlightRef.current) return;
    runInFlightRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const response = await api.invokeDqlArtifact(activeArtifact, values, undefined, certifiedBlockName, executionTarget);
      setResult(response.result);
      setActiveArtifact(response.artifact);
      if (response.result.chartConfig && typeof response.result.chartConfig === 'object') {
        setChartConfig(response.result.chartConfig as CellChartConfig);
      }
      if (response.parameters.length > 0) setParameters(response.parameters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      runInFlightRef.current = false;
      setRunning(false);
    }
  };

  const filterCandidates = useMemo(
    () => askResultFilterCandidates(activeArtifact, result),
    [activeArtifact, result],
  );
  const openFilterEditor = () => {
    const candidate = filterCandidates[0];
    if (!candidate) return;
    setFilterColumn(candidate.column);
    setFilterValue(candidate.values[0] == null ? '' : String(candidate.values[0]));
    setAddingFilter(true);
    setError(null);
  };
  const addResultFilter = async () => {
    try {
      // A generated SQL answer needs a real dialect parse to place the
      // predicate, so the server owns that edit. A semantic block binds to a
      // declared dimension and stays local.
      const added = activeArtifact.kind === 'sql_block'
        ? await api.addDqlArtifactResultFilter(activeArtifact, result.columns, filterColumn, filterValue, executionTarget)
        : addAskResultFilter(activeArtifact, result, filterColumn, filterValue);
      setActiveArtifact(added.artifact as typeof activeArtifact);
      setParameters(added.artifact.parameters ?? []);
      setValues((current) => ({ ...current, ...(added.artifact.parameterValues ?? {}) }));
      setAddingFilter(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const editable = parameters.some(isRuntimeEditableParameter);
  const appliedInputs = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      {appliedInputs.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: embedded ? '8px 12px 0' : 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 750, color: t.textMuted }}>Applied inputs</span>
          {appliedInputs.map(([name, value]) => (
            <span key={name} style={{ fontSize: 10.5, color: t.textSecondary, border: `1px solid ${t.cellBorder}`, background: t.appBg, borderRadius: 999, padding: '2px 7px' }}>
              {name.replace(/_/g, ' ')} = {formatAppliedParameterValue(value)}
            </span>
          ))}
        </div>
      ) : null}
      {loading ? <div style={{ fontSize: 10.5, color: t.textMuted }}>Loading reusable inputs…</div> : editable || filterCandidates.length > 0 ? (
        <div style={{ display: 'grid', gap: 8, padding: 9, margin: embedded ? '0 12px' : 0, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.appBg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.textPrimary }}>Change DQL inputs</div>
              <div style={{ fontSize: 10, color: t.textMuted }}>Reruns this DQL artifact directly. It does not start another AI search.</div>
            </div>
            {filterCandidates.length > 0 ? (
              <button type="button" onClick={openFilterEditor} style={smallButtonStyle(t)}>
                <Plus size={11} /> Add result filter
              </button>
            ) : null}
            <button type="button" disabled={running} onClick={() => void run()} style={{ ...smallButtonStyle(t), color: t.accent, opacity: running ? .65 : 1 }}>
              {running ? <Loader2 size={11} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Sparkles size={11} />}
              {running ? 'Running…' : 'Apply'}
            </button>
          </div>
          {addingFilter ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(150px, 1fr) auto auto', gap: 7, alignItems: 'end', padding: 8, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.cellBg }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 10, fontWeight: 750, color: t.textSecondary }}>
                Result column
                <select
                  aria-label="Result column for new DQL input"
                  value={filterColumn}
                  onChange={(event) => {
                    const column = event.target.value;
                    const candidate = filterCandidates.find((item) => item.column === column);
                    setFilterColumn(column);
                    setFilterValue(candidate?.values[0] == null ? '' : String(candidate.values[0]));
                  }}
                  style={askParameterControlStyle(t)}
                >
                  {filterCandidates.map((candidate) => <option key={candidate.column} value={candidate.column}>{candidate.column.split('_').join(' ')}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 10, fontWeight: 750, color: t.textSecondary }}>
                Default value
                <input
                  aria-label="Default value for new DQL input"
                  value={filterValue}
                  list={`ask-filter-${filterColumn}`}
                  onChange={(event) => setFilterValue(event.target.value)}
                  style={askParameterControlStyle(t)}
                />
                <datalist id={`ask-filter-${filterColumn}`}>
                  {(filterCandidates.find((candidate) => candidate.column === filterColumn)?.values ?? []).map((value) => (
                    <option key={`${typeof value}:${String(value)}`} value={String(value)} />
                  ))}
                </datalist>
              </label>
              <button type="button" onClick={() => { void addResultFilter(); }} style={{ ...smallButtonStyle(t), color: t.accent }}>Add input</button>
              <button type="button" onClick={() => setAddingFilter(false)} style={smallButtonStyle(t)}>Cancel</button>
            </div>
          ) : null}
          {parameters.length > 0 ? (
            <BlockParameterControls parameters={parameters} values={values} onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))} t={t} />
          ) : null}
          {filterCandidates.length > 0 ? (
            <div style={{ fontSize: 9.5, color: t.textMuted }}>
              Extra filters are available only for semantic dimensions in this result. They stay transient until you explicitly save a block.
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <div style={{ fontSize: 10.5, color: t.error }}>{error}</div> : null}
      <ResultView
        result={result}
        themeMode={themeMode}
        t={t}
        chartConfig={chartConfig}
        embedded={embedded}
        tabLabels={embedded ? { table: 'Results', chart: 'Visualization' } : undefined}
        contentMaxHeight={expanded ? 'calc(100vh - 172px)' : undefined}
        tableMaxHeight={expanded ? 'calc(100vh - 250px)' : undefined}
      />
    </div>
  );
}

export function resolvedParameterValues(payload: Record<string, unknown>): Record<string, unknown> {
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

function formatAppliedParameterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
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
  insertDqlActionLabel,
  sourceRunId,
  sourceQuestion,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
  onNextAction,
}: {
  artifact: AgentRunArtifact;
  t: Theme;
  themeMode: ThemeMode;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  insertDqlActionLabel?: string;
  sourceRunId?: string;
  sourceQuestion?: string;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
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
              <button
                type="button"
                onClick={() => onInsertDql({
                  sql,
                  dqlArtifact,
                  result: resultData,
                  chartConfig: resultData ? extractChartConfig(payload, resultData) : undefined,
                  title: name,
                  sourceRunId,
                  question: sourceQuestion,
                })}
                style={smallButtonStyle(t)}
              >
                {insertDqlActionLabel ?? 'Insert as DQL cell'}
              </button>
            ) : sql && onInsertSql ? (
              <button
                type="button"
                onClick={() => onInsertSql(sql, name, {
                  question: sourceQuestion,
                  sourceRunId,
                })}
                style={smallButtonStyle(t)}
              >
                Insert SQL preview
              </button>
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
              sourceRunId,
              question: sourceQuestion,
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
          <button
            type="button"
            onClick={() => onInsertSql(sql, name, {
              question: sourceQuestion,
              sourceRunId,
            })}
            style={smallButtonStyle(t)}
          >
            Insert SQL preview
          </button>
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
  if (route === 'modeling_draft') return 'modeling';
  if (route === 'skill_draft') return 'skill';
  if (route === 'app_build') return 'app';
  if (route === 'certified_answer' || route === 'semantic_answer' || route === 'generated_answer') return 'ask';
  return undefined;
}

function nextPromptFor(run: AgentRun, route?: AgentRunRoute): string {
  if (route === 'sql_cell') return `Create a SQL cell for: ${run.question}`;
  if (route === 'dql_block_draft') return `Create a DQL block draft for: ${run.question}`;
  if (route === 'modeling_draft') return `Revise the modeling proposal for: ${run.question}`;
  if (route === 'skill_draft') return `Revise the Skill proposal for: ${run.question}`;
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
  const metrics = Array.isArray(raw.metrics)
    ? raw.metrics.filter((value): value is string => typeof value === 'string' && columns.includes(value))
    : [];
  const config: CellChartConfig = {
    ...(chart ? { chart } : {}),
    ...(chart ? { decisionSource: storedDecisionSource ?? 'agent' as const } : {}),
    ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale } : {}),
    ...(pick('x') ? { x: pick('x') } : {}),
    ...(pick('y') ? { y: pick('y') } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
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
    && (resolved.metrics?.length ?? 0) <= 1
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
      const h = raw as {
        hintId?: unknown;
        title?: unknown;
        guidance?: unknown;
        scopeReason?: unknown;
        graphReason?: unknown;
        matchSignals?: {
          lexicalScore?: unknown;
          graphScore?: unknown;
          lexicalRank?: unknown;
        };
        lesson?: {
          rule?: unknown;
          category?: unknown;
          avoid?: unknown;
          expectedOutcome?: unknown;
        };
      };
      const label = typeof h.title === 'string' ? h.title.trim() : '';
      if (!label || seen.has(`h:${label}`)) continue;
      seen.add(`h:${label}`);
      const rule = typeof h.lesson?.rule === 'string'
        ? h.lesson.rule
        : typeof h.guidance === 'string'
          ? h.guidance
          : undefined;
      const matched = [
        typeof h.scopeReason === 'string' ? h.scopeReason : undefined,
        typeof h.graphReason === 'string' ? h.graphReason : undefined,
      ].filter(Boolean).join('; ');
      const lexicalScore = typeof h.matchSignals?.lexicalScore === 'number'
        ? h.matchSignals.lexicalScore
        : undefined;
      const graphScore = typeof h.matchSignals?.graphScore === 'number'
        ? h.matchSignals.graphScore
        : undefined;
      const scoreEvidence = lexicalScore !== undefined || graphScore !== undefined
        ? `Signals: lexical ${(lexicalScore ?? 0).toFixed(2)}, graph ${(graphScore ?? 0).toFixed(2)}`
        : undefined;
      out.push({
        kind: 'hint',
        id: typeof h.hintId === 'string' ? h.hintId : undefined,
        label,
        detail: [
          rule,
          matched ? `Matched: ${matched}` : undefined,
          scoreEvidence,
        ].filter(Boolean).join(' · ') || undefined,
      });
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
              <span style={appliedTagStyle(t, it.kind)}>{it.kind === 'hint' ? 'governed lesson' : 'memory'}</span>
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
    const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
      ? payload.result as Record<string, unknown>
      : undefined;
    const dqlArtifact = normalizeDqlArtifactReference(payload.dqlArtifact);
    const sql = payload.proposedSql
      ?? payload.sql
      ?? payload.sqlPreview
      ?? result?.sql
      ?? researchRun?.generatedSql
      ?? researchRun?.reviewedSql
      ?? dqlArtifact?.compiledSql;
    if (typeof sql === 'string' && sql.trim()) return sql;
  }
  return undefined;
}

/**
 * The certified block backing this run, if any.
 *
 * A certified block added to an App should become a real block tile rather than
 * a review-required pin: it keeps its block identity, re-runs with the
 * dashboard's filters, and survives publication (which strips pins).
 */
function certifiedBlockNameFromRun(run: AgentRun): string | undefined {
  if (run.trustState !== 'certified') return undefined;
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const name = payload.blockName ?? payload.blockId ?? normalizeDqlArtifactReference(payload.dqlArtifact)?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return undefined;
}

/** The chart configuration the run produced, so a pinned tile is not forced to `table`. */
function runChartConfig(run: AgentRun): CellChartConfig | undefined {
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const result = extractResult(payload);
    if (!result) continue;
    const config = extractChartConfig(payload, result);
    if (config) return config;
  }
  return undefined;
}

/** The executed rows, so a pinned tile renders data instead of an empty summary. */
function runResult(run: AgentRun): QueryResult | undefined {
  for (const artifact of run.artifacts) {
    const result = extractResult(payloadOf(artifact));
    if (result) return result;
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
  const canCommitBlockDraft = run.route === 'dql_block_draft'
    && run.status !== 'blocked'
    && run.status !== 'needs_clarification';
  if (run.route === 'certified_answer' || (!isAgentRunPinnable(run) && !canCommitBlockDraft)) return undefined;
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
        sourceRunId: run.id,
        question: run.question,
        executionTarget: run.executionTarget,
      };
    }
    if (mixedSourcePlan) {
      return {
        sql,
        dqlArtifact,
        title: dqlArtifact?.name ?? artifact.title ?? run.question,
        mixedSourcePlan,
        sourceRunId: run.id,
        question: run.question,
        executionTarget: run.executionTarget,
      };
    }
  }
  return {
    sql,
    dqlArtifact,
    title: dqlArtifact?.name ?? run.question,
    sourceRunId: run.id,
    question: run.question,
    executionTarget: run.executionTarget,
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
  return { ...controlStyle(t, { variant: 'secondary', size: 'md', pill: true }), fontWeight: 550 };
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
  // Keeps its taller `lg` footprint but shares the radius, type scale and
  // disabled treatment with every other control.
  return {
    ...controlStyle(t, { variant: enabled ? 'primary' : 'secondary', size: 'lg' }),
    ...(enabled ? {} : { color: t.textMuted }),
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

function askParameterControlStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 5,
    color: t.textPrimary,
    padding: '5px 7px',
    fontSize: 11,
    fontFamily: t.font,
  };
}

function smallButtonStyle(t: Theme): React.CSSProperties {
  return controlStyle(t, { variant: 'secondary', size: 'sm' });
}

/**
 * What a failure of each ORIGIN means, and what the user can do about it.
 *
 * Before this, every failure rendered as one grey paragraph, so a warehouse
 * rejection, a governance refusal and a DQL block-compile problem were
 * indistinguishable — and the most common line, "The selected route could not
 * compile its immutable analytical plan", is the DEFAULT for anything
 * unclassified. The origin is decided at the throw site (see
 * `analytical-error.ts`), so the card can finally say which of them happened.
 */
const ASK_FAILURE_PRESENTATION: Record<string, { title: string; hint: string }> = {
  warehouse: {
    title: 'The warehouse rejected the query',
    hint: 'The SQL reached your warehouse and it refused. The message below is the driver\u2019s own.',
  },
  dql_compilation: {
    title: 'DQL could not build a reusable block',
    hint: 'The query itself is fine \u2014 only saving this answer as a block is affected.',
  },
  governance_gate: {
    title: 'DQL stopped this before running it',
    hint: 'A governance check refused the query, so it never reached the warehouse.',
  },
  retrieval_gap: {
    title: 'DQL could not confirm this data exists',
    hint: 'The relation was not in the inspected metadata. Refreshing the connection scope usually resolves it.',
  },
  ambiguity: {
    title: 'One detail is missing',
    hint: 'Answer the question above and DQL will continue.',
  },
  provider: {
    title: 'The AI provider failed',
    hint: 'Nothing was run. Retry, or check the provider in Settings.',
  },
  orchestration_budget: {
    title: 'Ask could not freeze one executable plan',
    hint: 'Nothing was run. Ask stopped its own planning loop before another provider call; narrow the metric or dimension and retry.',
  },
  host: {
    title: 'DQL hit an internal error',
    hint: 'This is a defect in DQL. The detail below is what to report.',
  },
  modeling_gap: {
    title: 'The governed model does not cover this question',
    hint: 'No query ran. Add or review the missing metric, dimension, relationship, or allocation rule.',
  },
  proof_integrity: {
    title: 'Not executed: exact semantic proof was not established',
    hint: 'DQL could not establish the exact metric, requested grain, join keys, and fanout proof. Warehouse success cannot create that authority.',
  },
  identity_integrity: {
    title: 'DQL found an internal identity or target-binding defect',
    hint: 'No query ran. This is an orchestration integrity defect, not missing business modeling.',
  },
  policy: {
    title: 'Policy or permissions blocked this query',
    hint: 'No AI repair was attempted. Use only the server-provided access or connection actions.',
  },
  result_contract: {
    title: 'The warehouse result did not match the frozen plan',
    hint: 'The query ran, but DQL rejected the returned columns, types, grain, or row bound.',
  },
  compile: {
    title: 'DQL could not compile the frozen plan',
    hint: 'The query did not reach the warehouse. Review the exact plan binding and compiler diagnostic.',
  },
  timeout: {
    title: 'This run reached its hard deadline',
    hint: 'DQL stopped the run at its request-owned deadline and did not accept a later result.',
  },
  cancel: {
    title: 'This run was cancelled',
    hint: 'Cancellation is terminal and no later provider or warehouse result was accepted.',
  },
  unknown: {
    title: 'The query could not be completed',
    hint: 'Inspect the details or use the bounded repair when it is available.',
  },
};

/** The failure origin recorded on the run. Missing attribution stays unknown. */
function askFailureOrigin(run: AgentRun): string {
  for (const artifact of run.artifacts ?? []) {
    const payload = payloadOf(artifact) as {
      warehouseFailure?: { origin?: unknown };
      providerFailure?: { code?: unknown };
      refusalCode?: unknown;
      analyticalFailure?: { code?: unknown; phase?: unknown };
      aggregationSafetyProof?: { status?: unknown };
    } | undefined;
    const origin = payload?.warehouseFailure?.origin;
    const code = typeof payload?.analyticalFailure?.code === 'string' ? payload.analyticalFailure.code : '';
    if (payload?.refusalCode === 'modeling_gap') return 'modeling_gap';
    if (payload?.aggregationSafetyProof?.status === 'blocked') return 'proof_integrity';
    if (['IDENTIFIER_SCOPE_INVALID', 'EXECUTION_TARGET_MISMATCH', 'SEMANTIC_TARGET_BINDING_MISSING', 'SEMANTIC_SOURCE_DRIFT'].includes(code)) return 'identity_integrity';
    if (['POLICY_DENIED', 'PERMISSION_DENIED'].includes(code)) return 'policy';
    if (code === 'RESULT_CONTRACT_MISMATCH') return 'result_contract';
    if (['TIMEOUT', 'SEMANTIC_COMPILATION_TIMEOUT'].includes(code)) return 'timeout';
    if (code === 'EXECUTION_CANCELLED') return 'cancel';
    if (['COMPILATION_FAILED', 'DIALECT_ERROR', 'SEMANTIC_ADAPTER_NOT_READY'].includes(code)) return 'compile';
    if (typeof origin === 'string' && origin in ASK_FAILURE_PRESENTATION) return origin;
    if (payload?.providerFailure?.code === 'orchestration_budget_exhausted'
      || payload?.providerFailure?.code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') return 'orchestration_budget';
    if (payload?.providerFailure || payload?.refusalCode === 'provider_error') return 'provider';
  }
  if (run.diagnosticReceipt?.failure?.code === 'orchestration_budget_exhausted') return 'orchestration_budget';
  if (run.diagnosticReceipt?.failure?.code === 'AI_PROVIDER_FAILURE') return 'provider';
  return 'unknown';
}

export function askRunCaptureWarning(run: AgentRun): string | undefined {
  for (const artifact of run.artifacts ?? []) {
    const payload = payloadOf(artifact);
    const warnings = Array.isArray(payload.validationWarnings)
      ? payload.validationWarnings.filter((item): item is string => typeof item === 'string')
      : [];
    const warning = warnings.find((item) => /captur|reusable DQL block|save as (?:a )?block/i.test(item));
    if (warning) return warning;
  }
  return undefined;
}

export function askRunAllowsExecutionRepair(run: AgentRun): boolean {
  const capability = run.repairCapability;
  return capability?.version === 1
    && capability.automatic.eligible === true
    && capability.automatic.action === 'repair_embedded_sql'
    && capability.automatic.correctionCode === 'SQL_EXECUTION_REPAIR'
    && capability.automatic.attemptsRemaining > 0
    && capability.routeLocked === true
    && capability.targetLocked === true
    && capability.sourceImmutable === true;
}

/**
 * A failure the user can act on: what happened, in whose words, and what to try.
 */
function AskFailureCard({
  run,
  detail,
  threadId,
  onRepaired,
  t,
}: {
  run: AgentRun;
  detail: string;
  threadId?: string;
  onRepaired: (run: AgentRun) => void;
  t: Theme;
}): JSX.Element {
  const origin = askFailureOrigin(run);
  const presentation = ASK_FAILURE_PRESENTATION[origin] ?? ASK_FAILURE_PRESENTATION.unknown;
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const canRepair = askRunAllowsExecutionRepair(run);
  const repair = async () => {
    if (repairing) return;
    setRepairing(true);
    setRepairError(null);
    try {
      const response = await api.repairAgentRunExecution(run.id, threadId);
      onRepaired(response.run);
    } catch (cause) {
      setRepairError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRepairing(false);
    }
  };
  return (
    <div
      data-followup="answer"
      style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '11px 13px', borderRadius: 9,
        border: `1px solid ${t.error}33`, background: `${t.error}0d`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <ShieldAlert size={13} color={t.error} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: t.textPrimary }}>{presentation.title}</span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: t.textSecondary, wordBreak: 'break-word' }}>
        {cleanPresentationText(detail)}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: t.textMuted }}>{presentation.hint}</div>
      {canRepair ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <button
            type="button"
            className="dql-hover"
            disabled={repairing}
            onClick={() => void repair()}
            style={{ ...smallButtonStyle(t), opacity: repairing ? 0.7 : 1 }}
          >
            <Wrench size={12} /> {repairing ? 'Fixing and retrying…' : 'Fix and retry'}
          </button>
          <span style={{ fontSize: 10.5, color: t.textMuted }}>One bounded repair attempt on the same data target.</span>
        </div>
      ) : null}
      {repairError ? (
        <div role="alert" style={{ fontSize: 11.5, lineHeight: 1.45, color: t.error }}>{cleanPresentationText(repairError)}</div>
      ) : null}
    </div>
  );
}

/**
 * The most specific failure text a run carries.
 *
 * Preference order matters: `warehouseFailure.redactedMessage` is the producer's
 * own words, `run.summary` is the safe headline plus its diagnostic, and
 * `diagnosticReceipt.failure.message` is the bare per-code headline — the least
 * informative of the three and identical across every unclassified failure.
 */
function askFailureDetail(run: AgentRun): string | undefined {
  for (const artifact of run.artifacts ?? []) {
    const payload = payloadOf(artifact) as {
      warehouseFailure?: { redactedMessage?: unknown; diagnostic?: unknown };
      executionError?: unknown;
    } | undefined;
    const failure = payload?.warehouseFailure;
    const specific = [failure?.redactedMessage, failure?.diagnostic, payload?.executionError]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (specific) return specific;
  }
  const bindingDetail = retainedPlanBindingFailure(run);
  if (bindingDetail) return bindingDetail;
  return run.summary || run.diagnosticReceipt?.failure?.message;
}

/** Defensive compatibility for persisted runs produced before router
 * reconciliation. New runs should arrive as clarification/modeling-gap
 * outcomes, but a retained RAP still contains enough safe business context to
 * avoid the legacy one-line “Agent run is blocked” presentation. */
function retainedPlanBindingFailure(run: AgentRun): string | undefined {
  const plans = [
    recordOf(recordOf(run.diagnosticReceipt)?.resolvedAnalyticalPlan),
    ...(run.artifacts ?? []).flatMap((artifact) => {
      const payload = payloadOf(artifact);
      return [
        recordOf(payload.resolvedAnalyticalPlan),
        recordOf(recordOf(payload.diagnosticReceipt)?.resolvedAnalyticalPlan),
      ];
    }),
  ].filter((plan): plan is Record<string, unknown> => Boolean(plan));
  for (const plan of plans) {
    const query = recordOf(plan.query);
    const bindings = [
      ...recordList(query?.measures).map((binding) => ({ kind: 'metric', binding })),
      ...recordList(query?.dimensions).map((binding) => ({ kind: 'dimension', binding })),
      ...recordList(query?.filters).flatMap((filter) => {
        const binding = recordOf(filter.binding);
        return binding ? [{ kind: 'filter', binding }] : [];
      }),
    ];
    const failed = bindings.find(({ binding }) => binding.status === 'ambiguous' || binding.status === 'unresolved');
    if (!failed) continue;
    const requested = displayValue(failed.binding.requested) || `requested ${failed.kind}`;
    const choices = Array.isArray(failed.binding.candidateIds)
      ? failed.binding.candidateIds.filter((value): value is string => typeof value === 'string').map(qualifiedBindingLabel)
      : [];
    if (failed.binding.status === 'ambiguous' && choices.length > 1) {
      return `I found more than one governed ${failed.kind} for “${requested}”: ${choices.join(' or ')}. Choose one before I run the query.`;
    }
    return `I couldn’t identify one governed ${failed.kind} for “${requested}”. Review that model binding before retrying.`;
  }
  return undefined;
}

function qualifiedBindingLabel(id: string): string {
  const local = id.split(/[:./]/).filter(Boolean).at(-1) ?? id;
  return local.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
