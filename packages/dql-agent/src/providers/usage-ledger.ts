import { appendFileSync } from 'node:fs';
import type { ProviderName } from './types.js';

/**
 * THE PROVIDER USAGE LEDGER. What each API call cost, in tokens, for a run
 * that asks for it: with `DQL_PROVIDER_USAGE_LEDGER=<file>` set, every
 * successful HTTP provider call appends one JSON line. Nothing is written
 * otherwise, and the ledger never holds prompt or reply text. A benchmark
 * prices the lines per question from the run store's own start and end times;
 * subscription command-line providers report no usage and write nothing.
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens read from the provider's cache (billed at the cache-read price). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache (billed at the cache-write price). */
  cacheWriteTokens?: number;
  /** Output tokens spent on reasoning, when the provider reports them apart. */
  reasoningTokens?: number;
}

export interface ProviderUsageLine extends ProviderUsage {
  at: string;
  provider: ProviderName;
  model?: string;
  operation: string;
}

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The usage block of a provider's JSON reply, in one shape; undefined when it has none. */
export function extractProviderUsage(provider: ProviderName, body: unknown): ProviderUsage | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const reply = body as Record<string, any>;
  if (provider === 'claude') {
    const usage = reply.usage;
    if (!usage || count(usage.input_tokens) === undefined) return undefined;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: count(usage.output_tokens) ?? 0,
      ...(count(usage.cache_read_input_tokens) ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
      ...(count(usage.cache_creation_input_tokens) ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
    };
  }
  if (provider === 'openai') {
    const usage = reply.usage;
    if (!usage) return undefined;
    // Chat Completions names them prompt/completion; the Responses API input/output.
    const input = count(usage.prompt_tokens) ?? count(usage.input_tokens);
    if (input === undefined) return undefined;
    const cached = count(usage.prompt_tokens_details?.cached_tokens) ?? count(usage.input_tokens_details?.cached_tokens);
    const reasoning = count(usage.completion_tokens_details?.reasoning_tokens) ?? count(usage.output_tokens_details?.reasoning_tokens);
    return {
      inputTokens: input,
      outputTokens: count(usage.completion_tokens) ?? count(usage.output_tokens) ?? 0,
      ...(cached ? { cacheReadTokens: cached } : {}),
      ...(reasoning ? { reasoningTokens: reasoning } : {}),
    };
  }
  if (provider === 'gemini') {
    const usage = reply.usageMetadata;
    if (!usage || count(usage.promptTokenCount) === undefined) return undefined;
    const thoughts = count(usage.thoughtsTokenCount);
    return {
      inputTokens: usage.promptTokenCount,
      // Gemini bills thinking as output, reported apart from the candidates.
      outputTokens: (count(usage.candidatesTokenCount) ?? 0) + (thoughts ?? 0),
      ...(count(usage.cachedContentTokenCount) ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
      ...(thoughts ? { reasoningTokens: thoughts } : {}),
    };
  }
  if (provider === 'ollama') {
    // A local model costs nothing per token; the counts still show whether a
    // prompt fitted the context window.
    if (count(reply.prompt_eval_count) === undefined) return undefined;
    return { inputTokens: reply.prompt_eval_count, outputTokens: count(reply.eval_count) ?? 0 };
  }
  return undefined;
}

/**
 * Record a successful call's usage when the ledger is on. Reads a clone of the
 * response, so the caller's body is untouched; any failure here is swallowed,
 * because accounting must never break the call it accounts for.
 */
export function recordProviderUsage(input: { provider: ProviderName; operation: string; model?: string; response: Response }, env: NodeJS.ProcessEnv = process.env): void {
  const file = env.DQL_PROVIDER_USAGE_LEDGER;
  if (!file || !input.response.ok) return;
  if (!/json/i.test(input.response.headers.get('content-type') ?? '')) return;
  void input.response.clone().json().then((body) => {
    const usage = extractProviderUsage(input.provider, body);
    if (!usage) return;
    const line: ProviderUsageLine = { at: new Date().toISOString(), provider: input.provider, ...(input.model ? { model: input.model } : {}), operation: input.operation, ...usage };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  }).catch(() => undefined);
}
