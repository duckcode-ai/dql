import React, { useRef, useState } from 'react';
import { Bot, Maximize2, Minimize2, Send, X } from 'lucide-react';
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
  autoAsk,
  emptyHint,
  inputPlaceholder,
  suggestions,
  variant = 'default',
  embedded = false,
  showHeader = true,
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
  autoAsk?: { text: string; nonce: number };
  emptyHint?: string;
  inputPlaceholder?: string;
  suggestions?: Array<{ label: string; prompt: string; icon?: React.ReactNode }>;
  variant?: 'default' | 'executive';
  embedded?: boolean;
  showHeader?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onClose?: () => void;
}) {
  const t = themes[themeMode];
  const executive = variant === 'executive';
  const framed = executive && !embedded;
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState(initialInput ?? '');
  const [running, setRunning] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveEvents, setLiveEvents] = useState<AgentTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInitialInputRef = useRef(initialInput ?? '');
  const lastAskNonceRef = useRef<number | null>(null);

  React.useEffect(() => {
    if (!initialInput || running) return;
    if (initialInput === lastInitialInputRef.current) return;
    lastInitialInputRef.current = initialInput;
    setInput(initialInput);
  }, [initialInput, running]);

  React.useEffect(() => {
    if (!autoAsk || running) return;
    if (autoAsk.nonce === lastAskNonceRef.current) return;
    lastAskNonceRef.current = autoAsk.nonce;
    const text = autoAsk.text.trim();
    if (!text) return;
    setInput(text);
    void send(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk?.nonce]);

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
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
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      background: embedded ? 'transparent' : t.cellBg,
      border: framed ? `1px solid ${t.headerBorder}` : undefined,
      borderRadius: framed ? 8 : undefined,
      overflow: framed ? 'hidden' : undefined,
    }}>
      {showHeader && (
      <div style={{ padding: executive ? '10px 12px' : 12, borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: executive ? 10 : 8 }}>
          {executive && (
            <div style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: `${t.accent}16`,
              border: `1px solid ${t.accent}36`,
              color: t.accent,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
            }}>
              <Bot size={16} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: executive ? 12.5 : 13, fontWeight: 800, lineHeight: 1.25 }}>{title}</div>
            <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 2 }}>
              {scopeHint}{executive ? ' · evidence available on demand' : ' · Provider from Settings'}
            </div>
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
      )}

      <div style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: embedded ? '10px 0' : 12,
        display: 'flex',
        flexDirection: 'column',
        gap: executive ? 12 : 10,
      }}>
        {messages.length === 0 && !running ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            alignItems: 'center',
            textAlign: 'center',
            margin: 'auto 0',
            padding: executive ? '8px 4px' : 0,
          }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: `${t.accent}14`,
              border: `1px solid ${t.accent}2e`,
              color: t.accent,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Bot size={20} />
            </div>
            <div style={{ fontSize: executive ? 13 : 12.5, color: t.textSecondary, lineHeight: 1.5, maxWidth: 340 }}>
              {emptyHint ?? 'Ask about metric definitions, filters, tile results, or where to find certified analysis.'}
            </div>
            {suggestions && suggestions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, justifyContent: 'center', maxWidth: 360 }}>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    onClick={() => {
                      setInput(suggestion.prompt);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                    style={suggestionChipStyle(t)}
                  >
                    {suggestion.icon}
                    <span>{suggestion.label}</span>
                  </button>
                ))}
              </div>
            )}
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
            executive={executive}
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
            executive={executive}
          />
        )}
      </div>

      {error && <div style={{ margin: '0 12px 8px', color: '#ff7b72', fontSize: 12 }}>{error}</div>}

      <div style={{
        padding: executive ? 10 : 12,
        borderTop: `1px solid ${t.headerBorder}`,
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        background: embedded ? 'transparent' : executive ? t.appBg : undefined,
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={executive ? 3 : 2}
          placeholder={inputPlaceholder ?? 'Ask this context...'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          style={{
            flex: 1,
            resize: 'vertical',
            minHeight: executive ? 54 : 42,
            maxHeight: 140,
            ...selectStyle(t, executive),
          }}
        />
        {running ? (
          <button type="button" onClick={() => abortRef.current?.abort()} style={buttonStyle(t, false, executive)}>Stop</button>
        ) : (
          <button type="button" onClick={() => void send()} disabled={!input.trim()} style={buttonStyle(t, true, executive)}>
            {executive && <Send size={14} />}
            <span>Ask</span>
          </button>
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
  executive,
}: {
  message: LocalMessage;
  t: Theme;
  live?: boolean;
  themeMode: keyof typeof themes;
  hideSqlByDefault: boolean;
  addToAppTarget?: { appId: string; dashboardId: string };
  executive?: boolean;
}) {
  const isUser = message.role === 'user';
  const answer = !isUser ? extractGovernedAnswer(message.events ?? []) : null;
  if (answer) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          color: live ? t.accent : t.textMuted,
          textTransform: 'uppercase',
          fontWeight: 800,
        }}>
          {executive && <Bot size={12} />}
          Copilot
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
    <div style={{
      alignSelf: isUser && executive ? 'flex-end' : 'stretch',
      maxWidth: isUser && executive ? '88%' : undefined,
      border: `1px solid ${isUser ? `${t.accent}55` : t.headerBorder}`,
      borderRadius: executive ? 12 : 8,
      padding: executive ? '9px 11px' : 10,
      background: isUser ? `${t.accent}12` : t.appBg,
      whiteSpace: answer ? 'normal' : 'pre-wrap',
      fontSize: executive ? 12.5 : 12,
      lineHeight: 1.5,
    }}>
      <div style={{ fontSize: 10, color: live ? t.accent : t.textMuted, textTransform: 'uppercase', fontWeight: 800, marginBottom: 4 }}>
        {isUser ? 'You' : 'Copilot'}
      </div>
      {message.content}
    </div>
  );
}

function stripSqlBlocks(text: string): string {
  return text.replace(/Proposed SQL:\s*```sql[\s\S]*?```/gi, 'Proposed SQL hidden in dashboard mode. Send to analyst review to inspect.');
}

function suggestionChipStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 999,
    background: t.appBg,
    color: t.textSecondary,
    padding: '6px 11px',
    fontSize: 12,
    cursor: 'pointer',
    lineHeight: 1.2,
    fontFamily: t.font,
  };
}

function selectStyle(t: Theme, executive = false): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: executive ? 10 : 6,
    background: executive ? t.cellBg : t.appBg,
    color: t.textPrimary,
    fontSize: executive ? 12.5 : 12,
    lineHeight: 1.45,
    padding: executive ? '10px 11px' : '7px 8px',
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

function buttonStyle(t: Theme, primary: boolean, executive = false): React.CSSProperties {
  return {
    border: `1px solid ${primary ? t.accent : t.headerBorder}`,
    borderRadius: executive ? 10 : 6,
    background: primary ? `${t.accent}22` : t.appBg,
    color: primary ? t.accent : t.textPrimary,
    padding: executive ? '0 13px' : '8px 12px',
    minHeight: executive ? 42 : undefined,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: executive ? 800 : undefined,
    display: executive ? 'inline-flex' : undefined,
    alignItems: executive ? 'center' : undefined,
    gap: executive ? 6 : undefined,
  };
}
