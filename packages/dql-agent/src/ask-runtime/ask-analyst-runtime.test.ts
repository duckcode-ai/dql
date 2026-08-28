import { describe, expect, it, vi } from 'vitest';
import { createAskAnalystRuntimeV1 } from './ask-analyst-runtime.js';
import type { IntentDecision } from '../intent-controller.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence } from '../meaning-resolution.js';

function semanticCapability(metricId: string): NonNullable<AgentEvidenceCandidate['analyticalCapability']> {
  return {
    metricId,
    semanticModelId: 'semantic:model:orders',
    measureIds: [`${metricId}:measure`],
    primaryEntityId: 'semantic:entity:order',
    defaultResultGrainId: 'semantic:grain:scalar',
    resultGrainIds: ['semantic:grain:scalar'],
    aggregation: 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: [],
    timeDimensions: [{
      dimensionId: 'semantic:dimension:order_month',
      role: 'event_time',
      supportedGrains: ['day', 'month', 'year'],
      defaultFor: ['scalar', 'trend'],
    }],
    operations: ['filter', 'group', 'trend'],
    supportedOutputKinds: ['metric_value'],
    executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
    sourceFingerprint: `sha256:${metricId}`,
  };
}

const revenue: AgentEvidenceCandidate = {
  id: 'semantic:metric:orders.revenue',
  qualifiedId: 'semantic:metric:orders.revenue',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'orders.revenue',
  aliases: ['revenue'],
  relevanceScore: 1,
  matchReasons: ['exact canonical metric identifier'],
  compatibility: 'compatible',
  exactMatch: true,
  analyticalCapability: semanticCapability('semantic:metric:orders.revenue'),
};

function semanticDecision(): IntentDecision {
  return {
    action: 'answer',
    confidence: 1,
    followsUp: false,
    source: 'heuristic',
    reason: 'Compiler broker selected the semantic compiler.',
    analyticalCascadeDecision: {
      version: 1,
      requirements: {
        version: 1,
        measures: ['orders revenue'],
        dimensions: [],
        entityTerms: [],
        entityDisplayTerms: [],
        memberTerms: [],
      },
      sourceCoverage: [{ version: 1, source: 'semantic', status: 'available', candidateIds: [revenue.id] }],
      attempts: [
        { version: 1, tier: 'certified', outcome: 'unavailable', candidateIds: [], reason: 'No certified match.', planFrozen: false },
        { version: 1, tier: 'semantic', outcome: 'executable', candidateIds: [revenue.id], reason: 'MetricFlow can compile the tuple.', planFrozen: true },
      ],
      selectedTier: 'semantic',
      planFrozen: true,
      stopReason: 'selected',
    },
    resolvedAnalyticalPlan: {
      mode: 'authoritative',
      capability: 'semantic_execution',
      planId: 'rap:semantic',
      fingerprint: 'sha256:semantic',
      snapshotId: 'snapshot:one',
    } as IntentDecision['resolvedAnalyticalPlan'],
  };
}

describe('AskAnalystRuntimeV1', () => {
  it('AGT-035 binds an exact compatible MetricFlow identifier set with zero meaning calls', async () => {
    const amount: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:acm_eu_ingest_split_amt',
      qualifiedId: 'semantic:metric:acm_eu_ingest_split_amt',
      name: 'acm_eu_ingest_split_amt',
      semanticModel: 'acm_ingest',
      analyticalCapability: semanticCapability('semantic:metric:acm_eu_ingest_split_amt'),
    };
    const quantity: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:acm_eu_ingest_split_qty',
      qualifiedId: 'semantic:metric:acm_eu_ingest_split_qty',
      name: 'acm_eu_ingest_split_qty',
      semanticModel: 'acm_ingest',
      analyticalCapability: semanticCapability('semantic:metric:acm_eu_ingest_split_qty'),
    };
    const resolveMeaning = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot:acm',
        candidates: [amount, quantity],
        parsedIntent: { measures: [], dimensions: [], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'Show acm_eu_ingest_split_amt and acm_eu_ingest_split_qty by month',
      requestedMode: 'ask',
    });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.meaningResolution?.selectedConceptIds).toEqual([amount.id, quantity.id]);
    expect(decision.analyticalCascadeDecision?.selectedTier).toBe('semantic');
    expect(decision.askAnalystDecision?.frozenPlan?.steps).toMatchObject([
      { route: 'semantic_answer', goal: 'Show acm_eu_ingest_split_amt and acm_eu_ingest_split_qty by month' },
    ]);
  });

  it('AGT-035 keeps a catalog-proven customer profile on the exact certified zero-provider path when descriptive attributes do not change its grain', async () => {
    const customerProfile: AgentEvidenceCandidate = {
      id: 'dql:block:customer_profile',
      qualifiedId: 'dql:block:customer_profile',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'customer_profile',
      aliases: ['customer profile'],
      dimensions: ['customer_name', 'customer_type'],
      compatibilityFacts: [
        'grain: one row per customer',
        'output: customer_name',
        'output: customer_type',
        'output: count_lifetime_orders',
        'output: lifetime_spend',
      ],
      relevanceScore: 1,
      matchReasons: ['catalog complete certified fit'],
      compatibility: 'compatible',
      exactMatch: true,
      analyticalFitClass: 'exact',
    };
    const planAnalytical = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical,
      getEvidence: async () => ({
        snapshotId: 'snapshot:customer-profile',
        candidates: [customerProfile],
        parsedIntent: { measures: [], dimensions: ['customer'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'who are the top customers?',
      requestedMode: 'ask',
    });

    expect(planAnalytical).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.meaningResolution?.selectedConceptIds).toEqual([customerProfile.id]);
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'certified',
      planFrozen: true,
      attempts: [expect.objectContaining({ tier: 'certified', outcome: 'executable', planFrozen: true })],
    });
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      mode: 'deterministic_binding',
      plannerCalls: 0,
    });
  });

  it('AGT-035 binds one complete qualified physical relation without a provider when every requested field is proven', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:dim_customers',
      qualifiedId: 'dbt:model:dim_customers',
      kind: 'dbt_model',
      trustTier: 'exploratory',
      name: 'dim_customers',
      aliases: ['customers'],
      relevanceScore: 1,
      matchReasons: ['dbt manifest'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:dim_customers'],
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'dbt:column:dim_customers.customer_name',
      qualifiedId: 'dbt:column:dim_customers.customer_name',
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: 'customer_name',
      aliases: ['customer'],
      relevanceScore: 1,
      matchReasons: ['dbt manifest column'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:dim_customers'],
    };
    const orderCount: AgentEvidenceCandidate = {
      id: 'dbt:column:dim_customers.count_lifetime_orders',
      qualifiedId: 'dbt:column:dim_customers.count_lifetime_orders',
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: 'count_lifetime_orders',
      aliases: ['order count', 'count'],
      relevanceScore: 1,
      matchReasons: ['dbt manifest column'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:dim_customers'],
    };
    const resolveMeaning = vi.fn();
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot:customers',
        candidates: [relation, customerName, orderCount],
        parsedIntent: {
          measures: ['count', 'count for each customer', 'for each customer'],
          dimensions: ['customer'],
          filters: [],
        },
      }),
    });

    const decision = await runtime.decide({ question: 'what is the order count for each customer?', requestedMode: 'ask' });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.meaningResolution?.selectedConceptIds).toEqual(expect.arrayContaining([
      relation.id,
      customerName.id,
      orderCount.id,
    ]));
    expect(decision.meaningResolution?.recommendedRoute).toBe('exploratory');
    expect(decision.askAnalystDecision?.state.workspace.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'provider_meaning',
        status: 'skipped',
        reasonCode: 'deterministic_single_relation_physical_binding',
      }),
    ]));
  });

  it('AGT-035 binds an authored order-count measure through its sole generic MetricFlow metric without a provider', async () => {
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:customers.customer_name',
      qualifiedId: 'semantic:uncategorized:dimension:customers.customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'customers.customer_name',
      aliases: ['customer_name', 'customer', 'customer name'],
      relevanceScore: 0.98,
      matchReasons: ['authored MetricFlow display dimension'],
      compatibility: 'compatible',
    };
    const orderCountMeasure: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:measure:orders.order_count',
      qualifiedId: 'semantic:uncategorized:measure:orders.order_count',
      kind: 'semantic_member',
      semanticObjectType: 'measure',
      trustTier: 'semantic',
      name: 'orders.order_count',
      aliases: ['order_count', 'orders.order_count', 'order count'],
      relevanceScore: 1,
      matchReasons: ['exact authored semantic measure'],
      compatibility: 'compatible',
    };
    const customerOrderNumber: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:orders.customer_order_number',
      qualifiedId: 'semantic:uncategorized:dimension:orders.customer_order_number',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'orders.customer_order_number',
      aliases: ['customer order number', 'customer_order_number'],
      relevanceScore: 0.99,
      matchReasons: ['same MetricFlow capability attribute'],
      compatibility: 'compatible',
    };
    const ordersMetric: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:orders:orders',
      qualifiedId: 'semantic:orders:orders',
      name: 'orders.orders',
      aliases: ['orders', 'Orders', 'orders.orders'],
      definition: 'Count of orders.',
      analyticalCapability: {
        ...semanticCapability('semantic:orders:orders'),
        measureIds: [orderCountMeasure.qualifiedId!],
        dimensions: [{
          dimensionId: customerName.qualifiedId!,
          entityId: 'semantic:entity:customers.customer',
          label: 'Customer Name',
          aliases: ['customer_name', 'customer', 'customer name'],
          supportedRoles: ['group_by', 'display', 'rank_entity', 'filter'],
        }, {
          dimensionId: customerOrderNumber.qualifiedId!,
          entityId: 'semantic:entity:orders.order',
          label: 'Customer Order Number',
          aliases: ['customer_order_number', 'customer order number'],
          supportedRoles: ['group_by', 'display', 'filter'],
        }],
        operations: ['filter', 'group', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension'],
        resultGrainIds: ['semantic:grain:customers.customer'],
      },
    };
    const drinkOrders: AgentEvidenceCandidate = {
      ...ordersMetric,
      id: 'semantic:orders:drink_orders',
      qualifiedId: 'semantic:orders:drink_orders',
      name: 'orders.drink_orders',
      aliases: ['drink_orders', 'Drink Orders'],
      definition: 'Count of orders that contain drink order items.',
    };
    const newCustomerOrders: AgentEvidenceCandidate = {
      ...ordersMetric,
      id: 'semantic:orders:new_customer_orders',
      qualifiedId: 'semantic:orders:new_customer_orders',
      name: 'orders.new_customer_orders',
      aliases: ['new_customer_orders', 'New Customer Orders'],
      definition: 'Count of orders from new customers.',
    };
    const foodOrders: AgentEvidenceCandidate = {
      ...ordersMetric,
      id: 'semantic:orders:food_orders',
      qualifiedId: 'semantic:orders:food_orders',
      name: 'orders.food_orders',
      aliases: ['food_orders', 'Food Orders'],
      definition: 'Count of orders that contain food order items.',
    };
    // Mirror the real retained Jaffle workspace shape: the four related
    // metrics and both customer-looking dimensions live inside the qualified
    // execution closure alongside unrelated context cards. The deterministic
    // binding must freeze only the one generic Orders metric plus the
    // person-readable Customer Name display card.
    const fullWorkspaceContext: AgentEvidenceCandidate[] = Array.from({ length: 25 }, (_, index) => ({
      id: `dbt:model:workspace_context_${index}`,
      qualifiedId: `dbt:model:workspace_context_${index}`,
      kind: 'dbt_model' as const,
      trustTier: 'exploratory' as const,
      name: `workspace_context_${index}`,
      relevanceScore: 0.01,
      matchReasons: ['qualified same-snapshot context'],
      compatibility: 'compatible' as const,
    }));
    const planAnalytical = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical,
      getEvidence: async () => ({
        snapshotId: 'snapshot:order-count',
        candidates: [
          orderCountMeasure,
          newCustomerOrders,
          drinkOrders,
          foodOrders,
          ordersMetric,
          customerName,
          customerOrderNumber,
          ...fullWorkspaceContext,
        ],
        parsedIntent: {
          measures: ['count', 'count for each customer'],
          dimensions: ['customer'],
          filters: [],
        },
      }),
    });

    const decision = await runtime.decide({
      question: 'what is the order count for each customer?',
      requestedMode: 'ask',
    });

    expect(planAnalytical).not.toHaveBeenCalled();
    expect(decision.meaningResolution?.selectedConceptIds).toEqual([ordersMetric.id, customerName.id]);
    expect(decision.meaningResolution?.selectedConceptIds).not.toContain(drinkOrders.id);
    expect(decision.meaningResolution?.selectedConceptIds).not.toContain(newCustomerOrders.id);
    expect(decision.meaningResolution?.selectedConceptIds).not.toContain(foodOrders.id);
    expect(decision.meaningResolution?.selectedConceptIds).not.toContain(customerOrderNumber.id);
    expect(decision.meaningResolution?.recommendedRoute).toBe('semantic');
    // The compiler-facing V2 frame is the important boundary here. The
    // workspace deliberately contains three scoped order metrics and a
    // numeric order attribute, but the singular request may only carry the
    // selected generic Orders measure plus the readable customer display
    // field into MetricFlow capability validation.
    expect(decision.meaningResolution?.analyticalFrame?.metricConceptIds).toEqual([ordersMetric.id]);
    expect(decision.askAnalystDecision?.state.program?.candidateIds).toEqual([ordersMetric.id, customerName.id]);
    expect(decision.askAnalystDecision?.state.program?.executionCandidateIds).toEqual(expect.arrayContaining([
      ordersMetric.id,
      drinkOrders.id,
      newCustomerOrders.id,
      foodOrders.id,
      customerOrderNumber.id,
    ]));
    expect(decision.askAnalystDecision?.state.workspace.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'provider_meaning',
        status: 'skipped',
        reasonCode: 'deterministic_semantic_binding',
      }),
    ]));
  });

  it('AGT-011 clarifies a generic top-names semantic binding before planner or compiler execution', async () => {
    const accountName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:account_revenue.account_name',
      qualifiedId: 'semantic:uncategorized:dimension:account_revenue.account_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'account_revenue.account_name',
      aliases: ['account_name', 'account', 'account name'],
      relevanceScore: 0.98,
      matchReasons: ['MetricFlow rank entity'],
      compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:account_revenue.customer_name',
      qualifiedId: 'semantic:uncategorized:dimension:account_revenue.customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'account_revenue.customer_name',
      aliases: ['customer_name', 'customer', 'customer name'],
      relevanceScore: 0.97,
      matchReasons: ['MetricFlow rank entity'],
      compatibility: 'compatible',
    };
    const revenueWithNames: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:account_revenue.revenue',
      qualifiedId: 'semantic:metric:account_revenue.revenue',
      name: 'account_revenue.revenue',
      analyticalCapability: {
        ...semanticCapability('semantic:metric:account_revenue.revenue'),
        operations: ['group', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension', 'rank'],
        dimensions: [
          {
            dimensionId: accountName.id,
            entityId: 'semantic:entity:account_revenue.account',
            label: 'Account Name',
            aliases: ['account_name', 'account', 'account name'],
            supportedRoles: ['group_by', 'rank_entity'],
          },
          {
            dimensionId: customerName.id,
            entityId: 'semantic:entity:account_revenue.customer',
            label: 'Customer Name',
            aliases: ['customer_name', 'customer', 'customer name'],
            supportedRoles: ['group_by', 'rank_entity'],
          },
        ],
      },
    };
    const planAnalytical = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical,
      getEvidence: async () => ({
        snapshotId: 'snapshot:display-key-ambiguity',
        sourceFingerprint: 'sha256:display-key-ambiguity',
        continuityFingerprint: 'sha256:display-key-continuity',
        candidates: [revenueWithNames, accountName, customerName],
        parsedIntent: { measures: ['revenue'], dimensions: ['names'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'Show the top names by revenue',
      requestedMode: 'ask',
    });

    expect(planAnalytical).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      retrievalEvidence: {
        snapshotId: 'snapshot:display-key-ambiguity',
        continuityFingerprint: 'sha256:display-key-continuity',
      },
      askAnalystDecision: {
        state: {
          phase: 'clarify',
          planningReceipt: {
            mode: 'deterministic_binding',
            plannerCalls: 0,
            verification: { reasonCode: 'deterministic_display_key_ambiguity' },
          },
        },
      },
    });
    expect(decision.clarificationOptions).toEqual([
      expect.objectContaining({ id: accountName.id, label: 'Account Name' }),
      expect.objectContaining({ id: customerName.id, label: 'Customer Name' }),
    ]);
  });

  it('AGT-035 accepts the local index registry aliases for an exact semantic order-count/customer tuple', async () => {
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:jaffle_shop:dimension:customer_name',
      qualifiedId: 'semantic:jaffle_shop:dimension:customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'customers.customer_name',
      aliases: [
        'customer_name',
        'customers.customer_name',
        'semantic:jaffle_shop:dimension:customer_name',
      ],
      relevanceScore: 0.98,
      matchReasons: ['authored MetricFlow display dimension'],
      compatibility: 'compatible',
    };
    const orderCount: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:jaffle_shop:order_count',
      qualifiedId: 'semantic:jaffle_shop:order_count',
      name: 'customers.order_count',
      aliases: ['order_count', 'Order count', 'customers.order_count'],
      definition: 'Number of orders placed.',
      analyticalCapability: {
        ...semanticCapability('semantic:jaffle_shop:order_count'),
        measureIds: ['semantic:jaffle_shop:measure:customers.count_lifetime_orders'],
        primaryEntityId: 'semantic:jaffle_shop:entity:customers.customer',
        defaultResultGrainId: 'semantic:jaffle_shop:entity:customers.customer',
        resultGrainIds: ['semantic:jaffle_shop:entity:customers.customer'],
        dimensions: [{
          dimensionId: 'semantic:jaffle_shop:dimension:customers.customer_name',
          entityId: 'semantic:jaffle_shop:entity:customers.customer',
          label: 'customer_name',
          aliases: customerName.aliases,
          supportedRoles: ['group_by', 'display', 'rank_entity', 'filter'],
        }],
        operations: ['filter', 'group', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension'],
      },
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: vi.fn(),
      getEvidence: async () => ({
        snapshotId: 'snapshot:registry-order-count',
        candidates: [orderCount, customerName],
        parsedIntent: { measures: ['order count'], dimensions: ['customer'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'what is the order count for each customer?',
      requestedMode: 'ask',
    });

    expect(decision.meaningResolution?.selectedConceptIds).toEqual(expect.arrayContaining([
      orderCount.id,
      customerName.id,
    ]));
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      mode: 'deterministic_binding',
      plannerCalls: 0,
    });
  });

  it('owns the question frame, one snapshot, route-neutral program, and compiler selection', async () => {
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:one',
      sourceFingerprint: 'sha256:snapshot-one',
      candidates: [revenue],
      parsedIntent: { measures: ['orders revenue'], dimensions: [], filters: [] },
    };
    const getEvidence = vi.fn(async () => evidence);
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({ getEvidence, compilerBroker });

    const decision = await runtime.decide({ question: 'Show semantic:metric:orders.revenue' });

    expect(runtime.mode).toBe('authoritative');
    expect(getEvidence).toHaveBeenCalledTimes(1);
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.askAnalystDecision?.state.program.candidateIds).toEqual([revenue.id]);
    expect(decision.askAnalystDecision?.state.program.requiredRoles).toContain('metric');
    expect(decision.askAnalystDecision?.state.phase).toBe('compiled');
    expect(decision.askAnalystDecision?.resolvedPlan).toMatchObject({ compiler: 'metricflow', planFrozen: true });
  });

  it('does not treat a client-provided selectedEvidenceId as a structured continuation authority', async () => {
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const resolveMeaning = vi.fn(async () => ({
      interpretedQuestion: 'top customers by revenue',
      questionType: 'ranking' as const,
      selectedConceptIds: [revenue.id],
      recommendedExecutionId: revenue.id,
      queryIntent: { measures: ['revenue'], dimensions: [], filters: [], limit: 10, order: 'desc' as const },
      rejectedCandidates: [],
      confidence: 'high' as const,
      missingInformation: [],
      recommendedRoute: 'semantic' as const,
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      resolveMeaning,
      getEvidence: async () => ({ candidates: [revenue], parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] } }),
    });

    const decision = await runtime.decide({
      question: 'top customers by revenue',
      selectedEvidenceId: revenue.id,
      conversationBinding: 'structured_clarification',
    });

    const state = decision.askAnalystDecision?.state;
    // A client-provided ID is not a zero-call continuation authority.
    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(state?.frame.defaultedTop).toEqual({ limit: 10 });
    expect(state?.frame.conversation.binding).toBe('none');
    expect(state?.conversationDelta.selectedStableId).toBeUndefined();
    expect(state?.mission.taskLimit).toBe(3);
    expect(state?.toolCalls).toBeLessThanOrEqual(12);
  });

  it('does not reuse a server-issued clarification selection after its semantic snapshot changes', async () => {
    const accountName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:accounts.account_name',
      qualifiedId: 'semantic:dimension:accounts.account_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'account_name',
      aliases: ['account', 'account name'],
      relevanceScore: 1,
      matchReasons: ['server-issued display option'],
      compatibility: 'compatible',
    };
    const revenueWithAccount: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        dimensions: [{
          dimensionId: accountName.id,
          entityId: 'semantic:entity:account',
          label: 'Account Name',
          aliases: ['account', 'account name'],
          supportedRoles: ['group_by', 'rank_entity'],
        }],
      },
    };
    const resolveMeaning = vi.fn(async () => ({
      interpretedQuestion: 'top accounts by revenue',
      questionType: 'ranking' as const,
      selectedConceptIds: [revenueWithAccount.id, accountName.id],
      recommendedExecutionId: revenueWithAccount.id,
      queryIntent: { measures: ['revenue'], dimensions: ['account'], filters: [], limit: 10, order: 'desc' as const },
      rejectedCandidates: [],
      confidence: 'high' as const,
      missingInformation: [],
      recommendedRoute: 'semantic' as const,
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot:current',
        candidates: [revenueWithAccount, accountName],
        parsedIntent: { measures: ['revenue'], dimensions: ['account'], filters: [] },
      }),
    });

    await runtime.decide({
      question: 'top accounts by revenue',
      requestedMode: 'ask',
      threadId: 'thread:accounts',
      selectedEvidenceId: accountName.id,
      clarificationSourceQuestion: 'top accounts by revenue',
      conversationContext: {
        conversationEnvelope: {
          threadId: 'thread:accounts',
          pendingClarification: {
            sourceTurnId: 'turn:old',
            selection: { snapshotId: 'snapshot:old', optionIds: [accountName.id] },
          },
        },
        serverIssuedClarificationSelection: {
          version: 1,
          threadId: 'thread:accounts',
          sourceTurnId: 'turn:old',
          snapshotId: 'snapshot:old',
        },
      },
    });

    // The stale selection was rejected; the complete current snapshot can
    // still take the new exact semantic fast path without replaying that
    // client/server selection authority.
    expect(resolveMeaning).not.toHaveBeenCalled();
  });

  it('does not let a different native-ready semantic metric authorize a selected external-only metric', async () => {
    const nativeAlternative: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:orders.native_revenue',
      qualifiedId: 'semantic:metric:orders.native_revenue',
      name: 'orders.native_revenue',
      analyticalCapability: semanticCapability('semantic:metric:orders.native_revenue'),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      getEvidence: async () => ({
        snapshotId: 'snapshot:selected-readiness',
        candidates: [revenue, nativeAlternative],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
        diagnostics: {
          tierReadiness: {
            semanticCompiler: 'ready',
            physicalSchema: 'unavailable',
            semanticCandidateReadiness: [
              { candidateId: revenue.id, status: 'unavailable' },
              { candidateId: nativeAlternative.id, status: 'ready' },
            ],
          },
        },
      }),
    });

    const decision = await runtime.decide({ question: 'Show semantic:metric:orders.revenue', requestedMode: 'ask' });
    const semanticAttempt = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'semantic');
    // Source metadata can be available while this selected metric's compiler
    // is not. The tier receipt must preserve that operational distinction.
    expect(semanticAttempt).toMatchObject({ outcome: 'unavailable', planFrozen: false });
    expect(decision.analyticalCascadeDecision?.planFrozen).toBe(false);
    expect(decision.reason).toContain('semantic compiler or active target was unavailable before plan freeze');
  });

  it('uses the broker once in shadow mode and never starts a second execution path', async () => {
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      mode: 'shadow',
      compilerBroker,
      getEvidence: async () => ({ candidates: [revenue] }),
    });

    const decision = await runtime.decide({ question: 'Show orders.revenue' });

    expect(compilerBroker.decide).toHaveBeenCalledTimes(1);
    expect(decision.askAnalystDecision?.mode).toBe('shadow');
    expect(decision.askAnalystDecision?.state.executionAttempts).toBe(0);
  });

  it('AGT-036 freezes a 32-item execution closure and excludes a lower-ranked same-snapshot tail candidate', async () => {
    const physical = Array.from({ length: 33 }, (_, index): AgentEvidenceCandidate => ({
      id: `runtime:column:orders.tail_${index}`,
      qualifiedId: `runtime:column:orders.tail_${index}`,
      kind: 'sql_column',
      trustTier: 'generated',
      name: `tail_${index}`,
      relevanceScore: 100 - index,
      matchReasons: ['runtime schema'],
      compatibility: 'compatible',
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      getEvidence: async () => ({ candidates: [revenue, ...physical], parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] } }),
    });

    const decision = await runtime.decide({ question: 'Show semantic:metric:orders.revenue' });
    const closure = decision.askAnalystDecision?.state.program.executionCandidateIds ?? [];
    expect(closure).toHaveLength(32);
    expect(closure).not.toContain('runtime:column:orders.tail_32');
    expect(decision.askAnalystDecision?.state.workspace.excludedCandidates.some((candidate) => candidate.id === 'runtime:column:orders.tail_32')).toBe(true);
  });

  it('AGT-041 deterministically binds customer/product revenue from one role-balanced snapshot without a provider', async () => {
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'Customer Name', aliases: ['customer', 'customer name'],
      relevanceScore: 0.18, matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const productDescription: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.product_description', qualifiedId: 'semantic:dimension:products.product_description',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'Product Description', aliases: ['product', 'product description'],
      relevanceScore: 0.16, matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const revenueByProduct: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:customers.customer',
        defaultResultGrainId: 'semantic:entity:customers.customer',
        resultGrainIds: ['semantic:entity:customers.customer'],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        dimensions: [
          { dimensionId: customerName.id, entityId: 'semantic:entity:customers.customer', label: 'Customer Name', aliases: ['customer', 'customer name'], supportedRoles: ['group_by', 'rank_entity'] },
          {
            dimensionId: productDescription.id,
            entityId: 'semantic:entity:products.product',
            label: 'Product Description',
            aliases: ['product', 'product description'],
            supportedRoles: ['group_by'],
            nativeGroupingReference: 'product__product_description',
            nativeGroupingPath: ['product'],
          },
        ],
      },
    };
    const physical = ['customers', 'orders', 'order_items', 'products'].map((name, index): AgentEvidenceCandidate => ({
      id: `dbt:model:${name}`, qualifiedId: `dbt:model:${name}`, kind: 'dbt_model', trustTier: 'exploratory', name,
      relevanceScore: 0.1 - index / 100, matchReasons: ['dbt manifest'], compatibility: 'compatible',
      sourceObjects: [`runtime:relation:${name}`],
    }));
    const relationship: AgentEvidenceCandidate = {
      id: 'dql:relationship:customer_order_item_product', qualifiedId: 'dql:relationship:customer_order_item_product',
      kind: 'dql_modeling', trustTier: 'governed', name: 'customer order item product relationship',
      relevanceScore: 0.12, matchReasons: ['governed relationship'], compatibility: 'compatible',
      relationshipEvidence: ['dql:relationship:customer_order_item_product'],
    };
    const resolveMeaning = vi.fn();
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot:customer-product',
        candidates: [
          revenueByProduct,
          ...Array.from({ length: 20 }, (_, index): AgentEvidenceCandidate => ({
            id: `semantic:metric:noise_${index}`, kind: 'semantic_metric', trustTier: 'semantic', name: `Gross Amount ${index}`,
            relevanceScore: 0.99 - index / 100, matchReasons: ['correlated metric'], compatibility: 'compatible',
          })),
          { id: 'semantic:entity:customers.customer', kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic', name: 'Customer', relevanceScore: 0.2, matchReasons: ['entity'], compatibility: 'compatible' },
          customerName, productDescription, relationship, ...physical,
        ],
        parsedIntent: { measures: ['revenue'], dimensions: ['customer', 'product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'who are the top customers have product with revenue', requestedMode: 'ask' });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.analyticalCascadeDecision?.planFrozen).toBe(true);
    expect(decision.analyticalCascadeDecision?.selectedTier).toBe('semantic');
    expect(decision.askAnalystDecision?.state.program.executionCandidateIds).toEqual(expect.arrayContaining([
      revenueByProduct.id,
      customerName.id,
      productDescription.id,
      'dbt:model:customers',
      'dbt:model:orders',
      'dbt:model:order_items',
      'dbt:model:products',
    ]));
    expect(decision.askAnalystDecision?.state.workspace.admittedCandidateIds).toContain(productDescription.id);
    expect(decision.askAnalystDecision?.state.workspace.workspaceCandidateIds?.length).toBeLessThanOrEqual(32);
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds?.length).toBeLessThanOrEqual(16);
  });

  it('AGT-041 runs the ordinary customer/product/revenue Ask through one typed planner call when the snapshot is not uniquely complete', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer_id', kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer ID', aliases: ['customer key', 'customer id'], relevanceScore: 0.75, matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.7, matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const productName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.product_name', kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Product Name', aliases: ['product', 'product name'], relevanceScore: 0.6, matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const relationship: AgentEvidenceCandidate = {
      id: 'dql:relationship:customer_order_item_product', kind: 'dql_modeling', trustTier: 'governed',
      name: 'customer order item product relationship', relevanceScore: 0.5, matchReasons: ['governed relationship'], compatibility: 'compatible',
      relationshipEvidence: ['dql:relationship:customer_order_item_product'],
    };
    const planner = vi.fn(async (input: { plannerRequest: { candidates: Array<{ id: string; roles: string[] }>; planningMode: string } }) => {
      expect(input.plannerRequest.planningMode).toBe('initial_planner');
      expect(input.plannerRequest.candidates).toHaveLength(5);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('metric'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('entity_key'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('entity_label'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('categorical_dimension'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('relationship'))).toBe(true);
      return {
        version: 1 as const,
        selectedConceptIds: [revenue.id, customerKey.id, customerName.id, productName.id, relationship.id],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id, customerKey.id, customerName.id, productName.id, relationship.id],
          roleBindings: {
            metric: [revenue.id],
            entity_key: [customerKey.id],
            entity_label: [customerName.id],
            categorical_dimension: [productName.id],
            relationship: [relationship.id],
          },
          operations: ['aggregate', 'rank', 'group', 'project'] as const,
        }],
      };
    });
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:ordinary-planner',
        candidates: [revenue, customerKey, customerName, productName, relationship],
        parsedIntent: { measures: ['revenue'], dimensions: ['customer', 'product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'who are the top customers have product with revenue', requestedMode: 'ask' });

    expect(planner).toHaveBeenCalledTimes(1);
    // This deliberately small metadata fixture proves planner packaging only;
    // it has no physical closure capable of executing the customer/product
    // relationship.  The planner receipt still survives the truthful
    // pre-freeze gap rather than being misreported as a connection failure.
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      mode: 'initial_planner',
      plannerCalls: 1,
      revisionCalls: 0,
    });
    expect(decision.reason).not.toMatch(/connection|sql execute/i);
    expect(decision.askAnalystDecision?.state).toMatchObject({
      version: 2,
      planningMode: 'initial_planner',
      program: { version: 2 },
    });
    expect(decision.askAnalystDecision?.state.workspace.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'provider_meaning', reasonCode: 'planning.initial.completed' }),
    ]));
  });

  it('AGT-041 builds compiler requirements from verified planner role bindings instead of a wrong deterministic seed', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer_id', kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer ID', aliases: ['customer key'], relevanceScore: 0.8, matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer display'], relevanceScore: 0.7, matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const region: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.region', kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Region', aliases: ['territory'], relevanceScore: 0.6, matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    let plannerCardIds: string[] = [];
    let plannerFrameRequirements: { measures: string[]; dimensions: string[]; entityDisplayTerms: string[] } | undefined;
    const planner = vi.fn(async (input: { plannerRequest: {
      candidates: Array<{ id: string }>;
      frame: { requirements: { measures: string[]; dimensions: string[]; entityDisplayTerms: string[] } };
    } }) => {
      plannerCardIds = input.plannerRequest.candidates.map((candidate) => candidate.id);
      plannerFrameRequirements = input.plannerRequest.frame.requirements;
      return {
      version: 1 as const,
      selectedConceptIds: [revenue.id, customerKey.id, customerName.id, region.id],
      tasks: [{
        version: 1 as const,
        taskId: 'task-1',
        selectedConceptIds: [revenue.id, customerKey.id, customerName.id, region.id],
        roleBindings: {
          metric: [revenue.id],
          entity_key: [customerKey.id],
          entity_label: [customerName.id],
          categorical_dimension: [region.id],
        },
        operations: ['aggregate', 'rank', 'group', 'project'] as const,
      }],
      };
    });
    const plannerRevenue: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: customerKey.id,
        // The corrected business request is a ranked customer/region
        // breakdown. Give this fixture the corresponding authored semantic
        // capability so the test reaches the real compiler boundary rather
        // than stopping on an unrelated adapter capability gap.
        operations: ['filter', 'group', 'trend', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension', 'rank'],
        dimensions: [
          { dimensionId: customerKey.id, entityId: customerKey.id, label: 'Customer ID', aliases: ['customer key'], supportedRoles: ['group_by', 'rank_entity'] },
          { dimensionId: customerName.id, entityId: customerKey.id, label: 'Customer Name', aliases: ['customer display'], supportedRoles: ['group_by', 'rank_entity'] },
          { dimensionId: region.id, entityId: customerKey.id, label: 'Region', aliases: ['territory'], supportedRoles: ['group_by'] },
        ],
      },
    };
    const competingRevenue: AgentEvidenceCandidate = {
      ...plannerRevenue,
      id: 'semantic:metric:orders.gross_revenue',
      qualifiedId: 'semantic:metric:orders.gross_revenue',
      name: 'orders.gross_revenue',
      aliases: ['revenue'],
      exactMatch: false,
      relevanceScore: 0.72,
      analyticalCapability: semanticCapability('semantic:metric:orders.gross_revenue'),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:planner-correction',
        candidates: [plannerRevenue, competingRevenue, customerKey, customerName, region],
        parsedIntent: { measures: ['legacy spend'], dimensions: ['owner email'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      // This is the real ordinary Ask path: retrieval reports stale parser
      // hints, but no host-only seed is injected. The planner receives an
      // advisory frame and corrects it with qualified Revenue/Customer/Region
      // cards from its 16-card package.
      question: 'show the top revenue by customer and region',
      requestedMode: 'ask',
    });

    const state = decision.askAnalystDecision?.state;
    expect(planner).toHaveBeenCalledTimes(1);
    expect(plannerFrameRequirements).toMatchObject({
      measures: ['revenue'],
      entityDisplayTerms: ['customer name'],
    });
    expect(plannerFrameRequirements?.dimensions).not.toContain('owner email');
    expect(plannerFrameRequirements?.measures).not.toContain('legacy spend');
    expect(plannerCardIds).toEqual(expect.arrayContaining([
      revenue.id,
      customerKey.id,
      customerName.id,
      region.id,
    ]));
    // The planner can only select from the role-balanced, 16-card package.
    // The larger 32-card workspace is compiler-only closure and must never
    // become a second, unbounded planner authority.
    expect(plannerCardIds.length).toBeLessThanOrEqual(16);
    const plannerSelectedIds = [revenue.id, customerKey.id, customerName.id, region.id];
    expect(plannerSelectedIds.every((id) => plannerCardIds.includes(id))).toBe(true);
    expect(decision.askAnalystDecision?.taskExecutions).toBeDefined();
    expect(state?.frame.requirements).toMatchObject({
      measures: ['orders.revenue'],
      entityTerms: ['Customer ID'],
      entityDisplayTerms: ['Customer Name'],
      dimensions: expect.arrayContaining(['Region', 'Customer Name']),
      ranking: { metricTerms: ['orders.revenue'], entityTerms: ['Customer ID'] },
    });
    // The compiler bridge receives this re-bound host seed, rather than the
    // original legacy-spend/owner-email parser tuple.
    expect(decision.askAnalystDecision?.taskExecutions?.[0]?.meaningResolution.queryIntent).toMatchObject({
      measures: ['orders.revenue'],
      dimensions: expect.arrayContaining(['Region', 'Customer Name']),
    });
    expect(decision.meaningResolution?.queryIntent).toMatchObject({
      measures: ['orders.revenue'],
      dimensions: expect.arrayContaining(['Region', 'Customer Name']),
    });
    expect(state?.program.outputs).toMatchObject({
      measures: ['orders.revenue'],
      entityDisplayTerms: ['Customer Name'],
      dimensions: expect.arrayContaining(['Region', 'Customer Name']),
    });
    expect(state?.program.ranking?.metricTerms).toEqual(['orders.revenue']);
  });

  it('AGT-041 rejects an unsafe planner role correction before compiler selection', async () => {
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: [revenue.id],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id],
          // A metric cannot be used as an entity display key merely because a
          // planner says so; local role proof remains the hard boundary.
          roleBindings: { entity_label: [revenue.id] },
          operations: ['aggregate', 'project'],
        }],
      }),
      getEvidence: async () => ({ candidates: [revenue], parsedIntent: { measures: [], dimensions: [], filters: [] } }),
    });

    const decision = await runtime.decide({ question: 'show the business breakdown', requestedMode: 'ask' });
    expect(decision.askAnalystDecision?.state.phase).toBe('blocked');
    expect(compilerBroker.decide).not.toHaveBeenCalled();
  });

  it('AGT-044 preserves explicit filter, time, and ranking constraints while the planner binds their qualified cards', async () => {
    const tupleRevenue: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        operations: ['filter', 'group', 'trend', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension', 'rank'],
        dimensions: [
          {
            dimensionId: 'semantic:dimension:customers.customer_name',
            entityId: 'semantic:entity:order',
            label: 'Customer Name', aliases: ['customer', 'customer name'], supportedRoles: ['group_by', 'rank_by'],
          },
          {
            dimensionId: 'semantic:dimension:orders.region',
            entityId: 'semantic:entity:order',
            label: 'Region', aliases: ['region'], supportedRoles: ['group_by', 'filter'],
          },
        ],
      },
    };
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer_id', qualifiedId: 'semantic:entity:customers.customer_id',
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer ID', aliases: ['customer', 'customer id'], relevanceScore: 0.95,
      matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.94,
      matchReasons: ['semantic display'], compatibility: 'compatible',
    };
    const region: AgentEvidenceCandidate = {
      id: 'semantic:dimension:orders.region', qualifiedId: 'semantic:dimension:orders.region',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Region', aliases: ['region'], relevanceScore: 0.93,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const west: AgentEvidenceCandidate = {
      id: 'semantic:member:orders.region.west', qualifiedId: 'semantic:member:orders.region.west',
      kind: 'semantic_member', semanticObjectType: 'member', trustTier: 'semantic',
      name: 'West', aliases: ['west'], relevanceScore: 0.92,
      matchReasons: ['semantic member'], compatibility: 'compatible',
    };
    const relationship: AgentEvidenceCandidate = {
      id: 'modeling:relationship:customers_orders', qualifiedId: 'modeling:relationship:customers_orders',
      kind: 'dql_modeling', trustTier: 'governed', name: 'Customers to orders relationship',
      aliases: ['customer orders relationship'], relevanceScore: 0.9,
      matchReasons: ['governed relationship'], compatibility: 'compatible',
      relationshipEvidence: ['relationship:customers_orders'],
    };
    const planner = vi.fn(async () => ({
      version: 1 as const,
      selectedConceptIds: [tupleRevenue.id, customerKey.id, customerName.id, region.id, west.id, relationship.id],
      tasks: [{
        version: 1 as const,
        taskId: 'task-1',
        selectedConceptIds: [tupleRevenue.id, customerKey.id, customerName.id, region.id, west.id, relationship.id],
        roleBindings: {
          metric: [tupleRevenue.id],
          entity_key: [customerKey.id],
          entity_label: [customerName.id],
          categorical_dimension: [region.id],
          member: [west.id],
          // A semantic metric may bind an authored time child; it does not
          // authorize a time field outside the same snapshot.
          time_dimension: [tupleRevenue.id],
          relationship: [relationship.id],
        },
        operations: ['aggregate', 'filter', 'group', 'trend', 'rank', 'project'] as const,
      }],
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:explicit-tuple',
        candidates: [tupleRevenue, customerKey, customerName, region, west, relationship],
        parsedIntent: {
          measures: ['revenue'],
          dimensions: ['customer', 'region'],
          filters: [{ field: 'region', value: 'West' }],
        },
      }),
    });

    const decision = await runtime.decide({
      question: 'show top 5 revenue by customer and region for West by month',
      requestedMode: 'ask',
    });

    expect(planner).toHaveBeenCalledTimes(1);
    // The fixture deliberately omits the semantic member binding metadata
    // required by the production MetricFlow compiler, so this asserts the
    // stronger hand-off invariant rather than a fabricated successful query:
    // the frozen compiler seed retains every literal constraint unchanged.
    const compilerSeed = decision.meaningResolution?.hostRequirementSeed;
    expect(compilerSeed?.queryIntent).toMatchObject({
      filters: [{ field: 'region', value: 'West' }],
      timeGrain: 'month',
      order: 'desc',
      limit: 5,
    });
    expect(compilerSeed?.requirements.ranking).toMatchObject({
      metricTerms: ['orders.revenue'], direction: 'top', limit: 5, defaultedLimit: false,
    });
    expect(compilerSeed?.requirements.memberTerms).toEqual(['west']);
    expect(decision.meaningResolution?.queryIntent.filters).toEqual([{ field: 'region', value: 'West' }]);
    expect(decision.askAnalystDecision?.state.program).toMatchObject({
      filters: [{ fieldTerms: ['region'], value: 'West', operator: 'equals' }],
      ranking: { metricTerms: ['orders.revenue'], direction: 'desc', limit: 5 },
      time: { grain: 'month' },
    });
  });

  it('AGT-042 permits exactly one planner revision after a role-targeted same-snapshot extension', async () => {
    const productDimensions = ['one', 'two', 'three'].map((suffix, index): AgentEvidenceCandidate => ({
      id: `semantic:dimension:products.product_${suffix}`,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: `Product ${suffix}`,
      aliases: ['product'],
      relevanceScore: 0.8 - index / 100,
      matchReasons: ['semantic dimension'],
      compatibility: 'compatible',
    }));
    const target = productDimensions[2]!;
    const planner = vi.fn(async (input: { plannerRequest: {
      planningMode: string;
      candidates: Array<{ id: string }>;
      targetedCandidates?: Array<{ id: string }>;
      priorProposal?: { selectedConceptIds: string[]; tasks: Array<{ roleBindings: Record<string, string[]> }> };
      priorSelectedConceptIds?: string[];
      verificationFeedback?: { missingRoles: string[]; reasonCode: string };
    } }) => {
      if (input.plannerRequest.planningMode === 'initial_planner') {
        // The initial planner sees only the 16-card package and may not
        // smuggle a hidden workspace identity into selectedConceptIds.
        expect(input.plannerRequest.candidates.map((candidate) => candidate.id)).not.toContain(target.id);
        return {
          version: 1 as const,
          // The initial planner may choose only the visible 16-card package.
          // It leaves the product role unbound and asks by business term; the
          // verifier, not provider output, locates card 17 in the immutable
          // workspace before granting the one revision.
          selectedConceptIds: [revenue.id],
          confidence: 'high' as const,
          tasks: [{
            version: 1 as const,
            taskId: 'task-1',
            selectedConceptIds: [revenue.id],
            roleBindings: { metric: [revenue.id] },
            operations: ['aggregate', 'group'] as const,
          }],
          recovery: {
            version: 1 as const,
            missingRoles: ['categorical_dimension'] as const,
            searchTerms: ['product three'],
            relatedCandidateIds: [revenue.id],
          },
        };
      }
      // A revision is not a second broad 16-card planner pass. It receives
      // only the <=4 verifier-admitted target cards plus immutable selected
      // context/feedback from the initial proposal.
      expect(input.plannerRequest.candidates.map((candidate) => candidate.id)).toEqual([target.id]);
      expect(input.plannerRequest.targetedCandidates?.map((candidate) => candidate.id)).toEqual([target.id]);
      expect(input.plannerRequest.priorSelectedConceptIds).toEqual([revenue.id]);
      expect(input.plannerRequest.priorProposal?.selectedConceptIds).toEqual([revenue.id]);
      expect(input.plannerRequest.priorProposal?.tasks[0]?.roleBindings.metric).toEqual([revenue.id]);
      expect(input.plannerRequest.verificationFeedback).toMatchObject({
        missingRoles: ['categorical_dimension'],
        reasonCode: 'verifier_role_targeted_extension_admitted',
      });
      return {
        version: 1 as const,
        selectedConceptIds: [revenue.id, target.id],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id, target.id],
          roleBindings: { metric: [revenue.id], categorical_dimension: [target.id] },
          operations: ['aggregate', 'group'] as const,
        }],
      };
    });
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:targeted-revision',
        candidates: [revenue, ...productDimensions, ...Array.from({ length: 14 }, (_, index): AgentEvidenceCandidate => ({
          id: `semantic:metric:noise_${index}`, kind: 'semantic_metric', trustTier: 'semantic', name: `Noise ${index}`,
          relevanceScore: 0.99 - index / 1000, matchReasons: ['noise'], compatibility: 'compatible',
        }))],
        parsedIntent: { measures: ['revenue'], dimensions: ['product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product', requestedMode: 'ask' });

    expect(planner).toHaveBeenCalledTimes(2);
    expect(planner.mock.calls.map(([input]) => input.plannerRequest.planningMode)).toEqual(['initial_planner', 'targeted_revision']);
    // Targeted cards are deliberately not retroactively inserted into the
    // immutable initial 16-card planner package. Their separate receipt is
    // the authority for the one revision addition.
    expect(decision.askAnalystDecision?.state.workspace.admittedCandidateIds).not.toContain(target.id);
    expect(decision.askAnalystDecision?.state.workspace.targetedContext?.candidateIds).toEqual([target.id]);
    expect(decision.askAnalystDecision?.state.workspace.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'candidate_extension', candidateIds: [target.id] }),
    ]));
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds).toHaveLength(16);
  });

  it('AGT-042 retains a full initial package while a #17 target is added for one constrained revision', async () => {
    const productDimensions = ['one', 'two', 'three'].map((suffix, index): AgentEvidenceCandidate => ({
      id: `semantic:dimension:products.product_${suffix}`,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: `Product ${suffix}`,
      aliases: ['product'],
      relevanceScore: 0.8 - index / 100,
      matchReasons: ['semantic dimension'],
      compatibility: 'compatible',
    }));
    const target = productDimensions[2]!;
    const filler = Array.from({ length: 14 }, (_, index): AgentEvidenceCandidate => ({
      id: `semantic:metric:filler_${index}`,
      kind: 'semantic_metric',
      trustTier: 'semantic',
      name: `Filler ${index}`,
      aliases: ['filler'],
      relevanceScore: 0.99 - index / 1_000,
      matchReasons: ['metric crowding fixture'],
      compatibility: 'compatible',
    }));
    let initialPackageIds: string[] = [];
    const planner = vi.fn(async (input: { candidates: Array<{ id: string }>; plannerRequest: {
      planningMode: string;
      candidates: Array<{ id: string }>;
      targetedCandidates?: Array<{ id: string }>;
      priorProposal?: { selectedConceptIds: string[]; tasks: Array<{ selectedConceptIds: string[] }> };
      priorSelectedConceptIds?: string[];
    } }) => {
      if (input.plannerRequest.planningMode === 'initial_planner') {
        initialPackageIds = input.plannerRequest.candidates.map((candidate) => candidate.id);
        expect(initialPackageIds).toHaveLength(16);
        expect(initialPackageIds).not.toContain(target.id);
        expect(input.candidates.map((candidate) => candidate.id)).toEqual(initialPackageIds);
        return {
          version: 1 as const,
          selectedConceptIds: initialPackageIds,
          confidence: 'high' as const,
          tasks: [{
            version: 1 as const,
            taskId: 'task-1',
            selectedConceptIds: initialPackageIds,
            roleBindings: { metric: [revenue.id] },
            operations: ['aggregate', 'group'] as const,
          }],
          recovery: {
            version: 1 as const,
            missingRoles: ['categorical_dimension'] as const,
            searchTerms: ['product three'],
            relatedCandidateIds: [revenue.id],
          },
        };
      }
      // A revision is given an immutable record of all original selections,
      // plus the small target addition. It must not receive an evicting 16-card
      // union or a re-ranked broad candidate package.
      expect(input.plannerRequest.candidates.map((candidate) => candidate.id)).toEqual([target.id]);
      expect(input.candidates.map((candidate) => candidate.id)).toEqual([target.id]);
      expect(input.plannerRequest.targetedCandidates?.map((candidate) => candidate.id)).toEqual([target.id]);
      expect(input.plannerRequest.priorSelectedConceptIds).toEqual(initialPackageIds);
      expect(input.plannerRequest.priorProposal?.selectedConceptIds).toEqual(initialPackageIds);
      expect(input.plannerRequest.priorProposal?.tasks[0]?.selectedConceptIds).toEqual(initialPackageIds);
      return {
        version: 1 as const,
        selectedConceptIds: [...initialPackageIds, target.id],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [...initialPackageIds, target.id],
          roleBindings: { metric: [revenue.id], categorical_dimension: [target.id] },
          operations: ['aggregate', 'group'] as const,
        }],
      };
    });
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:full-package-targeted-revision',
        candidates: [revenue, ...productDimensions, ...filler],
        parsedIntent: { measures: ['revenue'], dimensions: ['product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product', requestedMode: 'ask' });

    expect(planner).toHaveBeenCalledTimes(2);
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds).toEqual(initialPackageIds);
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds).not.toContain(target.id);
    expect(decision.askAnalystDecision?.state.workspace.targetedContext?.candidateIds).toEqual([target.id]);
    expect(decision.askAnalystDecision?.state.program.candidateIds).toEqual(expect.arrayContaining([
      ...initialPackageIds,
      target.id,
    ]));
    expect(decision.askAnalystDecision?.state.program.candidateIds).toHaveLength(17);
    // This fixture deliberately has no MetricFlow grouping capability, so its
    // later compiler cascade may return a pre-freeze gap. The regression is
    // about retaining the full authoritative revision tuple before that
    // independent compiler eligibility boundary.
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      mode: 'targeted_revision', plannerCalls: 2, revisionCalls: 1,
    });
  });

  it('AGT-042 blocks an invented planner identity before compiler or execution selection', async () => {
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: ['semantic:dimension:invented.secret'],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: ['semantic:dimension:invented.secret'],
          roleBindings: { categorical_dimension: ['semantic:dimension:invented.secret'] },
          operations: ['aggregate', 'group'],
        }],
      }),
      getEvidence: async () => ({ candidates: [revenue], parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] } }),
    });

    const decision = await runtime.decide({ question: 'show revenue by region', requestedMode: 'ask' });

    expect(decision.terminalOutcome?.code).toBe('ANALYTICAL_POLICY_BLOCKED');
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.reason).not.toMatch(/connection|sql execute/i);
  });

  it('AGT-042 requires explicit business role bindings instead of repopulating them from the execution closure', async () => {
    const product: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.product_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Product Name', aliases: ['product'], relevanceScore: 0.9,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: [revenue.id],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id],
          roleBindings: {},
          operations: ['aggregate', 'group'],
        }],
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot:strict-role-bindings',
        candidates: [revenue, product],
        parsedIntent: { measures: ['revenue'], dimensions: ['product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product', requestedMode: 'ask' });

    expect(decision.askAnalystDecision?.state.phase).toBe('blocked');
    expect(decision.askAnalystDecision?.state.planningReceipt?.verification).toMatchObject({
      reasonCode: 'planner_missing_multiple_required_business_roles',
      missingRoles: expect.arrayContaining(['metric', 'categorical_dimension']),
    });
    expect(compilerBroker.decide).not.toHaveBeenCalled();
  });

  it('AGT-042 treats an unbound second requested dimension as recovery/gap, never as one-role completion', async () => {
    const region: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.region',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Region', aliases: ['region'], relevanceScore: 0.9,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const productCategory: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.product_category',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Product Category', aliases: ['product category'], relevanceScore: 0.8,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const relationship: AgentEvidenceCandidate = {
      id: 'dql:relationship:customer_product', kind: 'dql_modeling', trustTier: 'governed_sql',
      name: 'Customer Product Relationship', aliases: ['customer product relationship'], relevanceScore: 0.8,
      matchReasons: ['governed relationship'], compatibility: 'compatible',
      relationshipEvidence: ['dql:relationship:customer_product'],
    };
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: [revenue.id, region.id, relationship.id],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id, region.id, relationship.id],
          roleBindings: { metric: [revenue.id], categorical_dimension: [region.id], relationship: [relationship.id] },
          operations: ['aggregate', 'group'],
        }],
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot:two-dimensions',
        candidates: [revenue, region, productCategory, relationship],
        parsedIntent: { measures: ['revenue'], dimensions: ['region', 'product category'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by region and product category', requestedMode: 'ask' });

    expect(decision.askAnalystDecision?.state.phase).toBe('blocked');
    expect(decision.askAnalystDecision?.state.planningReceipt?.verification).toMatchObject({
      reasonCode: 'targeted_context_unavailable',
      missingRoles: ['categorical_dimension'],
    });
    expect(compilerBroker.decide).not.toHaveBeenCalled();
  });

  it('AGT-042 rejects a targeted recovery payload that names hidden workspace card 17', async () => {
    const target: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.product_hidden',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Product Hidden', aliases: ['product hidden'], relevanceScore: 0.1,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const productDistractors = ['one', 'two'].map((suffix, index): AgentEvidenceCandidate => ({
      id: `semantic:dimension:products.product_${suffix}`,
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: `Product ${suffix}`, aliases: ['product'], relevanceScore: 0.95 - index / 100,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: [revenue.id],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id],
          roleBindings: { metric: [revenue.id] },
          operations: ['aggregate', 'group'],
        }],
        recovery: {
          version: 1,
          missingRoles: ['categorical_dimension'],
          // Legacy IDs remain parseable for persisted records, but they may
          // never disclose a hidden #17 card to the new runtime.
          candidateIds: [target.id],
        },
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot:hidden-recovery-id',
        candidates: [revenue, ...productDistractors, ...Array.from({ length: 14 }, (_, index): AgentEvidenceCandidate => ({
          id: `semantic:metric:noise_${index}`, kind: 'semantic_metric', trustTier: 'semantic',
          name: `Noise ${index}`, relevanceScore: 0.99 - index / 1000, matchReasons: ['noise'], compatibility: 'compatible',
        })), target],
        parsedIntent: { measures: ['revenue'], dimensions: ['product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product', requestedMode: 'ask' });

    expect(decision.askAnalystDecision?.state.phase).toBe('blocked');
    expect(decision.askAnalystDecision?.state.planningReceipt?.verification.reasonCode).toBe('planner_recovery_referenced_unadmitted_candidate');
    expect(compilerBroker.decide).not.toHaveBeenCalled();
  });

  it('AGT-042 returns a typed gap when verifier-directed recovery terms do not match the immutable workspace', async () => {
    const target: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.product_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Product Name', aliases: ['product'], relevanceScore: 0.1,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: [revenue.id],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id],
          roleBindings: { metric: [revenue.id] },
          operations: ['aggregate', 'group'],
        }],
        recovery: {
          version: 1,
          missingRoles: ['categorical_dimension'],
          searchTerms: ['unmatched supplier lineage'],
          relatedCandidateIds: [revenue.id],
        },
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot:unmatched-recovery-terms',
        candidates: [revenue, ...Array.from({ length: 15 }, (_, index): AgentEvidenceCandidate => ({
          id: `semantic:metric:noise_${index}`, kind: 'semantic_metric', trustTier: 'semantic',
          name: `Noise ${index}`, relevanceScore: 0.99 - index / 1000, matchReasons: ['noise'], compatibility: 'compatible',
        })), target],
        parsedIntent: { measures: ['revenue'], dimensions: ['product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product', requestedMode: 'ask' });

    expect(decision.askAnalystDecision?.state.phase).toBe('blocked');
    expect(decision.askAnalystDecision?.state.planningReceipt?.verification.reasonCode).toBe('targeted_context_unavailable');
    expect(compilerBroker.decide).not.toHaveBeenCalled();
  });

  it('AGT-043 keeps Research an explicit request-level mode rather than inferring it from ordinary Ask wording', async () => {
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      getEvidence: async () => ({ candidates: [revenue], parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] } }),
    });

    const ordinary = await runtime.decide({
      question: 'Investigate why revenue changed',
      requestedMode: 'ask',
    });
    const explicitResearch = await runtime.decide({
      question: 'Investigate why revenue changed',
      requestedMode: 'research',
    });

    expect(ordinary.askAnalystDecision?.state.mission.mode).toBe('ask');
    expect(ordinary.askAnalystDecision?.state.frame.kind).toBe('diagnosis');
    expect(explicitResearch.askAnalystDecision?.state.mission.mode).toBe('research');
    expect(explicitResearch.askAnalystDecision?.state.frame.kind).toBe('research');
  });

  it('AGT-036 returns a pre-freeze scope clarification for more than three independent ordinary Ask clauses', async () => {
    const planner = vi.fn();
    const broker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: broker,
      planAnalytical: planner,
      getEvidence: async () => ({ candidates: [revenue], parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] } }),
    });

    const decision = await runtime.decide({
      question: 'show revenue; show order count; show customers; show products',
      requestedMode: 'ask',
    });

    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      reason: expect.stringMatching(/more than three independent analytical asks/i),
      askAnalystDecision: { state: { phase: 'clarify', mission: { scopeOverflow: true } } },
    });
    expect(planner).not.toHaveBeenCalled();
    expect(broker.decide).not.toHaveBeenCalled();
  });

  it('AGT-036 freezes every accepted ordinary compound task instead of deferring task-2', async () => {
    // Two qualified revenue candidates prevent the legal deterministic
    // single-metric fast path, so this covers the normal one-call planner
    // path before the runtime freezes one compiler program per accepted task.
    const competingRevenue: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:orders.booked_revenue',
      qualifiedId: 'semantic:metric:orders.booked_revenue',
      name: 'orders.booked_revenue',
      aliases: ['revenue'],
      exactMatch: false,
      relevanceScore: 0.8,
      analyticalCapability: semanticCapability('semantic:metric:orders.booked_revenue'),
    };
    const planner = vi.fn(async () => ({
      version: 1 as const,
      selectedConceptIds: [revenue.id],
      tasks: ['task-1', 'task-2'].map((taskId) => ({
        version: 1 as const,
        taskId,
        selectedConceptIds: [revenue.id],
        roleBindings: { metric: [revenue.id] },
        operations: ['aggregate', 'project'] as const,
      })),
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:compound',
        candidates: [revenue, competingRevenue],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'show revenue; show revenue',
      requestedMode: 'ask',
    });

    const state = decision.askAnalystDecision?.state;
    expect(state?.mission.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2']);
    expect(state?.mission.deferredTasks).toBeUndefined();
    expect(state?.program.taskIds).toEqual(['task-1', 'task-2']);
    expect(decision.askAnalystDecision?.taskExecutions?.map((task) => task.taskId)).toEqual(['task-1', 'task-2']);
    expect(decision.askAnalystDecision?.frozenPlan?.steps.map((step) => step.askAnalystTaskId)).toEqual(['task-1', 'task-2']);
    expect(planner).toHaveBeenCalledTimes(1);
  });

  it('AGT-036 rejects a planner that returns only task-1 of two independent ordinary Ask clauses', async () => {
    const competingRevenue: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:orders.booked_revenue',
      qualifiedId: 'semantic:metric:orders.booked_revenue',
      name: 'orders.booked_revenue',
      aliases: ['revenue'],
      exactMatch: false,
      relevanceScore: 0.8,
      analyticalCapability: semanticCapability('semantic:metric:orders.booked_revenue'),
    };
    const broker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: broker,
      planAnalytical: vi.fn(async () => ({
        version: 1 as const,
        selectedConceptIds: [revenue.id],
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id],
          roleBindings: { metric: [revenue.id] },
          operations: ['aggregate', 'project'] as const,
        }],
      })),
      getEvidence: async () => ({
        snapshotId: 'snapshot:subset',
        candidates: [revenue, competingRevenue],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue; show revenue again', requestedMode: 'ask' });

    expect(decision).toMatchObject({
      action: 'block',
      askAnalystDecision: {
        state: {
          phase: 'blocked',
          planningReceipt: { verification: { reasonCode: 'planner_task_coverage_incomplete' } },
        },
      },
    });
    expect(broker.decide).not.toHaveBeenCalled();
  });

  it('AGT-036 permits one verified program to cover compatible task options only when coverage is explicit', async () => {
    const region: AgentEvidenceCandidate = {
      id: 'semantic:dimension:orders.region',
      qualifiedId: 'semantic:dimension:orders.region',
      name: 'orders.region',
      aliases: ['region'],
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      exactMatch: true,
      relevanceScore: 0.9,
    } as AgentEvidenceCandidate;
    const revenueByRegion: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        operations: ['filter', 'group', 'trend', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension', 'rank'],
        dimensions: [{
          dimensionId: region.id,
          entityId: 'semantic:entity:order',
          label: 'Region',
          aliases: ['region'],
          supportedRoles: ['group_by'],
        }],
      },
    };
    const orderCount: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:orders.order_count',
      qualifiedId: 'semantic:metric:orders.order_count',
      name: 'orders.order_count',
      aliases: ['order count'],
      exactMatch: true,
      relevanceScore: 0.95,
      analyticalCapability: {
        ...semanticCapability('semantic:metric:orders.order_count'),
        operations: ['filter', 'group', 'trend', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension', 'rank'],
        dimensions: [{
          dimensionId: region.id,
          entityId: 'semantic:entity:order',
          label: 'Region',
          aliases: ['region'],
          supportedRoles: ['group_by'],
        }],
      },
    };
    const planner = vi.fn(async () => ({
      version: 1 as const,
      selectedConceptIds: [revenueByRegion.id, orderCount.id, region.id],
      tasks: [{
        version: 1 as const,
        taskId: 'task-1',
        coveredTaskIds: ['task-1', 'task-2'],
        selectedConceptIds: [revenueByRegion.id, orderCount.id, region.id],
        roleBindings: { metric: [revenueByRegion.id, orderCount.id], categorical_dimension: [region.id] },
        operations: ['aggregate', 'group', 'project'] as const,
      }],
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:merge',
        candidates: [revenueByRegion, orderCount, region],
        parsedIntent: { measures: ['revenue', 'order count'], dimensions: ['region'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'show revenue by region; show order count by region',
      requestedMode: 'ask',
    });

    expect(decision.askAnalystDecision?.taskExecutions).toHaveLength(1);
    expect(decision.askAnalystDecision?.state.program.planner.tasks[0]).toMatchObject({
      coveredTaskIds: ['task-1', 'task-2'],
    });
    expect(planner).toHaveBeenCalledTimes(1);
  });

  it('AGT-036 rejects a one-program merge when ranking metrics differ across covered task options', async () => {
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name',
      qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Customer Name',
      aliases: ['customer', 'customer name'],
      relevanceScore: 0.9,
      matchReasons: ['semantic dimension'],
      compatibility: 'compatible',
    };
    const orderCount: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:orders.order_count',
      qualifiedId: 'semantic:metric:orders.order_count',
      name: 'orders.order_count',
      aliases: ['order count'],
      exactMatch: true,
      relevanceScore: 0.9,
      analyticalCapability: semanticCapability('semantic:metric:orders.order_count'),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: vi.fn(async () => ({
        version: 1 as const,
        selectedConceptIds: [revenue.id, orderCount.id, customerName.id],
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          coveredTaskIds: ['task-1', 'task-2'],
          selectedConceptIds: [revenue.id, orderCount.id, customerName.id],
          roleBindings: { metric: [revenue.id, orderCount.id], entity_label: [customerName.id] },
          operations: ['aggregate', 'rank', 'group'] as const,
        }],
      })),
      getEvidence: async () => ({
        snapshotId: 'snapshot:ranking-merge',
        candidates: [revenue, orderCount, customerName],
        parsedIntent: { measures: ['revenue', 'order count'], dimensions: ['customer name'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'top customers by revenue; top customers by order count',
      requestedMode: 'ask',
    });

    expect(decision).toMatchObject({
      action: 'block',
      askAnalystDecision: { state: { planningReceipt: { verification: { reasonCode: 'planner_task_coverage_incomplete' } } } },
    });
  });

  it('AGT-036 rejects a one-program merge when region and product grouping shapes differ', async () => {
    const region: AgentEvidenceCandidate = {
      id: 'semantic:dimension:orders.region', qualifiedId: 'semantic:dimension:orders.region',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Region', aliases: ['region'], relevanceScore: 0.95,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const productCategory: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.category', qualifiedId: 'semantic:dimension:products.category',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Product Category', aliases: ['product category', 'category'], relevanceScore: 0.94,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const revenueWithDimensions: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        operations: ['filter', 'group', 'trend', 'rank'],
        supportedOutputKinds: ['metric_value', 'dimension', 'rank'],
        dimensions: [
          { dimensionId: region.id, entityId: 'semantic:entity:order', label: 'Region', aliases: ['region'], supportedRoles: ['group_by'] },
          { dimensionId: productCategory.id, entityId: 'semantic:entity:product', label: 'Product Category', aliases: ['product category', 'category'], supportedRoles: ['group_by'] },
        ],
      },
    };
    const competingRevenue: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:orders.booked_revenue', qualifiedId: 'semantic:metric:orders.booked_revenue',
      name: 'orders.booked_revenue', aliases: ['revenue'], exactMatch: false, relevanceScore: 0.8,
      analyticalCapability: semanticCapability('semantic:metric:orders.booked_revenue'),
    };
    const broker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: broker,
      planAnalytical: vi.fn(async () => ({
        version: 1 as const,
        selectedConceptIds: [revenueWithDimensions.id, region.id, productCategory.id],
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          coveredTaskIds: ['task-1', 'task-2'],
          selectedConceptIds: [revenueWithDimensions.id, region.id, productCategory.id],
          roleBindings: {
            metric: [revenueWithDimensions.id],
            categorical_dimension: [region.id, productCategory.id],
          },
          operations: ['aggregate', 'group', 'project'] as const,
        }],
      })),
      getEvidence: async () => ({
        snapshotId: 'snapshot:incompatible-merge',
        candidates: [revenueWithDimensions, competingRevenue, region, productCategory],
        parsedIntent: { measures: ['revenue'], dimensions: ['region', 'product category'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'show revenue by region; show revenue by product category',
      requestedMode: 'ask',
    });

    expect(decision).toMatchObject({
      action: 'block',
      askAnalystDecision: { state: { planningReceipt: { verification: { reasonCode: 'planner_task_coverage_incomplete' } } } },
    });
    expect(broker.decide).not.toHaveBeenCalled();
  });

  it('preserves a provider failure as terminal provider evidence rather than an analytical modeling gap', async () => {
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      getEvidence: async () => ({ candidates: [revenue], parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] } }),
      resolveMeaning: async () => { throw Object.assign(new Error('unauthorized provider'), { code: '401' }); },
    });

    const decision = await runtime.decide({ question: 'show revenue by region' });
    expect(decision.terminalOutcome).toMatchObject({ kind: 'policy_blocked', code: 'ANALYTICAL_POLICY_BLOCKED' });
    expect(decision.providerFailure).toMatchObject({ cause: 'authentication', phase: 'planning', retryable: false });
    expect(decision.terminalOutcome?.code).not.toBe('ANALYTICAL_MODELING_GAP');
  });

  it('records an invalid planner response as planning validation, not empty targeted recovery or a provider outage', async () => {
    const planner = vi.fn(async () => undefined);
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:invalid-planner-response',
        candidates: [revenue],
        parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by region', requestedMode: 'ask' });

    expect(planner).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'block',
      terminalOutcome: { kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP' },
      askAnalystDecision: {
        state: {
          planningReceipt: {
            mode: 'initial_planner',
            plannerCalls: 1,
            revisionCalls: 0,
            verification: {
              status: 'invalid',
              missingRoles: [],
              reasonCode: 'planner_resolution_invalid',
            },
          },
          workspace: {
            tools: expect.arrayContaining([
              expect.objectContaining({ kind: 'provider_meaning', status: 'failed', reasonCode: 'planning.initial.failed' }),
            ]),
          },
        },
      },
    });
    expect(decision.providerFailure).toBeUndefined();
    expect(decision.reason).not.toMatch(/connection|sql execute/i);
  });
});
