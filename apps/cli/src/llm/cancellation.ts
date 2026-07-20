/**
 * Deadline and cancellation errors must surface as THEMSELVES all the way to
 * the engine, which renders the graceful "bounded execution deadline" message
 * keyed on `err.name === 'TimeoutError'`. Any catch that flattens them into a
 * provider-failure string ("Claude subscription failed: …") strips the name and
 * turns a clean timeout into a confusing raw error for the user.
 *
 * Call this FIRST in every signal-aware fallback catch. It rethrows when the
 * error is a cancellation/deadline (or the signal already fired) and returns
 * normally otherwise so the catch can apply its ordinary fallback.
 */
export function rethrowIfCancelled(err: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? err;
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') throw err;
}
