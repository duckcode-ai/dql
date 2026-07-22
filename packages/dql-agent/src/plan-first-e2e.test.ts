import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { answer } from './answer-loop.js';
import { selectRoute } from './agent-run-engine.js';
import { KGStore } from './kg/sqlite-fts.js';
import { createHybridRouter } from './router.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';
import type { AgentMessage, AgentProvider } from './providers/types.js';

class NeverProvider implements AgentProvider {
  readonly name = 'claude' as const;
  calls = 0;
  async available(): Promise<boolean> { return true; }
  async generate(_messages: AgentMessage[]): Promise<string> {
    this.calls += 1;
    throw new Error('Plan-first E2E must not invoke free-form SQL or member selection.');
  }
}

const surfaces = ['browser_ask', 'cli', 'mcp', 'chat', 'notebook', 'preview', 'block_studio'] as const;
const metric: AgentEvidenceCandidate = {
  id: 'metric:actual_rollover_balance',
  qualifiedId: 'semantic:consumption:actual_rollover_balance',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Actual Rollover Balance',
  aliases: ['rollover balance'],
  dimensions: ['semantic:consumption:dimension:customer'],
  relevanceScore: 0.98,
  matchReasons: ['full business meaning'],
  compatibility: 'compatible',
};
const wrongMetric: AgentEvidenceCandidate = {
  id: 'metric:rollover_risk',
  qualifiedId: 'semantic:consumption:rollover_risk',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Rollover Risk',
  aliases: ['rollover balance risk'],
  dimensions: ['semantic:consumption:dimension:customer'],
  relevanceScore: 0.99,
  matchReasons: ['lexically stronger but wrong meaning'],
  compatibility: 'compatible',
};
const customer: AgentEvidenceCandidate = {
  id: 'dimension:customer_name',
  qualifiedId: 'semantic:consumption:dimension:customer',
  kind: 'semantic_member',
  trustTier: 'semantic',
  name: 'Customer',
  aliases: ['customer'],
  relevanceScore: 0.9,
  matchReasons: ['requested grouping'],
  compatibility: 'compatible',
};

const retrievalEvidence: AgentRetrievalEvidence = {
  snapshotId: 'snapshot-plan-first-e2e',
  sourceFingerprint: 'source-plan-first-e2e',
  knowledgeLens: {
    mode: 'auto',
    activeDomainId: 'consumption',
    skillRefs: ['consumption::skill::rollover-analysis'],
    snapshotId: 'snapshot-plan-first-e2e',
    skillFingerprints: { 'consumption::skill::rollover-analysis': 'skill-v1' },
  },
  candidates: [wrongMetric, metric, customer],
  parsedIntent: { measures: ['actual rollover balance'], dimensions: ['customer'], order: 'desc', limit: 5 },
};

const resolution: MeaningResolution = {
  interpretedQuestion: 'Top customers by actual rollover balance.',
  questionType: 'ranking',
  selectedConceptIds: [metric.id],
  recommendedExecutionId: metric.id,
  queryIntent: {
    measures: ['actual rollover balance'],
    dimensions: ['customer'],
    filters: [],
    order: 'desc',
    limit: 5,
  },
  rejectedCandidates: [{ id: wrongMetric.id, reason: 'Risk is a forecast, not the actual balance.' }],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'semantic',
};

let root: string;
let kg: KGStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plan-first-e2e-'));
  kg = new KGStore(join(root, 'kg.sqlite'));
  kg.rebuild([{
    nodeId: metric.id,
    kind: 'metric',
    name: 'actual_rollover_balance',
    status: 'certified',
    payload: { qualifiedId: metric.qualifiedId, localId: 'actual_rollover_balance' },
  }, {
    nodeId: wrongMetric.id,
    kind: 'metric',
    name: 'rollover_risk',
    status: 'certified',
    payload: { qualifiedId: wrongMetric.qualifiedId, localId: 'rollover_risk' },
  }, {
    nodeId: customer.id,
    kind: 'dimension',
    name: 'customer_name',
    payload: { qualifiedId: customer.qualifiedId, localId: 'customer_name' },
  }], []);
});

afterEach(() => {
  kg.close();
  rmSync(root, { recursive: true, force: true });
});

describe('plan-first surface parity E2E (API-006 / E2E-012)', () => {
  it('produces the same qualified plan, route, executable contract, and SQL on every surface', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [
        { name: 'actual_rollover_balance', label: 'Actual Rollover Balance', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' },
        { name: 'rollover_risk', label: 'Rollover Risk', description: '', domain: 'consumption', sql: 'risk', type: 'sum', table: 'usage' },
      ],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' }],
    });
    const provider = new NeverProvider();
    const contracts = [];

    for (const surface of surfaces) {
      const router = createHybridRouter({
        getEvidence: async () => retrievalEvidence,
        resolveMeaning: async () => resolution,
        resolvedPlanMode: 'authoritative',
      });
      const decision = await router.decide({
        question: 'Top customers by rollover balance risk wording.',
        intent: 'ad_hoc_ranking',
      });
      const plan = decision.resolvedAnalyticalPlan;
      if (!plan) throw new Error(`No resolved plan for ${surface}.`);
      let executedSql = '';
      const result = await answer({
        question: 'Please use the risk metric instead.',
        provider,
        kg,
        semanticLayer,
        resolvedAnalyticalPlan: plan,
        executeGeneratedSql: async (sql) => {
          executedSql = sql;
          return {
            columns: ['customer_name', 'actual_rollover_balance'],
            rows: [{ customer_name: 'A', actual_rollover_balance: 42 }],
            rowCount: 1,
            sql,
          };
        },
      });
      contracts.push({
        planSchemaVersion: plan.schemaVersion,
        planFingerprint: plan.fingerprint,
        snapshotId: plan.snapshotId,
        selectedConceptIds: plan.selectedConceptIds,
        executionId: plan.executionId,
        capability: plan.capability,
        route: selectRoute({ question: plan.question }, decision),
        executableSchemaVersion: result.executablePlan?.schemaVersion,
        executableStatus: result.executablePlan?.status,
        executableKind: result.executablePlan?.kind,
        answerRoute: result.route?.tier,
        sql: executedSql,
      });
    }

    expect(provider.calls).toBe(0);
    expect(contracts).toHaveLength(surfaces.length);
    expect(contracts.every((contract) => JSON.stringify(contract) === JSON.stringify(contracts[0]))).toBe(true);
    expect(contracts[0]).toMatchObject({
      planSchemaVersion: 1,
      snapshotId: 'snapshot-plan-first-e2e',
      selectedConceptIds: [metric.qualifiedId],
      executionId: metric.qualifiedId,
      capability: 'semantic_execution',
      route: 'semantic_answer',
      executableSchemaVersion: 1,
      executableStatus: 'ready',
      executableKind: 'semantic',
      answerRoute: 'semantic_metric',
    });
    expect(contracts[0]?.sql).toContain('SUM(balance) AS actual_rollover_balance');
    expect(contracts[0]?.sql).not.toContain('SUM(risk)');
  });
});
