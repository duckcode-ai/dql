export type ProviderId = 'claude-agent-sdk' | 'claude-code';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface BlockProposal {
  name: string;
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
  projectRoot: string;
}

export interface AgentRunner {
  run(req: AgentRunRequest, emit: (turn: AgentTurn) => void, signal: AbortSignal): Promise<void>;
}
