import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireActiveKnowledgeSnapshot,
  activeKnowledgeSnapshotLeaseCount,
  buildLocalContextPack,
  buildMetadataSnapshot,
  buildFollowUpSearchQuery,
  defaultMetadataPath,
  ensureMetadataCatalogFresh,
  MetadataCatalog,
  openMetadataCatalog,
  planAgentAnswer,
  recordRuntimeSchemaSnapshot,
  recordQueryRun,
  retrieveMetadataSnapshotCandidates,
  toAgentRetrievalEvidence,
  upsertMetadataSnapshot,
  buildGovernedTermIndex,
  reclassifyGovernedNameMentions,
} from './catalog.js';
import { buildAnalysisQuestionPlan } from './analysis-planner.js';
import { buildBlockBusinessFingerprint, buildBlockSqlFingerprints } from './block-fingerprints.js';
import { resolveSemanticLayerWithDiagnostics, SemanticLayer, type DQLManifest } from '@duckcodeailabs/dql-core';
import { recordCorrectionTrace, reviewHint } from '../hints/git-store.js';
import { defaultKgPath, reindexProject } from '../index.js';
import { KGStore } from '../kg/sqlite-fts.js';

describe('local metadata catalog', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempProject();
    seedDqlProject(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('CTX-003 keeps SQL bodies and prior row values out of metadata FTS queries', () => {
    const query = buildFollowUpSearchQuery('what product did they buy?', {
      kind: 'drilldown',
      sourceBlockName: 'top_beverage_customers',
      sourceQuestion: 'top beverage customers',
      filters: ['Melissa Lopez', 'Joy Lam'],
      dimensions: ['customer', 'product'],
      priorResultColumns: ['customer_name', 'beverage_revenue'],
      priorMeasures: ['beverage_revenue'],
      priorResultValues: { customer_name: ['Melissa Lopez', 'Joy Lam'] },
      priorResultRef: {
        id: 'turn-1',
        question: 'top beverage customers',
        columns: ['customer_name', 'beverage_revenue'],
        sourceSql: 'SELECT customers.customer_name, SUM(items.price) FROM secret_relation',
      },
    });

    expect(query).toContain('top_beverage_customers');
    expect(query).toContain('beverage_revenue');
    expect(query).not.toContain('Melissa Lopez');
    expect(query).not.toContain('secret_relation');
    expect(query).not.toContain('SELECT');
  });

  it('CONTRACT-002 admits only exactly bound certified block capability', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-07-22T00:00:00.000Z',
      project: 'capability-test',
      projectRoot,
      domains: {}, businessViews: {}, terms: {}, notebooks: {}, metrics: {}, dimensions: {}, sources: {}, apps: {}, dashboards: {},
      blocks: {
        revenue_by_customer: {
          name: 'revenue_by_customer', filePath: 'blocks/revenue_by_customer.dql', domain: 'sales', status: 'certified',
          sql: 'select customer_name, sum(revenue_amount) as revenue from orders group by 1',
          rawTableRefs: ['orders'], tableDependencies: ['orders'], refDependencies: [], allDependencies: ['orders'], tests: [],
          metricRef: 'semantic:sales:revenue',
          grain: 'semantic:sales:entity:order',
          entities: ['semantic:sales:entity:order'],
          dimensions: ['semantic:sales:dimension:customer_name'],
          allowedFilters: ['semantic:sales:dimension:customer_name'],
          declaredOutputs: ['customer_name', 'revenue'],
          outputContract: [
            { name: 'customer_name', role: 'dimension' },
            { name: 'revenue', role: 'metric' },
          ],
        },
      },
      lineage: { nodes: [], edges: [] }, diagnostics: [],
    } as DQLManifest;
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'orders', label: 'Orders', description: '', domain: 'sales', sql: 'select * from orders', table: 'orders',
      measures: [],
      dimensions: [{
        name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name', type: 'string',
        table: 'orders', cube: 'orders', entityLink: 'order',
      }],
      timeDimensions: [], joins: [], segments: [], preAggregations: [],
    });
    layer.addEntity({
      name: 'order', label: 'Order', description: '', type: 'primary', table: 'orders', cube: 'orders', domain: 'sales',
    });
    layer.addMeasure({
      name: 'revenue', label: 'Revenue', description: '', agg: 'sum', expr: 'revenue_amount',
      table: 'orders', cube: 'orders', domain: 'sales',
    });
    layer.addSemanticModel({
      name: 'orders', label: 'Orders', description: '', domain: 'sales', table: 'orders', entities: ['order'],
      measures: ['revenue'], dimensions: ['customer_name'], timeDimensions: [],
    });
    layer.addMetric({
      name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'revenue', type: 'custom',
      metricType: 'simple', aggregation: 'sum', table: '', cube: 'orders', typeParams: { measure: { name: 'revenue' } },
    });

    const snapshot = buildMetadataSnapshot(projectRoot, manifest, layer, []);
    const capability = snapshot.objects.find((object) => object.objectKey === 'dql:block:revenue_by_customer')
      ?.payload?.analyticalCapability;
    expect(capability).toMatchObject({
      metricId: 'semantic:sales:revenue',
      defaultResultGrainId: 'semantic:sales:entity:order',
      dimensions: [{
        dimensionId: 'semantic:sales:dimension:customer_name',
        supportedRoles: ['group_by', 'filter', 'display'],
      }],
      supportedOutputKinds: ['dimension', 'metric_value'],
      declaredOutputIds: ['customer_name', 'revenue'],
      executionCapabilities: [{ route: 'certified', adapterId: 'dql:block:revenue_by_customer' }],
    });
  });

  it('AGT-012 binds a named member only through exact runtime value and semantic column evidence', () => {
    const metricId = 'semantic:sales:revenue';
    const dimensionId = 'semantic:sales:dimension:customer_name';
    const capability = {
      metricId,
      semanticModelId: 'semantic:sales:model:orders',
      measureIds: ['semantic:sales:measure:revenue'],
      primaryEntityId: 'semantic:sales:entity:order',
      defaultResultGrainId: 'semantic:sales:entity:order',
      resultGrainIds: ['semantic:sales:entity:order'],
      aggregation: 'sum',
      additivity: { entities: 'additive' as const, time: 'additive' as const },
      dimensions: [{
        dimensionId,
        entityId: 'semantic:sales:entity:order',
        supportedRoles: ['filter' as const, 'group_by' as const],
      }],
      timeDimensions: [],
      operations: ['filter' as const, 'group' as const],
      supportedOutputKinds: ['metric_value' as const, 'dimension' as const],
      executionCapabilities: [{ route: 'semantic' as const, adapterId: 'metricflow' }],
      sourceFingerprint: 'sha256:metric',
    };
    const evidence = toAgentRetrievalEvidence({
      candidates: [{
        objectKey: 'semantic:metric:orders.revenue',
        qualifiedId: metricId,
        evidenceClass: 'semantic',
        trustTier: 'semantic',
        classRank: 1,
        relevanceScore: 100,
        name: 'Revenue', aliases: ['revenue'], objectType: 'semantic_metric',
        relevanceReasons: ['exact name or alias'], compatibilityFacts: [],
        businessShape: {
          entities: [], dimensions: [dimensionId], timeGrains: [], parameters: [], filters: [], outputs: [], sourceRelations: [],
        },
        analyticalCapability: capability,
        ambiguityPeerIds: [],
      }],
      byEvidenceClass: { certified: [], semantic: [], sql: [] },
      ambiguousGroups: [],
    }, buildAnalysisQuestionPlan('What is revenue from Zoom customer?'), {
      contextObjects: [
        {
          objectKey: 'semantic:dimension:orders.customer_name', objectType: 'semantic_dimension', name: 'customer_name',
          fullName: dimensionId, payload: { qualifiedId: dimensionId, table: 'analytics.orders', expression: 'customer_name' },
        },
        {
          objectKey: 'runtime:value:zoom', objectType: 'runtime_value', name: 'customer_name = Zoom',
          payload: { relation: 'analytics.orders', column: 'customer_name', value: 'Zoom', normalizedValue: 'zoom' },
        },
      ],
    });
    expect(evidence.parsedIntent?.filters).toEqual([{ field: dimensionId, value: 'Zoom' }]);

    const ambiguous = toAgentRetrievalEvidence({
      candidates: [{
        objectKey: 'semantic:metric:orders.revenue', qualifiedId: metricId, evidenceClass: 'semantic', trustTier: 'semantic',
        classRank: 1, relevanceScore: 100, name: 'Revenue', aliases: ['revenue'], objectType: 'semantic_metric',
        relevanceReasons: [], compatibilityFacts: [], businessShape: {
          entities: [], dimensions: [dimensionId], timeGrains: [], parameters: [], filters: [], outputs: [], sourceRelations: [],
        }, analyticalCapability: {
          ...capability,
          dimensions: [
            ...capability.dimensions,
            {
              dimensionId: 'semantic:sales:dimension:account_customer_name',
              entityId: 'semantic:sales:entity:order',
              supportedRoles: ['filter' as const],
            },
          ],
        }, ambiguityPeerIds: [],
      }], byEvidenceClass: { certified: [], semantic: [], sql: [] }, ambiguousGroups: [],
    }, buildAnalysisQuestionPlan('What is revenue from Zoom customer?'), {
      contextObjects: [
        {
          objectKey: 'semantic:dimension:orders.customer_name', objectType: 'semantic_dimension', name: 'customer_name',
          fullName: dimensionId, payload: { qualifiedId: dimensionId, table: 'analytics.orders', expression: 'customer_name' },
        },
        {
          objectKey: 'semantic:dimension:accounts.customer_name', objectType: 'semantic_dimension', name: 'customer_name',
          fullName: 'semantic:sales:dimension:account_customer_name',
          payload: { qualifiedId: 'semantic:sales:dimension:account_customer_name', table: 'analytics.accounts', expression: 'customer_name' },
        },
        {
          objectKey: 'runtime:value:zoom:orders', objectType: 'runtime_value', name: 'customer_name = Zoom',
          payload: { relation: 'analytics.orders', column: 'customer_name', value: 'Zoom', normalizedValue: 'zoom' },
        },
        {
          objectKey: 'runtime:value:zoom:accounts', objectType: 'runtime_value', name: 'customer_name = Zoom',
          payload: { relation: 'analytics.accounts', column: 'customer_name', value: 'Zoom', normalizedValue: 'zoom' },
        },
      ],
    });
    expect(ambiguous.parsedIntent?.filters).toEqual([]);
  });

  it('builds a SQLite catalog with DQL, dbt, FTS, diagnostics, and query-run evidence', async () => {
    const refresh = await ensureMetadataCatalogFresh(projectRoot);

    expect(refresh.refreshed).toBe(true);
    expect(existsSync(defaultMetadataPath(projectRoot))).toBe(true);
    expect(refresh.objectCount).toBeGreaterThan(4);
    expect(refresh.edgeCount).toBeGreaterThan(0);
    expect(refresh.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'semantic',
          severity: 'warning',
        }),
      ]),
    );

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('dql:block:Top 10 Goal Scorers')).toMatchObject({
        objectType: 'dql_block',
        status: 'certified',
        payload: expect.objectContaining({
          sql: expect.stringContaining('ORDER BY total_points DESC'),
          tableDependencies: expect.arrayContaining(['fct_player_performance']),
          sqlFingerprints: expect.objectContaining({
            version: 'sql-fingerprint-v1',
            exact: expect.any(String),
            parameterized: expect.any(String),
          }),
          businessFingerprint: expect.objectContaining({
            version: 'business-shape-v1',
            hash: expect.any(String),
            tokens: expect.arrayContaining(['domain:nba']),
          }),
        }),
      });
      expect(catalog.getObject('dql:block:Top 10 Goal Scorers')?.payload?.sqlFingerprints).toMatchObject(
        buildBlockSqlFingerprints(`
    SELECT player_name, season, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1, 2
    ORDER BY total_points DESC
    LIMIT 10
  `),
      );
      expect(catalog.getObject('dbt:model:fct_player_performance')).toMatchObject({
        objectType: 'dbt_model',
        status: 'dbt_imported',
      });
      expect(catalog.edgesForKeys(['dql:block:Top 10 Goal Scorers'], 1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'uses_dbt_model',
            fromKey: 'dql:block:Top 10 Goal Scorers',
            toKey: 'dbt:model:fct_player_performance',
          }),
        ]),
      );
      expect(catalog.sourceFingerprints().map((item) => item.sourcePath)).toEqual(
        expect.arrayContaining(['blocks/top_10_goal_scorers.dql']),
      );
      expect(catalog.domainShards().map((item) => item.domain)).toEqual(
        expect.arrayContaining(['nba']),
      );
      expect(catalog.searchObjects({ query: 'least points player', limit: 10 }).map((row) => row.objectKey)).toEqual(
        expect.arrayContaining([
          'dql:block:Top 10 Goal Scorers',
          'dbt:column:fct_player_performance.total_points',
        ]),
      );
      expect(catalog.searchObjects({ query: 'scor', limit: 10 }).map((row) => row.objectKey)).toEqual(
        expect.arrayContaining([
          'dql:block:Top 10 Goal Scorers',
        ]),
      );
    } finally {
      catalog.close();
    }

    recordQueryRun(projectRoot, {
      objectKey: 'dbt:model:fct_player_performance',
      source: 'ai_draft',
      status: 'executed',
      rowCount: 10,
      durationMs: 42,
      payload: { sql: 'select player_name, total_points from fct_player_performance order by total_points asc limit 10' },
    });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Who scored the least points?',
      limit: 20,
    });

    expect(pack.id).toMatch(/^ctx_/);
    expect(pack.trustLabel).not.toBe('certified');
    expect(pack.objects.map((row) => row.objectKey)).toEqual(
      expect.arrayContaining([
        'dql:block:Top 10 Goal Scorers',
        'dbt:model:fct_player_performance',
        'dbt:column:fct_player_performance.total_points',
      ]),
    );
    expect(pack.queryRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'ai_draft', status: 'executed', rowCount: 10 }),
      ]),
    );
    expect(pack.warnings.join('\n')).toContain('No semantic');
    expect(pack.retrievalDiagnostics.selectedEvidence.length).toBeGreaterThan(0);
    expect(pack.citations.map((citation) => citation.objectKey)).toContain('dql:block:Top 10 Goal Scorers');
    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'ad_hoc_ranking',
      reviewStatus: 'draft_ready',
      trustLabelInfo: {
        id: 'ai_generated',
      },
    });
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining(['NBA_DB.ANALYTICS.fct_player_performance']),
    );
  });

  it('preserves BM25 separation and emits compact trust-separated meaning evidence', async () => {
    const generatedAt = '1970-01-01T00:00:00.000Z';
    const snapshot = {
      projectRoot,
      manifest: { generatedAt } as DQLManifest,
      objects: [
        {
          objectKey: 'dql:block:customer_rollover_report', objectType: 'dql_block',
          name: 'Customer rollover report', fullName: 'consumption.customer_rollover_report',
          domain: 'consumption', status: 'certified',
          description: 'Monthly customer report for actual rollover balances.',
          payload: {
            grain: 'customer_month', dimensions: ['customer', 'month'],
            parameters: [{ name: 'month' }], declaredOutputs: ['customer_id', 'rollover_balance_amount'],
          },
        },
        {
          objectKey: 'semantic:metric:consumption.rollover_balance_amount', objectType: 'semantic_metric',
          name: 'consumption.rollover_balance_amount', fullName: 'consumption.rollover_balance_amount',
          domain: 'consumption', status: 'approved',
          description: 'Remaining eligible balance carried into the next billing month.',
          payload: { label: 'Rollover Balance Amount', aggregation: 'sum', dimensions: ['customer', 'month'], table: 'fct_consumption' },
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          objectKey: `semantic:measure:consumption.rollover_balance_amount_${index}`, objectType: 'semantic_measure',
          name: `consumption.rollover_balance_amount_${index}`, fullName: `consumption.rollover_balance_amount_${index}`,
          domain: 'consumption', status: 'approved',
          description: 'Remaining eligible balance carried into the next billing month.',
          payload: { label: 'Rollover Balance Amount', aggregation: 'sum', dimensions: ['customer', 'month'], table: 'fct_consumption' },
        })),
        {
          objectKey: 'semantic:metric:consumption.rollover_risk_amount', objectType: 'semantic_metric',
          name: 'consumption.rollover_risk_amount', fullName: 'consumption.rollover_risk_amount',
          domain: 'consumption', status: 'approved',
          description: 'Forecasted balance at risk of expiring before rollover.',
          payload: { label: 'Rollover Risk Amount', aggregation: 'sum', dimensions: ['customer', 'month'], table: 'fct_consumption' },
        },
        {
          objectKey: 'dbt:model:fct_consumption', objectType: 'dbt_model', name: 'fct_consumption',
          fullName: 'analytics.fct_consumption', status: 'dbt_catalog',
          description: 'Customer monthly consumption, rollover balance, and risk facts.',
          payload: { uniqueId: 'model.analytics.fct_consumption', relation: 'analytics.fct_consumption', columns: [{ name: 'rollover_balance_amount' }] },
        },
      ],
      edges: [], diagnostics: [], compileConflicts: [], fingerprint: 'meaning-evidence-test', generatedAt,
    };
    upsertMetadataSnapshot(projectRoot, snapshot);

    const catalog = openMetadataCatalog(projectRoot);
    try {
      const hits = catalog.searchObjects({ query: 'monthly rollover balance amount', limit: 10 });
      const exact = hits.find((hit) => hit.objectKey === 'semantic:metric:consumption.rollover_balance_amount');
      const partial = hits.find((hit) => hit.objectKey === 'semantic:metric:consumption.rollover_risk_amount');
      expect(exact?.score).toBeGreaterThan(partial?.score ?? 0);
      expect(new Set(hits.map((hit) => hit.score)).size).toBeGreaterThan(1);
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Who are the top customers by monthly rollover balance amount?',
      preparedMetadataFingerprint: snapshot.fingerprint,
      limit: 20,
    });
    const meaning = pack.retrievalDiagnostics.meaningEvidence;
    expect(meaning?.candidates.length).toBeLessThanOrEqual(12);
    expect(meaning?.byEvidenceClass.certified[0]).toMatchObject({
      objectKey: 'dql:block:customer_rollover_report', trustTier: 'certified',
    });
    expect(meaning?.byEvidenceClass.semantic.map((candidate) => candidate.objectKey)).toEqual(
      expect.arrayContaining([
        'semantic:metric:consumption.rollover_balance_amount',
        'semantic:metric:consumption.rollover_risk_amount',
      ]),
    );
    expect(meaning?.byEvidenceClass.semantic.filter((candidate) =>
      candidate.definition === 'Remaining eligible balance carried into the next billing month.')).toHaveLength(1);
    expect(meaning?.byEvidenceClass.sql[0]).toMatchObject({
      objectKey: 'dbt:model:fct_consumption', trustTier: 'exploratory',
    });
    expect(meaning?.ambiguousGroups.some((group) =>
      group.candidateIds.includes('semantic:metric:consumption.rollover_balance_amount')
      && group.candidateIds.includes('semantic:metric:consumption.rollover_risk_amount'))).toBe(true);
    const agentEvidence = toAgentRetrievalEvidence(meaning!, pack.questionPlan, {
      snapshotId: 'snapshot-meaning', sourceFingerprint: snapshot.fingerprint,
    });
    expect(agentEvidence).toMatchObject({
      snapshotId: 'snapshot-meaning',
      sourceFingerprint: snapshot.fingerprint,
      parsedIntent: { dimensions: expect.arrayContaining(['customer']), order: 'desc' },
    });
    expect(agentEvidence.candidates.find((candidate) =>
      candidate.id === 'semantic:metric:consumption.rollover_balance_amount')).toMatchObject({
      kind: 'semantic_metric', trustTier: 'semantic', compatibility: 'unknown', eligible: true,
    });
  });

  it('hands the whole small catalog to deep research and keeps ranked selection otherwise', async () => {
    // Deep mode (strictness: exploratory) over a tiny catalog: skip top-k pruning
    // and include every relation, even for a question that would not lexically
    // select it.
    const deep = await buildLocalContextPack(projectRoot, {
      question: 'give me an overview of everything available',
      strictness: 'exploratory',
    });
    expect(deep.retrievalDiagnostics.strategy).toBe('full_catalog');
    expect(deep.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining(['NBA_DB.ANALYTICS.fct_player_performance']),
    );

    // Quick mode keeps ranked (sqlite_fts) selection — no full-catalog dump.
    const quick = await buildLocalContextPack(projectRoot, {
      question: 'give me an overview of everything available',
    });
    expect(quick.retrievalDiagnostics.strategy).not.toBe('full_catalog');
  });

  it('lets reindexProject skip unchanged metadata catalog rebuilds by fingerprint', async () => {
    const firstStats = await reindexProject(projectRoot, { loadSkills: false });
    const first = openMetadataCatalog(projectRoot);
    const firstBuiltAt = first.state('built_at');
    first.close();

    expect(firstBuiltAt).toBeTruthy();
    expect(firstStats.metadataRefreshed).toBe(true);
    expect(firstStats.metadataFingerprint).toBeTruthy();

    const secondStats = await reindexProject(projectRoot, { loadSkills: false });
    const second = openMetadataCatalog(projectRoot);
    try {
      expect(second.state('built_at')).toBe(firstBuiltAt);
    } finally {
      second.close();
    }
    expect(secondStats.metadataRefreshed).toBe(false);
    expect(secondStats.metadataFingerprint).toBe(firstStats.metadataFingerprint);
  });

  it('CTX-002 leases one immutable snapshot while a newer snapshot activates', async () => {
    const first = await ensureMetadataCatalogFresh(projectRoot, { force: true });
    const oldLease = acquireActiveKnowledgeSnapshot(projectRoot);
    expect(oldLease.snapshotId).toBe(first.fingerprint);
    expect(activeKnowledgeSnapshotLeaseCount(oldLease.path)).toBe(1);

    addGenericAthleteBoxScoreModel(projectRoot, 'snapshot_generation_two');
    const second = await ensureMetadataCatalogFresh(projectRoot);
    const newLease = acquireActiveKnowledgeSnapshot(projectRoot);
    try {
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(newLease.snapshotId).toBe(second.fingerprint);
      expect(newLease.path).not.toBe(oldLease.path);
      expect(oldLease.catalog.state('fingerprint')).toBe(first.fingerprint);
      expect(oldLease.catalog.getObject('dbt:model:snapshot_generation_two')).toBeNull();
      expect(newLease.catalog.getObject('dbt:model:snapshot_generation_two')).toMatchObject({
        objectType: 'dbt_model',
      });
    } finally {
      newLease.release();
      oldLease.release();
    }
    expect(activeKnowledgeSnapshotLeaseCount()).toBe(0);
  });

  it('ID-001 resolves canonical semantic identities and fails closed on ambiguous aliases', async () => {
    writeQualifiedSemanticIdentityFixture(projectRoot);
    const semanticLayer = resolveSemanticLayerWithDiagnostics({
      provider: 'dbt',
      projectPath: '.',
    }, projectRoot).layer;
    await ensureMetadataCatalogFresh(projectRoot, { force: true, semanticLayer });

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.resolveIdentity('semantic:consumption:rollover_balance_amount')).toMatchObject({
        status: 'resolved',
        matchedBy: 'qualified_id',
        object: {
          objectType: 'semantic_metric',
          fullName: 'semantic:consumption:rollover_balance_amount',
          payload: expect.objectContaining({
            sourceNativeId: 'metric.scale.rollover_balance_amount',
          }),
        },
      });
      expect(catalog.resolveIdentity('metric.scale.rollover_balance_amount')).toMatchObject({
        status: 'resolved',
        matchedBy: 'source_native_id',
      });
      const ambiguous = catalog.resolveIdentity('Rollover Balance Amount');
      expect(ambiguous.status).toBe('ambiguous');
      expect(ambiguous.candidates).toHaveLength(2);
      expect(catalog.findObjectByIdentity('Rollover Balance Amount')).toBeNull();
    } finally {
      catalog.close();
    }
  });

  it('CTX-005 generates vector candidates independently and applies Domain eligibility before ranking', async () => {
    writeQualifiedSemanticIdentityFixture(projectRoot);
    const semanticLayer = resolveSemanticLayerWithDiagnostics({
      provider: 'dbt',
      projectPath: '.',
    }, projectRoot).layer;
    await ensureMetadataCatalogFresh(projectRoot, { force: true, semanticLayer });
    const provider = {
      id: 'semantic-fixture-v1',
      dimensions: 2,
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => {
          const normalized = text.toLowerCase();
          if (normalized.includes('unused carryover inventory') || normalized.includes('remaining eligible balance')) return [1, 0];
          if (normalized.includes('general-ledger liability')) return [0, 1];
          return [0, 0];
        });
      },
    };
    const catalog = openMetadataCatalog(projectRoot);
    try {
      await catalog.rebuildVectorIndex(provider);
      const lexical = catalog.searchObjects({ query: 'unused carryover inventory', limit: 20 });
      expect(lexical.map((object) => object.fullName)).not.toContain('semantic:consumption:rollover_balance_amount');

      const retrieved = await retrieveMetadataSnapshotCandidates(catalog, {
        question: 'unused carryover inventory',
        embeddingProvider: provider,
        domainContext: {
          activeDomain: 'consumption',
          ancestors: [],
          allowedImports: [],
          source: 'explicit_api',
          confidence: 'high',
          snapshotId: catalog.state('fingerprint')!,
        },
        limit: 20,
      });
      const vectorLane = retrieved.lanes.find((lane) => lane.lane === 'vector');
      expect(vectorLane).toMatchObject({
        provider: provider.id,
        candidates: [
          expect.objectContaining({
            objectKey: 'semantic:metric:consumption_model.rollover_balance_amount',
            rank: 1,
          }),
        ],
      });
      expect(vectorLane?.candidates.some((candidate) => candidate.objectKey.includes('billing_rollover'))).toBe(false);
    } finally {
      catalog.close();
    }
  });

  it('SKILL-001 / CTX-002 snapshots parsed skills, invalidates on source changes, and returns only domain/Area-eligible guidance', async () => {
    mkdirSync(join(projectRoot, 'skills'), { recursive: true });
    writeFileSync(join(projectRoot, 'skills', 'nba-ranking.skill.md'), `---
id: nba-ranking
domain: nba
model_areas: [scoring]
description: Rank players by total points.
triggers: [points, scorer]
preferred_metrics: [total_points]
vocabulary: { scorer: metric:total_points }
analytical_policy:
  metric_ids: [semantic:nba:total_points]
  timezone: America/Chicago
  calendar_id: calendar:gregorian
  completeness_policy: latest_complete
  default_ranking_period: current
---
Use player scoring facts and explain the ranking grain.
`, 'utf-8');
    writeFileSync(join(projectRoot, 'skills', 'nba-finance.skill.md'), `---
id: nba-finance
domain: nba
model_areas: [finance]
triggers: [points]
---
This must not apply outside the finance Area.
`, 'utf-8');
    writeFileSync(join(projectRoot, 'skills', 'revenue-policy.skill.md'), `---
id: revenue-policy
domain: revenue
triggers: [points]
---
This must not leak into the NBA domain.
`, 'utf-8');

    const first = await reindexProject(projectRoot);
    expect(first.skills).toBe(3);
    expect(first.metadataRefreshed).toBe(true);
    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('skill:nba::skill::nba-ranking')).toMatchObject({
        objectType: 'skill',
        sourceSystem: 'DQL domain skill',
        payload: expect.objectContaining({
          modelAreaRefs: ['scoring'],
          preferredMetrics: ['total_points'],
          vocabulary: { scorer: 'metric:total_points' },
          analyticalPolicy: expect.objectContaining({
            metricIds: ['semantic:nba:total_points'],
            timezone: 'America/Chicago',
            completenessPolicy: 'latest_complete',
          }),
          bodyHash: expect.any(String),
        }),
      });
      const object = catalog.getObject('skill:nba::skill::nba-ranking');
      expect(object?.payload).not.toHaveProperty('body');
      expect(catalog.skillBody(String(object?.payload?.bodyHash))).toContain('ranking grain');
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Who are the leading points scorers?',
      domainContext: {
        activeDomain: 'nba',
        ancestors: [],
        allowedImports: [],
        modelAreaId: 'scoring',
        source: 'explicit_api',
        confidence: 'high',
        snapshotId: first.metadataFingerprint,
      },
    });
    expect(pack.skills.map((skill) => skill.id)).toEqual(['nba-ranking']);
    expect(pack.skills[0]).toMatchObject({
      objectKey: 'skill:nba::skill::nba-ranking',
      provenance: 'DQL domain skill',
      guidance: expect.stringContaining('ranking grain'),
      analyticalPolicy: {
        policyId: 'nba::skill::nba-ranking#analytical',
        sourceHash: pack.knowledgeLens.skillFingerprints?.['nba::skill::nba-ranking'],
        metricIds: ['semantic:nba:total_points'],
        calendarId: 'calendar:gregorian',
        timezone: 'America/Chicago',
        completenessPolicy: 'latest_complete',
        defaultRankingPeriod: 'current',
        narrativeGuidance: [],
      },
    });
    expect(pack.objects.map((object) => object.objectKey)).toContain('skill:nba::skill::nba-ranking');
    expect(pack.objects.map((object) => object.objectKey)).not.toContain('skill:nba::skill::nba-finance');
    expect(pack.objects.map((object) => object.objectKey)).not.toContain('skill:revenue::skill::revenue-policy');

    writeFileSync(join(projectRoot, 'skills', 'nba-ranking.skill.md'), `---
id: nba-ranking
domain: nba
model_areas: [scoring]
triggers: [points]
---
Use player scoring facts with a revised tie-break rule.
`, 'utf-8');
    const second = await reindexProject(projectRoot);
    expect(second.metadataRefreshed).toBe(true);
    expect(second.metadataFingerprint).not.toBe(first.metadataFingerprint);
  });

  it('CTX-004 indexes Model Areas, scopes Skills, and infers a focused Area inside the active domain', async () => {
    mkdirSync(join(projectRoot, 'skills'), { recursive: true });
    writeFileSync(join(projectRoot, 'skills', 'scoring.skill.md'), `---
id: scoring-guide
domain: nba
model_areas: [scoring]
description: Explain player points and scoring leaderboards.
triggers: [points, scoring, leaders]
---
Use the scoring model area.
`, 'utf-8');
    writeFileSync(join(projectRoot, 'skills', 'finance.skill.md'), `---
id: finance-guide
domain: nba
model_areas: [finance]
description: Explain salary and payroll spending.
triggers: [salary, payroll, spending]
---
Use the finance model area.
`, 'utf-8');

    const manifest = {
      manifestVersion: 3,
      dqlVersion: 'test', generatedAt: '1970-01-01T00:00:00.000Z', project: 'test', projectRoot,
      domains: {
        nba: { id: 'nba', name: 'NBA', filePath: 'domains/nba/domain.dql' },
        growth: { id: 'growth', name: 'Growth', filePath: 'domains/growth/domain.dql' },
      },
      blocks: {}, businessViews: {}, terms: {}, notebooks: {}, dashboards: {}, apps: {}, metrics: {}, dimensions: {}, sources: {},
      lineage: { nodes: [], edges: [] }, diagnostics: [],
      dbtProvenance: { manifestPath: join(projectRoot, 'target/manifest.json'), manifestFingerprint: 'area-snapshot', nodes: {}, metricFlow: {} },
      modeling: {
        mode: 'dbt-first',
        packages: {
          nba: { id: 'nba', filePath: 'domains/nba/domain.dql', exports: [] },
          growth: { id: 'growth', filePath: 'domains/growth/domain.dql', exports: [] },
        },
        areas: {
          'nba::model_area::scoring': {
            id: 'nba::model_area::scoring', localId: 'scoring', qualifiedId: 'nba::model_area::scoring', domain: 'nba', name: 'Player scoring',
            description: 'Points, scoring leaders, and player performance.', intentExamples: ['Who leads the league in points?'],
            entityIds: ['nba::entity::performance'], relationshipIds: [], referencedEntityIds: [], sourcePath: 'domains/nba/modeling/areas/scoring.dql.yaml',
          },
          'nba::model_area::finance': {
            id: 'nba::model_area::finance', localId: 'finance', qualifiedId: 'nba::model_area::finance', domain: 'nba', name: 'Team finance',
            description: 'Salary, payroll, and team spending.', intentExamples: ['Which team has the largest payroll?'],
            entityIds: [], relationshipIds: [], referencedEntityIds: [], sourcePath: 'domains/nba/modeling/areas/finance.dql.yaml',
          },
        },
        entities: {
          'nba::entity::performance': {
            id: 'nba::entity::performance', localId: 'performance', qualifiedId: 'nba::entity::performance', domain: 'nba',
            areaId: 'nba::model_area::scoring', dbtUniqueId: 'model.nba.performance', keys: [], sourcePath: 'domains/nba/modeling/areas/scoring.dql.yaml', identityFingerprint: 'p',
          },
          'growth::entity::performance': {
            id: 'growth::entity::performance', localId: 'performance', qualifiedId: 'growth::entity::performance', domain: 'growth',
            dbtUniqueId: 'model.growth.performance', keys: [], sourcePath: 'domains/growth/modeling/entities.dql.yaml', identityFingerprint: 'growth-p',
          },
        },
        relationships: {}, contracts: {}, conformance: {}, rules: {}, interfaces: { exports: {}, imports: {} }, domainLineage: [],
      },
    } as unknown as DQLManifest;
    const snapshot = buildMetadataSnapshot(projectRoot, manifest);
    upsertMetadataSnapshot(projectRoot, snapshot);
    expect(snapshot.objects.map((object) => object.objectKey)).toEqual(expect.arrayContaining([
      'dql:entity:nba::entity::performance',
      'dql:entity:growth::entity::performance',
    ]));
    const identityCatalog = openMetadataCatalog(projectRoot);
    try {
      expect(identityCatalog.getObject('semantic:entity:performance')).toBeNull();
      expect(identityCatalog.getObject('dql:entity:nba::entity::performance')).toMatchObject({ domain: 'nba' });
    } finally {
      identityCatalog.close();
    }

    const explicit = await buildLocalContextPack(projectRoot, {
      question: 'Who are the points leaders?', preparedMetadataFingerprint: snapshot.fingerprint,
      domainContext: { activeDomain: 'nba', ancestors: [], allowedImports: [], modelAreaId: 'nba::model_area::scoring', source: 'explicit_api', confidence: 'high', snapshotId: 'area-snapshot' },
    });
    expect(explicit.retrievalDiagnostics).toMatchObject({ focusedModelAreaId: 'nba::model_area::scoring', modelAreaSource: 'explicit' });
    expect(explicit.objects.map((object) => object.objectType)).toContain('model_area');
    expect(explicit.objects.map((object) => object.objectKey)).toContain('dql:entity:nba::entity::performance');
    expect(explicit.skills.map((skill) => skill.id)).toEqual(['scoring-guide']);

    const inferred = await buildLocalContextPack(projectRoot, {
      question: 'Which team has the largest salary payroll spending?', preparedMetadataFingerprint: snapshot.fingerprint,
      domainContext: { activeDomain: 'nba', ancestors: [], allowedImports: [], source: 'explicit_api', confidence: 'high', snapshotId: 'area-snapshot' },
    });
    expect(inferred.retrievalDiagnostics).toMatchObject({ focusedModelAreaId: 'nba::model_area::finance', modelAreaSource: 'inferred' });
    expect(inferred.skills.map((skill) => skill.id)).toEqual(['finance-guide']);
  });

  it('lets reindexProject skip unchanged KG rebuilds by graph fingerprint', async () => {
    const firstStats = await reindexProject(projectRoot, { loadSkills: false });
    const first = new KGStore(defaultKgPath(projectRoot));
    const firstBuiltAt = first.meta('built_at');
    const firstFingerprint = first.meta('fingerprint');
    first.close();

    expect(firstBuiltAt).toBeTruthy();
    expect(firstFingerprint).toBeTruthy();
    expect(firstStats.kgRebuilt).toBe(true);
    expect(firstStats.kgFingerprint).toBe(firstFingerprint);

    await sleep(10);
    const secondStats = await reindexProject(projectRoot, { loadSkills: false });
    const second = new KGStore(defaultKgPath(projectRoot));
    const secondBuiltAt = second.meta('built_at');
    const secondFingerprint = second.meta('fingerprint');
    second.close();

    expect(secondBuiltAt).toBe(firstBuiltAt);
    expect(secondFingerprint).toBe(firstFingerprint);
    expect(secondStats.kgRebuilt).toBe(false);
    expect(secondStats.kgFingerprint).toBe(firstStats.kgFingerprint);

    await sleep(10);
    const forcedStats = await reindexProject(projectRoot, { loadSkills: false, forceKgIndex: true });
    const forced = new KGStore(defaultKgPath(projectRoot));
    try {
      expect(forced.meta('fingerprint')).toBe(firstFingerprint);
      expect(forced.meta('built_at')).not.toBe(firstBuiltAt);
    } finally {
      forced.close();
    }
    expect(forcedStats.kgRebuilt).toBe(true);
    expect(forcedStats.kgFingerprint).toBe(firstStats.kgFingerprint);
  });

  it('indexes block output column lineage as traversable metadata edges', async () => {
    await ensureMetadataCatalogFresh(projectRoot);

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('dql:block_output:Top 10 Goal Scorers.total_points')).toMatchObject({
        objectType: 'dql_block_output',
        name: 'total_points',
        payload: expect.objectContaining({
          block: 'Top 10 Goal Scorers',
          output: 'total_points',
          isAggregate: true,
          aggregateFn: 'SUM',
          sources: expect.arrayContaining([
            expect.objectContaining({ table: 'fct_player_performance', column: 'points' }),
          ]),
        }),
      });
      expect(catalog.edgesForKeys(['dql:block:Top 10 Goal Scorers'], 3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'contains',
            fromKey: 'dql:block:Top 10 Goal Scorers',
            toKey: 'dql:block_output:Top 10 Goal Scorers.total_points',
          }),
          expect.objectContaining({
            edgeType: 'derives_from',
            fromKey: 'dql:block_output:Top 10 Goal Scorers.total_points',
            toKey: 'dbt:column:fct_player_performance.points',
          }),
        ]),
      );
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can I trust the total points lineage?',
      limit: 30,
    });

    expect(pack.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'derives_from',
          fromKey: 'dql:block_output:Top 10 Goal Scorers.total_points',
          toKey: 'dbt:column:fct_player_performance.points',
        }),
      ]),
    );
    expect(pack.objects.map((object) => object.objectKey)).toContain('dql:block_output:Top 10 Goal Scorers.total_points');
    const scoringRelation = pack.allowedSqlContext.relations.find((relation) =>
      relation.relation.endsWith('fct_player_performance'),
    );
    expect(scoringRelation?.columns.find((column) => column.name === 'points')?.description).toContain(
      'Governed aliases from lineage: total_points.',
    );
  });

  it('indexes dbt compiled SQL column lineage as traversable metadata edges', async () => {
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    manifest.nodes['model.nba_analysis.stg_player_games'] = {
      resource_type: 'model',
      name: 'stg_player_games',
      alias: 'stg_player_games',
      database: 'NBA_DB',
      schema: 'STAGING',
      description: 'Staging player game rows.',
      depends_on: { nodes: [] },
      tags: ['nba', 'player'],
      original_file_path: 'models/staging/stg_player_games.sql',
      config: { materialized: 'view' },
      columns: {
        player_name: { name: 'player_name', data_type: 'text', description: 'Player full name.' },
        season: { name: 'season', data_type: 'number', description: 'NBA season year.' },
        points: { name: 'points', data_type: 'number', description: 'Points scored in a game.' },
      },
    };
    manifest.nodes['model.nba_analysis.fct_player_performance'] = {
      ...manifest.nodes['model.nba_analysis.fct_player_performance'],
      depends_on: { nodes: ['model.nba_analysis.stg_player_games'] },
      compiled_code: `
        SELECT player_name, season, SUM(points) AS total_points
        FROM stg_player_games
        GROUP BY 1, 2
      `,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    await ensureMetadataCatalogFresh(projectRoot);

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('dbt:column:fct_player_performance.total_points')).toMatchObject({
        objectType: 'dbt_column',
        payload: expect.objectContaining({
          compiledSqlLineage: true,
          aggregateFn: 'SUM',
          lineageSources: expect.arrayContaining([
            expect.objectContaining({ table: 'stg_player_games', column: 'points' }),
          ]),
        }),
      });
      expect(catalog.edgesForKeys(['dbt:model:fct_player_performance'], 3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'derives_from',
            fromKey: 'dbt:column:fct_player_performance.total_points',
            toKey: 'dbt:column:stg_player_games.points',
          }),
        ]),
      );
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can I trust dbt total_points lineage from stg player games?',
      limit: 40,
    });

    expect(pack.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'derives_from',
          fromKey: 'dbt:column:fct_player_performance.total_points',
          toKey: 'dbt:column:stg_player_games.points',
        }),
      ]),
    );
  });

  it('uses governed lineage aliases to map business metrics onto physical columns', async () => {
    writeFileSync(
      join(projectRoot, 'blocks', 'product_revenue_context.dql'),
      `block "Product Revenue Context" {
  domain = "orders"
  type = "custom"
  status = "certified"
  description = "Certified product revenue context."
  tags = ["product", "revenue"]
  grain = "product"
  entities = ["Product"]
  outputs = ["product_name", "revenue"]
  query = """
    SELECT product_name, SUM(product_price) AS revenue
    FROM order_items
    GROUP BY 1
  """
}`,
      'utf-8',
    );
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    manifest.nodes['model.nba_analysis.order_items'] = {
      resource_type: 'model',
      name: 'order_items',
      alias: 'order_items',
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: 'Order item rows with product details and item price.',
      depends_on: { nodes: [] },
      tags: ['orders', 'product'],
      original_file_path: 'models/marts/order_items.sql',
      config: { materialized: 'table' },
      columns: {
        product_name: { name: 'product_name', data_type: 'text', description: 'Product display name.' },
        product_price: { name: 'product_price', data_type: 'number', description: 'Item sale price.' },
        product_type: { name: 'product_type', data_type: 'text', description: 'Food or drink category.' },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show revenue by product',
      limit: 40,
    });

    const orderItems = pack.allowedSqlContext.relations.find((relation) =>
      relation.relation.endsWith('order_items'),
    );
    expect(orderItems?.columns.find((column) => column.name === 'product_price')?.description).toContain(
      'Governed aliases from lineage: revenue.',
    );
    expect(pack.retrievalDiagnostics.selectedRelations?.find((relation) =>
      relation.relation.endsWith('order_items'),
    )?.reason).toContain('semantic column map matched');
    expect(pack.retrievalDiagnostics.selectedRelations?.find((relation) =>
      relation.relation.endsWith('order_items'),
    )?.reason).toContain('revenue->product_price');
  });

  it('routes exact certified block-name questions to certified execution', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Run Top 10 Goal Scorers',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      intent: 'exact_certified_lookup',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
    });
  });

  it('indexes optional DataLex contract evidence and links bound DQL blocks', async () => {
    writeFileSync(
      join(projectRoot, 'datalex-manifest.json'),
      JSON.stringify({
        manifestSpecVersion: '1.0.0',
        datalexVersion: 'test',
        generatedAt: '2026-06-20T00:00:00.000Z',
        project: { name: 'nba_contracts' },
        domains: [
          {
            name: 'nba',
            description: 'NBA player analytics contracts.',
            owners: ['data-governance'],
            glossary: [
              {
                term: 'Top Scorer',
                definition: 'A player ranked by total points scored.',
                tags: ['nba', 'scoring'],
              },
            ],
            entities: [
              {
                name: 'Player',
                description: 'NBA player business entity.',
                fields: [
                  { name: 'player_name', type: 'string', description: 'Player display name.' },
                  { name: 'total_points', type: 'number', description: 'Total points scored.' },
                ],
                contracts: [
                  {
                    id: 'nba.Player.top_scorers',
                    name: 'Top Scorers',
                    version: 1,
                    description: 'Contract for ranking NBA players by points.',
                    owner: 'analytics@example.com',
                    signature: {
                      outputs: [
                        { name: 'player_name', type: 'string' },
                        { name: 'total_points', type: 'number' },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'blocks', 'contracted_top_scorers.dql'),
      `block "Contracted Top Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  datalex_contract = "nba.Player.top_scorers@1"
  owner = "analytics@example.com"
  description = "Contract-backed top scorer ranking."
  tags = ["nba", "player", "points"]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
  """
}`,
      'utf-8',
    );

    await ensureMetadataCatalogFresh(projectRoot);
    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('datalex:domain:nba')).toMatchObject({
        objectType: 'datalex_domain',
        owner: 'data-governance',
      });
      expect(catalog.getObject('datalex:entity:nba.Player')).toMatchObject({
        objectType: 'datalex_entity',
        description: 'NBA player business entity.',
      });
      expect(catalog.getObject('datalex:contract:nba.Player.top_scorers@1')).toMatchObject({
        objectType: 'datalex_contract',
        description: 'Contract for ranking NBA players by points.',
      });
      expect(catalog.edgesForKeys(['dql:block:Contracted Top Scorers'], 1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'resolves_contract',
            fromKey: 'dql:block:Contracted Top Scorers',
            toKey: 'datalex:contract:nba.Player.top_scorers@1',
          }),
        ]),
      );
    } finally {
      catalog.close();
    }
  });

  it('turns DataLex relationships into grain-safe datalex join paths (R2.8)', async () => {
    // Two dbt models sharing player_id, and a DataLex manifest that models the
    // relationship between the entities bound to them.
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes: Record<string, Record<string, unknown>> };
    manifest.nodes['model.nba_analysis.dim_players'] = {
      resource_type: 'model', name: 'dim_players', alias: 'dim_players', database: 'NBA_DB', schema: 'ANALYTICS',
      description: 'Player dimension.', depends_on: { nodes: [] }, original_file_path: 'models/dim_players.sql',
      columns: {
        player_id: { name: 'player_id', data_type: 'text', description: 'Player id.' },
        player_name: { name: 'player_name', data_type: 'text', description: 'Player name.' },
      },
    };
    manifest.nodes['model.nba_analysis.fct_games'] = {
      resource_type: 'model', name: 'fct_games', alias: 'fct_games', database: 'NBA_DB', schema: 'ANALYTICS',
      description: 'Game facts by player.', depends_on: { nodes: [] }, original_file_path: 'models/fct_games.sql',
      columns: {
        player_id: { name: 'player_id', data_type: 'text', description: 'Player id.' },
        points: { name: 'points', data_type: 'number', description: 'Points scored.' },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    writeFileSync(
      join(projectRoot, 'datalex-manifest.json'),
      JSON.stringify({
        manifestSpecVersion: '1.0.0', datalexVersion: 'test', generatedAt: '2026-06-20T00:00:00.000Z',
        project: { name: 'nba_contracts' },
        domains: [{
          name: 'nba', entities: [
            { name: 'Player', binding: { kind: 'dbt_model', ref: 'dim_players' }, fields: [{ name: 'player_id', primary_key: true }] },
            { name: 'Game', binding: { kind: 'dbt_model', ref: 'fct_games' }, fields: [{ name: 'player_id' }] },
          ],
        }],
        relationships: [{
          name: 'player_plays_game', type: 'reference', identifying: true, cardinality: 'one_to_many',
          from: { entity: 'Player', column: 'player_id' },
          to: { entity: 'Game', column: 'player_id' },
        }],
      }),
      'utf-8',
    );

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'points by player joining players and games',
      limit: 40,
    });

    expect(pack.retrievalDiagnostics.selectedJoinPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'datalex',
          leftColumn: 'player_id',
          rightColumn: 'player_id',
          reason: expect.stringContaining('DataLex relationship player_plays_game'),
        }),
      ]),
    );
  });

  it('ingests DataLex conformance as searchable concept objects (W5.1)', async () => {
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes: Record<string, Record<string, unknown>> };
    manifest.nodes['model.nba_analysis.dim_players_w51'] = {
      resource_type: 'model', name: 'dim_players_w51', alias: 'dim_players_w51', database: 'NBA_DB', schema: 'ANALYTICS',
      description: 'Player dimension.', depends_on: { nodes: [] }, original_file_path: 'models/dim_players_w51.sql',
      columns: { player_id: { name: 'player_id', data_type: 'text' } },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    writeFileSync(
      join(projectRoot, 'datalex-manifest.json'),
      JSON.stringify({
        manifestSpecVersion: '1.0.0', datalexVersion: 'test', generatedAt: '2026-06-20T00:00:00.000Z',
        project: { name: 'nba_contracts' },
        domains: [{ name: 'nba', entities: [] }],
        conformance: [{
          concept: 'PlayerProfile', domain: 'nba', canonical_key: ['player_id'],
          physical: [{ entity: 'DimPlayers', binding: { kind: 'dbt_model', ref: 'dim_players_w51' } }],
        }],
      }),
      'utf-8',
    );

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'PlayerProfile concept',
      limit: 40,
    });
    const concept = pack.objects.find((o) => o.objectType === 'datalex_concept' && o.name === 'PlayerProfile');
    expect(concept).toBeDefined();
    expect(concept?.payload?.canonicalKey).toEqual(['player_id']);
    expect(concept?.payload?.physicalRefs).toEqual(['dbt:model:dim_players_w51']);
  });

  it('routes exact certified example questions to certified execution', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Who were the top scorers?',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      intent: 'ad_hoc_ranking',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
    });
  });

  it('routes certified blocks by business content even when the block name is not used', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Which NBA players are the leading scorers?',
      limit: 20,
    });

    expect(plan.contextPack.questionPlan).toMatchObject({
      mode: 'ranking',
      routeIntent: 'ad_hoc_ranking',
    });
    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
      certifiedApplicability: expect.objectContaining({
        kind: 'exact_answer',
        name: 'Top 10 Goal Scorers',
      }),
    });
  });

  it('grain gate: demotes a wrong-grain certified block to generated SQL (Tier 2)', async () => {
    // A player-grain certified block exists; the question asks for a team grain.
    // Retrieval surfaces the player block as the best certified candidate, but
    // its declared grain does not satisfy the requested grain, so the answer is
    // demoted to Tier 2 instead of served as a near-miss certified answer.
    addGrainedTeamScoringModel(projectRoot);
    writeFileSync(
      join(projectRoot, 'blocks', 'player_scoring_leaders.dql'),
      `block "Player Scoring Leaders" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Certified ranking of player scoring leaders by total points."
  tags = ["nba", "player", "points", "scoring"]
  grain = "player_id"
  entities = ["Player"]
  outputs = ["player_name", "total_points"]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
    ORDER BY total_points DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const plan = await planAgentAnswer(projectRoot, {
      question: 'Show total points by team',
      limit: 30,
    });

    expect(plan.routeDecision.route).toBe('generated_sql');
    expect(plan.routeDecision.routeReason).toMatch(/player.*team.*Tier 2/i);
    expect(plan.routeDecision.grainGate).toMatchObject({
      allow: false,
      kind: 'mismatch',
      blockName: 'Player Scoring Leaders',
    });
  });

  it('grain gate: keeps an exact-grain certified question on Tier 1 (no regression)', async () => {
    writeFileSync(
      join(projectRoot, 'blocks', 'player_scoring_leaders.dql'),
      `block "Player Scoring Leaders" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Certified ranking of player scoring leaders by total points."
  tags = ["nba", "player", "points", "scoring"]
  grain = "player_id"
  entities = ["Player"]
  outputs = ["player_name", "total_points"]
  examples = [{ question = "Show total points by player" }]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
    ORDER BY total_points DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const plan = await planAgentAnswer(projectRoot, {
      question: 'Show total points by player',
      limit: 30,
    });

    expect(plan.routeDecision.route).toBe('certified');
    expect(plan.routeDecision.exactObjectKey).toBe('dql:block:Player Scoring Leaders');
  });

  it('block-fit gate: demotes a category certified block for product-grain revenue questions', async () => {
    addJaffleOrderItemsModel(projectRoot);
    writeFileSync(
      join(projectRoot, 'blocks', 'food_vs_drink_revenue.dql'),
      `block "food_vs_drink_revenue" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Revenue split between food and drink categories from order items."
  tags = ["revenue", "category", "food", "drink"]
  llmContext = "Use only for Food vs Drink category-level revenue, not product-level revenue."
  grain = "category"
  entities = ["Category"]
  outputs = ["category", "revenue"]
  dimensions = ["category"]
  query = """
    SELECT product_type AS category, SUM(product_price) AS revenue
    FROM order_items
    GROUP BY 1
    ORDER BY revenue DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue',
      limit: 40,
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'ad_hoc_ranking',
      reviewStatus: 'draft_ready',
      trustLabelInfo: {
        id: 'ai_generated',
      },
      certifiedApplicability: expect.objectContaining({
        name: 'food_vs_drink_revenue',
        kind: 'context_only',
      }),
      blockFit: expect.objectContaining({
        kind: 'context_only',
        confidence: 'high',
        missingDimensions: expect.arrayContaining(['product']),
        missingOutputs: expect.arrayContaining(['product_name']),
      }),
    });
    expect(pack.routeDecision.routeReason).toMatch(/product/i);
    expect(pack.routeDecision.exactObjectKey).toBeUndefined();
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('SHOP.ANALYTICS.order_items');
    const orderItems = pack.allowedSqlContext.relations.find((relation) => relation.relation === 'SHOP.ANALYTICS.order_items');
    const orderItemColumns = orderItems?.columns.map((column) => column.name) ?? [];
    expect(orderItemColumns.indexOf('product_type')).toBeGreaterThanOrEqual(0);
    expect(orderItemColumns.indexOf('product_price')).toBeGreaterThanOrEqual(0);
    expect(orderItemColumns.indexOf('product_type')).toBeLessThan(orderItemColumns.indexOf('category'));
    expect(orderItemColumns.indexOf('product_price')).toBeLessThan(orderItemColumns.indexOf('revenue'));
    expect(pack.retrievalDiagnostics.certifiedCandidateFits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'food_vs_drink_revenue',
          applicabilityKind: 'exact_answer',
          action: 'context_only',
          fit: expect.objectContaining({
            kind: 'context_only',
            missingOutputs: expect.arrayContaining(['product_name']),
            missingDimensions: expect.arrayContaining(['product']),
          }),
        }),
      ]),
    );
	  });

  it('prefers a complete beverage-scoped certified contract over a broader lexical spend match (AGT-009, AGT-010)', async () => {
    writeFileSync(
      join(projectRoot, 'blocks', 'customer_profile.dql'),
      `block "customer_profile" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Customer lifetime profile. One row per customer."
  tags = ["customer", "spend"]
  grain = "one row per customer"
  outputs = ["customer_name", "lifetime_spend"]
  dimensions = ["customer_name"]
  query = """
    SELECT player_name AS customer_name, SUM(points) AS lifetime_spend
    FROM fct_player_performance
    GROUP BY 1
  """
}`,
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'blocks', 'top_beverage_customers.dql'),
      `block "top_beverage_customers" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top customers ranked by beverage revenue. One row per customer."
  tags = ["beverage", "customer", "revenue", "ranking"]
  grain = "one row per customer in the beverage purchase ranking"
  outputs = ["customer_name", "beverage_revenue"]
  dimensions = ["customer_name"]
  query = """
    SELECT player_name AS customer_name, SUM(points) AS beverage_revenue
    FROM fct_player_performance
    WHERE is_beverage = true
    GROUP BY 1
    ORDER BY beverage_revenue DESC
    LIMIT 10
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Who are the top customers who spent on beverage category products?',
      limit: 40,
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'certified',
      exactObjectKey: 'dql:block:top_beverage_customers',
      blockFit: expect.objectContaining({
        kind: 'exact',
        unsupportedFilters: [],
      }),
    });
    expect(pack.retrievalDiagnostics.certifiedCandidateFits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'top_beverage_customers', action: 'certified_answer' }),
        expect.objectContaining({ name: 'customer_profile', action: 'rejected_for_fit' }),
      ]),
    );

    for (const question of [
      'Can you give each customer with lifetime spend info',
      'List every customer and their lifetime spend',
      'Show lifetime spend by customer',
      "What is each customer's lifetime spend?",
    ]) {
      const lifetimePack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      expect(lifetimePack.routeDecision, question).toMatchObject({
        route: 'certified',
        exactObjectKey: 'dql:block:customer_profile',
        blockFit: expect.objectContaining({ kind: 'exact' }),
      });
    }

    const scalarPack = await buildLocalContextPack(projectRoot, {
      question: 'What is total lifetime spend across all customers?',
      limit: 40,
    });
    expect(scalarPack.routeDecision).toMatchObject({
      route: 'generated_sql',
      blockFit: expect.objectContaining({
        kind: 'context_only',
        grainMismatch: expect.stringContaining('one aggregate value'),
      }),
      certifiedApplicability: expect.objectContaining({
        name: 'customer_profile',
        kind: 'context_only',
      }),
    });
    expect(scalarPack.routeDecision.exactObjectKey).toBeUndefined();
    expect(scalarPack.retrievalDiagnostics.certifiedCandidateFits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'customer_profile', action: 'context_only' }),
      ]),
    );
  });

  it('ingests dbt catalog.json columns as complete physical metadata', async () => {
    addJaffleOrderItemsModel(projectRoot);
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nodes: Record<string, { columns?: Record<string, unknown> }>;
    };
    delete manifest.nodes['model.nba_analysis.order_items']?.columns?.product_price;
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    writeFileSync(join(projectRoot, 'target', 'catalog.json'), JSON.stringify({
      nodes: {
        'model.nba_analysis.order_items': {
          columns: {
            order_item_id: { name: 'order_item_id', type: 'NUMBER', comment: 'Order item identifier.' },
            product_name: { name: 'product_name', type: 'TEXT', comment: 'Product display name.' },
            product_type: { name: 'product_type', type: 'TEXT', comment: 'Product category.' },
            product_price: { name: 'product_price', type: 'NUMBER', comment: 'Warehouse-resolved product revenue amount.' },
          },
        },
      },
    }), 'utf-8');
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show product revenue by product name',
      limit: 40,
    });

    const orderItems = pack.allowedSqlContext.relations.find((relation) => relation.relation === 'SHOP.ANALYTICS.order_items');
    expect(orderItems).toMatchObject({
      columnCompleteness: 'complete',
      columns: expect.arrayContaining([
        expect.objectContaining({ name: 'product_price', type: 'NUMBER' }),
      ]),
    });
  });

  it('preserves compiler-inferred output contracts for certified block fit', async () => {
    addJaffleOrderItemsModel(projectRoot);
    writeFileSync(
      join(projectRoot, 'blocks', 'product_revenue_inferred_contract.dql'),
      `block "Product Revenue Inferred Contract" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Revenue by product and category from order items."
  tags = ["revenue", "product", "category"]
  grain = "product"
  entities = ["Product"]
  dimensions = ["product", "category"]
  query = """
    SELECT product_name, product_type AS category, SUM(product_price) AS revenue
    FROM order_items
    GROUP BY 1, 2
    ORDER BY revenue DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const catalog = openMetadataCatalog(projectRoot);
    try {
      const object = catalog.getObject('dql:block:Product Revenue Inferred Contract');
      expect((object?.payload?.outputs as Array<{ name: string }> | undefined)?.map((output) => output.name)).toEqual(
        expect.arrayContaining(['product_name', 'category', 'revenue']),
      );
      expect((object?.payload?.outputContract as Array<{ name: string }> | undefined)?.map((output) => output.name)).toEqual(
        expect.arrayContaining(['product_name', 'category', 'revenue']),
      );
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show revenue by product with product name, category, and revenue',
      limit: 40,
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'certified',
      exactObjectKey: 'dql:block:Product Revenue Inferred Contract',
      trustLabelInfo: {
        id: 'certified',
      },
      blockFit: expect.objectContaining({
        kind: 'exact',
        confidence: 'high',
        missingOutputs: [],
        missingDimensions: [],
      }),
    });
  });

  it('promotes medium certified block fit only when confirmation accepts it', async () => {
    writeLegacyProductUsageBlock(projectRoot);
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
    let calls = 0;

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show usage by product',
      focusObjectKey: 'dql:block:Legacy Product Usage',
      runtimeSchemaSnapshot: productUsageRuntimeSchema(),
      confirmCertifiedFit: async ({ fit, block }) => {
        calls += 1;
        expect(block.name).toBe('Legacy Product Usage');
        expect(fit).toMatchObject({ kind: 'exact', confidence: 'medium' });
        return { allow: true, confidence: 'high', reason: 'legacy block declares product grain and usage metric' };
      },
    });

    expect(calls).toBe(1);
    expect(pack.routeDecision).toMatchObject({
      route: 'certified',
      exactObjectKey: 'dql:block:Legacy Product Usage',
      blockFit: expect.objectContaining({
        kind: 'exact',
        confidence: 'high',
        reasons: expect.arrayContaining([
          expect.stringContaining('fit confirmation accepted'),
        ]),
      }),
    });
  });

  it('demotes medium certified block fit when confirmation rejects it', async () => {
    writeLegacyProductUsageBlock(projectRoot);
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show usage by product',
      focusObjectKey: 'dql:block:Legacy Product Usage',
      runtimeSchemaSnapshot: productUsageRuntimeSchema(),
      confirmCertifiedFit: async () => ({ allow: false, confidence: 'high', reason: 'missing required output proof' }),
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      reviewStatus: 'draft_ready',
      certifiedApplicability: expect.objectContaining({ kind: 'context_only' }),
      blockFit: expect.objectContaining({
        kind: 'context_only',
        confidence: 'high',
        reasons: expect.arrayContaining([
          expect.stringContaining('fit confirmation rejected'),
        ]),
      }),
    });
    expect(pack.routeDecision.exactObjectKey).toBeUndefined();
  });

  it('keeps medium certified block fit review-required when confirmation fails', async () => {
    writeLegacyProductUsageBlock(projectRoot);
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show usage by product',
      focusObjectKey: 'dql:block:Legacy Product Usage',
      runtimeSchemaSnapshot: productUsageRuntimeSchema(),
      confirmCertifiedFit: async () => {
        throw new Error('provider unavailable');
      },
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      reviewStatus: 'draft_ready',
      blockFit: expect.objectContaining({
        kind: 'exact',
        confidence: 'medium',
        reasons: expect.arrayContaining([
          expect.stringContaining('fit confirmation unavailable'),
        ]),
      }),
    });
    expect(pack.routeDecision.exactObjectKey).toBeUndefined();
  });

  it('grain gate: does not demote certified routes for grain-free questions (no regression)', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Who were the top scorers?',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
    });
    // grain gate must be a no-op when the question carries no extractable grain.
    expect(plan.routeDecision.grainGate?.allow).not.toBe(false);
  });

  it('routes direct KPI value questions to certified blocks without requiring an example', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'What was revenue last week?',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      intent: 'exact_certified_lookup',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Revenue Total',
    });
  });

  it('pins source certified block and follow-up request context for drilldowns', async () => {
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Drill into Stephen Curry by game date',
      followUp: {
        kind: 'drilldown',
        sourceBlockName: 'Top 10 Goal Scorers',
        sourceQuestion: 'Run Top 10 Goal Scorers',
        filters: ['Stephen Curry'],
        dimensions: ['game date'],
      },
      limit: 20,
    });

    expect(pack.followUp).toMatchObject({
      kind: 'drilldown',
      sourceBlockName: 'Top 10 Goal Scorers',
    });
    expect(pack.objects.map((row) => row.objectKey)).toEqual(
      expect.arrayContaining([
        'dql:block:Top 10 Goal Scorers',
        expect.stringMatching(/^selected:followup:/),
      ]),
    );
    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'entity_drilldown',
      reviewStatus: 'draft_ready',
    });
  });

  it('preserves prior DQL artifact context for generic previous-result follow-ups', async () => {
    const sourceSql = 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10';
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'can you include product details with previous results and give final',
      followUp: {
        kind: 'generic',
        sourceQuestion: 'give me product and supply info',
        priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        priorResultRef: {
          id: 'turn_supply',
          question: 'give me product and supply info',
          columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
          rowCount: 65,
          sourceSql,
        },
        priorDqlArtifact: {
          kind: 'sql_block',
          name: 'product_supply_breakdown',
          source: `block "product_supply_breakdown" {
  type = "custom"
  query = """${sourceSql}"""
}`,
          orderBy: [{ name: 'supply_cost', direction: 'desc' }],
          limit: 10,
        },
      },
      limit: 20,
    });

    expect(pack.followUp).toMatchObject({
      kind: 'generic',
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
    });
    const followUpObject = pack.objects.find((object) => object.objectKey.startsWith('selected:followup:'));
    expect(followUpObject).toBeDefined();
    expect(followUpObject?.description).toContain('product_supply_breakdown');
    expect(followUpObject?.description).toContain('supply_cost desc');
    expect(followUpObject?.description).toContain('limit 10');
    expect(followUpObject?.payload).toMatchObject({
      priorResultRef: {
        id: 'turn_supply',
        rowCount: 65,
        sourceSql,
      },
      priorDqlArtifact: {
        name: 'product_supply_breakdown',
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
    });
  });

  it('seeds prior context-pack objects for refinements without short-circuiting retrieval', async () => {
    const priorPack = await buildLocalContextPack(projectRoot, {
      question: 'Who scored the least points?',
      limit: 20,
    });

    const refinedPack = await buildLocalContextPack(projectRoot, {
      question: 'same result but only 2024',
      priorContextPackId: priorPack.id,
      conversationTopicRelation: 'refinement',
      limit: 20,
    });

    expect(refinedPack.retrievalDiagnostics.strategy).toBe('sqlite_fts');
    expect(refinedPack.objects.map((row) => row.objectKey)).toEqual(
      expect.arrayContaining([
        'dql:block:Top 10 Goal Scorers',
        'dbt:model:fct_player_performance',
      ]),
    );
  });

  it('uses certified blocks as context for entity profile questions and generates SQL from metadata', async () => {
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Research Kevin Durant profile and complete stats',
      limit: 20,
    });

    expect(pack.questionPlan).toMatchObject({
      mode: 'entity_profile',
      routeIntent: 'entity_drilldown',
    });
    expect(pack.questionPlan.entities.map((entity) => entity.text)).toContain('Kevin Durant');
    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'entity_drilldown',
      reviewStatus: 'draft_ready',
      certifiedApplicability: expect.objectContaining({
        kind: 'context_only',
      }),
    });
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining(['NBA_DB.ANALYTICS.int_player_stats']),
    );
    const sourceShapeRelation = pack.allowedSqlContext.relations.find((relation) =>
      relation.relation.endsWith('int_player_stats'),
    );
    expect(sourceShapeRelation?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['dataset_name', 'row_count']),
    );
  });

  it('keeps SQL relation context bounded and ranked in noisy dbt projects', async () => {
    addNoisyDbtModels(projectRoot, 80);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 120,
    });

    expect(pack.allowedSqlContext.relations.length).toBeLessThanOrEqual(40);
    expect(pack.allowedSqlContext.relations[0]?.relation).toContain('fct_player_performance');
    expect(pack.retrievalDiagnostics.selectedRelations?.[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
    });
    expect(pack.retrievalDiagnostics.selectedRelations?.[0]?.reason).toMatch(/metric terms matched|dimension terms matched|relation shape/);
  });

  it('adds schema-shape dbt candidates when entity values do not appear in metadata text', async () => {
    addNoisyDbtModels(projectRoot, 120);
    addGenericAthleteBoxScoreModel(projectRoot);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can you research Kevin Durant profile and provide complete stats',
      limit: 40,
    });

    expect(pack.questionPlan).toMatchObject({
      mode: 'entity_profile',
      routeIntent: 'entity_drilldown',
    });
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('NBA_DB.ANALYTICS.athlete_box_scores');
    expect(pack.retrievalDiagnostics.schemaShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dbt:model:athlete_box_scores',
          relation: 'NBA_DB.ANALYTICS.athlete_box_scores',
          reason: expect.stringContaining('entity identifiers: athlete_name'),
          columns: expect.arrayContaining(['athlete_name', 'game_date', 'pts', 'ast', 'reb']),
        }),
      ]),
    );
    expect(pack.retrievalDiagnostics.selectedRelations?.map((relation) => relation.relation)).toContain('NBA_DB.ANALYTICS.athlete_box_scores');
  });

  it('finds schema-shape dbt candidates beyond the first large-repo scan window', async () => {
    addNoisyDbtModels(projectRoot, 1800);
    addGenericAthleteBoxScoreModel(projectRoot, 'zz_athlete_box_scores');

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can you research Kevin Durant profile and provide complete stats',
      limit: 40,
    });

    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('NBA_DB.ANALYTICS.zz_athlete_box_scores');
    expect(pack.retrievalDiagnostics.schemaShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dbt:model:zz_athlete_box_scores',
          relation: 'NBA_DB.ANALYTICS.zz_athlete_box_scores',
          reason: expect.stringContaining('entity identifiers: athlete_name'),
          columns: expect.arrayContaining(['athlete_name', 'game_date', 'pts', 'ast', 'reb']),
        }),
      ]),
    );
  });

  it('indexes 4,000 dbt models and 10,000 MetricFlow metrics with bounded retrieval (CTX-005, PERF-001, PERF-002, E2E-006)', async () => {
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'nba_ops',
      dbt: { projectDir: '.' },
    }), 'utf-8');
    addNoisyDbtModels(projectRoot, 3998);
    addLargeSemanticManifest(projectRoot, 10_000);

    const semanticLayer = resolveSemanticLayerWithDiagnostics({
      provider: 'dbt',
      projectPath: '.',
    }, projectRoot).layer;
    expect(semanticLayer?.listMetrics().length).toBeGreaterThanOrEqual(10_000);

    const refresh = await ensureMetadataCatalogFresh(projectRoot, { force: true, semanticLayer });
    expect(refresh.objectCount).toBeGreaterThan(10_000);

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.objectCount()).toBeGreaterThan(10_000);
      expect(catalog.getObject('dbt:model:noisy_3997')).toMatchObject({
        objectType: 'dbt_model',
      });
      expect(catalog.getObject('semantic:metric:enterprise_metrics.enterprise_metric_9999')).toMatchObject({
        objectType: 'semantic_metric',
      });
      expect(catalog.sourceFingerprints().length).toBeGreaterThan(10);
      expect(catalog.domainShards().some((shard) => shard.semanticMetricCount >= 10_000)).toBe(true);
    } finally {
      catalog.close();
    }

    const start = Date.now();
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show enterprise metric 9999 by enterprise segment',
      objectTypes: ['semantic_metric', 'semantic_model', 'dbt_model'],
      limit: 80,
    });
    const elapsed = Date.now() - start;

    expect(pack.objects.length).toBeLessThanOrEqual(80);
    expect(pack.objects.map((object) => object.objectKey)).toContain('semantic:metric:enterprise_metrics.enterprise_metric_9999');
    expect(pack.retrievalDiagnostics.topRejected.length).toBeGreaterThan(0);
    // Keep the product target strict locally. The full monorepo CI runs this
    // 4k-model/10k-metric fixture alongside other CPU-heavy suites, so leave
    // bounded scheduler headroom without weakening retrieval-size assertions.
    expect(elapsed).toBeLessThan(process.env.CI ? 10_000 : 4_000);
  }, 60_000);

  it('exposes selected join paths between dbt relations with shared keys', async () => {
    addPlayerDimensionModel(projectRoot);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show player points by position',
      limit: 40,
    });

    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining([
        'NBA_DB.ANALYTICS.fct_player_performance',
        'NBA_DB.ANALYTICS.dim_players',
      ]),
    );
    expect(pack.retrievalDiagnostics.selectedJoinPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leftRelation: 'NBA_DB.ANALYTICS.fct_player_performance',
          leftColumn: 'player_id',
          rightRelation: 'NBA_DB.ANALYTICS.dim_players',
          rightColumn: 'player_id',
          reason: expect.stringContaining('dbt lineage'),
          source: 'dbt_lineage',
        }),
      ]),
    );
  });

  it('retains parent dbt model columns when retrieval starts from column hits', async () => {
    addNoisyDbtModels(projectRoot, 80);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show player points by season',
      objectTypes: ['dbt_column'],
      limit: 2,
    });

    const relation = pack.allowedSqlContext.relations.find((candidate) =>
      candidate.relation.endsWith('fct_player_performance'),
    );

    expect(relation?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['player_name', 'season', 'points', 'total_points']),
    );
    expect(pack.retrievalDiagnostics.selectedRelations?.[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
      columns: expect.arrayContaining(['player_name', 'season', 'points', 'total_points']),
    });
  });

  it('balances relation and column budgets so column floods do not evict table context', async () => {
    addColumnFloodModels(projectRoot, 16, 12);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show supply metric by supply stage',
      objectTypes: ['dbt_model', 'dbt_column'],
      limit: 12,
    });

    const selectedSupplyModels = pack.objects.filter((object) =>
      object.objectType === 'dbt_model' && object.name.startsWith('supply_wide_'),
    );
    expect(selectedSupplyModels.length).toBeGreaterThanOrEqual(6);
    expect(pack.retrievalDiagnostics.topRejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: 'dbt_column',
          reason: expect.stringContaining('Outside balanced context window'),
        }),
      ]),
    );
  });

  it('caches schema-shape scans for repeated generated questions on the same catalog fingerprint', async () => {
    addNoisyDbtModels(projectRoot, 80);
    addGenericAthleteBoxScoreModel(projectRoot, 'cache_probe_box_scores');
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const scanSpy = vi.spyOn(MetadataCatalog.prototype, 'scanObjects');
    try {
      await buildLocalContextPack(projectRoot, {
        question: 'Can you research Kevin Durant profile and provide complete stats for cache probe',
        limit: 40,
      });
      const scansAfterFirstPack = scanSpy.mock.calls.length;
      expect(scansAfterFirstPack).toBeGreaterThan(0);

      await buildLocalContextPack(projectRoot, {
        question: 'Can you research Kevin Durant profile and provide complete stats for cache probe',
        limit: 40,
      });
      expect(scanSpy.mock.calls.length).toBe(scansAfterFirstPack);
    } finally {
      scanSpy.mockRestore();
    }
  });

  it('does not use generated draft blocks as allowed SQL context', async () => {
    mkdirSync(join(projectRoot, 'blocks', '_drafts'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'blocks', '_drafts', 'draft_fraud_pipeline.dql'),
      `block "Draft Fraud Pipeline" {
  domain = "risk"
  type = "custom"
  status = "draft"
  description = "AI-generated draft that has not been certified."
  asked_times = 1
  query = """
    SELECT account_id, risk_score
    FROM draft_only_table
  """
}`,
      'utf-8',
    );

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'review draft fraud pipeline',
      limit: 20,
    });

    expect(pack.objects.map((row) => row.objectKey)).toContain('dql:block:Draft Fraud Pipeline');
    expect(pack.allowedSqlContext.sourceBlockSql.map((source) => source.objectKey)).not.toContain('dql:block:Draft Fraud Pipeline');
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).not.toContain('draft_only_table');
  });

  it('asks for missing baseline context instead of proxying change analysis to an unrelated table', async () => {
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'What changed in Player Stats Data Availability?',
      focusObjectKey: 'dql:block:Player Stats Data Availability',
      limit: 20,
    });

    expect(pack.routeDecision.route).toBe('clarify');
    expect(pack.routeDecision.intent).toBe('diagnose_change');
    expect(pack.missingContext).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'baseline',
          severity: 'blocking',
        }),
      ]),
    );
  });

  it('uses runtime schema snapshots as allowed SQL context without persisting plaintext samples (SEC-003)', async () => {
    recordRuntimeSchemaSnapshot(projectRoot, {
      source: 'test runtime',
      tables: [{
        relation: 'NBA_DB.RAW.player_box_scores',
        schema: 'RAW',
        name: 'player_box_scores',
        columns: [
          { name: 'player_name', type: 'VARCHAR', sampleValues: ['Stephen Curry'] },
          { name: 'points', type: 'NUMBER' },
          { name: 'game_date', type: 'DATE' },
        ],
      }],
    });
    const catalog = openMetadataCatalog(projectRoot);
    try {
      const matches = catalog.searchRuntimeValues(['Stephen Curry']);
      expect(matches).toEqual([]);
      expect(catalog.state('runtime_value_index_count')).toBe('0');
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show Stephen Curry points by game date',
      limit: 20,
    });

    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('NBA_DB.RAW.player_box_scores');
    expect(pack.evidenceRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'runtime_schema',
          name: 'player_box_scores',
        }),
      ]),
    );
    expect(pack.evidenceRoles.some((role) => role.role === 'value_match')).toBe(false);
    const relation = pack.allowedSqlContext.relations.find((item) => item.relation === 'NBA_DB.RAW.player_box_scores');
    expect(relation?.columns.find((column) => column.name === 'player_name')?.sampleValues ?? []).toEqual([]);
  });

  it('retrieves a relevant table from a 3,000-table runtime schema without hydrating the full database catalog (CTX-005, PERF-002, E2E-006)', async () => {
    const prepared = await ensureMetadataCatalogFresh(projectRoot, { force: true });
    const tables = Array.from({ length: 3_000 }, (_, index) => ({
      relation: `ENTERPRISE.RAW.operational_table_${index}`,
      schema: 'RAW',
      name: `operational_table_${index}`,
      columns: [
        { name: 'record_id', type: 'VARCHAR' },
        { name: 'created_at', type: 'TIMESTAMP' },
        { name: `attribute_${index}`, type: 'VARCHAR' },
      ],
    }));
    tables[2_999] = {
      relation: 'ENTERPRISE.COMMERCE.beverage_customer_spend_fact',
      schema: 'COMMERCE',
      name: 'beverage_customer_spend_fact',
      columns: [
        { name: 'customer_id', type: 'VARCHAR' },
        { name: 'customer_name', type: 'VARCHAR' },
        { name: 'product_category', type: 'VARCHAR' },
        { name: 'beverage_revenue', type: 'DECIMAL' },
      ],
    };
    recordRuntimeSchemaSnapshot(projectRoot, {
      source: 'enterprise warehouse fixture',
      tables,
    });

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.state('runtime_schema_table_count')).toBe('3000');
      expect(catalog.searchRuntimeSchemaObjects('top customers beverage category spend', 20).map((row) => row.objectKey)).toContain(
        'runtime:table:ENTERPRISE.COMMERCE.beverage_customer_spend_fact',
      );
    } finally {
      catalog.close();
    }

    const start = Date.now();
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Who are the top customers who spent on beverage category products?',
      preparedMetadataFingerprint: prepared.fingerprint,
      limit: 40,
    });
    const elapsed = Date.now() - start;

    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain(
      'ENTERPRISE.COMMERCE.beverage_customer_spend_fact',
    );
    expect(pack.objects.filter((object) => object.objectType === 'runtime_table').length).toBeLessThanOrEqual(40);
    expect(elapsed).toBeLessThan(process.env.CI ? 5_000 : 2_000);
  }, 30_000);

  it('folds an approved, scoped correction hint into a matching Tier-2 context pack (cited)', async () => {
    // No hints yet → backward compatible (empty applied set).
    const before = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 40,
    });
    expect(before.appliedHints).toEqual([]);

    // Record + approve a correction scoped to the nba domain.
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'Show NBA player points by season',
      scope: { domain: 'nba' },
      wrongAnswer: 'SELECT player_name, points FROM fct_player_performance',
      correction: 'Always SUM points and GROUP BY player_name, season for season totals.',
      author: 'analyst@nba.test',
    });

    // Candidate must NOT be applied (approved-only).
    const candidatePack = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 40,
    });
    expect(candidatePack.appliedHints).toEqual([]);

    reviewHint(projectRoot, { hintId: hint.id, decision: 'approved', reviewer: 'lead@nba.test' });

    // In-scope Tier-2 question → hint is applied and cited.
    const matched = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 40,
    });
    expect(matched.appliedHints.map((h) => h.hintId)).toContain(hint.id);
    expect(matched.appliedHints[0].guidance).toContain('SUM points');
    expect(matched.appliedHints[0].scopeReason).toContain('domain=nba');
  });
});

describe('block fingerprints', () => {
  it('separates exact SQL copies from parameterized business-shape copies', () => {
    const left = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE season = 2016
      GROUP BY 1
      ORDER BY total_points DESC
      LIMIT 5
    `);
    const right = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE season = 2017
      GROUP BY 1
      ORDER BY total_points DESC
      LIMIT 10
    `);

    expect(left.exact).not.toBe(right.exact);
    expect(left.parameterized).toBe(right.parameterized);
  });

  it('treats different selected-set literal counts as the same parameterized SQL shape', () => {
    const oneTeam = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE team_abbreviation IN ('LAL')
      GROUP BY 1
    `);
    const twoTeams = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE team_abbreviation IN ('LAL', 'BOS')
      GROUP BY 1
    `);

    expect(oneTeam.exact).not.toBe(twoTeams.exact);
    expect(oneTeam.parameterized).toBe(twoTeams.parameterized);
  });

  it('includes declared dimensions in business-shape fingerprints', () => {
    const bySegment = buildBlockBusinessFingerprint({
      domain: 'revenue',
      pattern: 'ranking',
      grain: 'customer_id',
      outputs: ['customer_id', 'total_revenue'],
      dimensions: ['segment'],
      sources: ['marts.orders'],
    });
    const byRegion = buildBlockBusinessFingerprint({
      domain: 'revenue',
      pattern: 'ranking',
      grain: 'customer_id',
      outputs: ['customer_id', 'total_revenue'],
      dimensions: ['region'],
      sources: ['marts.orders'],
    });

    expect(bySegment.hash).not.toBe(byRegion.hash);
    expect(bySegment.tokens).toContain('dimension:segment');
  });
});

function mkdtempProject(): string {
  return mkdtempSync(join(tmpdir(), 'dql-metadata-catalog-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addNoisyDbtModels(root: string, count: number): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  for (let index = 0; index < count; index += 1) {
    manifest.nodes[`model.nba_analysis.noisy_${index}`] = {
      resource_type: 'model',
      name: `noisy_${index}`,
      alias: `noisy_${index}`,
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: `Unrelated noisy model ${index} for large repo retrieval testing.`,
      depends_on: { nodes: [] },
      tags: ['noise'],
      original_file_path: `models/noisy/noisy_${index}.sql`,
      config: { materialized: 'table' },
      columns: {
        id: { name: 'id', data_type: 'number' },
        created_at: { name: 'created_at', data_type: 'timestamp' },
      },
    };
  }
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addLargeSemanticManifest(root: string, metricCount: number): void {
  const measures = Array.from({ length: metricCount }, (_, index) => ({
    name: `enterprise_measure_${index}`,
    expr: `metric_value_${index}`,
    agg: 'sum',
    description: `Enterprise measure ${index}.`,
  }));
  const metrics = Object.fromEntries(Array.from({ length: metricCount }, (_, index) => [
    `metric.nba_analysis.enterprise_metric_${index}`,
    {
      name: `enterprise_metric_${index}`,
      label: `Enterprise Metric ${index}`,
      description: `Enterprise scale semantic metric ${index}.`,
      type: 'simple',
      type_params: { measure: `enterprise_measure_${index}` },
      tags: ['enterprise', 'scale'],
    },
  ]));
  writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify({
    semantic_models: {
      'semantic_model.nba_analysis.enterprise_metrics': {
        name: 'enterprise_metrics',
        model: "ref('fct_enterprise_metric_0')",
        defaults: { agg_time_dimension: 'metric_date' },
        entities: [{ name: 'enterprise_account', type: 'primary', expr: 'account_id' }],
        dimensions: [
          { name: 'enterprise_segment', type: 'categorical', expr: 'segment' },
          { name: 'metric_date', type: 'time', type_params: { time_granularity: 'day' }, expr: 'metric_date' },
        ],
        measures,
      },
    },
    metrics,
    saved_queries: {},
  }), 'utf-8');
}

function writeQualifiedSemanticIdentityFixture(root: string): void {
  writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify({
    semantic_models: {
      'semantic_model.scale.consumption_model': {
        unique_id: 'semantic_model.scale.consumption_model',
        package_name: 'scale',
        name: 'consumption_model',
        model: "ref('fct_player_performance')",
        meta: { domain: 'consumption' },
        entities: [{ name: 'account', type: 'primary', expr: 'account_id' }],
        dimensions: [{ name: 'month', type: 'time', type_params: { time_granularity: 'month' } }],
        measures: [{ name: 'rollover_balance_measure', agg: 'sum', expr: 'points' }],
      },
      'semantic_model.scale.billing_model': {
        unique_id: 'semantic_model.scale.billing_model',
        package_name: 'scale',
        name: 'billing_model',
        model: "ref('fct_player_performance')",
        meta: { domain: 'billing' },
        entities: [{ name: 'billing_account', type: 'primary', expr: 'account_id' }],
        dimensions: [{ name: 'ledger_month', type: 'time', type_params: { time_granularity: 'month' } }],
        measures: [{ name: 'billing_rollover_measure', agg: 'sum', expr: 'points' }],
      },
    },
    metrics: {
      'metric.scale.rollover_balance_amount': {
        unique_id: 'metric.scale.rollover_balance_amount',
        package_name: 'scale',
        name: 'rollover_balance_amount',
        label: 'Rollover Balance Amount',
        description: 'Remaining eligible balance carried into the next billing month.',
        type: 'simple',
        type_params: { measure: 'rollover_balance_measure' },
        meta: { domain: 'consumption', concept_id: 'semantic:consumption:rollover_balance_amount' },
      },
      'metric.scale.billing_rollover_balance_amount': {
        unique_id: 'metric.scale.billing_rollover_balance_amount',
        package_name: 'scale',
        name: 'billing_rollover_balance_amount',
        label: 'Rollover Balance Amount',
        description: 'Posted general-ledger liability after billing close.',
        type: 'simple',
        type_params: { measure: 'billing_rollover_measure' },
        meta: { domain: 'billing', concept_id: 'semantic:billing:rollover_balance_amount' },
      },
    },
    saved_queries: {},
  }), 'utf-8');
}

function addGenericAthleteBoxScoreModel(root: string, modelName = 'athlete_box_scores'): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  manifest.nodes[`model.nba_analysis.${modelName}`] = {
    resource_type: 'model',
    name: modelName,
    alias: modelName,
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Box score rows at game grain.',
    depends_on: { nodes: [] },
    tags: ['analytics'],
    original_file_path: `models/marts/${modelName}.sql`,
    config: { materialized: 'table' },
    columns: {
      athlete_name: {
        name: 'athlete_name',
        data_type: 'text',
        description: 'Name of the athlete.',
      },
      game_id: {
        name: 'game_id',
        data_type: 'text',
        description: 'Game identifier.',
      },
      game_date: {
        name: 'game_date',
        data_type: 'date',
        description: 'Date of the game.',
      },
      pts: {
        name: 'pts',
        data_type: 'number',
        description: 'Points recorded.',
      },
      ast: {
        name: 'ast',
        data_type: 'number',
        description: 'Assists recorded.',
      },
      reb: {
        name: 'reb',
        data_type: 'number',
        description: 'Rebounds recorded.',
      },
    },
  };
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addJaffleOrderItemsModel(root: string): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  manifest.nodes['model.nba_analysis.order_items'] = {
    resource_type: 'model',
    name: 'order_items',
    alias: 'order_items',
    database: 'SHOP',
    schema: 'ANALYTICS',
    description: 'Order item rows with product name, product category/type, and product price.',
    depends_on: { nodes: [] },
    tags: ['orders', 'products', 'revenue'],
    original_file_path: 'models/marts/order_items.sql',
    config: { materialized: 'table' },
    columns: {
      order_item_id: {
        name: 'order_item_id',
        data_type: 'number',
        description: 'Order item identifier.',
      },
      product_name: {
        name: 'product_name',
        data_type: 'text',
        description: 'Product display name.',
      },
      product_type: {
        name: 'product_type',
        data_type: 'text',
        description: 'Product category such as food or drink.',
      },
      product_price: {
        name: 'product_price',
        data_type: 'number',
        description: 'Product revenue amount.',
      },
    },
  };
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addGrainedTeamScoringModel(root: string): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  manifest.nodes['model.nba_analysis.fct_team_scoring'] = {
    resource_type: 'model',
    name: 'fct_team_scoring',
    alias: 'fct_team_scoring',
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Team scoring fact table with total points at team grain.',
    depends_on: { nodes: [] },
    tags: ['nba', 'team', 'points'],
    original_file_path: 'models/marts/fct_team_scoring.sql',
    config: { materialized: 'table' },
    columns: {
      team_name: { name: 'team_name', data_type: 'text', description: 'Team name.' },
      season: { name: 'season', data_type: 'number', description: 'NBA season year.' },
      total_points: { name: 'total_points', data_type: 'number', description: 'Total team points.' },
    },
  };
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addPlayerDimensionModel(root: string): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  const fact = manifest.nodes['model.nba_analysis.fct_player_performance'];
  if (fact) {
    fact.depends_on = { nodes: ['model.nba_analysis.dim_players'] };
    fact.columns = {
      ...((fact.columns as Record<string, unknown> | undefined) ?? {}),
      player_id: {
        name: 'player_id',
        data_type: 'text',
        description: 'Player identifier for joining to player attributes.',
      },
    };
  }
  manifest.nodes['model.nba_analysis.dim_players'] = {
    resource_type: 'model',
    name: 'dim_players',
    alias: 'dim_players',
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Player dimension table with profile attributes.',
    depends_on: { nodes: [] },
    tags: ['nba', 'player'],
    original_file_path: 'models/marts/dim_players.sql',
    config: { materialized: 'table' },
    columns: {
      player_id: {
        name: 'player_id',
        data_type: 'text',
        description: 'Player identifier.',
      },
      position: {
        name: 'position',
        data_type: 'text',
        description: 'Primary court position.',
      },
    },
  };
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addColumnFloodModels(root: string, modelCount: number, columnCount: number): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  for (let modelIndex = 0; modelIndex < modelCount; modelIndex += 1) {
    const columns: Record<string, Record<string, string>> = {};
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const name = `supply_metric_${modelIndex}_${columnIndex}`;
      columns[name] = {
        name,
        data_type: 'number',
        description: `Supply metric ${columnIndex} for stage analysis.`,
      };
    }
    columns.supply_stage = {
      name: 'supply_stage',
      data_type: 'text',
      description: 'Supply stage dimension.',
    };
    manifest.nodes[`model.nba_analysis.supply_wide_${modelIndex}`] = {
      resource_type: 'model',
      name: `supply_wide_${modelIndex}`,
      alias: `supply_wide_${modelIndex}`,
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: `Supply metric wide table ${modelIndex}.`,
      depends_on: { nodes: [] },
      tags: ['supply', 'metric'],
      original_file_path: `models/supply/supply_wide_${modelIndex}.sql`,
      config: { materialized: 'table' },
      columns,
    };
  }
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function seedDqlProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'nba_ops' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'top_10_goal_scorers.dql'),
    `block "Top 10 Goal Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top 10 NBA players by total points scored."
  tags = ["nba", "player", "points", "scoring"]
  llmContext = "Use for top scorers only. Do not use as a least-points or bottom-ranking answer."
  examples = [{ question = "Who were the top scorers?" }]
  query = """
    SELECT player_name, season, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1, 2
    ORDER BY total_points DESC
    LIMIT 10
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'blocks', 'player_stats_data_availability.dql'),
    `block "Player Stats Data Availability" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Current availability summary for player stats records."
  tags = ["nba", "player", "availability"]
  llmContext = "Use for current data availability only. Do not use for change analysis unless a baseline period is supplied."
  query = """
    SELECT dataset_name, COUNT(*) AS row_count
    FROM int_player_stats
    GROUP BY 1
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'blocks', 'revenue_total.dql'),
    `block "Revenue Total" {
  domain = "revenue"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Certified total revenue for the last completed week."
  tags = ["revenue", "kpi", "weekly"]
  query = """
    SELECT 42500 AS revenue_total
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'nba_analysis' },
      nodes: {
        'model.nba_analysis.fct_player_performance': {
          resource_type: 'model',
          name: 'fct_player_performance',
          alias: 'fct_player_performance',
          database: 'NBA_DB',
          schema: 'ANALYTICS',
          description: 'Player performance fact table with scoring, assists, and season grain.',
          depends_on: { nodes: [] },
          tags: ['nba', 'player'],
          original_file_path: 'models/marts/fct_player_performance.sql',
          config: { materialized: 'table' },
          columns: {
            player_name: {
              name: 'player_name',
              data_type: 'text',
              description: 'Player full name.',
            },
            season: {
              name: 'season',
              data_type: 'number',
              description: 'NBA season year.',
            },
            points: {
              name: 'points',
              data_type: 'number',
              description: 'Points scored in a game.',
            },
            total_points: {
              name: 'total_points',
              data_type: 'number',
              description: 'Aggregated points for a player and season.',
            },
          },
        },
        'model.nba_analysis.int_player_stats': {
          resource_type: 'model',
          name: 'int_player_stats',
          alias: 'int_player_stats',
          database: 'NBA_DB',
          schema: 'ANALYTICS',
          description: 'Current player stats intermediate table without historical availability snapshots.',
          depends_on: { nodes: [] },
          tags: ['nba', 'player'],
          original_file_path: 'models/intermediate/int_player_stats.sql',
          config: { materialized: 'table' },
          columns: {
            dataset_name: {
              name: 'dataset_name',
              data_type: 'text',
              description: 'Source dataset name.',
            },
            player_id: {
              name: 'player_id',
              data_type: 'text',
              description: 'Player identifier.',
            },
            row_count: {
              name: 'row_count',
              data_type: 'number',
              description: 'Current row count.',
            },
          },
        },
      },
      sources: {},
    }),
    'utf-8',
  );
}

function writeLegacyProductUsageBlock(root: string): void {
  writeFileSync(
    join(root, 'blocks', 'legacy_product_usage.dql'),
    `block "Legacy Product Usage" {
  domain = "product"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Legacy certified usage metric by product."
  tags = ["usage", "product", "metric"]
  grain = "product"
  entities = ["Product"]
  dimensions = ["product"]
}`,
    'utf-8',
  );
}

function productUsageRuntimeSchema() {
  return {
    source: 'test runtime schema',
    tables: [{
      relation: 'APP.ANALYTICS.product_usage',
      schema: 'ANALYTICS',
      name: 'product_usage',
      source: 'runtime',
      columns: [
        { name: 'product_name', type: 'text' },
        { name: 'usage', type: 'number' },
      ],
    }],
  };
}

describe('governed-name reclassification (BCM vs bcm fix)', () => {
  const index = buildGovernedTermIndex([
    { objectType: 'semantic_metric', name: 'previous_day_bcm', payload: { label: 'Previous Day BCM' } },
    { objectType: 'semantic_dimension', name: 'usage_source', payload: { label: 'Usage Source' } },
  ] as never);

  it('reclassifies a Title-Case metric label fragment from filter to metric term', () => {
    const plan = buildAnalysisQuestionPlan('what is the Previous Day BCM');
    expect(plan.requestedShape.filters).toContain('Previous Day');
    const notes = reclassifyGovernedNameMentions(plan, index, 'what is the Previous Day BCM');
    expect(notes).toHaveLength(1);
    expect(plan.requestedShape.filters).not.toContain('Previous Day');
    expect(plan.metricTerms).toContain('previous day bcm');
  });

  it('leaves genuine member values (Capital One) as filters', () => {
    const plan = buildAnalysisQuestionPlan('what is the total BCM for Capital One');
    const before = [...plan.requestedShape.filters];
    reclassifyGovernedNameMentions(plan, index, 'what is the total BCM for Capital One');
    // "Capital One" matches no governed name — it must survive as a filter.
    expect(plan.requestedShape.filters.filter((f) => /capital/i.test(f))).toEqual(before.filter((f) => /capital/i.test(f)));
  });

  it('requires the full governed name to appear in the question before reclassifying', () => {
    const plan = buildAnalysisQuestionPlan('sales for Previous Day period');
    const notes = reclassifyGovernedNameMentions(plan, index, 'sales for Previous Day period');
    // "bcm" is absent from the question, so "Previous Day" stays whatever it was.
    expect(notes).toEqual([]);
  });
});
