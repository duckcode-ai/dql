import { describe, expect, it } from 'vitest';
import type { AnalyticalQuestionFrameV2, MetricCapabilityContract } from '@duckcodeailabs/dql-core';
import { buildAnalyticalExecutionGraph } from './analytical-execution-graph.js';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import {
  compileGovernedRelationalExecutionGraph,
  compileGovernedRelationalPlan,
  finalizeGovernedCompilationReceipt,
  type GovernedRelationalRegistry,
} from './governed-relational-compiler.js';
import type { AgentEvidenceCandidate, MeaningResolution } from './meaning-resolution.js';

const amount: AgentEvidenceCandidate = {
  id: 'dbt:column:orders.amount',
  qualifiedId: 'dbt:column:orders.amount',
  kind: 'sql_column',
  trustTier: 'governed_sql',
  name: 'Revenue Amount',
  aliases: ['revenue'],
  aggregation: 'sum',
  sourceObjects: ['model.shop.orders'],
  relationshipEvidence: ['commerce::relationship::orders_to_customers'],
  relevanceScore: 0.96,
  matchReasons: ['measure'],
  compatibility: 'compatible',
};
const customer: AgentEvidenceCandidate = {
  id: 'dbt:column:customers.customer_name',
  qualifiedId: 'dbt:column:customers.customer_name',
  kind: 'sql_column',
  trustTier: 'governed_sql',
  name: 'Customer',
  aliases: ['customer'],
  sourceObjects: ['model.shop.customers'],
  relevanceScore: 0.92,
  matchReasons: ['dimension'],
  compatibility: 'compatible',
};
const resolution: MeaningResolution = {
  interpretedQuestion: 'Top customers by revenue.',
  questionType: 'ranking',
  selectedConceptIds: [amount.id],
  recommendedExecutionId: amount.id,
  queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
  rejectedCandidates: [],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'governed_sql',
};

function plan() {
  return buildResolvedAnalyticalPlan({
    question: resolution.interpretedQuestion,
    resolution,
    evidence: { snapshotId: 'snapshot-relational', candidates: [amount, customer] },
    candidates: [amount, customer],
    mode: 'authoritative',
  });
}

function registry(): GovernedRelationalRegistry {
  return {
    snapshotId: 'snapshot-relational',
    fingerprint: 'registry-fingerprint',
    relations: [{
      qualifiedId: 'model.shop.orders',
      sqlName: 'analytics.orders',
      identities: ['model.shop.orders'],
      columns: [{
        qualifiedId: 'dbt:column:orders.amount',
        name: 'amount',
        identities: ['dbt:column:orders.amount'],
      }, {
        qualifiedId: 'dbt:column:orders.order_date',
        name: 'order_date',
        type: 'date',
        isTime: true,
        identities: ['dbt:column:orders.order_date'],
      }, {
        qualifiedId: 'dbt:column:orders.customer_id',
        name: 'customer_id',
        identities: ['dbt:column:orders.customer_id'],
      }],
    }, {
      qualifiedId: 'model.shop.customers',
      sqlName: 'analytics.customers',
      identities: ['model.shop.customers'],
      columns: [{
        qualifiedId: 'dbt:column:customers.customer_id',
        name: 'customer_id',
        identities: ['dbt:column:customers.customer_id'],
      }, {
        qualifiedId: 'dbt:column:customers.customer_name',
        name: 'customer_name',
        identities: ['dbt:column:customers.customer_name'],
      }],
    }],
    relationships: [{
      qualifiedId: 'commerce::relationship::orders_to_customers',
      fromRelationId: 'model.shop.orders',
      toRelationId: 'model.shop.customers',
      keys: [{ fromColumnId: 'dbt:column:orders.customer_id', toColumnId: 'dbt:column:customers.customer_id' }],
      joinType: 'inner',
      cardinality: 'many_to_one',
      fanout: 'safe',
      status: 'certified',
      automaticJoinAllowed: true,
      staleCertification: false,
      identities: ['commerce::relationship::orders_to_customers'],
    }],
  };
}

describe('governed relational compiler (AGT-015 / API-006)', () => {
  it('renders SQL only from qualified columns and certified relationship proof', () => {
    const result = compileGovernedRelationalPlan({ plan: plan(), registry: registry(), driver: 'duckdb' });
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.sql).toContain('FROM "analytics"."orders" AS r0');
    expect(result.sql).toContain('INNER JOIN "analytics"."customers" AS r1');
    expect(result.sql).toContain('r0."customer_id" = r1."customer_id"');
    expect(result.sql).toContain('SUM(r0."amount") AS "revenue"');
    expect(result.sql).toContain('GROUP BY r1."customer_name"');
    expect(result.sql).toContain('ORDER BY "revenue" DESC');
    expect(result.receipt).toMatchObject({
      planFingerprint: plan().fingerprint,
      relationshipIds: ['commerce::relationship::orders_to_customers'],
      outputColumns: ['customer', 'revenue'],
    });
    expect(result.receipt.sqlFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when join proof is absent or stale', () => {
    expect(compileGovernedRelationalPlan({
      plan: plan(),
      registry: { ...registry(), relationships: [] },
    })).toMatchObject({ status: 'blocked', code: 'RELATIONSHIP_PROOF_REQUIRED' });
    expect(compileGovernedRelationalPlan({
      plan: plan(),
      registry: {
        ...registry(),
        relationships: registry().relationships.map((relationship) => ({ ...relationship, staleCertification: true })),
      },
    })).toMatchObject({ status: 'blocked', code: 'RELATIONSHIP_NOT_EXECUTABLE' });
  });

  it('validates result columns and fingerprints the displayed rows', () => {
    const compiled = compileGovernedRelationalPlan({ plan: plan(), registry: registry() });
    if (compiled.status !== 'compiled') throw new Error(compiled.reason);
    const receipt = finalizeGovernedCompilationReceipt(compiled.receipt, {
      columns: ['customer', 'revenue'],
      rows: [{ customer: 'A', revenue: 42 }],
      rowCount: 1,
    });
    expect(receipt.result?.rowCount).toBe(1);
    expect(receipt.result?.resultFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => finalizeGovernedCompilationReceipt(compiled.receipt, {
      columns: ['customer'], rows: [], rowCount: 0,
    })).toThrow('Result contract is missing: revenue');
  });

  it('compiles one safely aggregated statement per period before graph alignment and ranking', () => {
    const metricId = 'commerce::metric::net_revenue';
    const customerId = 'dbt:column:customers.customer_name';
    const dateId = 'dbt:column:orders.order_date';
    const frame: AnalyticalQuestionFrameV2 = {
      version: 2,
      interpretedQuestion: 'Current and prior revenue for top customers.',
      questionType: 'ranking',
      metricConceptIds: [metricId],
      entityGrainIds: ['commerce::entity::customer'],
      dimensions: [
        { dimensionId: customerId, role: 'group_by' },
        { dimensionId: customerId, role: 'rank_entity' },
        { dimensionId: dateId, role: 'time_axis' },
      ],
      memberBindings: [],
      timeContext: {
        timeDimensionId: dateId,
        timeRole: 'order_event_time',
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
        limit: 5,
        tiePolicy: 'stable_secondary_key',
      },
      requestedOutputs: [
        { id: 'customer', kind: 'dimension' },
        { id: 'current_revenue', kind: 'metric_value', metricId, periodId: 'current' },
        { id: 'prior_revenue', kind: 'metric_value', metricId, periodId: 'previous_year' },
        { id: 'revenue_delta', kind: 'delta', metricId },
        { id: 'revenue_percent_delta', kind: 'percent_delta', metricId },
      ],
      ambiguity: [],
    };
    const capability: MetricCapabilityContract = {
      metricId,
      measureIds: ['dbt:column:orders.amount'],
      primaryEntityId: 'commerce::entity::order',
      defaultResultGrainId: 'commerce::grain::scalar',
      resultGrainIds: ['commerce::grain::scalar', 'commerce::entity::customer'],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [{
        dimensionId: customerId,
        entityId: 'commerce::entity::customer',
        supportedRoles: ['group_by', 'rank_entity'],
        relationshipPathIds: ['commerce::relationship::orders_to_customers'],
      }],
      timeDimensions: [{
        dimensionId: dateId,
        role: 'order_event_time',
        supportedGrains: ['day', 'month', 'year'],
      }],
      operations: ['group', 'compare', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta'],
      executionCapabilities: [{ route: 'governed_sql', adapterId: 'relational-v1' }],
      sourceFingerprint: 'relational-capability-v1',
    };
    const analyticalPlan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution: { ...resolution, analyticalFrame: frame },
      evidence: { snapshotId: 'snapshot-relational', candidates: [amount, customer] },
      candidates: [amount, customer],
      mode: 'authoritative',
    });
    const built = buildAnalyticalExecutionGraph({
      plan: analyticalPlan,
      capability,
      route: 'governed_sql',
      adapterId: 'relational-v1',
    });
    if (built.status !== 'ready') throw new Error(built.reason);
    const compiled = compileGovernedRelationalExecutionGraph({
      graph: built.graph,
      plan: analyticalPlan,
      registry: registry(),
      driver: 'duckdb',
    });
    expect(compiled.status).toBe('compiled');
    if (compiled.status !== 'compiled') return;
    expect(compiled.statements).toHaveLength(2);
    expect(compiled.statements[0]).toMatchObject({
      nodeId: 'source:current',
      parameterValues: {
        time_start: '2026-01-01T00:00:00.000Z',
        time_end: '2026-07-01T00:00:00.000Z',
      },
      receipt: { outputColumns: ['customer', 'current_revenue'] },
    });
    expect(compiled.statements[0]!.sql).toContain('SUM(r0."amount") AS "current_revenue"');
    expect(compiled.statements[0]!.sql).toContain('r0."order_date" >= :time_start');
    expect(compiled.statements[0]!.sql).toContain('GROUP BY r1."customer_name"');
    expect(compiled.statements[0]!.sql).not.toContain('ORDER BY');
    expect(compiled.statements[1]).toMatchObject({
      nodeId: 'source:previous_year',
      parameterValues: {
        time_start: '2025-01-01T00:00:00.000Z',
        time_end: '2025-07-01T00:00:00.000Z',
      },
      receipt: { outputColumns: ['customer', 'prior_revenue'] },
    });
    expect(compiled.receipt).toMatchObject({
      graphFingerprint: built.graph.fingerprint,
      planFingerprint: analyticalPlan.fingerprint,
      statementFingerprints: [
        { nodeId: 'source:current' },
        { nodeId: 'source:previous_year' },
      ],
    });
    expect(compiled.receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
