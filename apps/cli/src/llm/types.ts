import type {
  AgentDqlArtifactReference,
  CascadeAnswerResult,
  AgentResultPayload,
  CertifiedBlockInvocationInput,
  AgentSchemaTable,
  AnalysisDepth,
  ConversationSnapshot,
  KGNode,
  LocalContextPack,
  ReasoningEffort,
} from '@duckcodeailabs/dql-agent';

export type ProviderId = 'anthropic' | 'claude-agent-sdk' | 'claude-code' | 'codex' | 'openai' | 'gemini' | 'ollama' | 'custom-openai';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentConversationContext {
  activeSurface?: 'notebook' | 'block' | 'app' | 'research' | 'chat' | string;
  conversationStateVersion?: number;
  activeTurnId?: string;
  activeTopic?: string;
  conversationSummary?: string;
  /** Server-built bounded snapshot: recent turns, semantic recall, working state, and topic relation. */
  serverSnapshot?: ConversationSnapshot;
  turns?: AgentConversationTurn[];
  sourceAnswerId?: string;
  sourceCertifiedBlock?: string;
  sourceQuestion?: string;
  sourceAnswerSummary?: string;
  followupKind?: 'generic' | 'drilldown' | 'contextual';
  requestedFilters?: string[];
  requestedDimensions?: string[];
  answerContract?: unknown;
  resultColumns?: string[];
  resultRowsSample?: Record<string, unknown>[];
  resultDimensionValues?: Record<string, string[]>;
  appliedFilters?: Record<string, unknown>;
  priorLimit?: number;
  priorMeasures?: string[];
  outputColumns?: string[];
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  route?: string;
  contextPackId?: string;
  draftBlockPath?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
  selectedEvidence?: unknown[];
  sourceSql?: string;
  updatedAt?: string;
}

export interface AgentConversationTurn {
  id: string;
  question: string;
  answerSummary?: string;
  completedAt?: string;
  artifactKind?: string;
  sourceCertifiedBlock?: string;
  route?: string;
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  contextPackId?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
  requestedFilters?: string[];
  requestedDimensions?: string[];
  requestedMeasures?: string[];
  answerContract?: unknown;
  topN?: number;
  result?: {
    columns?: string[];
    rowsSample?: Record<string, unknown>[];
    dimensionValues?: Record<string, string[]>;
    measureColumns?: string[];
    rowCount?: number;
  };
  sourceSql?: string;
}

export interface BlockProposal {
  name: string;
  path?: string;
  domain: string;
  owner: string;
  description: string;
  sql: string;
  blockType?: 'custom' | 'semantic';
  dqlSource?: string;
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ dimension: string; operator: string; values: string[] }>;
  timeDimension?: { name: string; granularity: string };
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
  /**
   * Reasoning effort for this run (low/medium/high). Resolved upstream from the
   * engine's per-route effort clamped by the provider's Settings ceiling; the
   * SDK runners translate it into their native param and no-op when unsupported.
   */
  reasoningEffort?: ReasoningEffort;
  /** Context/prompt depth for governed Ask AI. Research routes pass deep. */
  analysisDepth?: AnalysisDepth;
  projectRoot: string;
  executeCertifiedBlock?: (block: KGNode, invocation?: CertifiedBlockInvocationInput) => Promise<AgentResultPayload>;
  executeGeneratedSql?: (sql: string) => Promise<AgentResultPayload>;
  getSchemaContext?: (question: string, contextPack?: LocalContextPack) => Promise<AgentSchemaTable[]>;
  /** Active warehouse dialect so Lane-2 semantic compiles emit dialect-correct SQL. */
  semanticDriver?: string;
  /** Logical->physical table mapping for the semantic compiler, when resolved. */
  semanticTableMapping?: Record<string, string>;
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
