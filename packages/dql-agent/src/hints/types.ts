/**
 * Scoped correction memory ("mini Hint Graph") types.
 *
 * When an analyst corrects a Tier-2 generated answer, that knowledge is captured
 * as a scoped, approved-only, Git-versioned **hint**. Hints never override
 * certified routing — they are folded into the agent's context AFTER certified
 * artifacts, semantic context, and graph anchors, and only when `approved`.
 *
 * Source of truth = Git:
 *   - `.dql/traces/*.trace.json`  — raw correction traces (what was wrong + the fix)
 *   - `.dql/hints/*.hint.yaml`     — candidate/approved/rejected hints
 *   - `.dql/reviews/*.review.yaml` — human review decisions
 *
 * `.dql/cache/agent-kg.sqlite` carries a rebuildable FTS index of approved hints
 * (Git authoritative; SQLite is just a fast scoped lookup).
 */

/**
 * The scope an individual hint applies within. A hint is only eligible for a
 * question when EVERY field it declares matches the question's resolved scope.
 * Fields left undefined are wildcards (do not constrain).
 */
export interface HintScope {
  /** Metric / KPI name, e.g. "revenue" or "active_users". */
  metric?: string;
  /** dbt model the hint is about, e.g. "fct_orders". */
  dbtModel?: string;
  /** Business domain, e.g. "growth". */
  domain?: string;
  /** Warehouse SQL dialect, e.g. "duckdb", "snowflake", "bigquery". */
  dialect?: string;
  /** Optional business term the hint refines. */
  term?: string;
  /** Optional certified block the hint relates to (objectKey or block name). */
  block?: string;
}

export type HintStatus = 'candidate' | 'approved' | 'rejected';

/**
 * A raw correction trace recorded when a Tier-2 generated answer is corrected.
 * This is the immutable evidence a hint is later derived from.
 */
export interface CorrectionTrace {
  /** Stable id, e.g. `trace_xxx`. */
  id: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** The original analyst question. */
  question: string;
  /** Scope the question resolved to (used to scope the derived hint). */
  scope: HintScope;
  /** What the Tier-2 draft answered (SQL and/or prose) that was wrong. */
  wrongAnswer: string;
  /** The analyst's correction (corrected SQL, rule, or guidance). */
  correction: string;
  /** Optional free-text rationale from the analyst. */
  rationale?: string;
  /** Who recorded the correction. */
  author?: string;
  /** contextPackId / blockId the correction was anchored to, when known. */
  anchorObjectKey?: string;
  /** id of the hint derived from this trace, once created. */
  derivedHintId?: string;
}

/**
 * A scoped correction hint. Becomes usable in future draft generation only when
 * `status === 'approved'`. Stored in Git (`.dql/hints/<id>.hint.yaml`) and
 * indexed in SQLite for scoped retrieval.
 */
export interface Hint {
  /** Stable id, e.g. `hint_xxx`. */
  id: string;
  /** Short title surfaced to reviewers and as a citation label. */
  title: string;
  /** The guidance the agent should apply within scope (plain language / rule). */
  guidance: string;
  /** The scope this hint applies within. */
  scope: HintScope;
  /** Lifecycle state. Approved-only is enforced at retrieval. */
  status: HintStatus;
  /** Trace this hint was derived from, for provenance. */
  traceId?: string;
  /** Optional canonical corrected SQL the hint endorses. */
  correctedSql?: string;
  /** Free-text searchable keywords. */
  tags?: string[];
  /** Who authored the candidate hint. */
  author?: string;
  /** Who approved/rejected (set by the review). */
  reviewer?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** id of the hint this one supersedes (for conflict resolution). */
  supersedes?: string;
}

/** Human review decision recorded in `.dql/reviews/<id>.review.yaml`. */
export interface HintReview {
  id: string;
  hintId: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  note?: string;
  createdAt: string;
}

/** A hint matched for a question, with its FTS relevance + scope match reason. */
export interface ScopedHintMatch {
  hint: Hint;
  /** Higher is better. Combines FTS/embedding relevance. */
  score: number;
  /** Plain-language scope match explanation, e.g. "metric=revenue, domain=growth". */
  scopeReason: string;
  /** Snippet from the FTS match, if any. */
  snippet?: string;
}

/**
 * Resolve a question's scope from the route/context. Any field left undefined is
 * treated as "unconstrained" (wildcards in hints still match).
 */
export interface QuestionScope {
  metric?: string;
  dbtModel?: string;
  domain?: string;
  dialect?: string;
  term?: string;
  block?: string;
  /** Free-text keywords used for FTS search (typically the question). */
  text: string;
}

/**
 * Does a hint's scope apply to the question's resolved scope?
 *
 * Semantics: a hint scope field constrains ONLY when the hint declares it. For
 * each declared field, the question must declare the same value (case-insensitive).
 * If the question does not declare a field the hint constrains, the hint does
 * NOT apply (we never apply a narrower-than-known hint to an unknown context),
 * EXCEPT `dialect`, which applies when the question's dialect is unknown (so a
 * project-wide dialect hint is not silently dropped before a warehouse is wired).
 *
 * Undeclared hint fields are wildcards and never block a match.
 */
export function hintAppliesToScope(scope: HintScope, question: QuestionScope): {
  applies: boolean;
  reason: string;
} {
  const matched: string[] = [];
  const constrainedFields: Array<[keyof HintScope, keyof QuestionScope]> = [
    ['metric', 'metric'],
    ['dbtModel', 'dbtModel'],
    ['domain', 'domain'],
    ['term', 'term'],
    ['block', 'block'],
  ];

  for (const [hintField, qField] of constrainedFields) {
    const want = scope[hintField];
    if (want === undefined || want === '') continue; // wildcard
    const have = question[qField];
    if (have === undefined || have === '') {
      return { applies: false, reason: `hint requires ${hintField}=${want} but question scope is unknown` };
    }
    if (!eqScope(want, have)) {
      return { applies: false, reason: `hint ${hintField}=${want} ≠ question ${String(have)}` };
    }
    matched.push(`${hintField}=${want}`);
  }

  // Dialect: constrain when both sides know it; tolerate unknown question dialect.
  if (scope.dialect && scope.dialect !== '') {
    if (question.dialect && question.dialect !== '') {
      if (!eqScope(scope.dialect, question.dialect)) {
        return { applies: false, reason: `hint dialect=${scope.dialect} ≠ question ${question.dialect}` };
      }
      matched.push(`dialect=${scope.dialect}`);
    }
    // else: dialect unknown for the question — do not block; note advisory match.
  }

  return {
    applies: true,
    reason: matched.length > 0 ? matched.join(', ') : 'project-wide hint (no scope constraints)',
  };
}

/** Two hints conflict when their scopes overlap on the same concept. */
export function hintsConflict(a: Hint, b: Hint): boolean {
  if (a.id === b.id) return false;
  if (a.supersedes === b.id || b.supersedes === a.id) return false; // explicit resolution
  return scopesOverlap(a.scope, b.scope);
}

function scopesOverlap(a: HintScope, b: HintScope): boolean {
  const fields: Array<keyof HintScope> = ['metric', 'dbtModel', 'domain', 'dialect', 'term', 'block'];
  let sharedConstraint = false;
  for (const field of fields) {
    const av = a[field];
    const bv = b[field];
    if (av && bv) {
      if (!eqScope(av, bv)) return false; // disjoint on a declared field → no overlap
      sharedConstraint = true;
    }
  }
  // Overlap only when they actually share at least one declared, equal field.
  return sharedConstraint;
}

function eqScope(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
