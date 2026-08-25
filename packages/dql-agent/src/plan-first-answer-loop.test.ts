import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSqlOutputExpressionSignature,
  semanticExecutionFingerprint,
  SemanticLayer,
  type AnalyticalQuestionFrameV2,
  type MetricCapabilityContract,
  type SemanticAggregationCompilerReceiptV1,
} from '@duckcodeailabs/dql-core';
import { answer } from './answer-loop.js';
import { KGStore } from './kg/sqlite-fts.js';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import type { AgentEvidenceCandidate, MeaningResolution } from './meaning-resolution.js';
import type { AgentMessage, AgentProvider } from './providers/types.js';

class NeverProvider implements AgentProvider {
  readonly name = 'claude' as const;
  calls = 0;
  async available(): Promise<boolean> { return true; }
  async generate(_messages: AgentMessage[]): Promise<string> {
    this.calls += 1;
    throw new Error('The authoritative execution path must not invoke member selection or SQL generation.');
  }
}

class SqlProvider implements AgentProvider {
  readonly name = 'claude' as const;
  calls = 0;
  constructor(private readonly response: string) {}
  async available(): Promise<boolean> { return true; }
  async generate(_messages: AgentMessage[]): Promise<string> {
    this.calls += 1;
    return this.response;
  }
}

let root: string;
let kg: KGStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plan-first-answer-'));
  kg = new KGStore(join(root, 'kg.sqlite'));
});

afterEach(() => {
  kg.close();
  rmSync(root, { recursive: true, force: true });
});

function planFor(candidate: AgentEvidenceCandidate, resolution: MeaningResolution) {
  return buildResolvedAnalyticalPlan({
    question: resolution.interpretedQuestion,
    resolution,
    evidence: { snapshotId: 'snapshot-plan-first', candidates: [candidate] },
    candidates: [candidate],
    mode: 'authoritative',
  });
}

describe('authoritative plan answer loop (AGT-013 / AGT-014)', () => {
  it('executes only the router-selected exploratory tier without reopening certified or semantic lanes', async () => {
    kg.rebuild([{
      nodeId: 'block:top_customers',
      kind: 'block',
      name: 'top_customers',
      status: 'certified',
      declaredOutputs: ['customer_name', 'lifetime_spend'],
    }, {
      nodeId: 'metric:revenue',
      kind: 'metric',
      name: 'revenue',
      status: 'certified',
    }], []);
    const provider = new SqlProvider('```json\n{"summary":"Order count by customer.","sql":"SELECT customer_name, count_lifetime_orders AS order_count FROM analytics.dim_customers ORDER BY customer_name","outputs":["customer_name","order_count"]}\n```');
    let certifiedCalls = 0;
    let generatedCalls = 0;
    let hostFreezeCalls = 0;
    const capability = {
      version: 1 as const,
      runId: 'run-plan-first-exploratory',
      executionId: 'run-plan-first-exploratory:generated',
      snapshotId: 'snapshot-plan-first',
      planId: 'plan-first-exploratory',
      targetFingerprint: 'target-plan-first',
      bindingsFingerprint: 'bindings-plan-first',
      candidateSqlFingerprint: 'candidate-plan-first',
      provenIdentifiers: ['analytics.dim_customers', 'analytics.dim_customers.customer_name', 'analytics.dim_customers.count_lifetime_orders'],
      evidence: {
        'analytics.dim_customers': 'schema_tool' as const,
        'analytics.dim_customers.customer_name': 'schema_tool' as const,
        'analytics.dim_customers.count_lifetime_orders': 'schema_tool' as const,
      },
    };
    const result = await answer({
      question: 'what is the order count for each customer?',
      provider,
      kg,
      selectedCascadeTier: 'exploratory_sql',
      schemaContext: [{
        relation: 'analytics.dim_customers',
        name: 'dim_customers',
        columns: [
          { name: 'customer_name', type: 'string' },
          { name: 'count_lifetime_orders', type: 'number' },
        ],
      }],
      executeCertifiedBlock: async () => {
        certifiedCalls += 1;
        throw new Error('A router-selected exploratory plan must not reopen a certified block.');
      },
      prepareExploratorySqlExecution: async (sql) => {
        hostFreezeCalls += 1;
        expect(sql).toContain('FROM analytics.dim_customers');
        return {
          capability,
          freeze: {
            version: 1 as const,
            selectedTier: 'exploratory_sql' as const,
            planId: capability.planId,
            planFingerprint: 'a'.repeat(64),
            snapshotId: capability.snapshotId,
            targetFingerprint: capability.targetFingerprint,
            sqlFingerprint: 'b'.repeat(32),
            candidateIds: ['dbt:model:dim_customers', 'dbt:column:dim_customers.customer_name', 'dbt:column:dim_customers.count_lifetime_orders'],
            authorization: 'capability_minted' as const,
          },
        };
      },
      executeAgenticGeneratedSql: async (receivedCapability, sql) => {
        generatedCalls += 1;
        expect(receivedCapability).toBe(capability);
        return {
          columns: ['customer_name', 'order_count'],
          rows: [{ customer_name: 'Ada', order_count: 3 }],
          rowCount: 1,
          sql,
        };
      },
    });

    expect(certifiedCalls).toBe(0);
    expect(provider.calls).toBe(1);
    expect(hostFreezeCalls).toBe(1);
    expect(generatedCalls).toBe(1);
    expect(result).toMatchObject({
      kind: 'uncertified',
      certification: 'ai_generated',
      reviewStatus: 'draft_ready',
      sourceTier: 'dbt_manifest',
      exploratoryExecutionFreeze: {
        selectedTier: 'exploratory_sql',
        planId: capability.planId,
        authorization: 'capability_minted',
      },
    });

    const unavailableProvider = new NeverProvider();
    const unavailable = await answer({
      question: 'what is the order count for each customer?',
      provider: unavailableProvider,
      kg,
      selectedCascadeTier: 'exploratory_sql',
      schemaContext: [{
        relation: 'analytics.dim_customers',
        name: 'dim_customers',
        columns: [
          { name: 'customer_name', type: 'string' },
          { name: 'count_lifetime_orders', type: 'number' },
        ],
      }],
      executeCertifiedBlock: async () => {
        certifiedCalls += 1;
        throw new Error('not reached');
      },
      executeAgenticGeneratedSql: async () => {
        generatedCalls += 1;
        throw new Error('not reached');
      },
    });
    expect(unavailable).toMatchObject({ kind: 'no_answer', refusalCode: 'provider_error' });
    expect(certifiedCalls).toBe(0);
    expect(generatedCalls).toBe(1);
  });

  it('compiles and executes a single-relation governed AST without asking the provider for SQL', async () => {
    kg.rebuild([], []);
    const measure: AgentEvidenceCandidate = {
      id: 'dbt:column:orders.amount',
      qualifiedId: 'dbt:column:orders.amount',
      kind: 'sql_column',
      trustTier: 'governed_sql',
      name: 'Revenue',
      aggregation: 'sum',
      sourceObjects: ['runtime:relation:analytics.orders'],
      relevanceScore: 0.98,
      matchReasons: ['measure'],
      compatibility: 'compatible',
    };
    const customer: AgentEvidenceCandidate = {
      id: 'dbt:column:orders.customer_name',
      qualifiedId: 'dbt:column:orders.customer_name',
      kind: 'sql_column',
      trustTier: 'governed_sql',
      name: 'Customer',
      aliases: ['customer'],
      sourceObjects: ['runtime:relation:analytics.orders'],
      relevanceScore: 0.94,
      matchReasons: ['dimension'],
      compatibility: 'compatible',
    };
    // This direct answer-loop fixture is an authored governed projection. A
    // raw relation/column closure without this capability is deliberately
    // routed through review-required exploratory SQL by the router.
    measure.analyticalCapability = {
      metricId: measure.qualifiedId!,
      measureIds: [measure.qualifiedId!],
      primaryEntityId: 'commerce::entity::order',
      defaultResultGrainId: 'commerce::entity::order',
      resultGrainIds: ['commerce::entity::order'],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [{
        dimensionId: customer.qualifiedId!,
        entityId: 'commerce::entity::order',
        supportedRoles: ['group_by', 'display', 'rank_entity'],
      }],
      timeDimensions: [],
      operations: ['group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value'],
      executionCapabilities: [{ route: 'governed_sql', adapterId: 'relational-v1' }],
      sourceFingerprint: 'plan-first-governed-fixture',
    };
    const resolution: MeaningResolution = {
      interpretedQuestion: 'Top customers by revenue.',
      questionType: 'ranking',
      selectedConceptIds: [measure.id],
      recommendedExecutionId: measure.id,
      queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 5 },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'governed_sql',
    };
    const plan = buildResolvedAnalyticalPlan({
      question: resolution.interpretedQuestion,
      resolution,
      evidence: { snapshotId: 'snapshot-plan-first', candidates: [measure, customer] },
      candidates: [measure, customer],
      mode: 'authoritative',
    });
    const provider = new NeverProvider();
    let artifactSource = '';
    const result = await answer({
      question: 'Please invent SQL for something else.',
      provider,
      kg,
      resolvedAnalyticalPlan: plan,
      schemaContext: [{
        relation: 'analytics.orders',
        name: 'orders',
        columns: [{ name: 'amount', type: 'number' }, { name: 'customer_name', type: 'string' }],
      }],
      executeDqlArtifact: async (artifact) => {
        artifactSource = artifact.source;
        return {
          columns: ['customer', 'revenue'],
          rows: [{ customer: 'A', revenue: 42 }],
          rowCount: 1,
          sql: artifact.compiledSql,
        };
      },
    });
    expect(provider.calls).toBe(0);
    expect(artifactSource).toContain('block "resolved_plan_');
    expect(artifactSource).toContain('SUM(r0."amount") AS "revenue"');
    expect(result.certification).toBe('governed');
    expect(result.governedCompilationReceipt?.result?.rowCount).toBe(1);
    expect(result.governedCompilationReceipt?.planFingerprint).toBe(plan.fingerprint);
  });

  it('executes the plan-selected certified block instead of a lexically stronger wrong block', async () => {
    kg.rebuild([{
      nodeId: 'block:selected_rollover_block',
      kind: 'block',
      name: 'selected_rollover_block',
      status: 'certified',
      description: 'The compatible monthly rollover result.',
    }, {
      nodeId: 'block:wrong_rollover_block',
      kind: 'block',
      name: 'wrong_rollover_block',
      status: 'certified',
      description: 'Wrong rollover rollover rollover keyword match.',
    }], []);
    const selected: AgentEvidenceCandidate = {
      id: 'block:selected_rollover_block',
      qualifiedId: 'block:selected_rollover_block',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'selected_rollover_block',
      relevanceScore: 0.94,
      matchReasons: ['full output contract'],
      compatibility: 'compatible',
    };
    const plan = planFor(selected, {
      interpretedQuestion: 'Run the compatible rollover result.',
      questionType: 'value',
      selectedConceptIds: [selected.id],
      recommendedExecutionId: selected.id,
      queryIntent: { measures: [], dimensions: [], filters: [] },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'certified',
    });
    const executed: string[] = [];
    const provider = new NeverProvider();
    const result = await answer({
      question: 'Run the wrong rollover block for rollover.',
      provider,
      kg,
      resolvedAnalyticalPlan: plan,
      executeCertifiedBlock: async (block) => {
        executed.push(block.nodeId);
        return { columns: ['value'], rows: [{ value: 42 }], rowCount: 1 };
      },
    });
    expect(executed).toEqual(['block:selected_rollover_block']);
    expect(provider.calls).toBe(0);
    expect(result.sourceCertifiedBlock).toBe('selected_rollover_block');
    expect(result.resolvedAnalyticalPlan?.fingerprint).toBe(plan.fingerprint);

    const failedProvider = new NeverProvider();
    const failed = await answer({
      question: 'Ignore that choice and try another route.',
      provider: failedProvider,
      kg,
      resolvedAnalyticalPlan: plan,
      executeCertifiedBlock: async () => {
        throw new Error('Binder Error: referenced column does not exist.');
      },
    });
    expect(failedProvider.calls).toBe(0);
    expect(failed.kind).toBe('no_answer');
    // The frozen artifact remains the route provenance even though its own
    // execution failed. `kind` remains no_answer and trust is not certified;
    // the engine must not recast this as generated/no_answer after freeze.
    expect(failed.route?.tier).toBe('certified_block');
    expect(failed.certification).toBe('analyst_review_required');
    expect(failed.executionError).toMatch(/referenced column/i);
    expect(failed.resolvedAnalyticalPlan?.fingerprint).toBe(plan.fingerprint);
  });

  it('keeps frozen certified output-role aliases on the certified route', async () => {
    kg.rebuild([{
      nodeId: 'block:top_customers',
      kind: 'block',
      name: 'top_customers',
      status: 'certified',
      entities: ['customer'],
      dimensions: ['customer'],
      declaredOutputs: ['customer_name', 'lifetime_spend', 'order_count'],
      outputContract: [
        { name: 'customer_name', role: 'entity_label' },
        { name: 'lifetime_spend', role: 'metric' },
        { name: 'order_count', role: 'metric' },
      ],
    }, {
      nodeId: 'block:food_vs_drink_revenue',
      kind: 'block',
      name: 'food_vs_drink_revenue',
      status: 'certified',
      entities: ['category'],
      dimensions: ['category'],
      // Mirrors a pre-role certified block: the authored dimension and
      // projected alias are both `category`, while the measure remains an
      // explicit artifact-local metric output.
      declaredOutputs: ['category', 'revenue'],
      outputContract: [
        { name: 'category' },
        { name: 'revenue', role: 'metric' },
      ],
    }], []);
    const topCustomers: AgentEvidenceCandidate = {
      id: 'block:top_customers',
      qualifiedId: 'block:top_customers',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_customers',
      dimensions: ['customer'],
      relevanceScore: 1,
      matchReasons: ['selected certified block'],
      compatibility: 'compatible',
    };
    const foodVsDrink: AgentEvidenceCandidate = {
      id: 'block:food_vs_drink_revenue',
      qualifiedId: 'block:food_vs_drink_revenue',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'food_vs_drink_revenue',
      dimensions: ['category'],
      compatibilityFacts: ['output: revenue'],
      relevanceScore: 1,
      matchReasons: ['selected certified block'],
      compatibility: 'compatible',
    };
    const topPlan = planFor(topCustomers, {
      interpretedQuestion: 'who are the top customers',
      questionType: 'ranking',
      selectedConceptIds: [topCustomers.id],
      recommendedExecutionId: topCustomers.id,
      queryIntent: { measures: [], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'certified',
    });
    const categoryPlan = planFor(foodVsDrink, {
      interpretedQuestion: 'show me sales by category',
      questionType: 'value',
      selectedConceptIds: [foodVsDrink.id],
      recommendedExecutionId: foodVsDrink.id,
      // Meaning resolution has already normalized the user-facing sales alias
      // to the certified artifact's declared `revenue` output. The frozen
      // execution plan must retain that authoritative alias.
      queryIntent: { measures: ['revenue'], dimensions: ['category'], filters: [] },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'certified',
    });

    const provider = new NeverProvider();
    const top = await answer({
      question: 'who are the top customers',
      provider,
      kg,
      resolvedAnalyticalPlan: topPlan,
      executeCertifiedBlock: async () => ({
        columns: ['customer_name', 'lifetime_spend', 'order_count'],
        rows: [{ customer_name: 'Ada', lifetime_spend: 100, order_count: 3 }],
        rowCount: 1,
      }),
    });
    const category = await answer({
      question: 'show me sales by category',
      provider,
      kg,
      resolvedAnalyticalPlan: categoryPlan,
      executeCertifiedBlock: async () => ({
        columns: ['category', 'revenue'],
        rows: [{ category: 'Food', revenue: 100 }],
        rowCount: 1,
      }),
    });

    expect(provider.calls).toBe(0);
    expect(top).toMatchObject({
      kind: 'certified', certification: 'certified', route: { tier: 'certified_block' },
      sourceCertifiedBlock: 'top_customers',
    });
    expect(category).toMatchObject({
      kind: 'certified', certification: 'certified', route: { tier: 'certified_block' },
      sourceCertifiedBlock: 'food_vs_drink_revenue',
    });
  });

  it('returns a same-tier terminal failure when a frozen certified block omits its declared measure output', async () => {
    kg.rebuild([{
      nodeId: 'block:incomplete_revenue',
      kind: 'block',
      name: 'incomplete_revenue',
      status: 'certified',
      entities: ['customer'],
      dimensions: ['customer'],
      declaredOutputs: ['customer_name', 'lifetime_spend'],
      outputContract: [
        { name: 'customer_name', role: 'entity_label' },
        { name: 'lifetime_spend', role: 'metric' },
      ],
    }], []);
    const selected: AgentEvidenceCandidate = {
      id: 'block:incomplete_revenue',
      qualifiedId: 'block:incomplete_revenue',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'incomplete_revenue',
      compatibilityFacts: ['output: revenue'],
      relevanceScore: 1,
      matchReasons: ['selected certified block'],
      compatibility: 'compatible',
    };
    const plan = planFor(selected, {
      interpretedQuestion: 'show me sales',
      questionType: 'value',
      selectedConceptIds: [selected.id],
      recommendedExecutionId: selected.id,
      queryIntent: { measures: ['sales'], dimensions: [], filters: [] },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'certified',
    });
    const provider = new NeverProvider();
    const result = await answer({
      question: 'show me sales',
      provider,
      kg,
      resolvedAnalyticalPlan: plan,
      executeCertifiedBlock: async () => ({
        columns: ['customer_name', 'lifetime_spend'],
        rows: [{ customer_name: 'Ada', lifetime_spend: 100 }],
        rowCount: 1,
      }),
    });

    expect(provider.calls).toBe(0);
    expect(result).toMatchObject({
      kind: 'no_answer',
      certification: 'analyst_review_required',
      reviewStatus: 'none',
      sourceTier: 'certified_artifact',
      certifiedResultShapeFailure: true,
      route: { tier: 'certified_block' },
    });
    expect(result.validationWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('revenue'),
    ]));
    expect(result.dqlArtifact?.kind).not.toBe('sql_block');
  });

  it('compiles the exact metric and dimension from the plan with zero member-selection calls', async () => {
    kg.rebuild([{
      nodeId: 'metric:rollover_balance',
      kind: 'metric',
      name: 'rollover_balance',
      status: 'certified',
      payload: {
        qualifiedId: 'semantic:consumption:rollover_balance',
        localId: 'rollover_balance',
        relation: 'usage',
        measureColumn: 'balance',
        analyticalCapability: semanticCapability('semantic:consumption:rollover_balance', 'balance'),
      },
    }, {
      nodeId: 'dimension:customer_name',
      kind: 'dimension',
      name: 'customer_name',
      payload: { qualifiedId: 'semantic:consumption:dimension:customer', localId: 'customer_name' },
    }], []);
    const selected: AgentEvidenceCandidate = {
      id: 'metric:rollover_balance',
      qualifiedId: 'semantic:consumption:rollover_balance',
      kind: 'semantic_metric',
      trustTier: 'semantic',
      name: 'Rollover Balance',
      dimensions: ['semantic:consumption:dimension:customer'],
      relevanceScore: 0.98,
      matchReasons: ['meaning'],
      compatibility: 'compatible',
      analyticalCapability: semanticCapability('semantic:consumption:rollover_balance', 'balance'),
    };
    const dimension: AgentEvidenceCandidate = {
      id: 'dimension:customer_name',
      qualifiedId: 'semantic:consumption:dimension:customer',
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'Customer',
      aliases: ['customer'],
      relevanceScore: 0.95,
      matchReasons: ['grouping'],
      compatibility: 'compatible',
    };
    const resolution: MeaningResolution = {
      interpretedQuestion: 'Rollover balance by customer.',
      questionType: 'ranking',
      selectedConceptIds: [selected.id],
      recommendedExecutionId: selected.id,
      queryIntent: { measures: ['rollover balance'], dimensions: ['customer'], filters: [], order: 'desc', limit: 5 },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'semantic',
    };
    const plan = buildResolvedAnalyticalPlan({
      question: resolution.interpretedQuestion,
      resolution,
      evidence: { snapshotId: 'snapshot-plan-first', candidates: [selected, dimension] },
      candidates: [selected, dimension],
      mode: 'authoritative',
    });
    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover Balance', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' }],
    });
    const executed: string[] = [];
    const provider = new NeverProvider();
    const result = await answer({
      question: 'Use some other similar metric by account.',
      provider,
      kg,
      semanticLayer,
      resolvedAnalyticalPlan: plan,
      executeGeneratedSql: async (sql) => {
        executed.push(sql);
        return { columns: ['customer_name', 'rollover_balance'], rows: [{ customer_name: 'A', rollover_balance: 10 }], rowCount: 1, sql };
      },
    });
    expect(provider.calls).toBe(0);
    expect(executed[0]).toContain('SUM(balance) AS rollover_balance');
    expect(executed[0]).toContain('customer_name');
    expect(result.route?.tier).toBe('semantic_metric');
    expect(result.aggregationSafetyProof).toMatchObject({
      status: 'safe',
      metricIds: ['semantic:consumption:rollover_balance'],
      planFingerprint: plan.fingerprint,
      issueCodes: [],
    });
    expect(result.resolvedAnalyticalPlan?.fingerprint).toBe(plan.fingerprint);

    const failedProvider = new NeverProvider();
    const failed = await answer({
      question: 'Substitute another metric if this one fails.',
      provider: failedProvider,
      kg,
      semanticLayer,
      resolvedAnalyticalPlan: plan,
      executeGeneratedSql: async () => {
        throw new Error('column balance does not exist');
      },
    });
    expect(failedProvider.calls).toBe(0);
    expect(failed.kind).toBe('no_answer');
    expect(failed.route?.tier).toBe('no_answer');
    expect(failed.executionError).toContain('column balance does not exist');
    expect(failed.resolvedAnalyticalPlan?.fingerprint).toBe(plan.fingerprint);
  });

  it('executes only the exact compiler-bound governed ratio expression', async () => {
    const metricId = 'semantic:metric:order_item.food_revenue_pct';
    const capability: MetricCapabilityContract = {
      metricId,
      semanticModelId: 'semantic:model:order_item',
      measureIds: [
        'semantic:measure:order_item.food_revenue',
        'semantic:measure:order_item.revenue',
      ],
      primaryEntityId: 'order_item',
      defaultResultGrainId: 'order_item',
      resultGrainIds: ['order_item'],
      aggregation: 'ratio',
      additivity: { entities: 'non_additive', time: 'non_additive' },
      dimensions: [],
      timeDimensions: [],
      operations: [],
      supportedOutputKinds: ['metric_value'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
      declaredOutputIds: ['food_revenue_pct'],
      sourceFingerprint: 'fixture:food-revenue-ratio',
    };
    const sameNameDecoyCapability: MetricCapabilityContract = {
      ...capability,
      metricId: 'semantic:metric:customer.food_revenue_pct',
      semanticModelId: 'semantic:model:customer',
      measureIds: [
        'semantic:measure:customer.food_revenue',
        'semantic:measure:customer.revenue',
      ],
      primaryEntityId: 'customer',
      defaultResultGrainId: 'customer',
      resultGrainIds: ['customer'],
      sourceFingerprint: 'fixture:customer-food-revenue-ratio-decoy',
    };
    kg.rebuild([{
      nodeId: 'metric:food_revenue_pct',
      kind: 'metric',
      name: 'food_revenue_pct',
      status: 'certified',
      payload: {
        qualifiedId: metricId,
        localId: 'food_revenue_pct',
        analyticalCapability: capability,
      },
    }, {
      nodeId: 'metric:customer_food_revenue_pct',
      kind: 'metric',
      name: 'food_revenue_pct',
      status: 'certified',
      payload: {
        qualifiedId: sameNameDecoyCapability.metricId,
        localId: 'food_revenue_pct',
        analyticalCapability: sameNameDecoyCapability,
      },
    }], []);
    const selected: AgentEvidenceCandidate = {
      id: 'metric:food_revenue_pct',
      qualifiedId: metricId,
      kind: 'semantic_metric',
      trustTier: 'semantic',
      name: 'Food Revenue Percentage',
      relevanceScore: 1,
      matchReasons: ['exact qualified metric'],
      compatibility: 'compatible',
      analyticalCapability: capability,
    };
    const plan = planFor(selected, {
      interpretedQuestion: 'What is the food revenue percentage?',
      questionType: 'value',
      selectedConceptIds: [selected.id],
      recommendedExecutionId: selected.id,
      queryIntent: { measures: ['food revenue percentage'], dimensions: [], filters: [] },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'semantic',
      analyticalFrame: {
        version: 2,
        interpretedQuestion: 'What is the food revenue percentage?',
        questionType: 'value',
        metricConceptIds: [metricId],
        entityGrainIds: ['order_item'],
        dimensions: [],
        memberBindings: [],
        requestedOutputs: [{ id: 'food_revenue_pct', kind: 'metric_value', metricId }],
        ambiguity: [],
      },
    });
    const metricExpression = 'SUM(CASE WHEN is_food_item THEN product_price ELSE 0 END) / SUM(order_item.product_price)';
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'food_revenue_pct',
        label: 'Food Revenue %',
        description: '',
        domain: 'sales',
        sql: metricExpression,
        type: 'custom',
        aggregation: 'ratio',
        table: '',
        cube: 'order_item',
        metricType: 'ratio',
        typeParams: { numerator: { name: 'food_revenue' }, denominator: { name: 'revenue' } },
      }],
      dimensions: [],
      measures: [{
        name: 'food_revenue', label: 'Food Revenue', description: '', domain: 'sales', agg: 'sum',
        expr: 'CASE WHEN is_food_item THEN product_price ELSE 0 END', table: 'analytics.order_items', cube: 'order_item',
      }, {
        name: 'revenue', label: 'Revenue', description: '', domain: 'sales', agg: 'sum',
        expr: 'product_price', table: 'analytics.order_items', cube: 'order_item',
      }],
    });
    const provider = new NeverProvider();
    let executions = 0;
    const safeSql = 'SELECT CAST(SUM(CASE WHEN is_food_item THEN product_price ELSE 0 END) AS DOUBLE) / CAST(NULLIF(SUM(product_price), 0) AS DOUBLE) AS food_revenue_pct FROM analytics.order_items';
    const receiptFor = (sql: string): SemanticAggregationCompilerReceiptV1 => {
      const compiledExpression = buildSqlOutputExpressionSignature(sql, 'food_revenue_pct');
      if (!compiledExpression) throw new Error('fixture SQL has no exact output expression');
      const body = {
        version: 1 as const,
        executionId: plan.executionId!,
        capabilityFingerprint: plan.selectedCapabilityFingerprint!,
        metricId,
        metricExpressionSql: metricExpression,
        operator: 'ratio' as const,
        orderedMeasureIds: [...capability.measureIds],
        physicalRelation: 'analytics.order_items',
        relationAliases: ['order_item'],
        outputAlias: 'food_revenue_pct',
        dimensionIds: [],
        relationshipPathIds: [],
        relationshipProofFingerprints: [...new Set(
          plan.relationshipProofs?.map((proof) => proof.authorityFingerprint) ?? [],
        )].sort(),
        orderBy: [],
        compiledSqlFingerprint: semanticExecutionFingerprint(sql),
        compiledExpressionFingerprint: semanticExecutionFingerprint(compiledExpression.canonicalExpression),
        planFingerprint: plan.fingerprint,
        snapshotId: plan.snapshotId,
        targetFingerprint: 'target:fixture',
      };
      return { ...body, receiptFingerprint: semanticExecutionFingerprint(body) };
    };
    const safe = await answer({
      question: 'What is the food revenue percentage?',
      provider,
      kg,
      semanticLayer,
      resolvedAnalyticalPlan: plan,
      semanticQueryCompiler: async (selection) => ({
        sql: safeSql,
        engine: 'metricflow-cli',
        selection,
        trace: {
          version: 1,
          adapter: 'metricflow-cli',
          status: 'compiled',
          authoringRequest: { metrics: selection.metrics, dimensions: selection.dimensions ?? [] },
          bindings: [],
          warnings: [],
          steps: [],
          targetBinding: { executionTarget: { identityFingerprint: 'target:fixture' } },
        },
        aggregationCompilerReceipt: receiptFor(safeSql),
      }),
      executeGeneratedSql: async (sql) => {
        executions += 1;
        return { columns: ['food_revenue_pct'], rows: [{ food_revenue_pct: 0.42 }], rowCount: 1, sql };
      },
    });
    expect(safe).toMatchObject({
      kind: 'uncertified',
      aggregationSafetyProof: { status: 'safe', issueCodes: [] },
    });
    expect(executions).toBe(1);

    const selectedReceipt = receiptFor(safeSql);
    const { receiptFingerprint: _selectedFingerprint, ...wrongReceiptBody } = {
      ...selectedReceipt,
      executionId: sameNameDecoyCapability.metricId,
      capabilityFingerprint: sameNameDecoyCapability.sourceFingerprint,
    };
    const wrongReceipt = {
      ...wrongReceiptBody,
      receiptFingerprint: semanticExecutionFingerprint(wrongReceiptBody),
    };
    const wrongAuthority = await answer({
      question: 'What is the food revenue percentage?',
      provider,
      kg,
      semanticLayer,
      resolvedAnalyticalPlan: plan,
      semanticQueryCompiler: async (selection) => ({
        sql: safeSql,
        engine: 'metricflow-cli',
        selection,
        trace: {
          version: 1,
          adapter: 'metricflow-cli',
          status: 'compiled',
          authoringRequest: { metrics: selection.metrics, dimensions: selection.dimensions ?? [] },
          bindings: [],
          warnings: [],
          steps: [],
          targetBinding: { executionTarget: { identityFingerprint: 'target:fixture' } },
        },
        aggregationCompilerReceipt: wrongReceipt,
      }),
      executeGeneratedSql: async () => {
        executions += 1;
        throw new Error('a nonselected same-name capability must not execute');
      },
    });
    expect(wrongAuthority.kind).toBe('no_answer');
    expect(wrongAuthority.aggregationSafetyProof).toMatchObject({
      status: 'blocked',
      metricIds: [metricId],
      issueCodes: expect.arrayContaining(['SEMANTIC_COMPILER_RECEIPT_AUTHORITY_MISMATCH']),
    });
    expect(executions).toBe(1);

    for (const sql of [
      'SELECT SUM(secret_salary) / SUM(secret_tax) AS food_revenue_pct FROM analytics.order_items',
      'SELECT SUM(CASE WHEN is_food_item THEN product_price ELSE 0 END) + SUM(order_item.product_price) AS food_revenue_pct FROM analytics.order_items AS order_item',
    ]) {
      const blocked = await answer({
        question: 'What is the food revenue percentage?',
        provider,
        kg,
        semanticLayer,
        resolvedAnalyticalPlan: plan,
        semanticQueryCompiler: async (selection) => ({
          sql,
          engine: 'metricflow-cli',
          selection,
          trace: {
            version: 1,
            adapter: 'metricflow-cli',
            status: 'compiled',
            authoringRequest: { metrics: selection.metrics, dimensions: selection.dimensions ?? [] },
            bindings: [],
            warnings: [],
            steps: [],
            targetBinding: { executionTarget: { identityFingerprint: 'target:fixture' } },
          },
          aggregationCompilerReceipt: receiptFor(sql),
        }),
        executeGeneratedSql: async () => {
          executions += 1;
          throw new Error('unsafe SQL must not execute');
        },
      });
      expect(blocked.kind, sql).toBe('no_answer');
      expect(blocked.aggregationSafetyProof, sql).toMatchObject({
        status: 'blocked',
        issueCodes: expect.arrayContaining(['SEMANTIC_RATIO_COMPILER_BINDING_REQUIRED']),
      });
      // Aggregation proof rejection occurs after semantic SQL composition but
      // before a warehouse statement is dispatched. Keep the durable failure
      // at the semantic compiler boundary so trace projection cannot present
      // it as result normalization or SQL execution.
      expect(blocked.analyticalFailure, sql).toMatchObject({
        code: 'COMPILATION_FAILED',
        phase: 'compilation',
        safeActions: expect.arrayContaining(['edit_dql']),
      });
    }
    expect(provider.calls).toBe(0);
    expect(executions).toBe(1);
  });

  it('executes a bounded current/prior semantic graph before calculating and ranking the result', async () => {
    const metricId = 'semantic:consumption:rollover_balance';
    const customerId = 'semantic:consumption:dimension:customer';
    const dateId = 'semantic:consumption:dimension:report_date';
    const capability: MetricCapabilityContract = {
      metricId,
      measureIds: ['semantic:consumption:measure:rollover_balance'],
      // This is a same-entity semantic grouping fixture. It must not rely on
      // a generic relationship path as if it were MetricFlow-native proof.
      primaryEntityId: 'customer',
      defaultResultGrainId: 'scalar',
      resultGrainIds: ['scalar', 'customer'],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [{
        dimensionId: customerId,
        entityId: 'customer',
        supportedRoles: ['group_by', 'rank_entity'],
        relationshipPathIds: ['consumption::relationship::balance_to_customer'],
      }],
      timeDimensions: [{
        dimensionId: dateId,
        role: 'report_as_of',
        supportedGrains: ['day', 'month', 'year'],
      }],
      operations: ['group', 'compare', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta', 'rank'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
      sourceFingerprint: 'semantic-graph-capability-v1',
    };
    kg.rebuild([{
      nodeId: 'metric:rollover_balance',
      kind: 'metric',
      name: 'rollover_balance',
      status: 'certified',
      payload: { qualifiedId: metricId, localId: 'rollover_balance', analyticalCapability: capability },
    }, {
      nodeId: 'dimension:customer_name',
      kind: 'dimension',
      name: 'customer_name',
      payload: { qualifiedId: customerId, localId: 'customer_name' },
    }, {
      nodeId: 'dimension:report_date',
      kind: 'dimension',
      name: 'report_date',
      payload: { qualifiedId: dateId, localId: 'report_date' },
    }], []);
    const selected: AgentEvidenceCandidate = {
      id: 'metric:rollover_balance',
      qualifiedId: metricId,
      kind: 'semantic_metric',
      trustTier: 'semantic',
      name: 'Rollover Balance',
      dimensions: [customerId, dateId],
      relevanceScore: 0.99,
      matchReasons: ['exact metric'],
      compatibility: 'compatible',
      analyticalCapability: capability,
    };
    const dimension: AgentEvidenceCandidate = {
      id: 'dimension:customer_name',
      qualifiedId: customerId,
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'Customer',
      aliases: ['customer'],
      relevanceScore: 0.95,
      matchReasons: ['grouping'],
      compatibility: 'compatible',
    };
    const frame: AnalyticalQuestionFrameV2 = {
      version: 2,
      interpretedQuestion: 'Current and prior rollover balance for the top two customers.',
      questionType: 'ranking',
      metricConceptIds: [metricId],
      entityGrainIds: ['customer'],
      dimensions: [
        { dimensionId: customerId, role: 'group_by' },
        { dimensionId: customerId, role: 'rank_entity' },
        { dimensionId: dateId, role: 'time_axis' },
      ],
      memberBindings: [],
      timeContext: {
        timeDimensionId: dateId,
        timeRole: 'report_as_of',
        calendarId: 'calendar:gregorian',
        timezone: 'UTC',
        grain: 'day',
        completenessPolicy: 'closed_period',
        periods: [
          { id: 'current', kind: 'absolute', start: '2026-01-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' },
          { id: 'previous_year', kind: 'previous_year', start: '2025-01-01T00:00:00.000Z', end: '2025-07-01T00:00:00.000Z', alignToPeriodId: 'current' },
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
        entityDimensionId: customerId,
        byMetricId: metricId,
        byPeriodId: 'current',
        direction: 'desc',
        limit: 2,
        tiePolicy: 'stable_secondary_key',
      },
      requestedOutputs: [
        { id: 'customer', kind: 'dimension' },
        { id: 'current_balance', kind: 'metric_value', metricId, periodId: 'current' },
        { id: 'prior_balance', kind: 'metric_value', metricId, periodId: 'previous_year' },
        { id: 'balance_delta', kind: 'delta', metricId },
        { id: 'balance_percent_delta', kind: 'percent_delta', metricId },
        { id: 'rank', kind: 'rank' },
      ],
      ambiguity: [],
    };
    const resolution: MeaningResolution = {
      interpretedQuestion: frame.interpretedQuestion,
      questionType: 'ranking',
      selectedConceptIds: [selected.id],
      recommendedExecutionId: selected.id,
      queryIntent: { measures: ['rollover balance'], dimensions: ['customer'], filters: [], order: 'desc', limit: 2 },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'semantic',
      analyticalFrame: frame,
    };
    const plan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution,
      evidence: { snapshotId: 'snapshot-plan-first', candidates: [selected, dimension] },
      candidates: [selected, dimension],
      mode: 'authoritative',
    });
    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover Balance', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' },
        { name: 'report_date', label: 'Report date', description: '', domain: 'consumption', sql: 'report_date', type: 'date', table: 'usage', isTimeDimension: true, granularities: ['day', 'month', 'year'] },
      ],
    });
    const provider = new NeverProvider();
    let executions = 0;
    const result = await answer({
      question: frame.interpretedQuestion,
      provider,
      kg,
      semanticLayer,
      resolvedAnalyticalPlan: plan,
      executeGeneratedSql: async (sql) => {
        executions += 1;
        const current = executions === 1;
        return {
          columns: ['customer_name', 'rollover_balance'],
          rows: current
            ? [{ customer_name: 'Zoom', rollover_balance: '100.10' }, { customer_name: 'Acme', rollover_balance: '50' }]
            : [{ customer_name: 'Zoom', rollover_balance: '80.05' }, { customer_name: 'Acme', rollover_balance: '40' }],
          rowCount: 2,
          sql,
        };
      },
    });
    expect(provider.calls).toBe(0);
    expect(executions).toBe(2);
    expect(result.analyticalExecutionGraph?.nodes.map((node) => node.kind)).toEqual([
      'source_invocation',
      'source_invocation',
      'align_periods',
      'calculate_comparison',
      'rank',
      'project_validate',
    ]);
    expect(result.analyticalExecutionReceipt).toMatchObject({
      route: 'semantic',
      trustState: 'governed',
      rowCount: 2,
      subReceipts: [{ nodeId: 'source:current' }, { nodeId: 'source:previous_year' }],
    });
    expect(result.result).toMatchObject({
      columns: ['customer', 'current_balance', 'prior_balance', 'balance_delta', 'balance_percent_delta', 'rank'],
      rows: [
        ['Zoom', '100.10', '80.05', '20.05', '25.046845721424', 1],
        ['Acme', '50', '40', '10', '25', 2],
      ],
      rowCount: 2,
    });
    expect(result.analyticalFacts?.receiptId).toBe(result.analyticalExecutionReceipt?.receiptId);
    expect(result.analyticalNarrative?.claims.length).toBeGreaterThan(0);
    expect(result.text).toContain('Zoom');

    let deniedExecutions = 0;
    const permissionFailure = await answer({
      question: 'Try another table if access is denied.',
      provider,
      kg,
      semanticLayer,
      resolvedAnalyticalPlan: plan,
      executeGeneratedSql: async () => {
        deniedExecutions += 1;
        throw Object.assign(new Error('permission denied for relation private_usage password=hunter2'), { code: '42501' });
      },
    });
    expect(provider.calls).toBe(0);
    expect(deniedExecutions).toBe(1);
    expect(permissionFailure).toMatchObject({
      kind: 'no_answer',
      analyticalFailure: {
        code: 'PERMISSION_DENIED',
        phase: 'execution',
        recoverability: 'request_access',
        safeActions: ['request_access', 'change_authorized_connection'],
        planFingerprint: plan.fingerprint,
      },
    });
    expect(permissionFailure.executionError).not.toMatch(/private_usage|hunter2/);
    expect(permissionFailure.sql).toContain('SUM(balance) AS rollover_balance');
    expect(permissionFailure.dqlArtifact?.source).toContain('metrics = ["rollover_balance"]');

    const unboundedFrame = structuredClone(frame);
    unboundedFrame.timeContext!.completenessPolicy = 'latest_complete';
    unboundedFrame.timeContext!.periods = [
      { id: 'current', kind: 'current' },
      { id: 'previous_year', kind: 'previous_year', alignToPeriodId: 'current' },
    ];
    const unboundedPlan = buildResolvedAnalyticalPlan({
      question: unboundedFrame.interpretedQuestion,
      resolution: { ...resolution, analyticalFrame: unboundedFrame },
      evidence: { snapshotId: 'snapshot-plan-first', candidates: [selected, dimension] },
      candidates: [selected, dimension],
      mode: 'authoritative',
    });
    let freshnessCalls = 0;
    let freshnessAdapterRequest: unknown;
    const periodSql: string[] = [];
    const freshnessBound = await answer({
      question: unboundedFrame.interpretedQuestion,
      provider,
      kg,
      semanticLayer,
      resolvedAnalyticalPlan: unboundedPlan,
      analyticalReferenceInstant: '2026-07-22T15:30:00.000Z',
      resolveAnalyticalFreshness: async (request) => {
        freshnessCalls += 1;
        freshnessAdapterRequest = request.authorizedAdapterRequest;
        return {
          version: 1,
          snapshotId: request.snapshotId,
          metricId: request.metricId,
          timeDimensionId: request.timeDimensionId,
          observedThrough: '2026-07-22T00:00:00.000Z',
        };
      },
      executeGeneratedSql: async (sql) => {
        periodSql.push(sql);
        return {
          columns: ['customer_name', 'rollover_balance'],
          rows: [{ customer_name: 'Zoom', rollover_balance: periodSql.length === 1 ? '100' : '80' }],
          rowCount: 1,
          sql,
        };
      },
    });
    expect(freshnessCalls).toBe(1);
    expect(freshnessAdapterRequest).toMatchObject({
      route: 'semantic',
      metric: 'rollover_balance',
      timeDimension: 'report_date',
      granularity: 'day',
      outputField: 'report_date_day',
    });
    expect(periodSql).toHaveLength(2);
    expect(freshnessBound.resolvedAnalyticalPlan).toMatchObject({
      parentPlanId: unboundedPlan.planId,
      analyticalFrame: {
        timeContext: {
          periods: [
            { id: 'current', start: '2026-07-21T00:00:00.000Z', end: '2026-07-22T00:00:00.000Z' },
            { id: 'previous_year', start: '2025-07-21T00:00:00.000Z', end: '2025-07-22T00:00:00.000Z' },
          ],
        },
      },
    });
    expect(freshnessBound.analyticalFreshnessObservation?.observedThrough).toBe('2026-07-22T00:00:00.000Z');
  });
});

function semanticCapability(metricId: string, measure: string): MetricCapabilityContract {
  return {
    metricId,
    semanticModelId: 'semantic:consumption',
    measureIds: [measure],
    // The test's `customer_name` grouping is declared on this metric model;
    // it is not a synthetic cross-model join. Keeping it same-entity avoids
    // treating a bare result grain as adapter-native relationship proof.
    primaryEntityId: 'customer_name',
    defaultResultGrainId: 'usage',
    resultGrainIds: ['usage', 'customer_name'],
    aggregation: 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: [{
      dimensionId: 'semantic:consumption:dimension:customer',
      entityId: 'customer_name',
      supportedRoles: ['group_by', 'rank_entity'],
    }],
    timeDimensions: [],
    operations: ['group', 'rank'],
    supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
    executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
    sourceFingerprint: `fixture:${metricId}`,
  };
}
