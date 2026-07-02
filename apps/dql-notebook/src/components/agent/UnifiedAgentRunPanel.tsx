import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Blocks,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Code2,
  FileSearch,
  GitBranch,
  LayoutDashboard,
  Lightbulb,
  ListTree,
  Loader2,
  Plus,
  Route,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import {
  api,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunAudience,
  type AgentRunEvent,
  type AgentRunRequestedMode,
  type AgentRunRoute,
  type AgentRunSelectedObject,
  type AgentRunStep,
  type AgentRunStepStatus,
  type AppBuildProposal,
} from '../../api/client';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { AppBuildProposalPanel, defaultProposalSelection } from '../apps/AppBuildProposalPanel';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import type { QueryResult, AppSummary } from '../../store/types';

export type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'run'; id: string; run: AgentRun };

/** An empty-state suggestion chip: the label is shown, the prompt is submitted. */
export type ExamplePrompt = { label: string; prompt: string };

interface UnifiedAgentRunPanelProps {
  themeMode: ThemeMode;
  title?: string;
  scopeHint?: string;
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
  /** 'stakeholder' (consumption-only) hides authoring modes + adds the certify handoff. */
  audience?: AgentRunAudience;
  autoRun?: { text: string; mode?: AgentRunRequestedMode; nonce: number };
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  /** Navigate into an app/dashboard (used by the "Added to app" success link). */
  onOpenApp?: (appId: string, dashboardId?: string) => void;
  /** Reports whether a run is in flight, so a host can avoid unmounting mid-run. */
  onRunningChange?: (running: boolean) => void;
}

const ROUTE_LABEL: Record<AgentRunRoute, string> = {
  certified_answer: 'Certified answer',
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
  examplePrompts,
  emptyHint,
  notebookPath,
  selectedObject,
  workspaceContext,
  initialMode = 'auto',
  initialInput = '',
  initialItems,
  onItemsChange,
  audience = 'analyst',
  autoRun,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
  onRunningChange,
}: UnifiedAgentRunPanelProps): JSX.Element {
  const t = themes[themeMode];
  // One clean composer everywhere: an auto-routed box + a "Dig deeper" toggle — no
  // mode chips. Capability still varies server-side by `audience` (analyst keeps the
  // authoring routes so SQL/blocks generate; stakeholder is consumption-only), but
  // the chrome is uniform. A next-action can pre-route the *next* question (e.g.
  // "Draft this as a block") via this one-shot ref: consumed once at submit and cleared
  // the moment the user edits the prefilled prompt. The default is always auto.
  const pendingModeRef = useRef<AgentRunRequestedMode | undefined>(undefined);
  const [deepResearch, setDeepResearch] = useState(false);
  const [certifying, setCertifying] = useState<Record<string, 'pending' | 'sent' | 'error'>>({});
  const [input, setInput] = useState(initialInput);
  const [items, setItems] = useState<ThreadItem[]>(initialItems ?? []);
  const [runningEvents, setRunningEvents] = useState<AgentRunEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInitialInputRef = useRef(initialInput);
  const lastAutoRunNonceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!initialInput || running) return;
    if (initialInput === lastInitialInputRef.current) return;
    lastInitialInputRef.current = initialInput;
    setInput(initialInput);
  }, [initialInput, running]);

  const history = useMemo(
    (): Array<{ role: 'user' | 'assistant'; text: string }> => items.map((item) => (
      item.kind === 'user'
        ? { role: 'user' as const, text: item.text }
        : { role: 'assistant' as const, text: item.run.summary }
    )).slice(-12),
    [items],
  );

  // Report thread changes to a host (for conversation persistence) without
  // re-subscribing when the callback identity changes each render.
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  useEffect(() => {
    onItemsChangeRef.current?.(items);
  }, [items]);

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
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const runInput = {
        question: text,
        requestedMode: activeMode,
        audience,
        selectedObject: selectedObject ?? (notebookPath ? { kind: 'notebook' as const, path: notebookPath } : undefined),
        workspaceContext: {
          ...(workspaceContext ?? {}),
          ...(notebookPath ? { notebookPath } : {}),
        },
        history,
      };
      const run = await api.createAgentRunStream(runInput, (message) => {
        if (message.kind === 'event') {
          setRunningEvents((current) => [...current, message.event].slice(-8));
        } else {
          setRunningEvents(message.run.events.slice(-8));
        }
      }, controller.signal);
      setItems((current) => [...current, { kind: 'run', id: run.id, run }]);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
        setInput(text);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  // Submit the box; only clear the one-shot deep-research toggle when a run will
  // actually start (mirror the send button's guard so a no-op Enter can't lose it).
  const handleSubmit = () => {
    const willRun = Boolean(input.trim()) && !running;
    void submit(undefined, deepResearch ? 'research' : undefined);
    if (willRun && deepResearch) setDeepResearch(false);
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
  }, []);

  const requestCertification = async (run: AgentRun) => {
    if (certifying[run.id] === 'pending' || certifying[run.id] === 'sent') return;
    setCertifying((current) => ({ ...current, [run.id]: 'pending' }));
    try {
      const sql = answerSqlFromRun(run);
      const result = await api.requestCertification({
        question: run.question,
        generatedSql: sql,
        notebookPath: typeof workspaceContext?.notebookPath === 'string' ? workspaceContext.notebookPath : notebookPath,
        context: { agentRunId: run.id, route: run.route, selectedObject: run.selectedObject },
      });
      setCertifying((current) => ({ ...current, [run.id]: result.ok ? 'sent' : 'error' }));
    } catch {
      setCertifying((current) => ({ ...current, [run.id]: 'error' }));
    }
  };

  // Pre-selected app target when the panel is opened inside an app (the global
  // rail); on the Ask home there is none and the picker lists/creates apps.
  const appContext = {
    appId: typeof workspaceContext?.appId === 'string' ? workspaceContext.appId : undefined,
    dashboardId: typeof workspaceContext?.dashboardId === 'string' ? workspaceContext.dashboardId : undefined,
  };

  const handleNextAction = (run: AgentRun, action: AgentRun['nextActions'][number]) => {
    if (action.id === 'request-certification') {
      void requestCertification(run);
      return;
    }
    if (action.id === 'research-deeper') {
      void submit(run.question, 'research');
      return;
    }
    pendingModeRef.current = routeToMode(action.route);
    setInput(nextPromptFor(run, action.route));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: 1, minWidth: 0, width: '100%', background: t.cellBg }}>
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
        ) : (
          <RunCard
            key={item.id}
            run={item.run}
            t={t}
            themeMode={themeMode}
            certifyState={certifying[item.run.id]}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onInsertSql={onInsertSql}
            onOpenBlock={onOpenBlock}
            onOpenResearch={onOpenResearch}
            onNextAction={(action) => handleNextAction(item.run, action)}
          />
        ))}

        {running && <RunProgress events={runningEvents} t={t} />}
      </div>

      {error ? <div style={{ margin: '0 16px 8px', color: t.error, fontSize: 12 }}>{error}</div> : null}

      <div style={{ padding: '10px 16px 14px', borderTop: `1px solid ${t.headerBorder}`, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <button
            type="button"
            className="dql-hover"
            aria-pressed={deepResearch}
            onClick={() => setDeepResearch((v) => !v)}
            style={digDeeperStyle(t, deepResearch)}
            title="Run a slower, multi-step investigation instead of a quick answer."
          >
            <FileSearch size={13} />
            <span>Dig deeper</span>
          </button>
          <span style={{ fontSize: 11, color: t.textMuted }}>
            {deepResearch ? 'Your next question runs a deep investigation.' : 'Auto-routes to the best answer for your question.'}
          </span>
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
        </div>
      </div>
    </div>
  );
}

const DEFAULT_EMPTY_HINT = 'Ask a question or dig deeper with research — every answer is grounded in your certified metrics and dbt lineage.';
const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  { label: 'What is total revenue?', prompt: 'What is total revenue?' },
  { label: 'Why is revenue down by region?', prompt: 'Why is revenue down by region?' },
  { label: 'Top customers by revenue this quarter', prompt: 'Top customers by revenue this quarter' },
  { label: 'How have orders trended over the last 6 months?', prompt: 'How have orders trended over the last 6 months?' },
];

function routeActionLabel(route?: AgentRunRoute): string {
  switch (route) {
    case 'research': return 'Researching across governed data';
    case 'certified_answer':
    case 'generated_answer': return 'Finding the answer';
    case 'app_build': return 'Assembling the app';
    case 'sql_cell': return 'Writing the query';
    case 'dql_block_draft': return 'Drafting the block';
    default: return 'Working';
  }
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

/**
 * Live agent activity — boxless. A spinning halo + phase icon, a shimmering
 * action headline, a Plan→Work→Verify tracker, and the latest step line.
 * Expresses *what the agent is doing* rather than a generic progress bar.
 */
function RunProgress({ events, t }: { events: AgentRunEvent[]; t: Theme }) {
  const action = currentActionLabel(events);
  const stage = deriveStage(events);
  const Icon = phaseIconFor(events);
  const latest = events.length ? events[events.length - 1].message : '';
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

        {latest ? (
          <span key={latest} style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.4, animation: 'dql-step-in 0.3s ease-out' }}>{latest}</span>
        ) : null}
      </div>
    </div>
  );
}

function RunCard({
  run,
  t,
  themeMode,
  certifyState,
  appContext,
  onOpenApp,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  certifyState?: 'pending' | 'sent' | 'error';
  appContext?: { appId?: string; dashboardId?: string };
  onOpenApp?: (appId: string, dashboardId?: string) => void;
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onNextAction: (action: AgentRun['nextActions'][number]) => void;
}) {
  const steps = run.steps ?? [];
  const multiStep = steps.length > 1;
  const isLlmPlan = run.plan?.source === 'llm';
  const evidence = evidenceFromRun(run);
  const trustNote = trustExplainer(run);
  // A result worth saving: a real answer or research artifact (not blocked/clarify).
  const pinnable = run.status !== 'blocked' && run.status !== 'needs_clarification'
    && (Boolean(run.answer) || run.artifacts.some((a) => a.kind === 'answer' || a.kind === 'research_run'));
  // Offer a one-click deepening on quick answers (unless the agent already routed deep).
  const isAnswer = run.route === 'certified_answer' || run.route === 'generated_answer';
  const hasResearchAction = run.nextActions.some((a) => a.route === 'research');
  const showResearchDeeper = isAnswer && pinnable && !hasResearchAction;
  return (
    <div style={runCardStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusIcon run={run} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 850, color: t.textPrimary }}>{ROUTE_LABEL[run.route]}</div>
          <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 1 }}>{run.stopReason.split('_').join(' ')}</div>
        </div>
        <TrustBadge run={run} t={t} />
      </div>

      {trustNote ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, color: t.textMuted, lineHeight: 1.4 }}>
          {run.trustState === 'certified' ? <ShieldCheck size={12} color={t.success} style={{ flex: '0 0 auto', marginTop: 1 }} /> : run.trustState === 'grounded' ? <ShieldCheck size={12} color={t.accent} style={{ flex: '0 0 auto', marginTop: 1 }} /> : <ShieldAlert size={12} color={t.warning} style={{ flex: '0 0 auto', marginTop: 1 }} />}
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

      {run.summary && !(run.answer && sameText(run.summary, cleanAnswerText(run.answer))) ? (
        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: t.textSecondary }}>{run.summary}</div>
      ) : null}
      {run.answer ? <div style={answerBoxStyle(t)}>{cleanAnswerText(run.answer)}</div> : null}

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
        <div style={{ display: 'grid', gap: 8 }}>
          {run.artifacts.map((artifact) => (
            <ArtifactView
              key={artifact.id}
              artifact={artifact}
              t={t}
              themeMode={themeMode}
              onInsertSql={onInsertSql}
              onOpenBlock={onOpenBlock}
              onOpenResearch={onOpenResearch}
              onOpenApp={onOpenApp}
            />
          ))}
        </div>
      ) : null}

      {multiStep ? (
        <StepTrace steps={steps} t={t} />
      ) : (
        <VerificationChecks evaluations={run.evaluations} t={t} />
      )}

      {(pinnable || showResearchDeeper || run.nextActions.length > 0) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {pinnable ? <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} /> : null}
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
          {run.nextActions.filter((a) => a.id !== 'pin-to-app' && a.id !== 'research-deeper' && a.id !== 'confirm-app-build').map((action) => {
            const isCertify = action.id === 'request-certification';
            const label = isCertify && certifyState === 'sent'
              ? 'Sent to analyst'
              : isCertify && certifyState === 'pending'
                ? 'Sending…'
                : isCertify && certifyState === 'error'
                  ? 'Retry request'
                  : action.label;
            return (
              <button
                key={action.id}
                type="button"
                className="dql-hover"
                onClick={() => onNextAction(action)}
                disabled={isCertify && (certifyState === 'pending' || certifyState === 'sent')}
                style={isCertify ? certifyButtonStyle(t, certifyState) : smallButtonStyle(t)}
              >
                {isCertify && certifyState === 'sent' ? <CheckCircle2 size={11} /> : isCertify ? <ShieldCheck size={11} /> : null}
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
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
    const result = await api.createAiPin(appId, {
      dashboardId,
      title: defaultAppName(run.question),
      answer: run.answer ?? run.summary,
      question: run.question,
      sql: answerSqlFromRun(run),
      certification: run.trustState === 'certified' ? 'certified' : 'ai_generated',
      reviewStatus: run.trustState === 'certified' ? 'certified' : 'needs_review',
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
function trustExplainer(run: AgentRun): string | null {
  if (run.trustState === 'certified') return 'Certified — answered from a governed metric you can trust.';
  if (run.trustState === 'grounded') return 'Verified against your data — grounded and executed cleanly. Review to certify as a governed metric.';
  if (run.trustState === 'review_required') return 'Review-required — generated from governed data; not a certified metric yet.';
  if (run.trustState === 'blocked') return null;
  return null;
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
    const result = await api.commitAppAiBuild(sessionId, { selectedTileIds: Array.from(selected) });
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
          {artifact.title}
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

function ArtifactView({
  artifact,
  t,
  themeMode,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
}: {
  artifact: AgentRunArtifact;
  t: Theme;
  themeMode: ThemeMode;
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onOpenApp?: (appId: string, dashboardId?: string) => void;
}) {
  const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload as Record<string, unknown> : {};
  // Two-phase app build: the proposal card owns the confirm flow (toggles + Create).
  if (artifact.kind === 'app_proposal') {
    return <AppProposalArtifact artifact={artifact} payload={payload} t={t} onOpenApp={onOpenApp} />;
  }
  const resultData = extractResult(payload);
  const sql = typeof payload.sql === 'string'
    ? payload.sql
    : typeof payload.sqlPreview === 'string'
      ? payload.sqlPreview
      : typeof payload.proposedSql === 'string'
        ? payload.proposedSql
        : undefined;
  const name = typeof payload.name === 'string' ? payload.name : artifact.title;
  const path = typeof payload.path === 'string' ? payload.path : artifact.ref;
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

  return (
    <div style={artifactStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ArtifactIcon kind={artifact.kind} />
        <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {artifact.title}
        </div>
      </div>
      {keyFindings.length > 0 ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary }}>Key findings</div>
          {keyFindings.slice(0, 4).map((finding, index) => (
            <div key={index} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4, display: 'flex', gap: 6 }}>
              <span style={{ color: t.accent }}>•</span><span>{finding}</span>
            </div>
          ))}
        </div>
      ) : steps.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          {steps.slice(0, 4).map((step, index) => (
            <div key={index} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.35 }}>
              {index + 1}. {String(step.thought ?? step.expectation ?? 'Research step')}
            </div>
          ))}
        </div>
      ) : null}
      {recommendation ? (
        <div style={{ fontSize: 11.5, color: t.textPrimary, lineHeight: 1.4, display: 'flex', gap: 6 }}>
          <span style={{ color: t.accent }}>→</span><span>{recommendation}</span>
        </div>
      ) : null}
      {resultData ? <ResultView result={resultData} themeMode={themeMode} t={t} /> : null}
      {sql ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: t.textSecondary, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Code2 size={12} /><span>View query</span>
          </summary>
          <pre style={{ ...codeStyle(t), marginTop: 6 }}>{sql}</pre>
        </details>
      ) : null}
      {gaps.length > 0 ? (
        <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4 }}>
          Gaps: {gaps.slice(0, 3).join(', ')}
        </div>
      ) : null}
      {generatedPaths.length > 0 ? (
        <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4 }}>
          Files: {generatedPaths.slice(0, 3).join(', ')}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {researchRunId && onOpenResearch ? (
          <button type="button" onClick={() => onOpenResearch(researchRunId, notebookPath)} style={smallButtonStyle(t)}>Open research</button>
        ) : null}
        {sql && onInsertSql ? (
          <button type="button" onClick={() => onInsertSql(sql, name)} style={smallButtonStyle(t)}>Insert SQL</button>
        ) : null}
        {path && artifact.kind === 'dql_block_draft' && onOpenBlock ? (
          <button type="button" onClick={() => onOpenBlock(path, name)} style={smallButtonStyle(t)}>Open block</button>
        ) : null}
      </div>
    </div>
  );
}

function StatusIcon({ run }: { run: AgentRun }) {
  if (run.trustState === 'certified') return <ShieldCheck size={16} color="#16a34a" />;
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
    : run.trustState === 'grounded'
      ? t.accent
      : run.trustState === 'blocked'
        ? t.error
        : run.trustState === 'not_applicable'
          ? t.textMuted
          : t.warning;
  const label = run.trustState === 'grounded' ? 'verified' : run.trustState.split('_').join(' ');
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
    <div style={{ display: 'grid', gap: 6 }}>
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
    <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: t.textSecondary }}>
      <span style={{ color, lineHeight: '16px', flex: '0 0 auto', fontWeight: 800 }}>
        {evaluation.passed ? 'OK' : evaluation.severity === 'blocking' ? 'Stop' : 'Review'}
      </span>
      <span style={{ lineHeight: 1.4 }}>
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
  if (route === 'certified_answer' || route === 'generated_answer') return 'ask';
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
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^_(.+?)_$/gm, '$1')
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
    const rows = Array.isArray(record.rows) ? record.rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object')) : [];
    if (rows.length === 0) continue;
    const columns = Array.isArray(record.columns) && record.columns.length > 0
      ? record.columns.map((c) => (typeof c === 'string' ? c : (c as { name?: string })?.name ?? String(c)))
      : Object.keys(rows[0]);
    return { columns, rows, rowCount: typeof record.rowCount === 'number' ? record.rowCount : rows.length } as QueryResult;
  }
  return undefined;
}

/** Notebook-cell-style result view: chart + table toggle, reusing the same renderers. */
function ResultView({ result, themeMode, t }: { result: QueryResult; themeMode: ThemeMode; t: Theme }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: t.font,
    fontSize: 11, fontWeight: 700, padding: '2px 4px', color: active ? t.accent : t.textMuted,
    borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
  });
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, padding: '5px 9px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <button type="button" onClick={() => setView('chart')} style={tabStyle(view === 'chart')}>Chart</button>
        <button type="button" onClick={() => setView('table')} style={tabStyle(view === 'table')}>Table</button>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: t.textMuted, alignSelf: 'center' }}>{result.rowCount ?? result.rows.length} rows</span>
      </div>
      <div style={{ padding: 8, minHeight: view === 'chart' ? 200 : undefined, maxHeight: 320, overflow: 'auto' }}>
        {view === 'chart'
          ? <ChartOutput result={result} themeMode={themeMode} />
          : <TableOutput result={result} themeMode={themeMode} />}
      </div>
    </div>
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
    <div style={{ display: 'grid', gap: 6 }}>
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

function certifyButtonStyle(t: Theme, state?: 'pending' | 'sent' | 'error'): React.CSSProperties {
  const sent = state === 'sent';
  const color = sent ? t.success : t.accent;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    border: `1px solid ${color}`,
    background: `${color}14`,
    color,
    borderRadius: 7,
    padding: '5px 8px',
    fontSize: 11,
    fontWeight: 800,
    fontFamily: t.font,
    cursor: sent || state === 'pending' ? 'default' : 'pointer',
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

function digDeeperStyle(t: Theme, active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? t.accent : t.btnBorder}`,
    background: active ? `${t.accent}14` : 'transparent',
    color: active ? t.accent : t.textMuted,
    borderRadius: 999,
    padding: '5px 11px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11.5,
    fontWeight: 650,
    fontFamily: t.font,
    cursor: 'pointer',
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
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    color: t.textSecondary,
    fontSize: 12.5,
    border: `1px solid ${t.cellBorder}`,
    background: t.appBg,
    borderRadius: 8,
    padding: '8px 10px',
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
