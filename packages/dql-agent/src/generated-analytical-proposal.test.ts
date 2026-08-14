import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { answer } from './answer-loop.js';
import { KGStore } from './kg/sqlite-fts.js';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { validateGeneratedAnalyticalProposal } from './generated-analytical-proposal.js';
import type { AgentEvidenceCandidate, MeaningResolution } from './meaning-resolution.js';
import type { AgentProvider } from './providers/types.js';

const SQL_SIGNATURE_ATTACKS = [
  ['alias-spoofed customer count', `SELECT c.customer_name, COUNT(DISTINCT o.customer_id) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['wrong join key', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.order_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'JOIN_PREDICATE_TUPLE_DRIFT'],
  ['same-named measure from the wrong relation', `SELECT c.customer_name, SUM(c.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['missing group by', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id ORDER BY revenue DESC LIMIT 10`, 'GROUPING_TUPLE_DRIFT'],
  ['extra hidden aggregate', `SELECT c.customer_name, SUM(o.revenue) + COUNT(*) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['limit overrun', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 500`, 'LIMIT_TUPLE_DRIFT'],
  ['union bridge', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name UNION SELECT customer_name, SUM(revenue) AS revenue FROM archived_orders GROUP BY customer_name`, 'SET_OPERATION_TUPLE_DRIFT'],
  ['early rounding', `SELECT c.customer_name, ROUND(SUM(o.revenue), 0) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['filter drift', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE c.status = 'active' GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'FILTER_TUPLE_DRIFT'],
  ['malformed pasted bridge', `SELECT c.customer_name, COUNT(DISTINCT o.order_id) AS customers FROM order_items oi JOIN orders o ON oi.order_id = o.order_id JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY customers DESC LIMIT 10`, 'OUTPUT_TUPLE_DRIFT'],
] as const;

describe('generated analytical proposal tuple gate (AGT-013/014/018)', () => {
  it.each(SQL_SIGNATURE_ATTACKS)('blocks %s before SQL', (_label, sql, expectedCode) => {
    const { plan, proposal, contextPack } = fixture();
    const validation = validateGeneratedAnalyticalProposal({
      plan,
      proposal: { ...proposal, sql },
      expectedTargetFingerprint: 'target:jaffle',
      contextPack,
    });
    expect(validation).toMatchObject({
      ok: false,
      message: 'Generated query changed the resolved analytical plan and was not executed',
      driftCodes: expect.arrayContaining([expectedCode]),
    });
  });

  it('accepts an exact parser-owned generated proposal', () => {
    const { plan, proposal, contextPack } = fixture();
    expect(validateGeneratedAnalyticalProposal({
      plan,
      proposal,
      expectedTargetFingerprint: 'target:jaffle',
      contextPack,
    })).toEqual({ ok: true });
  });

  it('rejects the malformed pasted bridge query for extra customers, wrong order, missing revenue, and relation drift', () => {
    const { plan, proposal, contextPack } = fixture();
    const malformed = validateGeneratedAnalyticalProposal({
      plan,
      expectedTargetFingerprint: 'target:jaffle',
      contextPack,
      proposal: {
        ...proposal,
        sql: `SELECT c.customer_name, COUNT(DISTINCT o.order_id) AS customers
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.order_id
          JOIN customers c ON o.customer_id = c.customer_id
          GROUP BY c.customer_name
          ORDER BY customers DESC
          LIMIT 10`,
      },
    });
    expect(malformed).toMatchObject({
      ok: false,
      message: 'Generated query changed the resolved analytical plan and was not executed',
      driftCodes: expect.arrayContaining([
        'OUTPUT_TUPLE_DRIFT',
        'ORDER_TUPLE_DRIFT',
        'RELATION_TUPLE_DRIFT',
        'JOIN_PREDICATE_TUPLE_DRIFT',
      ]),
    });
  });

  it.each(SQL_SIGNATURE_ATTACKS)('blocks %s at the production boundary with zero SQL and artifact presentation', async (_label, sql, expectedCode) => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-generated-tuple-'));
    const kg = new KGStore(join(dir, 'kg.sqlite'));
    try {
      kg.rebuild([], []);
      const { plan, contextPack } = fixture();
      const generatedPlan = structuredClone(plan);
      generatedPlan.capability = 'bounded_exploration';
      generatedPlan.recommendedRoute = 'exploratory';
      const executeGeneratedSql = vi.fn();
      const captureGeneratedDraft = vi.fn();
      const provider: AgentProvider = {
        name: 'openai',
        available: async () => true,
        generate: async () => JSON.stringify({
          summary: 'Generated analytical proposal.',
          sql,
          outputs: ['customer_name', 'revenue'],
        }),
      };
      const result = await answer({
        question: 'who are the top customers by revenue',
        provider,
        kg,
        resolvedAnalyticalPlan: generatedPlan,
        generatedProposalTargetFingerprint: 'target:jaffle',
        contextPack,
        schemaContext: [
          { relation: 'order_items', name: 'order_items', columns: [{ name: 'order_id', type: 'string' }] },
          { relation: 'orders', name: 'orders', columns: [{ name: 'order_id', type: 'string' }, { name: 'customer_id', type: 'string' }] },
          { relation: 'customers', name: 'customers', columns: [{ name: 'customer_id', type: 'string' }, { name: 'customer_name', type: 'string' }] },
        ],
        executeGeneratedSql,
        captureGeneratedDraft,
      });

      expect(result.text).toBe('Generated query changed the resolved analytical plan and was not executed');
      expect(result.refusalDetails).toMatchObject({ code: 'GENERATED_ANALYTICAL_TUPLE_DRIFT', message: expect.stringContaining(expectedCode) });
      expect(executeGeneratedSql).not.toHaveBeenCalled();
      expect(captureGeneratedDraft).not.toHaveBeenCalled();
      expect(result.result).toBeUndefined();
      expect(result.dqlArtifact).toBeUndefined();
      expect(result.draftBlock).toBeUndefined();
    } finally {
      kg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes one safe exact generated proposal through the same production boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-generated-safe-'));
    const kg = new KGStore(join(dir, 'kg.sqlite'));
    try {
      kg.rebuild([], []);
      const { plan, proposal, contextPack } = fixture();
      const generatedPlan = structuredClone(plan);
      generatedPlan.capability = 'bounded_exploration';
      generatedPlan.recommendedRoute = 'exploratory';
      const executeGeneratedSql = vi.fn(async (sql: string) => ({
        columns: ['customer_name', 'revenue'],
        rows: [{ customer_name: 'Alice', revenue: 120 }],
        rowCount: 1,
        sql,
      }));
      const provider: AgentProvider = {
        name: 'openai',
        available: async () => true,
        generate: async () => JSON.stringify({
          summary: 'Top customers by revenue.',
          sql: proposal.sql,
          outputs: ['customer_name', 'revenue'],
        }),
      };
      const result = await answer({
        question: 'who are the top customers by revenue',
        provider,
        kg,
        contextPack,
        resolvedAnalyticalPlan: generatedPlan,
        generatedProposalTargetFingerprint: 'target:jaffle',
        schemaContext: [
          { relation: 'orders', name: 'orders', columns: [{ name: 'revenue', type: 'number' }, { name: 'customer_id', type: 'string' }] },
          { relation: 'customers', name: 'customers', columns: [{ name: 'customer_id', type: 'string' }, { name: 'customer_name', type: 'string' }] },
        ],
        executeGeneratedSql,
      });

      expect(executeGeneratedSql).toHaveBeenCalledTimes(1);
      expect(executeGeneratedSql).toHaveBeenCalledWith(proposal.sql, expect.anything());
      expect(result.result).toMatchObject({ rowCount: 1, columns: ['customer_name', 'revenue'] });
    } finally {
      kg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fixture() {
  const metricId = 'semantic:metric:order.revenue';
  const dimensionId = 'semantic:dimension:customer_name';
  const capability = {
    metricId,
    semanticModelId: 'orders',
    measureIds: ['semantic:measure:order.revenue'],
    primaryEntityId: 'order',
    defaultResultGrainId: 'order',
    resultGrainIds: ['order', 'customer'],
    aggregation: 'sum',
    additivity: { entities: 'additive' as const, time: 'additive' as const },
    dimensions: [{
      dimensionId,
      entityId: 'customer',
      supportedRoles: ['group_by' as const, 'rank_entity' as const],
      relationshipPathIds: ['relationship:orders_to_customers'],
    }],
    timeDimensions: [],
    operations: ['group' as const, 'rank' as const],
    supportedOutputKinds: ['dimension' as const, 'metric_value' as const],
    executionCapabilities: [{ route: 'semantic' as const, adapterId: 'native' }],
    sourceFingerprint: 'capability:order-revenue',
  };
  const candidate: AgentEvidenceCandidate = {
    id: metricId,
    qualifiedId: metricId,
    kind: 'semantic_metric',
    trustTier: 'semantic',
    name: 'Revenue',
    aliases: ['revenue'],
    sourceObjects: ['dbt:model:orders', 'dbt:model:customers'],
    relevanceScore: 1,
    matchReasons: ['exact metric'],
    compatibility: 'compatible',
    analyticalCapability: capability,
  };
  const resolution: MeaningResolution = {
    interpretedQuestion: 'Who are the top customers by revenue?',
    questionType: 'ranking',
    selectedConceptIds: [metricId],
    recommendedExecutionId: metricId,
    queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
    rejectedCandidates: [],
    confidence: 'high',
    missingInformation: [],
    recommendedRoute: 'semantic',
    analyticalFrame: {
      version: 2,
      interpretedQuestion: 'Who are the top customers by revenue?',
      questionType: 'ranking',
      metricConceptIds: [metricId],
      entityGrainIds: ['customer'],
      dimensions: [{ dimensionId, role: 'group_by' }, { dimensionId, role: 'rank_entity' }],
      memberBindings: [],
      ranking: {
        entityDimensionId: dimensionId,
        byMetricId: metricId,
        direction: 'desc',
        limit: 10,
        tiePolicy: 'stable_secondary_key',
      },
      requestedOutputs: [
        { id: 'customer_name', kind: 'dimension' },
        { id: 'revenue', kind: 'metric_value', metricId },
      ],
      ambiguity: [],
    },
  };
  const plan = buildResolvedAnalyticalPlan({
    question: resolution.interpretedQuestion,
    resolution,
    evidence: { snapshotId: 'snapshot:jaffle', candidates: [candidate] },
    candidates: [candidate],
    mode: 'authoritative',
  });
  return {
    plan,
    proposal: {
      version: 1 as const,
      planId: plan.planId,
      planFingerprint: plan.fingerprint,
      snapshotId: plan.snapshotId,
      executionId: plan.executionId!,
      capabilityFingerprint: plan.selectedCapabilityFingerprint!,
      targetFingerprint: 'target:jaffle',
      sql: `SELECT c.customer_name AS customer_name, SUM(o.revenue) AS revenue
        FROM orders o JOIN customers c ON o.customer_id = c.customer_id
        GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`,
    },
    contextPack: {
      id: 'context:jaffle-generated',
      question: resolution.interpretedQuestion,
      focusObjectKey: null,
      mode: 'question',
      trustLabel: 'mixed',
      questionPlan: {
        question: resolution.interpretedQuestion,
        normalizedQuestion: resolution.interpretedQuestion.toLowerCase(),
        mode: 'general_analysis',
        routeIntent: 'ad_hoc_ranking',
        entities: [],
        metricTerms: ['revenue'],
        dimensionTerms: ['customer_name'],
        filterTerms: [],
        timeTerms: [],
        outputShape: 'table',
        needsGeneratedSql: true,
        shouldConsiderCertifiedExact: false,
        needsResearchWorkspace: false,
        searchQueries: [resolution.interpretedQuestion],
        searchTerms: ['revenue', 'customer_name'],
        requestedShape: { dimensions: ['customer_name'], measures: ['revenue'], requiredOutputs: ['customer_name', 'revenue'], filters: [], followUpReferences: [] },
        confidence: 1,
        reasons: ['frozen authoritative plan'],
      },
      objects: [{
        objectKey: 'relationship:orders_to_customers',
        objectType: 'relationship',
        name: 'orders_to_customers',
        payload: {
          fromRelation: 'orders',
          toRelation: 'customers',
          keys: [{ from: 'customer_id', to: 'customer_id' }],
          cardinality: 'many_to_one',
          fanout: 'safe',
        },
      }],
      skills: [],
      edges: [],
      queryRuns: [],
      citations: [],
      evidenceSummaries: [],
      warnings: [],
      routeDecision: {
        route: 'generated_sql',
        intent: 'ad_hoc_ranking',
        reason: 'Use the frozen bounded proposal authority.',
        trustLabel: 'mixed',
        reviewStatus: 'draft_ready',
        selectedEvidence: [],
        missingContext: [],
        followUps: [],
      },
      evidenceRoles: [],
      allowedSqlContext: {
        relations: [
          { relation: 'orders', name: 'orders', source: 'semantic layer', columns: [{ name: 'revenue', type: 'number' }, { name: 'customer_id', type: 'string' }] },
          { relation: 'customers', name: 'customers', source: 'semantic layer', columns: [{ name: 'customer_id', type: 'string' }, { name: 'customer_name', type: 'string' }] },
        ],
        sourceBlockSql: [],
      },
      missingContext: [],
      conflicts: [],
      appliedHints: [],
      hintConflicts: [],
      retrievalDiagnostics: {
        strategy: 'sqlite_fts',
        selectedObjects: 1,
        selectedEvidence: [],
        selectedRelations: [],
        selectedJoinPaths: [{
          leftRelation: 'orders',
          leftColumn: 'customer_id',
          rightRelation: 'customers',
          rightColumn: 'customer_id',
          reason: 'frozen relationship:orders_to_customers',
          confidence: 1,
          source: 'dql_relationship',
        }],
        topRejected: [],
        certifiedCandidateFits: [],
        candidateConflicts: [],
      },
      freshness: { catalogPath: '/tmp/metadata.sqlite', builtAt: null, fingerprint: 'snapshot:jaffle' },
    } as any,
  };
}
