/**
 * Deterministic whole-tuple compatibility for RFC 0005 analytical frames.
 * Retrieval and AI may nominate IDs; only this solver can prove an executable
 * metric/entity/dimension/member/time/comparison/ranking/output combination.
 *
 * Acceptance: CONTRACT-002, SKILL-004, AGT-018.
 */

import {
  normalizeMetricCapabilityContract,
  type AnalyticalOperation,
  type AnalyticalPolicyContract,
  type AnalyticalQuestionFrameV2,
  type MetricCapabilityContract,
} from '@duckcodeailabs/dql-core';
import type { AgentEvidenceCandidate } from './meaning-resolution.js';

export type AnalyticalFitClass = 'exact' | 'parameterized' | 'adaptable';

export interface AnalyticalCapabilityCandidate {
  candidateId: string;
  capability: MetricCapabilityContract;
  fitClass?: AnalyticalFitClass;
}

export type AnalyticalCompatibilityCode =
  | 'FRAME_AMBIGUOUS'
  | 'MULTI_METRIC_UNSUPPORTED'
  | 'METRIC_CAPABILITY_MISSING'
  | 'ENTITY_GRAIN_UNSUPPORTED'
  | 'DIMENSION_ROLE_UNSUPPORTED'
  | 'MEMBER_FILTER_UNSUPPORTED'
  | 'RELATIONSHIP_PROOF_MISSING'
  | 'TIME_DIMENSION_REQUIRED'
  | 'TIME_DIMENSION_AMBIGUOUS'
  | 'TIME_ROLE_UNSUPPORTED'
  | 'TIME_GRAIN_UNSUPPORTED'
  | 'TIMEZONE_REQUIRED'
  | 'CALENDAR_REQUIRED'
  | 'COMPLETENESS_POLICY_REQUIRED'
  | 'PERIOD_CONTRACT_INVALID'
  | 'COMPARISON_UNSUPPORTED'
  | 'COMPARISON_ALIGNMENT_REQUIRED'
  | 'RANKING_UNSUPPORTED'
  | 'NON_ADDITIVE_DIMENSION'
  | 'OUTPUT_UNSUPPORTED'
  | 'EXECUTION_CAPABILITY_MISSING'
  | 'EXECUTION_AMBIGUOUS'
  | 'POLICY_AMBIGUOUS';

export interface AnalyticalCompatibilityFailure {
  code: AnalyticalCompatibilityCode;
  field: string;
  message: string;
  candidateIds?: string[];
}

export type AnalyticalCompatibilityResult =
  | {
      status: 'ready';
      frame: AnalyticalQuestionFrameV2;
      candidateId: string;
      capability: MetricCapabilityContract;
      route: MetricCapabilityContract['executionCapabilities'][number]['route'];
      adapterId?: string;
      fitClass: AnalyticalFitClass;
      proof: string[];
      policyIds: string[];
    }
  | {
      status: 'clarify';
      frame: AnalyticalQuestionFrameV2;
      failure: AnalyticalCompatibilityFailure;
      failures: AnalyticalCompatibilityFailure[];
      policyIds: string[];
    }
  | {
      status: 'blocked';
      frame: AnalyticalQuestionFrameV2;
      failures: AnalyticalCompatibilityFailure[];
      policyIds: string[];
    };

export interface AnalyticalCapabilityNormalizationResult {
  candidateId: string;
  status: 'complete' | 'incomplete';
  capability?: MetricCapabilityContract;
  missing: string[];
}

const ROUTE_PRIORITY: Record<MetricCapabilityContract['executionCapabilities'][number]['route'], number> = {
  certified: 4,
  semantic: 3,
  governed_sql: 2,
  exploratory: 1,
};

const FIT_PRIORITY: Record<AnalyticalFitClass, number> = {
  exact: 3,
  parameterized: 2,
  adaptable: 1,
};

/**
 * Admit only an explicit normalized capability contract. Legacy descriptive
 * fields are reported as missing rather than promoted into execution truth.
 */
export function normalizeEvidenceAnalyticalCapability(candidate: AgentEvidenceCandidate): AnalyticalCapabilityNormalizationResult {
  const candidateId = candidate.qualifiedId ?? candidate.id;
  const capability = normalizeMetricCapabilityContract(candidate.analyticalCapability);
  if (capability) return { candidateId, status: 'complete', capability, missing: [] };
  const missing = [
    ...(!candidate.primaryEntity ? ['primaryEntityId'] : []),
    ...(!candidate.dimensions?.length ? ['dimensionRoles'] : []),
    ...(!candidate.timeGrains?.length ? ['timeDimensions'] : []),
    'additivity',
    'supportedOperations',
    'supportedOutputKinds',
    'executionCapabilities',
    'sourceFingerprint',
  ];
  return {
    candidateId,
    status: 'incomplete',
    missing: [...new Set(missing)].sort(),
  };
}

export function solveAnalyticalCompatibility(input: {
  frame: AnalyticalQuestionFrameV2;
  candidates: AnalyticalCapabilityCandidate[];
  policies?: AnalyticalPolicyContract[];
}): AnalyticalCompatibilityResult {
  const policyResolution = applyAnalyticalPolicies(input.frame, input.policies ?? []);
  if ('failure' in policyResolution) {
    return {
      status: 'clarify',
      frame: policyResolution.frame,
      failure: policyResolution.failure,
      failures: [policyResolution.failure],
      policyIds: policyResolution.policyIds,
    };
  }
  const frame = policyResolution.frame;
  const policyIds = policyResolution.policyIds;
  if (frame.ambiguity.length > 0) {
    const first = frame.ambiguity[0]!;
    const failure: AnalyticalCompatibilityFailure = {
      code: 'FRAME_AMBIGUOUS',
      field: first.field,
      message: `The analytical frame has unresolved ambiguity: ${first.reasonCode}.`,
      candidateIds: [...first.candidateIds],
    };
    return {
      status: 'clarify',
      frame,
      failure,
      failures: [failure],
      policyIds,
    };
  }
  if (frame.metricConceptIds.length !== 1) {
    return {
      status: 'blocked',
      frame,
      failures: [
        {
          code: 'MULTI_METRIC_UNSUPPORTED',
          field: 'metricConceptIds',
          message: 'This composition stage requires exactly one metric contract.',
          candidateIds: [...frame.metricConceptIds],
        },
      ],
      policyIds,
    };
  }

  const metricId = frame.metricConceptIds[0]!;
  const matching = input.candidates.filter((candidate) => candidate.capability.metricId === metricId);
  if (matching.length === 0) {
    return {
      status: 'blocked',
      frame,
      failures: [
        {
          code: 'METRIC_CAPABILITY_MISSING',
          field: 'metricConceptIds',
          message: `No normalized capability contract covers ${metricId}.`,
          candidateIds: [metricId],
        },
      ],
      policyIds,
    };
  }

  const failed: AnalyticalCompatibilityFailure[] = [];
  const ready: Array<{
    candidate: AnalyticalCapabilityCandidate;
    frame: AnalyticalQuestionFrameV2;
    route: MetricCapabilityContract['executionCapabilities'][number];
    fitClass: AnalyticalFitClass;
    proof: string[];
  }> = [];
  for (const candidate of matching) {
    const resolvedTime = resolveTimeDimension(frame, candidate.capability);
    if ('failure' in resolvedTime) {
      failed.push({
        ...resolvedTime.failure,
        candidateIds: [candidate.candidateId],
      });
      continue;
    }
    const candidateFailures = evaluateCapabilityTuple(resolvedTime.frame, candidate.capability);
    if (candidateFailures.length > 0) {
      failed.push(
        ...candidateFailures.map((failure) => ({
          ...failure,
          candidateIds: [candidate.candidateId],
        })),
      );
      continue;
    }
    const routes = [...candidate.capability.executionCapabilities].sort(
      (left, right) => ROUTE_PRIORITY[right.route] - ROUTE_PRIORITY[left.route] || (left.adapterId ?? '').localeCompare(right.adapterId ?? ''),
    );
    const route = routes[0];
    if (!route) {
      failed.push({
        code: 'EXECUTION_CAPABILITY_MISSING',
        field: 'executionCapabilities',
        message: `${candidate.candidateId} has no executable adapter.`,
        candidateIds: [candidate.candidateId],
      });
      continue;
    }
    ready.push({
      candidate,
      frame: resolvedTime.frame,
      route,
      fitClass: candidate.fitClass ?? 'exact',
      proof: buildProof(resolvedTime.frame, candidate.capability, route),
    });
  }

  ready.sort(
    (left, right) =>
      ROUTE_PRIORITY[right.route.route] - ROUTE_PRIORITY[left.route.route] ||
      FIT_PRIORITY[right.fitClass] - FIT_PRIORITY[left.fitClass] ||
      left.candidate.candidateId.localeCompare(right.candidate.candidateId),
  );
  const winner = ready[0];
  if (!winner)
    return {
      status: 'blocked',
      frame,
      failures: dedupeFailures(failed),
      policyIds,
    };
  const tied = ready.filter(
    (candidate) => ROUTE_PRIORITY[candidate.route.route] === ROUTE_PRIORITY[winner.route.route] && FIT_PRIORITY[candidate.fitClass] === FIT_PRIORITY[winner.fitClass],
  );
  if (tied.length > 1) {
    const failure: AnalyticalCompatibilityFailure = {
      code: 'EXECUTION_AMBIGUOUS',
      field: 'execution',
      message: 'More than one materially equivalent execution asset covers the complete analytical frame.',
      candidateIds: tied.map((candidate) => candidate.candidate.candidateId).sort(),
    };
    return {
      status: 'clarify',
      frame,
      failure,
      failures: [failure, ...dedupeFailures(failed)],
      policyIds,
    };
  }
  return {
    status: 'ready',
    frame: winner.frame,
    candidateId: winner.candidate.candidateId,
    capability: winner.candidate.capability,
    route: winner.route.route,
    ...(winner.route.adapterId ? { adapterId: winner.route.adapterId } : {}),
    fitClass: winner.fitClass,
    proof: winner.proof,
    policyIds,
  };
}

function applyAnalyticalPolicies(
  inputFrame: AnalyticalQuestionFrameV2,
  policies: AnalyticalPolicyContract[],
):
  | { frame: AnalyticalQuestionFrameV2; policyIds: string[] }
  | {
      frame: AnalyticalQuestionFrameV2;
      policyIds: string[];
      failure: AnalyticalCompatibilityFailure;
    } {
  const frame = structuredClone(inputFrame);
  const applicable = policies.filter((policy) => !policy.metricIds?.length || frame.metricConceptIds.some((metricId) => policy.metricIds!.includes(metricId)));
  const policyIds = applicable.map((policy) => policy.policyId).sort();
  if (!frame.timeContext) return { frame, policyIds };
  const fields: Array<{
    key: 'timeRole' | 'calendarId' | 'timezone' | 'completenessPolicy';
    values: Array<string | undefined>;
  }> = [
    { key: 'timeRole', values: applicable.map((policy) => policy.timeRole) },
    {
      key: 'calendarId',
      values: applicable.map((policy) => policy.calendarId),
    },
    { key: 'timezone', values: applicable.map((policy) => policy.timezone) },
    {
      key: 'completenessPolicy',
      values: applicable.map((policy) => policy.completenessPolicy),
    },
  ];
  for (const field of fields) {
    if (frame.timeContext[field.key]) continue;
    const values = [...new Set(field.values.filter((value): value is string => Boolean(value)))];
    if (values.length > 1) {
      return {
        frame,
        policyIds,
        failure: {
          code: 'POLICY_AMBIGUOUS',
          field: `timeContext.${field.key}`,
          message: `Eligible analytical policies disagree about ${field.key}.`,
          candidateIds: policyIds,
        },
      };
    }
    if (values.length === 1) Object.assign(frame.timeContext, { [field.key]: values[0] });
  }
  if (frame.comparison && !frame.comparison.alignment) {
    const values = [
      ...new Set(applicable.map((policy) => policy.comparisonAlignment).filter((value): value is NonNullable<AnalyticalPolicyContract['comparisonAlignment']> => Boolean(value))),
    ];
    if (values.length > 1) {
      return {
        frame,
        policyIds,
        failure: {
          code: 'POLICY_AMBIGUOUS',
          field: 'comparison.alignment',
          message: 'Eligible analytical policies disagree about comparison alignment.',
          candidateIds: policyIds,
        },
      };
    }
    if (values.length === 1) frame.comparison.alignment = values[0];
  }
  if (frame.ranking && !frame.ranking.byPeriodId && frame.timeContext) {
    const values = [
      ...new Set(applicable.map((policy) => policy.defaultRankingPeriod).filter((value): value is NonNullable<AnalyticalPolicyContract['defaultRankingPeriod']> => Boolean(value))),
    ];
    if (values.length > 1) {
      return {
        frame,
        policyIds,
        failure: {
          code: 'POLICY_AMBIGUOUS',
          field: 'ranking.byPeriodId',
          message: 'Eligible analytical policies disagree about the default ranking period.',
          candidateIds: policyIds,
        },
      };
    }
    if (values[0] === 'current') {
      frame.ranking.byPeriodId = frame.timeContext.periods.find((period) => period.kind === 'current')?.id;
    } else if (values[0] === 'comparison') {
      frame.ranking.byPeriodId = frame.comparison?.comparisonPeriodIds[0];
    }
  }
  return { frame, policyIds };
}

function resolveTimeDimension(
  inputFrame: AnalyticalQuestionFrameV2,
  capability: MetricCapabilityContract,
): { frame: AnalyticalQuestionFrameV2 } | { failure: AnalyticalCompatibilityFailure } {
  const frame = structuredClone(inputFrame);
  if (!frame.timeContext) return { frame };
  if (frame.timeContext.timeDimensionId) {
    const selected = capability.timeDimensions.find((dimension) => dimension.dimensionId === frame.timeContext!.timeDimensionId);
    if (!selected) {
      return {
        failure: {
          code: 'TIME_DIMENSION_REQUIRED',
          field: 'timeContext.timeDimensionId',
          message: `Metric ${capability.metricId} does not support ${frame.timeContext.timeDimensionId}.`,
        },
      };
    }
    return { frame };
  }
  const use = frame.comparison ? 'comparison' : frame.questionType === 'trend' ? 'trend' : 'scalar';
  const byRole = frame.timeContext.timeRole ? capability.timeDimensions.filter((dimension) => dimension.role === frame.timeContext!.timeRole) : capability.timeDimensions;
  const defaults = byRole.filter((dimension) => dimension.defaultFor?.includes(use));
  const candidates = defaults.length > 0 ? defaults : byRole;
  if (candidates.length === 1) {
    frame.timeContext.timeDimensionId = candidates[0]!.dimensionId;
    frame.timeContext.timeRole ??= candidates[0]!.role;
    frame.timeContext.completenessPolicy ??= capability.freshness?.defaultCompletenessPolicy;
    return { frame };
  }
  if (candidates.length > 1) {
    return {
      failure: {
        code: 'TIME_DIMENSION_AMBIGUOUS',
        field: 'timeContext.timeDimensionId',
        message: `Metric ${capability.metricId} has multiple compatible time dimensions and no unique governed default.`,
        candidateIds: candidates.map((candidate) => candidate.dimensionId).sort(),
      },
    };
  }
  return {
    failure: {
      code: 'TIME_DIMENSION_REQUIRED',
      field: 'timeContext.timeDimensionId',
      message: `Metric ${capability.metricId} has no compatible time dimension.`,
    },
  };
}

function evaluateCapabilityTuple(frame: AnalyticalQuestionFrameV2, capability: MetricCapabilityContract): AnalyticalCompatibilityFailure[] {
  const failures: AnalyticalCompatibilityFailure[] = [];
  for (const entityId of frame.entityGrainIds) {
    if (entityId !== capability.primaryEntityId && !capability.resultGrainIds.includes(entityId)) {
      failures.push({
        code: 'ENTITY_GRAIN_UNSUPPORTED',
        field: 'entityGrainIds',
        message: `${capability.metricId} cannot produce result grain ${entityId}.`,
      });
    }
  }
  for (const binding of frame.dimensions) {
    if (binding.role === 'time_axis') continue;
    const dimension = capability.dimensions.find((candidate) => candidate.dimensionId === binding.dimensionId);
    if (!dimension || !dimension.supportedRoles.includes(binding.role)) {
      failures.push({
        code: 'DIMENSION_ROLE_UNSUPPORTED',
        field: `dimensions.${binding.dimensionId}.${binding.role}`,
        message: `${capability.metricId} does not support ${binding.dimensionId} as ${binding.role}.`,
      });
      continue;
    }
    if (
      dimension.entityId !== capability.primaryEntityId &&
      (binding.role === 'group_by' || binding.role === 'rank_entity' || binding.role === 'filter') &&
      !dimension.relationshipPathIds?.length
    ) {
      failures.push({
        code: 'RELATIONSHIP_PROOF_MISSING',
        field: `dimensions.${binding.dimensionId}`,
        message: `${binding.dimensionId} changes metric grain without a governed relationship path.`,
      });
    }
  }
  for (const member of frame.memberBindings) {
    const dimension = capability.dimensions.find((candidate) => candidate.dimensionId === member.dimensionId);
    if (!dimension?.supportedRoles.includes('filter')) {
      failures.push({
        code: 'MEMBER_FILTER_UNSUPPORTED',
        field: `memberBindings.${member.dimensionId}`,
        message: `${capability.metricId} cannot filter by ${member.dimensionId}.`,
      });
    } else if (dimension.entityId !== capability.primaryEntityId && !dimension.relationshipPathIds?.length) {
      failures.push({
        code: 'RELATIONSHIP_PROOF_MISSING',
        field: `memberBindings.${member.dimensionId}`,
        message: `${member.dimensionId} filters another entity without a governed relationship path.`,
      });
    }
  }
  for (const dimensionId of capability.additivity.nonAdditiveDimensionIds ?? []) {
    if (frame.dimensions.some((dimension) => dimension.dimensionId === dimensionId)) {
      failures.push({
        code: 'NON_ADDITIVE_DIMENSION',
        field: `dimensions.${dimensionId}`,
        message: `${capability.metricId} is non-additive across ${dimensionId}.`,
      });
    }
  }

  const requiredOperations = requiredOperationsFor(frame);
  for (const operation of requiredOperations) {
    if (!capability.operations.includes(operation)) {
      failures.push({
        code: operation === 'compare' ? 'COMPARISON_UNSUPPORTED' : operation === 'rank' ? 'RANKING_UNSUPPORTED' : 'DIMENSION_ROLE_UNSUPPORTED',
        field: `operations.${operation}`,
        message: `${capability.metricId} does not support ${operation}.`,
      });
    }
  }

  if (frame.comparison && !frame.comparison.alignment) {
    failures.push({
      code: 'COMPARISON_ALIGNMENT_REQUIRED',
      field: 'comparison.alignment',
      message: 'A multi-period comparison requires an explicit elapsed, calendar, or fiscal alignment policy.',
    });
  }

  if (frame.timeContext) {
    const selected = capability.timeDimensions.find((dimension) => dimension.dimensionId === frame.timeContext!.timeDimensionId);
    if (selected && frame.timeContext.timeRole && selected.role !== frame.timeContext.timeRole) {
      failures.push({
        code: 'TIME_ROLE_UNSUPPORTED',
        field: 'timeContext.timeRole',
        message: `${selected.dimensionId} has role ${selected.role}, not ${frame.timeContext.timeRole}.`,
      });
    }
    if (selected && frame.timeContext.grain && !selected.supportedGrains.includes(frame.timeContext.grain)) {
      failures.push({
        code: 'TIME_GRAIN_UNSUPPORTED',
        field: 'timeContext.grain',
        message: `${selected.dimensionId} does not support ${frame.timeContext.grain} grain.`,
      });
    }
    const relativePeriods = frame.timeContext.periods.filter((period) => period.kind !== 'absolute');
    if (relativePeriods.length > 0 && !frame.timeContext.timezone) {
      failures.push({
        code: 'TIMEZONE_REQUIRED',
        field: 'timeContext.timezone',
        message: 'Relative periods require an explicit governed timezone.',
      });
    }
    if (frame.timeContext.periods.some((period) => period.kind === 'previous_year') && !frame.timeContext.calendarId) {
      failures.push({
        code: 'CALENDAR_REQUIRED',
        field: 'timeContext.calendarId',
        message: 'Previous-year alignment requires an explicit governed calendar.',
      });
    }
    if (frame.timeContext.periods.some((period) => period.kind === 'current') && !frame.timeContext.completenessPolicy) {
      failures.push({
        code: 'COMPLETENESS_POLICY_REQUIRED',
        field: 'timeContext.completenessPolicy',
        message: 'Current periods require an explicit completeness policy.',
      });
    }
    failures.push(...validatePeriodContract(frame));
  }

  const outputKinds = new Set(capability.supportedOutputKinds);
  for (const output of frame.requestedOutputs) {
    if (!outputKinds.has(output.kind)) {
      failures.push({
        code: 'OUTPUT_UNSUPPORTED',
        field: `requestedOutputs.${output.id}`,
        message: `${capability.metricId} cannot produce output kind ${output.kind}.`,
      });
    }
  }
  const certified = capability.executionCapabilities.some((execution) => execution.route === 'certified');
  if (certified && capability.declaredOutputIds?.length) {
    for (const output of frame.requestedOutputs) {
      if (!capability.declaredOutputIds.includes(output.id)) {
        failures.push({
          code: 'OUTPUT_UNSUPPORTED',
          field: `requestedOutputs.${output.id}`,
          message: `Certified capability ${capability.metricId} does not declare output ${output.id}.`,
        });
      }
    }
  }
  return dedupeFailures(failures);
}

function validatePeriodContract(frame: AnalyticalQuestionFrameV2): AnalyticalCompatibilityFailure[] {
  const time = frame.timeContext;
  if (!time) return [];
  const failures: AnalyticalCompatibilityFailure[] = [];
  const ids = time.periods.map((period) => period.id);
  if (new Set(ids).size !== ids.length) {
    failures.push({
      code: 'PERIOD_CONTRACT_INVALID',
      field: 'timeContext.periods',
      message: 'Period IDs must be unique.',
    });
  }
  const idSet = new Set(ids);
  if (frame.comparison) {
    if (!idSet.has(frame.comparison.basePeriodId) || frame.comparison.comparisonPeriodIds.some((id) => !idSet.has(id))) {
      failures.push({
        code: 'PERIOD_CONTRACT_INVALID',
        field: 'comparison',
        message: 'Comparison references an unknown period.',
      });
    }
  }
  if (frame.ranking?.byPeriodId && !idSet.has(frame.ranking.byPeriodId)) {
    failures.push({
      code: 'PERIOD_CONTRACT_INVALID',
      field: 'ranking.byPeriodId',
      message: 'Ranking references an unknown period.',
    });
  }
  return failures;
}

function requiredOperationsFor(frame: AnalyticalQuestionFrameV2): Set<AnalyticalOperation> {
  const operations = new Set<AnalyticalOperation>();
  if (frame.memberBindings.length > 0 || frame.dimensions.some((dimension) => dimension.role === 'filter')) operations.add('filter');
  if (frame.dimensions.some((dimension) => dimension.role === 'group_by' || dimension.role === 'rank_entity')) operations.add('group');
  if (frame.questionType === 'trend') operations.add('trend');
  if (frame.comparison || (frame.timeContext?.periods.length ?? 0) > 1) operations.add('compare');
  if (frame.ranking) operations.add('rank');
  return operations;
}

function buildProof(frame: AnalyticalQuestionFrameV2, capability: MetricCapabilityContract, route: MetricCapabilityContract['executionCapabilities'][number]): string[] {
  return [
    `metric:${capability.metricId}`,
    ...frame.entityGrainIds.map((id) => `grain:${id}`),
    ...frame.dimensions.map((dimension) => `dimension:${dimension.dimensionId}:${dimension.role}`),
    ...frame.memberBindings.map((binding) => `member:${binding.dimensionId}:${binding.source}`),
    ...(frame.timeContext?.timeDimensionId ? [`time:${frame.timeContext.timeDimensionId}:${frame.timeContext.timeRole ?? 'unspecified'}`] : []),
    ...[...requiredOperationsFor(frame)].map((operation) => `operation:${operation}`),
    `route:${route.route}:${route.adapterId ?? 'native'}`,
  ].sort();
}

function dedupeFailures(failures: AnalyticalCompatibilityFailure[]): AnalyticalCompatibilityFailure[] {
  const byKey = new Map<string, AnalyticalCompatibilityFailure>();
  for (const failure of failures) {
    const key = `${failure.code}\u0000${failure.field}\u0000${failure.message}\u0000${(failure.candidateIds ?? []).join(',')}`;
    if (!byKey.has(key)) byKey.set(key, failure);
  }
  return [...byKey.values()].sort((left, right) => left.code.localeCompare(right.code) || left.field.localeCompare(right.field) || left.message.localeCompare(right.message));
}
