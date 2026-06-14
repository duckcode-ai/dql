import React, { useRef, useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { runAgent } from '../../llm/client';
import type { AgentTurn } from '../../llm/types';
import { themes, type Theme } from '../../themes/notebook-theme';
import { AgentAnswerCard, extractGovernedAnswer } from './AgentAnswerCard';
import { api, type AppConversationMessage } from '../../api/client';

interface LocalMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  events?: AgentTurn[];
  createdAt?: string;
}

export function AgentChatPanel({
  title,
  scopeHint,
  upstreamContext,
  themeMode,
  hideSqlByDefault = false,
  addToAppTarget,
  conversationTarget,
  onConversationUpdated,
  initialInput,
  expanded = false,
  onToggleExpanded,
  onClose,
}: {
  title: string;
  scopeHint: string;
  upstreamContext?: string;
  themeMode: keyof typeof themes;
  hideSqlByDefault?: boolean;
  addToAppTarget?: { appId: string; dashboardId: string };
  conversationTarget?: { appId: string; dashboardId?: string; notebookPath?: string };
  onConversationUpdated?: () => void;
  initialInput?: string;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onClose?: () => void;
}) {
  const t = themes[themeMode];
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState(initialInput ?? '');
  const [running, setRunning] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveEvents, setLiveEvents] = useState<AgentTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!initialInput || running) return;
    setInput((current) => current || initialInput);
  }, [initialInput, running]);

  const send = async () => {
    const text = input.trim();
    if (!text || running) return;
    const userMessage: LocalMessage = { id: makeMessageId(), role: 'user', content: text, createdAt: new Date().toISOString() };
    const next: LocalMessage[] = [...messages, userMessage];
    setMessages(next);
    setInput('');
    setError(null);
    setLiveText('');
    setLiveEvents([]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    const events: AgentTurn[] = [];
    let activeConversationId = conversationId;
    try {
      if (conversationTarget && !activeConversationId) {
        const created = await api.createAppConversation(conversationTarget.appId, {
          title: text.slice(0, 80),
          dashboardId: conversationTarget.dashboardId,
          notebookPath: conversationTarget.notebookPath,
          messages: toConversationMessages(next),
        });
        if (created.ok) {
          activeConversationId = created.conversation.id;
          setConversationId(activeConversationId);
          onConversationUpdated?.();
        }
      }
      await runAgent(
        {
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          upstream: { cellId: `scope:${title}`, sql: upstreamContext },
          signal: controller.signal,
        },
        (turn) => {
          events.push(turn);
          setLiveEvents([...events]);
          if (turn.kind === 'text') {
            acc += hideSqlByDefault ? stripSqlBlocks(turn.text) : turn.text;
            setLiveText(acc);
          }
          if (turn.kind === 'error') setError(turn.message);
        },
      );
      const finalMessages = [...next, { id: makeMessageId(), role: 'assistant' as const, content: acc, events, createdAt: new Date().toISOString() }];
      setMessages(finalMessages);
      if (conversationTarget && activeConversationId) {
        await api.updateAppConversation(conversationTarget.appId, activeConversationId, {
          messages: toConversationMessages(finalMessages),
        });
        onConversationUpdated?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setLiveText('');
      setLiveEvents([]);
      abortRef.current = null;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: t.cellBg }}>
      <div style={{ padding: 12, borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
            <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 2 }}>{scopeHint} · Provider from Settings</div>
          </div>
          {onToggleExpanded && (
            <button type="button" onClick={onToggleExpanded} title={expanded ? 'Collapse chat' : 'Expand chat'} style={iconButtonStyle(t)}>
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} title="Close chat" style={iconButtonStyle(t)}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && !running ? (
          <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45 }}>
            Ask about metric definitions, filters, tile results, or where to find certified analysis.
          </div>
        ) : null}
        {messages.map((m, index) => (
          <Bubble
            key={index}
            message={m}
            t={t}
            themeMode={themeMode}
            hideSqlByDefault={hideSqlByDefault}
            addToAppTarget={addToAppTarget}
          />
        ))}
        {running && (
          <Bubble
            message={{ role: 'assistant', content: liveText || 'Thinking...', events: liveEvents }}
            t={t}
            live
            themeMode={themeMode}
            hideSqlByDefault={hideSqlByDefault}
            addToAppTarget={addToAppTarget}
          />
        )}
      </div>

      {error && <div style={{ margin: '0 12px 8px', color: '#ff7b72', fontSize: 12 }}>{error}</div>}

      <div style={{ padding: 12, borderTop: `1px solid ${t.headerBorder}`, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder="Ask this context..."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          style={{ flex: 1, resize: 'vertical', minHeight: 42, ...selectStyle(t) }}
        />
        {running ? (
          <button type="button" onClick={() => abortRef.current?.abort()} style={buttonStyle(t, false)}>Stop</button>
        ) : (
          <button type="button" onClick={() => void send()} disabled={!input.trim()} style={buttonStyle(t, true)}>Ask</button>
        )}
      </div>
    </div>
  );
}

function makeMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toConversationMessages(messages: LocalMessage[]): AppConversationMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    events: message.events as unknown[] | undefined,
    createdAt: message.createdAt,
  }));
}

function Bubble({
  message,
  t,
  live,
  themeMode,
  hideSqlByDefault,
  addToAppTarget,
}: {
  message: LocalMessage;
  t: Theme;
  live?: boolean;
  themeMode: keyof typeof themes;
  hideSqlByDefault: boolean;
  addToAppTarget?: { appId: string; dashboardId: string };
}) {
  const isUser = message.role === 'user';
  const answer = !isUser ? extractGovernedAnswer(message.events ?? []) : null;
  if (answer) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, color: live ? t.accent : t.textMuted, textTransform: 'uppercase', fontWeight: 700 }}>
          DQL Agent
        </div>
        <AgentAnswerCard
          answer={answer}
          themeMode={themeMode}
          showSql={!hideSqlByDefault}
          compact
          addToAppTarget={addToAppTarget}
        />
      </div>
    );
  }
  return (
    <div style={{ border: `1px solid ${isUser ? `${t.accent}55` : t.headerBorder}`, borderRadius: 8, padding: 10, background: isUser ? `${t.accent}12` : t.appBg, whiteSpace: answer ? 'normal' : 'pre-wrap', fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ fontSize: 10, color: live ? t.accent : t.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>
        {isUser ? 'You' : 'DQL Agent'}
      </div>
      {message.content}
    </div>
  );
}

function stripSqlBlocks(text: string): string {
  return text.replace(/Proposed SQL:\s*```sql[\s\S]*?```/gi, 'Proposed SQL hidden in dashboard mode. Send to analyst review to inspect.');
}

function selectStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 6,
    background: t.appBg,
    color: t.textPrimary,
    fontSize: 12,
    padding: '7px 8px',
    fontFamily: t.font,
  };
}

function iconButtonStyle(t: Theme): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 6,
    background: t.appBg,
    color: t.textPrimary,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  };
}

function buttonStyle(t: Theme, primary: boolean): React.CSSProperties {
  return {
    border: `1px solid ${primary ? t.accent : t.headerBorder}`,
    borderRadius: 6,
    background: primary ? `${t.accent}22` : t.appBg,
    color: primary ? t.accent : t.textPrimary,
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 12,
  };
}
