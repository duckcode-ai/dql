/**
 * Compact, provider-agnostic evidence contracts for retrieval-first routing.
 *
 * Retrieval owns recall and ranking. The meaning resolver sees only this bounded
 * package and may reference only IDs contained in it. Execution remains owned by
 * the host after it validates the selected candidates and route.
 */

import type {
  AnalyticalPolicyContract,
  AnalyticalQuestionFrameV2,
  MetricCapabilityContract,
} from '@duckcodeailabs/dql-core';
import type { KnowledgeLens } from './domain-context.js';
import {
  buildAnalyticalRequirementSet,
  evidenceCandidateRoles,
  selectRoleBalancedMeaningCandidates,
  type ContextSourceCoverageV1,
} from './analytical-orchestration.js';

export type AgentEvidenceKind =
  | "certified_block"
  | "semantic_metric"
  | "semantic_member"
  | "dql_modeling"
  | "dbt_model"
  | "dbt_source"
  | "sql_table"
  | "sql_column";

export type AgentEvidenceTrustTier = "certified" | "semantic" | "governed_sql" | "exploratory";
export type AgentEvidenceCompatibility = "compatible" | "partial" | "incompatible" | "unknown";

/**
 * Compact, snapshot-bound relationship proof carried beside raw evidence.
 *
 * Relationship IDs are identities, not safety claims.  Hosts may only use this
 * record to permit an automatic exploratory composition after the router has
 * checked its lifecycle, validation, fanout, cardinality, and join authority.
 * Keeping the proof structured prevents a friendly-looking relationship name
 * from accidentally authorizing a join.
 */
export interface AgentRelationshipSafetyEvidence {
  /** Canonical, qualified relationship identity. */
  id: string;
  /** Other snapshot identities for the same relationship; never safety facts. */
  aliases?: string[];
  from?: string;
  to?: string;
  keys: Array<{ from: string; to: string }>;
  status?: string;
  cardinality?: string;
  fanout?: string;
  staleCertification?: boolean;
  automaticJoinAllowed?: boolean;
  certificationFingerprint?: string;
  evidenceExpiresAt?: string;
  validation?: {
    status?: string;
    checkedAt?: string;
    queryFingerprint?: string;
    proofFingerprint?: string;
  };
}

export interface AgentEvidenceCandidate {
  /** Stable, source-qualified ID. Leaf names are not valid identities. */
  id: string;
  /** Canonical registry identity; `id` may remain a legacy execution key during shadow rollout. */
  qualifiedId?: string;
  kind: AgentEvidenceKind;
  /** Exact semantic registry object class when `kind` intentionally collapses members. */
  semanticObjectType?: 'metric' | 'measure' | 'dimension' | 'entity' | 'model' | 'saved_query';
  trustTier: AgentEvidenceTrustTier;
  name: string;
  aliases?: string[];
  definition?: string;
  formula?: string;
  aggregation?: string;
  /** Source provenance retained so routing can distinguish authored metrics from measure-derived execution shims. */
  provenance?: string;
  domain?: string;
  semanticModel?: string;
  primaryEntity?: string;
  dimensions?: string[];
  timeGrains?: string[];
  requiredParameters?: string[];
  sourceObjects?: string[];
  relationshipEvidence?: string[];
  /** Canonical modeling entity IDs proven to bind this physical relation. */
  relationshipEndpointIds?: string[];
  /** Structured relationship proof; IDs alone can never authorize a join. */
  relationshipSafety?: AgentRelationshipSafetyEvidence[];
  /** Cross-source relevance score normalized to 0..1 by the retriever. */
  relevanceScore: number;
  matchReasons: string[];
  compatibility: AgentEvidenceCompatibility;
  compatibilityFacts?: string[];
  /** Normalized executable capability. Names alone never supply missing facts. */
  analyticalCapability?: MetricCapabilityContract;
  /** Deterministic certified-asset fit; ignored for non-certified evidence. */
  analyticalFitClass?: 'exact' | 'parameterized' | 'adaptable';
  /** False means the object must not be shown to the resolver. */
  eligible?: boolean;
  /** True only for an exact qualified/name/approved-alias match. */
  exactMatch?: boolean;
}

/**
 * Return the authored output identity that proves a certified block can answer
 * one requested measure.  This reads only the block's own `output:` facts,
 * which are populated from declared/output-contract fields at indexing time.
 * Block names, tags, examples, definitions, and unrelated retrieved metrics
 * are intentionally absent: none of those is an executable output contract.
 */
export function certifiedCandidateDeclaredMeasureOutput(
  candidate: AgentEvidenceCandidate,
  requested: string,
): string | undefined {
  if (candidate.kind !== 'certified_block') return undefined;
  const requestedIdentity = canonicalCertifiedOutputMetricIdentity(requested);
  if (!requestedIdentity) return undefined;
  const declared = (candidate.compatibilityFacts ?? [])
    .flatMap((fact) => /^output:\s*(.+)$/i.exec(fact)?.[1] ?? [])
    .map((output) => output.trim())
    .filter(Boolean);
  return declared.find((output) =>
    canonicalCertifiedOutputMetricIdentity(output) === requestedIdentity,
  );
}

/**
 * A certified tier can freeze only when the selected block itself declares
 * every requested measure.  This is deliberately stricter than retrieval
 * relevance: `top_customers` tagged with revenue but outputting only
 * `lifetime_spend` is context, never a certified revenue answer.
 */
export function certifiedCandidateExplicitlyCoversMeasures(
  candidate: AgentEvidenceCandidate,
  requestedMeasures: string[] | undefined,
): boolean {
  if (candidate.kind !== 'certified_block') return false;
  const requested = [...new Set((requestedMeasures ?? [])
    .map(canonicalCertifiedOutputMetricIdentity)
    .filter(Boolean))];
  const effectiveRequested = requested.length > 1
    ? requested.filter((measure) => measure !== 'total' && measure !== 'average')
    : requested;
  return effectiveRequested.every((measure) =>
    Boolean(certifiedCandidateDeclaredMeasureOutput(candidate, measure)),
  );
}

/**
 * Output identity deliberately has a much smaller alias surface than retrieval
 * matching. Generic presentation modifiers are safe (gross/total/monthly
 * revenue); business qualifiers are not (product revenue, beverage revenue,
 * lifetime spend). This mirrors the certified fit gate and prevents a loosely
 * correlated output from borrowing another metric's authority.
 */
function canonicalCertifiedOutputMetricIdentity(value: string): string {
  const aliases: Record<string, string> = {
    avg: 'average',
    drink: 'beverage',
    score: 'point',
    scorer: 'point',
    scoring: 'point',
    sum: 'total',
  };
  const genericModifiers = new Set([
    'annual', 'average', 'current', 'daily', 'gross', 'monthly', 'net',
    'quarterly', 'total', 'yearly',
  ]);
  // A typed resolver may retain a qualified metric selection in
  // queryIntent. Only its leaf is comparable to a block output; the namespace
  // is authority metadata, not part of the returned column identity.
  const outputLeaf = value.includes(':')
    ? value.split(':').filter(Boolean).at(-1) ?? value
    : value;
  const tokens = outputLeaf
    .toLowerCase()
    .replace(/%/g, ' percentage ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .map((token) => aliases[token] ?? token)
    .map((token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token)
    .filter(Boolean);
  while (tokens.length > 1 && genericModifiers.has(tokens[0]!)) tokens.shift();
  while (tokens.length > 1 && genericModifiers.has(tokens.at(-1)!)) tokens.pop();
  return tokens.join('_');
}

export interface AgentRetrievalEvidence {
  snapshotId?: string;
  sourceFingerprint?: string;
  knowledgeLens?: KnowledgeLens;
  candidates: AgentEvidenceCandidate[];
  /**
   * Already-retrieved, qualified cards reserved for deterministic host
   * clarification. They do not enter the smaller provider meaning package.
   */
  clarificationCandidates?: AgentEvidenceCandidate[];
  parsedIntent?: Partial<MeaningQueryIntent>;
  /**
   * Member values the reader named that could NOT be bound to a governed value.
   * Live value grounding is opt-in per project, so with it disabled a named
   * member silently vanished from the plan and the run answered as though no
   * member had been asked for.
   */
  unboundMemberTerms?: string[];
  /** Snapshot-compiled policy only; Skill prose never enters route authority. */
  analyticalPolicies?: AnalyticalPolicyContract[];
  /** A snapshot-declared fiscal calendar; absence is never guessed from FY text. */
  fiscalCalendar?: {
    id: string;
    fiscalPeriodFieldId: string;
    /** Required at execution time; optional here preserves older snapshots. */
    dateRoleId?: string;
  };
  diagnostics?: {
    searchedKinds?: AgentEvidenceKind[];
    durationMs?: number;
    truncated?: boolean;
    /** Actual retrieval-lane/source state captured with this snapshot. */
    sourceCoverage?: ContextSourceCoverageV1[];
  };
}

export interface MeaningQueryIntent {
  measures: string[];
  dimensions: string[];
  filters: Array<{ field: string; value: string }>;
  timeRange?: string;
  timeGrain?: string;
  order?: "asc" | "desc";
  limit?: number;
  /** Snapshot-bound fiscal binding injected only after a declared calendar is found. */
  fiscalCalendarId?: string;
  /** Declared date role paired with the fiscal calendar; never inferred from text. */
  fiscalDateRoleId?: string;
}

export type MeaningQuestionType =
  | "definition"
  | "value"
  | "ranking"
  | "trend"
  | "comparison"
  | "diagnosis"
  | "research";

export type MeaningExecutionRoute = "certified" | "semantic" | "governed_sql" | "exploratory" | "clarify";
export type MeaningConfidence = "high" | "medium" | "low";

export interface MeaningResolution {
  interpretedQuestion: string;
  questionType: MeaningQuestionType;
  selectedConceptIds: string[];
  recommendedExecutionId?: string;
  queryIntent: MeaningQueryIntent;
  rejectedCandidates: Array<{ id: string; reason: string }>;
  confidence: MeaningConfidence;
  missingInformation: string[];
  recommendedRoute: MeaningExecutionRoute;
  clarifyingQuestion?: string;
  /** RFC 0005 exact analytical meaning; absent for stored/simple v1 requests. */
  analyticalFrame?: AnalyticalQuestionFrameV2;
  /** Exact eligible structured policies applied by the deterministic solver. */
  analyticalPolicyIds?: string[];
  /** Host-owned result of deterministic capability solving; never model-authored. */
  compatibilityOutcome?: 'clarify' | 'modeling_gap' | 'policy_blocked';
  /** Stable solver codes and qualified candidates retained for route diagnostics. */
  compatibilityFailures?: Array<{
    code: string;
    field: string;
    message: string;
    candidateIds: string[];
  }>;
}

export interface MeaningResolutionInput {
  question: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  signal?: AbortSignal;
}

export type AgentMeaningResolver = (input: MeaningResolutionInput) => Promise<MeaningResolution>;

const TRUST_ORDER: Record<AgentEvidenceTrustTier, number> = {
  certified: 4,
  semantic: 3,
  governed_sql: 2,
  exploratory: 1,
};

const COMPATIBILITY_ORDER: Record<AgentEvidenceCompatibility, number> = {
  compatible: 4,
  partial: 3,
  unknown: 2,
  incompatible: 1,
};

/**
 * Produce the bounded evidence package sent to the resolver. Relevance remains
 * primary; trust is only a tie-breaker, so an unrelated certified block cannot
 * displace a materially better semantic match.
 */
export function buildMeaningEvidencePackage(
  evidence: AgentRetrievalEvidence,
  maxCandidates = 16,
  question = '',
): AgentEvidenceCandidate[] {
  const limit = Math.max(1, Math.min(16, Math.floor(maxCandidates)));
  const perKindLimit = Math.max(2, Math.ceil(limit / 2));
  const requirements = buildAnalyticalRequirementSet({ question, parsedIntent: evidence.parsedIntent });
  // First reserve exact and required-role candidates from the FULL canonical
  // set. Applying the same-kind cap first let eight high-scoring owner/sentiment
  // dimensions erase the explicit revenue metric and Account Name before the
  // role-aware admission code ever saw them.
  const canonicalEligible = canonicalizeMetricMeasureCandidates(evidence.candidates)
    .filter((candidate) => candidate.eligible !== false)
    .sort(compareCandidates);
  const rawPinned = selectRoleBalancedMeaningCandidates({
    candidates: canonicalEligible,
    requirements,
    maxCandidates: limit,
    pinOnly: true,
  });
  // Guard the fill and the pins themselves. A terse request for "accounts"
  // must not retain Account Owner / Sentiment merely because a generic
  // categorical-dimension parser also saw the token "account". An explicit
  // attribute request remains eligible.
  const requestedEntityDisplay = requirements.entityDisplayTerms.length > 0;
  const explicitlyRequestsAttribute = /\b(?:owner|sentiment|email)\b/i.test(question);
  const hasRawPinnedEntityLabel = rawPinned.some((candidate) => evidenceCandidateRoles(candidate).includes('entity_label'));
  const pinned = requestedEntityDisplay && hasRawPinnedEntityLabel && !explicitlyRequestsAttribute
    ? rawPinned.filter((candidate) => !/\b(?:owner|sentiment|email)\b/i.test(candidate.name))
    : rawPinned;
  const kindCounts = new Map<AgentEvidenceKind, number>();
  const perKindQualified = canonicalEligible
    .filter((candidate) => {
      // Metric and member evidence share the semantic trust tier but serve
      // different binding lanes. Counting only by trust let several exact
      // member values crowd the executable metric out of the resolver package.
      // Bound noise per evidence kind so every retrieved lane retains recall;
      // downstream compatibility still owns execution authority.
      const count = kindCounts.get(candidate.kind) ?? 0;
      if (count >= perKindLimit) return false;
      kindCounts.set(candidate.kind, count + 1);
      return true;
    });
  // Fill the remaining package under the kind cap without evicting a pin. The
  // resolver still receives at most 16 cards and exactly one meaning call.
  const hasPinnedEntityLabel = pinned.some((candidate) => evidenceCandidateRoles(candidate).includes('entity_label'));
  const safeFill = perKindQualified.filter((candidate) => {
    if (pinned.some((pin) => pin.id === candidate.id)) return false;
    // An account owner/e-mail/sentiment is an attribute, never a substitute
    // for the requested account/customer display entity. Do not let it consume
    // the remaining meaning cards after that display role was successfully pinned.
    return !hasPinnedEntityLabel || !/\b(?:owner|sentiment|email)\b/i.test(candidate.name);
  });
  return [...pinned, ...safeFill]
    .slice(0, limit);
}

/**
 * A dbt semantic metric and its backing measure are one execution authority,
 * not two business meanings. Retain the metric capability and suppress only
 * exact measure identities named by that capability; unrelated measures remain
 * available for genuine ambiguity and multi-metric questions.
 */
export function canonicalizeMetricMeasureCandidates(
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const backingMeasureIds = new Set(candidates.flatMap((candidate) =>
    candidate.semanticObjectType === 'metric'
      || candidate.kind === 'semantic_metric'
      ? candidate.analyticalCapability?.measureIds ?? []
      : []));
  return candidates.filter((candidate) => {
    if (candidate.semanticObjectType !== 'measure') return true;
    return ![candidate.id, candidate.qualifiedId]
      .filter((value): value is string => Boolean(value))
      .some((identity) => backingMeasureIds.has(identity));
  });
}

function compareCandidates(left: AgentEvidenceCandidate, right: AgentEvidenceCandidate): number {
  return Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
    || clamp01(right.relevanceScore) - clamp01(left.relevanceScore)
    || COMPATIBILITY_ORDER[right.compatibility] - COMPATIBILITY_ORDER[left.compatibility]
    || TRUST_ORDER[right.trustTier] - TRUST_ORDER[left.trustTier]
    || left.id.localeCompare(right.id);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Match only explicit qualified references; ordinary names still use resolution. */
export function findExplicitEvidenceReference(
  question: string,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  const refs = new Set<string>();
  for (const match of question.matchAll(/@(metric|block|model|table|column)\(([^)]+)\)/gi)) {
    refs.add(normalizeRef(match[2]));
  }
  for (const candidate of candidates) {
    if (question.includes(candidate.id)) refs.add(normalizeRef(candidate.id));
  }
  if (refs.size === 0) return undefined;
  const matches = candidates.filter((candidate) => {
    const candidateRefs = [candidate.id, candidate.name, ...(candidate.aliases ?? [])].map(normalizeRef);
    return candidateRefs.some((ref) => refs.has(ref));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeRef(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, "");
}

/** Validate that a resolver cannot invent or select ineligible evidence. */
export function validateMeaningResolution(
  value: MeaningResolution,
  candidates: AgentEvidenceCandidate[],
  requestedMeasures: string[] = value.queryIntent.measures,
): { ok: true; resolution: MeaningResolution } | { ok: false; reason: string } {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selectedConceptIds = value.selectedConceptIds.length > 0
    ? value.selectedConceptIds
    : value.recommendedExecutionId
      ? [value.recommendedExecutionId]
      : [];
  const referencedIds = [
    ...value.selectedConceptIds,
    ...(value.recommendedExecutionId ? [value.recommendedExecutionId] : []),
    ...value.rejectedCandidates.map((candidate) => candidate.id),
  ];
  const invented = referencedIds.find((id) => !byId.has(id));
  if (invented) return { ok: false, reason: `The resolver referenced evidence that was not retrieved: ${invented}` };
  if (value.confidence !== "low" && selectedConceptIds.length === 0) {
    return { ok: false, reason: "A medium/high-confidence resolution must select at least one retrieved concept." };
  }
  const selected = selectedConceptIds.map((id) => byId.get(id)!);
  if (selected.some((candidate) => candidate.eligible === false || candidate.compatibility === "incompatible")) {
    return { ok: false, reason: "The resolver selected ineligible or incompatible evidence." };
  }
  const rejectedIds = new Set(value.rejectedCandidates.map((candidate) => candidate.id));
  if (selectedConceptIds.some((id) => rejectedIds.has(id))) {
    return { ok: false, reason: "The resolver both selected and rejected the same evidence." };
  }
  const executionId = value.recommendedExecutionId ?? value.selectedConceptIds[0];
  if (executionId) {
    const execution = byId.get(executionId)!;
    if (execution.eligible === false || execution.compatibility === "incompatible") {
      return { ok: false, reason: "The recommended execution evidence is ineligible or incompatible." };
    }
    if (value.recommendedRoute === "certified" && execution.kind !== "certified_block") {
      return { ok: false, reason: "A certified route must reference a certified block." };
    }
    if (value.recommendedRoute === "certified" && execution.compatibility !== "compatible") {
      return { ok: false, reason: "A certified route requires a deterministically compatible block fit." };
    }
    if (value.recommendedRoute === 'certified'
      && !certifiedCandidateExplicitlyCoversMeasures(execution, requestedMeasures)) {
      return {
        ok: false,
        reason: 'A certified route must declare every requested measure in the selected block output contract.',
      };
    }
    if (value.recommendedRoute === "semantic" && execution.kind !== "semantic_metric" && execution.kind !== "semantic_member") {
      return { ok: false, reason: "A semantic route must reference semantic evidence." };
    }
    if (value.recommendedRoute === "semantic" && execution.compatibility !== "compatible") {
      return { ok: false, reason: "A semantic route requires deterministic measure, grain, and dimension compatibility." };
    }
  }
  if (value.analyticalFrame) {
    const invalidFrameReference = firstInvalidAnalyticalFrameReference(
      value.analyticalFrame,
      candidates,
      executionId,
    );
    if (invalidFrameReference) {
      return { ok: false, reason: `The analytical frame referenced evidence that was not retrieved: ${invalidFrameReference}` };
    }
  }
  return {
    ok: true,
    resolution: selectedConceptIds === value.selectedConceptIds
      ? value
      : { ...value, selectedConceptIds },
  };
}

function firstInvalidAnalyticalFrameReference(
  frame: AnalyticalQuestionFrameV2,
  candidates: AgentEvidenceCandidate[],
  executionId?: string,
): string | undefined {
  const metricIds = new Set<string>();
  const dimensionIds = new Set<string>();
  const entityIds = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const candidate of candidates) {
    evidenceIds.add(candidate.id);
    if (candidate.qualifiedId) evidenceIds.add(candidate.qualifiedId);
    if (candidate.kind === 'semantic_metric') {
      metricIds.add(candidate.id);
      if (candidate.qualifiedId) metricIds.add(candidate.qualifiedId);
    }
    if (candidate.kind === 'semantic_member') {
      dimensionIds.add(candidate.id);
      if (candidate.qualifiedId) dimensionIds.add(candidate.qualifiedId);
    }
    if (candidate.primaryEntity) entityIds.add(candidate.primaryEntity);
    for (const dimension of candidate.dimensions ?? []) dimensionIds.add(dimension);
    const capability = candidate.analyticalCapability;
    if (!capability) continue;
    metricIds.add(capability.metricId);
    entityIds.add(capability.primaryEntityId);
    for (const grain of capability.resultGrainIds) entityIds.add(grain);
    for (const dimension of capability.dimensions) dimensionIds.add(dimension.dimensionId);
    for (const dimension of capability.timeDimensions) dimensionIds.add(dimension.dimensionId);
  }
  const checks: Array<[string, Iterable<string>, Set<string>]> = [
    ['metric', frame.metricConceptIds, metricIds],
    ['entity grain', frame.entityGrainIds, entityIds],
    ['dimension', frame.dimensions.map((dimension) => dimension.dimensionId), dimensionIds],
    ['member dimension', frame.memberBindings.map((binding) => binding.dimensionId), dimensionIds],
    ['output metric', frame.requestedOutputs.flatMap((output) => output.metricId ? [output.metricId] : []), metricIds],
  ];
  if (frame.timeContext?.timeDimensionId) {
    checks.push(['time dimension', [frame.timeContext.timeDimensionId], dimensionIds]);
  }
  if (frame.ranking) {
    checks.push(
      ['ranking dimension', [frame.ranking.entityDimensionId], dimensionIds],
      ['ranking metric', [frame.ranking.byMetricId], metricIds],
    );
  }
  for (const [kind, ids, allowed] of checks) {
    for (const id of ids) if (!allowed.has(id)) return `${kind} ${id}`;
  }
  const selected = executionId
    ? candidates.find((candidate) => candidate.id === executionId || candidate.qualifiedId === executionId)
    : undefined;
  const selectedCapability = selected?.analyticalCapability;
  if (selectedCapability) {
    const selectedMetricIds = new Set([selectedCapability.metricId]);
    const selectedDimensionIds = new Set([
      ...selectedCapability.dimensions.map((dimension) => dimension.dimensionId),
      ...selectedCapability.timeDimensions.map((dimension) => dimension.dimensionId),
    ]);
    const selectedEntityIds = new Set([
      selectedCapability.primaryEntityId,
      ...selectedCapability.resultGrainIds,
    ]);
    const selectedChecks: Array<[string, Iterable<string>, Set<string>]> = [
      ['selected capability metric', frame.metricConceptIds, selectedMetricIds],
      ['selected capability entity grain', frame.entityGrainIds, selectedEntityIds],
      ['selected capability dimension', frame.dimensions.map((dimension) => dimension.dimensionId), selectedDimensionIds],
      ['selected capability member dimension', frame.memberBindings.map((binding) => binding.dimensionId), selectedDimensionIds],
    ];
    if (frame.ranking) {
      selectedChecks.push(
        ['selected capability ranking dimension', [frame.ranking.entityDimensionId], selectedDimensionIds],
        ['selected capability ranking metric', [frame.ranking.byMetricId], selectedMetricIds],
      );
    }
    for (const [kind, ids, allowed] of selectedChecks) {
      for (const id of ids) if (!allowed.has(id)) return `${kind} ${id}`;
    }
  }
  for (const ambiguity of frame.ambiguity) {
    for (const id of ambiguity.candidateIds) if (!evidenceIds.has(id)) return `ambiguity candidate ${id}`;
  }
  return undefined;
}

export function routeForEvidenceCandidate(candidate: AgentEvidenceCandidate): MeaningExecutionRoute {
  if (candidate.kind === "certified_block" && candidate.compatibility === "compatible") return "certified";
  if ((candidate.kind === "semantic_metric" || candidate.kind === "semantic_member") && candidate.compatibility === "compatible") {
    return "semantic";
  }
  return candidate.trustTier === "governed_sql" ? "governed_sql" : "exploratory";
}

export function questionTypeFromText(question: string): MeaningQuestionType {
  if (/\b(why|root ?cause|diagnos|driver|what (?:caused|changed|happened)|anomal)\b/i.test(question)) return "diagnosis";
  if (/\b(research|investigate|deep ?dive)\b/i.test(question)) return "research";
  if (/\b(top|bottom|highest|lowest|rank)\b/i.test(question)) return "ranking";
  if (/\b(trend|over time|month over month|year over year|mom|yoy|by (?:day|week|month|quarter|year))\b/i.test(question)) return "trend";
  if (/\b(compare|versus|vs\.?|difference between)\b/i.test(question)) return "comparison";
  // "What is total revenue?" asks for a data value, not a definition. This
  // distinction matters because definition paths may intentionally bypass
  // execution-shape checks for glossary/certified descriptions.
  if (/\b(total|sum|count|number of|average|avg|minimum|maximum|across all|overall)\b/i.test(question)
    && /\b(what (?:is|was|were|are)|how (?:much|many)|show|report|calculate|give|tell)\b/i.test(question)) return "value";
  if (/^\s*what (?:is|was|were|are)\b/i.test(question)
    && /\b(today|current|yesterday|last|this|from|for|by|top|bottom|during|between|through)\b/i.test(question)) return "value";
  if (/^\s*(what (?:is|are|does)|define|definition|meaning of)\b/i.test(question)) return "definition";
  return "value";
}

export function defaultQueryIntent(evidence: AgentRetrievalEvidence): MeaningQueryIntent {
  return {
    measures: evidence.parsedIntent?.measures ?? [],
    dimensions: evidence.parsedIntent?.dimensions ?? [],
    filters: evidence.parsedIntent?.filters ?? [],
    ...(evidence.parsedIntent?.timeRange ? { timeRange: evidence.parsedIntent.timeRange } : {}),
    ...(evidence.parsedIntent?.timeGrain ? { timeGrain: evidence.parsedIntent.timeGrain } : {}),
    ...(evidence.parsedIntent?.order ? { order: evidence.parsedIntent.order } : {}),
    ...(evidence.parsedIntent?.limit !== undefined ? { limit: evidence.parsedIntent.limit } : {}),
  };
}
