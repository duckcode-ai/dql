/**
 * Immutable, snapshot-bound analytical plan shared by every downstream route.
 * The router emits it authoritatively by default. The `shadow` discriminator
 * remains only for explicit dev/test comparison fixtures; production has no
 * environment flag or request field that can select it.
 *
 * Acceptance: AGT-013, API-006.
 */

import { createHash } from "node:crypto";
import {
  normalizeMetricCapabilityContract,
  type AnalyticalDimensionRole,
  type AnalyticalQuestionFrameV2,
  type MetricCapabilityContract,
  type ResolvedRelationshipProofV1,
} from "@duckcodeailabs/dql-core";
import type { KnowledgeLens } from "./domain-context.js";
import type {
  AgentEvidenceCandidate,
  AgentRetrievalEvidence,
  MeaningExecutionRoute,
  MeaningQuestionType,
  MeaningResolution,
} from './meaning-resolution.js';
import { buildResolvedRelationshipProofsV1 } from './relationship-proof.js';

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
  /** Exact normalized execution authority selected before the plan was frozen. */
  selectedCapability?: MetricCapabilityContract;
  /** Stable authority identity retained separately for receipt comparison. */
  selectedCapabilityFingerprint?: string;
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
  /** Exact selected relationship authority; native semantic paths are never DQL relationship IDs. */
  relationshipProofs?: ResolvedRelationshipProofV1[];
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
  /** Typed deterministic failure retained without changing the selected plan. */
  resolutionFailure?: {
    outcome: 'clarify' | 'modeling_gap' | 'policy_blocked';
    codes: string[];
    candidateIds: string[];
    selectedCapabilityId?: string;
    selectedExecutionId?: string;
    finalCapability: ResolvedPlanCapability;
    bindings: Array<{
      kind: 'measure' | 'dimension' | 'filter';
      requested: string;
      status: ResolvedPlanMemberBinding['status'];
      candidateIds: string[];
    }>;
  };
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
  const bindingCandidates = input.resolution.recommendedRoute === 'certified' && executionCandidate
    // A deterministically compatible certified block has already proved the
    // complete tuple. Bind its declared inputs/outputs as one execution
    // authority instead of mixing in the semantic concept used to select it.
    ? [executionCandidate]
    : resolutionUsesRelationalEvidence(input.resolution)
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
    ? input.resolution.queryIntent.measures.map((requested) => bindRequestedMember(requested, bindingCandidates, 'measure', input.question))
    : selectedCandidates
      .filter((candidate) => candidate.kind === 'semantic_metric')
      .map((candidate) => ({
        requested: candidate.name,
        qualifiedId: canonicalId(candidate),
        status: 'resolved' as const,
        candidateIds: [canonicalId(candidate)],
      }));
  // A v2 frame has already proved the exact governed dimensional tuple. Keep
  // semantic-member evidence available for the human phrasing ("customer")
  // even when selectedConceptIds intentionally contains only requested
  // metrics.
  const dimensionBindingCandidates = input.resolution.analyticalFrame
    ? input.candidates
    : bindingCandidates;
  const selectedCapability = normalizeMetricCapabilityContract(executionCandidate?.analyticalCapability);
  const bindDimension = (
    requested: string,
    roles: AnalyticalDimensionRole[],
  ): ResolvedPlanMemberBinding => {
    const capabilityBinding = bindSelectedCapabilityDimension(
      requested,
      selectedCapability,
      roles,
      input.candidates,
    );
    // A provider frame may describe a selected capability, but it cannot pick
    // one of that capability's grouping dimensions for the host. Once a
    // normalized capability supplies a relevant binding, its identifiers,
    // roles, entity/grain and relationship proof are authoritative.
    // A selected capability owns its grouping dimensions, but when it reports
    // AMBIGUITY the question text can still settle it — and until it did, an
    // answerable lookup stopped to ask.
    if (capabilityBinding && capabilityBinding.status === 'ambiguous') {
      const settled = memberNamedInQuestion(capabilityBinding.candidateIds, input.candidates, input.question);
      if (settled) return { ...capabilityBinding, qualifiedId: settled, status: 'resolved', candidateIds: [settled] };
    }
    if (capabilityBinding && capabilityBinding.status !== 'unresolved') return capabilityBinding;
    const normalizedRequested = normalize(requested);
    const frameIds = uniqueSorted((input.resolution.analyticalFrame?.dimensions ?? [])
      .filter((binding) =>
        capabilityEntailsFrameDimension(selectedCapability, binding)
        && (!selectedCapability || binding.role === 'time_axis')
        && memberTermMatches(normalize(binding.dimensionId), normalizedRequested))
      .map((binding) => binding.dimensionId));
    if (frameIds.length === 1) {
      return {
        requested,
        qualifiedId: frameIds[0],
        status: 'resolved',
        candidateIds: frameIds,
      };
    }
    if (capabilityBinding) return capabilityBinding;
    return bindRequestedMember(requested, dimensionBindingCandidates, 'dimension', input.question);
  };
  const rankingRequested = input.resolution.questionType === 'ranking'
    || input.resolution.queryIntent.order !== undefined
    || input.resolution.queryIntent.limit !== undefined;
  const dimensions = input.resolution.queryIntent.dimensions
    .map((requested) => bindDimension(
      requested,
      rankingRequested ? ['group_by', 'rank_entity'] : ['group_by'],
    ));
  // A provider may name the field it is grouping by and forget the MEMBER the
  // reader asked about: "What customer type is Wesley Jenkins?" came back with
  // `filters: []`, so the run returned all 200 customers and the narration
  // truthfully reported that his value was not present.
  //
  // DQL had already found him. `evidence.parsedIntent.filters` are GROUNDED
  // member bindings — matched against the retrieved context, not guessed — so
  // falling back to them adds no unproven predicate. The provider's own filters
  // still win whenever it supplies any.
  const requestedFilters = input.resolution.queryIntent.filters.length > 0
    ? input.resolution.queryIntent.filters
    : (input.evidence.parsedIntent?.filters ?? []).filter((filter) => filter.field && filter.value);
  const filters = requestedFilters.map((filter) => ({
    ...filter,
    binding: bindDimension(filter.field, ['filter']),
  }));
  const capabilityDimensionProof = resolvedCapabilityDimensionProof(
    selectedCapability,
    dimensions,
    filters,
  );
  const proofCandidates = [
    ...selectedCandidates,
    ...(executionCandidate && !selectedCandidates.some((candidate) => candidate.id === executionCandidate.id)
      ? [executionCandidate]
      : []),
  ];
  const compatibilityProof = proofCandidates.map((candidate) => ({
    candidateId: canonicalId(candidate),
    compatibility: candidate.compatibility,
    facts: uniqueSorted([
      ...(candidate.compatibilityFacts ?? []),
      ...(candidate.id === executionCandidate?.id && selectedCapability
        ? selectedCapabilityProofFacts(selectedCapability, capabilityDimensionProof)
        : []),
    ]),
  }));
  const capability = resolveCapability(input.resolution, executionCandidate, measures, dimensions, filters);
  const bindingGaps = bindingMissingInformation(measures, dimensions, filters);
  const missingInformation = uniqueSorted([
    ...input.resolution.missingInformation,
    ...bindingGaps,
    ...(capability === 'blocked' && input.resolution.missingInformation.length === 0 && bindingGaps.length === 0
      ? [`The selected ${input.resolution.recommendedRoute} capability is not executable for this analytical tuple.`]
      : []),
  ]);
  const timeBounds = input.resolution.queryIntent.timeRange
    ? resolvePlanTimeRange(input.resolution.queryIntent.timeRange, input.referenceTime ?? new Date())
    : undefined;
  const snapshotId = input.evidence.knowledgeLens?.snapshotId
    ?? input.evidence.snapshotId
    ?? input.evidence.sourceFingerprint
    ?? 'snapshot-unavailable';
  const selectedExecutionCapability = selectedCapability?.executionCapabilities.find((candidate) =>
    candidate.route === input.resolution.recommendedRoute);
  const relationshipProofs = selectedCapability && selectedExecutionCapability && executionId
    ? buildResolvedRelationshipProofsV1({
        capability: selectedCapability,
        dimensionIds: capabilityDimensionProof.map((dimension) => dimension.dimensionId),
        route: selectedExecutionCapability.route,
        ...(selectedExecutionCapability.adapterId ? { adapterId: selectedExecutionCapability.adapterId } : {}),
        executionId,
        snapshotId,
      })
    : [];
  const payload = {
    schemaVersion: input.resolution.analyticalFrame
      ? (2 as const)
      : (1 as const),
    mode: input.mode ?? ("authoritative" as const),
    revision: 0,
    snapshotId,
    sourceFingerprint: input.evidence.sourceFingerprint,
    question: input.question,
    interpretedQuestion: input.resolution.interpretedQuestion,
    questionType: input.resolution.questionType,
    confidence: input.resolution.confidence,
    selectedConceptIds,
    executionId,
    ...(selectedCapability
      ? {
          selectedCapability,
          selectedCapabilityFingerprint: selectedCapability.sourceFingerprint,
        }
      : {}),
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
    entityGrain: selectedCapability
      ? resolvedCapabilityEntityGrain(selectedCapability, dimensions)
      : input.resolution.analyticalFrame?.entityGrainIds[0] ?? executionCandidate?.primaryEntity,
    sourceRelationIds: uniqueSorted(
      selectedCandidates.flatMap((candidate) => candidate.sourceObjects ?? []),
    ),
    relationshipPathIds: selectedCapability
      ? uniqueSorted(relationshipProofs.flatMap((proof) =>
        proof.kind === 'dql_relationship_path' ? proof.relationshipPathIds : []))
      : uniqueSorted(selectedCandidates.flatMap(
        (candidate) => candidate.relationshipEvidence ?? [],
      )),
    relationshipProofs,
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
    missingInformation,
    clarification: input.resolution.clarifyingQuestion,
    ...(capability === 'blocked'
      ? {
          resolutionFailure: {
            outcome: input.resolution.compatibilityOutcome
              ?? (input.resolution.recommendedRoute === 'clarify' || input.resolution.confidence === 'low'
                ? 'clarify'
                : bindingCandidateIds(measures, dimensions, filters).length > 0
                  ? 'clarify'
                  : 'modeling_gap'),
            codes: uniqueSorted([
              ...(input.resolution.compatibilityFailures ?? []).map((failure) => failure.code),
              ...bindingFailureCodes(measures, dimensions, filters),
            ]),
            candidateIds: uniqueSorted([
              ...(input.resolution.compatibilityFailures ?? []).flatMap((failure) => failure.candidateIds),
              ...bindingCandidateIds(measures, dimensions, filters),
            ]),
            ...(selectedCapability?.metricId
              ? { selectedCapabilityId: selectedCapability.metricId }
              : {}),
            ...(executionId ? { selectedExecutionId: executionId } : {}),
            finalCapability: capability,
            bindings: unresolvedBindingReceipts(measures, dimensions, filters),
          },
        }
      : {}),
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
 * The selected metric capability is the sole authority for metric-relative
 * dimensions. Standalone member cards can help the model explain meaning, but
 * cannot introduce a second execution binding or substitute a same-name ID.
 */
function bindSelectedCapabilityDimension(
  requested: string,
  capability: MetricCapabilityContract | undefined,
  requiredRoles: AnalyticalDimensionRole[],
  candidates: AgentEvidenceCandidate[],
): ResolvedPlanMemberBinding | undefined {
  if (!capability) return undefined;
  const eligible = eligibleCapabilityDimensions(capability, requiredRoles);
  const exactIds = uniqueSorted(eligible
    .filter((dimension) => dimension.dimensionId === requested)
    .map((dimension) => dimension.dimensionId));
  if (exactIds.length === 1) {
    return {
      requested,
      qualifiedId: exactIds[0],
      status: 'resolved',
      candidateIds: exactIds,
    };
  }
  const requestedEntityEvidence = candidates.filter((candidate) =>
    candidate.semanticObjectType === 'entity'
    && candidateTerms(candidate).some((term) =>
      termMatchSpecificity(term, canonicalTokens(requested)) > 0));
  const entityScoped = requestedEntityEvidence.length > 0
    ? eligible.filter((dimension) => capabilityDimensionMatchesEntityEvidence(
      dimension,
      requestedEntityEvidence,
    ))
    : [];
  const bindingPool = entityScoped.length > 0 ? entityScoped : eligible;
  const scored = bindingPool
    .map((dimension) => ({
      dimension,
      score: capabilityDimensionMatchScore(requested, dimension, capability, candidates),
    }))
    .filter((match) => match.score > 0);
  if (scored.length === 0) {
    return {
      requested,
      status: 'unresolved',
      // Role-compatible but semantically unrelated members are not choices a
      // user can use to repair this binding. Keep the list empty so the router
      // reports a modeling/binding gap instead of offering arbitrary booleans.
      candidateIds: [],
    };
  }
  const bestScore = Math.max(...scored.map((match) => match.score));
  const matches = scored
    .filter((match) => match.score === bestScore)
    .map((match) => match.dimension);
  const ids = uniqueSorted(matches.map((dimension) => dimension.dimensionId));
  return {
    requested,
    ...(ids.length === 1 ? { qualifiedId: ids[0] } : {}),
    status: ids.length === 1 ? 'resolved' : 'ambiguous',
    candidateIds: ids,
  };
}

function capabilityDimensionMatchScore(
  requested: string,
  dimension: MetricCapabilityContract['dimensions'][number],
  capability: MetricCapabilityContract,
  candidates: AgentEvidenceCandidate[],
): number {
  const requestedTokens = canonicalTokens(requested);
  if (requestedTokens.length === 0) return 0;
  const evidenceTerms = candidates
    .filter((candidate) => candidate.kind === 'semantic_member'
      && candidate.semanticObjectType !== 'entity'
      && (candidate.qualifiedId ?? candidate.id) === dimension.dimensionId)
    .flatMap((candidate) => [candidate.name, ...(candidate.aliases ?? [])]);
  const evidenceScore = Math.max(0, ...evidenceTerms.map((term) =>
    termMatchSpecificity(term, requestedTokens)));
  const authoredDisplayScore = Math.max(
    0,
    ...[dimension.label, ...(dimension.aliases ?? [])]
      .filter((term): term is string => Boolean(term))
      .map((term) => termMatchSpecificity(term, requestedTokens)),
  );
  const localScore = termMatchSpecificity(localQualifiedLeaf(dimension.dimensionId), requestedTokens);
  const conventionalIdentityScore = conventionalIdentitySpecificity(
    localQualifiedLeaf(dimension.dimensionId),
    requestedTokens,
  );
  const entityScore = termMatchSpecificity(localQualifiedLeaf(dimension.entityId), requestedTokens);
  const identityScore = Math.max(
    evidenceScore > 0 ? 1_000 + evidenceScore : 0,
    authoredDisplayScore > 0 ? 900 + authoredDisplayScore : 0,
    conventionalIdentityScore > 0 ? 1_100 + conventionalIdentityScore : 0,
    localScore > 0 ? 600 + localScore : 0,
    entityScore > 0 ? 300 + entityScore : 0,
  );
  if (identityScore === 0) return 0;
  const authorityScore =
    (dimension.supportedRoles.includes('display') ? 8 : 0)
    + (dimension.entityId === capability.primaryEntityId ? 4 : 0)
    + (capability.resultGrainIds.includes(dimension.entityId) ? 4 : 0)
    + ((dimension.relationshipPathIds?.length ?? 0) > 0 ? 4 : 0);
  return identityScore + authorityScore;
}

function conventionalIdentitySpecificity(term: string, requestedTokens: string[]): number {
  const termTokens = canonicalTokens(term);
  if (!requestedTokens.every((token) => termTokens.includes(token))) return 0;
  const remaining = termTokens.filter((token) => !requestedTokens.includes(token));
  const identityDescriptors = new Set(['display', 'identifier', 'id', 'key', 'label', 'name', 'title']);
  return remaining.length === 1 && identityDescriptors.has(remaining[0]!) ? 100 : 0;
}

function capabilityDimensionMatchesEntityEvidence(
  dimension: MetricCapabilityContract['dimensions'][number],
  entityCandidates: AgentEvidenceCandidate[],
): boolean {
  const ownerTokens = canonicalTokens(localQualifiedOwner(dimension.dimensionId));
  return entityCandidates.some((candidate) => {
    const candidateId = candidate.qualifiedId ?? candidate.id;
    if (dimension.entityId === candidateId) return true;
    if (ownerTokens.length === 0) return false;
    const entityTerms = [candidate.name, ...(candidate.aliases ?? []), localQualifiedLeaf(candidateId)];
    return entityTerms.some((term) => {
      const tokens = canonicalTokens(localQualifiedLeaf(term));
      return tokens.length > 0 && tokens.every((token) => ownerTokens.includes(token));
    });
  });
}

function termMatchSpecificity(term: string, requestedTokens: string[]): number {
  const termTokens = canonicalTokens(term);
  if (termTokens.length === 0 || !requestedTokens.every((token) => termTokens.includes(token))) return 0;
  if (termTokens.length === requestedTokens.length
    && termTokens.every((token, index) => token === requestedTokens[index])) return 100;
  return 50 + requestedTokens.length;
}

function canonicalTokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .map(singularizeBindingToken);
}

function singularizeBindingToken(value: string): string {
  if (value.length <= 4 || value.endsWith('ss') || value.endsWith('us') || value.endsWith('is')) return value;
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  return value.endsWith('s') ? value.slice(0, -1) : value;
}

function localQualifiedLeaf(value: string): string {
  const leaf = value.split(/[:./]+/).filter(Boolean).at(-1);
  return leaf ?? value;
}

function localQualifiedOwner(value: string): string {
  const local = value.split(':').at(-1) ?? value;
  const segments = local.split(/[./]+/).filter(Boolean);
  return segments.length > 1 ? segments[0]! : '';
}

function eligibleCapabilityDimensions(
  capability: MetricCapabilityContract | undefined,
  requiredRoles: AnalyticalDimensionRole[],
): MetricCapabilityContract['dimensions'] {
  if (!capability) return [];
  return capability.dimensions.filter((dimension) => {
    if (!requiredRoles.every((role) => dimension.supportedRoles.includes(role))) return false;
    const sameEntity = dimension.entityId === capability.primaryEntityId;
    const declaredGrain = capability.resultGrainIds.includes(dimension.entityId);
    const relationshipProven = (dimension.relationshipPathIds?.length ?? 0) > 0;
    const nativeGroupingProven = Boolean(dimension.nativeGroupingReference)
      && capability.executionCapabilities.some((execution) => execution.route === 'semantic');
    return sameEntity || declaredGrain || relationshipProven || nativeGroupingProven;
  });
}

function capabilityEntailsFrameDimension(
  capability: MetricCapabilityContract | undefined,
  binding: { dimensionId: string; role: AnalyticalDimensionRole },
): boolean {
  if (!capability) return false;
  if (binding.role === 'time_axis') {
    return capability.timeDimensions.some((dimension) =>
      dimension.dimensionId === binding.dimensionId);
  }
  return eligibleCapabilityDimensions(capability, [binding.role])
    .some((dimension) => dimension.dimensionId === binding.dimensionId);
}

function resolvedCapabilityDimensionProof(
  capability: MetricCapabilityContract | undefined,
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
): MetricCapabilityContract['dimensions'] {
  if (!capability) return [];
  const boundIds = new Set([
    ...dimensions.flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []),
    ...filters.flatMap((filter) =>
      filter.binding.qualifiedId ? [filter.binding.qualifiedId] : []),
  ]);
  return capability.dimensions
    .filter((dimension) => boundIds.has(dimension.dimensionId))
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
}

function resolvedCapabilityEntityGrain(
  capability: MetricCapabilityContract,
  dimensions: ResolvedPlanMemberBinding[],
): string {
  const groupedIds = new Set(dimensions.flatMap((binding) =>
    binding.qualifiedId ? [binding.qualifiedId] : []));
  const groupedEntityIds = uniqueSorted(capability.dimensions
    .filter((dimension) => groupedIds.has(dimension.dimensionId))
    .map((dimension) => dimension.entityId));
  if (groupedEntityIds.length === 1 && capability.resultGrainIds.includes(groupedEntityIds[0]!)) {
    return groupedEntityIds[0]!;
  }
  return capability.defaultResultGrainId;
}

function selectedCapabilityProofFacts(
  capability: MetricCapabilityContract,
  dimensions: MetricCapabilityContract['dimensions'],
): string[] {
  return [
    `capability:metric:${capability.metricId}`,
    `capability:primary_entity:${capability.primaryEntityId}`,
    `capability:default_result_grain:${capability.defaultResultGrainId}`,
    ...capability.resultGrainIds.map((grain) => `capability:result_grain:${grain}`),
    ...dimensions.map((dimension) => `capability:dimension:${dimension.dimensionId}:${dimension.entityId}`),
    ...dimensions.flatMap((dimension) => dimension.nativeGroupingReference
      ? [`capability:native_grouping:${dimension.dimensionId}:${dimension.nativeGroupingReference}`]
      : []),
    ...dimensions.flatMap((dimension) =>
      (dimension.relationshipPathIds ?? []).map((relationshipId) =>
        `capability:relationship:${relationshipId}`)),
    ...capability.executionCapabilities.map((execution) =>
      `capability:route:${execution.route}:${execution.adapterId ?? 'native'}`),
  ];
}

function unresolvedBindingReceipts(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
): NonNullable<ResolvedAnalyticalPlan['resolutionFailure']>['bindings'] {
  return [
    ...measures.map((binding) => ({ kind: 'measure' as const, binding })),
    ...dimensions.map((binding) => ({ kind: 'dimension' as const, binding })),
    ...filters.map((filter) => ({ kind: 'filter' as const, binding: filter.binding })),
  ]
    .filter(({ binding }) => binding.status !== 'resolved')
    .map(({ kind, binding }) => ({
      kind,
      requested: binding.requested,
      status: binding.status,
      candidateIds: [...binding.candidateIds],
    }));
}

function bindingCandidateIds(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
): string[] {
  return unresolvedBindingReceipts(measures, dimensions, filters)
    .flatMap((binding) => binding.candidateIds);
}

function bindingFailureCodes(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
): string[] {
  return unresolvedBindingReceipts(measures, dimensions, filters)
    .map((binding) => `${binding.kind.toUpperCase()}_${binding.status.toUpperCase()}`);
}

function bindingMissingInformation(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
): string[] {
  return [
    ...measures.map((binding) => ({ kind: 'measure', binding })),
    ...dimensions.map((binding) => ({ kind: 'dimension', binding })),
    ...filters.map((filter) => ({ kind: 'filter', binding: filter.binding })),
  ].flatMap(({ kind, binding }) => {
    if (binding.status === 'resolved') return [];
    const choices = binding.candidateIds.length > 0
      ? ` Qualified choices: ${binding.candidateIds.join(', ')}.`
      : '';
    return [`Requested ${kind} “${binding.requested}” is ${binding.status}.${choices}`];
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

/**
 * Disambiguate a member binding using the QUESTION TEXT.
 *
 * A planner (or a provider) often reduces "customer type" to the bare term
 * `type`, and worse, may split it into two requested dimensions ("customer",
 * "type"). A bare `type` then matches `customers.customer_type` AND
 * `products.product_type` and reads as ambiguous, so an answerable question
 * stops to ask which dimension was meant. The question already answers it:
 * "customer type" appears in it and "product type" does not.
 *
 * Returns the single id the reader actually named, or undefined when the text
 * does not settle it. Only multi-word names count — one shared token is not
 * evidence.
 */
function memberNamedInQuestion(
  ids: string[],
  candidates: AgentEvidenceCandidate[],
  question: string,
): string | undefined {
  if (ids.length < 2) return undefined;
  const questionText = normalize(question);
  if (!questionText) return undefined;
  const named = ids.filter((id) => {
    const candidate = candidates.find((item) => (item.qualifiedId ?? item.id) === id || item.id === id);
    const terms = [candidate?.name ?? '', ...(candidate?.aliases ?? []), id.split(/[.:/]/).at(-1) ?? '']
      .map((term) => normalize(String(term)))
      .filter((term) => term.split(' ').length > 1);
    return terms.some((term) =>
      questionText === term
      || questionText.startsWith(`${term} `)
      || questionText.endsWith(` ${term}`)
      || questionText.includes(` ${term} `));
  });
  return named.length === 1 ? named[0] : undefined;
}

function bindRequestedMember(
  requested: string,
  candidates: AgentEvidenceCandidate[],
  kind: 'measure' | 'dimension',
  question = '',
): ResolvedPlanMemberBinding {
  const normalized = normalize(requested);
  // A lexical decoy that compatibility already rejected must never introduce
  // a second binding identity into the frozen plan. Only candidates still
  // eligible for the requested tuple can contribute member authority.
  const eligibleCandidates = candidates.filter((candidate) => candidate.compatibility !== 'incompatible');
  const directCandidates = eligibleCandidates.filter((candidate) => {
    const kindMatches = kind === 'measure'
      ? candidate.kind === 'semantic_metric' || candidate.kind === 'sql_column'
      : candidate.kind === 'semantic_member' || candidate.kind === 'sql_column';
    return kindMatches
      && candidateTerms(candidate).some((term) => memberTermMatches(term, normalized));
  });
  const collectedIds = uniqueSorted([
    ...directCandidates.map((candidate) => candidate.qualifiedId ?? candidate.id),
    ...(kind === 'dimension' ? eligibleCandidates.flatMap((candidate) =>
      (candidate.dimensions ?? []).filter((dimension) => {
        const value = normalize(dimension);
        return value === normalized || value.endsWith(` ${normalized}`);
      }).map((dimension) => qualifyDeclaredDimension(candidate, dimension))) : []),
  ]);
  // A candidate contributes its qualified identity AND its own declared
  // dimension list, so a dimension that IS the candidate arrived twice —
  // `semantic:dimension:customers.customer_type` alongside a bare
  // `customer_type`. Two ids read as ambiguous, the binding failed, and the
  // plan blocked, which is why a metric-free attribute lookup could never
  // freeze. A bare name that is the LEAF of a qualified id in the same set is
  // the same member named twice, not a second choice.
  const qualifiedIds = collectedIds.filter((id) => /[:./]/.test(id));
  const ids = collectedIds.filter((id) => {
    if (/[:./]/.test(id)) return true;
    const bare = normalize(id);
    return !qualifiedIds.some((qualified) =>
      normalize(qualified.split(/[.:/]/).at(-1) ?? '') === bare);
  });
  if (ids.length === 0 && kind === 'measure' && eligibleCandidates.length === 1) {
    const certified = eligibleCandidates[0]!;
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
  const namedWinner = memberNamedInQuestion(ids, eligibleCandidates, question);
  if (namedWinner) {
    const winnerCandidate = directCandidates.find((candidate) => (candidate.qualifiedId ?? candidate.id) === namedWinner);
    return {
      requested,
      qualifiedId: namedWinner,
      ...(winnerCandidate?.aggregation ? { aggregation: winnerCandidate.aggregation } : {}),
      status: 'resolved',
      candidateIds: [namedWinner],
    };
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
  return value.toLowerCase()
    .replace(/%/g, ' percentage ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
