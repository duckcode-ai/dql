import React, { useRef, useState } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import { useNotebook } from '../../store/NotebookStore';
import type {
  Cell,
  ChatCellConfig,
  ChatMessage,
  ChatProviderId,
  ChatBlockProposalSnapshot,
  ThemeMode,
} from '../../store/types';
import { runAgent } from '../../llm/client';
import type { AgentTurn } from '../../llm/types';
import { SaveAsBlockModal } from '../modals/SaveAsBlockModal';

interface ChatCellProps {
  cell: Cell;
  cells: Cell[];
  index: number;
  themeMode: ThemeMode;
  onUpdate: (updates: Partial<Cell>) => void;
}

const PROVIDERS: Array<{ id: ChatProviderId; label: string; hint: string }> = [
  { id: 'claude-agent-sdk', label: 'Claude Agent SDK', hint: 'Uses ANTHROPIC_API_KEY / ~/.dql/credentials' },
  { id: 'claude-code', label: 'Claude Code', hint: 'Spawns `claude -p` — uses your Claude Code auth' },
];

function genId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function findUpstreamSql(cells: Cell[], index: number, handle?: string): string | undefined {
  if (handle) {
    const named = cells.find((c) => c.name === handle);
    if (named?.content) return named.content;
  }
  for (let i = index - 1; i >= 0; i--) {
    const c = cells[i];
    if ((c.type === 'sql' || c.type === 'dql') && c.content) return c.content;
  }
  return undefined;
}

export function ChatCell({ cell, cells, index, themeMode, onUpdate }: ChatCellProps) {
  const { dispatch } = useNotebook();
  const t = themes[themeMode];
  const config: ChatCellConfig = cell.chatConfig ?? { provider: 'claude-agent-sdk', history: [] };

  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [pendingEvents, setPendingEvents] = useState<AgentTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const updateConfig = (patch: Partial<ChatCellConfig>) => {
    onUpdate({ chatConfig: { ...config, ...patch } });
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || running) return;
    const userMsg: ChatMessage = { id: genId(), role: 'user', content: text };
    const assistantMsg: ChatMessage = { id: genId(), role: 'assistant', content: '', events: [] };
    const nextHistory = [...config.history, userMsg, assistantMsg];
    updateConfig({ history: nextHistory });
    setInput('');
    setStreamingText('');
    setPendingEvents([]);
    setError(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let accText = '';
    const events: AgentTurn[] = [];
    let proposalSnapshot: ChatBlockProposalSnapshot | undefined;

    try {
      await runAgent(
        {
          provider: config.provider,
          messages: [...config.history, userMsg].map((m) => ({ role: m.role, content: m.content })),
          upstream: { cellId: cell.id, sql: findUpstreamSql(cells, index, config.upstream) },
          signal: controller.signal,
        },
        (turn) => {
          events.push(turn);
          setPendingEvents([...events]);
          if (turn.kind === 'text') {
            accText += turn.text;
            setStreamingText(accText);
          } else if (turn.kind === 'error') {
            setError(turn.message);
          } else if (turn.kind === 'proposal') {
            proposalSnapshot = {
              ...turn.proposal,
              certified: turn.governance.certified,
              errors: turn.governance.errors,
              warnings: turn.governance.warnings,
            };
          }
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      const finalHistory = nextHistory.map((m) =>
        m.id === assistantMsg.id
          ? { ...m, content: accText, events: events.map((e) => ({ kind: e.kind, payload: e })) }
          : m,
      );
      onUpdate({
        chatConfig: {
          ...config,
          history: finalHistory,
          lastProposal: proposalSnapshot ?? config.lastProposal,
        },
      });
      setRunning(false);
      setStreamingText('');
      setPendingEvents([]);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleClear = () => {
    updateConfig({ history: [], lastProposal: undefined });
  };

  const proposal = config.lastProposal;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', background: t.cellBg, fontFamily: t.font }}>
      <ChatHeader
        cell={cell}
        provider={config.provider}
        onProviderChange={(p) => updateConfig({ provider: p })}
        onClear={config.history.length > 0 ? handleClear : undefined}
        t={t}
      />

      {config.history.length === 0 && !running && (
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>
          Ask for a metric, a comparison, or a dashboard. The agent searches blocks, checks the semantic
          layer, and proposes a governed block when you're ready.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {config.history.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} t={t} />
        ))}
        {running && (
          <LiveBubble streamingText={streamingText} events={pendingEvents} t={t} />
        )}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: '#ff7b72', padding: '6px 10px', background: '#ff7b7218', borderRadius: 4 }}>
          {error}
        </div>
      )}

      {proposal && (
        <ProposalCard
          proposal={proposal}
          t={t}
          onOpen={() => setProposalOpen(true)}
          onDismiss={() => updateConfig({ lastProposal: undefined })}
        />
      )}

      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={handleStop}
        running={running}
        t={t}
      />

      {proposalOpen && proposal && (
        <SaveAsBlockModal
          cell={cell}
          initialContent={proposal.sql}
          initialName={proposal.name}
          initialDescription={proposal.description}
          initialTags={proposal.tags}
          onClose={() => setProposalOpen(false)}
          onSaved={({ path, name }) => {
            setProposalOpen(false);
            updateConfig({ lastProposal: undefined });
            dispatch({
              type: 'FILE_ADDED',
              file: { name, path, type: 'block', folder: 'blocks' },
            });
          }}
        />
      )}
    </div>
  );
}

function ChatHeader({
  cell,
  provider,
  onProviderChange,
  onClear,
  t,
}: {
  cell: Cell;
  provider: ChatProviderId;
  onProviderChange: (p: ChatProviderId) => void;
  onClear?: () => void;
  t: Theme;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          fontSize: 10,
          fontFamily: t.fontMono,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: '#f0883e',
          textTransform: 'uppercase',
          padding: '2px 6px',
          borderRadius: 3,
          background: '#f0883e18',
        }}
      >
        Chat
      </span>
      {cell.name && <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>}
      <select
        value={provider}
        onChange={(e) => onProviderChange(e.target.value as ChatProviderId)}
        title={PROVIDERS.find((p) => p.id === provider)?.hint}
        style={{
          marginLeft: 'auto',
          fontSize: 11,
          fontFamily: t.fontMono,
          padding: '3px 6px',
          background: t.cellBg,
          color: t.textSecondary,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 4,
        }}
      >
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      {onClear && (
        <button
          onClick={onClear}
          style={{
            fontSize: 11,
            padding: '3px 8px',
            background: 'transparent',
            color: t.textSecondary,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

function MessageBubble({ msg, t }: { msg: ChatMessage; t: Theme }) {
  const isUser = msg.role === 'user';
  const events = (msg.events ?? []).map((e) => e.payload as AgentTurn);
  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        background: isUser ? `${t.accent}14` : t.cellBg,
        border: `1px solid ${isUser ? `${t.accent}40` : t.cellBorder}`,
        fontSize: 13,
        lineHeight: 1.5,
        color: t.textPrimary,
        whiteSpace: 'pre-wrap',
      }}
    >
      <div style={{ fontSize: 10, fontFamily: t.fontMono, color: t.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {isUser ? 'You' : 'Assistant'}
      </div>
      {msg.content || (events.length > 0 ? <em style={{ color: t.textSecondary }}>(tool calls only)</em> : null)}
      {events.filter((e) => e.kind === 'tool_call').map((e) => (
        <ToolCallChip key={`tc-${(e as { id: string }).id}`} turn={e} t={t} />
      ))}
    </div>
  );
}

function LiveBubble({ streamingText, events, t }: { streamingText: string; events: AgentTurn[]; t: Theme }) {
  return (
    <div style={{ padding: '8px 12px', borderRadius: 6, background: t.cellBg, border: `1px solid ${t.cellBorder}`, fontSize: 13, lineHeight: 1.5, color: t.textPrimary, whiteSpace: 'pre-wrap' }}>
      <div style={{ fontSize: 10, fontFamily: t.fontMono, color: t.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Assistant <span style={{ color: t.accent }}>●</span>
      </div>
      {streamingText || <em style={{ color: t.textSecondary }}>Thinking…</em>}
      {events.filter((e) => e.kind === 'tool_call').map((e) => (
        <ToolCallChip key={`live-${(e as { id: string }).id}`} turn={e} t={t} />
      ))}
    </div>
  );
}

function ToolCallChip({ turn, t }: { turn: AgentTurn; t: Theme }) {
  if (turn.kind !== 'tool_call') return null;
  return (
    <div style={{ marginTop: 6, fontSize: 11, fontFamily: t.fontMono, color: t.textSecondary, padding: '4px 8px', background: t.cellBorder, borderRadius: 4, display: 'inline-block' }}>
      🔧 {turn.name}({JSON.stringify(turn.input).slice(0, 80)}{JSON.stringify(turn.input).length > 80 ? '…' : ''})
    </div>
  );
}

function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  running,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  t: Theme;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder="Ask for a metric or dashboard — ⌘↵ to send"
        rows={2}
        style={{
          flex: 1,
          resize: 'vertical',
          minHeight: 44,
          padding: '8px 10px',
          fontSize: 13,
          fontFamily: t.font,
          background: t.cellBg,
          color: t.textPrimary,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 6,
        }}
      />
      {running ? (
        <button
          onClick={onStop}
          style={{
            padding: '8px 14px',
            fontSize: 12,
            background: '#ff7b7218',
            color: '#ff7b72',
            border: '1px solid #ff7b72',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Stop
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={!value.trim()}
          style={{
            padding: '8px 14px',
            fontSize: 12,
            background: value.trim() ? `${t.accent}28` : 'transparent',
            color: value.trim() ? t.accent : t.textMuted,
            border: `1px solid ${value.trim() ? t.accent : t.cellBorder}`,
            borderRadius: 6,
            cursor: value.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Send
        </button>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  t,
  onOpen,
  onDismiss,
}: {
  proposal: ChatBlockProposalSnapshot;
  t: Theme;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const pills: Array<{ id: string; label: string; passed: boolean; severity: 'error' | 'warning' }> = [
    { id: 'has-name', label: 'Name', passed: !!proposal.name, severity: 'error' },
    { id: 'has-description', label: 'Description', passed: !!proposal.description, severity: 'error' },
    { id: 'has-owner', label: 'Owner', passed: !!proposal.owner, severity: 'error' },
    { id: 'has-domain', label: 'Domain', passed: !!proposal.domain, severity: 'error' },
    { id: 'has-sql', label: 'SQL', passed: !!proposal.sql, severity: 'error' },
  ];
  return (
    <div
      style={{
        border: `1px solid ${proposal.certified ? '#3fb950' : t.cellBorder}`,
        borderLeft: `3px solid ${proposal.certified ? '#3fb950' : '#f0883e'}`,
        borderRadius: 6,
        padding: '10px 12px',
        background: proposal.certified ? '#3fb95010' : '#f0883e10',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, fontFamily: t.fontMono, fontWeight: 700, letterSpacing: '0.08em', color: proposal.certified ? '#3fb950' : '#f0883e', textTransform: 'uppercase' }}>
          Block Proposal
        </span>
        <span style={{ fontSize: 13, fontFamily: t.fontMono, color: t.textPrimary }}>{proposal.name}</span>
        {proposal.domain && <span style={{ fontSize: 11, color: t.textSecondary }}>· {proposal.domain}</span>}
        <button
          onClick={onDismiss}
          style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 6px', background: 'transparent', color: t.textMuted, border: 'none', cursor: 'pointer' }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {pills.map((p) => (
          <span
            key={p.id}
            style={{
              fontSize: 10,
              fontFamily: t.fontMono,
              padding: '2px 6px',
              borderRadius: 3,
              background: p.passed ? '#3fb95020' : '#ff7b7220',
              color: p.passed ? '#3fb950' : '#ff7b72',
              border: `1px solid ${p.passed ? '#3fb95040' : '#ff7b7240'}`,
            }}
          >
            {p.passed ? '✓' : '✕'} {p.label}
          </span>
        ))}
      </div>
      {proposal.description && (
        <div style={{ fontSize: 12, color: t.textSecondary }}>{proposal.description}</div>
      )}
      <div>
        <button
          onClick={onOpen}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            background: `${t.accent}28`,
            color: t.accent,
            border: `1px solid ${t.accent}`,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Review & Save as Block
        </button>
      </div>
    </div>
  );
}
