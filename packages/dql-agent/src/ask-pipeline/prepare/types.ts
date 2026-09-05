import type { AnalyticalIntentV1 } from '../intent.js';
import type { VocabularyIndex } from '../vocabulary.js';

/**
 * PREPARE: every tier, before anything is committed.
 *
 * A prepared candidate is an executable the host can freeze: the SQL, its
 * parameters, the trust it will carry, and the proof of why it answers the
 * intent. A refusal is typed and carries the compiler's own words, never a
 * substitute sentence. Nothing here talks to a warehouse or a model.
 */

export type PrepareTier = 'certified' | 'semantic' | 'relational' | 'exploratory';
export type PrepareTrust = 'certified' | 'governed' | 'review_required';

export interface PreparedCandidate {
  tier: PrepareTier;
  trust: PrepareTrust;
  sql: string;
  /** Positional parameters, when the composer bound literals as parameters. */
  params?: unknown[];
  /** Why this candidate answers the intent, in the host's words. */
  proof: string[];
  /** The block ref for a certified candidate; the engine for a semantic one. */
  sourceRef?: string;
  engine?: string;
  /** Output columns the composer expects, when known before execution. */
  columns?: string[];
  /** A one-row probe (base_rows, joined_rows) that must not show fan-out before rows are trusted. */
  fanoutProbeSql?: string;
  /** The request handed to the compiler, for the receipt. */
  compileRequest?: unknown;
  /** Host artifact (a DQL source) rendered for the answer, when available. */
  artifact?: unknown;
}

export type PrepareRefusalCode =
  | 'no_certified_block'
  | 'block_not_applicable'
  | 'not_semantic'
  | 'measure_scope_not_expressible'
  | 'semantic_compile_failed'
  | 'semantic_runtime_unavailable'
  | 'not_relational'
  | 'join_path_required'
  | 'relational_compose_failed'
  | 'exploration_not_opted_in'
  | 'policy_denied';

export interface PreparedRefusal {
  tier: PrepareTier;
  code: PrepareRefusalCode;
  /** Verbatim: what the compiler, composer or entailment check actually said. */
  message: string;
  /** True when a corrected intent could plausibly prepare (unknown ref, wrong path). */
  repairable: boolean;
  detail?: unknown;
}

export interface SemanticCompileRequest {
  metrics: string[];
  dimensions: string[];
  filters?: Array<{ dimension?: string; operator?: string; values?: string[] }>;
  timeDimension?: { name: string; granularity: string };
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
}

export interface SemanticCompileOutput {
  sql: string;
  engine: string;
  columns?: string[];
  fanoutProbeSql?: string;
  strategy?: string;
  artifact?: unknown;
}

export interface RelationalJoinStep {
  /** Relation being joined in (`schema.table`). */
  relation: string;
  /** ON clause using fully qualified relation names. */
  on: string;
}

export interface SqlDialectLike {
  quoteIdentifier(name: string): string;
  dateTrunc(grain: string, expr: string): string;
  limitClause(limit: number): string;
}

export interface PrepareDeps {
  /** Compile a semantic request on the project's active engine. Throws with the engine's message. */
  compileSemantic?: (request: SemanticCompileRequest) => Promise<SemanticCompileOutput>;
  /** Join steps from one physical relation to another, or undefined when no governed path exists. */
  joinPath?: (fromRelation: string, toRelation: string) => RelationalJoinStep[] | undefined;
  /** Dialect for relational composition. */
  dialect?: SqlDialectLike;
  /** Certified block source text by block ref. */
  blockSql?: (blockRef: string) => string | undefined;
  /** Host-side policy check on a relation or column ref; a denial is terminal. */
  policyDenies?: (refs: string[]) => string | undefined;
}

export interface PrepareInput {
  intent: AnalyticalIntentV1;
  vocabulary: VocabularyIndex;
  deps: PrepareDeps;
  explorationOptIn?: boolean;
  /** Tiers whose candidate already failed an execution proof for this intent. */
  excludeTiers?: PrepareTier[];
}

export interface PrepareResult {
  candidates: PreparedCandidate[];
  refusals: PreparedRefusal[];
  chosen?: PreparedCandidate;
  /** Every tier that was tried, in order, and how it ended. */
  attempts: Array<{ tier: PrepareTier; outcome: 'prepared' | 'refused' | 'skipped'; detail?: string }>;
}
