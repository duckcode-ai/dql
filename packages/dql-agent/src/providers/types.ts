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

export interface ProviderRunOptions {
  /** Optional model override; otherwise the provider picks a sane default. */
  model?: string;
  /** Hard token cap. */
  maxTokens?: number;
  /** Sampling temperature (0..1). */
  temperature?: number;
  /** Caller-supplied AbortSignal — providers honor it. */
  signal?: AbortSignal;
}

export interface AgentProvider {
  readonly name: ProviderName;
  /**
   * Send the conversation, return a single response string.
   * Throws on transport / API errors.
   */
  generate(messages: AgentMessage[], options?: ProviderRunOptions): Promise<string>;
  /** True if this provider has all the credentials/binaries it needs. */
  available(): Promise<boolean>;
}
