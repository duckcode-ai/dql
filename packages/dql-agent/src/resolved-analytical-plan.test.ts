import { describe, expect, it } from 'vitest';
import { buildResolvedAnalyticalPlan, deriveResolvedAnalyticalPlan, resolvePlanTimeRange } from './resolved-analytical-plan.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';

const metric: AgentEvidenceCandidate = {
  id: 'semantic:metric:consumption_model.rollover_balance_amount',
  qualifiedId: 'semantic:consumption:rollover_balance_amount',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Rollover Balance Amount',
  aliases: ['rollover balance'],
  definition: 'Remaining eligible balance carried into the next billing month.',
  domain: 'consumption',
  primaryEntity: 'account',
  dimensions: ['semantic:consumption:dimension:customer', 'semantic:consumption:dimension:month'],
  timeGrains: ['month'],
  relationshipEvidence: ['consumption::relationship::balance_to_customer'],
  relevanceScore: 0.98,
  matchReasons: ['meaning match'],
  compatibility: 'compatible',
  compatibilityFacts: ['dimension: customer', 'time grain: month'],
};

const evidence: AgentRetrievalEvidence = {
  snapshotId: 'snapshot-1',
  sourceFingerprint: 'source-1',
  knowledgeLens: {
    mode: 'pinned',
    activeDomainId: 'consumption',
    skillRefs: ['consumption::skill::rollover-analysis'],
    snapshotId: 'snapshot-1',
    skillFingerprints: { 'consumption::skill::rollover-analysis': 'skill-hash-1' },
  },
  candidates: [metric],
};

const resolution: MeaningResolution = {
  interpretedQuestion: 'Top customers by monthly rollover balance amount.',
  questionType: 'ranking',
  selectedConceptIds: [metric.id],
  recommendedExecutionId: metric.id,
  queryIntent: {
    measures: ['rollover balance'],
    dimensions: ['customer'],
    filters: [],
    timeGrain: 'month',
    order: 'desc',
    limit: 10,
  },
  rejectedCandidates: [],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'semantic',
};

describe('ResolvedAnalyticalPlan (AGT-013 / API-006)', () => {
  it('resolves relative time once against the plan clock', () => {
    expect(resolvePlanTimeRange('last month', new Date('2026-07-22T15:00:00Z'))).toEqual({
      expression: 'last month',
      startInclusive: '2026-06-01T00:00:00.000Z',
      endExclusive: '2026-07-01T00:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(resolvePlanTimeRange('last 7 days', new Date('2026-07-22T15:00:00Z'))).toEqual({
      expression: 'last 7 days',
      startInclusive: '2026-07-15T00:00:00.000Z',
      endExclusive: '2026-07-22T00:00:00.000Z',
      timeZone: 'UTC',
    });
  });

  it('binds canonical IDs, snapshot/Skill hashes, compatibility, and output shape deterministically', () => {
    const first = buildResolvedAnalyticalPlan({
      question: 'Who are the top 10 customers by monthly rollover balance?',
      resolution,
      evidence,
      candidates: [metric],
    });
    const second = buildResolvedAnalyticalPlan({
      question: 'Who are the top 10 customers by monthly rollover balance?',
      resolution,
      evidence,
      candidates: [metric],
    });

    expect(first).toMatchObject({
      mode: 'authoritative',
      snapshotId: 'snapshot-1',
      selectedConceptIds: ['semantic:consumption:rollover_balance_amount'],
      executionId: 'semantic:consumption:rollover_balance_amount',
      capability: 'semantic_execution',
      entityGrain: 'account',
      relationshipPathIds: ['consumption::relationship::balance_to_customer'],
      query: {
        measures: [expect.objectContaining({ status: 'resolved' })],
        dimensions: [expect.objectContaining({
          requested: 'customer',
          qualifiedId: 'semantic:consumption:dimension:customer',
          status: 'resolved',
        })],
        timeGrain: 'month',
        order: 'desc',
        limit: 10,
      },
      knowledgeLens: {
        skillFingerprints: { 'consumption::skill::rollover-analysis': 'skill-hash-1' },
      },
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.planId).toBe(second.planId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.query.dimensions)).toBe(true);
  });

  it('AGT-031 binds the grounded member when the provider returns no filter', () => {
    // The provider named the grouping field and forgot the member, so the run
    // returned every customer. DQL had already grounded "Wesley Jenkins" in
    // `parsedIntent.filters`; that binding is evidence-backed, not a guess.
    const attribute = {
      id: 'semantic:dimension:customers.customer_type',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'customer_type', aliases: ['customer type'],
      primaryEntity: 'customer', dimensions: ['customer_type', 'customer_name'],
      relevanceScore: 1, matchReasons: [], compatibility: 'compatible', eligible: true,
    } as unknown as AgentEvidenceCandidate;

    const plan = buildResolvedAnalyticalPlan({
      question: 'What customer type is Wesley Jenkins?',
      resolution: {
        interpretedQuestion: 'Look up customer_type.',
        questionType: 'value',
        selectedConceptIds: [attribute.id],
        recommendedExecutionId: attribute.id,
        queryIntent: { measures: [], dimensions: ['customer_type'], filters: [] },
        rejectedCandidates: [], confidence: 'high', missingInformation: [],
        recommendedRoute: 'semantic',
      } as unknown as MeaningResolution,
      evidence: {
        ...evidence,
        candidates: [attribute],
        parsedIntent: {
          measures: [], dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Wesley Jenkins' }],
        },
      } as never,
      candidates: [attribute],
    });

    expect(plan.query.filters).toHaveLength(1);
    expect(plan.query.filters[0]).toMatchObject({ field: 'customer_name', value: 'Wesley Jenkins' });
    expect(plan.query.filters[0]?.binding.status).toBe('resolved');
  });

  it('AGT-031 lets the provider\'s own filters win over the grounded fallback', () => {
    const attribute = {
      id: 'semantic:dimension:customers.customer_type',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'customer_type', aliases: [], primaryEntity: 'customer',
      dimensions: ['customer_type', 'customer_name'],
      relevanceScore: 1, matchReasons: [], compatibility: 'compatible', eligible: true,
    } as unknown as AgentEvidenceCandidate;

    const plan = buildResolvedAnalyticalPlan({
      question: 'What customer type is Wesley Jenkins?',
      resolution: {
        interpretedQuestion: 'x', questionType: 'value',
        selectedConceptIds: [attribute.id], recommendedExecutionId: attribute.id,
        queryIntent: {
          measures: [], dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Benjamin Bell' }],
        },
        rejectedCandidates: [], confidence: 'high', missingInformation: [],
        recommendedRoute: 'semantic',
      } as unknown as MeaningResolution,
      evidence: {
        ...evidence, candidates: [attribute],
        parsedIntent: {
          measures: [], dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Wesley Jenkins' }],
        },
      } as never,
      candidates: [attribute],
    });

    expect(plan.query.filters[0]).toMatchObject({ value: 'Benjamin Bell' });
  });

  it('AGT-031 freezes a metric-free attribute lookup as semantic execution', () => {
    // "What customer type is <member>?" names a FIELD and a MEMBER and no
    // measure at all. The claim under test is whether the plan builder can
    // freeze such a plan, or whether it is structurally metric-only.
    const attribute: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_type',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'customer_type',
      aliases: ['customer type'],
      definition: 'Whether the customer is new or returning.',
      primaryEntity: 'customer',
      dimensions: ['customer_type', 'customer_name'],
      relevanceScore: 1,
      matchReasons: ['exact name or alias'],
      compatibility: 'compatible',
      eligible: true,
      exactMatch: true,
    } as AgentEvidenceCandidate;

    const plan = buildResolvedAnalyticalPlan({
      question: 'What customer type is Wesley Jenkins?',
      resolution: {
        interpretedQuestion: 'Look up the customer_type attribute for one customer.',
        questionType: 'value',
        selectedConceptIds: [attribute.id],
        recommendedExecutionId: attribute.id,
        queryIntent: {
          measures: [],
          dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Wesley Jenkins' }],
        },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'semantic',
      } as unknown as MeaningResolution,
      evidence: { ...evidence, candidates: [attribute] },
      candidates: [attribute],
    });

    expect(plan.capability).toBe('semantic_execution');
    expect(plan.query.measures).toEqual([]);
    // The dimension arrived twice — once as the candidate's qualified identity
    // and once as its own declared dimension name — and two ids read as
    // ambiguous, which blocked every metric-free lookup.
    expect(plan.query.dimensions).toEqual([
      expect.objectContaining({
        requested: 'customer_type',
        qualifiedId: 'semantic:dimension:customers.customer_type',
        status: 'resolved',
        candidateIds: ['semantic:dimension:customers.customer_type'],
      }),
    ]);
    expect(plan.query.filters[0]?.binding.status).toBe('resolved');
  });

  it('fails capability closed when a requested semantic dimension is unresolved', () => {
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by campaign channel.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, dimensions: ['campaign channel'] },
      },
      evidence,
      candidates: [metric],
    });
    expect(plan.query.dimensions).toEqual([
      expect.objectContaining({ requested: 'campaign channel', status: 'unresolved' }),
    ]);
    expect(plan.capability).toBe('blocked');
  });

  it('does not let a v2 frame dimension outrank selected-capability authority', () => {
    const exactDimensionId = 'semantic:consumption:dimension:customer.customer_name';
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by customer name.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, dimensions: ['customer name'] },
        selectedConceptIds: [metric.id, 'semantic:member:customer_name'],
        analyticalFrame: {
          version: 2,
          interpretedQuestion: 'Show rollover balance by customer name.',
          questionType: 'ranking',
          metricConceptIds: [metric.qualifiedId!],
          entityGrainIds: ['semantic:consumption:entity:customer'],
          dimensions: [{ dimensionId: exactDimensionId, role: 'group_by', requestedLabel: 'customer name' }],
          memberBindings: [],
          requestedOutputs: [
            { id: 'customer_name', kind: 'dimension' },
            { id: 'rollover_balance', kind: 'metric_value', metricId: metric.qualifiedId },
          ],
          ambiguity: [],
        },
      },
      evidence,
      candidates: [
        metric,
        {
          ...metric,
          id: 'semantic:member:customer_name',
          qualifiedId: 'semantic:consumption:member:customer_name',
          kind: 'semantic_member',
          name: 'Customer Name',
        },
        {
          ...metric,
          id: 'semantic:member:other_customer_name',
          qualifiedId: 'semantic:sales:member:customer_name',
          kind: 'semantic_member',
          name: 'Customer Name',
        },
      ],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'customer name',
      status: 'ambiguous',
      candidateIds: [
        'semantic:consumption:member:customer_name',
        'semantic:sales:member:customer_name',
      ],
    }]);
    expect(plan.query.dimensions[0]?.qualifiedId).not.toBe(exactDimensionId);
  });

  it('AGT-012 binds an arbitrary requested entity only from the selected metric capability', () => {
    const workspaceNameId = 'semantic:workforce:dimension:workspace_name';
    const capabilityMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:workforce.active_seats',
      qualifiedId: 'semantic:workforce:metric:active_seats',
      name: 'Active seats',
      aliases: ['seat count'],
      dimensions: [workspaceNameId],
      analyticalCapability: {
        metricId: 'semantic:workforce:metric:active_seats',
        measureIds: ['semantic:workforce:measure:active_seats'],
        primaryEntityId: 'semantic:workforce:entity:subscription',
        defaultResultGrainId: 'semantic:workforce:grain:scalar',
        resultGrainIds: ['semantic:workforce:grain:scalar', 'semantic:workforce:entity:workspace'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          {
            dimensionId: workspaceNameId,
            entityId: 'semantic:workforce:entity:workspace',
            supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
            relationshipPathIds: ['semantic:workforce:relationship:subscription_to_workspace'],
          },
          {
            dimensionId: 'semantic:workforce:dimension:is_archived',
            entityId: 'semantic:workforce:entity:workspace',
            supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
            relationshipPathIds: ['semantic:workforce:relationship:subscription_to_workspace'],
          },
          {
            dimensionId: 'semantic:inventory:dimension:is_trial_item',
            entityId: 'semantic:inventory:entity:item',
            supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
            relationshipPathIds: ['semantic:workforce:relationship:subscription_to_item'],
          },
        ],
        timeDimensions: [],
        operations: ['filter', 'group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:workforce-active-seats',
      },
    };
    const genericMember: AgentEvidenceCandidate = {
      ...capabilityMetric,
      id: 'semantic:member:workspace_name',
      qualifiedId: workspaceNameId,
      kind: 'semantic_member',
      name: 'Workspace',
      aliases: ['workspace identity'],
      analyticalCapability: undefined,
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Which workspaces have the most active seats?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank workspaces by active seats.',
        selectedConceptIds: [capabilityMetric.id, genericMember.id],
        recommendedExecutionId: capabilityMetric.id,
        queryIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        analyticalFrame: {
          version: 2,
          interpretedQuestion: 'Rank workspaces by active seats.',
          questionType: 'ranking',
          metricConceptIds: ['semantic:workforce:metric:active_seats'],
          entityGrainIds: ['semantic:finance:entity:cost_center'],
          dimensions: [{
            dimensionId: 'semantic:finance:dimension:cost_center',
            role: 'group_by',
          }],
          memberBindings: [],
          ranking: {
            entityDimensionId: 'semantic:finance:dimension:cost_center',
            byMetricId: 'semantic:workforce:metric:active_seats',
            direction: 'desc',
            limit: 10,
            tiePolicy: 'stable_secondary_key',
          },
          requestedOutputs: [{
            id: 'active_seats',
            kind: 'metric_value',
            metricId: 'semantic:workforce:metric:active_seats',
          }],
          ambiguity: [],
        },
      },
      evidence: { ...evidence, candidates: [capabilityMetric, genericMember] },
      candidates: [capabilityMetric, genericMember],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'workspace',
      qualifiedId: workspaceNameId,
      status: 'resolved',
      candidateIds: [workspaceNameId],
    }]);
    expect(plan.capability).toBe('semantic_execution');
    expect(plan.entityGrain).toBe('semantic:workforce:entity:workspace');
    expect(plan.relationshipPathIds).toEqual([
      'semantic:workforce:relationship:subscription_to_workspace',
    ]);
    expect(plan.compatibilityProof).toContainEqual(expect.objectContaining({
      candidateId: 'semantic:workforce:metric:active_seats',
      facts: expect.arrayContaining([
        'capability:metric:semantic:workforce:metric:active_seats',
        'capability:primary_entity:semantic:workforce:entity:subscription',
        'capability:result_grain:semantic:workforce:entity:workspace',
        'capability:relationship:semantic:workforce:relationship:subscription_to_workspace',
      ]),
    }));
    expect(plan.entityGrain).not.toBe('semantic:finance:entity:cost_center');
    expect(plan.query.dimensions[0]?.qualifiedId).not.toBe('semantic:finance:dimension:cost_center');
    const repeated = buildResolvedAnalyticalPlan({
      question: 'Which workspaces have the most active seats?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank workspaces by active seats.',
        selectedConceptIds: [capabilityMetric.id, genericMember.id],
        recommendedExecutionId: capabilityMetric.id,
        queryIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        analyticalFrame: plan.analyticalFrame,
      },
      evidence: { ...evidence, candidates: [capabilityMetric, genericMember] },
      candidates: [capabilityMetric, genericMember],
    });
    expect(repeated.fingerprint).toBe(plan.fingerprint);
  });

  it('AGT-012 binds the requested entity display dimension and excludes unrelated capability booleans', () => {
    const customerNameId = 'semantic:order_item:dimension:customers.customer_name';
    const revenueMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:order_item.revenue',
      qualifiedId: 'semantic:order_item:revenue',
      name: 'Revenue',
      aliases: ['total revenue'],
      primaryEntity: 'order_item',
      dimensions: [
        customerNameId,
        'semantic:order_item:dimension:customers.customer_type',
        'semantic:order_item:dimension:customers.first_ordered_at',
        'semantic:order_item:dimension:orders.customer_order_number',
        'semantic:order_item:dimension:orders.ordered_at',
        'semantic:order_item:dimension:products.is_drink_item',
        'semantic:order_item:dimension:products.is_food_item',
      ],
      analyticalCapability: {
        metricId: 'semantic:order_item:revenue',
        measureIds: ['semantic:order_item:measure:revenue'],
        primaryEntityId: 'semantic:order_item:entity:order_item',
        defaultResultGrainId: 'semantic:order_item:entity:order_item',
        resultGrainIds: ['semantic:order_item:entity:order_item'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          ['customers.customer_name', 'customer_name', 'semantic:order_item:entity:customer'],
          ['customers.customer_type', 'customer_type', 'semantic:order_item:entity:customer'],
          ['customers.first_ordered_at', 'first_ordered_at', 'semantic:order_item:entity:customer'],
          ['orders.customer_order_number', 'customer_order_number', 'semantic:order_item:entity:order'],
          ['orders.ordered_at', 'ordered_at', 'semantic:order_item:entity:order'],
          ['products.is_drink_item', 'is_drink_item', 'semantic:order_item:entity:product'],
          ['products.is_food_item', 'is_food_item', 'semantic:order_item:entity:product'],
        ].map(([localId, label, entityId]) => ({
          dimensionId: `semantic:order_item:dimension:${localId}`,
          entityId,
          supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'] as const,
          label,
          nativeGroupingReference: localId.replace('.', '__'),
          nativeGroupingPath: [localId.split('.')[0]!],
        })),
        timeDimensions: [],
        operations: ['filter', 'group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:order-item-revenue',
      },
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'who are the top customers have a highest revenue',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank customers by revenue.',
        selectedConceptIds: [revenueMetric.id],
        recommendedExecutionId: revenueMetric.id,
        queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
      },
      evidence: { ...evidence, candidates: [revenueMetric] },
      candidates: [revenueMetric],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'customer',
      qualifiedId: customerNameId,
      status: 'resolved',
      candidateIds: [customerNameId],
    }]);
    expect(plan.capability).toBe('semantic_execution');
    expect(plan.resolutionFailure).toBeUndefined();
    expect(plan.relationshipPathIds).toEqual([]);
    expect(plan.relationshipProofs).toEqual([expect.objectContaining({
      version: 1,
      kind: 'semantic_native_grouping',
      metricId: 'semantic:order_item:revenue',
      dimensionId: customerNameId,
      nativeGroupingReference: 'customers__customer_name',
      nativeGroupingPath: ['customers'],
      route: 'semantic',
      adapterId: 'native',
      snapshotId: 'snapshot-1',
      capabilityFingerprint: 'sha256:order-item-revenue',
      authorityFingerprint: expect.any(String),
    })]);
    expect(plan.compatibilityProof).toContainEqual(expect.objectContaining({
      candidateId: 'semantic:order_item:revenue',
      facts: expect.arrayContaining([
        `capability:dimension:${customerNameId}:semantic:order_item:entity:customer`,
        `capability:native_grouping:${customerNameId}:customers__customer_name`,
      ]),
    }));
    expect(plan.query.dimensions[0]!.candidateIds).not.toEqual(expect.arrayContaining([
      'semantic:order_item:dimension:products.is_drink_item',
      'semantic:order_item:dimension:products.is_food_item',
    ]));
  });

  it('AGT-012 uses arbitrary authored entity and display labels without leaking attribute distractors', () => {
    const assetLabelId = 'semantic:maintenance:dimension:assets.asset_label';
    const assetMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:maintenance.open_cost',
      qualifiedId: 'semantic:maintenance:metric:open_cost',
      name: 'Open cost',
      aliases: ['maintenance cost'],
      analyticalCapability: {
        metricId: 'semantic:maintenance:metric:open_cost',
        measureIds: ['semantic:maintenance:measure:open_cost'],
        primaryEntityId: 'semantic:maintenance:entity:work_order',
        defaultResultGrainId: 'semantic:maintenance:entity:work_order',
        resultGrainIds: ['semantic:maintenance:entity:work_order'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          { dimensionId: assetLabelId, label: 'asset_label', entityId: 'semantic:maintenance:entity:asset', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'asset__asset_label', nativeGroupingPath: ['asset'] },
          { dimensionId: 'semantic:maintenance:dimension:assets.asset_type', label: 'asset_type', entityId: 'semantic:maintenance:entity:asset', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'asset__asset_type', nativeGroupingPath: ['asset'] },
          { dimensionId: 'semantic:maintenance:dimension:work_orders.asset_work_order_number', label: 'asset_work_order_number', entityId: 'semantic:maintenance:entity:work_order', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'work_order__asset_work_order_number', nativeGroupingPath: [] },
          { dimensionId: 'semantic:maintenance:dimension:parts.is_asset_critical', label: 'is_asset_critical', entityId: 'semantic:maintenance:entity:part', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'part__is_asset_critical', nativeGroupingPath: ['part'] },
        ],
        timeDimensions: [],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:maintenance-open-cost',
      },
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Which assets have the highest open cost?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank assets by open cost.',
        selectedConceptIds: [assetMetric.id],
        recommendedExecutionId: assetMetric.id,
        queryIntent: { measures: ['open cost'], dimensions: ['asset'], filters: [], order: 'desc', limit: 10 },
      },
      evidence: { ...evidence, candidates: [assetMetric] },
      candidates: [assetMetric],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'asset',
      qualifiedId: assetLabelId,
      status: 'resolved',
      candidateIds: [assetLabelId],
    }]);
    expect(plan.capability).toBe('semantic_execution');
  });

  it('AGT-012 retains every qualified selected-capability dimension when the entity binding is ambiguous', () => {
    const ambiguousMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:support.case_volume',
      qualifiedId: 'semantic:support:metric:case_volume',
      name: 'Case volume',
      aliases: ['cases'],
      analyticalCapability: {
        metricId: 'semantic:support:metric:case_volume',
        measureIds: ['semantic:support:measure:case_count'],
        primaryEntityId: 'semantic:support:entity:case',
        defaultResultGrainId: 'semantic:support:grain:scalar',
        resultGrainIds: ['semantic:support:grain:scalar', 'semantic:support:entity:account'],
        aggregation: 'count',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          {
            dimensionId: 'semantic:support:dimension:billing_account',
            entityId: 'semantic:support:entity:account',
            supportedRoles: ['group_by', 'rank_entity'],
            relationshipPathIds: ['semantic:support:relationship:case_to_billing_account'],
          },
          {
            dimensionId: 'semantic:support:dimension:service_account',
            entityId: 'semantic:support:entity:account',
            supportedRoles: ['group_by', 'rank_entity'],
            relationshipPathIds: ['semantic:support:relationship:case_to_service_account'],
          },
        ],
        timeDimensions: [],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:support-case-volume',
      },
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Which accounts have the most cases?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank accounts by case volume.',
        selectedConceptIds: [ambiguousMetric.id],
        recommendedExecutionId: ambiguousMetric.id,
        queryIntent: { measures: ['case volume'], dimensions: ['account'], filters: [], order: 'desc', limit: 10 },
      },
      evidence: { ...evidence, candidates: [ambiguousMetric] },
      candidates: [ambiguousMetric],
    });

    expect(plan.query.dimensions).toEqual([expect.objectContaining({
      requested: 'account',
      status: 'ambiguous',
      candidateIds: [
        'semantic:support:dimension:billing_account',
        'semantic:support:dimension:service_account',
      ],
    })]);
    expect(plan.capability).toBe('blocked');
  });

  it('fails capability closed when a requested measure cannot bind inside the selected meaning', () => {
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover liability by customer.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, measures: ['unrelated liability'] },
      },
      evidence,
      candidates: [metric],
    });
    expect(plan.query.measures).toEqual([
      expect.objectContaining({ requested: 'unrelated liability', status: 'unresolved' }),
    ]);
    expect(plan.capability).toBe('blocked');
  });

  it('AGT-009 never binds requested revenue to a certified block that returns only lifetime_spend', () => {
    const topCustomers: AgentEvidenceCandidate = {
      id: 'dql:block:top_customers',
      qualifiedId: 'orders::block::top_customers',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_customers',
      relevanceScore: 1,
      matchReasons: ['tag: revenue'],
      compatibility: 'compatible',
      compatibilityFacts: ['output: customer_name', 'output: lifetime_spend', 'output: order_count'],
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'show me revenue',
      resolution: {
        interpretedQuestion: 'show me revenue',
        questionType: 'value',
        selectedConceptIds: [topCustomers.id],
        recommendedExecutionId: topCustomers.id,
        queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'certified',
      },
      evidence: { ...evidence, candidates: [topCustomers] },
      candidates: [topCustomers],
    });

    expect(plan.capability).toBe('blocked');
    expect(plan.query.measures).toEqual([
      expect.objectContaining({ requested: 'revenue', status: 'unresolved' }),
    ]);
    expect(plan.query.measures[0]).not.toHaveProperty('qualifiedId');
  });

  it('applies a typed follow-up delta without reading prior prose or SQL', () => {
    const root = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by customer.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, timeRange: 'last month' },
      },
      evidence,
      candidates: [metric],
      mode: 'authoritative',
      referenceTime: new Date('2026-07-22T15:00:00Z'),
    });
    const followUp = deriveResolvedAnalyticalPlan(root, {
      question: 'Only Melissa, top 3.',
      selectedResultFilter: {
        binding: root.query.dimensions[0]!,
        value: 'Melissa Lopez',
        sourceTurnId: 'turn-1',
      },
      limit: 3,
    });
    expect(followUp).toMatchObject({
      parentPlanId: root.planId,
      rootPlanId: root.planId,
      revision: 1,
      snapshotId: root.snapshotId,
      executionId: root.executionId,
      query: {
        limit: 3,
        timeBounds: {
          startInclusive: '2026-06-01T00:00:00.000Z',
          endExclusive: '2026-07-01T00:00:00.000Z',
        },
        filters: [{
          value: 'Melissa Lopez',
          binding: { qualifiedId: 'semantic:consumption:dimension:customer' },
        }],
      },
    });
    expect(followUp.fingerprint).not.toBe(root.fingerprint);
    expect(followUp.query.timeBounds).toEqual(root.query.timeBounds);
    expect(Object.isFrozen(followUp)).toBe(true);
  });
});
