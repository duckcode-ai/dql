import type { ProviderName } from './types.js';

/**
 * Reasoning effort — the single, provider-agnostic knob the agent uses to trade
 * latency/cost against answer quality. Each provider translates it into its own
 * native parameter (Anthropic `output_config.effort`, OpenAI `reasoning_effort` /
 * Responses `reasoning.effort`, Gemini `thinkingConfig`). Providers that have no
 * reasoning surface (Ollama, subscription CLIs) simply ignore it.
 *
 * The abstraction mirrors the coding-extension's model so the two products speak
 * the same language, but stays deliberately light: no full model registry, just
 * the capability checks and budget mappings the loop actually needs.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'] as const;

/** Narrowing type-guard for untrusted input (settings JSON, env vars, request bodies). */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

/** Coerce untrusted input to a valid effort, or `undefined` when unset/invalid. */
export function coerceReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value == null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  return isReasoningEffort(normalized) ? normalized : undefined;
}

const RANK: Record<ReasoningEffort, number> = { low: 0, medium: 1, high: 2 };

/**
 * Clamp a desired effort to a ceiling. The user's global Settings choice acts as
 * the ceiling; the engine's per-route effort is the desired value. So "Low"
 * globally is always honored, while "High" lets the engine pick per task.
 */
export function clampReasoningEffort(desired: ReasoningEffort, ceiling: ReasoningEffort): ReasoningEffort {
  return RANK[desired] <= RANK[ceiling] ? desired : ceiling;
}

/** Bump one level (a failed cheap pass earns more reasoning on the repair). Saturates at `high`. */
export function bumpReasoningEffort(effort: ReasoningEffort): ReasoningEffort {
  return effort === 'low' ? 'medium' : 'high';
}

/**
 * Whether a provider+model actually accepts a reasoning parameter. Gating here
 * keeps us from sending an unsupported field to a model that would reject the
 * request (e.g. `gpt-4.1-mini`, older Claude, plain Gemini Flash).
 */
export function supportsReasoningEffort(provider: ProviderName, model: string | undefined): boolean {
  const m = (model ?? '').toLowerCase();
  switch (provider) {
    case 'claude':
      // `output_config.effort` is supported on Opus 4.5+, Sonnet 4.6+, Sonnet 5+,
      // and Fable 5+ (and explicit `:thinking` virtual ids). It is REJECTED on
      // Sonnet 4.5 and Haiku 4.5, so those must not match — a false positive here
      // 400s the request. Kept intentionally conservative; a defensive retry in
      // ClaudeProvider strips the field if a model/gateway still rejects it.
      if (m.includes(':thinking')) return true;
      if (/opus-4-([5-9]|\d\d)/.test(m) || /opus-[5-9]/.test(m)) return true;
      if (/sonnet-4-([6-9]|\d\d)/.test(m) || /sonnet-[5-9]/.test(m)) return true;
      if (/fable-[5-9]/.test(m)) return true;
      return false;
    case 'openai':
      // o-series (o1, o3, o4-mini, …) and the gpt-5 family take reasoning_effort.
      // Allow a leading provider namespace (e.g. `openai/o3-mini`).
      return /(^|\/)o\d/.test(m) || m.includes('gpt-5') || m.includes('gpt5');
    case 'gemini':
      return geminiReasoningStyle(model) !== null;
    default:
      return false;
  }
}

/**
 * Gemini exposes reasoning two ways depending on generation: 2.5 takes a token
 * `thinkingBudget`; 3.x takes a `thinkingLevel` effort string. Returns which (or
 * `null` when the model has no thinking surface).
 */
export type GeminiReasoningStyle = 'budget' | 'level';

export function geminiReasoningStyle(model: string | undefined): GeminiReasoningStyle | null {
  const m = (model ?? '').toLowerCase();
  if (m.includes('gemini-3')) return 'level';
  if (m.includes('gemini-2.5') || m.includes('flash-thinking')) return 'budget';
  return null;
}

/** Token budgets for budget-style thinking providers (Anthropic-native / Gemini 2.5). */
const EFFORT_BUDGET: Record<ReasoningEffort, number> = { low: 2048, medium: 8192, high: 16384 };

/**
 * Map effort → a thinking-token budget, kept strictly below the answer's
 * `maxTokens` (with headroom) so the budget can never starve the response.
 * Anthropic requires a floor of 1024.
 */
export function effortToThinkingBudget(effort: ReasoningEffort, maxTokens?: number): number {
  const base = EFFORT_BUDGET[effort];
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    return Math.max(1024, Math.min(base, Math.floor(maxTokens * 0.8)));
  }
  return base;
}
