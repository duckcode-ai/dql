import type {
  ProviderDispatchCompletionEvent,
  ProviderDispatchOperation,
  ProviderName,
  ProviderRunOptions,
} from './types.js';

/**
 * The physical ceiling on sends from one provider call when the caller sets no
 * `maxProviderDispatches`. This is a backstop against a runaway loop, not a
 * budget: the run-scoped dispatch ledger is the only authority on how many
 * sends a turn may make, and a caller that wants a tighter bound states it.
 * (A silent default of two ended real turns mid-discovery for months.)
 */
export const PROVIDER_DISPATCH_PHYSICAL_CEILING = 30;

export function providerDispatchLimit(options: ProviderRunOptions): number {
  return Math.max(1, Math.min(PROVIDER_DISPATCH_PHYSICAL_CEILING, options.maxProviderDispatches ?? PROVIDER_DISPATCH_PHYSICAL_CEILING));
}

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
  const limit = providerDispatchLimit(input.options);
  if (input.attemptIndex > limit) {
    const error = Object.assign(new Error(
      `${input.provider}: provider dispatch budget exhausted after ${limit} attempt${limit === 1 ? '' : 's'}`,
    ), { code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' });
    try {
      input.options.onProviderDispatchRejected?.({
        provider: input.provider,
        operation: input.operation,
        attemptIndex: input.attemptIndex,
        ...(input.options.model ? { model: input.options.model } : {}),
        error,
      });
    } catch {
      // A local observation is never allowed to influence admission.
    }
    throw error;
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

/**
 * Emit a content-free observation when a physical send settles. This stays
 * outside provider receipts and does not affect admission, retries, or the
 * wire payload. It exists so a local trace can close the span started by the
 * matching `onProviderDispatch` callback with its real outcome and duration.
 */
export function completeProviderHttpDispatch(input: {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  options: ProviderRunOptions;
}, completion: Omit<ProviderDispatchCompletionEvent, 'provider' | 'operation' | 'attemptIndex' | 'model'>): void {
  try {
    input.options.onProviderDispatchComplete?.({
      provider: input.provider,
      operation: input.operation,
      attemptIndex: input.attemptIndex,
      ...(input.options.model ? { model: input.options.model } : {}),
      ...completion,
    });
  } catch {
    // Observation must never turn a completed provider request into a failed
    // Ask run. The call site still owns the actual transport result.
  }
}

/**
 * Shared physical send wrapper. Providers still own parsing and retry policy;
 * this reports the actual transport settlement only. A 2xx response is not a
 * successful provider result until the provider has consumed/validated it.
 */
export async function fetchProviderHttpDispatch(input: {
  provider: ProviderName;
  operation: ProviderDispatchOperation;
  attemptIndex: number;
  envelope: Record<string, unknown>;
  options: ProviderRunOptions;
  url: string;
  init: Omit<RequestInit, 'body'>;
}): Promise<Response> {
  const dispatchedBody = prepareProviderHttpDispatch(input);
  try {
    const response = await fetch(input.url, {
      ...input.init,
      body: JSON.stringify(dispatchedBody),
    });
    completeProviderHttpDispatch(input, {
      outcome: response.ok ? 'ok' : 'error',
      settlement: 'transport',
      httpStatus: response.status,
    });
    return response;
  } catch (error) {
    completeProviderHttpDispatch(input, {
      outcome: input.options.signal?.aborted ? 'cancelled' : 'error',
      settlement: 'transport',
      error,
    });
    throw error;
  }
}
