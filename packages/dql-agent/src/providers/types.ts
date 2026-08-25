/**
 * Pluggable LLM provider interface for the agent.
 *
 * Providers are intentionally tiny — they take a system+user message pair
 * and return a string response. Streaming and tool-use orchestration are
 * intentionally out of scope at this layer; the answer-loop owns that
 * orchestration on top of the provider.
 *
 * Each provider is implementation-detail-free: it reads its config from
 * env vars and an optional user-supplied object, and uses `fetch` so we
 * stay zero-dep at the package level. Network-bound failures bubble out as
 * thrown Errors with provider-prefixed messages.
 */

export type ProviderName = 'claude' | 'openai' | 'gemini' | 'ollama';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ProviderDispatchOperation = 'generate' | 'generate_with_tools' | 'generate_stream';

/** Exact provider-native envelope observed immediately before one HTTP send. */
export interface ProviderDispatchEvent {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  /** One-based attempt number within this provider method invocation. */
  attemptIndex: number;
  model?: string;
  options?: {
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: import('./reasoning-effort.js').ReasoningEffort;
  };
  envelope: Record<string, unknown>;
}

/**
 * The observer returns the normalized envelope that must be sent. This makes
 * guarding/accounting part of the transport boundary instead of an outer-call
 * approximation.
 */
export type ProviderDispatchObserver = (event: ProviderDispatchEvent) => Record<string, unknown>;

/** Content-free completion observation for one already-admitted physical send. */
export interface ProviderDispatchCompletionEvent {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  model?: string;
  outcome: 'ok' | 'error' | 'cancelled';
  /**
   * The physical boundary which just settled. A successful transport/process
   * observation is deliberately not a successful provider result: parsers and
   * stream consumers can still fail afterwards. Existing providers that do
   * not report this field retain the historical final-result interpretation.
   */
  settlement?: 'transport' | 'process' | 'result';
  httpStatus?: number;
  /** Runtime-only classification input. Observers must never persist this raw value. */
  error?: unknown;
}

export type ProviderDispatchCompletionObserver = (event: ProviderDispatchCompletionEvent) => void;

/** A send that was refused before an HTTP request was admitted. */
export interface ProviderDispatchRejectionEvent {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  model?: string;
  /** Runtime-only classification input; trace observers persist only its typed diagnostic. */
  error: unknown;
}

export type ProviderDispatchRejectionObserver = (event: ProviderDispatchRejectionEvent) => void;

export interface ProviderRunOptions {
  /** Optional model override; otherwise the provider picks a sane default. */
  model?: string;
  /** Hard token cap. */
  maxTokens?: number;
  /** Sampling temperature (0..1). */
  temperature?: number;
  /**
   * Reasoning effort (low/medium/high). Providers with a reasoning surface
   * translate it into their native param; the rest ignore it. See
   * `./reasoning-effort.ts`.
   */
  reasoningEffort?: import('./reasoning-effort.js').ReasoningEffort;
  /** Caller-supplied AbortSignal — providers honor it. */
  signal?: AbortSignal;
  /** Hard cap covering compatibility retries and native tool follow-ups. */
  maxProviderDispatches?: number;
  /** Server-owned hook invoked immediately before every provider HTTP body send. */
  onProviderDispatch?: ProviderDispatchObserver;
  /** Server-owned hook invoked when that same physical HTTP send settles. */
  onProviderDispatchComplete?: ProviderDispatchCompletionObserver;
  /** Server-owned hook invoked when admission rejects a would-be physical send. */
  onProviderDispatchRejected?: ProviderDispatchRejectionObserver;
  /**
   * Server-owned lifecycle label for the physical send.  Providers must carry
   * this through untouched; the local runtime is the only authority that maps
   * it to an egress receipt and a trace span.  It exists so an immutable
   * exploratory-plan correction cannot be miscounted as a second generation.
   */
  dispatchPhase?: import('@duckcodeailabs/dql-core').ProviderDispatchPhaseV1;
  /**
   * Server-owned egress purpose paired with {@link dispatchPhase}.  Ordinary
   * Ask generation remains content-free; the only normal Ask repair purpose is
   * `repair_sql` and it has no result-row permission.
   */
  egressPurpose?: import('@duckcodeailabs/dql-core').ProviderEgressPurpose;
  /**
   * Server-owned lineage marker for one same-provider transient transport
   * retry. Providers carry it through to the local ledger; callers cannot use
   * it to reopen planning or route selection.
   */
  retryOfAttemptIndex?: number;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown): Promise<unknown>;
}

export interface ProviderToolLoopOptions extends ProviderRunOptions {
  /** Hard cap for provider-visible tool calls in this turn. Default 8. */
  maxToolCalls?: number;
  /** Optional trace hook for tests/UI instrumentation. `durationMs` is the tool's wall-clock time. */
  onToolCall?: (event: { name: string; input: unknown; output?: unknown; isError?: boolean; durationMs?: number }) => void;
  /** Run-budget guard checked immediately before each physical tool branch. */
  mayStartToolCall?: () => boolean;
  /** Server-owned result-row egress policy applied recursively to every tool output. */
  providerPayloadGuard?: {
    purpose: import('@duckcodeailabs/dql-core').ProviderEgressPurpose;
    allowedResultRowTools?: Record<string, number>;
    resultRowBudgetGroupByTool?: Record<string, string>;
    cumulativeResultRowBudgets?: Record<string, number>;
    onPayload?: (event: {
      toolName: string;
      output: unknown;
      resultRowCount: number;
      columnCount: number;
      cumulativeResultRowCount: number;
      budgetGroup: string;
      budgetExhausted: boolean;
    }) => void;
  };
}

export interface AgentProvider {
  readonly name: ProviderName;
  /**
   * Send the conversation, return a single response string.
   * Throws on transport / API errors.
   */
  generate(messages: AgentMessage[], options?: ProviderRunOptions): Promise<string>;
  /**
   * Optional bounded tool loop. Providers that implement native tool use should
   * call supplied tools, append their observations, and resolve with the final
   * assistant text. Callers must keep a one-shot generate() fallback.
   */
  generateWithTools?(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    options?: ProviderToolLoopOptions,
  ): Promise<string>;
  /**
   * Optional token streaming. Calls `onDelta` with each text chunk as it arrives
   * and resolves with the full concatenated text. Providers that omit this fall
   * back to `generate()` via {@link streamOrGenerate}.
   */
  generateStream?(
    messages: AgentMessage[],
    options: ProviderRunOptions,
    onDelta: (delta: string) => void,
  ): Promise<string>;
  /** True if this provider has all the credentials/binaries it needs. */
  available(): Promise<boolean>;
}

/**
 * Stream if the provider supports it, else generate once and emit the whole text
 * as a single delta. Degradation is structural — callers always get the full text
 * and at least one delta.
 */
export async function streamOrGenerate(
  provider: AgentProvider,
  messages: AgentMessage[],
  options: ProviderRunOptions,
  onDelta: (delta: string) => void,
): Promise<string> {
  if (provider.generateStream) {
    return provider.generateStream(messages, options, onDelta);
  }
  const text = await provider.generate(messages, options);
  if (text) onDelta(text);
  return text;
}
