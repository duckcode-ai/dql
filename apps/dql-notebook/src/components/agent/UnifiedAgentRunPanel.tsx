import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Blocks,
  Bot,
  CheckCircle2,
  Code2,
  FileSearch,
  GitBranch,
  LayoutDashboard,
  ListTree,
  Loader2,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import {
  api,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunEvent,
  type AgentRunRequestedMode,
  type AgentRunRoute,
  type AgentRunSelectedObject,
  type AgentRunStep,
  type AgentRunStepStatus,
} from '../../api/client';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';

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
  autoRun?: { text: string; mode?: AgentRunRequestedMode; nonce: number };
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
}

const MODE_OPTIONS: Array<{ value: AgentRunRequestedMode; label: string; icon: React.ReactNode }> = [
  { value: 'auto', label: 'Auto', icon: <Route size={13} /> },
  { value: 'ask', label: 'Ask', icon: <Sparkles size={13} /> },
  { value: 'research', label: 'Research', icon: <FileSearch size={13} /> },
  { value: 'sql', label: 'SQL', icon: <Code2 size={13} /> },
  { value: 'block', label: 'Block', icon: <Blocks size={13} /> },
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
  autoRun,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
}: UnifiedAgentRunPanelProps): JSX.Element {
  const t = themes[themeMode];
  const [mode, setMode] = useState<AgentRunRequestedMode>(initialMode);
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

  const handleNextAction = (run: AgentRun, route?: AgentRunRoute) => {
    const nextMode = routeToMode(route);
    if (nextMode) setMode(nextMode);
    setInput(nextPromptFor(run, route));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: t.cellBg }}>
      <style>{`@keyframes dql-agent-run-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={iconShellStyle(t)}><Bot size={16} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 850, color: t.textPrimary }}>{title}</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {scopeHint}
            </div>
          </div>
        </div>
        <div role="group" aria-label="Copilot route" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {MODE_OPTIONS.map((option) => {
            const active = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                aria-pressed={active}
                style={modeButtonStyle(t, active)}
              >
                {option.icon}
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.length === 0 && !running ? (
          <div style={{ margin: 'auto 0', display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center', color: t.textSecondary }}>
            <div style={largeIconShellStyle(t)}><Sparkles size={20} /></div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, maxWidth: 330 }}>
              No runs yet.
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
            onInsertSql={onInsertSql}
            onOpenBlock={onOpenBlock}
            onOpenResearch={onOpenResearch}
            onNextAction={(route) => handleNextAction(item.run, route)}
          />
        ))}

        {running && (
          <div style={assistantBubbleStyle(t)}>
            <Loader2 size={14} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite', flex: '0 0 auto' }} />
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span>Running route and checks...</span>
              {runningEvents.slice(-4).map((event) => (
                <span key={event.id} style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35 }}>
                  {event.message}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {error ? <div style={{ margin: '0 12px 8px', color: t.error, fontSize: 12 }}>{error}</div> : null}

      <div style={{ padding: 12, borderTop: `1px solid ${t.headerBorder}`, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder={mode === 'auto' ? 'Ask or describe what to build...' : `Ask in ${mode} mode...`}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
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
  );
}

function RunCard({
  run,
  t,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
  onNextAction: (route?: AgentRunRoute) => void;
}) {
  const steps = run.steps ?? [];
  const multiStep = steps.length > 1;
  const isLlmPlan = run.plan?.source === 'llm';
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

      {(isLlmPlan || multiStep || run.repairAttempts > 0) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {isLlmPlan ? <MetaChip t={t} icon={<ListTree size={11} />} label="AI plan" tone="accent" /> : null}
          {multiStep ? <MetaChip t={t} icon={<Route size={11} />} label={`${steps.length} steps`} tone="muted" /> : null}
          {run.repairAttempts > 0 ? <MetaChip t={t} icon={<Wrench size={11} />} label={`${run.repairAttempts} repair${run.repairAttempts > 1 ? 's' : ''}`} tone="warning" /> : null}
        </div>
      ) : null}

      <div style={{ fontSize: 12.5, lineHeight: 1.45, color: t.textSecondary }}>{run.summary}</div>
      {run.answer ? <div style={answerBoxStyle(t)}>{run.answer}</div> : null}

      {run.artifacts.length > 0 ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {run.artifacts.map((artifact) => (
            <ArtifactView
              key={artifact.id}
              artifact={artifact}
              t={t}
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

      {run.nextActions.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {run.nextActions.map((action) => (
            <button key={action.id} type="button" onClick={() => onNextAction(action.route)} style={smallButtonStyle(t)}>
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArtifactView({
  artifact,
  t,
  onInsertSql,
  onOpenBlock,
  onOpenResearch,
}: {
  artifact: AgentRunArtifact;
  t: Theme;
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string) => void;
}) {
  const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload as Record<string, unknown> : {};
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

  return (
    <div style={artifactStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ArtifactIcon kind={artifact.kind} />
        <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {artifact.title}
        </div>
      </div>
      {steps.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          {steps.slice(0, 4).map((step, index) => (
            <div key={index} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.35 }}>
              {index + 1}. {String(step.thought ?? step.expectation ?? 'Research step')}
            </div>
          ))}
        </div>
      ) : null}
      {sql ? <pre style={codeStyle(t)}>{sql}</pre> : null}
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

function modeButtonStyle(t: Theme, active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? t.accent : t.btnBorder}`,
    background: active ? `${t.accent}18` : t.btnBg,
    color: active ? t.accent : t.textSecondary,
    borderRadius: 7,
    padding: '5px 8px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    fontWeight: 800,
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
