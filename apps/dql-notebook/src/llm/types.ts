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

export type AgentTurn =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | {
      kind: 'proposal';
      proposal: BlockProposal;
      governance: { certified: boolean; errors: string[]; warnings: string[] };
    }
  | { kind: 'error'; message: string }
  | { kind: 'done'; stopReason?: string };
