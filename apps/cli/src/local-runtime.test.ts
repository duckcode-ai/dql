import { describe, expect, it, vi } from 'vitest';
import {
  applyRequestedTopNToExploratorySql,
  parseAiModelingOperations,
  buildAgentValueProbeSql,
  agentRunDeadlineMs,
  exploratoryProbeContradiction,
  probeableExploratoryJoins,
  agentAnswerHasExecutionFailure,
  analyticalFreshnessObservedThrough,
  analyticalFailedRunFromAgentRun,
  boundedAgentMeaningSignal,
  applyDashboardFiltersToBlockExecution,
  dashboardSemanticFiltersForTile,
  collectDashboardFilterOptions,
  buildAgentPreviewSql,
  buildAppCopilotResearchAgentRequest,
  buildRowBoundedSql,
  extractBlockStudioSql,
  maskDqlStringContents,
  slimAgentRunForTransport,
  parseBlockStudioArrayField,
  parseBlockStudioStringField,
  buildExploratoryJoinProbeSql,
  repairExploratorySqlBeforeExecution,
  buildAgentSchemaContext,
  reconcileAgentSchemaContextWithLive,
  buildRuntimeSchemaSearchSql,
  buildNamedRelationProbeSql,
  prepareAnalyticalExecutionSql,
  ExecutionService,
  repairableSqlFromAgentRun,
  repairableDqlArtifactFromAgentRun,
  repairPresentationContextFromAgentRun,
  dqlRepairParameterContract,
  notebookCellRepairSql,
  notebookDqlSourceAllowsBackgroundRepair,
  replaceNotebookDqlQueryForRepair,
  applyNotebookRepairRewrites,
  restoreNotebookDqlParameterInterpolations,
  notebookFailureAllowsBackgroundRepair,
  resolveBareInternalRelationIds,
  sqlMayContainJoin,
  analyticalFailureAllowsDeterministicRetry,
  analyticalFailureAllowsAppRepair,
  analyticalRepairCapabilityForAgentRun,
  targetGenerationFingerprint,
  buildDbtStatus,
  buildDbtDatabaseSchemaTree,
  schemaColumnsFromDescribeRows,
  splitQualifiedRelationIdentifier,
  buildDbtParseArgs,
  buildProposeReadiness,
  buildProposeCandidatePreview,
  buildSemanticCompostingChangeset,
  generateProposeDrafts,
  generateSemanticCompostingDrafts,
  buildSemanticLayerDiagnostics,
  buildSemanticTableMapping,
  buildConversationContextRecap,
  buildPriorAnswerExplanation,
  resolveSemanticTableMapping,
  compileBlockStudioManifest,
  conversationTurnInputFromRun,
  createBlockArtifacts,
  createDqlArtifactGenerationSessionForProject,
  createDqlGenerationSessionForProject,
  createSemanticBuilderBlock,
  deleteBlockStudioArtifacts,
  discoverDbtProfileConnections,
  resolveDbtProfileRuntimeConnection,
  evaluateBlockInvariants,
  extractAgentValueSearchTerms,
  extractBlockInvariants,
  formatLocalQueryRuntimeError,
  getConnectorInstallStatuses,
  assertConnectionNodeCompatibility,
  ensureConnectorInstalledForStartup,
  loadProjectConfig,
  isAgentValueProbeColumn,
  markBlockStudioSourceReusable,
  normalizeProjectConnection,
  normalizeAgentRunDomain,
  resolveUiDomainContext,
  ownerlessReviewDqlArtifactFromAnswer,
  openBlockStudioDocument,
  parseBlockSourceMetadata,
  parseAgentRunRequestBody,
  prepareLocalExecution,
  dashboardRuntimeVariables,
  resolveDefaultLLMProvider,
  resolveGovernedAnswerRunner,
  resolveAgentRuntimeValueGrounding,
  resolveDbtMacrosForExecution,
  resolveProjectRelativeSqlPaths,
  runtimeSchemaSnapshotForAgentConnection,
  runtimeSnapshotStale,
  compactBlockStudioRuntimeFailure,
  reconcileBlockStudioRuntimeValidation,
  saveBlockStudioArtifacts,
  saveBlockStudioDraftArtifacts,
  sanitizeAgentBlockDraftSource,
  setBlockStudioStatus,
  semanticAnswerHasPassedAggregationProof,
  shouldAugmentAgentRuntimeSchema,
  shouldSynthesizeAgentRunAnswer,
  serializeJSON,
  staticResponseCacheControl,
  startLocalServer,
  validateBlockStudioSource,
  validateConnectionForTest,
} from './local-runtime.js';
import { Certifier, ENTERPRISE_RULES } from '@duckcodeailabs/dql-governance';
import {
  getActiveProvider,
  providerSettingsPath,
  saveProviderSettings,
} from './settings/provider-settings.js';
import { getRunner } from './llm/index.js';
import { afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createWarehouseTargetIdentity, loadSemanticLayerFromDir, SemanticLayer } from '@duckcodeailabs/dql-core';
import type { AggregationSafetyProofV1 } from '@duckcodeailabs/dql-core';
import {
  createAnalyticalFailure,
  defaultAgentRunSqlitePath,
  latestRuntimeSchemaSnapshotForProject,
  recordRuntimeSchemaSnapshot,
  SqliteAgentRunStore,
  assertProviderPayloadAllowed,
  prepareProviderContextForDispatch,
} from '@duckcodeailabs/dql-agent';
import type { DatabaseConnector, QueryExecutor, QueryResult } from '@duckcodeailabs/dql-connectors';
import { saveTestedSemanticRuntimeSettings } from './semantic-runtime-settings.js';
import { addAskResultToAppBuildDraft, createAppPackage, createStoredAppBuildDraft } from './apps-api.js';

const tempDirs: string[] = [];

describe('repair target generation identity (API-007)', () => {
  it('detects same-name connection drift without hashing secrets into the identity', () => {
    const base = targetGenerationFingerprint({
      driver: 'snowflake', account: 'acct', database: 'analytics', schema: 'public', warehouse: 'wh', role: 'reader', password: 'secret-a',
    }, 'reporting');
    expect(targetGenerationFingerprint({
      driver: 'snowflake', account: 'acct', database: 'analytics', schema: 'public', warehouse: 'wh', role: 'reader', password: 'secret-b',
    }, 'reporting')).toBe(base);
    expect(targetGenerationFingerprint({
      driver: 'snowflake', account: 'acct', database: 'analytics', schema: 'public', warehouse: 'wh-2', role: 'reader', password: 'secret-a',
    }, 'reporting')).not.toBe(base);
    expect(base).not.toContain('secret-a');
  });

  it('binds connector authorization identity while allowing credential rotation for the same principal', () => {
    const snowflake = targetGenerationFingerprint({
      driver: 'snowflake', account: 'acct', database: 'analytics', schema: 'public', warehouse: 'wh', role: 'reader',
      username: 'analyst_a', authMethod: 'password', password: 'rotated-secret-a',
    }, 'reporting');
    expect(targetGenerationFingerprint({
      driver: 'snowflake', account: 'acct', database: 'analytics', schema: 'public', warehouse: 'wh', role: 'reader',
      username: 'analyst_a', authMethod: 'password', password: 'rotated-secret-b',
    }, 'reporting')).toBe(snowflake);
    expect(targetGenerationFingerprint({
      driver: 'snowflake', account: 'acct', database: 'analytics', schema: 'public', warehouse: 'wh', role: 'reader',
      username: 'analyst_b', authMethod: 'oauth', password: 'rotated-secret-a',
    }, 'reporting')).not.toBe(snowflake);

    const databricks = targetGenerationFingerprint({
      driver: 'databricks', host: 'workspace.example', httpPath: '/sql/warehouses/a', catalog: 'main', schema: 'gold',
      username: 'service-principal-a', authMethod: 'oauth_client_credentials', oauthClientId: 'client-a', token: 'token-a',
    }, 'lakehouse');
    expect(targetGenerationFingerprint({
      driver: 'databricks', host: 'workspace.example', httpPath: '/sql/warehouses/a', catalog: 'main', schema: 'gold',
      username: 'service-principal-a', authMethod: 'oauth_client_credentials', oauthClientId: 'client-a', token: 'token-b',
    }, 'lakehouse')).toBe(databricks);
    expect(targetGenerationFingerprint({
      driver: 'databricks', host: 'workspace.example', httpPath: '/sql/warehouses/a', catalog: 'main', schema: 'gold',
      username: 'service-principal-b', authMethod: 'oauth_client_credentials', oauthClientId: 'client-b', token: 'token-a',
    }, 'lakehouse')).not.toBe(databricks);
    expect(`${snowflake}${databricks}`).not.toContain('rotated-secret');
    expect(`${snowflake}${databricks}`).not.toContain('token-a');
  });
});

describe('App Copilot uniform orchestration (AGT-007, AGT-022)', () => {
  it('adapts App research evidence into a deep stakeholder AgentRun', () => {
    const request = buildAppCopilotResearchAgentRequest({
      appId: 'revenue-watch',
      dashboardId: 'drivers',
      sourceTileId: 'regional-revenue',
      question: 'Why did EMEA revenue decline?',
      intent: 'driver_analysis',
      context: { filters: { region: 'EMEA' }, settledRunReceipt: 'run-123' },
    });

    expect(request).toMatchObject({
      question: 'Why did EMEA revenue decline?',
      requestedMode: 'research',
      audience: 'stakeholder',
      analysisDepth: 'deep',
      selectedObject: { kind: 'app', id: 'revenue-watch' },
      workspaceContext: {
        surface: 'app_copilot',
        appId: 'revenue-watch',
        dashboardId: 'drivers',
        appResearch: {
          mode: 'app_research',
          intent: 'driver_analysis',
          context: { filters: { region: 'EMEA' }, settledRunReceipt: 'run-123' },
        },
      },
    });
  });

  it('keeps memo-only work evidence-bound and explicitly suppresses replacement SQL', () => {
    const request = buildAppCopilotResearchAgentRequest({
      appId: 'revenue-watch',
      question: 'Summarize the selected result',
      intent: 'business_readout',
      mode: 'memo_only',
      generatedSql: 'select 1',
      resultPreviews: [{ rows: [{ revenue: 42 }] }],
    });

    expect(request.question).toContain('using only the evidence envelope');
    expect(request.workspaceContext?.appResearch).toMatchObject({
      generationMode: 'memo_only',
      generatedSql: 'select 1',
    });
    expect(JSON.stringify(request.workspaceContext)).toContain('Do not generate replacement SQL');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('notebook static asset caching', () => {
  it('keeps the HTML shell fresh while caching fingerprinted build assets', () => {
    expect(staticResponseCacheControl(join('/runtime', 'index.html'))).toBe('no-cache');
    expect(staticResponseCacheControl(join('/runtime', 'assets', 'dql-notebook', 'index.html'))).toBe('no-cache');
    expect(staticResponseCacheControl(join('/runtime', 'assets', 'index-abc123.js')))
      .toBe('public, max-age=31536000, immutable');
  });
});

describe('Block AI domain normalization (UI-016 / E2E-015)', () => {
  it('treats semantic catalog fallback labels as absent domain context', () => {
    expect(normalizeAgentRunDomain('uncategorized')).toBeUndefined();
    expect(normalizeAgentRunDomain('_uncategorized')).toBeUndefined();
    expect(normalizeAgentRunDomain('  ')).toBeUndefined();
    expect(normalizeAgentRunDomain('finance')).toBe('finance');
  });

  it('UI-016 derives an ownerless canonical multi-metric draft from the governed answer artifact', () => {
    const metrics = [
      'percent_dod_eu_core_ccu_acm_qty',
      'percent_dod_eu_core_ccu_bcm',
      'percent_dod_eu_core_ccu_bcm_qty',
      'percent_dod_legacy_acm_qty',
      'percent_dod_legacy_bcm',
    ];
    const artifact = ownerlessReviewDqlArtifactFromAnswer({
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'capital_one_metrics',
        sourcePath: 'blocks/certified/capital_one_metrics.dql',
        source: `block "capital_one_metrics" {
  type = "semantic"
  status = "certified"
  owner = "finance-analytics"
  metric = "percent_dod_eu_core_ccu_acm_qty"
  dimensions = ["customer_name"]
  query = """
    SELECT should_not_survive
  """
}`,
        metrics,
        dimensions: ['customer_name'],
        persistence: 'saved',
        trustState: 'certified',
        compiledSql: `SELECT customer_name, ${metrics.join(', ')} FROM analytics.metrics`,
      },
    }, 'Show all five Capital One metrics by customer');

    expect(artifact).toMatchObject({
      kind: 'semantic_block',
      name: 'capital_one_metrics',
      metrics,
      dimensions: ['customer_name'],
      persistence: 'transient',
      trustState: 'review_required',
      sourcePath: undefined,
    });
    expect(artifact?.source).toContain(`metrics = [${metrics.map((metric) => `"${metric}"`).join(', ')}]`);
    expect(artifact?.source).toContain('dimensions = ["customer_name"]');
    expect(artifact?.source).toContain('status = "draft"');
    expect(artifact?.source).toContain('chart = "table"');
    expect(artifact?.source).not.toContain('metric = ');
    expect(artifact?.source).not.toContain('owner = ');
    expect(artifact?.source).not.toContain('query =');
  });

  it('UI-016 keeps custom SQL DQL intact while removing generated ownership and certification', () => {
    const artifact = ownerlessReviewDqlArtifactFromAnswer({
      dqlArtifact: {
        kind: 'sql_block',
        name: 'customer_ranking',
        source: `block "customer_ranking" {
  type = "custom"
  status = "certified"
  owner = "analytics"
  query = """
    SELECT customer_name, revenue FROM analytics.customers
  """
}`,
      },
      proposedSql: 'SELECT customer_name, revenue FROM analytics.customers',
    }, 'Rank customers');

    expect(artifact?.source).toContain('type = "custom"');
    expect(artifact?.source).toContain('status = "draft"');
    expect(artifact?.source).toContain('SELECT customer_name, revenue');
    expect(artifact?.source).not.toContain('owner = ');
    expect(artifact?.compiledSql).toContain('SELECT customer_name');
  });
});

describe('semantic runtime table mapping', () => {
  it('qualifies tables owned only by dbt measures or semantic models', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'revenue', label: 'Revenue', description: '', domain: 'commerce',
        sql: 'revenue', type: 'custom', table: '', metricType: 'simple',
        typeParams: { measure: { name: 'revenue' } },
      }],
      dimensions: [],
      measures: [{
        name: 'revenue', label: 'Revenue', description: '', domain: 'commerce',
        agg: 'sum', expr: 'amount', table: 'order_items',
      }],
      semanticModels: [{
        name: 'customers', label: 'Customers', description: '', table: 'customers',
        entities: [], measures: [], dimensions: [], timeDimensions: [],
      }],
    });

    expect(buildSemanticTableMapping(semanticLayer, [
      { table_schema: 'analytics', table_name: 'order_items' },
      { table_schema: 'analytics', table_name: 'customers' },
    ])).toEqual({
      order_items: 'analytics.order_items',
      customers: 'analytics.customers',
    });
  });

  it('does not truncate enterprise catalogs before a late semantic table', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'late_metric', label: 'Late metric', description: '', domain: 'enterprise',
        sql: 'SUM(value)', type: 'sum', table: 'table_3000',
      }],
      dimensions: [],
    });
    const rows = Array.from({ length: 3_001 }, (_, index) => ({
      table_schema: 'analytics',
      table_name: `table_${index}`,
    }));
    const executeQuery = vi.fn(async (_sql: string) => ({ rows }));

    const mapping = await resolveSemanticTableMapping(
      { executeQuery } as unknown as QueryExecutor,
      { driver: 'duckdb', filepath: ':memory:' },
      semanticLayer,
    );

    expect(mapping).toEqual({ table_3000: 'analytics.table_3000' });
    expect(String(executeQuery.mock.calls[0]?.[0])).not.toMatch(/LIMIT\s+2000/i);
  });

  it('matches Snowflake uppercase and quoted relations without changing the semantic key', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'revenue', label: 'Revenue', description: '', domain: 'commerce',
        sql: 'SUM(amount)', type: 'sum', table: 'sales.orders',
      }],
      dimensions: [],
    });

    expect(buildSemanticTableMapping(semanticLayer, [{
      table_catalog: 'ANALYTICS',
      table_schema: 'SALES',
      table_name: 'ORDERS',
      table_relation: '"ANALYTICS"."SALES"."ORDERS"',
    }])).toEqual({
      'sales.orders': '"ANALYTICS"."SALES"."ORDERS"',
    });
  });

  it('refuses an ambiguous unqualified semantic table instead of guessing a schema', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'revenue', label: 'Revenue', description: '', domain: 'commerce',
        sql: 'SUM(amount)', type: 'sum', table: 'orders',
      }],
      dimensions: [],
    });

    expect(buildSemanticTableMapping(semanticLayer, [
      { table_catalog: 'ANALYTICS', table_schema: 'SALES', table_name: 'ORDERS' },
      { table_catalog: 'ANALYTICS', table_schema: 'FINANCE', table_name: 'ORDERS' },
    ])).toBeUndefined();
  });
});

describe('runtimeSnapshotStale (P6 live-schema freshness)', () => {
  function seedSnapshot(capturedAt?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'p6-freshness-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.dql', 'cache'), { recursive: true });
    recordRuntimeSchemaSnapshot(dir, {
      source: 'test',
      ...(capturedAt ? { capturedAt } : {}),
      tables: [{ relation: 'raw.t', name: 't', columns: [{ name: 'id' }] }],
    });
    return dir;
  }

  it('treats a snapshot older than the window as stale (forces a rescan)', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(runtimeSnapshotStale(seedSnapshot(twoHoursAgo))).toBe(true);
  });

  it('treats a fresh snapshot as not stale (reuses it)', () => {
    expect(runtimeSnapshotStale(seedSnapshot(new Date().toISOString()))).toBe(false);
  });

  it('treats a missing snapshot as stale (needs a first scan)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p6-empty-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.dql', 'cache'), { recursive: true });
    expect(runtimeSnapshotStale(dir)).toBe(true);
  });

  it('keeps serving the latest snapshot after many writes are pruned (P7)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p7-prune-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.dql', 'cache'), { recursive: true });
    for (let i = 0; i < 8; i += 1) {
      recordRuntimeSchemaSnapshot(dir, {
        source: `scan-${i}`,
        capturedAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), // distinct, increasing
        tables: [{ relation: `raw.t${i}`, name: `t${i}`, columns: [{ name: 'id' }] }],
      });
    }
    // The prune must never delete the newest row — it's the only one ever read.
    expect(latestRuntimeSchemaSnapshotForProject(dir)?.source).toBe('scan-7');
  });

  it('never gives an Ask run metadata from another selected connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-connection-metadata-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.dql', 'cache'), { recursive: true });
    recordRuntimeSchemaSnapshot(dir, {
      generationId: 'primary-generation',
      connectionId: 'primary',
      scopeFingerprint: 'primary-scope',
      status: 'ready',
      capturedAt: '2026-07-29T12:00:00.000Z',
      tables: [{ relation: 'PROD.SALES.ORDERS', name: 'ORDERS', columns: [{ name: 'ID' }] }],
    });
    recordRuntimeSchemaSnapshot(dir, {
      generationId: 'reporting-generation',
      connectionId: 'reporting',
      scopeFingerprint: 'reporting-scope',
      status: 'ready',
      capturedAt: '2026-07-29T12:01:00.000Z',
      tables: [{ relation: 'GOLD.COMMON.REVENUE', name: 'REVENUE', columns: [{ name: 'AMOUNT' }] }],
    });

    expect(runtimeSchemaSnapshotForAgentConnection(dir, 'primary', 'primary-scope').tables[0]?.relation)
      .toBe('PROD.SALES.ORDERS');
    expect(runtimeSchemaSnapshotForAgentConnection(dir, 'primary', 'drifted-scope')).toMatchObject({
      connectionId: 'primary',
      status: 'partial',
      tables: [],
    });
    expect(runtimeSchemaSnapshotForAgentConnection(dir, 'missing')).toMatchObject({
      connectionId: 'missing',
      tables: [],
    });
  });
});

describe('bounded Ask meaning resolution (AGT-009, PERF-002)', () => {
  it('inherits user cancellation and enforces its own short deadline', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    expect(boundedAgentMeaningSignal(cancelled.signal, 1_000).aborted).toBe(true);

    const deadline = boundedAgentMeaningSignal(undefined, 5);
    await new Promise<void>((resolve) => deadline.addEventListener('abort', () => resolve(), { once: true }));
    expect(deadline.aborted).toBe(true);
  });

  it('keeps every ordinary Ask under one 45s hard ceiling and Research explicit', () => {
    // A bare scalar metric ("total revenue") composes in one shot — short budget.
    expect(agentRunDeadlineMs({
      question: 'total revenue',
      requestedMode: 'ask',
    })).toBe(45_000);
    // Shape and depth change soft targets, never the hard Ask ceiling.
    expect(agentRunDeadlineMs({
      question: 'what are the top products Melissa Lopez bought and what is the revenue?',
      requestedMode: 'ask',
    })).toBe(45_000);
    expect(agentRunDeadlineMs({
      question: 'top bcm customers from the south region',
      requestedMode: 'ask',
    })).toBe(45_000);
    expect(agentRunDeadlineMs({
      question: 'investigate why revenue declined and identify the drivers',
      requestedMode: 'research',
    })).toBe(120_000);
    expect(agentRunDeadlineMs({
      question: 'analyze revenue',
      requestedMode: 'ask',
      analysisDepth: 'deep',
    })).toBe(45_000);
    // A clarification continuation stays inside the same Ask ceiling.
    expect(agentRunDeadlineMs({
      question: 'Lost Deal Activity Count',
      selectedEvidenceId: 'semantic:metric:sales.lost_deal_activity_count',
      clarificationSourceQuestion: 'Compare monthly competitive losses by competitor and total activity count for each lost opportunity',
      requestedMode: 'ask',
    })).toBe(45_000);
  });

  it('does not let reasoning controls broaden the hard deadline', () => {
    // Thinking depth affects provider effort, not wall-clock authority.
    expect(agentRunDeadlineMs({
      question: 'total revenue',
      requestedMode: 'ask',
      thinkingMode: 'high',
    })).toBe(45_000);
    expect(agentRunDeadlineMs({
      question: 'top customers in south region based on last 6 months',
      requestedMode: 'ask',
      reasoningEffort: 'high',
    })).toBe(45_000);
    expect(agentRunDeadlineMs({
      question: 'total revenue',
      requestedMode: 'ask',
      reasoningEffort: 'low',
    })).toBe(45_000);
  });

  it('does not let provider transport or env overrides broaden the ceiling', () => {
    // Transport selection changes no product deadline contract.
    expect(agentRunDeadlineMs(
      { question: 'what is total bcm?', requestedMode: 'ask' },
      {} as NodeJS.ProcessEnv,
      'claude-code',
    )).toBe(45_000);
    expect(agentRunDeadlineMs(
      { question: 'top 10 customers for bcm', requestedMode: 'ask' },
      {} as NodeJS.ProcessEnv,
      'claude-code',
    )).toBe(45_000);
    expect(agentRunDeadlineMs(
      { question: 'investigate revenue drivers', requestedMode: 'research' },
      {} as NodeJS.ProcessEnv,
      'codex',
    )).toBe(120_000);
    expect(agentRunDeadlineMs(
      { question: 'total revenue?', requestedMode: 'ask' },
      {} as NodeJS.ProcessEnv,
      'anthropic',
    )).toBe(45_000);
    expect(agentRunDeadlineMs(
      { question: 'total revenue?', requestedMode: 'ask' },
      { DQL_AGENT_LOOKUP_DEADLINE_MS: '60000' } as unknown as NodeJS.ProcessEnv,
      'claude-code',
    )).toBe(45_000);
  });
});

describe('Ask AI runtime schema augmentation', () => {
  it('uses the typed question plan for composite metric questions with singular nouns', () => {
    expect(shouldAugmentAgentRuntimeSchema(
      'who are the customers who bought more revenue on beverage product category?',
      {
        entities: ['customer'],
        metricTerms: ['revenue'],
        dimensionTerms: ['customer', 'product', 'category'],
      },
    )).toBe(true);
  });

  it('keeps simple one-table metric questions on the cached metadata path', () => {
    expect(shouldAugmentAgentRuntimeSchema(
      'what is total revenue?',
      { metricTerms: ['revenue'], dimensionTerms: [] },
    )).toBe(false);
  });
});

describe('formatLocalQueryRuntimeError', () => {
  it('explains missing DuckDB native bindings with actionable guidance', () => {
    const message = formatLocalQueryRuntimeError(
      { driver: 'file', filepath: ':memory:' },
      new Error("Cannot find module '/tmp/duckdb/lib/binding/duckdb.node'"),
    );

    expect(message).toContain('DuckDB native bindings could not be loaded');
    expect(message).toContain(`Current Node.js runtime: ${process.versions.node}`);
    expect(message).toContain('Node 18, 20, or 22');
    expect(message).toContain('pnpm install');
  });
});

describe('serializeJSON', () => {
  it('serializes safe bigint values as numbers', () => {
    expect(serializeJSON({ revenue: 42n })).toBe('{"revenue":42}');
  });

  it('serializes unsafe bigint values as strings', () => {
    const value = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(serializeJSON({ revenue: value })).toBe(`{"revenue":"${value.toString()}"}`);
  });
});

describe('authorized analytical freshness observation (AGT-019, SEC-004)', () => {
  const request = {
    version: 1 as const,
    snapshotId: 'snapshot-1',
    metricId: 'semantic:orders:gross_revenue',
    timeDimensionId: 'semantic:orders:dimension:report_date',
    authorizedAdapterRequest: {
      route: 'semantic' as const,
      metric: 'gross_revenue',
      timeDimension: 'orders__report_date',
      granularity: 'day',
      outputField: 'report_date_day',
    },
  };

  it('extracts the compiler-declared time output without inspecting unrelated strings', () => {
    expect(analyticalFreshnessObservedThrough({
      columns: [
        { name: 'report_date_day', type: 'date', driverType: 'DATE' },
        { name: 'gross_revenue', type: 'number', driverType: 'DECIMAL' },
      ],
      rows: [{ report_date_day: '2026-07-21', gross_revenue: 42 }],
      rowCount: 1,
      executionTimeMs: 2,
    }, request)).toBe('2026-07-21T00:00:00.000Z');
  });

  it('fails closed when no authorized binding or identifiable time output exists', () => {
    const result: QueryResult = {
      columns: [{ name: 'label', type: 'string', driverType: 'VARCHAR' }],
      rows: [{ label: '2026-07-21' }],
      rowCount: 1,
      executionTimeMs: 1,
    };
    expect(() => analyticalFreshnessObservedThrough(result, { ...request, authorizedAdapterRequest: undefined }))
      .toThrow(/authorized semantic adapter binding/i);
    expect(() => analyticalFreshnessObservedThrough(result, request))
      .toThrow(/identifiable time field/i);
  });
});

describe('local runtime network boundary', () => {
  it('refuses non-loopback binding without a token and explicit origin allowlist', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-remote-security-'));
    tempDirs.push(projectRoot);
    await expect(startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      host: '0.0.0.0',
    })).rejects.toThrow('DQL_SERVER_TOKEN');
  });

  it('does not grant wildcard CORS to a non-loopback browser origin', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-loopback-cors-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/domain-workspaces`, { headers: { Origin: 'https://evil.example' } });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('warehouse metadata scope runtime API (CTX-005, PERF-002, API-006, SEC-003)', () => {
  it('discovers visible schemas and marks dbt-covered schemas without persisting scope changes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-metadata-discovery-api-'));
    tempDirs.push(projectRoot);
    const connection = {
      driver: 'databricks' as const,
      host: 'adb.example.test',
      httpPath: '/sql/1.0/warehouses/test',
      token: 'discovery-token',
      catalog: 'analytics_prod',
      schema: 'sales',
    };
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'metadata-discovery-api',
      connections: { default: connection },
      defaultConnectionName: 'default',
    }));
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      nodes: {
        'model.demo.orders': {
          resource_type: 'model',
          name: 'orders',
          database: 'analytics_prod',
          schema: 'sales',
          alias: 'orders',
        },
      },
      sources: {},
    }));
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql === 'SHOW CATALOGS') {
        return {
          columns: [],
          rows: [{ catalog: 'analytics_prod' }, { catalog: 'reporting_prod' }],
          rowCount: 2,
          executionTimeMs: 1,
        };
      }
      return {
        columns: [],
        rows: sql.includes('analytics_prod')
          ? [{ databaseName: 'sales' }, { databaseName: 'gold' }]
          : [{ databaseName: 'finance' }],
        rowCount: sql.includes('analytics_prod') ? 2 : 1,
        executionTimeMs: 1,
      };
    });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executePositional } as unknown as QueryExecutor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/api/connections/default/metadata-scope/discovery`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        supported: true,
        dbtScopes: [{ catalogOrDatabase: 'analytics_prod', schemas: ['sales'] }],
        scopes: [
          {
            catalogOrDatabase: 'analytics_prod',
            schemas: [
              { name: 'gold', inDbtProject: false },
              { name: 'sales', inDbtProject: true, dbtRelationCount: 1 },
            ],
          },
          {
            catalogOrDatabase: 'reporting_prod',
            schemas: [{ name: 'finance', inDbtProject: false }],
          },
        ],
      });
      expect(executePositional).toHaveBeenCalledTimes(3);
      expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8')).metadataScopes).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('applies a selected multi-catalog scope and serves schema UI from the activated generation', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-metadata-scope-api-'));
    tempDirs.push(projectRoot);
    const connection = {
      driver: 'databricks' as const,
      host: 'adb.example.test',
      httpPath: '/sql/1.0/warehouses/test',
      token: 'not-persisted-by-scope',
      catalog: 'analytics_prod',
      schema: 'sales',
    };
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'metadata-scope-api',
      connections: { default: connection },
      defaultConnectionName: 'default',
    }));
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => ({
      columns: [],
      rows: sql.includes('reference_data')
        ? [{
            table_catalog: 'reference_data',
            table_schema: 'shared',
            table_name: 'calendar',
            column_name: 'calendar_date',
            data_type: 'DATE',
            ordinal_position: 1,
          }]
        : [{
            table_catalog: 'analytics_prod',
            table_schema: 'sales',
            table_name: 'orders',
            column_name: 'customer_id',
            data_type: 'BIGINT',
            ordinal_position: 1,
          }],
      rowCount: 1,
      executionTimeMs: 1,
      truncated: false,
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executePositional } as unknown as QueryExecutor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const scopeBody = {
        mode: 'selected_scopes',
        scopes: [
          { catalogOrDatabase: 'analytics_prod', schemas: ['sales'] },
          { catalogOrDatabase: 'reference_data', schemas: ['shared'] },
        ],
      };
      const applied = await fetch(`${base}/api/connections/default/metadata-scope`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scopeBody),
      });
      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({
        scope: {
          mode: 'selected_scopes',
          scopes: scopeBody.scopes,
        },
        status: {
          state: 'ready',
          relationCount: 2,
          columnCount: 2,
        },
      });
      expect(executePositional).toHaveBeenCalledTimes(2);

      const schema = await fetch(`${base}/api/schema`);
      expect(schema.status).toBe(200);
      expect(await schema.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'analytics_prod.sales.orders' }),
        expect.objectContaining({ path: 'reference_data.shared.calendar' }),
      ]));
      expect(executePositional).toHaveBeenCalledTimes(2);

      const persisted = JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8'));
      expect(persisted.metadataScopes.default).toEqual(scopeBody);
      expect(JSON.stringify(persisted.metadataScopes)).not.toContain(connection.token);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('unified provider draft testing (CFG-004)', () => {
  it('tests unsaved OpenAI and Anthropic enterprise URLs through governed adapters without persisting drafts', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-provider-draft-test-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const nativeFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://openai.enterprise.example/')) {
        requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://anthropic.enterprise.example/')) {
        requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return nativeFetch(input, init);
    }));

    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const openai = await nativeFetch(`http://127.0.0.1:${port}/api/settings/providers/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'openai', apiKey: 'openai-draft-secret', baseUrl: 'https://openai.enterprise.example/v1', model: 'gpt-enterprise' }),
      });
      const anthropic = await nativeFetch(`http://127.0.0.1:${port}/api/settings/providers/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'anthropic', apiKey: 'anthropic-draft-secret', baseUrl: 'https://anthropic.enterprise.example/proxy/v1', model: 'claude-enterprise' }),
      });

      expect(openai.status).toBe(200);
      expect(anthropic.status).toBe(200);
      expect(requests.map((request) => request.url)).toEqual([
        'https://openai.enterprise.example/v1/chat/completions',
        'https://anthropic.enterprise.example/proxy/v1/messages',
      ]);
      expect(requests[0].headers.get('authorization')).toBe('Bearer openai-draft-secret');
      expect(requests[0].body).toMatchObject({ model: 'gpt-enterprise', messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
      expect(requests[1].headers.get('x-api-key')).toBe('anthropic-draft-secret');
      expect(requests[1].body).toMatchObject({ model: 'claude-enterprise', messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
      expect(existsSync(providerSettingsPath(projectRoot))).toBe(false);

      saveProviderSettings(projectRoot, { id: 'openai', enabled: true, apiKey: 'stored-redacted-secret', baseUrl: 'https://openai.enterprise.example/v1', model: 'gpt-stored' });
      saveProviderSettings(projectRoot, { id: 'openai', enabled: false });
      const disabledCandidate = await nativeFetch(`http://127.0.0.1:${port}/api/settings/providers/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'openai' }),
      });
      const disabledBody = await disabledCandidate.text();
      expect(disabledCandidate.status).toBe(200);
      expect(requests[2].headers.get('authorization')).toBe('Bearer stored-redacted-secret');
      expect(disabledBody).not.toContain('stored-redacted-secret');
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('uniform DQL artifact parameter invocation API (PRD-001, CTX-001, AGT-006, AGT-012, API-005, UI-011)', () => {
  it('returns the typed contract and reruns only the named certified block with explicit values', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certified-parameter-api-'));
    tempDirs.push(projectRoot);
    const blockDir = join(projectRoot, 'domains', 'commerce', 'blocks');
    mkdirSync(blockDir, { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'parameter-api',
      connections: {
        default: { driver: 'databricks', host: 'default.example.test' },
        reporting: { driver: 'databricks', host: 'reporting.example.test' },
      },
      defaultConnectionName: 'default',
    }));
    writeFileSync(join(blockDir, 'runtime_parameter.dql'), `block "Runtime Parameter" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  params {
    category: string = "Beverage"
    top_n: number = 10
  }
  parameterPolicy {
    category = "dynamic"
    top_n = "dynamic"
  }
  query = """SELECT \${category} AS selected_category, \${top_n} AS selected_limit"""
}`);
    writeFileSync(join(blockDir, 'conflicting_draft.dql'), `block "Conflicting Draft" {
  domain = "commerce"
  type = "custom"
  status = "draft"
  query = """SELECT 'wrong_source' AS selected_category, 999 AS selected_limit"""
}`);

    const executionConnections: Array<{ host?: string } | undefined> = [];
    const executeQuery = vi.fn(async (
      sql,
      _params,
      variables: Record<string, unknown>,
      executionConnection?: { host?: string },
    ): Promise<QueryResult> => {
      executionConnections.push(executionConnection);
      return {
      columns: [
        { name: 'selected_category', type: 'string', driverType: 'VARCHAR' },
        { name: 'selected_limit', type: 'number', driverType: 'INTEGER' },
      ],
      rows: [sql.includes('wrong_source')
        ? { selected_category: 'wrong_source', selected_limit: 999 }
        : { selected_category: variables.category, selected_limit: variables.top_n }],
      rowCount: 1,
      executionTimeMs: 1,
      };
    });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery } as unknown as QueryExecutor,
        connection: { driver: 'databricks', host: 'default.example.test' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const contractResponse = await fetch(`${base}/api/blocks/parameters?name=${encodeURIComponent('Runtime Parameter')}`);
      expect(contractResponse.status).toBe(200);
      const contract = await contractResponse.json() as { parameters: Array<{ name: string; type: string; policy: string }> };
      expect(contract.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'category', type: 'string', policy: 'dynamic' }),
        expect.objectContaining({ name: 'top_n', type: 'number', policy: 'dynamic' }),
      ]));

      const parameterOptionsResponse = await fetch(`${base}/api/dashboard/filter-options?block=${encodeURIComponent('Runtime Parameter')}&column=category`);
      expect(parameterOptionsResponse.status).toBe(400);
      await expect(parameterOptionsResponse.json()).resolves.toMatchObject({
        error: '"category" is not a declared output of this block',
      });
      expect(executeQuery).not.toHaveBeenCalled();

      const invokeResponse = await fetch(`${base}/api/blocks/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockName: 'Runtime Parameter', parameters: { category: 'Coffee', top_n: 3 } }),
      });
      const invoked = await invokeResponse.json() as { error?: string; result: { rows: Array<Record<string, unknown>>; auditId: string } };
      expect({ status: invokeResponse.status, error: invoked.error }).toEqual({ status: 200, error: undefined });
      expect(invoked.result.rows).toEqual([{ selected_category: 'Coffee', selected_limit: 3 }]);
      expect(invoked.result.auditId).toMatch(/^[a-f0-9]+$/);

      const generatedSource = `block "Generated Runtime Parameter" {
  domain = "commerce"
  type = "custom"
  status = "draft"
  params { category: string = "Beverage" top_n: number = 10 }
  parameterPolicy { category = "dynamic" top_n = "dynamic" }
  query = """SELECT \${category} AS selected_category, \${top_n} AS selected_limit"""
}`;
      const generatedResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact: { kind: 'sql_block', name: 'Generated Runtime Parameter', source: generatedSource, persistence: 'transient', trustState: 'review_required' },
          parameters: { category: 'Tea', top_n: 7 },
          executionTarget: { target: 'connection', connectionName: 'reporting' },
        }),
      });
      const generated = await generatedResponse.json() as {
        error?: string;
        result: { rows: Array<Record<string, unknown>> };
        artifact: {
          source: string;
          trustState: string;
          persistence: string;
          parameters: Array<{ name: string; type: string }>;
          parameterValues: Record<string, unknown>;
          executionReceipt: Record<string, string>;
          executableArtifact: Record<string, unknown>;
        };
      };
      expect({ status: generatedResponse.status, error: generated.error }).toEqual({ status: 200, error: undefined });
      expect(generated.result.rows).toEqual([{ selected_category: 'Tea', selected_limit: 7 }]);
      expect(executionConnections.at(-1)?.host).toBe('reporting.example.test');
      expect(generated.artifact).toMatchObject({
        trustState: 'review_required',
        persistence: 'transient',
        parameterValues: { category: 'Tea', top_n: 7 },
        parameters: expect.arrayContaining([
          expect.objectContaining({ name: 'category', type: 'string' }),
          expect.objectContaining({ name: 'top_n', type: 'number' }),
        ]),
      });
      expect(generated.artifact.executionReceipt).toMatchObject({
        sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        compiledSqlFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        parameterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        resultFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(generated.artifact.executableArtifact).toMatchObject({
        version: 1,
        kind: 'sql_block',
        trustState: 'review_required',
        previewPolicy: { mode: 'compiler_governed' },
        dqlFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        normalizedSqlFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        provenanceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        snapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(generated.artifact.executableArtifact).not.toHaveProperty('rows');
      expect(generated.artifact.executableArtifact).not.toHaveProperty('sql');

      const parityResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifact: generated.artifact, parameters: { category: 'Tea', top_n: 7 } }),
      });
      const parity = await parityResponse.json() as typeof generated;
      expect({ status: parityResponse.status, error: parity.error }).toEqual({ status: 200, error: undefined });
      expect(parity.result.rows).toEqual(generated.result.rows);
      expect(parity.artifact.executionReceipt).toEqual(generated.artifact.executionReceipt);

      const trailingNewlineSource = `${generatedSource}\n`;
      const trailingNewlineResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact: {
            kind: 'sql_block',
            name: 'Generated Runtime Parameter',
            source: trailingNewlineSource,
            persistence: 'transient',
            trustState: 'review_required',
          },
          parameters: { category: 'Tea', top_n: 7 },
        }),
      });
      const trailingNewline = await trailingNewlineResponse.json() as typeof generated;
      expect({ status: trailingNewlineResponse.status, error: trailingNewline.error }).toEqual({ status: 200, error: undefined });
      expect(trailingNewline.artifact.source).toBe(trailingNewlineSource);

      const legacyTrimmedSourceResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact: {
            ...trailingNewline.artifact,
            // DQL <= 1.11.10 normalized away this final newline after creating
            // the receipt. Existing saved runs must remain parameter-rerunnable.
            source: trailingNewlineSource.trimEnd(),
          },
          parameters: { category: 'Coffee', top_n: 5 },
        }),
      });
      const legacyTrimmedSource = await legacyTrimmedSourceResponse.json() as typeof generated;
      expect({ status: legacyTrimmedSourceResponse.status, error: legacyTrimmedSource.error }).toEqual({ status: 200, error: undefined });
      expect(legacyTrimmedSource.result.rows).toEqual([{ selected_category: 'Coffee', selected_limit: 5 }]);

      const driftResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact: {
            ...generated.artifact,
            executionReceipt: {
              ...generated.artifact.executionReceipt,
              compiledSqlFingerprint: 'f'.repeat(64),
            },
          },
          parameters: { category: 'Tea', top_n: 7 },
        }),
      });
      expect(driftResponse.status).toBe(400);
      await expect(driftResponse.json()).resolves.toMatchObject({
        error: expect.stringContaining('changed while its source and inputs were unchanged'),
      });

      const sourceDriftResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact: {
            ...generated.artifact,
            source: generated.artifact.source.replace('selected_limit', 'changed_limit'),
          },
          parameters: { category: 'Tea', top_n: 7 },
        }),
      });
      expect(sourceDriftResponse.status).toBe(400);
      await expect(sourceDriftResponse.json()).resolves.toMatchObject({
        error: expect.stringContaining('source changed after the answer was produced'),
      });

      const exactSourceResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact: {
            kind: 'sql_block',
            name: 'Generated Runtime Parameter',
            source: generatedSource,
            sourcePath: 'domains/commerce/blocks/conflicting_draft.dql',
            persistence: 'saved',
            trustState: 'review_required',
          },
          parameters: { category: 'Tea', top_n: 7 },
        }),
      });
      const exactSource = await exactSourceResponse.json() as typeof generated;
      expect({ status: exactSourceResponse.status, error: exactSource.error }).toEqual({ status: 200, error: undefined });
      expect(exactSource.result.rows).toEqual([{ selected_category: 'Tea', selected_limit: 7 }]);

      const questionBoundResponse = await fetch(`${base}/api/dql/artifacts/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact: { kind: 'sql_block', name: 'Generated Runtime Parameter', source: generatedSource, persistence: 'transient', trustState: 'review_required' },
          question: 'Show the top 4 Tea results',
          parameters: { category: 'Tea' },
        }),
      });
      const questionBound = await questionBoundResponse.json() as {
        error?: string;
        result: { rows: Array<Record<string, unknown>>; parameters: Array<{ name: string; value: unknown; source: string }> };
        artifact: { parameterValues: Record<string, unknown> };
      };
      expect({ status: questionBoundResponse.status, error: questionBound.error }).toEqual({ status: 200, error: undefined });
      expect(questionBound.result.rows).toEqual([{ selected_category: 'Tea', selected_limit: 4 }]);
      expect(questionBound.result.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'category', value: 'Tea', source: 'explicit' }),
        expect.objectContaining({ name: 'top_n', value: 4, source: 'question' }),
      ]));
      expect(questionBound.artifact.parameterValues).toEqual({ category: 'Tea', top_n: 4 });
      expect(executeQuery).toHaveBeenCalledTimes(8);
    } finally {
      await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
    }
  });
});

describe('local runtime source-control isolation (UI-001, SEC-001, E2E-001)', () => {
  it('reports every untracked file instead of collapsing nested folders (UI-001, E2E-001)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-git-status-files-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'blocks', 'cards'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    writeFileSync(join(projectRoot, 'blocks', 'cards', 'approval-rate.dql'), 'block "Approval rate" {}\n');
    writeFileSync(join(projectRoot, 'blocks', 'cards', 'fraud-alerts.dql'), 'block "Fraud alerts" {}\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'ignore' });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/git/status`);
      const status = await response.json() as { changes: Array<{ path: string; status: string }> };

      expect(status.changes).toEqual(expect.arrayContaining([
        { path: 'blocks/cards/approval-rate.dql', status: '??' },
        { path: 'blocks/cards/fraud-alerts.dql', status: '??' },
      ]));
      expect(status.changes).not.toContainEqual({ path: 'blocks/', status: '??' });
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('repairs a legacy broad .dql ignore without hiding governed skills or Hint Graph files (UI-001, SEC-001, E2E-001)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-local-ignore-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, '.dql', 'hints'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n.dql/\n');
    writeFileSync(join(projectRoot, '.dql', 'hints', 'customer-region.hint.yaml'), 'version: 3\nid: customer-region\nstatus: candidate\n');
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const gitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.dql/connectors/');
      expect(gitignore).toContain('.dql/oauth-credentials.json');
      expect(gitignore).toContain('.dql/provider-settings.json');
      expect(gitignore).toContain('.dql/mcp-servers.json');
      expect(gitignore).toContain('.dql/memory/');
      expect(gitignore).not.toContain('.dql/skills/');
      expect(gitignore.split(/\r?\n/).map((line) => line.trim())).not.toContain('.dql/');

      const governedResponse = await fetch(`http://127.0.0.1:${port}/api/git/governed-context`);
      const governed = await governedResponse.json() as {
        trackingReady: boolean;
        legacyBroadIgnore: boolean;
        learning: { untracked: number; ignored: number; paths: Array<{ path: string }> };
      };
      expect(governed.trackingReady).toBe(true);
      expect(governed.legacyBroadIgnore).toBe(false);
      expect(governed.learning.ignored).toBe(0);
      expect(governed.learning.untracked).toBe(1);
      expect(governed.learning.paths).toContainEqual(expect.objectContaining({
        path: '.dql/hints/customer-region.hint.yaml',
      }));

      const prematureReview = await fetch(`http://127.0.0.1:${port}/api/git/review/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Review local changes', base: 'main' }),
      });
      expect(prematureReview.status).toBe(400);
      await expect(prematureReview.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('Share the changes to a review branch'),
      });
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('version-aware Guided Setup launch (UI-007, E2E-005)', () => {
  it('opens for first install and version upgrades, then preserves the acknowledgement with other user preferences', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-setup-launch-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;

      const firstLaunch = await (await fetch(`${base}/api/onboarding/launch`)).json() as {
        version: string;
        acknowledgedVersion: string | null;
        shouldOpen: boolean;
        reason: string | null;
      };
      expect(firstLaunch).toMatchObject({
        acknowledgedVersion: null,
        shouldOpen: true,
        reason: 'first_install',
      });
      expect(firstLaunch.version).not.toBe('unknown');

      const acknowledged = await (await fetch(`${base}/api/onboarding/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })).json() as { version: string; acknowledged: boolean };
      expect(acknowledged).toMatchObject({ version: firstLaunch.version, acknowledged: true });
      await expect((await fetch(`${base}/api/onboarding/launch`)).json()).resolves.toMatchObject({
        version: firstLaunch.version,
        acknowledgedVersion: firstLaunch.version,
        shouldOpen: false,
        reason: null,
      });

      writeFileSync(join(projectRoot, '.dql-user-prefs.json'), JSON.stringify({
        favorites: ['revenue'],
        recentlyUsed: ['orders'],
        setup: { acknowledgedVersion: '0.0.1', acknowledgedAt: '2026-01-01T00:00:00.000Z' },
      }));
      await expect((await fetch(`${base}/api/onboarding/launch`)).json()).resolves.toMatchObject({
        version: firstLaunch.version,
        acknowledgedVersion: '0.0.1',
        shouldOpen: true,
        reason: 'version_upgrade',
      });

      await fetch(`${base}/api/onboarding/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(JSON.parse(readFileSync(join(projectRoot, '.dql-user-prefs.json'), 'utf-8'))).toMatchObject({
        favorites: ['revenue'],
        recentlyUsed: ['orders'],
        setup: { acknowledgedVersion: firstLaunch.version, acknowledgedAt: expect.any(String) },
      });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('requires configured OSS dbt projects to be previewed and reapplied before acknowledging an npm upgrade', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-upgrade-reapply-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: upgrade_shop\nversion: 1\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'upgrade_shop' },
      nodes: {
        'model.upgrade_shop.orders': {
          unique_id: 'model.upgrade_shop.orders',
          resource_type: 'model',
          name: 'orders',
          original_file_path: 'models/orders.sql',
          columns: {},
          depends_on: { nodes: [] },
          tags: [],
        },
      },
      sources: {}, metrics: {}, exposures: {}, semantic_models: {}, groups: {}, child_map: {}, parent_map: {},
    }));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'upgrade-shop',
      manifestVersion: 3,
      modeling: { mode: 'dbt-first' },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
      semanticLayer: { provider: 'dbt', projectPath: '.' },
    }));
    writeFileSync(join(projectRoot, '.dql-user-prefs.json'), JSON.stringify({
      favorites: ['revenue'],
      recentlyUsed: ['orders'],
      setup: { acknowledgedVersion: '0.0.1', acknowledgedAt: '2026-01-01T00:00:00.000Z' },
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const launch = await (await fetch(`${base}/api/onboarding/launch`)).json() as {
        version: string;
        shouldOpen: boolean;
        reason: string;
        requiresDbtReapply: boolean;
        dbtAppliedVersion: string | null;
      };
      expect(launch).toMatchObject({
        shouldOpen: true,
        reason: 'version_upgrade',
        requiresDbtReapply: true,
        dbtAppliedVersion: null,
      });

      const premature = await fetch(`${base}/api/onboarding/acknowledge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(premature.status).toBe(409);
      await expect(premature.json()).resolves.toMatchObject({ code: 'DBT_REAPPLY_REQUIRED' });

      const preview = await (await fetch(`${base}/api/onboarding/dbt/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: '.', manifestPath: 'target/manifest.json' }),
      })).json() as { fingerprint: string };
      const reapplied = await fetch(`${base}/api/onboarding/dbt/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: '.', manifestPath: 'target/manifest.json', expectedFingerprint: preview.fingerprint }),
      });
      expect(reapplied.status).toBe(200);

      await expect((await fetch(`${base}/api/onboarding/launch`)).json()).resolves.toMatchObject({
        version: launch.version,
        shouldOpen: true,
        reason: 'version_upgrade',
        requiresDbtReapply: false,
        dbtAppliedVersion: launch.version,
      });
      const acknowledged = await fetch(`${base}/api/onboarding/acknowledge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(acknowledged.status).toBe(200);
      expect(JSON.parse(readFileSync(join(projectRoot, '.dql-user-prefs.json'), 'utf-8'))).toMatchObject({
        favorites: ['revenue'],
        recentlyUsed: ['orders'],
        setup: {
          acknowledgedVersion: launch.version,
          dbtAppliedVersion: launch.version,
          acknowledgedAt: expect.any(String),
          dbtAppliedAt: expect.any(String),
        },
      });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('does not describe unresolved starter placeholders as a configured dbt project', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-setup-placeholder-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: '{{PROJECT_NAME}}',
      dbt: { projectDir: '{{DBT_PROJECT_DIR}}', manifestPath: 'target/manifest.json' },
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      await expect((await fetch(`http://127.0.0.1:${port}/api/onboarding/status`)).json()).resolves.toMatchObject({
        dbt: { configured: false, projectFound: false, manifestFound: false },
      });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });
});

describe('dbt-first onboarding runtime API', () => {
  it('clones and previews a Git dbt repository without semantic copying (CFG-003, E2E-003)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-git-workspace-'));
    const dbtRoot = mkdtempSync(join(tmpdir(), 'dbt-git-source-'));
    tempDirs.push(projectRoot, dbtRoot);
    mkdirSync(join(dbtRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{"project":"git-workspace"}\n');
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: git_shop\nprofile: git_shop\n');
    writeFileSync(join(dbtRoot, 'profiles.yml'), 'git_shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: warehouse.duckdb\n');
    writeFileSync(join(dbtRoot, 'warehouse.duckdb'), '');
    writeFileSync(join(dbtRoot, 'target', 'manifest.json'), JSON.stringify({ metadata: { project_name: 'git_shop' }, nodes: {}, sources: {}, metrics: {} }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dbtRoot });
    execFileSync('git', ['add', '.'], { cwd: dbtRoot });
    execFileSync('git', ['-c', 'user.name=DQL Test', '-c', 'user.email=dql@example.com', 'commit', '-m', 'fixture'], { cwd: dbtRoot });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const response = await fetch(`http://127.0.0.1:${port}/api/onboarding/dbt/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: `file://${dbtRoot}`, branch: 'main', manifestPath: 'target/manifest.json' }),
      });
      expect(response.status).toBe(200);
      const preview = await response.json() as { repoUrl: string; projectName: string; projectDir: string; profilesDir: string };
      expect(preview).toMatchObject({ repoUrl: `file://${dbtRoot}`, projectName: 'git_shop' });
      expect(preview.projectDir).toContain('.dql/cache/repos/');
      expect(preview.profilesDir).toBe(preview.projectDir);
      expect(existsSync(join(projectRoot, 'semantic-layer'))).toBe(false);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('compiles Domain Studio from a configured external dbt checkout (CFG-003, E2E-003)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-external-workspace-'));
    const dbtRoot = mkdtempSync(join(tmpdir(), 'dbt-external-repo-'));
    tempDirs.push(projectRoot, dbtRoot);
    mkdirSync(join(dbtRoot, 'target'), { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: external_shop\nprofile: external_shop\n');
    writeFileSync(join(dbtRoot, 'profiles.yml'), 'external_shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: warehouse.duckdb\n');
    writeFileSync(join(dbtRoot, 'warehouse.duckdb'), '');
    writeFileSync(join(dbtRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'external_shop' },
      nodes: {
        'model.external_shop.orders': {
          unique_id: 'model.external_shop.orders', resource_type: 'model', name: 'orders',
          original_file_path: 'models/orders.sql', columns: {}, depends_on: { nodes: [] }, tags: [],
        },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'workspace', manifestVersion: 3, modeling: { mode: 'dbt-first' },
      dbt: { projectDir: dbtRoot, manifestPath: 'target/manifest.json' },
      semanticLayer: { provider: 'dbt', projectPath: dbtRoot },
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const response = await fetch(`http://127.0.0.1:${port}/api/modeling/dbt-first`);
      expect(response.status).toBe(200);
      const body = await response.json() as { manifestVersion: number; dbtProvenance: { projectName: string } };
      expect(body).toMatchObject({ manifestVersion: 3, dbtProvenance: { projectName: 'external_shop' } });
      const connections = await (await fetch(`http://127.0.0.1:${port}/api/connections`)).json() as {
        activeConnection: { source: string; driver: string; profileId?: string };
      };
      expect(connections.activeConnection).toMatchObject({ source: 'dbt_profile', driver: 'duckdb', profileId: expect.any(String) });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('serves a dbt-scoped first page and late search without scanning the warehouse (CTX-005, PERF-001, UI-009)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-bounded-dbt-catalog-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    const nodes = Object.fromEntries(Array.from({ length: 60 }, (_, index) => {
      const suffix = String(index).padStart(3, '0');
      const name = `model_${suffix}`;
      return [`model.shop.${name}`, {
        unique_id: `model.shop.${name}`,
        resource_type: 'model',
        name,
        alias: name,
        relation_name: `ANALYTICS.COMMERCE.${name.toUpperCase()}`,
        database: 'ANALYTICS',
        schema: 'COMMERCE',
        original_file_path: `models/${name}.sql`,
        columns: { id: { name: 'id' } },
        depends_on: { nodes: [] },
        tags: [],
      }];
    }));
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: {
        ...nodes,
        'model.shop.ephemeral_helper': {
          unique_id: 'model.shop.ephemeral_helper', resource_type: 'model', name: 'ephemeral_helper',
          config: { materialized: 'ephemeral' }, original_file_path: 'models/ephemeral_helper.sql',
          columns: {}, depends_on: { nodes: [] }, tags: [],
        },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    }));
    const executeQuery = vi.fn(async () => {
      throw new Error('A dbt-scoped catalog must not scan the warehouse');
    });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery } as unknown as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const generic = await (await fetch(`${base}/api/modeling/dbt-first/inventory?limit=25`)).json() as {
        total: number;
        scope?: string;
      };
      expect(generic).toMatchObject({ total: 61 });
      expect(generic.scope).toBeUndefined();

      const first = await (await fetch(`${base}/api/modeling/dbt-first/inventory?physicalOnly=true&limit=25`)).json() as {
        items: Array<{ uniqueId: string; relation: string }>;
        total: number;
        nextCursor: number | null;
        scope: string;
      };
      expect(first).toMatchObject({ total: 60, nextCursor: 25, scope: 'dbt_relations' });
      expect(first.items).toHaveLength(25);
      expect(first.items.every((item) => item.relation.startsWith('ANALYTICS.COMMERCE.'))).toBe(true);

      const late = await (await fetch(`${base}/api/modeling/dbt-first/inventory?physicalOnly=true&q=model_059&limit=25`)).json() as {
        items: Array<{ uniqueId: string }>;
        total: number;
        nextCursor: number | null;
      };
      expect(late).toEqual(expect.objectContaining({
        total: 1,
        nextCursor: null,
        items: [expect.objectContaining({ uniqueId: 'model.shop.model_059' })],
      }));

      const catalog = await (await fetch(`${base}/api/block-studio/catalog?includeSemantic=false`)).json() as {
        databaseTree: Array<{ children?: unknown[] }>;
      };
      expect(catalog.databaseTree.flatMap((schema) => schema.children ?? [])).toHaveLength(25);
      expect(executeQuery).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('builds the Block Studio tree from dbt relations only (CTX-005, PERF-001)', () => {
    const tree = buildDbtDatabaseSchemaTree({
      dbtProvenance: {
        manifestPath: 'target/manifest.json', manifestFingerprint: 'manifest', metricFlow: {},
        nodes: {
          'model.shop.orders': {
            uniqueId: 'model.shop.orders', resourceType: 'model', name: 'orders',
            relation: 'ANALYTICS.COMMERCE.ORDERS', identityFingerprint: 'orders',
            available: { description: false, columns: true, tests: false, catalogTypes: false, dqlMeta: false },
          },
          'model.shop.ephemeral': {
            uniqueId: 'model.shop.ephemeral', resourceType: 'model', name: 'ephemeral', identityFingerprint: 'ephemeral',
            relation: 'ANALYTICS.COMMERCE.EPHEMERAL',
            available: { description: false, columns: false, tests: false, catalogTypes: false, dqlMeta: false },
          },
        },
      },
    } as unknown as import('@duckcodeailabs/dql-core').DQLManifest, 25, new Set(['model.shop.orders']));

    expect(tree).toEqual([expect.objectContaining({
      label: 'ANALYTICS.COMMERCE',
      children: [expect.objectContaining({ label: 'ORDERS', path: 'ANALYTICS.COMMERCE.ORDERS', type: 'DBT_MODEL', children: [] })],
    })]);
    expect(schemaColumnsFromDescribeRows([
      { name: 'ORDER_ID', type: 'NUMBER' },
      { COLUMN_NAME: 'CREATED_AT', DATA_TYPE: 'TIMESTAMP_NTZ' },
    ])).toEqual([
      { name: 'ORDER_ID', type: 'NUMBER' },
      { name: 'CREATED_AT', type: 'TIMESTAMP_NTZ' },
    ]);
    expect(splitQualifiedRelationIdentifier('"ANALYTICS"."sales"."Order Facts"')).toEqual([
      'ANALYTICS', 'sales', 'Order Facts',
    ]);
    expect(splitQualifiedRelationIdentifier('ANALYTICS.COMMERCE.ORDERS; DROP TABLE USERS')).toBeNull();
  });

  it('reports disabled modeling separately from a missing dbt manifest (CFG-003, UI-007, E2E-003)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-studio-disabled-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'workspace',
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const response = await fetch(`http://127.0.0.1:${port}/api/modeling/dbt-first`);
      expect(response.status).toBe(404);
      const body = await response.json() as { code: string; details: { manifestVersion: number; modelingMode: string | null } };
      expect(body).toMatchObject({
        code: 'DBT_FIRST_NOT_ENABLED',
        details: { manifestVersion: 2, modelingMode: null },
      });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('reports a missing compiled dbt artifact when dbt-first modeling is enabled (CFG-003, UI-007, E2E-003)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-studio-missing-manifest-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'workspace',
      manifestVersion: 3,
      modeling: { mode: 'dbt-first' },
      dbt: { projectDir: '.', manifestPath: 'build/manifest.json' },
    }));
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: workspace\nprofile: workspace\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const response = await fetch(`http://127.0.0.1:${port}/api/modeling/dbt-first`);
      expect(response.status).toBe(409);
      const body = await response.json() as { code: string; details: { manifestPath: string }; nextActions: string[] };
      expect(body).toMatchObject({
        code: 'DBT_MANIFEST_NOT_FOUND',
        details: { manifestPath: 'build/manifest.json' },
      });
      expect(body.nextActions[0]).toContain('dbt parse');
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('reports an unreadable dbt artifact as a load failure, not a setup failure (CFG-003, UI-007, E2E-003)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-studio-invalid-manifest-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'workspace',
      manifestVersion: 3,
      modeling: { mode: 'dbt-first' },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    }));
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: workspace\nprofile: workspace\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), '{ invalid json');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const response = await fetch(`http://127.0.0.1:${port}/api/modeling/dbt-first`);
      expect(response.status).toBe(422);
      const body = await response.json() as { code: string; message: string };
      expect(body.code).toBe('DBT_MANIFEST_COMPILE_FAILED');
      expect(body.message).not.toContain('not enabled');
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('previews, drift-checks, and applies dbt-first config without copying dbt semantics', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-onboarding-dbt-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop',
      connections: { warehouse: { driver: 'duckdb', filepath: ':memory:' } },
      defaultConnectionName: 'warehouse',
      aiProviders: { default: 'ollama', ollama: { model: 'qwen-test' } },
    }));
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: shop\nversion: 1\n');
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ metadata: { project_name: 'shop' }, nodes: { 'model.shop.orders': { resource_type: 'model', name: 'orders' } }, sources: {}, metrics: {} }));
    writeFileSync(join(projectRoot, 'target', 'semantic_manifest.json'), JSON.stringify({
      semantic_models: [{
        name: 'orders',
        model: "ref('orders')",
        measures: [{ name: 'order_revenue', agg: 'sum', expr: 'revenue' }],
      }],
      metrics: [
        { name: 'total_order_revenue', type: 'simple', type_params: { measure: { name: 'order_revenue' } } },
        { name: 'revenue_growth', type: 'derived', type_params: { expr: 'total_order_revenue', metrics: [{ name: 'total_order_revenue' }] } },
      ],
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, connection: { driver: 'file' }, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const previewResponse = await fetch(`${base}/api/onboarding/dbt/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: '.', manifestPath: 'target/manifest.json' }) });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { requestId: string; fingerprint: string; counts: { models: number } };
      expect(preview.requestId).toMatch(/^onboarding-dbt-preview-/);
      expect(preview.counts.models).toBe(1);

      writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}\n`);
      const staleApply = await fetch(`${base}/api/onboarding/dbt/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: '.', manifestPath: 'target/manifest.json', fingerprint: preview.fingerprint }) });
      expect(staleApply.status).toBe(409);
      const staleResult = await staleApply.json() as { requestId: string; code: string };
      expect(staleResult.requestId).toMatch(/^onboarding-dbt-apply-/);
      expect(staleResult.code).toBe('SOURCE_CHANGED');

      const freshPreview = await (await fetch(`${base}/api/onboarding/dbt/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: '.', manifestPath: 'target/manifest.json' }) })).json() as { fingerprint: string };
      const applyResponse = await fetch(`${base}/api/onboarding/dbt/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: '.', manifestPath: 'target/manifest.json', fingerprint: freshPreview.fingerprint }) });
      expect(applyResponse.status).toBe(200);
      const applied = await applyResponse.json() as {
        jobId: string;
        snapshotId: string;
        status: string;
        stage: string;
        progress: number;
        phases: Array<{ id: string; status: string; durationMs?: number }>;
      };
      expect(applied).toMatchObject({
        jobId: expect.stringMatching(/^dbt-prepare-/),
        snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'running',
        stage: 'indexing',
        progress: 65,
        phases: [
          { id: 'artifact_validation', status: 'completed', durationMs: expect.any(Number) },
          { id: 'snapshot_compile', status: 'completed', durationMs: expect.any(Number) },
          { id: 'search_index', status: 'running' },
        ],
      });
      let preparation: any = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        preparation = await (await fetch(`${base}/api/onboarding/jobs/${applied.jobId}`)).json();
        if (preparation.status === 'completed' || preparation.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(preparation).toMatchObject({
        status: 'completed',
        stage: 'ready',
        progress: 100,
        snapshotId: applied.snapshotId,
        result: {
          snapshotId: applied.snapshotId,
          objectCount: expect.any(Number),
          metadataFingerprint: expect.any(String),
          kgFingerprint: expect.any(String),
          phaseDurationsMs: {
            artifactValidation: expect.any(Number),
            snapshotCompile: expect.any(Number),
            searchIndex: expect.any(Number),
            total: expect.any(Number),
          },
        },
      });
      expect(existsSync(join(projectRoot, '.dql', 'cache', 'agent-kg.sqlite'))).toBe(true);
      expect(existsSync(join(projectRoot, '.dql', 'cache', 'metadata.sqlite'))).toBe(true);
      const config = JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8')) as any;
      expect(config).toMatchObject({ manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' }, semanticLayer: { provider: 'dbt' } });
      expect(config.connections).toEqual({ warehouse: { driver: 'duckdb', filepath: ':memory:' } });
      expect(config.aiProviders).toEqual({ default: 'ollama', ollama: { model: 'qwen-test' } });
      expect(existsSync(join(projectRoot, 'semantic-layer'))).toBe(false);
      const semanticLayer = await (await fetch(`${base}/api/semantic-layer`)).json() as {
        provider: string;
        metrics: Array<{ name: string; execution?: { status: string; engine: string | null; reason: string | null } }>;
      };
      expect(semanticLayer.provider).toBe('dbt');
      expect(semanticLayer.metrics.map((metric) => metric.name)).toContain('total_order_revenue');
      expect(semanticLayer.metrics.find((metric) => metric.name === 'total_order_revenue')?.execution).toEqual({
        status: 'ready',
        engine: 'native',
        reason: null,
      });
      expect(semanticLayer.metrics.find((metric) => metric.name === 'revenue_growth')?.execution).toEqual({
        status: 'requires_setup',
        engine: null,
        reason: expect.stringContaining('requires a full semantic runtime'),
      });
      const installer = await (await fetch(`${base}/api/semantic-runtime/metricflow/installer`)).json() as {
        recommendedAdapter: string;
        supportedAdapters: string[];
        projectConfigured: boolean;
        semanticManifestFound: boolean;
        job: unknown;
      };
      expect(installer).toMatchObject({
        recommendedAdapter: 'duckdb',
        projectConfigured: true,
        semanticManifestFound: true,
        job: null,
      });
      expect(installer.supportedAdapters).toContain('snowflake');
      const invalidInstaller = await fetch(`${base}/api/semantic-runtime/metricflow/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adapter: 'mssql' }),
      });
      expect(invalidInstaller.status).toBe(400);
      await expect(invalidInstaller.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('supported warehouse adapter') });
      const status = await (await fetch(`${base}/api/onboarding/status`)).json() as { requestId: string; snapshotId: string; modeling: { enabled: boolean; snapshotState: string }; preparation: { id: string; status: string } };
      expect(status.requestId).toMatch(/^onboarding-status-/);
      expect(status.snapshotId).toMatch(/^[a-f0-9]{64}$/);
      expect(status.modeling).toMatchObject({ enabled: true, snapshotState: 'ready' });
      expect(status.preparation).toMatchObject({ id: applied.jobId, status: 'completed' });
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('discovers evidence-cited domains, previews without writes, and applies only draft declarations', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-onboarding-domains-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop',
      manifestVersion: 3,
      modeling: { mode: 'dbt-first' },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    }));
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: shop\nversion: 1\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: {
        'model.shop.orders': {
          resource_type: 'model',
          name: 'orders',
          original_file_path: 'models/commerce/orders.sql',
          meta: { dql: { domain: 'commerce' } },
          depends_on: { nodes: [] },
          tags: [],
        },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const discovery = await (await fetch(`${base}/api/onboarding/domains/discover`, { method: 'POST' })).json() as {
        requestId: string;
        snapshotId: string;
        sourceFingerprint: string;
        proposals: Array<{ id: string; requiresReview: boolean }>;
      };
      expect(discovery.requestId).toMatch(/^domain-discovery-/);
      expect(discovery.snapshotId).toMatch(/^[a-f0-9]{64}$/);
      expect(discovery.proposals).toContainEqual(expect.objectContaining({ id: 'commerce', requiresReview: true }));

      const preview = await (await fetch(`${base}/api/onboarding/domains/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSourceFingerprint: discovery.sourceFingerprint, selectedDomains: ['commerce'], mode: 'preview' }),
      })).json() as { applied: boolean; preview: Array<{ path: string }> };
      expect(preview).toMatchObject({ applied: false, preview: [{ path: 'domains/commerce/domain.dql' }] });
      expect(existsSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'))).toBe(false);

      const apply = await (await fetch(`${base}/api/onboarding/domains/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSourceFingerprint: discovery.sourceFingerprint, selectedDomains: ['commerce'] }),
      })).json() as { applied: boolean; results: Array<{ status: string }> };
      expect(apply).toMatchObject({ applied: true, results: [{ status: 'created' }] });
      expect(readFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'utf8')).toContain('Draft domain boundary');
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('returns snapshot-guarded structured errors and applies dbt YAML source patches', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-modeling-source-patch-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    mkdirSync(join(projectRoot, 'models'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'commerce'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    }));
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: shop\nversion: 1\n');
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" { id = "commerce" }\n');
    writeFileSync(join(projectRoot, 'models', 'orders.yml'), 'version: 2\nmodels:\n  - name: orders\n    description: Old\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: {
        'model.shop.orders': {
          unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders',
          original_file_path: 'models/orders.sql', patch_path: 'shop://models/orders.yml',
          columns: { order_id: {} }, depends_on: { nodes: [] }, tags: [],
        },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { requestId: string; snapshotId: string };
      expect(modeling.requestId).toMatch(/^modeling-dbt-first-/);
      expect(modeling.snapshotId).toMatch(/^[a-f0-9]{64}$/);

      const stale = await fetch(`${base}/api/modeling/dbt-first/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSnapshotId: 'stale', change: { operation: 'upsert_entity', value: { id: 'order', domain: 'commerce', dbtModel: 'model.shop.orders' } } }),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: 'SOURCE_CHANGED', recoverable: true, snapshotId: modeling.snapshotId, message: expect.any(String), nextActions: expect.any(Array) });

      const change = { uniqueId: 'model.shop.orders', description: 'One row per order.', columns: [{ name: 'order_id', tests: ['unique', 'not_null'] }] };
      const previewResponse = await fetch(`${base}/api/modeling/dbt-first/dbt-source/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change, expectedSnapshotId: modeling.snapshotId }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { snapshotId: string; fingerprint: string; patch: { path: string; after: string } };
      expect(preview.patch.path).toBe('models/orders.yml');
      expect(preview.patch.after).toContain('data_tests:');
      const applyResponse = await fetch(`${base}/api/modeling/dbt-first/dbt-source/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ change, expectedSnapshotId: preview.snapshotId, expectedFingerprint: preview.fingerprint }),
      });
      expect(applyResponse.status).toBe(200);
      expect(readFileSync(join(projectRoot, 'models', 'orders.yml'), 'utf8')).toContain('One row per order.');
      expect(existsSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'model.dql.yaml'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('dbt-first semantic ownership runtime guard', () => {
  it('rejects local metric and semantic-block writes while preserving custom blocks', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-first-semantic-guard-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop',
      manifestVersion: 3,
      modeling: { mode: 'dbt-first' },
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const metric = await fetch(`${base}/api/semantic-layer/metric`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'gross_revenue', sql: 'sum(revenue)', type: 'sum', table: 'orders' }),
      });
      expect(metric.status).toBe(409);
      expect(await metric.json()).toMatchObject({ code: 'DQL_MODELING_DBT_OWNED' });

      const semanticBlock = await fetch(`${base}/api/blocks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Duplicate Revenue', domain: 'commerce', blockType: 'semantic' }),
      });
      expect(semanticBlock.status).toBe(409);
      expect(await semanticBlock.json()).toMatchObject({ code: 'DQL_MODELING_DBT_OWNED' });

      const customBlock = await fetch(`${base}/api/blocks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Reviewed Revenue Query', domain: 'commerce', blockType: 'custom', content: 'SELECT 1 AS revenue' }),
      });
      expect(customBlock.status).toBe(201);
      expect(existsSync(join(projectRoot, 'blocks', 'commerce', 'reviewed-revenue-query.dql'))).toBe(true);
      expect(existsSync(join(projectRoot, 'semantic-layer', 'metrics'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('domain Related Products backlinks', () => {
  it('derives both domain counts from global App and Notebook ProductDomainContext', async () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/dbt-first-commerce');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const allRelated = await (await fetch(`${base}/api/domain-workspaces/related-products`)).json() as {
        domain: string | null;
        apps: Array<Record<string, unknown>>;
        notebooks: Array<Record<string, unknown>>;
      };
      expect(allRelated.domain).toBeNull();
      expect(allRelated.apps).toContainEqual(expect.objectContaining({ id: 'growth-revenue' }));
      expect(allRelated.notebooks).toContainEqual(expect.objectContaining({
        id: 'notebooks/revenue-acquisition-research.dqlnb',
      }));
      for (const domain of ['growth', 'commerce']) {
        const related = await (await fetch(`${base}/api/domain-workspaces/${domain}/related-products`)).json() as {
          apps: Array<Record<string, unknown>>;
          notebooks: Array<Record<string, unknown>>;
        };
        expect(related.apps).toContainEqual(expect.objectContaining({
          id: 'growth-revenue',
          filePath: 'apps/growth-revenue',
          ownerDomain: 'growth',
          usesDomains: ['growth', 'commerce'],
          requiredExports: ['commerce.customer_identity@1', 'commerce.order_analytics@1'],
        }));
        expect(related.notebooks).toContainEqual(expect.objectContaining({
          id: 'notebooks/revenue-acquisition-research.dqlnb',
          ownerDomain: 'growth',
          usesDomains: ['growth', 'commerce'],
        }));
        const workspace = await (await fetch(`${base}/api/domain-workspaces/${domain}`)).json() as { counts: { relatedProducts: number } };
        expect(workspace.counts.relatedProducts).toBe(2);
      }
    } finally {
      await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
    }
  });

  it('serves the compiler-owned capsule and qualified Business 360 neighborhood', async () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/dbt-first-commerce');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}/api/domain-workspaces/growth/knowledge`);
      expect(response.status).toBe(200);
      const knowledge = await response.json() as {
        snapshotId: string;
        sourceFingerprint: string;
        capsule: { skillRefs: string[] };
        counts: { routeStates: Record<string, number> };
        routes: Array<{ state: string; relationshipId: string }>;
      };
      expect(knowledge.snapshotId).toMatch(/^[a-f0-9]{64}$/);
      expect(knowledge.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(knowledge.capsule.skillRefs).toContain('growth::skill::acquisition_analysis');
      expect(knowledge.counts.routeStates).toMatchObject({ authorized: 1, blocked: 1 });

      const relationshipId = 'growth::relationship::acquisition_to_customer';
      const business360Response = await fetch(`${base}/api/lineage/business-360/${encodeURIComponent(relationshipId)}`);
      expect(business360Response.status).toBe(200);
      const business360 = await business360Response.json() as { knowledge: { focus: { id: string }; routes: Array<{ state: string }> } };
      expect(business360.knowledge.focus.id).toBe(relationshipId);
      expect(business360.knowledge.routes.some((route) => route.state === 'authorized')).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
    }
  });
});

describe('global Notebook ProductDomainContext authoring (UI-001, PRD-001)', () => {
  it('keeps the file global while recording a validated domain backlink', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-notebook-create-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const domainRoot = join(projectRoot, 'domains', 'commerce');
    mkdirSync(domainRoot, { recursive: true });
    writeFileSync(join(domainRoot, 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}/api/notebooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Customer Research',
          template: 'analysis',
          ownerDomain: 'commerce',
          usesDomains: ['commerce'],
        }),
      });
      expect(response.status).toBe(201);
      const created = await response.json() as { path: string };
      expect(created.path).toBe('notebooks/customer_research.dqlnb');
      const document = JSON.parse(readFileSync(join(projectRoot, created.path), 'utf-8')) as {
        metadata: { ownerDomain?: string; usesDomains?: string[]; requiredExports?: string[] };
      };
      expect(document.metadata).toMatchObject({
        ownerDomain: 'commerce',
        usesDomains: ['commerce'],
        requiredExports: [],
      });
      expect(existsSync(join(projectRoot, 'domains', 'commerce', 'notebooks', 'customer_research.dqlnb'))).toBe(false);

      const listed = await fetch(`${base}/api/notebooks`).then((listing) => listing.json()) as Array<{
        path: string;
        ownerDomain?: string;
        usesDomains?: string[];
      }>;
      expect(listed).toContainEqual(expect.objectContaining({
        path: 'notebooks/customer_research.dqlnb',
        ownerDomain: 'commerce',
        usesDomains: ['commerce'],
      }));

      const rejected = await fetch(`${base}/api/notebooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Unknown Domain', template: 'blank', ownerDomain: 'missing' }),
      });
      expect(rejected.status).toBe(400);
    } finally {
      await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
    }
  });
});

describe('exploratory result contracts', () => {
  it('EXP-003 enforces the planned overall top-N before exploratory execution', () => {
    expect(applyRequestedTopNToExploratorySql(
      'SELECT customer_name, spend FROM customers ORDER BY spend DESC LIMIT 100',
      10,
    )).toBe('SELECT customer_name, spend FROM customers ORDER BY spend DESC LIMIT 10');
    expect(applyRequestedTopNToExploratorySql(
      'SELECT customer_name, spend FROM customers ORDER BY spend DESC;',
      5,
    )).toBe('SELECT customer_name, spend FROM customers ORDER BY spend DESC\nLIMIT 5');
  });
});

describe('agent run runtime API', () => {
  it('summarizes the latest substantive turn instead of a prior recap turn', () => {
    const recap = buildConversationContextRecap({
      activeTurnId: 'turn-recap',
      turns: [
        {
          id: 'turn-data',
          question: 'what region has most revenue',
          answerSummary: 'Philadelphia has the highest revenue at $425,467.00.',
          route: 'semantic_answer',
          result: {
            columns: ['location_name', 'revenue'],
            rowsSample: [['Philadelphia', 425467]],
            dimensionValues: { location_name: ['Philadelphia', 'Brooklyn'] },
          },
        },
        {
          id: 'turn-recap',
          question: 'what we are reviewing in this chat',
          answerSummary: 'We were reviewing regional revenue.',
          route: 'conversation',
        },
      ],
    });

    expect(recap).toContain('what region has most revenue');
    expect(recap).toContain('Philadelphia has the highest revenue');
    expect(recap).toContain('location_name=Philadelphia');
    expect(recap).not.toContain('what we are reviewing in this chat');
  });

  it('explains the latest answer grain without rerunning or using a recap turn', () => {
    const context = {
      activeTurnId: 'turn-recap',
      turns: [
        {
          id: 'turn-data',
          question: 'show top customers by revenue',
          answerSummary: 'Here are the top customers.',
          route: 'semantic_answer',
          requestedMeasures: ['total_revenue'],
          requestedDimensions: ['customer_name'],
          dqlArtifact: {
            source: 'block "top_customers" {}',
            name: 'top_customers',
            metrics: ['total_revenue'],
            dimensions: ['customer_name'],
            filters: [{ dimension: 'status', operator: 'equals', values: ['completed'] }],
            timeDimension: { name: 'order_date', granularity: 'month' },
          },
          result: {
            columns: ['order_date', 'customer_name', 'total_revenue'],
            rowsSample: [['2026-01-01', 'Melissa Lopez', 4200]],
          },
        },
        {
          id: 'turn-recap',
          question: 'what are we discussing?',
          answerSummary: 'We are discussing customer revenue.',
          route: 'conversation',
        },
      ],
    };

    const explanation = buildPriorAnswerExplanation('is it monthly or daily revenue?', context);
    expect(explanation).toContain('monthly grain');
    expect(explanation).toContain('order date');
    expect(explanation).toContain('status equals completed');
    expect(explanation).not.toContain('what are we discussing');
  });

  it('fails closed when the prior answer does not declare a time grain', () => {
    const explanation = buildPriorAnswerExplanation('what period does this result cover?', {
      activeTurnId: 'turn-data',
      turns: [{
        id: 'turn-data',
        question: 'show top customers by revenue',
        route: 'generated_answer',
        dqlArtifact: {
          source: 'block "top_customers" {}',
          metrics: ['total_revenue'],
          dimensions: ['customer_name'],
        },
      }],
    });

    expect(explanation).toContain('does not declare a daily or monthly time grain');
    expect(explanation).toContain('ask me to show or group it that way');
  });

  it('AGT-012 retains the result-row sample for member values and cross-result compute', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      product_name: index === 9 ? 'flame impala' : 'product_' + index,
      location_name: 'Philadelphia',
      revenue: 100 - index,
    }));
    const turn = conversationTurnInputFromRun({
      id: 'run_member_memory',
      question: 'top products by region',
      status: 'completed',
      route: 'generated_answer',
      trustState: 'review_required',
      artifacts: [{
        kind: 'answer',
        payload: {
          result: {
            columns: ['product_name', 'location_name', 'revenue'],
            rows,
            rowCount: 10,
          },
        },
      }],
      evaluations: [],
      nextActions: [],
    } as any);

    // The sample now retains the full bounded window (up to 50) so a
    // cross-result follow-up can compute over the shown rows.
    expect(turn.agentRunId).toBe('run_member_memory');
    expect(turn.result?.rowsSample).toHaveLength(10);
    expect(turn.result?.dimensionValues?.product_name).toContain('flame impala');
  });

  it('does not persist blocked result prose or rows into conversation context', () => {
    const turn = conversationTurnInputFromRun({
      id: 'run_invalid_result',
      question: 'food revenue percentage',
      status: 'blocked',
      route: 'semantic_answer',
      trustState: 'blocked',
      stopReason: 'blocked',
      summary: 'The semantic result did not satisfy the frozen output contract.',
      answer: 'The semantic result did not satisfy the frozen output contract.',
      artifacts: [{
        id: 'invalid-result-diagnostic',
        kind: 'answer',
        title: 'Invalid result diagnostic',
        trustState: 'blocked',
        payload: {
          result: {
            columns: ['secret'],
            rows: [{ secret: 'INVALID_ROW_MUST_DISCARD' }],
            rowCount: 1,
          },
        },
      }],
      evaluations: [],
      nextActions: [],
    } as any);

    expect(turn.answerSummary).toBe('The semantic result did not satisfy the frozen output contract.');
    expect(turn.answerText).toBe('The semantic result did not satisfy the frozen output contract.');
    expect(turn.result).toBeUndefined();
    expect(JSON.stringify(turn)).not.toContain('INVALID_ROW_MUST_DISCARD');
  });

  it('UI-010 classifies governed SQL execution errors as failed outcomes', () => {
    expect(agentAnswerHasExecutionFailure({ executionError: 'DuckDB lock conflict' })).toBe(true);
    expect(agentAnswerHasExecutionFailure({ executionError: '   ' })).toBe(false);
    expect(agentAnswerHasExecutionFailure({})).toBe(false);
  });

  it('AGT-010 derives governed semantic trust only from a passed exact aggregation proof', () => {
    const semanticRoute = { tier: 'semantic_metric' } as any;
    const proof: Omit<AggregationSafetyProofV1, 'status'> = {
      version: 1,
      metricIds: ['order_item.revenue'],
      metricProvenanceFingerprints: ['metric-fingerprint'],
      nativeGrain: ['order_item'],
      requestedGrain: ['order_item'],
      additivity: 'additive',
      joinCardinalities: [],
      fanout: 'proven_absent',
      rounding: 'none',
      issueCodes: [],
      correctionCodes: [],
      sqlFingerprint: 'sql-fingerprint',
      planFingerprint: 'plan-fingerprint',
      evidenceFingerprint: 'evidence-fingerprint',
    };

    expect(semanticAnswerHasPassedAggregationProof({
      route: semanticRoute,
      aggregationSafetyProof: { ...proof, status: 'safe' },
    })).toBe(true);
    expect(semanticAnswerHasPassedAggregationProof({
      route: semanticRoute,
      aggregationSafetyProof: {
        ...proof,
        status: 'blocked',
        additivity: 'unknown',
        fanout: 'unknown',
        issueCodes: ['ADDITIVITY_EVIDENCE_MISSING'],
      },
    })).toBe(false);
    expect(semanticAnswerHasPassedAggregationProof({ route: semanticRoute })).toBe(false);
  });

  it('API-007 retains failed analytical plan, DQL, SQL, and stable diagnostics for repair', () => {
    const dqlSource = 'block "revenue" { metric = "revenue" }';
    const sql = 'select sum(revenue) as revenue from analytics.orders';
    const failure = createAnalyticalFailure({
      code: 'PERMISSION_DENIED',
      phase: 'execution',
      snapshotId: 'snapshot-1',
      runId: 'analytical-run-1',
      planFingerprint: 'a'.repeat(64),
      dqlSource,
      compiledSql: sql,
    });
    const failedAgentRun = {
      id: 'agent-run-1',
      question: 'what is revenue?',
      status: 'blocked',
      stopReason: 'blocked',
      route: 'semantic_answer',
      trustState: 'blocked',
      artifacts: [{
        id: 'answer-1',
        kind: 'answer',
        title: 'Failed governed analytical run',
        trustState: 'blocked',
        payload: {
          resolvedAnalyticalPlan: { fingerprint: 'a'.repeat(64), recommendedRoute: 'semantic' },
          analyticalExecutionGraph: { route: 'semantic' },
          analyticalFailure: failure,
          dqlArtifact: {
            kind: 'semantic_block',
            source: dqlSource,
            metrics: ['revenue'],
            dimensions: [],
            trustState: 'governed',
            persistence: 'transient',
            compiledSql: sql,
          },
          sql,
        },
      }],
      evaluations: [],
      nextActions: [],
    } as unknown as Parameters<typeof analyticalFailedRunFromAgentRun>[0];
    const retained = analyticalFailedRunFromAgentRun(failedAgentRun);
    expect(retained).toMatchObject({
      runId: 'analytical-run-1',
      snapshotId: 'snapshot-1',
      route: 'semantic',
      trustState: 'governed',
      planFingerprint: 'a'.repeat(64),
      dqlSource,
      compiledSql: sql,
      failure: { code: 'PERMISSION_DENIED' },
    });

    const turn = conversationTurnInputFromRun(failedAgentRun as Parameters<typeof conversationTurnInputFromRun>[0]);
    expect(turn).toMatchObject({
      agentRunId: 'agent-run-1',
      question: 'what is revenue?',
      runStatus: 'blocked',
      stopReason: 'blocked',
      sql,
      dqlArtifact: {
        kind: 'semantic_block',
        source: dqlSource,
        metrics: ['revenue'],
        dimensions: [],
        trustState: 'governed',
        persistence: 'transient',
        compiledSql: sql,
      },
    });
  });

  it('preserves conversation context when parsing governed agent run requests', () => {
    const parsed = parseAgentRunRequestBody({
      question: 'who are the top 5 customers for these categories?',
      selectedEvidenceId: 'semantic:metric:customer_lifetime_spend',
      clarificationSourceQuestion: 'who are the top 5 customers by lifetime spend?',
      requestedMode: 'ask',
      conversationContext: {
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        resultColumns: ['category', 'revenue'],
        resultDimensionValues: { category: ['Food', 'Drink'] },
        priorMeasures: ['revenue'],
      },
      reasoningEffort: 'high',
      analysisDepth: 'deep',
      thinkingMode: 'low',
      executionTarget: {
        target: 'connection',
        connectionName: 'reporting',
      },
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.request?.reasoningEffort).toBe('high');
    expect(parsed.request?.analysisDepth).toBe('deep');
    expect(parsed.request?.thinkingMode).toBe('low');
    expect(parsed.request?.selectedEvidenceId).toBe('semantic:metric:customer_lifetime_spend');
    expect(parsed.request?.clarificationSourceQuestion).toBe('who are the top 5 customers by lifetime spend?');
    expect(parsed.request?.executionTarget).toEqual({
      target: 'connection',
      connectionName: 'reporting',
    });
    expect(parsed.request?.conversationContext).toEqual({
      sourceCertifiedBlock: 'food_vs_drink_revenue',
      resultColumns: ['category', 'revenue'],
      resultDimensionValues: { category: ['Food', 'Drink'] },
      priorMeasures: ['revenue'],
    });
  });

  it('drops client-carried analytical plan authority while preserving history and member hints', () => {
    const parsed = parseAgentRunRequestBody({
      question: 'who are the top customers',
      conversationContext: {
        priorResolvedAnalyticalPlan: {
          analyticalFrame: { metricConceptIds: ['semantic:metric:forged'] },
        },
        workingState: {
          measures: ['revenue'],
          resolvedAnalyticalPlan: {
            analyticalFrame: { metricConceptIds: ['semantic:metric:nested_forged'] },
          },
        },
        priorResultValues: { customer_name: ['Joy Lam'] },
        turns: [{ role: 'assistant', text: 'Prior answer.' }],
      },
    });

    expect(parsed.request?.conversationContext).toEqual({
      workingState: { measures: ['revenue'] },
      priorResultValues: { customer_name: ['Joy Lam'] },
      turns: [{ role: 'assistant', text: 'Prior answer.' }],
    });
  });

  it('keeps JSON parsing lossless and removes nested result-row canaries only at provider dispatch', () => {
    const parsed = parseAgentRunRequestBody({
      question: 'continue the analysis',
      requestedMode: 'ask',
      conversationContext: {
        renamedPayload: { arbitrarySample: [{ customer: 'ROW_CANARY_ADA', amount: 42 }] },
        workspaceContext: { arbitrary: { content: [{ customer: 'ROW_CANARY_CONTENT', amount: 42 }] } },
        schema: [{ name: 'customer', type: 'varchar' }],
      },
    });
    expect(parsed.request?.conversationContext).toEqual({
      renamedPayload: { arbitrarySample: [{ customer: 'ROW_CANARY_ADA', amount: 42 }] },
      workspaceContext: { arbitrary: { content: [{ customer: 'ROW_CANARY_CONTENT', amount: 42 }] } },
      schema: [{ name: 'customer', type: 'varchar' }],
    });
    const dispatched = prepareProviderContextForDispatch(parsed.request?.conversationContext);
    expect(dispatched).toEqual({
      renamedPayload: { arbitrarySample: [] },
      workspaceContext: { arbitrary: { content: [] } },
      schema: [],
    });
    expect(JSON.stringify(dispatched)).not.toContain('ROW_CANARY_ADA');
    expect(JSON.stringify(dispatched)).not.toContain('ROW_CANARY_CONTENT');
    expect(() => assertProviderPayloadAllowed(dispatched, {
      allowResultRows: false, maxResultRows: 0, purpose: 'answer_generation',
    })).not.toThrow();
  });

  it('preserves every authoring mode so Modeling and Skills AI reach their own routes', () => {
    // Regression: the runtime whitelist was a strict subset of
    // `AgentRunRequestedMode` — it omitted 'modeling' and 'skill'. A
    // `Set<AgentRunRequestedMode>` accepts a subset, so this never failed to
    // compile. The parser dropped the mode to `undefined`, `selectRoute` saw no
    // explicit mode, and Modeling's "Build with AI" silently ran the governed
    // answer loop, returning an Ask-AI analytical answer instead of a proposal.
    for (const mode of ['auto', 'ask', 'research', 'sql', 'block', 'app', 'modeling', 'skill'] as const) {
      const parsed = parseAgentRunRequestBody({ question: 'model the customer profile', requestedMode: mode });
      expect(parsed.error).toBeUndefined();
      expect(parsed.request?.requestedMode).toBe(mode);
    }

    expect(parseAgentRunRequestBody({ question: 'q', requestedMode: 'nonsense' }).request?.requestedMode).toBeUndefined();
  });

  it('keeps Research result-row consent explicit, Research-only, and per run', () => {
    expect(parseAgentRunRequestBody({ question: 'research this', requestedMode: 'research' }).request)
      .toMatchObject({ researchResultRowsOptIn: false });
    expect(parseAgentRunRequestBody({
      question: 'research this',
      requestedMode: 'research',
      researchResultRowsOptIn: true,
    }).request).toMatchObject({ researchResultRowsOptIn: true });
    expect(parseAgentRunRequestBody({ question: 'research again', requestedMode: 'research' }).request)
      .toMatchObject({ researchResultRowsOptIn: false });
    expect(parseAgentRunRequestBody({
      question: 'ordinary ask',
      requestedMode: 'ask',
      researchResultRowsOptIn: true,
    })).toMatchObject({ error: expect.stringMatching(/Research/i) });
  });

  it('ignores invalid governed agent run depth and reasoning values', () => {
    const parsed = parseAgentRunRequestBody({
      question: 'orders',
      reasoningEffort: 'maximum',
      analysisDepth: 'wide',
      thinkingMode: 'turbo',
      executionTarget: { target: 'unknown', connectionName: 'reporting' },
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.request?.reasoningEffort).toBeUndefined();
    expect(parsed.request?.analysisDepth).toBeUndefined();
    expect(parsed.request?.thinkingMode).toBeUndefined();
    expect(parsed.request?.executionTarget).toBeUndefined();
  });

  it('saves an answer block with an owner and returns either a certified block or a labelled draft', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-save-answer-block-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/blocks/save-from-cell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cellId: 'answer-1',
          name: 'Monthly revenue',
          owner: 'owner@example.com',
          content: 'block "AI answer" {\n  query = """\n    SELECT 1 AS revenue\n  """\n}',
        }),
      });
      expect(response.status).toBe(201);
      const saved = await response.json() as { path: string; content: string; status: string; blockers: string[] };
      expect(['certified', 'draft']).toContain(saved.status);
      expect(Array.isArray(saved.blockers)).toBe(true);
      expect(saved.content).toContain('block "Monthly revenue"');
      expect(saved.content).toContain('owner = "owner@example.com"');
      expect(readFileSync(join(projectRoot, saved.path), 'utf-8')).toContain(`status = "${saved.status}"`);
    } finally {
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    }
  });

  it('UI-016 keeps answer-to-Block AI generation write-free until explicit commit', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-ai-write-free-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Turn the governed answer into a reusable block',
          requestedMode: 'block',
          conversationContext: {
            dqlArtifact: {
              kind: 'semantic_block',
              name: 'revenue_and_orders',
              sourcePath: 'domains/finance/blocks/revenue_and_orders.dql',
              source: `block "revenue_and_orders" {
  type = "semantic"
  status = "certified"
  owner = "finance"
  metric = "revenue"
  dimensions = ["region"]
}`,
              metrics: ['revenue', 'order_count'],
              dimensions: ['region'],
              persistence: 'saved',
              trustState: 'certified',
              compiledSql: 'select region, sum(revenue), count(*) from orders group by region',
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const payload = await response.json() as { run: any };
      expect(payload.run.route).toBe('dql_block_draft');
      expect(payload.run.status).toBe('needs_review');
      const draft = payload.run.artifacts.find((artifact: any) => artifact.kind === 'dql_block_draft');
      expect(draft?.path).toBeUndefined();
      expect(draft?.payload?.path).toBeUndefined();
      expect(draft?.payload?.dqlArtifact).toMatchObject({
        metrics: ['revenue', 'order_count'],
        dimensions: ['region'],
        persistence: 'transient',
        trustState: 'review_required',
      });
      expect(draft?.payload?.dqlArtifact?.source).toContain('metrics = ["revenue", "order_count"]');
      expect(draft?.payload?.dqlArtifact?.source).not.toContain('owner = ');
      expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
      expect(existsSync(join(projectRoot, 'domains'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    }
  });

  it('uses deterministic presentation for ordinary DQL-first answers', () => {
    expect(shouldSynthesizeAgentRunAnswer({
      kind: 'uncertified',
      certification: 'ai_generated',
      text: 'Top products by value are ready for review.',
      result: { columns: ['product_name', 'revenue'], rows: [{ product_name: 'A', revenue: 10 }], rowCount: 1 },
      dqlArtifact: {
        kind: 'sql_block',
        name: 'top_products_by_value',
        source: 'block "top_products_by_value" { query = """select 1""" }',
      },
    })).toBe(false);
  });

  it('permits provider narration only for explicit Research', () => {
    expect(shouldSynthesizeAgentRunAnswer({
      kind: 'uncertified',
      certification: 'ai_generated',
      text: 'Draft answer',
    })).toBe(false);

    expect(shouldSynthesizeAgentRunAnswer({
      kind: 'certified',
      certification: 'certified',
      text: 'Certified answer',
    })).toBe(false);

    expect(shouldSynthesizeAgentRunAnswer({
      kind: 'certified',
      certification: 'certified',
      text: 'Answered by certified block top_customers.',
      result: { columns: ['customer_name', 'lifetime_spend'], rows: [{ customer_name: 'Matthew', lifetime_spend: 3000 }], rowCount: 1 },
    })).toBe(false);

    expect(shouldSynthesizeAgentRunAnswer({
      kind: 'no_answer',
      text: 'Need more context.',
    })).toBe(false);

    expect(shouldSynthesizeAgentRunAnswer({
      kind: 'uncertified',
      certification: 'analyst_review_required',
      text: 'Exploratory result at a declared grain.',
      exploratoryCandidate: {
        kind: 'dbt_grounded_exploration',
        reason: 'unbound_relation',
        sql: 'select 1',
        message: 'Missing modeled relationship coverage.',
        modeledEntityIds: [],
        relationshipIds: [],
        executionStatus: 'not_executed',
      },
    })).toBe(false);

    expect(shouldSynthesizeAgentRunAnswer({
      kind: 'uncertified',
      certification: 'analyst_review_required',
      text: 'QUERY PLAN: grain = one row per customer.',
      result: { columns: ['customer_name'], rows: [{ customer_name: 'Matthew' }], rowCount: 1 },
      exploratoryCandidate: {
        kind: 'dbt_grounded_exploration',
        reason: 'unbound_relation',
        sql: 'select 1',
        message: 'Missing modeled relationship coverage.',
        modeledEntityIds: [],
        relationshipIds: [],
        executionStatus: 'not_executed',
      },
    }, 'research')).toBe(true);
  });

  it('API-007 derives repairs through the HTTP API while permission denial stays terminal', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-analytical-repair-api-'));
    tempDirs.push(projectRoot);
    let server: Server | undefined;
    const dqlSource = 'block "revenue" { metric = "revenue" }';
    const sql = 'select sum(revenue) as revenue from analytics.orders';
    const failure = createAnalyticalFailure({
      code: 'PERMISSION_DENIED',
      phase: 'execution',
      snapshotId: 'snapshot-1',
      runId: 'analytical-run-1',
      planFingerprint: 'a'.repeat(64),
      dqlSource,
      compiledSql: sql,
    });
    const refreshFailure = createAnalyticalFailure({
      code: 'COLUMN_NOT_FOUND',
      phase: 'execution',
      snapshotId: 'stale-snapshot',
      runId: 'analytical-run-refresh',
      planFingerprint: 'c'.repeat(64),
      dqlSource,
      compiledSql: sql,
    });
    try {
      const failedAnswerExecutor = (context: { request: { question: string } }) => {
        const selectedFailure = context.request.question.includes('stale column') ? refreshFailure : failure;
        return ({
        summary: 'The selected route was denied.',
        answer: selectedFailure.message,
        status: 'blocked' as const,
        trustState: 'blocked' as const,
        stopReason: 'blocked' as const,
        artifacts: [{
          id: 'answer:failed',
          kind: 'answer' as const,
          title: 'Failed governed analytical run',
          trustState: 'blocked' as const,
          payload: {
            kind: 'no_answer',
            resolvedAnalyticalPlan: { fingerprint: selectedFailure.planFingerprint, recommendedRoute: 'semantic' },
            analyticalExecutionGraph: { route: 'semantic' },
            analyticalFailure: selectedFailure,
            dqlArtifact: { kind: 'semantic_block', source: dqlSource, trustState: 'governed' },
            sql,
          },
        }],
        evaluations: [],
        nextActions: [],
      });
      };
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
        agentRunExecutors: {
          conversation: failedAnswerExecutor,
          certified_answer: failedAnswerExecutor,
          semantic_answer: failedAnswerExecutor,
          generated_answer: failedAnswerExecutor,
          research: failedAnswerExecutor,
          clarify: failedAnswerExecutor,
          blocked: failedAnswerExecutor,
        },
      });
      const base = `http://127.0.0.1:${port}`;
      const createdResponse = await fetch(`${base}/api/agent-runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Revenue today?', requestedMode: 'ask' }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { run: Parameters<typeof analyticalFailedRunFromAgentRun>[0] };
      expect(analyticalFailedRunFromAgentRun(created.run)).toBeDefined();

      const forbidden = await fetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}/analytical-repair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repair: { version: 1, action: 'edit_dql', dqlSource } }),
      });
      expect(forbidden.status).toBe(403);

      const authorized = await fetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}/analytical-repair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repair: { version: 1, action: 'change_authorized_connection', authorizedConnectionFingerprint: 'b'.repeat(64) } }),
      });
      expect(authorized.status).toBe(201);
      await expect(authorized.json()).resolves.toMatchObject({
        status: 'ready',
        derivation: { action: 'change_authorized_connection', routeLocked: true, permissionsExpanded: false },
      });

      const refreshRunResponse = await fetch(`${base}/api/agent-runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Repair the stale column', requestedMode: 'ask' }),
      });
      const refreshRun = await refreshRunResponse.json() as { run: Parameters<typeof analyticalFailedRunFromAgentRun>[0] };
      expect(analyticalFailedRunFromAgentRun(refreshRun.run)?.failure.code).toBe('COLUMN_NOT_FOUND');
      const refreshed = await fetch(`${base}/api/agent-runs/${encodeURIComponent(refreshRun.run.id)}/analytical-repair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repair: { version: 1, action: 'refresh_snapshot' } }),
      });
      expect(refreshed.status).toBe(201);
      await expect(refreshed.json()).resolves.toMatchObject({
        status: 'ready',
        derivation: {
          action: 'refresh_snapshot',
          snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
          routeLocked: true,
          permissionsExpanded: false,
          requiresRecompile: true,
        },
      });
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('API-007 repairs only embedded SQL and preserves the immutable wrapper contract', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-executable-repair-api-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    saveProviderSettings(projectRoot, {
      id: 'openai', enabled: true, apiKey: 'sk-ask-sql-repair',
      baseUrl: 'https://ask-sql-repair.example.test/v1', model: 'repair-test',
    });
    let server: Server | undefined;
    const failedSql = 'SELECT order_id FROM main.orders WHERE order_id >= $1';
    const repairedSql = 'SELECT order_id FROM "main"."orders" WHERE order_id >= $1';
    const sourceDql = `block "Orders" {
  type = "custom"
  params { min_order_id: number = 1 }
  parameterPolicy { min_order_id = "dynamic" }
  query = """SELECT order_id FROM main.orders WHERE order_id >= \${min_order_id}"""
}`;
    const failure = createAnalyticalFailure({
      code: 'DIALECT_ERROR',
      phase: 'execution',
      snapshotId: 'snapshot-repair-sql',
      runId: 'failed-sql-repair',
      planFingerprint: 'd'.repeat(64),
      dqlSource: sourceDql,
      compiledSql: failedSql,
    });
    const failedAnswerExecutor = () => ({
      summary: 'The query could not be completed.',
      status: 'blocked' as const,
      trustState: 'blocked' as const,
      stopReason: 'blocked' as const,
      artifacts: [{
        id: 'answer:failed-source-id',
        kind: 'answer' as const,
        title: 'Failed analytical run',
        trustState: 'blocked' as const,
        payload: {
          kind: 'no_answer',
          analyticalFailure: failure,
          resolvedAnalyticalPlan: { fingerprint: failure.planFingerprint, recommendedRoute: 'generated_answer' },
          dqlArtifact: {
            kind: 'sql_block',
            name: 'Orders',
            source: sourceDql,
            compiledSql: failedSql,
            parameterValues: { min_order_id: 7 },
            trustState: 'review_required',
            persistence: 'transient',
          },
          proposedSql: failedSql,
          sql: failedSql,
          executionError: 'The warehouse rejected the source dialect quoting.',
          warehouseFailure: {
            version: 1,
            origin: 'warehouse',
            stage: 'execution',
            category: 'dialect_error',
            retryDisposition: 'model_repair',
            redactedMessage: 'The warehouse rejected the source dialect quoting.',
            driver: 'duckdb',
          },
        },
      }],
      evaluations: [],
      nextActions: [],
    });
    let executionAttempts = 0;
    const executor = {
      executeQuery: vi.fn(async (sql: string, _parameters?: unknown[], variables?: Record<string, unknown>) => {
        executionAttempts += 1;
        if (executionAttempts === 1) throw new Error('Parser Error: dialect quoting requires explicit identifiers');
        return ({
        columns: ['order_id'],
        rows: [{ order_id: 42 }],
        rowCount: 1,
        sql,
        variables,
      });
      }),
    } as unknown as QueryExecutor;
    const nativeFetch = globalThis.fetch;
    const providerRequests: string[] = [];
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerObserved = new Promise<void>((resolve) => { providerStarted = resolve; });
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://ask-sql-repair.example.test/')) {
        const request = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
        const messages = request.messages ?? [];
        const userPayload = JSON.parse(messages.at(-1)?.content ?? '{}') as { sql?: string };
        const serialized = JSON.stringify(messages);
        providerRequests.push(serialized);
        expect(userPayload.sql).toBe(failedSql);
        expect(serialized).not.toContain(sourceDql);
        providerStarted();
        await providerGate;
        return new Response(JSON.stringify({
          choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ summary: 'Repair the missing column.', sql: repairedSql, viz: 'table', outputs: ['order_id'] })}\n\`\`\`` } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return nativeFetch(input, init);
    });
    vi.stubGlobal('fetch', providerFetch);

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
        agentRunExecutors: {
          conversation: failedAnswerExecutor,
          certified_answer: failedAnswerExecutor,
          semantic_answer: failedAnswerExecutor,
          generated_answer: failedAnswerExecutor,
          research: failedAnswerExecutor,
          clarify: failedAnswerExecutor,
          blocked: failedAnswerExecutor,
        },
      });
      const base = `http://127.0.0.1:${port}`;
      const createdResponse = await nativeFetch(`${base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Show orders',
          requestedMode: 'ask',
          executionTarget: { target: 'local' },
        }),
      });
      const created = await createdResponse.json() as { run: { id: string; repairCapability?: { automatic?: { eligible?: boolean } } } };
      expect(created.run.repairCapability?.automatic?.eligible).toBe(true);

      const repairedRequest = nativeFetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}/repair-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const firstRepairState = await Promise.race([
        providerObserved.then(() => ({ kind: 'provider' as const })),
        repairedRequest.then((response) => ({
          kind: 'response' as const,
          status: response.status,
        })),
      ]);
      expect(firstRepairState).toEqual({ kind: 'provider' });
      const concurrentResponse = await nativeFetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}/repair-execution`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(concurrentResponse.status).toBe(409);
      await expect(concurrentResponse.json()).resolves.toMatchObject({ code: 'REPAIR_IN_PROGRESS' });
      releaseProvider();
      const repairedResponse = await repairedRequest;
      expect(repairedResponse.status).toBe(201);
      const repaired = await repairedResponse.json() as { run: any };
      expect(repaired.run).toMatchObject({
        id: `${created.run.id}:repair:1`,
        status: 'needs_review',
        trustState: 'review_required',
        repairAttempts: 1,
        derivation: {
          version: 1,
          kind: 'analytical_repair',
          sourceRunId: created.run.id,
          attempt: 1,
        },
      });
      expect(repaired.run.artifacts[0].payload.proposedSql).toBe(repairedSql);
      expect(repaired.run.artifacts[0].payload.sql).toBe(`${repairedSql}\nLIMIT 200`);
      expect(repaired.run.executionTarget).toEqual({ target: 'local' });
      expect(repaired.run.artifacts[0].payload.dqlArtifact).toMatchObject({
        compiledSql: repairedSql,
        parameterValues: { min_order_id: 7 },
        trustState: 'review_required',
        persistence: 'transient',
        executableArtifact: {
          version: 1,
          kind: 'sql_block',
          trustState: 'review_required',
          targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(repaired.run.artifacts[0].payload.dqlArtifact.source).toContain('SELECT order_id FROM "main"."orders" WHERE order_id >= ${min_order_id}');
      expect(repaired.run.artifacts[0].payload.result.rows).toEqual([{ order_id: 42 }]);
      expect(repaired.run.artifacts[0].payload.diagnosticReceipt).toMatchObject({
        phase: 'run.completed',
        repair: { sourceRunId: created.run.id, targetPreserved: true, readOnly: true },
        execution: { rowCount: 1 },
        providerEgressReceipts: [expect.objectContaining({ resultRowCount: 0, columnCount: 0, optIn: false })],
      });
      expect(repaired.run.providerEgressReceipts).toEqual([
        expect.objectContaining({ purpose: 'repair_sql', dispatchPhase: 'repair', resultRowCount: 0, columnCount: 0, optIn: false }),
      ]);
      expect(JSON.stringify(repaired.run.providerEgressReceipts)).not.toContain('order_id');
      expect(repaired.run.telemetry).toMatchObject({
        providerRoundTrips: 1,
        toolCalls: 0,
        sqlExecutions: 2,
        repairs: 1,
        egressReceipts: 1,
        stageDurationsMs: { retrieval: 0, meaning: 0 },
      });
      expect(repaired.run.diagnosticReceiptV2).toMatchObject({ version: 2, telemetry: repaired.run.telemetry });
      expect(providerRequests).toHaveLength(1);

      const sourceResponse = await nativeFetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}`);
      const sourceState = await sourceResponse.json() as { lifecycleState: string; run: any };
      expect(sourceState.run.status).toBe('blocked');
      expect(sourceState.run.artifacts[0].payload.sql).toBe(failedSql);
      expect(sourceState.run.artifacts[0].payload.dqlArtifact.source).toBe(sourceDql);

      const idempotent = await nativeFetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}/repair-execution`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(idempotent.status).toBe(200);
      await expect(idempotent.json()).resolves.toMatchObject({ run: { id: repaired.run.id } });
      expect(providerRequests).toHaveLength(1);
    } finally {
      releaseProvider();
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  }, 90_000);

  it('returns typed manual actions when a legacy run lacks repair capability authority', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-legacy-repair-capability-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const completedAt = new Date().toISOString();
    const legacyStore = new SqliteAgentRunStore({ path: defaultAgentRunSqlitePath(projectRoot) });
    legacyStore.save({
      id: 'legacy-blocked-run',
      question: 'Show orders',
      requestedMode: 'ask',
      route: 'generated_answer',
      status: 'blocked',
      trustState: 'blocked',
      startedAt: completedAt,
      completedAt,
      artifacts: [],
      evaluations: [],
      events: [],
      nextActions: [{ id: 'edit', label: 'Edit DQL', action: 'edit_dql', enabled: true }],
    } as never);
    legacyStore.close();

    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs/legacy-blocked-run/repair-execution`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: 'REPAIR_CAPABILITY_REQUIRED',
        error: expect.any(String),
        manualActions: ['edit_dql', 'open_sql_notebook'],
      });
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('rejects mutated plan, failure, and source fingerprints before reserving or dispatching repair', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-repair-capability-binding-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const source = `block "Orders" {
  type = "custom"
  query = """SELECT order_id FROM main.orders"""
}`;
    const sql = 'SELECT order_id FROM main.orders';
    const targetFingerprint = targetGenerationFingerprint({ driver: 'file' });
    const store = new SqliteAgentRunStore({ path: defaultAgentRunSqlitePath(projectRoot) });
    for (const mismatch of ['plan', 'failure', 'source'] as const) {
      const id = `repair-binding-${mismatch}`;
      const failure = createAnalyticalFailure({
        code: 'DIALECT_ERROR',
        phase: 'execution',
        snapshotId: 'snapshot-binding',
        runId: id,
        planFingerprint: 'a'.repeat(64),
        dqlSource: source,
        compiledSql: sql,
      });
      const run = {
        id,
        question: 'Show orders',
        requestedMode: 'ask',
        route: 'generated_answer',
        status: 'blocked',
        trustState: 'blocked',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        executionTarget: { target: 'local' },
        artifacts: [{
          id: `answer:${id}`,
          kind: 'answer',
          title: 'Failed analytical run',
          trustState: 'blocked',
          payload: {
            kind: 'no_answer',
            resolvedAnalyticalPlan: { fingerprint: failure.planFingerprint, recommendedRoute: 'generated_answer' },
            analyticalFailure: failure,
            dqlArtifact: {
              kind: 'sql_block', name: 'Orders', source, compiledSql: sql,
              trustState: 'review_required', persistence: 'transient',
            },
            proposedSql: sql,
            sql,
            warehouseFailure: {
              version: 1, origin: 'warehouse', stage: 'execution', category: 'dialect_error',
              retryDisposition: 'model_repair', redactedMessage: 'Dialect error.', driver: 'file',
            },
          },
        }],
        evaluations: [],
        events: [],
        nextActions: [],
      } as any;
      run.repairCapability = analyticalRepairCapabilityForAgentRun(run, targetFingerprint);
      const payload = run.artifacts[0].payload;
      if (mismatch === 'plan') payload.resolvedAnalyticalPlan.fingerprint = 'b'.repeat(64);
      if (mismatch === 'failure') payload.analyticalFailure = { ...payload.analyticalFailure, code: 'COLUMN_NOT_FOUND' };
      if (mismatch === 'source') payload.dqlArtifact.source = source.replace('main.orders', 'main.changed_orders');
      store.save(run);
    }
    store.close();

    const executor = { executeQuery: vi.fn() } as unknown as QueryExecutor;
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      for (const mismatch of ['plan', 'failure', 'source'] as const) {
        const sourceRunId = `repair-binding-${mismatch}`;
        const response = await fetch(`${base}/api/agent-runs/${sourceRunId}/repair-execution`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ code: 'REPAIR_CAPABILITY_REQUIRED' });
        const derived = await fetch(`${base}/api/agent-runs/${sourceRunId}:repair:1`);
        expect(derived.status).toBe(404);
      }
      expect(executor.executeQuery).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('rejects a stale fabricated capability before consulting persisted repair attempts after restart', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-durable-repair-attempt-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const completedAt = new Date().toISOString();
    const sourceRunId = 'durable-failed-repair-source';
    const derivedRunId = `${sourceRunId}:repair:1`;
    const store = new SqliteAgentRunStore({ path: defaultAgentRunSqlitePath(projectRoot) });
    store.save({
      id: sourceRunId,
      question: 'Show orders',
      requestedMode: 'ask',
      route: 'generated_answer',
      status: 'blocked',
      trustState: 'blocked',
      startedAt: completedAt,
      completedAt,
      artifacts: [],
      evaluations: [],
      events: [],
      nextActions: [],
      repairCapability: {
        version: 1,
        automatic: {
          eligible: true,
          action: 'repair_embedded_sql',
          correctionCode: 'SQL_EXECUTION_REPAIR',
          attemptsRemaining: 1,
        },
        failureFingerprint: 'failure-fingerprint',
        sourceFingerprint: 'source-fingerprint',
        planFingerprint: 'plan-fingerprint',
        dqlFingerprint: 'dql-fingerprint',
        sqlFingerprint: 'sql-fingerprint',
        targetFingerprint: 'target-fingerprint',
        routeLocked: true,
        targetLocked: true,
        sourceImmutable: true,
        manualActions: ['edit_dql', 'open_sql_notebook'],
      },
    } as never);
    store.save({
      id: derivedRunId,
      question: 'Show orders',
      requestedMode: 'ask',
      route: 'generated_answer',
      status: 'blocked',
      trustState: 'blocked',
      stopReason: 'blocked',
      startedAt: completedAt,
      completedAt,
      summary: 'The provider repair changed the immutable plan.',
      artifacts: [],
      evaluations: [],
      events: [],
      nextActions: [],
      repairAttempts: 1,
      derivation: {
        version: 1,
        kind: 'analytical_repair',
        sourceRunId,
        attempt: 1,
      },
    } as never);
    store.close();

    const executor = { executeQuery: vi.fn() } as unknown as QueryExecutor;
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs/${sourceRunId}/repair-execution`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'REPAIR_CAPABILITY_REQUIRED',
      });
      expect(executor.executeQuery).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('keeps an invalid DQL wrapper editable and never sends it to provider repair', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ask-dql-compiler-repair-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    saveProviderSettings(projectRoot, {
      id: 'openai', enabled: true, apiKey: 'sk-ask-repair',
      baseUrl: 'https://ask-repair.example.test/v1', model: 'repair-test',
    });
    const nativeFetch = globalThis.fetch;
    const malformedSource = 'block "Orders" { type = "custom" query """SELECT order_id FROM main.orders""" }';
    const providerRequests: string[] = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://ask-repair.example.test/')) {
        providerRequests.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ sql: 'SELECT order_id FROM main.orders' }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return nativeFetch(input, init);
    });
    vi.stubGlobal('fetch', providerFetch);
    const analyticalFailure = createAnalyticalFailure({
      code: 'DIALECT_ERROR',
      phase: 'execution',
      snapshotId: 'snapshot-invalid-wrapper',
      runId: 'failed-invalid-wrapper',
      planFingerprint: 'e'.repeat(64),
      dqlSource: malformedSource,
      compiledSql: 'SELECT order_id FROM main.orders',
    });
    const failedAnswerExecutor = () => ({
      summary: 'DQL compiler expected equals before query.',
      status: 'blocked' as const,
      trustState: 'blocked' as const,
      stopReason: 'blocked' as const,
      artifacts: [{
        id: 'answer:dql-compiler-failure',
        kind: 'answer' as const,
        title: 'Failed DQL compilation',
        trustState: 'blocked' as const,
        payload: {
          kind: 'no_answer',
          analyticalFailure,
          dqlArtifact: { kind: 'sql_block', name: 'Orders', source: malformedSource, trustState: 'review_required' },
          proposedSql: 'SELECT order_id FROM main.orders',
          executionError: 'DQL compiler expected equals before query.',
          warehouseFailure: {
            version: 1,
            origin: 'dql_compilation',
            stage: 'compile',
            category: 'syntax',
            retryDisposition: 'model_repair',
            redactedMessage: 'DQL compiler expected equals before query.',
            driver: 'duckdb',
          },
          resolvedAnalyticalPlan: { fingerprint: 'plan-dql-repair' },
        },
      }],
      evaluations: [],
      nextActions: [],
    });
    const executor = {
      executeQuery: vi.fn(async (sql: string) => ({
        columns: ['order_id'], rows: [{ order_id: 42 }], rowCount: 1, sql,
      })),
      executePositional: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
    } as unknown as QueryExecutor;
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
        agentRunExecutors: {
          conversation: failedAnswerExecutor,
          certified_answer: failedAnswerExecutor,
          semantic_answer: failedAnswerExecutor,
          generated_answer: failedAnswerExecutor,
          research: failedAnswerExecutor,
          clarify: failedAnswerExecutor,
          blocked: failedAnswerExecutor,
        },
      });
      const base = `http://127.0.0.1:${port}`;
      const created = await (await nativeFetch(`${base}/api/agent-runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Show orders', requestedMode: 'ask' }),
      })).json() as { run: { id: string } };
      const response = await nativeFetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}/repair-execution`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const text = await response.text();
      expect(response.status, text).toBe(409);
      expect(JSON.parse(text)).toMatchObject({
        code: 'REPAIR_CAPABILITY_REQUIRED',
        ineligibilityReason: 'invalid_dql_wrapper',
        manualActions: expect.any(Array),
      });
      expect(providerRequests.some((request) => request.includes(malformedSource))).toBe(false);
      expect(providerRequests.some((request) => request.includes('Repair one malformed executable DQL'))).toBe(false);
      expect(providerRequests.some((request) => request.includes('Repair one failed read-only analytical SQL'))).toBe(false);
      expect(executor.executeQuery).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('repairs and reruns a notebook cell without creating an agent conversation', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-notebook-background-repair-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    let server: Server | undefined;
    const executor = {
      executeQuery: vi.fn(async (sql: string) => ({
        columns: ['order_id'],
        rows: [{ order_id: 42 }],
        rowCount: 1,
        sql,
      })),
    } as unknown as QueryExecutor;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const repairedResponse = await fetch(`${base}/api/notebook/repair-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell: {
            id: 'cell_1',
            type: 'sql',
            source: 'SELECT order_id FROM source::analytics.main.orders',
            title: 'Orders',
          },
          error: 'syntax error near source::',
        }),
      });

      expect(repairedResponse.status).toBe(200);
      const repaired = await repairedResponse.json() as any;
      expect(repaired).toMatchObject({
        ok: true,
        repairMode: 'deterministic',
        result: { rows: [{ order_id: 42 }], rowCount: 1 },
      });
      expect(repaired.source).not.toContain('source::');
      expect(repaired.repairedSql).not.toContain('source::');
      expect(executor.executeQuery).toHaveBeenCalledTimes(1);

      const dqlSource = [
        'block "Order lookup" {',
        '  type = "custom"',
        '  description = "Order lookup"',
        '  query = """',
        'SELECT order_id FROM source::analytics.main.orders',
        '  """',
        '}',
      ].join('\n');
      const repairedDqlResponse = await fetch(`${base}/api/notebook/repair-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell: { id: 'cell_dql', type: 'dql', source: dqlSource, title: 'Order lookup' },
          error: 'syntax error near source::',
        }),
      });
      const repairedDqlText = await repairedDqlResponse.text();
      expect(repairedDqlResponse.status, repairedDqlText).toBe(200);
      const repairedDql = JSON.parse(repairedDqlText) as any;
      expect(repairedDql.source).toContain('description = "Order lookup"');
      expect(repairedDql.source).not.toContain('source::');
      expect(executor.executeQuery).toHaveBeenCalledTimes(2);

      const parameterizedDqlSource = `block "Filtered orders" {
  type = "custom"
  params {
    category: string = "Beverage"
  }
  query = """SELECT order_id FROM source::analytics.main.orders WHERE category = \${category}"""
}`;
      const parameterizedResponse = await fetch(`${base}/api/notebook/repair-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell: { id: 'cell_parameterized', type: 'dql', source: parameterizedDqlSource },
          error: 'syntax error near source::',
          parameters: { category: 'Tea' },
        }),
      });
      const parameterizedText = await parameterizedResponse.text();
      expect(parameterizedResponse.status, parameterizedText).toBe(200);
      const parameterized = JSON.parse(parameterizedText) as any;
      expect(parameterized.source).toContain('${category}');
      expect(parameterized.source).not.toContain('source::');
      expect(executor.executeQuery).toHaveBeenCalledTimes(3);
      expect((executor.executeQuery as any).mock.calls[2][1]).toEqual([{ name: 'category', position: 1 }]);
      expect((executor.executeQuery as any).mock.calls[2][2]).toMatchObject({ category: 'Tea' });

      const runs = await (await fetch(`${base}/api/agent-runs`)).json() as { total: number };
      expect(runs.total).toBe(0);

      const refused = await fetch(`${base}/api/notebook/repair-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell: { id: 'cell_2', type: 'sql', source: 'SELECT * FROM secret.orders' },
          error: 'permission denied for table orders',
        }),
      });
      expect(refused.status).toBe(409);
      expect(executor.executeQuery).toHaveBeenCalledTimes(3);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('repairs malformed DQL and schema references in one bounded Block Studio attempt', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-notebook-dql-compiler-repair-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-repair-test',
      baseUrl: 'https://repair.example.test/v1',
      model: 'repair-test',
    });
    const nativeFetch = globalThis.fetch;
    const providerRequests: Array<Record<string, unknown>> = [];
    const repairedSource = `block "Top customers" {
  type = "custom"
  params {
    top_n: number = 5
  }
  query = """
SELECT customers.name AS customer_name
FROM main.dim_customers AS customers
ORDER BY customers.name
LIMIT \${top_n}
  """
}`;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://repair.example.test/')) {
        providerRequests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ dql: repairedSource }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return nativeFetch(input, init);
    }));

    const executeQuery = vi.fn(async (sql: string, sqlParams: unknown[], variables: Record<string, unknown>) => ({
      columns: ['customer_name'],
      rows: [{ customer_name: 'Ada' }],
      rowCount: 1,
      sql,
      sqlParams,
      variables,
    }));
    const executePositional = vi.fn(async () => ({
      columns: ['table_schema', 'table_name', 'column_name', 'data_type'],
      rows: [
        { table_schema: 'main', table_name: 'dim_customers', column_name: 'customer_id', data_type: 'BIGINT' },
        { table_schema: 'main', table_name: 'dim_customers', column_name: 'name', data_type: 'VARCHAR' },
      ],
      rowCount: 2,
    }));
    const executor = { executeQuery, executePositional } as unknown as QueryExecutor;
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const malformedSource = `block "Top customers" {
  type = "custom"
  params {
    top_n: number = 5
  }
  query """
SELECT customers.customer_name AS customer_name
FROM main.dim_customers AS customers
LIMIT \${top_n}
  """
}`;
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/block-studio/repair-and-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell: { id: 'cell_dql_syntax', type: 'dql', source: malformedSource, title: 'Top customers' },
          error: 'DQL compiler: expected equals before query; customer_name does not exist',
          parameters: { top_n: 3 },
        }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const repaired = JSON.parse(text) as any;
      expect(repaired.source).toBe(repairedSource);
      expect(repaired.repairMode).toBe('ai');
      expect(repaired.result.rows).toEqual([{ customer_name: 'Ada' }]);
      expect(repaired.repairedSql).toContain('customers.name');
      expect(repaired.repairedSql).not.toContain('customers.customer_name');
      expect(executeQuery).toHaveBeenCalledTimes(1);
      expect(executeQuery.mock.calls[0][1]).toEqual([{ name: 'top_n', position: 1 }]);
      expect(executeQuery.mock.calls[0][2]).toMatchObject({ top_n: 3 });
      expect(providerRequests).toHaveLength(1);
      const repairPrompt = providerRequests[0] as { messages: Array<{ content: string }> };
      const repairPayload = JSON.parse(repairPrompt.messages[1].content) as { schema: unknown[] };
      expect(repairPayload.schema).toContainEqual({
        relation: 'main.dim_customers',
        columns: [
          { name: 'customer_id', type: 'BIGINT' },
          { name: 'name', type: 'VARCHAR' },
        ],
      });
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('rejects malformed Block Studio source before writing or reopening a frozen block', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-save-validation-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const malformedSource = `block "Frozen draft" {
  type = "custom"
  owner = "analytics"
  query """SELECT 1"""
}`;
      const response = await fetch(`http://127.0.0.1:${port}/api/block-studio/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: malformedSource,
          metadata: {
            name: 'Frozen draft',
            domain: 'uncategorized',
            description: '',
            owner: 'analytics',
            tags: [],
          },
        }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(422);
      expect(JSON.parse(text)).toMatchObject({
        code: 'BLOCK_VALIDATION_FAILED',
        recoverable: true,
        details: { validation: { valid: false, saveable: false } },
      });
      expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('stamps App-source reuse only when a generated draft is explicitly saved or added', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-reusable-save-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const legacySource = `block "Legacy analysis" {
  type = "custom"
  status = "draft"
  tags = ["ai-generated"]
  source_question = "Why did revenue change?"
  query = """SELECT 1 AS value"""
}`;
      expect(legacySource).not.toContain('app-source');

      const saved = await fetch(`http://127.0.0.1:${port}/api/block-studio/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: legacySource,
          metadata: { name: 'Legacy analysis', domain: 'finance', owner: 'analytics', tags: ['ai-generated'] },
        }),
      }).then((response) => response.json()) as { path: string };
      expect(readFileSync(join(projectRoot, saved.path), 'utf-8')).toContain('tags = ["ai-generated", "app-source"]');

      const added = await fetch(`http://127.0.0.1:${port}/api/block-studio/agent-drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: legacySource.replace('Legacy analysis', 'Added analysis'),
          name: 'Added analysis',
          domain: 'finance',
          tags: ['ai-generated'],
          runId: 'run-explicit-add',
        }),
      }).then((response) => response.json()) as { path: string };
      expect(readFileSync(join(projectRoot, added.path), 'utf-8')).toContain('tags = ["ai-generated", "app-source"]');
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('uses the shared bounded repair for App draft-analysis execution without mutating source (AGT-023, API-010)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-tile-repair-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const created = createAppPackage(projectRoot, {
      name: 'Repair App',
      domain: 'revenue',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const draftDir = join(projectRoot, 'apps/repair-app/drafts');
    mkdirSync(draftDir, { recursive: true });
    const source = `block "Regional revenue repair" {
  domain = "revenue"
  type = "custom"
  status = "review"
  owner = "owner@local"
  query = """
SELECT missing_revenue FROM analytics.orders
  """
  visualization { chart = "table" }
}\n`;
    const draftPath = join(draftDir, 'regional-revenue-repair.dql');
    writeFileSync(draftPath, source);
    const dashboardPath = join(projectRoot, 'apps/repair-app/dashboards/overview.dqld');
    const dashboardBefore = JSON.parse(readFileSync(dashboardPath, 'utf-8')) as any;
    dashboardBefore.layout.items.push({
      i: 'draft-repair', x: 0, y: 0, w: 6, h: 3,
      draftAnalysis: {
        ref: 'drafts/regional-revenue-repair.dql',
        artifactFingerprint: `sha256:${createHash('sha256').update(source).digest('hex')}`,
      },
      viz: { type: 'table' },
      title: 'Regional revenue repair',
      sourceClass: 'exploratory_analysis',
      review: { status: 'required' },
      trustState: 'review_required',
      reviewStatus: 'review_required',
    });
    dashboardBefore.layout.items.push({
      i: 'story-copy', x: 0, y: 4, w: 12, h: 1,
      text: { markdown: 'Keep this tile out of the bounded retry response.' },
      viz: { type: 'text' },
      title: 'Story copy',
    });
    writeFileSync(dashboardPath, `${JSON.stringify(dashboardBefore, null, 2)}\n`);
    const dashboardSourceBefore = readFileSync(dashboardPath, 'utf-8');
    let server: Server | undefined;
    let attempt = 0;
    const executor = {
      executeQuery: vi.fn(async (sql: string) => {
        attempt += 1;
        if (attempt === 1) throw new Error('Binder Error: Referenced column missing_revenue not found');
        return {
          columns: ['revenue'],
          rows: [{ revenue: 125 }],
          rowCount: 1,
          sql,
        };
      }),
    } as unknown as QueryExecutor;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/apps/repair-app/dashboards/overview/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tileId: 'draft-repair' }),
      });
      const payload = await response.json() as any;
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.tiles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tileId: 'draft-repair',
          status: 'ok',
          result: expect.objectContaining({ rows: [{ revenue: 125 }] }),
          repair: expect.objectContaining({
            version: 1,
            status: 'repaired',
            source: 'draft_analysis',
            mode: 'deterministic',
            approvalEligible: false,
          }),
          artifact: expect.objectContaining({
            version: 1,
            sourceKind: 'draft_analysis',
            sourcePath: 'drafts/regional-revenue-repair.dql',
            dql: source,
            sql: expect.stringContaining('missing_revenue'),
            trustState: 'review_required',
          }),
        }),
      ]));
      expect(payload.tiles).toHaveLength(1);
      expect(executor.executeQuery).toHaveBeenCalledTimes(2);
      expect(readFileSync(draftPath, 'utf-8')).toBe(source);
      expect(readFileSync(dashboardPath, 'utf-8')).toBe(dashboardSourceBefore);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('runs Ask review DQL from the local edit-draft bundle before the Project App directory (API-013, UI-005)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-ask-local-artifact-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const created = createAppPackage(projectRoot, {
      name: 'Ask Base App',
      domain: 'revenue',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const draft = createStoredAppBuildDraft(projectRoot, {
      baseAppId: created.app.id,
      goal: 'Safely edit the Project App with Ask',
      authoringMode: 'ai',
      sourcePolicy: 'include_review_required',
      entrypoint: 'ask',
    });
    const added = addAskResultToAppBuildDraft(projectRoot, draft.id, {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      pageId: created.dashboardId,
      title: 'Regional risk from Ask',
      question: 'Which regions need review?',
      sql: 'SELECT region, risk_score FROM regional_risk',
      visualization: 'table',
    });
    const localSource = added.draft.sources.find((source) => source.kind === 'review_dql');
    expect(localSource?.sourceRef).toBeTruthy();
    expect(existsSync(join(projectRoot, '.dql', 'local', 'app-builds', draft.id, localSource!.sourceRef))).toBe(true);
    expect(existsSync(join(projectRoot, 'apps', created.app.id, localSource!.sourceRef))).toBe(false);

    const executeQuery = vi.fn(async (sql: string) => ({
      columns: ['region', 'risk_score'], rows: [{ region: 'West', risk_score: 9 }], rowCount: 1, sql,
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery } as unknown as QueryExecutor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/app-builds/${draft.id}/dashboards/${created.dashboardId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tileId: added.tileId }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const payload = JSON.parse(text) as any;
      expect(payload.tiles).toEqual([expect.objectContaining({
        tileId: added.tileId,
        status: 'ok',
        trustState: 'review_required',
        result: expect.objectContaining({ rows: [{ region: 'West', risk_score: 9 }] }),
        artifact: expect.objectContaining({
          sourceKind: 'draft_analysis',
          sourcePath: localSource!.sourceRef,
          trustState: 'review_required',
        }),
      })]);
      expect(executeQuery).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('repairs one failed certified App block without changing or recertifying its saved source', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certified-app-tile-repair-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const blockDir = join(projectRoot, 'blocks', 'revenue');
    mkdirSync(blockDir, { recursive: true });
    const source = `block "Certified revenue repair" {
  domain = "revenue"
  type = "custom"
  status = "certified"
  owner = "owner@local"
  query = """
SELECT missing_revenue FROM analytics.orders
  """
  visualization { chart = "table" }
}\n`;
    const blockPath = join(blockDir, 'certified-revenue-repair.dql');
    writeFileSync(blockPath, source);
    const created = createAppPackage(projectRoot, {
      name: 'Certified Repair App',
      domain: 'revenue',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: ['Certified revenue repair'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const dashboardPath = join(projectRoot, 'apps/certified-repair-app/dashboards/overview.dqld');
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8')) as any;
    const tileId = dashboard.layout.items[0]?.i as string;
    expect(tileId).toBeTruthy();
    let server: Server | undefined;
    let attempt = 0;
    const executor = {
      executeQuery: vi.fn(async (sql: string) => {
        attempt += 1;
        if (attempt === 1) throw new Error('Binder Error: Referenced column missing_revenue not found');
        return {
          columns: ['revenue'],
          rows: [{ revenue: 500 }],
          rowCount: 1,
          sql,
        };
      }),
    } as unknown as QueryExecutor;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/apps/certified-repair-app/dashboards/overview/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tileId }),
      });
      const payload = await response.json() as any;
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.tiles).toHaveLength(1);
      expect(payload.tiles[0]).toMatchObject({
        tileId,
        status: 'ok',
        tileType: 'block',
        certificationStatus: 'certified',
        trustState: 'review_required',
        result: { rows: [{ revenue: 500 }] },
        citation: { kind: 'block_repaired', name: 'Certified revenue repair' },
        repair: {
          status: 'repaired',
          source: 'certified_block',
          approvalEligible: false,
        },
        artifact: {
          sourceKind: 'certified_block',
          dql: source,
          sql: expect.stringContaining('missing_revenue'),
          trustState: 'review_required',
        },
      });
      expect(executor.executeQuery).toHaveBeenCalledTimes(2);
      expect(readFileSync(blockPath, 'utf-8')).toBe(source);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('repairs malformed App DQL and schema references without overwriting the App draft', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-dql-compiler-repair-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-app-repair-test',
      baseUrl: 'https://app-repair.example.test/v1',
      model: 'app-repair-test',
    });
    const created = createAppPackage(projectRoot, {
      name: 'DQL Repair App',
      domain: 'customers',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const appId = created.app.id;
    const malformedSource = `block "Top customers" {
  type = "custom"
  params {
    top_n: number = 5
  }
  query """
SELECT customers.customer_name AS customer_name
FROM main.dim_customers AS customers
LIMIT \${top_n}
  """
}\n`;
    const repairedSource = `block "Top customers" {
  type = "custom"
  params {
    top_n: number = 5
  }
  query = """
SELECT customers.name AS customer_name
FROM main.dim_customers AS customers
LIMIT \${top_n}
  """
}\n`;
    const draftDir = join(projectRoot, 'apps', appId, 'drafts');
    mkdirSync(draftDir, { recursive: true });
    const draftPath = join(draftDir, 'top-customers.dql');
    writeFileSync(draftPath, malformedSource);
    const dashboardPath = join(projectRoot, 'apps', appId, 'dashboards', `${created.dashboardId}.dqld`);
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8')) as any;
    dashboard.layout.items.push({
      i: 'top-customers', x: 0, y: 0, w: 6, h: 3,
      draftAnalysis: {
        ref: 'drafts/top-customers.dql',
        artifactFingerprint: `sha256:${createHash('sha256').update(malformedSource).digest('hex')}`,
      },
      parameterBindings: [{ param: 'top_n', source: 'constant', value: 3 }],
      viz: { type: 'table' },
      title: 'Top customers',
      trustState: 'review_required',
    });
    writeFileSync(dashboardPath, `${JSON.stringify(dashboard, null, 2)}\n`);

    const nativeFetch = globalThis.fetch;
    const providerRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://app-repair.example.test/')) {
        providerRequests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ dql: repairedSource }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return nativeFetch(input, init);
    }));
    const executeQuery = vi.fn(async () => ({
      columns: ['customer_name'], rows: [{ customer_name: 'Ada' }], rowCount: 1,
    }));
    const executePositional = vi.fn(async () => ({
      columns: ['table_schema', 'table_name', 'column_name', 'data_type'],
      rows: [
        { table_schema: 'main', table_name: 'dim_customers', column_name: 'customer_id', data_type: 'BIGINT' },
        { table_schema: 'main', table_name: 'dim_customers', column_name: 'name', data_type: 'VARCHAR' },
      ],
      rowCount: 2,
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery, executePositional } as unknown as QueryExecutor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
      });
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(created.dashboardId)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tileId: 'top-customers' }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const payload = JSON.parse(text) as any;
      expect(payload.tiles[0]).toMatchObject({
        status: 'ok',
        trustState: 'review_required',
        repair: { status: 'repaired', source: 'draft_analysis', mode: 'ai', approvalEligible: false },
        artifact: {
          sourceKind: 'draft_analysis',
          dql: repairedSource.trim(),
          sql: expect.stringContaining('customers.name'),
          trustState: 'review_required',
        },
      });
      expect(providerRequests).toHaveLength(1);
      expect(executeQuery).toHaveBeenCalledTimes(1);
      expect(readFileSync(draftPath, 'utf-8')).toBe(malformedSource);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('routes App Studio drafts through the local-only lifecycle API (PRD-006, API-013)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-studio-runtime-'));
    tempDirs.push(projectRoot);
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery: vi.fn(), executePositional: vi.fn() } as unknown as QueryExecutor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
      });
      const created = await fetch(`http://127.0.0.1:${port}/api/app-builds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Operations Health', goal: 'Monitor operations', authoringMode: 'manual', template: 'operational_dashboard' }),
      });
      const createdText = await created.text();
      expect(created.status, createdText).toBe(201);
      const payload = JSON.parse(createdText) as any;
      expect(payload.draft).toMatchObject({ version: 3, authoringMode: 'manual', state: 'local_draft', template: 'operational_dashboard' });
      expect(existsSync(join(projectRoot, 'apps'))).toBe(false);

      const listed = await fetch(`http://127.0.0.1:${port}/api/app-builds`);
      expect(listed.status).toBe(200);
      expect((await listed.json() as any).drafts.map((draft: any) => draft.id)).toContain(payload.draft.id);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('threads conversation context through the HTTP agent-run endpoint into the route executor', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-context-'));
    tempDirs.push(projectRoot);
    let server: Server | undefined;
    let observedContext: Record<string, unknown> | undefined;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => {
          server = created;
        },
        agentRunExecutors: {
          generated_answer: ({ request }) => {
            observedContext = request.conversationContext;
            return {
              summary: 'Prepared review-required DQL artifact with SQL preview.',
              answer: 'Top customers for the prior categories.',
              status: 'needs_review',
              trustState: 'review_required',
              stopReason: 'human_review_required',
              artifacts: [{
                id: 'answer:test',
                kind: 'answer',
                title: 'Review-required answer',
                trustState: 'review_required',
                payload: {
                  kind: 'uncertified',
                  certification: 'ai_generated',
                  reviewStatus: 'draft_ready',
                  text: 'Top customers for the prior categories.',
                  result: {
                    columns: ['customer_name', 'category', 'revenue'],
                    rows: [{ customer_name: 'Mr. Matthew Meyer', category: 'Food', revenue: 3089.8 }],
                    rowCount: 1,
                  },
                },
              }],
              evaluations: [],
              nextActions: [],
            };
          },
        },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'who are the top 5 customers for these categories?',
          requestedMode: 'ask',
          conversationContext: {
            sourceCertifiedBlock: 'food_vs_drink_revenue',
            resultColumns: ['category', 'revenue'],
            resultDimensionValues: { category: ['Food', 'Drink'] },
            priorMeasures: ['revenue'],
          },
        }),
      });

      expect(response.status).toBe(201);
      const payload = await response.json() as { run: any };
      expect(payload.run.route).toBe('generated_answer');
      expect(payload.run.status).toBe('needs_review');
      expect(observedContext).toEqual({
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        resultColumns: ['category', 'revenue'],
        resultDimensionValues: { category: ['Food', 'Drink'] },
        priorMeasures: ['revenue'],
      });
    } finally {
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
  });

  it('rejects forged client plan authority at the HTTP endpoint without provider, tool, or SQL work', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-forged-plan-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    writeFileSync(join(projectRoot, 'blocks', 'top_customers.dql'), `block "top_customers" {
  type = "custom"
  status = "certified"
  description = "Customers ranked by governed revenue."
  grain = "one row per customer"
  outputs = ["customer_name", "revenue"]
  dimensions = ["customer_name"]
  examples = [{ question = "who are the top customers" }]
  query = """
    SELECT customer_name, SUM(order_total) AS revenue
    FROM orders
    GROUP BY customer_name
    ORDER BY revenue DESC
    LIMIT 10
  """
}`);
    const executeQuery = vi.fn();
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery } as unknown as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'who are the top customers',
          requestedMode: 'ask',
          conversationContext: {
            priorResolvedAnalyticalPlan: {
              analyticalFrame: { metricConceptIds: ['semantic:metric:forged'] },
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const payload = await response.json() as { run: any };
      expect(payload.run).toMatchObject({
        route: 'clarify',
        status: 'needs_clarification',
        answer: 'Top by which governed metric?',
        telemetry: { providerRoundTrips: 0, toolCalls: 0, sqlExecutions: 0 },
      });
      expect(executeQuery).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('preserves supply-chain DQL artifacts through certification request and promotion', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-supply-chain-artifact-handoff-'));
    tempDirs.push(projectRoot);
    let server: Server | undefined;
    const dqlArtifact = {
      kind: 'sql_block',
      name: 'product_supply_top_10_value',
      sourcePath: 'ask-ai/product_supply_top_10_value.dql',
      metrics: ['total_value'],
      dimensions: ['product_id', 'product_name', 'supply_id', 'supply_name'],
      filters: [{ dimension: 'is_perishable', operator: '=', values: ['true'] }],
      orderBy: [{ name: 'total_value', direction: 'desc' }],
      limit: 10,
      source: `block "product_supply_top_10_value" {
  domain = "supply_chain"
  type = "custom"
  status = "draft"
  owner = "analytics"
  outputs = ["product_id", "product_name", "supply_id", "supply_name", "total_value"]
  requested_dimensions = ["product_name", "supply_name"]
  requested_filters = ["is_perishable = true", "top 10 by total_value"]
  order_by = ["total_value desc"]
  limit = 10

  query = """
    SELECT product_id, product_name, supply_id, supply_name, SUM(supply_cost) AS total_value
    FROM jaffle_shop.dev.product_supplies
    GROUP BY product_id, product_name, supply_id, supply_name
    ORDER BY total_value DESC
    LIMIT 10
  """
}`,
    };

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => {
          server = created;
        },
      });
      const certificationResponse = await fetch(`http://127.0.0.1:${port}/api/agent-runs/request-certification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Can you give me the complete supply chain with product and order details with top 10 value?',
          notebookPath: 'notebooks/supply-chain-review.dqlnb',
          domain: 'supply_chain',
          owner: 'analytics',
          dqlArtifact,
          context: { route: 'generated_answer', example: 'product supply detail' },
        }),
      });

      expect(certificationResponse.status).toBe(201);
      const certification = await certificationResponse.json() as { ok: boolean; researchRunId: string };
      expect(certification.ok).toBe(true);
      expect(certification.researchRunId).toBeTruthy();

      const runResponse = await fetch(`http://127.0.0.1:${port}/api/notebook/research/${encodeURIComponent(certification.researchRunId)}`);
      expect(runResponse.status).toBe(200);
      const runPayload = await runResponse.json() as { run: { dqlArtifact?: typeof dqlArtifact; generatedSql?: string; reviewChecklist?: { readyForDqlDraft: boolean } } };
      expect(runPayload.run.generatedSql).toBeUndefined();
      expect(runPayload.run.dqlArtifact).toMatchObject({
        kind: 'sql_block',
        name: 'product_supply_top_10_value',
        metrics: ['total_value'],
        dimensions: ['product_id', 'product_name', 'supply_id', 'supply_name'],
        limit: 10,
      });
      expect(runPayload.run.reviewChecklist?.readyForDqlDraft).toBe(false);

      const promoteResponse = await fetch(`http://127.0.0.1:${port}/api/notebook/research/${encodeURIComponent(certification.researchRunId)}/promote-dql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'supply_chain', owner: 'analytics' }),
      });
      expect(promoteResponse.status).toBe(200);
      const promoted = await promoteResponse.json() as {
        run: { draftBlockPath?: string; dqlPromotionAction?: string };
        session: { generation: { provider: string }; candidates: Array<{ sql: string; dqlSource: string; draftSave?: { path?: string } }> };
      };
      const candidate = promoted.session.candidates[0];
      expect(promoted.session.generation.provider).toBe('dql-artifact');
      expect(candidate.sql).toBe('');
      expect(candidate.dqlSource).toContain('requested_dimensions = ["product_name", "supply_name"]');
      expect(candidate.dqlSource).toContain('requested_filters = ["is_perishable = true", "top 10 by total_value"]');
      expect(candidate.dqlSource).toContain('outputs = ["product_id", "product_name", "supply_id", "supply_name", "total_value"]');
      expect(promoted.run.draftBlockPath).toBe(candidate.draftSave?.path);
      expect(readFileSync(join(projectRoot, promoted.run.draftBlockPath!), 'utf-8')).toBe(candidate.dqlSource);
    } finally {
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
  });

  it('does not synthesize certified-score signals for ordinary HTTP Ask runs', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-no-signals-'));
    tempDirs.push(projectRoot);
    let server: Server | undefined;
    let observedSignals: unknown = 'not-called';

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => {
          server = created;
        },
        agentRunExecutors: {
          generated_answer: ({ request }) => {
            observedSignals = request.signals;
            return {
              summary: 'Prepared review-required DQL artifact with SQL preview.',
              answer: 'Revenue answer.',
              status: 'needs_review',
              trustState: 'review_required',
              stopReason: 'human_review_required',
              artifacts: [{
                id: 'answer:no-signals',
                kind: 'answer',
                title: 'Review-required answer',
                trustState: 'review_required',
                payload: { text: 'Revenue answer.' },
              }],
              evaluations: [],
              nextActions: [],
            };
          },
        },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'What is customer revenue?',
          audience: 'stakeholder',
        }),
      });

      expect(response.status).toBe(201);
      const payload = await response.json() as { run: any };
      expect(payload.run.route).toBe('generated_answer');
      expect(observedSignals).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
  });

  it('creates, stores, and reads a governed agent run', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-api-'));
    tempDirs.push(projectRoot);
    let server: Server | undefined;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => {
          server = created;
        },
      });
      const base = `http://127.0.0.1:${port}`;

      const createThreadResponse = await fetch(`${base}/api/agent/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface: 'ask', title: 'Disposable Ask thread' }),
      });
      expect(createThreadResponse.status).toBe(201);
      const createdThread = await createThreadResponse.json() as { thread: { id: string } };
      expect((await fetch(`${base}/api/agent/threads/${encodeURIComponent(createdThread.thread.id)}`)).status).toBe(200);
      const deleteThreadResponse = await fetch(
        `${base}/api/agent/threads/${encodeURIComponent(createdThread.thread.id)}`,
        { method: 'DELETE' },
      );
      const deleteThreadPayload = await deleteThreadResponse.json() as { ok?: boolean; error?: string };
      expect(deleteThreadResponse.status, deleteThreadPayload.error).toBe(200);
      expect(deleteThreadPayload).toEqual({ ok: true });
      expect((await fetch(`${base}/api/agent/threads/${encodeURIComponent(createdThread.thread.id)}`)).status).toBe(404);

      const createResponse = await fetch(`${base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Research customer revenue by segment',
          requestedMode: 'research',
          selectedObject: { kind: 'notebook', path: 'notebooks/customer.dqlnb' },
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { run: any };
      expect(created.run.route).toBe('research');
      expect(created.run.status).toBe('needs_review');
      expect(created.run.artifacts[0]?.kind).toBe('research_run');
      expect(created.run.events.map((event: any) => event.type)).toContain('route.decided');

      const getResponse = await fetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}`);
      expect(getResponse.status).toBe(200);
      const fetched = await getResponse.json() as { run: any };
      expect(fetched.run.id).toBe(created.run.id);

      const askResponse = await fetch(`${base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'What is customer revenue?',
          requestedMode: 'ask',
        }),
      });
      expect(askResponse.status).toBe(201);
      const ask = await askResponse.json() as { run: any };
      // Routing is deterministic regardless of provider availability.
      expect(ask.run.route).toBe('generated_answer');
      // Without a reachable provider the run is cleanly blocked (ai-provider eval); with one
      // it returns a governed / needs-clarification result. Either way, no raw infra leak.
      expect(['blocked', 'needs_review', 'needs_clarification', 'completed']).toContain(ask.run.status);
      // Every terminal run must stay inspectable. The inspector can only be opened
      // FROM an artifact, so an empty list renders a refusal as a bare sentence
      // with no DQL, no SQL and no "How it was answered".
      expect(ask.run.artifacts.length).toBeGreaterThan(0);
      if (ask.run.status === 'blocked') {
        expect(ask.run.evaluations.some((evaluation: any) => evaluation.id === 'ai-provider')).toBe(true);
        expect(ask.run.lifecycle).toMatchObject({ state: 'terminal', phase: 'run.failed' });
        expect(ask.run.artifacts[0]).toMatchObject({
          title: 'AI answer provider failed',
          trustState: 'blocked',
          payload: {
            refusalCode: 'provider_error',
            providerFailure: { code: 'AI_PROVIDER_FAILURE' },
          },
        });
        expect(ask.run.diagnosticReceipt?.failure).toMatchObject({
          code: 'AI_PROVIDER_FAILURE',
          phase: 'run.failed',
        });
      }
      expect(ask.run.summary).not.toContain('Could not locate the bindings file');

      const appResponse = await fetch(`${base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Build an app for customer revenue',
          requestedMode: 'app',
          selectedObject: { kind: 'notebook', path: 'notebooks/customer.dqlnb' },
        }),
      });
      expect(appResponse.status).toBe(201);
      const appRun = await appResponse.json() as { run: any };
      // With no certified coverage the loop escalates app_build → dql_block_draft (drafting
      // the missing block); if no provider is reachable it stays blocked. Never a raw infra leak.
      expect(['app_build', 'dql_block_draft', 'blocked']).toContain(appRun.run.route);
      expect(['blocked', 'needs_review', 'needs_clarification']).toContain(appRun.run.status);
      expect(appRun.run.summary).not.toContain('Could not locate the bindings file');

      const streamResponse = await fetch(`${base}/api/agent-runs?stream=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Research churn by plan',
          requestedMode: 'research',
          selectedObject: { kind: 'notebook', path: 'notebooks/customer.dqlnb' },
        }),
      });
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
      const streamText = await streamResponse.text();
      expect(streamText).toContain('event: agent-run-event');
      expect(streamText).toContain('event: agent-run-complete');

      const listResponse = await fetch(`${base}/api/agent-runs?limit=5`);
      expect(listResponse.status).toBe(200);
      const listed = await listResponse.json() as { runs: any[]; total: number };
      expect(listed.total).toBe(4);
      expect(listed.runs.some((run) => run.id === created.run.id)).toBe(true);
      expect(listed.runs.some((run) => run.id === ask.run.id)).toBe(true);
      expect(listed.runs.some((run) => run.id === appRun.run.id)).toBe(true);
      // P0: runs persist in SQLite now (one row per run, retention on write),
      // not the rewrite-the-world JSON file.
      expect(existsSync(join(projectRoot, '.dql', 'local', 'agent-runs.sqlite'))).toBe(true);
      expect(existsSync(join(projectRoot, '.dql', 'local', 'agent-runs.json'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
  });
});

describe('Ask Research baseline continuity', () => {
  it('revalidates the successful Ask baseline on the exact selected connection when deeper composition is unavailable', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ask-research-baseline-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'ask-research-baseline',
      connections: {
        default: { driver: 'databricks', host: 'default.example.test' },
        reporting: { driver: 'databricks', host: 'reporting.example.test' },
      },
      defaultConnectionName: 'default',
    }));

    const executionHosts: Array<string | undefined> = [];
    const executeQuery = vi.fn(async (
      _sql: string,
      _params: unknown[],
      _variables: Record<string, unknown>,
      executionConnection?: { host?: string },
    ): Promise<QueryResult> => {
      executionHosts.push(executionConnection?.host);
      return {
        columns: [
          { name: 'segment', type: 'string', driverType: 'VARCHAR' },
          { name: 'revenue', type: 'number', driverType: 'DOUBLE' },
        ],
        rows: [{ segment: 'Enterprise', revenue: 4200 }],
        rowCount: 1,
        executionTimeMs: 1,
      };
    });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery } as unknown as QueryExecutor,
        connection: { driver: 'databricks', host: 'default.example.test' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Research customer revenue by segment',
          requestedMode: 'research',
          executionTarget: { target: 'connection', connectionName: 'reporting' },
          workspaceContext: {
            surface: 'ask',
            researchSource: {
              runId: 'ask-run-1',
              question: 'Research customer revenue by segment',
              trustState: 'review_required',
              sql: 'SELECT segment, SUM(revenue) AS revenue FROM analytics.orders GROUP BY segment',
              dqlArtifact: {
                kind: 'sql_block',
                name: 'customer_revenue_by_segment',
                source: 'block "customer_revenue_by_segment" {}',
                persistence: 'transient',
                trustState: 'review_required',
              },
            },
          },
        }),
      });
      const payload = await response.json() as { run?: any; error?: string };

      expect({ status: response.status, error: payload.error }).toEqual({ status: 201, error: undefined });
      expect(payload.run?.route).toBe('research');
      expect(executionHosts).toContain('reporting.example.test');
      const researchArtifact = payload.run?.artifacts.find((artifact: any) => artifact.kind === 'research_run');
      expect(researchArtifact?.payload?.researchRun).toMatchObject({
        status: 'ready',
        summary: expect.stringContaining('revalidated it on the same data target'),
        generatedSql: expect.stringContaining('analytics.orders'),
        resultPreview: {
          rows: [{ segment: 'Enterprise', revenue: 4200 }],
        },
      });
      expect(researchArtifact?.payload?.researchRun?.warnings).toContain('Baseline Ask run: ask-run-1');
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('AI provider settings', () => {
  it('makes saved OpenAI settings the active default instead of falling through to Ollama', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-provider-openai-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-test-openai',
      model: 'gpt-test',
    });

    expect(getActiveProvider(projectRoot)).toBe('openai');
    expect(resolveDefaultLLMProvider(projectRoot)).toBe('openai');
    expect(readFileSync(providerSettingsPath(projectRoot), 'utf-8')).toContain('"activeProvider": "openai"');
  });

  it('keeps an enabled but incomplete OpenAI setup active so chat shows an OpenAI error', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-provider-openai-missing-key-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
    });

    expect(getActiveProvider(projectRoot)).toBe('openai');
    expect(resolveDefaultLLMProvider(projectRoot)).toBe('openai');
  });

  it('routes governed OpenAI answers through the DQL answer-loop runner, not the native SDK runner', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-governed-provider-openai-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-test-openai',
      model: 'gpt-test',
    });

    const governed = resolveGovernedAnswerRunner(projectRoot);
    expect(governed?.provider).toBe('openai');
    expect(governed?.runner).toBeTruthy();
    expect(governed?.runner).not.toBe(getRunner('openai'));
  });

  it('routes governed Claude Code answers through the DQL answer-loop runner, not the MCP chat runner', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-governed-provider-claude-code-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'claude-code',
      enabled: true,
    });

    const governed = resolveGovernedAnswerRunner(projectRoot);
    expect(governed?.provider).toBe('claude-code');
    expect(governed?.runner).toBeTruthy();
    expect(governed?.runner).not.toBe(getRunner('claude-code'));
  });

  it('clears the active default without falling back to unconfigured Ollama', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-provider-disable-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-test-openai',
    });
    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: false,
    });

    expect(getActiveProvider(projectRoot)).toBeUndefined();
    expect(resolveDefaultLLMProvider(projectRoot)).toBeNull();
  });

  it('normalizes structured AI metadata arrays during SQL import', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-structured-arrays-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'terms'), { recursive: true });
    writeFileSync(join(projectRoot, 'terms', 'player_points.dql'), `
term "Player Points" {
  domain = "nba"
  type = "metric"
  status = "certified"
  description = "Total NBA points scored by a player."
  owner = "analytics"
}
`, 'utf-8');
    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-test-openai',
      model: 'gpt-test',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            name: 'NBA Player Points',
            description: 'Ranks NBA players by total points. Review required.',
            tags: [{ value: 'nba' }, { name: 'scoring' }],
            terms: [{ name: 'Player Points' }, { name: 'Invented Term' }],
            entities: [{ name: 'Player' }],
            outputs: [{ name: 'player_name' }, { field: 'total_points' }],
            dimensions: [{ column: 'team_name' }],
            sourceSystems: [{ name: 'TRANSFORMED' }],
            reviewCadence: 'quarterly',
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'upload',
      sourceKind: 'raw-sql',
      sources: [{
        path: 'top_players.sql',
        content: 'SELECT player_name, SUM(pts) AS total_points FROM TRANSFORMED.int_player_stats GROUP BY player_name LIMIT 5;',
      }],
      domain: 'nba',
      owner: 'analytics',
      provider: 'openai',
    });

    const candidate = session.candidates[0];
    expect(candidate.generationMode).toBe('ai');
    expect(candidate.dqlSource).not.toContain('[object Object]');
    expect(candidate.dqlSource).toContain('entities = ["Player"]');
    expect(candidate.dqlSource).toContain('outputs = ["player_name", "total_points"]');
    expect(candidate.terms).toEqual(['Player Points']);
    expect(candidate.dqlSource).toContain('terms = ["Player Points"]');
    expect(candidate.dqlSource).not.toContain('Invented Term');
    expect(candidate.dqlSource).toContain('dimensions = ["team_name"]');
    expect(candidate.dqlSource).toContain('sourceSystems = ["TRANSFORMED"]');
    expect(candidate.reviewCadence).toBe('quarterly');
    expect(candidate.dqlSource).toContain('reviewCadence = "quarterly"');
  });

  it('persists generated DQL artifacts without regenerating from SQL', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-artifact-generation-'));
    tempDirs.push(projectRoot);

    const session = await createDqlArtifactGenerationSessionForProject(projectRoot, {
      question: 'Show monthly revenue by channel.',
      domain: 'finance',
      owner: 'analytics',
      tags: ['ask-ai'],
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'monthly_revenue_by_channel',
        sourcePath: 'semantic/monthly_revenue_by_channel.dql',
        source: `block "monthly_revenue_by_channel" {
  type = "semantic"
  status = "draft"
  metric = "total_revenue"
  dimensions = ["channel"]
  time_dimension = "order_date"
  granularity = "month"
}`,
        metrics: ['total_revenue'],
        dimensions: ['channel'],
        timeDimension: { name: 'order_date', granularity: 'month' },
      },
    });

    const candidate = session.candidates[0];
    expect(session.generation.provider).toBe('dql-artifact');
    expect(session.generation.aiEnabled).toBe(false);
    expect(session.generation.createdDrafts).toBe(1);
    expect(candidate.generationProvider).toBe('dql-artifact');
    expect(candidate.sql).toBe('');
    expect(candidate.savedPath).toBe(candidate.draftSave.path);
    expect(candidate.dqlSource).toContain('block "monthly_revenue_by_channel"');
    expect(candidate.dqlSource).toContain('tags = ["app-source"]');
    expect(candidate.dqlSource).toContain('proposed_contract_id = "finance.Unknown.monthly_revenue_channel"');
    expect(readFileSync(join(projectRoot, candidate.draftSave.path!), 'utf-8')).toBe(candidate.dqlSource);
  });

  it('keeps deterministic AI import local and infers ranking after parameterization', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-deterministic-ranking-'));
    tempDirs.push(projectRoot);

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'upload',
      sourceKind: 'raw-sql',
      sources: [{
        path: 'top_players.sql',
        content: `
SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) IN (2016, 2017)
GROUP BY player_name
ORDER BY total_points DESC
LIMIT 5;
`,
      }],
      domain: 'transformed',
      owner: 'analytics',
      provider: 'none',
    });

    const candidate = session.candidates[0];
    expect(session.generation.provider).toBe('local-deterministic');
    expect(session.generation.aiEnabled).toBe(false);
    expect(session.generation.warnings).toEqual([]);
    expect(candidate.pattern).toBe('ranking');
    expect(candidate.entities).toEqual(['Player']);
    expect(candidate.reviewCadence).toBe('monthly');
    expect(candidate.parameterPolicy).toEqual(expect.arrayContaining([
      { name: 'season_start', policy: 'dynamic' },
      { name: 'season_end', policy: 'dynamic' },
      { name: 'top_n', policy: 'dynamic' },
    ]));
    expect(candidate.dqlSource).toContain('pattern = "ranking"');
    expect(candidate.dqlSource).toContain('entities = ["Player"]');
    expect(candidate.dqlSource).toContain('reviewCadence = "monthly"');
    expect(candidate.dqlSource).toContain('LIMIT ${top_n}');
  });

  it('keeps session-only SQL analysis out of the blocks directory until explicit save', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-session-only-'));
    tempDirs.push(projectRoot);

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'paste',
      sourceKind: 'raw-sql',
      sources: [{ path: 'pasted.sql', content: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region;' }],
      domain: 'finance',
      owner: 'analytics',
      provider: 'none',
      persistence: 'session-only',
    });

    expect(session.persistence).toBe('session-only');
    expect(session.generation.createdDrafts).toBe(0);
    expect(session.candidates[0].analysisStatus).toBe('ready');
    expect(session.candidates[0].draftSave).toEqual({ status: 'pending' });
    expect(session.candidates[0].savedPath).toBeUndefined();
    expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
    expect(existsSync(join(projectRoot, 'domains'))).toBe(false);
  });

  it('returns asynchronous candidate shells before bounded import analysis finishes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-async-shell-'));
    tempDirs.push(projectRoot);
    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'paste',
      sourceKind: 'raw-sql',
      sources: [{ path: 'pasted.sql', content: 'SELECT region, SUM(revenue) AS revenue FROM orders GROUP BY region;' }],
      domain: 'finance',
      owner: 'analytics',
      provider: 'none',
      persistence: 'session-only',
      async: true,
    });

    expect(session.candidates[0].analysisStatus).toBe('queued');
    expect(session.generation.createdDrafts).toBe(0);
    const candidatePath = join(projectRoot, '.dql', 'imports', session.id, 'candidates', `${session.candidates[0].id}.json`);
    let completed: any = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      completed = JSON.parse(readFileSync(candidatePath, 'utf-8'));
      if (completed.analysisStatus === 'ready' || completed.analysisStatus === 'needs_attention') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed.analysisStatus).toBe('ready');
    expect(completed.draftSave.status).toBe('pending');
    expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
  });

  it('promotes a complete semantic match before retaining raw SQL', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-semantic-match-'));
    tempDirs.push(projectRoot);
    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: '', domain: 'finance', sql: 'SUM(revenue)', type: 'sum', table: 'orders' }],
      dimensions: [{ name: 'region', label: 'Region', description: '', domain: 'finance', sql: 'region', type: 'string', table: 'orders' }],
      hierarchies: [], segments: [], preAggregations: [], measures: [], entities: [], semanticModels: [], savedQueries: [],
    });

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'paste',
      sourceKind: 'raw-sql',
      sources: [{ path: 'pasted.sql', content: 'SELECT region, SUM(revenue) AS total_revenue FROM orders GROUP BY region;' }],
      domain: 'finance',
      owner: 'analytics',
      provider: 'none',
      persistence: 'session-only',
    }, semanticLayer);

    expect(session.candidates[0].dqlSource).toContain('type = "semantic"');
    expect(session.candidates[0].dqlSource).toContain('metrics = ["total_revenue"]');
    expect(session.candidates[0].dqlSource).toContain('dimensions = ["region"]');
    expect(session.candidates[0].sql).toContain('SUM(revenue)');
    expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
  });

  it('skips the LLM when deterministic fingerprints find a reusable governed block', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-certified-reuse-'));
    tempDirs.push(projectRoot);
    const sql = 'SELECT region, SUM(revenue) AS total_revenue FROM orders GROUP BY region';
    saveBlockStudioArtifacts(projectRoot, {
      source: `block "revenue_by_region" {
  status = "certified"
  domain = "finance"
  type = "custom"
  description = "Revenue by region"
  owner = "analytics"
  tags = ["revenue"]
  query = """
${sql}
  """
  visualization { chart = "bar" }
}`,
      name: 'revenue_by_region',
      domain: 'finance',
      owner: 'analytics',
    });
    saveProviderSettings(projectRoot, { id: 'openai', enabled: true, apiKey: 'sk-test-openai', model: 'gpt-test' });
    const fetchMock = vi.fn(async () => { throw new Error('LLM should not be invoked for exact reuse'); });
    vi.stubGlobal('fetch', fetchMock);

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'paste',
      sourceKind: 'raw-sql',
      sources: [{ path: 'pasted.sql', content: sql }],
      domain: 'finance',
      owner: 'analytics',
      provider: 'openai',
      persistence: 'session-only',
    });

    expect(session.candidates[0].recommendedAction).toBe('reuse_existing');
    expect(session.candidates[0].draftSave.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves dynamic parameter metadata for enterprise certification', () => {
    const source = `
block "Top Players" {
    status = "draft"
    domain = "transformed"
    type = "custom"
    description = "Ranks NBA players by total points across a configurable season range."
    tags = ["nba", "ranking"]
    owner = "analytics"
    pattern = "ranking"
    grain = "player_name"
    entities = ["Player"]
    outputs = ["player_name", "total_points", "games_played"]
    dimensions = ["player_name"]
    allowedFilters = ["season_start", "season_end", "top_n"]
    parameterPolicy {
        season_start = "dynamic"
        season_end = "dynamic"
        top_n = "dynamic"
    }
    filterBindings {
        season_start = "game_date_est"
        season_end = "game_date_est"
        top_n = "limit"
    }
    sourceSystems = ["TRANSFORMED"]
    reviewCadence = "monthly"

    query = """
SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points, COUNT(DISTINCT details_game_id) AS games_played
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN \${season_start} AND \${season_end}
GROUP BY player_name
ORDER BY total_points DESC
LIMIT \${top_n}
    """

    tests {
        assert_row_count > 0
    }
}`;

    const parsed = parseBlockSourceMetadata(source);

    expect(parsed.dimensions).toEqual(['player_name']);
    expect(parsed.parameterPolicy).toEqual([
      { name: 'season_start', policy: 'dynamic' },
      { name: 'season_end', policy: 'dynamic' },
      { name: 'top_n', policy: 'dynamic' },
    ]);
    expect(parsed.filterBindings).toEqual([
      { filter: 'season_start', binding: 'game_date_est' },
      { filter: 'season_end', binding: 'game_date_est' },
      { filter: 'top_n', binding: 'limit' },
    ]);

    const result = new Certifier(ENTERPRISE_RULES).evaluate({
      id: parsed.name,
      name: parsed.name,
      domain: parsed.domain,
      type: parsed.blockType,
      version: '0.0.0',
      status: 'draft',
      gitRepo: '',
      gitPath: 'domains/transformed/blocks/_drafts/top-players.dql',
      gitCommitSha: '',
      description: parsed.description,
      owner: parsed.owner,
      tags: parsed.tags,
      pattern: parsed.pattern,
      grain: parsed.grain,
      entities: parsed.entities,
      declaredOutputs: parsed.outputs,
      dimensions: parsed.dimensions,
      allowedFilters: parsed.allowedFilters,
      parameterPolicy: parsed.parameterPolicy,
      filterBindings: parsed.filterBindings,
      sourceSystems: parsed.sourceSystems,
      replacementFor: parsed.replacementFor,
      reviewCadence: parsed.reviewCadence,
      dependencies: [],
      usedInCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, {
      passed: 1,
      failed: 0,
      skipped: 0,
      duration: 0,
      assertions: [{ name: 'assert_row_count > 0', passed: true }],
      runAt: new Date(),
    });

    expect(result.errors).toEqual([]);
    expect(result.certified).toBe(true);
  });
});

describe('resolveProjectRelativeSqlPaths', () => {
  it('rewrites notebook sample file paths relative to the selected project', () => {
    const sql = "SELECT * FROM read_csv_auto('./data/revenue.csv')";
    const resolved = resolveProjectRelativeSqlPaths(sql, '/tmp/demo-project');

    expect(resolved).toBe("SELECT * FROM read_csv_auto('/tmp/demo-project/data/revenue.csv')");
  });

  it('leaves unrelated string literals untouched', () => {
    const sql = "SELECT './data/revenue.csv' AS label";
    expect(resolveProjectRelativeSqlPaths(sql, '/tmp/demo-project')).toBe(sql);
  });
});

describe('normalizeProjectConnection', () => {
  it('resolves relative local database paths against the project root', () => {
    expect(normalizeProjectConnection(
      { driver: 'duckdb', filepath: './local/dev.duckdb' },
      '/tmp/demo-project',
    )).toEqual({
      driver: 'duckdb',
      filepath: '/tmp/demo-project/local/dev.duckdb',
      moduleSearchPaths: [
        '/tmp/demo-project/.dql/connectors',
        '/tmp/demo-project',
      ],
    });
  });

  it('expands environment placeholders when the value is available', () => {
    const previous = process.env.DQL_TEST_DATABASE;
    process.env.DQL_TEST_DATABASE = 'analytics';
    try {
      expect(normalizeProjectConnection(
        { driver: 'postgresql', host: 'localhost', database: '${DQL_TEST_DATABASE}', username: 'dql' },
        '/tmp/demo-project',
      )).toEqual({ driver: 'postgresql', host: 'localhost', database: 'analytics', username: 'dql' });
    } finally {
      if (previous === undefined) delete process.env.DQL_TEST_DATABASE;
      else process.env.DQL_TEST_DATABASE = previous;
    }
  });
});

describe('getConnectorInstallStatuses', () => {
  it('reports optional connector packages and built-in Databricks support', () => {
    const statuses = getConnectorInstallStatuses('/tmp/demo-project');

    expect(statuses.find((status) => status.driver === 'duckdb')).toMatchObject({
      packageName: 'duckdb',
      // Latest 1.x — the driver normalizes BIGINT, so no version pin is needed.
      packageSpec: 'duckdb@^1.1.0',
      builtIn: false,
      installPath: '/tmp/demo-project/.dql/connectors',
    });
    expect(statuses.find((status) => status.driver === 'snowflake')).toMatchObject({
      packageName: 'snowflake-sdk',
      packageSpec: 'snowflake-sdk@^1.12.0',
      builtIn: false,
    });
    expect(statuses.find((status) => status.driver === 'databricks')).toMatchObject({
      builtIn: true,
      installed: true,
    });
  });
});

describe('ensureConnectorInstalledForStartup', () => {
  it('is a no-op for undefined, built-in, and unknown drivers (never shells out)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ensure-connector-'));
    tempDirs.push(projectRoot);
    // None of these should attempt an install — so no .dql/connectors is created and
    // no throw escapes. (duckdb/snowflake would npm-install, so they're not tested here.)
    expect(() => ensureConnectorInstalledForStartup(projectRoot, undefined)).not.toThrow();
    expect(() => ensureConnectorInstalledForStartup(projectRoot, 'databricks')).not.toThrow();
    expect(() => ensureConnectorInstalledForStartup(projectRoot, 'file')).not.toThrow();
    expect(() => ensureConnectorInstalledForStartup(projectRoot, 'not-a-real-driver')).not.toThrow();
    expect(existsSync(join(projectRoot, '.dql/connectors'))).toBe(false);
  });
});

describe('Snowflake Node runtime startup guard (API-007, E2E-014)', () => {
  it('refuses below the driver floor', () => {
    // `snowflake-sdk` declares `engines: { node: '>=20' }`. Below that is a real
    // incompatibility and stopping early beats crashing mid-query.
    expect(() => assertConnectionNodeCompatibility({ driver: 'snowflake' }, '18.20.4')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_NODE_RUNTIME' }),
    );
  });

  it('allows tested LTS releases', () => {
    for (const version of ['20.11.0', '22.18.0', '24.3.0']) {
      expect(() => assertConnectionNodeCompatibility({ driver: 'snowflake' }, version)).not.toThrow();
    }
  });

  it('allows a newer Node than we have tested instead of blocking it', () => {
    // This previously threw. The guard was an allowlist of exactly [20, 22, 24],
    // which is stricter than snowflake-sdk itself: users installed cleanly
    // (our engines.node is >=20) and were then blocked at the first query on
    // Node 25, and every future release — including each new LTS — would have
    // hard-failed the same way until DQL shipped a new build. An untested
    // runtime above the driver's own floor is a warning, not a refusal.
    for (const version of ['25.2.1', '26.0.0']) {
      expect(() => assertConnectionNodeCompatibility({ driver: 'snowflake' }, version)).not.toThrow();
    }
  });

  it('never gates a non-Snowflake driver', () => {
    expect(() => assertConnectionNodeCompatibility({ driver: 'duckdb' }, '18.20.4')).not.toThrow();
  });
});

describe('semantic compatibility server survival (API-004, API-007, E2E-014)', () => {
  it('returns structured source drift and remains healthy when a selected cloud metric inventory is stale', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-semantic-server-survival-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'semantic-layer', 'metrics'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'semantic-survival',
      semanticLayer: { provider: 'dql', path: 'semantic-layer' },
    }));
    writeFileSync(join(projectRoot, 'semantic-layer', 'metrics', 'revenue.yaml'), [
      'name: revenue',
      'label: Revenue',
      'description: Governed revenue',
      'domain: finance',
      'sql: SUM(amount)',
      'type: sum',
      'table: orders',
      '',
    ].join('\n'));
    saveTestedSemanticRuntimeSettings(projectRoot, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, { ok: true, message: 'Legacy connection-only test', dialect: 'snowflake' }, createWarehouseTargetIdentity({
      connectionRef: 'connection:test',
      driver: 'snowflake',
      redactedContext: { account: 'ACME', database: 'ANALYTICS', schema: 'SEMANTIC' },
    }));

    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/^https?:\/\/127\.0\.0\.1/.test(target)) return nativeFetch(input, init);
      return new Response(JSON.stringify({
        data: {
          environmentInfo: { dialect: 'snowflake' },
          metricsPaginated: { totalItems: 1 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const compatibility = await nativeFetch(`${base}/api/semantic-layer/compatible-dims?metrics=revenue`);
      expect(compatibility.status).toBe(409);
      await expect(compatibility.json()).resolves.toMatchObject({
        code: 'SEMANTIC_SOURCE_DRIFT',
        recoverable: true,
        details: {
          adapter: 'dbt-cloud',
          metricInventoryState: 'missing',
          requestedMetrics: ['revenue'],
        },
      });

      const health = await nativeFetch(`${base}/api/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ status: 'ok' });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });
});

describe('notebook cell execution isolation (API-006, API-007, UI-009, E2E-014)', () => {
  it('CFG-003/UI-015 resolves the legacy default connection identically for Ask and Notebook AI', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-default-connection-parity-'));
    tempDirs.push(projectRoot);
    const databasePath = join(projectRoot, 'legacy-default.duckdb');
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'default-connection-parity',
      defaultConnection: { driver: 'file', filepath: databasePath },
    }));

    const executionConnections: Array<{ filepath?: string } | undefined> = [];
    const executeQuery = vi.fn(async (
      _sql: string,
      _params: unknown[],
      _variables: Record<string, unknown>,
      executionConnection?: { filepath?: string },
    ): Promise<QueryResult> => {
      executionConnections.push(executionConnection);
      return {
        columns: [{ name: 'value', type: 'number', driverType: 'INTEGER' }],
        rows: [{ value: 1 }],
        rowCount: 1,
        executionTimeMs: 1,
      };
    });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery } as unknown as QueryExecutor,
        connection: { driver: 'file', filepath: databasePath },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
        agentRunExecutors: {
          generated_answer: () => ({
            summary: 'Used the configured default connection.',
            answer: 'One row.',
            status: 'completed',
            trustState: 'review_required',
            stopReason: 'generated_review_required',
            artifacts: [{
              id: 'answer:default-connection',
              kind: 'answer',
              title: 'Default connection answer',
              trustState: 'review_required',
              payload: { text: 'One row.' },
            }],
            evaluations: [],
            nextActions: [],
          }),
        },
      });
      const base = `http://127.0.0.1:${port}`;

      const askResponse = await fetch(`${base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'How many rows are there?',
          requestedMode: 'ask',
          executionTarget: { target: 'connection', connectionName: 'default' },
        }),
      });
      expect(askResponse.status).toBe(201);

      const notebookResponse = await fetch(`${base}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: 'SELECT 1 AS value',
          executionTarget: { target: 'connection', connectionName: 'default' },
        }),
      });
      expect(notebookResponse.status).toBe(200);
      expect(executionConnections.at(-1)?.filepath).toBe(databasePath);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('binds every response to its cell run and does not leak a failed cell into the next execution', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-notebook-cell-isolation-'));
    tempDirs.push(projectRoot);
    const databasePath = join(projectRoot, 'notebook.duckdb');
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'notebook-cell-isolation',
      connections: {
        default: { driver: 'file', filepath: databasePath },
      },
      defaultConnectionName: 'default',
    }));

    const executeQuery = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('FAIL_FIRST')) {
        throw new Error("SQL compilation error: invalid identifier 'FAIL_FIRST'");
      }
      return {
        columns: [{ name: 'value', type: 'number', driverType: 'INTEGER' }],
        rows: [{ value: 2 }],
        rowCount: 1,
        executionTimeMs: 1,
      };
    });
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: { executeQuery } as unknown as QueryExecutor,
        connection: { driver: 'file', filepath: databasePath },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const executeCell = (cellId: string, runId: string, sql: string) => fetch(`${base}/api/notebook/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell: {
            id: cellId,
            type: 'dql',
            source: `block "${cellId}" {
  type = "custom"
  query = """${sql}"""
}`,
          },
          executionContext: {
            notebookPath: 'notebooks/isolation.dqlnb',
            cellId,
            runId,
            source: 'notebook_dql_cell',
          },
          executionTarget: { target: 'connection', connectionName: 'default' },
        }),
      });

      const failedResponse = await executeCell('cell_failed', 'run_failed', 'SELECT FAIL_FIRST');
      expect(failedResponse.status).toBe(500);
      await expect(failedResponse.json()).resolves.toMatchObject({
        code: 'COLUMN_NOT_FOUND',
        details: {
          phase: 'execution',
          executionTarget: {
            target: 'connection',
            connectionName: 'default',
          },
          executionContext: {
            cellId: 'cell_failed',
            runId: 'run_failed',
          },
        },
      });

      // A BARE internal identity names no database or schema. DQL probes
      // information_schema for the name; this fixture has no such relation, so
      // the refusal stands — and now says the connection was actually checked
      // rather than sending the user to an AI repair. (A QUALIFIED identity is
      // decoded mechanically and runs — covered separately below.)
      const internalIdResponse = await executeCell(
        'cell_internal_id',
        'run_internal_id',
        'SELECT value FROM source::monthly_revenue',
      );
      expect(internalIdResponse.status).toBe(400);
      await expect(internalIdResponse.json()).resolves.toMatchObject({
        code: 'DQL_INTERNAL_RELATION_ID',
        error: expect.stringContaining('internal DQL graph relation identifier'),
        details: {
          phase: 'compilation',
          executionContext: {
            cellId: 'cell_internal_id',
            runId: 'run_internal_id',
          },
        },
      });

      /**
       * REPORTED REPEATEDLY. A model leaks `source::db.schema.table` into SQL
       * despite the prompt forbidding it. The suffix IS the physical relation,
       * and DQL's own error already said "use the physical relation instead" —
       * so rejecting the cell made the user (or another AI round trip) perform a
       * substitution DQL can do itself. It is decoded, then run.
       */
      const qualifiedInternalId = await executeCell(
        'cell_qualified_id',
        'run_qualified_id',
        'SELECT value FROM source::dev.reporting.monthly_revenue',
      );
      expect(qualifiedInternalId.status).toBe(200);

      const successfulResponse = await executeCell('cell_success', 'run_success', 'SELECT 2 AS value');
      expect(successfulResponse.status).toBe(200);
      await expect(successfulResponse.json()).resolves.toMatchObject({
        cellType: 'dql',
        executionContext: {
          cellId: 'cell_success',
          runId: 'run_success',
        },
        executionTarget: {
          target: 'connection',
          connectionName: 'default',
        },
        result: {
          rows: [{ value: 2 }],
          rowCount: 1,
        },
        compiledSql: expect.stringContaining('SELECT 2 AS value'),
      });

      const sqlResponse = await fetch(`${base}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: 'SELECT 2 AS value',
          executionContext: {
            notebookPath: 'notebooks/isolation.dqlnb',
            cellId: 'cell_sql',
            runId: 'run_sql',
            source: 'notebook_sql_cell',
          },
        }),
      });
      expect(sqlResponse.status).toBe(200);
      await expect(sqlResponse.json()).resolves.toMatchObject({
        executionContext: {
          cellId: 'cell_sql',
          runId: 'run_sql',
        },
        executionTarget: {
          target: 'connection',
          connectionName: 'default',
        },
        compiledSql: 'SELECT 2 AS value',
        executedSql: 'SELECT 2 AS value',
      });
      // 5: the failed cell, the DECODED qualified internal id, the plain
      // success, the SQL cell, and the information_schema probe that proves the
      // bare internal id names nothing visible. The bare id itself is never run.
      expect(executeQuery).toHaveBeenCalledTimes(5);

      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });
});

describe('loadProjectConfig', () => {
  it('uses the configured named Snowflake connection for execution', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-config-default-name-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      defaultConnectionName: 'warehouse',
      connections: {
        default: { driver: 'duckdb', filepath: ':memory:' },
        warehouse: {
          driver: 'snowflake',
          account: 'acme',
          username: 'analyst',
          database: 'analytics',
          warehouse: 'compute_wh',
          schema: 'public',
        },
      },
    }), 'utf-8');

    const config = loadProjectConfig(projectRoot);

    expect(config.defaultConnectionName).toBe('warehouse');
    expect(config.defaultConnection).toMatchObject({
      driver: 'snowflake',
      account: 'acme',
      database: 'analytics',
    });
  });

  it('auto-promotes the only real connection over an in-memory starter DuckDB placeholder', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-config-auto-default-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      connections: {
        default: { driver: 'duckdb', filepath: ':memory:' },
        snowflake: {
          driver: 'snowflake',
          account: 'acme',
          username: 'analyst',
          database: 'analytics',
          warehouse: 'compute_wh',
        },
      },
    }), 'utf-8');

    const config = loadProjectConfig(projectRoot);

    expect(config.defaultConnectionName).toBe('snowflake');
    expect(config.defaultConnection?.driver).toBe('snowflake');
  });

  it('keeps a detected DuckDB file as default when it is a real project connection', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-config-real-duckdb-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      connections: {
        default: { driver: 'duckdb', filepath: 'jaffle_shop.duckdb' },
        snowflake: {
          driver: 'snowflake',
          account: 'acme',
          username: 'analyst',
          database: 'analytics',
          warehouse: 'compute_wh',
        },
      },
    }), 'utf-8');

    const config = loadProjectConfig(projectRoot);

    expect(config.defaultConnectionName).toBe('default');
    expect(config.defaultConnection).toMatchObject({
      driver: 'duckdb',
      filepath: 'jaffle_shop.duckdb',
    });
  });
});

describe('discoverDbtProfileConnections', () => {
  it('passes the discovered profiles directory to dbt parse (CFG-003)', () => {
    expect(buildDbtParseArgs('/repos/shop', '/secrets/dbt')).toEqual([
      'parse', '--project-dir', '/repos/shop', '--profiles-dir', '/secrets/dbt',
    ]);
  });

  it('loads a compatibility profile.yaml from a configured external dbt repo and activates its default target (CFG-003, E2E-003)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-profile-workspace-'));
    const dbtRoot = mkdtempSync(join(tmpdir(), 'dbt-profile-repo-'));
    tempDirs.push(projectRoot, dbtRoot);
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: shop\nprofile: shop\n', 'utf-8');
    writeFileSync(join(dbtRoot, 'profile.yaml'), [
      'shop:',
      '  target: dev',
      '  outputs:',
      '    dev:',
      '      type: duckdb',
      '      path: warehouse.duckdb',
    ].join('\n'), 'utf-8');
    writeFileSync(join(dbtRoot, 'warehouse.duckdb'), '', 'utf-8');
    const config = { dbt: { projectDir: dbtRoot, profilesDir: dbtRoot } };

    const candidates = discoverDbtProfileConnections(projectRoot, config);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ profileName: 'shop', targetName: 'dev', missingFields: [] });
    expect(resolveDbtProfileRuntimeConnection(projectRoot, config)).toMatchObject({
      driver: 'duckdb', filepath: join(dbtRoot, 'warehouse.duckdb'),
    });
  });

  it('previews an explicitly selected profiles.yml or profile.yaml path without filtering to the dbt project profile', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-explicit-profile-workspace-'));
    const profileRoot = mkdtempSync(join(tmpdir(), 'dql-explicit-profile-file-'));
    tempDirs.push(projectRoot, profileRoot);
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: shop\nprofile: shop\n', 'utf-8');
    writeFileSync(join(profileRoot, 'dbt_project.yml'), 'name: finance\nprofile: finance\n', 'utf-8');
    writeFileSync(join(profileRoot, 'warehouse.duckdb'), '', 'utf-8');
    const profilePath = join(profileRoot, 'profile.yaml');
    writeFileSync(profilePath, [
      'finance:',
      '  target: local',
      '  outputs:',
      '    local:',
      '      type: duckdb',
      '      path: warehouse.duckdb',
    ].join('\n'), 'utf-8');

    const fromFile = discoverDbtProfileConnections(projectRoot, {}, profilePath);
    const fromFolder = discoverDbtProfileConnections(projectRoot, {}, profileRoot);

    expect(fromFile).toHaveLength(1);
    expect(fromFile[0]).toMatchObject({ profileName: 'finance', targetName: 'local', adapter: 'duckdb', missingFields: [] });
    expect(fromFile[0]?.connection.filepath).toBe(join(profileRoot, 'warehouse.duckdb'));
    expect(fromFolder).toEqual(fromFile);
  });

  it('maps only lightweight-supported dbt profiles.yml targets into DQL connection drafts', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-profiles-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: banking\nprofile: banking\n', 'utf-8');
    writeFileSync(join(projectRoot, 'profiles.yml'), [
      'banking:',
      '  target: dev',
      '  outputs:',
      '    dev:',
      '      type: postgres',
      '      host: "{{ env_var(\'PGHOST\', \'localhost\') }}"',
      '      port: 5432',
      '      dbname: analytics',
      '      schema: marts',
      '      user: analyst',
      '      password: "{{ env_var(\'PGPASSWORD\') }}"',
      '    local:',
      '      type: duckdb',
      '      path: banking.duckdb',
    ].join('\n'), 'utf-8');

    const profilePath = join(projectRoot, 'profiles.yml');
    const candidates = discoverDbtProfileConnections(projectRoot, {});
    const candidate = candidates.find((item) => item.path === profilePath && item.profileName === 'banking' && item.targetName === 'local');

    expect(candidate).toBeDefined();
    // The duckdb `path` is relative to the dbt project dir; we resolve it to an absolute
    // path so the imported connection opens the real warehouse, not an empty db elsewhere.
    expect(candidate?.connection).toMatchObject({
      driver: 'duckdb',
      filepath: join(projectRoot, 'banking.duckdb'),
    });
    expect(candidate?.warnings).toContain('Not the default dbt target "dev".');
    expect(candidates.some((item) => item.adapter === 'postgres')).toBe(false);
  });

  it('resolves a relative duckdb path against the dbt project dir, not the DQL workspace (regression)', () => {
    // Workspace layout: DQL workspace at projectRoot, dbt project in a sibling-style subdir.
    // A new user with a standard dbt+duckdb repo had the relative `path` resolved against the
    // DQL workspace, so DuckDB silently created an EMPTY db there and every query failed.
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-duckdb-path-'));
    tempDirs.push(projectRoot);
    const dbtDir = join(projectRoot, 'analytics');
    mkdirSync(dbtDir, { recursive: true });
    writeFileSync(join(dbtDir, 'dbt_project.yml'), 'name: jaffle\nprofile: jaffle\n', 'utf-8');
    writeFileSync(join(dbtDir, 'profiles.yml'), [
      'jaffle:',
      '  target: dev',
      '  outputs:',
      '    dev:',
      '      type: duckdb',
      '      path: jaffle_shop.duckdb',
    ].join('\n'), 'utf-8');
    // The real warehouse lives next to dbt_project.yml.
    writeFileSync(join(dbtDir, 'jaffle_shop.duckdb'), '', 'utf-8');

    const candidates = discoverDbtProfileConnections(projectRoot, { dbt: { projectDir: 'analytics' } });
    const candidate = candidates.find((item) => item.targetName === 'dev' && item.adapter === 'duckdb');

    expect(candidate).toBeDefined();
    // Resolved against the dbt dir, NOT projectRoot, and NOT left relative.
    expect(candidate?.connection.filepath).toBe(join(dbtDir, 'jaffle_shop.duckdb'));
    expect(candidate?.connection.filepath).not.toBe(join(projectRoot, 'jaffle_shop.duckdb'));
    // The file exists, so no "not found" warning.
    expect(candidate?.warnings.some((w) => w.includes('DuckDB file not found'))).toBe(false);
  });

  it('warns when the resolved duckdb file does not exist instead of failing silently (regression)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-duckdb-missing-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: jaffle\nprofile: jaffle\n', 'utf-8');
    writeFileSync(join(projectRoot, 'profiles.yml'), [
      'jaffle:',
      '  target: dev',
      '  outputs:',
      '    dev:',
      '      type: duckdb',
      '      path: not_built_yet.duckdb',
    ].join('\n'), 'utf-8');

    const candidates = discoverDbtProfileConnections(projectRoot, {});
    const candidate = candidates.find((item) => item.targetName === 'dev' && item.adapter === 'duckdb');

    expect(candidate?.connection.filepath).toBe(join(projectRoot, 'not_built_yet.duckdb'));
    expect(candidate?.warnings.some((w) => w.includes('DuckDB file not found'))).toBe(true);
    expect(resolveDbtProfileRuntimeConnection(projectRoot, {})).toBeNull();
  });

  it('maps Snowflake dbt key-pair profiles from inline keys and key files', () => {
    const previousPrivateKey = process.env.SNOWFLAKE_PRIVATE_KEY;
    const previousPrivateKeyPath = process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
    const previousPrivateKeyPassphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
    delete process.env.SNOWFLAKE_PRIVATE_KEY;
    delete process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
    delete process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;

    try {
      const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-snowflake-profiles-'));
      tempDirs.push(projectRoot);
      writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: analytics\nprofile: analytics\n', 'utf-8');
      writeFileSync(join(projectRoot, 'profiles.yml'), [
        'analytics:',
        '  target: inline',
        '  outputs:',
        '    inline:',
        '      type: snowflake',
        '      account: xy12345.us-east-1',
        '      warehouse: ANALYTICS_WH',
        '      database: PROD',
        '      schema: MARTS',
        '      user: svc_dql',
        '      role: ANALYST',
        '      private_key: "{{ env_var(\'SNOWFLAKE_PRIVATE_KEY\') }}"',
        '      private_key_passphrase: "{{ env_var(\'SNOWFLAKE_PRIVATE_KEY_PASSPHRASE\', \'\') }}"',
        '    keyfile:',
        '      type: snowflake',
        '      account: xy12345.us-east-1',
        '      warehouse: ANALYTICS_WH',
        '      database: PROD',
        '      schema: MARTS',
        '      user: svc_dql',
        '      role: ANALYST',
        '      authenticator: SNOWFLAKE_JWT',
        '      private_key_path: "{{ env_var(\'SNOWFLAKE_PRIVATE_KEY_PATH\') }}"',
      ].join('\n'), 'utf-8');

      const candidates = discoverDbtProfileConnections(projectRoot, {});
      const inline = candidates.find((item) => item.profileName === 'analytics' && item.targetName === 'inline');
      const keyfile = candidates.find((item) => item.profileName === 'analytics' && item.targetName === 'keyfile');

      expect(inline?.connection).toMatchObject({
        driver: 'snowflake',
        account: 'xy12345.us-east-1',
        warehouse: 'ANALYTICS_WH',
        database: 'PROD',
        schema: 'MARTS',
        username: 'svc_dql',
        role: 'ANALYST',
        privateKey: '${SNOWFLAKE_PRIVATE_KEY}',
        authMethod: 'key_pair',
      });
      expect(inline?.missingFields).toContain('env:SNOWFLAKE_PRIVATE_KEY');
      expect(inline?.missingFields).not.toContain('privateKeyPath');

      expect(keyfile?.connection).toMatchObject({
        driver: 'snowflake',
        privateKeyPath: '${SNOWFLAKE_PRIVATE_KEY_PATH}',
        authenticator: 'SNOWFLAKE_JWT',
        authMethod: 'key_pair',
      });
      expect(keyfile?.missingFields).toContain('env:SNOWFLAKE_PRIVATE_KEY_PATH');
      expect(keyfile?.missingFields).not.toContain('privateKeyPath');
      expect(keyfile?.warnings).toContain('Not the default dbt target "inline".');
    } finally {
      if (previousPrivateKey === undefined) delete process.env.SNOWFLAKE_PRIVATE_KEY;
      else process.env.SNOWFLAKE_PRIVATE_KEY = previousPrivateKey;
      if (previousPrivateKeyPath === undefined) delete process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
      else process.env.SNOWFLAKE_PRIVATE_KEY_PATH = previousPrivateKeyPath;
      if (previousPrivateKeyPassphrase === undefined) delete process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
      else process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE = previousPrivateKeyPassphrase;
    }
  });

  it('maps enterprise Snowflake and Databricks dbt profile options', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-enterprise-profiles-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: analytics\nprofile: analytics\n', 'utf-8');
    writeFileSync(join(projectRoot, 'profiles.yml'), [
      'analytics:',
      '  target: snowflake_prod',
      '  outputs:',
      '    snowflake_prod:',
      '      type: snowflake',
      '      account: xy12345.us-east-1',
      '      warehouse: ANALYTICS_WH',
      '      database: PROD',
      '      schema: MARTS',
      '      user: svc_dql',
      '      authenticator: PROGRAMMATIC_ACCESS_TOKEN',
      '      token: "{{ env_var(\'SNOWFLAKE_PAT\') }}"',
      '      query_tag: team=analytics;app=dql',
      '      proxy_host: proxy.internal',
      '      proxy_port: 8080',
      '    databricks_prod:',
      '      type: databricks',
      '      host: adb-123.4.azuredatabricks.net',
      '      http_path: /sql/1.0/warehouses/9196548d010cf14d',
      '      catalog: main',
      '      schema: marts',
      '      auth_type: oauth',
      '      token: "{{ env_var(\'DATABRICKS_TOKEN\') }}"',
      '      wait_timeout: 50s',
      '      byte_limit: 1000000',
    ].join('\n'), 'utf-8');

    const candidates = discoverDbtProfileConnections(projectRoot, {});
    const snowflake = candidates.find((item) => item.targetName === 'snowflake_prod');
    const databricks = candidates.find((item) => item.targetName === 'databricks_prod');

    expect(snowflake?.connection).toMatchObject({
      driver: 'snowflake',
      authMethod: 'programmatic_access_token',
      token: '${SNOWFLAKE_PAT}',
      queryTag: 'team=analytics;app=dql',
      proxyHost: 'proxy.internal',
      proxyPort: 8080,
    });
    expect(snowflake?.missingFields).toContain('env:SNOWFLAKE_PAT');
    expect(snowflake?.missingFields).not.toContain('password');

    expect(databricks?.connection).toMatchObject({
      driver: 'databricks',
      host: 'adb-123.4.azuredatabricks.net',
      httpPath: '/sql/1.0/warehouses/9196548d010cf14d',
      catalog: 'main',
      authMethod: 'oauth',
      token: '${DATABRICKS_TOKEN}',
      waitTimeout: '50s',
      byteLimit: 1000000,
    });
    expect(databricks?.missingFields).toContain('env:DATABRICKS_TOKEN');
    expect(databricks?.missingFields).not.toContain('httpPath');
  });
});

describe('prepareLocalExecution', () => {
  it('returns bounded searchable choices only from server-approved page filter columns', () => {
    const options = collectDashboardFilterOptions({
      filters: [{ id: 'customer_name', label: 'Customer name', type: 'search', bindsTo: 'customer_name', optionSource: { mode: 'distinct_query', limit: 2 } }],
      layout: {
        kind: 'grid',
        cols: 12,
        rowHeight: 72,
        items: [{
          i: 'customers', x: 0, y: 0, w: 6, h: 4,
          block: { blockId: 'customer_profile' },
          viz: { type: 'table' },
          filterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate', capability: 'preflight_required' }],
        }, {
          i: 'unsupported', x: 6, y: 0, w: 6, h: 4,
          block: { blockId: 'revenue' },
          viz: { type: 'table' },
          filterBindings: [{ filter: 'customer_name', capability: 'unsupported', unsupportedReason: 'Not available.' }],
        }],
      },
    }, [{
      tileId: 'customers',
      status: 'ok',
      result: {
        columns: ['customer_name', 'lifetime_spend'],
        rows: [
          { customer_name: 'Zoe', lifetime_spend: 10 },
          { customer_name: 'Amy', lifetime_spend: 20 },
          { customer_name: 'Zoe', lifetime_spend: 30 },
          { customer_name: 'Ben', lifetime_spend: 40 },
        ],
        rowCount: 4,
      },
      filterableColumns: [{ column: 'customer_name', predicateTarget: 'customer_name' }],
    }, {
      tileId: 'unsupported',
      status: 'ok',
      result: { columns: ['customer_name'], rows: [{ customer_name: 'Must not leak' }], rowCount: 1 },
      filterableColumns: [{ column: 'customer_name', predicateTarget: 'customer_name' }],
    }], 100);

    expect(options).toEqual([{
      filterId: 'customer_name',
      values: ['Amy', 'Ben'],
      truncated: true,
      sourceTileIds: ['customers'],
    }]);
  });

  it('returns ephemeral date availability bounds and an explicit empty state for date controls', () => {
    const dashboard = {
      filters: [{ id: 'order_date', label: 'Order date', type: 'daterange' as const, bindsTo: 'order_date' }],
      layout: {
        kind: 'grid' as const,
        cols: 12,
        rowHeight: 72,
        items: [{
          i: 'orders', x: 0, y: 0, w: 12, h: 4,
          block: { blockId: 'orders' },
          viz: { type: 'table' as const },
          filterBindings: [{ filter: 'order_date', binding: 'order_date', mode: 'predicate' as const, capability: 'preflight_required' as const }],
        }],
      },
    };
    const populated = collectDashboardFilterOptions(dashboard, [{
      tileId: 'orders',
      status: 'ok',
      result: {
        columns: ['order_date'],
        rows: [{ order_date: '2025-03-15T00:00:00Z' }, { order_date: '2024-01-02' }, { order_date: null }],
        rowCount: 3,
      },
      filterableColumns: [{ column: 'order_date', predicateTarget: 'order_date' }],
    }]);
    expect(populated).toEqual([{
      filterId: 'order_date',
      values: [],
      truncated: false,
      sourceTileIds: ['orders'],
      valueCount: 2,
      dateRange: { min: '2024-01-02', max: '2025-03-15' },
    }]);

    const empty = collectDashboardFilterOptions(dashboard, [{
      tileId: 'orders',
      status: 'ok',
      result: { columns: ['order_date'], rows: [{ order_date: null }], rowCount: 1 },
      filterableColumns: [{ column: 'order_date', predicateTarget: 'order_date' }],
    }]);
    expect(empty).toEqual([{
      filterId: 'order_date',
      values: [],
      truncated: false,
      sourceTileIds: ['orders'],
      valueCount: 0,
    }]);
  });

  it('fills block parameters from dashboard filters before execution', () => {
    const variables = dashboardRuntimeVariables(
      {
        filters: [
          { id: 'season_range', type: 'daterange', default: [2016, 2017] },
        ],
      },
      { top_n: 5 },
    );
    const applied = applyDashboardFiltersToBlockExecution({
      sql: 'SELECT player_name, total_points FROM player_points WHERE season BETWEEN $1 AND $2 LIMIT $3',
      sqlParams: [
        { name: 'season_start', position: 1 },
        { name: 'season_end', position: 2 },
        { name: 'top_n', position: 3 },
      ],
      variables,
      block: {
        name: 'Top Players',
        parameterPolicy: [
          { name: 'season_start', policy: 'dynamic' },
          { name: 'season_end', policy: 'dynamic' },
          { name: 'top_n', policy: 'dynamic' },
        ],
      },
      dashboard: {
        filters: [
          { id: 'season_range', type: 'daterange', default: [2016, 2017] },
        ],
      },
    });

    expect(applied.sql).toBe('SELECT player_name, total_points FROM player_points WHERE season BETWEEN $1 AND $2 LIMIT $3');
    expect(applied.sqlParams).toHaveLength(3);
    expect(applied.variables).toMatchObject({
      season_start: 2016,
      season_end: 2017,
      top_n: 5,
    });
    expect(applied.appliedFilters).toEqual([
      {
        filter: 'season_range',
        mode: 'parameter',
        paramNames: ['season_start', 'season_end'],
      },
    ]);
  });

  it('wraps block SQL with safe dashboard predicates from filter bindings', () => {
    const applied = applyDashboardFiltersToBlockExecution({
      sql: 'SELECT region, SUM(revenue) AS revenue FROM marts.orders GROUP BY 1',
      sqlParams: [],
      variables: { region: ['East', 'West'] },
      block: {
        name: 'Revenue By Region',
        allowedFilters: ['region'],
        filterBindings: [{ filter: 'region', binding: 'region' }],
      },
      dashboard: {
        filters: [{ id: 'region', type: 'select' }],
      },
    });

    expect(applied.sql).toBe('SELECT * FROM (SELECT region, SUM(revenue) AS revenue FROM marts.orders GROUP BY 1) _dql_filter WHERE _dql_filter.region IN ($1, $2)');
    expect(applied.sqlParams).toEqual([
      { name: '__dashboard_filter_region_value_1', position: 1 },
      { name: '__dashboard_filter_region_value_2', position: 2 },
    ]);
    expect(applied.variables).toMatchObject({
      __dashboard_filter_region_value_1: 'East',
      __dashboard_filter_region_value_2: 'West',
    });
    expect(applied.appliedFilters[0]).toMatchObject({
      filter: 'region',
      binding: 'region',
      mode: 'predicate',
    });
  });

  it('applies a server-proven App tile binding added by the manual filter editor', () => {
    const applied = applyDashboardFiltersToBlockExecution({
      sql: 'SELECT customer_name, customer_type FROM marts.customers',
      sqlParams: [],
      variables: { customer_type: 'new' },
      block: {
        name: 'Customer Profile',
        allowedFilters: ['customer_name'],
      },
      dashboard: {
        filters: [{ id: 'customer_type', type: 'select', bindsTo: 'customer_type' }],
      },
      tileFilterBindings: [{
        filter: 'customer_type',
        binding: 'customer_type',
        mode: 'predicate',
      }],
    });

    expect(applied.sql).toBe('SELECT * FROM (SELECT customer_name, customer_type FROM marts.customers) _dql_filter WHERE _dql_filter.customer_type = $1');
    expect(applied.appliedFilters).toEqual([expect.objectContaining({
      filter: 'customer_type',
      binding: 'customer_type',
      mode: 'predicate',
    })]);
  });

  it('does not apply a dashboard filter to a component outside its explicit scope', () => {
    const applied = applyDashboardFiltersToBlockExecution({
      sql: 'SELECT customer_name, customer_type FROM marts.customers',
      sqlParams: [],
      variables: { customer_type: 'new' },
      block: { name: 'Customer Profile', allowedFilters: ['customer_type'] },
      dashboard: {
        filters: [{ id: 'customer_type', type: 'select', bindsTo: 'customer_type', scope: { tileIds: ['customer-table'] } }],
      },
      tileId: 'revenue-chart',
      tileFilterBindings: [{ filter: 'customer_type', binding: 'customer_type', mode: 'predicate' }],
    });

    expect(applied.sql).toBe('SELECT customer_name, customer_type FROM marts.customers');
    expect(applied.appliedFilters).toEqual([]);
    expect(applied.skippedFilters).toEqual([{ filter: 'customer_type', reason: 'component is outside this filter scope' }]);
  });

  it('maps App-wide filter values into only explicitly linked semantic components', () => {
    const dashboard = {
      filters: [{ id: 'segment', type: 'multiselect' as const, field: { name: 'customer_segment' }, scope: { tileIds: ['segment-chart'] } }],
    };
    const semantic = {
      id: 'segment-revenue', provider: 'metricflow' as const, metrics: ['revenue'], dimensions: ['customer_segment'],
      semanticModelRefs: ['orders'], definitionFingerprint: 'sha256:semantic',
    };

    expect(dashboardSemanticFiltersForTile(dashboard, {
      i: 'segment-chart', semantic,
      filterBindings: [{ filter: 'segment', binding: 'customer_segment', mode: 'semantic', capability: 'preflight_required' }],
    }, { segment: ['Enterprise', 'SMB'] })).toEqual([{
      dimension: 'customer_segment', operator: 'in', values: ['Enterprise', 'SMB'],
    }]);
    expect(dashboardSemanticFiltersForTile(dashboard, {
      i: 'unlinked-chart', semantic,
      filterBindings: [{ filter: 'segment', binding: 'customer_segment', mode: 'semantic', capability: 'preflight_required' }],
    }, { segment: ['Enterprise'] })).toEqual([]);
  });

  it('treats a search control as a case-insensitive contains predicate', () => {
    const applied = applyDashboardFiltersToBlockExecution({
      sql: 'SELECT customer_name, customer_type FROM marts.customers',
      sqlParams: [],
      variables: { customer_name: 'aaron' },
      block: { name: 'Customer Profile', allowedFilters: ['customer_name'] },
      dashboard: { filters: [{ id: 'customer_name', type: 'search', bindsTo: 'customer_name' }] },
      tileFilterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate' }],
    });

    expect(applied.sql).toBe('SELECT * FROM (SELECT customer_name, customer_type FROM marts.customers) _dql_filter WHERE LOWER(_dql_filter.customer_name) LIKE LOWER($1)');
    expect(applied.variables.__dashboard_filter_customer_name_contains).toBe('%aaron%');
  });

  it('rewrites SQL paths for file-backed notebook queries', () => {
    const prepared = prepareLocalExecution(
      "SELECT * FROM read_csv_auto('./data/revenue.csv')",
      { driver: 'file', filepath: ':memory:' },
      '/tmp/demo-project',
      { dataDir: './data' },
    );

    expect(prepared.connection).toEqual({
      driver: 'file',
      filepath: ':memory:',
      moduleSearchPaths: [
        '/tmp/demo-project/.dql/connectors',
        '/tmp/demo-project',
      ],
    });
    expect(prepared.sql).toBe("SELECT * FROM read_csv_auto('/tmp/demo-project/data/revenue.csv')");
  });

  it('resolves dbt ref macros from a parent project manifest before Snowflake execution', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-ref-parent-'));
    tempDirs.push(repoRoot);
    const projectRoot = join(repoRoot, 'dql');
    const targetDir = join(repoRoot, 'target');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      nodes: {
        'model.nba_analysis.fct_player_performance': {
          resource_type: 'model',
          name: 'fct_player_performance',
          alias: 'fct_player_performance',
          database: 'NBA_GAMES',
          schema: 'RAW',
          relation_name: 'NBA_GAMES.RAW.FCT_PLAYER_PERFORMANCE',
        },
      },
      sources: {},
    }), 'utf-8');

    const prepared = prepareLocalExecution(
      "SELECT * FROM {{ ref('fct_player_performance') }} LIMIT 10",
      { driver: 'snowflake', account: 'test', username: 'user', warehouse: 'WH', database: 'NBA_GAMES', schema: 'RAW' },
      projectRoot,
      {},
    );

    expect(prepared.sql).toBe('SELECT * FROM NBA_GAMES.RAW.FCT_PLAYER_PERFORMANCE LIMIT 10');
  });

  it('resolves dbt source macros from configured dbt project metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-source-config-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: nba_analysis\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      nodes: {},
      sources: {
        'source.nba_analysis.raw.games': {
          source_name: 'raw',
          name: 'games',
          identifier: 'GAMES',
          database: 'NBA_GAMES',
          schema: 'RAW',
          relation_name: 'NBA_GAMES.RAW.GAMES',
        },
      },
    }), 'utf-8');

    expect(resolveDbtMacrosForExecution(
      "SELECT * FROM {{ source('raw', 'games') }}",
      projectRoot,
      { dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' } },
    )).toBe('SELECT * FROM NBA_GAMES.RAW.GAMES');
  });

  it('fails fast with a clear message when dbt macros cannot be resolved', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-ref-missing-'));
    tempDirs.push(projectRoot);

    expect(() => resolveDbtMacrosForExecution(
      "SELECT * FROM {{ ref('missing_model') }}",
      projectRoot,
      {},
    )).toThrow(/target\/manifest\.json was not available/);
  });
});

describe('resolveBareInternalRelationIds', () => {
  // A QUALIFIED `source::db.schema.table` decodes without asking anyone. A BARE
  // `source::orders` does not, and the old behaviour was to fail the cell and
  // offer "Ask AI to fix" — an LLM round trip for what is a name lookup. The
  // name is unambiguous whenever exactly one relation answers to it.
  const executorWith = (rows: Array<Record<string, unknown>>) => ({
    executeQuery: vi.fn(async () => ({ rows, columns: [], rowCount: rows.length })),
  }) as never;
  const connection = { name: 'default', driver: 'duckdb' } as never;

  it('resolves a bare identity when exactly one relation answers to the name', async () => {
    const out = await resolveBareInternalRelationIds(
      'SELECT COUNT(*) FROM source::stg_orders',
      executorWith([{ table_schema: 'main', table_name: 'stg_orders' }]),
      connection,
    );
    expect(out.sql).toBe('SELECT COUNT(*) FROM main.stg_orders');
    expect(out.resolved).toEqual([{ from: 'source::stg_orders', to: 'main.stg_orders' }]);
    expect(out.ambiguous).toEqual([]);
  });

  it('refuses to guess when the name matches more than one schema', async () => {
    const out = await resolveBareInternalRelationIds(
      'SELECT 1 FROM source::orders',
      executorWith([
        { table_schema: 'main', table_name: 'orders' },
        { table_schema: 'staging', table_name: 'orders' },
      ]),
      connection,
    );
    expect(out.sql).toContain('source::orders');
    expect(out.ambiguous).toEqual(['source::orders']);
  });

  it('leaves the identity alone when the warehouse knows nothing about it', async () => {
    const out = await resolveBareInternalRelationIds(
      'SELECT 1 FROM source::nope',
      executorWith([]),
      connection,
    );
    expect(out.sql).toContain('source::nope');
    expect(out.resolved).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it('never probes for an identity that already carries a schema', async () => {
    const executor = executorWith([]);
    const out = await resolveBareInternalRelationIds(
      'SELECT 1 FROM source::db.main.orders',
      executor,
      connection,
    );
    expect((executor as unknown as { executeQuery: { mock: { calls: unknown[] } } }).executeQuery)
      .not.toHaveBeenCalled();
    expect(out.sql).toBe('SELECT 1 FROM source::db.main.orders');
  });

  it('survives a warehouse that cannot answer the probe', async () => {
    const executor = { executeQuery: vi.fn(async () => { throw new Error('no information_schema'); }) } as never;
    const out = await resolveBareInternalRelationIds('SELECT 1 FROM source::orders', executor, connection);
    expect(out.sql).toBe('SELECT 1 FROM source::orders');
    expect(out.resolved).toEqual([]);
  });
});

describe('notebook background repair source handling', () => {
  it('extracts and replaces only the embedded DQL query', () => {
    const source = [
      'block revenue {',
      '  description = "Revenue by customer"',
      '  query = """',
      'SELECT customer_id, SUM(revenue) AS revenue',
      'FROM source::analytics.main.orders',
      'GROUP BY 1',
      '  """',
      '}',
    ].join('\n');

    expect(notebookCellRepairSql({ id: 'dql_1', type: 'dql', source })).toContain('source::analytics.main.orders');
    const repaired = replaceNotebookDqlQueryForRepair(
      source,
      'SELECT customer_id, SUM(revenue) AS revenue FROM analytics.main.orders GROUP BY 1',
    );
    expect(repaired).toContain('description = "Revenue by customer"');
    expect(repaired).toContain('FROM analytics.main.orders');
    expect(repaired).not.toContain('source::');
  });

  it('refuses semantic DQL without an editable embedded query', () => {
    expect(notebookCellRepairSql({
      id: 'dql_2',
      type: 'dql',
      source: 'query revenue { metric = @metric(revenue) }',
    })).toBeUndefined();
  });

  it('offers bounded repair for a malformed custom wrapper before SQL extraction succeeds', () => {
    const malformed = `block "Orders" {
  type = "custom"
  params { top_n: number = 10 }
  query """SELECT * FROM orders LIMIT \${top_n}"""
}`;
    expect(notebookCellRepairSql({ id: 'dql_3', type: 'dql', source: malformed })).toBeUndefined();
    expect(notebookDqlSourceAllowsBackgroundRepair(malformed)).toBe(true);
    expect(notebookDqlSourceAllowsBackgroundRepair('@block("Certified Orders")')).toBe(false);
    expect(notebookDqlSourceAllowsBackgroundRepair('block x { type = "semantic" query = """x""" }')).toBe(false);
    expect(dqlRepairParameterContract(malformed)).toEqual(['top_n']);
  });

  it('preserves DQL parameters while applying only proven relation rewrites', () => {
    expect(applyNotebookRepairRewrites(
      'SELECT * FROM source::analytics.main.orders WHERE category = ${category}',
      [{ from: 'source::analytics.main.orders', to: 'analytics.main.orders' }],
    )).toBe('SELECT * FROM analytics.main.orders WHERE category = ${category}');
    expect(restoreNotebookDqlParameterInterpolations(
      'SELECT * FROM analytics.main.orders WHERE category = $1 LIMIT $2',
      [{ name: 'category', position: 1 }, { name: 'top_n', position: 2 }],
    )).toBe('SELECT * FROM analytics.main.orders WHERE category = ${category} LIMIT ${top_n}');
  });

  it('refuses background repair for failures that require user decisions', () => {
    expect(notebookFailureAllowsBackgroundRepair({ message: 'syntax error near source::' })).toBe(true);
    expect(notebookFailureAllowsBackgroundRepair({ code: 'UPSTREAM_RESULT_UNAVAILABLE', message: 'Unavailable' })).toBe(false);
    expect(notebookFailureAllowsBackgroundRepair({ message: 'permission denied for table orders' })).toBe(false);
    expect(notebookFailureAllowsBackgroundRepair({ message: 'Provide required parameter: region.' })).toBe(false);
  });
});

describe('prepareAnalyticalExecutionSql', () => {
  const connection = { name: 'default', driver: 'duckdb', filepath: ':memory:' } as never;

  it('decodes a qualified internal source identity before connector execution', async () => {
    const executor = { executeQuery: vi.fn() } as never;
    const prepared = await prepareAnalyticalExecutionSql({
      sql: 'SELECT * FROM source::analytics.reporting.orders',
      subject: 'Ask AI query',
      executor,
      connection,
      projectRoot: '/tmp/dql-shared-preparation',
      projectConfig: {},
      enforceReadOnly: true,
      rowLimit: 200,
    });

    expect(prepared.decodedSql).toBe('SELECT * FROM analytics.reporting.orders');
    expect(prepared.executedSql).not.toContain('source::');
    expect(prepared.executedSql).toMatch(/LIMIT 200$/i);
    expect((executor as unknown as { executeQuery: ReturnType<typeof vi.fn> }).executeQuery)
      .not.toHaveBeenCalled();
  });

  it('resolves a unique bare source identity through the bounded catalog probe', async () => {
    const executor = {
      executeQuery: vi.fn(async () => ({
        rows: [{ table_schema: 'main', table_name: 'orders' }],
        columns: [],
        rowCount: 1,
      })),
    } as never;
    const prepared = await prepareAnalyticalExecutionSql({
      sql: 'SELECT * FROM source::orders',
      subject: 'Ask AI query',
      executor,
      connection,
      projectRoot: '/tmp/dql-shared-preparation',
      projectConfig: {},
      enforceReadOnly: true,
    });

    expect(prepared.decodedSql).toBe('SELECT * FROM main.orders');
    expect(prepared.rewrites).toContainEqual({ from: 'source::orders', to: 'main.orders' });
    expect((executor as unknown as { executeQuery: ReturnType<typeof vi.fn> }).executeQuery)
      .toHaveBeenCalledTimes(1);
  });

  it('rejects an ambiguous bare identity instead of guessing a schema', async () => {
    const executor = {
      executeQuery: vi.fn(async () => ({
        rows: [
          { table_schema: 'main', table_name: 'orders' },
          { table_schema: 'staging', table_name: 'orders' },
        ],
        columns: [],
        rowCount: 2,
      })),
    } as never;

    await expect(prepareAnalyticalExecutionSql({
      sql: 'SELECT * FROM source::orders',
      subject: 'Ask AI query',
      executor,
      connection,
      projectRoot: '/tmp/dql-shared-preparation',
      projectConfig: {},
      enforceReadOnly: true,
    })).rejects.toMatchObject({ name: 'DqlInternalRelationIdError' });
  });
});

describe('ExecutionService surface parity (API-003 / E2E-014)', () => {
  it('uses identical connector SQL and result fingerprints for Ask, Notebook, Block Run, and App tiles', async () => {
    const executed: string[] = [];
    const executor = {
      executeQuery: vi.fn(async (sql: string) => {
        executed.push(sql);
        return {
          columns: [{ name: 'customer' }, { name: 'revenue' }],
          rows: [{ customer: 'Joy Lam', revenue: 42 }],
          rowCount: 1,
          executionTimeMs: 3,
        };
      }),
    } as never;
    const connection = { name: 'default', driver: 'duckdb', filepath: ':memory:' } as never;
    const service = new ExecutionService({
      executor,
      projectRoot: '/tmp/dql-shared-execution-service',
      projectConfig: () => ({}),
    });
    const common = {
      sql: 'SELECT customer, SUM(revenue) AS revenue FROM orders WHERE region = ${region} GROUP BY customer',
      connection,
      sqlParams: [],
      variables: { region: 'West' },
    };

    const executions = await Promise.all([
      service.execute({ ...common, subject: 'Ask AI query' }),
      service.execute({ ...common, subject: 'Notebook query' }),
      service.execute({ ...common, subject: 'Block Run query' }),
      service.execute({ ...common, subject: 'App tile block query' }),
    ]);
    const [ask, notebook, blockRun, appTile] = executions;

    expect(new Set(executed)).toEqual(new Set([ask.preparation.executedSql]));
    expect(new Set(executions.map((item) => item.compiledSqlFingerprint))).toEqual(new Set([ask.compiledSqlFingerprint]));
    expect(new Set(executions.map((item) => item.resultFingerprint))).toEqual(new Set([ask.resultFingerprint]));
    expect(notebook.result).toEqual(ask.result);
    expect(blockRun.result).toEqual(ask.result);
    expect(appTile.result).toEqual(ask.result);
  });

  it('preserves connector SQL and fingerprints through real Block Run, certification, and App block ingress', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-execution-service-ingress-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'semantic-layer', 'metrics'), { recursive: true });
    mkdirSync(join(projectRoot, 'blocks', 'revenue'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'execution-service-ingress',
      semanticLayer: { provider: 'dql', path: 'semantic-layer' },
    }));
    writeFileSync(join(projectRoot, 'semantic-layer', 'metrics', 'revenue.yaml'), [
      'name: revenue',
      'label: Revenue',
      'description: Governed revenue',
      'domain: revenue',
      'sql: SUM(amount)',
      'type: sum',
      'table: orders',
      '',
    ].join('\n'));
    const blockSource = `block "Revenue Metric" {
  type = "semantic"
  status = "certified"
  owner = "analytics"
  domain = "revenue"
  metrics = ["revenue"]
}\n`;
    writeFileSync(join(projectRoot, 'blocks', 'revenue', 'revenue-metric.dql'), blockSource);
    const created = createAppPackage(projectRoot, {
      name: 'Execution Parity App',
      domain: 'revenue',
      owners: ['analytics'],
      tags: [],
      selectedBlockIds: ['Revenue Metric'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const dashboardPath = join(projectRoot, 'apps', created.app.id, 'dashboards', `${created.dashboardId}.dqld`);
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf8')) as any;
    writeFileSync(dashboardPath, `${JSON.stringify(dashboard, null, 2)}\n`);

    const executedSql: string[] = [];
    const executor = {
      executeQuery: vi.fn(async (sql: string) => {
        executedSql.push(sql);
        return { columns: ['revenue'], rows: [{ revenue: 42 }], rowCount: 1 };
      }),
    } as unknown as QueryExecutor;
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
      });
      const base = `http://127.0.0.1:${port}`;
      const previewResponse = await fetch(`${base}/api/block-studio/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: blockSource }),
      });
      const previewText = await previewResponse.text();
      expect(previewResponse.status, previewText).toBe(200);
      const preview = JSON.parse(previewText) as any;

      const certificationResponse = await fetch(`${base}/api/block-studio/certification-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: blockSource }),
      });
      const certificationText = await certificationResponse.text();
      expect(certificationResponse.status, certificationText).toBe(200);
      const certification = JSON.parse(certificationText) as any;

      const appResponse = await fetch(`${base}/api/apps/${created.app.id}/dashboards/${created.dashboardId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const appText = await appResponse.text();
      expect(appResponse.status, appText).toBe(200);
      const app = JSON.parse(appText) as any;
      const executedTiles = app.tiles.filter((tile: any) => tile.status === 'ok' && tile.blockId);
      expect(executedTiles).toHaveLength(1);

      const fingerprints = [
        preview,
        certification.preview,
        ...executedTiles,
      ].map((value) => ({
        compiledSqlFingerprint: value.compiledSqlFingerprint,
        resultFingerprint: value.resultFingerprint,
      }));
      const analyticalSql = executedSql.filter((sql) => /SUM\s*\(\s*amount\s*\)/i.test(sql));
      expect(analyticalSql).toHaveLength(3);
      expect(new Set(analyticalSql).size).toBe(1);
      expect(new Set(fingerprints.map((value) => value.compiledSqlFingerprint)).size).toBe(1);
      expect(new Set(fingerprints.map((value) => value.resultFingerprint)).size).toBe(1);
      expect(fingerprints.every((value) => /^[a-f0-9]{64}$/.test(value.compiledSqlFingerprint))).toBe(true);
      expect(fingerprints.every((value) => /^[a-f0-9]{64}$/.test(value.resultFingerprint))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });

  it('keeps every production execution adapter on the shared service boundary', () => {
    const source = readFileSync(new URL('./local-runtime.ts', import.meta.url), 'utf8');
    const artifactExecutor = source.slice(
      source.indexOf('const executeDqlArtifactSourceForAgent = async'),
      source.indexOf('const executeCertifiedBlockByNameForAgent = async'),
    );
    const appTiles = source.slice(
      source.indexOf('const appDashRun = path.match'),
      source.indexOf("path === '/api/apps/generate'"),
    );
    const notebookStart = source.indexOf("path === '/api/notebook/execute'");
    const notebookExecution = source.slice(
      notebookStart,
      source.indexOf("path === '/api/query'", notebookStart),
    );
    const blockRunStart = source.indexOf("path === '/api/dql/artifacts/execute'");
    const blockRun = source.slice(blockRunStart, notebookStart);

    expect(artifactExecutor).toContain('analyticalExecutionService.execute');
    expect(appTiles).toContain("subject: 'App tile block query'");
    expect(appTiles).toContain("subject: 'App tile semantic query'");
    const appNotebook = source.slice(
      source.indexOf('const runNotebookForApp = async'),
      source.indexOf('const runNotebookForAppSnapshot', source.indexOf('const runNotebookForApp = async')),
    );
    expect(appNotebook).toContain("subject: 'App notebook query'");
    const blockPreview = source.slice(
      source.indexOf('const runBlockStudioPreviewSource = async'),
      source.indexOf('const runBlockStudioTestSummary', source.indexOf('const runBlockStudioPreviewSource = async')),
    );
    expect(blockPreview).toContain("subject: 'Block Studio preview query'");
    expect(blockPreview).not.toContain('executor.executeQuery(');
    expect(notebookExecution).toContain('analyticalExecutionService.execute');
    expect(blockRun).toContain('executeDqlArtifactSourceForAgent');
    expect(blockRun).toContain('executeCertifiedBlockByNameForAgent');
  });
});

describe('bounded analytical repair inputs', () => {
  it('retains the exact proposed SQL from the immutable failed run', () => {
    expect(repairableSqlFromAgentRun({
      artifacts: [{ payload: { proposedSql: 'SELECT * FROM source::analytics.main.orders' } }],
    } as never)).toBe('SELECT * FROM source::analytics.main.orders');
  });

  it('retains editable DQL values and only the safe presentation context', () => {
    const dqlArtifact = {
      kind: 'sql_block',
      source: 'block "Orders" { type = "custom" query = """SELECT * FROM orders""" }',
      parameterValues: { top_n: 5 },
    };
    const run = {
      artifacts: [{ payload: {
        dqlArtifact,
        resolvedAnalyticalPlan: { fingerprint: 'plan-1' },
        analyticalExecutionGraph: { graphId: 'graph-1' },
        analyticalFailure: { code: 'COLUMN_NOT_FOUND' },
        analyticalFacts: { fingerprint: 'failed-result-facts' },
        semanticExecutionTrace: { failure: { code: 'compile_failed' } },
        contextPackId: 'context-1',
      } }],
    } as never;
    expect(repairableDqlArtifactFromAgentRun(run)).toEqual(dqlArtifact);
    expect(repairPresentationContextFromAgentRun(run)).toEqual({
      resolvedAnalyticalPlan: { fingerprint: 'plan-1' },
      analyticalExecutionGraph: { graphId: 'graph-1' },
      contextPackId: 'context-1',
    });
  });

  it('never retries access, authentication, unsafe, or cancelled failures', () => {
    for (const category of ['permission', 'authentication', 'unsafe', 'cancelled'] as const) {
      expect(analyticalFailureAllowsDeterministicRetry({ category } as never)).toBe(false);
    }
    expect(analyticalFailureAllowsDeterministicRetry({ category: 'syntax' } as never)).toBe(true);
  });

  it('never repairs structured access or policy refusals retained by the agent', () => {
    expect(analyticalFailureAllowsAppRepair({ code: 'PERMISSION_DENIED' } as never)).toBe(false);
    expect(analyticalFailureAllowsAppRepair({ code: 'POLICY_DENIED' } as never)).toBe(false);
    expect(analyticalFailureAllowsAppRepair({ code: 'COLUMN_NOT_FOUND' } as never)).toBe(true);
  });

  it('does not infer provider repair authority from a policy refusal without a warehouse failure', () => {
    const source = 'block "Orders" { type = "custom" query = """SELECT order_id FROM main.orders""" }';
    const failure = createAnalyticalFailure({
      code: 'POLICY_DENIED',
      phase: 'validation',
      snapshotId: 'snapshot-policy',
      runId: 'policy-run',
      planFingerprint: 'f'.repeat(64),
      dqlSource: source,
      compiledSql: 'SELECT order_id FROM main.orders',
    });
    const capability = analyticalRepairCapabilityForAgentRun({
      id: 'policy-run',
      status: 'blocked',
      executionTarget: { target: 'local' },
      artifacts: [{ payload: {
        analyticalFailure: failure,
        dqlArtifact: { kind: 'sql_block', source, compiledSql: 'SELECT order_id FROM main.orders' },
      } }],
    } as never);
    expect(capability).toMatchObject({
      automatic: { eligible: false, action: 'none', attemptsRemaining: 0 },
      ineligibilityReason: 'failure_not_eligible',
    });
  });
});

describe('buildNamedRelationProbeSql', () => {
  // `getSchemaContextForAgent` returns nothing on a lexical miss — right for
  // bulk retrieval, but it meant a relation the model named explicitly, and
  // that a notebook queries happily, was refused as "outside the inspected
  // metadata context" without the warehouse ever being asked. This probe asks,
  // and it must remain a point lookup rather than the scan the policy forbids.
  it('uses equality predicates, never a LIKE scan', () => {
    const sql = buildNamedRelationProbeSql(['analytics.sales.orders'])!;
    expect(sql).toContain("LOWER(table_schema) = 'sales'");
    expect(sql).toContain("LOWER(table_name) = 'orders'");
    expect(sql).not.toContain('LIKE');
  });

  it('matches on the leaf name when no schema was given', () => {
    const sql = buildNamedRelationProbeSql(['orders'])!;
    expect(sql).toContain("LOWER(table_name) = 'orders'");
    expect(sql).not.toContain('table_schema =');
  });

  it('bounds how many relations one probe may ask about', () => {
    const sql = buildNamedRelationProbeSql(['a.one', 'b.two', 'c.three', 'd.four', 'e.five', 'f.six'])!;
    expect(sql.match(/LOWER\(table_name\) =/g)).toHaveLength(4);
    expect(sql).toContain('LIMIT 400');
  });

  it('refuses anything that is not a plain identifier', () => {
    expect(buildNamedRelationProbeSql(["orders'; DROP TABLE users --"])).toBeNull();
    expect(buildNamedRelationProbeSql(['a b c'])).toBeNull();
    expect(buildNamedRelationProbeSql([''])).toBeNull();
    expect(buildNamedRelationProbeSql([])).toBeNull();
  });

  it('deduplicates and tolerates quoted identifiers', () => {
    const sql = buildNamedRelationProbeSql(['"SALES"."ORDERS"', 'sales.orders'])!;
    expect(sql.match(/LOWER\(table_name\) =/g)).toHaveLength(1);
  });

  it('still excludes system schemas', () => {
    expect(buildNamedRelationProbeSql(['sales.orders'])!)
      .toContain("UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')");
  });
});

describe('sqlMayContainJoin', () => {
  it('recognizes explicit and comma joins without treating commas in functions as joins', () => {
    expect(sqlMayContainJoin('SELECT * FROM orders JOIN customers ON orders.customer_id = customers.id')).toBe(true);
    expect(sqlMayContainJoin('SELECT * FROM orders o, customers c WHERE o.customer_id = c.id')).toBe(true);
    expect(sqlMayContainJoin('SELECT COALESCE(region, \'unknown\') FROM orders')).toBe(false);
  });

  it('ignores join keywords inside comments and strings', () => {
    expect(sqlMayContainJoin("SELECT 'join customers' AS note FROM orders -- JOIN hidden")).toBe(false);
  });
});

describe('buildRowBoundedSql', () => {
  // The old wrapper was `SELECT * FROM (<sql>) AS dql_agent_preview LIMIT n`.
  // It is not a no-op: a CTE inside a derived table is a syntax error on
  // MSSQL/Fabric, duplicate output aliases break on several engines, and the
  // inner ORDER BY stops being guaranteed. All showed up as "fails in Ask but
  // runs in the notebook" for byte-identical SQL.
  it('never wraps the statement in a derived table', () => {
    const shapes = [
      'SELECT status, COUNT(*) AS n FROM orders GROUP BY status',
      'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
      'SELECT a FROM x UNION ALL SELECT a FROM y',
      'SELECT o.id, c.id FROM orders o JOIN customers c ON c.id = o.customer_id',
      'SELECT * FROM orders ORDER BY total DESC',
    ];
    for (const shape of shapes) {
      expect(buildRowBoundedSql(shape, 200).sql).not.toContain('dql_agent_preview');
    }
  });

  it('appends a bound to a plain SELECT that has none', () => {
    const bound = buildRowBoundedSql('SELECT status FROM orders;', 200);
    expect(bound.outcome).toBe('appended');
    expect(bound.sql).toBe('SELECT status FROM orders\nLIMIT 200');
  });

  it('appends after a WITH…SELECT without disturbing the CTE', () => {
    const bound = buildRowBoundedSql('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent', 50);
    expect(bound.outcome).toBe('appended');
    expect(bound.sql).toBe('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent\nLIMIT 50');
  });

  it("never overrides a bound the statement already carries", () => {
    for (const sql of [
      'SELECT status FROM orders LIMIT 5',
      'SELECT TOP 5 status FROM orders',
      'SELECT status FROM orders OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY',
    ]) {
      const bound = buildRowBoundedSql(sql, 200);
      // Whether it is recognised as an existing bound or simply not parseable
      // under this dialect, the statement must come back untouched.
      expect(bound.outcome).not.toBe('appended');
      expect(bound.sql).toBe(sql);
    }
  });

  it('detects an existing LIMIT rather than doubling it', () => {
    expect(buildRowBoundedSql('SELECT status FROM orders LIMIT 5', 200).outcome).toBe('existing');
  });

  it('leaves the statement alone on dialects where a trailing LIMIT is invalid', () => {
    for (const dialect of ['mssql', 'fabric']) {
      const bound = buildRowBoundedSql('SELECT status FROM orders', 200, dialect);
      expect(bound.outcome).toBe('skipped');
      expect(bound.sql).toBe('SELECT status FROM orders');
    }
  });

  it('does not rewrite SQL it cannot parse', () => {
    const bound = buildRowBoundedSql('SELECT status FROM orders QUALIFY ~~~ nonsense', 200);
    expect(bound.outcome).toBe('skipped');
    expect(bound.sql).toBe('SELECT status FROM orders QUALIFY ~~~ nonsense');
  });

  it('applies no bound when none is requested (the notebook contract)', () => {
    const bound = buildRowBoundedSql('SELECT status FROM orders', undefined);
    expect(bound.outcome).toBe('skipped');
    expect(bound.sql).toBe('SELECT status FROM orders');
  });
});

describe('readOnlySqlValidationError', () => {
  // The keyword blacklist matched IDENTIFIERS, so a CTE or alias named `load`,
  // `merge`, or `copy` was rejected as if it were DDL. The AST check accepts
  // them; `set` stays rejected because it is a reserved word the parser cannot
  // read, and an unparseable statement keeps the conservative treatment.
  it('accepts a parseable SELECT whose CTE or alias collides with a DDL keyword', () => {
    for (const sql of [
      'SELECT total AS load FROM orders',
      'WITH merge AS (SELECT 1 AS a) SELECT a FROM merge',
      'SELECT total AS copy FROM orders',
      'WITH analyze_step AS (SELECT 1 AS a) SELECT a FROM analyze_step',
    ]) {
      expect(buildAgentPreviewSql(sql)).toContain('SELECT');
    }
  });

  it('still refuses genuine DML and multi-statement input', () => {
    expect(() => buildAgentPreviewSql('DELETE FROM orders')).toThrow('read-only SELECT or WITH');
    expect(() => buildAgentPreviewSql('SELECT 1; DROP TABLE orders')).toThrow('one statement');
  });
});

describe('buildAgentPreviewSql', () => {

  it('rejects generated SQL that is not a single read-only statement', () => {
    expect(() => buildAgentPreviewSql('SELECT 1; DROP TABLE orders')).toThrow('one statement');
    expect(() => buildAgentPreviewSql('DELETE FROM orders')).toThrow('read-only SELECT or WITH');
  });

  it('rejects internal DQL graph relation identities before preview execution', () => {
    const preview = () => buildAgentPreviewSql(
      'SELECT amount FROM source::dev_finance.reporting.monthly_revenue',
    );
    expect(preview).toThrow('internal DQL graph relation identifier');
    expect(preview).toThrow('physical database.schema.table');
  });
});

describe('EXP-001 exploratory join probes', () => {
  it('repairs a uniquely resolvable relation qualifier and preserves lifetime measures at owner grain', () => {
    const result = repairExploratorySqlBeforeExecution(`
      SELECT
        customer_name,
        products.product_description,
        SUM(lifetime_spend) AS lifetime_spend
      FROM dev.customers
      LEFT JOIN jaffle_shop.dev.orders ON customers.customer_id = orders.customer_id
      LEFT JOIN jaffle_shop.dev.order_items ON orders.order_id = order_items.order_id
      LEFT JOIN jaffle_shop.dev.products ON order_item.product_id = products.product_id
      GROUP BY customer_name, products.product_description
    `, [
      {
        relation: 'dev.customers',
        name: 'customers',
        columns: [{ name: 'customer_id' }, { name: 'customer_name' }, { name: 'lifetime_spend' }],
      },
      {
        relation: 'jaffle_shop.dev.order_items',
        name: 'order_items',
        columns: [{ name: 'order_id' }, { name: 'product_id' }],
      },
    ]);

    expect(result.blockedReason).toBeUndefined();
    expect(result.sql).toContain('order_items.product_id = products.product_id');
    expect(result.sql).toContain('MAX(lifetime_spend) AS lifetime_spend');
    expect(result.repairs).toHaveLength(2);
  });

  it('qualifies inspected tables and uses an available lifetime measure for a lifespan request', () => {
    const result = repairExploratorySqlBeforeExecution(`
      SELECT c.customer_name, p.product_description, SUM(o.tax_paid) AS tax_paid
      FROM orders AS o
      JOIN customers AS c ON o.customer_id = c.customer_id
      JOIN order_items AS oi ON o.order_id = oi.order_id
      JOIN products AS p ON oi.product_id = p.product_id
      GROUP BY c.customer_name, p.product_description
    `, [
      {
        relation: 'jaffle_shop.dev.orders',
        name: 'orders',
        columns: [{ name: 'order_id' }, { name: 'customer_id' }, { name: 'tax_paid' }],
      },
      {
        relation: 'jaffle_shop.dev.customers',
        name: 'customers',
        columns: [{ name: 'customer_id' }, { name: 'customer_name' }, { name: 'lifetime_tax_paid' }],
      },
      {
        relation: 'jaffle_shop.dev.order_items',
        name: 'order_items',
        columns: [{ name: 'order_id' }, { name: 'product_id' }],
      },
      {
        relation: 'jaffle_shop.dev.products',
        name: 'products',
        columns: [{ name: 'product_id' }, { name: 'product_description' }],
      },
    ], 'what is the tax and product info for customer life span?');

    expect(result.blockedReason).toBeUndefined();
    expect(result.sql).toContain('FROM jaffle_shop.dev.orders AS o');
    expect(result.sql).toContain('JOIN jaffle_shop.dev.order_items AS oi');
    expect(result.sql).toContain('MAX(c.lifetime_tax_paid) AS tax_paid');
    expect(result.repairs).toEqual(expect.arrayContaining([
      expect.stringContaining('Qualified exploratory relation orders'),
      expect.stringContaining('Used lifetime_tax_paid'),
    ]));
  });

  it('blocks a non-additive parent measure when the owning entity is not retained', () => {
    const result = repairExploratorySqlBeforeExecution(`
      SELECT p.product_name, SUM(c.lifetime_tax_paid) AS lifetime_tax_paid
      FROM customers AS c
      JOIN orders AS o ON c.customer_id = o.customer_id
      JOIN products AS p ON o.product_id = p.product_id
      GROUP BY p.product_name
    `, [{
      relation: 'customers',
      name: 'customers',
      columns: [{ name: 'customer_id' }, { name: 'customer_name' }, { name: 'lifetime_tax_paid' }],
    }]);

    expect(result.blockedReason).toContain('allocation policy');
    expect(result.sql).toContain('SUM(c.lifetime_tax_paid)');
  });

  it('renames a percent-style alias when the generated expression is an amount', () => {
    const result = repairExploratorySqlBeforeExecution(`
      SELECT c.customer_name,
        SUM(CASE WHEN p.category = 'beverage' THEN oi.product_price ELSE 0 END) AS beverage_revenue_pct
      FROM customers c
      JOIN order_items oi ON c.customer_id = oi.customer_id
      JOIN products p ON oi.product_id = p.product_id
      GROUP BY c.customer_name
      ORDER BY beverage_revenue_pct DESC
    `, [], 'Which customers bought the most beverage revenue?');

    expect(result.sql).toContain('AS beverage_revenue');
    expect(result.sql).toContain('ORDER BY beverage_revenue DESC');
    expect(result.sql).not.toContain('beverage_revenue_pct');
    expect(result.repairs).toContainEqual(expect.stringContaining('returns an amount'));
  });

  it('preserves percentage aliases for percentage questions and ratio expressions', () => {
    const percentageQuestion = repairExploratorySqlBeforeExecution(
      'SELECT SUM(revenue) AS revenue_pct FROM orders',
      [],
      'What percentage of revenue is from beverages?',
    );
    const ratioExpression = repairExploratorySqlBeforeExecution(
      'SELECT SUM(beverage_revenue) / SUM(revenue) * 100 AS revenue_pct FROM orders',
      [],
      'Show beverage revenue',
    );

    expect(percentageQuestion.sql).toContain('AS revenue_pct');
    expect(ratioExpression.sql).toContain('AS revenue_pct');
  });

  it('AGT-005 blocks premature amount rounding in the exploratory execution lane', () => {
    const unsafe = repairExploratorySqlBeforeExecution(
      'SELECT SUM(ROUND(COALESCE(o.amount, 0), 2)) AS total_amount FROM analytics.orders o',
      [{
        relation: 'analytics.orders',
        name: 'orders',
        columns: [{ name: 'amount', type: 'DECIMAL(18,2)' }],
      }],
    );
    const safe = repairExploratorySqlBeforeExecution(
      'SELECT ROUND(COALESCE(SUM(o.amount), 0), 2) AS total_amount FROM analytics.orders o',
      [{
        relation: 'analytics.orders',
        name: 'orders',
        columns: [{ name: 'amount', type: 'DECIMAL(18,2)' }],
      }],
    );

    expect(unsafe.blockedReason).toContain('rounds an input before aggregation');
    expect(safe.blockedReason).toBeUndefined();
  });

  it('uses safely quoted identifiers and fixed bounded samples', () => {
    const sql = buildExploratoryJoinProbeSql({
      leftRelation: 'analytics.orders',
      leftColumn: 'customer_id',
      rightRelation: 'analytics.customers',
      rightColumn: 'id',
    });
    expect(sql).toContain('FROM "analytics"."orders"');
    expect(sql).toContain('FROM "analytics"."customers"');
    expect(sql.match(/LIMIT 5000/g)).toHaveLength(2);
    expect(sql).toContain('max_matches_per_left_key');
  });

  it('rejects identifiers that cannot be safely rendered into a probe', () => {
    expect(() => buildExploratoryJoinProbeSql({
      leftRelation: 'analytics.orders; DROP TABLE customers',
      leftColumn: 'customer_id',
      rightRelation: 'analytics.customers',
      rightColumn: 'id',
    })).toThrow('safe physical identifier');
  });
});

describe('validateConnectionForTest', () => {
  function result(rows: Record<string, unknown>[]): QueryResult {
    return {
      columns: [],
      rows,
      rowCount: rows.length,
      executionTimeMs: 1,
    };
  }

  function fakeSnowflakeConnector(
    execute: (sql: string) => Promise<QueryResult>,
  ): DatabaseConnector {
    return {
      driverName: 'snowflake',
      connect: async () => {},
      disconnect: async () => {},
      ping: async () => true,
      execute,
    };
  }

  it('rejects a Snowflake warehouse that is visible but suspended', async () => {
    const executed: string[] = [];
    const connector = fakeSnowflakeConnector(async (sql) => {
      executed.push(sql);
      if (sql.startsWith('SHOW WAREHOUSES')) {
        return result([{ name: 'ANALYTICS_WH', state: 'SUSPENDED' }]);
      }
      throw new Error('context query should not run while warehouse is suspended');
    });

    const validation = await validateConnectionForTest(connector, {
      driver: 'snowflake',
      account: 'acct',
      username: 'analyst',
      password: 'wrong-or-right',
      database: 'PROD',
      schema: 'MARTS',
      warehouse: 'ANALYTICS_WH',
    });

    expect(validation.ok).toBe(false);
    expect(validation.message).toContain('SUSPENDED');
    expect(executed.some((sql) => sql.includes('CURRENT_ACCOUNT'))).toBe(false);
  });

  it('validates a running Snowflake warehouse with current context', async () => {
    const connector = fakeSnowflakeConnector(async (sql) => {
      if (sql.startsWith('SHOW WAREHOUSES')) {
        return result([{ name: 'ANALYTICS_WH', state: 'STARTED' }]);
      }
      if (sql.includes('CURRENT_ACCOUNT')) {
        return result([{
          ACCOUNT_NAME: 'ACME',
          USER_NAME: 'ANALYST',
          ROLE_NAME: 'ANALYST_ROLE',
          DATABASE_NAME: 'PROD',
          SCHEMA_NAME: 'MARTS',
          WAREHOUSE_NAME: 'ANALYTICS_WH',
        }]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const validation = await validateConnectionForTest(connector, {
      driver: 'snowflake',
      account: 'acct',
      username: 'analyst',
      password: 'secret',
      database: 'PROD',
      schema: 'MARTS',
      warehouse: 'ANALYTICS_WH',
    });

    expect(validation.ok).toBe(true);
    expect(validation.message).toContain('Connected to Snowflake as ANALYST');
    expect(validation.details?.warehouseState).toBe('STARTED');
  });
});

describe('buildAgentSchemaContext', () => {
  it('uses live target columns while preserving matching dbt descriptions', () => {
    const reconciled = reconcileAgentSchemaContextWithLive(
      [{
        relation: 'jaffle_shop.main.dim_customers',
        schema: 'main',
        name: 'dim_customers',
        source: 'local metadata catalog',
        columns: [
          { name: 'customer_id', description: 'Customer key' },
          { name: 'customer_name', description: 'Customer full name' },
        ],
      }],
      [{
        relation: 'main.dim_customers',
        schema: 'main',
        name: 'dim_customers',
        source: 'runtime information_schema',
        columns: [
          { name: 'customer_id', type: 'INTEGER' },
          { name: 'name', type: 'VARCHAR' },
        ],
      }],
    );

    expect(reconciled[0]?.columns).toEqual([
      { name: 'customer_id', type: 'INTEGER', description: 'Customer key', sampleValues: undefined },
      { name: 'name', type: 'VARCHAR', description: undefined, sampleValues: undefined },
    ]);
    expect(reconciled[0]?.source).toContain('verified against live runtime schema');
    expect(reconciled[0]?.columnCompleteness).toBe('complete');
  });

  it('keeps likely entity tables for value-led single-customer questions', () => {
    const rows = [
      { table_schema: 'dev', table_name: 'customers', column_name: 'customer_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'customers', column_name: 'customer_name', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'orders', column_name: 'order_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'orders', column_name: 'customer_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'orders', column_name: 'order_total', data_type: 'DECIMAL' },
      { table_schema: 'dev', table_name: 'inventory', column_name: 'sku', data_type: 'VARCHAR' },
    ];

    const context = buildAgentSchemaContext('What did Matthew Meyer order?', rows);

    expect(context.map((table) => table.relation)).toEqual(
      expect.arrayContaining(['dev.customers', 'dev.orders']),
    );
    expect(context.find((table) => table.relation === 'dev.customers')?.columns.map((column) => column.name)).toEqual([
      'customer_id',
      'customer_name',
    ]);
  });

  it('keeps the order-item fact path for composite product and customer questions', () => {
    const rows = [
      { table_schema: 'dev', table_name: 'customers', column_name: 'customer_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'customers', column_name: 'customer_name', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'customers', column_name: 'lifetime_spend', data_type: 'DECIMAL' },
      { table_schema: 'dev', table_name: 'order_items', column_name: 'order_item_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'order_items', column_name: 'order_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'order_items', column_name: 'product_name', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'order_items', column_name: 'product_type', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'order_items', column_name: 'product_price', data_type: 'DECIMAL' },
      { table_schema: 'dev', table_name: 'fct_orders', column_name: 'order_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'fct_orders', column_name: 'customer_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'fct_orders', column_name: 'order_total', data_type: 'DECIMAL' },
      { table_schema: 'dev', table_name: 'calendar', column_name: 'date_day', data_type: 'DATE' },
    ];

    const context = buildAgentSchemaContext(
      'Give me top revenue products with product name, category, revenue, and customers who bought these products',
      rows,
    );

    expect(context.map((table) => table.relation)).toEqual(
      expect.arrayContaining(['dev.order_items', 'dev.fct_orders', 'dev.customers']),
    );
    expect(context[0]?.relation).toBe('dev.order_items');
  });

  it('can preserve unscored tables for runtime schema snapshots without changing default prompt ranking', () => {
    const rows = [
      { table_schema: 'dev', table_name: 'orders', column_name: 'order_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'orders', column_name: 'order_total', data_type: 'DECIMAL' },
      { table_schema: 'dev', table_name: 'supplies', column_name: 'supply_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'supplies', column_name: 'supply_name', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'warehouse_bins', column_name: 'bin_id', data_type: 'VARCHAR' },
    ];

    const promptContext = buildAgentSchemaContext('Show order totals', rows);
    const snapshotContext = buildAgentSchemaContext('Show order totals', rows, {
      includeUnscored: true,
      limit: 50,
    });

    expect(promptContext.map((table) => table.relation)).toEqual(['dev.orders']);
    expect(snapshotContext.map((table) => table.relation)).toEqual(
      expect.arrayContaining(['dev.orders', 'dev.supplies', 'dev.warehouse_bins']),
    );
  });
});

describe('buildRuntimeSchemaSearchSql', () => {
  it('searches table and column names using bounded safe business terms', () => {
    const sql = buildRuntimeSchemaSearchSql("Revenue for Zoom customer's top accounts");
    expect(sql).toContain("LOWER(table_name) LIKE '%revenue%'");
    expect(sql).toContain("LOWER(column_name) LIKE '%zoom%'");
    expect(sql).toContain('LIMIT 600');
    expect(sql).not.toContain("customer's");
  });

  it('never emits user SQL syntax into the physical catalog query', () => {
    const sql = buildRuntimeSchemaSearchSql("revenue'; DROP TABLE prod.secret; --");
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain("';");
    expect(sql).toContain("LIKE '%revenue%'");
  });
});

describe('extractAgentValueSearchTerms', () => {
  it('extracts names, quoted values, and emails for bounded value search', () => {
    expect(extractAgentValueSearchTerms('What is revenue for customer Matthew Meyer?')).toContain('Matthew Meyer');
    expect(extractAgentValueSearchTerms('Show orders for "Acme West"')).toContain('Acme West');
    expect(extractAgentValueSearchTerms('Usage for jane@example.com')).toContain('jane@example.com');
    expect(extractAgentValueSearchTerms('What is revenue for customer matthew meyer last month?')).toContain('matthew meyer');
    expect(extractAgentValueSearchTerms('What is revenue for customer matthew meyer last month?')).not.toContain('customer matthew meyer last month');
    expect(extractAgentValueSearchTerms('Break that down by segment for Enterprise last week')).toContain('Enterprise');
    expect(extractAgentValueSearchTerms('what are the top product Melissa Lopex got it? what is the revenue?')).toContain('Melissa Lopex');
    expect(extractAgentValueSearchTerms('what are the top product Melissa Lopex got it? what is the revenue?')).not.toContain('Melissa Lopex got it');
    expect(extractAgentValueSearchTerms('Who paid less tax than Melissa?')).toContain('Melissa');
  });
});

describe('runtime value grounding policy', () => {
  it('is disabled unless a project admin opts in with explicit columns (SEC-003)', () => {
    expect(resolveAgentRuntimeValueGrounding({})).toMatchObject({ mode: 'disabled' });
    expect(resolveAgentRuntimeValueGrounding({
      agent: { runtimeValueGrounding: { mode: 'safe_automatic', searchSafeColumns: [] } },
    })).toMatchObject({ mode: 'disabled' });
    expect(resolveAgentRuntimeValueGrounding({
      agent: { runtimeValueGrounding: { mode: 'safe_automatic', searchSafeColumns: ['dev.customers.customer_name'] } },
    })).toMatchObject({ mode: 'safe_automatic' });
  });

  it('rejects wildcard scopes instead of treating an unknown column as search-safe (SEC-003)', () => {
    const policy = resolveAgentRuntimeValueGrounding({
      agent: { runtimeValueGrounding: { mode: 'safe_automatic', searchSafeColumns: ['dev.customers.*'] } },
    });
    expect(policy.mode).toBe('disabled');
    expect(policy.searchSafeColumns.size).toBe(0);
  });

  it('hard-denies secrets, email, and free text even before allowlist matching (SEC-003)', () => {
    for (const name of ['customer_password', 'api_token', 'secretKey', 'customer_email', 'profile_description']) {
      expect(isAgentValueProbeColumn({ name, type: 'VARCHAR' })).toBe(false);
    }
    expect(isAgentValueProbeColumn({ name: 'product_category', type: 'VARCHAR' })).toBe(true);
  });
});

describe('buildAgentValueProbeSql', () => {
  it('uses equality and anchored prefix probes without an unbounded leading wildcard', () => {
    const sql = buildAgentValueProbeSql(
      {
        relation: 'main.revenue',
        schema: 'main',
        name: 'revenue',
        source: 'runtime information_schema',
        columns: [{ name: 'segment', type: 'VARCHAR' }],
      },
      'segment',
      ['Enterprise'],
      { driver: 'file', filepath: ':memory:' },
    );

    expect(sql).toContain("= 'enterprise'");
    expect(sql).toContain("LIKE 'enterprise%' ESCAPE '\\'");
    expect(sql).not.toContain("LIKE '%enterprise");
    expect(sql).not.toContain("ESCAPE '\\\\'");
    expect(sql).toContain('LIMIT 25');
  });
});

describe('semantic block save artifacts', () => {
  it('atomically recompiles the manifest and lineage after a Block Studio save', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-compile-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    saveBlockStudioArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      description: 'Revenue by account',
      owner: 'analytics',
      tags: ['finance'],
      source: 'block "Revenue Summary" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect account_id, sum(revenue) as revenue from analytics.orders group by account_id\n  """\n}\n',
    });

    const manifest = compileBlockStudioManifest(projectRoot);
    const emitted = JSON.parse(readFileSync(join(projectRoot, 'dql-manifest.json'), 'utf-8'));

    expect(manifest.blocks['Revenue Summary']).toBeDefined();
    expect(manifest.lineage.nodes.some((node) => node.id === 'block:Revenue Summary')).toBe(true);
    expect(emitted.blocks['Revenue Summary']).toBeDefined();
    expect(existsSync(join(projectRoot, 'dql-manifest.json'))).toBe(true);
  });

  it('autosaves generated blocks under draft paths without promoting to canonical blocks', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-draft-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const firstPath = saveBlockStudioDraftArtifacts(projectRoot, {
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Draft revenue block',
      owner: 'analytics',
      tags: ['ai-generated'],
      source: 'block "Revenue Draft" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 1\n  """\n}',
      stableSuffix: 'cand123',
    });
    const secondPath = saveBlockStudioDraftArtifacts(projectRoot, {
      currentPath: firstPath,
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Draft revenue block',
      source: 'block "Revenue Draft" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 2\n  """\n}',
      stableSuffix: 'cand123',
    });

    expect(firstPath).toBe('blocks/_drafts/finance/revenue-draft-cand123.dql');
    expect(secondPath).toBe(firstPath);
    expect(readFileSync(join(projectRoot, firstPath), 'utf-8')).toContain('select 2');
    expect(() => readFileSync(join(projectRoot, 'blocks/finance/revenue-draft.dql'), 'utf-8')).toThrow();
  });

  it('keeps AI-authored drafts ownerless until a human promotes them', () => {
    const source = 'block "Revenue Draft" {\n  owner = "invented-team"\n  query = """\nselect 1\n"""\n}';
    const sanitized = sanitizeAgentBlockDraftSource(source);
    expect(sanitized).not.toContain('owner =');
    expect(sanitized).not.toContain('invented-team');
  });

  it('stamps explicit Block Studio reuse in canonical parser-supported tags', () => {
    const generated = `block "Revenue Draft" {
  status = "draft"
  tags = ["ai-generated", "review-required"]
  source_question = "Why did revenue change?"
  query = """SELECT 1 AS value"""
}`;
    const reusable = markBlockStudioSourceReusable(generated);

    expect(parseBlockSourceMetadata(reusable).tags).toEqual([
      'ai-generated',
      'review-required',
      'app-source',
    ]);
    expect(markBlockStudioSourceReusable(reusable)).toBe(reusable);
  });

  it('promotes domain-first drafts into the domain block folder and removes stale draft artifacts', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-promote-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    writeFileSync(join(projectRoot, 'domains', 'finance', 'domain.dql'), 'domain "Finance" {\n  owner = "analytics"\n}\n');

    const draftPath = saveBlockStudioDraftArtifacts(projectRoot, {
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Draft revenue block',
      owner: 'analytics',
      tags: ['finance'],
      source: 'block "Revenue Draft" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 1\n  """\n}',
      stableSuffix: 'cand123',
    });

    expect(draftPath).toBe('domains/finance/blocks/_drafts/revenue-draft-cand123.dql');
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'blocks', '_drafts', 'finance', 'revenue-draft-cand123.yaml'), 'utf-8')).toContain('domain: _drafts/finance');

    const canonicalPath = saveBlockStudioArtifacts(projectRoot, {
      currentPath: draftPath,
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Certified revenue block',
      owner: 'analytics',
      tags: ['finance'],
      source: 'block "Revenue Draft" {\n  status = "certified"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 2\n  """\n}',
    });

    expect(canonicalPath).toBe('domains/finance/blocks/revenue-draft.dql');
    expect(readFileSync(join(projectRoot, canonicalPath), 'utf-8')).toContain('select 2');
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'blocks', 'finance', 'revenue-draft.yaml'), 'utf-8')).toContain('domain: finance');
    expect(() => readFileSync(join(projectRoot, draftPath), 'utf-8')).toThrow();
    expect(() => readFileSync(join(projectRoot, 'semantic-layer', 'blocks', '_drafts', 'finance', 'revenue-draft-cand123.yaml'), 'utf-8')).toThrow();
  });

  it('opens and updates status for domain-first block paths', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-status-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const blockPath = saveBlockStudioArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      description: 'Finance revenue summary',
      owner: 'analytics',
      tags: ['finance'],
      source: 'block "Revenue Summary" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  description = "Finance revenue summary"\n  owner = "analytics"\n  tags = ["finance"]\n  query = """\nselect 1\n  """\n}\n',
    });

    expect(blockPath).toBe('domains/finance/blocks/revenue-summary.dql');
    const opened = openBlockStudioDocument(projectRoot, blockPath);
    expect(opened.metadata.domain).toBe('finance');
    expect(opened.companionPath).toBe('semantic-layer/blocks/finance/revenue-summary.yaml');

    setBlockStudioStatus(projectRoot, blockPath, 'review');

    expect(readFileSync(join(projectRoot, blockPath), 'utf-8')).toContain('status = "review"');
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'blocks', 'finance', 'revenue-summary.yaml'), 'utf-8')).toContain('reviewStatus: review');
    expect(openBlockStudioDocument(projectRoot, blockPath).metadata.reviewStatus).toBe('review');
  });

  it('saves and moves blocks through nested domain folders without leaving stale companions', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-folder-move-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const firstPath = saveBlockStudioArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      folderPath: 'executive/monthly',
      owner: 'analytics',
      source: 'block "Revenue Summary" {\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 1\n  """\n}\n',
    });
    expect(firstPath).toBe('domains/finance/blocks/executive/monthly/revenue-summary.dql');
    expect(openBlockStudioDocument(projectRoot, firstPath).metadata.folderPath).toBe('executive/monthly');
    const firstCompanion = 'semantic-layer/blocks/finance/executive/monthly/revenue-summary.yaml';
    expect(existsSync(join(projectRoot, firstCompanion))).toBe(true);

    const movedPath = saveBlockStudioArtifacts(projectRoot, {
      currentPath: firstPath,
      name: 'Revenue Summary',
      domain: 'finance',
      folderPath: 'leadership',
      owner: 'analytics',
      source: 'block "Revenue Summary" {\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 2\n  """\n}\n',
    });
    expect(movedPath).toBe('domains/finance/blocks/leadership/revenue-summary.dql');
    expect(existsSync(join(projectRoot, firstPath))).toBe(false);
    expect(existsSync(join(projectRoot, firstCompanion))).toBe(false);
    expect(existsSync(join(projectRoot, 'semantic-layer/blocks/finance/leadership/revenue-summary.yaml'))).toBe(true);
  });

  it('rejects unsafe nested block folders', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-invalid-folder-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    expect(() => saveBlockStudioArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      folderPath: '../outside',
      source: 'block "Revenue Summary" {\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 1\n  """\n}\n',
    })).toThrow('Invalid block folder');
  });

  it('deletes only the requested block and its semantic companion', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-delete-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const blockPath = saveBlockStudioArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      description: 'Finance revenue summary',
      owner: 'analytics',
      source: 'block "Revenue Summary" {\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 1\n  """\n}\n',
    });
    const keepPath = saveBlockStudioArtifacts(projectRoot, {
      name: 'Margin Summary',
      domain: 'finance',
      description: 'Finance margin summary',
      owner: 'analytics',
      source: 'block "Margin Summary" {\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 2\n  """\n}\n',
    });
    const deleted = deleteBlockStudioArtifacts(projectRoot, blockPath);

    expect(deleted).toEqual({
      path: blockPath,
      companionPath: 'semantic-layer/blocks/finance/revenue-summary.yaml',
    });
    expect(existsSync(join(projectRoot, blockPath))).toBe(false);
    expect(existsSync(join(projectRoot, deleted.companionPath!))).toBe(false);
    expect(existsSync(join(projectRoot, keepPath))).toBe(true);
    expect(() => deleteBlockStudioArtifacts(projectRoot, '../../outside.dql')).toThrow('Invalid block path');
    expect(() => deleteBlockStudioArtifacts(projectRoot, blockPath)).toThrow(`File not found: ${blockPath}`);
  });

  it('writes both the block file and semantic companion metadata for save-from-cell flows', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createBlockArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      content: 'SELECT @metric(total_revenue), @dim(order_date);',
      description: 'Finance summary block',
      tags: ['finance', 'exec'],
    });

    expect(created.path).toBe('blocks/finance/revenue-summary.dql');
    expect(created.companionPath).toBe('semantic-layer/blocks/finance/revenue-summary.yaml');
    expect(readFileSync(join(projectRoot, created.path), 'utf-8')).toContain('@metric(total_revenue)');

    const companion = readFileSync(join(projectRoot, created.companionPath), 'utf-8');
    expect(companion).toContain('provider: dql');
    expect(companion).toContain('semanticMetrics:');
    expect(companion).toContain('  - total_revenue');
    expect(companion).toContain('semanticDimensions:');
    expect(companion).toContain('  - order_date');
    expect(companion).toContain('reviewStatus: draft');
  });

  it('writes manual block artifacts under domains/<domain>/blocks when the domain exists', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-block-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const created = createBlockArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      content: 'SELECT @metric(total_revenue), @dim(order_date);',
      description: 'Finance summary block',
      owner: 'finance-analytics',
      tags: ['finance', 'exec'],
    });

    expect(created.path).toBe('domains/finance/blocks/revenue-summary.dql');
    expect(() => readFileSync(join(projectRoot, 'blocks', 'finance', 'revenue-summary.dql'), 'utf-8')).toThrow();
    expect(readFileSync(join(projectRoot, created.path), 'utf-8')).toContain('@metric(total_revenue)');
    expect(readFileSync(join(projectRoot, created.companionPath), 'utf-8')).toContain('domain: finance');
  });

  it('resolves a qualified nested domain id to its physical package and preserves subfolders', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-nested-domain-block-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    const commerceRoot = join(projectRoot, 'domains', 'commerce');
    const customerRoot = join(commerceRoot, 'customer');
    mkdirSync(customerRoot, { recursive: true });
    writeFileSync(join(commerceRoot, 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    writeFileSync(join(customerRoot, 'domain.dql'), 'domain "Customer" {\n  id = "commerce.customer"\n  parent = "commerce"\n}\n');

    const created = createBlockArtifacts(projectRoot, {
      name: 'Customer Health',
      domain: 'commerce.customer',
      folderPath: 'reporting/monthly',
      content: 'SELECT 1 AS healthy',
      owner: 'customer-analytics',
    });

    expect(created.path).toBe('domains/commerce/customer/blocks/reporting/monthly/customer-health.dql');
    expect(existsSync(join(projectRoot, created.path))).toBe(true);
    expect(created.companionPath).toBe('semantic-layer/blocks/commerce.customer/reporting/monthly/customer-health.yaml');
  });

  it('writes semantic builder blocks with lineage companion metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-builder-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createSemanticBuilderBlock(projectRoot, {
      name: 'Executive Revenue',
      domain: 'finance',
      description: 'Executive revenue cut',
      owner: 'finance-analytics',
      tags: ['finance'],
      metrics: ['total_revenue'],
      dimensions: ['sales_channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      chart: 'line',
      blockType: 'semantic',
      sql: 'SELECT 1',
      tables: ['analytics.orders'],
      provider: 'dbt',
    });

    expect(created.path).toBe('blocks/finance/executive-revenue.dql');
    expect(created.content).toContain('type = "semantic"');
    expect(created.content).toContain('metrics = ["total_revenue"]');

    const companion = readFileSync(join(projectRoot, created.companionPath), 'utf-8');
    expect(companion).toContain('provider: dbt');
    expect(companion).toContain('lineage:');
    expect(companion).toContain('analytics.orders');
    expect(companion).toContain('semanticMetrics:');
    expect(companion).toContain('  - total_revenue');
    expect(companion).toContain('semanticDimensions:');
    expect(companion).toContain('  - sales_channel');
    expect(companion).toContain('  - order_date');
  });

  it('UI-012 preserves every selected metric with a multi-metric table contract', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-multi-metric-builder-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createSemanticBuilderBlock(projectRoot, {
      name: 'Customer Unit Economics',
      domain: 'finance',
      metrics: ['revenue', 'refunds', 'gross_margin'],
      dimensions: ['customer_name'],
      chart: 'bar',
      blockType: 'semantic',
      sql: 'SELECT 1',
      tables: ['analytics.customers'],
      provider: 'dbt',
    });

    expect(created.content).toContain('metrics = ["revenue", "refunds", "gross_margin"]');
    expect(created.content).toContain('chart = "table"');
    expect(created.content).not.toContain('y = revenue');
  });

  it('writes semantic builder blocks under the domain-first block folder when the domain exists', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-builder-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const created = createSemanticBuilderBlock(projectRoot, {
      name: 'Executive Revenue',
      domain: 'finance',
      description: 'Executive revenue cut',
      owner: 'finance-analytics',
      tags: ['finance'],
      metrics: ['total_revenue'],
      dimensions: ['sales_channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      chart: 'line',
      blockType: 'semantic',
      sql: 'SELECT 1',
      tables: ['analytics.orders'],
      provider: 'dbt',
    });

    expect(created.path).toBe('domains/finance/blocks/executive-revenue.dql');
    expect(() => readFileSync(join(projectRoot, 'blocks', 'finance', 'executive-revenue.dql'), 'utf-8')).toThrow();
    expect(readFileSync(join(projectRoot, created.path), 'utf-8')).toContain('metrics = ["total_revenue"]');
    expect(readFileSync(join(projectRoot, created.companionPath), 'utf-8')).toContain('provider: dbt');
  });

  it('writes a blank semantic block when created from the Semantic Block path', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-blank-semantic-block-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createBlockArtifacts(projectRoot, {
      name: 'Approval Rate',
      domain: 'cards',
      blockType: 'semantic',
      owner: 'cards-analytics',
      description: 'Semantic metric starter',
      tags: ['cards'],
    });

    expect(created.path).toBe('blocks/cards/approval-rate.dql');
    expect(created.content).toContain('type = "semantic"');
    expect(created.content).toContain('metrics = []');
    expect(created.content).toContain('dimensions = []');
    expect(created.content).not.toContain('query = """');
  });
});

describe('buildDbtStatus', () => {
  it('reports configured dbt artifacts and counts for the Block Studio start page', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-status-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: banking\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'banking', generated_at: '2026-04-30T12:00:00Z' },
      nodes: {
        'model.banking.fct_cards': { resource_type: 'model' },
        'test.banking.not_null': { resource_type: 'test' },
      },
      sources: {
        'source.banking.raw.cards': {},
      },
    }), 'utf-8');
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      metadata: { generated_at: '2026-04-30T12:01:00Z' },
      metrics: [{ name: 'approval_rate' }],
      semantic_models: [{ name: 'cards' }],
      saved_queries: [{ name: 'daily_cards' }],
    }), 'utf-8');

    const status = buildDbtStatus(projectRoot, {
      semanticLayer: { provider: 'dbt', projectPath: './dbt' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    }, '2026-04-30T12:02:00Z');

    expect(status.configured).toBe(true);
    expect(status.projectName).toBe('banking');
    expect(status.artifacts.manifest.exists).toBe(true);
    expect(status.artifacts.semanticManifest.exists).toBe(true);
    expect(status.counts.models).toBe(1);
    expect(status.counts.sources).toBe(1);
    expect(status.counts.metrics).toBe(1);
    expect(status.counts.semanticModels).toBe(1);
    expect(status.counts.savedQueries).toBe(1);
    expect(status.lastSyncTime).toBe('2026-04-30T12:02:00Z');
    expect(status.setupHint).toContain('dbt artifacts are ready');
  });

  it('counts object-shaped dbt semantic artifacts and reports actionable diagnostics', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-diagnostics-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: banking\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'banking', generated_at: '2026-04-30T12:00:00Z' },
      nodes: {
        'model.banking.fct_cards': { resource_type: 'model' },
      },
      sources: {},
      metrics: {
        'metric.banking.approval_rate': { name: 'approval_rate' },
      },
      semantic_models: {
        'semantic_model.banking.cards': { name: 'cards' },
      },
    }), 'utf-8');
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      metadata: { generated_at: '2026-04-30T12:01:00Z' },
      metrics: {
        'metric.banking.approval_rate': { name: 'approval_rate' },
      },
      semantic_models: {
        'semantic_model.banking.cards': { name: 'cards' },
      },
      saved_queries: {
        'saved_query.banking.daily_cards': { name: 'daily_cards' },
      },
    }), 'utf-8');

    const projectConfig = {
      semanticLayer: { provider: 'dbt' as const, projectPath: './dbt' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    };
    const status = buildDbtStatus(projectRoot, projectConfig, null);
    const diagnostics = buildSemanticLayerDiagnostics(projectRoot, projectConfig, {
      semanticLayer: new SemanticLayer(),
      semanticConfig: projectConfig.semanticLayer,
      lastSyncTime: null,
    });

    expect(status.counts.metrics).toBe(1);
    expect(status.counts.semanticModels).toBe(1);
    expect(status.counts.savedQueries).toBe(1);
    expect(diagnostics.sourceOfTruth).toContain('dbt MetricFlow');
    expect(diagnostics.issues.map((issue) => issue.code)).not.toContain('metricflow_semantic_manifest_missing');
  });

  it('diagnoses missing MetricFlow semantic manifest separately from dbt model metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-missing-semantic-manifest-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: banking\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'banking' },
      nodes: {
        'model.banking.fct_cards': { resource_type: 'model' },
      },
      sources: {},
    }), 'utf-8');

    const diagnostics = buildSemanticLayerDiagnostics(projectRoot, {
      semanticLayer: { provider: 'dbt', projectPath: './dbt' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    }, {
      semanticLayer: new SemanticLayer(),
      semanticConfig: { provider: 'dbt', projectPath: './dbt' },
      lastSyncTime: null,
    });

    expect(diagnostics.dbt.artifacts.manifest.exists).toBe(true);
    expect(diagnostics.dbt.artifacts.semanticManifest.exists).toBe(false);
    expect(diagnostics.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'metricflow_semantic_manifest_missing',
          path: expect.stringContaining('semantic_manifest.json'),
        }),
      ]),
    );
    expect(diagnostics.warnings.join('\n')).toContain('dbt MetricFlow semantic_manifest.json is missing');
  });

  it('surfaces empty MetricFlow artifacts even when local DQL semantic layer is active', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-empty-semantic-manifest-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: nba_analysis\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'nba_analysis' },
      nodes: {
        'model.nba_analysis.int_player_stats': { resource_type: 'model' },
      },
      sources: {},
    }), 'utf-8');
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      semantic_models: [],
      metrics: [],
      saved_queries: [],
    }), 'utf-8');

    const projectConfig = {
      semanticLayer: { provider: 'dql' as const, path: 'semantic-layer' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    };
    const status = buildDbtStatus(projectRoot, projectConfig, null);
    const diagnostics = buildSemanticLayerDiagnostics(projectRoot, projectConfig, {
      semanticLayer: new SemanticLayer({
        metrics: [{ name: 'draft_block_metric', label: 'Draft block metric', description: '', domain: 'business', sql: 'count(*)', type: 'count', table: 'blocks' }],
        dimensions: [],
        hierarchies: [],
        segments: [],
        preAggregations: [],
        measures: [],
        entities: [],
        semanticModels: [],
        savedQueries: [],
      }),
      semanticConfig: projectConfig.semanticLayer,
      lastSyncTime: null,
    });

    expect(status.counts.models).toBe(1);
    expect(status.counts.metrics).toBe(0);
    expect(status.setupHint).toContain('MetricFlow semantic_manifest.json is empty');
    expect(diagnostics.provider).toBe('dql');
    expect(diagnostics.counts.metrics).toBe(1);
    expect(diagnostics.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'metricflow_semantic_manifest_empty',
          path: expect.stringContaining('semantic_manifest.json'),
        }),
      ]),
    );
  });
});

describe('validateBlockStudioSource', () => {
  const semanticLayer = new SemanticLayer({
    metrics: [
      {
        name: 'total_revenue',
        label: 'Total Revenue',
        description: 'Revenue metric',
        domain: 'finance',
        sql: 'SUM(revenue)',
        type: 'sum',
        table: 'orders',
        tags: [],
      },
    ],
    dimensions: [
      {
        name: 'customer_type',
        label: 'Customer Type',
        description: 'Customer type dimension',
        domain: 'finance',
        sql: 'customer_type',
        type: 'string',
        table: 'orders',
        tags: [],
      },
      {
        name: 'channel',
        label: 'Channel',
        description: 'Sales channel',
        domain: 'finance',
        sql: 'channel',
        type: 'string',
        table: 'orders',
        tags: [],
      },
    ],
    hierarchies: [],
  });

  it('condenses multi-metric compiler output into one targeted correction', () => {
    const friendly = compactBlockStudioRuntimeFailure(
      'Could not compose SQL for semantic block metrics. percent_dod_bic_acm_qty: the metric does not have enough composable measure and relation metadata. percent_dod_bic_bcm: the metric does not have enough composable measure and relation metadata.',
    );

    expect(friendly).toBe('2 selected metrics cannot be compiled by the current semantic runtime: percent_dod_bic_acm_qty, percent_dod_bic_bcm. Review the measure and relationship metadata, then run again.');
  });

  it('composes executable SQL for semantic blocks with metric and dimensions', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  metric = "total_revenue"
  dimensions = ["customer_type"]
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(true);
    expect(validation.executableSql).toContain('SUM(revenue) AS total_revenue');
    expect(validation.executableSql).toContain('customer_type AS customer_type');
    expect(validation.executableSql).toContain('GROUP BY customer_type');
  });

  it('composes executable SQL for semantic blocks with requested filters', () => {
    const source = `block "Revenue by Online Channel" {
  domain = "finance"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  metric = "total_revenue"
  dimensions = ["channel"]
  requested_filters = ["channel=Online"]
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(true);
    expect(validation.executableSql).toContain("WHERE channel = 'Online'");
    expect(validation.executableSql).toContain('GROUP BY channel');
  });

  it('returns an actionable diagnostic when a semantic block is missing a metric', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  dimensions = ["customer_type"]
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.saveable).toBe(false);
    expect(validation.executableSql).toBeNull();
    expect(validation.diagnostics.some((item) => item.code === 'semantic_metric_missing')).toBe(true);
    expect(validation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'semantic_metric_missing',
        title: 'Choose at least one metric',
        field: 'Metrics',
        action: 'review_metrics',
      }),
    ]));
  });

  it('uses a successful full-runtime compile as the validation verdict for preview and certification', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  metric = "total_revenue"
  dimensions = ["customer_type"]
}`;
    const base = validateBlockStudioSource(source, semanticLayer);
    const nativeOnlyFailure = {
      ...base,
      valid: false,
      executableSql: null,
      diagnostics: [
        ...base.diagnostics,
        {
          severity: 'error' as const,
          code: 'semantic_compose_failed',
          message: 'Could not compose SQL with the native compiler.',
        },
      ],
    };

    const reconciled = reconcileBlockStudioRuntimeValidation(nativeOnlyFailure, {
      sql: 'SELECT customer_type, SUM(revenue) AS total_revenue FROM orders GROUP BY customer_type',
      diagnostics: [],
    });

    expect(reconciled.valid).toBe(true);
    expect(reconciled.executableSql).toContain('SUM(revenue)');
    expect(reconciled.diagnostics.some((item) => item.code === 'semantic_compose_failed')).toBe(false);
  });

  it('keeps a structurally valid semantic draft saveable when its runtime is not configured', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  metric = "total_revenue"
  dimensions = ["customer_type"]
}`;

    const validation = validateBlockStudioSource(source);

    expect(validation.valid).toBe(false);
    expect(validation.saveable).toBe(true);
    expect(validation.diagnostics.some((item) => item.code === 'semantic_layer_missing')).toBe(true);
  });

  it('returns a semantic validation error for unknown dimensions', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  metric = "total_revenue"
  dimensions = ["missing_dimension"]
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((item) => item.code === 'semantic_ref' && item.message.includes('missing_dimension'))).toBe(true);
  });

  it('keeps custom block validation behavior unchanged', () => {
    const source = `block "Custom Revenue" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT revenue
FROM orders
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(true);
    expect(validation.executableSql).toContain('SELECT revenue');
  });

  it('rejects non-read-only custom block SQL before save or certification', () => {
    const source = `block "Unsafe Revenue" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
DELETE FROM orders
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((item) => item.code === 'sql_read_only')).toBe(true);
  });

  it('resolves semantic refs inside custom block SQL before execution', () => {
    const source = `block "Revenue Query" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT
  @metric(total_revenue),
  @dim(customer_type)
FROM orders
GROUP BY @dim(customer_type)
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(true);
    expect(validation.executableSql).toContain('SUM(revenue) AS total_revenue');
    expect(validation.executableSql).toContain('customer_type AS customer_type');
    expect(validation.executableSql).toContain('GROUP BY customer_type');
  });

  it('returns a semantic validation error for unresolved refs in custom SQL', () => {
    const source = `block "Broken Revenue Query" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT @metric(missing_metric)
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((item) => item.code === 'semantic_ref' && item.message.includes('missing_metric'))).toBe(true);
  });
});

describe('block invariant evaluation (run-time wiring)', () => {
  const blockWithInvariants = `block "Approval Rate" {
  domain = "ops"
  type = "custom"
  description = "Approval rate."
  owner = "ops@example.com"
  query = """SELECT 1"""
  invariants = ["approval_rate_pct <= 100", "arr >= 0"]
}`;

  it('extracts declared invariants from block source', () => {
    expect(extractBlockInvariants(blockWithInvariants)).toEqual([
      'approval_rate_pct <= 100',
      'arr >= 0',
    ]);
  });

  it('returns an empty array for a block with no invariants', () => {
    const source = `block "Plain" {
  domain = "ops"
  type = "custom"
  description = ""
  owner = ""
  query = """SELECT 1"""
}`;
    expect(extractBlockInvariants(source)).toEqual([]);
  });

  it('returns null for blocks without invariants so the run output is unchanged', () => {
    const source = `block "Plain" {
  domain = "ops"
  type = "custom"
  description = ""
  owner = ""
  query = """SELECT 1"""
}`;
    expect(evaluateBlockInvariants(source, { columns: ['x'], rows: [{ x: 1 }] })).toBeNull();
  });

  it('passes when the result honors every invariant', () => {
    const out = evaluateBlockInvariants(blockWithInvariants, {
      columns: ['approval_rate_pct', 'arr'],
      rows: [{ approval_rate_pct: 80, arr: 1000 }],
    });
    expect(out).not.toBeNull();
    expect(out!.invariantViolation).toBe(false);
    expect(out!.invariantResults.every((entry) => entry.passed)).toBe(true);
  });

  it('flags a violation when the result breaks an invariant', () => {
    const out = evaluateBlockInvariants(blockWithInvariants, {
      columns: ['approval_rate_pct', 'arr'],
      rows: [{ approval_rate_pct: 137, arr: 1000 }],
    });
    expect(out!.invariantViolation).toBe(true);
    expect(out!.invariantResults.find((entry) => entry.expr === 'approval_rate_pct <= 100')?.passed).toBe(false);
  });
});

describe('buildProposeReadiness (/api/propose handler core)', () => {
  // Minimal synthetic dbt manifest at <projectRoot>/target/manifest.json so the
  // readiness handler resolves it via the same lookup the local runtime uses.
  function writeManifest(projectRoot: string): void {
    const targetDir = join(projectRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'jaffle_shop' },
      nodes: {
        'model.jaffle_shop.stg_orders': {
          resource_type: 'model',
          name: 'stg_orders',
          schema: 'staging',
          database: 'analytics',
          description: '',
          original_file_path: 'models/staging/stg_orders.sql',
          config: { materialized: 'view' },
          tags: [],
          depends_on: { nodes: ['source.jaffle_shop.raw.orders'] },
          columns: { order_id: { name: 'order_id' } },
          meta: {},
        },
        'model.jaffle_shop.dim_customers': {
          resource_type: 'model',
          name: 'dim_customers',
          schema: 'marts',
          database: 'analytics',
          description: 'One row per customer with lifetime attributes.',
          original_file_path: 'models/marts/dim_customers.sql',
          config: { materialized: 'table' },
          tags: ['core'],
          depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
          columns: {
            customer_id: { name: 'customer_id', description: 'Customer surrogate key.' },
            customer_name: { name: 'customer_name' },
          },
          meta: {},
        },
        'model.jaffle_shop.fct_orders': {
          resource_type: 'model',
          name: 'fct_orders',
          schema: 'marts',
          database: 'analytics',
          description: 'Order-grain fact with amounts.',
          original_file_path: 'models/marts/fct_orders.sql',
          config: { materialized: 'table' },
          tags: ['core'],
          depends_on: { nodes: ['model.jaffle_shop.stg_orders', 'model.jaffle_shop.dim_customers'] },
          columns: {
            order_id: { name: 'order_id' },
            order_date: { name: 'order_date' },
            amount: { name: 'amount' },
          },
          meta: {},
        },
      },
      sources: {
        'source.jaffle_shop.raw.orders': {
          name: 'orders',
          identifier: 'orders',
          schema: 'raw',
          database: 'analytics',
          tags: [],
        },
      },
    }), 'utf-8');
  }

  it('returns a not-ready readiness result when no dbt manifest is present', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-readiness-empty-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');

    const result = buildProposeReadiness(projectRoot);

    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/dbt manifest/i);
    expect(result.proposals).toEqual([]);
    expect(result.summary.modelsScanned).toBe(0);
    expect(result.summary.proposalsRanked).toBe(0);
  });

  it('returns ranked DRAFT proposals with stored certifier verdicts (nothing certified)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-readiness-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    writeManifest(projectRoot);

    const result = buildProposeReadiness(projectRoot, undefined, { owner: 'me@example.com' });

    expect(result.ready).toBe(true);
    expect(result.summary.projectName).toBe('jaffle_shop');
    // All 3 models are scanned, but staging is plumbing → only 2 business models
    // are selected/ranked. The plan reflects the business-only scope.
    expect(result.summary.modelsScanned).toBe(3);
    expect(result.summary.businessModels).toBe(2);
    expect(result.summary.plumbingExcluded).toBe(1);
    expect(result.summary.proposalsRanked).toBe(2);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((p) => p.model !== 'stg_orders')).toBe(true);

    // The PLAN is present, business-only, and bounded — and writes nothing.
    expect(result.plan.willGenerate).toBe(2);
    expect(result.plan.domains.flatMap((d) => d.candidates).map((c) => c.model)).not.toContain('stg_orders');

    // Every proposal is a DRAFT and carries a Certifier verdict; none certified.
    for (const proposal of result.proposals) {
      expect(proposal.certification.certified).toBe(false);
      expect(Array.isArray(proposal.certification.errors)).toBe(true);
      expect(Array.isArray(proposal.certification.warnings)).toBe(true);
    }

    // Ranked: scores are non-increasing across the queue.
    const scores = result.proposals.map((p) => p.ranking.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // Summary aggregates mirror the per-proposal certifier counts.
    const blocking = result.proposals.reduce((sum, p) => sum + p.certification.errors.length, 0);
    const warnings = result.proposals.reduce((sum, p) => sum + p.certification.warnings.length, 0);
    expect(result.summary.blockingTotal).toBe(blocking);
    expect(result.summary.warningTotal).toBe(warnings);
    expect(result.summary.readyForReview).toBe(
      result.proposals.filter((p) => p.certification.errors.length === 0).length,
    );
    expect(result.summary.reviewTelemetry).toMatchObject({
      existingDrafts: 0,
      readyForReviewRate: result.summary.readyForReview / result.summary.proposalsRanked,
    });
    expect(result.summary.reviewTelemetry?.estimatedReviewMinutes).toBeGreaterThan(0);
    for (const [index, proposal] of result.proposals.entries()) {
      expect(proposal.review.queueRank).toBe(index + 1);
      expect(proposal.review.draftPath).toMatch(/^blocks\/_drafts\/.+\.dql$/);
      expect(proposal.review.certifyCommand).toContain(`dql certify --from-draft ${proposal.review.draftPath}`);
      expect(proposal.review.payload).toMatchObject({
        model: proposal.model,
        domain: proposal.domain,
        outputs: proposal.inference.declaredOutputs,
        resultSample: { status: 'not_run', rows: [] },
      });
      expect(proposal.review.payload.sqlPreview).toContain(proposal.model);
      expect(proposal.review.estimatedReviewMinutes).toBeGreaterThan(0);
    }
  });

  it('does not write any draft files (dryRun preview only)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-readiness-dryrun-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    writeManifest(projectRoot);

    buildProposeReadiness(projectRoot);

    // The readiness preview must never mutate the project with draft blocks.
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(false);
  });

  it('generateProposeDrafts writes ONLY the approved scope (business-only)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-generate-'));
    tempDirs.push(projectRoot);
    // aiEnrichment off → deterministic + offline (no provider ping in tests).
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p', propose: { aiEnrichment: 'off' } }), 'utf-8');
    writeManifest(projectRoot);

    const result = await generateProposeDrafts(projectRoot, ['dim_customers'], undefined, { owner: 'me@example.com' });

    expect(result.ready).toBe(true);
    expect(result.draftsWritten).toBe(1);
    expect(result.proposals.map((p) => p.model)).toEqual(['dim_customers']);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', 'dim_customers.dql'))).toBe(true);
    // The unselected business model and the plumbing model are not written.
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', 'fct_orders.dql'))).toBe(false);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', 'stg_orders.dql'))).toBe(false);

    const source = readFileSync(join(projectRoot, 'blocks', '_drafts', 'dim_customers.dql'), 'utf-8');
    expect(source).toContain('status = "draft"');
    expect(source).not.toContain('status = "certified"');
  });

  it('surfaces existing draft review latency and certify handoff in readiness', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-review-telemetry-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p', propose: { aiEnrichment: 'off' } }), 'utf-8');
    writeManifest(projectRoot);

    await generateProposeDrafts(projectRoot, ['dim_customers'], undefined, { owner: 'me@example.com' });

    const readiness = buildProposeReadiness(projectRoot, undefined, { owner: 'me@example.com' });
    const dimCustomers = readiness.proposals.find((proposal) => proposal.slug === 'dim_customers');

    expect(readiness.summary.reviewTelemetry?.existingDrafts).toBeGreaterThanOrEqual(1);
    expect(dimCustomers?.review).toMatchObject({
      status: expect.stringMatching(/draft_exists|ready_for_review/),
      draftExists: true,
      draftPath: 'blocks/_drafts/dim_customers.dql',
    });
    expect(dimCustomers?.review.firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(dimCustomers?.review.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof dimCustomers?.review.reviewAgeHours).toBe('number');
    expect(dimCustomers?.review.certifyCommand).toContain('dql certify --from-draft blocks/_drafts/dim_customers.dql');
  });

  it('generateProposeDrafts never writes a plumbing model even if explicitly requested', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-generate-plumbing-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p', propose: { aiEnrichment: 'off' } }), 'utf-8');
    writeManifest(projectRoot);

    const result = await generateProposeDrafts(projectRoot, ['stg_orders']);
    expect(result.draftsWritten).toBe(0);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts', 'stg_orders.dql'))).toBe(false);
  });
});

describe('semantic composting changesets', () => {
  function writeCertifiedRevenueCluster(projectRoot: string): void {
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks', 'revenue_by_product.dql'), `block "Revenue By Product" {
  domain = "sales"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  outputs = ["product_name", "completed_revenue"]
  query = """
    SELECT product_name, SUM(amount) AS completed_revenue
    FROM analytics.orders
    WHERE status = 'completed'
    GROUP BY product_name
  """
}
`);
    writeFileSync(join(projectRoot, 'blocks', 'revenue_by_region.dql'), `block "Revenue By Region" {
  domain = "sales"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  outputs = ["region", "completed_revenue"]
  query = """
    SELECT region, SUM(amount) AS completed_revenue
    FROM analytics.orders
    WHERE status = 'completed'
    GROUP BY region
  """
}
`);
    writeFileSync(join(projectRoot, 'blocks', 'draft_revenue.dql'), `block "Draft Revenue" {
  domain = "sales"
  type = "custom"
  status = "draft"
  owner = "analytics@example.com"
  outputs = ["completed_revenue"]
  query = """
    SELECT SUM(amount) AS completed_revenue
    FROM analytics.orders
  """
}
`);
  }

  it('mines certified block clusters into reviewable semantic metric draft changesets', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-composting-'));
    tempDirs.push(projectRoot);
    writeCertifiedRevenueCluster(projectRoot);

    const changeset = buildSemanticCompostingChangeset(projectRoot, { owner: 'owner@example.com' });
    const candidate = changeset.candidates[0];

    expect(changeset.ready).toBe(true);
    expect(changeset.summary.certifiedBlocksScanned).toBe(2);
    expect(changeset.summary.candidatesRanked).toBe(1);
    expect(candidate).toMatchObject({
      kind: 'metric',
      name: 'completed_revenue',
      domain: 'sales',
      type: 'sum',
      sql: 'SUM(amount)',
      filter: "status = 'completed'",
      support: 2,
      draftPath: 'semantic-layer/metrics/_drafts/sales/completed_revenue.yaml',
      draftExists: false,
    });
    expect(candidate.donorBlocks.map((donor) => donor.path).sort()).toEqual([
      'blocks/revenue_by_product.dql',
      'blocks/revenue_by_region.dql',
    ]);
    expect(candidate.yaml).toContain('status: draft');
    expect(candidate.yaml).toContain('owner: owner@example.com');
    expect(changeset.prBody).toContain('blocks/revenue_by_product.dql');
  });

  it('writes approved semantic composting drafts and PR-body provenance only on generate', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-composting-generate-'));
    tempDirs.push(projectRoot);
    writeCertifiedRevenueCluster(projectRoot);

    const preview = buildSemanticCompostingChangeset(projectRoot, { owner: 'owner@example.com' });
    expect(existsSync(join(projectRoot, preview.candidates[0].draftPath))).toBe(false);

    const result = generateSemanticCompostingDrafts(
      projectRoot,
      [preview.candidates[0].id],
      { owner: 'owner@example.com' },
    );

    expect(result.ready).toBe(true);
    expect(result.draftsWritten).toBe(1);
    expect(result.paths).toEqual(['semantic-layer/metrics/_drafts/sales/completed_revenue.yaml']);
    expect(result.prBodyPath).toBe('semantic-layer/metrics/_drafts/PR_BODY.md');
    expect(existsSync(join(projectRoot, 'semantic-layer', 'metrics', '_drafts', 'sales', 'completed_revenue.yaml'))).toBe(true);
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'metrics', '_drafts', 'PR_BODY.md'), 'utf-8')).toContain('Semantic Composting Changeset');

    const metric = loadSemanticLayerFromDir(join(projectRoot, 'semantic-layer')).getMetric('completed_revenue');
    expect(metric).toMatchObject({
      name: 'completed_revenue',
      status: 'draft',
      domain: 'sales',
      sql: 'SUM(amount)',
      type: 'sum',
      table: expect.stringContaining('orders'),
      filter: "status = 'completed'",
      owner: 'owner@example.com',
    });
    expect(metric?.source?.extra?.support).toBe(2);

    const afterGenerate = buildSemanticCompostingChangeset(projectRoot, { owner: 'owner@example.com' });
    expect(afterGenerate.summary.existingDrafts).toBe(1);
    expect(afterGenerate.candidates[0]).toMatchObject({
      name: 'completed_revenue',
      draftExists: true,
      draftPath: 'semantic-layer/metrics/_drafts/sales/completed_revenue.yaml',
    });
  });
});

describe('buildProposeCandidatePreview (/api/propose/preview handler core)', () => {
  function writeManifest(projectRoot: string): void {
    const targetDir = join(projectRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'jaffle_shop' },
      nodes: {
        'model.jaffle_shop.dim_customers': {
          resource_type: 'model',
          name: 'dim_customers',
          schema: 'marts',
          database: 'analytics',
          description: 'One row per customer.',
          original_file_path: 'models/marts/dim_customers.sql',
          config: { materialized: 'table' },
          tags: ['core'],
          depends_on: { nodes: [] },
          columns: {
            customer_id: { name: 'customer_id', description: 'Customer surrogate key.' },
            customer_name: { name: 'customer_name' },
          },
          meta: {},
        },
        'model.jaffle_shop.stg_orders': {
          resource_type: 'model',
          name: 'stg_orders',
          schema: 'staging',
          database: 'analytics',
          description: '',
          original_file_path: 'models/staging/stg_orders.sql',
          config: { materialized: 'view' },
          tags: [],
          depends_on: { nodes: [] },
          columns: { order_id: { name: 'order_id' } },
          meta: {},
        },
      },
      sources: {},
    }), 'utf-8');
  }

  it('fills the preview fields for one slug (real SQL + certifier verdict), writing nothing', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-preview-'));
    tempDirs.push(projectRoot);
    // aiEnrichment off → deterministic + offline (no provider ping in tests).
    writeFileSync(
      join(projectRoot, 'dql.config.json'),
      JSON.stringify({ project: 'p', propose: { aiEnrichment: 'off' }, identity: { owner: 'me@example.com' } }),
      'utf-8',
    );
    writeManifest(projectRoot);

    const candidate = await buildProposeCandidatePreview(projectRoot, 'dim_customers');

    expect(candidate).toBeDefined();
    expect(candidate!.slug).toBe('dim_customers');
    // Real narrowed projection SQL — not select-*.
    expect(candidate!.sqlPreview).toContain('customer_id');
    expect(candidate!.sqlPreview).not.toMatch(/SELECT \* FROM/i);
    expect(candidate!.outputs).toEqual(['customer_id', 'customer_name']);
    expect(candidate!.certifierVerdict).toMatchObject({
      blocking: expect.any(Array),
      warnings: expect.any(Array),
      ready: expect.any(Boolean),
    });
    // Owner stamped from identity → "Missing owner" is not blocking.
    expect(candidate!.certifierVerdict!.blocking).not.toContain('Missing owner');

    // Preview writes NOTHING.
    expect(existsSync(join(projectRoot, 'blocks'))).toBe(false);
  });

  it('returns undefined for a plumbing/unknown slug', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-preview-miss-'));
    tempDirs.push(projectRoot);
    writeFileSync(
      join(projectRoot, 'dql.config.json'),
      JSON.stringify({ project: 'p', propose: { aiEnrichment: 'off' } }),
      'utf-8',
    );
    writeManifest(projectRoot);

    expect(await buildProposeCandidatePreview(projectRoot, 'stg_orders')).toBeUndefined();
    expect(await buildProposeCandidatePreview(projectRoot, 'no_such')).toBeUndefined();
  });
});

describe('domains API (spec 17, part B)', () => {
  it('lists authored domains with per-domain block + skill + term counts', async () => {
    const { listDomains, parseDomainInput } = await import('./local-runtime.js');
    const { writeDomainDeclaration } = await import('@duckcodeailabs/dql-core');
    const { upsertSkill } = await import('@duckcodeailabs/dql-agent');
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domains-api-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');

    // Author a domain, plus a block, term, and skill that belong to it.
    const input = parseDomainInput({ name: 'Sales', owner: 'sales@x.com', sourceSystems: ['orders'] });
    expect(input).not.toBeNull();
    writeDomainDeclaration(projectRoot, input!);

    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'blocks', 'orders.dql'),
      `block "orders" {\n  type = "custom"\n  domain = "Sales"\n  status = "draft"\n  query = """\n    SELECT 1 AS x\n  """\n}\n`,
      'utf-8',
    );
    mkdirSync(join(projectRoot, 'terms'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'terms', 'order.dql'),
      `term "Order" {\n  domain = "Sales"\n  type = "entity"\n}\n`,
      'utf-8',
    );
    upsertSkill(projectRoot, { id: 'sales-review', scope: 'project', domain: 'Sales', body: 'Sales review.' });

    const domains = listDomains(projectRoot);
    const sales = domains.find((d) => d.name === 'Sales');
    expect(sales).toMatchObject({
      id: 'sales',
      owner: 'sales@x.com',
      sourceSystems: ['orders'],
      blockCount: 1,
      termCount: 1,
      skillCount: 1,
    });
    expect(sales?.sourcePath).toBe('domains/sales/domain.dql');
  });

  it('parseDomainInput rejects a body with no name', async () => {
    const { parseDomainInput } = await import('./local-runtime.js');
    expect(parseDomainInput({})).toBeNull();
    expect(parseDomainInput({ owner: 'x' })).toBeNull();
    expect(parseDomainInput({ id: 'Finance' })?.name).toBe('Finance');
  });

  it('keeps domain declarations out of the Blocks library and saves bootstrap choices explicitly', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-bootstrap-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    mkdirSync(join(projectRoot, 'domains'), { recursive: true });
    writeFileSync(join(projectRoot, 'domains', 'revenue.dql'), 'domain "Revenue" {\n  owner = "finance"\n}\n', 'utf-8');
    writeFileSync(join(projectRoot, 'domains', 'block.dql'), 'block "Revenue total" {\n  domain = "Revenue"\n  type = "custom"\n  query = """SELECT 1 AS revenue"""\n}\n', 'utf-8');
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const library = await fetch(`http://127.0.0.1:${port}/api/blocks/library`).then((response) => response.json()) as { blocks: Array<{ name: string }> };
      expect(library.blocks.map((block) => block.name)).toEqual(['Revenue total']);

      const before = existsSync(join(projectRoot, '.dql', 'skills'));
      const session = await fetch(`http://127.0.0.1:${port}/api/context-bootstrap`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai: false }),
      }).then((response) => response.json()) as {
        id: string;
        status: string;
        candidates: Array<{ id: string; kind: string }>;
        progress: { domains: { total: number }; skills: { total: number } };
      };
      expect(session.status).toBe('queued');
      expect(session.progress.domains.total).toBeGreaterThan(0);
      expect(session.progress.skills.total).toBeGreaterThan(0);
      expect(session.candidates.some((candidate) => candidate.kind === 'skill')).toBe(true);
      expect(existsSync(join(projectRoot, '.dql', 'skills'))).toBe(before);

      let completed: { status: string; ai: { mode: string }; progress: { percent: number } } | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const updated = await fetch(`http://127.0.0.1:${port}/api/context-bootstrap/${encodeURIComponent(session.id)}`).then((response) => response.json()) as { status: string; ai: { mode: string }; progress: { percent: number } };
        completed = updated;
        if (updated.status === 'ready') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed?.status).toBe('ready');
      expect(completed?.ai.mode).toBe('evidence_only');
      expect(completed?.progress.percent).toBe(100);
      const latest = await fetch(`http://127.0.0.1:${port}/api/context-bootstrap/latest`).then((response) => response.json()) as { session?: { id?: string } | null };
      expect(latest.session?.id).toBe(session.id);

      const skill = session.candidates.find((candidate) => candidate.kind === 'skill');
      const saved = await fetch(`http://127.0.0.1:${port}/api/context-bootstrap/${encodeURIComponent(session.id)}/save-selected`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateIds: skill ? [skill.id] : [] }),
      }).then((response) => response.json()) as { saved: Array<{ status: string; path?: string }> };
      expect(saved.saved[0]?.status).toBe('saved');
      expect(saved.saved[0]?.path).toContain('skills');
      const afterSave = await fetch(`http://127.0.0.1:${port}/api/context-bootstrap/latest`).then((response) => response.json()) as { session?: unknown };
      expect(afterSave.session).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('skills carry an optional domain (spec 17, part B)', () => {
  it('round-trips skill.domain through write + load', async () => {
    const { upsertSkill, loadSkills } = await import('@duckcodeailabs/dql-agent');
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-skill-domain-'));
    tempDirs.push(projectRoot);
    upsertSkill(projectRoot, { id: 'cxo-review', scope: 'project', domain: 'Finance', body: 'Board review.' });
    const reloaded = loadSkills(projectRoot).skills.find((s) => s.id === 'cxo-review');
    expect(reloaded?.domain).toBe('Finance');
  });
});

describe('configured Skills folder API', () => {
  it('uses an existing sibling dbt-repo folder for listing and writing Skills', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'dql-skill-path-api-'));
    const projectRoot = join(repoRoot, 'dql');
    const sharedSkills = join(repoRoot, 'skills');
    tempDirs.push(repoRoot);
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(sharedSkills, { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    writeFileSync(join(sharedSkills, 'existing.skill.md'), '---\nid: existing\n---\nExisting shared guidance', 'utf-8');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });

    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const configured = await fetch(`${base}/api/skills/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '../skills' }),
      }).then((response) => response.json()) as { path: string; resolvedPath: string; exists: boolean };
      expect(configured).toMatchObject({ path: '../skills', resolvedPath: sharedSkills, exists: true });

      const existing = await fetch(`${base}/api/skills`).then((response) => response.json()) as { skills: Array<{ id: string }> };
      expect(existing.skills.map((skill) => skill.id)).toContain('existing');

      const governed = await fetch(`${base}/api/git/governed-context`).then((response) => response.json()) as {
        skills: { paths: Array<{ path: string; state: string }> };
      };
      expect(governed.skills.paths).toContainEqual({
        path: '../skills/existing.skill.md',
        state: 'untracked',
      });

      const created = await fetch(`${base}/api/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: { id: 'new-guidance', scope: 'project', body: 'New shared guidance' } }),
      });
      expect(created.ok).toBe(true);
      expect(readFileSync(join(sharedSkills, 'new-guidance.skill.md'), 'utf-8')).toContain('New shared guidance');
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  });
});

describe('agentRunDeadlineMs env overrides (Slice 1)', () => {
  it('keeps the 45s/120s normative defaults', () => {
    expect(agentRunDeadlineMs({ question: 'total revenue' }, {})).toBe(45_000);
    expect(agentRunDeadlineMs({ question: 'total revenue', requestedMode: 'research' }, {})).toBe(120_000);
  });

  it('keeps normative ceilings despite legacy env overrides', () => {
    expect(agentRunDeadlineMs({ question: 'total revenue' }, { DQL_AGENT_LOOKUP_DEADLINE_MS: '180000' })).toBe(45_000);
    expect(agentRunDeadlineMs({ question: 'x', requestedMode: 'research' }, { DQL_AGENT_RESEARCH_DEADLINE_MS: '420000' })).toBe(120_000);
    expect(agentRunDeadlineMs({ question: 'total revenue' }, { DQL_AGENT_LOOKUP_DEADLINE_MS: '1' })).toBe(45_000);
    expect(agentRunDeadlineMs({ question: 'total revenue' }, { DQL_AGENT_LOOKUP_DEADLINE_MS: '99999999' })).toBe(45_000);
    expect(agentRunDeadlineMs({ question: 'total revenue' }, { DQL_AGENT_LOOKUP_DEADLINE_MS: 'not-a-number' })).toBe(45_000);
  });
});

describe('exploratoryProbeContradiction gating (Slice 1)', () => {
  const join = { leftRelation: 'analytics.fct_orders', leftColumn: 'o.customer_id', rightRelation: 'analytics.dim_customers', rightColumn: 'c.customer_id' };
  const edge = { relationshipId: 'order_to_customer', fromRelation: 'analytics.fct_orders', toRelation: 'analytics.dim_customers', cardinality: 'many_to_one' };
  const probeRow = (overrides: Record<string, number>) => [{
    left_sample_rows: 100,
    right_sample_rows: 50,
    joined_rows: 100,
    unmatched_left_sample_rows: 0,
    unmatched_right_sample_rows: 0,
    max_matches_per_left_key: 1,
    max_matches_per_right_key: 4,
    max_left_rows_per_key: 4,
    max_right_rows_per_key: 1,
    ...overrides,
  }];

  it('stops execution when the unfiltered key samples have zero overlap', () => {
    const error = exploratoryProbeContradiction(probeRow({ joined_rows: 0 }), join, edge);
    expect(error).toContain('no matching rows');
  });

  it('stops execution when the declared one-side key is duplicated', () => {
    const error = exploratoryProbeContradiction(probeRow({ max_right_rows_per_key: 3 }), join, edge);
    expect(error).toContain('duplicates');
  });

  it('allows a legitimate many-to-one join with duplicates only on the many side', () => {
    expect(exploratoryProbeContradiction(probeRow({}), join, edge)).toBeUndefined();
  });

  it('does not gate cardinality without a resolvable edge orientation', () => {
    const ambiguous = { ...edge, fromRelation: undefined, toRelation: undefined };
    expect(exploratoryProbeContradiction(probeRow({ max_right_rows_per_key: 9 }), join, ambiguous)).toBeUndefined();
  });

  it('never treats an empty-but-matching sample pair as a contradiction', () => {
    expect(exploratoryProbeContradiction(probeRow({ left_sample_rows: 0, joined_rows: 0 }), join, edge)).toBeUndefined();
  });
});

describe('probeableExploratoryJoins (Slice 1c — CTE endpoints are not warehouse tables)', () => {
  const physical = { leftRelation: 'jaffle_shop.dev.order_items', leftColumn: 'oi.order_id', rightRelation: 'jaffle_shop.dev.orders', rightColumn: 'o.order_id' };
  const cteJoin = { leftRelation: 'joy_items', leftColumn: 'ji.product_id', rightRelation: 'jaffle_shop.dev.products', rightColumn: 'p.product_id' };

  it('drops joins whose endpoint is a CTE and keeps physical joins', () => {
    const result = probeableExploratoryJoins([physical, cteJoin], ['joy_items']);
    expect(result).toEqual([physical]);
  });

  it('matches CTE names case-insensitively and by bare name', () => {
    const quoted = { ...cteJoin, leftRelation: '"Joy_Items"' };
    expect(probeableExploratoryJoins([quoted], ['joy_items'])).toEqual([]);
  });

  it('keeps everything when the query has no CTEs', () => {
    expect(probeableExploratoryJoins([physical, cteJoin], [])).toEqual([physical, cteJoin]);
  });

  it('does not drop a physical table that merely shares a suffix token', () => {
    const lookalike = { ...physical, leftRelation: 'jaffle_shop.dev.items' };
    expect(probeableExploratoryJoins([lookalike], ['joy_items'])).toEqual([lookalike]);
  });

  it('AGT-010/EXP-003 drops a generated nested-subquery alias such as subq_2', () => {
    const derivedJoin = { ...cteJoin, leftRelation: '"subq_2"' };
    expect(probeableExploratoryJoins([physical, derivedJoin], [], ['subq_2'])).toEqual([physical]);
  });
});

describe('validateBlockStudioSource — empty and mis-typed query sections', () => {
  it('rejects a custom block that declares a query and leaves it blank', () => {
    // This shape used to validate and save cleanly, producing a block that can
    // never execute (the semantic route has no SQL to put in the section).
    const source = [
      'block "dod_bic_bcm" {',
      '    type = "custom"',
      '    dimensions = ["customer_name"]',
      '    query = """',
      '    """',
      '}',
    ].join('\n');
    const validation = validateBlockStudioSource(source, undefined);
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((d) => d.code === 'sql_missing' && d.severity === 'error')).toBe(true);
  });

  it('keeps a bare skeleton with no query section a warning, not an error', () => {
    const source = ['block "draft" {', '    type = "custom"', '}'].join('\n');
    const validation = validateBlockStudioSource(source, undefined);
    expect(validation.diagnostics.some((d) => d.code === 'sql_missing' && d.severity === 'error')).toBe(false);
  });
});

describe('a stale Ask scope must not wedge the surface', () => {
  const manifest = {
    manifestVersion: 3,
    dbtProvenance: { manifestFingerprint: 'snap-1' },
    modeling: {
      mode: 'dbt-first',
      packages: { commerce: { id: 'commerce', filePath: 'domains/commerce/domain.dql', exports: [] } },
      areas: {}, entities: {}, relationships: {}, contracts: {}, conformance: {}, rules: {},
      interfaces: { exports: {}, imports: {} }, domainLineage: [],
    },
  } as never;

  it('ignores a pinned domain that no longer exists instead of blocking the answer', () => {
    // The Ask scope now survives reloads, so a domain that was renamed, deleted
    // or mistyped would throw `Unknown domain` on EVERY question and the user
    // saw "Blocked — no answer produced" until they found the chip and cleared
    // it. An unresolvable scope must widen the search, never wedge the surface.
    expect(resolveUiDomainContext({ manifest, activeDomain: 'jaffle', source: 'explicit_ui' })).toBeUndefined();
  });

  it('still resolves a domain that does exist', () => {
    expect(resolveUiDomainContext({ manifest, activeDomain: 'commerce', source: 'explicit_ui' }))
      .toMatchObject({ activeDomain: 'commerce' });
  });

  it('ignores a stale model area the same way', () => {
    expect(resolveUiDomainContext({ manifest, activeDomain: 'commerce', modelAreaId: 'gone', source: 'explicit_ui' }))
      .toBeUndefined();
  });

  it('does not swallow unrelated failures', () => {
    // Only an unresolvable SCOPE is tolerated; a broken manifest is a real bug
    // and must still surface.
    expect(() => resolveUiDomainContext({ manifest: undefined as never, activeDomain: 'commerce', source: 'explicit_ui' }))
      .toThrow();
  });
});

describe('governed correction lifecycle API', () => {
  it('rebuilds the local Hint Graph index after a fast-forward pull', async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'dql-hint-pull-remote-'));
    const producerRoot = mkdtempSync(join(tmpdir(), 'dql-hint-pull-producer-'));
    const consumerParent = mkdtempSync(join(tmpdir(), 'dql-hint-pull-consumer-'));
    const consumerRoot = join(consumerParent, 'project');
    tempDirs.push(remoteRoot, producerRoot, consumerParent);
    execFileSync('git', ['init', '--bare'], { cwd: remoteRoot, stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main'], { cwd: producerRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dql-test@example.com'], { cwd: producerRoot });
    execFileSync('git', ['config', 'user.name', 'DQL Test'], { cwd: producerRoot });
    writeFileSync(join(producerRoot, 'dql.config.json'), JSON.stringify({ project: 'hint_pull' }));
    writeFileSync(join(producerRoot, '.gitignore'), [
      '**/.dql/cache/',
      '**/.dql/local/',
      '**/.dql/imports/',
      '**/.dql/connectors/',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], { cwd: producerRoot });
    execFileSync('git', ['commit', '-m', 'initial project'], { cwd: producerRoot, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: producerRoot });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: producerRoot, stdio: 'ignore' });
    execFileSync('git', ['clone', '--branch', 'main', remoteRoot, consumerRoot], { stdio: 'ignore' });

    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: consumerRoot,
        projectRoot: consumerRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const before = await fetch(`http://127.0.0.1:${port}/api/agent/hints`).then((response) => response.json()) as {
        hints: Array<{ id: string }>;
      };
      expect(before.hints).toEqual([]);

      const hintDir = join(producerRoot, '.dql', 'hints');
      mkdirSync(hintDir, { recursive: true });
      writeFileSync(join(hintDir, 'pulled-revenue.hint.yaml'), [
        'id: pulled-revenue',
        'title: Use governed net revenue',
        'guidance: Use net amount and exclude refunds.',
        'status: approved',
        'scope:',
        '  metric: revenue',
        'createdAt: 2026-01-01T00:00:00.000Z',
        'updatedAt: 2026-01-01T00:00:00.000Z',
        '',
      ].join('\n'));
      execFileSync('git', ['add', '.dql/hints/pulled-revenue.hint.yaml'], { cwd: producerRoot });
      execFileSync('git', ['commit', '-m', 'add governed hint'], { cwd: producerRoot, stdio: 'ignore' });
      execFileSync('git', ['push'], { cwd: producerRoot, stdio: 'ignore' });

      const pulled = await fetch(`http://127.0.0.1:${port}/api/git/pull`, {
        method: 'POST',
      });
      expect(pulled.status).toBe(200);
      const after = await fetch(`http://127.0.0.1:${port}/api/agent/hints`).then((response) => response.json()) as {
        hints: Array<{ id: string; graphEdges?: Array<{ kind: string; targetId: string }> }>;
      };
      expect(after.hints).toEqual([
        expect.objectContaining({ id: 'pulled-revenue' }),
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()) ?? resolveClose());
    }
  });

  it('materializes Git-owned Hint Graph data when a cloned project opens', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-hint-clone-bootstrap-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'hint_clone_bootstrap' }));
    const hintDir = join(projectRoot, '.dql', 'hints');
    mkdirSync(hintDir, { recursive: true });
    writeFileSync(join(hintDir, 'clone-revenue.hint.yaml'), [
      'id: clone-revenue',
      'title: Use governed net revenue',
      'guidance: Use net amount and exclude refunds.',
      'status: approved',
      'scope:',
      '  metric: revenue',
      '  domain: commerce',
      '  dbtModel: fct_orders',
      'correctedSql: SELECT SUM(o.net_amount) FROM analytics.fct_orders AS o',
      'createdAt: 2026-01-01T00:00:00.000Z',
      'updatedAt: 2026-01-01T00:00:00.000Z',
      '',
    ].join('\n'));

    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const listed = await fetch(`http://127.0.0.1:${port}/api/agent/hints`).then((response) => response.json()) as {
        hints: Array<{
          id: string;
          graphEdges?: Array<{ kind: string; targetId: string }>;
        }>;
      };

      expect(listed.hints).toEqual([
        expect.objectContaining({
          id: 'clone-revenue',
          graphEdges: expect.arrayContaining([
            expect.objectContaining({ kind: 'belongs_to_domain', targetId: 'domain:commerce' }),
            expect.objectContaining({ kind: 'uses_relation', targetId: 'relation:analytics.fct_orders' }),
            expect.objectContaining({ kind: 'uses_column', targetId: 'column:analytics.fct_orders.net_amount' }),
          ]),
        }),
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()) ?? resolveClose());
    }
  });

  it('never fabricates approval during correction capture', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-hint-capture-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'hint_capture' }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/learnings/correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'What is net revenue?',
          wrongSql: 'SELECT SUM(amount) FROM orders',
          correctedSql: 'SELECT SUM(net_amount) FROM orders',
          title: 'Use governed net revenue',
          guidance: 'Use net_amount and exclude refunds for revenue.',
          rationale: 'The governed metric is net of refunds.',
          scope: { metric: 'revenue', domain: 'commerce' },
          approve: true,
        }),
      });
      const payload = await response.json() as {
        ok: boolean;
        hint: { status: string; title: string; guidance: string; scope: { metric: string; domain: string } };
        trace: { rationale?: string };
        approvalRequested: boolean;
        note?: string;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.hint).toMatchObject({
        status: 'candidate',
        title: 'Use governed net revenue',
        guidance: 'Use net_amount and exclude refunds for revenue.',
        scope: { metric: 'revenue', domain: 'commerce' },
      });
      expect(payload.trace.rationale).toBe('The governed metric is net of refunds.');
      expect(payload.approvalRequested).toBe(true);
      expect(payload.note).toContain('Automatic approval is not permitted');
    } finally {
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()) ?? resolveClose());
    }
  });

  it('exposes review evidence and supports explicit edit and retire transitions', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-hint-review-ui-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'hint_review_ui' }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const captured = await fetch(`${base}/api/agent/learnings/correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'What is net revenue?',
          wrongSql: 'SELECT SUM(amount) FROM orders',
          correctedSql: 'SELECT SUM(net_amount) FROM orders',
          scope: { metric: 'revenue' },
          lesson: {
            category: 'aggregation_rule',
            rule: 'Use net amount for recognized revenue.',
            intentExamples: ['Recognized revenue', 'Net revenue total'],
            avoid: ['Do not sum the raw amount.'],
            expectedOutcome: 'A single recognized-revenue value.',
          },
        }),
      }).then((response) => response.json()) as {
        hint: {
          id: string;
          lesson?: { category: string; intentExamples: string[] };
        };
      };
      expect(captured.hint.lesson).toMatchObject({
        category: 'aggregation_rule',
        intentExamples: ['Recognized revenue', 'Net revenue total'],
      });

      const listed = await fetch(`${base}/api/agent/hints`).then((response) => response.json()) as {
        hints: Array<{
          id: string;
          trace?: { question: string };
          graphEdges?: Array<{ kind: string; targetId: string }>;
          inspection?: { state: string; checks: unknown[] };
          exclusions?: Array<{ reason: string }>;
        }>;
      };
      expect(listed.hints[0]).toMatchObject({
        id: captured.hint.id,
        trace: { question: 'What is net revenue?' },
      });
      expect(listed.hints[0].inspection?.checks.length).toBeGreaterThan(0);
      expect(listed.hints[0].inspection?.state).not.toBe('current');
      expect(listed.hints[0].exclusions?.map((item) => item.reason)).toContain(listed.hints[0].inspection?.state);
      expect(listed.hints[0].graphEdges).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'refines_metric', targetId: 'metric:revenue' }),
        expect.objectContaining({ kind: 'uses_relation', targetId: 'relation:orders' }),
        expect.objectContaining({ kind: 'uses_column', targetId: 'column:orders.net_amount' }),
      ]));

      const editedResponse = await fetch(`${base}/api/agent/hints/${encodeURIComponent(captured.hint.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Use governed net revenue',
          guidance: 'Prefer net_amount for revenue.',
          lesson: {
            category: 'semantic_rule',
            rule: 'Prefer net_amount for revenue.',
            intentExamples: ['Revenue after refunds'],
            avoid: ['Do not use gross amount.'],
            expectedOutcome: 'One governed revenue value.',
          },
          correctedSql: 'SELECT SUM(net_amount) FROM governed_orders',
          scope: { metric: 'net_revenue', dbtModel: 'governed_orders' },
        }),
      });
      const edited = await editedResponse.json() as {
        ok: boolean;
        hint: {
          title: string;
          status: string;
          lesson?: { category: string; intentExamples: string[] };
        };
      };
      expect(editedResponse.status).toBe(200);
      expect(edited).toMatchObject({ ok: true, hint: { title: 'Use governed net revenue', status: 'candidate' } });
      expect(edited.hint.lesson).toMatchObject({
        category: 'semantic_rule',
        intentExamples: ['Revenue after refunds'],
      });

      const retiredResponse = await fetch(`${base}/api/agent/hints/${encodeURIComponent(captured.hint.id)}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retire', note: 'The metric changed.' }),
      });
      const retired = await retiredResponse.json() as { ok: boolean; hint: { status: string } };
      expect(retiredResponse.status).toBe(200);
      expect(retired).toMatchObject({ ok: true, hint: { status: 'retired' } });

      const after = await fetch(`${base}/api/agent/hints`).then((response) => response.json()) as {
        counts: { retired: number };
      };
      expect(after.counts.retired).toBe(1);
    } finally {
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()) ?? resolveClose());
    }
  });
});

describe('extractBlockStudioSql', () => {
  const SEMANTIC_BLOCK = `block "daily_percent_dod_bic_bcm_qty" {
  domain = "sm_consumption_daily_metrics_detail"
  type = "semantic"
  status = "draft"
  description = "Can you give me the DOD BIC metrics for all info including ACM, BCM with % and qty ?"
  metrics = ["percent_dod_bic_bcm_qty"]
  dimensions = []
  time_dimension = "metric_time"
  granularity = "day"
}`;

  // Reported: a semantic block failed with `SQL compilation error: syntax error
  // line 1 at position 5 unexpected '%'`, and removing the DESCRIPTION fixed it.
  // The keyword fallback scanned the block's prose fields and matched the word
  // "with" inside `description`, returning the tail of the block as if it were
  // SQL. Callers read a non-null result as "already precompiled", so the
  // semantic/MetricFlow compile was skipped AND the fragment went to Snowflake.
  it('never mistakes a prose field for inline SQL', () => {
    expect(extractBlockStudioSql(SEMANTIC_BLOCK)).toBeNull();
  });

  it('is not fooled by any SQL keyword appearing in prose', () => {
    for (const word of ['with', 'select', 'create', 'drop', 'update', 'describe']) {
      const block = `block "b" {\n  type = "semantic"\n  description = "please ${word} the metrics"\n  metrics = ["m"]\n}`;
      expect(extractBlockStudioSql(block), word).toBeNull();
    }
  });

  it('still returns the SQL a block actually declares', () => {
    const block = `block "b" {\n  type = "custom"\n  description = "revenue with detail"\n  query = """\nSELECT 1 AS n\n"""\n}`;
    expect(extractBlockStudioSql(block)).toBe('SELECT 1 AS n');
  });

  it('still reads a loose raw-SQL source that is not a block', () => {
    expect(extractBlockStudioSql('SELECT status FROM orders')).toBe('SELECT status FROM orders');
    expect(extractBlockStudioSql('WITH t AS (SELECT 1) SELECT * FROM t')).toBe('WITH t AS (SELECT 1) SELECT * FROM t');
  });
});

/**
 * A block's `description` is FREE TEXT — on an AI-generated block it is literally
 * the user's question. Field lookups scan the whole source for `key = ...`, so a
 * description mentioning a field name was matched as if it WERE that field and
 * silently replaced the real one. Same class as the `extractBlockStudioSql`
 * "with" bug: a regex over a structured source that ignores string boundaries.
 */
describe('block field parsing ignores content inside string literals', () => {
  function block(description: string): string {
    return `block "b" {
  domain = "sales"
  type = "semantic"
  description = "${description}"
  metrics = ["real_metric"]
  dimensions = ["real_dim"]
  time_dimension = "orders.close_date"
  granularity = "month"
}`;
  }

  const HOSTILE = [
    'give me lost opportunities by month for FY26',
    'counts and amounts with % and qty',
    'show rows where granularity = "day" please',
    'what is the opportunity type = "won" count',
    'compare dimensions = ["a","b"] side by side',
    'the metrics = ["fake_metric"] should be ignored',
    // Escaped, as every DQL writer emits it (`candidateToDqlSource` escapes `"""`).
    'run query = \\"\\"\\"SELECT 1\\"\\"\\" for me',
  ];

  it('reads the real fields regardless of what the description says', () => {
    for (const description of HOSTILE) {
      const source = block(description);
      expect(parseBlockStudioStringField(source, 'type'), description).toBe('semantic');
      expect(parseBlockStudioStringField(source, 'granularity'), description).toBe('month');
      expect(parseBlockStudioStringField(source, 'time_dimension'), description).toBe('orders.close_date');
      expect(parseBlockStudioArrayField(source, 'metrics'), description).toEqual(['real_metric']);
      expect(parseBlockStudioArrayField(source, 'dimensions'), description).toEqual(['real_dim']);
      expect(extractBlockStudioSql(source), description).toBeNull();
    }
  });

  it('still reads the description itself', () => {
    expect(parseBlockStudioStringField(block('plain text'), 'description')).toBe('plain text');
  });

  it('masking preserves length and offsets exactly', () => {
    for (const source of [...HOSTILE.map(block), 'block "b" { query = """SELECT 1""" }']) {
      expect(maskDqlStringContents(source)).toHaveLength(source.length);
    }
  });

  it('still returns a real query and its exact text', () => {
    const source = `block "b" {\n  description = "run query = \\"\\"\\"nope\\"\\"\\""\n  query = """\nSELECT 1 AS n\n"""\n}`;
    expect(extractBlockStudioSql(source)).toBe('SELECT 1 AS n');
  });
});

/**
 * Thread history was taking ~10s to load. A stored run averages ~700 KB and can
 * exceed 2 MB, and the endpoint fetched up to 50 of them — tens of megabytes to
 * read, parse, re-serialize and ship before the sidebar could draw.
 *
 * Almost none of it is content. On a real 2.4 MB run the renderable part
 * (`payload.result`) was 3 KB; the rest was the SAME artifacts stored four
 * times over: `run.artifacts`, `run.steps[].artifacts`, one progress event's
 * payload, and `diagnosticReceipt` — itself held twice, top-level and inside the
 * artifact payload, each embedding its own copy of steps and artifacts.
 *
 * The projection drops duplicates only. Nothing is truncated, and the complete
 * record stays available from `GET /api/agent-runs/:id`.
 */
describe('slimAgentRunForTransport', () => {
  function runWithDuplicatedDiagnostics() {
    const bulk = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, value: `v${i}` })) };
    const receipt = { version: 1, runId: 'r1', failure: { message: 'the real cause' }, steps: [bulk], artifacts: [bulk] };
    return {
      id: 'r1',
      question: 'q',
      artifacts: [{ id: 'a', kind: 'answer', title: 'Answer', payload: { result: { columns: ['id'], rows: [{ id: 1 }] }, considered: bulk, diagnosticReceipt: receipt } }],
      diagnosticReceipt: receipt,
      steps: [{ id: 's1', goal: 'g', artifacts: [bulk] }],
      events: [{ id: 'e1', runId: 'r1', message: 'small', payload: { ok: true } }, { id: 'e2', runId: 'r1', message: 'big', payload: bulk }],
    } as never;
  }

  it('cuts the payload dramatically without touching what renders', () => {
    const run = runWithDuplicatedDiagnostics();
    const slim = slimAgentRunForTransport(run);
    const before = JSON.stringify(run).length;
    const after = JSON.stringify(slim).length;
    expect(after).toBeLessThan(before * 0.3);

    const payload = (slim.artifacts?.[0] as { payload?: Record<string, unknown> })?.payload ?? {};
    expect(payload.result).toEqual({ columns: ['id'], rows: [{ id: 1 }] });
  });

  it('keeps the failure message the UI reads', () => {
    const slim = slimAgentRunForTransport(runWithDuplicatedDiagnostics());
    expect((slim.diagnosticReceipt as unknown as { failure?: { message?: string } })?.failure?.message).toBe('the real cause');
  });

  it('drops only duplicates: nested receipt steps/artifacts, step artifacts, unread considered', () => {
    const slim = slimAgentRunForTransport(runWithDuplicatedDiagnostics());
    const receipt = slim.diagnosticReceipt as unknown as Record<string, unknown>;
    expect(receipt.steps).toBeUndefined();
    expect(receipt.artifacts).toBeUndefined();
    expect((slim.steps?.[0] as unknown as Record<string, unknown>)?.artifacts).toBeUndefined();
    expect((slim.artifacts?.[0] as { payload?: Record<string, unknown> })?.payload?.considered).toBeUndefined();
  });

  it('keeps small event payloads and omits only oversized ones', () => {
    const slim = slimAgentRunForTransport(runWithDuplicatedDiagnostics());
    const [small, big] = slim.events as unknown as Array<{ payload?: Record<string, unknown> }>;
    expect(small.payload).toEqual({ ok: true });
    expect(big.payload).toMatchObject({ omitted: 'oversized' });
  });
});

describe('Modeling AI provider replies (AGT-024)', () => {
  it('reads entity and relationship operations out of a fenced reply', () => {
    const parsed = parseAiModelingOperations([
      'Here is the model.',
      '```json',
      JSON.stringify({
        operations: [
          { kind: 'upsert_entity', id: 'order', dbtModel: 'model.shop.orders', businessName: 'Order', businessContext: 'One completed purchase.', grain: 'id', keys: ['id'], analyticalRole: 'event' },
          { kind: 'upsert_relationship', id: 'order_to_customer', from: 'order', to: 'customer', keys: [{ from: 'customer_id', to: 'id' }], cardinality: 'many_to_one', fanout: 'safe', verb: 'placed by' },
        ],
      }),
      '```',
    ].join('\n'));

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: 'upsert_entity', dbtModel: 'model.shop.orders', grain: 'id', keys: ['id'] });
    expect(parsed[1]).toMatchObject({ kind: 'upsert_relationship', from: 'order', to: 'customer', keys: [{ from: 'customer_id', to: 'id' }] });
  });

  it('yields nothing for malformed or unrecognized replies rather than guessing', () => {
    expect(parseAiModelingOperations('I could not model that.')).toEqual([]);
    expect(parseAiModelingOperations('```json\n{ not json\n```')).toEqual([]);
    // Unknown operation kinds are dropped, not coerced into an upsert.
    expect(parseAiModelingOperations(JSON.stringify({ operations: [{ kind: 'drop_everything', id: 'x' }] }))).toEqual([]);
    // Key pairs missing an endpoint cannot become a join.
    expect(parseAiModelingOperations(JSON.stringify({
      operations: [{ kind: 'upsert_relationship', id: 'r', from: 'a', to: 'b', keys: [{ from: 'only_one_side' }] }],
    }))[0]?.keys).toEqual([]);
  });
});

describe('unified context authoring proposals (API-011, API-012, MIG-003)', () => {
  it('keeps YAML discovery write-free, commits a reviewed batch, and rejects stale source without partial writes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-context-proposal-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    const areaPath = join(projectRoot, 'domains', 'commerce', 'modeling', 'areas', 'core.dql.yaml');
    writeFileSync(areaPath, 'domain: commerce\narea:\n  id: core\n  name: Core\n');
    const importDirectory = join(projectRoot, 'import-samples');
    mkdirSync(importDirectory, { recursive: true });
    writeFileSync(join(importDirectory, 'dql.yml'), 'entities:\n  - id: imported_orders\n    dbt_model: model.shop.orders\n');
    writeFileSync(join(importDirectory, 'semantic.yml'), 'semantic_models:\n  - name: customers_semantic\n    model: ref("customers")\n');
    writeFileSync(join(importDirectory, 'generic.yml'), 'widgets:\n  - name: unsupported\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: Object.fromEntries(['orders', 'customers'].map((name) => [`model.shop.${name}`, { unique_id: `model.shop.${name}`, resource_type: 'model', name, original_file_path: `models/${name}.sql`, columns: { id: { name: 'id' } }, depends_on: { nodes: [] }, tags: [] }])),
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string };
      const before = readFileSync(areaPath, 'utf8');
      const mixedResponse = await fetch(`${base}/api/modeling/dbt-first/imports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { mode: 'path', path: importDirectory } }) });
      expect(mixedResponse.status).toBe(201);
      const mixed = await mixedResponse.json() as { session: { candidates: Array<{ dialect: string; action: string }> } };
      expect(new Set(mixed.session.candidates.map((candidate) => candidate.dialect))).toEqual(new Set(['dql_modeling', 'dbt_semantic', 'unsupported']));
      expect(mixed.session.candidates.find((candidate) => candidate.dialect === 'unsupported')?.action).toBe('unsupported');
      const malformedResponse = await fetch(`${base}/api/modeling/dbt-first/imports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { mode: 'paste', filename: 'broken.yml', content: 'models:\n  - name: orders\n   description: broken' } }) });
      expect(malformedResponse.status).toBe(201);
      expect(await malformedResponse.json()).toMatchObject({ session: { candidates: [{ dialect: 'unsupported', action: 'unsupported' }] } });
      expect(readFileSync(areaPath, 'utf8')).toBe(before);
      const discoveryResponse = await fetch(`${base}/api/modeling/dbt-first/imports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { mode: 'paste', filename: 'schema.yml', content: 'version: 2\nmodels:\n  - name: orders\n    description: Orders\n  - name: customers\n    description: Customers\n' } }) });
      expect(discoveryResponse.status).toBe(201);
      const discovery = await discoveryResponse.json() as { session: { id: string; candidates: Array<{ id: string; dialect: string }> } };
      expect(discovery.session.candidates[0]).toMatchObject({ dialect: 'dbt_resource' });
      expect(readFileSync(areaPath, 'utf8')).toBe(before);

      const previewResponse = await fetch(`${base}/api/modeling/dbt-first/imports/${discovery.session.id}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selectedCandidateIds: discovery.session.candidates.map((candidate) => candidate.id), domain: 'commerce', areaId: 'core', expectedSnapshotId: modeling.snapshotId }) });
      expect(previewResponse.status).toBe(201);
      const preview = await previewResponse.json() as { proposal: { id: string; proposalHash: string; operations: unknown[]; patches: Array<{ after: string }> } };
      expect(preview.proposal.operations).toHaveLength(2);
      expect(preview.proposal.patches[0]?.after).toContain('model.shop.orders');
      expect(readFileSync(areaPath, 'utf8')).toBe(before);

      const committed = await fetch(`${base}/api/context-proposals/${preview.proposal.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedProposalHash: preview.proposal.proposalHash, idempotencyKey: 'commit-import-1' }) });
      expect(committed.status).toBe(200);
      expect(readFileSync(areaPath, 'utf8')).toContain('model.shop.customers');
      const idempotent = await fetch(`${base}/api/context-proposals/${preview.proposal.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedProposalHash: preview.proposal.proposalHash, idempotencyKey: 'commit-import-1' }) });
      expect(idempotent.status).toBe(200);
      expect(await idempotent.json()).toMatchObject({ idempotent: true });
      const mismatchedRetry = await fetch(`${base}/api/context-proposals/${preview.proposal.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedProposalHash: 'different-hash', idempotencyKey: 'commit-import-1' }) });
      expect(mismatchedRetry.status).toBe(409);
      expect(await mismatchedRetry.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      const skillOptions = await (await fetch(`${base}/api/skills/options?q=orders`)).json() as { modelingRefs: string[] };
      expect(skillOptions.modelingRefs).toContain('commerce::entity::orders');

      const current = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string };
      const proposalResponse = await fetch(`${base}/api/context-proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'manual', expectedSnapshotId: current.snapshotId, operations: [{ id: 'update-orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'commerce', areaId: 'core', dbtModel: 'model.shop.orders', businessContext: 'Reviewed orders.' } } }] }) });
      expect(proposalResponse.status).toBe(201);
      const staleProposal = await proposalResponse.json() as { proposal: { id: string; proposalHash: string } };
      const concurrent = `${readFileSync(areaPath, 'utf8')}\n# concurrent edit\n`;
      writeFileSync(areaPath, concurrent);
      const staleCommit = await fetch(`${base}/api/context-proposals/${staleProposal.proposal.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedProposalHash: staleProposal.proposal.proposalHash, idempotencyKey: 'stale-import-1' }) });
      expect(staleCommit.status).toBe(409);
      expect(await staleCommit.json()).toMatchObject({ code: expect.stringMatching(/SOURCE|SNAPSHOT|PROPOSAL/) });
      expect(readFileSync(areaPath, 'utf8')).toBe(concurrent);
      const rebased = await fetch(`${base}/api/context-proposals/${staleProposal.proposal.id}/repreview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rebase: true }) });
      expect(rebased.status).toBe(201);
      expect(await rebased.json()).toMatchObject({ proposal: { revision: 2, trustState: 'review_required' } });
      expect(readFileSync(areaPath, 'utf8')).toBe(concurrent);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('creates the missing Domain and subject area instead of blocking a first-time author (UI-019)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-context-scope-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    // Deliberately no `domains/` directory: this is a project that has never
    // been modeled, which previously produced blocking MODEL_AREA_REQUIRED /
    // DOMAIN_NOT_FOUND diagnostics and a dead-ended UI.
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: Object.fromEntries(['orders', 'customers'].map((name) => [`model.shop.${name}`, { unique_id: `model.shop.${name}`, resource_type: 'model', name, original_file_path: `models/${name}.sql`, columns: { id: { name: 'id' } }, depends_on: { nodes: [] }, tags: [] }])),
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string; modeling: { packages: Record<string, unknown> } };
      expect(Object.keys(modeling.modeling.packages)).toHaveLength(0);

      const response = await fetch(`${base}/api/context-proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'dbt_discovery',
          expectedSnapshotId: modeling.snapshotId,
          operations: [{ id: 'bind:model.shop.orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'shop', areaId: 'core', dbtModel: 'model.shop.orders', businessName: 'Orders', status: 'draft' } } }],
        }),
      });
      expect(response.status).toBe(201);
      const { proposal } = await response.json() as {
        proposal: {
          operations: Array<{ id: string; kind: string; dependsOn?: string[]; change?: { operation: string; value: Record<string, unknown> } }>;
          diagnostics: Array<{ code: string; severity: string }>;
          patches: Array<{ path: string; after: string }>;
        };
      };

      // The scope is synthesized ahead of the entity that needs it, and the
      // entity declares the dependency so a partial selection cannot orphan it.
      expect(proposal.operations.map((operation) => operation.id)).toEqual(['scope:domain:shop', 'scope:area:shop:core', 'bind:model.shop.orders']);
      expect(proposal.operations[0]?.change).toMatchObject({ operation: 'upsert_domain', value: { id: 'shop' } });
      expect(proposal.operations[1]?.change).toMatchObject({ operation: 'upsert_area', value: { id: 'core', domain: 'shop' } });
      expect(proposal.operations[2]?.dependsOn).toEqual(['scope:domain:shop', 'scope:area:shop:core']);
      expect(proposal.diagnostics.filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);
      expect(proposal.patches.map((patch) => patch.path)).toEqual(expect.arrayContaining([
        'domains/shop/domain.dql',
        'domains/shop/modeling/areas/core.dql.yaml',
      ]));
      // Still write-free until the proposal is explicitly committed.
      expect(existsSync(join(projectRoot, 'domains'))).toBe(false);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('brings relationships declared in dbt tests across as draft edges (REL-004)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-test-edges-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas', 'core.dql.yaml'), 'domain: commerce\narea:\n  id: core\n  name: Core\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: {
        'model.shop.orders': { unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders', original_file_path: 'models/orders.sql', columns: { customer_id: { name: 'customer_id' } }, depends_on: { nodes: [] }, tags: [] },
        'model.shop.customers': { unique_id: 'model.shop.customers', resource_type: 'model', name: 'customers', original_file_path: 'models/customers.sql', columns: { id: { name: 'id' } }, depends_on: { nodes: [] }, tags: [] },
        // dbt already states the exact key pair and enforces it with `dbt test`.
        'test.shop.relationships_orders_customer_id': {
          unique_id: 'test.shop.relationships_orders_customer_id', resource_type: 'test', name: 'relationships_orders_customer_id',
          original_file_path: 'models/schema.yml', column_name: 'customer_id', attached_node: 'model.shop.orders',
          test_metadata: { name: 'relationships', kwargs: { field: 'id', to: "ref('customers')" } },
          depends_on: { nodes: ['model.shop.customers', 'model.shop.orders'] }, tags: [],
        },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string };
      const response = await fetch(`${base}/api/context-proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'dbt_discovery',
          expectedSnapshotId: modeling.snapshotId,
          operations: [
            { id: 'bind:orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'commerce', areaId: 'core', dbtModel: 'model.shop.orders', status: 'draft' } } },
            { id: 'bind:customers', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'customers', domain: 'commerce', areaId: 'core', dbtModel: 'model.shop.customers', status: 'draft' } } },
          ],
        }),
      });
      expect(response.status).toBe(201);
      const { proposal } = await response.json() as {
        proposal: { operations: Array<{ id: string; dependsOn?: string[]; evidence?: string[]; change?: { operation: string; value: Record<string, unknown> } }> };
      };
      const edge = proposal.operations.find((operation) => operation.change?.operation === 'upsert_relationship');
      expect(edge).toBeDefined();
      expect(edge!.change!.value).toMatchObject({
        id: 'orders_to_customers', domain: 'commerce', areaId: 'core', from: 'orders', to: 'customers',
        keys: [{ from: 'customer_id', to: 'id' }],
        // REL-001: a dbt test is evidence, never join authorization.
        status: 'draft', fanout: 'unknown',
      });
      expect(edge!.change!.value.validation).toBeUndefined();
      expect(edge!.change!.value.certifiedAgainst).toBeUndefined();
      expect(edge!.dependsOn).toEqual(expect.arrayContaining(['bind:orders', 'bind:customers']));
      expect(edge!.evidence).toContain('test.shop.relationships_orders_customer_id');
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('pairs MetricFlow primary and foreign entities into draft edges on semantic import (REL-004)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-semantic-edges-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas', 'core.dql.yaml'), 'domain: commerce\narea:\n  id: core\n  name: Core\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: Object.fromEntries(['orders', 'customers'].map((name) => [`model.shop.${name}`, { unique_id: `model.shop.${name}`, resource_type: 'model', name, original_file_path: `models/${name}.sql`, columns: { id: { name: 'id' } }, depends_on: { nodes: [] }, tags: [] }])),
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string };
      const semanticYaml = [
        'semantic_models:',
        '  - name: orders',
        '    model: ref("orders")',
        '    defaults:',
        '      agg_time_dimension: ordered_at',
        '    entities:',
        '      - name: order',
        '        type: primary',
        '        expr: id',
        '      - name: customer',
        '        type: foreign',
        '        expr: customer_id',
        '  - name: customers',
        '    model: ref("customers")',
        '    entities:',
        '      - name: customer',
        '        type: primary',
        '        expr: id',
        '',
      ].join('\n');
      const discovery = await (await fetch(`${base}/api/modeling/dbt-first/imports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { mode: 'paste', filename: 'semantic.yml', content: semanticYaml } }) })).json() as { session: { id: string; candidates: Array<{ id: string; dialect: string }> } };
      expect(discovery.session.candidates[0]).toMatchObject({ dialect: 'dbt_semantic' });

      const previewResponse = await fetch(`${base}/api/modeling/dbt-first/imports/${discovery.session.id}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selectedCandidateIds: discovery.session.candidates.map((candidate) => candidate.id), domain: 'commerce', areaId: 'core', expectedSnapshotId: modeling.snapshotId }) });
      expect(previewResponse.status).toBe(201);
      const { proposal } = await previewResponse.json() as {
        proposal: { operations: Array<{ id: string; dependsOn?: string[]; change?: { operation: string; value: Record<string, unknown> } }> };
      };
      const edge = proposal.operations.find((operation) => operation.change?.operation === 'upsert_relationship');
      expect(edge).toBeDefined();
      expect(edge!.change!.value).toMatchObject({
        from: 'orders', to: 'customers', keys: [{ from: 'customer_id', to: 'id' }],
        verb: 'customer', status: 'draft', fanout: 'unknown',
      });
      // MetricFlow's own grain and primary key survive the import.
      const ordersEntity = proposal.operations.find((operation) => operation.change?.operation === 'upsert_entity' && operation.change.value.id === 'orders');
      expect(ordersEntity!.change!.value).toMatchObject({ grain: 'ordered_at', keys: ['id'] });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('drops AI-proposed models and columns that are not in the dbt snapshot (AGT-024)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-modeling-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas', 'core.dql.yaml'), 'domain: commerce\narea:\n  id: core\n  name: Core\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: {
        'model.shop.orders': { unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders', original_file_path: 'models/orders.sql', columns: { id: { name: 'id' }, customer_id: { name: 'customer_id' } }, depends_on: { nodes: [] }, tags: [] },
        'model.shop.customers': { unique_id: 'model.shop.customers', resource_type: 'model', name: 'customers', original_file_path: 'models/customers.sql', columns: { id: { name: 'id' } }, depends_on: { nodes: [] }, tags: [] },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string };

      // Stand in for a provider reply that mixes real identifiers with
      // hallucinated ones. Everything invented must be dropped, not repaired.
      const response = await fetch(`${base}/api/context-proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'ai',
          expectedSnapshotId: modeling.snapshotId,
          operations: [
            { id: 'entity:commerce:orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'commerce', areaId: 'core', dbtModel: 'model.shop.orders', businessContext: 'One completed purchase.', status: 'draft' } } },
            { id: 'rel:commerce:invented', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'orders_to_customers', domain: 'commerce', areaId: 'core', from: 'orders', to: 'customers', keys: [{ from: 'customer_id', to: 'id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'certified', certifiedAgainst: { from: { grain: 'id', keys: ['customer_id'] }, to: { grain: 'id', keys: ['id'] } } } } },
            { id: 'remove:commerce:orders', kind: 'modeling_change', change: { operation: 'remove_entity', value: { id: 'orders', domain: 'commerce' } } },
          ],
        }),
      });
      expect(response.status).toBe(201);
      const { proposal } = await response.json() as {
        proposal: {
          operations: Array<{ id: string; change?: { operation: string; value: Record<string, unknown> } }>;
          diagnostics: Array<{ code: string; severity: string }>;
        };
      };

      // AGT-002/REL-002: an AI origin can never certify or attach proof.
      const relationship = proposal.operations.find((operation) => operation.change?.operation === 'upsert_relationship');
      expect(relationship!.change!.value.status).toBe('draft');
      expect(relationship!.change!.value.certifiedAgainst).toBeUndefined();
      expect(relationship!.change!.value.validation).toBeUndefined();
      // AI cannot delete governed source.
      expect(proposal.diagnostics).toContainEqual(expect.objectContaining({ code: 'AI_DELETE_FORBIDDEN', severity: 'blocking' }));
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('defaults an omitted subject area rather than blocking the proposal (UI-019)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-context-default-area-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'commerce'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: { 'model.shop.orders': { unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders', original_file_path: 'models/orders.sql', columns: { id: { name: 'id' } }, depends_on: { nodes: [] }, tags: [] } },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string };
      const response = await fetch(`${base}/api/context-proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'yaml_import',
          expectedSnapshotId: modeling.snapshotId,
          operations: [{ id: 'bind:orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'commerce', dbtModel: 'model.shop.orders', status: 'draft' } } }],
        }),
      });
      expect(response.status).toBe(201);
      const { proposal } = await response.json() as {
        proposal: {
          operations: Array<{ id: string; change?: { value: Record<string, unknown> } }>;
          diagnostics: Array<{ code: string; severity: string }>;
        };
      };
      expect(proposal.diagnostics).toContainEqual(expect.objectContaining({ code: 'MODEL_AREA_DEFAULTED', severity: 'info' }));
      expect(proposal.diagnostics.filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);
      expect(proposal.operations.find((operation) => operation.id === 'bind:orders')?.change?.value).toMatchObject({ areaId: 'core' });
      // The existing Domain is reused; only the missing area is synthesized.
      expect(proposal.operations.map((operation) => operation.id)).toEqual(['scope:area:commerce:core', 'bind:orders']);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });

  it('harvests a dbt relationships test against an area-owned entity with a local area id', async () => {
    // Regression: the harvest read the existing entity's `areaId`, which is the
    // qualified `commerce::model_area::core`, and split it on '::area::' — a
    // separator that never matches. The full qualified id was carried into the
    // relationship's `areaId`, reached `requiredId`, whose safe-id regex rejects
    // ':', and failed the entire proposal. Binding any dbt model that had a
    // relationships test pointing at an already-area-owned model was impossible.
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-context-area-harvest-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    // `customers` already belongs to an area, so its compiled `areaId` is qualified.
    writeFileSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'areas', 'core.dql.yaml'), [
      'domain: commerce',
      'area:',
      '  id: core',
      '  name: Core models',
      'entities:',
      '  - id: customers',
      '    dbt_model: model.shop.customers',
      '',
    ].join('\n'));
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'shop' },
      nodes: {
        'model.shop.customers': { unique_id: 'model.shop.customers', resource_type: 'model', name: 'customers', original_file_path: 'models/customers.sql', columns: { customer_id: { name: 'customer_id' }, first_order_id: { name: 'first_order_id' } }, depends_on: { nodes: [] }, tags: [] },
        'model.shop.orders': { unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders', original_file_path: 'models/orders.sql', columns: { order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' } }, depends_on: { nodes: [] }, tags: [] },
        // Attached to the ALREADY area-owned model, so the harvest reads that
        // entity's qualified `areaId` for the edge's own area.
        'test.shop.relationships_customers_first_order_id__order_id__ref_orders_.abc123': {
          unique_id: 'test.shop.relationships_customers_first_order_id__order_id__ref_orders_.abc123',
          resource_type: 'test',
          name: 'relationships_customers_first_order_id__order_id__ref_orders_',
          original_file_path: 'models/schema.yml',
          test_metadata: { name: 'relationships', kwargs: { to: "ref('orders')", field: 'order_id', column_name: 'first_order_id' } },
          attached_node: 'model.shop.customers',
          column_name: 'first_order_id',
          depends_on: { nodes: ['model.shop.customers', 'model.shop.orders'] },
          columns: {}, tags: [],
        },
      },
      sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
    }));
    let server: Server | undefined;
    try {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as {
        snapshotId: string;
        modeling: { entities: Record<string, { areaId?: string }> };
      };
      // Precondition: the compiled entity really does carry a qualified area id.
      expect(Object.values(modeling.modeling.entities).some((entity) => entity.areaId?.includes('::model_area::'))).toBe(true);

      const response = await fetch(`${base}/api/context-proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'dbt_discovery',
          expectedSnapshotId: modeling.snapshotId,
          operations: [{ id: 'bind:orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'commerce', dbtModel: 'model.shop.orders', areaId: 'core', status: 'draft' } } }],
        }),
      });

      expect(response.status).toBe(201);
      const { proposal } = await response.json() as {
        proposal: {
          operations: Array<{ id: string; change?: { value: Record<string, unknown> } }>;
          diagnostics: Array<{ code: string; severity: string; message: string }>;
        };
      };
      expect(proposal.diagnostics.filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);

      const harvested = proposal.operations.find((operation) => operation.id.startsWith('dbt-test:'));
      expect(harvested, 'the dbt relationships test should be harvested').toBeDefined();
      // The whole point: a writable local id, never the qualified form.
      expect(harvested?.change?.value.areaId).toBe('core');
      expect(String(harvested?.change?.value.areaId)).not.toContain(':');
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
    }
  });
});
