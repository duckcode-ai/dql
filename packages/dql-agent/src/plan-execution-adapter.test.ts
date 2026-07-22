import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { adaptResolvedAnalyticalPlan, buildPlanExecutionRegistry } from './plan-execution-adapter.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';
import type { KGNode } from './kg/types.js';

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
});
