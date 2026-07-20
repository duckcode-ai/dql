import { describe, expect, it } from 'vitest';
import { rethrowIfCancelled } from './cancellation.js';

describe('rethrowIfCancelled', () => {
  it('rethrows a TimeoutError by name so the engine can render the graceful deadline outcome', () => {
    const deadline = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(() => rethrowIfCancelled(deadline)).toThrow(deadline);
  });

  it('rethrows an AbortError by name', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    expect(() => rethrowIfCancelled(abort)).toThrow(abort);
  });

  it('prefers the fired signal reason over the caught error', () => {
    const deadline = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const controller = new AbortController();
    controller.abort(deadline);
    let thrown: unknown;
    try {
      rethrowIfCancelled(new Error('claude did not return a parseable result'), controller.signal);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(deadline);
  });

  it('returns normally for ordinary provider failures so the fallback message still applies', () => {
    expect(() => rethrowIfCancelled(new Error('upstream 503'))).not.toThrow();
    expect(() => rethrowIfCancelled('string error')).not.toThrow();
  });
});
