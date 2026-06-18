import type { AgentResultPayload, AgentSchemaTable, KGNode } from '@duckcodeailabs/dql-agent';

export type ProviderId = 'anthropic' | 'claude-agent-sdk' | 'claude-code' | 'openai' | 'gemini' | 'ollama' | 'custom-openai';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentConversationContext {
  activeSurface?: 'notebook' | 'block' | 'app' | 'research' | 'chat' | string;
  sourceCertifiedBlock?: string;
  sourceQuestion?: string;
  sourceAnswerSummary?: string;
  followupKind?: 'generic' | 'drilldown';
  requestedFilters?: string[];
  requestedDimensions?: string[];
  outputColumns?: string[];
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  route?: string;
  contextPackId?: string;
  draftBlockPath?: string;
  selectedEvidence?: unknown[];
  updatedAt?: string;
}

export interface BlockProposal {
  name: string;
  path?: string;
  domain: string;
  owner: string;
  description: string;
  sql: string;
  tags?: string[];
  chartType?: string;
}

/**
 * Normalized event a provider streams back for each step of an agent run.
 * The UI renders these in order; the final `proposal` (if any) routes through
 * the governance gate before `/api/blocks/save-from-cell`.
 */
export type AgentTurn =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | { kind: 'proposal'; proposal: BlockProposal; governance: { certified: boolean; errors: string[]; warnings: string[] } }
  | { kind: 'error'; message: string }
  | { kind: 'done'; stopReason?: string };

export interface AgentRunRequest {
  provider: ProviderId;
  messages: ChatTurn[];
  upstream?: { cellId?: string; sql?: string; preview?: unknown };
  conversationContext?: AgentConversationContext;
  projectRoot: string;
  executeCertifiedBlock?: (block: KGNode) => Promise<AgentResultPayload>;
  executeGeneratedSql?: (sql: string) => Promise<AgentResultPayload>;
  getSchemaContext?: (question: string) => Promise<AgentSchemaTable[]>;
}

export interface AgentRunner {
  run(req: AgentRunRequest, emit: (turn: AgentTurn) => void, signal: AbortSignal): Promise<void>;
}

/**
 * Public-facing name for the adapter contract a provider must implement.
 * `AgentRunner` is the internal call site; `LLMProvider` is what community
 * authors target when they add a new `providers/<name>.ts`. Keep in sync.
 */
export type LLMProvider = AgentRunner;
