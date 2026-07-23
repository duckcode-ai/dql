import { describe, expect, it } from 'vitest';
import type { AnalyticalQuestionFrameV2, MetricCapabilityContract } from '@duckcodeailabs/dql-core';
import { normalizeEvidenceAnalyticalCapability, solveAnalyticalCompatibility } from './analytical-compatibility.js';
import { buildDeterministicAnalyticalFrame } from './analytical-frame.js';
import { buildAnalyticalCapabilityReadiness } from './analytical-readiness.js';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { createHybridRouter } from './router.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';

const ids = {
  metric: 'commerce::metric::net_revenue',
  measure: 'commerce::measure::net_revenue',
  order: 'commerce::entity::order',
  customer: 'commerce::entity::customer',
  customerName: 'commerce::dimension::customer_name',
  reportDate: 'commerce::dimension::report_date',
  relationship: 'commerce::relationship::order_to_customer',
};

const semanticCapability: MetricCapabilityContract = {
  metricId: ids.metric,
  semanticModelId: 'commerce::semantic_model::orders',
  measureIds: [ids.measure],
  primaryEntityId: ids.order,
  defaultResultGrainId: 'commerce::grain::scalar',
  resultGrainIds: ['commerce::grain::scalar', ids.customer],
  aggregation: 'sum',
  additivity: { entities: 'additive', time: 'additive' },
  dimensions: [
    {
      dimensionId: ids.customerName,
      entityId: ids.customer,
      supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
      relationshipPathIds: [ids.relationship],
    },
  ],
  timeDimensions: [
    {
      dimensionId: ids.reportDate,
      role: 'report_as_of',
      supportedGrains: ['day', 'week', 'month', 'quarter', 'year'],
      defaultFor: ['scalar', 'trend', 'comparison'],
    },
  ],
  freshness: {
    observedThroughFieldId: ids.reportDate,
    defaultCompletenessPolicy: 'latest_complete',
  },
  operations: ['filter', 'group', 'trend', 'compare', 'rank'],
  supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta', 'rank'],
  executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
  sourceFingerprint: 'semantic-capability-v1',
};

function revenueTodayFrame(): AnalyticalQuestionFrameV2 {
  return {
    version: 2,
    interpretedQuestion: 'Revenue today.',
    questionType: 'scalar',
    metricConceptIds: [ids.metric],
    entityGrainIds: ['commerce::grain::scalar'],
    dimensions: [{ dimensionId: ids.reportDate, role: 'time_axis' }],
    memberBindings: [],
    timeContext: {
      timeRole: 'report_as_of',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'day',
      completenessPolicy: 'latest_complete',
      periods: [{ id: 'current', kind: 'current' }],
    },
    requestedOutputs: [
      {
        id: 'revenue',
        kind: 'metric_value',
        metricId: ids.metric,
        periodId: 'current',
      },
    ],
    ambiguity: [],
  };
}

function zoomRevenueFrame(): AnalyticalQuestionFrameV2 {
  return {
    ...revenueTodayFrame(),
    interpretedQuestion: 'Revenue from Zoom customer.',
    dimensions: [
      { dimensionId: ids.customerName, role: 'filter' },
      { dimensionId: ids.reportDate, role: 'time_axis' },
    ],
    memberBindings: [
      {
        dimensionId: ids.customerName,
        canonicalValues: ['Zoom'],
        source: 'question',
        confidence: 'exact',
      },
    ],
  };
}

function topCustomersComparisonFrame(): AnalyticalQuestionFrameV2 {
  return {
    version: 2,
    interpretedQuestion: 'Current and last-year revenue for the top five customers.',
    questionType: 'ranking',
    metricConceptIds: [ids.metric],
    entityGrainIds: [ids.customer],
    dimensions: [
      { dimensionId: ids.customerName, role: 'group_by' },
      { dimensionId: ids.customerName, role: 'rank_entity' },
      { dimensionId: ids.reportDate, role: 'time_axis' },
    ],
    memberBindings: [],
    timeContext: {
      timeDimensionId: ids.reportDate,
      timeRole: 'report_as_of',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'day',
      completenessPolicy: 'latest_complete',
      periods: [
        {
          id: 'current',
          kind: 'current',
          start: '2026-07-01',
          end: '2026-07-22',
        },
        {
          id: 'previous_year',
          kind: 'previous_year',
          start: '2025-07-01',
          end: '2025-07-22',
          alignToPeriodId: 'current',
        },
      ],
    },
    comparison: {
      basePeriodId: 'current',
      comparisonPeriodIds: ['previous_year'],
      alignment: 'elapsed_period',
      outputs: ['value', 'absolute_delta', 'percent_delta'],
      zeroDenominatorPolicy: 'null',
    },
    ranking: {
      entityDimensionId: ids.customerName,
      byMetricId: ids.metric,
      byPeriodId: 'current',
      direction: 'desc',
      limit: 5,
      tiePolicy: 'stable_secondary_key',
    },
    requestedOutputs: [
      { id: 'customer_name', kind: 'dimension' },
      {
        id: 'current_revenue',
        kind: 'metric_value',
        metricId: ids.metric,
        periodId: 'current',
      },
      {
        id: 'previous_revenue',
        kind: 'metric_value',
        metricId: ids.metric,
        periodId: 'previous_year',
      },
      { id: 'revenue_delta', kind: 'delta', metricId: ids.metric },
      { id: 'revenue_delta_pct', kind: 'percent_delta', metricId: ids.metric },
    ],
    ambiguity: [],
  };
}

const metricCandidate: AgentEvidenceCandidate = {
  id: 'metric:net_revenue',
  qualifiedId: ids.metric,
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Net Revenue',
  primaryEntity: ids.order,
  dimensions: [ids.customerName, ids.reportDate],
  timeGrains: ['day', 'month', 'year'],
  relevanceScore: 1,
  matchReasons: ['exact metric meaning'],
  compatibility: 'compatible',
  analyticalCapability: semanticCapability,
};

const customerCandidate: AgentEvidenceCandidate = {
  id: 'dimension:customer_name',
  qualifiedId: ids.customerName,
  kind: 'semantic_member',
  trustTier: 'semantic',
  name: 'Customer Name',
  aliases: ['customer', 'customers'],
  relevanceScore: 0.2,
  matchReasons: ['customer dimension'],
  compatibility: 'compatible',
};

const revenuePolicy = {
  policyId: 'commerce::skill::revenue_reporting',
  sourceHash: 'revenue-policy-v1',
  metricIds: [ids.metric],
  timeRole: 'report_as_of',
  calendarId: 'calendar:gregorian',
  timezone: 'America/Chicago',
  completenessPolicy: 'latest_complete' as const,
  comparisonAlignment: 'elapsed_period' as const,
  defaultRankingPeriod: 'current' as const,
};

describe('deterministic analytical compatibility (CONTRACT-002 / AGT-017 / AGT-018)', () => {
  it('reports exact scenario readiness and incomplete legacy metadata', () => {
    const report = buildAnalyticalCapabilityReadiness([metricCandidate]);
    expect(report).toEqual([
      expect.objectContaining({
        candidateId: ids.metric,
        metricId: ids.metric,
        status: 'complete',
        support: {
          scalar: true,
          filter: true,
          grouping: true,
          trend: true,
          comparison: true,
          ranking: true,
        },
        blockers: {},
      }),
    ]);
    const incomplete = buildAnalyticalCapabilityReadiness([
      {
        ...metricCandidate,
        id: 'legacy-metric',
        qualifiedId: undefined,
        analyticalCapability: undefined,
      },
    ]);
    expect(incomplete[0]).toMatchObject({
      candidateId: 'legacy-metric',
      status: 'incomplete',
      support: { scalar: false, comparison: false },
    });
  });

  it('constructs all three canonical frames without an AI call', () => {
    const today = buildDeterministicAnalyticalFrame({
      question: 'What is revenue today?',
      evidence: {
        candidates: [metricCandidate],
        parsedIntent: { measures: ['net revenue'] },
        analyticalPolicies: [revenuePolicy],
      },
      metricCandidate,
      candidates: [metricCandidate],
    });
    expect(today).toMatchObject({
      questionType: 'scalar',
      entityGrainIds: ['commerce::grain::scalar'],
      timeContext: {
        timeDimensionId: ids.reportDate,
        timezone: 'America/Chicago',
        completenessPolicy: 'latest_complete',
        periods: [{ id: 'current', kind: 'current' }],
      },
    });

    const zoom = buildDeterministicAnalyticalFrame({
      question: 'What is revenue from Zoom customer?',
      evidence: {
        candidates: [metricCandidate, customerCandidate],
        parsedIntent: {
          measures: ['net revenue'],
          dimensions: ['customer'],
          filters: [{ field: 'customer', value: 'Zoom' }],
        },
      },
      metricCandidate,
      candidates: [metricCandidate, customerCandidate],
    });
    expect(zoom).toMatchObject({
      entityGrainIds: ['commerce::grain::scalar'],
      dimensions: [{ dimensionId: ids.customerName, role: 'filter' }],
      memberBindings: [{ dimensionId: ids.customerName, canonicalValues: ['Zoom'] }],
    });

    const comparison = buildDeterministicAnalyticalFrame({
      question: 'Show current revenue and last year revenue for top 5 customers.',
      evidence: {
        candidates: [metricCandidate, customerCandidate],
        parsedIntent: {
          measures: ['net revenue'],
          dimensions: ['customer'],
          order: 'desc',
          limit: 5,
        },
        analyticalPolicies: [revenuePolicy],
      },
      metricCandidate,
      candidates: [metricCandidate, customerCandidate],
    });
    expect(comparison).toMatchObject({
      questionType: 'ranking',
      entityGrainIds: [ids.customer],
      comparison: {
        basePeriodId: 'current',
        comparisonPeriodIds: ['previous_year'],
      },
      ranking: {
        entityDimensionId: ids.customerName,
        byPeriodId: 'current',
        limit: 5,
      },
      requestedOutputs: [
        { id: 'customer_name', kind: 'dimension' },
        { id: 'net_revenue__current', kind: 'metric_value' },
        { id: 'net_revenue__previous_year', kind: 'metric_value' },
        { id: 'net_revenue__delta', kind: 'delta' },
        { id: 'net_revenue__percent_delta', kind: 'percent_delta' },
        { id: 'rank', kind: 'rank' },
      ],
    });
  });

  it('resolves revenue today through the unique governed default time dimension', () => {
    const result = solveAnalyticalCompatibility({
      frame: revenueTodayFrame(),
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    });
    expect(result).toMatchObject({
      status: 'ready',
      route: 'semantic',
      adapterId: 'metricflow-cli',
      frame: {
        timeContext: {
          timeDimensionId: ids.reportDate,
          completenessPolicy: 'latest_complete',
        },
      },
    });
  });

  it('keeps Zoom as a customer filter instead of changing the result grain', () => {
    const result = solveAnalyticalCompatibility({
      frame: zoomRevenueFrame(),
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.frame.entityGrainIds).toEqual(['commerce::grain::scalar']);
    expect(result.frame.memberBindings).toEqual([
      expect.objectContaining({
        dimensionId: ids.customerName,
        canonicalValues: ['Zoom'],
      }),
    ]);
    expect(result.proof).toContain(`operation:filter`);
    expect(result.proof).not.toContain(`dimension:${ids.customerName}:group_by`);
  });

  it('rejects a partial certified block and selects the complete semantic route', () => {
    const certifiedPartial: MetricCapabilityContract = {
      ...semanticCapability,
      operations: ['filter', 'group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      declaredOutputIds: ['customer_name', 'current_revenue'],
      executionCapabilities: [{ route: 'certified', adapterId: 'block:revenue_by_customer' }],
      sourceFingerprint: 'certified-partial-v1',
    };
    const result = solveAnalyticalCompatibility({
      frame: topCustomersComparisonFrame(),
      candidates: [
        {
          candidateId: 'commerce::block::revenue_by_customer',
          capability: certifiedPartial,
          fitClass: 'parameterized',
        },
        { candidateId: ids.metric, capability: semanticCapability },
      ],
    });
    expect(result).toMatchObject({
      status: 'ready',
      candidateId: ids.metric,
      route: 'semantic',
    });
  });

  it('selects a fully compatible certified block before semantic compilation', () => {
    const certifiedComplete: MetricCapabilityContract = {
      ...semanticCapability,
      declaredOutputIds: topCustomersComparisonFrame().requestedOutputs.map((output) => output.id),
      executionCapabilities: [{ route: 'certified', adapterId: 'block:revenue_yoy_top_customers' }],
      sourceFingerprint: 'certified-complete-v1',
    };
    const result = solveAnalyticalCompatibility({
      frame: topCustomersComparisonFrame(),
      candidates: [
        {
          candidateId: 'commerce::block::revenue_yoy_top_customers',
          capability: certifiedComplete,
        },
        { candidateId: ids.metric, capability: semanticCapability },
      ],
    });
    expect(result).toMatchObject({
      status: 'ready',
      candidateId: 'commerce::block::revenue_yoy_top_customers',
      route: 'certified',
      fitClass: 'exact',
    });
  });

  it('clarifies when multiple time dimensions have no unique governed default', () => {
    const capability: MetricCapabilityContract = {
      ...semanticCapability,
      timeDimensions: [
        {
          dimensionId: ids.reportDate,
          role: 'report_as_of',
          supportedGrains: ['day'],
        },
        {
          dimensionId: 'commerce::dimension::order_date',
          role: 'event_time',
          supportedGrains: ['day'],
        },
      ],
    };
    const frame = revenueTodayFrame();
    frame.timeContext = { ...frame.timeContext!, timeRole: undefined };
    const result = solveAnalyticalCompatibility({
      frame,
      candidates: [{ candidateId: ids.metric, capability }],
    });
    expect(result).toMatchObject({
      status: 'blocked',
      failures: [expect.objectContaining({ code: 'TIME_DIMENSION_AMBIGUOUS' })],
    });
  });

  it('fails closed on ambiguous members, missing relationship proof, and non-additive grouping (E2E-013)', () => {
    const ambiguous = zoomRevenueFrame();
    ambiguous.ambiguity = [{
      field: `memberBindings.${ids.customerName}`,
      reasonCode: 'MEMBER_AMBIGUOUS',
      candidateIds: ['commerce::member::zoom-us', 'commerce::member::zoom-emea'],
    }];
    expect(solveAnalyticalCompatibility({
      frame: ambiguous,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({
      status: 'clarify',
      failure: { code: 'FRAME_AMBIGUOUS', candidateIds: ['commerce::member::zoom-us', 'commerce::member::zoom-emea'] },
    });

    const noRelationship: MetricCapabilityContract = {
      ...semanticCapability,
      dimensions: semanticCapability.dimensions.map((dimension) => ({
        ...dimension,
        relationshipPathIds: [],
      })),
    };
    const missingRelationship = solveAnalyticalCompatibility({
      frame: zoomRevenueFrame(),
      candidates: [{ candidateId: ids.metric, capability: noRelationship }],
    });
    expect(missingRelationship.status).toBe('blocked');
    if (missingRelationship.status === 'blocked') {
      expect(missingRelationship.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'RELATIONSHIP_PROOF_MISSING' }),
      ]));
    }

    const nonAdditive: MetricCapabilityContract = {
      ...semanticCapability,
      additivity: {
        entities: 'non_additive',
        time: 'non_additive',
        nonAdditiveDimensionIds: [ids.customerName],
      },
    };
    const nonAdditiveResult = solveAnalyticalCompatibility({
      frame: topCustomersComparisonFrame(),
      candidates: [{ candidateId: ids.metric, capability: nonAdditive }],
    });
    expect(nonAdditiveResult.status).toBe('blocked');
    if (nonAdditiveResult.status === 'blocked') {
      expect(nonAdditiveResult.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'NON_ADDITIVE_DIMENSION' }),
      ]));
    }
  });

  it('keeps the canonical output contract equivalent across certified, semantic, and governed SQL routes (E2E-013)', () => {
    const frame = topCustomersComparisonFrame();
    const variants = [
      { route: 'certified' as const, adapterId: 'block:top_customers' },
      { route: 'semantic' as const, adapterId: 'metricflow-cli' },
      { route: 'governed_sql' as const, adapterId: 'sql-ast-v1' },
    ].map((execution) => solveAnalyticalCompatibility({
      frame,
      candidates: [{
        candidateId: `${ids.metric}:${execution.route}`,
        capability: {
          ...semanticCapability,
          ...(execution.route === 'certified'
            ? { declaredOutputIds: frame.requestedOutputs.map((output) => output.id) }
            : {}),
          executionCapabilities: [execution],
          sourceFingerprint: `capability-${execution.route}`,
        },
      }],
    }));
    expect(variants.map((result) => result.status)).toEqual(['ready', 'ready', 'ready']);
    expect(variants.map((result) => result.status === 'ready'
      ? {
          route: result.route,
          outputs: result.frame.requestedOutputs,
          ranking: result.frame.ranking,
          comparison: result.frame.comparison,
        }
      : result)).toEqual([
        expect.objectContaining({ route: 'certified', outputs: frame.requestedOutputs }),
        expect.objectContaining({ route: 'semantic', outputs: frame.requestedOutputs }),
        expect.objectContaining({ route: 'governed_sql', outputs: frame.requestedOutputs }),
      ]);
  });

  it('reports legacy evidence as incomplete instead of inventing capability from names', () => {
    const legacy = normalizeEvidenceAnalyticalCapability({
      ...metricCandidate,
      analyticalCapability: undefined,
    });
    expect(legacy).toMatchObject({ status: 'incomplete' });
    expect(legacy.missing).toContain('additivity');
    expect(legacy.missing).toContain('supportedOperations');
  });

  it('binds an exact v2 frame into the immutable resolved plan without breaking v1 plans', () => {
    const frame = topCustomersComparisonFrame();
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot-analytical-v2',
      candidates: [metricCandidate],
    };
    const resolution: MeaningResolution = {
      interpretedQuestion: frame.interpretedQuestion,
      questionType: 'ranking',
      selectedConceptIds: [metricCandidate.id],
      recommendedExecutionId: metricCandidate.id,
      queryIntent: {
        measures: ['net revenue'],
        dimensions: ['customer name', 'report date'],
        filters: [],
        timeGrain: 'day',
        order: 'desc',
        limit: 5,
      },
      analyticalFrame: frame,
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'semantic',
    };
    const plan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution,
      evidence,
      candidates: [metricCandidate],
      mode: 'authoritative',
    });
    expect(plan).toMatchObject({
      schemaVersion: 2,
      entityGrain: ids.customer,
      analyticalFrame: {
        comparison: { basePeriodId: 'current' },
        ranking: { byPeriodId: 'current', limit: 5 },
      },
      outputContract: {
        fields: ['customer_name', 'current_revenue', 'previous_revenue', 'revenue_delta', 'revenue_delta_pct'],
        periodIds: ['current', 'previous_year'],
      },
    });
    expect(Object.isFrozen(plan.analyticalFrame)).toBe(true);
  });

  it('overrides an AI route recommendation with deterministic complete-tuple fit', async () => {
    const frame = topCustomersComparisonFrame();
    const certifiedPartialCapability: MetricCapabilityContract = {
      ...semanticCapability,
      operations: ['filter', 'group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      declaredOutputIds: ['customer_name', 'current_revenue'],
      executionCapabilities: [{ route: 'certified', adapterId: 'block:revenue_by_customer' }],
      sourceFingerprint: 'partial-block-v1',
    };
    const blockCandidate: AgentEvidenceCandidate = {
      id: 'block:revenue_by_customer',
      qualifiedId: 'commerce::block::revenue_by_customer',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'Revenue by Customer',
      primaryEntity: ids.order,
      dimensions: [ids.customerName, ids.reportDate],
      relevanceScore: 0.99,
      matchReasons: ['revenue and customer match'],
      compatibility: 'compatible',
      analyticalCapability: certifiedPartialCapability,
      analyticalFitClass: 'parameterized',
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot-route-solver',
      candidates: [blockCandidate, metricCandidate],
    };
    const aiResolution: MeaningResolution = {
      interpretedQuestion: frame.interpretedQuestion,
      questionType: 'ranking',
      selectedConceptIds: [metricCandidate.id],
      recommendedExecutionId: blockCandidate.id,
      queryIntent: {
        measures: ['net revenue'],
        dimensions: ['customer name', 'report date'],
        filters: [],
        order: 'desc',
        limit: 5,
      },
      analyticalFrame: frame,
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'certified',
    };
    const router = createHybridRouter({
      getEvidence: async () => evidence,
      resolveMeaning: async () => aiResolution,
      resolvedPlanMode: 'authoritative',
    });
    const decision = await router.decide({
      question: frame.interpretedQuestion,
      intent: 'ad_hoc_ranking',
    });
    expect(decision.meaningResolution).toMatchObject({
      recommendedExecutionId: metricCandidate.id,
      recommendedRoute: 'semantic',
    });
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      schemaVersion: 2,
      executionId: ids.metric,
      capability: 'semantic_execution',
    });
  });

  it('uses the zero-AI exact-metric path to produce a v2 plan and semantic route', async () => {
    let resolverCalls = 0;
    const exactMetric = { ...metricCandidate, exactMatch: true };
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-zero-ai',
        candidates: [exactMetric],
        parsedIntent: { measures: ['net revenue'] },
        analyticalPolicies: [revenuePolicy],
      }),
      resolveMeaning: async () => {
        resolverCalls += 1;
        throw new Error('The exact metric path must not call AI meaning resolution.');
      },
      resolvedPlanMode: 'authoritative',
    });
    const decision = await router.decide({
      question: 'What is revenue today?',
      intent: 'ad_hoc_ranking',
    });
    expect(resolverCalls).toBe(0);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      schemaVersion: 2,
      capability: 'semantic_execution',
      analyticalPolicies: [
        {
          policyId: revenuePolicy.policyId,
          sourceHash: revenuePolicy.sourceHash,
        },
      ],
      analyticalFrame: {
        timeContext: {
          timeDimensionId: ids.reportDate,
          timezone: 'America/Chicago',
        },
      },
    });
  });

  it('routes the named-customer and current/prior top-customer canonical plans with zero AI calls', async () => {
    let resolverCalls = 0;
    const exactMetric = { ...metricCandidate, exactMatch: true };
    const decide = async (question: string, parsedIntent: AgentRetrievalEvidence['parsedIntent']) => {
      const router = createHybridRouter({
        getEvidence: async () => ({
          snapshotId: 'snapshot-canonical-zero-ai',
          candidates: [exactMetric],
          parsedIntent,
          analyticalPolicies: [revenuePolicy],
        }),
        resolveMeaning: async () => {
          resolverCalls += 1;
          throw new Error('Canonical exact plans must not call AI meaning resolution.');
        },
        resolvedPlanMode: 'authoritative',
      });
      return router.decide({ question, intent: 'ad_hoc_ranking' });
    };

    const zoom = await decide('What is revenue from Zoom customer?', {
      measures: ['net revenue'],
      dimensions: [],
      filters: [{ field: ids.customerName, value: 'Zoom' }],
    });
    expect(zoom.resolvedAnalyticalPlan).toMatchObject({
      schemaVersion: 2,
      recommendedRoute: 'semantic',
      analyticalFrame: {
        entityGrainIds: ['commerce::grain::scalar'],
        dimensions: [{ dimensionId: ids.customerName, role: 'filter' }],
        memberBindings: [{ dimensionId: ids.customerName, canonicalValues: ['Zoom'] }],
      },
    });

    const comparison = await decide('Show current revenue and last year revenue for top 5 customers.', {
      measures: ['net revenue'],
      dimensions: ['customer'],
      filters: [],
      order: 'desc',
      limit: 5,
    });
    expect(comparison.resolvedAnalyticalPlan).toMatchObject({
      schemaVersion: 2,
      recommendedRoute: 'semantic',
      analyticalFrame: {
        entityGrainIds: [ids.customer],
        comparison: { alignment: 'elapsed_period' },
        ranking: { byPeriodId: 'current', limit: 5 },
      },
    });
    expect(resolverCalls).toBe(0);
  });
});
