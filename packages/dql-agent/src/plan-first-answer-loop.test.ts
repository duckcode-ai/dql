import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
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
});
