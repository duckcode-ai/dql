import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Blocks,
  Bot,
  CheckCircle2,
  Code2,
  FileSearch,
  LayoutDashboard,
  Loader2,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  api,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunRequestedMode,
  type AgentRunRoute,
  type AgentRunSelectedObject,
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
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
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
  onInsertSql,
  onOpenBlock,
}: UnifiedAgentRunPanelProps): JSX.Element {
  const t = themes[themeMode];
  const [mode, setMode] = useState<AgentRunRequestedMode>(initialMode);
  const [input, setInput] = useState(initialInput);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInitialInputRef = useRef(initialInput);

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
    try {
      const run = await api.createAgentRun({
        question: text,
        requestedMode: activeMode,
        selectedObject: selectedObject ?? (notebookPath ? { kind: 'notebook', path: notebookPath } : undefined),
        workspaceContext: {
          ...(workspaceContext ?? {}),
          ...(notebookPath ? { notebookPath } : {}),
        },
        history,
      });
      setItems((current) => [...current, { kind: 'run', id: run.id, run }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInput(text);
    } finally {
      setRunning(false);
    }
  };

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
            onNextAction={(route) => handleNextAction(item.run, route)}
          />
        ))}

        {running && (
          <div style={assistantBubbleStyle(t)}>
            <Loader2 size={14} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} />
            <span>Running route and checks...</span>
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
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onNextAction: (route?: AgentRunRoute) => void;
}) {
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
            />
          ))}
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 5 }}>
        {run.evaluations.map((evaluation) => (
          <div key={evaluation.id} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: t.textSecondary }}>
            <span style={{ color: evaluation.passed ? t.success : evaluation.severity === 'blocking' ? t.error : t.warning, lineHeight: '16px' }}>
              {evaluation.passed ? 'OK' : evaluation.severity === 'blocking' ? 'Stop' : 'Review'}
            </span>
            <span style={{ lineHeight: 1.4 }}>{evaluation.message}</span>
          </div>
        ))}
      </div>

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
}: {
  artifact: AgentRunArtifact;
  t: Theme;
  onInsertSql?: (sql: string, title?: string) => void;
  onOpenBlock?: (path: string, name?: string) => void;
}) {
  const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload as Record<string, unknown> : {};
  const sql = typeof payload.sql === 'string'
    ? payload.sql
    : typeof payload.sqlPreview === 'string'
      ? payload.sqlPreview
      : undefined;
  const name = typeof payload.name === 'string' ? payload.name : artifact.title;
  const path = typeof payload.path === 'string' ? payload.path : artifact.ref;
  const plan = payload.plan && typeof payload.plan === 'object' ? payload.plan as Record<string, unknown> : undefined;
  const steps = Array.isArray(plan?.steps) ? plan.steps as Array<Record<string, unknown>> : [];
  const gaps = Array.isArray(plan?.gaps) ? plan.gaps.map(String) : [];

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
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
