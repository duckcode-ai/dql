/**
 * Shared contracts for the conversational analytical orchestrator.
 *
 * The existing DQL engine remains the authority for compilation, execution,
 * trust, and the immutable resolved analytical plan.  This module is the thin
 * outer contract used by the conversational layer to describe what it
 * understood, what it searched, and why it could or could not continue.
 *
 * The contract is intentionally content-only: it never carries model
 * chain-of-thought, credentials, raw provider payloads, or authorization.
 *
 * Acceptance: AGT-027..033, CTX-007, PERF-003, E2E-022.
 */

import { createHash } from 'node:crypto';
import type { DqlArtifactExecutionReceipt } from '@duckcodeailabs/dql-core';

export const ANALYTICAL_ORCHESTRATION_CONTRACT_VERSION = 1 as const;

export type AnalyticalTurnKind =
  | 'conversation'
  | 'definition'
  | 'lookup'
  | 'ranking'
  | 'breakdown'
  | 'comparison'
  | 'drilldown'
  | 'diagnosis'
  | 'research'
  | 'compound'
  | 'clarification'
  // Basic value/measure requests that are not a glossary definition.
  // Kept separate from `definition` so narration can explain the result.
  // (The union member is intentionally last for stable serialized values.)
  | 'aggregation';

export type AnalyticalTaskKind =
  | 'definition'
  | 'aggregation'
  | 'ranking'
  | 'attribute_lookup'
  | 'breakdown'
  | 'comparison'
  | 'drilldown'
  | 'diagnosis'
  | 'research_branch';

export type AnalyticalTaskStatus = 'planned' | 'running' | 'completed' | 'partial' | 'gap' | 'blocked';

export interface AnalyticalTaskOutputContractV1 {
  metrics: string[];
  dimensions: string[];
  filters: Array<{ field: string; value: string }>;
  grain?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  requestedColumns?: string[];
}

/** A bounded, server-computed dependency between two compound tasks. */
export interface AnalyticalTaskDependencyV1 {
  version: 1;
  kind: 'top_ranked_region';
  sourceTaskId: string;
  targetDimension: 'region';
}

/**
 * The only parent-result material a dependent child may receive. It carries
 * one selected canonical value and its row/result proofs, never parent prose,
 * SQL, or arbitrary rows.
 */
export interface AnalyticalTaskDependencyBindingV1 {
  version: 1;
  sourceTaskId: string;
  sourceResultFingerprint: string;
  canonicalColumn: string;
  value: string;
  rowFingerprint: string;
}

export type AnalyticalTaskDependencyResolution =
  | { ok: true; binding: AnalyticalTaskDependencyBindingV1 }
  | { ok: false; code: 'RESULT_CONTRACT_MISMATCH'; message: string };

export interface AnalyticalTaskV1 {
  version: 1;
  id: string;
  kind: AnalyticalTaskKind;
  question: string;
  dependencies: string[];
  dependency?: AnalyticalTaskDependencyV1;
  output: AnalyticalTaskOutputContractV1;
  status: AnalyticalTaskStatus;
  /** Only qualified catalog IDs may be placed in this list. */
  candidateIds: string[];
  /** Shared prior-result bindings, e.g. region = Philadelphia. */
  inheritedBindings: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
}

/** Durable, content-only outcome for one independent clause/branch. */
export interface AnalyticalTaskOutcomeV1 {
  version: 1;
  taskId: string;
  status: 'completed' | 'partial' | 'gap' | 'blocked';
  summary?: string;
  resultFingerprint?: string;
  gap?: AnalyticalCoverageGapV1;
}

export interface AnalyticalCoverageGapV1 {
  version: 1;
  code:
    | 'MISSING_MEASURE'
    | 'MISSING_DIMENSION'
    | 'MISSING_ATTRIBUTE'
    | 'MISSING_RELATIONSHIP'
    | 'MISSING_RUNTIME_CAPABILITY'
    | 'RESULT_CONTRACT_MISMATCH'
    | 'PROVIDER_UNAVAILABLE'
    | 'EXECUTION_FAILED'
    | 'AMBIGUOUS_MEANING'
    | 'POLICY_BLOCKED';
  phase: 'retrieval' | 'meaning' | 'planning' | 'compilation' | 'execution' | 'presentation';
  message: string;
  searchedSources: string[];
  attemptedRoutes: Array<'certified' | 'semantic' | 'governed_relational' | 'generated' | 'research'>;
  missing: string[];
  recoverable: boolean;
  planFrozen: boolean;
  nextActions: string[];
}

/**
 * Roles are deliberately independent of a source's trust tier.  A semantic
 * dimension can be an entity label, a categorical breakdown, or a time axis;
 * treating all members as interchangeable is what made an Account question
 * offer owner e-mail and sentiment as substitutes for the account itself.
 *
 * Acceptance: CTX-005, CTX-007, AGT-009, AGT-010.
 */
export type EvidenceCandidateRoleV1 =
  | 'metric'
  | 'entity_key'
  | 'entity_label'
  | 'categorical_dimension'
  | 'time_dimension'
  | 'member'
  | 'relationship'
  | 'context';

/**
 * A typed, content-safe reading of the analytical requirements in a question.
 * It is advisory for retrieval/ranking only: the compatibility solver and the
 * immutable resolved plan still own authorization and execution.
 */
export interface AnalyticalRequirementSetV1 {
  version: 1;
  measures: string[];
  dimensions: string[];
  entityTerms: string[];
  entityDisplayTerms: string[];
  memberTerms: string[];
  ranking?: {
    metricTerms: string[];
    entityTerms: string[];
    direction: 'top' | 'bottom';
    limit: number;
    /** True means the reader did not specify a count and DQL assumed 10. */
    defaultedLimit: boolean;
  };
  time?: {
    role: 'time_axis' | 'time_filter';
    grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
    fiscalPeriod?: string;
    /** A fiscal token is not executable until a declared calendar binds it. */
    requiresDeclaredFiscalCalendar: boolean;
  };
}

export type ContextSourceCoverageStatusV1 = 'available' | 'empty' | 'stale' | 'unavailable' | 'errored' | 'skipped';

/** Source coverage is distinct from a missing capability.  A bounded package
 * may omit a relevant candidate; that is not proof that the source lacks it. */
export interface ContextSourceCoverageV1 {
  version: 1;
  source: 'certified' | 'semantic' | 'governed_relational' | 'exploratory' | 'dbt_manifest' | 'runtime_schema' | 'vector' | 'conversation';
  status: ContextSourceCoverageStatusV1;
  candidateIds: string[];
  reason?: string;
}

export type AnalyticalCascadeTierV1 = 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql' | 'clarify_or_gap';
export type AnalyticalCascadeTierOutcomeV1 = 'executable' | 'ineligible' | 'unavailable' | 'ambiguous' | 'denied';

/** One immutable, inspectable decision per ordered authority tier. */
export interface CascadeTierAttemptV1 {
  version: 1;
  tier: AnalyticalCascadeTierV1;
  outcome: AnalyticalCascadeTierOutcomeV1;
  candidateIds: string[];
  reason: string;
  /** A denied or frozen tier must never silently fall through to another one. */
  planFrozen: boolean;
}

/**
 * A server-owned freeze made after a generated exploratory proposal has passed
 * the selected snapshot's SQL/context checks and has been bound to one live
 * execution target. It intentionally contains fingerprints and qualified
 * candidate identities only: the opaque execution capability and SQL text
 * never leave the in-memory host boundary.
 */
export interface ExploratoryExecutionFreezeV1 {
  version: 1;
  selectedTier: 'exploratory_sql';
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  targetFingerprint: string;
  sqlFingerprint: string;
  candidateIds: string[];
  /** The host minted one single-use capability before connector execution. */
  authorization: 'capability_minted';
}

/**
 * The shared cascade receipt.  This does not itself compile SQL; it prevents
 * downstream presentation/execution layers from silently reinterpreting a
 * question after route selection.
 */
export interface AnalyticalCascadeDecisionV1 {
  version: 1;
  requirements: AnalyticalRequirementSetV1;
  sourceCoverage: ContextSourceCoverageV1[];
  attempts: CascadeTierAttemptV1[];
  selectedTier?: Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>;
  planFrozen: boolean;
  /** Present only after a selected exploratory proposal is host-authorized. */
  exploratoryExecutionFreeze?: ExploratoryExecutionFreezeV1;
  stopReason: 'selected' | 'ambiguous' | 'coverage_gap' | 'denied' | 'post_freeze_failure';
}

export type ProviderFailureCauseV1 =
  | 'authentication'
  | 'model_not_found'
  | 'rate_limited'
  | 'gateway'
  | 'network'
  | 'provider_timeout'
  | 'run_deadline'
  | 'admission_denied'
  | 'dispatch_budget'
  | 'cancelled'
  | 'unknown';

/** Content-free, redacted provider diagnostics safe to persist in a run. */
export interface ProviderFailureDiagnosticV1 {
  version: 1;
  cause: ProviderFailureCauseV1;
  phase: 'preflight' | 'meaning_resolution' | 'planning' | 'generation' | 'repair' | 'narration' | 'unknown';
  retryable: boolean;
  safeAction: 'retry_same_provider' | 'fix_provider_configuration' | 'wait_and_retry' | 'inspect_run' | 'none';
  httpStatusClass?: '4xx' | '5xx';
  providerFingerprint?: string;
  modelFingerprint?: string;
  baseOriginFingerprint?: string;
}

/**
 * Additive durable diagnostics. V1 and V2 intentionally remain the compact
 * compatibility envelopes used by older persisted runs.
 */
export interface AgentRunDiagnosticReceiptV3 {
  version: 3;
  runId: string;
  sourceCoverage: ContextSourceCoverageV1[];
  cascade?: AnalyticalCascadeDecisionV1;
  planFrozen: boolean;
  orchestrationMode?: 'legacy' | 'shadow' | 'agentic';
  provider?: ProviderFailureDiagnosticV1;
  finalStopReason: string;
}

export interface AnalyticalTurnPlanV1 {
  version: 1;
  turnId?: string;
  question: string;
  kind: AnalyticalTurnKind;
  /** Natural-language turns use one bounded interpretation call by default. */
  meaningCallBudget: 0 | 1;
  meaningCallReason: 'explicit_binding' | 'conversation_only' | 'candidate_interpretation' | 'frozen_research_child';
  snapshotId?: string;
  sourceFingerprint?: string;
  taskIds: string[];
  tasks: AnalyticalTaskV1[];
  authorityOrder: Array<'certified' | 'semantic' | 'governed_relational' | 'generated'>;
  /** This is set only after compatibility and authorization have passed. */
  frozen: boolean;
  conversationTurnId?: string;
  parentRunId?: string;
}

export interface AnalyticalAnswerSectionV1 {
  version: 1;
  id: string;
  taskId: string;
  status: 'answered' | 'partial' | 'gap' | 'blocked';
  answer?: string;
  result?: CanonicalQueryResultV1;
  gap?: AnalyticalCoverageGapV1;
  factIds: string[];
  trustState: 'certified' | 'governed' | 'review_required' | 'not_applicable' | 'blocked';
}

export interface AnalyticalTurnAnswerV1 {
  version: 1;
  answer: string;
  sections: AnalyticalAnswerSectionV1[];
  followUps: string[];
  facts: string[];
}

/**
 * Small, explainable intent vocabulary used before the physical plan exists.
 * It is deliberately not a second semantic matcher: candidate identity still
 * comes from retrieval plus the bounded meaning call. These helpers only turn
 * a request into a task graph and output contract, so a compound question can
 * report partial success instead of collapsing the whole turn to one error.
 */
export function inferAnalyticalTurnKind(question: string): AnalyticalTurnKind {
  const text = question.toLowerCase();
  if (/\b(hello|hi|hey|thanks|thank you|good morning|good afternoon)\b/.test(text)) return 'conversation';
  if (/\b(why|root cause|driver|diagnos|anomal|changed)\b/.test(text)) return 'diagnosis';
  if (/\b(research|investigate|deep dive|tell a story|surrounding context)\b/.test(text)) return 'research';
  if (/\b(compare|versus|vs\.?|difference)\b/.test(text)) return 'comparison';
  if (/\b(top|bottom|highest|lowest|rank)\b/.test(text)) return 'ranking';
  if (/\b(by|per|over time|trend|monthly|daily|weekly)\b/.test(text)) return 'breakdown';
  if (/\b(what is|what are|define|definition|meaning)\b/.test(text) && !/\b(total|revenue|count|sales|amount)\b/.test(text)) return 'definition';
  if (/\b(region|country|state|city|name|label|email|category|product|customer)\b/.test(text)
    && /\b(where|which|what|who)\b/.test(text)) return 'lookup';
  return 'aggregation';
}

type RoleBalancedEvidenceCandidate = {
  id: string;
  qualifiedId?: string;
  kind?: string;
  semanticObjectType?: string;
  name?: string;
  aliases?: string[];
  dimensions?: string[];
  timeGrains?: string[];
  relationshipEvidence?: string[];
  relevanceScore?: number;
  exactMatch?: boolean;
  compatibility?: string;
  /**
   * Snapshot-authored compatibility declarations. These are deliberately not
   * folded into general lexical identity: only the categorical-dimension lane
   * may use the narrowly typed declarations below.
   */
  compatibilityFacts?: string[];
  analyticalCapability?: {
    dimensions?: Array<{ dimensionId?: string }>;
    timeDimensions?: Array<{ dimensionId?: string }>;
  };
};

function normalizeRequirementTerm(value: string): string {
  return value.toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueRequirementTerms(values: Array<string | undefined>): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeRequirementTerm)
    .filter(Boolean))];
}

function isTemporalTerm(term: string): boolean {
  return /^(?:date|day|week|month|quarter|year|fy\d{2,4}|fiscal year|fiscal quarter)$/.test(term);
}

/**
 * Parser output occasionally retains the grammatical wrapper around an
 * aggregation (for example "count for each customer") as though it were a
 * second metric.  The stable requirement is `count`; the rest describes the
 * requested grain and is already represented by the entity/dimension roles.
 * Keeping the wrapper makes a physically complete customer table look
 * incomplete and prematurely terminates the pre-freeze cascade.
 */
function isStructuralMeasurePhrase(value: string): boolean {
  const term = normalizeRequirementTerm(value);
  return /^(?:count|sum|total|average|avg)?\s*for\s+(?:each|every)\s+(?:account|customer|client|company|product|order|item|row)s?$/.test(term)
    || /^for\s+(?:each|every)\s+(?:account|customer|client|company|product|order|item|row)s?$/.test(term);
}

const AGGREGATION_REQUIREMENT_OPERATORS = new Set([
  'total', 'sum', 'average', 'avg', 'minimum', 'min', 'maximum', 'max',
]);

/**
 * A parsed intent may preserve every grammatical fragment of an aggregate
 * request ("total", "total supply cost", "supply", and "product").  Those
 * fragments are useful while retrieving, but they are not independent
 * physical requirements. Normalize only the explicit aggregation + grouping
 * construction so ordinary named metrics such as `total_revenue` keep their
 * authored identity.
 */
function typedAggregationRequirementRoles(question: string): {
  measure: string;
  dimension: string;
} | undefined {
  const match = /\b(?:total|sum|average|avg|minimum|min|maximum|max)\s+([a-z][a-z0-9_ -]{1,60}?)\s+(?:per|by|for\s+each)\s+([a-z][a-z0-9_-]*)\b/i.exec(question);
  const measure = match?.[1] ? normalizeRequirementTerm(match[1]) : '';
  const dimension = match?.[2] ? normalizeRequirementTerm(match[2]) : '';
  return measure && dimension ? { measure, dimension } : undefined;
}

function normalizedTypedAggregationRequirements(input: {
  question: string;
  measures: string[];
  dimensions: string[];
}): { measures: string[]; dimensions: string[] } {
  const typed = typedAggregationRequirementRoles(input.question);
  if (!typed) return input;
  const measureParts = new Set(typed.measure.split(' ').filter(Boolean));
  const measures = uniqueRequirementTerms([
    typed.measure,
    ...input.measures.filter((value) => {
      const normalized = normalizeRequirementTerm(value);
      return normalized !== typed.measure
        && !AGGREGATION_REQUIREMENT_OPERATORS.has(normalized)
        && normalized !== `total ${typed.measure}`
        && !(normalized.split(' ').length === 1 && measureParts.has(normalized));
    }),
  ]);
  const dimensions = uniqueRequirementTerms([
    typed.dimension,
    ...input.dimensions.filter((value) => {
      const normalized = normalizeRequirementTerm(value);
      return normalized !== typed.dimension
        && !(normalized.split(' ').length === 1 && measureParts.has(normalized));
    }),
  ]);
  return { measures, dimensions };
}

/**
 * Normalize grammatical aggregation wrappers before they become a plan
 * requirement.  Retrieval/parser output is allowed to retain useful search
 * phrases, but an immutable plan must never treat "count for each customer"
 * or "for each customer" as separate physical measures.  The grouping entity
 * is represented by the dimension/entity roles instead.
 *
 * `order count for each customer` is the common prose form for a count
 * aggregation at customer grain.  Keep the aggregation (`count`) and remove
 * the object noun (`order`) only for that exact grouped construction; a named
 * metric such as `order_value` remains untouched.
 */
export function normalizeAnalyticalMeasureTerms(
  question: string,
  values: readonly string[],
  options: { preserveIdentity?: boolean } = {},
): string[] {
  const normalizedQuestion = normalizeRequirementTerm(question);
  const groupedOrderCount = /\borders?\s+count\s+(?:for|per)\s+(?:each|every)\s+(?:the\s+)?(?:account|customer|client|company|product|order|item|row)s?\b/.test(normalizedQuestion);
  const terms = values
    .filter((value) => !isStructuralMeasurePhrase(value))
    .filter((value) => !(groupedOrderCount && /^(?:order|orders)$/i.test(normalizeRequirementTerm(value))));
  if (groupedOrderCount && !terms.some((value) => normalizeRequirementTerm(value) === 'count')) {
    terms.push('count');
  }
  // An inherited measure can already be a stable semantic/dbt identity. Keep
  // that identity intact for the planner/meaning handoff; matching and display
  // have their own normalizers. Rewriting `total_consumption_units` to prose
  // here lost the only sticky reference a measure-less refinement carried.
  if (options.preserveIdentity) {
    const seen = new Set<string>();
    return terms.flatMap((value) => {
      const exact = value.replace(/\s+/g, ' ').trim();
      const normalized = normalizeRequirementTerm(exact);
      if (!exact || !normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [exact];
    });
  }
  return uniqueRequirementTerms(terms);
}

/**
 * Parsed measure phrases are the most specific typed evidence available before
 * meaning resolution. A lexical root is useful only when the parser found no
 * phrase that already owns it: adding both `beverage revenue` and `revenue`
 * turns one requested metric into two and incorrectly rejects a block whose
 * own declared output is `beverage_revenue`. The same holds for `order count`
 * and its generic `count` root; grouped prose is normalized to `count` before
 * this helper runs, so retaining both is neither necessary nor correct.
 */
function nonRedundantLexicalMeasureTerms(
  parsedMeasures: readonly string[],
  question: string,
): string[] {
  const lexical = ['revenue', 'refund', 'refunds', 'bcm', 'run rate', 'count']
    .filter((term) => new RegExp(`\\b${term.replace(' ', '\\s+')}\\b`, 'i').test(question));
  return lexical.filter((term) => {
    if (term === 'count') {
      return !parsedMeasures.some((measure) =>
        normalizeRequirementTerm(measure).split(' ').includes('count'));
    }
    const token = term === 'refunds' ? 'refund' : term;
    return !parsedMeasures.some((measure) =>
      normalizeRequirementTerm(measure)
        .split(' ')
        .some((word) => word === token || (token === 'refund' && word === 'refunds')),
    );
  });
}

/**
 * Parse only stable analytical roles. This is purposefully narrower than an
 * LLM interpretation: unknown business phrases remain available to the normal
 * bounded meaning resolver instead of being guessed here.
 */
export function buildAnalyticalRequirementSet(input: {
  question: string;
  parsedIntent?: Partial<{
    measures: string[];
    dimensions: string[];
    filters: Array<{ field: string; value: string }>;
    timeGrain: string;
    limit: number;
  }>;
}): AnalyticalRequirementSetV1 {
  const question = input.question;
  const lower = question.toLowerCase();
  const parsed = input.parsedIntent;
  const grainMatch = lower.match(/\b(?:by|per|each)\s+(day|week|month|quarter|year)\b|\b(monthly|weekly|quarterly|yearly|daily)\b/i);
  const grainWord = (grainMatch?.[1] ?? grainMatch?.[0]?.replace(/ly\b/i, '') ?? '').toLowerCase();
  const grain = grainWord === 'daily' ? 'day'
    : grainWord === 'weekly' ? 'week'
      : grainWord === 'monthly' ? 'month'
        : grainWord === 'quarterly' ? 'quarter'
          : grainWord === 'yearly' ? 'year'
            : /^(day|week|month|quarter|year)$/.test(grainWord) ? grainWord as AnalyticalRequirementSetV1['time'] extends { grain?: infer G } ? G : never
              : undefined;
  const fiscal = lower.match(/\bfy\s?(\d{2,4})\b|\bfiscal\s+year\s+(\d{2,4})\b/i);
  const fiscalPeriod = fiscal ? `FY${fiscal[1] ?? fiscal[2]}`.toUpperCase() : undefined;
  const ranking = lower.match(/\b(top|bottom|highest|lowest)\s*(\d+)?\b/i);
  const requestedDimensions = uniqueRequirementTerms(parsed?.dimensions ?? []);
  const entityTerms = uniqueRequirementTerms([
    ...((lower.match(/\b(?:account|accounts|customer|customers|client|clients|company|companies)\b/g) ?? [])),
  ]).map((term) => term.replace(/s$/, ''));
  const entityDisplayTerms = /\b(?:who|which)\b/i.test(question)
    ? uniqueRequirementTerms(entityTerms.map((term) => `${term} name`))
    : [];
  // "this amount" is a deictic reference to a prior result, not a request to
  // choose an `amount` metric. Treating it as a new explicit measure made a
  // compositional follow-up reject every otherwise-valid display/predicate
  // option. Concrete metric words remain typed requirements, including the
  // common revenue/refunds pair used by multi-metric requests.
  const deicticAmount = /\b(?:this|that|the|such)\s+amount\b/i.test(question);
  const parsedMeasures = normalizeAnalyticalMeasureTerms(question, parsed?.measures ?? []);
  const parsedMeasuresWithLexicalTerms = uniqueRequirementTerms([
    ...parsedMeasures,
    ...nonRedundantLexicalMeasureTerms(parsedMeasures, question),
    ...(!deicticAmount
      && /\bamount\b/i.test(question)
      && !parsedMeasures.some((measure) => normalizeRequirementTerm(measure).split(' ').includes('amount'))
      ? ['amount']
      : []),
  ]);
  const typedRequirements = normalizedTypedAggregationRequirements({
    question,
    measures: parsedMeasuresWithLexicalTerms,
    dimensions: requestedDimensions.filter((term) => !isTemporalTerm(term)),
  });
  const measures = typedRequirements.measures;
  const dimensions = typedRequirements.dimensions;
  const rankingMetricTerms = ranking ? measures : [];
  const parsedLimit = typeof parsed?.limit === 'number' && Number.isFinite(parsed.limit) && parsed.limit > 0
    ? Math.floor(parsed.limit)
    : undefined;
  const explicitLimit = ranking?.[2] ? Number(ranking[2]) : parsedLimit;
  const time = grain || fiscalPeriod
    ? {
        role: grain ? 'time_axis' as const : 'time_filter' as const,
        ...(grain ? { grain: grain as NonNullable<AnalyticalRequirementSetV1['time']>['grain'] } : {}),
        ...(fiscalPeriod ? { fiscalPeriod } : {}),
        requiresDeclaredFiscalCalendar: Boolean(fiscalPeriod),
      }
    : undefined;
  return {
    version: 1,
    measures,
    dimensions,
    entityTerms,
    entityDisplayTerms,
    memberTerms: uniqueRequirementTerms((parsed?.filters ?? []).map((filter) => filter.value)),
    ...(ranking
      ? {
          ranking: {
            metricTerms: rankingMetricTerms,
            entityTerms,
            direction: /bottom|lowest/i.test(ranking[1] ?? '') ? 'bottom' : 'top',
            limit: explicitLimit ?? 10,
            defaultedLimit: explicitLimit === undefined,
          },
        }
      : {}),
    ...(time ? { time } : {}),
  };
}

/** Classify the role an already-qualified candidate may fill. */
export function evidenceCandidateRoles(candidate: RoleBalancedEvidenceCandidate): EvidenceCandidateRoleV1[] {
  const identity = uniqueRequirementTerms([
    candidate.id,
    candidate.qualifiedId,
    candidate.name,
    ...(candidate.aliases ?? []),
    ...(candidate.dimensions ?? []),
    ...(candidate.analyticalCapability?.dimensions ?? []).map((dimension) => dimension.dimensionId),
    ...(candidate.analyticalCapability?.timeDimensions ?? []).map((dimension) => dimension.dimensionId),
  ]).join(' ');
  const roles = new Set<EvidenceCandidateRoleV1>();
  if (candidate.kind === 'semantic_metric' || candidate.semanticObjectType === 'metric' || /\bmetric\b/.test(identity)) roles.add('metric');
  if (candidate.semanticObjectType === 'entity' || /(?:^| )(?:account|customer|client|company) id\b/.test(identity) || /\bentity\b/.test(identity)) roles.add('entity_key');
  if (/\b(?:account|customer|client|company)(?: name)?\b/.test(identity)
    && /\b(?:name|label|display|account|customer|client|company)\b/.test(identity)
    && !/\b(?:owner|sentiment|email)\b/.test(identity)) roles.add('entity_label');
  if (/(?:\bdate\b|\btime\b|\bmonth\b|\bquarter\b|\byear\b)/.test(identity)
    || (candidate.timeGrains?.length ?? 0) > 0
    || (candidate.analyticalCapability?.timeDimensions?.length ?? 0) > 0) roles.add('time_dimension');
  if ((candidate.relationshipEvidence?.length ?? 0) > 0 || /\b(?:relationship|join|bridge)\b/.test(identity)) roles.add('relationship');
  if (candidate.kind === 'semantic_member' || candidate.semanticObjectType === 'dimension') roles.add('categorical_dimension');
  if (candidate.kind === 'sql_column' || candidate.kind === 'dbt_model' || candidate.kind === 'sql_table') roles.add('context');
  if (roles.size === 0) roles.add('context');
  return [...roles];
}

function candidateMatchesTerms(
  candidate: RoleBalancedEvidenceCandidate,
  terms: string[],
  options: { categoricalDimension?: boolean } = {},
): boolean {
  if (terms.length === 0) return false;
  const identity = uniqueRequirementTerms([
    candidate.id,
    candidate.qualifiedId,
    candidate.name,
    ...(candidate.aliases ?? []),
    ...(candidate.dimensions ?? []),
  ]).join(' ');
  if (terms.some((term) => identity.includes(term) || term.includes(identity))) return true;
  return options.categoricalDimension === true
    && candidateMatchesCategoricalDimensionRequirement(candidate, terms);
}

/**
 * A categorical dimension may satisfy a requested business role only through
 * its own snapshot-authored declaration. In particular, `location_name` is
 * not a synonym for `region`: it can fill a region lane only when metadata
 * explicitly says `alternative-for:region`, or when the dimension itself is
 * declared with the semantic geography role. This protects admission from
 * broad lexical geography expansion while retaining role-balanced recall.
 */
export function candidateMatchesCategoricalDimensionRequirement(
  candidate: Pick<RoleBalancedEvidenceCandidate, 'compatibilityFacts'>,
  terms: readonly string[],
): boolean {
  const facts = new Set((candidate.compatibilityFacts ?? [])
    .map(normalizeRequirementTerm)
    .filter(Boolean));
  if (facts.size === 0) return false;

  const requestedRoles = [...new Set(terms.flatMap((term) => {
    const normalized = normalizeRequirementTerm(term);
    const terminal = normalized.split(' ').at(-1) ?? '';
    return [normalized, terminal].filter(Boolean);
  }))];
  const hasDeclaredAlternative = requestedRoles.some((role) =>
    facts.has(`alternative for ${role}`)
    || facts.has(`dimension alternative for ${role}`));
  if (hasDeclaredAlternative) return true;

  const declaredGeography = facts.has('semantic role geography')
    || facts.has('semantic geography role');
  return declaredGeography && requestedRoles.some((role) =>
    role === 'region' || role === 'geography' || role === 'geographic');
}

/**
 * Keep an internal retrieval result broad while making the provider package
 * role-balanced. Exact/alias matches stay pinned; each requested role gets up
 * to two candidates before relevance fills remaining cards.
 */
export function selectRoleBalancedMeaningCandidates<T extends RoleBalancedEvidenceCandidate>(input: {
  candidates: T[];
  requirements: AnalyticalRequirementSetV1;
  maxCandidates?: number;
  /** Use before any kind cap to reserve exact/required-role cards. */
  pinOnly?: boolean;
}): T[] {
  const max = Math.max(1, Math.min(16, Math.floor(input.maxCandidates ?? 16)));
  const ranked = [...new Map(input.candidates
    .filter((candidate) => candidate.id.trim() && candidate.compatibility !== 'incompatible')
    .map((candidate) => [candidate.id, candidate] as const)).values()]
    .sort((left, right) => Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0)
      || left.id.localeCompare(right.id));
  const selected: T[] = [];
  const add = (candidate: T | undefined): void => {
    if (candidate && selected.length < max && !selected.some((item) => item.id === candidate.id)) selected.push(candidate);
  };
  const servesRequestedRole = (candidate: T): boolean => {
    const roles = evidenceCandidateRoles(candidate);
    const metricTerms = input.requirements.ranking?.metricTerms.length
      ? input.requirements.ranking.metricTerms
      : input.requirements.measures;
    if (roles.includes('metric') && candidateMatchesTerms(candidate, metricTerms)) return true;
    // An entity term such as "account" is deliberately insufficient for an
    // attribute (Account Owner Email) to displace the requested display key.
    // Only an actual entity-label candidate may satisfy this binding.
    if (roles.includes('entity_label') && candidateMatchesTerms(candidate, [
      ...input.requirements.entityTerms,
      ...input.requirements.entityDisplayTerms,
    ])) return true;
    if (roles.includes('time_dimension') && Boolean(input.requirements.time)) return true;
    if (roles.includes('categorical_dimension')
      && input.requirements.dimensions.length > 0
      && candidateMatchesTerms(candidate, input.requirements.dimensions, { categoricalDimension: true })) return true;
    if (roles.includes('relationship')
      && (input.requirements.dimensions.length > 1 || input.requirements.entityTerms.length > 0)) return true;
    return false;
  };
  for (const candidate of ranked.filter((candidate) => candidate.exactMatch)) {
    // In a pin-only prepass, an exact match is only a pin when it serves a
    // requested analytical role. Otherwise a pile of exact members consumes
    // the whole package before the requested metric/entity can be reserved.
    if (input.pinOnly && !servesRequestedRole(candidate)) continue;
    add(candidate);
  }
  const required: Array<[EvidenceCandidateRoleV1, string[]]> = [
    ['metric', input.requirements.ranking?.metricTerms.length ? input.requirements.ranking.metricTerms : input.requirements.measures],
    ['entity_label', [...input.requirements.entityTerms, ...input.requirements.entityDisplayTerms]],
    ['time_dimension', input.requirements.time ? [input.requirements.time.grain ?? 'time'] : []],
    ['categorical_dimension', input.requirements.dimensions],
    ['relationship', input.requirements.dimensions.length > 1 || input.requirements.entityTerms.length > 0 ? ['relationship'] : []],
  ];
  for (const [role, terms] of required) {
    // No requested categorical dimension means that high-scoring arbitrary
    // members are noise, not a role reservation. This is the subtle path that
    // used to admit Account Owner and Sentiment immediately after Account Name.
    if (terms.length === 0) continue;
    let admitted = 0;
    for (const candidate of ranked) {
      if (admitted >= 2 || selected.length >= max) break;
      const roles = evidenceCandidateRoles(candidate);
      if (!roles.includes(role)) continue;
      // "top accounts" needs the account display key, not any field whose
      // label happens to contain account. Once a display candidate is
      // available, owner/e-mail/sentiment attributes are neither the entity
      // role nor a useful categorical reservation unless the user explicitly
      // named that attribute. This runs during the pre-cap pin pass so noisy
      // same-kind cards cannot enter through the categorical role.
      const explicitlyRequestsAttribute = /\b(?:owner|sentiment|email)\b/i.test([
        ...input.requirements.dimensions,
        ...input.requirements.entityTerms,
        ...input.requirements.entityDisplayTerms,
      ].join(' '));
      const hasRequestedEntityLabel = ranked.some((item) =>
        evidenceCandidateRoles(item).includes('entity_label')
        && candidateMatchesTerms(item, [
          ...input.requirements.entityTerms,
          ...input.requirements.entityDisplayTerms,
        ]));
      if (role === 'categorical_dimension'
        && hasRequestedEntityLabel
        && !explicitlyRequestsAttribute
        && /\b(?:owner|sentiment|email)\b/i.test(candidate.name ?? candidate.id)) continue;
      // For entity labels, role is more important than a lexical owner/email
      // hit. For all other roles, prefer an identity matching the requested
      // business term but retain a role candidate when the request is terse.
      if (terms.length > 0 && !candidateMatchesTerms(candidate, terms, { categoricalDimension: role === 'categorical_dimension' })
        && role !== 'time_dimension' && role !== 'relationship' && role !== 'entity_label') continue;
      add(candidate);
      admitted += 1;
    }
  }
  if (!input.pinOnly) {
    for (const candidate of ranked) add(candidate);
  }
  return selected;
}

export function classifyProviderFailure(input: {
  message?: string;
  code?: string;
  phase?: ProviderFailureDiagnosticV1['phase'];
  providerFingerprint?: string;
  modelFingerprint?: string;
  baseOriginFingerprint?: string;
}): ProviderFailureDiagnosticV1 {
  const text = `${input.code ?? ''} ${input.message ?? ''}`.toLowerCase();
  const cause: ProviderFailureCauseV1 = /cancel/.test(text) ? 'cancelled'
    : /dispatch.?budget|provider_dispatch_budget/.test(text) ? 'dispatch_budget'
      : /deadline.?insufficient|admission|soft.?target/.test(text) ? 'admission_denied'
        : /run.?deadline|time limit/.test(text) ? 'run_deadline'
          : /timeout|timed out/.test(text) ? 'provider_timeout'
            : /401|403|api key|unauthori[sz]ed|auth(?:entication)?/.test(text) ? 'authentication'
              : /model(?:[ _-]+|\s+).*not[ _-]?found|unknown model|model_not_found|404/.test(text) ? 'model_not_found'
                : /429|rate[ _-]?limit|too many requests/.test(text) ? 'rate_limited'
                  : /502|503|504|gateway/.test(text) ? 'gateway'
                    : /econn|network|fetch failed|not reachable|connection refused/.test(text) ? 'network'
                      : 'unknown';
  const retryable = cause === 'rate_limited' || cause === 'gateway' || cause === 'network' || cause === 'provider_timeout';
  const safeAction: ProviderFailureDiagnosticV1['safeAction'] = retryable ? (cause === 'rate_limited' ? 'wait_and_retry' : 'retry_same_provider')
    : cause === 'authentication' || cause === 'model_not_found' ? 'fix_provider_configuration'
      : cause === 'cancelled' ? 'none'
        : 'inspect_run';
  const httpStatusClass = /\b(?:401|403|404|429)\b/.test(text) ? '4xx' as const
    : /\b(?:502|503|504)\b/.test(text) ? '5xx' as const
      : undefined;
  return {
    version: 1,
    cause,
    phase: input.phase ?? 'unknown',
    retryable,
    safeAction,
    ...(httpStatusClass ? { httpStatusClass } : {}),
    ...(input.providerFingerprint ? { providerFingerprint: input.providerFingerprint } : {}),
    ...(input.modelFingerprint ? { modelFingerprint: input.modelFingerprint } : {}),
    ...(input.baseOriginFingerprint ? { baseOriginFingerprint: input.baseOriginFingerprint } : {}),
  };
}

export function buildAnalyticalCascadeDecision(input: Omit<AnalyticalCascadeDecisionV1, 'version'>): AnalyticalCascadeDecisionV1 {
  return {
    version: 1,
    ...input,
    sourceCoverage: input.sourceCoverage.map((coverage) => ({
      ...coverage,
      version: 1,
      candidateIds: [...new Set(coverage.candidateIds)].slice(0, 32),
    })),
    attempts: input.attempts.map((attempt) => ({ ...attempt, version: 1, candidateIds: [...new Set(attempt.candidateIds)].slice(0, 32) })),
  };
}

/**
 * `Regarding: "Mr. Matthew Meyer"` and friends — a short label, a colon, and a
 * quoted value, with nothing else in the clause. Deliberately narrow: it must
 * be the WHOLE clause and the value must be quoted, so an ordinary question
 * that happens to contain a colon is untouched.
 */
const ANNOTATION_CLAUSE = /^\s*[A-Za-z][A-Za-z ]{0,24}:\s*["“'‘][^"”'’]*["”'’]\s*$/;

export function splitAnalyticalTasks(question: string): string[] {
  // The separator belongs to the SPLIT, not to the clause. Carrying it through
  // produced a child task whose question was literally
  // `" then "What customer type is Wesley Jenkins` — quote, connector and all —
  // which then failed to resolve and surfaced that punctuation to the reader as
  // the task title.
  const leadingJunk = /^(?:[\s"'“”‘’,:;.\-]+|\b(?:then|and|also)\b)+/i;
  const trailingJunk = /[\s"'“”‘’,:;.\-]+$/;
  const raw = question
    .split(/\s*(?:\?|;|\band then\b|\balso\b)\s*/i)
    .flatMap((part) => part.split(/\s+\band\s+(?=(?:what|who|which|show|list|tell|give|how|why)\b)/i));
  // A `Label: "value"` clause is an ANNOTATION, not a question. The composer
  // appends `Regarding: "<selected row>"` when the reader follows up on
  // something they clicked, and splitting on the `?` before it turned that
  // referent into a task of its own — titled `Regarding: "Mr. Matthew Meyer`,
  // which then "answered" by computing an unrelated maximum over the rows still
  // on screen. Context says WHO the real task is about; it is never a task.
  // Filtered before the junk strip, which would unbalance the quotes.
  const asked = raw.filter((part) => !ANNOTATION_CLAUSE.test(part));
  const parts = (asked.length > 0 ? asked : raw)
    .map((part) => part.replace(leadingJunk, '').replace(trailingJunk, '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [question.trim()];
}

export function buildAnalyticalTaskGraph(input: {
  question: string;
  /**
   * Explicit user-selected mode. Research is a root workflow, not merely a
   * higher reasoning effort: its evidence ledger and synthesis must retain the
   * whole question rather than treating story clauses as independent asks.
   */
  mode?: 'ask' | 'research';
  candidateIds?: string[];
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; value: string }>;
  inheritedBindings?: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
  maxTasks?: number;
}): { kind: AnalyticalTurnKind; tasks: AnalyticalTaskV1[]; partial: boolean } {
  const rootKind = input.mode === 'research' ? 'research' : inferAnalyticalTurnKind(input.question);
  // A research turn may later create bounded evidence branches, but that is a
  // research planner's job. Splitting at ingress loses the surrounding story
  // before it has an opportunity to reason about it.
  const clauses = (rootKind === 'research' ? [input.question.trim()] : splitAnalyticalTasks(input.question))
    .slice(0, Math.max(1, Math.min(6, input.maxTasks ?? 6)));
  const candidateIds = [...new Set((input.candidateIds ?? []).filter((id) => id.trim()))];
  const metrics = [...new Set((input.metrics ?? []).filter((metric) => metric.trim()))];
  const dimensions = [...new Set((input.dimensions ?? []).filter((dimension) => dimension.trim()))];
  const filters = input.filters ?? [];
  const inheritedBindings = input.inheritedBindings ?? [];
  const unboundTasks = clauses.map((clause, index): AnalyticalTaskV1 => {
    const kind = rootKind === 'research' ? 'research' : inferAnalyticalTurnKind(clause);
    const research = kind === 'research' || kind === 'diagnosis';
    const taskKind: AnalyticalTaskKind = research
      ? 'research_branch'
      : kind === 'lookup'
        ? 'attribute_lookup'
        : kind === 'breakdown'
          ? 'breakdown'
          : kind === 'comparison'
            ? 'comparison'
            : kind === 'ranking'
              ? 'ranking'
              : kind === 'definition'
                ? 'definition'
                : 'aggregation';
    return {
      version: 1,
      id: `task-${index + 1}`,
      kind: taskKind,
      question: clause,
      dependencies: index === 0 ? [] : [],
      output: {
        metrics,
        dimensions,
        filters,
        ...(kind === 'ranking' ? { order: 'desc' as const } : {}),
      },
      status: 'planned',
      candidateIds,
      inheritedBindings,
    };
  });
  const tasks = bindTopRankedRegionDependencies(unboundTasks);
  return {
    kind: rootKind === 'research' ? 'research' : tasks.length > 1 ? 'compound' : rootKind,
    tasks,
    partial: false,
  };
}

const TOP_RANKED_REGION_RE = /(?:\b(?:top|highest|most)\b[^?.!]{0,72}\bregions?\b|\bregions?\b[^?.!]{0,72}\b(?:top|highest|most)\b)/i;
const DEPENDENT_REGION_CUSTOMERS_RE = /\b(?:that|this|same)\s+region\b/i;

/**
 * Recognise only the demonstrated two-step dependency. Broader pronoun
 * resolution belongs to the normal conversation layer; turning every compound
 * question into a dependency would serialise unrelated work and invent filters.
 */
function bindTopRankedRegionDependencies(tasks: AnalyticalTaskV1[]): AnalyticalTaskV1[] {
  return tasks.map((task, index) => {
    if (!DEPENDENT_REGION_CUSTOMERS_RE.test(task.question) || !/\bcustomers?\b/i.test(task.question)) return task;
    const parent = tasks.slice(0, index).reverse().find((candidate) => TOP_RANKED_REGION_RE.test(candidate.question));
    if (!parent) return task;
    const dependency: AnalyticalTaskDependencyV1 = {
      version: 1,
      kind: 'top_ranked_region',
      sourceTaskId: parent.id,
      targetDimension: 'region',
    };
    return { ...task, dependencies: [parent.id], dependency };
  });
}

export function buildAnalyticalTurnPlan(input: {
  question: string;
  mode?: 'ask' | 'research';
  turnId?: string;
  candidateIds?: string[];
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; value: string }>;
  inheritedBindings?: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
  zeroCallReason?: AnalyticalTurnPlanV1['meaningCallReason'];
  frozen?: boolean;
  snapshotId?: string;
  sourceFingerprint?: string;
}): AnalyticalTurnPlanV1 {
  const graph = buildAnalyticalTaskGraph(input);
  const zeroCall = input.zeroCallReason === 'explicit_binding'
    || input.zeroCallReason === 'conversation_only'
    || input.zeroCallReason === 'frozen_research_child';
  return {
    version: 1,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    question: input.question,
    kind: graph.kind,
    meaningCallBudget: zeroCall ? 0 : 1,
    meaningCallReason: input.zeroCallReason ?? 'candidate_interpretation',
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
    taskIds: graph.tasks.map((task) => task.id),
    tasks: graph.tasks,
    authorityOrder: ['certified', 'semantic', 'governed_relational', 'generated'],
    frozen: input.frozen === true,
  };
}

export function summarizeTaskOutcomes(tasks: AnalyticalTaskV1[]): {
  status: 'completed' | 'partial' | 'gap' | 'blocked';
  completed: string[];
  gaps: string[];
} {
  const completed = tasks.filter((task) => task.status === 'completed').map((task) => task.id);
  const gaps = tasks.filter((task) => task.status === 'gap' || task.status === 'blocked').map((task) => task.id);
  const status = completed.length === tasks.length && tasks.length > 0
    ? 'completed'
    : completed.length > 0
      ? 'partial'
      : gaps.some((id) => tasks.find((task) => task.id === id)?.status === 'blocked')
        ? 'blocked'
        : 'gap';
  return { status, completed, gaps };
}

export interface CanonicalQueryResultV1 {
  version: 1;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  executionTime?: number;
  truncated?: boolean;
  /** The exact execution proof is carried through every transport boundary. */
  executionReceipt?: DqlArtifactExecutionReceipt;
  /** Trust/tier are descriptive identity, never inferred by a renderer. */
  trustState?: 'certified' | 'governed' | 'review_required' | 'not_applicable' | 'blocked';
  answerTier?: string;
  resultFingerprint: string;
}

/**
 * A reader-selected value from a previously rendered canonical result.
 *
 * This is intentionally a reference, not copied conversational prose. The
 * host must resolve `sourceRunId` from its durable run store and validate every
 * field against the persisted result before the binding may influence routing,
 * value lookup, or SQL planning.
 */
export interface AgentSelectedResultBindingV1 {
  version: 1;
  sourceRunId: string;
  sourceArtifactId: string;
  canonicalColumn: string;
  value: string;
  rowFingerprint: string;
  resultFingerprint: string;
}

export type AgentSelectedResultBindingValidation =
  | { ok: true; binding: AgentSelectedResultBindingV1 }
  | {
      ok: false;
      code: 'RESULT_BINDING_INVALID' | 'RESULT_BINDING_RESULT_MISMATCH' | 'RESULT_BINDING_ROW_MISMATCH';
      message: string;
    };

/** Stable scalar transport for a selected canonical result cell. */
export function canonicalResultBindingValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** A row proof includes all canonical columns, not just the selected cell. */
export function canonicalResultRowFingerprint(result: Pick<CanonicalQueryResultV1, 'columns'>, row: Record<string, unknown>): string {
  return stableFingerprint({
    columns: result.columns,
    row: Object.fromEntries(result.columns.map((column) => [column, row[column]])),
  });
}

/**
 * Validate an untrusted selected-result reference against a persisted
 * canonical result. The source run/artifact identities are checked by the
 * host before calling this pure result-level validator.
 */
export function validateSelectedResultBinding(
  binding: AgentSelectedResultBindingV1 | undefined,
  result: CanonicalQueryResultV1 | undefined,
): AgentSelectedResultBindingValidation {
  if (!binding
    || binding.version !== 1
    || !binding.sourceRunId.trim()
    || !binding.sourceArtifactId.trim()
    || !binding.canonicalColumn.trim()
    || !binding.value.trim()
    || !normalizeAnalyticalExecutionFingerprint(binding.rowFingerprint)
    || !normalizeAnalyticalExecutionFingerprint(binding.resultFingerprint)) {
    return {
      ok: false,
      code: 'RESULT_BINDING_INVALID',
      message: 'The selected result reference is incomplete or malformed.',
    };
  }
  if (!result || binding.resultFingerprint !== result.resultFingerprint) {
    return {
      ok: false,
      code: 'RESULT_BINDING_RESULT_MISMATCH',
      message: 'The selected result is no longer the persisted result for this run.',
    };
  }
  if (!result.columns.includes(binding.canonicalColumn)) {
    return {
      ok: false,
      code: 'RESULT_BINDING_ROW_MISMATCH',
      message: `The selected column ${binding.canonicalColumn} is not present in the persisted result.`,
    };
  }
  const matched = result.rows.some((row) =>
    canonicalResultRowFingerprint(result, row) === binding.rowFingerprint
    && canonicalResultBindingValue(row[binding.canonicalColumn]) === binding.value);
  if (!matched) {
    return {
      ok: false,
      code: 'RESULT_BINDING_ROW_MISMATCH',
      message: 'The selected row/value does not match the persisted result.',
    };
  }
  return { ok: true, binding: { ...binding, resultFingerprint: result.resultFingerprint } };
}

/**
 * Derive the one value a `top region -> customers in that region` child may
 * consume. A first row alone is never proof. The parent must either return an
 * explicit rank, or be the server-computed descending ranking task and return
 * at least two rows with one strictly-leading numeric measure. `rowCount` is
 * the returned-row contract, not proof that a singleton is the complete group
 * set. Ties and ambiguous result shapes remain a typed child gap.
 */
export function resolveTopRankedRegionDependency(
  sourceTaskId: string,
  result: CanonicalQueryResultV1 | undefined,
  parentTask?: Pick<AnalyticalTaskV1, 'kind' | 'output'>,
): AnalyticalTaskDependencyResolution {
  if (!result || result.rows.length === 0) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region task did not produce a canonical result that can bind the dependent customer task.',
    };
  }
  const canonicalResultFingerprint = normalizeAnalyticalExecutionFingerprint(result.resultFingerprint);
  const executionReceipt = normalizeAnalyticalExecutionReceipt(result.executionReceipt);
  if (!executionReceipt) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region result did not retain a complete normalized execution receipt, so the dependent customer task was not run.',
    };
  }
  if (!canonicalResultFingerprint
    || result.resultFingerprint !== canonicalResultFingerprint
    || executionReceipt.resultFingerprint !== canonicalResultFingerprint) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region execution receipt does not match the canonical result, so the dependent customer task was not run.',
    };
  }
  const regionColumns = result.columns.filter((column) => /(?:^|_)region(?:_name)?$/i.test(column));
  if (regionColumns.length !== 1) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region result did not contain exactly one canonical region column.',
    };
  }
  const canonicalColumn = regionColumns[0]!;
  const first = result.rows[0]!;
  const value = canonicalResultBindingValue(first[canonicalColumn]);
  if (!value) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The leading top-region row did not contain a usable region value.',
    };
  }
  if (!hasUnambiguousTopRow(result, parentTask)) {
    return {
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: 'The top-region result did not prove a single leading region, so the dependent customer task was not run.',
    };
  }
  return {
    ok: true,
    binding: {
      version: 1,
      sourceTaskId,
      sourceResultFingerprint: canonicalResultFingerprint,
      canonicalColumn,
      value,
      rowFingerprint: canonicalResultRowFingerprint(result, first),
    },
  };
}

function hasUnambiguousTopRow(
  result: CanonicalQueryResultV1,
  parentTask?: Pick<AnalyticalTaskV1, 'kind' | 'output'>,
): boolean {
  const rankColumn = result.columns.find((column) => /(?:^|_)(?:rank|row_number)$/i.test(column));
  if (rankColumn) {
    const ranks = result.rows.map((row) => numericCell(row[rankColumn]));
    if (ranks[0] === 1 && ranks.slice(1).every((rank) => rank === undefined || rank > 1)) return true;
  }
  // A plain numerical result column does not say that its first row was ranked.
  // It becomes a ranking proof only when the server's own parent task explicitly
  // asked for a descending ranking AND the returned rows demonstrate a strictly
  // leading value. A singleton needs an explicit rank = 1: it cannot establish
  // that unreturned groups are lower.
  if (parentTask?.kind !== 'ranking' || parentTask.output.order !== 'desc') return false;
  if (result.rows.length < 2) return false;
  const measures = result.columns.filter((column) => {
    if (column === rankColumn) return false;
    const values = result.rows.map((row) => numericCell(row[column]));
    return values.every((value) => value !== undefined);
  });
  if (measures.length !== 1) return false;
  const values = result.rows.map((row) => numericCell(row[measures[0]!])!);
  return values.slice(1).every((value) => values[0]! > value);
}

function numericCell(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Normalize connector, MetricFlow, and provider result shapes at one boundary.
 * Connectors may return `ColumnMeta[]` and rows as arrays; UI surfaces should
 * never need to guess how to index those rows.
 */
export function normalizeCanonicalQueryResult(input: {
  columns?: unknown;
  rows?: unknown;
  rowCount?: unknown;
  executionTime?: unknown;
  executionTimeMs?: unknown;
  truncated?: unknown;
  resultFingerprint?: unknown;
  executionReceipt?: unknown;
  trustState?: unknown;
  answerTier?: unknown;
}): CanonicalQueryResultV1 {
  const columns = Array.isArray(input.columns)
    ? input.columns.map(columnName)
    : [];
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  const inferredColumns = columns.length > 0
    ? columns
    : objectRowColumns(rawRows).length > 0
      ? objectRowColumns(rawRows)
      : firstArrayRow(rawRows)
        ? firstArrayRow(rawRows)!.map((_, index) => `column_${index + 1}`)
        : [];
  const rows = rawRows.map((row) => normalizeRow(row, inferredColumns));
  const rowCount = typeof input.rowCount === 'number' && Number.isFinite(input.rowCount)
    ? Math.max(0, Math.trunc(input.rowCount))
    : rows.length;
  const executionTime = typeof input.executionTimeMs === 'number'
    ? input.executionTimeMs
    : typeof input.executionTime === 'number'
      ? input.executionTime
      : undefined;
  const canonical = {
    version: 1 as const,
    columns: inferredColumns,
    rows,
    rowCount,
    ...(executionTime !== undefined ? { executionTime } : {}),
    ...(input.truncated === true ? { truncated: true } : {}),
  };
  const receipt = input.executionReceipt && typeof input.executionReceipt === 'object'
    ? input.executionReceipt as DqlArtifactExecutionReceipt
    : undefined;
  const receiptFingerprint = typeof receipt?.resultFingerprint === 'string' ? receipt.resultFingerprint : undefined;
  const suppliedFingerprint = typeof input.resultFingerprint === 'string' && input.resultFingerprint.trim()
    ? input.resultFingerprint.trim()
    : receiptFingerprint;
  const trustState = input.trustState === 'certified'
    || input.trustState === 'governed'
    || input.trustState === 'review_required'
    || input.trustState === 'not_applicable'
    || input.trustState === 'blocked'
    ? input.trustState
    : undefined;
  return {
    ...canonical,
    ...(receipt ? { executionReceipt: receipt } : {}),
    ...(trustState ? { trustState } : {}),
    ...(typeof input.answerTier === 'string' && input.answerTier.trim()
      ? { answerTier: input.answerTier.trim() }
      : {}),
    // A connector/execution receipt is authoritative. The local digest is only
    // a backwards-compatible fallback for legacy unreceipted rows.
    resultFingerprint: suppliedFingerprint ?? stableFingerprint(canonical),
  };
}

export function canonicalResultRows(result: CanonicalQueryResultV1): unknown[][] {
  return result.rows.map((row) => result.columns.map((column) => row[column]));
}

export function assertCanonicalResult(result: CanonicalQueryResultV1): void {
  if (result.version !== 1) throw new Error('Unsupported analytical result contract version.');
  if (result.rowCount < result.rows.length) throw new Error('Result rowCount cannot be smaller than the returned rows.');
  if (new Set(result.columns).size !== result.columns.length) throw new Error('Result columns must be unique.');
  for (const row of result.rows) {
    for (const column of result.columns) {
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        throw new Error(`Result row is missing the declared column ${column}.`);
      }
    }
  }
}

export interface ContextCandidateCardV1 {
  id: string;
  lane: 'exact' | 'lexical' | 'vector' | 'graph' | 'runtime_value' | 'domain' | 'skill' | 'conversation'
    | 'certified' | 'semantic' | 'relational' | 'business';
  relevance: number;
  trust?: 'certified' | 'semantic' | 'governed_sql' | 'exploratory';
  compatible?: boolean;
  summary?: string;
}

export interface ContextFusionDiagnosticsV1 {
  lanes: Record<string, {
    returned: number;
    durationMs?: number;
    status?: 'ok' | 'empty' | 'error' | 'skipped';
    error?: string;
    skippedReason?: string;
  }>;
  selectedIds: string[];
  truncated: boolean;
}

export interface ContextFusionResultV1 {
  candidates: ContextCandidateCardV1[];
  diagnostics: ContextFusionDiagnosticsV1;
}

/** Reciprocal-rank fusion keeps recall across lexical, vector, and graph lanes. */
export function fuseContextCandidates(
  lanes: Record<string, ContextCandidateCardV1[]>,
  limit = 32,
): ContextFusionResultV1 {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const byId = new Map<string, ContextCandidateCardV1 & { score: number; lanes: Set<string> }>();
  const diagnostics: ContextFusionDiagnosticsV1 = { lanes: {}, selectedIds: [], truncated: false };
  for (const [lane, cards] of Object.entries(lanes)) {
    diagnostics.lanes[lane] = { returned: cards.length };
    cards.forEach((card, index) => {
      if (!card.id.trim()) return;
      const score = 1 / (60 + index + 1) + Math.max(0, Math.min(1, card.relevance)) * 0.25;
      const existing = byId.get(card.id);
      if (existing) {
        existing.score += score;
        existing.lanes.add(lane);
        if ((card.relevance ?? 0) > existing.relevance) existing.relevance = card.relevance;
        if (card.compatible === true) existing.compatible = true;
        if (!existing.summary && card.summary) existing.summary = card.summary;
      } else {
        byId.set(card.id, { ...card, score, lanes: new Set([lane]) });
      }
    });
  }
  const selected = [...byId.values()]
    .sort((left, right) => right.score - left.score || right.relevance - left.relevance || left.id.localeCompare(right.id))
    .slice(0, safeLimit)
    .map(({ score: _score, lanes: _lanes, ...card }) => card);
  diagnostics.selectedIds = selected.map((card) => card.id);
  diagnostics.truncated = byId.size > selected.length;
  return { candidates: selected, diagnostics };
}

export async function retrieveContextLanes(
  lanes: Record<string, () => Promise<ContextCandidateCardV1[]>>,
  limit = 32,
  maxConcurrent = 4,
): Promise<ContextFusionResultV1> {
  const entries = Object.entries(lanes);
  const concurrency = Math.max(1, Math.min(8, Math.trunc(maxConcurrent) || 1));
  const settled: Array<readonly [string, ContextCandidateCardV1[] | { error: string }, number]> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry) return;
      const [name, retrieve] = entry;
      const startedAt = Date.now();
      try {
        const cards = await retrieve();
        settled[index] = [name, cards, Date.now() - startedAt];
      } catch (error) {
        settled[index] = [name, { error: error instanceof Error ? error.message : String(error) }, Date.now() - startedAt];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
  const successful: Record<string, ContextCandidateCardV1[]> = {};
  const errors: Record<string, string> = {};
  const durations: Record<string, number> = {};
  for (const [name, result, durationMs] of settled) {
    durations[name] = durationMs;
    if (Array.isArray(result)) successful[name] = result;
    else errors[name] = result.error;
  }
  const fused = fuseContextCandidates(successful, limit);
  for (const [name, cards] of Object.entries(successful)) {
    fused.diagnostics.lanes[name] = {
      returned: cards.length,
      durationMs: durations[name],
      status: cards.length > 0 ? 'ok' : 'empty',
    };
  }
  for (const [name, error] of Object.entries(errors)) {
    fused.diagnostics.lanes[name] = {
      returned: 0,
      durationMs: durations[name],
      status: 'error',
      error,
    };
  }
  return fused;
}

export interface ResearchLedgerEntryV1 {
  id: string;
  branchId: string;
  question: string;
  status: 'observed' | 'failed' | 'skipped';
  /** Optional complete execution proof; arbitrary IDs are never accepted. */
  executionReceipt?: DqlArtifactExecutionReceipt;
  resultFingerprint?: string;
  rowCount?: number;
  facts: string[];
  receipts: string[];
  error?: string;
}

export interface ResearchEvidenceLedgerV1 {
  version: 1;
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchLedgerEntryV1[];
  factIds: string[];
  stoppingReason: 'completed' | 'budget' | 'insufficient_evidence' | 'blocked' | 'not_started';
}

export type ResearchEvidenceVerdictV2 = 'supported' | 'contradicted' | 'inconclusive' | 'failed' | 'skipped';

/** Deterministic observation classes; none infer causality from returned rows. */
export type ResearchEvidenceValidatorKindV2 = 'trend' | 'comparison' | 'contributor' | 'anomaly' | 'freshness' | 'counter_evidence';

export interface ResearchEvidenceValidatorV2 {
  version: 1;
  kind: ResearchEvidenceValidatorKindV2;
  /** True only when a deterministic, receipt-bound predicate was evaluated. */
  evaluated: boolean;
  /** Optional non-causal observation result. Absent means inconclusive. */
  outcome?: 'supports_observation' | 'contradicts_observation';
  receiptFingerprints: string[];
}

export interface ResearchHypothesisPlanEntryV2 {
  id: string;
  statement: string;
  expectation: string;
  targetId: string;
  validatorKind: ResearchEvidenceValidatorKindV2;
}

export interface ResearchHypothesisPlanV2 {
  version: 2;
  hypotheses: ResearchHypothesisPlanEntryV2[];
  limitedScope: boolean;
}

/**
 * V2 makes the difference between a returned row and an evaluated hypothesis
 * explicit. A branch may be observed yet inconclusive; it is never promoted to
 * a causal claim merely because it executed.
 */
export interface ResearchEvidenceLedgerEntryV2 extends ResearchLedgerEntryV1 {
  verdict: ResearchEvidenceVerdictV2;
  hypothesis?: string;
  validator?: ResearchEvidenceValidatorV2;
  counterEvidenceFactIds: string[];
}

export interface ResearchEvidenceLedgerV2 {
  version: 2;
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchEvidenceLedgerEntryV2[];
  factIds: string[];
  groundableBranchCount: number;
  limitedScope: boolean;
  stoppingReason: ResearchEvidenceLedgerV1['stoppingReason'];
}

export function capResearchBranches<T>(branches: T[], max = 6): T[] {
  return branches.slice(0, Math.max(1, Math.min(6, Math.trunc(max))));
}

export function buildResearchEvidenceLedger(input: {
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchLedgerEntryV1[];
  stoppingReason?: ResearchEvidenceLedgerV1['stoppingReason'];
}): ResearchEvidenceLedgerV1 {
  const entries = input.entries.slice(0, 6).map((entry) => {
    const resultFingerprint = normalizeAnalyticalExecutionFingerprint(entry.resultFingerprint);
    const executionReceipt = normalizeAnalyticalExecutionReceipt(entry.executionReceipt);
    const receiptFingerprint = executionReceipt?.resultFingerprint;
    const listedFingerprint = entry.receipts
      .map((receipt) => normalizeAnalyticalExecutionFingerprint(receipt))
      .find((receipt): receipt is string => Boolean(receipt));
    const executionProof = resultFingerprint ?? receiptFingerprint ?? listedFingerprint;

    // A receipt/result proof is meaningful only for an observed branch. Never
    // carry a preloaded receipt, child ID, context-pack ID, or malformed
    // fingerprint through a failed/cancelled/skipped entry.
    if (entry.status !== 'observed') {
      const { executionReceipt: _receipt, resultFingerprint: _fingerprint, ...withoutProof } = entry;
      return { ...withoutProof, receipts: [] };
    }

    // A ready/observed branch without a complete receipt or canonical result
    // fingerprint is not an observation. Downgrade it and retain no invented
    // proof; callers can still inspect the branch and retry it explicitly.
    if (!executionProof) {
      const { executionReceipt: _receipt, resultFingerprint: _fingerprint, ...withoutProof } = entry;
      return {
        ...withoutProof,
        status: 'failed' as const,
        receipts: [],
        error: entry.error ?? 'Research branch had no valid execution receipt or canonical result fingerprint.',
      };
    }

    return {
      ...entry,
      status: 'observed' as const,
      resultFingerprint: executionProof,
      ...(executionReceipt ? { executionReceipt } : {}),
      receipts: [executionProof],
    };
  });
  return {
    version: 1,
    rootQuestion: input.rootQuestion,
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    entries,
    factIds: [...new Set(entries.flatMap((entry) => entry.facts))],
    stoppingReason: input.stoppingReason ?? (entries.length > 0 ? 'completed' : 'not_started'),
  };
}

export function buildResearchEvidenceLedgerV2(input: {
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  /** Number of catalog-grounded branches admitted before execution. A runtime
   * failure must not be misreported as if the catalog had fewer hypotheses. */
  groundableBranchCount?: number;
  entries: Array<ResearchLedgerEntryV1 & {
    verdict?: ResearchEvidenceVerdictV2;
    hypothesis?: string;
    validator?: ResearchEvidenceValidatorV2;
    counterEvidenceFactIds?: string[];
  }>;
  stoppingReason?: ResearchEvidenceLedgerV1['stoppingReason'];
}): ResearchEvidenceLedgerV2 {
  const v1 = buildResearchEvidenceLedger(input);
  const entries = v1.entries.map((entry, index) => {
    const source = input.entries[index];
    const validator = normalizeResearchEvidenceValidator(source?.validator, entry);
    const requestedVerdict = /\b(?:because|caused?|driven by|due to)\b/i.test(source?.hypothesis ?? '')
      ? undefined
      : source?.verdict;
    const verdict = researchVerdictFromValidatedObservation({
      status: entry.status,
      requestedVerdict,
      validator,
    });
    const validFactIds = new Set(entry.facts);
    const counterEvidenceFactIds = [...new Set(source?.counterEvidenceFactIds ?? [])]
      .filter((factId) => validFactIds.has(factId));
    return {
      ...entry,
      verdict,
      ...(source?.hypothesis?.trim() ? { hypothesis: source.hypothesis.trim() } : {}),
      ...(validator ? { validator } : {}),
      counterEvidenceFactIds,
    };
  });
  const observedGroundableBranchCount = entries.filter((entry) => entry.status === 'observed' && entry.verdict !== 'failed' && entry.verdict !== 'skipped').length;
  const plannedGroundableBranchCount = Math.max(0, Math.min(6, Math.trunc(input.groundableBranchCount ?? 0)));
  const groundableBranchCount = Math.max(observedGroundableBranchCount, plannedGroundableBranchCount);
  return {
    version: 2,
    rootQuestion: v1.rootQuestion,
    ...(v1.planId ? { planId: v1.planId } : {}),
    ...(v1.snapshotId ? { snapshotId: v1.snapshotId } : {}),
    entries,
    factIds: [...new Set(entries.flatMap((entry) => [...entry.facts, ...entry.counterEvidenceFactIds]))],
    groundableBranchCount,
    limitedScope: groundableBranchCount < 3,
    stoppingReason: v1.stoppingReason,
  };
}

/**
 * Normalise a hypothesis plan into the bounded research contract. The caller
 * may supply fewer than three grounded hypotheses; that is retained honestly as
 * limited scope rather than padded with invented joins or explanations.
 */
export function buildResearchHypothesisPlanV2(input: {
  hypotheses: Array<{
    id?: string;
    statement: string;
    expectation: string;
    targetId: string;
    validatorKind?: ResearchEvidenceValidatorKindV2;
  }>;
}): ResearchHypothesisPlanV2 {
  const seen = new Set<string>();
  const hypotheses: ResearchHypothesisPlanEntryV2[] = [];
  for (const candidate of input.hypotheses) {
    const statement = candidate.statement.trim();
    const expectation = candidate.expectation.trim();
    const targetId = candidate.targetId.trim();
    if (!statement || !expectation || !targetId) continue;
    const key = `${statement.toLowerCase()}\u0000${targetId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hypotheses.push({
      id: candidate.id?.trim() || `hypothesis:${hypotheses.length + 1}`,
      statement,
      expectation,
      targetId,
      validatorKind: candidate.validatorKind ?? inferResearchValidatorKind(statement, expectation),
    });
    if (hypotheses.length >= 6) break;
  }
  return { version: 2, hypotheses, limitedScope: hypotheses.length < 3 };
}

/** Map an action/expectation to a deterministic observation class only. */
export function inferResearchValidatorKind(statement: string, expectation = ''): ResearchEvidenceValidatorKindV2 {
  const text = `${statement} ${expectation}`.toLowerCase();
  if (/fresh|updated|stale|as of|recency/.test(text)) return 'freshness';
  if (/contribut|driver|segment|breakdown|dominant/.test(text)) return 'contributor';
  if (/trend|time|month|week|quarter|year|shift|change/.test(text)) return 'trend';
  if (/compare|versus|vs\.?|difference/.test(text)) return 'comparison';
  if (/anomal|outlier|spike|drop/.test(text)) return 'anomaly';
  return 'counter_evidence';
}

/**
 * A verdict is promoted only from a validator that evaluated a deterministic
 * observation against a branch receipt. Rows by themselves stay inconclusive;
 * causal statements are never supported by this helper.
 */
export function researchVerdictFromValidatedObservation(input: {
  status: ResearchLedgerEntryV1['status'];
  requestedVerdict?: ResearchEvidenceVerdictV2;
  validator?: ResearchEvidenceValidatorV2;
}): ResearchEvidenceVerdictV2 {
  if (input.status === 'failed') return 'failed';
  if (input.status === 'skipped') return 'skipped';
  if (!input.validator?.evaluated || input.validator.receiptFingerprints.length === 0) return 'inconclusive';
  if (input.requestedVerdict === 'supported' && input.validator.outcome === 'supports_observation') return 'supported';
  if (input.requestedVerdict === 'contradicted' && input.validator.outcome === 'contradicts_observation') return 'contradicted';
  return 'inconclusive';
}

function normalizeResearchEvidenceValidator(
  validator: ResearchEvidenceValidatorV2 | undefined,
  entry: ResearchLedgerEntryV1,
): ResearchEvidenceValidatorV2 | undefined {
  if (!validator || validator.version !== 1) return undefined;
  const knownReceipt = entry.resultFingerprint;
  const receiptFingerprints = [...new Set(validator.receiptFingerprints)]
    .map(normalizeAnalyticalExecutionFingerprint)
    .filter((fingerprint): fingerprint is string => Boolean(fingerprint))
    .filter((fingerprint) => !knownReceipt || fingerprint === knownReceipt);
  return {
    version: 1,
    kind: validator.kind,
    evaluated: validator.evaluated === true && receiptFingerprints.length > 0,
    ...(validator.outcome ? { outcome: validator.outcome } : {}),
    receiptFingerprints,
  };
}

/** The only accepted host-side execution identity is a SHA-256 fingerprint. */
export function normalizeAnalyticalExecutionFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

/**
 * Normalize a complete DQL execution receipt. A partial object or arbitrary
 * identifier is deliberately not execution evidence.
 */
export function normalizeAnalyticalExecutionReceipt(value: unknown): DqlArtifactExecutionReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourceFingerprint = normalizeAnalyticalExecutionFingerprint(record.sourceFingerprint);
  const compiledSqlFingerprint = normalizeAnalyticalExecutionFingerprint(record.compiledSqlFingerprint);
  const parameterFingerprint = normalizeAnalyticalExecutionFingerprint(record.parameterFingerprint);
  const resultFingerprint = normalizeAnalyticalExecutionFingerprint(record.resultFingerprint);
  return sourceFingerprint && compiledSqlFingerprint && parameterFingerprint && resultFingerprint
    ? { sourceFingerprint, compiledSqlFingerprint, parameterFingerprint, resultFingerprint }
    : undefined;
}

export function buildCoverageGap(input: Omit<AnalyticalCoverageGapV1, 'version'>): AnalyticalCoverageGapV1 {
  return { version: 1, ...input };
}

function columnName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return String((value as { name: unknown }).name);
  }
  return String(value ?? 'column');
}

function objectRowColumns(rows: unknown[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const column of Object.keys(row as Record<string, unknown>)) columns.add(column);
  }
  return [...columns];
}

function firstArrayRow(rows: unknown[]): unknown[] | undefined {
  const row = rows.find((candidate) => Array.isArray(candidate));
  return row as unknown[] | undefined;
}

function normalizeRow(row: unknown, columns: string[]): Record<string, unknown> {
  if (Array.isArray(row)) return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  if (row && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    return Object.fromEntries(columns.map((column) => [column, record[column]]));
  }
  return Object.fromEntries(columns.map((column) => [column, undefined]));
}

function stableFingerprint(value: unknown): string {
  const text = stableStringify(value);
  return createHash('sha256').update(text).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
