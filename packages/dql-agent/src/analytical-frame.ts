/**
 * Zero-provider construction of an RFC 0005 analytical frame from an already
 * resolved metric, parsed request hints, retrieved semantic members, and an
 * explicit normalized capability contract.
 *
 * This is intentionally conservative: unresolved roles become ambiguity or no
 * frame instead of name-based execution authority.
 *
 * Acceptance: AGT-017, AGT-018.
 */

import { normalizeMetricCapabilityContract, type AnalyticalDimensionBindingV2, type AnalyticalQuestionFrameV2, type MetricCapabilityContract } from '@duckcodeailabs/dql-core';
import { questionTypeFromText, type AgentEvidenceCandidate, type AgentRetrievalEvidence, type MeaningQueryIntent } from './meaning-resolution.js';

export function buildDeterministicAnalyticalFrame(input: {
  question: string;
  evidence: AgentRetrievalEvidence;
  metricCandidate: AgentEvidenceCandidate;
  candidates: AgentEvidenceCandidate[];
}): AnalyticalQuestionFrameV2 | undefined {
  const capability = normalizeMetricCapabilityContract(input.metricCandidate.analyticalCapability);
  if (!capability) return undefined;
  const meaningType = questionTypeFromText(input.question);
  if (meaningType === 'definition') return undefined;
  const queryIntent: MeaningQueryIntent = {
    measures: input.evidence.parsedIntent?.measures ?? [],
    dimensions: input.evidence.parsedIntent?.dimensions ?? [],
    filters: input.evidence.parsedIntent?.filters ?? [],
    ...(input.evidence.parsedIntent?.timeRange ? { timeRange: input.evidence.parsedIntent.timeRange } : {}),
    ...(input.evidence.parsedIntent?.timeGrain ? { timeGrain: input.evidence.parsedIntent.timeGrain } : {}),
    ...(input.evidence.parsedIntent?.order ? { order: input.evidence.parsedIntent.order } : {}),
    ...(input.evidence.parsedIntent?.limit !== undefined ? { limit: input.evidence.parsedIntent.limit } : {}),
  };
  const requestedDimensionTerms = new Set(queryIntent.dimensions.map(normalize).filter(Boolean));
  for (const filter of queryIntent.filters) requestedDimensionTerms.add(normalize(filter.field));
  for (const candidate of input.candidates) {
    if (candidate.kind !== 'semantic_member') continue;
    const capabilityDimension = resolveCapabilityDimension(candidate.qualifiedId ?? candidate.id, capability);
    if (!capabilityDimension) continue;
    const terms = [candidate.name, ...(candidate.aliases ?? [])].map(normalize).filter(Boolean);
    if (terms.some((term) => phraseAppears(input.question, term))) {
      requestedDimensionTerms.add(normalize(candidate.qualifiedId ?? candidate.id));
    }
  }

  const ambiguity: AnalyticalQuestionFrameV2['ambiguity'] = [];
  const resolvedDimensions = new Map<string, MetricCapabilityContract['dimensions'][number]>();
  for (const requested of requestedDimensionTerms) {
    const matches = resolveDimensionTerm(requested, capability, input.candidates);
    if (matches.length === 1) resolvedDimensions.set(matches[0]!.dimensionId, matches[0]!);
    else if (matches.length > 1) {
      ambiguity.push({
        field: `dimensions.${requested}`,
        candidateIds: matches.map((dimension) => dimension.dimensionId).sort(),
        reasonCode: 'DIMENSION_AMBIGUOUS',
      });
    }
  }

  const filterDimensionIds = new Set<string>();
  const memberBindings: AnalyticalQuestionFrameV2['memberBindings'] = [];
  for (const filter of queryIntent.filters) {
    const matches = resolveDimensionTerm(normalize(filter.field), capability, input.candidates);
    if (matches.length !== 1) continue;
    const dimension = matches[0]!;
    filterDimensionIds.add(dimension.dimensionId);
    resolvedDimensions.set(dimension.dimensionId, dimension);
    memberBindings.push({
      dimensionId: dimension.dimensionId,
      canonicalValues: [filter.value],
      source: 'question',
      confidence: 'exact',
    });
  }

  const rankingRequested = meaningType === 'ranking' || queryIntent.limit !== undefined || /\b(top|bottom|highest|lowest|rank)\b/i.test(input.question);
  const groupRequested = rankingRequested || /\b(by|per|for each|breakdown)\b/i.test(input.question);
  const dimensions: AnalyticalDimensionBindingV2[] = [];
  for (const dimension of resolvedDimensions.values()) {
    const onlyFilter = filterDimensionIds.has(dimension.dimensionId) && !groupRequested;
    if (onlyFilter) {
      dimensions.push({ dimensionId: dimension.dimensionId, role: 'filter' });
      continue;
    }
    if (dimension.supportedRoles.includes('group_by')) {
      dimensions.push({ dimensionId: dimension.dimensionId, role: 'group_by' });
      if (rankingRequested && dimension.supportedRoles.includes('rank_entity')) {
        dimensions.push({
          dimensionId: dimension.dimensionId,
          role: 'rank_entity',
        });
      }
    } else if (filterDimensionIds.has(dimension.dimensionId)) {
      dimensions.push({ dimensionId: dimension.dimensionId, role: 'filter' });
    }
  }

  const timeRequested =
    Boolean(queryIntent.timeRange || queryIntent.timeGrain) ||
    /\b(today|current|this (?:day|week|month|quarter|year)|month[ -]to[ -]date|mtd|last year|previous year|year over year|yoy)\b/i.test(input.question);
  const previousYearRequested = /\b(last year|previous year|year over year|yoy)\b/i.test(input.question);
  const currentRequested = /\b(today|current|this (?:day|week|month|quarter|year)|month[ -]to[ -]date|mtd)\b/i.test(input.question) || previousYearRequested;
  const timeContext: AnalyticalQuestionFrameV2['timeContext'] = timeRequested
    ? {
        ...(capability.timeDimensions.length === 1
          ? {
              timeDimensionId: capability.timeDimensions[0]!.dimensionId,
              timeRole: capability.timeDimensions[0]!.role,
            }
          : {}),
        grain: queryIntent.timeGrain ?? inferTimeGrain(input.question),
        ...(capability.freshness?.defaultCompletenessPolicy
          ? {
              completenessPolicy: capability.freshness.defaultCompletenessPolicy,
            }
          : {}),
        periods: [
          ...(currentRequested ? [{ id: 'current', kind: 'current' as const }] : []),
          ...(previousYearRequested
            ? [
                {
                  id: 'previous_year',
                  kind: 'previous_year' as const,
                  alignToPeriodId: 'current',
                },
              ]
            : []),
          ...(!currentRequested && queryIntent.timeRange ? [{ id: 'requested_period', kind: 'absolute' as const }] : []),
        ],
      }
    : undefined;
  if (timeContext) {
    for (const policy of input.evidence.analyticalPolicies ?? []) {
      if (policy.metricIds?.length && !policy.metricIds.includes(capability.metricId)) continue;
      timeContext.timeRole ??= policy.timeRole;
      timeContext.calendarId ??= policy.calendarId;
      timeContext.timezone ??= policy.timezone;
      timeContext.completenessPolicy ??= policy.completenessPolicy;
    }
    dimensions.push({
      dimensionId: capability.timeDimensions.length === 1 ? capability.timeDimensions[0]!.dimensionId : '',
      role: 'time_axis',
    });
  }
  const filteredDimensions = dimensions.filter((dimension) => Boolean(dimension.dimensionId));
  const grouped = [...resolvedDimensions.values()].filter((dimension) =>
    filteredDimensions.some((binding) => binding.dimensionId === dimension.dimensionId && (binding.role === 'group_by' || binding.role === 'rank_entity')),
  );
  const entityGrainIds = grouped.length > 0 ? [...new Set(grouped.map((dimension) => dimension.entityId))] : [capability.defaultResultGrainId];

  const comparison = previousYearRequested
    ? {
        basePeriodId: 'current',
        comparisonPeriodIds: ['previous_year'],
        outputs: ['value', 'absolute_delta', 'percent_delta'] as Array<'value' | 'absolute_delta' | 'percent_delta'>,
        zeroDenominatorPolicy: 'null' as const,
      }
    : undefined;
  const rankDimension = filteredDimensions.find((dimension) => dimension.role === 'rank_entity');
  const ranking =
    rankingRequested && rankDimension
      ? {
          entityDimensionId: rankDimension.dimensionId,
          byMetricId: capability.metricId,
          ...(currentRequested ? { byPeriodId: 'current' } : {}),
          direction: queryIntent.order ?? (/\b(bottom|lowest)\b/i.test(input.question) ? ('asc' as const) : ('desc' as const)),
          limit: queryIntent.limit ?? extractLimit(input.question) ?? 10,
          tiePolicy: 'stable_secondary_key' as const,
        }
      : undefined;
  const localMetric = localId(capability.metricId);
  const projectedTimeDimensions = meaningType === 'trend' && timeContext?.timeDimensionId
    ? [{
        dimensionId: timeContext.timeDimensionId,
        outputId: localId(timeContext.timeDimensionId),
      }]
    : [];
  const requestedOutputs: AnalyticalQuestionFrameV2['requestedOutputs'] = [
    ...grouped.map((dimension) => ({
      id: localId(dimension.dimensionId),
      kind: 'dimension' as const,
    })),
    ...projectedTimeDimensions.map((dimension) => ({
      id: dimension.outputId,
      kind: 'dimension' as const,
    })),
    ...(comparison
      ? [
          {
            id: `${localMetric}__current`,
            kind: 'metric_value' as const,
            metricId: capability.metricId,
            periodId: 'current',
          },
          {
            id: `${localMetric}__previous_year`,
            kind: 'metric_value' as const,
            metricId: capability.metricId,
            periodId: 'previous_year',
          },
          {
            id: `${localMetric}__delta`,
            kind: 'delta' as const,
            metricId: capability.metricId,
          },
          {
            id: `${localMetric}__percent_delta`,
            kind: 'percent_delta' as const,
            metricId: capability.metricId,
          },
        ]
      : [
          {
            id: localMetric,
            kind: 'metric_value' as const,
            metricId: capability.metricId,
            ...(timeContext?.periods[0]?.id ? { periodId: timeContext.periods[0].id } : {}),
          },
        ]),
    ...(ranking ? [{ id: 'rank', kind: 'rank' as const }] : []),
  ];

  return {
    version: 2,
    interpretedQuestion: input.question.trim(),
    questionType: meaningType === 'value' ? 'scalar' : meaningType,
    metricConceptIds: [capability.metricId],
    entityGrainIds,
    dimensions: filteredDimensions,
    memberBindings,
    ...(timeContext ? { timeContext } : {}),
    ...(comparison ? { comparison } : {}),
    ...(ranking ? { ranking } : {}),
    requestedOutputs,
    ambiguity,
  };
}

function resolveDimensionTerm(requested: string, capability: MetricCapabilityContract, candidates: AgentEvidenceCandidate[]): MetricCapabilityContract['dimensions'] {
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'semantic_member') continue;
    const terms = [candidate.name, ...(candidate.aliases ?? []), candidate.qualifiedId ?? '', candidate.id].map(normalize).filter(Boolean);
    if (terms.some((term) => termsMatch(term, requested))) {
      candidateIds.add(candidate.qualifiedId ?? candidate.id);
    }
  }
  return capability.dimensions.filter((dimension) => termsMatch(normalize(dimension.dimensionId), requested) || candidateIds.has(dimension.dimensionId));
}

function resolveCapabilityDimension(id: string, capability: MetricCapabilityContract): MetricCapabilityContract['dimensions'][number] | undefined {
  return capability.dimensions.find((dimension) => dimension.dimensionId === id || termsMatch(normalize(dimension.dimensionId), normalize(id)));
}

function phraseAppears(question: string, phrase: string): boolean {
  const questionTokens = new Set(normalize(question).split(' ').map(singularize));
  const significant = phrase
    .split(' ')
    .map(singularize)
    .filter((token) => token.length >= 3 && !['name', 'dimension'].includes(token));
  return significant.length > 0 && significant.some((token) => questionTokens.has(token));
}

function termsMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right || left.endsWith(` ${right}`) || right.endsWith(` ${left}`)) return true;
  const leftTokens = new Set(left.split(' ').map(singularize));
  const rightTokens = right
    .split(' ')
    .map(singularize)
    .filter((token) => token.length >= 3);
  return rightTokens.length > 0 && rightTokens.every((token) => leftTokens.has(token));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularize(value: string): string {
  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value;
}

function localId(value: string): string {
  return (
    value
      .split(/::|[:./]/)
      .filter(Boolean)
      .at(-1) ?? value
  );
}

function inferTimeGrain(question: string): string | undefined {
  if (/\b(today|day|daily)\b/i.test(question)) return 'day';
  if (/\b(week|weekly)\b/i.test(question)) return 'week';
  if (/\b(month|monthly|mtd)\b/i.test(question)) return 'day';
  if (/\b(quarter|quarterly)\b/i.test(question)) return 'quarter';
  if (/\b(year|yearly|annual|yoy)\b/i.test(question)) return 'year';
  return undefined;
}

function extractLimit(question: string): number | undefined {
  const match = /\b(?:top|bottom)\s+(\d{1,4})\b/i.exec(question);
  return match ? Math.max(1, Number(match[1])) : undefined;
}
