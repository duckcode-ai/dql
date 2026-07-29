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
import { hintsConflict, type Hint, type QuestionScope, type ScopedHintMatch } from './types.js';
import { staleHintDependencies } from './dependencies.js';
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
  /** Approved hints withheld by governance gates, retained for review/repair. */
  excluded: Array<{
    hintId: string;
    title: string;
    reason: 'stale' | 'superseded' | 'conflict';
    detail: string;
  }>;
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
  /** Current content fingerprints keyed by persisted dependency id. */
  currentDependencies?: ReadonlyMap<string, string>;
  /** Conservative fallback for older v3 hints without dependency provenance. */
  currentSnapshotId?: string | null;
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
  if (!existsSync(indexPath)) return { applied: [], conflicts: [], excluded: [] };

  const store = new HintStore(indexPath);
  try {
    const matches = await store.searchApprovedHints({
      questionScope: options.questionScope,
      limit: options.limit ?? 6,
      alpha: options.alpha,
      embeddingProvider: options.embeddingProvider,
    });
    const excluded: HintRetrievalResult['excluded'] = [];
    const fresh = matches.filter((match) => {
      const currentDependencies = new Map(options.currentDependencies ?? []);
      if (options.currentSnapshotId) {
        for (const dependency of match.hint.dependencies ?? []) {
          if (dependency.id.startsWith('scope:')) {
            currentDependencies.set(dependency.id, options.currentSnapshotId);
          }
        }
      }
      const staleDependencies = staleHintDependencies(match.hint.dependencies, currentDependencies);
      const legacySnapshotStale = (match.hint.dependencies?.length ?? 0) === 0
        && Boolean(match.hint.snapshotId)
        && Boolean(options.currentSnapshotId)
        && match.hint.snapshotId !== options.currentSnapshotId;
      if (staleDependencies.length === 0 && !legacySnapshotStale) return true;
      excluded.push({
        hintId: match.hint.id,
        title: match.hint.title,
        reason: 'stale',
        detail: staleDependencies.length > 0
          ? `Changed or missing dependencies: ${staleDependencies.map((dependency) => dependency.id).join(', ')}.`
          : `Candidate snapshot ${match.hint.snapshotId} differs from current snapshot ${options.currentSnapshotId}.`,
      });
      return false;
    });

    const eligibleIds = new Set(fresh.map((match) => match.hint.id));
    const supersededIds = new Set(
      fresh
        .map((match) => match.hint.supersedes)
        .filter((id): id is string => Boolean(id) && eligibleIds.has(id!)),
    );
    const unsuperseded = fresh.filter((match) => {
      if (!supersededIds.has(match.hint.id)) return true;
      excluded.push({
        hintId: match.hint.id,
        title: match.hint.title,
        reason: 'superseded',
        detail: 'A newer eligible approved hint explicitly supersedes this hint.',
      });
      return false;
    });

    const conflictPairs: Array<[Hint, Hint]> = [];
    for (let left = 0; left < unsuperseded.length; left += 1) {
      for (let right = left + 1; right < unsuperseded.length; right += 1) {
        const a = unsuperseded[left].hint;
        const b = unsuperseded[right].hint;
        if (hintsConflict(a, b)) conflictPairs.push([a, b]);
      }
    }
    const conflictingIds = new Set(conflictPairs.flatMap(([a, b]) => [a.id, b.id]));
    for (const match of unsuperseded) {
      if (!conflictingIds.has(match.hint.id)) continue;
      excluded.push({
        hintId: match.hint.id,
        title: match.hint.title,
        reason: 'conflict',
        detail: 'Overlapping approved hints are withheld until one explicitly supersedes the other.',
      });
    }
    const applied = unsuperseded
      .filter((match) => !conflictingIds.has(match.hint.id))
      .slice(0, options.limit ?? 6)
      .map(toAppliedHint);
    const conflicts = conflictPairs.map(([a, b]) => ({
        hintIds: [a.id, b.id] as [string, string],
        titles: [a.title, b.title] as [string, string],
        reason: `Approved hints "${a.title}" and "${b.title}" overlap on scope and are withheld until review resolves the conflict.`,
      }));

    return { applied, conflicts, excluded };
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
