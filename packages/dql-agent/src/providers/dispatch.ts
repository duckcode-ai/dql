import type {
  ProviderDispatchOperation,
  ProviderName,
  ProviderRunOptions,
} from './types.js';

export const DEFAULT_PROVIDER_DISPATCH_LIMIT = 2;

/**
 * Enforce the physical-send budget and return the exact envelope to serialize.
 * The observer runs even when fetch will reject for cancellation or transport
 * failure, so attempted dispatches have matching counters and receipts.
 */
export function prepareProviderHttpDispatch(input: {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  envelope: Record<string, unknown>;
  options: ProviderRunOptions;
}): Record<string, unknown> {
  const limit = Math.max(1, Math.min(30, input.options.maxProviderDispatches ?? DEFAULT_PROVIDER_DISPATCH_LIMIT));
  if (input.attemptIndex > limit) {
    throw Object.assign(new Error(
      `${input.provider}: provider dispatch budget exhausted after ${limit} attempt${limit === 1 ? '' : 's'}`,
    ), { code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' });
  }
  return input.options.onProviderDispatch?.({
    provider: input.provider,
    operation: input.operation,
    attemptIndex: input.attemptIndex,
    ...(input.options.model ? { model: input.options.model } : {}),
    options: {
      ...(input.options.maxTokens !== undefined ? { maxTokens: input.options.maxTokens } : {}),
      ...(input.options.temperature !== undefined ? { temperature: input.options.temperature } : {}),
      ...(input.options.reasoningEffort ? { reasoningEffort: input.options.reasoningEffort } : {}),
    },
    envelope: input.envelope,
  }) ?? input.envelope;
}
