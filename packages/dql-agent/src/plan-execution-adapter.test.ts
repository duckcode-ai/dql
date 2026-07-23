import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { buildAnalyticalExecutionGraph } from './analytical-execution-graph.js';
import {
  adaptAnalyticalFreshnessRequest,
  adaptAnalyticalSemanticGraph,
  adaptResolvedAnalyticalPlan,
  buildPlanExecutionRegistry,
} from './plan-execution-adapter.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';
import type { KGNode } from './kg/types.js';
import type { AnalyticalQuestionFrameV2, MetricCapabilityContract } from '@duckcodeailabs/dql-core';

const metric: AgentEvidenceCandidate = {
  id: 'semantic:metric:usage.rollover_balance',
  qualifiedId: 'semantic:consumption:rollover_balance',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Rollover Balance',
  aliases: ['rollover balance'],
  domain: 'consumption',
  dimensions: ['semantic:consumption:dimension:customer'],
  relevanceScore: 0.99,
  matchReasons: ['exact meaning'],
  compatibility: 'compatible',
};
const dimension: AgentEvidenceCandidate = {
  id: 'semantic:dimension:usage.customer_name',
  qualifiedId: 'semantic:consumption:dimension:customer',
  kind: 'semantic_member',
  trustTier: 'semantic',
  name: 'Customer',
  aliases: ['customer'],
  domain: 'consumption',
  relevanceScore: 0.95,
  matchReasons: ['requested grouping'],
  compatibility: 'compatible',
};
const evidence: AgentRetrievalEvidence = {
  snapshotId: 'snapshot-1',
  candidates: [metric, dimension],
};
const resolution: MeaningResolution = {
  interpretedQuestion: 'Top customers by rollover balance.',
  questionType: 'ranking',
  selectedConceptIds: [metric.id],
  recommendedExecutionId: metric.id,
  queryIntent: {
    measures: ['rollover balance'],
    dimensions: ['customer'],
    filters: [],
    order: 'desc',
    limit: 10,
  },
  rejectedCandidates: [],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'semantic',
};

function semanticPlan() {
  return buildResolvedAnalyticalPlan({
    question: 'Who are the top customers by rollover balance?',
    resolution,
    evidence,
    candidates: [metric, dimension],
    mode: 'authoritative',
  });
}

function semanticNodes(): KGNode[] {
  return [{
    nodeId: 'metric:usage.rollover_balance',
    kind: 'metric',
    name: 'rollover_balance',
    domain: 'consumption',
    payload: {
      qualifiedId: 'semantic:consumption:rollover_balance',
      localId: 'rollover_balance',
      aliases: ['usage.rollover_balance'],
    },
  }, {
    nodeId: 'dimension:usage.customer_name',
    kind: 'dimension',
    name: 'customer_name',
    domain: 'consumption',
    payload: {
      qualifiedId: 'semantic:consumption:dimension:customer',
      localId: 'customer_name',
    },
  }];
}

describe('plan execution adapter (AGT-013 / AGT-014 / API-006)', () => {
  it('binds exact qualified semantic IDs to a compiler selection without question rematching', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' }],
    });
    const binding = adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry: buildPlanExecutionRegistry({ nodes: semanticNodes() }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    });
    expect(binding).toMatchObject({
      status: 'ready',
      kind: 'semantic',
      selection: {
        metrics: ['rollover_balance'],
        dimensions: ['customer_name'],
        orderBy: [{ name: 'rollover_balance', direction: 'desc' }],
        limit: 10,
      },
    });
  });

  it('fails closed on a stale snapshot and an ambiguous canonical registry ID', () => {
    const registry = buildPlanExecutionRegistry({ nodes: semanticNodes() });
    expect(adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry,
      expectedSnapshotId: 'snapshot-2',
    })).toMatchObject({ status: 'blocked', code: 'SNAPSHOT_MISMATCH' });

    const duplicate = { ...semanticNodes()[0]!, nodeId: 'metric:usage.rollover_balance_copy' };
    expect(adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry: buildPlanExecutionRegistry({ nodes: [...semanticNodes(), duplicate] }),
      semanticLayer: new SemanticLayer({ metrics: [], dimensions: [] }),
    })).toMatchObject({ status: 'blocked', code: 'EXECUTION_ID_AMBIGUOUS' });
  });

  it('binds freshness to the same exact metric, time dimension, and snapshot without search', () => {
    const dateId = 'semantic:consumption:dimension:report_date';
    const frame: AnalyticalQuestionFrameV2 = {
      version: 2,
      interpretedQuestion: 'What is rollover balance today?',
      questionType: 'scalar',
      metricConceptIds: [metric.qualifiedId!],
      entityGrainIds: ['account'],
      dimensions: [{ dimensionId: dateId, role: 'time_axis' }],
      memberBindings: [],
      timeContext: {
        timeDimensionId: dateId,
        timeRole: 'report_as_of',
        calendarId: 'calendar:gregorian',
        timezone: 'UTC',
        grain: 'month',
        completenessPolicy: 'latest_complete',
        periods: [{ id: 'current', kind: 'current' }],
      },
      requestedOutputs: [{ id: 'rollover_balance', kind: 'metric_value', metricId: metric.qualifiedId!, periodId: 'current' }],
      ambiguity: [],
    };
    const plan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution: { ...resolution, analyticalFrame: frame },
      evidence: { snapshotId: 'snapshot-1', candidates: [metric] },
      candidates: [metric],
      mode: 'authoritative',
    });
    const registry = buildPlanExecutionRegistry({
      nodes: [
        semanticNodes()[0]!,
        {
          nodeId: 'dimension:usage.report_date',
          kind: 'dimension',
          name: 'report_date',
          payload: { qualifiedId: dateId, localId: 'report_date' },
        },
      ],
    });
    const layer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [{
        name: 'report_date', label: 'Report date', description: '', domain: 'consumption', sql: 'report_date', type: 'date', table: 'usage',
        isTimeDimension: true, granularities: ['day', 'month'],
      }],
    });
    const request = {
      version: 1 as const,
      snapshotId: 'snapshot-1',
      metricId: metric.qualifiedId!,
      timeDimensionId: dateId,
    };
    expect(adaptAnalyticalFreshnessRequest({
      plan,
      request,
      registry,
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    })).toEqual({
      schemaVersion: 1,
      status: 'ready',
      kind: 'semantic_freshness',
      request: {
        route: 'semantic',
        metric: 'rollover_balance',
        timeDimension: 'report_date',
        granularity: 'day',
        outputField: 'report_date_day',
      },
    });
    expect(adaptAnalyticalFreshnessRequest({
      plan,
      request: { ...request, timeDimensionId: 'semantic:consumption:dimension:other_date' },
      registry,
      semanticLayer: layer,
    })).toMatchObject({ status: 'blocked', code: 'TIME_DIMENSION_REQUIRED' });
  });

  it('binds a certified block only when its snapshot status is certified', () => {
    const blockCandidate: AgentEvidenceCandidate = {
      id: 'dql:block:consumption:rollover_leaders',
      qualifiedId: 'consumption::block::rollover_leaders',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'Rollover Leaders',
      relevanceScore: 1,
      matchReasons: ['explicit block'],
      compatibility: 'compatible',
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Run the certified rollover leaders block.',
      resolution: {
        interpretedQuestion: 'Run Rollover Leaders.',
        questionType: 'value',
        selectedConceptIds: [blockCandidate.id],
        recommendedExecutionId: blockCandidate.id,
        queryIntent: { measures: [], dimensions: [], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'certified',
      },
      evidence: { snapshotId: 'snapshot-1', candidates: [blockCandidate] },
      candidates: [blockCandidate],
      mode: 'authoritative',
    });
    const node: KGNode = { nodeId: 'block:Rollover Leaders', kind: 'block', name: 'Rollover Leaders', status: 'certified' };
    const registry = buildPlanExecutionRegistry({
      nodes: [node],
      objects: [{
        objectKey: blockCandidate.id,
        objectType: 'dql_block',
        name: node.name,
        fullName: blockCandidate.qualifiedId,
      }],
    });
    expect(adaptResolvedAnalyticalPlan({ plan, registry })).toMatchObject({
      status: 'ready',
      kind: 'certified',
      node: { nodeId: 'block:Rollover Leaders' },
    });
    expect(adaptResolvedAnalyticalPlan({
      plan,
      registry: buildPlanExecutionRegistry({ nodes: [{ ...node, status: 'draft' }], objects: [{
        objectKey: blockCandidate.id,
        objectType: 'dql_block',
        name: node.name,
        fullName: blockCandidate.qualifiedId,
      }] }),
    })).toMatchObject({ status: 'blocked', code: 'CERTIFICATION_REQUIRED' });
  });

  it('adapts each bounded graph period to exact semantic members without rematching the question', () => {
    const customerId = 'semantic:consumption:dimension:customer';
    const dateId = 'semantic:consumption:dimension:report_date';
    const metricId = metric.qualifiedId!;
    const frame: AnalyticalQuestionFrameV2 = {
      version: 2,
      interpretedQuestion: 'Current and prior rollover balance for top customers.',
      questionType: 'ranking',
      metricConceptIds: [metricId],
      entityGrainIds: ['customer'],
      dimensions: [
        { dimensionId: customerId, role: 'group_by' },
        { dimensionId: customerId, role: 'rank_entity' },
        { dimensionId: dateId, role: 'time_axis' },
      ],
      memberBindings: [{
        dimensionId: customerId,
        canonicalValues: ['Zoom'],
        source: 'question',
        confidence: 'exact',
      }],
      timeContext: {
        timeDimensionId: dateId,
        timeRole: 'report_as_of',
        calendarId: 'calendar:gregorian',
        timezone: 'UTC',
        grain: 'day',
        completenessPolicy: 'closed_period',
        periods: [
          { id: 'current', kind: 'absolute', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' },
          { id: 'previous_year', kind: 'previous_year', start: '2025-07-01T00:00:00.000Z', end: '2025-08-01T00:00:00.000Z', alignToPeriodId: 'current' },
        ],
      },
      comparison: {
        basePeriodId: 'current',
        comparisonPeriodIds: ['previous_year'],
        alignment: 'calendar_period',
        outputs: ['value', 'absolute_delta', 'percent_delta'],
        zeroDenominatorPolicy: 'null',
      },
      ranking: {
        entityDimensionId: customerId,
        byMetricId: metricId,
        byPeriodId: 'current',
        direction: 'desc',
        limit: 5,
        tiePolicy: 'stable_secondary_key',
      },
      requestedOutputs: [
        { id: 'customer', kind: 'dimension' },
        { id: 'current_balance', kind: 'metric_value', metricId, periodId: 'current' },
        { id: 'prior_balance', kind: 'metric_value', metricId, periodId: 'previous_year' },
        { id: 'balance_delta', kind: 'delta', metricId },
        { id: 'balance_percent_delta', kind: 'percent_delta', metricId },
      ],
      ambiguity: [],
    };
    const analyticalCapability: MetricCapabilityContract = {
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
        supportedRoles: ['group_by', 'filter', 'rank_entity'],
        relationshipPathIds: ['consumption::relationship::balance_to_customer'],
      }],
      timeDimensions: [{
        dimensionId: dateId,
        role: 'report_as_of',
        supportedGrains: ['day', 'month', 'year'],
      }],
      operations: ['filter', 'group', 'compare', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
      sourceFingerprint: 'semantic-capability-v1',
    };
    const plan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution: { ...resolution, analyticalFrame: frame },
      evidence,
      candidates: [metric, dimension],
      mode: 'authoritative',
    });
    const built = buildAnalyticalExecutionGraph({
      plan,
      capability: analyticalCapability,
      route: 'semantic',
      adapterId: 'metricflow-cli',
    });
    if (built.status !== 'ready') throw new Error(built.reason);
    const nodes = [
      ...semanticNodes(),
      {
        nodeId: 'dimension:usage.report_date',
        kind: 'dimension' as const,
        name: 'report_date',
        domain: 'consumption',
        payload: { qualifiedId: dateId, localId: 'report_date' },
      },
    ];
    const layer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' },
        { name: 'report_date', label: 'Report date', description: '', domain: 'consumption', sql: 'report_date', type: 'date', table: 'usage', isTimeDimension: true, granularities: ['day', 'month', 'year'] },
      ],
    });
    const binding = adaptAnalyticalSemanticGraph({
      graph: built.graph,
      plan,
      registry: buildPlanExecutionRegistry({ nodes }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    });
    expect(binding).toMatchObject({
      status: 'ready',
      kind: 'semantic_graph',
      invocations: [
        {
          nodeId: 'source:current',
          adapterId: 'metricflow-cli',
          selection: {
            metrics: ['rollover_balance'],
            dimensions: ['customer_name'],
            filters: [
              { dimension: 'customer_name', operator: 'equals', values: ['Zoom'] },
              { dimension: 'report_date', operator: 'gte', values: ['2026-07-01T00:00:00.000Z'] },
              { dimension: 'report_date', operator: 'lt', values: ['2026-08-01T00:00:00.000Z'] },
            ],
          },
          outputAliases: { metric: { outputId: 'current_balance' } },
        },
        {
          nodeId: 'source:previous_year',
          selection: {
            metrics: ['rollover_balance'],
            dimensions: ['customer_name'],
            filters: [
              { dimension: 'customer_name', operator: 'equals', values: ['Zoom'] },
              { dimension: 'report_date', operator: 'gte', values: ['2025-07-01T00:00:00.000Z'] },
              { dimension: 'report_date', operator: 'lt', values: ['2025-08-01T00:00:00.000Z'] },
            ],
          },
          outputAliases: { metric: { outputId: 'prior_balance' } },
        },
      ],
    });
  });
});
