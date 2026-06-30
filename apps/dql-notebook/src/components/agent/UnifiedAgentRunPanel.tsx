import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
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
  Pin,
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
} from '../../api/client';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import type { QueryResult } from '../../store/types';

type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'run'; id: string; run: AgentRun };

interface UnifiedAgentRunPanelProps {
  themeMode: ThemeMode;
  title?: string;
  scopeHint?: string;
  notebookPath?: string;
  selectedObject?: AgentRunSelectedObject;
  workspaceContext?: Record<string, unknown>;
  initialMode?: AgentRunRequestedMode;
  initialInput?: string;
  /** 'stakeholder' (consumption-only) hides authoring modes + adds the certify handoff. */
  audience?: AgentRunAudience;
  autoRun?: { text: string; mode?: AgentRunRequestedMode; nonce: number };
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
}

const ANALYST_MODE_OPTIONS: Array<{ value: AgentRunRequestedMode; label: string; icon: React.ReactNode }> = [
  { value: 'auto', label: 'Auto', icon: <Route size={13} /> },
  { value: 'ask', label: 'Ask', icon: <Sparkles size={13} /> },
  { value: 'research', label: 'Research', icon: <FileSearch size={13} /> },
  { value: 'sql', label: 'SQL', icon: <Code2 size={13} /> },
  { value: 'block', label: 'Block', icon: <Blocks size={13} /> },
  { value: 'app', label: 'App', icon: <LayoutDashboard size={13} /> },
];

// Stakeholders never author SQL/blocks — only consumption routes.
const STAKEHOLDER_MODE_OPTIONS: Array<{ value: AgentRunRequestedMode; label: string; icon: React.ReactNode }> = [
  { value: 'auto', label: 'Auto', icon: <Route size={13} /> },
  { value: 'ask', label: 'Ask', icon: <Sparkles size={13} /> },
  { value: 'research', label: 'Research', icon: <FileSearch size={13} /> },
  { value: 'app', label: 'App', icon: <LayoutDashboard size={13} /> },
];

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
  notebookPath,
  selectedObject,
  workspaceContext,
  initialMode = 'auto',
  initialInput = '',
  audience = 'analyst',
  autoRun,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
}: UnifiedAgentRunPanelProps): JSX.Element {
  const t = themes[themeMode];
  const modeOptions = audience === 'stakeholder' ? STAKEHOLDER_MODE_OPTIONS : ANALYST_MODE_OPTIONS;
  const [mode, setMode] = useState<AgentRunRequestedMode>(initialMode);
  const [certifying, setCertifying] = useState<Record<string, 'pending' | 'sent' | 'error'>>({});
  const [pinning, setPinning] = useState<Record<string, 'pending' | 'sent' | 'error'>>({});
  const [input, setInput] = useState(initialInput);
  const [items, setItems] = useState<ThreadItem[]>([]);
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

  const submit = async (textOverride?: string, modeOverride?: AgentRunRequestedMode) => {
    const text = (textOverride ?? input).trim();
    if (!text || running) return;
    const activeMode = modeOverride ?? mode;
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

  const appId = typeof workspaceContext?.appId === 'string' ? workspaceContext.appId : undefined;
  const dashboardId = typeof workspaceContext?.dashboardId === 'string' ? workspaceContext.dashboardId : undefined;
  const canPin = Boolean(appId && dashboardId);

  const pinToApp = async (run: AgentRun) => {
    if (!appId || !dashboardId) return;
    if (pinning[run.id] === 'pending' || pinning[run.id] === 'sent') return;
    setPinning((current) => ({ ...current, [run.id]: 'pending' }));
    try {
      const cleanTitle = run.question.replace(/^\/\w+\s+/, '').slice(0, 80);
      const result = await api.createAiPin(appId, {
        dashboardId,
        title: cleanTitle,
        answer: run.answer ?? run.summary,
        question: run.question,
        sql: answerSqlFromRun(run),
        certification: run.trustState === 'certified' ? 'certified' : 'ai_generated',
        reviewStatus: run.trustState === 'certified' ? 'certified' : 'needs_review',
      });
      setPinning((current) => ({ ...current, [run.id]: result.ok ? 'sent' : 'error' }));
    } catch {
      setPinning((current) => ({ ...current, [run.id]: 'error' }));
    }
  };

  const handleNextAction = (run: AgentRun, action: AgentRun['nextActions'][number]) => {
    if (action.id === 'request-certification') {
      void requestCertification(run);
      return;
    }
    if (action.id === 'pin-to-app') {
      void pinToApp(run);
      return;
    }
    const nextMode = routeToMode(action.route);
    if (nextMode) setMode(nextMode);
    setInput(nextPromptFor(run, action.route));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: 1, minWidth: 0, width: '100%', background: t.cellBg }}>
      <style>{`@keyframes dql-agent-run-spin { to { transform: rotate(360deg); } } @keyframes dql-agent-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } } .dql-agent-dots::after { content: ''; animation: dql-agent-dots 1.4s steps(1) infinite; } @keyframes dql-agent-sweep { 0% { transform: translateX(-130%); } 100% { transform: translateX(330%); } } @keyframes dql-agent-fadein { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } } @keyframes dql-agent-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.8); } }`}</style>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.length === 0 && !running ? (
          <div style={{ margin: 'auto 0', display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center', color: t.textSecondary }}>
            <div style={largeIconShellStyle(t)}><Sparkles size={20} /></div>
            <div style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 380, color: t.textSecondary }}>
              Ask a question or dig deeper with research — every answer is grounded in your certified metrics and dbt lineage.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
              {EXAMPLE_PROMPTS.map((ex) => (
                <button key={ex} type="button" onClick={() => { setInput(ex); requestAnimationFrame(() => inputRef.current?.focus()); }} style={suggestionChipStyle(t)}>
                  {ex}
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
            pinState={pinning[item.run.id]}
            canPin={canPin}
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
        <div role="group" aria-label="Copilot mode" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {modeOptions.map((option) => {
            const active = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                aria-pressed={active}
                style={modeChipStyle(t, active)}
              >
                {option.icon}
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={2}
            placeholder={mode === 'auto' ? 'Ask anything about your data…' : `Ask in ${mode} mode…`}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            style={inputStyle(t)}
          />
          <button type="button" onClick={() => void submit()} disabled={!input.trim() || running} style={sendButtonStyle(t, Boolean(input.trim()) && !running)}>
            {running ? <Loader2 size={14} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Send size={14} />}
            <span>Run</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  'What is total revenue?',
  'Why is revenue down by region?',
  'Top customers by revenue this quarter',
  'How have orders trended over the last 6 months?',
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

/** Clean, animated progress — a current-action label + an indeterminate sweep bar. */
function RunProgress({ events, t }: { events: AgentRunEvent[]; t: Theme }) {
  const action = currentActionLabel(events);
  return (
    <div style={{ ...assistantBubbleStyle(t), alignItems: 'stretch', flexDirection: 'column', gap: 8, maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: t.accent, flex: '0 0 auto', animation: 'dql-agent-pulse 1.2s ease-in-out infinite' }} />
        <span key={action} className="dql-agent-dots" style={{ fontSize: 12.5, fontWeight: 800, color: t.textPrimary, animation: 'dql-agent-fadein 0.25s ease-out' }}>{action}</span>
      </div>
      <div style={{ position: 'relative', height: 4, borderRadius: 999, background: `${t.accent}1f`, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, bottom: 0, width: '38%', borderRadius: 999, background: t.accent, animation: 'dql-agent-sweep 1.25s cubic-bezier(0.4,0,0.2,1) infinite' }} />
      </div>
      {events.length > 0 ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 10.5, color: t.textMuted, listStyle: 'none' }}>Details</summary>
          <div style={{ display: 'grid', gap: 3, marginTop: 5 }}>
            {events.slice(-6).map((event) => (
              <span key={event.id} style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.35 }}>{event.message}</span>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function RunCard({
  run,
  t,
  themeMode,
  certifyState,
  pinState,
  canPin,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  certifyState?: 'pending' | 'sent' | 'error';
  pinState?: 'pending' | 'sent' | 'error';
  canPin?: boolean;
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
  // Pin only a result worth pinning (an answer/research artifact), in an app context.
  const pinnable = Boolean(canPin) && run.status !== 'blocked' && run.status !== 'needs_clarification'
    && (Boolean(run.answer) || run.artifacts.some((a) => a.kind === 'answer' || a.kind === 'research_run'));
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
          {run.trustState === 'certified' ? <ShieldCheck size={12} color={t.success} style={{ flex: '0 0 auto', marginTop: 1 }} /> : <ShieldAlert size={12} color={t.warning} style={{ flex: '0 0 auto', marginTop: 1 }} />}
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

      <div style={{ fontSize: 12.5, lineHeight: 1.45, color: t.textSecondary }}>{run.summary}</div>
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
            />
          ))}
        </div>
      ) : null}

      {multiStep ? (
        <StepTrace steps={steps} t={t} />
      ) : (
        <div style={{ display: 'grid', gap: 5 }}>
          {run.evaluations.map((evaluation) => (
            <EvaluationRow key={evaluation.id} evaluation={evaluation} t={t} />
          ))}
        </div>
      )}

      {(run.nextActions.length > 0 || pinnable) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {run.nextActions.map((action) => {
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
                onClick={() => onNextAction(action)}
                disabled={isCertify && (certifyState === 'pending' || certifyState === 'sent')}
                style={isCertify ? certifyButtonStyle(t, certifyState) : smallButtonStyle(t)}
              >
                {isCertify && certifyState === 'sent' ? <CheckCircle2 size={11} /> : isCertify ? <ShieldCheck size={11} /> : null}
                {label}
              </button>
            );
          })}
          {pinnable ? (
            <button
              type="button"
              onClick={() => onNextAction({ id: 'pin-to-app', label: 'Pin to app' })}
              disabled={pinState === 'pending' || pinState === 'sent'}
              style={certifyButtonStyle(t, pinState)}
              title="Add this insight to the current app dashboard"
            >
              {pinState === 'sent' ? <CheckCircle2 size={11} /> : <Pin size={11} />}
              {pinState === 'sent' ? 'Pinned to app' : pinState === 'pending' ? 'Pinning…' : pinState === 'error' ? 'Retry pin' : 'Pin to app'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Plain-English trust line so a stakeholder knows what they can rely on. */
function trustExplainer(run: AgentRun): string | null {
  if (run.trustState === 'certified') return 'Certified — answered from a governed metric you can trust.';
  if (run.trustState === 'review_required') return 'Review-required — generated from governed data; not a certified metric yet.';
  if (run.trustState === 'blocked') return null;
  return null;
}

function ArtifactView({
  artifact,
  t,
  themeMode,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
}: {
  artifact: AgentRunArtifact;
  t: Theme;
  themeMode: ThemeMode;
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
}) {
  const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload as Record<string, unknown> : {};
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
  if (run.status === 'completed') return <CheckCircle2 size={16} color="#16a34a" />;
  if (run.status === 'blocked') return <Route size={16} color="#ef4444" />;
  return <Route size={16} color="#d97706" />;
}

function ArtifactIcon({ kind }: { kind: AgentRunArtifact['kind'] }) {
  if (kind === 'sql_cell') return <Code2 size={14} />;
  if (kind === 'dql_block_draft') return <Blocks size={14} />;
  if (kind === 'app_draft') return <LayoutDashboard size={14} />;
  if (kind === 'research_run') return <FileSearch size={14} />;
  return <Sparkles size={14} />;
}

function TrustBadge({ run, t }: { run: AgentRun; t: Theme }) {
  const color = run.trustState === 'certified'
    ? t.success
    : run.trustState === 'blocked'
      ? t.error
      : run.trustState === 'not_applicable'
        ? t.textMuted
        : t.warning;
  return (
    <span style={{ border: `1px solid ${color}55`, color, background: `${color}12`, borderRadius: 999, padding: '3px 7px', fontSize: 10, fontWeight: 850 }}>
      {run.trustState.split('_').join(' ')}
    </span>
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

function modeChipStyle(t: Theme, active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? t.accent : t.btnBorder}`,
    background: active ? `${t.accent}14` : 'transparent',
    color: active ? t.accent : t.textMuted,
    borderRadius: 999,
    padding: '3px 9px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function suggestionChipStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    borderRadius: 999,
    padding: '6px 11px',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function inputStyle(t: Theme): React.CSSProperties {
  return {
    flex: 1,
    minHeight: 54,
    maxHeight: 140,
    resize: 'vertical',
    border: `1px solid ${t.btnBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 8,
    padding: '9px 10px',
    fontSize: 12.5,
    lineHeight: 1.4,
    fontFamily: t.font,
    outline: 'none',
  };
}

function sendButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    border: `1px solid ${enabled ? t.accent : t.btnBorder}`,
    background: enabled ? t.accent : t.btnBg,
    color: enabled ? '#fff' : t.textMuted,
    borderRadius: 8,
    height: 38,
    padding: '0 12px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 850,
    fontFamily: t.font,
    cursor: enabled ? 'pointer' : 'not-allowed',
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
