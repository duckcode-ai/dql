import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticLayer, type AnalyticalQuestionFrameV2, type MetricCapabilityContract } from '@duckcodeailabs/dql-core';
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
    expect(failed.route?.tier).toBe('no_answer');
    expect(failed.executionError).toMatch(/referenced column/i);
    expect(failed.resolvedAnalyticalPlan?.fingerprint).toBe(plan.fingerprint);
  });

  it('compiles the exact metric and dimension from the plan with zero member-selection calls', async () => {
    kg.rebuild([{
      nodeId: 'metric:rollover_balance',
      kind: 'metric',
      name: 'rollover_balance',
      status: 'certified',
      payload: { qualifiedId: 'semantic:consumption:rollover_balance', localId: 'rollover_balance' },
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

  it('executes a bounded current/prior semantic graph before calculating and ranking the result', async () => {
    const metricId = 'semantic:consumption:rollover_balance';
    const customerId = 'semantic:consumption:dimension:customer';
    const dateId = 'semantic:consumption:dimension:report_date';
    const capability: MetricCapabilityContract = {
      metricId,
      measureIds: ['semantic:consumption:measure:rollover_balance'],
      primaryEntityId: 'account',
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
    expect(permissionFailure.dqlArtifact?.source).toContain('metric = "rollover_balance"');

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
