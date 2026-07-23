/**
 * Immutable, snapshot-bound analytical plan shared by every downstream route.
 * The router emits it authoritatively by default. Shadow mode remains the
 * bounded route-level rollback switch while integration verification closes.
 *
 * Acceptance: AGT-013, API-006.
 */

import { createHash } from "node:crypto";
import type { AnalyticalQuestionFrameV2 } from "@duckcodeailabs/dql-core";
import type { KnowledgeLens } from "./domain-context.js";
import type {
  AgentEvidenceCandidate,
  AgentRetrievalEvidence,
  MeaningExecutionRoute,
  MeaningQuestionType,
  MeaningResolution,
} from './meaning-resolution.js';

export type ResolvedPlanCapability =
  | 'certified_execution'
  | 'semantic_execution'
  | 'governed_relational'
  | 'bounded_exploration'
  | 'blocked';

export interface ResolvedPlanMemberBinding {
  requested: string;
  qualifiedId?: string;
  aggregation?: string;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  candidateIds: string[];
}

export interface ResolvedPlanCompatibilityProof {
  candidateId: string;
  compatibility: AgentEvidenceCandidate['compatibility'];
  facts: string[];
}

export interface ResolvedAnalyticalPlan {
  schemaVersion: 1 | 2;
  mode: "shadow" | "authoritative";
  planId: string;
  fingerprint: string;
  parentPlanId?: string;
  rootPlanId?: string;
  revision: number;
  snapshotId: string;
  sourceFingerprint?: string;
  question: string;
  interpretedQuestion: string;
  questionType: MeaningQuestionType;
  confidence: MeaningResolution['confidence'];
  selectedConceptIds: string[];
  executionId?: string;
  recommendedRoute: MeaningExecutionRoute;
  capability: ResolvedPlanCapability;
  query: {
    measures: ResolvedPlanMemberBinding[];
    dimensions: ResolvedPlanMemberBinding[];
    filters: Array<{
      field: string;
      value: string;
      binding: ResolvedPlanMemberBinding;
    }>;
    timeRange?: string;
    timeBounds?: {
      expression: string;
      startInclusive: string;
      endExclusive: string;
      timeZone: 'UTC';
    };
    timeGrain?: string;
    order?: 'asc' | 'desc';
    limit?: number;
  };
  entityGrain?: string;
  sourceRelationIds: string[];
  relationshipPathIds: string[];
  compatibilityProof: ResolvedPlanCompatibilityProof[];
  outputContract: {
    measures: string[];
    dimensions: string[];
    timeGrain?: string;
    fields?: string[];
    periodIds?: string[];
  };
  evidenceIds: string[];
  rejectedCandidates: Array<{ id: string; reason: string }>;
  missingInformation: string[];
  clarification?: string;
  knowledgeLens?: KnowledgeLens;
  /** Exact selected policy identities and source hashes used for defaults. */
  analyticalPolicies?: Array<{ policyId: string; sourceHash: string }>;
  /** Exact RFC 0005 meaning. Present iff schemaVersion is 2. */
  analyticalFrame?: AnalyticalQuestionFrameV2;
}

export interface BuildResolvedAnalyticalPlanInput {
  question: string;
  resolution: MeaningResolution;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  mode?: ResolvedAnalyticalPlan['mode'];
  /** Clock captured once by the router; used only to resolve relative time. */
  referenceTime?: Date;
}

export interface ResolvedAnalyticalPlanDelta {
  question: string;
  measures?: ResolvedPlanMemberBinding[];
  dimensions?: ResolvedPlanMemberBinding[];
  filters?: ResolvedAnalyticalPlan['query']['filters'];
  selectedResultFilter?: {
    binding: ResolvedPlanMemberBinding;
    value: string;
    sourceTurnId: string;
  };
  timeRange?: string;
  timeGrain?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  referenceTime?: Date;
  analyticalFrame?: AnalyticalQuestionFrameV2;
}

export function buildResolvedAnalyticalPlan(
  input: BuildResolvedAnalyticalPlanInput,
): ResolvedAnalyticalPlan {
  const byLegacyId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const selectedCandidates = input.resolution.selectedConceptIds
    .flatMap((id) => byLegacyId.get(id) ? [byLegacyId.get(id)!] : []);
  const executionCandidate = input.resolution.recommendedExecutionId
    ? byLegacyId.get(input.resolution.recommendedExecutionId)
    : selectedCandidates[0];
  const bindingCandidates = resolutionUsesRelationalEvidence(input.resolution)
    ? input.candidates
    : selectedCandidates.length > 0
      ? selectedCandidates
      : executionCandidate
        ? [executionCandidate]
        : input.candidates;
  const canonicalId = (candidate: AgentEvidenceCandidate): string => candidate.qualifiedId ?? candidate.id;
  const selectedConceptIds = selectedCandidates.map(canonicalId);
  const executionId = executionCandidate ? canonicalId(executionCandidate) : undefined;
  const measures = input.resolution.queryIntent.measures.length > 0
    ? input.resolution.queryIntent.measures.map((requested) => bindRequestedMember(requested, bindingCandidates, 'measure'))
    : selectedCandidates
      .filter((candidate) => candidate.kind === 'semantic_metric')
      .map((candidate) => ({
        requested: candidate.name,
        qualifiedId: canonicalId(candidate),
        status: 'resolved' as const,
        candidateIds: [canonicalId(candidate)],
      }));
  const dimensions = input.resolution.queryIntent.dimensions
    .map((requested) => bindRequestedMember(requested, bindingCandidates, 'dimension'));
  const filters = input.resolution.queryIntent.filters.map((filter) => ({
    ...filter,
    binding: bindRequestedMember(filter.field, bindingCandidates, 'dimension'),
  }));
  const compatibilityProof = selectedCandidates.map((candidate) => ({
    candidateId: canonicalId(candidate),
    compatibility: candidate.compatibility,
    facts: [...(candidate.compatibilityFacts ?? [])].sort(),
  }));
  const capability = resolveCapability(input.resolution, executionCandidate, measures, dimensions, filters);
  const timeBounds = input.resolution.queryIntent.timeRange
    ? resolvePlanTimeRange(input.resolution.queryIntent.timeRange, input.referenceTime ?? new Date())
    : undefined;
  const payload = {
    schemaVersion: input.resolution.analyticalFrame
      ? (2 as const)
      : (1 as const),
    mode: input.mode ?? ("shadow" as const),
    revision: 0,
    snapshotId: input.evidence.knowledgeLens?.snapshotId
      ?? input.evidence.snapshotId
      ?? input.evidence.sourceFingerprint
      ?? 'snapshot-unavailable',
    sourceFingerprint: input.evidence.sourceFingerprint,
    question: input.question,
    interpretedQuestion: input.resolution.interpretedQuestion,
    questionType: input.resolution.questionType,
    confidence: input.resolution.confidence,
    selectedConceptIds,
    executionId,
    recommendedRoute: input.resolution.recommendedRoute,
    capability,
    query: {
      measures,
      dimensions,
      filters,
      ...(input.resolution.queryIntent.timeRange ? { timeRange: input.resolution.queryIntent.timeRange } : {}),
      ...(timeBounds ? { timeBounds } : {}),
      ...(input.resolution.queryIntent.timeGrain ? { timeGrain: input.resolution.queryIntent.timeGrain } : {}),
      ...(input.resolution.queryIntent.order ? { order: input.resolution.queryIntent.order } : {}),
      ...(input.resolution.queryIntent.limit !== undefined ? { limit: input.resolution.queryIntent.limit } : {}),
    },
    entityGrain:
      input.resolution.analyticalFrame?.entityGrainIds[0] ??
      executionCandidate?.primaryEntity,
    sourceRelationIds: uniqueSorted(
      selectedCandidates.flatMap((candidate) => candidate.sourceObjects ?? []),
    ),
    relationshipPathIds: uniqueSorted(
      selectedCandidates.flatMap(
        (candidate) => candidate.relationshipEvidence ?? [],
      ),
    ),
    compatibilityProof,
    outputContract: {
      measures: uniqueSorted(
        measures.flatMap((binding) =>
          binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      dimensions: uniqueSorted(
        dimensions.flatMap((binding) =>
          binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      ...(input.resolution.queryIntent.timeGrain
        ? { timeGrain: input.resolution.queryIntent.timeGrain }
        : {}),
      ...(input.resolution.analyticalFrame
        ? {
            fields: input.resolution.analyticalFrame.requestedOutputs.map(
              (output) => output.id,
            ),
            periodIds:
              input.resolution.analyticalFrame.timeContext?.periods.map(
                (period) => period.id,
              ) ?? [],
          }
        : {}),
    },
    evidenceIds: uniqueSorted(input.candidates.map(canonicalId)),
    rejectedCandidates: input.resolution.rejectedCandidates.map((candidate) => {
      const retrieved = byLegacyId.get(candidate.id);
      return { id: retrieved ? canonicalId(retrieved) : candidate.id, reason: candidate.reason };
    }),
    missingInformation: [...input.resolution.missingInformation],
    clarification: input.resolution.clarifyingQuestion,
    knowledgeLens: input.evidence.knowledgeLens,
    ...((input.resolution.analyticalPolicyIds?.length ?? 0) > 0
      ? {
          analyticalPolicies: input.resolution
            .analyticalPolicyIds!.flatMap((policyId) => {
              const policy = input.evidence.analyticalPolicies?.find(
                (candidate) => candidate.policyId === policyId,
              );
              return policy
                ? [{ policyId, sourceHash: policy.sourceHash }]
                : [];
            })
            .sort((left, right) => left.policyId.localeCompare(right.policyId)),
        }
      : {}),
    ...(input.resolution.analyticalFrame
      ? { analyticalFrame: structuredClone(input.resolution.analyticalFrame) }
      : {}),
  };
  const fingerprint = sha256(stableStringify(payload));
  return deepFreeze({
    ...payload,
    planId: `rap:${fingerprint.slice(0, 24)}`,
    fingerprint,
  });
}

/**
 * Apply an explicitly typed follow-up delta. No prose, prior SQL, or answer text
 * is inspected; every carried member remains a qualified binding from the root.
 * Acceptance: CTX-003, AGT-013, AGT-016.
 */
export function deriveResolvedAnalyticalPlan(
  parent: ResolvedAnalyticalPlan,
  delta: ResolvedAnalyticalPlanDelta,
): ResolvedAnalyticalPlan {
  const dimensions = delta.dimensions ? delta.dimensions.map(cloneBinding) : parent.query.dimensions.map(cloneBinding);
  const measures = delta.measures ? delta.measures.map(cloneBinding) : parent.query.measures.map(cloneBinding);
  const filters = delta.filters
    ? delta.filters.map(cloneFilter)
    : parent.query.filters.map(cloneFilter);
  if (delta.selectedResultFilter) {
    filters.push({
      field: delta.selectedResultFilter.binding.requested,
      value: delta.selectedResultFilter.value,
      binding: cloneBinding(delta.selectedResultFilter.binding),
    });
  }
  const timeRange = delta.timeRange !== undefined ? delta.timeRange : parent.query.timeRange;
  // An inherited relative range is already bound to the root plan's captured
  // clock. Re-resolving "last month" during a later turn would silently change
  // the analytical contract, so only an explicit time delta gets a new clock.
  const timeBounds = delta.timeRange !== undefined
    ? (timeRange ? resolvePlanTimeRange(timeRange, delta.referenceTime ?? new Date()) : undefined)
    : parent.query.timeBounds;
  const unresolved = [...measures, ...dimensions, ...filters.map((filter) => filter.binding)]
    .filter((binding) => binding.status !== 'resolved');
  const payload = {
    ...parent,
    parentPlanId: parent.planId,
    rootPlanId: parent.rootPlanId ?? parent.planId,
    revision: parent.revision + 1,
    question: delta.question,
    interpretedQuestion: delta.question,
    capability: unresolved.length > 0 ? 'blocked' as const : parent.capability,
    query: {
      measures,
      dimensions,
      filters,
      ...(timeRange ? { timeRange } : {}),
      ...(timeBounds ? { timeBounds } : {}),
      ...((delta.timeGrain ?? parent.query.timeGrain) ? { timeGrain: delta.timeGrain ?? parent.query.timeGrain } : {}),
      ...((delta.order ?? parent.query.order) ? { order: delta.order ?? parent.query.order } : {}),
      ...(delta.limit !== undefined || parent.query.limit !== undefined ? { limit: delta.limit ?? parent.query.limit } : {}),
    },
    outputContract: {
      measures: uniqueSorted(
        measures.flatMap((binding) =>
          binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      dimensions: uniqueSorted(
        dimensions.flatMap((binding) =>
          binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      ...((delta.timeGrain ?? parent.query.timeGrain)
        ? { timeGrain: delta.timeGrain ?? parent.query.timeGrain }
        : {}),
      ...((delta.analyticalFrame ?? parent.analyticalFrame)
        ? {
            fields: (delta.analyticalFrame ??
              parent.analyticalFrame)!.requestedOutputs.map(
              (output) => output.id,
            ),
            periodIds:
              (delta.analyticalFrame ??
                parent.analyticalFrame)!.timeContext?.periods.map(
                (period) => period.id,
              ) ?? [],
          }
        : {}),
    },
    missingInformation:
      unresolved.length > 0
        ? uniqueSorted([
            ...parent.missingInformation,
            ...unresolved.map(
              (binding) => `${binding.requested} is ${binding.status}.`,
            ),
          ])
        : [...parent.missingInformation],
    ...(delta.analyticalFrame
      ? {
          schemaVersion: 2 as const,
          analyticalFrame: structuredClone(delta.analyticalFrame),
        }
      : {}),
  };
  const { planId: _oldPlanId, fingerprint: _oldFingerprint, ...fingerprintPayload } = payload;
  const fingerprint = sha256(stableStringify(fingerprintPayload));
  return deepFreeze({
    ...fingerprintPayload,
    planId: `rap:${fingerprint.slice(0, 24)}`,
    fingerprint,
  });
}

function cloneBinding(binding: ResolvedPlanMemberBinding): ResolvedPlanMemberBinding {
  return { ...binding, candidateIds: [...binding.candidateIds] };
}

function cloneFilter(filter: ResolvedAnalyticalPlan['query']['filters'][number]): ResolvedAnalyticalPlan['query']['filters'][number] {
  return { ...filter, binding: cloneBinding(filter.binding) };
}

function bindRequestedMember(
  requested: string,
  candidates: AgentEvidenceCandidate[],
  kind: 'measure' | 'dimension',
): ResolvedPlanMemberBinding {
  const normalized = normalize(requested);
  const directCandidates = candidates.filter((candidate) => {
    const kindMatches = kind === 'measure'
      ? candidate.kind === 'semantic_metric' || candidate.kind === 'sql_column'
      : candidate.kind === 'semantic_member' || candidate.kind === 'sql_column';
    return kindMatches
      && candidateTerms(candidate).some((term) => memberTermMatches(term, normalized));
  });
  const ids = uniqueSorted([
    ...directCandidates.map((candidate) => candidate.qualifiedId ?? candidate.id),
    ...(kind === 'dimension' ? candidates.flatMap((candidate) =>
      (candidate.dimensions ?? []).filter((dimension) => {
        const value = normalize(dimension);
        return value === normalized || value.endsWith(` ${normalized}`);
      }).map((dimension) => qualifyDeclaredDimension(candidate, dimension))) : []),
  ]);
  if (ids.length === 0 && kind === 'measure' && candidates.length === 1) {
    const certified = candidates[0]!;
    if (certified.kind === 'certified_block' && certified.compatibility === 'compatible') {
      const id = certified.qualifiedId ?? certified.id;
      return {
        requested,
        qualifiedId: id,
        status: 'resolved',
        candidateIds: [id],
      };
    }
  }
  const direct = ids.length === 1
    ? directCandidates.find((candidate) => (candidate.qualifiedId ?? candidate.id) === ids[0])
    : undefined;
  return {
    requested,
    ...(ids.length === 1 ? { qualifiedId: ids[0] } : {}),
    ...(direct?.aggregation ? { aggregation: direct.aggregation } : {}),
    status: ids.length === 1 ? 'resolved' : ids.length > 1 ? 'ambiguous' : 'unresolved',
    candidateIds: ids,
  };
}

function qualifyDeclaredDimension(candidate: AgentEvidenceCandidate, dimension: string): string {
  if (/[:./]/.test(dimension) || !candidate.domain) return dimension;
  const domain = candidate.domain.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const local = dimension.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return `semantic:${domain}:dimension:${local}`;
}

function resolutionUsesRelationalEvidence(resolution: MeaningResolution): boolean {
  return resolution.recommendedRoute === 'governed_sql' || resolution.recommendedRoute === 'exploratory';
}

function memberTermMatches(candidateTerm: string, requested: string): boolean {
  if (candidateTerm === requested || candidateTerm.endsWith(` ${requested}`)) return true;
  if (!requested) return false;
  return ` ${candidateTerm} `.includes(` ${requested} `);
}

function candidateTerms(candidate: AgentEvidenceCandidate): string[] {
  return [candidate.name, ...(candidate.aliases ?? []), candidate.qualifiedId ?? '', candidate.id]
    .map(normalize)
    .filter(Boolean);
}

function resolveCapability(
  resolution: MeaningResolution,
  execution: AgentEvidenceCandidate | undefined,
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
): ResolvedPlanCapability {
  if (
    resolution.confidence === "low" ||
    resolution.recommendedRoute === "clarify" ||
    !execution ||
    Boolean(resolution.analyticalFrame?.ambiguity.length)
  )
    return "blocked";
  if (
    ((measures.some((binding) => binding.status !== "resolved") &&
      resolution.queryIntent.measures.length > 0) ||
      (dimensions.some((binding) => binding.status !== "resolved") &&
        resolution.queryIntent.dimensions.length > 0)) &&
    (resolution.recommendedRoute === "certified" ||
      resolution.recommendedRoute === "semantic")
  )
    return "blocked";
  if (
    filters.some((filter) => filter.binding.status !== "resolved") &&
    (resolution.recommendedRoute === "certified" ||
      resolution.recommendedRoute === "semantic")
  )
    return "blocked";
  if (execution.compatibility === "incompatible") return "blocked";
  if (
    resolution.recommendedRoute === "certified" &&
    execution.kind === "certified_block" &&
    execution.compatibility === "compatible"
  ) {
    return "certified_execution";
  }
  if (resolution.recommendedRoute === 'semantic'
    && (execution.kind === 'semantic_metric' || execution.kind === 'semantic_member')
    && execution.compatibility === 'compatible') return 'semantic_execution';
  if (resolution.recommendedRoute === 'governed_sql') return 'governed_relational';
  if (resolution.recommendedRoute === 'exploratory') return 'bounded_exploration';
  return 'blocked';
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_./:-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Resolve common analytical ranges once so no executor reinterprets "last month". */
export function resolvePlanTimeRange(
  expression: string,
  referenceTime: Date,
): ResolvedAnalyticalPlan['query']['timeBounds'] | undefined {
  const text = expression.trim().toLowerCase();
  const reference = new Date(Date.UTC(
    referenceTime.getUTCFullYear(),
    referenceTime.getUTCMonth(),
    referenceTime.getUTCDate(),
  ));
  const explicit = /^(\d{4}-\d{2}-\d{2})\s+(?:to|through)\s+(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (explicit) {
    const start = new Date(`${explicit[1]}T00:00:00.000Z`);
    const inclusiveEnd = new Date(`${explicit[2]}T00:00:00.000Z`);
    if (!Number.isNaN(start.valueOf()) && !Number.isNaN(inclusiveEnd.valueOf()) && start <= inclusiveEnd) {
      inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() + 1);
      return temporalBounds(expression, start, inclusiveEnd);
    }
  }
  const match = /^(?:the\s+)?(last|this)\s+(?:(\d+)\s+)?(day|week|month|quarter|year)s?$/.exec(text);
  if (!match) return undefined;
  const mode = match[1]!;
  const count = Math.max(1, Number(match[2] ?? 1));
  const unit = match[3]!;
  if (mode === 'this') {
    const start = startOfUnit(reference, unit);
    return temporalBounds(expression, start, addUnits(start, unit, count));
  }
  if (match[2]) return temporalBounds(expression, addUnits(reference, unit, -count), reference);
  const end = startOfUnit(reference, unit);
  return temporalBounds(expression, addUnits(end, unit, -1), end);
}

function temporalBounds(expression: string, start: Date, end: Date): NonNullable<ResolvedAnalyticalPlan['query']['timeBounds']> {
  return {
    expression,
    startInclusive: start.toISOString(),
    endExclusive: end.toISOString(),
    timeZone: 'UTC',
  };
}

function startOfUnit(value: Date, unit: string): Date {
  const out = new Date(value);
  if (unit === 'year') out.setUTCMonth(0, 1);
  else if (unit === 'quarter') out.setUTCMonth(Math.floor(out.getUTCMonth() / 3) * 3, 1);
  else if (unit === 'month') out.setUTCDate(1);
  else if (unit === 'week') out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
  return out;
}

function addUnits(value: Date, unit: string, count: number): Date {
  const out = new Date(value);
  if (unit === 'year') out.setUTCFullYear(out.getUTCFullYear() + count);
  else if (unit === 'quarter') out.setUTCMonth(out.getUTCMonth() + count * 3);
  else if (unit === 'month') out.setUTCMonth(out.getUTCMonth() + count);
  else if (unit === 'week') out.setUTCDate(out.getUTCDate() + count * 7);
  else out.setUTCDate(out.getUTCDate() + count);
  return out;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}
