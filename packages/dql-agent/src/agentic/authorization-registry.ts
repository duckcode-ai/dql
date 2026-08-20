/**
 * Turn-scoped registry for execution authorizations.
 *
 * The analyst loop proves identifiers; the LEGACY loop executes. Those live on
 * opposite sides of an import boundary (`local-runtime` imports the provider,
 * so the provider cannot import back), and the authorization has to cross it or
 * the guard at the warehouse can never fire — which is exactly the state the
 * review found: a correct guard, unreachable.
 *
 * A module-level registry is the smallest thing that closes that gap without a
 * cycle. It is deliberately NOT a cache:
 *   - entries are keyed by run, not by question, so two turns asking the same
 *     thing cannot inherit each other's proofs;
 *   - `consume` removes as it reads, so one authorization can license exactly
 *     one execution and a retry must prove itself again;
 *   - a bounded map with FIFO eviction, so a crashed turn leaks nothing
 *     unbounded.
 */

import type { FinalSqlAuthorizationV1 } from './sql-authorization.js';

const MAX_PENDING = 64;
const pending = new Map<string, FinalSqlAuthorizationV1>();

export function registerSqlAuthorization(runKey: string, authorization: FinalSqlAuthorizationV1): void {
  if (!runKey) return;
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(runKey, authorization);
}

/** Read and REMOVE. One authorization licenses one execution. */
export function consumeSqlAuthorization(runKey: string): FinalSqlAuthorizationV1 | undefined {
  if (!runKey) return undefined;
  const found = pending.get(runKey);
  if (found) pending.delete(runKey);
  return found;
}

/** Drop a turn's authorization without executing — used when a run ends early. */
export function clearSqlAuthorization(runKey: string): void {
  pending.delete(runKey);
}

/** Test seam only. */
export function pendingAuthorizationCount(): number {
  return pending.size;
}
