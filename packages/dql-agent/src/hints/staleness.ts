/**
 * Hint staleness detection (W4.6).
 *
 * An approved hint names scope targets (a block, metric, dbt model, or term). After
 * a model rename or a deleted block, the hint keeps firing with guidance about a
 * thing that no longer exists — silently steering answers with stale advice. On
 * reindex we cross-check each approved hint's scope targets against the current
 * catalog and flag the ones whose targets vanished, so a human can retire or
 * re-scope them (surfaced in the review queue like any other proposal).
 */
import type { Hint, HintScope } from './types.js';
import type { KGStore } from '../kg/sqlite-fts.js';

export type HintScopeTargetKind = 'block' | 'metric' | 'dbtModel' | 'term';

export interface StaleHintFinding {
  hintId: string;
  title: string;
  missing: Array<{ kind: HintScopeTargetKind; name: string }>;
}

const SCOPE_TARGET_KINDS: HintScopeTargetKind[] = ['block', 'metric', 'dbtModel', 'term'];

/**
 * Flag approved hints whose named scope targets no longer exist. `exists` checks
 * the current catalog for a scope kind + name. Only approved hints are considered —
 * candidate/rejected hints never reach an answer.
 */
export function findStaleHints(
  hints: Array<Pick<Hint, 'id' | 'title' | 'scope' | 'status'>>,
  exists: (kind: HintScopeTargetKind, name: string) => boolean,
): StaleHintFinding[] {
  const findings: StaleHintFinding[] = [];
  for (const hint of hints) {
    if (hint.status !== 'approved') continue;
    const missing: Array<{ kind: HintScopeTargetKind; name: string }> = [];
    for (const kind of SCOPE_TARGET_KINDS) {
      const name = (hint.scope as HintScope)[kind];
      if (name && !exists(kind, name)) missing.push({ kind, name });
    }
    if (missing.length > 0) findings.push({ hintId: hint.id, title: hint.title, missing });
  }
  return findings;
}

/** KG-backed staleness check: resolves scope targets against the knowledge graph. */
export function findStaleApprovedHints(
  hints: Array<Pick<Hint, 'id' | 'title' | 'scope' | 'status'>>,
  kg: KGStore,
): StaleHintFinding[] {
  const dbtNames = new Set([
    ...kg.getNodesByKind('dbt_model', 5000).map((node) => node.name.toLowerCase()),
    ...kg.getNodesByKind('dbt_source', 5000).map((node) => node.name.toLowerCase()),
  ]);
  return findStaleHints(hints, (kind, name) => {
    switch (kind) {
      case 'block': return kg.getNode(`block:${name}`) !== null;
      case 'metric': return kg.getNode(`metric:${name}`) !== null;
      case 'term': return kg.getNode(`term:${name}`) !== null;
      case 'dbtModel': return dbtNames.has(name.toLowerCase());
    }
  });
}
