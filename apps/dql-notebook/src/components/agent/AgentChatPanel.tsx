import React, { useRef, useState } from 'react';
import { Bot, FileText, Maximize2, Minimize2, Plus, Send, X } from 'lucide-react';
import { runAgent } from '../../llm/client';
import type { AgentConversationContext, AgentTurn, BlockProposal } from '../../llm/types';
import { themes, type Theme } from '../../themes/notebook-theme';
import {
  AgentAnswerCard,
  StructuredAnswerText,
  extractGovernedAnswer,
  type AgentAnswerEnvelope,
  type AgentAnswerInvestigationRequest,
} from './AgentAnswerCard';
import { api, type AppConversation, type AppConversationMessage } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { NotebookFile } from '../../store/types';

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
  onInvestigate,
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
  onInvestigate?: (request: AgentAnswerInvestigationRequest) => void;
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
  const [conversationContext, setConversationContext] = useState<AgentConversationContext | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInitialInputRef = useRef(initialInput ?? '');
  const lastAskNonceRef = useRef<number | null>(null);
  const conversationTargetAppId = conversationTarget?.appId;
  const conversationTargetDashboardId = conversationTarget?.dashboardId;
  const conversationTargetNotebookPath = conversationTarget?.notebookPath;

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

  React.useEffect(() => {
    if (!conversationTargetAppId) return;
    const target = {
      appId: conversationTargetAppId,
      dashboardId: conversationTargetDashboardId,
      notebookPath: conversationTargetNotebookPath,
    };
    let cancelled = false;
    setMessages([]);
    setConversationId(null);
    setConversationContext(undefined);
    void (async () => {
      const conversations = await api.listAppConversations(target.appId);
      const latest = conversations.find((conversation) => matchesConversationTarget(conversation, target));
      if (!latest) return;
      const full = await api.getAppConversation(target.appId, latest.id);
      if (!full || cancelled) return;
      setConversationId(full.id);
      setMessages(toLocalMessages(full.messages ?? []));
      setConversationContext(full.context);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationTargetAppId, conversationTargetDashboardId, conversationTargetNotebookPath]);

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
    if (onInvestigate && shouldRouteToResearchWorkspace(text)) {
      const note: LocalMessage = {
        id: makeMessageId(),
        role: 'assistant',
        content: 'I opened this in Research so the answer can keep SQL, preview rows, evidence, and review actions together.',
        createdAt: new Date().toISOString(),
      };
      const finalMessages = [...next, note];
      setMessages(finalMessages);
      onInvestigate({
        question: text,
        title: researchTitleFromQuestion(text),
      });
      if (conversationTarget) {
        let activeConversationId = conversationId;
        if (!activeConversationId) {
          const created = await api.createAppConversation(conversationTarget.appId, {
            title: text.slice(0, 80),
            dashboardId: conversationTarget.dashboardId,
            notebookPath: conversationTarget.notebookPath,
            context: conversationContext,
            messages: toConversationMessages(finalMessages),
          });
          if (created.ok) {
            activeConversationId = created.conversation.id;
            setConversationId(activeConversationId);
          }
        } else {
          await api.updateAppConversation(conversationTarget.appId, activeConversationId, {
            context: conversationContext ?? null,
            messages: toConversationMessages(finalMessages),
          });
        }
        onConversationUpdated?.();
      }
      return;
    }
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
          context: conversationContext,
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
          conversationContext,
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
      const governedAnswer = extractGovernedAnswer(events);
      const proposalEvent = latestProposalEvent(events);
      const nextContext = governedAnswer
        ? contextFromGovernedAnswer(governedAnswer, text, conversationContext, conversationTarget ? 'app' : 'notebook')
        : proposalEvent
          ? contextFromProposalEvent(proposalEvent, text, conversationContext, conversationTarget ? 'app' : 'notebook')
          : conversationContext;
      setConversationContext(nextContext);
      setMessages(finalMessages);
      if (conversationTarget && activeConversationId) {
        await api.updateAppConversation(conversationTarget.appId, activeConversationId, {
          context: nextContext ?? null,
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
  const continueIntoInvestigation = (request: AgentAnswerInvestigationRequest) => {
    if (!onInvestigate) return;
    onInvestigate(request);
    const note: LocalMessage = {
      id: makeMessageId(),
      role: 'assistant',
      content: `I opened a Research workspace for "${request.question}". Keep asking here; this chat stays attached while the evidence opens in the main view.`,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => {
      const next = [...current, note];
      if (conversationTarget && conversationId) {
        void api.updateAppConversation(conversationTarget.appId, conversationId, {
          context: conversationContext ?? null,
          messages: toConversationMessages(next),
        }).then(() => onConversationUpdated?.());
      }
      return next;
    });
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
              {scopeHint}{executive ? ' · evidence available on demand' : ' · Provider from Connections'}
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
            sourceQuestion={previousUserQuestion(messages, index)}
            t={t}
            themeMode={themeMode}
            hideSqlByDefault={hideSqlByDefault}
            addToAppTarget={addToAppTarget}
            onInvestigate={onInvestigate ? continueIntoInvestigation : undefined}
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

      {conversationContext && (
        <div style={contextStripStyle(t, executive)}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={contextPillStyle(t)}>
                {conversationContext.trustLabel === 'certified' || conversationContext.certification === 'certified' ? 'Certified context' : 'Review context'}
              </span>
              <span style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {conversationContext.sourceCertifiedBlock
                  ? `Continuing from ${conversationContext.sourceCertifiedBlock}`
                  : conversationContext.draftBlockPath
                    ? 'Continuing from draft'
                    : 'Continuing with prior answer'}
              </span>
            </div>
            <div style={{ color: t.textMuted, fontSize: executive ? 10.5 : 10, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {conversationContext.sourceQuestion ?? conversationContext.contextPackId ?? conversationContext.draftBlockPath}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setConversationContext(undefined);
              if (conversationTarget && conversationId) {
                void api.updateAppConversation(conversationTarget.appId, conversationId, { context: null });
              }
            }}
            title="Clear follow-up context"
            style={contextClearButtonStyle(t)}
          >
            <X size={13} />
          </button>
        </div>
      )}

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

function shouldRouteToResearchWorkspace(text: string): boolean {
  const value = text.toLowerCase();
  return /\b(research|investigate|investigation|deep[- ]?dive|root cause)\b/.test(value)
    || /\b(detailed|complete|full)\s+(overview|analysis|summary)\b/.test(value);
}

function researchTitleFromQuestion(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 90 ? `${clean.slice(0, 87)}...` : clean || 'Research request';
}

type ProposalTurn = Extract<AgentTurn, { kind: 'proposal' }>;

function latestProposalEvent(events: AgentTurn[] | undefined): ProposalTurn | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === 'proposal') return event;
  }
  return null;
}

function contextFromProposalEvent(
  event: ProposalTurn,
  sourceQuestion: string,
  previous: AgentConversationContext | undefined,
  activeSurface: AgentConversationContext['activeSurface'],
): AgentConversationContext | undefined {
  const path = cleanOptionalString(event.proposal.path);
  const summary = summarizeAnswer(event.proposal.description || event.proposal.name);
  if (!path && !summary) return previous;
  return {
    ...previous,
    activeSurface,
    sourceQuestion: sourceQuestion.trim(),
    sourceAnswerSummary: summary ?? previous?.sourceAnswerSummary,
    draftBlockPath: path ?? previous?.draftBlockPath,
    requestedFilters: mergeTextArrays(previous?.requestedFilters, inferFilters(sourceQuestion)),
    requestedDimensions: previous?.requestedDimensions,
    trustLabel: event.governance.certified ? 'certified' : 'draft',
    certification: event.governance.certified ? 'certified' : 'uncertified',
    route: 'proposal',
    updatedAt: new Date().toISOString(),
  };
}

function contextFromGovernedAnswer(
  answer: AgentAnswerEnvelope,
  sourceQuestion: string,
  previous: AgentConversationContext | undefined,
  activeSurface: AgentConversationContext['activeSurface'],
): AgentConversationContext | undefined {
  const sourceCertifiedBlock = sourceBlockNameFromAnswer(answer) ?? previous?.sourceCertifiedBlock;
  const draftBlockPath = cleanOptionalString(answer.draftBlock?.path)
    ?? cleanOptionalString(answer.draftBlockId)
    ?? previous?.draftBlockPath;
  const contextPackId = cleanOptionalString(answer.contextPackId) ?? previous?.contextPackId;
  const summary = summarizeAnswer(answer.answer ?? answer.text ?? '');
  const outputColumns = normalizeOutputColumns(answer.result?.columns);
  const requestedDimensions = mergeTextArrays(
    previous?.requestedDimensions,
    answer.analysisPlan?.dimensions,
    answer.evidence?.analysisPlan?.dimensions,
  );
  const requestedFilters = mergeTextArrays(previous?.requestedFilters, inferFilters(sourceQuestion));
  if (!sourceCertifiedBlock && !draftBlockPath && !contextPackId && !summary) return undefined;
  return {
    activeSurface,
    sourceCertifiedBlock,
    sourceQuestion: sourceQuestion.trim(),
    sourceAnswerSummary: summary,
    requestedFilters,
    requestedDimensions,
    outputColumns: outputColumns.length > 0 ? outputColumns : previous?.outputColumns,
    trustLabel: cleanOptionalString(answer.trustLabel) ?? previous?.trustLabel,
    reviewStatus: cleanOptionalString(answer.reviewStatus) ?? previous?.reviewStatus,
    certification: cleanOptionalString(answer.certification) ?? previous?.certification,
    route: cleanOptionalString(answer.kind) ?? previous?.route,
    contextPackId,
    draftBlockPath,
    selectedEvidence: Array.isArray(answer.selectedEvidence) ? answer.selectedEvidence.slice(0, 16) : previous?.selectedEvidence,
    updatedAt: new Date().toISOString(),
  };
}

function summarizeAnswer(text: string): string | undefined {
  const clean = text
    .replace(/```sql[\s\S]*?```/gi, '')
    .replace(/Proposed SQL:[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, 600) : undefined;
}

function normalizeOutputColumns(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  return columns
    .map((column) => {
      if (typeof column === 'string') return column.trim();
      if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
        return String((column as { name: unknown }).name).trim();
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 24);
}

function inferFilters(question: string): string[] {
  const filters: string[] = [];
  for (const match of question.matchAll(/["']([^"']+)["']/g)) {
    const value = match[1].trim();
    if (value) filters.push(value);
  }
  for (const pattern of [
    /\benterprise\b/i,
    /\bsmall business\b/i,
    /\bmid[- ]market\b/i,
    /\blast week\b/i,
    /\bthis week\b/i,
    /\blast month\b/i,
    /\bthis month\b/i,
    /\blast quarter\b/i,
    /\bthis quarter\b/i,
  ]) {
    const match = question.match(pattern);
    if (match) filters.push(match[0]);
  }
  return Array.from(new Set(filters)).slice(0, 24);
}

function mergeTextArrays(...groups: Array<unknown[] | undefined>): string[] | undefined {
  const values = groups
    .flatMap((group) => group ?? [])
    .map((value) => cleanOptionalString(value))
    .filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(values)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

function sourceBlockNameFromAnswer(answer: AgentAnswerEnvelope): string | undefined {
  return cleanOptionalString(answer.sourceCertifiedBlock)
    ?? firstBlockName(answer.evidence?.selectedAssets)
    ?? firstBlockName(answer.evidence?.lineage)
    ?? firstBlockName(answer.citations)
    ?? cleanOptionalString(answer.result?.blockName)
    ?? cleanOptionalString(answer.block?.name);
}

function firstBlockName(items?: Array<{ kind?: string; name?: string }>): string | undefined {
  return items
    ?.map((item) => (item.kind === 'block' ? cleanOptionalString(item.name) : undefined))
    .find((value): value is string => Boolean(value));
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function toLocalMessages(messages: AppConversationMessage[]): LocalMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    events: Array.isArray(message.events) ? message.events as AgentTurn[] : undefined,
    createdAt: message.createdAt,
  }));
}

function matchesConversationTarget(
  conversation: AppConversation,
  target: { appId: string; dashboardId?: string; notebookPath?: string },
): boolean {
  if (conversation.appId !== target.appId) return false;
  if ((conversation.dashboardId ?? '') !== (target.dashboardId ?? '')) return false;
  if ((conversation.notebookPath ?? '') !== (target.notebookPath ?? '')) return false;
  return true;
}

function previousUserQuestion(messages: LocalMessage[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i].content;
  }
  return undefined;
}

function Bubble({
  message,
  sourceQuestion,
  t,
  live,
  themeMode,
  hideSqlByDefault,
  addToAppTarget,
  onInvestigate,
  executive,
}: {
  message: LocalMessage;
  sourceQuestion?: string;
  t: Theme;
  live?: boolean;
  themeMode: keyof typeof themes;
  hideSqlByDefault: boolean;
  addToAppTarget?: { appId: string; dashboardId: string };
  onInvestigate?: (request: AgentAnswerInvestigationRequest) => void;
  executive?: boolean;
}) {
  const isUser = message.role === 'user';
  const answer = !isUser ? extractGovernedAnswer(message.events ?? []) : null;
  const proposalEvent = !isUser ? latestProposalEvent(message.events) : null;
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
          sourceQuestion={sourceQuestion}
          onInvestigate={onInvestigate}
        />
        {proposalEvent && (
          <ProposalActionCard
            proposal={proposalEvent.proposal}
            governance={proposalEvent.governance}
            t={t}
            addToAppTarget={addToAppTarget}
          />
        )}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignSelf: isUser && executive ? 'flex-end' : 'stretch', maxWidth: isUser && executive ? '88%' : undefined }}>
      <div style={{
        border: `1px solid ${isUser ? `${t.accent}55` : t.headerBorder}`,
        borderRadius: executive ? 12 : 8,
        padding: executive ? '9px 11px' : 10,
        background: isUser ? `${t.accent}12` : t.appBg,
        whiteSpace: isUser ? 'pre-wrap' : 'normal',
        fontSize: executive ? 12.5 : 12,
        lineHeight: 1.5,
      }}>
        <div style={{ fontSize: 10, color: live ? t.accent : t.textMuted, textTransform: 'uppercase', fontWeight: 800, marginBottom: 4 }}>
          {isUser ? 'You' : 'Copilot'}
        </div>
        {isUser ? message.content : <StructuredAnswerText text={message.content} t={t} compact />}
      </div>
      {proposalEvent && (
        <ProposalActionCard
          proposal={proposalEvent.proposal}
          governance={proposalEvent.governance}
          t={t}
          addToAppTarget={addToAppTarget}
        />
      )}
    </div>
  );
}

function ProposalActionCard({
  proposal,
  governance,
  t,
  addToAppTarget,
}: {
  proposal: BlockProposal;
  governance: { certified: boolean; errors: string[]; warnings: string[] };
  t: Theme;
  addToAppTarget?: { appId: string; dashboardId: string };
}) {
  const { state, dispatch } = useNotebook();
  const [busy, setBusy] = useState<'open' | 'add' | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'error' | 'muted'; text: string } | null>(null);
  const path = cleanOptionalString(proposal.path);
  const name = cleanOptionalString(proposal.name)
    ?? path?.split('/').pop()?.replace(/\.dql$/i, '')
    ?? 'draft_block';
  const hasErrors = governance.errors.length > 0;
  const hasWarnings = governance.warnings.length > 0;
  const accent = governance.certified ? '#3fb950' : hasErrors ? '#ff7b72' : '#f0883e';

  const openDraft = async () => {
    if (!path) {
      setStatus({ tone: 'error', text: 'The AI response did not include a saved draft path.' });
      return;
    }
    setBusy('open');
    setStatus(null);
    try {
      const payload = await api.openBlockStudio(path);
      const file: NotebookFile = { name, path, type: 'block', folder: 'blocks' };
      if (!state.files.some((existing) => existing.path === path)) {
        dispatch({ type: 'FILE_ADDED', file });
      }
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
      setStatus({ tone: 'success', text: 'Opened draft block for review.' });
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const addDraftToApp = async () => {
    if (!addToAppTarget) return;
    if (!path) {
      setStatus({ tone: 'error', text: 'The AI response did not include a saved draft path.' });
      return;
    }
    setBusy('add');
    setStatus(null);
    try {
      const doc = await api.getDashboard(addToAppTarget.appId, addToAppTarget.dashboardId);
      if (!doc) throw new Error('Dashboard could not be loaded.');
      const vizType = normalizeProposalViz(proposal.chartType);
      const nextItems = [...doc.dashboard.layout.items];
      const dashboardForPosition = { ...doc.dashboard, layout: { ...doc.dashboard.layout, items: nextItems } };
      nextItems.push({
        i: proposalTileId(dashboardForPosition, name),
        ...proposalTilePosition(dashboardForPosition, proposalTileSize(vizType)),
        block: { ref: path },
        viz: { type: vizType },
        title: name,
      });
      const saved = await api.patchDashboardLayout(addToAppTarget.appId, addToAppTarget.dashboardId, {
        ...doc.dashboard.layout,
        items: nextItems,
      });
      if (!saved.ok) throw new Error(saved.error);
      window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: addToAppTarget }));
      setStatus({ tone: 'success', text: 'Added draft tile to the app for review.' });
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{
      border: `1px solid ${accent}55`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 10,
      background: `${accent}10`,
      padding: '10px 11px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      color: t.textPrimary,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: `${accent}14`,
          border: `1px solid ${accent}45`,
          color: accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
        }}>
          <FileText size={15} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 850 }}>{name}</span>
            <span style={proposalPillStyle(t, accent)}>
              {governance.certified ? 'passes gate' : hasErrors ? 'needs fixes' : 'draft review'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {path ?? 'No draft file path returned'}
          </div>
          {proposal.description && (
            <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45, marginTop: 5 }}>
              {proposal.description}
            </div>
          )}
        </div>
      </div>
      {(hasErrors || hasWarnings) && (
        <div style={{ display: 'grid', gap: 4 }}>
          {governance.errors.slice(0, 2).map((error, index) => (
            <div key={`proposal-error-${index}`} style={{ fontSize: 11.5, color: '#ff7b72', lineHeight: 1.35 }}>
              {error}
            </div>
          ))}
          {governance.warnings.slice(0, 2).map((warning, index) => (
            <div key={`proposal-warning-${index}`} style={{ fontSize: 11.5, color: '#f0883e', lineHeight: 1.35 }}>
              {warning}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void openDraft()}
          disabled={busy !== null || !path}
          style={proposalButtonStyle(t, true, busy !== null || !path)}
        >
          <FileText size={13} />
          <span>{busy === 'open' ? 'Opening...' : 'Open draft'}</span>
        </button>
        {addToAppTarget && (
          <button
            type="button"
            onClick={() => void addDraftToApp()}
            disabled={busy !== null || !path}
            style={proposalButtonStyle(t, false, busy !== null || !path)}
          >
            <Plus size={13} />
            <span>{busy === 'add' ? 'Adding...' : 'Add to app'}</span>
          </button>
        )}
        {proposal.chartType && (
          <span style={{ fontSize: 11, color: t.textMuted }}>
            view: {proposal.chartType}
          </span>
        )}
      </div>
      {status && (
        <div style={{
          fontSize: 11.5,
          color: status.tone === 'success' ? '#3fb950' : status.tone === 'error' ? '#ff7b72' : t.textMuted,
        }}>
          {status.text}
        </div>
      )}
    </div>
  );
}

function proposalPillStyle(t: Theme, accent: string): React.CSSProperties {
  return {
    border: `1px solid ${accent}45`,
    borderRadius: 999,
    background: `${accent}12`,
    color: accent,
    padding: '2px 7px',
    fontSize: 10,
    fontWeight: 850,
    lineHeight: 1.15,
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
    fontFamily: t.font,
  };
}

function proposalButtonStyle(t: Theme, primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    border: `1px solid ${primary ? t.accent : t.headerBorder}`,
    borderRadius: 7,
    background: disabled ? t.appBg : primary ? `${t.accent}18` : t.cellBg,
    color: disabled ? t.textMuted : primary ? t.accent : t.textPrimary,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    fontSize: 11.5,
    fontWeight: 800,
    fontFamily: t.font,
  };
}

function proposalTilePosition(dashboard: { layout: { items: Array<{ y: number; h: number }> } }, size: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const y = dashboard.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { x: 0, y, w: size.w, h: size.h };
}

function proposalTileId(dashboard: { layout: { items: Array<{ i: string }> } }, raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'draft-tile';
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function proposalTileSize(vizType: string): { w: number; h: number } {
  if (vizType === 'kpi' || vizType === 'single_value') return { w: 3, h: 3 };
  if (vizType === 'table' || vizType === 'pivot') return { w: 6, h: 4 };
  return { w: 6, h: 3 };
}

function normalizeProposalViz(value: unknown): string {
  const chart = String(value ?? 'table').toLowerCase().replace(/-/g, '_');
  if (chart === 'single_value' || chart === 'kpi' || chart === 'line' || chart === 'bar' || chart === 'area'
    || chart === 'pie' || chart === 'pivot' || chart === 'map' || chart === 'funnel' || chart === 'table') {
    return chart;
  }
  return 'table';
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

function contextStripStyle(t: Theme, executive = false): React.CSSProperties {
  return {
    margin: executive ? '0 10px 8px' : '0 12px 8px',
    border: `1px solid ${t.headerBorder}`,
    borderRadius: executive ? 10 : 8,
    background: t.appBg,
    color: t.textPrimary,
    padding: executive ? '8px 9px' : '7px 9px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: executive ? 11.5 : 11,
    lineHeight: 1.35,
  };
}

function contextPillStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    border: `1px solid ${t.accent}45`,
    borderRadius: 999,
    color: t.accent,
    background: `${t.accent}12`,
    padding: '2px 7px',
    fontSize: 10,
    fontWeight: 800,
    lineHeight: 1.1,
    whiteSpace: 'nowrap',
  };
}

function contextClearButtonStyle(t: Theme): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 6,
    background: t.cellBg,
    color: t.textSecondary,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flex: '0 0 auto',
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
