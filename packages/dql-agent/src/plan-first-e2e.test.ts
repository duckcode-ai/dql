import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticLayer, type MetricCapabilityContract } from '@duckcodeailabs/dql-core';
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
    payload: {
      qualifiedId: metric.qualifiedId,
      localId: 'actual_rollover_balance',
      relation: 'usage',
      measureColumn: 'balance',
      analyticalCapability: semanticCapability(metric.qualifiedId!, 'balance'),
    },
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

function semanticCapability(metricId: string, measure: string): MetricCapabilityContract {
  return {
    metricId,
    semanticModelId: 'semantic:consumption',
    measureIds: [measure],
    primaryEntityId: 'usage',
    defaultResultGrainId: 'usage',
    resultGrainIds: ['usage', 'customer_name'],
    aggregation: 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: [{ dimensionId: 'customer_name', entityId: 'customer_name', supportedRoles: ['group_by', 'rank_entity'] }],
    timeDimensions: [],
    operations: ['group', 'rank'],
    supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
    executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
    sourceFingerprint: `fixture:${metricId}`,
  };
}

afterEach(() => {
  kg.close();
  rmSync(root, { recursive: true, force: true });
});

describe('plan-first surface parity E2E (API-006 / E2E-012)', () => {
  it('deterministically executes the exact revenue capability and excludes narrower/duplicate candidates', async () => {
    const customerRegistryId = 'semantic:uncategorized:dimension:customers.customer_name';
    const capability = {
      ...semanticCapability('semantic:orders:revenue', 'product_price'),
      primaryEntityId: 'order_item',
      defaultResultGrainId: 'order_item',
      resultGrainIds: ['order_item', 'customer_name'],
      executionCapabilities: [{ route: 'semantic' as const, adapterId: 'metricflow-cli' }],
      dimensions: [{
        dimensionId: customerRegistryId,
        entityId: 'order_item',
        supportedRoles: ['group_by' as const, 'rank_entity' as const],
      }],
    };
    const revenue: AgentEvidenceCandidate = {
      id: capability.metricId,
      qualifiedId: capability.metricId,
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      trustTier: 'semantic',
      name: 'Revenue',
      aliases: ['revenue'],
      dimensions: ['customer_name'],
      exactMatch: true,
      relevanceScore: 1,
      matchReasons: ['exact governed metric'],
      compatibility: 'compatible',
      analyticalCapability: capability,
    };
    const backingMeasure: AgentEvidenceCandidate = {
      id: 'product_price',
      qualifiedId: 'product_price',
      kind: 'semantic_member',
      semanticObjectType: 'measure',
      trustTier: 'semantic',
      name: 'Revenue',
      aliases: ['revenue'],
      exactMatch: true,
      relevanceScore: 1,
      matchReasons: ['backing measure'],
      compatibility: 'compatible',
    };
    const beverageBlock: AgentEvidenceCandidate = {
      id: 'dql:block:top_beverage_customers',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_beverage_customers',
      aliases: ['top customers by revenue'],
      relevanceScore: 0.99,
      matchReasons: ['ranking phrase'],
      compatibility: 'partial',
      compatibilityFacts: ['certified static scope is not requested: beverage'],
      eligible: false,
    };
    const customerDimension: AgentEvidenceCandidate = {
      id: customerRegistryId,
      qualifiedId: customerRegistryId,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Customer',
      aliases: ['customer', 'customers'],
      relevanceScore: 0.98,
      matchReasons: ['exact grouping'],
      compatibility: 'compatible',
    };
    kg.rebuild([{
      nodeId: revenue.id,
      kind: 'metric',
      name: 'revenue',
      status: 'certified',
      payload: {
        qualifiedId: revenue.qualifiedId,
        localId: 'revenue',
        relation: 'order_items',
        measureColumn: 'product_price',
        analyticalCapability: capability,
      },
    }, {
      nodeId: 'dimension:customers.customer_name',
      kind: 'dimension',
      name: 'customer_name',
      payload: {
        registryQualifiedId: customerRegistryId,
        qualifiedId: 'semantic:uncategorized:dimension:customer_name',
        localId: 'customer_name',
        registryReference: 'customers.customer_name',
      },
    }], []);
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-revenue',
        sourceFingerprint: 'sha256:jaffle-revenue',
        candidates: [beverageBlock, backingMeasure, revenue, customerDimension],
        parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
      }),
      resolveMeaning: async () => { throw new Error('Exact Jaffle revenue route must not call a provider.'); },
      resolvedPlanMode: 'authoritative',
    });
    const question = 'who are the top customers by revenue';
    const decision = await router.decide({ question, intent: 'ad_hoc_ranking' });
    expect(decision.action).toBe('answer');
    expect(selectRoute({ question }, decision)).toBe('semantic_answer');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual([capability.metricId]);
    expect(decision.resolvedAnalyticalPlan?.query.dimensions).toEqual([
      expect.objectContaining({ qualifiedId: customerDimension.qualifiedId }),
    ]);
    expect(decision.resolvedAnalyticalPlan?.analyticalFrame?.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimensionId: customerDimension.qualifiedId, role: 'group_by' }),
      expect.objectContaining({ dimensionId: customerDimension.qualifiedId, role: 'rank_entity' }),
    ]));
    expect(decision.retrievalEvidence?.candidateIds).not.toEqual(expect.arrayContaining([
      backingMeasure.id,
      beverageBlock.id,
    ]));

    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'orders', sql: 'product_price', type: 'sum', table: '' }],
      dimensions: [{
        name: 'customer_name',
        qualifiedName: 'customer__customer_name',
        label: 'Customer',
        description: '',
        domain: 'orders',
        sql: 'customer_name',
        type: 'string',
        table: 'order_items',
      }],
    });
    const provider = new NeverProvider();
    const compiler = vi.fn(async () => ({
      sql: [
        'SELECT customer_name, SUM(product_price) AS revenue',
        'FROM order_items',
        'GROUP BY customer_name',
        'ORDER BY revenue DESC, customer_name ASC',
        'LIMIT 10',
      ].join('\n'),
      engine: 'metricflow-cli' as const,
      selection: { metrics: ['revenue'], dimensions: ['customer_name'] },
    }));
    const executed: string[] = [];
    const result = await answer({
      question,
      provider,
      kg,
      semanticLayer,
      semanticQueryCompiler: compiler,
      contextPack: {
        objects: [],
        allowedSqlContext: { relations: [], columns: [] },
        routeDecision: {
          grainGate: {
            requestedGrain: 'customer',
            sourceId: 'dql:block:customer_profile',
          },
        },
        questionPlan: {
          requestedShape: {
            grain: 'customer',
            dimensions: ['customer'],
          },
        },
        retrievalDiagnostics: {
          meaningEvidence: {
            candidates: [{ objectKey: 'dql:block:customer_profile', compatibility: 'incompatible' }],
          },
        },
      } as never,
      resolvedAnalyticalPlan: decision.resolvedAnalyticalPlan,
      executeGeneratedSql: async (sql) => {
        executed.push(sql);
        return {
          columns: ['customer_name', 'revenue'],
          rows: [{ customer_name: 'Alice Johnson', revenue: 40 }],
          rowCount: 1,
          sql,
        };
      },
    });

    expect(provider.calls).toBe(0);
    expect(compiler).toHaveBeenCalledOnce();
    expect(result.kind).toBe('uncertified');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('SUM(product_price) AS revenue');
    expect(executed[0]).toContain('ORDER BY revenue DESC');
    expect(executed[0]).toMatch(/ORDER BY revenue DESC, customer_name ASC\s+LIMIT 10/);
    expect(compiler).toHaveBeenCalledWith(expect.objectContaining({
      dimensions: ['customer__customer_name'],
      orderBy: [
        { name: 'revenue', direction: 'desc' },
        { name: 'customer_name', direction: 'asc' },
      ],
      limit: 10,
    }));
    expect(result.route?.tier).toBe('semantic_metric');
    expect(result.result?.columns).toEqual(['customer_name', 'revenue']);
    expect(result.aggregationSafetyProof).toMatchObject({
      status: 'safe', metricIds: [capability.metricId], issueCodes: [],
    });
  });

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
