import { describe, expect, it, vi } from 'vitest';
import { createAskAnalystRuntimeV1 } from './ask-analyst-runtime.js';
import { buildAnalyticalRequirementSeedV1, evidenceCandidateRoles } from '../analytical-orchestration.js';
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

  it('AGT-051 binds an exact safe physical member value into one review-required exploratory program when semantic evidence is absent', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders',
      qualifiedId: 'dbt:model:orders',
      kind: 'dbt_model',
      trustTier: 'exploratory',
      name: 'orders',
      aliases: ['orders'],
      relevanceScore: 1,
      matchReasons: ['qualified dbt relation'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:analytics.orders'],
    };
    const revenueColumn: AgentEvidenceCandidate = {
      id: 'dbt:column:orders.revenue',
      qualifiedId: 'dbt:column:orders.revenue',
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: 'revenue',
      aliases: ['revenue'],
      relevanceScore: 1,
      matchReasons: ['qualified physical measure'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:analytics.orders'],
    };
    const regionColumn: AgentEvidenceCandidate = {
      id: 'dbt:column:orders.region',
      qualifiedId: 'dbt:column:orders.region',
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: 'region',
      aliases: ['region'],
      relevanceScore: 0.99,
      matchReasons: ['qualified physical categorical column'],
      compatibility: 'compatible',
      compatibilityFacts: ['roles categorical dimension'],
      sourceObjects: ['runtime:relation:analytics.orders'],
      safeValueEvidence: [{
        version: 1,
        relation: 'analytics.orders',
        column: 'region',
        value: 'Philadelphia',
        normalizedValue: 'philadelphia',
      }],
    };
    const resolveMeaning = vi.fn();
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot:physical-philadelphia',
        candidates: [relation, revenueColumn, regionColumn],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'Show revenue in Philadelphia',
      requestedMode: 'ask',
    });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.action).toBe('answer');
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      planFrozen: true,
    });
    expect(decision.askAnalystDecision?.state.program.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldTerms: [regionColumn.id],
        value: 'Philadelphia',
        operator: 'equals',
      }),
    ]));
    expect(decision.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({
      compiler: 'exploratory_sql',
      reviewRequired: true,
      planFrozen: true,
    });
  });

  it('AGT-051 probes one cold exact literal then admits a bounded exploratory closure without provider egress', async () => {
    const customers: AgentEvidenceCandidate = {
      id: 'dbt:model:customers', qualifiedId: 'dbt:model:customers', kind: 'dbt_model',
      trustTier: 'exploratory', name: 'customers', aliases: ['customers'], relevanceScore: 1,
      exactMatch: true, matchReasons: ['exact customer relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:customers'],
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'runtime:column:customers.customer_name', qualifiedId: 'runtime:column:customers.customer_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'customer_name', aliases: ['customer', 'customer name'],
      relevanceScore: 0.99, exactMatch: true, matchReasons: ['exact customer display field'], compatibility: 'compatible',
      compatibilityFacts: ['roles entity label'], sourceObjects: ['runtime:relation:customers'],
    };
    const locations: AgentEvidenceCandidate = {
      id: 'dbt:model:locations', qualifiedId: 'dbt:model:locations', kind: 'dbt_model',
      trustTier: 'exploratory', name: 'locations', aliases: ['locations'], relevanceScore: 0.01,
      matchReasons: ['qualified location relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:locations'],
    };
    // This intentionally has no categorical-role fact. Its exact observed
    // value, qualified identity, and path proof—not its lexical label—are the
    // permitted literal binding evidence.
    const locationName: AgentEvidenceCandidate = {
      id: 'runtime:column:locations.location_name', qualifiedId: 'runtime:column:locations.location_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'location_name', aliases: ['location name'],
      relevanceScore: 0.01, matchReasons: ['qualified location value field'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:locations'],
      // The local host, not retrieval or the planner, owns this opaque
      // single-use probe token. Field metadata stays in the host registry.
      hostLiteralProbeToken: 'host-test-location-probe',
    };
    const customerLocation: AgentEvidenceCandidate = {
      id: 'dql:relationship:customer_location', qualifiedId: 'dql:relationship:customer_location',
      kind: 'dql_modeling', trustTier: 'governed_sql', name: 'customer location relationship',
      aliases: ['customer location relationship'], relevanceScore: 0.02,
      matchReasons: ['declared draft relationship proof'], compatibility: 'compatible',
      relationshipEvidence: ['dql:relationship:customer_location'],
      relationshipSafety: [{
        id: 'dql:relationship:customer_location',
        from: 'runtime:relation:customers', to: 'runtime:relation:locations',
        keys: [{ from: 'location_id', to: 'location_id' }], status: 'draft', staleCertification: false,
        cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: false,
        exploratoryJoinAllowed: true, exploratoryPathFingerprint: 'path:customer-location',
      }],
    };
    // More than the execution-workspace cap of irrelevant cards ensures the
    // location relation/value are below the initial fused selection.
    const filler = Array.from({ length: 36 }, (_, index): AgentEvidenceCandidate => ({
      id: `dbt:model:context_${index}`, qualifiedId: `dbt:model:context_${index}`,
      kind: 'dbt_model', trustTier: 'exploratory', name: `Context ${index}`,
      aliases: [`context ${index}`], relevanceScore: 0.9 - index / 1_000,
      matchReasons: ['irrelevant workspace pressure'], compatibility: 'compatible',
      sourceObjects: [`runtime:relation:context_${index}`],
    }));
    const resolveMeaning = vi.fn();
    const getEvidence = vi.fn(async (): Promise<AgentRetrievalEvidence> => ({
      snapshotId: 'snapshot:below-cap-philadelphia',
      // `revenue` deliberately creates an early deterministic semantic
      // binding. It does not prove the current Philadelphia predicate, so it
      // must not suppress the one host literal probe/closure below.
      candidates: [revenue, customers, customerName, ...filler, locations, locationName, customerLocation],
      parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
    }));
    const probeLiteralGrounding = vi.fn(async () => {
      return { version: 1 as const, status: 'matched' as const, candidateId: locationName.id, reasonCode: 'exact_value_probe_match' };
    });
    expect(evidenceCandidateRoles(locationName)).toEqual(['context']);
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      resolveMeaning,
      getEvidence,
      probeLiteralGrounding,
      allowDeterministicNaturalLanguageBinding: true,
    });

    const decision = await runtime.decide({
      question: 'Show revenue for customers in Philadelphia',
      requestedMode: 'ask',
    });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(getEvidence).toHaveBeenCalledTimes(1);
    expect(probeLiteralGrounding).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe('answer');
    expect(decision.analyticalCascadeDecision?.selectedTier).toBe('exploratory_sql');
    expect(decision.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({
      reviewRequired: true,
      planFrozen: true,
    });
    expect(decision.askAnalystDecision?.state.workspace.workspaceCandidateIds).toHaveLength(32);
    expect(decision.askAnalystDecision?.state.workspace.targetedContext).toMatchObject({
      status: 'admitted',
      reasonCode: 'same_snapshot_literal_role_extension_exploratory',
      // The first-class enrichment admitted the exact configured field into
      // the regular workspace before closure assembly; the closure only adds
      // the owning relation/path that remained outside that cap.
      candidateIds: expect.arrayContaining([locations.qualifiedId]),
      relationshipPathIds: ['dql:relationship:customer_location'],
    });
    expect(decision.askAnalystDecision?.state.workspace.workspaceCandidateIds).toEqual(expect.arrayContaining([
      locationName.qualifiedId,
    ]));
    expect(decision.askAnalystDecision?.state.workspace.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tool:literal_role_extension',
        kind: 'candidate_extension',
        status: 'completed',
        reasonCode: 'same_snapshot_literal_role_extension_exploratory',
      }),
      expect.objectContaining({
        id: 'tool:literal_grounding_probe',
        status: 'completed',
        reasonCode: 'literal_grounding_exact_match',
      }),
    ]));
    const toolIds = decision.askAnalystDecision?.state.workspace.tools.map((tool) => tool.id) ?? [];
    expect(toolIds.indexOf('tool:literal_grounding_probe')).toBeGreaterThan(toolIds.indexOf('tool:retrieve_snapshot'));
    expect(toolIds.indexOf('tool:literal_grounding_probe')).toBeLessThan(toolIds.indexOf('tool:literal_role_extension'));
    expect(decision.askAnalystDecision?.state.program.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldTerms: [locationName.qualifiedId], value: 'philadelphia', operator: 'equals' }),
    ]));
    // The local trace/tool surface never retains the probe literal, SQL, or
    // warehouse rows. Only the selected candidate identity and status remain.
    expect(JSON.stringify(decision.askAnalystDecision?.state.workspace.tools)).not.toContain('Philadelphia');

    const foreignBroker = { decide: vi.fn(async () => semanticDecision()) };
    const foreignProbe = vi.fn(async () => ({
      version: 1 as const,
      status: 'matched' as const,
      candidateId: 'runtime:column:other.location_name',
      reasonCode: 'foreign_candidate',
    }));
    const foreign = await createAskAnalystRuntimeV1({
      compilerBroker: foreignBroker,
      getEvidence,
      probeLiteralGrounding: foreignProbe,
      allowDeterministicNaturalLanguageBinding: true,
    }).decide({ question: 'Show revenue for customers in Philadelphia', requestedMode: 'ask' });
    expect(foreign.action).not.toBe('answer');
    expect(foreign.askAnalystDecision?.state.workspace.targetedContext).toBeUndefined();
    expect(foreign.askAnalystDecision?.state.workspace.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool:literal_grounding_probe', reasonCode: 'literal_grounding_invalid_match' }),
    ]));
    expect(foreignBroker.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['no match', { status: 'no_match' as const, reasonCode: 'exact_value_probe_no_match' }],
    ['disabled', { status: 'disabled' as const, reasonCode: 'runtime_value_grounding_disabled' }],
    ['unavailable', { status: 'unavailable' as const, reasonCode: 'literal_probe_execution_unavailable' }],
    ['invalid capability', { status: 'denied' as const, reasonCode: 'literal_probe_capability_denied' }],
    ['ambiguous capability', { status: 'ambiguous' as const, reasonCode: 'literal_probe_capability_ambiguous' }],
  ])('AGT-051 keeps a cold literal %s result pre-freeze and never falls back to a broad route', async (_label, probeResult) => {
    const customers: AgentEvidenceCandidate = {
      id: 'dbt:model:customers', qualifiedId: 'dbt:model:customers', kind: 'dbt_model',
      trustTier: 'exploratory', name: 'customers', aliases: ['customers'], relevanceScore: 1,
      exactMatch: true, matchReasons: ['exact customer relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:customers'],
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'runtime:column:customers.customer_name', qualifiedId: 'runtime:column:customers.customer_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'customer_name', aliases: ['customer', 'customer name'],
      relevanceScore: 0.99, exactMatch: true, matchReasons: ['exact customer display field'], compatibility: 'compatible',
      compatibilityFacts: ['roles entity label'], sourceObjects: ['runtime:relation:customers'],
    };
    const locationName: AgentEvidenceCandidate = {
      id: 'runtime:column:locations.location_name', qualifiedId: 'runtime:column:locations.location_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'location_name', aliases: ['location name'],
      relevanceScore: 0.1, matchReasons: ['configured physical value field'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:locations'], hostLiteralProbeToken: 'opaque-negative-probe-token',
    };
    const planner = vi.fn(async () => undefined);
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const probeLiteralGrounding = vi.fn(async () => ({ version: 1 as const, ...probeResult }));
    const decision = await createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      probeLiteralGrounding,
      allowDeterministicNaturalLanguageBinding: true,
      getEvidence: async () => ({
        snapshotId: 'snapshot:cold-literal-negative',
        candidates: [revenue, customers, customerName, locationName],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      }),
    }).decide({ question: 'Show revenue for customers in Philadelphia', requestedMode: 'ask' });

    expect(probeLiteralGrounding).toHaveBeenCalledTimes(1);
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.askAnalystDecision?.state.phase).toBe('blocked');
    expect(decision.askAnalystDecision?.state.resolvedPlan?.planFrozen ?? false).toBe(false);
    expect(decision.analyticalCascadeDecision?.selectedTier).toBeUndefined();
    // Opaque capability material cannot leak into durable/planner state even
    // when the host declines the probe before a generated route exists.
    expect(JSON.stringify(decision.askAnalystDecision)).not.toContain('opaque-negative-probe-token');
  });

  it('AGT-051 leaves ambiguous or unsafe below-cap literal closures as a typed pre-freeze gap', async () => {
    const customer: AgentEvidenceCandidate = {
      id: 'dbt:model:customers', qualifiedId: 'dbt:model:customers', kind: 'dbt_model',
      trustTier: 'exploratory', name: 'customers', aliases: ['customers'], relevanceScore: 1,
      exactMatch: true, matchReasons: ['exact customer relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:customers'],
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'runtime:column:customers.customer_name', qualifiedId: 'runtime:column:customers.customer_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'customer_name', aliases: ['customer'], relevanceScore: 0.99,
      exactMatch: true, matchReasons: ['exact customer display field'], compatibility: 'compatible',
      compatibilityFacts: ['roles entity label'], sourceObjects: ['runtime:relation:customers'],
    };
    const locations: AgentEvidenceCandidate = {
      id: 'dbt:model:locations', qualifiedId: 'dbt:model:locations', kind: 'dbt_model',
      trustTier: 'exploratory', name: 'locations', aliases: ['locations'], relevanceScore: 0.01,
      matchReasons: ['qualified location relation'], compatibility: 'compatible', sourceObjects: ['runtime:relation:locations'],
    };
    const literal = (id: string): AgentEvidenceCandidate => ({
      id, qualifiedId: id, kind: 'sql_column', trustTier: 'exploratory', name: id.split('.').at(-1) ?? id,
      aliases: ['location'], relevanceScore: 0.01, matchReasons: ['qualified value field'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:locations'],
      safeValueEvidence: [{ version: 1, relation: 'locations', column: id.split('.').at(-1) ?? id, value: 'Philadelphia', normalizedValue: 'philadelphia' }],
    });
    const unsafePath: AgentEvidenceCandidate = {
      id: 'dql:relationship:unsafe_customer_location', qualifiedId: 'dql:relationship:unsafe_customer_location',
      kind: 'dql_modeling', trustTier: 'governed_sql', name: 'unsafe customer location relationship', relevanceScore: 0.02,
      matchReasons: ['unsafe relationship'], compatibility: 'compatible', relationshipEvidence: ['dql:relationship:unsafe_customer_location'],
      relationshipSafety: [{
        id: 'dql:relationship:unsafe_customer_location', from: 'runtime:relation:customers', to: 'runtime:relation:locations',
        keys: [{ from: 'location_id', to: 'location_id' }], status: 'certified', staleCertification: false,
        cardinality: 'many_to_many', fanout: 'unsafe', automaticJoinAllowed: false,
        validation: { status: 'passed', checkedAt: '2026-08-29T00:00:00.000Z' },
      }],
    };
    // One evidence card can still hide two distinct safe physical joins. The
    // literal extension must not collapse those paths merely because the card
    // itself has one stable ID.
    const twoSafePhysicalPathsInOneCard: AgentEvidenceCandidate = {
      id: 'dql:relationship:two_customer_location_paths', qualifiedId: 'dql:relationship:two_customer_location_paths',
      kind: 'dql_modeling', trustTier: 'governed_sql', name: 'two customer location paths', relevanceScore: 0.02,
      matchReasons: ['two certified safe relationship proofs'], compatibility: 'compatible',
      relationshipEvidence: [
        'dql:relationship:customer_location_by_id',
        'dql:relationship:customer_location_by_code',
      ],
      relationshipSafety: [
        {
          id: 'dql:relationship:customer_location_by_id', from: 'runtime:relation:customers', to: 'runtime:relation:locations',
          keys: [{ from: 'location_id', to: 'location_id' }], status: 'certified', staleCertification: false,
          cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: true,
          certificationFingerprint: 'sha256:customer-location-id',
          validation: {
            status: 'passed', checkedAt: '2026-08-29T00:00:00.000Z',
            queryFingerprint: 'sha256:customer-location-id-query', proofFingerprint: 'sha256:customer-location-id-proof',
          },
        },
        {
          id: 'dql:relationship:customer_location_by_code', from: 'runtime:relation:customers', to: 'runtime:relation:locations',
          keys: [{ from: 'location_code', to: 'location_code' }], status: 'certified', staleCertification: false,
          cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: true,
          certificationFingerprint: 'sha256:customer-location-code',
          validation: {
            status: 'passed', checkedAt: '2026-08-29T00:00:00.000Z',
            queryFingerprint: 'sha256:customer-location-code-query', proofFingerprint: 'sha256:customer-location-code-proof',
          },
        },
      ],
    };
    const filler = Array.from({ length: 36 }, (_, index): AgentEvidenceCandidate => ({
      id: `dbt:model:context_${index}`, qualifiedId: `dbt:model:context_${index}`,
      kind: 'dbt_model', trustTier: 'exploratory', name: `Context ${index}`, aliases: [`context ${index}`],
      relevanceScore: 0.9 - index / 1_000, matchReasons: ['workspace pressure'], compatibility: 'compatible',
      sourceObjects: [`runtime:relation:context_${index}`],
    }));
    for (const candidates of [
      [customer, customerName, ...filler, locations, literal('runtime:column:locations.location_name'), literal('runtime:column:locations.city_name')],
      [customer, customerName, ...filler, locations, literal('runtime:column:locations.location_name'), unsafePath],
      [customer, customerName, ...filler, locations, literal('runtime:column:locations.location_name'), twoSafePhysicalPathsInOneCard],
    ]) {
      const broker = { decide: vi.fn(async () => semanticDecision()) };
      const runtime = createAskAnalystRuntimeV1({
        compilerBroker: broker,
        getEvidence: async () => ({ snapshotId: 'snapshot:unsafe-or-ambiguous', candidates, parsedIntent: { measures: [], dimensions: [], filters: [] } }),
      });
      const decision = await runtime.decide({ question: 'Who are the customers in Philadelphia?', requestedMode: 'ask' });
      expect(decision.action).not.toBe('answer');
      expect(decision.askAnalystDecision?.state.workspace.targetedContext).toBeUndefined();
      expect(decision.askAnalystDecision?.state.workspace.tools.some((tool) => tool.id === 'tool:literal_role_extension')).toBe(false);
      expect(broker.decide).not.toHaveBeenCalled();
      expect(decision.askAnalystDecision?.state.phase).toBe('blocked');
      expect(decision.askAnalystDecision?.state.resolvedPlan?.planFrozen ?? false).toBe(false);
      expect(decision.askAnalystDecision?.state.planningReceipt?.verification.status).toBe('invalid');
    }
  });

  it('AGT-036 keeps a typed prior-result lookup on one qualified relation without inventing a measure', async () => {
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
      aliases: ['customer', 'customer name'],
      relevanceScore: 1,
      matchReasons: ['runtime schema column'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:dim_customers'],
    };
    const region: AgentEvidenceCandidate = {
      id: 'dbt:column:dim_customers.region',
      qualifiedId: 'dbt:column:dim_customers.region',
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: 'region',
      aliases: ['region'],
      relevanceScore: 1,
      matchReasons: ['runtime schema column'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:dim_customers'],
    };
    const planAnalytical = vi.fn();
    const probeLiteralGrounding = vi.fn();
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical,
      probeLiteralGrounding,
      getEvidence: async () => ({
        snapshotId: 'snapshot:customer-region',
        candidates: [relation, customerName, region],
        parsedIntent: { measures: [], dimensions: ['region'], filters: [] },
      }),
    });
    const question = 'Which region does Brittany Barrera belong to?';
    const decision = await runtime.decide({
      question,
      requestedMode: 'ask',
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question,
        parsedIntent: { dimensions: ['region'], filters: [{ field: 'customer_name', value: 'Brittany Barrera' }] },
      }),
    });

    expect(planAnalytical).not.toHaveBeenCalled();
    // The current proper name is already bound by the host-issued predicate;
    // it must not trigger a new warehouse-value probe or clear the direct
    // one-relation program.
    expect(probeLiteralGrounding).not.toHaveBeenCalled();
    expect(decision.meaningResolution?.recommendedRoute).toBe('exploratory');
    expect(decision.meaningResolution?.selectedConceptIds).toEqual(expect.arrayContaining([
      relation.id,
      customerName.id,
      region.id,
    ]));
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
      relationshipSafety: [{
        id: 'dql:relationship:customer_order_item_product',
        from: 'semantic:entity:customers.customer_id',
        to: 'semantic:entity:products.product',
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        status: 'certified', staleCertification: false, cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: true,
        certificationFingerprint: 'sha256:customer-order-item-product',
        validation: { status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z', queryFingerprint: 'sha256:customer-product-query', proofFingerprint: 'sha256:customer-product-proof' },
      }],
    };
    const planner = vi.fn(async (input: { plannerRequest: { candidates: readonly { id: string; roles: string[] }[]; planningMode: string } }) => {
      expect(input.plannerRequest.planningMode).toBe('initial_planner');
      expect(input.plannerRequest.candidates).toHaveLength(5);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('metric'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('entity_key'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('entity_label'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('categorical_dimension'))).toBe(true);
      expect(input.plannerRequest.candidates.some((candidate) => candidate.roles.includes('relationship'))).toBe(true);
      const pathCardId = input.plannerRequest.candidates.find((candidate) =>
        candidate.id.startsWith('dql:relationship_path:'))?.id ?? 'dql:relationship_path:missing';
      return {
        version: 1 as const,
        selectedConceptIds: [revenue.id, customerKey.id, customerName.id, productName.id, pathCardId],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id, customerKey.id, customerName.id, productName.id, pathCardId],
          roleBindings: {
            metric: [revenue.id],
            entity_key: [customerKey.id],
            entity_label: [customerName.id],
            categorical_dimension: [productName.id],
            relationship: [pathCardId],
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
      // V3 is the intentional authoritative planner/compiler handoff. The
      // planner receipt remains V1 for additive JSON compatibility, while
      // the persisted Ask state and immutable program carry V3 provenance.
      version: 3,
      planningMode: 'initial_planner',
      program: { version: 3 },
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
      relationshipSafety: [{
        id: 'relationship:customers_orders',
        from: 'semantic:entity:customers.customer_id',
        to: 'semantic:entity:order',
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        status: 'certified', staleCertification: false, cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: true,
        certificationFingerprint: 'sha256:customers-orders',
        validation: { status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z', queryFingerprint: 'sha256:customers-orders-query', proofFingerprint: 'sha256:customers-orders-proof' },
      }],
    };
    const planner = vi.fn(async (input: { plannerRequest: { candidates: readonly { id: string }[] } }) => {
      const pathCardId = input.plannerRequest.candidates.find((candidate) =>
        candidate.id.startsWith('dql:relationship_path:'))?.id ?? 'dql:relationship_path:missing';
      return {
        version: 1 as const,
        selectedConceptIds: [tupleRevenue.id, customerKey.id, customerName.id, region.id, west.id, pathCardId],
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [tupleRevenue.id, customerKey.id, customerName.id, region.id, west.id, pathCardId],
          roleBindings: {
            metric: [tupleRevenue.id],
            entity_key: [customerKey.id],
            entity_label: [customerName.id],
            categorical_dimension: [region.id],
            member: [west.id],
            // A semantic metric may bind an authored time child; it does not
            // authorize a time field outside the same snapshot.
            time_dimension: [tupleRevenue.id],
            relationship: [pathCardId],
          },
          operations: ['aggregate', 'filter', 'group', 'trend', 'rank', 'project'] as const,
        }],
      };
    });
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

  it('AGT-042 rejects an unretrieved foreign physical field despite an admitted same-named qualified column', async () => {
    const admittedProductPrice: AgentEvidenceCandidate = {
      id: 'dbt:column:order_items.product_price',
      qualifiedId: 'order_items.product_price',
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: 'product_price',
      aliases: ['product price'],
      relevanceScore: 0.9,
      matchReasons: ['qualified physical output'],
      compatibility: 'compatible',
      sourceObjects: ['runtime:relation:order_items'],
    };
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const unretrievedId = 'other_items.product_price';
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: [revenue.id, unretrievedId],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id, unretrievedId],
          roleBindings: { metric: [revenue.id], categorical_dimension: [unretrievedId] },
          operations: ['aggregate', 'group'],
        }],
      }),
      getEvidence: async () => ({
        candidates: [revenue, admittedProductPrice],
        parsedIntent: { measures: ['revenue'], dimensions: ['product price'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product price', requestedMode: 'ask' });

    expect(decision.terminalOutcome?.code).toBe('ANALYTICAL_POLICY_BLOCKED');
    expect(decision.reason).toMatch(/valid selection from the 16-card package/i);
    expect(compilerBroker.decide).not.toHaveBeenCalled();
  });

  it('AGT-042 materializes a planner-qualified divergent candidate identity to its admitted local identity before compilation', async () => {
    // The planner card exposes the fully-qualified MetricFlow identity, but
    // the local snapshot retains a different stable storage ID. This is the
    // normal V3 handoff boundary: a qualified selection must resolve to this
    // one admitted card before the legacy compiler compatibility carrier is
    // built. It must not be treated as an unretrieved foreign candidate.
    const admittedRegion: AgentEvidenceCandidate = {
      id: 'semantic:dimension:orders.region',
      qualifiedId: 'semantic:uncategorized:dimension:orders.region',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'orders.region',
      aliases: ['region'],
      relevanceScore: 0.9,
      matchReasons: ['qualified semantic grouping dimension'],
      compatibility: 'compatible',
    };
    const revenueByRegion: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        dimensions: [{
          dimensionId: admittedRegion.qualifiedId!,
          entityId: 'semantic:entity:order',
          label: 'Region',
          aliases: ['region'],
          supportedRoles: ['group_by', 'display'],
        }],
        operations: ['filter', 'group'],
        supportedOutputKinds: ['metric_value', 'dimension'],
        resultGrainIds: ['semantic:entity:order'],
      },
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: async () => ({
        version: 1,
        selectedConceptIds: [revenueByRegion.qualifiedId!, admittedRegion.qualifiedId!],
        tasks: [{
          version: 1,
          taskId: 'task-1',
          selectedConceptIds: [revenueByRegion.qualifiedId!, admittedRegion.qualifiedId!],
          roleBindings: {
            metric: [revenueByRegion.qualifiedId!],
            categorical_dimension: [admittedRegion.qualifiedId!],
          },
          operations: ['aggregate', 'group', 'project'],
        }],
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot:qualified-divergent-region',
        candidates: [revenueByRegion, admittedRegion],
        parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by region', requestedMode: 'ask' });

    expect(decision.action).toBe('answer');
    // Program V3 retains the qualified identity that the planner saw.
    expect(decision.askAnalystDecision?.state.program.planner.tasks[0]?.selectedConceptIds)
      .toContain(admittedRegion.qualifiedId);
    // The compiler compatibility carrier is keyed by admitted local IDs.
    expect(decision.meaningResolution?.selectedConceptIds).toEqual(expect.arrayContaining([
      revenueByRegion.id,
      admittedRegion.id,
    ]));
    expect(decision.meaningResolution?.selectedConceptIds).not.toContain(admittedRegion.qualifiedId);
    expect(decision.askAnalystDecision?.taskExecutions?.[0]).toMatchObject({
      meaningResolution: {
        selectedConceptIds: expect.arrayContaining([
          revenueByRegion.id,
          admittedRegion.id,
        ]),
      },
      resolvedPlan: { planFrozen: true },
    });
  });

  it('AGT-042 rejects an unretrieved same-named semantic dimension from another model', async () => {
    const locationName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:locations.location_name',
      // This is the historical compact local-index representation. The
      // planner must not be allowed to turn a terminal-name match from an
      // unrelated model into this admitted card.
      qualifiedId: 'semantic:uncategorized:dimension:location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['region', 'location'], relevanceScore: 0.9,
      matchReasons: ['semantic dimension'], compatibility: 'compatible',
    };
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const unretrievedId = 'semantic:dimension:other.location_name';
    const planner = vi.fn(async () => ({
      version: 1 as const,
      selectedConceptIds: [revenue.id, unretrievedId],
      tasks: [{
        version: 1 as const,
        taskId: 'task-1',
        selectedConceptIds: [revenue.id, unretrievedId],
        roleBindings: { metric: [revenue.id], categorical_dimension: [unretrievedId] },
        operations: ['aggregate', 'group'] as const,
      }],
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => ({
        candidates: [revenue, locationName],
        parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by region', requestedMode: 'ask' });

    // An outside identity is a policy boundary, not malformed output that
    // merits a second provider continuation.
    expect(planner).toHaveBeenCalledTimes(1);
    expect(decision.terminalOutcome?.code).toBe('ANALYTICAL_POLICY_BLOCKED');
    expect(decision.reason).toMatch(/valid selection from the 16-card package/i);
    expect(compilerBroker.decide).not.toHaveBeenCalled();
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
      relationshipSafety: [{
        id: 'dql:relationship:customer_product',
        from: 'semantic:entity:customers.customer',
        to: 'semantic:entity:products.product',
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        status: 'certified', staleCertification: false, cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: true,
        certificationFingerprint: 'sha256:customer-product',
        validation: { status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z', queryFingerprint: 'sha256:customer-product-query', proofFingerprint: 'sha256:customer-product-proof' },
      }],
    };
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async (input) => {
        const pathCardId = input.plannerRequest.candidates.find((candidate) =>
          candidate.id.startsWith('dql:relationship_path:'))?.id ?? 'dql:relationship_path:missing';
        return {
          version: 1,
          selectedConceptIds: [revenue.id, region.id, pathCardId],
          tasks: [{
            version: 1,
            taskId: 'task-1',
            selectedConceptIds: [revenue.id, region.id, pathCardId],
            roleBindings: { metric: [revenue.id], categorical_dimension: [region.id], relationship: [pathCardId] },
            operations: ['aggregate', 'group'],
          }],
        };
      },
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

  it('AGT-036 retains an executable independent task when a sibling cannot compile', async () => {
    const unavailableBookedRevenue: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:orders.booked_revenue',
      qualifiedId: 'semantic:metric:orders.booked_revenue',
      name: 'orders.booked_revenue',
      aliases: ['booked revenue'],
      exactMatch: false,
      relevanceScore: 0.8,
      analyticalCapability: semanticCapability('semantic:metric:orders.booked_revenue'),
    };
    const compilerBroker = {
      decide: vi.fn(async () => semanticDecision()),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: async () => ({
        version: 1 as const,
        selectedConceptIds: [revenue.id, unavailableBookedRevenue.id],
        tasks: [revenue.id, unavailableBookedRevenue.id].map((metricId, index) => ({
          version: 1 as const,
          taskId: `task-${index + 1}`,
          selectedConceptIds: [metricId],
          roleBindings: { metric: [metricId] },
          operations: ['aggregate', 'project'] as const,
        })),
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot:compound-partial',
        candidates: [revenue, unavailableBookedRevenue],
        parsedIntent: { measures: ['revenue', 'booked revenue'], dimensions: [], filters: [] },
        diagnostics: {
          tierReadiness: {
            semanticCompiler: 'ready',
            physicalSchema: 'unavailable',
            semanticCandidateReadiness: [
              { candidateId: revenue.id, status: 'ready' as const },
              { candidateId: unavailableBookedRevenue.id, status: 'unavailable' as const },
            ],
          },
        },
      }),
    });

    const decision = await runtime.decide({
      question: 'show revenue; show booked revenue',
      requestedMode: 'ask',
    });

    expect(decision.action).toBe('answer');
    expect(decision.askAnalystDecision?.taskExecutions?.map((task) => task.taskId)).toEqual(['task-1']);
    expect(decision.askAnalystDecision?.taskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-2', status: 'gap', trustState: 'blocked' }),
    ]));
    // Compilation has an eligible task-1 program but no executed result.
    // The engine owns the first success receipt after the child checkpoint.
    expect(decision.askAnalystDecision?.taskOutcomeSummary).toMatchObject({
      status: 'blocked',
      trustState: 'blocked',
      successfulTaskIds: [],
      failedTaskIds: ['task-2'],
      dependencyBlockedTaskIds: [],
    });
    expect(decision.askAnalystDecision?.frozenPlan?.steps.map((step) => step.askAnalystTaskId)).toEqual(['task-1']);
    expect(compilerBroker.decide).not.toHaveBeenCalled();
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

  it('AGT-041 corrects one invalid planner response on the same immutable package before reporting validation', async () => {
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

    expect(planner).toHaveBeenCalledTimes(2);
    expect(planner.mock.calls[1]?.[0]).toMatchObject({
      feedback: { reasonCode: 'planner_output_invalid_retry' },
      plannerRequest: {
        planningMode: 'targeted_revision',
        // A malformed-output correction is not a hidden extension: the
        // provider sees the same original package, not a newly re-ranked set.
        candidates: [expect.objectContaining({ id: revenue.id })],
      },
    });
    expect(decision).toMatchObject({
      action: 'block',
      terminalOutcome: { kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP' },
      askAnalystDecision: {
        state: {
          planningReceipt: {
            mode: 'targeted_revision',
            plannerCalls: 2,
            revisionCalls: 1,
            verification: {
              status: 'invalid',
              missingRoles: [],
              reasonCode: 'planner_resolution_invalid',
            },
          },
          workspace: {
            tools: expect.arrayContaining([
              expect.objectContaining({ kind: 'provider_meaning', status: 'failed', reasonCode: 'planning.revision.failed' }),
            ]),
          },
        },
      },
    });
    expect(decision.providerFailure).toBeUndefined();
    expect(decision.reason).not.toMatch(/connection|sql execute/i);
  });

  it('AGT-041 sends a corrected valid proposal into the canonical semantic cascade', async () => {
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
    const planner = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        version: 1 as const,
        selectedConceptIds: [revenue.id],
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id],
          roleBindings: { metric: [revenue.id] },
          operations: ['aggregate', 'project'] as const,
        }],
      });
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:corrected-planner',
        candidates: [revenue, competingRevenue],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue', requestedMode: 'ask' });

    expect(planner).toHaveBeenCalledTimes(2);
    expect(planner.mock.calls[1]?.[0]).toMatchObject({
      feedback: { reasonCode: 'planner_output_invalid_retry' },
      plannerRequest: { planningMode: 'targeted_revision' },
    });
    expect(decision.action).toBe('answer');
    expect(decision.analyticalCascadeDecision).toMatchObject({ selectedTier: 'semantic', planFrozen: true });
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      mode: 'targeted_revision', plannerCalls: 2, revisionCalls: 1,
    });
  });

  it('AGT-041 keeps a same-snapshot role extension in the initial package while correcting malformed planner output once', async () => {
    const product = {
      id: 'semantic:dimension:products.product_name',
      qualifiedId: 'semantic:dimension:products.product_name',
      kind: 'semantic_member' as const,
      semanticObjectType: 'dimension' as const,
      trustTier: 'semantic' as const,
      name: 'Product name',
      aliases: ['product', 'product name'],
      relevanceScore: 0.01,
      matchReasons: ['same snapshot product grouping'],
      compatibility: 'compatible' as const,
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'product',
        metricId: revenue.id,
        dimensionId: 'semantic:dimension:products.product_name',
        basis: 'exact_metricflow_grouping_dimension',
      },
    } satisfies AgentEvidenceCandidate;
    const revenueByProduct: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:customers.customer',
        defaultResultGrainId: 'semantic:entity:customers.customer',
        resultGrainIds: ['semantic:entity:customers.customer'],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        dimensions: [{
          dimensionId: product.id,
          entityId: 'semantic:entity:products.product',
          label: 'Product name',
          aliases: ['product', 'product name'],
          supportedRoles: ['group_by'],
          nativeGroupingReference: 'product__product_name',
          nativeGroupingPath: ['product'],
        }],
      },
    };
    // A same-term metric competitor deliberately keeps this an ordinary
    // planner turn instead of taking the deterministic single-metric shortcut.
    const competingRevenue: AgentEvidenceCandidate = {
      ...revenueByProduct,
      id: 'semantic:metric:finance.revenue',
      qualifiedId: 'semantic:metric:finance.revenue',
      name: 'finance.revenue',
      aliases: ['revenue'],
      exactMatch: false,
      relevanceScore: 0.02,
    };
    // Exact but role-irrelevant cards model a crowded initial package. The
    // product grouping is low-relevance, but role-balanced admission must
    // reserve it before relevance fillers consume all 16 planner cards.
    const exactContext = Array.from({ length: 15 }, (_, index): AgentEvidenceCandidate => ({
      id: `dbt:model:context_${index}`,
      qualifiedId: `dbt:model:context_${index}`,
      kind: 'dbt_model',
      trustTier: 'exploratory',
      name: `Context ${index}`,
      relevanceScore: 0.99 - index / 100,
      exactMatch: true,
      matchReasons: ['exact non-role fixture'],
      compatibility: 'compatible',
    }));
    let initialCandidateIds: string[] = [];
    const planner = vi.fn(async (input: { plannerRequest: {
      planningMode: string;
      candidates: Array<{ id: string }>;
      targetedCandidates?: Array<{ id: string }>;
      verificationFeedback?: { reasonCode: string; missingRoles: string[] };
    } }) => {
      if (input.plannerRequest.planningMode === 'initial_planner') {
        initialCandidateIds = input.plannerRequest.candidates.map((candidate) => candidate.id);
        expect(initialCandidateIds).toHaveLength(16);
        expect(initialCandidateIds).toContain(revenueByProduct.id);
        expect(initialCandidateIds).toContain(product.id);
        // The transport completed, but its content is malformed. The host
        // gets one correction on this immutable, already role-complete
        // package; it must not create a second retrieval/extension loop.
        return undefined;
      }
      expect(input.plannerRequest.candidates.map((candidate) => candidate.id)).toEqual(initialCandidateIds);
      expect(input.plannerRequest.targetedCandidates).toBeUndefined();
      expect(input.plannerRequest.verificationFeedback).toMatchObject({
        reasonCode: 'planner_output_invalid_retry',
      });
      return {
        version: 1 as const,
        selectedConceptIds: [revenueByProduct.id, product.id],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [revenueByProduct.id, product.id],
          roleBindings: { metric: [revenueByProduct.id], categorical_dimension: [product.id] },
          operations: ['aggregate', 'group'] as const,
        }],
      };
    });
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:malformed-plus-targeted',
        candidates: [revenueByProduct, ...exactContext, competingRevenue, product],
        parsedIntent: { measures: ['revenue'], dimensions: ['product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product', requestedMode: 'ask' });

    expect(planner).toHaveBeenCalledTimes(2);
    expect(planner.mock.calls.map(([input]) => input.plannerRequest.planningMode)).toEqual([
      'initial_planner',
      'targeted_revision',
    ]);
    expect(decision).toMatchObject({
      action: 'answer',
      analyticalCascadeDecision: { selectedTier: 'semantic', planFrozen: true },
      askAnalystDecision: {
        state: {
          planningReceipt: { mode: 'targeted_revision', plannerCalls: 2, revisionCalls: 1 },
        },
      },
    });
    expect(decision.askAnalystDecision?.state.workspace.targetedContext).toBeUndefined();
  });

  it('AGT-034 excludes stale or mismatched same-snapshot extensions before planner admission and role coverage', async () => {
    const productDimensionId = 'semantic:dimension:products.product_name';
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        dimensions: [{
          dimensionId: productDimensionId,
          entityId: 'semantic:entity:products.product',
          label: 'Product name',
          aliases: ['product'],
          supportedRoles: ['group_by'],
          nativeGroupingReference: 'product__product_name',
          nativeGroupingPath: ['product'],
        }],
      },
    };
    const competitor: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:finance.revenue',
      qualifiedId: 'semantic:metric:finance.revenue',
      name: 'finance.revenue',
      aliases: ['revenue'],
      exactMatch: false,
      relevanceScore: 0.2,
      analyticalCapability: {
        ...metric.analyticalCapability!,
        metricId: 'semantic:metric:finance.revenue',
        measureIds: ['semantic:metric:finance.revenue:measure'],
      },
    };
    const extension = (id: string, overrides: Partial<NonNullable<AgentEvidenceCandidate['sameSnapshotRoleExtension']>> = {}): AgentEvidenceCandidate => ({
      id,
      qualifiedId: productDimensionId,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Product name',
      aliases: ['product'],
      relevanceScore: 0.9,
      matchReasons: ['untrusted persisted extension'],
      compatibility: 'compatible',
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'product',
        metricId: metric.analyticalCapability!.metricId,
        dimensionId: productDimensionId,
        basis: 'exact_metricflow_grouping_dimension',
        ...overrides,
      },
    });
    const invalidExtensions = [
      extension('semantic:extension:wrong_metric', { metricId: 'semantic:metric:stale.revenue' }),
      extension('semantic:extension:wrong_dimension', { dimensionId: 'semantic:dimension:other.product_name' }),
      extension('semantic:extension:wrong_basis', { basis: 'legacy_lexical_alias' as never }),
      { ...extension('semantic:extension:ineligible'), eligible: false },
    ];
    const plannerPackages: string[][] = [];
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: vi.fn(async ({ plannerRequest }) => {
        plannerPackages.push(plannerRequest.candidates.map((candidate) => candidate.id));
        return undefined;
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot:extension-proof-rejection',
        // The wrong-metric wrapper appears in the ordinary retrieval pool,
        // not only the clarification reserve. It must still be removed before
        // lexical role balancing can present it as Product to the planner.
        candidates: [metric, competitor, invalidExtensions[0]!],
        clarificationCandidates: invalidExtensions,
        parsedIntent: { measures: ['revenue'], dimensions: ['product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({ question: 'show revenue by product', requestedMode: 'ask' });

    expect(plannerPackages).not.toEqual([]);
    expect(plannerPackages.flat()).not.toEqual(expect.arrayContaining(invalidExtensions.map((candidate) => candidate.id)));
    expect(decision.askAnalystDecision?.state.workspace.roleCoverage
      ?.some((entry) => entry.role === 'categorical_dimension' && entry.candidateCount > 0)).toBe(false);
  });

  it('AGT-027/AGT-034 reserves a unique MetricFlow geography substitute and browser-selected customer path under the 16-card planner cap', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer', qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer', 'customer id'], relevanceScore: 0.91,
      matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.9,
      matchReasons: ['semantic display dimension'], compatibility: 'compatible',
    };
    const locationDimensionId = 'semantic:dimension:locations.location_name';
    // The snapshot does not expose a literal `region` field. It does expose
    // the selected metric's one authored geographic grouping, intentionally
    // low-ranked beneath 16 irrelevant context cards. Admission must retain
    // it as an explicit review-required substitute rather than issuing a
    // generic coverage gap.
    const locationName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:locations.location_name',
      qualifiedId: 'semantic:uncategorized:dimension:locations.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], relevanceScore: 0.12,
      matchReasons: ['semantic location dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const locationsModel: AgentEvidenceCandidate = {
      id: 'dbt:model:locations', qualifiedId: 'dbt:model:locations',
      kind: 'dbt_model', trustTier: 'exploratory', name: 'locations', aliases: ['location'], relevanceScore: 0.11,
      matchReasons: ['dbt manifest relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:locations'],
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      relevanceScore: 0.88,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:order_items.order_item',
        dimensions: [
          {
            dimensionId: customerName.id,
            entityId: customerKey.id,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['dql:relationship:order_to_customer'],
            nativeGroupingReference: 'customer__customer_name',
            nativeGroupingPath: ['customer'],
          },
          {
            dimensionId: locationDimensionId,
            entityId: 'semantic:entity:locations.location',
            label: 'Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['dql:relationship:order_to_location'],
            nativeGroupingReference: 'location__location_name',
            nativeGroupingPath: ['location'],
          },
        ],
      },
    };
    const competingMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:finance.revenue',
      qualifiedId: 'semantic:metric:finance.revenue',
      name: 'finance.revenue',
      relevanceScore: 0.87,
    };
    const relationship = (
      id: string,
      relevanceScore: number,
      keyCount: number,
      from: string,
      to: string,
    ): AgentEvidenceCandidate => ({
      id, qualifiedId: id, kind: 'dql_modeling', trustTier: 'governed_sql',
      name: id.replace('dql:relationship:', '').replaceAll('_', ' '), relevanceScore,
      matchReasons: ['safe authored relationship'], compatibility: 'compatible', relationshipEvidence: [id],
      relationshipSafety: [{
        id,
        from,
        to,
        keys: Array.from({ length: keyCount }, (_, index) => ({ from: `left_${index}`, to: `right_${index}` })),
        status: 'certified',
        staleCertification: false,
        cardinality: 'many_to_one',
        fanout: 'safe',
        automaticJoinAllowed: true,
        certificationFingerprint: `sha256:relationship:${id}`,
        validation: {
          status: 'passed',
          checkedAt: '2026-08-28T00:00:00.000Z',
          queryFingerprint: `sha256:query:${id}`,
          proofFingerprint: `sha256:proof:${id}`,
        },
      }],
    });
    const orderItemsToOrder = relationship(
      'dql:relationship:order_item_to_order',
      0.85,
      1,
      'semantic:entity:order_items.order_item',
      'semantic:entity:orders.order',
    );
    const orderToLocation = relationship(
      'dql:relationship:order_to_location',
      0.97,
      1,
      'semantic:entity:orders.order',
      'semantic:entity:locations.location',
    );
    // The higher-relevance distractor would consume the edge budget before
    // `order_to_customer` in the old relevance-only closure.
    const orderToStatus = relationship(
      'dql:relationship:order_to_status',
      0.99,
      1,
      'semantic:entity:orders.order',
      'semantic:entity:statuses.status',
    );
    const orderToCustomer = relationship(
      'dql:relationship:order_to_customer',
      0.6,
      2,
      'semantic:entity:orders.order',
      customerKey.id,
    );
    let plannerCandidates: readonly { id: string; relationHints?: string[]; relationshipProofClass?: string }[] = [];
    const planner = vi.fn(async (input: { plannerRequest: {
      frame: { requirements: { entityTerms: string[]; entityDisplayTerms: string[]; memberTerms: string[]; priorResultMemberBinding?: unknown } };
      candidates: readonly { id: string; relationHints?: string[]; relationshipProofClass?: string }[];
    } }) => {
      // The host predicate must not be included in provider planner context.
      expect(input.plannerRequest.frame.requirements).toMatchObject({
        entityTerms: expect.arrayContaining(['customer']),
        entityDisplayTerms: expect.arrayContaining(['customer name']),
      });
      expect(input.plannerRequest.frame.requirements.memberTerms).not.toContain('melissa davis');
      expect(input.plannerRequest.frame.requirements.priorResultMemberBinding).toBeUndefined();
      plannerCandidates = input.plannerRequest.candidates;
      const pathCardId = plannerCandidates.find((candidate) =>
        candidate.id.startsWith('dql:relationship_path:'))?.id ?? 'dql:relationship_path:missing';
      return {
        version: 1 as const,
        selectedConceptIds: [metric.id, customerKey.id, customerName.id, locationDimensionId, pathCardId],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [metric.id, customerKey.id, customerName.id, locationDimensionId, pathCardId],
          roleBindings: {
            metric: [metric.id],
            entity_key: [customerKey.id],
            entity_label: [customerName.id],
            categorical_dimension: [locationDimensionId],
            relationship: [pathCardId],
          },
          operations: ['aggregate', 'filter', 'group', 'project'] as const,
        }],
      };
    });
    // Fill the normal planner package to its cap. The closure can therefore
    // survive only when it is admitted as one atomic relationship-path card.
    const fillerContext = Array.from({ length: 16 }, (_, index): AgentEvidenceCandidate => ({
      id: `dbt:model:context_${index}`,
      qualifiedId: `dbt:model:context_${index}`,
      kind: 'dbt_model',
      trustTier: 'exploratory',
      name: `Context ${index}`,
      aliases: [`context ${index}`],
      relevanceScore: 0.98 - index / 1000,
      matchReasons: ['retrieved context'],
      compatibility: 'compatible',
    }));
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:prior-customer-region',
        candidates: [
          metric,
          competingMetric,
          customerKey,
          customerName,
          locationName,
          locationsModel,
          orderToStatus,
          orderToLocation,
          orderItemsToOrder,
          orderToCustomer,
          ...fillerContext,
        ],
        parsedIntent: { measures: [], dimensions: ['region'], filters: [] },
      }),
    });
    const question = 'Show revenue by region for her.';
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name',
      values: ['Melissa Davis'],
      sourceTurnId: 'run:top-customers',
      resultFingerprint: 'a'.repeat(64),
    };
    const decision = await runtime.decide({
      question,
      requestedMode: 'ask',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question,
        parsedIntent: { measures: ['billing revenue'], dimensions: ['region'], filters: [] },
        priorResultMemberBinding,
      }),
    });

    expect(planner).toHaveBeenCalledTimes(1);
    // The planner sees one host-owned path unit, not individually capped
    // relationship cards. Its edge proof must remain whole even under a
    // filled 16-card package.
    expect(plannerCandidates).toHaveLength(16);
    // The planner must receive the executable authored child, not a lexical
    // `region` alias or a dropped low-relevance location card.
    expect(plannerCandidates.map((candidate) => candidate.id)).toContain(locationDimensionId);
    const pathCard = plannerCandidates.find((candidate) => candidate.id.startsWith('dql:relationship_path:'));
    expect(pathCard?.relationshipProofClass).toBe('governed');
    expect(pathCard?.relationHints).toEqual(expect.arrayContaining([
      orderItemsToOrder.id,
      orderToCustomer.id,
      orderToLocation.id,
    ]));
    expect(plannerCandidates
      .filter((candidate) => [orderItemsToOrder.id, orderToCustomer.id, orderToLocation.id].includes(candidate.id)))
      .toEqual([]);
    expect(decision.askAnalystDecision?.state.frame).toMatchObject({
      conversation: { binding: 'prior_result' },
      requirements: {
        entityTerms: expect.arrayContaining(['Customer']),
        entityDisplayTerms: expect.arrayContaining(['Customer Name']),
        priorResultMemberBinding: {
          displayDimension: 'customer_name', values: ['Melissa Davis'], sourceTurnId: 'run:top-customers',
        },
      },
    });
    expect(decision.askAnalystDecision?.state.program.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldTerms: expect.arrayContaining(['customer_name']), value: 'Melissa Davis' }),
    ]));
    expect(decision.askAnalystDecision?.state.program.executionCandidateIds).toEqual(expect.arrayContaining([
      orderItemsToOrder.id,
      orderToCustomer.id,
      orderToLocation.id,
      locationsModel.id,
    ]));
    expect(decision.askAnalystDecision?.state.program.executionCandidateIds).not.toContain(orderToStatus.id);
    // The inferred grouping is capability-qualified, so the canonical
    // cascade freezes semantic execution rather than becoming a 0-attempt
    // generic coverage gap or an unfiltered warehouse question.
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'semantic',
      planFrozen: true,
      attempts: [
        expect.objectContaining({ tier: 'certified', outcome: 'unavailable', planFrozen: false }),
        expect.objectContaining({ tier: 'semantic', outcome: 'executable', planFrozen: true }),
      ],
    });
    expect(decision.askAnalystDecision?.state.workspace.roleCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'categorical_dimension', candidateCount: expect.any(Number) }),
    ]));
    expect(decision.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({ reviewRequired: true });
    // The meaning receipt retains the stable source ID while the frozen
    // capability/plan uses the qualified MetricFlow identity above.
    expect(decision.meaningResolution?.selectedConceptIds).toContain(locationName.id);
  });

  it('AGT-034 carries a unique ordinary location substitute through one malformed-plan correction and the full safe relationship path', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer', qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer', 'customer id'], relevanceScore: 0.98,
      matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.97,
      matchReasons: ['semantic display dimension'], compatibility: 'compatible',
    };
    // This reproduces the live index shape: it is a qualified, ordinary
    // dimension (not a specially-tagged same-snapshot extension) and it is
    // low relevance behind enough context to have been dropped by role_cap.
    const locationName: AgentEvidenceCandidate = {
      // The live provider returned this canonical MetricFlow identity even
      // though the bounded planner card exposed the stable uncategorized ID.
      // The runtime may adapt that one unique semantic-dimension identity;
      // it must not perform a broad lexical alias lookup.
      id: 'semantic:dimension:locations.location_name',
      qualifiedId: 'semantic:uncategorized:dimension:location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], relevanceScore: 0.1,
      matchReasons: ['semantic uncategorized dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    // The historical failure let this high-relevance semantic model impersonate
    // a categorical field because legacy indexes use `semantic_member` for
    // both shapes. It is execution context only.
    const customersModel: AgentEvidenceCandidate = {
      id: 'semantic:model:customers', qualifiedId: 'semantic:model:customers',
      kind: 'semantic_member', semanticObjectType: 'model', trustTier: 'semantic',
      name: 'customers', aliases: ['customers'], relevanceScore: 0.99,
      matchReasons: ['semantic model'], compatibility: 'compatible',
    };
    const locationsModel: AgentEvidenceCandidate = {
      id: 'semantic:model:locations', qualifiedId: 'semantic:model:locations',
      kind: 'semantic_member', semanticObjectType: 'model', trustTier: 'semantic',
      name: 'locations', aliases: ['locations'], relevanceScore: 0.96,
      matchReasons: ['semantic model'], compatibility: 'compatible',
    };
    const countryName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:locations.country_name', qualifiedId: 'semantic:dimension:locations.country_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Country Name', aliases: ['country'], relevanceScore: 0.09,
      matchReasons: ['semantic country dimension'], compatibility: 'compatible',
    };
    // The live failure retained an ordinary semantic time field beside
    // Location Name. It must remain a time role even though older index rows
    // represent both as `semantic_member` / `dimension`.
    const openedDate: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:opened_date',
      qualifiedId: 'semantic:uncategorized:dimension:opened_date',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Opened Date', aliases: ['opened date'], dataType: 'timestamp', timeGrains: ['day'], relevanceScore: 0.095,
      // Reproduce stale authored metadata from a migrated index. The typed
      // timestamp remains time-only and cannot create a false `region`
      // alternative under the 16-card cap.
      compatibilityFacts: ['roles categorical dimension'],
      matchReasons: ['semantic time dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      relevanceScore: 0.95,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:orders.order',
        dimensions: [
          {
            dimensionId: customerName.id,
            entityId: customerKey.id,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['commerce::relationship::order_to_customer'],
            nativeGroupingReference: 'customer__customer_name',
            nativeGroupingPath: ['customer'],
          },
          {
            dimensionId: locationName.id,
            entityId: 'semantic:entity:locations.location',
            label: 'Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['commerce::relationship::order_to_location'],
            nativeGroupingReference: 'location__location_name',
            nativeGroupingPath: ['location'],
          },
          // A second geography-capable child prevents the existing narrow
          // sole-MetricFlow extension from pre-authorizing location_name.
          // The planner must choose it from the ordinary role reservation.
          {
            dimensionId: countryName.id,
            entityId: 'semantic:entity:locations.location',
            label: 'Country Name', aliases: ['country'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['commerce::relationship::order_to_location'],
            nativeGroupingReference: 'location__country_name',
            nativeGroupingPath: ['location'],
          },
        ],
      },
    };
    const relationship = (
      id: string,
      from: string,
      to: string,
      relevanceScore: number,
    ): AgentEvidenceCandidate => ({
      id, qualifiedId: id, kind: 'dql_modeling', trustTier: 'governed_sql',
      name: id.replace('commerce::relationship::', '').replaceAll('_', ' '),
      aliases: [], relevanceScore, matchReasons: ['safe relationship'], compatibility: 'compatible',
      relationshipEvidence: [id],
      relationshipSafety: [{
        id, from, to, keys: [{ from: 'id', to: 'id' }],
        status: 'certified', staleCertification: false, cardinality: 'many_to_one',
        fanout: 'safe', automaticJoinAllowed: true,
        certificationFingerprint: `sha256:${id}`,
        validation: {
          status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z',
          queryFingerprint: `sha256:query:${id}`, proofFingerprint: `sha256:proof:${id}`,
        },
      }],
    });
    const orderToCustomer = relationship(
      'commerce::relationship::order_to_customer',
      'semantic:entity:orders.order',
      customerKey.id,
      0.92,
    );
    const orderToLocation = relationship(
      'commerce::relationship::order_to_location',
      'semantic:entity:orders.order',
      'semantic:entity:locations.location',
      0.91,
    );
    const fillerContext = Array.from({ length: 16 }, (_, index): AgentEvidenceCandidate => ({
      id: `dbt:model:role_cap_context_${index}`,
      qualifiedId: `dbt:model:role_cap_context_${index}`,
      kind: 'dbt_model', trustTier: 'exploratory', name: `Context ${index}`,
      aliases: [`context ${index}`], relevanceScore: 0.94 - index / 1_000,
      matchReasons: ['live trace role_cap filler'], compatibility: 'compatible',
    }));
    let plannerCards: readonly {
      id: string;
      roles: readonly string[];
      admissionReasonCode?: string;
      unresolvedRoles?: readonly string[];
      relationHints?: readonly string[];
    }[] = [];
    let plannerCalls = 0;
    const planner = vi.fn(async (input: { plannerRequest: {
      candidates: typeof plannerCards;
      planningMode: string;
      verificationFeedback?: { reasonCode: string };
      targetedCandidates?: readonly unknown[];
    } }) => {
      plannerCalls += 1;
      plannerCards = input.plannerRequest.candidates;
      // Reproduce the captured run: the first provider response was empty,
      // then the one bounded malformed-output correction received the same
      // immutable 16-card package. A unique inferred location must prevent a
      // separate targeted-context turn for a role already present.
      if (plannerCalls === 1) return undefined;
      expect(input.plannerRequest.planningMode).toBe('targeted_revision');
      expect(input.plannerRequest.verificationFeedback?.reasonCode).toBe('planner_output_invalid_retry');
      expect(input.plannerRequest.targetedCandidates).toBeUndefined();
      const pathCardId = plannerCards.find((candidate) => candidate.id.startsWith('dql:relationship_path:'))?.id;
      expect(pathCardId).toBeDefined();
      return {
        version: 1 as const,
        // The provider selects business meaning only.  It must not need to
        // choose a relationship path: the authoritative host derives a
        // complete safe path from the frozen same-snapshot closure after this
        // verification succeeds.
        selectedConceptIds: [metric.id, customerKey.id, customerName.id, locationName.id],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [metric.id, customerKey.id, customerName.id, locationName.id],
          roleBindings: {
            metric: [metric.id],
            entity_key: [customerKey.id],
            entity_label: [customerName.id],
            categorical_dimension: [locationName.id],
          },
          operations: ['aggregate', 'filter', 'group', 'project'] as const,
        }],
      };
    });
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name',
      values: ['Brittany Barrera'],
      sourceTurnId: 'run:990dffed',
      resultFingerprint: 'b'.repeat(64),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:654155-live-replay',
        candidates: [
          metric, customerKey, customerName, locationName, openedDate,
          customersModel, locationsModel, orderToCustomer, orderToLocation,
          ...fillerContext,
        ],
        parsedIntent: { measures: ['billing revenue'], dimensions: ['region'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'Which region is Brittany Barrera in by revenue?',
      requestedMode: 'ask',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      // A local host produced this shape-only anchor from a completed prior
      // result.  It is not a provider-selected meaning and must survive the
      // V3 handoff independently of the member filter below.
      trustedTaskAnchor: {
        version: 1,
        kind: 'analytical_shape',
        values: [],
        measures: ['billing revenue'],
        dimensions: ['customer_name', 'region'],
        sourceTurnId: 'turn:top-customers',
        resultFingerprint: 'a'.repeat(64),
      },
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question: 'Which region is Brittany Barrera in by revenue?',
        parsedIntent: { measures: ['billing revenue'], dimensions: ['region'], filters: [] },
        priorResultMemberBinding,
      }),
    });

    expect(evidenceCandidateRoles(customersModel)).not.toContain('categorical_dimension');
    expect(evidenceCandidateRoles(openedDate)).toContain('time_dimension');
    expect(evidenceCandidateRoles(openedDate)).not.toContain('categorical_dimension');
    expect(planner).toHaveBeenCalledTimes(2);
    expect(plannerCards).toHaveLength(16);
    // The verified frame now carries the host-owned inferred substitution as
    // a review-required semantic output, rather than returning to the stale
    // lexical `region` phrase after the task binding was accepted.
    expect(decision.askAnalystDecision?.state.frame.requirements.dimensions)
      .toContain('Location Name');
    const locationCard = plannerCards.find((candidate) => candidate.id === locationName.qualifiedId);
    expect(locationCard).toMatchObject({
      roles: expect.arrayContaining(['categorical_dimension']),
    });
    expect(plannerCards.find((candidate) => candidate.id === openedDate.id)?.roles ?? [])
      .not.toContain('categorical_dimension');
    const customersModelCard = plannerCards.find((candidate) => candidate.id === customersModel.id);
    expect(customersModelCard?.roles).not.toContain('categorical_dimension');
    expect(customersModelCard?.admissionReasonCode).toBeUndefined();
    const pathCard = plannerCards.find((candidate) => candidate.id.startsWith('dql:relationship_path:'));
    expect(pathCard?.relationHints).toEqual(expect.arrayContaining([
      orderToCustomer.id,
      orderToLocation.id,
    ]));
    expect(decision.askAnalystDecision?.state.workspace.roleCoverage).toEqual(expect.arrayContaining([
      // `Opened Date` is present in the 16-card snapshot but typed as time,
      // so it cannot inflate the geographical role. The one remaining
      // Location Name candidate is a recorded inferred substitution: it can
      // be verified/executed, but its frozen plan remains review-required.
      expect.objectContaining({ role: 'categorical_dimension', candidateCount: 1, state: 'proven' }),
    ]));
    expect(decision.askAnalystDecision?.state.program.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldTerms: expect.arrayContaining(['customer_name']), value: 'Brittany Barrera' }),
    ]));
    expect(decision.askAnalystDecision?.state.program.relationshipRequirements).toEqual(expect.arrayContaining([
      orderToCustomer.id,
      orderToLocation.id,
    ]));
    // AGT-034 / AGT-050: the verified handoff must carry the host-owned
    // selected ordinary dimension and its one atomic path into the exact
    // program the compiler receives. The provider does not bind a join path;
    // it is a canonical host receipt so no raw relationship edge may reappear
    // in the planner receipt after the 16-card role-cap pressure.
    expect(decision.askAnalystDecision?.state.program.candidateIds).toEqual(expect.arrayContaining([
      locationName.qualifiedId,
      pathCard!.id,
    ]));
    expect(decision.askAnalystDecision?.state.program).toMatchObject({
      version: 3,
      relationshipPaths: [expect.objectContaining({
        candidateId: pathCard!.id,
        relationshipEvidence: expect.arrayContaining([
          orderToCustomer.id,
          orderToLocation.id,
        ]),
      })],
      // A V3 program retains current-turn/filter atoms and the host-validated
      // successful-task anchor independently of planner/legacy resolution.
      inputAtoms: expect.arrayContaining([
        expect.objectContaining({ role: 'filter', term: 'customer_name', source: 'current_question' }),
        expect.objectContaining({ role: 'filter', term: 'Brittany Barrera', source: 'current_question' }),
      ]),
      trustedTaskAnchors: expect.arrayContaining([expect.objectContaining({
        displayDimension: 'customer_name',
        values: ['Brittany Barrera'],
        sourceTurnId: 'run:990dffed',
      }), expect.objectContaining({
        kind: 'analytical_shape',
        values: [],
        measures: ['billing revenue'],
        dimensions: ['customer_name', 'region'],
        sourceTurnId: 'turn:top-customers',
        resultFingerprint: 'a'.repeat(64),
      })]),
    });
    expect(decision.askAnalystDecision?.state.program.planner.tasks[0]?.roleBindings).toMatchObject({
      categorical_dimension: expect.arrayContaining([locationName.qualifiedId]),
    });
    expect(decision.askAnalystDecision?.state.program.planner.tasks[0]?.roleBindings.relationship).toBeUndefined();
    // The compiler consumes the materialized program and freezes the
    // semantic execution plan. The broker envelope can omit its legacy
    // cascade receipt, so assert the canonical frozen plan carried by the
    // Ask runtime rather than a compatibility-only outer field.
    expect(decision.askAnalystDecision?.state.resolvedPlan).toMatchObject({
      compiler: 'metricflow', planFrozen: true, reviewRequired: true,
    });
    expect(decision.askAnalystDecision?.state.planningReceipt?.verification.reasonCode)
      .not.toBe('ordinary_role_inference_ambiguous');
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      plannerCalls: 2,
      revisionCalls: 1,
      verification: { status: 'valid' },
    });
    expect(decision.resolvedAnalyticalPlan).toMatchObject({ capability: 'semantic_execution' });
  });

  it('AGT-049 reports a typed relationship coverage gap instead of offering cross-entity ordinary geography fields when every bridge is denied', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer', qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer', 'customer id'], relevanceScore: 0.92,
      matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.91,
      matchReasons: ['semantic display dimension'], compatibility: 'compatible',
    };
    const locationName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:locations.location_name',
      qualifiedId: 'semantic:uncategorized:dimension:locations.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], relevanceScore: 0.3,
      matchReasons: ['ordinary qualified location dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const countryName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:locations.country_name',
      qualifiedId: 'semantic:uncategorized:dimension:locations.country_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Country Name', aliases: ['country'], relevanceScore: 0.29,
      matchReasons: ['ordinary qualified country dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      relevanceScore: 0.95,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:orders.order',
        dimensions: [
          {
            dimensionId: customerName.id, entityId: customerKey.id,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['dql:relationship:customer_to_location_denied'],
            nativeGroupingReference: 'customer__customer_name', nativeGroupingPath: ['customer'],
          },
          {
            dimensionId: locationName.id, entityId: 'semantic:entity:locations.location',
            label: 'Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display'],
            relationshipPathIds: ['dql:relationship:customer_to_location_denied'],
            nativeGroupingReference: 'location__location_name', nativeGroupingPath: ['location'],
          },
          {
            dimensionId: countryName.id, entityId: 'semantic:entity:locations.location',
            label: 'Country Name', aliases: ['country'],
            supportedRoles: ['group_by', 'display'],
            relationshipPathIds: ['dql:relationship:customer_to_location_denied'],
            nativeGroupingReference: 'location__country_name', nativeGroupingPath: ['location'],
          },
        ],
      },
    };
    // This card has a relationship-shaped name and complete endpoint data,
    // but policy explicitly denies automatic use. It must improve neither
    // ordinary-role reachability nor the planner's apparent geography choices.
    const deniedRelationship: AgentEvidenceCandidate = {
      id: 'dql:relationship:customer_to_location_denied',
      qualifiedId: 'dql:relationship:customer_to_location_denied',
      kind: 'dql_modeling', trustTier: 'governed_sql', name: 'customer to location denied',
      aliases: ['customer location relationship'], relevanceScore: 0.99,
      matchReasons: ['denied relationship evidence'], compatibility: 'compatible',
      relationshipEvidence: ['dql:relationship:customer_to_location_denied'],
      relationshipSafety: [{
        id: 'dql:relationship:customer_to_location_denied',
        from: customerKey.id,
        to: 'semantic:entity:locations.location',
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        status: 'certified', staleCertification: false, cardinality: 'many_to_one',
        fanout: 'safe', automaticJoinAllowed: false,
        certificationFingerprint: 'sha256:denied-customer-location',
        validation: {
          status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z',
          queryFingerprint: 'sha256:query:denied-customer-location',
          proofFingerprint: 'sha256:proof:denied-customer-location',
        },
      }],
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:ordinary-role-unsafe-relationship',
      candidates: [metric, customerKey, customerName, locationName, countryName, deniedRelationship],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
    };
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => evidence,
    });
    const question = 'Which region does customer Brittany Barrera belong to by revenue?';
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name',
      values: ['Brittany Barrera'],
      sourceTurnId: 'run:ordinary-role-unsafe-relationship',
      resultFingerprint: 'd'.repeat(64),
    };

    const decision = await runtime.decide({
      question,
      requestedMode: 'ask',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question,
        parsedIntent: evidence.parsedIntent,
        priorResultMemberBinding,
      }),
    });

    expect(decision).toMatchObject({
      action: 'block',
      terminalOutcome: { code: 'ANALYTICAL_MODELING_GAP' },
    });
    expect(decision.reason).toContain('no complete safe relationship path');
    expect(decision.clarificationOptions ?? []).toEqual([]);
    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.analyticalCascadeDecision).toBeUndefined();
    expect(decision.askAnalystDecision?.taskExecutions).toBeUndefined();
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds).not.toContain(locationName.id);
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds).not.toContain(countryName.id);
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      plannerCalls: 0,
      revisionCalls: 0,
      verification: {
        status: 'invalid',
        missingRoles: ['relationship'],
        reasonCode: 'ordinary_role_relationship_unproven',
      },
    });
  });

  it('AGT-049 rejects a candidate-local customer-to-location bridge when the metric primary order entity is not connected', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer', qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer', 'customer id'], relevanceScore: 0.92,
      matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.91,
      matchReasons: ['semantic display dimension'], compatibility: 'compatible',
    };
    const locationName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:locations.location_name',
      qualifiedId: 'semantic:uncategorized:dimension:locations.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], relevanceScore: 0.3,
      matchReasons: ['ordinary qualified location dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const countryName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:locations.country_name',
      qualifiedId: 'semantic:uncategorized:dimension:locations.country_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Country Name', aliases: ['country'], relevanceScore: 0.29,
      matchReasons: ['ordinary qualified country dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const partialPathId = 'dql:relationship:customer_to_location_only';
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      relevanceScore: 0.95,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:orders.order',
        dimensions: [
          {
            dimensionId: customerName.id, entityId: customerKey.id,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: [partialPathId],
            nativeGroupingReference: 'customer__customer_name', nativeGroupingPath: ['customer'],
          },
          {
            dimensionId: locationName.id, entityId: 'semantic:entity:locations.location',
            label: 'Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display'],
            relationshipPathIds: [partialPathId],
            nativeGroupingReference: 'location__location_name', nativeGroupingPath: ['location'],
          },
          {
            dimensionId: countryName.id, entityId: 'semantic:entity:locations.location',
            label: 'Country Name', aliases: ['country'],
            supportedRoles: ['group_by', 'display'],
            relationshipPathIds: [partialPathId],
            nativeGroupingReference: 'location__country_name', nativeGroupingPath: ['location'],
          },
        ],
      },
    };
    // This edge is fully certified and safe, but it cannot close the route
    // from the metric's `orders` primary entity. Candidate-local reachability
    // from customer to location must not turn it into a clarification choice.
    const customerToLocationOnly: AgentEvidenceCandidate = {
      id: partialPathId, qualifiedId: partialPathId,
      kind: 'dql_modeling', trustTier: 'governed_sql', name: 'customer to location',
      aliases: ['customer location relationship'], relevanceScore: 0.99,
      matchReasons: ['safe but partial relationship evidence'], compatibility: 'compatible',
      relationshipEvidence: [partialPathId],
      relationshipSafety: [{
        id: partialPathId,
        from: customerKey.id,
        to: 'semantic:entity:locations.location',
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        status: 'certified', staleCertification: false, cardinality: 'many_to_one',
        fanout: 'safe', automaticJoinAllowed: true,
        certificationFingerprint: 'sha256:customer-to-location-only',
        validation: {
          status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z',
          queryFingerprint: 'sha256:query:customer-to-location-only',
          proofFingerprint: 'sha256:proof:customer-to-location-only',
        },
      }],
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:ordinary-role-partial-closure',
      candidates: [metric, customerKey, customerName, locationName, countryName, customerToLocationOnly],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
    };
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => evidence,
    });
    const question = 'Which region does customer Brittany Barrera belong to by revenue?';
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name',
      values: ['Brittany Barrera'],
      sourceTurnId: 'run:ordinary-role-partial-closure',
      resultFingerprint: 'e'.repeat(64),
    };

    const decision = await runtime.decide({
      question,
      requestedMode: 'ask',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question,
        parsedIntent: evidence.parsedIntent,
        priorResultMemberBinding,
      }),
    });

    expect(decision).toMatchObject({
      action: 'block',
      terminalOutcome: { code: 'ANALYTICAL_MODELING_GAP' },
    });
    expect(decision.reason).toContain('no complete safe relationship path');
    expect(decision.clarificationOptions ?? []).toEqual([]);
    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.analyticalCascadeDecision).toBeUndefined();
    expect(decision.askAnalystDecision?.taskExecutions).toBeUndefined();
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      plannerCalls: 0,
      verification: {
        status: 'invalid',
        missingRoles: ['relationship'],
        reasonCode: 'ordinary_role_relationship_unproven',
      },
    });
  });

  it('AGT-049 permits a canonically same-entity ordinary field without a relationship closure', async () => {
    const customerEntityId = 'semantic:entity:customers.customer';
    const customerKey: AgentEvidenceCandidate = {
      id: customerEntityId, qualifiedId: customerEntityId,
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer'], primaryEntity: customerEntityId,
      relevanceScore: 0.93, matchReasons: ['canonical semantic customer entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], primaryEntity: customerEntityId,
      relevanceScore: 0.92, matchReasons: ['canonical semantic customer display'], compatibility: 'compatible',
    };
    // `Location Name` is deliberately not an alias for `region`; it remains
    // an inferred review-required output. Its source-authored primaryEntity
    // nevertheless proves it is a field of the already-bound customer grain,
    // so no relationship path is required.
    const locationName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.location_name', qualifiedId: 'semantic:dimension:customers.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], primaryEntity: customerEntityId,
      relevanceScore: 0.4, matchReasons: ['ordinary canonical customer location dimension'], compatibility: 'compatible',
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: customerEntityId,
        dimensions: [
          {
            dimensionId: customerName.id, entityId: customerEntityId,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            nativeGroupingReference: 'customer__customer_name', nativeGroupingPath: ['customer'],
          },
          {
            dimensionId: locationName.id, entityId: customerEntityId,
            label: 'Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display'],
            nativeGroupingReference: 'customer__location_name', nativeGroupingPath: ['customer'],
          },
        ],
      },
    };
    const planner = vi.fn(async () => ({
      version: 1 as const,
      selectedConceptIds: [metric.id, customerKey.id, customerName.id, locationName.id],
      confidence: 'high' as const,
      tasks: [{
        version: 1 as const,
        taskId: 'task-1',
        selectedConceptIds: [metric.id, customerKey.id, customerName.id, locationName.id],
        roleBindings: {
          metric: [metric.id],
          entity_key: [customerKey.id],
          entity_label: [customerName.id],
          categorical_dimension: [locationName.id],
        },
        operations: ['aggregate', 'group', 'project'] as const,
      }],
    }));
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:ordinary-role-same-entity',
      candidates: [metric, customerKey, customerName, locationName],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
    };
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name', values: ['Brittany Barrera'],
      sourceTurnId: 'run:ordinary-role-same-entity', resultFingerprint: 'f'.repeat(64),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => evidence,
    });

    const decision = await runtime.decide({
      question: 'Which region does customer Brittany Barrera belong to by revenue?',
      requestedMode: 'ask',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question: 'Which region does customer Brittany Barrera belong to by revenue?',
        parsedIntent: evidence.parsedIntent,
        priorResultMemberBinding,
      }),
    });

    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ action: 'answer' });
    expect(decision.analyticalCascadeDecision).toMatchObject({ selectedTier: 'semantic', planFrozen: true });
    expect(decision.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({ reviewRequired: true });
  });

  it('AGT-049 does not treat incidental customer words in an ordinary field identity as same-entity proof', async () => {
    const customerEntityId = 'semantic:entity:customers.customer';
    const locationEntityId = 'semantic:entity:locations.location';
    const customerKey: AgentEvidenceCandidate = {
      id: customerEntityId, qualifiedId: customerEntityId,
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer'], relevanceScore: 0.93,
      matchReasons: ['canonical semantic customer entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.92,
      matchReasons: ['canonical semantic customer display'], compatibility: 'compatible',
    };
    // These cards intentionally contain `customer` in every legacy text
    // carrier. None supplies primaryEntity, endpoint, or an exact source
    // relation of `customers`, so they must remain cross-entity and cannot
    // bypass the missing orders -> location closure.
    const incidentalLocation: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:customer_notes.location_name',
      qualifiedId: 'semantic:uncategorized:dimension:customer_notes.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Location Note', aliases: ['customer location'], relevanceScore: 0.4,
      matchReasons: ['ordinary qualified geographic field'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:customer_notes'],
    };
    const incidentalCountry: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:customer_notes.country_name',
      qualifiedId: 'semantic:uncategorized:dimension:customer_notes.country_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Country Note', aliases: ['customer country'], relevanceScore: 0.39,
      matchReasons: ['ordinary qualified geographic field'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:customer_notes'],
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:orders.order',
        dimensions: [
          {
            dimensionId: customerName.id, entityId: customerEntityId,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            nativeGroupingReference: 'customer__customer_name', nativeGroupingPath: ['customer'],
          },
          {
            dimensionId: incidentalLocation.id, entityId: locationEntityId,
            label: 'Customer Location Note', aliases: ['customer location'],
            supportedRoles: ['group_by', 'display'],
            nativeGroupingReference: 'location__location_name', nativeGroupingPath: ['location'],
          },
          {
            dimensionId: incidentalCountry.id, entityId: locationEntityId,
            label: 'Customer Country Note', aliases: ['customer country'],
            supportedRoles: ['group_by', 'display'],
            nativeGroupingReference: 'location__country_name', nativeGroupingPath: ['location'],
          },
        ],
      },
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:ordinary-role-incidental-customer',
      candidates: [metric, customerKey, customerName, incidentalLocation, incidentalCountry],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
    };
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => evidence,
    });
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name', values: ['Brittany Barrera'],
      sourceTurnId: 'run:ordinary-role-incidental-customer', resultFingerprint: 'a'.repeat(64),
    };

    const decision = await runtime.decide({
      question: 'Which region does customer Brittany Barrera belong to by revenue?',
      requestedMode: 'ask',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question: 'Which region does customer Brittany Barrera belong to by revenue?',
        parsedIntent: evidence.parsedIntent,
        priorResultMemberBinding,
      }),
    });

    expect(decision).toMatchObject({ action: 'block', terminalOutcome: { code: 'ANALYTICAL_MODELING_GAP' } });
    expect(decision.clarificationOptions ?? []).toEqual([]);
    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.askAnalystDecision?.taskExecutions).toBeUndefined();
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      plannerCalls: 0,
      verification: { reasonCode: 'ordinary_role_relationship_unproven' },
    });
  });

  it('AGT-049 keeps package-qualified customer identities distinct when duplicate relation leaves lack a safe closure', async () => {
    const billingCustomerId = 'semantic:entity:billing.customer';
    const crmCustomerId = 'semantic:entity:crm.customer';
    const billingCustomer: AgentEvidenceCandidate = {
      id: billingCustomerId, qualifiedId: billingCustomerId,
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Billing Customer', aliases: ['customer'], primaryEntity: billingCustomerId,
      relevanceScore: 0.94, matchReasons: ['selected billing customer entity'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_a.customer'],
    };
    const billingCustomerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:billing.customer_name', qualifiedId: 'semantic:dimension:billing.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], primaryEntity: billingCustomerId,
      relevanceScore: 0.93, matchReasons: ['billing customer display'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_a.customer'],
    };
    // This is a separate structured entity/relation even though its terminal
    // identifier is also `customer`. It is intentionally not selected by the
    // metric capability for this Ask turn.
    const crmCustomer: AgentEvidenceCandidate = {
      id: crmCustomerId, qualifiedId: crmCustomerId,
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'CRM Customer', aliases: ['customer'], primaryEntity: crmCustomerId,
      relevanceScore: 0.92, matchReasons: ['unrelated crm customer entity'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_b.customer'],
    };
    const crmLocation: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:crm.location_name',
      qualifiedId: 'semantic:uncategorized:dimension:crm.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], primaryEntity: crmCustomerId,
      relevanceScore: 0.4, matchReasons: ['ordinary crm location field'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_b.customer'],
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:orders.order',
        dimensions: [{
          dimensionId: billingCustomerName.id, entityId: billingCustomerId,
          label: 'Customer Name', aliases: ['customer', 'customer name'],
          supportedRoles: ['group_by', 'display', 'filter'],
          nativeGroupingReference: 'billing_customer__customer_name', nativeGroupingPath: ['billing_customer'],
        }],
      },
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:namespace-collision-gap',
      candidates: [metric, billingCustomer, billingCustomerName, crmCustomer, crmLocation],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
    };
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const priorResultMemberBinding = {
      version: 1 as const, displayDimension: 'customer_name', values: ['Brittany Barrera'],
      sourceTurnId: 'run:namespace-collision-gap', resultFingerprint: 'c'.repeat(64),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker, planAnalytical: planner, getEvidence: async () => evidence,
    });

    const decision = await runtime.decide({
      question: 'Which region does customer Brittany Barrera belong to by revenue?',
      requestedMode: 'ask', conversationBinding: 'prior_result', priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question: 'Which region does customer Brittany Barrera belong to by revenue?',
        parsedIntent: evidence.parsedIntent, priorResultMemberBinding,
      }),
    });

    expect(decision).toMatchObject({ action: 'block', terminalOutcome: { code: 'ANALYTICAL_MODELING_GAP' } });
    expect(decision.clarificationOptions ?? []).toEqual([]);
    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision.askAnalystDecision?.state.planningReceipt).toMatchObject({
      plannerCalls: 0,
      verification: { reasonCode: 'ordinary_role_relationship_unproven' },
    });
  });

  it('AGT-049 preserves the exact intended namespaced entity despite an unrelated duplicate customer leaf', async () => {
    const billingCustomerId = 'semantic:entity:billing.customer';
    const crmCustomerId = 'semantic:entity:crm.customer';
    const billingCustomer: AgentEvidenceCandidate = {
      id: billingCustomerId, qualifiedId: billingCustomerId,
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Billing Customer', aliases: ['customer'], primaryEntity: billingCustomerId,
      relevanceScore: 0.94, matchReasons: ['selected billing customer entity'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_a.customer'],
    };
    const billingCustomerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:billing.customer_name', qualifiedId: 'semantic:dimension:billing.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], primaryEntity: billingCustomerId,
      relevanceScore: 0.93, matchReasons: ['billing customer display'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_a.customer'],
    };
    const billingLocation: AgentEvidenceCandidate = {
      id: 'semantic:dimension:billing.location_name', qualifiedId: 'semantic:dimension:billing.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], primaryEntity: billingCustomerId,
      relevanceScore: 0.42, matchReasons: ['billing location output'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_a.customer'],
    };
    const crmLocation: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:crm.location_name', qualifiedId: 'semantic:uncategorized:dimension:crm.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'CRM Location Name', aliases: ['crm location'], primaryEntity: crmCustomerId,
      relevanceScore: 0.41, matchReasons: ['unrelated crm location'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_b.customer'],
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      analyticalCapability: {
        ...semanticCapability(revenue.id), primaryEntityId: billingCustomerId,
        dimensions: [
          {
            dimensionId: billingCustomerName.id, entityId: billingCustomerId,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            nativeGroupingReference: 'billing_customer__customer_name', nativeGroupingPath: ['billing_customer'],
          },
          {
            dimensionId: billingLocation.id, entityId: billingCustomerId,
            label: 'Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display'],
            nativeGroupingReference: 'billing_customer__location_name', nativeGroupingPath: ['billing_customer'],
          },
        ],
      },
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:namespace-intended-entity',
      candidates: [metric, billingCustomer, billingCustomerName, billingLocation, crmLocation],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
    };
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const priorResultMemberBinding = {
      version: 1 as const, displayDimension: 'customer_name', values: ['Brittany Barrera'],
      sourceTurnId: 'run:namespace-intended-entity', resultFingerprint: 'd'.repeat(64),
    };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker, planAnalytical: planner, getEvidence: async () => evidence,
    });

    const decision = await runtime.decide({
      question: 'Which region does customer Brittany Barrera belong to by revenue?',
      requestedMode: 'ask', conversationBinding: 'prior_result', priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question: 'Which region does customer Brittany Barrera belong to by revenue?',
        parsedIntent: evidence.parsedIntent, priorResultMemberBinding,
      }),
    });

    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ action: 'answer' });
    expect(decision.analyticalCascadeDecision).toMatchObject({ selectedTier: 'semantic', planFrozen: true });
    expect(decision.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({ reviewRequired: true });
  });

  it('AGT-049 binds ordinary entity proof to the selected exact billing revenue metric, never a lexical CRM revenue alternative', async () => {
    const billingCustomerId = 'semantic:entity:billing.customer';
    const crmCustomerId = 'semantic:entity:crm.customer';
    const billingCustomer: AgentEvidenceCandidate = {
      id: billingCustomerId, qualifiedId: billingCustomerId,
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Billing Customer', aliases: ['customer'], primaryEntity: billingCustomerId,
      relevanceScore: 0.94, matchReasons: ['billing customer entity'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_billing.customer'],
    };
    const billingCustomerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:billing.customer_name', qualifiedId: 'semantic:dimension:billing.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Billing Customer Name', aliases: ['customer', 'customer name'], primaryEntity: billingCustomerId,
      relevanceScore: 0.93, matchReasons: ['billing display dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_billing.customer'],
    };
    const billingLocation: AgentEvidenceCandidate = {
      id: 'semantic:dimension:billing.location_name', qualifiedId: 'semantic:dimension:billing.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Billing Location Name', aliases: ['location', 'location name'], primaryEntity: billingCustomerId,
      relevanceScore: 0.42, matchReasons: ['same-entity billing location'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_billing.customer'],
    };
    const crmLocation: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:crm.location_name', qualifiedId: 'semantic:uncategorized:dimension:crm.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'CRM Location Name', aliases: ['location', 'location name'], primaryEntity: crmCustomerId,
      relevanceScore: 0.41, matchReasons: ['cross-entity CRM location'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:pkg_crm.customer'],
    };
    const billingRevenue: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:billing.revenue', qualifiedId: 'semantic:metric:billing.revenue',
      name: 'Billing Revenue', aliases: ['billing revenue', 'revenue'], exactMatch: true,
      analyticalCapability: {
        ...semanticCapability('semantic:metric:billing.revenue'), primaryEntityId: billingCustomerId,
        dimensions: [
          {
            dimensionId: billingCustomerName.id, entityId: billingCustomerId,
            label: 'Billing Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            nativeGroupingReference: 'billing_customer__customer_name', nativeGroupingPath: ['billing_customer'],
          },
          {
            dimensionId: billingLocation.id, entityId: billingCustomerId,
            label: 'Billing Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display'],
            nativeGroupingReference: 'billing_customer__location_name', nativeGroupingPath: ['billing_customer'],
          },
        ],
      },
    };
    // This is intentionally a lexical retrieval competitor for the same
    // human word "revenue". Its CRM entity must not join the billing entity
    // context solely because both metric names match that word.
    const crmRevenue: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:metric:crm.revenue', qualifiedId: 'semantic:metric:crm.revenue',
      name: 'crm.revenue', aliases: ['revenue'], exactMatch: false,
      analyticalCapability: {
        ...semanticCapability('semantic:metric:crm.revenue'), primaryEntityId: crmCustomerId,
        dimensions: [{
          dimensionId: crmLocation.id, entityId: crmCustomerId,
          label: 'CRM Location Name', aliases: ['location', 'location name'],
          supportedRoles: ['group_by', 'display'],
          nativeGroupingReference: 'crm_customer__location_name', nativeGroupingPath: ['crm_customer'],
        }],
      },
    };
    // The business phrase makes Billing Revenue the unique exact semantic
    // metric while CRM Revenue remains a retrieved lexical `revenue` card.
    // This exercises selected metric authority without relying on an explicit
    // canonical identifier shortcut.
    const question = 'Which region does customer Brittany Barrera belong to by billing revenue?';
    const priorResultMemberBinding = {
      version: 1 as const, displayDimension: 'customer_name', values: ['Brittany Barrera'],
      sourceTurnId: 'run:selected-billing-metric', resultFingerprint: 'b'.repeat(64),
    };
    const requestFor = (candidates: AgentEvidenceCandidate[]) => ({
      question,
      requestedMode: 'ask' as const,
      conversationBinding: 'prior_result' as const,
      priorResultMemberBinding,
      hostRequirementSeed: buildAnalyticalRequirementSeedV1({
        question,
        parsedIntent: { measures: ['billing revenue'], dimensions: ['region'], filters: [] },
        priorResultMemberBinding,
      }),
      candidates,
    });

    // With only CRM's ordinary geographic field available, the selected
    // billing metric cannot let it become the selected categorical output.
    // There is no safe Billing-to-CRM closure, so it is a typed gap rather
    // than a silent cross-namespace binding.
    const blockedPlanner = vi.fn();
    const blockedCompiler = { decide: vi.fn(async () => semanticDecision()) };
    const blockedRuntime = createAskAnalystRuntimeV1({
      compilerBroker: blockedCompiler,
      planAnalytical: blockedPlanner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:selected-billing-crm-gap',
        candidates: requestFor([]).candidates.concat([
          billingRevenue, crmRevenue, billingCustomer, billingCustomerName, crmLocation,
        ]),
        parsedIntent: { measures: ['billing revenue'], dimensions: ['region'], filters: [] },
      }),
    });
    const blockedInput = requestFor([]);
    const blocked = await blockedRuntime.decide(blockedInput);

    expect(blocked).toMatchObject({ action: 'block', terminalOutcome: { code: 'ANALYTICAL_MODELING_GAP' } });
    expect(blocked.meaningResolution?.selectedConceptIds ?? []).not.toContain(crmRevenue.id);
    expect(blocked.meaningResolution?.selectedConceptIds ?? []).not.toContain(crmLocation.id);
    expect(blocked.clarificationOptions ?? []).toEqual([]);
    expect(blockedPlanner).not.toHaveBeenCalled();
    expect(blockedCompiler.decide).not.toHaveBeenCalled();
    expect(blocked.askAnalystDecision?.state.planningReceipt).toMatchObject({
      plannerCalls: 0,
      verification: { reasonCode: 'ordinary_role_relationship_unproven' },
    });

    // The exact billing field remains a legal same-entity inferred output,
    // even though the unrelated CRM revenue/location cards are still present.
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:selected-billing-same-entity',
        candidates: [billingRevenue, crmRevenue, billingCustomer, billingCustomerName, billingLocation, crmLocation],
        parsedIntent: { measures: ['billing revenue'], dimensions: ['region'], filters: [] },
      }),
    });
    const decision = await runtime.decide(requestFor([]));

    expect(planner).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ action: 'answer' });
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds).toContain(billingLocation.id);
    expect(decision.askAnalystDecision?.state.workspace.plannerCandidateIds).not.toContain(crmLocation.id);
    expect(decision.analyticalCascadeDecision).toMatchObject({ selectedTier: 'semantic', planFrozen: true });
    expect(decision.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({ reviewRequired: true });
  });

  it('AGT-049 clarifies two ordinary safe geographic alternatives from the qualified workspace before a 16-card cap can make one look unique', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer', qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer', 'customer id'], relevanceScore: 0.92,
      matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.91,
      matchReasons: ['semantic display dimension'], compatibility: 'compatible',
    };
    // These are ordinary, qualified catalog dimensions. Neither is tagged as
    // a declared synonym for `region`; both must therefore become a stable
    // clarification rather than a relevance-ranked planner choice.
    const locationName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:locations.location_name',
      qualifiedId: 'semantic:uncategorized:dimension:locations.location_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Location Name', aliases: ['location', 'location name'], relevanceScore: 0.12,
      matchReasons: ['ordinary qualified location dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const countryName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:locations.country_name',
      qualifiedId: 'semantic:uncategorized:dimension:locations.country_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Country Name', aliases: ['country'], relevanceScore: 0.11,
      matchReasons: ['ordinary qualified country dimension'], compatibility: 'compatible',
      sourceObjects: ['dbt:model:locations'],
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      relevanceScore: 0.95,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: 'semantic:entity:orders.order',
        dimensions: [
          {
            dimensionId: customerName.id, entityId: customerKey.id,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['dql:relationship:order_to_customer'],
            nativeGroupingReference: 'customer__customer_name', nativeGroupingPath: ['customer'],
          },
          {
            dimensionId: locationName.id, entityId: 'semantic:entity:locations.location',
            label: 'Location Name', aliases: ['location', 'location name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['dql:relationship:order_to_location'],
            nativeGroupingReference: 'location__location_name', nativeGroupingPath: ['location'],
          },
          {
            dimensionId: countryName.id, entityId: 'semantic:entity:locations.location',
            label: 'Country Name', aliases: ['country'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['dql:relationship:order_to_location'],
            nativeGroupingReference: 'location__country_name', nativeGroupingPath: ['location'],
          },
        ],
      },
    };
    const relationship = (id: string, from: string, to: string): AgentEvidenceCandidate => ({
      id, qualifiedId: id, kind: 'dql_modeling', trustTier: 'governed_sql',
      name: id.replace('dql:relationship:', '').replaceAll('_', ' '), relevanceScore: 0.9,
      matchReasons: ['safe authored relationship'], compatibility: 'compatible', relationshipEvidence: [id],
      relationshipSafety: [{
        id, from, to, keys: [{ from: 'id', to: 'id' }], status: 'certified', staleCertification: false,
        cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: true,
        certificationFingerprint: `sha256:${id}`,
        validation: {
          status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z',
          queryFingerprint: `sha256:query:${id}`, proofFingerprint: `sha256:proof:${id}`,
        },
      }],
    });
    const orderToCustomer = relationship(
      'dql:relationship:order_to_customer',
      'semantic:entity:orders.order',
      customerKey.id,
    );
    const orderToLocation = relationship(
      'dql:relationship:order_to_location',
      'semantic:entity:orders.order',
      'semantic:entity:locations.location',
    );
    // Fifteen exact/pinned customer cards consume the naive planner budget.
    // A relevance-only 16-card cut would leave room for only one geography
    // field and incorrectly promote it as a unique inferred `region`.
    // The runtime must inspect the qualified workspace first and surface both
    // stable IDs as a pre-planner clarification.
    const fillers = Array.from({ length: 15 }, (_, index): AgentEvidenceCandidate => ({
      id: `dbt:model:ambiguity_customer_pin_${index}`,
      qualifiedId: `dbt:model:ambiguity_customer_pin_${index}`,
      kind: 'dbt_model', trustTier: 'exploratory', name: `Customer Pin ${index}`,
      aliases: ['customer'], relevanceScore: 0.99 - index / 1_000,
      exactMatch: true,
      compatibilityFacts: ['roles entity key'],
      matchReasons: ['exact pinned customer retrieval'], compatibility: 'compatible',
    }));
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:ordinary-role-ambiguity',
      continuityFingerprint: 'sha256:ordinary-role-ambiguity',
      candidates: [
        metric, customerKey, customerName, locationName, countryName,
        orderToCustomer, orderToLocation, ...fillers,
      ],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
    };
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => evidence,
    });
    const question = 'Which region is Brittany Barrera in by revenue?';
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name',
      values: ['Brittany Barrera'],
      sourceTurnId: 'run:top-customers',
      resultFingerprint: 'c'.repeat(64),
    };
    const hostRequirementSeed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: evidence.parsedIntent,
      priorResultMemberBinding,
    });

    const initial = await runtime.decide({
      question,
      requestedMode: 'ask',
      threadId: 'thread:ordinary-role-ambiguity',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed,
    });

    expect(initial).toMatchObject({ action: 'clarify', requiresClarification: true });
    expect(initial.clarificationOptions?.map((option) => option.id)).toEqual(expect.arrayContaining([
      locationName.id,
      countryName.id,
    ]));
    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(initial.analyticalCascadeDecision).toBeUndefined();
    expect(initial.askAnalystDecision?.state.planningReceipt).toMatchObject({
      plannerCalls: 0,
      verification: { status: 'ambiguous', reasonCode: 'ordinary_role_inference_ambiguous' },
    });
    const plannerGeographyIds = initial.askAnalystDecision?.state.workspace.plannerCandidateIds
      .filter((id) => [locationName.id, countryName.id].includes(id)) ?? [];
    // The bounded package cannot safely retain both after the 15 pins. The
    // clarification nevertheless has both choices because it was derived
    // from the qualified workspace before planner truncation.
    expect(plannerGeographyIds.length).toBeLessThan(2);
    expect(initial.askAnalystDecision?.taskExecutions).toBeUndefined();
    expect(initial.askAnalystDecision?.state.workspace.roleCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'categorical_dimension',
        candidateCount: 2,
        state: 'alternatives',
      }),
    ]));

    // This recreates the server-owned persisted/reload envelope. It proves the
    // original thread, turn, snapshot, and offered stable IDs; browser prose
    // does not become a selection authority.
    const selected = await runtime.decide({
      question,
      requestedMode: 'ask',
      threadId: 'thread:ordinary-role-ambiguity',
      selectedEvidenceId: locationName.id,
      clarificationSourceQuestion: question,
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed,
      conversationContext: {
        conversationEnvelope: {
          version: 1,
          threadId: 'thread:ordinary-role-ambiguity',
          recentTurns: [],
          pendingClarification: {
            sourceTurnId: 'turn:ordinary-role-ambiguity',
            sourceQuestion: question,
            question: 'Which geographic field should I use?',
            selection: {
              version: 1,
              optionIds: [locationName.id, countryName.id],
              ambiguityCandidateIds: [locationName.id, countryName.id],
              snapshotId: evidence.snapshotId,
              continuityFingerprint: evidence.continuityFingerprint,
              requirements: hostRequirementSeed.requirements,
            },
          },
        },
        serverIssuedClarificationSelection: {
          version: 1,
          threadId: 'thread:ordinary-role-ambiguity',
          sourceTurnId: 'turn:ordinary-role-ambiguity',
          snapshotId: evidence.snapshotId,
          continuityFingerprint: evidence.continuityFingerprint,
        },
      },
    });

    expect(planner).not.toHaveBeenCalled();
    // The restored server-issued choice is a zero-provider identity binding;
    // the canonical semantic cascade owns the frozen execution route.
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(selected.action).toBe('answer');
    expect(selected.askAnalystDecision?.state.frame.conversation).toMatchObject({
      binding: 'structured_clarification',
      selectedStableId: locationName.id,
    });
    expect(selected.askAnalystDecision?.state.workspace.plannerCandidateIds).toContain(locationName.id);
    expect(selected.askAnalystDecision?.state.workspace.plannerCandidateIds).not.toContain(countryName.id);
    expect(selected.askAnalystDecision?.state.program.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldTerms: expect.arrayContaining(['customer_name']), value: 'Brittany Barrera' }),
    ]));
    expect(selected.analyticalCascadeDecision).toMatchObject({ selectedTier: 'semantic', planFrozen: true });
    expect(selected.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({ reviewRequired: true });
  });

  it('AGT-049 continues a persisted qualified SQL-column choice through one review-required exploratory path without replanning', async () => {
    const customers: AgentEvidenceCandidate = {
      id: 'dbt:model:customers', qualifiedId: 'dbt:model:customers',
      kind: 'dbt_model', trustTier: 'exploratory', name: 'customers', aliases: ['customers'],
      relevanceScore: 0.9, matchReasons: ['qualified physical relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:customers'],
    };
    const orders: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders',
      kind: 'dbt_model', trustTier: 'exploratory', name: 'orders', aliases: ['orders'],
      relevanceScore: 0.89, matchReasons: ['qualified physical relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:orders'],
    };
    const locations: AgentEvidenceCandidate = {
      id: 'dbt:model:locations', qualifiedId: 'dbt:model:locations',
      kind: 'dbt_model', trustTier: 'exploratory', name: 'locations', aliases: ['locations'],
      relevanceScore: 0.88, matchReasons: ['qualified physical relation'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:locations'],
    };
    const customerId: AgentEvidenceCandidate = {
      id: 'runtime:column:customers.customer_id', qualifiedId: 'runtime:column:customers.customer_id',
      kind: 'sql_column', trustTier: 'exploratory', name: 'customer_id', aliases: ['customer id'],
      relevanceScore: 0.87, matchReasons: ['qualified physical customer key'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:customers'],
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'runtime:column:customers.customer_name', qualifiedId: 'runtime:column:customers.customer_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'customer_name', aliases: ['customer', 'customer name'],
      relevanceScore: 0.86, matchReasons: ['qualified physical customer label'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:customers'],
    };
    // Deliberately give both safe physical fields the same display label. The
    // clarifier must retain their distinct qualified identities in the label
    // rather than sending the user back to prose/position selection.
    const locationName: AgentEvidenceCandidate = {
      id: 'runtime:column:locations.location_name', qualifiedId: 'runtime:column:locations.location_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'Location', aliases: ['location name'],
      relevanceScore: 0.11, matchReasons: ['ordinary qualified location field'], compatibility: 'compatible',
      compatibilityFacts: ['roles categorical dimension'], sourceObjects: ['runtime:relation:locations'],
    };
    const countryName: AgentEvidenceCandidate = {
      id: 'runtime:column:locations.country_name', qualifiedId: 'runtime:column:locations.country_name',
      kind: 'sql_column', trustTier: 'exploratory', name: 'Location', aliases: ['country name'],
      relevanceScore: 0.1, matchReasons: ['ordinary qualified country field'], compatibility: 'compatible',
      compatibilityFacts: ['roles categorical dimension'], sourceObjects: ['runtime:relation:locations'],
    };
    const relationship = (id: string, from: string, to: string): AgentEvidenceCandidate => ({
      id, qualifiedId: id, kind: 'dql_modeling', trustTier: 'governed_sql',
      name: id.replace('dql:relationship:', '').replaceAll('_', ' '), relevanceScore: 0.92,
      matchReasons: ['same-snapshot safe relationship proof'], compatibility: 'compatible', relationshipEvidence: [id],
      relationshipSafety: [{
        id, from, to, keys: [{ from: 'id', to: 'id' }], status: 'certified', staleCertification: false,
        cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: true,
        certificationFingerprint: `sha256:${id}`,
        validation: {
          status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z',
          queryFingerprint: `sha256:query:${id}`, proofFingerprint: `sha256:proof:${id}`,
        },
      }],
    });
    const customerToOrder = relationship(
      'dql:relationship:customer_to_order',
      'runtime:relation:customers',
      'runtime:relation:orders',
    );
    const orderToLocation = relationship(
      'dql:relationship:order_to_location',
      'runtime:relation:orders',
      'runtime:relation:locations',
    );
    const fillers = Array.from({ length: 16 }, (_, index): AgentEvidenceCandidate => ({
      id: `dbt:model:physical_ambiguity_context_${index}`,
      qualifiedId: `dbt:model:physical_ambiguity_context_${index}`,
      kind: 'dbt_model', trustTier: 'exploratory', name: `Context ${index}`,
      aliases: [`context ${index}`], relevanceScore: 0.98 - index / 1_000,
      matchReasons: ['16-card pressure filler'], compatibility: 'compatible',
    }));
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:physical-role-ambiguity',
      continuityFingerprint: 'sha256:physical-role-ambiguity',
      candidates: [
        customers, orders, locations, customerId, customerName, locationName, countryName,
        customerToOrder, orderToLocation, ...fillers,
      ],
      parsedIntent: { measures: [], dimensions: ['region'], filters: [] },
    };
    const planner = vi.fn();
    const compilerBroker = { decide: vi.fn(async () => semanticDecision()) };
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker,
      planAnalytical: planner,
      getEvidence: async () => evidence,
    });
    const question = 'Which region is Brittany Barrera in?';
    const priorResultMemberBinding = {
      version: 1 as const,
      displayDimension: 'customer_name',
      values: ['Brittany Barrera'],
      sourceTurnId: 'run:top-customers',
      resultFingerprint: 'd'.repeat(64),
    };
    const hostRequirementSeed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: evidence.parsedIntent,
      priorResultMemberBinding,
    });

    const initial = await runtime.decide({
      question,
      requestedMode: 'ask',
      threadId: 'thread:physical-role-ambiguity',
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed,
    });

    expect(initial).toMatchObject({ action: 'clarify', requiresClarification: true });
    expect(initial.clarificationOptions?.map((option) => option.id)).toEqual(expect.arrayContaining([
      locationName.qualifiedId,
      countryName.qualifiedId,
    ]));
    expect(initial.clarificationOptions?.every((option) => option.kind === 'sql_column')).toBe(true);
    expect(new Set(initial.clarificationOptions?.map((option) => option.label)).size).toBe(2);
    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(initial.analyticalCascadeDecision).toBeUndefined();
    expect(initial.askAnalystDecision?.state.workspace.plannerCandidateIds.length).toBeLessThanOrEqual(16);
    expect(initial.askAnalystDecision?.state.workspace.roleCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'categorical_dimension', state: 'alternatives' }),
    ]));

    const selected = await runtime.decide({
      question,
      requestedMode: 'ask',
      threadId: 'thread:physical-role-ambiguity',
      selectedEvidenceId: locationName.qualifiedId,
      clarificationSourceQuestion: question,
      conversationBinding: 'prior_result',
      priorResultMemberBinding,
      hostRequirementSeed,
      conversationContext: {
        conversationEnvelope: {
          version: 1,
          threadId: 'thread:physical-role-ambiguity',
          recentTurns: [],
          pendingClarification: {
            sourceTurnId: 'turn:physical-role-ambiguity',
            sourceQuestion: question,
            question: 'Which geographic field should I use?',
            selection: {
              version: 1,
              optionIds: [locationName.qualifiedId!, countryName.qualifiedId!],
              ambiguityCandidateIds: [locationName.qualifiedId!, countryName.qualifiedId!],
              snapshotId: evidence.snapshotId,
              continuityFingerprint: evidence.continuityFingerprint,
              requirements: hostRequirementSeed.requirements,
            },
          },
        },
        serverIssuedClarificationSelection: {
          version: 1,
          threadId: 'thread:physical-role-ambiguity',
          sourceTurnId: 'turn:physical-role-ambiguity',
          snapshotId: evidence.snapshotId,
          continuityFingerprint: evidence.continuityFingerprint,
        },
      },
    });

    expect(planner).not.toHaveBeenCalled();
    expect(compilerBroker.decide).not.toHaveBeenCalled();
    expect(selected.action).toBe('answer');
    expect(selected.requiresClarification).not.toBe(true);
    expect(selected.askAnalystDecision?.state.frame.conversation).toMatchObject({
      binding: 'structured_clarification',
      selectedStableId: locationName.qualifiedId,
    });
    expect(selected.askAnalystDecision?.state.workspace.plannerCandidateIds).toContain(locationName.qualifiedId);
    expect(selected.askAnalystDecision?.state.workspace.plannerCandidateIds).not.toContain(countryName.qualifiedId);
    expect(selected.askAnalystDecision?.state.program.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldTerms: expect.arrayContaining(['customer_name']), value: 'Brittany Barrera' }),
    ]));
    expect(selected.askAnalystDecision?.state.program.executionCandidateIds).toEqual(expect.arrayContaining([
      customerToOrder.qualifiedId,
      orderToLocation.qualifiedId,
      locationName.qualifiedId,
    ]));
    expect(selected.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      planFrozen: true,
    });
    expect(selected.askAnalystDecision?.taskExecutions?.[0]?.resolvedPlan).toMatchObject({
      compiler: 'exploratory_sql',
      reviewRequired: true,
      planFrozen: true,
    });
    expect(selected.askAnalystDecision?.state.workspace.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'provider_meaning',
        status: 'skipped',
        reasonCode: 'deterministic_structured_physical_continuation_binding',
      }),
    ]));
  });

  it('AGT-041 admits only canonically proven relationship path cards and preserves exploratory proof class', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer', qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member', semanticObjectType: 'entity', trustTier: 'semantic',
      name: 'Customer', aliases: ['customer'], relevanceScore: 0.92,
      matchReasons: ['semantic entity'], compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customer name'], relevanceScore: 0.91,
      matchReasons: ['semantic display dimension'], compatibility: 'compatible',
    };
    const region: AgentEvidenceCandidate = {
      id: 'semantic:dimension:locations.region', qualifiedId: 'semantic:dimension:locations.region',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Region', aliases: ['region', 'location'], relevanceScore: 0.9,
      matchReasons: ['semantic location dimension'], compatibility: 'compatible',
    };
    const metric: AgentEvidenceCandidate = {
      ...revenue,
      exactMatch: false,
      relevanceScore: 0.89,
      analyticalCapability: {
        ...semanticCapability(revenue.id),
        primaryEntityId: customerKey.id,
        dimensions: [
          {
            dimensionId: customerName.id, entityId: customerKey.id,
            label: 'Customer Name', aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'filter'],
            relationshipPathIds: ['dql:relationship:customer_to_location'],
          },
          {
            dimensionId: region.id, entityId: 'semantic:entity:locations.location',
            label: 'Region', aliases: ['region', 'location'],
            supportedRoles: ['group_by', 'display'],
            relationshipPathIds: ['dql:relationship:customer_to_location'],
          },
        ],
      },
    };
    const competingMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:finance.revenue', qualifiedId: 'semantic:metric:finance.revenue',
      name: 'finance.revenue', relevanceScore: 0.88,
    };
    type RelationshipSafety = NonNullable<AgentEvidenceCandidate['relationshipSafety']>[number];
    const validSafety = (): RelationshipSafety => ({
      id: 'dql:relationship:customer_to_location',
      from: customerKey.id,
      to: 'semantic:entity:locations.location',
      keys: [{ from: 'customer_id', to: 'customer_id' }],
      status: 'certified',
      staleCertification: false,
      cardinality: 'many_to_one',
      fanout: 'safe',
      automaticJoinAllowed: true,
      certificationFingerprint: 'sha256:customer-location',
      validation: {
        status: 'passed', checkedAt: '2026-08-28T00:00:00.000Z',
        queryFingerprint: 'sha256:customer-location-query', proofFingerprint: 'sha256:customer-location-proof',
      },
    });
    const relationship = (input: { safety: RelationshipSafety | RelationshipSafety[]; evidence?: string[] }): AgentEvidenceCandidate => {
      const safety = Array.isArray(input.safety) ? input.safety : [input.safety];
      return {
      id: 'dql:relationship:customer_to_location', qualifiedId: 'dql:relationship:customer_to_location',
      kind: 'dql_modeling', trustTier: 'governed_sql',
      name: 'Customer to location', aliases: ['customer location relationship'], relevanceScore: 0.95,
      matchReasons: ['relationship fixture'], compatibility: 'compatible',
      relationshipEvidence: input.evidence ?? [safety[0]!.id],
      relationshipSafety: safety,
      };
    };
    const plannerCardsFor = async (input: { safety: RelationshipSafety | RelationshipSafety[]; evidence?: string[] }) => {
      let cards: readonly { id: string; trustTier: string; relationshipProofClass?: string; relationHints?: string[] }[] = [];
      const runtime = createAskAnalystRuntimeV1({
        compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
        planAnalytical: async (input) => {
          cards = input.plannerRequest.candidates;
          // The test exercises admission only. A malformed proposal safely
          // stops before any compiler/execution path.
          return undefined;
        },
        getEvidence: async () => ({
          snapshotId: 'snapshot:relationship-proof',
          candidates: [metric, competingMetric, customerKey, customerName, region, relationship(input)],
          parsedIntent: { measures: ['revenue'], dimensions: ['customer', 'region'], filters: [] },
        }),
      });
      await runtime.decide({ question: 'show revenue by customer and region', requestedMode: 'ask' });
      return cards;
    };
    const governedCard = (await plannerCardsFor({ safety: validSafety() })).find((card) =>
      card.id.startsWith('dql:relationship_path:'));
    expect(governedCard).toMatchObject({ trustTier: 'governed', relationshipProofClass: 'governed' });

    const exploratorySafety: RelationshipSafety = {
      ...validSafety(),
      status: 'draft',
      certificationFingerprint: undefined,
    };
    const exploratoryCard = (await plannerCardsFor({ safety: exploratorySafety })).find((card) =>
      card.id.startsWith('dql:relationship_path:'));
    expect(exploratoryCard).toMatchObject({ trustTier: 'exploratory', relationshipProofClass: 'exploratory' });

    // An alias may identify the same raw snapshot edge, but the planner card
    // must serialize the matched proof's canonical relationship ID only.
    const aliasedSafety: RelationshipSafety = {
      ...validSafety(),
      aliases: ['dql:relationship:customer_to_location_alias'],
    };
    const aliasCard = (await plannerCardsFor({
      safety: aliasedSafety,
      evidence: ['dql:relationship:customer_to_location_alias'],
    })).find((card) => card.id.startsWith('dql:relationship_path:'));
    expect(aliasCard).toMatchObject({
      relationshipProofClass: 'governed',
      relationHints: ['dql:relationship:customer_to_location'],
    });

    const rejectedProofs: Array<[string, RelationshipSafety]> = [
      ['automatic join denied', { ...validSafety(), automaticJoinAllowed: false }],
      ['stale certification', { ...validSafety(), staleCertification: true }],
      ['draft without passed validation', { ...validSafety(), status: 'draft', validation: { ...validSafety().validation!, status: 'failed' } }],
      ['unvalidated proof', { ...validSafety(), validation: undefined }],
      ['invalid endpoints and keys', { ...validSafety(), from: '', keys: [{ from: '', to: 'customer_id' }] }],
      ['unsafe cardinality', { ...validSafety(), cardinality: 'many_to_many' }],
    ];
    for (const [label, safety] of rejectedProofs) {
      const cards = await plannerCardsFor({ safety });
      expect(cards.some((card) => card.id.startsWith('dql:relationship_path:')), label).toBe(false);
    }

    const proof = validSafety();
    const proofMappingRejects: Array<[string, { safety: RelationshipSafety[]; evidence: string[] }]> = [
      ['proved plus unproved evidence edge', {
        safety: [proof],
        evidence: [proof.id, 'dql:relationship:unproved_edge'],
      }],
      ['unrelated extra proof', {
        safety: [proof, { ...validSafety(), id: 'dql:relationship:unrelated_extra' }],
        evidence: [proof.id],
      }],
      ['duplicate alias proof mapping', {
        safety: [proof, { ...validSafety(), id: 'dql:relationship:duplicate_alias', aliases: [proof.id] }],
        evidence: [proof.id],
      }],
    ];
    for (const [label, input] of proofMappingRejects) {
      const cards = await plannerCardsFor(input);
      expect(cards.some((card) => card.id.startsWith('dql:relationship_path:')), label).toBe(false);
    }
  });

  it('AGT-041 retains only the minimal safe relationship closure for a multi-relation Ask', async () => {
    const customerKey: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer_id',
      qualifiedId: 'semantic:entity:customers.customer_id',
      kind: 'semantic_member',
      semanticObjectType: 'entity',
      trustTier: 'semantic',
      name: 'Customer ID',
      aliases: ['customer key', 'customer id'],
      relevanceScore: 0.8,
      matchReasons: ['semantic entity'],
      compatibility: 'compatible',
    };
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_name',
      qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Customer name',
      aliases: ['customer', 'customer name'],
      relevanceScore: 0.79,
      matchReasons: ['semantic display dimension'],
      compatibility: 'compatible',
    };
    const productName: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.product_name',
      qualifiedId: 'semantic:dimension:products.product_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Product name',
      aliases: ['product', 'product name'],
      relevanceScore: 0.78,
      matchReasons: ['semantic grouping dimension'],
      compatibility: 'compatible',
    };
    const relationship = (id: string, relevanceScore: number, edgeCount: number, fanout = 'safe'): AgentEvidenceCandidate => ({
      id,
      qualifiedId: id,
      kind: 'dql_modeling',
      trustTier: 'governed_sql',
      name: id.replace('dql:relationship:', '').replaceAll('_', ' '),
      aliases: ['customer product relationship'],
      relevanceScore,
      matchReasons: ['validated relationship closure'],
      compatibility: 'compatible',
      relationshipEvidence: [id],
      relationshipSafety: [{
        id,
        from: 'semantic:entity:customers.customer',
        to: 'semantic:entity:products.product',
        keys: Array.from({ length: edgeCount }, (_, index) => ({
          from: `customer_key_${index}`,
          to: `customer_key_${index}`,
        })),
        status: 'certified',
        staleCertification: false,
        cardinality: 'many_to_one',
        fanout,
        automaticJoinAllowed: true,
        certificationFingerprint: `sha256:relationship:${id}`,
        validation: {
          status: 'passed',
          checkedAt: '2026-08-28T00:00:00.000Z',
          queryFingerprint: `sha256:query:${id}`,
          proofFingerprint: `sha256:proof:${id}`,
        },
      }],
    });
    const safeOne = relationship('dql:relationship:customers_orders', 0.91, 2);
    const safeTwo = relationship('dql:relationship:orders_order_items', 0.9, 1);
    const safeThree = relationship('dql:relationship:order_items_products', 0.89, 1);
    const safeFour = relationship('dql:relationship:customers_accounts', 0.88, 1);
    const unsafeFanout = relationship('dql:relationship:customers_products_unbounded', 0.99, 1, 'many_to_many');
    const planner = vi.fn(async (input: { plannerRequest: {
      candidates: readonly { id: string; relationHints?: string[] }[];
    } }) => {
      const pathCard = input.plannerRequest.candidates.find((candidate) =>
        candidate.id.startsWith('dql:relationship_path:'));
      expect(pathCard?.relationHints).toEqual([safeOne.id, safeTwo.id, safeThree.id]);
      expect(input.plannerRequest.candidates
        .filter((candidate) => [safeOne.id, safeTwo.id, safeThree.id, safeFour.id, unsafeFanout.id].includes(candidate.id)))
        .toEqual([]);
      return {
        version: 1 as const,
        selectedConceptIds: [revenue.id, customerKey.id, customerName.id, productName.id, pathCard!.id],
        confidence: 'high' as const,
        tasks: [{
          version: 1 as const,
          taskId: 'task-1',
          selectedConceptIds: [revenue.id, customerKey.id, customerName.id, productName.id, pathCard!.id],
          roleBindings: {
            metric: [revenue.id],
            entity_key: [customerKey.id],
            entity_label: [customerName.id],
            categorical_dimension: [productName.id],
            relationship: [pathCard!.id],
          },
          operations: ['aggregate', 'group', 'project'] as const,
        }],
      };
    });
    const runtime = createAskAnalystRuntimeV1({
      compilerBroker: { decide: vi.fn(async () => semanticDecision()) },
      planAnalytical: planner,
      getEvidence: async () => ({
        snapshotId: 'snapshot:bounded-relationship-closure',
        candidates: [
          revenue,
          customerKey,
          customerName,
          productName,
          safeOne,
          safeTwo,
          safeThree,
          safeFour,
          unsafeFanout,
        ],
        parsedIntent: { measures: ['revenue'], dimensions: ['customer', 'product'], filters: [] },
      }),
    });

    const decision = await runtime.decide({
      question: 'show revenue by customer and product',
      requestedMode: 'ask',
    });

    const closure = (decision.askAnalystDecision?.state.program.executionCandidateIds ?? [])
      .filter((id) => id.startsWith('dql:relationship:'));
    expect(closure).toEqual([safeOne.id, safeTwo.id, safeThree.id]);
    expect(closure).not.toContain(safeFour.id);
    expect(closure).not.toContain(unsafeFanout.id);
    expect(closure).toHaveLength(3);
    const edgeCounts = new Map([safeOne, safeTwo, safeThree, safeFour, unsafeFanout]
      .map((candidate) => [candidate.id, candidate.relationshipSafety?.[0]?.keys.length ?? 0]));
    expect(closure.reduce((total, id) => total + (edgeCounts.get(id) ?? 0), 0)).toBe(4);
  });
});
