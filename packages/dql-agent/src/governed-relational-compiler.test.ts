import { describe, expect, it } from 'vitest';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import {
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
});
