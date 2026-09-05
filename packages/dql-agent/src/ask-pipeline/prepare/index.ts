import { prepareCertified } from './certified.js';
import { prepareRelational } from './relational.js';
import { prepareSemantic } from './semantic.js';
import type { PrepareInput, PrepareResult, PreparedCandidate, PreparedRefusal } from './types.js';

export * from './types.js';
export { entails } from './certified.js';
export { bindSemanticRequest } from './semantic.js';
export { composeRelational } from './relational.js';

const TRUST_RANK: Record<PreparedCandidate['trust'], number> = { certified: 0, governed: 1, review_required: 2 };
const TIER_RANK: Record<PreparedCandidate['tier'], number> = { certified: 0, semantic: 1, relational: 2, exploratory: 3 };

/**
 * Run every governed tier against the same intent and choose the highest
 * trust that prepared. Exploration is never automatic: without an explicit
 * opt-in it is recorded as a refusal so the user can choose it.
 */
export async function prepare(input: PrepareInput): Promise<PrepareResult> {
  const candidates: PreparedCandidate[] = [];
  const refusals: PreparedRefusal[] = [];
  const attempts: PrepareResult['attempts'] = [];
  const record = (tier: PrepareResult['attempts'][number]['tier'], result: { candidates: PreparedCandidate[]; refusals: PreparedRefusal[] }) => {
    candidates.push(...result.candidates);
    refusals.push(...result.refusals);
    attempts.push({ tier, outcome: result.candidates.length ? 'prepared' : 'refused', ...(result.refusals[0] ? { detail: `${result.refusals[0].code}: ${result.refusals[0].message.slice(0, 200)}` } : {}) });
  };
  const excluded = new Set(input.excludeTiers ?? []);
  if (excluded.has('certified')) attempts.push({ tier: 'certified', outcome: 'skipped', detail: 'failed an execution proof' });
  else record('certified', prepareCertified(input.intent, input.vocabulary, input.deps));
  if (excluded.has('semantic')) attempts.push({ tier: 'semantic', outcome: 'skipped', detail: 'failed an execution proof' });
  else if (candidates.length === 0) record('semantic', await prepareSemantic(input.intent, input.vocabulary, input.deps));
  else attempts.push({ tier: 'semantic', outcome: 'skipped' });
  if (excluded.has('relational')) attempts.push({ tier: 'relational', outcome: 'skipped', detail: 'failed an execution proof' });
  else if (candidates.length === 0) record('relational', prepareRelational(input.intent, input.vocabulary, input.deps));
  else attempts.push({ tier: 'relational', outcome: 'skipped' });
  if (candidates.length === 0 && !input.explorationOptIn) {
    refusals.push({ tier: 'exploratory', code: 'exploration_not_opted_in', message: 'no governed tier could prepare this intent; review-required exploration needs an explicit opt-in', repairable: false });
    attempts.push({ tier: 'exploratory', outcome: 'refused', detail: 'exploration_not_opted_in' });
  }
  candidates.sort((a, b) => TRUST_RANK[a.trust] - TRUST_RANK[b.trust] || TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  return { candidates, refusals, attempts, ...(candidates[0] ? { chosen: candidates[0] } : {}) };
}
