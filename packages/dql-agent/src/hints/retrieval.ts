/**
 * Fold approved scoped hints into the agent's context, AFTER certified routing.
 *
 * Retrieval order (extended, not replaced):
 *   certified artifacts → semantic context → graph anchors → APPROVED HINTS → Tier-2 draft.
 *
 * Approved-only is hard-enforced here: only `status === 'approved'` hints are
 * ever returned in normal mode. A hint is applied only within its declared
 * scope (metric / dbt model / domain / dialect / term / block).
 */

import { existsSync } from 'node:fs';
import { defaultHintIndexPath } from './git-store.js';
import { HintStore } from './store.js';
import type { QuestionScope, ScopedHintMatch } from './types.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';

export interface AppliedHint {
  hintId: string;
  title: string;
  guidance: string;
  scopeReason: string;
  score: number;
  correctedSql?: string;
  traceId?: string;
}

export interface HintRetrievalResult {
  /** Approved, scoped hints to fold in as advisory context (cited). */
  applied: AppliedHint[];
  /** Approved hints whose scopes overlap and disagree — surfaced for review. */
  conflicts: Array<{ hintIds: [string, string]; titles: [string, string]; reason: string }>;
}

export interface RetrieveScopedHintsOptions {
  questionScope: QuestionScope;
  limit?: number;
  /**
   * Hybrid-rank weight. Defaults to 0 (pure FTS5, the safe default). Anything
   * >0 blends the deterministic embedding similarity in.
   */
  alpha?: number;
  embeddingProvider?: EmbeddingProvider;
  indexPath?: string;
}

/**
 * Retrieve approved scoped hints from the SQLite index. Returns an empty result
 * (no error) when the index does not exist yet or no hints match — keeping the
 * whole feature additive and backward-compatible.
 */
export async function retrieveScopedHints(
  projectRoot: string,
  options: RetrieveScopedHintsOptions,
): Promise<HintRetrievalResult> {
  const indexPath = options.indexPath ?? defaultHintIndexPath(projectRoot);
  if (!existsSync(indexPath)) return { applied: [], conflicts: [] };

  const store = new HintStore(indexPath);
  try {
    const matches = await store.searchApprovedHints({
      questionScope: options.questionScope,
      limit: options.limit ?? 6,
      alpha: options.alpha,
      embeddingProvider: options.embeddingProvider,
    });
    const applied = matches.map(toAppliedHint);

    // Surface conflicts only among the hints we actually applied, so unrelated
    // overlaps elsewhere in the project do not noise up an answer.
    const appliedIds = new Set(applied.map((hint) => hint.hintId));
    const conflicts = store
      .conflictingApprovedHints()
      .filter(([a, b]) => appliedIds.has(a.id) || appliedIds.has(b.id))
      .map(([a, b]) => ({
        hintIds: [a.id, b.id] as [string, string],
        titles: [a.title, b.title] as [string, string],
        reason: `Approved hints "${a.title}" and "${b.title}" overlap on scope and may disagree; review which is authoritative.`,
      }));

    return { applied, conflicts };
  } finally {
    store.close();
  }
}

function toAppliedHint(match: ScopedHintMatch): AppliedHint {
  return {
    hintId: match.hint.id,
    title: match.hint.title,
    guidance: match.hint.guidance,
    scopeReason: match.scopeReason,
    score: match.score,
    correctedSql: match.hint.correctedSql,
    traceId: match.hint.traceId,
  };
}
