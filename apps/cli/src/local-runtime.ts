import { execFileSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { QueryExecutor, type ConnectionConfig, type DatabaseConnector, type SQLParamSpec } from '@duckcodeailabs/dql-connectors';
import {
  buildExecutionPlan,
  createWelcomeNotebook,
  deserializeNotebook,
  getConnectorFormSchemas,
  hasSemanticRefs,
  resolveSemanticRefs,
  type NotebookCell,
} from '@duckcodeailabs/dql-notebook';
import {
  loadSemanticLayerFromDir,
  resolveSemanticLayerAsync,
  getDialect,
  Parser,
  buildLineageGraph,
  buildManifest,
  findAppDocuments,
  findDashboardsForApp,
  isBlockIdRef,
  loadAppDocument,
  loadDashboardDocument,
  analyzeImpact,
  buildTrustChain,
  detectDomainFlows,
  getDomainTrustOverview,
  queryLineage,
  queryBusiness360,
  queryCompleteLineagePaths,
  LineageGraph,
  type SemanticLayer,
  type SemanticLayerProviderConfig,
  type SemanticLayerResult,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
  type Business360ResultV2,
  type AppDocument,
  type DashboardDocument,
  type DashboardGridItem,
  type DQLManifest,
  type ManifestBlock,
  canonicalize,
  canonicalizeNotebook,
  diffDQL,
  diffNotebook,
  type DiffReport,
} from '@duckcodeailabs/dql-core';
import { load as loadYaml } from 'js-yaml';
import { listBlockTemplates } from './block-templates.js';
import { getRunner as getLLMRunner } from './llm/index.js';
import type { AgentConversationContext, ProviderId } from './llm/types.js';
import { listRemoteMcpSettings, saveRemoteMcpSettings } from './llm/mcp-config.js';
import {
  ClaudeProvider,
  GeminiProvider,
  MemoryStore,
  OllamaProvider,
  OpenAIProvider,
  buildBlockBusinessFingerprint,
  buildBlockSqlFingerprints,
  buildLocalContextPack,
  defaultMemoryPath,
  ensureDefaultMemoryFiles,
  ensureMetadataCatalogFresh,
  recordQueryRun,
  recordRuntimeSchemaSnapshot,
  type AgentAnswer,
  type AgentResultPayload,
  type AgentProvider,
  type AgentSchemaTable,
  type LocalContextPack,
  type MetadataObject,
  type KGNode,
} from '@duckcodeailabs/dql-agent';
import { handleAppsApi, recommendVisualization } from './apps-api.js';
import {
  getActiveProvider,
  getEffectiveProviderConfig,
  listProviderSettings,
  saveProviderSettings,
  type ProviderSettingsId,
} from './settings/provider-settings.js';
import {
  DQLAccessDeniedError,
  activePersonaAppId,
  assertAppAccess,
  loadRuntimeApp,
  runtimeVariables,
} from './governance-runtime.js';
import { LocalAppStorage, LocalNotebookResearchStorage, defaultLocalAppsDbPath, defaultNotebookResearchDbPath } from '@duckcodeailabs/dql-project';
import type { BlockRecord, NotebookResearchDqlPromotion, NotebookResearchDqlPromotionAction, NotebookResearchIntent, NotebookResearchNextActionFilter, NotebookResearchPlan, NotebookResearchReadinessFilter, NotebookResearchRun, NotebookResearchRunListResult, NotebookResearchSort, NotebookResearchSourceCellInput, TestAssertionResult, TestResultSummary } from '@duckcodeailabs/dql-project';
import { Certifier, ENTERPRISE_RULES } from '@duckcodeailabs/dql-governance';
import {
  buildSemanticObjectDetail,
  buildSemanticTree,
  computeSyncDiff,
  loadSemanticImportManifest,
  performSemanticImport,
  previewSemanticImport,
  syncSemanticImport,
} from './semantic-import.js';
import {
  clearBlockStudioImportSessions,
  createBlockStudioImportSession,
  deleteBlockStudioImportSession,
  listBlockStudioImportSessions,
  loadBlockStudioImportSession,
  readBlockStudioImportCandidate,
  parameterizeSqlForDqlImport,
  updateBlockStudioImportCandidate,
  writeBlockStudioImportSession,
  writeBlockStudioImportCandidate,
  type BlockStudioImportInputMode,
  type BlockStudioImportSource,
  type BlockStudioImportSourceKind,
  type BlockStudioImportCandidate,
  type DqlGenerationCandidate,
  type DqlGenerationEvidence,
  type DqlGenerationSession,
  type BlockDraftSaveState,
  type BlockSimilarityMatch,
  type DqlCandidateRecommendedAction,
  type DqlParameterDecision,
} from './block-studio-import.js';
import {
  MetricFlowUnavailableError,
  compileMetricFlowQuery,
  hasDbtSemanticManifest,
} from './metricflow.js';

const NOTEBOOK_EXECUTE_PREVIEW_ROW_LIMIT = 500;

export interface ProjectConfig {
  project?: string;
  defaultConnection?: ConnectionConfig;
  defaultConnectionName?: string;
  connections?: Record<string, ConnectionConfig & { path?: string; type?: string }>;
  dataDir?: string;
  semanticLayer?: SemanticLayerProviderConfig;
  dbt?: {
    projectDir?: string;
    manifestPath?: string;
  };
  preview?: {
    port?: number;
    theme?: string;
    open?: boolean;
  };
}

export function resolveProjectSemanticConfig(
  projectConfig: ProjectConfig,
  projectRoot: string,
): SemanticLayerProviderConfig | undefined {
  const configured = projectConfig.semanticLayer;
  const dbtProjectDir = projectConfig.dbt?.projectDir;
  if (
    dbtProjectDir
    && (!configured || configured.provider === 'dql')
    && hasDbtSemanticArtifacts(projectRoot, dbtProjectDir)
  ) {
    return { provider: 'dbt', projectPath: dbtProjectDir };
  }
  return configured;
}

function hasDbtSemanticArtifacts(projectRoot: string, dbtProjectDir: string): boolean {
  const dbtRoot = resolve(projectRoot, dbtProjectDir);
  if (existsSync(join(dbtRoot, 'target', 'semantic_manifest.json'))) return true;
  const manifestPath = join(dbtRoot, 'target', 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    if (parsed.semantic_models && typeof parsed.semantic_models === 'object') return true;
    if (parsed.metrics && typeof parsed.metrics === 'object') return true;
  } catch {
    return false;
  }
  return false;
}

export interface DbtProfileConnectionCandidate {
  id: string;
  profileName: string;
  targetName: string;
  adapter: string;
  path: string;
  connection: ConnectionConfig;
  missingFields: string[];
  warnings: string[];
}

export interface ConnectorInstallStatus {
  driver: 'duckdb' | 'snowflake' | 'databricks';
  label: string;
  packageName?: string;
  packageSpec?: string;
  installed: boolean;
  builtIn: boolean;
  installPath: string;
  installCommand?: string;
}

export interface LocalServerOptions {
  rootDir: string;
  projectRoot?: string;
  executor: QueryExecutor;
  connection?: ConnectionConfig | null;
  preferredPort: number;
  /**
   * Host the HTTP server binds to. Defaults to `127.0.0.1` (loopback only)
   * for security. Set to `0.0.0.0` when running inside a container so the
   * port is reachable from the host. Honours `DQL_HOST` env var when unset.
   */
  host?: string;
}

export async function startLocalServer(opts: LocalServerOptions): Promise<number> {
  const { rootDir, executor, connection: rawConnection, preferredPort, projectRoot = process.cwd() } = opts;
  const bindHost = opts.host ?? process.env.DQL_HOST ?? '127.0.0.1';
  let connection = rawConnection ? normalizeProjectConnection(rawConnection, projectRoot) : null;
  let projectConfig = loadProjectConfig(projectRoot);
  const requireActiveConnection = (candidate: ConnectionConfig | null | undefined = connection): ConnectionConfig => {
    if (!candidate) {
      throw new Error('No database connection is configured yet. Open Connections, add a warehouse or local DuckDB/file connection, then retry.');
    }
    return candidate;
  };

  // Load semantic layer via provider system (dql native, dbt, cubejs, etc.)
  let semanticLayer: SemanticLayer | undefined;
  let semanticLayerErrors: string[] = [];
  let semanticDetectedProvider: string | undefined;
  const semanticLayerDir = join(projectRoot, 'semantic-layer');
  let semanticImportManifest = loadSemanticImportManifest(projectRoot);
  const userPrefsPath = join(projectRoot, '.dql-user-prefs.json');
  const semanticConfig = resolveProjectSemanticConfig(projectConfig, projectRoot);
  let semanticLastSyncTime: string | null = null;
  {
    const semanticConnection = connection;
    const executeQuery = semanticConfig?.provider === 'snowflake' && semanticConnection
      ? async (sql: string) => { const r = await executor.executeQuery(sql, [], {}, semanticConnection); return { rows: r.rows }; }
      : undefined;
    const result = await resolveSemanticLayerAsync(semanticConfig, projectRoot, executeQuery);
    semanticLayer = result.layer;
    semanticLayerErrors = result.errors;
    semanticDetectedProvider = result.detectedProvider;
    semanticLastSyncTime = result.layer ? new Date().toISOString() : null;
    semanticImportManifest = loadSemanticImportManifest(projectRoot);
    // Legacy fallback if provider system returned nothing and no errors
    if (!semanticLayer && semanticLayerErrors.length === 0 && existsSync(semanticLayerDir)) {
      try {
        semanticLayer = loadSemanticLayerFromDir(semanticLayerDir);
        semanticLastSyncTime = new Date().toISOString();
      } catch { /* continue without */ }
    }
  }
  await refreshLocalMetadataCatalog(projectRoot);

  // Auto-register data/ CSV and Parquet files as DuckDB views so semantic layer
  // queries like `FROM orders` resolve without requiring read_csv_auto() in SQL.
  if (connection && (connection.driver === 'file' || connection.driver === 'duckdb')) {
    const dataDir = projectConfig.dataDir
      ? resolve(projectRoot, projectConfig.dataDir)
      : join(projectRoot, 'data');
    if (existsSync(dataDir)) {
      try {
        const files = readdirSync(dataDir, { withFileTypes: true })
          .filter((e) => e.isFile() && /\.(csv|parquet)$/i.test(e.name));
        for (const file of files) {
          const tableName = file.name.replace(/\.(csv|parquet)$/i, '');
          const absPath = join(dataDir, file.name).replaceAll('\\', '/');
          const reader = file.name.endsWith('.parquet') ? 'read_parquet' : 'read_csv_auto';
          const ddl = `CREATE OR REPLACE VIEW "${tableName}" AS SELECT * FROM ${reader}('${absPath}')`;
          try { await executor.executeQuery(ddl, [], {}, connection); } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
    }
  }

  const executeLocalSqlForStoredResult = async (sql: string) => {
    const activeConnection = requireActiveConnection();
    const semantic = prepareSemanticSql(sql, semanticLayer);
    if (semantic.unresolvedRefs.length > 0) {
      throw new Error(`Unknown semantic reference${semantic.unresolvedRefs.length > 1 ? 's' : ''}: ${semantic.unresolvedRefs.join(', ')}`);
    }
    const prepared = prepareLocalExecution(semantic.sql, activeConnection, projectRoot, projectConfig);
    const result = await executor.executeQuery(
      prepared.sql,
      [],
      runtimeVariables({}),
      prepared.connection,
    );
    return normalizeQueryResult(result, semantic.semanticRefs);
  };

  const runNotebookForApp = async (appId: string, notebookPath: string): Promise<void> => {
    const absPath = safeJoin(projectRoot, notebookPath);
    if (!absPath || !existsSync(absPath) || statSync(absPath).isDirectory() || !absPath.endsWith('.dqlnb')) {
      throw new Error(`Notebook not found: ${notebookPath}`);
    }
    const app = loadRuntimeApp(projectRoot, appId);
    if (!app) throw new Error(`App "${appId}" not found`);

    const raw = readFileSync(absPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      cells?: Array<Record<string, unknown>>;
    };
    const sourceCells = parsed.cells ?? [];
    const resultByName = new Map<string, ReturnType<typeof normalizeQueryResult>>();
    const resultById = new Map<string, ReturnType<typeof normalizeQueryResult>>();
    const snapshotCells: Array<{
      cellId: string;
      status: 'idle' | 'running' | 'success' | 'error';
      result?: ReturnType<typeof normalizeQueryResult>;
      error?: string;
      executionCount?: number;
      executedAt?: string;
    }> = [];

    for (let index = 0; index < sourceCells.length; index++) {
      const sourceCell = sourceCells[index];
      const cellId = typeof sourceCell.id === 'string' ? sourceCell.id : `cell-${index + 1}`;
      const type = typeof sourceCell.type === 'string' ? sourceCell.type : 'sql';
      const title = typeof sourceCell.name === 'string'
        ? sourceCell.name
        : typeof sourceCell.title === 'string'
          ? sourceCell.title
          : undefined;
      const executedAt = new Date().toISOString();

      if (type === 'sql' || type === 'dql') {
        try {
          const cell: NotebookCell = {
            id: cellId,
            type: type as NotebookCell['type'],
            source: typeof sourceCell.content === 'string'
              ? sourceCell.content
              : typeof sourceCell.source === 'string'
                ? sourceCell.source
                : '',
            title,
            config: (sourceCell.chartConfig ?? sourceCell.config) as NotebookCell['config'],
          };
          const resolved = resolveNotebookBlockReferenceCell(cell, projectRoot);
          const activeConnection = requireActiveConnection();
          const tableMapping = await resolveSemanticTableMapping(executor, activeConnection, semanticLayer);
          const plan = buildExecutionPlan(resolved.cell, { semanticLayer, driver: activeConnection.driver, tableMapping });
          if (!plan) {
            snapshotCells.push({ cellId, status: 'idle', executionCount: 0, executedAt });
            continue;
          }
          const prepared = prepareLocalExecution(plan.sql, activeConnection, projectRoot, projectConfig);
          assertAppAccess({ app, domain: resolved.domain ?? app.domain, level: 'execute' });
          const rawResult = await executor.executeQuery(
            prepared.sql,
            plan.sqlParams,
            runtimeVariables(plan.variables),
            prepared.connection,
          );
          const result = normalizeQueryResult(rawResult);
          snapshotCells.push({
            cellId,
            status: 'success',
            result,
            executionCount: 1,
            executedAt,
          });
          resultById.set(cellId, result);
          if (title) resultByName.set(title, result);
        } catch (err) {
          snapshotCells.push({
            cellId,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            executionCount: 1,
            executedAt,
          });
        }
        continue;
      }

      const upstream = typeof sourceCell.upstream === 'string' ? sourceCell.upstream : undefined;
      const upstreamResult = upstream ? resultByName.get(upstream) ?? resultById.get(upstream) : undefined;
      if (upstreamResult && (type === 'chart' || type === 'table' || type === 'pivot' || type === 'single_value' || type === 'filter')) {
        snapshotCells.push({
          cellId,
          status: 'success',
          result: upstreamResult,
          executionCount: 1,
          executedAt,
        });
      }
    }

    writeRunSnapshot(projectRoot, notebookPath, {
      version: 1,
      notebookPath,
      capturedAt: new Date().toISOString(),
      cells: snapshotCells,
    });
  };

  const executeCertifiedBlockForAgent = async (node: KGNode): Promise<AgentResultPayload> => {
    if (node.kind !== 'block') {
      throw new Error(`Certified ${node.kind} "${node.name}" is a navigation artifact and cannot be executed as a block.`);
    }
    const manifest = buildManifest({ projectRoot });
    const block = manifest.blocks[node.name] ?? manifest.blocks[node.nodeId.replace(/^block:/, '')];
    if (!block) {
      throw new Error(`Matched block "${node.name}" is not present in the project manifest.`);
    }

    const absBlockPath = join(projectRoot, block.filePath);
    const source = readFileSync(absBlockPath, 'utf-8');
    const activeConnection = requireActiveConnection();
    const tableMapping = await resolveSemanticTableMapping(executor, activeConnection, semanticLayer);
    const semanticCompose = semanticLayer
      ? composeSemanticBlockSql(source, semanticLayer, {
          driver: activeConnection.driver,
          tableMapping,
          projectRoot,
          projectConfig,
          detectedProvider: semanticDetectedProvider,
        })
      : null;
    const plan = buildExecutionPlan(
      { id: `agent-${block.name}`, type: 'dql', source, title: block.name },
      { semanticLayer, driver: activeConnection.driver, tableMapping },
    );
    if (!plan && !semanticCompose?.sql) {
      const semanticError = semanticCompose?.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message;
      throw new Error(semanticError ?? `Block "${block.name}" produced no executable SQL.`);
    }

    const prepared = prepareLocalExecution(
      semanticCompose?.sql ?? plan!.sql,
      activeConnection,
      projectRoot,
      projectConfig,
    );
    const app = loadRuntimeApp(projectRoot, activePersonaAppId());
    assertAppAccess({ app, domain: block.domain ?? app?.domain, level: 'execute' });
    const rawResult = await executor.executeQuery(
      prepared.sql,
      plan?.sqlParams ?? [],
      runtimeVariables(plan?.variables ?? {}),
      prepared.connection,
    );
    const normalized = normalizeQueryResult(rawResult);
    return {
      columns: normalized.columns,
      rows: normalized.rows,
      rowCount: normalized.rowCount,
      executionTime: normalized.executionTime,
      chartConfig: plan?.chartConfig ?? (block.chartType ? { chart: block.chartType } : undefined),
      sql: prepared.sql,
      blockName: block.name,
      blockPath: block.filePath,
    };
  };

  const executeGeneratedSqlForAgent = async (sql: string): Promise<AgentResultPayload> => {
    const activeConnection = requireActiveConnection();
    const boundedSql = buildAgentPreviewSql(sql);
    const semantic = prepareSemanticSql(boundedSql, semanticLayer);
    if (semantic.unresolvedRefs.length > 0) {
      throw new Error(`Unknown semantic reference${semantic.unresolvedRefs.length > 1 ? 's' : ''}: ${semantic.unresolvedRefs.join(', ')}`);
    }
    const prepared = prepareLocalExecution(semantic.sql, activeConnection, projectRoot, projectConfig);
    const app = loadRuntimeApp(projectRoot, activePersonaAppId());
    assertAppAccess({ app, domain: app?.domain, level: 'execute' });
    const rawResult = await executor.executeQuery(
      prepared.sql,
      [],
      runtimeVariables({}),
      prepared.connection,
    );
    const normalized = normalizeQueryResult(rawResult, semantic.semanticRefs);
    return {
      columns: normalized.columns,
      rows: normalized.rows,
      rowCount: normalized.rowCount,
      executionTime: normalized.executionTime,
      sql: prepared.sql,
    };
  };

  const getSchemaContextForAgent = async (question: string): Promise<AgentSchemaTable[]> => {
    const catalogContext = await buildAgentSchemaContextFromCatalog(projectRoot, question).catch(() => []);
    if (catalogContext.length > 0) {
      if (!connection) return catalogContext;
      const enriched = await enrichAgentSchemaContextWithValueMatches(question, catalogContext, executor, connection);
      recordAgentRuntimeSchemaSnapshot(projectRoot, enriched, 'catalog enriched runtime schema');
      return enriched;
    }

    if (!connection) return [];
    try {
      const result = await executor.executeQuery(
        `SELECT table_schema, table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
         ORDER BY table_schema, table_name, ordinal_position
         LIMIT 2000`,
        [],
        runtimeVariables({}),
        connection,
      );
      const schemaContext = buildAgentSchemaContext(question, result.rows);
      const enriched = await enrichAgentSchemaContextWithValueMatches(question, schemaContext, executor, connection);
      recordAgentRuntimeSchemaSnapshot(projectRoot, enriched, 'information_schema runtime scan');
      return enriched;
    } catch {
      return [];
    }
  };

  const generateInvestigationSqlForApp = async (input: {
    appId: string;
    dashboardId?: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    title?: string;
    question: string;
    intent: string;
    context?: unknown;
  }): Promise<{
    sql?: string;
    answer?: string;
    result?: AgentResultPayload;
    analysisPlan?: unknown;
    evidence?: unknown;
    citations?: unknown[];
    suggestedViz?: string;
    executionError?: string;
    providerUsed?: string;
  }> => {
    const resolvedProvider = resolveDefaultLLMProvider(projectRoot);
    const runner = resolvedProvider ? getLLMRunner(resolvedProvider) : null;
    if (!resolvedProvider || !runner) {
      throw new Error('No AI provider is configured. Configure OpenAI, Gemini, Ollama, or a custom OpenAI-compatible endpoint in Settings.');
    }

    let governedAnswer: AgentAnswer | undefined;
    let providerError: string | undefined;
    const contextEnvelope = {
      mode: 'app_research',
      intent: input.intent,
      appId: input.appId,
      dashboardId: input.dashboardId,
      sourceTileId: input.sourceTileId,
      sourceBlockId: input.sourceBlockId,
      title: input.title,
      instruction: 'Generate review-required read-only SQL when certified blocks do not exactly answer the requested research grain. Execute only through the bounded generated SQL preview path.',
      context: input.context,
    };
    const controller = new AbortController();
    await runner.run(
      {
        provider: resolvedProvider,
        messages: [{ role: 'user', content: input.question }],
        upstream: {
          cellId: `app-research:${input.appId}:${input.dashboardId ?? 'app'}`,
          sql: JSON.stringify(contextEnvelope, null, 2),
        },
        projectRoot,
        executeCertifiedBlock: executeCertifiedBlockForAgent,
        executeGeneratedSql: executeGeneratedSqlForAgent,
        getSchemaContext: getSchemaContextForAgent,
      },
      (turn) => {
        if (turn.kind === 'tool_result' && turn.id === 'governed_answer') {
          governedAnswer = turn.output as AgentAnswer;
        }
        if (turn.kind === 'error') {
          providerError = turn.message;
        }
      },
      controller.signal,
    );

    if (!governedAnswer) {
      throw new Error(providerError ?? 'The AI provider did not return a governed answer.');
    }

    return {
      sql: governedAnswer.proposedSql ?? governedAnswer.sql,
      answer: governedAnswer.answer ?? governedAnswer.text,
      result: governedAnswer.result,
      analysisPlan: governedAnswer.analysisPlan,
      evidence: governedAnswer.evidence,
      citations: governedAnswer.citations,
      suggestedViz: governedAnswer.suggestedViz,
      executionError: governedAnswer.executionError,
      providerUsed: governedAnswer.providerUsed,
    };
  };

  const openNotebookResearchStorage = () => new LocalNotebookResearchStorage(defaultNotebookResearchDbPath(projectRoot));

  const runNotebookResearch = async (
    storage: LocalNotebookResearchStorage,
    run: NotebookResearchRun,
    input: {
      domain?: string;
      owner?: string;
      sourceCellFingerprint?: string;
      question?: string;
      intent?: NotebookResearchIntent;
      context?: unknown;
      generatedSql?: string;
      reviewedSql?: string;
    } = {},
  ): Promise<NotebookResearchRun> => {
    const question = notebookResearchString(input.question) || run.question;
    const domain = notebookResearchString(input.domain) ?? run.domain;
    const owner = notebookResearchString(input.owner) ?? run.owner;
    const sourceCellFingerprint = notebookResearchString(input.sourceCellFingerprint) ?? run.sourceCellFingerprint;
    const intent = input.intent ?? run.intent;
    const context = input.context === undefined ? run.context : input.context;
    let generatedSql = notebookResearchString(input.generatedSql) ?? run.generatedSql;
    let reviewedSql = notebookResearchString(input.reviewedSql) ?? run.reviewedSql;
    const startedAt = new Date().toISOString();
    storage.updateRun(run.id, {
      domain,
      owner,
      sourceCellFingerprint,
      question,
      intent,
      context,
      generatedSql,
      reviewedSql,
      status: 'running',
      reviewStatus: 'needs_review',
      error: '',
    });

    try {
      const contextPack = await buildLocalContextPack(projectRoot, {
        question,
        mode: 'question',
        surface: 'notebook',
        selectedContext: {
          ...notebookResearchSelectedContext(run, context),
          domain,
          owner,
          intent,
          researchPattern: notebookResearchIntentPattern(intent),
        },
        strictness: 'balanced',
        limit: 100,
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        return {
          id: '',
          routeDecision: undefined,
          evidenceRoles: [],
          warnings: [`Context pack failed: ${message}`],
          retrievalDiagnostics: { selectedEvidence: [] },
        } as unknown as LocalContextPack;
      });

      let governedAnswer: AgentAnswer | undefined;
      let providerError: string | undefined;
      const generationWarnings: string[] = [];
      if (!generatedSql && !reviewedSql) {
        const resolvedProvider = resolveDefaultLLMProvider(projectRoot);
        const runner = resolvedProvider ? getLLMRunner(resolvedProvider) : null;
        if (!resolvedProvider || !runner) {
          generationWarnings.push('No AI provider is configured. Metadata context was saved as a research plan; paste SQL or configure an AI provider to generate candidate SQL.');
        } else {
          const controller = new AbortController();
          try {
            await runner.run(
              {
                provider: resolvedProvider,
                messages: [{ role: 'user', content: notebookResearchAgentPrompt(question, intent) }],
                upstream: {
                  cellId: `notebook-research:${run.notebookPath}:${run.id}`,
                  sql: JSON.stringify({
                    mode: 'notebook_research',
                    notebookPath: run.notebookPath,
                    sourceCellId: run.sourceCellId,
                    sourceCellName: run.sourceCellName,
                    owner,
                    intent,
                    researchPattern: notebookResearchIntentPattern(intent),
                    instruction: 'Generate review-required read-only SQL from the inspected metadata context. Execute only through bounded preview and keep the result uncertified until promoted to a DQL draft.',
                    context,
                  }, null, 2),
                },
                projectRoot,
                executeCertifiedBlock: executeCertifiedBlockForAgent,
                executeGeneratedSql: executeGeneratedSqlForAgent,
                getSchemaContext: getSchemaContextForAgent,
              },
              (turn) => {
                if (turn.kind === 'tool_result' && turn.id === 'governed_answer') {
                  governedAnswer = turn.output as AgentAnswer;
                }
                if (turn.kind === 'error') providerError = turn.message;
              },
              controller.signal,
            );
          } catch (error) {
            providerError = error instanceof Error ? error.message : String(error);
          }
          if (!governedAnswer) {
            generationWarnings.push(`AI SQL generation did not return a governed answer. Metadata context was saved for review.${providerError ? ` ${providerError}` : ''}`);
          } else {
            generatedSql = notebookResearchString(governedAnswer.proposedSql) ?? notebookResearchString(governedAnswer.sql);
            if (!generatedSql) {
              generationWarnings.push('AI returned a governed answer without SQL. Metadata context was saved; add reviewed SQL before DQL promotion.');
            }
          }
        }
      }

      const sqlForPreview = reviewedSql || generatedSql;
      const warnings = [
        ...(contextPack.warnings ?? []),
        ...(governedAnswer?.validationWarnings ?? []),
        ...generationWarnings,
      ].filter(Boolean);
      let resultPreview: ReturnType<typeof normalizeQueryResult> | undefined;
      let previewError: string | undefined;
      if (governedAnswer?.result?.rows && !reviewedSql) {
        resultPreview = normalizeNotebookAgentResult(governedAnswer.result);
      } else if (sqlForPreview) {
        try {
          const previewSql = buildAgentPreviewSql(sqlForPreview);
          const previewStart = Date.now();
          resultPreview = await executeLocalSqlForStoredResult(previewSql);
          recordNotebookQueryRun(projectRoot, {
            notebookPath: run.notebookPath,
            cellId: run.sourceCellId,
            cellName: run.sourceCellName,
            researchRunId: run.id,
            source: reviewedSql ? 'notebook_research_reviewed_sql' : 'notebook_research_ai_sql',
            status: 'success',
            rowCount: resultPreview.rowCount ?? resultPreview.rows.length,
            durationMs: Date.now() - previewStart,
            sql: sqlForPreview,
            contextPackId: contextPack.id,
          });
        } catch (error) {
          previewError = error instanceof Error ? error.message : String(error);
          recordNotebookQueryRun(projectRoot, {
            notebookPath: run.notebookPath,
            cellId: run.sourceCellId,
            cellName: run.sourceCellName,
            researchRunId: run.id,
            source: reviewedSql ? 'notebook_research_reviewed_sql' : 'notebook_research_ai_sql',
            status: 'error',
            errorCode: previewError,
            sql: sqlForPreview,
            contextPackId: contextPack.id,
          });
        }
      }

      const routeDecision = notebookResearchRouteDecisionForRun(run, contextPack.routeDecision, sqlForPreview);
      const display = resultPreview
        ? recommendVisualization(projectRoot, {
            prompt: question,
            resultSchema: resultPreview.columns,
            rowSample: resultPreview.rows.slice(0, 25),
            defaultVisualization: governedAnswer?.suggestedViz,
          })
        : undefined;
      const evidence = {
        trustStatus: {
          label: governedAnswer?.trustLabel
            ?? (reviewedSql ? 'Reviewed notebook SQL' : generatedSql ? 'AI-generated research SQL' : 'Metadata-grounded research plan'),
          reviewRequired: true,
        },
        contextPackId: contextPack.id,
        routeDecision,
        selectedEvidence: contextPack.evidenceRoles?.slice(0, 24) ?? [],
        evidenceRoles: contextPack.evidenceRoles?.slice(0, 24) ?? [],
        evidenceSummaries: contextPack.evidenceSummaries?.slice(0, 16) ?? [],
        allowedSqlContext: {
          relations: (contextPack.allowedSqlContext?.relations ?? []).slice(0, 24).map((relation) => ({
            relation: relation.relation,
            name: relation.name,
            source: relation.source,
            columns: relation.columns.slice(0, 32).map((column) => {
              if (typeof column === 'string') return column;
              if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
                return String((column as { name: unknown }).name);
              }
              return String(column);
            }),
          })),
          sourceBlockSql: contextPack.allowedSqlContext?.sourceBlockSql?.slice(0, 12) ?? [],
        },
        missingContext: contextPack.missingContext?.slice(0, 16) ?? [],
        warnings: contextPack.warnings?.slice(0, 16) ?? [],
        retrievalDiagnostics: contextPack.retrievalDiagnostics,
        agentEvidence: governedAnswer?.evidence,
        analysisPlan: governedAnswer?.analysisPlan,
        citations: [
          ...(contextPack.citations ?? []),
          ...(governedAnswer?.citations ?? []),
        ].slice(0, 40),
      };
      const summary = notebookResearchString(governedAnswer?.answer)
        ?? notebookResearchString(governedAnswer?.text)
        ?? notebookResearchSummary(question, resultPreview, previewError);
      const recommendation = previewError
        ? 'Review the SQL, selected metadata, and connection context before rerunning.'
        : sqlForPreview
          ? 'Review the SQL, parameter choices, grain, and evidence before promoting this research into a DQL draft block.'
          : 'Review the selected metadata context, then paste reviewed SQL or configure an AI provider before DQL draft promotion.';
      const researchPlan = buildNotebookResearchPlan({
        run,
        evidence,
        resultPreview,
        previewError,
        generatedSql,
        reviewedSql,
        routeDecision,
      });
      return storage.updateRun(run.id, {
        domain,
        owner,
        sourceCellFingerprint,
        question,
        intent,
        context,
        status: previewError ? 'error' : 'ready',
        summary,
        recommendation,
        resultPreview,
        evidence,
        researchPlan,
        generatedSql,
        reviewedSql,
        display: display && display.ok ? display.display : undefined,
        contextPackId: contextPack.id,
        routeDecision,
        warnings: [
          ...warnings,
          ...(display && !display.ok ? [display.error] : []),
          ...(display && display.ok ? display.warnings : []),
        ],
        reviewStatus: 'needs_review',
        error: previewError,
        lastRunAt: startedAt,
      }) ?? run;
    } catch (error) {
      return storage.updateRun(run.id, {
        domain,
        owner,
        sourceCellFingerprint,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        reviewStatus: 'needs_review',
        lastRunAt: startedAt,
      }) ?? run;
    }
  };

  const promoteNotebookResearchToDql = async (
    storage: LocalNotebookResearchStorage,
    run: NotebookResearchRun,
    input: { domain?: string; owner?: string; tags?: string[]; provider?: string } = {},
  ): Promise<{ run: NotebookResearchRun; session: DqlGenerationSession }> => {
    const sql = notebookResearchString(run.reviewedSql) ?? notebookResearchString(run.generatedSql);
    if (!sql) throw new Error('Notebook research needs generated or reviewed SQL before DQL draft promotion.');
    const sourcePath = `${run.notebookPath}${run.sourceCellId ? `#${run.sourceCellId}` : ''}`;
    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'upload',
      sources: [{ path: sourcePath.endsWith('.sql') ? sourcePath : `${sourcePath}.sql`, content: sql }],
      sourceKind: 'raw-sql-file',
      domain: notebookResearchString(input.domain) ?? run.domain,
      owner: notebookResearchString(input.owner),
      tags: ['notebook-research', 'review-required', ...(Array.isArray(input.tags) ? input.tags : [])],
      provider: input.provider,
    }, semanticLayer);
    const draftPath = session.candidates.find((candidate) => candidate.draftSave?.path)?.draftSave?.path
      ?? session.candidates.find((candidate) => candidate.savedPath)?.savedPath;
    const promotion = buildNotebookDqlPromotionSummary(session, draftPath);
    const updated = storage.markPromoted(run.id, {
      draftBlockPath: draftPath,
      dqlImportId: session.id,
      dqlCandidateIds: session.candidates.map((candidate) => candidate.id),
      dqlPromotion: promotion,
    }) ?? run;
    const planned = storage.updateRun(updated.id, {
      researchPlan: buildNotebookResearchPlan({
        run: updated,
        evidence: updated.evidence,
        resultPreview: updated.resultPreview as ReturnType<typeof normalizeQueryResult> | undefined,
        generatedSql: updated.generatedSql,
        reviewedSql: updated.reviewedSql,
        routeDecision: updated.routeDecision,
      }),
    }) ?? updated;
    return { run: planned, session };
  };

  const checkNotebookResearchReuse = async (
    storage: LocalNotebookResearchStorage,
    run: NotebookResearchRun,
    input: { domain?: string; owner?: string } = {},
  ): Promise<{ run: NotebookResearchRun; promotion: NotebookResearchDqlPromotion; match: Awaited<ReturnType<typeof matchSqlForDqlReuse>> }> => {
    const sql = notebookResearchString(run.reviewedSql) ?? notebookResearchString(run.generatedSql);
    if (!sql) throw new Error('Notebook research needs generated or reviewed SQL before reuse checking.');
    const sourcePath = `${run.notebookPath}${run.sourceCellId ? `#${run.sourceCellId}` : ''}.sql`;
    const match = await matchSqlForDqlReuse({
      sql,
      sourcePath,
      name: run.title || 'Notebook research SQL',
      domain: notebookResearchString(input.domain) ?? run.domain ?? 'uncategorized',
      owner: notebookResearchString(input.owner) ?? 'analytics',
    });
    const promotion: NotebookResearchDqlPromotion = {
      importId: `reuse-check:${run.id}:${Date.now()}`,
      candidateIds: ['reuse_check'],
      recommendedAction: match.recommendedAction,
      similarityMatches: match.similarityMatches.slice(0, 8).map(toNotebookPromotionMatch),
      candidates: [{
        id: 'reuse_check',
        name: run.title || 'Notebook research SQL',
        domain: notebookResearchString(input.domain) ?? run.domain,
        reviewStatus: 'reuse_checked',
        recommendedAction: match.recommendedAction,
        similarityMatches: match.similarityMatches.slice(0, 5).map(toNotebookPromotionMatch),
        parameterPolicy: match.parameterPolicy.slice(0, 16).map((entry) => ({
          name: entry.name,
          policy: entry.policy,
        })),
        allowedFilters: match.allowedFilters.slice(0, 16),
        warnings: match.parameterDecisions
          .filter((decision) => decision.reason)
          .map((decision) => `${decision.name}: ${decision.reason}`)
          .slice(0, 12),
      }],
      createdAt: new Date().toISOString(),
    };
    const checked = storage.updateRun(run.id, {
      dqlPromotionAction: match.recommendedAction,
      dqlPromotion: promotion,
      researchPlan: buildNotebookResearchPlan({
        run: {
          ...run,
          dqlPromotionAction: match.recommendedAction,
          dqlPromotion: promotion,
        },
        evidence: run.evidence,
        resultPreview: run.resultPreview as ReturnType<typeof normalizeQueryResult> | undefined,
        generatedSql: run.generatedSql,
        reviewedSql: run.reviewedSql,
        routeDecision: run.routeDecision,
      }),
    }) ?? run;
    return { run: checked, promotion, match };
  };

  const matchSqlForDqlReuse = async (input: {
    sql: string;
    sourcePath?: string;
    name?: string;
    domain?: string;
    owner?: string;
  }) => {
    const sql = input.sql.trim();
    if (!sql) throw new Error('Missing SQL for reuse check.');
    const sourceTables = extractSqlTablesLight(sql);
    const candidate: BlockStudioImportCandidate = {
      id: 'match_sql',
      sourceKind: 'raw-sql-file',
      sourcePath: input.sourcePath ?? 'pasted.sql',
      name: input.name ?? 'SQL match preview',
      domain: input.domain ?? 'imported',
      description: 'SQL match preview candidate.',
      owner: input.owner ?? 'analytics',
      tags: [],
      sql,
      dqlSource: '',
      validation: null,
      preview: null,
      lineage: {
        sourceTables,
        parameters: [],
        warnings: [],
        statementIndex: 1,
        totalStatements: 1,
      },
      confidence: 0.8,
      splitStrategy: 'manual',
      warnings: [],
      conversionNotes: [],
      aiAssistance: [],
      reviewStatus: 'draft',
    };
    const evidence = deterministicDqlGenerationEvidence(candidate);
    const patch = deterministicDqlGenerationPatch(candidate, evidence);
    const contextPack = await buildDqlGenerationContextPack(projectRoot, { ...candidate, sql: patch.sql ?? sql }).catch(() => null);
    const similarity = buildDqlGenerationSimilarityMatches(candidate, patch, contextPack);
    return {
      parameterDecisions: patch.parameterDecisions ?? [],
      parameterPolicy: patch.parameterPolicy ?? [],
      filterBindings: patch.filterBindings ?? [],
      allowedFilters: patch.allowedFilters ?? [],
      parameterizedSql: patch.sql ?? sql,
      similarityMatches: similarity.matches,
      recommendedAction: similarity.recommendedAction,
    };
  };

  const buildNotebookDqlPromotionSummary = (
    session: DqlGenerationSession,
    draftBlockPath?: string,
  ): NotebookResearchDqlPromotion => {
    const primary = draftBlockPath
      ? session.candidates.find((candidate) => candidate.draftSave?.path === draftBlockPath || candidate.savedPath === draftBlockPath) ?? session.candidates[0]
      : session.candidates[0];
    return {
      importId: session.id,
      candidateIds: session.candidates.map((candidate) => candidate.id),
      draftBlockPath,
      recommendedAction: primary?.recommendedAction,
      similarityMatches: (primary?.similarityMatches ?? []).slice(0, 8).map(toNotebookPromotionMatch),
      candidates: session.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        domain: candidate.domain,
        draftPath: candidate.draftSave?.path,
        savedPath: candidate.savedPath,
        reviewStatus: candidate.reviewStatus,
        recommendedAction: candidate.recommendedAction,
        similarityMatches: (candidate.similarityMatches ?? []).slice(0, 5).map(toNotebookPromotionMatch),
        parameterPolicy: (candidate.parameterPolicy ?? []).slice(0, 16).map((entry) => ({
          name: entry.name,
          policy: entry.policy,
        })),
        allowedFilters: (candidate.allowedFilters ?? []).slice(0, 16),
        warnings: [...(candidate.warnings ?? []), ...(candidate.lineage.warnings ?? [])].slice(0, 12),
      })),
      createdAt: new Date().toISOString(),
    };
  };

  const toNotebookPromotionMatch = (match: BlockSimilarityMatch) => ({
    kind: match.kind,
    objectKey: match.objectKey,
    name: match.name,
    status: match.status,
    source: match.source,
    score: match.score,
    reason: match.reason,
    recommendedAction: match.recommendedAction,
  });

  // SSE clients for /api/watch hot-reload
  const sseClients = new Set<ServerResponse>();

  // Watch notebooks/, workbooks/, semantic-layer/, and data/ dirs for changes
  if (projectRoot) {
    for (const dir of ['notebooks', 'workbooks', 'blocks', 'dashboards', 'semantic-layer', 'data']) {
      const watchDir = join(projectRoot, dir);
      if (!existsSync(watchDir)) continue;
      try {
        watch(watchDir, { persistent: false }, (eventType, filename) => {
          if (!filename) return;
          const path = `${dir}/${filename}`;
          const payload = JSON.stringify({ type: eventType === 'rename' ? 'file-added' : 'file-changed', path });
          for (const client of sseClients) {
            try { client.write(`event: change\ndata: ${payload}\n\n`); } catch { sseClients.delete(client); }
          }
          // Hot-reload semantic layer on change and notify frontend
          if (dir === 'semantic-layer') {
            const semanticConnection = connection;
            const executeQuery = semanticConfig?.provider === 'snowflake' && semanticConnection
              ? async (sql: string) => { const r = await executor.executeQuery(sql, [], {}, semanticConnection); return { rows: r.rows }; }
              : undefined;
            resolveSemanticLayerAsync(semanticConfig, projectRoot, executeQuery).then((refreshed) => {
              if (refreshed.layer) {
                semanticLayer = refreshed.layer;
                semanticLayerErrors = refreshed.errors;
                semanticLastSyncTime = new Date().toISOString();
                semanticImportManifest = loadSemanticImportManifest(projectRoot);
              } else if (refreshed.errors.length > 0) {
                semanticLayerErrors = refreshed.errors;
              }
              // Notify all connected notebook clients to re-fetch the semantic layer
              const reloadPayload = JSON.stringify({ type: 'semantic-reload' });
              for (const client of sseClients) {
                try { client.write(`event: change\ndata: ${reloadPayload}\n\n`); } catch { sseClients.delete(client); }
              }
            }).catch(() => { /* reload errors are non-fatal */ });
          }
        });
      } catch { /* dir not watchable */ }
    }
  }

  const validateImportCandidate = (candidate: BlockStudioImportCandidate): BlockStudioImportCandidate => ({
    ...candidate,
    validation: validateBlockStudioSource(candidate.dqlSource, semanticLayer),
  });

  const validateImportCandidateForSave = (candidate: BlockStudioImportCandidate): {
    candidate: BlockStudioImportCandidate;
    errors: string[];
  } => {
    const validated = validateImportCandidate(candidate);
    const diagnostics = ((validated.validation as any)?.diagnostics ?? []) as Array<{ severity?: string; message?: string }>;
    const errors = diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message || 'Candidate validation failed.');
    if (validated.reviewStatus === 'rejected') {
      errors.unshift('Candidate was rejected.');
    }
    const duplicateBlocker = duplicateCertificationBlocker(validated);
    if (duplicateBlocker) errors.unshift(duplicateBlocker);
    return { candidate: validated, errors };
  };

  const duplicateCertificationBlocker = (candidate: BlockStudioImportCandidate): string | null => {
    const match = candidate.similarityMatches?.[0];
    if (!match) return null;
    const duplicateKind = match.kind === 'exact_sql_match'
      || match.kind === 'parameterized_duplicate'
      || (match.kind === 'business_duplicate' && match.status === 'certified' && match.score >= 0.76);
    if (!duplicateKind) return null;
    const replacementFor = new Set((candidate.replacementFor ?? []).map((value) => value.toLowerCase()));
    const documentedReplacement = candidate.recommendedAction === 'create_replacement'
      || replacementFor.has(match.name.toLowerCase())
      || (match.objectKey && replacementFor.has(match.objectKey.toLowerCase()));
    if (documentedReplacement) return null;
    return `Likely duplicate of ${match.name} (${match.kind}, ${Math.round(match.score * 100)}% match). Reuse the existing block, extend it, or document this draft as a replacement before certification.`;
  };

  const runBlockStudioPreviewSource = async (
    source: string,
    targetConnection?: ConnectionConfig | null,
  ): Promise<{
    sql: string;
    result: ReturnType<typeof normalizeQueryResult>;
    chartConfig: { chart?: string; x?: string; y?: string; color?: string; title?: string } | null;
  }> => {
    const activeConnection = requireActiveConnection(targetConnection);
    let tableMapping: Record<string, string> | undefined;
    if (semanticLayer) {
      try {
        const tablesResult = await executor.executeQuery(
          `SELECT table_schema, table_name
           FROM information_schema.tables
           WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`,
          [], {}, activeConnection,
        );
        tableMapping = buildSemanticTableMapping(semanticLayer, tablesResult.rows);
      } catch {
        tableMapping = undefined;
      }
    }
    const semanticCompose = semanticLayer
      ? composeSemanticBlockSql(source, semanticLayer, {
          driver: activeConnection.driver,
          tableMapping,
          projectRoot,
          projectConfig,
          detectedProvider: semanticDetectedProvider,
        })
      : null;
    const validation = validateBlockStudioSource(source, semanticLayer);
    const executableSql = semanticCompose?.sql ?? validation.executableSql;
    if (!executableSql) {
      const message = semanticCompose?.diagnostics.find((item) => item.severity === 'error')?.message
        ?? validation.diagnostics.find((item) => item.severity === 'error')?.message
        ?? 'No executable SQL found in block source.';
      throw new Error(message);
    }
    const plan = buildExecutionPlan(
      { id: 'block-studio', type: 'dql', source, title: 'Block Studio' },
      { semanticLayer, driver: activeConnection.driver, tableMapping },
    );
    const prepared = prepareLocalExecution(
      semanticCompose?.sql ?? plan?.sql ?? executableSql,
      activeConnection,
      projectRoot,
      projectConfig,
    );
    const result = await executor.executeQuery(
      prepared.sql,
      plan?.sqlParams ?? [],
      runtimeVariables(plan?.variables ?? {}),
      prepared.connection,
    );
    return {
      sql: prepared.sql,
      result: normalizeQueryResult(result),
      chartConfig: plan?.chartConfig ?? validation.chartConfig ?? null,
    };
  };

  const runBlockStudioTestSummary = async (
    source: string,
    targetConnection?: ConnectionConfig | null,
  ): Promise<TestResultSummary> => {
    const activeConnection = requireActiveConnection(targetConnection);
    const start = Date.now();
    const tableMapping = await resolveSemanticTableMapping(executor, activeConnection, semanticLayer);
    const plan = buildExecutionPlan(
      { id: 'block-studio-tests', type: 'dql', source, title: 'Block Studio' },
      { semanticLayer, driver: activeConnection.driver, tableMapping },
    );
    const tests = plan?.tests ?? [];
    if (!plan || !plan.sql) {
      return {
        passed: 0,
        failed: Math.max(tests.length, 1),
        skipped: 0,
        duration: Date.now() - start,
        assertions: [{
          name: 'build execution plan',
          passed: false,
          error: 'Could not build an execution plan for this block.',
        }],
        runAt: new Date(),
      };
    }
    if (tests.length === 0) {
      return { passed: 0, failed: 0, skipped: 0, duration: Date.now() - start, assertions: [], runAt: new Date() };
    }

    const prepared = prepareLocalExecution(plan.sql, activeConnection, projectRoot, projectConfig);
    const rawResult = await executor.executeQuery(
      prepared.sql,
      plan.sqlParams ?? [],
      runtimeVariables(plan.variables ?? {}),
      prepared.connection,
    );
    const rows = Array.isArray(rawResult?.rows) ? rawResult.rows : [];
    const columns = Array.isArray(rawResult?.columns)
      ? rawResult.columns.map((column: any) => typeof column === 'string' ? column : column?.name ?? String(column))
      : [];
    const assertions: TestAssertionResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const test of tests) {
      const name = `assert ${test.field} ${test.operator} ${formatBlockStudioExpected(test.expected)}`;
      let actual: unknown;
      if (test.field === 'row_count') {
        actual = rows.length;
      } else if (!columns.includes(test.field)) {
        assertions.push({ name, passed: false, expected: test.expected, error: `Column '${test.field}' not found in results` });
        failed += 1;
        continue;
      } else {
        actual = rows[0]?.[test.field];
      }

      const ok = compareBlockStudioValues(actual, test.operator, test.expected);
      if (ok) {
        assertions.push({ name, passed: true, actual, expected: test.expected });
        passed += 1;
      } else {
        assertions.push({
          name,
          passed: false,
          actual,
          expected: test.expected,
          error: `${String(actual)} ${test.operator} ${formatBlockStudioExpected(test.expected)} is false`,
        });
        failed += 1;
      }
    }

    return { passed, failed, skipped: 0, duration: Date.now() - start, assertions, runAt: new Date() };
  };

  const saveDqlGenerationDraft = (
    importId: string,
    candidate: BlockStudioImportCandidate,
  ): DqlGenerationCandidate => saveDqlGenerationDraftForProject(projectRoot, importId, candidate);

  const createDqlGenerationSessionFromBody = async (body: any): Promise<DqlGenerationSession> => {
    return createDqlGenerationSessionForProject(projectRoot, {
      inputPath: typeof body.path === 'string' ? body.path : '',
      inputMode: body.inputMode === 'paste' || body.inputMode === 'upload' || body.inputMode === 'path' ? body.inputMode : undefined,
      sources: Array.isArray(body.sources)
        ? body.sources.map((source: any, index: number) => ({
            path: typeof source?.path === 'string' ? source.path : `source-${index + 1}.sql`,
            content: typeof source?.content === 'string' ? source.content : '',
          }))
        : undefined,
      sourceKind: typeof body.sourceKind === 'string' ? body.sourceKind : 'raw-sql',
      domain: typeof body.domain === 'string' ? body.domain : undefined,
      owner: typeof body.owner === 'string' ? body.owner : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
    }, semanticLayer);
  };

  const loadDqlGenerationSession = (importId: string): DqlGenerationSession => {
    const session = loadBlockStudioImportSession(projectRoot, importId);
    const candidates = session.candidates.map((candidate) => ({
      ...candidate,
      generationMode: candidate.generationMode ?? 'deterministic',
      generationProvider: candidate.generationProvider ?? 'local-deterministic',
      llmContext: candidate.llmContext ?? deterministicDqlGenerationContext(candidate, candidate.evidence ?? []),
      evidence: candidate.evidence ?? deterministicDqlGenerationEvidence(candidate),
      draftSave: candidate.draftSave ?? (
        isDraftBlockPath(candidate.savedPath)
          ? { status: 'saved' as const, path: candidate.savedPath }
          : { status: 'pending' as const }
      ),
    }));
    return {
      ...session,
      mode: 'ai-import',
      candidates,
      generation: {
        provider: candidates.find((candidate) => candidate.generationProvider)?.generationProvider ?? 'local-deterministic',
        aiEnabled: candidates.some((candidate) => candidate.generationMode === 'ai'),
        contextObjectCount: candidates.reduce((sum, candidate) => sum + (candidate.evidence?.length ?? 0), 0),
        createdDrafts: candidates.filter((candidate) => candidate.draftSave.status === 'saved').length,
        warnings: candidates.flatMap((candidate) => candidate.draftSave.status === 'error' && candidate.draftSave.error ? [candidate.draftSave.error] : []),
      },
    };
  };

  const certifyBlockStudioSource = async (
    source: string,
    blockPath?: string | null,
    options: { enterprise?: boolean } = {},
  ) => {
    const validation = validateBlockStudioSource(source, semanticLayer);
    let preview: Awaited<ReturnType<typeof runBlockStudioPreviewSource>> | null = null;
    let testResults: TestResultSummary | null = null;
    const blockers: string[] = [];

    try {
      preview = await runBlockStudioPreviewSource(source);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }

    try {
      testResults = await runBlockStudioTestSummary(source);
    } catch (error) {
      testResults = {
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 0,
        assertions: [{ name: 'run tests', passed: false, error: error instanceof Error ? error.message : String(error) }],
        runAt: new Date(),
      };
    }

    const parsed = parseBlockSourceMetadata(source);
    const record: BlockRecord = {
      id: parsed.name || 'local',
      name: parsed.name || 'unnamed',
      domain: parsed.domain,
      type: parsed.blockType || 'custom',
      version: '0.0.0',
      status: 'draft',
      gitRepo: '',
      gitPath: blockPath ?? '',
      gitCommitSha: '',
      description: parsed.description,
      owner: parsed.owner,
      tags: parsed.tags,
      llmContext: parsed.llmContext,
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
    };
    const certification = new Certifier(options.enterprise ? ENTERPRISE_RULES : undefined).evaluate(record, testResults ?? undefined);
    const checklist = buildBlockStudioCertificationChecklist({
      source,
      validation,
      previewSucceeded: Boolean(preview),
      testResults,
      certificationErrors: certification.errors,
      extraBlockers: blockers,
    });
    return { certification, checklist, validation, preview, testResults };
  };

  const server = createServer(async (req, res) => {
    const requestUrl = req.url || '/';
    const url = new URL(requestUrl, 'http://127.0.0.1');
    const path = url.pathname || '/';

    // CORS — needed for dql-notebook SPA dev mode
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ status: 'ok' }));
      return;
    }

    if (req.method === 'GET' && path === '/api/settings/env-status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ groups: collectSettingsEnvStatus() }));
      return;
    }

    if (req.method === 'GET' && path === '/api/settings/providers') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ providers: listProviderSettings(projectRoot) }));
      return;
    }

    if (req.method === 'POST' && path === '/api/settings/providers') {
      try {
        const body = await readJSON(req);
        if (!isProviderSettingsId(body?.id)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Unknown provider id.' }));
          return;
        }
        const providers = saveProviderSettings(projectRoot, {
          id: body.id,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, providers }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/settings/providers/test') {
      try {
        const body = await readJSON(req);
        if (!isProviderSettingsId(body?.id)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ ok: false, error: 'Unknown provider id.' }));
          return;
        }
        const ok = await testProviderConfig(projectRoot, body.id);
        res.writeHead(ok.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(ok));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/settings/mcp') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ settings: listRemoteMcpSettings(projectRoot) }));
      return;
    }

    if (req.method === 'POST' && path === '/api/settings/mcp') {
      try {
        const body = await readJSON(req);
        const settings = saveRemoteMcpSettings(projectRoot, { entries: body?.entries });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, settings }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/agent/memory') {
      const memory = new MemoryStore(defaultMemoryPath(projectRoot));
      try {
        const scope = url.searchParams.get('scope') ?? undefined;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ memories: memory.list(isMemoryScope(scope) ? scope : undefined) }));
      } finally {
        memory.close();
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/agent/memory') {
      const body = await readJSON(req).catch(() => null);
      if (!body || !isMemoryScope(body.scope) || typeof body.title !== 'string' || typeof body.content !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'scope, title, and content are required.' }));
        return;
      }
      const memory = new MemoryStore(defaultMemoryPath(projectRoot));
      try {
        const saved = memory.upsert({
          id: typeof body.id === 'string' ? body.id : undefined,
          scope: body.scope,
          scopeId: typeof body.scopeId === 'string' ? body.scopeId : undefined,
          title: body.title,
          content: body.content,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          source: typeof body.source === 'string' ? body.source : 'settings-ui',
          confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
          importance: typeof body.importance === 'number' ? body.importance : undefined,
          validFrom: typeof body.validFrom === 'string' ? body.validFrom : undefined,
          validTo: typeof body.validTo === 'string' ? body.validTo : undefined,
          supersedes: typeof body.supersedes === 'string' ? body.supersedes : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, memory: saved }));
      } finally {
        memory.close();
      }
      return;
    }

    if (req.method === 'DELETE' && path === '/api/agent/memory') {
      const id = url.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'id is required.' }));
        return;
      }
      const memory = new MemoryStore(defaultMemoryPath(projectRoot));
      try {
        memory.delete(id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true }));
      } finally {
        memory.close();
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/agent/memory/default-files') {
      const files = ensureDefaultMemoryFiles(projectRoot).map((p) => relative(projectRoot, p));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ ok: true, files }));
      return;
    }

    const appDashRun = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)\/run$/);
    if (req.method === 'POST' && appDashRun) {
      try {
        const appId = decodeURIComponent(appDashRun[1]);
        const dashboardId = decodeURIComponent(appDashRun[2]);
        const body = await readJSON(req).catch(() => ({}));
        const loaded = loadAppDashboard(projectRoot, appId, dashboardId);
        if (!loaded) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Dashboard "${dashboardId}" not found in app "${appId}"` }));
          return;
        }

        const manifest = buildManifest({ projectRoot });
        const variables = body.variables && typeof body.variables === 'object'
          ? body.variables as Record<string, unknown>
          : {};
        const dashboardVariables = dashboardRuntimeVariables(loaded.dashboard, variables);
        const tiles = [];
        let localApps: LocalAppStorage | null = null;
        for (const item of loaded.dashboard.layout.items) {
          if (item.text) {
            tiles.push({
              tileId: item.i,
              status: 'ok',
              tileType: 'text',
              title: item.title,
              viz: item.viz,
              text: item.text,
            });
            continue;
          }
          if (item.aiPin) {
            try {
              localApps ??= new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
            } catch (err) {
              tiles.push({
                tileId: item.i,
                status: 'error',
                tileType: 'aiPin',
                error: err instanceof Error ? err.message : String(err),
              });
              continue;
            }
            let pin = localApps.getAiPin(item.aiPin.id);
            if (!pin) {
              tiles.push({
                tileId: item.i,
                status: 'unresolved',
                tileType: 'aiPin',
                error: `AI pin "${item.aiPin.id}" could not be found`,
              });
              continue;
            }
            if (pin.refreshCadence === 'daily' && pin.sql && isAiPinRefreshDue(pin.lastRefreshedAt)) {
              try {
                const refreshed = await executeLocalSqlForStoredResult(pin.sql);
                pin = localApps.updateAiPinResult(pin.id, refreshed) ?? pin;
              } catch (err) {
                pin = localApps.updateAiPinResult(
                  pin.id,
                  pin.result,
                  err instanceof Error ? err.message : String(err),
                ) ?? pin;
              }
            }
            tiles.push({
              tileId: item.i,
              status: 'ok',
              tileType: 'aiPin',
              title: item.title ?? pin.title,
              viz: item.viz,
              chartConfig: mergeDashboardChartConfig(pin.chartConfig as Record<string, unknown> | undefined, item),
              result: pin.result,
              aiPin: pin,
              citation: {
                kind: 'ai_pin',
                name: pin.title,
              },
            });
            continue;
          }
          const block = resolveDashboardItemBlock(item, manifest);
          if (!block) {
            tiles.push({
              tileId: item.i,
              status: 'unresolved',
              blockRef: item.block ? (isBlockIdRef(item.block) ? item.block.blockId : item.block.ref) : '(missing source)',
              error: 'Block reference could not be resolved',
            });
            continue;
          }
          try {
            assertAppAccess({
              app: loaded.app,
              domain: block.domain ?? loaded.dashboard.metadata.domain ?? loaded.app.domain,
              level: 'execute',
            });
            const absBlockPath = join(projectRoot, block.filePath);
            const source = readFileSync(absBlockPath, 'utf-8');
            const targetConnection = isConnectionConfig(body.connection) ? body.connection : connection;
            const tableMapping = await resolveSemanticTableMapping(executor, targetConnection, semanticLayer);
            const semanticCompose = semanticLayer
              ? composeSemanticBlockSql(source, semanticLayer, {
                  driver: targetConnection.driver,
                  tableMapping,
                  projectRoot,
                  projectConfig,
                  detectedProvider: semanticDetectedProvider,
                })
              : null;
            const plan = buildExecutionPlan(
              { id: item.i, type: 'dql', source, title: item.title ?? block.name },
              { semanticLayer, driver: targetConnection.driver, tableMapping },
            );
            if (!plan && !semanticCompose?.sql) {
              tiles.push({
                tileId: item.i,
                status: 'error',
                blockId: block.name,
                error: semanticCompose?.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? 'Block produced no executable plan',
              });
              continue;
            }
            const filterApplication = applyDashboardFiltersToBlockExecution({
              sql: semanticCompose?.sql ?? plan!.sql,
              sqlParams: plan?.sqlParams ?? [],
              variables: { ...(plan?.variables ?? {}), ...dashboardVariables },
              block,
              dashboard: loaded.dashboard,
            });
            const prepared = prepareLocalExecution(
              filterApplication.sql,
              targetConnection,
              projectRoot,
              projectConfig,
            );
            const result = await executor.executeQuery(
              prepared.sql,
              filterApplication.sqlParams,
              runtimeVariables(filterApplication.variables),
              prepared.connection,
            );
            tiles.push({
              tileId: item.i,
              status: 'ok',
              blockId: block.name,
              blockPath: block.filePath,
              certificationStatus: block.status ?? null,
              title: item.title ?? block.name,
              viz: item.viz,
              chartConfig: mergeDashboardChartConfig(plan?.chartConfig, item),
              result: normalizeQueryResult(result),
              filters: {
                applied: filterApplication.appliedFilters,
                skipped: filterApplication.skippedFilters,
              },
              citation: {
                kind: 'block',
                name: block.name,
                path: block.filePath,
              },
            });
          } catch (err) {
            if (err instanceof DQLAccessDeniedError) {
              tiles.push({
                tileId: item.i,
                status: 'unauthorized',
                blockId: block.name,
                error: err.message,
              });
            } else {
              tiles.push({
                tileId: item.i,
                status: 'error',
                blockId: block.name,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        localApps?.close();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          appId,
          dashboardId,
          persona: activePersonaAppId() ? { appId: activePersonaAppId() } : null,
          tiles,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Apps, dashboards, persona — see apps-api.ts. Returns true if handled.
    if (path.startsWith('/api/apps') || path.startsWith('/api/visualizations') || path === '/api/persona') {
      try {
          const handled = await handleAppsApi({
            req,
            res: res as unknown as ServerResponse,
          url,
          path,
          projectRoot,
          executeSql: executeLocalSqlForStoredResult,
          generateInvestigationSql: generateInvestigationSqlForApp,
          runNotebook: (appId, notebookPath) => runNotebookForApp(appId, notebookPath),
        });
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: (err as Error).message }));
        }
        return;
      }
    }

    // SSE endpoint for hot-reload file watching
    if (req.method === 'GET' && path === '/api/watch') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
        sseClients.add(res as unknown as ServerResponse);
        req.on('close', () => { sseClients.delete(res as unknown as ServerResponse); });
      return;
    }

    // ── dql-notebook file management API ─────────────────────────────────────
    // GET  /api/notebooks          — list all .dql/.dqlnb files grouped by folder
    // GET  /api/notebook-content   — read a file (?path=relative/path)
    // POST /api/notebooks          — create new notebook
    // PUT  /api/notebook-content   — save file
    // GET  /api/schema             — list data files for schema panel
    if (req.method === 'GET' && path === '/api/notebooks') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(scanNotebookFiles(projectRoot)));
      return;
    }

    if (req.method === 'GET' && path === '/api/notebook-content') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'Missing path query parameter' }));
        return;
      }
      const absPath = safeJoin(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'File not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ content: readFileSync(absPath, 'utf-8') }));
      return;
    }

    if (req.method === 'POST' && path === '/api/notebooks') {
      try {
        const body = await readJSON(req);
        const { name, template } = body as { name: string; template: string };
        if (!name || typeof name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing notebook name' }));
          return;
        }
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'notebook';
        const nbDir = join(projectRoot, 'notebooks');
        mkdirSync(nbDir, { recursive: true });
        const nbPath = join(nbDir, `${slug}.dqlnb`);
        if (existsSync(nbPath)) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Notebook already exists' }));
          return;
        }
        const content = buildNotebookTemplate(name, template ?? 'blank');
        writeFileSync(nbPath, content, 'utf-8');
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ path: `notebooks/${slug}.dqlnb`, content }));
      } catch (error) {
        if (error instanceof DQLAccessDeniedError) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: error.message, code: 'unauthorized' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'PUT' && path === '/api/notebook-content') {
      try {
        const body = await readJSON(req);
        const { path: filePath, content } = body as { path: string; content: string };
        if (!filePath || typeof content !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing path or content' }));
          return;
        }
        const absPath = safeJoin(projectRoot, filePath);
        if (!absPath) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Invalid path' }));
          return;
        }
        mkdirSync(dirname(absPath), { recursive: true });
        const toWrite = absPath.endsWith('.dql')
          ? canonicalizeSafe(content)
          : absPath.endsWith('.dqlnb')
            ? canonicalizeNotebookSafe(content)
            : content;
        writeFileSync(absPath, toWrite, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true }));
      } catch (error) {
        if (error instanceof DQLAccessDeniedError) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: error.message, code: 'unauthorized' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/notebook/research') {
      const storage = openNotebookResearchStorage();
      try {
        const notebookPath = notebookResearchString(url.searchParams.get('path'));
        const sourceCellId = notebookResearchString(url.searchParams.get('sourceCellId') ?? url.searchParams.get('cellId'));
        const domain = notebookResearchString(url.searchParams.get('domain'));
        const owner = notebookResearchString(url.searchParams.get('owner'));
        const intent = notebookResearchIntent(url.searchParams.get('intent'));
        const search = notebookResearchString(url.searchParams.get('q')) ?? notebookResearchString(url.searchParams.get('search'));
        const status = notebookResearchStatus(url.searchParams.get('status'));
        const reviewStatus = notebookResearchReviewStatus(url.searchParams.get('reviewStatus'));
        const promotionAction = notebookResearchPromotionAction(url.searchParams.get('promotionAction') ?? url.searchParams.get('action'));
        const readiness = notebookResearchReadiness(url.searchParams.get('readiness') ?? url.searchParams.get('ready'));
        const age = notebookResearchAge(url.searchParams.get('age'));
        const nextAction = notebookResearchNextAction(url.searchParams.get('nextAction') ?? url.searchParams.get('next'));
        const activeOnlyParam = url.searchParams.get('activeOnly') ?? url.searchParams.get('active');
        const activeOnly = activeOnlyParam === 'true' || activeOnlyParam === '1';
        const sort = notebookResearchSort(url.searchParams.get('sort'));
        const limit = notebookResearchInteger(url.searchParams.get('limit'), 50, 1, 500);
        const offset = notebookResearchInteger(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        const page = storage.listRunsPage({ notebookPath, sourceCellId, domain, owner, intent, search, status, reviewStatus, promotionAction, readiness, age, nextAction, activeOnly, sort, limit, offset });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(withNotebookResearchChecklistPage(page)));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        storage.close();
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/notebook/research') {
      const storage = openNotebookResearchStorage();
      try {
	        const body = await readJSON(req);
	        const notebookPath = notebookResearchString(body.notebookPath) ?? notebookResearchString(body.path);
	        const question = notebookResearchString(body.question);
	        const sourceCell = notebookResearchSourceCellPayload(body);
	        const sourceCellId = notebookResearchString(body.sourceCellId) ?? notebookResearchSourceCellId(sourceCell);
	        const sourceCellName = notebookResearchString(body.sourceCellName) ?? notebookResearchSourceCellName(sourceCell);
	        const sourceCellFingerprint = notebookResearchString(body.sourceCellFingerprint) ?? notebookResearchSourceCellFingerprint(sourceCell);
	        if (!notebookPath || !question) {
	          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
	          res.end(serializeJSON({ error: 'notebookPath and question are required.' }));
          return;
        }
        const created = storage.createRun({
          notebookPath,
          domain: notebookResearchString(body.domain),
          owner: notebookResearchString(body.owner),
          sourceCell,
	          sourceCellId,
	          sourceCellName,
	          sourceCellFingerprint,
	          title: notebookResearchString(body.title),
	          question,
          intent: notebookResearchIntent(body.intent),
          context: body.context,
          generatedSql: notebookResearchString(body.generatedSql),
          reviewedSql: notebookResearchString(body.reviewedSql),
        });
        const run = body.run === true
          ? await runNotebookResearch(storage, created, {
              domain: notebookResearchString(body.domain),
	              sourceCellFingerprint,
	              question,
              intent: notebookResearchIntent(body.intent),
              context: body.context,
              generatedSql: notebookResearchString(body.generatedSql),
              reviewedSql: notebookResearchString(body.reviewedSql),
            })
          : created;
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ run: withNotebookResearchChecklist(run) }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        storage.close();
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/notebook/research/context-preview') {
      try {
        const body = await readJSON(req);
        const notebookPath = notebookResearchString(body.notebookPath) ?? notebookResearchString(body.path);
        const question = notebookResearchString(body.question);
        if (!notebookPath || !question) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'notebookPath and question are required.' }));
          return;
        }
	        const intent = notebookResearchIntent(body.intent) ?? 'ad_hoc_analysis';
	        const domain = notebookResearchString(body.domain);
	        const context = body.context;
	        const sourceCell = notebookResearchSourceCellPayload(body);
	        const contextPack = await buildLocalContextPack(projectRoot, {
          question,
          mode: 'question',
          surface: 'notebook',
          selectedContext: {
	            activeSurface: 'notebook',
	            notebookPath,
	            domain,
	            sourceCellId: notebookResearchString(body.sourceCellId) ?? notebookResearchSourceCellId(sourceCell),
	            sourceCellName: notebookResearchString(body.sourceCellName) ?? notebookResearchSourceCellName(sourceCell),
	            context,
            intent,
            researchPattern: notebookResearchIntentPattern(intent),
          },
          strictness: 'balanced',
          limit: 100,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(notebookResearchContextPreview(contextPack)));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/notebook/research/seed-cells') {
      const storage = openNotebookResearchStorage();
      try {
        const body = await readJSON(req);
        const notebookPath = notebookResearchString(body.notebookPath) ?? notebookResearchString(body.path);
        if (!notebookPath) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'notebookPath is required.' }));
          return;
        }
        const cells: unknown[] = Array.isArray(body.cells) ? body.cells : [];
        if (cells.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'At least one source cell is required.' }));
          return;
        }
        const validCells = cells.filter((cell): cell is Record<string, unknown> => Boolean(cell && typeof cell === 'object' && !Array.isArray(cell)));
        const invalidCellCount = cells.length - validCells.length;
        const seeded = storage.seedRunsFromCells({
          notebookPath,
          domain: notebookResearchString(body.domain),
          owner: notebookResearchString(body.owner),
          notebookTitle: notebookResearchString(body.notebookTitle),
	          cells: validCells.map((cell) => ({
	            sourceCell: notebookResearchSourceCellPayload(cell),
	            id: notebookResearchString(cell.id),
	            sourceCellId: notebookResearchString(cell.sourceCellId),
	            name: notebookResearchString(cell.name),
	            sourceCellName: notebookResearchString(cell.sourceCellName),
	            sourceCellFingerprint: notebookResearchString(cell.sourceCellFingerprint),
	            title: notebookResearchString(cell.title),
	            type: notebookResearchString(cell.type),
	            sql: notebookResearchString(cell.sql),
	            content: notebookResearchString(cell.content),
	            source: notebookResearchString(cell.source),
	            question: notebookResearchString(cell.question),
	            intent: notebookResearchIntent(cell.intent),
	          })),
          limit: 1000,
        });
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          created: seeded.created.map(withNotebookResearchChecklist),
          createdCount: seeded.createdCount,
          skippedCount: seeded.skippedCount + invalidCellCount,
          limitApplied: seeded.limitApplied,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        storage.close();
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/notebook/research/source-coverage') {
      const storage = openNotebookResearchStorage();
      try {
        const body = await readJSON(req);
        const notebookPath = notebookResearchString(body.notebookPath) ?? notebookResearchString(body.path);
        if (!notebookPath) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'notebookPath is required.' }));
          return;
        }
	        const rawSourceCells = Array.isArray(body.sourceCells)
	          ? body.sourceCells
	          : Array.isArray(body.cells)
	            ? body.cells
	            : [];
	        const sourceCells = rawSourceCells.flatMap((cell: unknown): NotebookResearchSourceCellInput[] => {
	          if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return [];
	          const record = cell as Record<string, unknown>;
	          const nested = notebookResearchSourceCellPayload(record) ?? {};
	          return [{
	            ...nested,
	            id: notebookResearchString(record.id) ?? nested.id,
	            sourceCellId: notebookResearchString(record.sourceCellId) ?? nested.sourceCellId,
	            cellId: notebookResearchString(record.cellId) ?? nested.cellId,
	            name: notebookResearchString(record.name) ?? nested.name,
	            sourceCellName: notebookResearchString(record.sourceCellName) ?? nested.sourceCellName,
	            title: notebookResearchString(record.title) ?? nested.title,
	            fingerprint: notebookResearchString(record.fingerprint) ?? nested.fingerprint,
	            sourceCellFingerprint: notebookResearchString(record.sourceCellFingerprint) ?? nested.sourceCellFingerprint,
	            sqlFingerprint: notebookResearchString(record.sqlFingerprint) ?? nested.sqlFingerprint,
	            type: notebookResearchString(record.type) ?? nested.type,
	          }];
	        });
	        const requestedIds: unknown[] = Array.isArray(body.sourceCellIds)
	          ? body.sourceCellIds
	          : rawSourceCells.length > 0
	            ? sourceCells.map((cell: NotebookResearchSourceCellInput) => notebookResearchSourceCellId(cell))
	            : [];
	        const sourceCellIds: string[] = Array.from(new Set(
	          requestedIds
	            .map((id: unknown) => notebookResearchString(id))
	            .filter((id: string | undefined): id is string => Boolean(id)),
	        ));
	        const requestedSourceCellCount = new Set([
	          ...sourceCellIds,
	          ...sourceCells
	            .map((cell: NotebookResearchSourceCellInput) => notebookResearchSourceCellId(cell))
	            .filter((id: string | undefined): id is string => Boolean(id)),
	        ]).size;
        const limit = typeof body.limit === 'number' && Number.isFinite(body.limit)
          ? Math.max(1, Math.min(10_000, Math.floor(body.limit)))
          : 10_000;
	        const linkedRuns = storage.listLatestRunsBySourceCell({
	          notebookPath,
	          sourceCellIds,
	          sourceCells,
	          limit,
	        });
	        const missingRuns = storage.listLatestRunsForMissingSourceCells({
	          notebookPath,
	          sourceCellIds,
	          sourceCells,
	          limit,
	        });
        const runs = [...linkedRuns, ...missingRuns];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          runs: runs.map(withNotebookResearchChecklist),
	          requestedCount: requestedSourceCellCount,
	          matchedCount: runs.length,
	          limitApplied: requestedSourceCellCount > limit,
	        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        storage.close();
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/notebook/research/diagnostics') {
      const storage = openNotebookResearchStorage();
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(storage.getDiagnostics()));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        storage.close();
      }
      return;
    }

    const notebookResearchMatch = /^\/api\/notebook\/research\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (notebookResearchMatch) {
      const id = decodeURIComponent(notebookResearchMatch[1]);
      const action = notebookResearchMatch[2];
      const storage = openNotebookResearchStorage();
      try {
        const run = storage.getRun(id);
        if (!run) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Notebook research run not found.' }));
          return;
        }

        if (req.method === 'GET' && !action) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ run: withNotebookResearchChecklist(run) }));
          return;
        }

	        if (req.method === 'PATCH' && !action) {
	          const body = await readJSON(req);
	          const sourceCell = notebookResearchSourceCellPayload(body);
	          const sourceCellIdPatch = notebookResearchPatchString(body, 'sourceCellId');
	          const sourceCellNamePatch = notebookResearchPatchString(body, 'sourceCellName');
	          const sourceCellFingerprintPatch = notebookResearchPatchString(body, 'sourceCellFingerprint');
          const updated = storage.updateRun(id, {
            domain: notebookResearchString(body.domain),
            owner: notebookResearchString(body.owner),
            sourceCellId: sourceCellIdPatch !== undefined ? sourceCellIdPatch : notebookResearchSourceCellId(sourceCell),
	            sourceCellName: sourceCellNamePatch !== undefined ? sourceCellNamePatch : notebookResearchSourceCellName(sourceCell),
	            sourceCellFingerprint: sourceCellFingerprintPatch !== undefined ? sourceCellFingerprintPatch : notebookResearchSourceCellFingerprint(sourceCell),
            title: notebookResearchString(body.title),
            question: notebookResearchString(body.question),
            intent: notebookResearchIntent(body.intent),
            context: body.context,
            recommendation: notebookResearchString(body.recommendation),
            evidence: body.evidence,
            contextPackId: notebookResearchString(body.contextPackId),
            routeDecision: body.routeDecision,
            generatedSql: notebookResearchString(body.generatedSql),
            reviewedSql: notebookResearchString(body.reviewedSql),
            warnings: Array.isArray(body.warnings) ? body.warnings.filter((item: unknown): item is string => typeof item === 'string') : undefined,
            reviewStatus: notebookResearchReviewStatus(body.reviewStatus),
          }) ?? run;
          const planned = storage.updateRun(updated.id, {
            researchPlan: buildNotebookResearchPlan({
              run: updated,
              evidence: updated.evidence,
              resultPreview: updated.resultPreview as ReturnType<typeof normalizeQueryResult> | undefined,
              previewError: updated.error,
              generatedSql: updated.generatedSql,
              reviewedSql: updated.reviewedSql,
              routeDecision: updated.routeDecision,
            }),
          }) ?? updated;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ run: withNotebookResearchChecklist(planned) }));
          return;
        }

	        if (req.method === 'POST' && action === 'run') {
	          const body = await readJSON(req).catch(() => ({}));
	          const sourceCell = notebookResearchSourceCellPayload(body);
          const updated = await runNotebookResearch(storage, run, {
            domain: notebookResearchString(body.domain),
            owner: notebookResearchString(body.owner),
            sourceCellFingerprint: notebookResearchString(body.sourceCellFingerprint) ?? notebookResearchSourceCellFingerprint(sourceCell),
            question: notebookResearchString(body.question),
            intent: notebookResearchIntent(body.intent),
            context: body.context,
            generatedSql: notebookResearchString(body.generatedSql),
            reviewedSql: notebookResearchString(body.reviewedSql),
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ run: withNotebookResearchChecklist(updated) }));
          return;
        }

        if (req.method === 'POST' && action === 'reuse-check') {
          const body = await readJSON(req).catch(() => ({}));
          const payload = await checkNotebookResearchReuse(storage, run, {
            domain: notebookResearchString(body.domain),
            owner: notebookResearchString(body.owner),
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ ...payload, run: withNotebookResearchChecklist(payload.run) }));
          return;
        }

        if (req.method === 'POST' && action === 'promote-dql') {
          const body = await readJSON(req).catch(() => ({}));
          const payload = await promoteNotebookResearchToDql(storage, run, {
            domain: notebookResearchString(body.domain),
            owner: notebookResearchString(body.owner),
            provider: notebookResearchString(body.provider),
            tags: Array.isArray(body.tags) ? body.tags.filter((item: unknown): item is string => typeof item === 'string') : undefined,
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ ...payload, run: withNotebookResearchChecklist(payload.run) }));
          return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'Unsupported notebook research operation.' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        storage.close();
      }
      return;
    }

    // ── run snapshots (v0.11) ───────────────────────────────────────────────
    // Captures executed notebook state (query results + timings) in a
    // sibling `.run.json` so notebooks can show last-run output without
    // re-executing after a reload. Snapshots are git-ignored by default.
    if (req.method === 'GET' && path === '/api/run-snapshot') {
      const notebookPath = url.searchParams.get('path') ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(readRunSnapshot(projectRoot, notebookPath)));
      return;
    }
    if (req.method === 'PUT' && path === '/api/run-snapshot') {
      try {
        const body = await readJSON(req) as { path: string; snapshot: unknown };
        if (!body.path || typeof body.path !== 'string' || !body.snapshot) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing path or snapshot' }));
          return;
        }
        writeRunSnapshot(projectRoot, body.path, body.snapshot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // ── git read-only API (v0.11) ───────────────────────────────────────────
    // GET /api/git/status  — branch, clean, changed files
    // GET /api/git/log     — last N commits (?limit=20)
    // GET /api/git/diff    — unified diff for a single file (?path=relative/path)
    if (req.method === 'GET' && path === '/api/git/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(await readGitStatus(projectRoot)));
      return;
    }
    if (req.method === 'GET' && path === '/api/git/log') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 200);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(await readGitLog(projectRoot, limit)));
      return;
    }
    if (req.method === 'GET' && path === '/api/git/diff') {
      const filePath = url.searchParams.get('path') ?? '';
      const staged = url.searchParams.get('staged') === 'true';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(await readGitDiff(projectRoot, filePath, staged)));
      return;
    }
    if (req.method === 'GET' && path === '/api/git/branches') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(await readGitBranches(projectRoot)));
      return;
    }
    if (req.method === 'GET' && path === '/api/git/remote') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(await readGitRemote(projectRoot)));
      return;
    }
    if (req.method === 'POST' && path === '/api/git/stage') {
      try {
        const body = (await readJSON(req)) as { paths?: string[] };
        const result = await gitStage(projectRoot, body.paths ?? []);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/git/unstage') {
      try {
        const body = (await readJSON(req)) as { paths?: string[] };
        const result = await gitUnstage(projectRoot, body.paths ?? []);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/git/discard') {
      try {
        const body = (await readJSON(req)) as { paths?: string[] };
        const result = await gitDiscard(projectRoot, body.paths ?? []);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/git/commit') {
      try {
        const body = (await readJSON(req)) as { message?: string; stageAll?: boolean };
        const result = await gitCommit(projectRoot, body.message ?? '', body.stageAll === true);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/git/push') {
      try {
        const result = await gitPush(projectRoot);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/git/pull') {
      try {
        const result = await gitPull(projectRoot);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/git/branch') {
      try {
        const body = (await readJSON(req)) as { name?: string; checkout?: boolean };
        const result = await gitCreateBranch(projectRoot, body.name ?? '', body.checkout !== false);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/git/checkout') {
      try {
        const body = (await readJSON(req)) as { name?: string };
        const result = await gitCheckout(projectRoot, body.name ?? '');
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/schema') {
      try {
        const dataFiles = scanDataFiles(projectRoot);
        const { tables, columnsByPath } = connection
          ? await introspectSchema(executor, connection)
          : { tables: [], columnsByPath: new Map<string, Array<{ name: string; type: string }>>() };
        const dbTables = tables.map((t) => ({
          name: t.path,
          path: t.path,
          columns: columnsByPath.get(t.path) ?? [],
          source: 'database',
          objectType: t.type,
        }));
        const seen = new Set(dataFiles.map((f) => f.name));
        const merged = [
          ...dataFiles.map((f) => ({ ...f, source: 'file' })),
          ...dbTables.filter((t) => !seen.has(t.name)),
        ];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(merged));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[dql] /api/schema introspection failed: ${message}`);
        const fallback = scanDataFiles(projectRoot).map((f) => ({ ...f, source: 'file' }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(fallback));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/blocks') {
      try {
        const body = await readJSON(req);
        const {
          name,
          domain,
          content,
          description,
          tags,
          metricRefs,
          template,
          blockType,
        } = body as {
          name: string;
          domain?: string;
          content?: string;
          description?: string;
          tags?: string[];
          metricRefs?: string[];
          template?: string;
          blockType?: 'custom' | 'semantic';
        };
        if (!name || typeof name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing block name' }));
          return;
        }
        const created = createBlockArtifacts(projectRoot, {
          name,
          domain,
          content,
          description,
          tags,
          metricRefs,
          template,
          blockType,
        });
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(created));
      } catch (error) {
        if (error instanceof Error && error.message === 'BLOCK_EXISTS') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block already exists' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/blocks/save-from-cell') {
      try {
        const body = await readJSON(req);
        const {
          name,
          domain,
          owner,
          content,
          description,
          tags,
          metricRefs,
          template,
          llmContext,
          examples,
          invariants,
        } = body as {
          name: string;
          domain?: string;
          owner?: string;
          content: string;
          description?: string;
          tags?: string[];
          metricRefs?: string[];
          template?: string;
          llmContext?: string;
          examples?: Array<{ question: string; sql?: string }>;
          invariants?: string[];
        };
        if (!name || typeof name !== 'string' || !content || typeof content !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'name and content are required' }));
          return;
        }
        const missing: string[] = [];
        if (!owner || !owner.trim()) missing.push('owner');
        if (!domain || !domain.trim()) missing.push('domain');
        if (!description || !description.trim()) missing.push('description');
        if (missing.length > 0) {
          res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({
            error: `Block is missing required governance fields: ${missing.join(', ')}`,
            missing,
          }));
          return;
        }
        const created = createBlockArtifacts(projectRoot, {
          name,
          domain,
          owner,
          content,
          description,
          tags,
          metricRefs,
          template,
          llmContext,
          examples,
          invariants,
          gitMetadata: readGitMetadata(projectRoot),
        });
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(created));
      } catch (error) {
        if (error instanceof Error && error.message === 'BLOCK_EXISTS') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block already exists' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/blocks/templates') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ templates: listBlockTemplates() }));
      return;
    }

    // ── Block library (list all blocks with metadata) ────────────────────
    if (req.method === 'GET' && path === '/api/blocks/library') {
      try {
        const blocks: Array<{
          name: string; domain: string; status: string;
          owner: string | null; tags: string[]; path: string;
          lastModified: string; description: string;
          llmContext: string | null;
        }> = [];
        const seen = new Set<string>();
        const scanDir = (dir: string) => {
          if (!existsSync(dir)) return;
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const filePath = join(dir, entry.name);
            if (entry.isDirectory()) {
              scanDir(filePath);
            } else if (entry.name.endsWith('.dql') && !seen.has(filePath)) {
              seen.add(filePath);
              const relPath = relative(projectRoot, filePath).replaceAll('\\', '/');
              try {
                const source = readFileSync(filePath, 'utf-8');
                const stat = statSync(filePath);
                // Quick regex parse for key block fields
                const nameMatch = /block\s+"([^"]+)"/.exec(source);
                const domainMatch = /domain\s*=\s*"([^"]+)"/.exec(source);
                const statusMatch = /status\s*=\s*"([^"]+)"/.exec(source);
                const ownerMatch = /owner\s*=\s*"([^"]+)"/.exec(source);
                const descMatch = /description\s*=\s*"([^"]+)"/.exec(source);
                const tagsMatch = /tags\s*=\s*\[([^\]]*)\]/.exec(source);
                const parsedTags = tagsMatch
                  ? tagsMatch[1].split(',').map((tag) => tag.trim().replace(/^"|"$/g, '')).filter(Boolean)
                  : [];
                const llmMatch = /llmContext\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(source);
                blocks.push({
                  name: nameMatch?.[1] ?? entry.name.replace('.dql', ''),
                  domain: (domainMatch?.[1] ?? inferBlockStudioPathDomain(relPath)) || 'uncategorized',
                  status: statusMatch?.[1] ?? 'draft',
                  owner: ownerMatch?.[1] ?? null,
                  tags: parsedTags,
                  path: relPath,
                  lastModified: stat.mtime.toISOString(),
                  description: descMatch?.[1] ?? '',
                  llmContext: llmMatch?.[1] ?? null,
                });
              } catch { /* skip unreadable files */ }
            }
          }
        };
        scanDir(join(projectRoot, 'blocks'));
        scanDir(join(projectRoot, 'domains'));
        blocks.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ blocks }));
      } catch (error) {
        if (error instanceof DQLAccessDeniedError) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: error.message, code: 'unauthorized' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // ── Apps (App artifact listing for notebook AppsPanel) ────────────────
    if (req.method === 'GET' && path === '/api/apps') {
      try {
        const appsRoot = join(projectRoot, 'apps');
        type AppManifest = {
          name: string;
          domain: string;
          owner?: string;
          description?: string;
          cadence?: string;
          consumers?: string[];
          entryPoints?: string[];
        };
        type DiscoveredApp = {
          path: string;
          manifest: AppManifest;
          notebooks: string[];
          dashboards: string[];
          hasDigest: boolean;
        };
        const apps: DiscoveredApp[] = [];
        const listFilesByExt = (dir: string, ext: string): string[] => {
          const out: string[] = [];
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                out.push(...listFilesByExt(full, ext).map((n) => `${entry.name}/${n}`));
              } else if (entry.isFile() && entry.name.endsWith(ext)) {
                out.push(entry.name);
              }
            }
          } catch { /* dir missing; return [] */ }
          return out;
        };
        if (existsSync(appsRoot)) {
          for (const entry of readdirSync(appsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.endsWith('.dql-app')) continue;
            const appDir = join(appsRoot, entry.name);
            try {
              const raw = readFileSync(join(appDir, 'app.yml'), 'utf-8');
              const manifest = loadYaml(raw) as AppManifest | null;
              if (!manifest || !manifest.name || !manifest.domain) continue;
              apps.push({
                path: relative(projectRoot, appDir),
                manifest,
                notebooks: listFilesByExt(join(appDir, 'notebooks'), '.dqlnb'),
                dashboards: listFilesByExt(join(appDir, 'dashboards'), '.dql'),
                hasDigest: existsSync(join(appDir, 'digest.dql')),
              });
            } catch { /* skip unreadable apps */ }
          }
        }
        apps.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ apps }));
      } catch (error) {
        const status = error instanceof DQLAccessDeniedError ? 403 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          error: error instanceof Error ? error.message : String(error),
          ...(status === 403 ? { code: 'unauthorized' } : {}),
        }));
      }
      return;
    }

    // ── Block status update ──────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/blocks/status') {
      try {
        const body = await readJSON(req);
        const blockPath = body.path as string;
        const newStatus = body.newStatus as string;
        const validStatuses = ['draft', 'review', 'certified', 'deprecated'];
        if (!validStatuses.includes(newStatus)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Status must be one of: ${validStatuses.join(', ')}` }));
          return;
        }
        if (newStatus === 'certified') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Use /api/block-studio/certify so validation, run, and tests gate certification.' }));
          return;
        }
        setBlockStudioStatus(projectRoot, blockPath, newStatus);
        await refreshLocalMetadataCatalog(projectRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, status: newStatus }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // ── Block version history (git log) ──────────────────────────────────
    if (req.method === 'GET' && path === '/api/blocks/history') {
      try {
        const blockPath = url.searchParams.get('path');
        if (!blockPath) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'path parameter is required' }));
          return;
        }
        const { execSync } = await import('node:child_process');
        const gitLog = execSync(
          `git log --format="%H|||%ai|||%an|||%s" -20 -- "${blockPath}"`,
          { cwd: projectRoot, encoding: 'utf-8', timeout: 10000 },
        ).trim();
        const entries = gitLog
          ? gitLog.split('\n').map((line) => {
              const [hash, date, author, message] = line.split('|||');
              return { hash, date, author, message };
            })
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ entries }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ entries: [] }));
      }
      return;
    }

    // ── Block body (re-read from disk, used by bound-cell refresh) ──────
    if (req.method === 'GET' && path === '/api/blocks/body') {
      try {
        const blockPath = url.searchParams.get('path');
        if (!blockPath) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'path parameter is required' }));
          return;
        }
        const absolutePath = resolve(projectRoot, blockPath);
        if (!absolutePath.startsWith(projectRoot + '/') && absolutePath !== projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'path escapes project root' }));
          return;
        }
        if (!existsSync(absolutePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'block not found' }));
          return;
        }
        const body = readFileSync(absolutePath, 'utf-8');
        let commitSha: string | null = null;
        try {
          const { execSync } = await import('node:child_process');
          const sha = execSync(`git log -1 --format=%H -- "${blockPath}"`, {
            cwd: projectRoot,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
          }).trim();
          commitSha = sha.length > 0 ? sha : null;
        } catch {
          commitSha = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ path: blockPath, body, commitSha }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: message }));
      }
      return;
    }

    // ── Run block tests ────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/blocks/run-tests') {
      try {
        const body = await readJSON(req);
        const source = body.source as string;
        if (!source) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'source is required' }));
          return;
        }
        const summary = await runBlockStudioTestSummary(source);
        const results = summary.assertions.map((assertion) => ({
          name: assertion.name,
          field: assertion.name.match(/^assert\s+(\S+)/)?.[1] ?? assertion.name,
          operator: assertion.name.match(/^assert\s+\S+\s+(\S+)/)?.[1] ?? '',
          expected: assertion.expected !== undefined ? String(assertion.expected) : assertion.name.replace(/^assert\s+\S+\s+\S+\s*/, ''),
          passed: assertion.passed,
          actual: assertion.error ?? (assertion.actual !== undefined ? String(assertion.actual) : undefined),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ assertions: results, passed: summary.passed, failed: summary.failed, duration: summary.duration }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/block-studio/certify') {
      try {
        const body = await readJSON(req);
        const source = typeof body.source === 'string' ? body.source : '';
        const blockPath = typeof body.path === 'string' ? body.path : null;
        if (!source.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'source is required' }));
          return;
        }
        const result = await certifyBlockStudioSource(source, blockPath, { enterprise: body.enterprise !== false });
        const blockers = Array.from(new Set(result.checklist.blockers));
        if (!result.certification.certified || blockers.length > 0) {
          res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ ok: false, ...result, blockers }));
          return;
        }
        let certifiedPayload: ReturnType<typeof openBlockStudioDocument> | null = null;
        const certifiedSource = setBlockStudioStatusInSource(source, 'certified');
        if (blockPath) {
          const normalizedBlockPath = normalize(blockPath).replace(/^\/+/, '');
          const parsed = parseBlockSourceMetadata(certifiedSource);
          if (isDraftBlockPath(normalizedBlockPath)) {
            const savedPath = saveBlockStudioArtifacts(projectRoot, {
              currentPath: normalizedBlockPath,
              source: certifiedSource,
              name: parsed.name,
              domain: parsed.domain,
              description: parsed.description,
              owner: parsed.owner,
              tags: parsed.tags,
            });
            certifiedPayload = openBlockStudioDocument(projectRoot, savedPath, semanticLayer);
          } else {
            setBlockStudioStatus(projectRoot, normalizedBlockPath, 'certified');
            certifiedPayload = openBlockStudioDocument(projectRoot, normalizedBlockPath, semanticLayer);
          }
        }
        await refreshLocalMetadataCatalog(projectRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok: true,
          status: 'certified',
          ...result,
          path: certifiedPayload?.path ?? blockPath ?? null,
          source: certifiedPayload?.source ?? certifiedSource,
          metadata: certifiedPayload?.metadata,
          companionPath: certifiedPayload?.companionPath ?? null,
          validation: certifiedPayload?.validation ?? result.validation,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/block-studio/ai-imports') {
      try {
        const body = await readJSON(req);
        const session = await createDqlGenerationSessionFromBody(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(session));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/block-studio/match-sql') {
      try {
        const body = await readJSON(req);
        if (typeof body.sql !== 'string' || body.sql.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing SQL in request body.' }));
          return;
        }
        const sql = body.sql.trim();
        const match = await matchSqlForDqlReuse({
          sql,
          sourcePath: typeof body.sourcePath === 'string' ? body.sourcePath : 'pasted.sql',
          name: typeof body.name === 'string' ? body.name : 'SQL match preview',
          domain: typeof body.domain === 'string' ? body.domain : 'imported',
          owner: typeof body.owner === 'string' ? body.owner : 'analytics',
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(match));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    const aiImportPathMatch = path.match(/^\/api\/block-studio\/ai-imports\/([^/]+)(?:\/candidates\/([^/]+)(?:\/(preview|certify))?)?$/);
    if (aiImportPathMatch) {
      const importId = decodeURIComponent(aiImportPathMatch[1]);
      const candidateId = aiImportPathMatch[2] ? decodeURIComponent(aiImportPathMatch[2]) : null;
      const action = aiImportPathMatch[3] ?? null;
      try {
        if (req.method === 'GET' && !candidateId) {
          const session = loadDqlGenerationSession(importId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON(session));
          return;
        }

        if (req.method === 'PATCH' && candidateId && !action) {
          const body = await readJSON(req);
          const candidate = updateBlockStudioImportCandidate(projectRoot, importId, candidateId, {
            name: typeof body.name === 'string' ? body.name : undefined,
            domain: typeof body.domain === 'string' ? body.domain : undefined,
            description: typeof body.description === 'string' ? body.description : undefined,
            owner: typeof body.owner === 'string' ? body.owner : undefined,
            tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
            terms: Array.isArray(body.terms) ? body.terms.map(String) : undefined,
            pattern: typeof body.pattern === 'string' ? body.pattern : undefined,
            grain: typeof body.grain === 'string' ? body.grain : undefined,
            entities: Array.isArray(body.entities) ? body.entities.map(String) : undefined,
            outputs: Array.isArray(body.outputs) ? body.outputs.map(String) : undefined,
            dimensions: Array.isArray(body.dimensions) ? body.dimensions.map(String) : undefined,
            allowedFilters: Array.isArray(body.allowedFilters) ? body.allowedFilters.map(String) : undefined,
            parameterPolicy: Array.isArray(body.parameterPolicy) ? body.parameterPolicy : undefined,
            filterBindings: Array.isArray(body.filterBindings) ? body.filterBindings : undefined,
            sourceSystems: Array.isArray(body.sourceSystems) ? body.sourceSystems.map(String) : undefined,
            replacementFor: Array.isArray(body.replacementFor) ? body.replacementFor.map(String) : undefined,
            reviewCadence: typeof body.reviewCadence === 'string' ? body.reviewCadence : undefined,
            sql: typeof body.sql === 'string' ? body.sql : undefined,
            llmContext: typeof body.llmContext === 'string' ? body.llmContext : undefined,
          });
          const validated = validateImportCandidate(candidate);
          const savedDraft = saveDqlGenerationDraft(importId, validated);
          writeBlockStudioImportCandidate(projectRoot, importId, savedDraft);
          await refreshLocalMetadataCatalog(projectRoot);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON(savedDraft));
          return;
        }

        if (req.method === 'POST' && candidateId && action === 'preview') {
          const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
          const preview = await runBlockStudioPreviewSource(candidate.dqlSource);
          const next = saveDqlGenerationDraft(importId, {
            ...candidate,
            preview,
            validation: validateBlockStudioSource(candidate.dqlSource, semanticLayer),
          });
          writeBlockStudioImportCandidate(projectRoot, importId, next);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON(next));
          return;
        }

        if (req.method === 'POST' && candidateId && action === 'certify') {
          const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
          const readiness = validateImportCandidateForSave(candidate);
          if (readiness.errors.length > 0) {
            const savedDraft = saveDqlGenerationDraft(importId, readiness.candidate);
            writeBlockStudioImportCandidate(projectRoot, importId, savedDraft);
            res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(serializeJSON({
              error: readiness.errors.join(' '),
              candidate: savedDraft,
              diagnostics: (savedDraft.validation as any)?.diagnostics ?? [],
            }));
            return;
          }
          const certifiedSource = setBlockStudioSourceStatus(readiness.candidate.dqlSource, 'certified');
          const certification = await certifyBlockStudioSource(certifiedSource, readiness.candidate.savedPath, { enterprise: true });
          const blockers = Array.from(new Set(certification.checklist.blockers));
          if (!certification.certification.certified || blockers.length > 0) {
            const savedDraft = saveDqlGenerationDraft(importId, readiness.candidate);
            writeBlockStudioImportCandidate(projectRoot, importId, savedDraft);
            res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(serializeJSON({ ok: false, candidate: savedDraft, blockers, ...certification }));
            return;
          }
          const savedPath = saveBlockStudioArtifacts(projectRoot, {
            currentPath: readiness.candidate.savedPath,
            source: certifiedSource,
            name: readiness.candidate.name,
            domain: readiness.candidate.domain,
            description: readiness.candidate.description,
            owner: readiness.candidate.owner,
            tags: readiness.candidate.tags,
            lineage: readiness.candidate.lineage.sourceTables,
            importMeta: {
              importId,
              candidateId,
              sourceKind: readiness.candidate.sourceKind,
              sourcePath: readiness.candidate.sourcePath,
            },
          });
          const next: DqlGenerationCandidate = {
            ...readiness.candidate,
            dqlSource: certifiedSource,
            reviewStatus: 'saved',
            savedPath,
            validation: validateBlockStudioSource(certifiedSource, semanticLayer),
            generationMode: readiness.candidate.generationMode ?? 'deterministic',
            generationProvider: readiness.candidate.generationProvider ?? 'local-deterministic',
            llmContext: readiness.candidate.llmContext ?? deterministicDqlGenerationContext(readiness.candidate, readiness.candidate.evidence ?? []),
            evidence: readiness.candidate.evidence ?? [],
            draftSave: readiness.candidate.draftSave ?? { status: 'pending' },
          };
          writeBlockStudioImportCandidate(projectRoot, importId, next);
          await refreshLocalMetadataCatalog(projectRoot);
          const payload = openBlockStudioDocument(projectRoot, savedPath, semanticLayer);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ candidate: next, block: payload, certification }));
          return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'Unsupported AI import operation.' }));
      } catch (error) {
        if (error instanceof Error && error.message === 'BLOCK_EXISTS') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block already exists' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/block-studio/imports') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ sessions: listBlockStudioImportSessions(projectRoot) }));
      return;
    }

    if (req.method === 'DELETE' && path === '/api/block-studio/imports') {
      try {
        const removed = clearBlockStudioImportSessions(projectRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, removed }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && (path === '/api/block-studio/import/preview' || path === '/api/block-studio/imports')) {
      try {
        const body = await readJSON(req);
        const inputPath = typeof body.path === 'string' ? body.path : '';
        const session = createBlockStudioImportSession(projectRoot, {
          inputPath,
          inputMode: body.inputMode === 'paste' || body.inputMode === 'upload' || body.inputMode === 'path' ? body.inputMode : undefined,
          sources: Array.isArray(body.sources)
            ? body.sources.map((source: any, index: number) => ({
                path: typeof source?.path === 'string' ? source.path : `source-${index + 1}.sql`,
                content: typeof source?.content === 'string' ? source.content : '',
              }))
            : undefined,
          sourceKind: typeof body.sourceKind === 'string' ? body.sourceKind : 'raw-sql',
          domain: typeof body.domain === 'string' ? body.domain : undefined,
          owner: typeof body.owner === 'string' ? body.owner : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        });
        const candidates = session.candidates.map(validateImportCandidate);
        const validatedSession = { ...session, candidates };
        for (const candidate of candidates) {
          writeBlockStudioImportCandidate(projectRoot, session.id, candidate);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(validatedSession));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    const importSaveAllMatch = path.match(/^\/api\/block-studio\/imports\/([^/]+)\/save-all$/);
    if (importSaveAllMatch && req.method === 'POST') {
      const importId = decodeURIComponent(importSaveAllMatch[1]);
      try {
        const session = loadBlockStudioImportSession(projectRoot, importId);
        const saved: Array<{ candidateId: string; path: string }> = [];
        const errors: Array<{ candidateId: string; error: string }> = [];
        const nextCandidates = [...session.candidates];
        for (let i = 0; i < nextCandidates.length; i += 1) {
          const candidate = nextCandidates[i];
          if (candidate.reviewStatus === 'saved' || candidate.reviewStatus === 'rejected') continue;
          const readiness = validateImportCandidateForSave(candidate);
          nextCandidates[i] = readiness.candidate;
          writeBlockStudioImportCandidate(projectRoot, importId, readiness.candidate);
          if (readiness.errors.length > 0) {
            errors.push({ candidateId: candidate.id, error: readiness.errors.join(' ') });
            continue;
          }
          try {
            const savedPath = saveBlockStudioArtifacts(projectRoot, {
              source: readiness.candidate.dqlSource,
              name: readiness.candidate.name,
              domain: readiness.candidate.domain,
              description: readiness.candidate.description,
              owner: readiness.candidate.owner,
              tags: readiness.candidate.tags,
              lineage: readiness.candidate.lineage.sourceTables,
              importMeta: {
                importId,
                candidateId: readiness.candidate.id,
                sourceKind: readiness.candidate.sourceKind,
                sourcePath: readiness.candidate.sourcePath,
              },
            });
            nextCandidates[i] = { ...readiness.candidate, reviewStatus: 'saved', savedPath };
            writeBlockStudioImportCandidate(projectRoot, importId, nextCandidates[i]);
            saved.push({ candidateId: candidate.id, path: savedPath });
          } catch (error) {
            errors.push({ candidateId: candidate.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        const nextSession = { ...session, candidates: nextCandidates, updatedAt: new Date().toISOString() };
        writeBlockStudioImportSession(projectRoot, nextSession);
        if (saved.length > 0) await refreshLocalMetadataCatalog(projectRoot);
        res.writeHead(errors.length > 0 ? 207 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: errors.length === 0, session: nextSession, saved, errors }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    const importPathMatch = path.match(/^\/api\/block-studio\/imports\/([^/]+)(?:\/candidates\/([^/]+)(?:\/(run|save|ai-assist))?)?$/);
    if (importPathMatch) {
      const importId = decodeURIComponent(importPathMatch[1]);
      const candidateId = importPathMatch[2] ? decodeURIComponent(importPathMatch[2]) : null;
      const action = importPathMatch[3] ?? null;
      try {
        if (req.method === 'DELETE' && !candidateId) {
          deleteBlockStudioImportSession(projectRoot, importId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ ok: true }));
          return;
        }

        if (req.method === 'GET' && !candidateId) {
          const session = loadBlockStudioImportSession(projectRoot, importId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON(session));
          return;
        }

        if (req.method === 'PATCH' && candidateId && !action) {
          const body = await readJSON(req);
          const reviewStatus = typeof body.reviewStatus === 'string' && ['draft', 'review', 'saved', 'rejected'].includes(body.reviewStatus)
            ? body.reviewStatus as BlockStudioImportCandidate['reviewStatus']
            : undefined;
          const candidate = updateBlockStudioImportCandidate(projectRoot, importId, candidateId, {
            name: typeof body.name === 'string' ? body.name : undefined,
            domain: typeof body.domain === 'string' ? body.domain : undefined,
            description: typeof body.description === 'string' ? body.description : undefined,
            owner: typeof body.owner === 'string' ? body.owner : undefined,
            tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
            terms: Array.isArray(body.terms) ? body.terms.map(String) : undefined,
            reviewCadence: typeof body.reviewCadence === 'string' ? body.reviewCadence : undefined,
            sql: typeof body.sql === 'string' ? body.sql : undefined,
            reviewStatus,
          });
          const validated = validateImportCandidate(candidate);
          writeBlockStudioImportCandidate(projectRoot, importId, validated);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON(validated));
          return;
        }

        if (req.method === 'POST' && candidateId && action === 'run') {
          const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
          const preview = await runBlockStudioPreviewSource(candidate.dqlSource);
          const next = { ...candidate, preview, validation: validateBlockStudioSource(candidate.dqlSource, semanticLayer) };
          writeBlockStudioImportCandidate(projectRoot, importId, next);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON(next));
          return;
        }

        if (req.method === 'POST' && candidateId && action === 'ai-assist') {
          const body = await readJSON(req).catch(() => ({}));
          const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
          const actionName = typeof body.action === 'string' ? body.action : 'explain';
          const validation = validateBlockStudioSource(candidate.dqlSource, semanticLayer);
          const assist = await buildBlockStudioAiAssistSummary(
            projectRoot,
            actionName,
            candidate,
            validation,
            isProviderSettingsId(body.provider) ? body.provider : undefined,
          );
          const next: BlockStudioImportCandidate = {
            ...candidate,
            validation,
            aiAssistance: [
              ...(candidate.aiAssistance ?? []),
              {
                action: actionName,
                summary: assist.summary,
                createdAt: new Date().toISOString(),
                status: 'suggested',
                provider: assist.provider,
              },
            ],
          };
          writeBlockStudioImportCandidate(projectRoot, importId, next);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON(next));
          return;
        }

        if (req.method === 'POST' && candidateId && action === 'save') {
          const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
          if (candidate.reviewStatus === 'saved' && candidate.savedPath) {
            const payload = openBlockStudioDocument(projectRoot, candidate.savedPath, semanticLayer);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(serializeJSON({ candidate, block: payload }));
            return;
          }
          const readiness = validateImportCandidateForSave(candidate);
          if (readiness.errors.length > 0) {
            writeBlockStudioImportCandidate(projectRoot, importId, readiness.candidate);
            res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(serializeJSON({
              error: readiness.errors.join(' '),
              candidate: readiness.candidate,
              diagnostics: (readiness.candidate.validation as any)?.diagnostics ?? [],
            }));
            return;
          }
          const savedPath = saveBlockStudioArtifacts(projectRoot, {
            source: readiness.candidate.dqlSource,
            name: readiness.candidate.name,
            domain: readiness.candidate.domain,
            description: readiness.candidate.description,
            owner: readiness.candidate.owner,
            tags: readiness.candidate.tags,
            lineage: readiness.candidate.lineage.sourceTables,
            importMeta: {
              importId,
              candidateId,
              sourceKind: readiness.candidate.sourceKind,
              sourcePath: readiness.candidate.sourcePath,
            },
          });
          const next = { ...readiness.candidate, reviewStatus: 'saved' as const, savedPath };
          writeBlockStudioImportCandidate(projectRoot, importId, next);
          await refreshLocalMetadataCatalog(projectRoot);
          const payload = openBlockStudioDocument(projectRoot, savedPath, semanticLayer);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ candidate: next, block: payload }));
          return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'Unsupported import operation.' }));
      } catch (error) {
        if (error instanceof Error && error.message === 'BLOCK_EXISTS') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block already exists' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/block-studio/catalog') {
      try {
        const cfg = loadProjectConfig(projectRoot) as any;
        const connections = getProjectConnectionsForApi(cfg);
        const defaultKey = resolveDefaultConnectionKey(cfg, connections) ?? Object.keys(connections)[0] ?? 'default';
        const userPrefs = readUserPrefs(userPrefsPath);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          semanticTree: semanticLayer ? buildSemanticTree(semanticLayer, semanticImportManifest) : null,
          databaseTree: await buildDatabaseSchemaTree(projectRoot, executor, connection),
          connection: {
            default: defaultKey,
            current: defaultKey,
            connections,
          },
          favorites: userPrefs.favorites,
          recentlyUsed: userPrefs.recentlyUsed,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/block-studio/dbt-status') {
      try {
        const status = buildDbtStatus(projectRoot, projectConfig, semanticLastSyncTime);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(status));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/semantic-layer/diagnostics') {
      try {
        const diagnostics = buildSemanticLayerDiagnostics(projectRoot, projectConfig, {
          semanticLayer,
          semanticErrors: semanticLayerErrors,
          semanticConfig,
          detectedProvider: semanticDetectedProvider,
          lastSyncTime: semanticLastSyncTime,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(diagnostics));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/semantic-layer/reload') {
      try {
        const semanticConnection = connection;
        const executeQuery = semanticConfig?.provider === 'snowflake' && semanticConnection
          ? async (sql: string) => { const r = await executor.executeQuery(sql, [], {}, semanticConnection); return { rows: r.rows }; }
          : undefined;
        const refreshed = await resolveSemanticLayerAsync(semanticConfig, projectRoot, executeQuery);
        semanticLayer = refreshed.layer;
        semanticLayerErrors = refreshed.errors;
        semanticDetectedProvider = refreshed.detectedProvider;
        semanticLastSyncTime = refreshed.layer ? new Date().toISOString() : null;
        semanticImportManifest = loadSemanticImportManifest(projectRoot);
        const diagnostics = buildSemanticLayerDiagnostics(projectRoot, projectConfig, {
          semanticLayer,
          semanticErrors: semanticLayerErrors,
          semanticConfig,
          detectedProvider: semanticDetectedProvider,
          lastSyncTime: semanticLastSyncTime,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok: Boolean(refreshed.layer),
          ...diagnostics,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/block-studio/open') {
      try {
        const relativePath = url.searchParams.get('path');
        if (!relativePath) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing block path.' }));
          return;
        }
        const payload = openBlockStudioDocument(projectRoot, relativePath, semanticLayer);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(payload));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/block-studio/validate') {
      try {
        const body = await readJSON(req);
        const source = typeof body.source === 'string' ? body.source : '';
        const validation = validateBlockStudioSource(source, semanticLayer);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(validation));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/block-studio/run') {
      try {
        const body = await readJSON(req);
        const source = typeof body.source === 'string' ? body.source : '';
        const targetConnection = isConnectionConfig(body.connection) ? body.connection : connection;
        const preview = await runBlockStudioPreviewSource(source, targetConnection);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(preview));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/block-studio/save') {
      try {
        const body = await readJSON(req);
        const source = typeof body.source === 'string' ? body.source : '';
        const metadata = body.metadata && typeof body.metadata === 'object'
          ? body.metadata as {
            name?: string;
            domain?: string;
            description?: string;
            owner?: string;
            tags?: string[];
            sourceKind?: string;
            sourcePath?: string;
            importId?: string;
            candidateId?: string;
            lineage?: string[];
          }
          : {};
        if (!source.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block source is required.' }));
          return;
        }
        if (!metadata.name || typeof metadata.name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block name is required.' }));
          return;
        }
        const currentPath = typeof body.path === 'string' ? body.path : undefined;
        const saveOptions = {
          currentPath,
          source,
          name: metadata.name,
          domain: metadata.domain,
          description: metadata.description,
          owner: metadata.owner,
          tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
          lineage: Array.isArray(metadata.lineage) ? metadata.lineage.map(String) : undefined,
          importMeta: metadata.sourceKind || metadata.sourcePath || metadata.importId || metadata.candidateId
            ? {
                importId: metadata.importId,
                candidateId: metadata.candidateId,
                sourceKind: metadata.sourceKind,
                sourcePath: metadata.sourcePath,
              }
            : undefined,
        };
        const savedPath = isDraftBlockPath(currentPath)
          ? saveBlockStudioDraftArtifacts(projectRoot, {
              ...saveOptions,
              stableSuffix: metadata.candidateId,
            })
          : saveBlockStudioArtifacts(projectRoot, saveOptions);
        await refreshLocalMetadataCatalog(projectRoot);
        const payload = openBlockStudioDocument(projectRoot, savedPath, semanticLayer);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(payload));
      } catch (error) {
        if (error instanceof Error && error.message === 'BLOCK_EXISTS') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block already exists' }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/connections') {
      const cfg = loadProjectConfig(projectRoot);
      const connections = getProjectConnectionsForApi(cfg);
      const defaultKey = resolveDefaultConnectionKey(cfg as unknown as Record<string, unknown>, connections)
        ?? Object.keys(connections)[0]
        ?? 'default';
      const dbtProfiles = discoverDbtProfileConnections(projectRoot, cfg);
      const connectorStatus = getConnectorInstallStatuses(projectRoot);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ default: defaultKey, connections, dbtProfiles, connectorStatus }));
      return;
    }

    if (req.method === 'POST' && path === '/api/connectors/install') {
      try {
        const body = await readJSON(req);
        const driver = typeof body.driver === 'string' ? body.driver : '';
        const status = installConnectorPackage(projectRoot, driver);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok: true,
          status,
          connectorStatus: getConnectorInstallStatuses(projectRoot),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok: false,
          error: message,
          connectorStatus: getConnectorInstallStatuses(projectRoot),
        }));
      }
      return;
    }

    // Save/update connections
    if (req.method === 'PUT' && path === '/api/connections') {
      try {
        const body = await readJSON(req);
        const configPath = join(projectRoot, 'dql.config.json');
        let raw: Record<string, unknown> = {};
        if (existsSync(configPath)) {
          raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        }
        if (body.connections && typeof body.connections === 'object') {
          raw.connections = body.connections;
        }
        const connections = getStoredConnections(raw);
        if (body.connections && typeof body.connections === 'object') {
          const requestedDefault = typeof body.defaultConnectionName === 'string'
            ? body.defaultConnectionName
            : typeof body.default === 'string'
              ? body.default
              : undefined;
          const defaultConnectionName = resolveDefaultConnectionKey(
            requestedDefault ? { ...raw, defaultConnectionName: requestedDefault } : raw,
            connections,
          );
          delete raw.defaultConnection;
          if (defaultConnectionName) {
            raw.defaultConnectionName = defaultConnectionName;
          } else {
            delete raw.defaultConnectionName;
          }
        }
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');

        // Hot-swap: re-read the config and re-initialize the active connection
        projectConfig = loadProjectConfig(projectRoot);
        const newDefault = projectConfig.defaultConnection;
        if (newDefault) {
          connection = normalizeProjectConnection(newDefault, projectRoot);
          // Auto-register data files if DuckDB/file driver
          if (connection.driver === 'file' || connection.driver === 'duckdb') {
            const dataDir = projectConfig.dataDir
              ? resolve(projectRoot, projectConfig.dataDir)
              : join(projectRoot, 'data');
            if (existsSync(dataDir)) {
              try {
                const files = readdirSync(dataDir, { withFileTypes: true })
                  .filter((e) => e.isFile() && /\.(csv|parquet)$/i.test(e.name));
                for (const file of files) {
                  const tableName = file.name.replace(/\.(csv|parquet)$/i, '');
                  const absPath = join(dataDir, file.name).replaceAll('\\', '/');
                  const reader = file.name.endsWith('.parquet') ? 'read_parquet' : 'read_csv_auto';
                  const ddl = `CREATE OR REPLACE VIEW "${tableName}" AS SELECT * FROM ${reader}('${absPath}')`;
                  try { await executor.executeQuery(ddl, [], {}, connection); } catch { /* non-fatal */ }
                }
              } catch { /* non-fatal */ }
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // ── Semantic layer discovery API ─────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/semantic-layer') {
      const userPrefs = readUserPrefs(userPrefsPath);
      if (!semanticLayer) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          available: false,
          provider: semanticConfig?.provider ?? semanticDetectedProvider ?? null,
          errors: semanticLayerErrors,
          metrics: [],
          measures: [],
          dimensions: [],
          timeDimensions: [],
          entities: [],
          hierarchies: [],
          semanticModels: [],
          savedQueries: [],
          domains: [],
          tags: [],
          favorites: userPrefs.favorites,
          recentlyUsed: userPrefs.recentlyUsed,
          lastSyncTime: semanticLastSyncTime,
        }));
        return;
      }
      const metrics = semanticLayer.listMetrics().map((m) => ({
        name: m.name,
        label: m.label,
        description: m.description,
        domain: m.domain,
        sql: m.sql,
        type: m.type,
        table: m.table,
        tags: m.tags ?? [],
        owner: m.owner ?? null,
        metricType: m.metricType ?? null,
        typeParams: m.typeParams ?? null,
        filter: m.filter ?? null,
        source: m.source ?? null,
      }));
      const measures = semanticLayer.listMeasures().map((m) => ({
        name: m.name,
        label: m.label,
        description: m.description,
        domain: m.domain,
        agg: m.agg,
        expr: m.expr ?? null,
        table: m.table,
        cube: m.cube ?? null,
        aggTimeDimension: m.aggTimeDimension ?? null,
        nonAdditiveDimension: m.nonAdditiveDimension ?? null,
        tags: m.tags ?? [],
        owner: m.owner ?? null,
        source: m.source ?? null,
      }));
      const dimensions = semanticLayer.listDimensions().map((d) => ({
        name: d.name,
        label: d.label,
        description: d.description,
        domain: d.domain,
        sql: d.sql,
        type: d.type,
        table: d.table,
        tags: d.tags ?? [],
        owner: d.owner ?? null,
        cube: d.cube ?? null,
        isTimeDimension: d.isTimeDimension ?? false,
        typeParams: d.typeParams ?? null,
        source: d.source ?? null,
      }));
      const timeDimensions = semanticLayer.listTimeDimensions().map((d) => ({
        name: d.name,
        label: d.label,
        description: d.description,
        domain: d.domain,
        sql: d.sql,
        type: d.type,
        table: d.table,
        cube: d.cube ?? null,
        granularities: d.granularities ?? [],
        primaryTime: d.primaryTime ?? false,
        tags: d.tags ?? [],
        owner: d.owner ?? null,
        typeParams: d.typeParams ?? null,
        source: d.source ?? null,
      }));
      const entities = semanticLayer.listEntities().map((e) => ({
        name: e.name,
        label: e.label,
        description: e.description,
        domain: e.domain,
        type: e.type,
        expr: e.expr ?? null,
        table: e.table,
        cube: e.cube ?? null,
        role: e.role ?? null,
        tags: e.tags ?? [],
        owner: e.owner ?? null,
        source: e.source ?? null,
      }));
      const hierarchies = semanticLayer.listHierarchies().map((h) => ({
        name: h.name,
        label: h.label,
        description: h.description,
        domain: h.domain,
        levels: h.levels.map((l) => ({ name: l.name, label: l.label })),
      }));
      const semanticModels = semanticLayer.listSemanticModels().map((m) => ({
        name: m.name,
        label: m.label,
        description: m.description,
        domain: m.domain,
        model: m.model ?? null,
        table: m.table,
        entities: m.entities,
        measures: m.measures,
        dimensions: m.dimensions,
        timeDimensions: m.timeDimensions,
        tags: m.tags ?? [],
        owner: m.owner ?? null,
        source: m.source ?? null,
      }));
      const savedQueries = semanticLayer.listSavedQueries().map((q) => ({
        name: q.name,
        label: q.label,
        description: q.description,
        domain: q.domain,
        metrics: q.metrics,
        dimensions: q.dimensions,
        timeDimension: q.timeDimension ?? null,
        granularity: q.granularity ?? null,
        filters: q.filters ?? null,
        tags: q.tags ?? [],
        owner: q.owner ?? null,
        source: q.source ?? null,
      }));
      const provider = semanticConfig?.provider ?? semanticDetectedProvider ?? 'dql';
      const dbtExecutionReady = provider === 'dbt'
        ? hasDbtSemanticManifest(projectRoot, semanticConfig?.projectPath)
        : false;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({
        available: true,
        provider,
        execution: provider === 'dbt'
          ? {
              engine: 'metricflow',
              ready: dbtExecutionReady,
              setup: dbtExecutionReady
                ? null
                : 'Run `dbt parse` or `dbt build` so target/semantic_manifest.json exists, and install MetricFlow so `mf` is on PATH.',
            }
          : { engine: 'native', ready: true, setup: null },
        errors: semanticLayerErrors,
        metrics,
        measures,
        dimensions,
        timeDimensions,
        entities,
        hierarchies,
        semanticModels,
        savedQueries,
        domains: semanticLayer.listDomains(),
        tags: semanticLayer.listTags(),
        favorites: userPrefs.favorites,
        recentlyUsed: userPrefs.recentlyUsed,
        lastSyncTime: semanticLastSyncTime,
      }));
      return;
    }
    if (req.method === 'GET' && path === '/api/semantic-layer/tree') {
      if (!semanticLayer) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          tree: {
            id: 'provider:dql',
            label: 'semantic layer',
            kind: 'provider',
            count: 0,
            children: [],
          },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({
        tree: buildSemanticTree(semanticLayer, semanticImportManifest),
      }));
      return;
    }
    if (req.method === 'GET' && path.startsWith('/api/semantic-layer/object/')) {
      if (!semanticLayer) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'No semantic layer configured.' }));
        return;
      }
      const id = decodeURIComponent(path.slice('/api/semantic-layer/object/'.length));
      const detail = buildSemanticObjectDetail(semanticLayer, semanticImportManifest, id);
      if (!detail) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: `Unknown semantic object: ${id}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(detail));
      return;
    }
    if (req.method === 'POST' && path === '/api/semantic-layer/import') {
      try {
        const body = await readJSON(req);
        const provider = body.provider as 'dbt' | 'cubejs' | 'snowflake';
        if (provider !== 'dbt' && provider !== 'cubejs' && provider !== 'snowflake') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'provider must be one of dbt, cubejs, snowflake' }));
          return;
        }
        const sourceConfig = provider === 'snowflake'
          ? {
              provider,
              projectPath: body.projectPath ?? projectConfig.semanticLayer?.projectPath,
              connection: body.connection ?? projectConfig.semanticLayer?.connection,
            }
          : {
              provider,
              projectPath: typeof body.projectPath === 'string' ? body.projectPath : projectConfig.semanticLayer?.projectPath,
              repoUrl: typeof body.repoUrl === 'string' ? body.repoUrl : projectConfig.semanticLayer?.repoUrl,
              branch: typeof body.branch === 'string' ? body.branch : projectConfig.semanticLayer?.branch,
              subPath: typeof body.subPath === 'string' ? body.subPath : projectConfig.semanticLayer?.subPath,
              source: body.repoUrl || projectConfig.semanticLayer?.repoUrl
                ? ((body.source ?? projectConfig.semanticLayer?.source ?? 'github') as 'local' | 'github' | 'gitlab')
                : 'local',
            };
        const executeQuery = provider === 'snowflake'
          ? async (sql: string) => {
              const result = await executor.executeQuery(sql, [], {}, requireActiveConnection());
              return { rows: result.rows };
            }
          : undefined;
        const importResult = await performSemanticImport({
          targetProjectRoot: projectRoot,
          provider,
          sourceConfig,
          executeQuery,
        });
        // Re-resolve using project's actual semantic config (not hardcoded 'dql')
        const projSemConfig = loadProjectConfig(projectRoot)?.semanticLayer ?? { provider: 'dql', path: './semantic-layer' };
        const refreshed = await resolveSemanticLayerAsync(projSemConfig, projectRoot);
        semanticLayer = refreshed.layer;
        semanticLayerErrors = refreshed.errors;
        semanticDetectedProvider = refreshed.detectedProvider ?? 'dql';
        semanticLastSyncTime = importResult.manifest.importedAt;
        semanticImportManifest = importResult.manifest;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(importResult));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = message.includes('conflict')
          ? 'A file conflict was detected. Remove or rename the conflicting file and retry.'
          : message.includes('dbt_project.yml')
            ? 'Ensure your dbt project path contains a valid dbt_project.yml file.'
            : message.includes('query executor')
              ? 'A Snowflake connection is required. Configure one in the Connection panel first.'
              : 'Check the provider path and ensure the source files are accessible.';
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: message, hint }));
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/semantic-layer/sync') {
      try {
        const executeQuery = semanticImportManifest?.provider === 'snowflake'
          ? async (sql: string) => {
              const result = await executor.executeQuery(sql, [], {}, requireActiveConnection());
              return { rows: result.rows };
            }
          : undefined;
        const importResult = await syncSemanticImport({
          targetProjectRoot: projectRoot,
          executeQuery,
        });
        // Re-resolve using project's actual semantic config (not hardcoded 'dql')
        const projSemConfig = loadProjectConfig(projectRoot)?.semanticLayer ?? { provider: 'dql', path: './semantic-layer' };
        const refreshed = await resolveSemanticLayerAsync(projSemConfig, projectRoot);
        semanticLayer = refreshed.layer;
        semanticLayerErrors = refreshed.errors;
        semanticDetectedProvider = refreshed.detectedProvider ?? 'dql';
        semanticLastSyncTime = importResult.manifest.importedAt;
        semanticImportManifest = importResult.manifest;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(importResult));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = message.includes('No semantic import manifest')
          ? 'No previous import found. Use the Setup Wizard to import a semantic layer first.'
          : 'Check the source configuration and retry.';
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: message, hint }));
      }
      return;
    }
    // ── Semantic layer import preview (dry-run) ──────────────────────────
    if (req.method === 'POST' && path === '/api/semantic-layer/import-preview') {
      try {
        const body = await readJSON(req);
        const provider = body.provider as 'dbt' | 'cubejs' | 'snowflake';
        if (provider !== 'dbt' && provider !== 'cubejs' && provider !== 'snowflake') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'provider must be one of dbt, cubejs, snowflake' }));
          return;
        }
        const sourceConfig = provider === 'snowflake'
          ? {
              provider,
              projectPath: body.projectPath ?? projectConfig.semanticLayer?.projectPath,
              connection: body.connection ?? projectConfig.semanticLayer?.connection,
            }
          : {
              provider,
              projectPath: typeof body.projectPath === 'string' ? body.projectPath : projectConfig.semanticLayer?.projectPath,
              repoUrl: typeof body.repoUrl === 'string' ? body.repoUrl : projectConfig.semanticLayer?.repoUrl,
              branch: typeof body.branch === 'string' ? body.branch : projectConfig.semanticLayer?.branch,
              subPath: typeof body.subPath === 'string' ? body.subPath : projectConfig.semanticLayer?.subPath,
              source: body.repoUrl || projectConfig.semanticLayer?.repoUrl
                ? ((body.source ?? projectConfig.semanticLayer?.source ?? 'github') as 'local' | 'github' | 'gitlab')
                : 'local',
            };
        const executeQuery = provider === 'snowflake'
          ? async (sql: string) => {
              const result = await executor.executeQuery(sql, [], {}, requireActiveConnection());
              return { rows: result.rows };
            }
          : undefined;
        const preview = await previewSemanticImport({
          targetProjectRoot: projectRoot,
          provider,
          sourceConfig,
          executeQuery,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(preview));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = message.includes('dbt_project.yml')
          ? 'Ensure your dbt project path contains a valid dbt_project.yml file.'
          : message.includes('model/') || message.includes('schema/')
            ? 'Ensure your Cube.js project has a model/ or schema/ directory.'
            : message.includes('query executor')
              ? 'A Snowflake connection is required. Configure one in the Connection panel first.'
              : 'Check the provider path and ensure the source files are accessible.';
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: message, hint }));
      }
      return;
    }

    // ── Semantic layer sync diff preview ────────────────────────────────
    if (req.method === 'POST' && path === '/api/semantic-layer/sync-preview') {
      try {
        const executeQuery = semanticImportManifest?.provider === 'snowflake'
          ? async (sql: string) => {
              const result = await executor.executeQuery(sql, [], {}, requireActiveConnection());
              return { rows: result.rows };
            }
          : undefined;
        const diff = await computeSyncDiff({
          targetProjectRoot: projectRoot,
          executeQuery,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(diff));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/semantic-layer/search') {
      if (!semanticLayer) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ metrics: [], measures: [], dimensions: [], timeDimensions: [], entities: [], hierarchies: [], semanticModels: [], savedQueries: [] }));
        return;
      }
      const q = url.searchParams.get('q') ?? '';
      const domain = url.searchParams.get('domain') ?? '';
      const tag = url.searchParams.get('tag') ?? '';
      const type = url.searchParams.get('type') ?? '';
      const results = semanticLayer.searchAdvanced(q, {
        domains: domain ? [domain] : undefined,
        tags: tag ? [tag] : undefined,
        types: ['metric', 'measure', 'dimension', 'hierarchy', 'entity', 'semantic_model', 'saved_query'].includes(type) ? [type as any] : undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({
        metrics: results.metrics.map((m) => ({
          name: m.name,
          label: m.label,
          description: m.description,
          domain: m.domain,
          sql: m.sql,
          type: m.type,
          table: m.table,
          tags: m.tags ?? [],
          owner: m.owner ?? null,
        })),
        measures: results.measures.map((m) => ({
          name: m.name,
          label: m.label,
          description: m.description,
          domain: m.domain,
          agg: m.agg,
          expr: m.expr,
          table: m.table,
          cube: m.cube,
          tags: m.tags ?? [],
          owner: m.owner ?? null,
        })),
        dimensions: results.dimensions.map((d) => ({
          name: d.name,
          label: d.label,
          description: d.description,
          domain: d.domain,
          sql: d.sql,
          type: d.type,
          table: d.table,
          tags: d.tags ?? [],
          owner: d.owner ?? null,
        })),
        timeDimensions: semanticLayer.listTimeDimensions().filter((d) => results.dimensions.some((dim) => dim.name === d.name)).map((d) => ({
          name: d.name,
          label: d.label,
          description: d.description,
          domain: d.domain,
          sql: d.sql,
          type: d.type,
          table: d.table,
          tags: d.tags ?? [],
          owner: d.owner ?? null,
        })),
        entities: results.entities.map((e) => ({
          name: e.name,
          label: e.label,
          description: e.description,
          domain: e.domain,
          type: e.type,
          table: e.table,
          tags: e.tags ?? [],
          owner: e.owner ?? null,
        })),
        hierarchies: results.hierarchies.map((h) => ({
          name: h.name,
          label: h.label,
          description: h.description,
          domain: h.domain,
          levels: h.levels.map((l) => ({ name: l.name, label: l.label })),
        })),
        semanticModels: results.semanticModels.map((m) => ({
          name: m.name,
          label: m.label,
          description: m.description,
          domain: m.domain,
          table: m.table,
          measures: m.measures,
          dimensions: m.dimensions,
          timeDimensions: m.timeDimensions,
        })),
        savedQueries: results.savedQueries.map((q) => ({
          name: q.name,
          label: q.label,
          description: q.description,
          domain: q.domain,
          metrics: q.metrics,
          dimensions: q.dimensions,
        })),
      }));
      return;
    }
    if (req.method === 'GET' && path === '/api/semantic-layer/compatible-dims') {
      if (!semanticLayer) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ dimensions: [] }));
        return;
      }
      const metrics = (url.searchParams.get('metrics') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const dimensions = semanticLayer.listCompatibleDimensions(metrics).map((d) => ({
        name: d.name,
        label: d.label,
        description: d.description,
        domain: d.domain,
        sql: d.sql,
        type: d.type,
        table: d.table,
        tags: d.tags ?? [],
        owner: d.owner ?? null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ dimensions }));
      return;
    }
    if (req.method === 'GET' && path === '/api/user-prefs/favorites') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ favorites: readUserPrefs(userPrefsPath).favorites }));
      return;
    }
    if (req.method === 'POST' && path === '/api/user-prefs/favorites') {
      try {
        const body = await readJSON(req);
        const prefs = readUserPrefs(userPrefsPath);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name) {
          prefs.favorites = prefs.favorites.includes(name)
            ? prefs.favorites.filter((item) => item !== name)
            : [...prefs.favorites, name].sort((a, b) => a.localeCompare(b));
          writeUserPrefs(userPrefsPath, prefs);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ favorites: prefs.favorites }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (req.method === 'GET' && path === '/api/user-prefs/recent') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ recentlyUsed: readUserPrefs(userPrefsPath).recentlyUsed }));
      return;
    }
    if (req.method === 'POST' && path === '/api/user-prefs/recent') {
      try {
        const body = await readJSON(req);
        const prefs = readUserPrefs(userPrefsPath);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name) {
          prefs.recentlyUsed = [name, ...prefs.recentlyUsed.filter((item) => item !== name)].slice(0, 12);
          writeUserPrefs(userPrefsPath, prefs);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ recentlyUsed: prefs.recentlyUsed }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    // ── Semantic completions for SQL cells ─────────────────────────────────────
    if (req.method === 'GET' && path === '/api/semantic-completions') {
      const completions: Array<{ type: string; name: string; label: string; description: string; sql: string; domain?: string; tags: string[] }> = [];
      if (semanticLayer) {
        for (const m of semanticLayer.listMetrics()) {
          completions.push({
            type: 'metric',
            name: m.name,
            label: m.label,
            description: m.description ?? '',
            sql: m.sql,
            domain: m.domain,
            tags: m.tags ?? [],
          });
        }
        for (const d of semanticLayer.listDimensions()) {
          completions.push({
            type: 'dimension',
            name: d.name,
            label: d.label,
            description: d.description ?? '',
            sql: d.sql,
            domain: d.domain,
            tags: d.tags ?? [],
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ completions }));
      return;
    }
    // ── end dql-notebook API ──────────────────────────────────────────────────

    // GET /api/describe-table?table=schema.table — returns columns for a specific table
    if (req.method === 'GET' && path === '/api/describe-table') {
      try {
        const tablePath = url.searchParams.get('table') ?? '';
        const schemaName = url.searchParams.get('schema') ?? undefined;
        if (!tablePath) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing table parameter' }));
          return;
        }
        // Try connector.listColumns() first
        let columns: Array<{ name: string; type: string }> = [];
        const activeConnection = connection;
        try {
          if (!activeConnection) throw new Error('No active connection');
          const connector = await executor.getConnector(activeConnection);
          if (typeof connector.listColumns === 'function') {
            const rawCols = await connector.listColumns(schemaName, tablePath);
            columns = rawCols.map((c) => ({ name: c.name, type: c.dataType }));
          }
        } catch {
          // fallback below
        }
        // Fallback: DESCRIBE via SQL (works for DuckDB, PG)
        if (columns.length === 0) {
          try {
            const isFile = /\.(csv|parquet|json)$/i.test(tablePath) || tablePath.startsWith('data/');
            const safePath = tablePath.replace(/'/g, "''");
            const qualifiedIdentifier = tablePath.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
            const sql = isFile
              ? `DESCRIBE SELECT * FROM read_csv_auto('${safePath}') LIMIT 0`
              : `DESCRIBE ${qualifiedIdentifier}`;
            if (!activeConnection) throw new Error('No active connection');
            const result = await executor.executeQuery(sql, [], {}, activeConnection);
            columns = result.rows.map((row) => ({
              name: String(row['column_name'] ?? row['Field'] ?? ''),
              type: String(row['column_type'] ?? row['Type'] ?? ''),
            }));
          } catch {
            // empty columns
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(columns));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/llm/run') {
      const body = await readJSON(req).catch(() => null);
      if (!body || typeof body !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'Invalid JSON body' }));
        return;
      }
      const { provider, messages, upstream, conversationContext } = body as {
        provider?: string;
        messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
        upstream?: { cellId?: string; sql?: string };
        conversationContext?: unknown;
      };
      const resolvedProvider = isLLMProviderId(provider) ? provider : resolveDefaultLLMProvider(projectRoot);
      const runner = resolvedProvider ? getLLMRunner(resolvedProvider) : null;
      if (!resolvedProvider || !runner) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'No AI provider is configured. Configure OpenAI, Gemini, Ollama, or a custom OpenAI-compatible endpoint in Settings.' }));
        return;
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'messages[] required' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const emit = (turn: unknown) => { res.write(`data: ${JSON.stringify(turn)}\n\n`); };
      try {
        await runner.run(
          {
            provider: resolvedProvider,
            messages,
            upstream,
            conversationContext: conversationContext && typeof conversationContext === 'object' && !Array.isArray(conversationContext)
              ? conversationContext as AgentConversationContext
              : undefined,
            projectRoot,
            executeCertifiedBlock: executeCertifiedBlockForAgent,
            executeGeneratedSql: executeGeneratedSqlForAgent,
            getSchemaContext: getSchemaContextForAgent,
          },
          emit,
          controller.signal,
        );
      } catch (err) {
        emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      res.end();
      return;
    }

    if (req.method === 'POST' && path === '/api/ai/sql-draft/preview') {
      try {
        const body = await readJSON(req);
        if (typeof body.sql !== 'string' || body.sql.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing SQL in request body.' }));
          return;
        }
        const previewSql = buildAgentPreviewSql(body.sql);
        const result = await executeLocalSqlForStoredResult(previewSql);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, result }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/query') {
      let body: any;
      let execContext: NotebookExecutionContextInput | null = null;
      const start = Date.now();
      try {
        body = await readJSON(req);
        execContext = notebookExecutionContext(body.executionContext);
        if (typeof body.sql !== 'string' || body.sql.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ columns: [], rows: [], error: 'Missing SQL in request body.' }));
          return;
        }
        const semantic = prepareSemanticSql(body.sql, semanticLayer);
        if (semantic.unresolvedRefs.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({
            columns: [],
            rows: [],
            error: `Unknown semantic reference${semantic.unresolvedRefs.length > 1 ? 's' : ''}: ${semantic.unresolvedRefs.join(', ')}`,
            code: 'semantic_ref',
            unresolvedRefs: semantic.unresolvedRefs,
          }));
          return;
        }
        const prepared = prepareLocalExecution(
          semantic.sql,
          requireActiveConnection(isConnectionConfig(body.connection) ? body.connection : connection),
          projectRoot,
          projectConfig,
        );
        const app = loadRuntimeApp(projectRoot, typeof body.appId === 'string' ? body.appId : activePersonaAppId());
        const domain = typeof body.domain === 'string' ? body.domain : app?.domain;
        assertAppAccess({ app, domain, level: 'execute' });
        const result = await executor.executeQuery(
          prepared.sql,
          Array.isArray(body.sqlParams) ? body.sqlParams : [],
          runtimeVariables(body.variables && typeof body.variables === 'object' ? body.variables : {}),
          prepared.connection,
        );
        const normalized = normalizeQueryResult(result, semantic.semanticRefs);
        if (execContext) {
          recordNotebookQueryRun(projectRoot, {
            notebookPath: execContext.notebookPath!,
            cellId: execContext.cellId,
            cellName: execContext.cellName,
            researchRunId: execContext.researchRunId,
            source: execContext.source ?? 'notebook_sql_cell',
            status: 'success',
            rowCount: normalized.rowCount ?? normalized.rows.length,
            durationMs: Date.now() - start,
            sql: body.sql,
          });
          updateNotebookResearchFromCellExecution(projectRoot, execContext, {
            status: 'success',
            resultPreview: normalized,
            sql: body.sql,
          });
        }
        const payload = serializeJSON(normalized);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(payload);
      } catch (error) {
        if (res.headersSent || res.writableEnded) {
          res.end();
          return;
        }
        if (error instanceof DQLAccessDeniedError) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({
            columns: [],
            rows: [],
            error: error.message,
            code: 'unauthorized',
          }));
          return;
        }
        if (execContext) {
          recordNotebookQueryRun(projectRoot, {
            notebookPath: execContext.notebookPath!,
            cellId: execContext.cellId,
            cellName: execContext.cellName,
            researchRunId: execContext.researchRunId,
            source: execContext.source ?? 'notebook_sql_cell',
            status: 'error',
            durationMs: Date.now() - start,
            errorCode: error instanceof Error ? error.message : String(error),
            sql: typeof body?.sql === 'string' ? body.sql : undefined,
          });
          updateNotebookResearchFromCellExecution(projectRoot, execContext, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            sql: typeof body?.sql === 'string' ? body.sql : undefined,
          });
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          columns: [],
          rows: [],
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }

    // Semantic layer query endpoint: compose SQL from metrics/dimensions
    if (req.method === 'POST' && path === '/api/semantic-query') {
      try {
        if (!semanticLayer) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'No semantic layer configured. Add YAML files to semantic-layer/ directory.' }));
          return;
        }
        const body = await readJSON(req);
        const { metrics = [], dimensions = [], filters = [], limit, timeDimension, orderBy, savedQuery, engine } = body as {
          metrics: string[];
          dimensions: string[];
          filters?: Array<{ dimension: string; operator: string; values: string[]; expression?: string }>;
          timeDimension?: { name: string; granularity: string };
          orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
          limit?: number;
          savedQuery?: string;
          engine?: 'native' | 'metricflow';
        };
        // Resolve which connection to use — request can override default
        const targetConnection = requireActiveConnection(isConnectionConfig(body.connection) ? body.connection : connection);
        const driver = targetConnection.driver;
        // Build table mapping: resolve semantic model names to actual DB table names
        let tableMapping: Record<string, string> | undefined;
        try {
          const tablesResult = await executor.executeQuery(
            `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`,
            [], {}, targetConnection,
          );
          const dbTableNames = new Set<string>();
          const schemaQualified = new Map<string, string>();
          for (const row of tablesResult.rows) {
            const schema = String(row['table_schema'] ?? '');
            const name = String(row['table_name'] ?? '');
            dbTableNames.add(name);
            schemaQualified.set(name, schema ? `${schema}.${name}` : name);
          }
          // For each table in the semantic layer, map to qualified name if it exists
          const allSemanticTables = new Set<string>();
          for (const m of semanticLayer.listMetrics()) allSemanticTables.add(m.table);
          for (const d of semanticLayer.listDimensions()) allSemanticTables.add(d.table);
          tableMapping = {};
          for (const semTable of allSemanticTables) {
            if (dbTableNames.has(semTable) && schemaQualified.has(semTable)) {
              tableMapping[semTable] = schemaQualified.get(semTable)!;
            }
          }
          if (Object.keys(tableMapping).length === 0) tableMapping = undefined;
        } catch {
          // Non-fatal: proceed without table mapping
        }
        const composed = composeRuntimeSemanticQuery({
          metrics,
          dimensions,
          filters,
          limit,
          timeDimension,
          orderBy,
          savedQuery,
          engine,
        }, semanticLayer, {
          projectRoot,
          projectConfig,
          detectedProvider: semanticDetectedProvider,
          driver,
          tableMapping,
        });
        if (!composed) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Could not compose query for metrics: [${metrics.join(', ')}]` }));
          return;
        }
        // Execute the composed SQL against the resolved connection
        const prepared = prepareLocalExecution(composed.sql, targetConnection, projectRoot, projectConfig);
        const result = await executor.executeQuery(prepared.sql, [], {}, prepared.connection);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          sql: composed.sql,
          tables: composed.tables,
          joins: composed.joins,
          engine: composed.engine,
          result: normalizeQueryResult(result),
        }));
      } catch (error) {
        if (error instanceof DQLAccessDeniedError) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: error.message, code: 'unauthorized' }));
          return;
        }
        const status = error instanceof MetricFlowUnavailableError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof MetricFlowUnavailableError ? 'metricflow_unavailable' : undefined,
          hint: error instanceof MetricFlowUnavailableError
            ? 'Install dbt Semantic Layer dependencies, run dbt parse/build to create target/semantic_manifest.json, then retry.'
            : undefined,
        }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/semantic-builder/preview') {
      try {
        if (!semanticLayer) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'No semantic layer configured.' }));
          return;
        }
        const body = await readJSON(req);
        const { metrics = [], dimensions = [], filters = [], limit, timeDimension, orderBy, savedQuery, engine } = body as {
          metrics: string[];
          dimensions: string[];
          filters?: Array<{ dimension: string; operator: string; values: string[]; expression?: string }>;
          timeDimension?: { name: string; granularity: string };
          orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
          limit?: number;
          savedQuery?: string;
          engine?: 'native' | 'metricflow';
        };
        const targetConnection = requireActiveConnection(isConnectionConfig(body.connection) ? body.connection : connection);
        const driver = targetConnection.driver;
        let tableMapping: Record<string, string> | undefined;
        try {
          const tablesResult = await executor.executeQuery(
            `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`,
            [], {}, targetConnection,
          );
          const schemaQualified = new Map<string, string>();
          for (const row of tablesResult.rows) {
            const schema = String(row['table_schema'] ?? '');
            const name = String(row['table_name'] ?? '');
            schemaQualified.set(name, schema ? `${schema}.${name}` : name);
          }
          tableMapping = {};
          for (const metric of semanticLayer.listMetrics()) {
            if (schemaQualified.has(metric.table)) tableMapping[metric.table] = schemaQualified.get(metric.table)!;
          }
          for (const dimension of semanticLayer.listDimensions()) {
            if (schemaQualified.has(dimension.table)) tableMapping[dimension.table] = schemaQualified.get(dimension.table)!;
          }
          if (Object.keys(tableMapping).length === 0) tableMapping = undefined;
        } catch {
          tableMapping = undefined;
        }
        const composed = composeRuntimeSemanticQuery({
          metrics,
          dimensions,
          filters,
          limit,
          timeDimension,
          orderBy,
          savedQuery,
          engine,
        }, semanticLayer, {
          projectRoot,
          projectConfig,
          detectedProvider: semanticDetectedProvider,
          driver,
          tableMapping,
        });
        if (!composed) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Could not compose semantic block preview SQL.' }));
          return;
        }
        const prepared = prepareLocalExecution(composed.sql, targetConnection, projectRoot, projectConfig);
        const result = await executor.executeQuery(prepared.sql, [], {}, prepared.connection);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          sql: composed.sql,
          joins: composed.joins,
          tables: composed.tables,
          engine: composed.engine,
          result: normalizeQueryResult(result),
        }));
      } catch (error) {
        const status = error instanceof MetricFlowUnavailableError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof MetricFlowUnavailableError ? 'metricflow_unavailable' : undefined,
          hint: error instanceof MetricFlowUnavailableError
            ? 'Install dbt Semantic Layer dependencies, run dbt parse/build to create target/semantic_manifest.json, then retry.'
            : undefined,
        }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/semantic-builder/save') {
      try {
        if (!semanticLayer) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'No semantic layer configured.' }));
          return;
        }
        const body = await readJSON(req);
        const {
          name,
          domain,
          description,
          owner,
          tags,
          metrics = [],
          dimensions = [],
          timeDimension,
          filters = [],
          chart = 'table',
          blockType = 'semantic',
          engine,
        } = body as {
          name: string;
          domain?: string;
          description?: string;
          owner?: string;
          tags?: string[];
          metrics: string[];
          dimensions: string[];
          timeDimension?: { name: string; granularity: string };
          filters?: Array<{ dimension: string; operator: string; values: string[] }>;
          chart?: string;
          blockType?: 'semantic' | 'custom';
          engine?: 'native' | 'metricflow';
        };
        if (!name || metrics.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'name and at least one metric are required.' }));
          return;
        }
        const targetConnection = requireActiveConnection(isConnectionConfig(body.connection) ? body.connection : connection);
        const composed = composeRuntimeSemanticQuery({
          metrics,
          dimensions,
          filters,
          timeDimension,
          engine,
        }, semanticLayer, {
          projectRoot,
          projectConfig,
          detectedProvider: semanticDetectedProvider,
          driver: targetConnection.driver,
        });
        if (!composed) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Could not compose semantic block SQL.' }));
          return;
        }
        const created = createSemanticBuilderBlock(projectRoot, {
          name,
          domain,
          description,
          owner,
          tags,
          metrics,
          dimensions,
          timeDimension,
          chart,
          blockType,
          sql: composed.sql,
          tables: composed.tables,
          provider: semanticImportManifest?.provider ?? semanticDetectedProvider ?? 'dql',
        });
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(created));
      } catch (error) {
        if (error instanceof Error && error.message === 'BLOCK_EXISTS') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block already exists' }));
          return;
        }
        const status = error instanceof MetricFlowUnavailableError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof MetricFlowUnavailableError ? 'metricflow_unavailable' : undefined,
          hint: error instanceof MetricFlowUnavailableError
            ? 'Install dbt Semantic Layer dependencies, run dbt parse/build to create target/semantic_manifest.json, then retry.'
            : undefined,
        }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/test-connection') {
      let target: ConnectionConfig | null = connection;
      try {
        const body = await readJSON(req);
        target = normalizeProjectConnection(
          requireActiveConnection(isConnectionConfig(body.connection) ? body.connection : connection),
          projectRoot,
        );
        const connector = await executor.getConnector(target);
        const result = await validateConnectionForTest(connector, target);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok: false,
          message: target ? formatConnectionTestError(target, error) : error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }

    // ---- Lineage API ----
    if (req.method === 'GET' && path === '/api/lineage') {
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(graph.toJSON()));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/lineage/search') {
      const term = url.searchParams.get('q') ?? '';
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const result = queryLineage(graph, { search: term });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ matches: result.matches ?? [] }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/lineage/scope') {
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const result = buildScopedLineage(graph, {
          domain: url.searchParams.get('domain') ?? undefined,
          appId: url.searchParams.get('appId') ?? undefined,
          dashboardId: url.searchParams.get('dashboardId') ?? undefined,
          blockId: url.searchParams.get('blockId') ?? undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/lineage/query') {
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const types = url.searchParams.get('types')
          ?.split(',')
          .map((value) => value.trim())
          .filter(Boolean) as any[] | undefined;
        const upstreamDepthParam = url.searchParams.get('upstreamDepth');
        const downstreamDepthParam = url.searchParams.get('downstreamDepth');
        const result = queryLineage(graph, {
          focus: url.searchParams.get('focus') ?? undefined,
          search: url.searchParams.get('search') ?? undefined,
          types,
          domain: url.searchParams.get('domain') ?? undefined,
          upstreamDepth: upstreamDepthParam ? Number(upstreamDepthParam) : undefined,
          downstreamDepth: downstreamDepthParam ? Number(downstreamDepthParam) : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lineage/business-360/')) {
      const rawNodeId = decodeURIComponent(path.slice('/api/lineage/business-360/'.length));
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const result: Business360ResultV2 | null = queryBusiness360(graph, rawNodeId);
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Lineage node "${rawNodeId}" not found` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lineage/node/')) {
      const rawNodeId = decodeURIComponent(path.slice('/api/lineage/node/'.length));
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const node = resolveLineageNode(graph, rawNodeId);
        if (!node) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ node: null, incoming: [], outgoing: [] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          node,
          incoming: graph.getIncomingEdges(node.id).map((edge) => ({
            edge,
            node: graph.getNode(edge.source),
          })),
          outgoing: graph.getOutgoingEdges(node.id).map((edge) => ({
            edge,
            node: graph.getNode(edge.target),
          })),
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lineage/domain/')) {
      const domain = decodeURIComponent(path.slice('/api/lineage/domain/'.length));
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const overview = getDomainTrustOverview(graph, domain);
        const nodes = graph.getNodesByDomain(domain);
        const flows = detectDomainFlows(graph);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          domain,
          overview,
          nodes,
          inFlows: flows.filter((f) => f.to === domain),
          outFlows: flows.filter((f) => f.from === domain),
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lineage/impact/')) {
      const blockName = decodeURIComponent(path.slice('/api/lineage/impact/'.length));
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const nodeId = `block:${blockName}`;
        if (!graph.getNode(nodeId)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Block "${blockName}" not found` }));
          return;
        }
        const impact = analyzeImpact(graph, nodeId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(impact));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lineage/block/')) {
      const blockName = decodeURIComponent(path.slice('/api/lineage/block/'.length));
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const nodeId = `block:${blockName}`;
        const node = graph.getNode(nodeId);
        if (!node) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Block "${blockName}" not found` }));
          return;
        }
        const ancestors = graph.ancestors(nodeId);
        const descendants = graph.descendants(nodeId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ node, ancestors, descendants }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lineage/paths/')) {
      const rawNodeId = decodeURIComponent(path.slice('/api/lineage/paths/'.length));
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const maxDepth = Number(url.searchParams.get('maxDepth') ?? '10') || 10;
        const maxPaths = Number(url.searchParams.get('maxPaths') ?? '20') || 20;
        const result = queryCompleteLineagePaths(graph, rawNodeId, { maxDepth, maxPaths });
        if (!result) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('null');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(result));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/lineage/trust-chain') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'Missing "from" and "to" query parameters' }));
        return;
      }
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const chain = buildTrustChain(graph, `block:${from}`, `block:${to}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(chain ?? { error: 'No path found' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/notebook/bootstrap') {
      const welcomeNotebook = resolveNotebook(projectRoot, projectConfig.project ?? 'DQL Project');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({
        projectRoot,
        project: projectConfig.project ?? 'DQL Project',
        defaultConnection: projectConfig.defaultConnection ?? connection,
        connectorForms: getConnectorFormSchemas(),
        files: listProjectFiles(projectRoot),
        notebook: welcomeNotebook,
      }));
      return;
    }

    if (req.method === 'GET' && path === '/api/notebook/file') {
      const relativePath = url.searchParams.get('path');
      if (!relativePath) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: 'Missing file path.' }));
        return;
      }

      const filePath = safeJoin(projectRoot, relativePath);
      if (!filePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: `File not found: ${relativePath}` }));
        return;
      }

      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
      res.end(readFileSync(filePath));
      return;
    }

    if (req.method === 'POST' && path === '/api/notebook/execute') {
      let body: any;
      let execContext: NotebookExecutionContextInput | null = null;
      const start = Date.now();
      try {
        body = await readJSON(req);
        execContext = notebookExecutionContext(body.executionContext);
        const cell = normalizeNotebookCell(body.cell);
        if (!cell) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing notebook cell payload.' }));
          return;
        }

        const resolved = resolveNotebookBlockReferenceCell(cell, projectRoot);
        const executableCell = resolved.cell;
        const cellConnection = requireActiveConnection(isConnectionConfig(body.connection) ? body.connection : connection);
        const tableMapping = needsSemanticTableMapping(executableCell)
          ? await resolveSemanticTableMapping(executor, cellConnection, semanticLayer)
          : undefined;
        const plan = buildExecutionPlan(executableCell, { semanticLayer, driver: cellConnection.driver, tableMapping });
        if (!plan) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ cellType: cell.type, result: null }));
          return;
        }

        const prepared = prepareLocalExecution(
          plan.sql,
          cellConnection,
          projectRoot,
          projectConfig,
        );
        const app = loadRuntimeApp(projectRoot, typeof body.appId === 'string' ? body.appId : activePersonaAppId());
        assertAppAccess({ app, domain: resolved.domain ?? app?.domain, level: 'execute' });
        const rawResult = await executor.executeQuery(
          prepared.sql,
          plan.sqlParams,
          runtimeVariables(plan.variables),
          prepared.connection,
        );
        const normalized = normalizeQueryResult(rawResult);
        if (execContext) {
          recordNotebookQueryRun(projectRoot, {
            notebookPath: execContext.notebookPath!,
            cellId: execContext.cellId ?? cell.id,
            cellName: execContext.cellName ?? plan.title ?? resolved.blockName,
            researchRunId: execContext.researchRunId,
            source: execContext.source ?? (cell.type === 'dql' ? 'notebook_dql_cell' : 'notebook_cell'),
            status: 'success',
            rowCount: normalized.rowCount ?? normalized.rows.length,
            durationMs: Date.now() - start,
            sql: plan.sql,
            objectKey: resolved.blockPath,
          });
          updateNotebookResearchFromCellExecution(projectRoot, execContext, {
            status: 'success',
            resultPreview: normalized,
            sql: plan.sql,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          cellType: cell.type,
          title: plan.title,
          blockName: resolved.blockName,
          blockPath: resolved.blockPath,
          chartConfig: plan.chartConfig,
          tests: plan.tests,
          result: normalized,
        }));
      } catch (error) {
        if (execContext) {
          recordNotebookQueryRun(projectRoot, {
            notebookPath: execContext.notebookPath!,
            cellId: execContext.cellId,
            cellName: execContext.cellName,
            researchRunId: execContext.researchRunId,
            source: execContext.source ?? 'notebook_cell',
            status: 'error',
            durationMs: Date.now() - start,
            errorCode: error instanceof Error ? error.message : String(error),
          });
          updateNotebookResearchFromCellExecution(projectRoot, execContext, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // Create a new metric YAML file in semantic-layer/metrics/
    if (req.method === 'POST' && path === '/api/semantic-layer/metric') {
      try {
        const body = await readJSON(req);
        const { name, label, description, domain, sql, type, table, tags } = body as {
          name: string; label: string; description: string; domain: string;
          sql: string; type: string; table: string; tags?: string[];
        };
        if (!name || !sql || !type || !table) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'name, sql, type, and table are required' }));
          return;
        }
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        const metricsDir = join(projectRoot, 'semantic-layer', 'metrics');
        mkdirSync(metricsDir, { recursive: true });
        const filePath = join(metricsDir, `${slug}.yaml`);
        const tagList = Array.isArray(tags) && tags.length > 0
          ? `\ntags:\n${tags.map(t => `  - ${t}`).join('\n')}`
          : '';
        const yaml = `name: ${slug}
label: ${label || name}
description: ${description || ''}
domain: ${domain || 'general'}
sql: ${sql}
type: ${type}
table: ${table}${tagList}
`;
        writeFileSync(filePath, yaml, 'utf-8');
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, path: `semantic-layer/metrics/${slug}.yaml` }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    const requestedPath = path === '/' ? '/index.html' : path;
    const filePath = safeJoin(rootDir, requestedPath);
    if (!filePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderNotFound(path));
      return;
    }

    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(content);
  });

  return new Promise<number>((resolvePromise, reject) => {
    let retriedWithRandomPort = false;

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && !retriedWithRandomPort) {
        retriedWithRandomPort = true;
        server.listen(0, bindHost);
        return;
      }
      reject(error);
    });

    server.listen(preferredPort, bindHost, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve local server address.'));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

export async function assertLocalQueryRuntimeReady(
  executor: QueryExecutor,
  connection: ConnectionConfig,
): Promise<void> {
  try {
    const connector = await executor.getConnector(connection);
    const ok = await connector.ping();
    if (!ok) {
      throw new Error(`Connection check failed for driver "${connection.driver}".`);
    }
  } catch (error) {
    throw new Error(formatLocalQueryRuntimeError(connection, error));
  }
}

export function formatLocalQueryRuntimeError(
  connection: ConnectionConfig,
  error: unknown,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const driver = connection.driver;
  const currentNode = process.versions.node;

  if (
    (driver === 'file' || driver === 'duckdb') &&
    detail.includes('duckdb.node')
  ) {
    return `Local query runtime is unavailable for driver "${driver}": DuckDB native bindings could not be loaded. Current Node.js runtime: ${currentNode}. Reinstall dependencies with a supported LTS Node release (for example Node 18, 20, or 22), then rerun "pnpm install". Original error: ${detail}`;
  }

  return `Local query runtime is unavailable for driver "${driver}": ${detail}`;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export async function validateConnectionForTest(
  connector: DatabaseConnector,
  connection: ConnectionConfig,
): Promise<ConnectionTestResult> {
  if (connection.driver === 'snowflake') {
    return validateSnowflakeConnectionForTest(connector, connection);
  }

  const ok = await connector.ping();
  const label = connectionDriverLabel(connection);
  return {
    ok,
    message: ok
      ? `Connected to ${label} successfully.`
      : `Connection to ${label} failed. Check credentials, network access, and database availability.`,
  };
}

function formatConnectionTestError(connection: ConnectionConfig, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const label = connectionDriverLabel(connection);
  if (connection.driver === 'snowflake') {
    const cleaned = detail.replace(/^Snowflake (?:connection|query) failed:\s*/i, '').trim();
    return `Snowflake connection failed: ${cleaned || 'Check account, user, password/auth method, role, and network access.'}`;
  }
  return `Connection to ${label} failed: ${detail}`;
}

async function validateSnowflakeConnectionForTest(
  connector: DatabaseConnector,
  connection: ConnectionConfig,
): Promise<ConnectionTestResult> {
  const warehouse = connection.warehouse?.trim();
  if (!warehouse) {
    return {
      ok: false,
      message: 'Snowflake connection requires a warehouse before it can be tested.',
    };
  }

  const warehouseRow = await findSnowflakeWarehouse(connector, warehouse);
  if (!warehouseRow) {
    return {
      ok: false,
      message: `Snowflake warehouse "${warehouse}" was not found or is not visible to this role.`,
    };
  }

  const state = String(readRowField(warehouseRow, 'state') ?? '').trim();
  const normalizedState = state.toUpperCase();
  if (normalizedState && normalizedState !== 'STARTED') {
    return {
      ok: false,
      message: `Snowflake warehouse "${warehouse}" is ${state}. Start or resume it, then test again.`,
      details: {
        warehouse,
        state,
      },
    };
  }

  const context = await connector.execute(
    `SELECT
       CURRENT_ACCOUNT() AS account_name,
       CURRENT_USER() AS user_name,
       CURRENT_ROLE() AS role_name,
       CURRENT_DATABASE() AS database_name,
       CURRENT_SCHEMA() AS schema_name,
       CURRENT_WAREHOUSE() AS warehouse_name`,
  );
  const row = context.rows[0] ?? {};
  const user = String(readRowField(row, 'user_name') ?? connection.username ?? '').trim();
  const role = String(readRowField(row, 'role_name') ?? connection.role ?? '').trim();
  const activeWarehouse = String(readRowField(row, 'warehouse_name') ?? warehouse).trim();

  return {
    ok: true,
    message: `Connected to Snowflake${user ? ` as ${user}` : ''} using warehouse ${activeWarehouse || warehouse}.`,
    details: {
      warehouse: activeWarehouse || warehouse,
      warehouseState: state || 'STARTED',
      role: role || undefined,
      database: readRowField(row, 'database_name') ?? connection.database,
      schema: readRowField(row, 'schema_name') ?? connection.schema,
    },
  };
}

async function findSnowflakeWarehouse(
  connector: DatabaseConnector,
  warehouse: string,
): Promise<Record<string, unknown> | null> {
  const candidates = Array.from(new Set([warehouse, warehouse.toUpperCase()]));
  for (const candidate of candidates) {
    const result = await connector.execute(`SHOW WAREHOUSES LIKE '${escapeSqlString(candidate)}'`);
    const row = result.rows.find((item) => {
      const name = String(readRowField(item, 'name') ?? '').trim();
      return name.localeCompare(warehouse, undefined, { sensitivity: 'accent' }) === 0;
    });
    if (row) return row;
  }
  return null;
}

function readRowField(row: Record<string, unknown>, field: string): unknown {
  const expected = field.toLowerCase();
  const entry = Object.entries(row).find(([key]) => key.toLowerCase() === expected);
  return entry?.[1];
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function connectionDriverLabel(connection: ConnectionConfig): string {
  return connection.driver === 'snowflake' ? 'Snowflake' : connection.driver ?? 'database';
}

/**
 * Normalize connector QueryResult → SPA-friendly shape.
 * Connector returns columns as ColumnMeta[] ({name,type,driverType}).
 * The notebook SPA expects columns as string[] (just names).
 */
function normalizeQueryResult(
  result: any,
  semanticRefs?: { metrics: string[]; dimensions: string[] },
): {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTime: number;
  truncated?: boolean;
  semanticRefs?: { metrics: string[]; dimensions: string[] };
} {
  const rawCols: unknown[] = Array.isArray(result?.columns) ? result.columns : [];
  const columns = rawCols.map((c) =>
    typeof c === 'string' ? c : typeof (c as any)?.name === 'string' ? (c as any).name : String(c)
  );
  const rawRows = Array.isArray(result?.rows) ? result.rows : [];
  const rows = rawRows.slice(0, NOTEBOOK_EXECUTE_PREVIEW_ROW_LIMIT);
  const hasRefs = semanticRefs && (semanticRefs.metrics.length > 0 || semanticRefs.dimensions.length > 0);
  return {
    columns,
    rows,
    rowCount: typeof result?.rowCount === 'number' ? result.rowCount : rawRows.length,
    executionTime: typeof result?.executionTimeMs === 'number'
      ? result.executionTimeMs
      : typeof result?.executionTime === 'number'
        ? result.executionTime
        : 0,
    ...(rawRows.length > rows.length ? { truncated: true } : {}),
    ...(hasRefs ? { semanticRefs } : {}),
  };
}

function isLLMProviderId(value: unknown): value is ProviderId {
  return value === 'anthropic'
    || value === 'claude-agent-sdk'
    || value === 'claude-code'
    || value === 'openai'
    || value === 'gemini'
    || value === 'ollama'
    || value === 'custom-openai';
}

export function resolveDefaultLLMProvider(projectRoot: string): ProviderId | null {
  const settings = listProviderSettings(projectRoot);
  const activeProvider = getActiveProvider(projectRoot);
  if (activeProvider) {
    const active = settings.find((item) => item.id === activeProvider);
    if (active?.enabled) return activeProvider;
  }
  const preferred: ProviderId[] = ['openai', 'gemini', 'anthropic', 'custom-openai', 'ollama'];
  for (const id of preferred) {
    const provider = settings.find((item) => item.id === id);
    if (provider?.enabled && provider.hasApiKey) return id;
  }
  return null;
}

function loadAppDashboard(
  projectRoot: string,
  appId: string,
  dashboardId: string,
): { app: AppDocument; dashboard: DashboardDocument } | null {
  for (const p of findAppDocuments(projectRoot)) {
    const { document: app } = loadAppDocument(p);
    if (!app || app.id !== appId) continue;
    const appDir = p.slice(0, -'/dql.app.json'.length);
    for (const d of findDashboardsForApp(appDir)) {
      const { document: dashboard } = loadDashboardDocument(d);
      if (dashboard?.id === dashboardId) return { app, dashboard };
    }
  }
  return null;
}

function resolveDashboardItemBlock(
  item: DashboardGridItem,
  manifest: DQLManifest,
): ManifestBlock | null {
  if (!item.block) return null;
  if (isBlockIdRef(item.block)) {
    return manifest.blocks[item.block.blockId] ?? null;
  }
  const normalizedRef = normalize(item.block.ref).replaceAll('\\', '/');
  return Object.values(manifest.blocks).find((b) => normalize(b.filePath).replaceAll('\\', '/') === normalizedRef) ?? null;
}

function mergeDashboardChartConfig(
  base: object | null | undefined,
  item: DashboardGridItem,
): Record<string, unknown> {
  const options = item.viz.options ?? {};
  const baseChart = (base as { chart?: unknown } | null | undefined)?.chart;
  return {
    ...(base ?? {}),
    ...options,
    chart: dashboardVizToChart(String(options.chart ?? baseChart ?? item.viz.type)),
  };
}

function dashboardVizToChart(value: string): string {
  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized === 'single-value') return 'kpi';
  return normalized;
}

export function serializeJSON(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') {
      const asNumber = Number(current);
      return Number.isSafeInteger(asNumber) ? asNumber : current.toString();
    }
    return current;
  });
}

async function refreshLocalMetadataCatalog(projectRoot: string): Promise<void> {
  try {
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
  } catch {
    // The catalog is a rebuildable local cache. Save/certify flows should not
    // fail only because metadata refresh hit a stale dbt or semantic config.
  }
}

function renderNotFound(path: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>DQL Local Runtime</title>
    <style>
      body { font-family: Inter, system-ui, sans-serif; margin: 40px; color: #111827; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>DQL Local Runtime</h1>
    <p>No file exists for <code>${escapeHtml(path)}</code>.</p>
    <p>Try opening <code>/</code> or confirm that you built the bundle correctly.</p>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'dql.config.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  const config = raw as unknown as ProjectConfig;

  const connections = getStoredConnections(raw);
  const defaultConnectionName = resolveDefaultConnectionKey(raw, connections);
  if (defaultConnectionName) {
    const selected = normalizeStoredConnection(connections[defaultConnectionName]);
    if (selected) {
      config.defaultConnection = selected;
      config.defaultConnectionName = defaultConnectionName;
    }
  } else if (config.defaultConnection) {
    const normalized = normalizeStoredConnection(config.defaultConnection as ConnectionConfig & { path?: string; type?: string });
    if (normalized) {
      config.defaultConnection = normalized;
    }
  }

  return config;
}

function getProjectConnectionsForApi(config: ProjectConfig | Record<string, unknown>): Record<string, unknown> {
  const connections = getStoredConnections(config as Record<string, unknown>);
  if (Object.keys(connections).length === 0 && isConnectionLike((config as ProjectConfig).defaultConnection)) {
    return { default: (config as ProjectConfig).defaultConnection };
  }
  return connections;
}

const CONNECTOR_INSTALLS: Record<string, Omit<ConnectorInstallStatus, 'installed' | 'installPath' | 'installCommand'>> = {
  duckdb: {
    driver: 'duckdb',
    label: 'DuckDB',
    packageName: 'duckdb',
    packageSpec: 'duckdb@^1.1.0',
    builtIn: false,
  },
  snowflake: {
    driver: 'snowflake',
    label: 'Snowflake',
    packageName: 'snowflake-sdk',
    packageSpec: 'snowflake-sdk@^1.12.0',
    builtIn: false,
  },
  databricks: {
    driver: 'databricks',
    label: 'Databricks',
    builtIn: true,
  },
};

function connectorInstallRoot(projectRoot: string): string {
  return join(projectRoot, '.dql', 'connectors');
}

function connectorModuleSearchPaths(projectRoot: string): string[] {
  return [connectorInstallRoot(projectRoot), projectRoot];
}

function connectorInstallCommand(projectRoot: string, packageSpec: string): string {
  return `npm install --prefix ${connectorInstallRoot(projectRoot)} ${packageSpec}`;
}

function isConnectorPackageInstalled(projectRoot: string, packageName: string): boolean {
  for (const basePath of connectorModuleSearchPaths(projectRoot)) {
    try {
      const req = createRequire(join(basePath, 'package.json'));
      req.resolve(packageName);
      return true;
    } catch {
      // Try the next supported location.
    }
  }
  return false;
}

export function getConnectorInstallStatuses(projectRoot: string): ConnectorInstallStatus[] {
  return Object.values(CONNECTOR_INSTALLS).map((definition) => {
    const installPath = connectorInstallRoot(projectRoot);
    const installed = definition.builtIn || (
      definition.packageName
        ? isConnectorPackageInstalled(projectRoot, definition.packageName)
        : true
    );
    return {
      ...definition,
      installed,
      installPath,
      installCommand: definition.packageSpec
        ? connectorInstallCommand(projectRoot, definition.packageSpec)
        : undefined,
    };
  });
}

function installConnectorPackage(projectRoot: string, driver: string): ConnectorInstallStatus {
  const definition = CONNECTOR_INSTALLS[driver];
  if (!definition) {
    throw new Error(`Unknown connector "${driver}".`);
  }
  if (definition.builtIn || !definition.packageSpec) {
    return getConnectorInstallStatuses(projectRoot).find((status) => status.driver === definition.driver)!;
  }

  const installRoot = connectorInstallRoot(projectRoot);
  mkdirSync(installRoot, { recursive: true });
  const packageJsonPath = join(installRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        private: true,
        description: 'Project-local DQL connector packages',
      }, null, 2) + '\n',
      'utf-8',
    );
  }

  execFileSync(
    'npm',
    ['install', '--prefix', installRoot, '--no-audit', '--no-fund', definition.packageSpec],
    {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10 * 60 * 1000,
    },
  );

  return getConnectorInstallStatuses(projectRoot).find((status) => status.driver === definition.driver)!;
}

function getStoredConnections(raw: Record<string, unknown>): Record<string, unknown> {
  const value = raw.connections;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function resolveDefaultConnectionKey(
  raw: Record<string, unknown>,
  connections: Record<string, unknown>,
): string | undefined {
  const keys = Object.keys(connections).filter((key) => isConnectionLike(connections[key]));
  if (keys.length === 0) return undefined;

  const configured = readConfiguredDefaultConnectionName(raw);
  if (configured && keys.includes(configured)) {
    return configured;
  }

  if (keys.includes('default') && !isPlaceholderLocalConnection(connections.default)) {
    return 'default';
  }

  const realConnections = keys.filter((key) => !isPlaceholderLocalConnection(connections[key]));
  if (keys.includes('default') && isPlaceholderLocalConnection(connections.default) && realConnections.length === 1) {
    return realConnections[0];
  }

  if (keys.length === 1) {
    return keys[0];
  }

  return keys.includes('default') ? 'default' : keys[0];
}

function readConfiguredDefaultConnectionName(raw: Record<string, unknown>): string | undefined {
  for (const key of ['defaultConnectionName', 'defaultConnectionKey', 'currentConnection']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return typeof raw.default === 'string' && raw.default.trim() ? raw.default.trim() : undefined;
}

function normalizeStoredConnection(value: unknown): ConnectionConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const driver = raw.driver ?? raw.type;
  if (typeof driver !== 'string' || !driver.trim()) return null;

  const { path: legacyPath, type: _type, ...rest } = raw;
  const filepath = typeof raw.filepath === 'string'
    ? raw.filepath
    : typeof legacyPath === 'string'
      ? legacyPath
      : undefined;
  return {
    ...rest,
    driver: driver.trim(),
    ...(filepath ? { filepath } : {}),
  } as unknown as ConnectionConfig;
}

function isConnectionLike(value: unknown): boolean {
  return normalizeStoredConnection(value) !== null;
}

function isPlaceholderLocalConnection(value: unknown): boolean {
  const connection = normalizeStoredConnection(value);
  if (!connection) return false;
  if (connection.driver !== 'duckdb' && connection.driver !== 'file') return false;
  return !connection.filepath || connection.filepath === ':memory:';
}

export function prepareLocalExecution(
  sql: string,
  connection: ConnectionConfig,
  projectRoot: string,
  projectConfig: ProjectConfig,
): { sql: string; connection: ConnectionConfig } {
  const normalizedConnection = normalizeProjectConnection(connection, projectRoot);
  const dbtResolvedSql = resolveDbtMacrosForExecution(sql, projectRoot, projectConfig);
  return {
    sql: shouldResolveProjectPaths(normalizedConnection)
      ? resolveProjectRelativeSqlPaths(dbtResolvedSql, projectRoot, projectConfig.dataDir)
      : dbtResolvedSql,
    connection: normalizedConnection,
  };
}

export interface DashboardFilterApplicationResult {
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  appliedFilters: Array<{
    filter: string;
    binding?: string;
    mode: 'parameter' | 'predicate';
    paramNames: string[];
  }>;
  skippedFilters: Array<{
    filter: string;
    reason: string;
  }>;
}

export function dashboardRuntimeVariables(
  dashboard: Pick<DashboardDocument, 'filters' | 'params'>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const param of dashboard.params ?? []) {
    if (param.default !== undefined) variables[param.id] = param.default;
  }
  for (const filter of dashboard.filters ?? []) {
    if (filter.default !== undefined) variables[filter.id] = filter.default;
  }
  return { ...variables, ...overrides };
}

export function applyDashboardFiltersToBlockExecution(input: {
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  block: Pick<ManifestBlock, 'name' | 'allowedFilters' | 'filterBindings' | 'parameterPolicy'>;
  dashboard: Pick<DashboardDocument, 'filters'>;
}): DashboardFilterApplicationResult {
  const variables = { ...input.variables };
  const sqlParams = [...input.sqlParams];
  const appliedFilters: DashboardFilterApplicationResult['appliedFilters'] = [];
  const skippedFilters: DashboardFilterApplicationResult['skippedFilters'] = [];
  const clauses: string[] = [];
  let nextPosition = sqlParams.reduce((max, param) => Math.max(max, param.position), 0);

  for (const filter of input.dashboard.filters ?? []) {
    const value = dashboardFilterValue(filter, variables);
    if (isEmptyDashboardFilterValue(value)) {
      skippedFilters.push({ filter: filter.id, reason: 'no value supplied' });
      continue;
    }

    const paramNames = bindDashboardFilterToExistingParams(filter, value, input.block, sqlParams, variables);
    if (paramNames.length > 0) {
      appliedFilters.push({
        filter: filter.id,
        mode: 'parameter',
        paramNames,
      });
      continue;
    }

    const binding = resolveDashboardFilterBinding(filter, input.block);
    if (!binding) {
      skippedFilters.push({ filter: filter.id, reason: `block "${input.block.name}" does not declare a compatible filter binding` });
      continue;
    }
    const expression = dashboardFilterExpression(binding);
    if (!expression) {
      skippedFilters.push({ filter: filter.id, reason: `filter binding "${binding}" is not safe for runtime predicate injection` });
      continue;
    }
    const predicate = buildDashboardFilterPredicate({
      expression,
      filterId: filter.id,
      filterType: filter.type,
      value,
      params: sqlParams,
      nextPosition: () => {
        nextPosition += 1;
        return nextPosition;
      },
      variables,
    });
    if (!predicate) {
      skippedFilters.push({ filter: filter.id, reason: 'filter value could not be converted into a predicate' });
      continue;
    }
    clauses.push(predicate);
    appliedFilters.push({
      filter: filter.id,
      binding,
      mode: 'predicate',
      paramNames: sqlParams
        .filter((param) => param.name.startsWith(`__dashboard_filter_${normalizeDashboardFilterName(filter.id)}_`))
        .map((param) => param.name),
    });
  }

  if (clauses.length === 0) {
    return { sql: input.sql, sqlParams, variables, appliedFilters, skippedFilters };
  }

  return {
    sql: `SELECT * FROM (${stripSqlTerminator(input.sql)}) _dql_filter WHERE ${clauses.join(' AND ')}`,
    sqlParams,
    variables,
    appliedFilters,
    skippedFilters,
  };
}

function dashboardFilterValue(
  filter: NonNullable<DashboardDocument['filters']>[number],
  variables: Record<string, unknown>,
): unknown {
  if (Object.prototype.hasOwnProperty.call(variables, filter.id)) return variables[filter.id];
  if (filter.bindsTo && Object.prototype.hasOwnProperty.call(variables, filter.bindsTo)) return variables[filter.bindsTo];
  return filter.default;
}

function isEmptyDashboardFilterValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function bindDashboardFilterToExistingParams(
  filter: NonNullable<DashboardDocument['filters']>[number],
  value: unknown,
  block: Pick<ManifestBlock, 'parameterPolicy'>,
  sqlParams: SQLParamSpec[],
  variables: Record<string, unknown>,
): string[] {
  const availableParamNames = new Set(sqlParams.map((param) => param.name));
  const declaredParamNames = new Set((block.parameterPolicy ?? []).map((entry) => entry.name));
  const applied: string[] = [];
  const directCandidates = uniqueDashboardStrings([
    filter.id,
    filter.bindsTo ?? '',
    normalizeDashboardFilterName(filter.id),
    filter.bindsTo ? normalizeDashboardFilterName(filter.bindsTo) : '',
  ]);
  for (const name of directCandidates) {
    if (!name || !availableParamNames.has(name)) continue;
    variables[name] = value;
    applied.push(name);
  }
  if (applied.length > 0) return applied;

  const range = dashboardRangeValue(value);
  if (range) {
    const baseNames = uniqueDashboardStrings([
      filter.id,
      filter.id.replace(/_?range$/i, ''),
      filter.bindsTo ?? '',
      filter.bindsTo ? filter.bindsTo.replace(/_?range$/i, '') : '',
    ].map(normalizeDashboardFilterName));
    for (const base of baseNames) {
      const pairs = [
        [`${base}_start`, `${base}_end`],
        [`${base}_from`, `${base}_to`],
        [`start_${base}`, `end_${base}`],
      ];
      for (const [startName, endName] of pairs) {
        if (availableParamNames.has(startName) && availableParamNames.has(endName)) {
          variables[startName] = range.start;
          variables[endName] = range.end;
          return [startName, endName];
        }
      }
    }
    for (const [startName, endName] of [['start_date', 'end_date'], ['date_start', 'date_end'], ['season_start', 'season_end'], ['year_start', 'year_end']]) {
      if (availableParamNames.has(startName) && availableParamNames.has(endName)) {
        variables[startName] = range.start;
        variables[endName] = range.end;
        return [startName, endName];
      }
    }
  }

  for (const name of declaredParamNames) {
    if (!availableParamNames.has(name)) continue;
    const normalized = normalizeDashboardFilterName(name);
    if (normalized === normalizeDashboardFilterName(filter.id) || normalized === normalizeDashboardFilterName(filter.bindsTo ?? '')) {
      variables[name] = value;
      return [name];
    }
  }

  return [];
}

function resolveDashboardFilterBinding(
  filter: NonNullable<DashboardDocument['filters']>[number],
  block: Pick<ManifestBlock, 'allowedFilters' | 'filterBindings'>,
): string | null {
  const candidates = uniqueDashboardStrings([filter.id, filter.bindsTo ?? '']).map(normalizeDashboardFilterName);
  for (const entry of block.filterBindings ?? []) {
    if (candidates.includes(normalizeDashboardFilterName(entry.filter))) return entry.binding;
  }
  if (filter.bindsTo && (block.allowedFilters ?? []).some((item) => normalizeDashboardFilterName(item) === normalizeDashboardFilterName(filter.bindsTo ?? ''))) {
    return filter.bindsTo;
  }
  if ((block.allowedFilters ?? []).some((item) => normalizeDashboardFilterName(item) === normalizeDashboardFilterName(filter.id))) {
    return filter.id;
  }
  return null;
}

function dashboardFilterExpression(binding: string): string | null {
  const trimmed = binding.trim();
  const yearMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)\.year$/i);
  if (yearMatch) {
    const base = dashboardOutputColumn(yearMatch[1]);
    return base ? `EXTRACT(YEAR FROM _dql_filter.${base})` : null;
  }
  const column = dashboardOutputColumn(trimmed);
  return column ? `_dql_filter.${column}` : null;
}

function dashboardOutputColumn(binding: string): string | null {
  const cleaned = binding.replace(/[`"[\]]/g, '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(cleaned)) return null;
  const column = cleaned.split('.').filter(Boolean).at(-1);
  return column && /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ? column : null;
}

function buildDashboardFilterPredicate(input: {
  expression: string;
  filterId: string;
  filterType: NonNullable<DashboardDocument['filters']>[number]['type'];
  value: unknown;
  params: SQLParamSpec[];
  nextPosition: () => number;
  variables: Record<string, unknown>;
}): string | null {
  const range = input.filterType === 'daterange' ? dashboardRangeValue(input.value) : null;
  if (range) {
    const start = addDashboardFilterParam(input, 'start', range.start);
    const end = addDashboardFilterParam(input, 'end', range.end);
    return `${input.expression} BETWEEN $${start.position} AND $${end.position}`;
  }
  const values = Array.isArray(input.value) ? input.value.filter((item) => !isEmptyDashboardFilterValue(item)) : [input.value];
  if (values.length === 0) return null;
  if (values.length === 1) {
    const param = addDashboardFilterParam(input, 'value', values[0]);
    return `${input.expression} = $${param.position}`;
  }
  const placeholders = values.map((value, index) => {
    const param = addDashboardFilterParam(input, `value_${index + 1}`, value);
    return `$${param.position}`;
  });
  return `${input.expression} IN (${placeholders.join(', ')})`;
}

function addDashboardFilterParam(
  input: {
    filterId: string;
    params: SQLParamSpec[];
    nextPosition: () => number;
    variables: Record<string, unknown>;
  },
  suffix: string,
  value: unknown,
): SQLParamSpec {
  const name = `__dashboard_filter_${normalizeDashboardFilterName(input.filterId)}_${suffix}`;
  const uniqueName = input.variables[name] === undefined && !input.params.some((param) => param.name === name)
    ? name
    : `${name}_${input.params.length + 1}`;
  const param = { name: uniqueName, position: input.nextPosition() };
  input.params.push(param);
  input.variables[uniqueName] = value;
  return param;
}

function dashboardRangeValue(value: unknown): { start: unknown; end: unknown } | null {
  if (Array.isArray(value) && value.length >= 2 && !isEmptyDashboardFilterValue(value[0]) && !isEmptyDashboardFilterValue(value[1])) {
    return { start: value[0], end: value[1] };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const start = record.start ?? record.from ?? record.min;
    const end = record.end ?? record.to ?? record.max;
    if (!isEmptyDashboardFilterValue(start) && !isEmptyDashboardFilterValue(end)) return { start, end };
  }
  return null;
}

function normalizeDashboardFilterName(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function stripSqlTerminator(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

function uniqueDashboardStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function resolveDbtMacrosForExecution(
  sql: string,
  projectRoot: string,
  projectConfig: ProjectConfig = {},
): string {
  if (!/\{\{\s*(?:ref|source)\s*\(/i.test(sql)) return sql;
  const manifestPath = resolveDbtManifestPath(projectRoot, projectConfig);
  if (!manifestPath) {
    throw new Error('dbt ref/source macros were found, but target/manifest.json was not available. Run dbt parse or dbt compile, then retry.');
  }
  const manifest = readJsonFile(manifestPath);
  const refs = buildDbtRelationLookup(manifest);
  const unresolved = new Set<string>();

  let rendered = sql.replace(
    /\{\{\s*ref\(\s*(?:(['"])([^'"]+)\1\s*,\s*)?(['"])([^'"]+)\3(?:\s*,[^)]*)?\)\s*\}\}/gi,
    (match: string, _pkgQuote: string | undefined, packageName: string | undefined, _modelQuote: string, modelName: string) => {
      const key = normalizeDbtLookupKey(modelName);
      const scopedKey = packageName ? normalizeDbtLookupKey(`${packageName}.${modelName}`) : key;
      const relation = refs.models.get(scopedKey) ?? refs.models.get(key);
      if (!relation) {
        unresolved.add(packageName ? `ref('${packageName}', '${modelName}')` : `ref('${modelName}')`);
        return match;
      }
      return relation;
    },
  );

  rendered = rendered.replace(
    /\{\{\s*source\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*\)\s*\}\}/gi,
    (match: string, _sourceQuote: string, sourceName: string, _tableQuote: string, tableName: string) => {
      const key = normalizeDbtLookupKey(`${sourceName}.${tableName}`);
      const relation = refs.sources.get(key) ?? refs.sources.get(normalizeDbtLookupKey(tableName));
      if (!relation) {
        unresolved.add(`source('${sourceName}', '${tableName}')`);
        return match;
      }
      return relation;
    },
  );

  if (unresolved.size > 0) {
    throw new Error(`Could not resolve dbt macro${unresolved.size === 1 ? '' : 's'} from manifest.json: ${Array.from(unresolved).join(', ')}.`);
  }
  return rendered;
}

function buildDbtRelationLookup(manifest: unknown): { models: Map<string, string>; sources: Map<string, string> } {
  const models = new Map<string, string>();
  const sources = new Map<string, string>();
  const root = manifest && typeof manifest === 'object' ? manifest as Record<string, unknown> : {};
  const nodes = root.nodes && typeof root.nodes === 'object' ? root.nodes as Record<string, unknown> : {};
  const manifestSources = root.sources && typeof root.sources === 'object' ? root.sources as Record<string, unknown> : {};

  for (const [uniqueId, rawNode] of Object.entries(nodes)) {
    const node = rawNode && typeof rawNode === 'object' ? rawNode as Record<string, unknown> : null;
    if (!node || node.resource_type !== 'model') continue;
    const relation = dbtRelationName(node);
    if (!relation) continue;
    const name = stringField(node, 'name');
    const alias = stringField(node, 'alias');
    const packageName = uniqueId.split('.')[1];
    for (const key of [name, alias, packageName && name ? `${packageName}.${name}` : null, uniqueId]) {
      if (key) models.set(normalizeDbtLookupKey(key), relation);
    }
  }

  for (const [uniqueId, rawSource] of Object.entries(manifestSources)) {
    const source = rawSource && typeof rawSource === 'object' ? rawSource as Record<string, unknown> : null;
    if (!source) continue;
    const relation = dbtRelationName(source);
    if (!relation) continue;
    const sourceName = stringField(source, 'source_name');
    const name = stringField(source, 'name');
    const identifier = stringField(source, 'identifier');
    for (const key of [
      sourceName && name ? `${sourceName}.${name}` : null,
      sourceName && identifier ? `${sourceName}.${identifier}` : null,
      name,
      identifier,
      uniqueId,
    ]) {
      if (key) sources.set(normalizeDbtLookupKey(key), relation);
    }
  }

  return { models, sources };
}

function dbtRelationName(node: Record<string, unknown>): string | null {
  const relationName = stringField(node, 'relation_name');
  if (relationName) return relationName;
  const database = stringField(node, 'database');
  const schema = stringField(node, 'schema');
  const alias = stringField(node, 'alias') ?? stringField(node, 'identifier') ?? stringField(node, 'name');
  if (database && schema && alias) return `${database}.${schema}.${alias}`;
  if (schema && alias) return `${schema}.${alias}`;
  return alias ?? null;
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeDbtLookupKey(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

const AGENT_PREVIEW_FORBIDDEN_SQL = [
  'alter',
  'analyze',
  'attach',
  'call',
  'copy',
  'create',
  'delete',
  'detach',
  'drop',
  'export',
  'grant',
  'import',
  'insert',
  'install',
  'load',
  'merge',
  'pragma',
  'reset',
  'revoke',
  'set',
  'truncate',
  'update',
  'vacuum',
];

export function buildAgentPreviewSql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error('Generated SQL preview is empty.');
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '').trim();
  const readOnlyError = readOnlySqlValidationError(withoutTrailingSemicolon, 'Generated SQL preview');
  if (readOnlyError) throw new Error(readOnlyError);
  return `SELECT * FROM (\n${withoutTrailingSemicolon}\n) AS dql_agent_preview LIMIT 200`;
}

function readOnlySqlValidationError(sql: string, subject: string): string | null {
  const scanSql = stripSqlStringsAndComments(sql).trim();
  if (!/^(select|with)\b/i.test(scanSql)) {
    return `${subject} only supports read-only SELECT or WITH queries.`;
  }
  if (scanSql.includes(';')) {
    return `${subject} only supports one statement.`;
  }
  const forbiddenPattern = new RegExp(`\\b(${AGENT_PREVIEW_FORBIDDEN_SQL.join('|')})\\b`, 'i');
  const forbidden = scanSql.match(forbiddenPattern)?.[1];
  if (forbidden) {
    return `${subject} rejected unsupported statement keyword: ${forbidden.toUpperCase()}.`;
  }
  return null;
}

function stripSqlStringsAndComments(sql: string): string {
  let output = '';
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (current === '-' && next === '-') {
      output += '  ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      if (index < sql.length) output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        output += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < sql.length) {
        output += '  ';
        index += 1;
      }
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      output += ' ';
      while (index + 1 < sql.length) {
        index += 1;
        output += sql[index] === '\n' ? '\n' : ' ';
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 1;
            output += ' ';
            continue;
          }
          break;
        }
      }
      continue;
    }
    output += current;
  }
  return output;
}

export interface PreparedSemanticSql {
  sql: string;
  semanticRefs: { metrics: string[]; dimensions: string[] };
  unresolvedRefs: string[];
}

/**
 * Shared resolver for `@metric(name)` / `@dim(name)` refs in raw SQL.
 * Used by notebook SQL execution and Block Studio validation so both paths
 * behave identically. If the SQL has no refs, returns it unchanged.
 */
export function prepareSemanticSql(
  sql: string,
  semanticLayer: SemanticLayer | undefined,
): PreparedSemanticSql {
  if (!hasSemanticRefs(sql)) {
    return { sql, semanticRefs: { metrics: [], dimensions: [] }, unresolvedRefs: [] };
  }
  const resolution = resolveSemanticRefs(sql, semanticLayer);
  return {
    sql: resolution.resolvedSql,
    semanticRefs: {
      metrics: resolution.resolvedMetrics,
      dimensions: resolution.resolvedDimensions,
    },
    unresolvedRefs: resolution.unresolvedRefs,
  };
}

function needsSemanticTableMapping(cell: NotebookCell): boolean {
  if (cell.type === 'sql') return hasSemanticRefs(cell.source);
  if (cell.type !== 'dql') return false;
  return hasSemanticRefs(cell.source) || /\btype\s*=\s*"semantic"/i.test(cell.source);
}

export function normalizeProjectConnection(connection: ConnectionConfig, projectRoot: string): ConnectionConfig {
  const normalized: ConnectionConfig = expandConnectionEnvPlaceholders({ ...connection });

  if ((normalized.driver === 'file' || normalized.driver === 'duckdb') && normalized.filepath && normalized.filepath !== ':memory:' && !isAbsoluteLikePath(normalized.filepath)) {
    normalized.filepath = resolve(projectRoot, normalized.filepath);
  }

  if (normalized.driver === 'file' || normalized.driver === 'duckdb' || normalized.driver === 'snowflake') {
    normalized.moduleSearchPaths = connectorModuleSearchPaths(projectRoot);
  }

  if (normalized.driver === 'sqlite' && normalized.database && normalized.database !== ':memory:' && !isAbsoluteLikePath(normalized.database)) {
    normalized.database = resolve(projectRoot, normalized.database);
  }

  return normalized;
}

function expandConnectionEnvPlaceholders(connection: ConnectionConfig): ConnectionConfig {
  const expanded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(connection)) {
    expanded[key] = typeof value === 'string'
      ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, envKey: string) => process.env[envKey] ?? match)
      : value;
  }
  return expanded as unknown as ConnectionConfig;
}

export function resolveProjectRelativeSqlPaths(sql: string, projectRoot: string, dataDir?: string): string {
  const resolvedRoot = resolve(projectRoot);
  const normalizedDataDir = typeof dataDir === 'string' && dataDir.trim().length > 0
    ? resolve(projectRoot, dataDir)
    : join(resolvedRoot, 'data');

  return sql.replace(
    /\b(read_csv_auto|read_csv|read_parquet|read_json_auto|read_json|read_ndjson_auto|read_ndjson|read_xlsx|parquet_scan)\s*\(\s*(['"])(\.{1,2}\/[^'"]*)\2/gi,
    (_match, fnName: string, quote: string, relativePath: string) => {
      const absolutePath = relativePath.startsWith('./data/')
        ? join(normalizedDataDir, relativePath.slice('./data/'.length))
        : resolve(resolvedRoot, relativePath);
      return `${fnName}(${quote}${absolutePath.replaceAll('\\', '/')}${quote}`;
    },
  );
}

function shouldResolveProjectPaths(connection: ConnectionConfig): boolean {
  return connection.driver === 'file' || connection.driver === 'duckdb' || connection.driver === 'sqlite';
}

function isAbsoluteLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

function readJSON(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(rootDir: string, requestPath: string): string | null {
  const normalized = normalize(requestPath).replace(/^([.][.][/\\])+/, '');
  const fullPath = resolve(rootDir, `.${normalized.startsWith('/') ? normalized : `/${normalized}`}`);
  const resolvedRoot = resolve(rootDir);
  return fullPath.startsWith(resolvedRoot) ? fullPath : null;
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    default:
      return 'text/plain; charset=utf-8';
  }
}

function listProjectFiles(projectRoot: string): string[] {
  const allowed = new Set(['.dql', '.sql', '.md', '.json', '.csv', '.yaml', '.yml', '.dqlnb']);
  const files: string[] = [];

  walk(projectRoot);
  return files.sort();

  function walk(currentDir: string): void {
    for (const entry of readdirSync(currentDir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') {
        continue;
      }

      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (allowed.has(extname(entry))) {
        files.push(fullPath.slice(projectRoot.length + 1));
      }
    }
  }
}

function resolveNotebook(projectRoot: string, projectTitle: string) {
  const notebookPath = join(projectRoot, 'notebooks', 'welcome.dqlnb');
  if (existsSync(notebookPath)) {
    return deserializeNotebook(readFileSync(notebookPath, 'utf-8'));
  }
  return createWelcomeNotebook('starter', projectTitle);
}

function normalizeNotebookCell(value: unknown): NotebookCell | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<NotebookCell>;
  if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string' || typeof candidate.source !== 'string') {
    return null;
  }

  return {
    id: candidate.id,
    type: candidate.type as NotebookCell['type'],
    source: candidate.source,
    title: typeof candidate.title === 'string' ? candidate.title : undefined,
    config: candidate.config,
  };
}

function resolveNotebookBlockReferenceCell(
  cell: NotebookCell,
  projectRoot: string,
): {
  cell: NotebookCell;
  blockName?: string;
  blockPath?: string;
  domain?: string;
} {
  if (cell.type !== 'dql') return { cell };
  const match = cell.source.trim().match(/^@block\(\s*["']([^"']+)["']\s*\)$/i);
  if (!match) return { cell };

  const ref = match[1].trim();
  const manifest = buildManifest({ projectRoot });
  const block = manifest.blocks[ref] ?? Object.values(manifest.blocks).find((candidate) => candidate.filePath === ref);
  if (!block) {
    throw new Error(`Block reference "${ref}" could not be resolved.`);
  }

  const blockPath = join(projectRoot, block.filePath);
  if (!existsSync(blockPath)) {
    throw new Error(`Block "${block.name}" file is missing: ${block.filePath}`);
  }

  return {
    cell: {
      ...cell,
      title: cell.title ?? block.name,
      source: readFileSync(blockPath, 'utf-8'),
    },
    blockName: block.name,
    blockPath: block.filePath,
    domain: block.domain,
  };
}

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  return Boolean(value && typeof value === 'object' && 'driver' in (value as Record<string, unknown>));
}

// ── dql-notebook helper functions ─────────────────────────────────────────────

type NotebookFileEntry = {
  name: string;
  path: string;
  type: 'notebook' | 'workbook' | 'block' | 'dashboard' | 'term' | 'business_view';
  folder: string;
};

function scanNotebookFiles(projectRoot: string): NotebookFileEntry[] {
  const result: NotebookFileEntry[] = [];
  const folderMap: Record<string, NotebookFileEntry['type']> = {
    notebooks: 'notebook',
    workbooks: 'workbook',
    blocks: 'block',
    dashboards: 'dashboard',
    terms: 'term',
    'business-views': 'business_view',
  };
  for (const [folder, type] of Object.entries(folderMap)) {
    const dir = join(projectRoot, folder);
    if (!existsSync(dir)) continue;
    collect(dir, folder, type);
  }
  return result;

  function collect(currentDir: string, relativeDir: string, type: NotebookFileEntry['type']): void {
    try {
      for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = join(currentDir, entry.name);
        const relativePath = `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          collect(fullPath, relativePath, type);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.dql') && !entry.name.endsWith('.dqlnb')) continue;
        const fallbackName = entry.name.replace(/\.(dql|dqlnb)$/, '');
        result.push({
          name: inferDqlArtifactName(fullPath, type, fallbackName),
          path: relativePath,
          type,
          folder: relativeDir.split('/')[0] ?? relativeDir,
        });
      }
    } catch { /* skip unreadable dirs */ }
  }
}

function inferDqlArtifactName(fullPath: string, type: NotebookFileEntry['type'], fallbackName: string): string {
  if (!fullPath.endsWith('.dql')) return fallbackName;
  const expectedKind: Record<string, string> = {
    block: 'BlockDecl',
    dashboard: 'Dashboard',
    term: 'TermDecl',
    business_view: 'BusinessViewDecl',
  };
  const kind = expectedKind[type];
  if (!kind) return fallbackName;
  try {
    const ast = new Parser(readFileSync(fullPath, 'utf-8')).parse();
    const statement = ast.statements.find((item: any) => item.kind === kind && typeof item.name === 'string') as any;
    return statement?.name ?? fallbackName;
  } catch {
    return fallbackName;
  }
}

function scanDataFiles(projectRoot: string): { name: string; path: string; columns: never[] }[] {
  const dataDir = join(projectRoot, 'data');
  if (!existsSync(dataDir)) return [];
  try {
    return readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(csv|parquet|json)$/.test(e.name))
      .map((e) => ({ name: e.name, path: `data/${e.name}`, columns: [] }));
  } catch { return []; }
}

interface UserPrefs {
  favorites: string[];
  recentlyUsed: string[];
}

function readUserPrefs(userPrefsPath: string): UserPrefs {
  try {
    if (!existsSync(userPrefsPath)) {
      return { favorites: [], recentlyUsed: [] };
    }
    const raw = JSON.parse(readFileSync(userPrefsPath, 'utf-8')) as Partial<UserPrefs>;
    return {
      favorites: Array.isArray(raw.favorites) ? raw.favorites.map(String) : [],
      recentlyUsed: Array.isArray(raw.recentlyUsed) ? raw.recentlyUsed.map(String) : [],
    };
  } catch {
    return { favorites: [], recentlyUsed: [] };
  }
}

function writeUserPrefs(userPrefsPath: string, prefs: UserPrefs): void {
  writeFileSync(userPrefsPath, JSON.stringify(prefs, null, 2) + '\n', 'utf-8');
}

async function introspectSchema(
  executor: QueryExecutor,
  connection: ConnectionConfig,
): Promise<{
  tables: Array<{ schema: string; name: string; path: string; type?: string }>;
  columnsByPath: Map<string, Array<{ name: string; type: string }>>;
}> {
  let tables: Array<{ schema: string; name: string; path: string; type?: string }> = [];
  let columnsByPath = new Map<string, Array<{ name: string; type: string }>>();

  // Tier 1: information_schema (PG, MySQL, Snowflake, MSSQL, DuckDB, Redshift, Fabric, Databricks)
  try {
    const catalogRows = await executor.executeQuery(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY table_schema, table_name`,
      [], {}, connection,
    );
    tables = catalogRows.rows.map((row) => {
      const schema = String(row['table_schema'] ?? row['TABLE_SCHEMA'] ?? 'default');
      const name = String(row['table_name'] ?? row['TABLE_NAME'] ?? '');
      const type = String(row['table_type'] ?? row['TABLE_TYPE'] ?? 'TABLE');
      const path = schema ? `${schema}.${name}` : name;
      return { schema, name, path, type };
    });

    const columnRows = await executor.executeQuery(
      `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY table_schema, table_name, ordinal_position`,
      [], {}, connection,
    );
    columnsByPath = columnRows.rows.reduce((map, row) => {
      const schema = String(row['table_schema'] ?? row['TABLE_SCHEMA'] ?? 'default');
      const tableName = String(row['table_name'] ?? row['TABLE_NAME'] ?? '');
      const path = schema ? `${schema}.${tableName}` : tableName;
      const next = map.get(path) ?? [];
      next.push({
        name: String(row['column_name'] ?? row['COLUMN_NAME'] ?? ''),
        type: String(row['data_type'] ?? row['DATA_TYPE'] ?? ''),
      });
      map.set(path, next);
      return map;
    }, new Map<string, Array<{ name: string; type: string }>>());
    return { tables, columnsByPath };
  } catch {
    // Tier 1 failed — try connector methods
  }

  // Tier 2: connector.listTables() + connector.listColumns() (SQLite, BigQuery, Athena, ClickHouse, Trino)
  try {
    const connector = await executor.getConnector(connection);
    if (typeof connector.listTables === 'function') {
      const rawTables = await connector.listTables();
      tables = rawTables.map((t) => {
        const schema = t.schema || 'default';
        const path = t.schema ? `${t.schema}.${t.name}` : t.name;
        return { schema, name: t.name, path, type: t.type };
      });
    }
    if (typeof connector.listColumns === 'function') {
      const rawColumns = await connector.listColumns();
      columnsByPath = rawColumns.reduce((map, col) => {
        const schema = col.schema || 'default';
        const path = schema ? `${schema}.${col.table}` : col.table;
        const next = map.get(path) ?? [];
        next.push({ name: col.name, type: col.dataType });
        map.set(path, next);
        return map;
      }, new Map<string, Array<{ name: string; type: string }>>());
    }
  } catch {
    // Tier 3: tables only, no columns — already have what we have
  }

  return { tables, columnsByPath };
}

function buildDatabaseSchemaTree(
  projectRoot: string,
  executor: QueryExecutor,
  connection: ConnectionConfig | null,
): Promise<Array<{
  id: string;
  label: string;
  kind: 'schema' | 'table' | 'column';
  path?: string;
  type?: string;
  children?: Array<{ id: string; label: string; kind: 'schema' | 'table' | 'column'; path?: string; type?: string; children?: unknown[] }>;
}>> {
  return (async () => {
    const dataFiles = scanDataFiles(projectRoot);
    const { tables: dbTables, columnsByPath: dbColumnsByPath } = connection
      ? await introspectSchema(executor, connection)
      : { tables: [], columnsByPath: new Map<string, Array<{ name: string; type: string }>>() };

    const schemaMap = new Map<string, Array<{ name: string; path: string; type?: string }>>();
    for (const table of dbTables) {
      const schemaName = table.schema || 'default';
      const existing = schemaMap.get(schemaName) ?? [];
      existing.push({ name: table.name, path: table.path, type: table.type });
      schemaMap.set(schemaName, existing);
    }

    const databaseNodes = Array.from(schemaMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([schemaName, tables]) => ({
        id: `db-schema:${schemaName}`,
        label: schemaName,
        kind: 'schema' as const,
        children: tables
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((table) => ({
            id: `db-table:${table.path}`,
            label: table.name,
            kind: 'table' as const,
            path: table.path,
            type: table.type,
            children: (dbColumnsByPath.get(table.path) ?? []).map((column) => ({
              id: `db-column:${table.path}:${column.name}`,
              label: column.name,
              kind: 'column' as const,
              path: table.path,
              type: column.type,
            })),
          })),
      }));

    // Eagerly resolve file columns via DuckDB DESCRIBE
    if (dataFiles.length > 0) {
      const fileChildren: Array<{
        id: string; label: string; kind: 'table'; path: string; type: string;
        children: Array<{ id: string; label: string; kind: 'column'; path: string; type: string }>;
      }> = [];
      for (const file of dataFiles) {
        let columns: Array<{ id: string; label: string; kind: 'column'; path: string; type: string }> = [];
        if (connection) {
          try {
            const ext = file.name.split('.').pop()?.toLowerCase();
            const readFn = ext === 'parquet' ? 'read_parquet' : ext === 'json' ? 'read_json_auto' : 'read_csv_auto';
            const descResult = await executor.executeQuery(
              `DESCRIBE SELECT * FROM ${readFn}('${file.path.replace(/'/g, "''")}') LIMIT 0`,
              [], {}, connection,
            );
            columns = descResult.rows.map((row) => ({
              id: `db-column:${file.path}:${String(row['column_name'] ?? '')}`,
              label: String(row['column_name'] ?? ''),
              kind: 'column' as const,
              path: file.path,
              type: String(row['column_type'] ?? ''),
            }));
          } catch {
            // file column discovery failed — empty children is fine
          }
        }
        fileChildren.push({
          id: `db-table:${file.path}`,
          label: file.name,
          kind: 'table',
          path: file.path,
          type: 'FILE',
          children: columns,
        });
      }
      databaseNodes.unshift({
        id: 'db-schema:files',
        label: 'files',
        kind: 'schema' as const,
        children: fileChildren,
      });
    }

    return databaseNodes;
  })();
}

export function openBlockStudioDocument(
  projectRoot: string,
  relativePath: string,
  semanticLayer?: SemanticLayer,
): {
  path: string;
  source: string;
  metadata: {
    name: string;
    path: string | null;
    domain: string;
    description: string;
    owner: string;
    tags: string[];
    reviewStatus?: string;
  };
  companionPath: string | null;
  validation: ReturnType<typeof validateBlockStudioSource>;
} {
  const normalizedPath = normalize(relativePath).replace(/^\/+/, '');
  if (!isBlockStudioBlockPath(normalizedPath)) {
    throw new Error('Invalid block path');
  }
  const absPath = join(projectRoot, normalizedPath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${normalizedPath}`);
  }
  const source = readFileSync(absPath, 'utf-8');
  const companionPath = blockCompanionRelativePath(normalizedPath);
  const companion = companionPath ? readBlockCompanionFile(projectRoot, companionPath) : null;
  const parsedMetadata = parseBlockSourceMetadata(source);
  const fileName = normalizedPath.split('/').pop()?.replace(/\.dql$/, '') ?? 'block';
  const metadata = {
    name: parsedMetadata.name || companion?.name || fileName,
    path: normalizedPath,
    domain: parsedMetadata.domain || companion?.domain || inferBlockStudioPathDomain(normalizedPath) || 'uncategorized',
    description: parsedMetadata.description || companion?.description || '',
    owner: parsedMetadata.owner || companion?.owner || '',
    tags: parsedMetadata.tags.length > 0 ? parsedMetadata.tags : companion?.tags ?? [],
    reviewStatus: parsedMetadata.status || companion?.reviewStatus || 'draft',
  };
  return {
    path: normalizedPath,
    source,
    metadata,
    companionPath: companionPath && existsSync(join(projectRoot, companionPath)) ? companionPath : null,
    validation: validateBlockStudioSource(source, semanticLayer),
  };
}

type BlockStudioDiagnostic = { severity: 'error' | 'warning' | 'info'; message: string; code?: string };

interface ParsedSemanticBlockConfig {
  blockType: 'semantic' | 'custom';
  metric?: string;
  metrics: string[];
  dimensions: string[];
  timeDimension?: string;
  granularity?: string;
  limit?: number;
}

interface RuntimeSemanticQueryRequest {
  metrics: string[];
  dimensions: string[];
  filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
  timeDimension?: { name: string; granularity: string };
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  savedQuery?: string;
  engine?: 'native' | 'metricflow';
}

function parseBlockStudioArrayField(source: string, key: string): string[] {
  const match = source.match(new RegExp(`\\b${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'i'));
  if (!match) return [];
  return (match[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)).filter(Boolean);
}

function parseBlockStudioStringField(source: string, key: string): string | undefined {
  return source.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? undefined;
}

function parseSemanticBlockConfig(source: string): ParsedSemanticBlockConfig {
  const blockType = (parseBlockStudioStringField(source, 'type') ?? 'custom').toLowerCase() === 'semantic'
    ? 'semantic'
    : 'custom';
  const metric = parseBlockStudioStringField(source, 'metric');
  const metrics = parseBlockStudioArrayField(source, 'metrics');
  const dimensions = parseBlockStudioArrayField(source, 'dimensions');
  const timeDimension = parseBlockStudioStringField(source, 'time_dimension');
  const granularity = parseBlockStudioStringField(source, 'granularity');
  const limitMatch = source.match(/\blimit\s*=\s*(\d+)/i);
  return {
    blockType,
    metric,
    metrics,
    dimensions,
    timeDimension,
    granularity,
    limit: limitMatch ? Number.parseInt(limitMatch[1], 10) : undefined,
  };
}

export async function resolveSemanticTableMapping(
  executor: QueryExecutor,
  connection: ConnectionConfig,
  semanticLayer?: SemanticLayer,
): Promise<Record<string, string> | undefined> {
  if (!semanticLayer) return undefined;
  try {
    const tablesResult = await executor.executeQuery(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY table_schema, table_name
       LIMIT 2000`,
      [], {}, connection,
    );
    return buildSemanticTableMapping(semanticLayer, tablesResult.rows);
  } catch {
    return undefined;
  }
}

export function buildSemanticTableMapping(
  semanticLayer: SemanticLayer,
  rows: Array<Record<string, unknown>>,
): Record<string, string> | undefined {
  const dbTableNames = new Set<string>();
  const schemaQualified = new Map<string, string>();
  for (const row of rows) {
    const schema = String(row['table_schema'] ?? '');
    const name = String(row['table_name'] ?? '');
    if (!name) continue;
    dbTableNames.add(name);
    schemaQualified.set(name, schema ? `${schema}.${name}` : name);
  }

  const tableMapping: Record<string, string> = {};
  const allSemanticTables = new Set<string>();
  for (const metric of semanticLayer.listMetrics()) allSemanticTables.add(metric.table);
  for (const dimension of semanticLayer.listDimensions()) allSemanticTables.add(dimension.table);
  for (const semTable of allSemanticTables) {
    if (dbTableNames.has(semTable) && schemaQualified.has(semTable)) {
      tableMapping[semTable] = schemaQualified.get(semTable)!;
    }
  }
  return Object.keys(tableMapping).length > 0 ? tableMapping : undefined;
}

function isDbtSemanticRuntime(
  projectConfig: ProjectConfig,
  detectedProvider: string | null | undefined,
  semanticLayer?: SemanticLayer | null,
): boolean {
  if (projectConfig.semanticLayer?.provider === 'dbt' || projectConfig.dbt?.projectDir || detectedProvider === 'dbt') return true;
  return Boolean(semanticLayer?.listMetrics().some((metric) => metric.source?.provider === 'dbt'));
}

function composeRuntimeSemanticQuery(
  request: RuntimeSemanticQueryRequest,
  semanticLayer: SemanticLayer,
  context: {
    projectRoot: string;
    projectConfig: ProjectConfig;
    detectedProvider: string | null | undefined;
    driver?: ConnectionConfig['driver'];
    tableMapping?: Record<string, string>;
  },
): { sql: string; joins: string[]; tables: string[]; engine: 'native' | 'metricflow' } | null {
  const useMetricFlow = request.engine === 'metricflow' || (
    request.engine !== 'native' &&
    isDbtSemanticRuntime(context.projectConfig, context.detectedProvider, semanticLayer)
  );

  if (useMetricFlow) {
    const effectiveSemanticConfig = resolveProjectSemanticConfig(context.projectConfig, context.projectRoot);
    const dbtProjectPath = effectiveSemanticConfig?.provider === 'dbt'
      ? effectiveSemanticConfig.projectPath
      : context.projectConfig.dbt?.projectDir;
    const compiled = compileMetricFlowQuery({
      projectRoot: context.projectRoot,
      dbtProjectPath,
      metrics: request.metrics,
      dimensions: request.dimensions,
      filters: request.filters,
      timeDimension: request.timeDimension,
      orderBy: request.orderBy,
      limit: request.limit,
      savedQuery: request.savedQuery,
    });
    return {
      sql: compiled.sql,
      joins: [],
      tables: [],
      engine: 'metricflow',
    };
  }

  const composed = semanticLayer.composeQuery({
    metrics: request.metrics,
    dimensions: request.dimensions,
    filters: request.filters as Array<{ dimension: string; operator: string; values: string[] }> | undefined,
    limit: request.limit,
    timeDimension: request.timeDimension,
    orderBy: request.orderBy,
    driver: context.driver,
    tableMapping: context.tableMapping,
  });
  return composed ? { ...composed, engine: 'native' } : null;
}

function composeSemanticBlockSql(
  source: string,
  semanticLayer: SemanticLayer,
  options?: {
    driver?: ConnectionConfig['driver'];
    tableMapping?: Record<string, string>;
    projectRoot?: string;
    projectConfig?: ProjectConfig;
    detectedProvider?: string | null;
  },
): { sql: string | null; diagnostics: BlockStudioDiagnostic[]; semanticRefs: { metrics: string[]; dimensions: string[]; segments: string[] } } {
  const config = parseSemanticBlockConfig(source);
  const metrics = config.metrics.length > 0
    ? config.metrics
    : config.metric
      ? [config.metric]
      : [];
  const semanticRefs = {
    metrics,
    dimensions: config.dimensions,
    segments: [] as string[],
  };
  const diagnostics: BlockStudioDiagnostic[] = [];

  if (config.blockType !== 'semantic') {
    return { sql: null, diagnostics, semanticRefs };
  }

  if (metrics.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'semantic_metric_missing',
      message: 'Semantic block is missing a metric. Add metric = "metric_name" or metrics = ["metric_name"].',
    });
    return { sql: null, diagnostics, semanticRefs };
  }

  if (config.timeDimension && !config.granularity) {
    diagnostics.push({
      severity: 'error',
      code: 'semantic_granularity_missing',
      message: `Semantic block selects time_dimension = "${config.timeDimension}" but is missing granularity.`,
    });
  }

  const refValidation = semanticLayer.validateReferences([...metrics, ...config.dimensions]);
  for (const unknown of refValidation.unknown) {
    diagnostics.push({
      severity: 'error',
      code: 'semantic_ref',
      message: `Unknown semantic reference: ${unknown}`,
    });
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { sql: null, diagnostics, semanticRefs };
  }

  let composed: { sql: string; joins: string[]; tables: string[] } | null;
  try {
    composed = options?.projectRoot && options.projectConfig
      ? composeRuntimeSemanticQuery({
          metrics,
          dimensions: config.dimensions,
          timeDimension: config.timeDimension && config.granularity
            ? { name: config.timeDimension, granularity: config.granularity }
            : undefined,
          limit: config.limit,
        }, semanticLayer, {
          projectRoot: options.projectRoot,
          projectConfig: options.projectConfig,
          detectedProvider: options.detectedProvider ?? null,
          driver: options.driver,
          tableMapping: options.tableMapping,
        })
      : semanticLayer.composeQuery({
          metrics,
          dimensions: config.dimensions,
          timeDimension: config.timeDimension && config.granularity
            ? { name: config.timeDimension, granularity: config.granularity }
            : undefined,
          limit: config.limit,
          driver: options?.driver,
          tableMapping: options?.tableMapping,
        });
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: error instanceof MetricFlowUnavailableError ? 'metricflow_unavailable' : 'semantic_compose_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    return { sql: null, diagnostics, semanticRefs };
  }
  if (!composed) {
    diagnostics.push({
      severity: 'error',
      code: 'semantic_compose_failed',
      message: `Could not compose SQL for semantic block metrics: [${metrics.join(', ')}].`,
    });
    return { sql: null, diagnostics, semanticRefs };
  }

  return {
    sql: composed.sql,
    diagnostics,
    semanticRefs,
  };
}

function resolveCustomBlockSql(
  sql: string | null,
  semanticLayer?: SemanticLayer,
): {
  sql: string | null;
  diagnostics: BlockStudioDiagnostic[];
  semanticRefs: { metrics: string[]; dimensions: string[]; segments: string[] };
} {
  if (!sql) {
    return {
      sql: null,
      diagnostics: [],
      semanticRefs: { metrics: [], dimensions: [], segments: [] },
    };
  }

  const semanticRefs = extractBlockStudioSemanticReferences(sql);
  if (!hasSemanticRefs(sql)) {
    return { sql, diagnostics: [], semanticRefs };
  }

  const resolution = resolveSemanticRefs(sql, semanticLayer);
  if (resolution.unresolvedRefs.length > 0) {
    return {
      sql: null,
      diagnostics: resolution.unresolvedRefs.map((unresolved) => ({
        severity: 'error' as const,
        code: 'semantic_ref',
        message: `Unknown semantic reference: ${unresolved}`,
      })),
      semanticRefs,
    };
  }

  return {
    sql: resolution.resolvedSql,
    diagnostics: [],
    semanticRefs: {
      metrics: resolution.resolvedMetrics,
      dimensions: resolution.resolvedDimensions,
      segments: semanticRefs.segments,
    },
  };
}

export function validateBlockStudioSource(
  source: string,
  semanticLayer?: SemanticLayer,
): {
  valid: boolean;
  diagnostics: BlockStudioDiagnostic[];
  semanticRefs: { metrics: string[]; dimensions: string[]; segments: string[] };
  chartConfig?: { chart?: string; x?: string; y?: string; color?: string; title?: string };
  executableSql?: string | null;
} {
  const diagnostics: BlockStudioDiagnostic[] = [];
  const semanticConfig = parseSemanticBlockConfig(source);
  if (semanticConfig.blockType !== 'semantic') {
    try {
      const parser = new Parser(source, '<block-studio>');
      parser.parse();
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'syntax',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    const hasBlockHeader = /\bblock\s+"[^"]+"\s*\{/i.test(source);
    const hasClosingBrace = /\}\s*$/m.test(source);
    if (!hasBlockHeader || !hasClosingBrace) {
      diagnostics.push({
        severity: 'error',
        code: 'semantic_shape',
        message: 'Semantic block must use block "Name" { ... } structure.',
      });
    }
  }

  let semanticRefs = extractBlockStudioSemanticReferences(source);
  if (semanticConfig.blockType === 'semantic') {
    const selectedMetrics = semanticConfig.metrics.length > 0
      ? semanticConfig.metrics
      : semanticConfig.metric
        ? [semanticConfig.metric]
        : [];
    semanticRefs = {
      metrics: selectedMetrics,
      dimensions: semanticConfig.dimensions,
      segments: semanticRefs.segments,
    };
  }

  let executableSql = extractBlockStudioSql(source);
  if (semanticConfig.blockType === 'semantic') {
    if (semanticLayer) {
      const semanticCompose = composeSemanticBlockSql(source, semanticLayer);
      semanticRefs = semanticCompose.semanticRefs;
      diagnostics.push(...semanticCompose.diagnostics);
      executableSql = semanticCompose.sql;
    } else {
      diagnostics.push({
        severity: 'error',
        code: 'semantic_layer_missing',
        message: 'Semantic block cannot run because no semantic layer is configured.',
      });
      executableSql = null;
    }
  } else if (semanticLayer) {
    const resolvedCustomSql = resolveCustomBlockSql(executableSql, semanticLayer);
    semanticRefs = resolvedCustomSql.semanticRefs;
    diagnostics.push(...resolvedCustomSql.diagnostics);
    executableSql = resolvedCustomSql.sql;
  }

  if (executableSql && semanticConfig.blockType !== 'semantic') {
    const readOnlyError = readOnlySqlValidationError(executableSql.trim().replace(/;\s*$/, '').trim(), 'Block SQL');
    if (readOnlyError) {
      diagnostics.push({
        severity: 'error',
        code: 'sql_read_only',
        message: readOnlyError,
      });
    }
  }

  const chartConfig = extractBlockStudioChartConfig(source);
  if (!chartConfig) {
    diagnostics.push({
      severity: 'warning',
      code: 'visualization_missing',
      message: 'Block has no visualization section yet.',
    });
  }

  if (!executableSql) {
    diagnostics.push(semanticConfig.blockType === 'semantic'
      ? {
          severity: 'warning',
          code: 'semantic_not_runnable',
          message: 'Semantic block is not runnable yet. Select a metric and complete any required time settings.',
        }
      : {
          severity: 'warning',
          code: 'sql_missing',
          message: 'No executable SQL found in the block source.',
        });
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    semanticRefs,
    chartConfig: chartConfig ?? undefined,
    executableSql,
  };
}

export interface CreateDqlGenerationSessionForProjectOptions {
  inputPath?: string;
  inputMode?: BlockStudioImportInputMode;
  sources?: BlockStudioImportSource[];
  sourceKind?: BlockStudioImportSourceKind | 'raw-sql';
  domain?: string;
  owner?: string;
  tags?: string[];
  provider?: string;
}

export async function createDqlGenerationSessionForProject(
  projectRoot: string,
  options: CreateDqlGenerationSessionForProjectOptions,
  semanticLayer?: SemanticLayer,
): Promise<DqlGenerationSession> {
  const deterministicOnly = isDeterministicDqlGenerationProvider(options.provider);
  const requestedProvider = !deterministicOnly && isProviderSettingsId(options.provider) ? options.provider : undefined;
  const provider = deterministicOnly ? null : await createBlockStudioAssistProvider(projectRoot, requestedProvider);
  const session = createBlockStudioImportSession(projectRoot, {
    inputPath: options.inputPath ?? '',
    inputMode: options.inputMode,
    sources: options.sources,
    sourceKind: options.sourceKind ?? 'raw-sql',
    domain: options.domain,
    owner: options.owner,
    tags: options.tags,
  });

  const warnings: string[] = [];
  const nextCandidates: DqlGenerationCandidate[] = [];
  let contextObjectCount = 0;
  for (const candidate of session.candidates) {
    const contextPack = await buildDqlGenerationContextPack(projectRoot, candidate).catch((error) => {
      warnings.push(`Context pack failed for ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    contextObjectCount += contextPack?.objects.length ?? 0;
    const evidence = contextPack ? dqlGenerationEvidenceFromContext(contextPack, candidate) : deterministicDqlGenerationEvidence(candidate);
    let patch = deterministicDqlGenerationPatch(candidate, evidence);
    let generatorName = 'local-deterministic';
    let generationMode: 'ai' | 'deterministic' = 'deterministic';
    if (provider) {
      const aiPatch = await buildAiDqlGenerationPatch(provider, candidate, evidence, contextPack).catch((error) => {
        warnings.push(`AI generation fell back for ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (aiPatch) {
        patch = mergeDqlGenerationPatch(patch, aiPatch, candidate, evidence);
        generatorName = provider.name;
        generationMode = 'ai';
      }
    }
    const similarity = buildDqlGenerationSimilarityMatches(candidate, patch, contextPack);
    patch = {
      ...patch,
      similarityMatches: similarity.matches,
      recommendedAction: similarity.recommendedAction,
    };
    for (const warning of patch.warnings ?? []) warnings.push(`${candidate.name}: ${warning}`);
    const enriched = updateBlockStudioImportCandidate(projectRoot, session.id, candidate.id, {
      name: patch.name,
      domain: patch.domain,
      description: patch.description,
      owner: patch.owner,
      tags: patch.tags,
      terms: patch.terms,
      pattern: patch.pattern,
      grain: patch.grain,
      entities: patch.entities,
      outputs: patch.outputs,
      dimensions: patch.dimensions,
      allowedFilters: patch.allowedFilters,
      parameterPolicy: patch.parameterPolicy,
      filterBindings: patch.filterBindings,
      parameterDecisions: patch.parameterDecisions,
      similarityMatches: patch.similarityMatches,
      recommendedAction: patch.recommendedAction,
      sourceSystems: patch.sourceSystems,
      replacementFor: patch.replacementFor,
      reviewCadence: patch.reviewCadence,
      sql: patch.sql,
      llmContext: patch.llmContext,
      evidence,
      conversionNotes: dqlGenerationConversionNotes(generatorName),
      generationMode,
      generationProvider: generatorName,
    });
    const validated: BlockStudioImportCandidate = {
      ...enriched,
      validation: validateBlockStudioSource(enriched.dqlSource, semanticLayer),
    };
    const savedDraft = saveDqlGenerationDraftForProject(projectRoot, session.id, validated);
    writeBlockStudioImportCandidate(projectRoot, session.id, savedDraft);
    nextCandidates.push(savedDraft);
  }

  const generationSession: DqlGenerationSession = {
    ...session,
    mode: 'ai-import',
    candidates: nextCandidates,
    updatedAt: new Date().toISOString(),
    generation: {
      provider: nextCandidates.find((candidate) => candidate.generationMode === 'ai')?.generationProvider ?? 'local-deterministic',
      aiEnabled: nextCandidates.some((candidate) => candidate.generationMode === 'ai'),
      contextObjectCount,
      createdDrafts: nextCandidates.filter((candidate) => candidate.draftSave.status === 'saved').length,
      warnings,
    },
  };
  writeBlockStudioImportSession(projectRoot, generationSession);
  if (generationSession.generation.createdDrafts > 0) await refreshLocalMetadataCatalog(projectRoot);
  return generationSession;
}

function saveDqlGenerationDraftForProject(
  projectRoot: string,
  importId: string,
  candidate: BlockStudioImportCandidate,
): DqlGenerationCandidate {
  if (candidate.recommendedAction === 'reuse_existing') {
    const topMatch = candidate.similarityMatches?.[0];
    return {
      ...candidate,
      reviewStatus: 'review',
      draftSave: {
        status: 'skipped',
        reason: topMatch
          ? `Reuse recommended: ${topMatch.name} (${topMatch.kind}, ${(topMatch.score * 100).toFixed(0)}%).`
          : 'Reuse recommended; no new draft block was needed.',
      },
      generationMode: candidate.generationMode ?? 'deterministic',
      generationProvider: candidate.generationProvider ?? 'local-deterministic',
      llmContext: candidate.llmContext ?? deterministicDqlGenerationContext(candidate, candidate.evidence ?? []),
      evidence: candidate.evidence ?? [],
    };
  }

  try {
    const savedPath = saveBlockStudioDraftArtifacts(projectRoot, {
      currentPath: isDraftBlockPath(candidate.savedPath) ? candidate.savedPath : undefined,
      source: candidate.dqlSource,
      name: candidate.name,
      domain: candidate.domain,
      description: candidate.description,
      owner: candidate.owner,
      tags: candidate.tags,
      lineage: candidate.lineage.sourceTables,
      stableSuffix: candidate.id.replace(/^cand_/, ''),
      importMeta: {
        importId,
        candidateId: candidate.id,
        sourceKind: candidate.sourceKind,
        sourcePath: candidate.sourcePath,
      },
    });
    const draftSave: BlockDraftSaveState = { status: 'saved', path: savedPath, savedAt: new Date().toISOString() };
    return {
      ...candidate,
      reviewStatus: candidate.reviewStatus === 'rejected' ? 'rejected' : 'draft',
      savedPath,
      draftSave,
      generationMode: candidate.generationMode ?? 'deterministic',
      generationProvider: candidate.generationProvider ?? 'local-deterministic',
      llmContext: candidate.llmContext ?? deterministicDqlGenerationContext(candidate, candidate.evidence ?? []),
      evidence: candidate.evidence ?? [],
    };
  } catch (error) {
    return {
      ...candidate,
      draftSave: { status: 'error', error: error instanceof Error ? error.message : String(error) },
      generationMode: candidate.generationMode ?? 'deterministic',
      generationProvider: candidate.generationProvider ?? 'local-deterministic',
      llmContext: candidate.llmContext ?? deterministicDqlGenerationContext(candidate, candidate.evidence ?? []),
      evidence: candidate.evidence ?? [],
    };
  }
}

export function saveBlockStudioArtifacts(
  projectRoot: string,
  options: {
    currentPath?: string;
    source: string;
    name: string;
    domain?: string;
    description?: string;
    owner?: string;
    tags?: string[];
    lineage?: string[];
    importMeta?: {
      importId?: string;
      candidateId?: string;
      sourceKind?: string;
      sourcePath?: string;
    };
  },
): string {
  const slug = options.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
  const safeDomain = (options.domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '') || 'uncategorized';
  const previousPath = options.currentPath ? normalize(options.currentPath).replace(/^\/+/, '') : null;
  const targetRelativePath = canonicalBlockRelativePath(projectRoot, safeDomain, slug, previousPath);
  const targetPath = join(projectRoot, targetRelativePath);

  if (existsSync(targetPath) && previousPath !== targetRelativePath) {
    throw new Error('BLOCK_EXISTS');
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, options.source.trimEnd() + '\n', 'utf-8');
  writeBlockCompanionFile(projectRoot, {
    slug,
    name: options.name,
    domain: safeDomain,
    description: options.description,
    owner: options.owner,
    tags: options.tags,
    provider: 'dql',
    content: options.source,
    lineage: options.lineage,
    importMeta: options.importMeta,
  });

  if (previousPath && previousPath !== targetRelativePath) {
    const previousAbsPath = join(projectRoot, previousPath);
    if (existsSync(previousAbsPath)) rmSync(previousAbsPath, { force: true });
    const previousCompanion = blockCompanionRelativePath(previousPath);
    if (previousCompanion) {
      const previousCompanionPath = join(projectRoot, previousCompanion);
      if (existsSync(previousCompanionPath)) rmSync(previousCompanionPath, { force: true });
    }
  }

  return targetRelativePath;
}

export function saveBlockStudioDraftArtifacts(
  projectRoot: string,
  options: {
    currentPath?: string;
    source: string;
    name: string;
    domain?: string;
    description?: string;
    owner?: string;
    tags?: string[];
    lineage?: string[];
    importMeta?: {
      importId?: string;
      candidateId?: string;
      sourceKind?: string;
      sourcePath?: string;
    };
    stableSuffix?: string;
  },
): string {
  const slug = options.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
  const safeDomain = (options.domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '') || 'uncategorized';
  const previousPath = options.currentPath ? normalize(options.currentPath).replace(/^\/+/, '') : null;
  const domainFirstRoot = join(projectRoot, 'domains');
  const useDomainFirstDrafts = existsSync(domainFirstRoot);
  const draftPrefix = useDomainFirstDrafts
    ? `domains/${safeDomain}/blocks/_drafts/`
    : `blocks/_drafts/${safeDomain}/`;
  const stableSuffix = options.stableSuffix?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18);
  let targetRelativePath: string = previousPath && isDraftBlockPath(previousPath)
    ? previousPath
    : `${draftPrefix}${slug}${stableSuffix ? `-${stableSuffix}` : ''}.dql`;
  let targetPath = join(projectRoot, targetRelativePath);
  if (!previousPath && existsSync(targetPath)) {
    for (let index = 2; index < 1000; index += 1) {
      const candidatePath = `${draftPrefix}${slug}-${index}.dql`;
      if (!existsSync(join(projectRoot, candidatePath))) {
        targetRelativePath = candidatePath;
        targetPath = join(projectRoot, targetRelativePath);
        break;
      }
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, options.source.trimEnd() + '\n', 'utf-8');
  const companionSlug = targetRelativePath.split('/').pop()?.replace(/\.dql$/, '') || slug;
  writeBlockCompanionFile(projectRoot, {
    slug: companionSlug,
    name: options.name,
    domain: `_drafts/${safeDomain}`,
    description: options.description,
    owner: options.owner,
    tags: options.tags,
    provider: 'dql',
    content: options.source,
    lineage: options.lineage,
    importMeta: options.importMeta,
  });

  return targetRelativePath;
}

function canonicalBlockRelativePath(
  projectRoot: string,
  safeDomain: string,
  slug: string,
  previousPath: string | null,
): string {
  const previousDomainFirst = previousPath?.match(/^domains\/([^/]+)\/blocks\/(?:_drafts\/)?[^/]+\.dql$/);
  if (previousDomainFirst) {
    return `domains/${previousDomainFirst[1]}/blocks/${slug}.dql`;
  }
  if (existsSync(join(projectRoot, 'domains', safeDomain))) {
    return `domains/${safeDomain}/blocks/${slug}.dql`;
  }
  return `blocks/${safeDomain}/${slug}.dql`;
}

function isDraftBlockPath(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = normalize(value).replace(/^\/+/, '');
  return normalized.startsWith('blocks/_drafts/') || /^domains\/[^/]+\/blocks\/_drafts\//.test(normalized);
}

function isBlockStudioBlockPath(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = normalize(value).replace(/^\/+/, '');
  return normalized.startsWith('blocks/') || /^domains\/[^/]+\/blocks\//.test(normalized);
}

function inferBlockStudioPathDomain(blockPath: string): string {
  const normalized = normalize(blockPath).replace(/^\/+/, '');
  if (normalized.startsWith('blocks/')) {
    return normalized.split('/').slice(1, -1).join('/');
  }
  const domainFirst = normalized.match(/^domains\/([^/]+)\/blocks\/(.+)$/);
  if (!domainFirst) return '';
  const domain = domainFirst[1];
  const blockSubpath = domainFirst[2];
  if (blockSubpath.startsWith('_drafts/')) return `_drafts/${domain}`;
  return domain;
}

function blockCompanionRelativePath(blockPath: string): string | null {
  const normalized = normalize(blockPath).replace(/^\/+/, '');
  if (normalized.startsWith('blocks/')) {
    const withoutRoot = normalized.slice('blocks/'.length).replace(/\.dql$/, '.yaml');
    return join('semantic-layer', 'blocks', withoutRoot).replaceAll('\\', '/');
  }
  const domainFirst = normalized.match(/^domains\/([^/]+)\/blocks\/(.+)\.dql$/);
  if (domainFirst) {
    const domain = domainFirst[1];
    const blockPath = domainFirst[2];
    const companionBlockPath = blockPath.startsWith('_drafts/')
      ? join('_drafts', domain, blockPath.slice('_drafts/'.length))
      : join(domain, blockPath);
    return join('semantic-layer', 'blocks', `${companionBlockPath}.yaml`).replaceAll('\\', '/');
  }
  return null;
}

function readBlockCompanionFile(projectRoot: string, relativePath: string) {
  const absPath = join(projectRoot, relativePath);
  if (!existsSync(absPath)) return null;
  try {
    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const topLevel: Record<string, string> = {};
    const arrays: Record<string, string[]> = {};
    let currentArray: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.replace(/\t/g, '  ');
      if (!line.trim() || line.trimStart().startsWith('#')) continue;

      if (/^\S[^:]*:\s*$/.test(line)) {
        currentArray = line.trim().slice(0, -1);
        if (['tags', 'lineage', 'semanticMetrics', 'semanticDimensions'].includes(currentArray)) {
          arrays[currentArray] = [];
        }
        continue;
      }

      const itemMatch = line.match(/^\s*-\s*(.+)\s*$/);
      if (itemMatch && currentArray && arrays[currentArray]) {
        arrays[currentArray].push(parseYamlScalar(itemMatch[1]));
        continue;
      }

      const scalarMatch = line.match(/^([A-Za-z0-9_]+):\s*(.+)\s*$/);
      if (scalarMatch) {
        currentArray = null;
        topLevel[scalarMatch[1]] = parseYamlScalar(scalarMatch[2]);
      }
    }

    return {
      name: topLevel.name ?? '',
      block: topLevel.block ?? '',
      domain: topLevel.domain ?? '',
      description: topLevel.description ?? '',
      owner: topLevel.owner ?? '',
      tags: arrays.tags ?? [],
      reviewStatus: topLevel.reviewStatus ?? '',
    };
  } catch {
    return null;
  }
}

export function parseBlockSourceMetadata(source: string): {
  name: string;
  domain: string;
  description: string;
  owner: string;
  tags: string[];
  status: string;
  blockType: string;
  llmContext: string;
  pattern: string;
  grain: string;
  entities: string[];
  outputs: string[];
  dimensions: string[];
  allowedFilters: string[];
  parameterPolicy: Array<{ name: string; policy: string }>;
  filterBindings: Array<{ filter: string; binding: string }>;
  sourceSystems: string[];
  replacementFor: string[];
  reviewCadence: string;
} {
  const name = source.match(/^\s*block\s+"([^"]+)"/i)?.[1] ?? '';
  const extractString = (key: string) => source.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const extractStringArray = (key: string) => {
    const match = source.match(new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'i'));
    return match ? (match[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)) : [];
  };
  const extractStringMapSection = (key: string) => {
    const match = source.match(new RegExp(`\\b${key}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'i'));
    if (!match) return [];
    return match[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => line.match(/^([A-Za-z_][\w.]*)\s*=\s*"([^"]*)"\s*$/))
      .filter((entry): entry is RegExpMatchArray => Boolean(entry))
      .map((entry) => ({ key: entry[1], value: entry[2] }));
  };
  const parameterPolicy = extractStringMapSection('parameterPolicy')
    .map((entry) => ({ name: entry.key, policy: entry.value }));
  const filterBindings = extractStringMapSection('filterBindings')
    .map((entry) => ({ filter: entry.key, binding: entry.value }));
  return {
    name,
    domain: extractString('domain'),
    description: extractString('description'),
    owner: extractString('owner'),
    tags: extractStringArray('tags'),
    status: extractString('status') || 'draft',
    blockType: extractString('type') || 'custom',
    llmContext: extractString('llmContext'),
    pattern: extractString('pattern'),
    grain: extractString('grain'),
    entities: extractStringArray('entities'),
    outputs: extractStringArray('outputs'),
    dimensions: extractStringArray('dimensions'),
    allowedFilters: extractStringArray('allowedFilters'),
    parameterPolicy,
    filterBindings,
    sourceSystems: extractStringArray('sourceSystems'),
    replacementFor: extractStringArray('replacementFor'),
    reviewCadence: extractString('reviewCadence'),
  };
}

function compareBlockStudioValues(actual: unknown, operator: string, expected: unknown): boolean {
  const expectedValue = normalizeBlockStudioExpected(expected);
  if (operator === '==' || operator === '=') return String(actual) === String(expectedValue);
  if (operator === '!=') return String(actual) !== String(expectedValue);
  const actualNumber = Number(actual);
  const expectedNumber = Number(expectedValue);
  switch (operator) {
    case '>': return actualNumber > expectedNumber;
    case '>=': return actualNumber >= expectedNumber;
    case '<': return actualNumber < expectedNumber;
    case '<=': return actualNumber <= expectedNumber;
    default: return false;
  }
}

function normalizeBlockStudioExpected(expected: unknown): unknown {
  if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, 'value')) {
    return (expected as { value: unknown }).value;
  }
  if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, 'name')) {
    return (expected as { name: unknown }).name;
  }
  return expected;
}

function formatBlockStudioExpected(expected: unknown): string {
  const normalized = normalizeBlockStudioExpected(expected);
  if (normalized === null || normalized === undefined) return 'null';
  if (typeof normalized === 'string' || typeof normalized === 'number' || typeof normalized === 'boolean') return String(normalized);
  return JSON.stringify(normalized);
}

function buildBlockStudioCertificationChecklist(input: {
  source: string;
  validation: ReturnType<typeof validateBlockStudioSource>;
  previewSucceeded: boolean;
  testResults: TestResultSummary | null;
  certificationErrors: Array<{ rule: string; message: string }>;
  extraBlockers?: string[];
}) {
  const parsed = parseBlockSourceMetadata(input.source);
  const sql = extractBlockStudioSql(input.source) ?? '';
  const blockers = new Set<string>();
  for (const diagnostic of input.validation.diagnostics) {
    if (diagnostic.severity === 'error') blockers.add(diagnostic.message);
  }
  for (const error of input.certificationErrors) blockers.add(`${error.rule}: ${error.message}`);
  for (const blocker of input.extraBlockers ?? []) blockers.add(blocker);
  if (!input.previewSucceeded) blockers.add('Block has not run successfully');
  if (!input.testResults || input.testResults.failed > 0) blockers.add('Tests must pass before certification');
  if (!input.testResults || input.testResults.assertions.length === 0) blockers.add('At least one test assertion is required before certification');
  if (!input.validation.chartConfig?.chart) blockers.add('Visualization config is missing');

  return {
    metadata: Boolean(parsed.domain.trim() && parsed.owner.trim() && parsed.description.trim()),
    validation: input.validation.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    run: input.previewSucceeded,
    tests: Boolean(input.testResults && input.testResults.failed === 0 && input.testResults.assertions.length > 0),
    chart: Boolean(input.validation.chartConfig?.chart),
    lineage: extractSqlTablesLight(sql).length > 0 || input.validation.semanticRefs.metrics.length > 0,
    aiReviewed: true,
    blockers: Array.from(blockers),
    checkedAt: new Date().toISOString(),
  };
}

function extractSqlTablesLight(sql: string): string[] {
  const tables = new Set<string>();
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/extract\s*\(\s*\w+\s+from\s+[^)]+\)/gi, 'EXTRACT_VALUE');
  const regex = /\b(?:from|join|update|into)\s+([`"[]?[A-Za-z0-9_./:-]+(?:\.[A-Za-z0-9_./:-]+)*[`"\]]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned))) {
    const raw = match[1].replace(/^[`"[]|[`"\]]$/g, '');
    if (raw && !raw.startsWith('(') && !/^(select|values|unnest|lateral)$/i.test(raw)) tables.add(raw);
  }
  return Array.from(tables);
}

function setBlockStudioStatusInSource(source: string, newStatus: string): string {
  if (/status\s*=\s*"[^"]*"/.test(source)) {
    return source.replace(/status\s*=\s*"[^"]*"/, `status = "${newStatus}"`);
  }
  return source.replace(/block\s+"[^"]*"\s*\{/, (match) => `${match}\n  status = "${newStatus}"`);
}

export function setBlockStudioStatus(projectRoot: string, blockPath: string, newStatus: string): void {
  const normalizedPath = normalize(blockPath).replace(/^\/+/, '');
  if (!isBlockStudioBlockPath(normalizedPath)) throw new Error('Invalid block path');
  const absPath = join(projectRoot, normalizedPath);
  if (!existsSync(absPath)) throw new Error('Block file not found');
  const source = setBlockStudioStatusInSource(readFileSync(absPath, 'utf-8'), newStatus);
  writeFileSync(absPath, source, 'utf-8');

  const companionPath = blockCompanionRelativePath(normalizedPath);
  if (!companionPath) return;
  const absCompanionPath = join(projectRoot, companionPath);
  if (!existsSync(absCompanionPath)) return;
  let companion = readFileSync(absCompanionPath, 'utf-8');
  if (/^reviewStatus:\s*.+$/m.test(companion)) {
    companion = companion.replace(/^reviewStatus:\s*.+$/m, `reviewStatus: ${newStatus}`);
  } else {
    companion = `${companion.trimEnd()}\nreviewStatus: ${newStatus}\n`;
  }
  writeFileSync(absCompanionPath, companion, 'utf-8');
}

interface DqlGenerationPatch {
  name?: string;
  domain?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  terms?: string[];
  llmContext?: string;
  pattern?: string;
  grain?: string;
  entities?: string[];
  outputs?: string[];
  dimensions?: string[];
  allowedFilters?: string[];
  parameterPolicy?: Array<{ name: string; policy: string }>;
  filterBindings?: Array<{ filter: string; binding: string }>;
  parameterDecisions?: DqlParameterDecision[];
  similarityMatches?: BlockSimilarityMatch[];
  recommendedAction?: DqlCandidateRecommendedAction;
  sourceSystems?: string[];
  replacementFor?: string[];
  reviewCadence?: string;
  sql?: string;
  warnings?: string[];
}

async function buildDqlGenerationContextPack(
  projectRoot: string,
  candidate: BlockStudioImportCandidate,
): Promise<LocalContextPack> {
  const tables = candidate.lineage.sourceTables.join(', ');
  const question = [
    `Generate a governed DQL block draft for SQL import candidate "${candidate.name}".`,
    candidate.description,
    tables ? `Source tables: ${tables}.` : '',
    candidate.sql.slice(0, 1200),
  ].filter(Boolean).join('\n');
  return buildLocalContextPack(projectRoot, {
    question,
    mode: 'build',
    surface: 'block-studio',
    limit: 80,
    objectTypes: [
      'dql_block',
      'dql_term',
      'business_view',
      'domain',
      'semantic_metric',
      'semantic_model',
      'semantic_dimension',
      'semantic_measure',
      'dbt_model',
      'dbt_source',
      'dbt_column',
      'warehouse_table',
      'datalex_domain',
      'datalex_entity',
      'datalex_contract',
      'datalex_term',
    ],
    strictness: 'balanced',
  });
}

function dqlGenerationEvidenceFromContext(
  contextPack: LocalContextPack,
  candidate: BlockStudioImportCandidate,
): DqlGenerationEvidence[] {
  const directEvidence = contextPack.objects
    .filter((object) => isDqlGenerationEvidenceObject(object))
    .filter((object) => metadataObjectMatchesImportedSource(object, candidate.lineage.sourceTables))
    .map((object) => metadataObjectToDqlGenerationEvidence(object, 'Directly matches an imported SQL source table.'));
  const selected = contextPack.retrievalDiagnostics.selectedEvidence.slice(0, 12);
  const byKey = new Map(contextPack.objects.map((object) => [object.objectKey, object]));
  const evidence = selected.flatMap((item): DqlGenerationEvidence[] => {
    const object = byKey.get(item.objectKey);
    if (!object || !isDqlGenerationEvidenceObject(object)) return [];
    return [metadataObjectToDqlGenerationEvidence(
      object,
      item.reason,
      Math.max(0.35, Math.min(0.98, item.score / Math.max(item.score, 10))),
    )];
  });
  const ranked = uniqueDqlGenerationEvidence([...directEvidence, ...evidence]).slice(0, 12);
  return ranked.length > 0 ? ranked : deterministicDqlGenerationEvidence(candidate);
}

function deterministicDqlGenerationEvidence(candidate: BlockStudioImportCandidate): DqlGenerationEvidence[] {
  return candidate.lineage.sourceTables.map((table) => ({
    kind: 'warehouse_table',
    name: table,
    source: candidate.sourcePath,
    reason: 'Detected in the imported SQL source.',
    confidence: 0.7,
  }));
}

function isDqlGenerationEvidenceObject(object: LocalContextPack['objects'][number]): boolean {
  if (object.objectType === 'dql_block') {
    if (object.status !== 'certified') return false;
    if (object.sourcePath?.includes('/_drafts/') || object.sourcePath?.includes('\\_drafts\\')) return false;
  }
  return true;
}

function metadataObjectToDqlGenerationEvidence(
  object: LocalContextPack['objects'][number],
  reason: string,
  confidence = 0.82,
): DqlGenerationEvidence {
  return {
    kind: dqlGenerationEvidenceKind(object.objectType),
    name: object.fullName ?? object.name,
    description: object.description,
    objectKey: object.objectKey,
    source: object.sourcePath ?? object.sourceSystem,
    reason,
    confidence,
  };
}

function metadataObjectMatchesImportedSource(
  object: LocalContextPack['objects'][number],
  sourceTables: string[],
): boolean {
  if (sourceTables.length === 0) return false;
  const haystack = [
    object.fullName,
    object.name,
    object.objectKey,
    object.sourcePath,
    object.sourceSystem,
    typeof object.payload?.relation === 'string' ? object.payload.relation : '',
    typeof object.payload?.relationName === 'string' ? object.payload.relationName : '',
    typeof object.payload?.relation_name === 'string' ? object.payload.relation_name : '',
  ].filter(Boolean).join(' ').toLowerCase();
  return sourceTables.some((table) =>
    relationLookupTokens(table).some((token) => token && haystack.includes(token))
  );
}

function relationLookupTokens(relation: string): string[] {
  const normalized = relation.replace(/[`"[\]]/g, '').toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  return Array.from(new Set([
    normalized,
    parts.slice(-2).join('.'),
    parts.at(-1) ?? '',
  ].filter((item) => item.length >= 3)));
}

function uniqueDqlGenerationEvidence(evidence: DqlGenerationEvidence[]): DqlGenerationEvidence[] {
  const seen = new Set<string>();
  const result: DqlGenerationEvidence[] = [];
  for (const item of evidence) {
    const key = item.objectKey || `${item.kind}:${item.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dqlGenerationEvidenceKind(objectType: string): DqlGenerationEvidence['kind'] {
  if (objectType === 'dql_block') return 'dql_block';
  if (objectType === 'dql_term') return 'dql_term';
  if (objectType === 'business_view') return 'business_view';
  if (objectType === 'domain') return 'domain';
  if (objectType === 'semantic_metric') return 'semantic_metric';
  if (objectType === 'semantic_model') return 'semantic_model';
  if (objectType === 'dbt_model' || objectType === 'dbt_source' || objectType === 'dbt_column') return 'dbt_model';
  if (objectType === 'warehouse_table') return 'warehouse_table';
  if (objectType === 'datalex_contract') return 'datalex_contract';
  if (objectType === 'datalex_entity') return 'datalex_entity';
  if (objectType === 'datalex_domain') return 'datalex_domain';
  if (objectType === 'datalex_term') return 'datalex_term';
  if (objectType.includes('lineage')) return 'lineage';
  return 'metadata';
}

function deterministicDqlGenerationPatch(
  candidate: BlockStudioImportCandidate,
  evidence: DqlGenerationEvidence[],
): DqlGenerationPatch {
  const domain = inferDqlGenerationDomain(candidate);
  const parameterized = parameterizeSqlForDqlImport(candidate.sql);
  const grain = extractDqlGenerationGroupByFields(parameterized.sql)[0];
  const outputs = extractDqlGenerationSelectOutputs(parameterized.sql);
  const sourceSystems = candidate.lineage.sourceTables.map((table) => table.split('.').filter(Boolean).slice(-2, -1)[0] ?? '').filter(Boolean);
  const description = candidate.description && !candidate.description.startsWith('Imported from ')
    ? candidate.description
    : deterministicDqlGenerationDescription(candidate, evidence);
  const allowedFilters = Array.from(new Set([
    ...parameterized.allowedFilters,
    ...extractDqlGenerationFilterFields(parameterized.sql),
  ])).slice(0, 16);
  return {
    name: candidate.name,
    domain,
    description,
    owner: candidate.owner,
    tags: dqlGenerationBusinessTags(candidate, evidence, domain),
    terms: inferDqlGenerationTerms(evidence),
    llmContext: deterministicDqlGenerationContext({ ...candidate, sql: parameterized.sql }, evidence),
    pattern: inferDqlGenerationPattern(parameterized.sql),
    grain,
    entities: inferDqlGenerationEntities({
      grain,
      outputs,
      sourceTables: candidate.lineage.sourceTables,
      evidence,
    }),
    outputs,
    dimensions: extractDqlGenerationDimensions(parameterized.sql, grain, outputs),
    allowedFilters,
    parameterPolicy: parameterized.parameterPolicy,
    filterBindings: parameterized.filterBindings,
    parameterDecisions: parameterized.parameterDecisions,
    sql: parameterized.sql,
    warnings: parameterized.warnings,
    sourceSystems,
    reviewCadence: 'monthly',
  };
}

function inferDqlGenerationTerms(evidence: DqlGenerationEvidence[]): string[] {
  return Array.from(new Set(
    evidence
      .filter((item) => item.kind === 'dql_term' || item.kind === 'datalex_term')
      .map((item) => item.name.trim())
      .filter(Boolean),
  )).slice(0, 16);
}

function deterministicDqlGenerationDescription(
  candidate: BlockStudioImportCandidate,
  evidence: DqlGenerationEvidence[],
): string {
  const tables = candidate.lineage.sourceTables.length > 0
    ? candidate.lineage.sourceTables.join(', ')
    : candidate.sourcePath;
  const sourceContext = evidence.find((item) =>
    (item.kind === 'dbt_model' || item.kind === 'semantic_model' || item.kind === 'warehouse_table') &&
    item.description &&
    candidate.lineage.sourceTables.some((table) => relationLookupTokens(table).some((token) => item.name.toLowerCase().includes(token)))
  );
  const aggregate = /\b(sum|count|avg|min|max)\s*\(/i.test(candidate.sql);
  const grouped = /\bgroup\s+by\b/i.test(candidate.sql);
  const sourcePhrase = sourceContext?.description
    ? ` using ${sourceContext.name} (${sourceContext.description})`
    : ` using ${tables}`;
  if (aggregate && grouped) return `Summarizes imported SQL${sourcePhrase}.`;
  if (aggregate) return `Calculates aggregate values${sourcePhrase}.`;
  return `Exposes imported SQL${sourcePhrase}.`;
}

function dqlGenerationBusinessTags(
  candidate: BlockStudioImportCandidate,
  evidence: DqlGenerationEvidence[],
  domain: string,
): string[] {
  const generic = new Set(['imported', 'raw-sql', 'ai-generated']);
  const stopTags = new Set(['int', 'stg', 'src', 'fct', 'dim', 'name', 'id', 'key', 'model', 'source', 'table']);
  const sourceTokens = candidate.lineage.sourceTables
    .flatMap((table) => table.split('.').slice(-2))
    .flatMap((part) => part.split(/[_\s.-]+/));
  const tags = [
    ...candidate.tags.filter((tag) => !generic.has(tag)),
    domain,
    ...sourceTokens,
    'review-required',
  ].map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 1 && !generic.has(tag) && !stopTags.has(tag))
    .map((tag) => tag.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  return Array.from(new Set(tags)).slice(0, 12);
}

function deterministicDqlGenerationContext(
  candidate: Pick<BlockStudioImportCandidate, 'name' | 'sql' | 'lineage'>,
  evidence: DqlGenerationEvidence[],
): string {
  const tables = candidate.lineage.sourceTables.length > 0
    ? candidate.lineage.sourceTables.join(', ')
    : 'the imported SQL source';
  const evidenceNames = evidence
    .filter((item) => item.kind !== 'dql_block')
    .slice(0, 3)
    .map((item) => item.name)
    .filter(Boolean);
  const grain = extractDqlGenerationGroupByFields(candidate.sql);
  const years = extractDqlGenerationYearFilters(candidate.sql);
  return [
    `Use after review for questions matching "${candidate.name}".`,
    grain.length > 0 ? `Grain: ${grain.join(', ')}.` : '',
    years.length > 0 ? `Filters: year ${years.join(', ')}.` : '',
    `Source: ${tables}.`,
    evidenceNames.length > 0 ? `Grounded by: ${evidenceNames.join(', ')}.` : '',
    'Certification must confirm grain, filters, owner, tags, and tests.',
  ].filter(Boolean).join(' ');
}

function extractDqlGenerationGroupByFields(sql: string): string[] {
  const match = sql.match(/\bgroup\s+by\b([\s\S]+?)(?:\border\s+by\b|\blimit\b|\bqualify\b|\bhaving\b|$)/i);
  if (!match) return [];
  return splitDqlGenerationSqlList(match[1])
    .map((item) => item.replace(/[`"[\]]/g, '').trim())
    .filter((item) => item && !/^\d+$/.test(item))
    .slice(0, 4);
}

function extractDqlGenerationSelectOutputs(sql: string): string[] {
  const selectMatch = sql.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!selectMatch) return [];
  return splitDqlGenerationSqlList(selectMatch[1])
    .map((expr) => {
      const alias = expr.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1]
        ?? expr.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1]
        ?? '';
      return alias.replace(/[`"[\]]/g, '');
    })
    .filter(Boolean)
    .filter((name) => !/^(from|where|group|order|limit)$/i.test(name))
    .slice(0, 24);
}

function extractDqlGenerationDimensions(sql: string, grain: string | undefined, outputs: string[]): string[] {
  const outputSet = new Set(outputs.map(normalizedTerm));
  return extractDqlGenerationGroupByFields(sql)
    .map((field) => field.split('.').pop() ?? field)
    .filter((field) => normalizedTerm(field) !== normalizedTerm(grain ?? ''))
    .filter((field) => !outputSet.has(normalizedTerm(field)))
    .filter((field) => !/\b(total|count|sum|avg|average|min|max|rate|pct|percent|amount|revenue|points?|score)\b/i.test(field))
    .slice(0, 16);
}

function inferDqlGenerationEntities(input: {
  grain?: string;
  outputs: string[];
  sourceTables: string[];
  evidence: DqlGenerationEvidence[];
}): string[] {
  const entities = new Set<string>();
  const add = (value: string | undefined) => {
    const entity = businessEntityFromDqlGenerationIdentifier(value ?? '');
    if (entity) entities.add(entity);
  };

  add(input.grain);
  for (const output of input.outputs) add(output);
  for (const table of input.sourceTables) add(table.split('.').pop());
  for (const item of input.evidence.slice(0, 12)) {
    if (item.kind === 'datalex_entity' || item.kind === 'semantic_model' || item.kind === 'dbt_model' || item.kind === 'warehouse_table') {
      add(item.name.split('.').pop());
    }
  }

  return [...entities].slice(0, 8);
}

function businessEntityFromDqlGenerationIdentifier(value: string): string {
  const raw = value
    .split('.').pop()
    ?.trim()
    .replace(/[`"[\]]/g, '')
    .replace(/^(dim|fact|fct|stg|src|int)_/i, '')
    .replace(/_(id|key|name|code|uuid|number|num|abbreviation|abbr)$/i, '')
    .replace(/s$/i, '') ?? '';
  if (!raw) return '';
  const tokens = raw
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .filter((token) => !isGenericDqlGenerationEntityToken(token));
  if (tokens.length === 0) return '';
  return titleizeDqlGenerationName(tokens.join(' '));
}

function isGenericDqlGenerationEntityToken(token: string): boolean {
  return new Set([
    'total',
    'count',
    'sum',
    'avg',
    'average',
    'min',
    'max',
    'metric',
    'measure',
    'value',
    'amount',
    'revenue',
    'point',
    'points',
    'score',
    'date',
    'day',
    'week',
    'month',
    'quarter',
    'year',
    'season',
    'period',
    'time',
    'row',
    'record',
    'detail',
    'stat',
    'stats',
    'analytic',
    'analytics',
    'transformed',
  ]).has(token);
}

function titleizeDqlGenerationName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferDqlGenerationPattern(sql: string): string {
  const groupFields = extractDqlGenerationGroupByFields(sql);
  if (/@metric\s*\(/i.test(sql)) return 'metric_wrapper';
  if (/\bjoin\b/i.test(sql)) {
    const systems = new Set(extractDqlGenerationSourceSystems(sql));
    if (systems.size > 1) return 'bridge';
  }
  if (hasDqlGenerationRankingLimit(sql)) return 'ranking';
  if (groupFields.some((field) => /\b(date|day|week|month|quarter|year|period|time)\b/i.test(field))) return 'trend';
  if (groupFields.length === 1 && /_id$|_key$/i.test(groupFields[0])) return 'entity_rollup';
  if (!/\b(sum|count|avg|min|max|median|percentile|rank)\s*\(/i.test(sql) && /\b(dim|profile|customer|account|player|product|user|entity)\b/i.test(sql)) {
    return 'entity_profile';
  }
  return 'custom';
}

function hasDqlGenerationRankingLimit(sql: string): boolean {
  return /\border\s+by\b[\s\S]*\blimit\s+(?:\d+|\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}|[:?][A-Za-z_][A-Za-z0-9_]*)/i.test(sql);
}

function extractDqlGenerationSourceSystems(sql: string): string[] {
  const tables = new Set<string>();
  const cleaned = sql.replace(/--[^\n\r]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const regex = /\b(?:from|join|update|into)\s+([`"[]?[A-Za-z0-9_./:-]+(?:\.[A-Za-z0-9_./:-]+)*[`"\]]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned))) {
    const raw = match[1].replace(/^[`"[]|[`"\]]$/g, '');
    const parts = raw.split('.').filter(Boolean);
    const system = parts.slice(-2, -1)[0] ?? parts[0];
    if (system) tables.add(system.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-'));
  }
  return [...tables].filter(Boolean).slice(0, 12);
}

function extractDqlGenerationFilterFields(sql: string): string[] {
  const filters = new Set<string>();
  const where = sql.match(/\bwhere\b([\s\S]+?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i)?.[1] ?? '';
  const addFilter = (value: string | undefined) => {
    const name = value?.split('.').pop()?.replace(/[`"[\]]/g, '');
    if (name && !/^(and|or|not|null|year|month|day)$/i.test(name)) filters.add(name);
  };
  const extractRegex = /\bextract\s*\([^)]*\bfrom\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*(?:=|<>|!=|>|<|>=|<=|\bin\b|\blike\b)/gi;
  const isNullRegex = /\b([A-Za-z_][A-Za-z0-9_.]*)\s+is\s+(?:not\s+)?null\b/gi;
  const regex = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|<>|!=|>|<|>=|<=|\bin\b|\blike\b)/gi;
  let match: RegExpExecArray | null;
  while ((match = extractRegex.exec(where))) addFilter(match[1]);
  while ((match = isNullRegex.exec(where))) addFilter(match[1]);
  while ((match = regex.exec(where))) {
    addFilter(match[1]);
  }
  return [...filters].slice(0, 16);
}

function extractDqlGenerationYearFilters(sql: string): string[] {
  const years = new Set<string>();
  const cleaned = sql.replace(/--[^\n\r]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  let match: RegExpExecArray | null;
  const extractYear = /extract\s*\(\s*year\s+from\s+[^)]+\)\s*(?:=\s*([12][0-9]{3})|in\s*\(([^)]*)\))/gi;
  while ((match = extractYear.exec(cleaned))) {
    for (const year of (match[1] || match[2] || '').match(/[12][0-9]{3}/g) ?? []) years.add(year);
  }
  return Array.from(years).sort();
}

function splitDqlGenerationSqlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (!double && char === "'" && value[i - 1] !== '\\') single = !single;
    else if (!single && char === '"' && value[i - 1] !== '\\') double = !double;
    else if (!single && !double && char === '(') depth += 1;
    else if (!single && !double && char === ')' && depth > 0) depth -= 1;
    else if (!single && !double && depth === 0 && char === ',') {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function inferDqlGenerationDomain(candidate: BlockStudioImportCandidate): string {
  const current = candidate.domain?.trim();
  if (current && current !== 'imported' && current !== 'general') return current;
  const firstTable = candidate.lineage.sourceTables[0];
  const schema = firstTable?.split('.').filter(Boolean).slice(-2, -1)[0];
  return schema?.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase() || current || 'imported';
}

async function buildAiDqlGenerationPatch(
  provider: AgentProvider,
  candidate: BlockStudioImportCandidate,
  evidence: DqlGenerationEvidence[],
  contextPack: LocalContextPack | null,
): Promise<DqlGenerationPatch | null> {
  const payload = {
    candidate: {
      name: candidate.name,
      domain: candidate.domain,
      description: candidate.description,
      owner: candidate.owner,
      tags: candidate.tags,
      sql: candidate.sql,
      sourceTables: candidate.lineage.sourceTables,
      parameters: candidate.lineage.parameters,
      warnings: candidate.warnings ?? candidate.lineage.warnings,
      grain: extractDqlGenerationGroupByFields(candidate.sql),
        yearFilters: extractDqlGenerationYearFilters(candidate.sql),
        parameterization: parameterizeSqlForDqlImport(candidate.sql),
      },
    context: {
      evidence,
      selectedObjects: contextPack?.objects.slice(0, 24).map((object) => ({
        objectKey: object.objectKey,
        objectType: object.objectType,
        name: object.fullName ?? object.name,
        domain: object.domain,
        status: object.status,
        description: object.description,
      })) ?? [],
      allowedRelations: contextPack?.allowedSqlContext.relations.slice(0, 12).map((relation) => ({
        relation: relation.relation,
        source: relation.source,
        columns: relation.columns.slice(0, 16).map((column) => column.name),
      })) ?? [],
    },
  };
  const text = await provider.generate([
    {
      role: 'system',
      content: [
        'You generate DQL Block Studio metadata for a local draft.',
        'Return only a compact JSON object with optional keys: name, domain, description, owner, tags, terms, llmContext, pattern, grain, entities, outputs, dimensions, allowedFilters, sourceSystems, replacementFor, reviewCadence.',
        'Do not return markdown. Do not mark the block certified. Do not change SQL.',
        'Use only directly relevant dbt, semantic, warehouse, certified block, and SQL-shape evidence from the payload.',
        'terms must reference existing DQL/DataLex glossary terms from the payload. Do not invent term names.',
        'If metadata descriptions are missing, describe the observable SQL intent instead of inventing business meaning.',
        'Descriptions and llmContext must be specific, business-readable, concise, and review-required.',
        'reviewCadence should usually be monthly or quarterly unless evidence strongly suggests a different cadence.',
        'Tags must be business/search tags. Avoid generic tags such as raw-sql, imported, ai-generated.',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(payload) },
  ], { maxTokens: 900, temperature: 0.1 });
  return normalizeDqlGenerationPatch(parseFirstJsonObject(text));
}

function parseFirstJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return JSON.parse(trimmed);
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return JSON.parse(match[0]);
}

function normalizeDqlGenerationPatch(value: unknown): DqlGenerationPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const patch: DqlGenerationPatch = {};
  if (typeof record.name === 'string' && record.name.trim()) patch.name = record.name.trim().slice(0, 120);
  if (typeof record.domain === 'string' && record.domain.trim()) patch.domain = record.domain.trim().slice(0, 80);
  if (typeof record.description === 'string' && record.description.trim()) patch.description = record.description.trim().slice(0, 500);
  if (typeof record.owner === 'string' && record.owner.trim()) patch.owner = record.owner.trim().slice(0, 120);
  if (Array.isArray(record.tags)) patch.tags = normalizeDqlGenerationStringArray(record.tags, 12);
  if (Array.isArray(record.terms)) patch.terms = normalizeDqlGenerationStringArray(record.terms, 16);
  if (typeof record.llmContext === 'string' && record.llmContext.trim()) patch.llmContext = record.llmContext.trim().slice(0, 1000);
  if (typeof record.pattern === 'string' && record.pattern.trim()) patch.pattern = normalizeDqlGenerationPattern(record.pattern);
  if (typeof record.grain === 'string' && record.grain.trim()) patch.grain = record.grain.trim().slice(0, 120);
  if (Array.isArray(record.entities)) patch.entities = normalizeDqlGenerationStringArray(record.entities, 12);
  if (Array.isArray(record.outputs)) patch.outputs = normalizeDqlGenerationStringArray(record.outputs, 24);
  if (Array.isArray(record.dimensions)) patch.dimensions = normalizeDqlGenerationStringArray(record.dimensions, 16);
  if (Array.isArray(record.allowedFilters)) patch.allowedFilters = normalizeDqlGenerationStringArray(record.allowedFilters, 16);
  if (Array.isArray(record.sourceSystems)) patch.sourceSystems = normalizeDqlGenerationStringArray(record.sourceSystems, 12);
  if (Array.isArray(record.replacementFor)) patch.replacementFor = normalizeDqlGenerationStringArray(record.replacementFor, 12);
  if (typeof record.reviewCadence === 'string' && record.reviewCadence.trim()) {
    const reviewCadence = normalizeDqlGenerationReviewCadence(record.reviewCadence);
    if (reviewCadence) patch.reviewCadence = reviewCadence;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function normalizeDqlGenerationStringArray(value: unknown[], limit: number): string[] {
  const result: string[] = [];
  for (const item of value) {
    const normalized = normalizeDqlGenerationStringItem(item);
    if (normalized) result.push(normalized);
  }
  return Array.from(new Set(result)).slice(0, limit);
}

function normalizeDqlGenerationStringItem(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'field', 'column', 'id', 'value', 'label', 'sourceSystem', 'source_system']) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

function normalizeDqlGenerationPattern(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const allowed = new Set([
    'metric_wrapper',
    'entity_profile',
    'entity_rollup',
    'ranking',
    'trend',
    'bridge',
    'drilldown',
    'replacement',
    'custom',
  ]);
  return allowed.has(normalized) ? normalized : undefined;
}

function normalizeDqlGenerationReviewCadence(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_ -]+/g, '').replace(/\s+/g, '_');
  const allowed = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual']);
  return allowed.has(normalized) ? normalized : undefined;
}

function mergeGroundedDqlGenerationTerms(
  baseTerms: string[] | undefined,
  overrideTerms: string[] | undefined,
  evidence: DqlGenerationEvidence[],
): string[] | undefined {
  const grounded = new Map<string, string>();
  for (const item of evidence) {
    if (item.kind !== 'dql_term' && item.kind !== 'datalex_term') continue;
    const normalized = normalizedTerm(item.name);
    if (normalized) grounded.set(normalized, item.name.trim());
  }
  const merged = [...(baseTerms ?? []), ...(overrideTerms ?? [])]
    .map((term) => grounded.get(normalizedTerm(term)))
    .filter((term): term is string => Boolean(term));
  const result = Array.from(new Set(merged)).slice(0, 16);
  return result.length > 0 ? result : undefined;
}

function mergeDqlGenerationPatch(
  base: DqlGenerationPatch,
  override: DqlGenerationPatch,
  candidate: BlockStudioImportCandidate,
  evidence: DqlGenerationEvidence[],
): DqlGenerationPatch {
  const name = override.name && !isWeakDqlGenerationName(override.name) ? override.name : base.name;
  const description = override.description
    && !isWeakDqlGenerationDescription(override.description)
    && !isUngroundedDqlGenerationDescription(override.description, candidate, evidence)
    ? override.description
    : base.description;
  const llmContext = override.llmContext
    && !isUngroundedDqlGenerationDescription(override.llmContext, candidate, evidence)
    ? override.llmContext
    : base.llmContext;
  const overrideTags = override.tags
    ? override.tags.filter((tag) => !/^(raw-sql|imported|ai-generated)$/i.test(tag))
    : [];
  return {
    ...base,
    ...override,
    name,
    description,
    llmContext,
    tags: Array.from(new Set([...(base.tags ?? []), ...overrideTags])).slice(0, 12),
    terms: mergeGroundedDqlGenerationTerms(base.terms, override.terms, evidence),
    pattern: override.pattern ?? base.pattern,
    grain: override.grain ?? base.grain,
    entities: override.entities?.length ? override.entities : base.entities,
    outputs: override.outputs?.length ? override.outputs : base.outputs,
    dimensions: override.dimensions?.length ? override.dimensions : base.dimensions,
    allowedFilters: override.allowedFilters?.length ? override.allowedFilters : base.allowedFilters,
    parameterPolicy: base.parameterPolicy,
    filterBindings: base.filterBindings,
    parameterDecisions: base.parameterDecisions,
    similarityMatches: base.similarityMatches,
    recommendedAction: base.recommendedAction,
    sql: base.sql,
    warnings: base.warnings,
    sourceSystems: override.sourceSystems?.length ? override.sourceSystems : base.sourceSystems,
    replacementFor: override.replacementFor?.length ? override.replacementFor : base.replacementFor,
    reviewCadence: override.reviewCadence ?? base.reviewCadence,
  };
}

function buildDqlGenerationSimilarityMatches(
  candidate: BlockStudioImportCandidate,
  patch: DqlGenerationPatch,
  contextPack: LocalContextPack | null,
): { matches: BlockSimilarityMatch[]; recommendedAction: DqlCandidateRecommendedAction } {
  const candidateSql = patch.sql ?? candidate.sql;
  const candidateFingerprints = buildBlockSqlFingerprints(candidateSql);
  const candidateBusinessFingerprint = buildBlockBusinessFingerprint({
    name: patch.name ?? candidate.name,
    domain: patch.domain ?? candidate.domain,
    pattern: patch.pattern,
    grain: patch.grain,
    entities: patch.entities,
    terms: patch.terms,
    outputs: patch.outputs,
    dimensions: patch.dimensions,
    filters: patch.allowedFilters,
    sources: candidate.lineage.sourceTables,
    sourceSystems: patch.sourceSystems,
  });
  const candidateShape = {
    name: candidate.name,
    pattern: patch.pattern,
    grain: patch.grain,
    outputs: new Set((patch.outputs ?? []).map(normalizedTerm)),
    terms: new Set((patch.terms ?? []).map(normalizedTerm)),
    dimensions: new Set((patch.dimensions ?? []).map(normalizedTerm)),
    filters: new Set((patch.allowedFilters ?? []).map(normalizedTerm)),
    entities: new Set((patch.entities ?? []).map(normalizedTerm)),
    sources: new Set(candidate.lineage.sourceTables.flatMap(relationLookupTokens).map(normalizedTerm)),
  };
  const objects = (contextPack?.objects ?? []).filter((object) => object.objectType === 'dql_block');
  const matches = objects.flatMap((object): BlockSimilarityMatch[] => {
    const payload = object.payload ?? {};
    const objectSql = typeof payload.sql === 'string' ? payload.sql : '';
    const objectFingerprints = metadataSqlFingerprints(payload.sqlFingerprints)
      ?? (objectSql ? buildBlockSqlFingerprints(objectSql) : null);
    const objectBusinessFingerprint = metadataBusinessFingerprint(payload.businessFingerprint);
    const objectShape = {
      pattern: metadataString(payload.pattern),
      grain: metadataString(payload.grain),
      outputs: new Set(metadataStringArray(payload.declaredOutputs ?? payload.outputs)),
      terms: new Set(metadataStringArray(payload.termRefs ?? payload.terms)),
      dimensions: new Set(metadataStringArray(payload.dimensions)),
      filters: new Set(metadataStringArray(payload.allowedFilters)),
      entities: new Set(metadataStringArray(payload.entities)),
      sources: new Set(metadataStringArray(payload.tableDependencies ?? payload.rawTableRefs).flatMap(relationLookupTokens).map(normalizedTerm)),
    };
    if (objectFingerprints?.exact && objectFingerprints.exact === candidateFingerprints.exact) {
      return [{
        kind: 'exact_sql_match',
        objectKey: object.objectKey,
        name: object.fullName ?? object.name,
        status: object.status,
        source: object.sourcePath,
        score: 0.99,
        reason: 'Normalized SQL exactly matches an existing DQL block.',
        recommendedAction: 'reuse_existing',
      }];
    }
    if (objectFingerprints?.parameterized && objectFingerprints.parameterized === candidateFingerprints.parameterized) {
      return [{
        kind: 'parameterized_duplicate',
        objectKey: object.objectKey,
        name: object.fullName ?? object.name,
        status: object.status,
        source: object.sourcePath,
        score: 0.94,
        reason: 'SQL shape matches after replacing literal values with parameters.',
        recommendedAction: 'reuse_existing',
      }];
    }
    const score = businessShapeSimilarity(candidateShape, objectShape, object);
    if (
      objectBusinessFingerprint?.hash
      && objectBusinessFingerprint.hash === candidateBusinessFingerprint.hash
      && object.status === 'certified'
    ) {
      return [{
        kind: 'business_duplicate',
        objectKey: object.objectKey,
        name: object.fullName ?? object.name,
        status: object.status,
        source: object.sourcePath,
        score: Math.max(score, 0.86),
        reason: 'Certified block has the same persisted business-shape fingerprint.',
        recommendedAction: 'reuse_existing',
      }];
    }
    if (score >= 0.76 && object.status === 'certified') {
      return [{
        kind: 'business_duplicate',
        objectKey: object.objectKey,
        name: object.fullName ?? object.name,
        status: object.status,
        source: object.sourcePath,
        score,
        reason: 'Certified block has the same business shape: entity, grain, filters, outputs, or source family overlap.',
        recommendedAction: 'reuse_existing',
      }];
    }
    if (score >= 0.58) {
      return [{
        kind: 'near_variant',
        objectKey: object.objectKey,
        name: object.fullName ?? object.name,
        status: object.status,
        source: object.sourcePath,
        score,
        reason: 'Existing block is close but appears to need a reviewed filter, output, grain, or source extension.',
        recommendedAction: 'extend_existing',
      }];
    }
    return [];
  }).sort((a, b) => b.score - a.score).slice(0, 8);
  const top = matches[0];
  return {
    matches,
    recommendedAction: top?.recommendedAction ?? 'create_new',
  };
}

function metadataSqlFingerprints(value: unknown): { exact: string; parameterized: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const exact = typeof record.exact === 'string' ? record.exact : '';
  const parameterized = typeof record.parameterized === 'string' ? record.parameterized : '';
  if (!exact || !parameterized) return null;
  return { exact, parameterized };
}

function metadataBusinessFingerprint(value: unknown): { hash: string; tokens: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hash = typeof record.hash === 'string' ? record.hash : '';
  if (!hash) return null;
  const tokens = Array.isArray(record.tokens)
    ? record.tokens.map((item) => String(item)).filter(Boolean)
    : [];
  return { hash, tokens };
}

function businessShapeSimilarity(
  candidate: {
    name: string;
    pattern?: string;
    grain?: string;
    outputs: Set<string>;
    terms: Set<string>;
    dimensions: Set<string>;
    filters: Set<string>;
    entities: Set<string>;
    sources: Set<string>;
  },
  object: {
    pattern?: string;
    grain?: string;
    outputs: Set<string>;
    terms: Set<string>;
    dimensions: Set<string>;
    filters: Set<string>;
    entities: Set<string>;
    sources: Set<string>;
  },
  metadata: MetadataObject,
): number {
  let score = 0;
  if (candidate.pattern && object.pattern && normalizedTerm(candidate.pattern) === normalizedTerm(object.pattern)) score += 0.12;
  if (candidate.grain && object.grain && normalizedTerm(candidate.grain) === normalizedTerm(object.grain)) score += 0.15;
  score += overlapScore(candidate.outputs, object.outputs) * 0.18;
  score += overlapScore(candidate.terms, object.terms) * 0.08;
  score += overlapScore(candidate.dimensions, object.dimensions) * 0.13;
  score += overlapScore(candidate.filters, object.filters) * 0.14;
  score += overlapScore(candidate.entities, object.entities) * 0.12;
  score += overlapScore(candidate.sources, object.sources) * 0.1;
  const nameTokens = new Set(candidate.name.toLowerCase().split(/[^a-z0-9]+/).filter((value) => value.length > 2));
  const targetTokens = new Set([
    ...metadata.name.toLowerCase().split(/[^a-z0-9]+/),
    ...(metadata.description ?? '').toLowerCase().split(/[^a-z0-9]+/),
  ].filter((value) => value.length > 2));
  score += overlapScore(nameTokens, targetTokens) * 0.04;
  return Number(Math.min(0.98, score).toFixed(3));
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const value of left) {
    if (value && right.has(value)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function normalizedTerm(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).map(normalizedTerm);
}

function isWeakDqlGenerationName(name: string): boolean {
  return /^(pasted|query|source|imported query|sql import)(?:\s+\d+)?$/i.test(name.trim());
}

function isWeakDqlGenerationDescription(description: string): boolean {
  return /^draft dql block summarizing imported sql/i.test(description.trim())
    || /^draft dql block generated from imported sql/i.test(description.trim())
    || /^imported from /i.test(description.trim())
    || /^this query (shows|returns|provides)/i.test(description.trim());
}

function isUngroundedDqlGenerationDescription(
  description: string,
  candidate: BlockStudioImportCandidate,
  evidence: DqlGenerationEvidence[],
): boolean {
  const text = description.toLowerCase();
  const tokens = new Set<string>();
  for (const tag of candidate.tags) {
    if (!/^(raw-sql|imported|ai-generated|review-required)$/i.test(tag) && tag.length > 2) tokens.add(tag.toLowerCase());
  }
  for (const table of candidate.lineage.sourceTables) {
    for (const token of table.split(/[._\s/-]+/)) {
      if (token.length > 2) tokens.add(token.toLowerCase());
    }
  }
  for (const item of evidence.slice(0, 6)) {
    for (const token of item.name.split(/[._\s/-]+/)) {
      if (token.length > 3 && !/^(model|source|semantic|table)$/i.test(token)) tokens.add(token.toLowerCase());
    }
  }
  if (tokens.size === 0) return false;
  return !Array.from(tokens).some((token) => text.includes(token));
}

function dqlGenerationConversionNotes(providerName: string): string[] {
  return [
    `Generated with ${providerName} using local project context when available.`,
    'Runtime-scope SQL literals are converted into DQL params when safe; business constants stay static for review.',
    'Certified and draft block similarity is checked before a new draft is saved.',
    'SQL semantics are preserved while reusable parameter placeholders may replace literal values.',
    'Drafts are autosaved under blocks/_drafts or domains/<domain>/blocks/_drafts before certification.',
    'Preview results and tests gate certification before promotion.',
  ];
}

function setBlockStudioSourceStatus(source: string, status: string): string {
  if (/status\s*=\s*"[^"]*"/.test(source)) {
    return source.replace(/status\s*=\s*"[^"]*"/, `status = "${status}"`);
  }
  return source.replace(/block\s+"[^"]*"\s*\{/, (match) => `${match}\n  status = "${status}"`);
}

async function buildBlockStudioAiAssistSummary(
  projectRoot: string,
  action: string,
  candidate: BlockStudioImportCandidate,
  validation: ReturnType<typeof validateBlockStudioSource>,
  requestedProvider?: ProviderSettingsId,
): Promise<{ summary: string; provider: string }> {
  const fallback = buildDeterministicAiAssistSummary(action, candidate, validation);
  const provider = await createBlockStudioAssistProvider(projectRoot, requestedProvider);
  if (!provider) return { summary: fallback, provider: 'review-gated-local' };

  const messages = [
    {
      role: 'system' as const,
      content: [
        'You are DQL Block Studio AI Assist.',
        'Return concise review notes only. Do not claim the block is certified.',
        'Do not rewrite source unless the user explicitly applies a later patch.',
        'Focus on DQL custom block structure, metadata, tests, chart hints, and validation errors.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        action,
        candidate: {
          name: candidate.name,
          domain: candidate.domain,
          description: candidate.description,
          owner: candidate.owner,
          tags: candidate.tags,
          sourcePath: candidate.sourcePath,
          sql: candidate.sql,
          dqlSource: candidate.dqlSource,
          detectedTables: candidate.lineage.sourceTables,
          parameters: candidate.lineage.parameters,
          warnings: candidate.warnings ?? candidate.lineage.warnings,
        },
        validation: {
          valid: validation.valid,
          diagnostics: validation.diagnostics,
          chartConfig: validation.chartConfig,
          semanticRefs: validation.semanticRefs,
        },
      }, null, 2),
    },
  ];

  try {
    const summary = await provider.generate(messages, { maxTokens: 700, temperature: 0.1 });
    return {
      summary: summary.trim() || fallback,
      provider: provider.name,
    };
  } catch (error) {
    return {
      summary: `${fallback}\n\nConfigured provider failed: ${error instanceof Error ? error.message : String(error)}`,
      provider: provider.name,
    };
  }
}

async function createBlockStudioAssistProvider(
  projectRoot: string,
  requestedProvider?: ProviderSettingsId,
): Promise<AgentProvider | null> {
  const settings = listProviderSettings(projectRoot);
  const activeProvider = getActiveProvider(projectRoot);
  const selected = requestedProvider
    ? settings.find((provider) => provider.id === requestedProvider && provider.enabled && provider.hasApiKey)
    : settings.find((provider) => provider.id === activeProvider && provider.enabled)
      ?? settings.find((provider) => provider.enabled && provider.hasApiKey);
  if (!selected) return null;
  const config = getEffectiveProviderConfig(projectRoot, selected.id);
  let provider: AgentProvider;
  switch (selected.id) {
    case 'anthropic':
      provider = new ClaudeProvider({ apiKey: config.apiKey, model: config.model });
      break;
    case 'openai':
      provider = new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
      break;
    case 'gemini':
      provider = new GeminiProvider({ apiKey: config.apiKey, model: config.model });
      break;
    case 'ollama':
      provider = new OllamaProvider({ baseUrl: config.baseUrl, model: config.model });
      break;
    case 'custom-openai':
      provider = new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, allowNoApiKey: true });
      break;
    default:
      return null;
  }
  return await provider.available() ? provider : null;
}

function buildDeterministicAiAssistSummary(
  action: string,
  candidate: BlockStudioImportCandidate,
  validation: ReturnType<typeof validateBlockStudioSource>,
): string {
  const tables = candidate.lineage.sourceTables.length > 0 ? candidate.lineage.sourceTables.join(', ') : 'no source tables detected';
  const params = candidate.lineage.parameters.length > 0 ? candidate.lineage.parameters.join(', ') : 'no parameters detected';
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => diagnostic.message);
  if (action === 'fix-validation') {
    return errors.length > 0
      ? `Review-gated AI assist would focus on these validation errors: ${errors.join(' | ')}. No source was changed automatically.`
      : 'No validation errors were found. No source was changed automatically.';
  }
  if (action === 'infer-chart') {
    return `Candidate uses ${tables}. Keep table as the safe default, then choose a chart after previewing result columns. No chart was changed automatically.`;
  }
  if (action === 'propose-tests') {
    return `Default test is row_count > 0. Consider adding assertions for key measures after previewing this candidate. Parameters: ${params}.`;
  }
  return `This is a deterministic review note for ${candidate.name}. Tables: ${tables}. Parameters: ${params}. DQL wraps the SQL into a custom block and defaults visualization to table.`;
}

function extractBlockStudioChartConfig(source: string): { chart?: string; x?: string; y?: string; color?: string; title?: string } | null {
  const vizMatch = source.match(/visualization\s*\{([^}]+)\}/is);
  if (!vizMatch) return null;
  const body = vizMatch[1];
  const get = (key: string) => body.match(new RegExp(`\\b${key}\\s*=\\s*["']?([\\w-]+)["']?`, 'i'))?.[1];
  const chart = get('chart');
  if (!chart) return null;
  const title = body.match(/\btitle\s*=\s*"([^"]+)"/i)?.[1];
  return {
    chart,
    x: get('x'),
    y: get('y'),
    color: get('color'),
    title,
  };
}

function extractBlockStudioSql(source: string): string | null {
  const tripleQuoteMatch = source.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (tripleQuoteMatch) return tripleQuoteMatch[1].trim() || null;
  const bareTripleMatch = source.match(/"""([\s\S]*?)"""/);
  if (bareTripleMatch) return bareTripleMatch[1].trim() || null;
  if (/^\s*(dashboard|workbook)\s+"/i.test(source)) return null;
  const sqlKeywordMatch = source.match(/\b(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|SHOW|DESCRIBE|EXPLAIN)\b([\s\S]*)/i);
  if (!sqlKeywordMatch) return null;
  let raw = sqlKeywordMatch[0];
  const dqlSectionStart = raw.search(/\b(visualization|tests|block)\s*\{/i);
  if (dqlSectionStart > 0) raw = raw.slice(0, dqlSectionStart);
  return raw.trim() || null;
}

function extractBlockStudioSemanticReferences(source: string): { metrics: string[]; dimensions: string[]; segments: string[] } {
  const metrics = new Set<string>();
  const dimensions = new Set<string>();
  const segments = new Set<string>();
  const semanticRegex = /@(metric|dim)\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = semanticRegex.exec(source))) {
    const name = match[2].trim();
    if (!name) continue;
    if (match[1].toLowerCase() === 'metric') metrics.add(name);
    else dimensions.add(name);
  }
  const segmentRegex = /\/\*\s*segment:([^*]+)\*\//gi;
  while ((match = segmentRegex.exec(source))) {
    const name = match[1].trim();
    if (name) segments.add(name);
  }
  return {
    metrics: Array.from(metrics),
    dimensions: Array.from(dimensions),
    segments: Array.from(segments),
  };
}

function canonicalizeSafe(source: string): string {
  try {
    return canonicalize(source);
  } catch {
    // If the block body has content the parser rejects (e.g. unsupported
    // syntax in a user-provided template), keep the original bytes rather
    // than fail the write — format header gets added next time it passes fmt.
    return source;
  }
}

function canonicalizeNotebookSafe(source: string): string {
  try {
    return canonicalizeNotebook(source);
  } catch {
    return source;
  }
}

export interface BlockGitMetadata {
  commitSha: string;
  repo: string | null;
  branch: string | null;
}

export function readGitMetadata(projectRoot: string): BlockGitMetadata | null {
  const run = (cmd: string): string =>
    execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const commitSha = run('git rev-parse HEAD');
    let repo: string | null = null;
    let branch: string | null = null;
    try { repo = run('git config --get remote.origin.url') || null; } catch { /* no remote */ }
    try { branch = run('git rev-parse --abbrev-ref HEAD') || null; } catch { /* detached */ }
    return { commitSha, repo, branch };
  } catch {
    return null;
  }
}

function resolveBlockWriteTarget(
  projectRoot: string,
  safeDomain: string,
  slug: string,
): { relativePath: string; absPath: string } {
  if (safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))) {
    const relativePath = `domains/${safeDomain}/blocks/${slug}.dql`;
    return { relativePath, absPath: join(projectRoot, relativePath) };
  }
  const relativePath = safeDomain ? `blocks/${safeDomain}/${slug}.dql` : `blocks/${slug}.dql`;
  return { relativePath, absPath: join(projectRoot, relativePath) };
}

export function createBlockArtifacts(
  projectRoot: string,
  options: {
    name: string;
    domain?: string;
    owner?: string;
    content?: string;
    description?: string;
    tags?: string[];
    metricRefs?: string[];
    template?: string;
    blockType?: 'custom' | 'semantic';
    llmContext?: string;
    examples?: Array<{ question: string; sql?: string }>;
    invariants?: string[];
    gitMetadata?: BlockGitMetadata | null;
  },
): { path: string; content: string; companionPath: string } {
  const slug = options.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
  const safeDomain = (options.domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  const target = resolveBlockWriteTarget(projectRoot, safeDomain, slug);
  mkdirSync(dirname(target.absPath), { recursive: true });
  const blockPath = target.absPath;
  if (existsSync(blockPath)) {
    throw new Error('BLOCK_EXISTS');
  }

  const templateContent = options.template
    ? listBlockTemplates().find((template) => template.id === options.template)?.content
    : undefined;
  const relativePath = target.relativePath;
  const fileContent = canonicalizeSafe(options.blockType === 'semantic' && !options.content?.trim() && !templateContent
    ? buildBlankSemanticBlockContent({
        name: options.name,
        domain: safeDomain || 'uncategorized',
        owner: options.owner,
        description: options.description,
        tags: options.tags,
      })
    : normalizeBlockStudioContent({
        name: options.name,
        domain: safeDomain || 'uncategorized',
        owner: options.owner,
        description: options.description,
        tags: options.tags,
        llmContext: options.llmContext,
        examples: options.examples,
        invariants: options.invariants,
        content: options.content?.trim() || templateContent,
      }));

  writeFileSync(blockPath, fileContent, 'utf-8');
  const companionPath = writeBlockCompanionFile(projectRoot, {
    slug,
    name: options.name,
    domain: safeDomain || 'uncategorized',
    owner: options.owner,
    description: options.description,
    tags: options.tags,
    provider: 'dql',
    content: fileContent,
    gitMetadata: options.gitMetadata,
    gitPath: relativePath,
  });
  return {
    path: relativePath,
    content: fileContent,
    companionPath,
  };
}

export function createSemanticBuilderBlock(
  projectRoot: string,
  options: {
    name: string;
    domain?: string;
    description?: string;
    owner?: string;
    tags?: string[];
    metrics: string[];
    dimensions: string[];
    timeDimension?: { name: string; granularity: string };
    chart?: string;
    blockType: 'semantic' | 'custom';
    sql: string;
    tables: string[];
    provider: string;
  },
): { path: string; content: string; companionPath: string } {
  const slug = options.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
  const safeDomain = (options.domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '') || 'uncategorized';
  const target = resolveBlockWriteTarget(projectRoot, safeDomain, slug);
  mkdirSync(dirname(target.absPath), { recursive: true });
  const blockPath = target.absPath;
  if (existsSync(blockPath)) {
    throw new Error('BLOCK_EXISTS');
  }

  const content = canonicalizeSafe(
    options.blockType === 'custom'
      ? buildCustomSemanticBlockContent(options)
      : buildSemanticBlockContent(options),
  );
  writeFileSync(blockPath, content, 'utf-8');

  const companionPath = writeBlockCompanionFile(projectRoot, {
    slug,
    name: options.name,
    domain: safeDomain,
    description: options.description,
    owner: options.owner,
    tags: options.tags,
    provider: options.provider,
    content,
    lineage: options.tables,
    semanticMetrics: options.metrics,
    semanticDimensions: [
      ...options.dimensions,
      ...(options.timeDimension ? [options.timeDimension.name] : []),
    ],
  });

  return {
    path: target.relativePath,
    content,
    companionPath,
  };
}

function buildSemanticBlockContent(options: {
  name: string;
  domain?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  chart?: string;
}): string {
  const lines = [
    `block "${options.name}" {`,
    `    domain = "${options.domain ?? 'uncategorized'}"`,
    '    type = "semantic"',
  ];
  if (options.description) lines.push(`    description = "${escapeDqlString(options.description)}"`);
  if (options.owner) lines.push(`    owner = "${escapeDqlString(options.owner)}"`);
  if (options.tags && options.tags.length > 0) {
    lines.push(`    tags = [${options.tags.map((tag) => `"${escapeDqlString(tag)}"`).join(', ')}]`);
  }
  if (options.metrics.length === 0) {
    lines.push('    metric = ""');
  } else if (options.metrics.length === 1) {
    lines.push(`    metric = "${escapeDqlString(options.metrics[0])}"`);
  } else {
    lines.push(`    metrics = [${options.metrics.map((metric) => `"${escapeDqlString(metric)}"`).join(', ')}]`);
  }
  if (options.dimensions.length > 0) {
    lines.push(`    dimensions = [${options.dimensions.map((dimension) => `"${escapeDqlString(dimension)}"`).join(', ')}]`);
  } else {
    lines.push('    dimensions = []');
  }
  if (options.timeDimension) {
    lines.push(`    time_dimension = "${escapeDqlString(options.timeDimension.name)}"`);
    lines.push(`    granularity = "${escapeDqlString(options.timeDimension.granularity)}"`);
  }
  const visualization = buildVisualizationBlock(options.chart ?? 'table', options.dimensions, options.timeDimension, options.metrics);
  if (visualization) {
    lines.push('');
    lines.push(...visualization);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function buildCustomSemanticBlockContent(options: {
  name: string;
  domain?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  chart?: string;
  sql: string;
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
}): string {
  const lines = [
    `block "${options.name}" {`,
    `    domain = "${options.domain ?? 'uncategorized'}"`,
    '    type = "custom"',
  ];
  if (options.description) lines.push(`    description = "${escapeDqlString(options.description)}"`);
  if (options.owner) lines.push(`    owner = "${escapeDqlString(options.owner)}"`);
  if (options.tags && options.tags.length > 0) {
    lines.push(`    tags = [${options.tags.map((tag) => `"${escapeDqlString(tag)}"`).join(', ')}]`);
  }
  lines.push('');
  lines.push('    query = """');
  lines.push(...indentBlock(options.sql.trim(), 8).split('\n'));
  lines.push('    """');
  const visualization = buildVisualizationBlock(options.chart ?? 'table', options.dimensions, options.timeDimension, options.metrics);
  if (visualization) {
    lines.push('');
    lines.push(...visualization);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function buildVisualizationBlock(
  chart: string,
  dimensions: string[],
  timeDimension: { name: string; granularity: string } | undefined,
  metrics: string[],
): string[] | null {
  const x = timeDimension ? `${timeDimension.name}_${timeDimension.granularity}` : dimensions[0];
  const y = metrics[0];
  if (!x && chart !== 'kpi' && chart !== 'table') return null;
  if (chart === 'table') {
    return ['    visualization {', '        chart = "table"', '    }'];
  }
  if (chart === 'kpi') {
    return ['    visualization {', '        chart = "kpi"', `        y = ${y}`, '    }'];
  }
  return [
    '    visualization {',
    `        chart = "${chart}"`,
    `        x = ${x}`,
    `        y = ${y}`,
    '    }',
  ];
}

function writeBlockCompanionFile(
  projectRoot: string,
  options: {
    slug: string;
    name: string;
    domain: string;
    description?: string;
    owner?: string;
    tags?: string[];
    provider?: string;
    content: string;
    lineage?: string[];
    semanticMetrics?: string[];
    semanticDimensions?: string[];
    gitMetadata?: BlockGitMetadata | null;
    gitPath?: string;
    importMeta?: {
      importId?: string;
      candidateId?: string;
      sourceKind?: string;
      sourcePath?: string;
    };
  },
): string {
  const extractedRefs = extractSemanticReferenceNames(options.content);
  const semanticMetrics = Array.from(new Set([...(options.semanticMetrics ?? []), ...extractedRefs.metrics]));
  const semanticDimensions = Array.from(new Set([...(options.semanticDimensions ?? []), ...extractedRefs.dimensions]));
  const companionDir = join(projectRoot, 'semantic-layer', 'blocks', options.domain);
  mkdirSync(companionDir, { recursive: true });
  const companionPath = join(companionDir, `${options.slug}.yaml`);
  const lines = [
    `name: ${options.slug}`,
    `block: ${options.slug}`,
    `domain: ${options.domain}`,
    `description: ${yamlScalar(options.description?.trim() || options.name)}`,
  ];
  if (options.owner) lines.push(`owner: ${yamlScalar(options.owner)}`);
  if (options.tags && options.tags.length > 0) {
    lines.push('tags:');
    for (const tag of options.tags) lines.push(`  - ${yamlScalar(tag)}`);
  }
  if (options.provider) {
    lines.push('source:');
    lines.push(`  provider: ${yamlScalar(options.provider)}`);
    lines.push('  objectType: block');
    lines.push(`  objectId: ${yamlScalar(options.slug)}`);
  }
  if (semanticMetrics.length > 0) {
    lines.push('semanticMetrics:');
    for (const metric of semanticMetrics) lines.push(`  - ${yamlScalar(metric)}`);
  }
  if (semanticDimensions.length > 0) {
    lines.push('semanticDimensions:');
    for (const dimension of semanticDimensions) lines.push(`  - ${yamlScalar(dimension)}`);
  }
  const mappingEntries = [
    ...semanticMetrics.map((metric) => [metric, metric] as const),
    ...semanticDimensions.map((dimension) => [dimension, dimension] as const),
  ];
  if (mappingEntries.length > 0) {
    lines.push('semanticMappings:');
    for (const [key, value] of mappingEntries) {
      lines.push(`  ${key}: ${yamlScalar(value)}`);
    }
  }
  if (options.lineage && options.lineage.length > 0) {
    lines.push('lineage:');
    for (const table of options.lineage) lines.push(`  - ${yamlScalar(table)}`);
  }
  if (options.gitMetadata || options.gitPath) {
    lines.push('git:');
    if (options.gitMetadata?.commitSha) lines.push(`  commitSha: ${yamlScalar(options.gitMetadata.commitSha)}`);
    if (options.gitMetadata?.repo) lines.push(`  repo: ${yamlScalar(options.gitMetadata.repo)}`);
    if (options.gitMetadata?.branch) lines.push(`  branch: ${yamlScalar(options.gitMetadata.branch)}`);
    if (options.gitPath) lines.push(`  path: ${yamlScalar(options.gitPath)}`);
  }
  if (options.importMeta) {
    lines.push('import:');
    if (options.importMeta.importId) lines.push(`  importId: ${yamlScalar(options.importMeta.importId)}`);
    if (options.importMeta.candidateId) lines.push(`  candidateId: ${yamlScalar(options.importMeta.candidateId)}`);
    if (options.importMeta.sourceKind) lines.push(`  sourceKind: ${yamlScalar(options.importMeta.sourceKind)}`);
    if (options.importMeta.sourcePath) lines.push(`  sourcePath: ${yamlScalar(options.importMeta.sourcePath)}`);
  }
  lines.push('reviewStatus: draft');
  writeFileSync(companionPath, lines.join('\n') + '\n', 'utf-8');
  return relative(projectRoot, companionPath).replaceAll('\\', '/');
}

function extractSemanticReferenceNames(content: string): { metrics: string[]; dimensions: string[] } {
  const metrics = new Set<string>();
  const dimensions = new Set<string>();
  const regex = /@(metric|dim)\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const name = match[2].trim();
    if (!name) continue;
    if (match[1].toLowerCase() === 'metric') {
      metrics.add(name);
    } else {
      dimensions.add(name);
    }
  }
  return {
    metrics: Array.from(metrics),
    dimensions: Array.from(dimensions),
  };
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function indentBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function normalizeBlockStudioContent(options: {
  name: string;
  domain: string;
  owner?: string;
  description?: string;
  tags?: string[];
  llmContext?: string;
  examples?: Array<{ question: string; sql?: string }>;
  invariants?: string[];
  content?: string;
}): string {
  const content = options.content?.trim();
  if (content && /^\s*block\s+"/i.test(content)) {
    return `${content.trimEnd()}\n`;
  }

  return buildBlankBlockContent({
    name: options.name,
    domain: options.domain,
    owner: options.owner,
    description: options.description,
    tags: options.tags,
    llmContext: options.llmContext,
    examples: options.examples,
    invariants: options.invariants,
    sql: content || 'SELECT 1 AS value',
  });
}

function buildBlankBlockContent(options: {
  name: string;
  domain: string;
  owner?: string;
  description?: string;
  tags?: string[];
  llmContext?: string;
  examples?: Array<{ question: string; sql?: string }>;
  invariants?: string[];
  sql: string;
}): string {
  const lines = [
    `block "${escapeDqlString(options.name)}" {`,
    `    domain = "${escapeDqlString(options.domain)}"`,
    '    type = "custom"',
    `    description = "${escapeDqlString(options.description?.trim() || options.name)}"`,
    `    owner = "${escapeDqlString(options.owner?.trim() ?? '')}"`,
  ];
  lines.push(`    tags = [${(options.tags ?? []).map((tag) => `"${escapeDqlString(tag)}"`).join(', ')}]`);
  if (options.llmContext && options.llmContext.trim()) {
    lines.push(`    llmContext = "${escapeDqlString(options.llmContext.trim())}"`);
  }
  if (options.invariants && options.invariants.length > 0) {
    lines.push(
      `    invariants = [${options.invariants
        .filter((inv) => inv && inv.trim())
        .map((inv) => `"${escapeDqlString(inv.trim())}"`)
        .join(', ')}]`,
    );
  }
  if (options.examples && options.examples.length > 0) {
    const items = options.examples.filter((ex) => ex.question && ex.question.trim());
    if (items.length > 0) {
      lines.push('    examples = [');
      for (const ex of items) {
        const parts = [`question = "${escapeDqlString(ex.question.trim())}"`];
        if (ex.sql && ex.sql.trim()) parts.push(`sql = "${escapeDqlString(ex.sql.trim())}"`);
        lines.push(`        { ${parts.join(', ')} },`);
      }
      lines.push('    ]');
    }
  }
  lines.push('');
  lines.push('    query = """');
  lines.push(...indentBlock(options.sql.trim(), 8).split('\n'));
  lines.push('    """');
  lines.push('');
  lines.push('    visualization {');
  lines.push('        chart = "table"');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

function buildBlankSemanticBlockContent(options: {
  name: string;
  domain: string;
  owner?: string;
  description?: string;
  tags?: string[];
}): string {
  const lines = [
    `block "${escapeDqlString(options.name)}" {`,
    `    domain = "${escapeDqlString(options.domain)}"`,
    '    type = "semantic"',
    '    status = "draft"',
    `    description = "${escapeDqlString(options.description?.trim() || options.name)}"`,
    `    owner = "${escapeDqlString(options.owner?.trim() ?? '')}"`,
    `    tags = [${(options.tags ?? []).map((tag) => `"${escapeDqlString(tag)}"`).join(', ')}]`,
    '    metric = ""',
    '    dimensions = []',
    '',
    '    visualization {',
    '        chart = "table"',
    '    }',
    '}',
  ];
  return lines.join('\n') + '\n';
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9_.:/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function buildNotebookTemplate(title: string, template: string): string {
  const id = () => Math.random().toString(36).slice(2, 10);
  let cells: object[];

  if (template === 'revenue') {
    cells = [
      { id: id(), type: 'markdown', content: `# ${title}\n\nRevenue analysis using DQL and DuckDB.` },
      { id: id(), type: 'sql', name: 'revenue_summary', content: "SELECT\n  segment_tier AS segment,\n  SUM(amount) AS total_revenue,\n  COUNT(*) AS deals\nFROM read_csv_auto('./data/revenue.csv')\nGROUP BY segment_tier\nORDER BY total_revenue DESC" },
      { id: id(), type: 'sql', name: 'revenue_trend', content: "SELECT\n  recognized_at AS date,\n  SUM(amount) AS revenue\nFROM read_csv_auto('./data/revenue.csv')\nGROUP BY recognized_at\nORDER BY recognized_at" },
    ];
  } else if (template === 'pipeline') {
    cells = [
      { id: id(), type: 'markdown', content: `# ${title}\n\nPipeline health and conversion analysis.` },
      { id: id(), type: 'sql', name: 'pipeline_overview', content: "SELECT *\nFROM read_csv_auto('./data/pipeline.csv')\nLIMIT 100" },
    ];
  } else {
    cells = [
      { id: id(), type: 'markdown', content: `# ${title}\n\nAdd your analysis here.` },
      { id: id(), type: 'sql', name: 'query_1', content: 'SELECT 1 AS hello' },
    ];
  }

  return JSON.stringify({ version: 1, title, cells }, null, 2);
}

/** Build a lineage graph from the project's blocks and semantic layer. */
// Simple lineage graph cache: rebuilds at most every 5 seconds
let _lineageCache: { graph: InstanceType<typeof LineageGraph>; builtAt: number } | null = null;
const LINEAGE_CACHE_TTL_MS = 5000;

function buildProjectLineageGraph(projectRoot: string, semanticLayer: SemanticLayer | null | undefined) {
  if (_lineageCache && Date.now() - _lineageCache.builtAt < LINEAGE_CACHE_TTL_MS) {
    return _lineageCache.graph;
  }
  const graph = buildProjectLineageGraphUncached(projectRoot, semanticLayer);
  _lineageCache = { graph, builtAt: Date.now() };
  return graph;
}

function buildProjectLineageGraphUncached(projectRoot: string, semanticLayer: SemanticLayer | null | undefined) {
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (manifest.lineage?.nodes && manifest.lineage?.edges) {
        return LineageGraph.fromJSON({
          nodes: manifest.lineage.nodes,
          edges: manifest.lineage.edges,
        });
      }
    } catch {
      // Fall back to a live build.
    }
  }

  const dbtManifestPath = resolveDbtManifestPath(projectRoot, {});
  try {
    const manifest = buildManifest({
      projectRoot,
      dbtManifestPath,
    });
    return LineageGraph.fromJSON({
      nodes: manifest.lineage.nodes as any,
      edges: manifest.lineage.edges as any,
    });
  } catch {
    const blocks: LineageBlockInput[] = [];
    const metrics: LineageMetricInput[] = [];
    const dimensions: LineageDimensionInput[] = [];

    const dirs = ['blocks', 'dashboards', 'workbooks'];
    for (const dir of dirs) {
      const dirPath = join(projectRoot, dir);
      if (!existsSync(dirPath)) continue;
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isFile() || extname(entry.name) !== '.dql') continue;
        try {
          const source = readFileSync(join(dirPath, entry.name), 'utf-8');
          const parser = new Parser(source, `${dir}/${entry.name}`);
          const ast = parser.parse();
          for (const stmt of ast.statements) {
            const block = stmt as any;
            if (block.kind !== 'BlockDecl') continue;
            blocks.push({
              name: block.name,
              sql: block.query?.rawSQL ?? '',
              domain: extractProp(block, 'domain'),
              owner: extractProp(block, 'owner'),
              status: extractProp(block, 'status') as any,
              blockType: block.blockType,
              metricRef: block.metricRef,
              chartType: extractVizChart(block),
            });
          }
        } catch { /* skip unparseable */ }
      }
    }

    if (semanticLayer) {
      for (const m of semanticLayer.listMetrics()) {
        metrics.push({ name: m.name, table: m.table, domain: m.domain, type: m.type });
      }
      for (const d of semanticLayer.listDimensions()) {
        dimensions.push({ name: d.name, table: d.table });
      }
    }

    return buildLineageGraph(blocks, metrics, dimensions);
  }
}

function resolveDbtManifestPath(projectRoot: string, projectConfig: ProjectConfig = {}): string | undefined {
  const candidates: string[] = [];
  if (projectConfig.dbt?.projectDir || projectConfig.semanticLayer?.provider === 'dbt') {
    const dbtProjectPath = findDbtProjectPath(projectRoot, projectConfig);
    candidates.push(resolve(dbtProjectPath, projectConfig.dbt?.manifestPath ?? 'target/manifest.json'));
  }
  candidates.push(
    join(projectRoot, 'target', 'manifest.json'),
    join(resolve(projectRoot, '..'), 'target', 'manifest.json'),
    join(resolve(projectRoot, '../dbt'), 'target', 'manifest.json'),
    join(resolve(projectRoot, '../../dbt'), 'target', 'manifest.json'),
  );
  return candidates.find((candidate, index, list) => list.indexOf(candidate) === index && existsSync(candidate));
}

type DbtProfileOutput = Record<string, unknown>;

interface DbtProfileTextResult {
  value?: string;
  envRefs: string[];
}

export function discoverDbtProfileConnections(projectRoot: string, projectConfig: ProjectConfig): DbtProfileConnectionCandidate[] {
  const dbtProjectPath = findDbtProjectPath(projectRoot, projectConfig);
  const projectProfileName = readDbtProjectProfileName(dbtProjectPath);
  const profilePaths = findDbtProfilePaths(projectRoot, dbtProjectPath);
  const candidates: DbtProfileConnectionCandidate[] = [];

  for (const profilePath of profilePaths) {
    const profiles = readYamlFile(profilePath);
    if (!profiles) continue;

    for (const [profileName, rawProfile] of Object.entries(profiles)) {
      if (!rawProfile || typeof rawProfile !== 'object') continue;
      if (projectProfileName && profileName !== projectProfileName) continue;
      const profile = rawProfile as Record<string, unknown>;
      const outputs = profile.outputs && typeof profile.outputs === 'object'
        ? profile.outputs as Record<string, DbtProfileOutput>
        : {};
      const defaultTarget = typeof profile.target === 'string' ? profile.target : 'default';

      for (const [targetName, output] of Object.entries(outputs)) {
        if (!output || typeof output !== 'object') continue;
        const mapped = mapDbtProfileOutput(output);
        if (!mapped) continue;
        const warnings = [...mapped.warnings];
        if (targetName !== defaultTarget) {
          warnings.push(`Not the default dbt target "${defaultTarget}".`);
        }

        candidates.push({
          id: `${profilePath}:${profileName}:${targetName}`,
          profileName,
          targetName,
          adapter: mapped.adapter,
          path: profilePath,
          connection: mapped.connection,
          missingFields: requiredConnectionFields(mapped.connection, mapped.envRefs),
          warnings,
        });
      }
    }
  }

  return candidates.slice(0, 20);
}

function findDbtProjectPath(projectRoot: string, projectConfig: ProjectConfig): string {
  const configuredDbtDir = projectConfig.dbt?.projectDir
    ? resolve(projectRoot, projectConfig.dbt.projectDir)
    : undefined;
  const semanticDbtDir = projectConfig.semanticLayer?.provider === 'dbt' && projectConfig.semanticLayer.projectPath
    ? resolve(projectRoot, projectConfig.semanticLayer.projectPath)
    : undefined;
  const candidateDirs = [
    configuredDbtDir,
    semanticDbtDir,
    projectRoot,
    resolve(projectRoot, '..'),
    resolve(projectRoot, '../dbt'),
    resolve(projectRoot, '../../dbt'),
  ].filter((value): value is string => Boolean(value));

  return candidateDirs.find((dir, index, list) => list.indexOf(dir) === index && existsSync(join(dir, 'dbt_project.yml')))
    ?? configuredDbtDir
    ?? semanticDbtDir
    ?? projectRoot;
}

function findDbtProfilePaths(projectRoot: string, dbtProjectPath: string): string[] {
  const dirs = [
    process.env.DBT_PROFILES_DIR,
    dbtProjectPath,
    projectRoot,
    join(homedir(), '.dbt'),
  ].filter((value): value is string => Boolean(value));

  const paths: string[] = [];
  for (const dir of dirs) {
    for (const filename of ['profiles.yml', 'profiles.yaml']) {
      const profilePath = resolve(dir, filename);
      if (existsSync(profilePath) && !paths.includes(profilePath)) {
        paths.push(profilePath);
      }
    }
  }
  return paths;
}

function readDbtProjectProfileName(dbtProjectPath: string): string | null {
  const projectFile = join(dbtProjectPath, 'dbt_project.yml');
  const projectYaml = readYamlFile(projectFile);
  return typeof projectYaml?.profile === 'string' ? projectYaml.profile : null;
}

function readYamlFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = loadYaml(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function mapDbtProfileOutput(output: DbtProfileOutput): {
  adapter: string;
  connection: ConnectionConfig;
  envRefs: string[];
  warnings: string[];
} | null {
  const adapter = text(output, 'type').value?.toLowerCase();
  const envRefs = new Set<string>();
  const warnings: string[] = [];
  const read = (...keys: string[]) => {
    const result = text(output, ...keys);
    result.envRefs.forEach((ref) => envRefs.add(ref));
    return result.value;
  };

  switch (adapter) {
    case 'snowflake': {
      const privateKeyPath = read('private_key_path', 'privateKeyPath');
      const privateKey = read('private_key', 'privateKey');
      const authenticator = read('authenticator');
      const normalizedAuthenticator = authenticator?.toLowerCase().replace(/[\s_-]/g, '');
      const authMethod: ConnectionConfig['authMethod'] = privateKeyPath || privateKey || normalizedAuthenticator === 'snowflakejwt'
        ? 'key_pair'
        : normalizedAuthenticator === 'externalbrowser'
          ? 'external_browser'
          : normalizedAuthenticator === 'usernamepasswordmfa'
            ? 'mfa'
          : normalizedAuthenticator === 'oauthauthorizationcode'
            ? 'oauth_authorization_code'
          : normalizedAuthenticator === 'oauthclientcredentials'
            ? 'oauth_client_credentials'
          : normalizedAuthenticator === 'programmaticaccesstoken'
            ? 'programmatic_access_token'
          : normalizedAuthenticator === 'workloadidentity'
            ? 'workload_identity'
          : normalizedAuthenticator === 'oauth'
            ? 'oauth'
          : 'password';
      return {
        adapter,
        connection: compactConnection({
          driver: 'snowflake',
          account: read('account'),
          warehouse: read('warehouse'),
          database: read('database'),
          schema: read('schema'),
          username: read('user', 'username'),
          password: read('password'),
          role: read('role'),
          privateKeyPath,
          privateKey,
          privateKeyPassphrase: read('private_key_passphrase', 'privateKeyPassphrase'),
          authenticator,
          authMethod,
          token: read('token'),
          accessUrl: read('access_url', 'accessUrl'),
          application: read('application'),
          browserActionTimeout: readNumber(output, 'browser_action_timeout', 'browserActionTimeout'),
          clientRequestMFAToken: readBoolean(output, 'client_request_mfa_token', 'clientRequestMFAToken'),
          clientStoreTemporaryCredential: readBoolean(output, 'client_store_temporary_credential', 'clientStoreTemporaryCredential'),
          clientSessionKeepAlive: readBoolean(output, 'client_session_keep_alive', 'clientSessionKeepAlive'),
          clientSessionKeepAliveHeartbeatFrequency: readNumber(output, 'client_session_keep_alive_heartbeat_frequency', 'clientSessionKeepAliveHeartbeatFrequency'),
          credentialCacheDir: read('credential_cache_dir', 'credentialCacheDir'),
          keepAlive: readBoolean(output, 'keep_alive', 'keepAlive'),
          noProxy: read('no_proxy', 'noProxy'),
          oauthAuthorizationUrl: read('oauth_authorization_url', 'oauthAuthorizationUrl'),
          oauthClientId: read('oauth_client_id', 'oauthClientId'),
          oauthClientSecret: read('oauth_client_secret', 'oauthClientSecret'),
          oauthRedirectUri: read('oauth_redirect_uri', 'oauthRedirectUri'),
          oauthScope: read('oauth_scope', 'oauthScope'),
          oauthTokenRequestUrl: read('oauth_token_request_url', 'oauthTokenRequestUrl'),
          passcode: read('passcode'),
          passcodeInPassword: readBoolean(output, 'passcode_in_password', 'passcodeInPassword'),
          proxyHost: read('proxy_host', 'proxyHost'),
          proxyPassword: read('proxy_password', 'proxyPassword'),
          proxyPort: readNumber(output, 'proxy_port', 'proxyPort'),
          proxyProtocol: read('proxy_protocol', 'proxyProtocol'),
          proxyUser: read('proxy_user', 'proxyUser'),
          queryTag: read('query_tag', 'queryTag'),
          timeout: readNumber(output, 'timeout'),
          workloadIdentityProvider: read('workload_identity_provider', 'workloadIdentityProvider'),
          workloadIdentityAzureClientId: read('workload_identity_azure_client_id', 'workloadIdentityAzureClientId'),
        }),
        envRefs: [...envRefs],
        warnings,
      };
    }
    case 'duckdb':
      return {
        adapter,
        connection: compactConnection({
          driver: 'duckdb',
          filepath: read('path', 'database') ?? ':memory:',
        }),
        envRefs: [...envRefs],
        warnings,
      };
    case 'databricks': {
      const databricksAuth = read('auth_type', 'auth_method', 'authMethod');
      const authMethod: ConnectionConfig['authMethod'] = databricksAuth?.toLowerCase().includes('oauth') ? 'oauth' : 'token';
      return {
        adapter,
        connection: compactConnection({
          driver: 'databricks',
          host: read('host', 'server_hostname'),
          httpPath: read('http_path', 'httpPath'),
          warehouse: read('warehouse', 'warehouse_id'),
          catalog: read('catalog'),
          database: read('catalog', 'database'),
          schema: read('schema'),
          token: read('token'),
          authMethod,
          waitTimeout: read('wait_timeout', 'waitTimeout'),
          byteLimit: readNumber(output, 'byte_limit', 'byteLimit'),
        }),
        envRefs: [...envRefs],
        warnings,
      };
    }
    default:
      return null;
  }
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === 'boolean') return raw;
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(value)) return true;
    if (['false', '0', 'no', 'n'].includes(value)) return false;
  }
  return undefined;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = source[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function text(source: Record<string, unknown>, ...keys: string[]): DbtProfileTextResult {
  for (const key of keys) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    return resolveDbtEnvVars(value);
  }
  return { envRefs: [] };
}

function resolveDbtEnvVars(value: string): DbtProfileTextResult {
  const envRefs: string[] = [];
  const replaced = value.replace(
    /\{\{\s*env_var\(\s*['"]([^'"]+)['"]\s*(?:,\s*(['"])(.*?)\2)?\s*\)\s*\}\}/g,
    (_match, envKey: string, _quote: string | undefined, fallback: string | undefined) => {
      const envValue = process.env[envKey];
      if (envValue !== undefined) return envValue;
      if (fallback !== undefined) return fallback;
      envRefs.push(envKey);
      return `\${${envKey}}`;
    },
  );
  return { value: replaced, envRefs };
}

function compactConnection(connection: Partial<ConnectionConfig> & { driver: ConnectionConfig['driver'] }): ConnectionConfig {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(connection)) {
    if (value === undefined || value === null || value === '') continue;
    compact[key] = value;
  }
  return compact as unknown as ConnectionConfig;
}

function requiredConnectionFields(connection: ConnectionConfig, envRefs: string[]): string[] {
  const missing = new Set<string>();
  const needs = (field: keyof ConnectionConfig) => {
    const value = connection[field];
    if (value === undefined || value === null || value === '') missing.add(String(field));
  };

  switch (connection.driver) {
    case 'snowflake':
      needs('account');
      needs('warehouse');
      needs('database');
      needs('schema');
      needs('username');
      if (connection.authMethod === 'key_pair') {
        if (!connection.privateKeyPath && !connection.privateKey) {
          missing.add('privateKeyPath');
        }
      } else if (connection.authMethod === 'oauth') {
        if (!connection.token && !connection.password) {
          missing.add('token');
        }
      } else if (connection.authMethod === 'programmatic_access_token') {
        if (!connection.token && !connection.password) {
          missing.add('token');
        }
      } else if (connection.authMethod === 'oauth_authorization_code') {
        needs('oauthClientId');
        needs('oauthClientSecret');
      } else if (connection.authMethod === 'oauth_client_credentials') {
        needs('oauthClientId');
        needs('oauthClientSecret');
        needs('oauthTokenRequestUrl');
      } else if (connection.authMethod === 'workload_identity') {
        needs('workloadIdentityProvider');
      } else if (connection.authMethod !== 'external_browser') {
        needs('password');
      }
      break;
    case 'duckdb':
      needs('filepath');
      break;
    case 'databricks':
      needs('host');
      if (!connection.httpPath && !connection.warehouse) missing.add('httpPath');
      needs('token');
      break;
  }

  for (const envKey of envRefs) {
    if (!process.env[envKey]) missing.add(`env:${envKey}`);
  }

  return [...missing];
}

export function buildDbtStatus(projectRoot: string, projectConfig: ProjectConfig, lastSyncTime: string | null) {
  const dbtProjectPath = findDbtProjectPath(projectRoot, projectConfig);
  const configuredManifest = projectConfig.dbt?.manifestPath ?? 'target/manifest.json';
  const manifestPath = resolve(dbtProjectPath, configuredManifest);
  const catalogPath = resolve(dbtProjectPath, 'target/catalog.json');
  const semanticManifestPath = resolve(dbtProjectPath, 'target/semantic_manifest.json');
  const runResultsPath = resolve(dbtProjectPath, 'target/run_results.json');

  const manifest = readJsonFile(manifestPath);
  const semanticManifest = readJsonFile(semanticManifestPath);
  const projectName = typeof manifest?.metadata?.project_name === 'string'
    ? manifest.metadata.project_name
    : null;
  const nodes = manifest && typeof manifest === 'object' && manifest.nodes && typeof manifest.nodes === 'object'
    ? Object.values(manifest.nodes as Record<string, any>)
    : [];
  const modelCount = nodes.filter((node: any) => node?.resource_type === 'model').length;
  const sourceCount = manifest?.sources && typeof manifest.sources === 'object'
    ? Object.keys(manifest.sources).length
    : 0;
  const manifestMetricCount = artifactCollectionCount(manifest?.metrics);
  const semanticMetricCount = semanticManifest
    ? artifactCollectionCount(semanticManifest.metrics)
    : manifestMetricCount;
  const semanticModelCount = semanticManifest
    ? artifactCollectionCount(semanticManifest.semantic_models)
    : artifactCollectionCount(manifest?.semantic_models);
  const savedQueryCount = semanticManifest
    ? artifactCollectionCount(semanticManifest.saved_queries ?? semanticManifest.savedQueries)
    : artifactCollectionCount(manifest?.saved_queries ?? manifest?.savedQueries);
  const configured = existsSync(join(dbtProjectPath, 'dbt_project.yml'))
    || Boolean(projectConfig.dbt?.projectDir)
    || Boolean(projectConfig.semanticLayer?.provider === 'dbt' && projectConfig.semanticLayer.projectPath);
  const manifestExists = existsSync(manifestPath);
  const semanticExists = existsSync(semanticManifestPath);
  const setupHint = !configured
    ? 'No dbt project detected. Start without dbt or run DQL from a repo with dbt_project.yml.'
    : !manifestExists
      ? 'Run `dbt parse`, `dbt compile`, or `dbt build`, then run `dql sync dbt`.'
      : !semanticExists
        ? 'dbt manifest is ready. Run `dbt parse` or `dbt build` if you use dbt Semantic Layer metrics.'
        : semanticMetricCount === 0 && semanticModelCount === 0 && savedQueryCount === 0
          ? 'dbt manifest is ready, but MetricFlow semantic_manifest.json is empty. Add dbt semantic_models and metrics, then rerun dbt parse/build.'
        : 'dbt artifacts are ready. Build SQL blocks from models or semantic blocks from metrics.';

  return {
    configured,
    provider: projectConfig.semanticLayer?.provider ?? null,
    projectPath: dbtProjectPath,
    projectName,
    artifacts: {
      manifest: describeArtifact(manifestPath, modelCount + sourceCount, manifest?.metadata?.generated_at),
      catalog: describeArtifact(catalogPath),
      semanticManifest: describeArtifact(semanticManifestPath, semanticMetricCount + semanticModelCount + savedQueryCount, semanticManifest?.metadata?.generated_at),
      runResults: describeArtifact(runResultsPath),
    },
    counts: {
      models: modelCount,
      sources: sourceCount,
      metrics: semanticMetricCount,
      semanticModels: semanticModelCount,
      savedQueries: savedQueryCount,
    },
    lastSyncTime,
    setupHint,
  };
}

export type SemanticLayerDiagnosticsIssueSeverity = 'info' | 'warning' | 'error';

export interface SemanticLayerDiagnosticsIssue {
  severity: SemanticLayerDiagnosticsIssueSeverity;
  code: string;
  message: string;
  action?: string;
  path?: string;
}

export function buildSemanticLayerDiagnostics(
  projectRoot: string,
  projectConfig: ProjectConfig,
  options: {
    semanticLayer?: SemanticLayer;
    semanticErrors?: string[];
    semanticConfig?: SemanticLayerProviderConfig;
    detectedProvider?: string;
    lastSyncTime: string | null;
  },
) {
  const provider = options.semanticConfig?.provider ?? options.detectedProvider ?? null;
  const dbt = buildDbtStatus(projectRoot, projectConfig, options.lastSyncTime);
  const counts = semanticLayerCounts(options.semanticLayer);
  const uncategorizedObjects = countUncategorizedSemanticObjects(options.semanticLayer);
  const totalObjects = counts.metrics
    + counts.measures
    + counts.dimensions
    + counts.timeDimensions
    + counts.entities
    + counts.hierarchies
    + counts.semanticModels
    + counts.savedQueries;
  const issues: SemanticLayerDiagnosticsIssue[] = [];

  for (const error of options.semanticErrors ?? []) {
    issues.push({
      severity: 'error',
      code: 'semantic_load_error',
      message: error,
      action: 'Open the semantic source configuration, fix the provider error, then reload the semantic layer.',
    });
  }

  if (!provider) {
    issues.push({
      severity: existsSync(join(projectRoot, 'semantic-layer')) ? 'info' : 'warning',
      code: 'semantic_provider_not_configured',
      message: 'No semantic layer provider is configured.',
      action: 'Configure dbt MetricFlow, local semantic-layer YAML, or Snowflake Semantic Views from the setup flow.',
    });
  }

  if (provider === 'dbt' || dbt.configured) {
    if (!dbt.configured) {
      issues.push({
        severity: 'warning',
        code: 'dbt_project_not_detected',
        message: 'dbt is selected as the semantic source, but no dbt project was detected.',
        action: 'Set dbt.projectDir or run DQL from a repository containing dbt_project.yml.',
      });
    }
    if (!dbt.artifacts.manifest.exists) {
      issues.push({
        severity: 'error',
        code: 'dbt_manifest_missing',
        message: 'dbt manifest.json is missing, so DQL cannot build dbt model context.',
        action: 'Run dbt parse, dbt compile, or dbt build, then reload the semantic layer.',
        path: dbt.artifacts.manifest.path,
      });
    }
    if (!dbt.artifacts.semanticManifest.exists) {
      issues.push({
        severity: 'warning',
        code: 'metricflow_semantic_manifest_missing',
        message: 'dbt MetricFlow semantic_manifest.json is missing. DQL can still inspect dbt models, but MetricFlow metrics and saved queries may be incomplete.',
        action: 'Run dbt parse or dbt build with semantic models configured, then reload. For execution, ensure MetricFlow is installed and mf is on PATH.',
        path: dbt.artifacts.semanticManifest.path,
      });
    } else if (dbt.counts.metrics === 0 && dbt.counts.semanticModels === 0 && dbt.counts.savedQueries === 0) {
      issues.push({
        severity: 'warning',
        code: 'metricflow_semantic_manifest_empty',
        message: 'semantic_manifest.json exists, but it does not contain metrics, semantic models, or saved queries.',
        action: 'Check dbt semantic model YAML definitions and rerun dbt parse.',
        path: dbt.artifacts.semanticManifest.path,
      });
    }
    if (options.semanticLayer && totalObjects === 0 && (dbt.counts.models > 0 || dbt.counts.sources > 0)) {
      issues.push({
        severity: 'warning',
        code: 'dbt_model_inventory_only',
        message: 'DQL loaded dbt model inventory, but no MetricFlow semantic metrics were found.',
        action: 'Create dbt semantic_models and metrics, or use AI Import to build DQL blocks from dbt model metadata.',
      });
    }
  }

  if (provider === 'snowflake') {
    if (!options.semanticLayer && (options.semanticErrors ?? []).length === 0) {
      issues.push({
        severity: 'warning',
        code: 'snowflake_semantic_views_not_loaded',
        message: 'Snowflake semantic provider did not load semantic views.',
        action: 'Confirm the active Snowflake connection can query semantic views, then reload. Warehouse tables still feed database context separately.',
      });
    } else if (options.semanticLayer && totalObjects === 0) {
      issues.push({
        severity: 'info',
        code: 'snowflake_semantic_views_empty',
        message: 'Snowflake semantic provider loaded, but no semantic view objects were discovered.',
        action: 'Check that Snowflake Semantic Views exist and the active role can see them.',
      });
    }
  }

  if (options.semanticLayer && totalObjects === 0 && issues.every((issue) => issue.code !== 'dbt_model_inventory_only')) {
    issues.push({
      severity: 'warning',
      code: 'semantic_layer_empty',
      message: 'Semantic layer is available, but no semantic objects are loaded.',
      action: 'Import semantic definitions or run dbt parse/build, then reload.',
    });
  }

  if (uncategorizedObjects > 0) {
    issues.push({
      severity: 'info',
      code: 'semantic_uncategorized_domain',
      message: `${uncategorizedObjects} semantic object${uncategorizedObjects === 1 ? '' : 's'} had no domain and are visible under "uncategorized".`,
      action: 'Add domain metadata in dbt semantic YAML or local semantic-layer files when domain ownership matters.',
    });
  }

  const warnings = Array.from(new Set([
    ...(options.semanticErrors ?? []),
    ...issues
      .filter((issue) => issue.severity !== 'info')
      .map((issue) => issue.message),
  ]));

  return {
    available: Boolean(options.semanticLayer),
    provider,
    sourceOfTruth: provider === 'dbt'
      ? 'dbt MetricFlow semantic_manifest.json, dbt manifest.json semantic nodes, then dbt semantic YAML fallback'
      : provider === 'snowflake'
        ? 'Snowflake Semantic Views only; warehouse tables remain database catalog context'
        : provider === 'dql'
          ? 'local semantic-layer YAML'
          : 'not configured',
    errors: options.semanticErrors ?? [],
    lastSyncTime: options.lastSyncTime,
    counts,
    dbt,
    issues,
    warnings,
  };
}

function semanticLayerCounts(layer: SemanticLayer | undefined) {
  return layer
    ? {
        domains: layer.listDomains().length,
        metrics: layer.listMetrics().length,
        measures: layer.listMeasures().length,
        dimensions: layer.listDimensions().length,
        timeDimensions: layer.listTimeDimensions().length,
        entities: layer.listEntities().length,
        hierarchies: layer.listHierarchies().length,
        semanticModels: layer.listSemanticModels().length,
        savedQueries: layer.listSavedQueries().length,
      }
    : {
        domains: 0,
        metrics: 0,
        measures: 0,
        dimensions: 0,
        timeDimensions: 0,
        entities: 0,
        hierarchies: 0,
        semanticModels: 0,
        savedQueries: 0,
      };
}

function countUncategorizedSemanticObjects(layer: SemanticLayer | undefined): number {
  if (!layer) return 0;
  return [
    ...layer.listMetrics(),
    ...layer.listMeasures(),
    ...layer.listDimensions(),
    ...layer.listTimeDimensions(),
    ...layer.listEntities(),
    ...layer.listHierarchies(),
    ...layer.listSemanticModels(),
    ...layer.listSavedQueries(),
  ].filter((object) => !object.domain || !object.domain.trim()).length;
}

function artifactCollectionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length;
  return 0;
}

function describeArtifact(path: string, count?: number, generatedAt?: string | null) {
  return {
    path,
    exists: existsSync(path),
    count,
    generatedAt: generatedAt ?? null,
  };
}

function readJsonFile(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function resolveLineageNode(graph: LineageGraph, rawNodeId: string) {
  if (graph.getNode(rawNodeId)) return graph.getNode(rawNodeId);
  const result = queryLineage(graph, { focus: rawNodeId });
  return result.focalNode;
}

function buildScopedLineage(
  graph: LineageGraph,
  scope: { domain?: string; appId?: string; dashboardId?: string; blockId?: string },
) {
  const focus = scope.blockId
    ? `block:${scope.blockId}`
    : scope.dashboardId
      ? `dashboard:${scope.appId ? `${scope.appId}/${scope.dashboardId}` : scope.dashboardId}`
      : scope.appId
        ? `app:${scope.appId}`
        : undefined;
  const result = queryLineage(graph, {
    focus,
    domain: focus ? undefined : scope.domain,
    upstreamDepth: 8,
    downstreamDepth: 4,
  });
  const graphJson = result.graph ?? graph.toJSON();
  const breadcrumbs = [
    scope.domain ? graph.getNode(`domain:${scope.domain}`) : null,
    scope.appId ? graph.getNode(`app:${scope.appId}`) : null,
    scope.dashboardId ? graph.getNode(`dashboard:${scope.appId ? `${scope.appId}/${scope.dashboardId}` : scope.dashboardId}`) : null,
    scope.blockId ? graph.getNode(`block:${scope.blockId}`) : null,
  ].filter(Boolean);
  const paths = focus ? queryCompleteLineagePaths(graph, focus, { maxDepth: 12, maxPaths: 20 }) : null;
  return {
    scope,
    focus,
    graph: graphJson,
    focalNode: result.focalNode,
    breadcrumbs,
    paths,
    view: 'Domain > App > Dashboard tab > Tile > Block > Semantic/dbt/source',
  };
}

function extractProp(block: any, key: string): string | undefined {
  // Check direct AST fields first (parser puts domain, owner, type directly on the node)
  if (block[key] !== undefined && block[key] !== null) return String(block[key]);
  for (const prop of block.properties ?? []) {
    if (prop.key === key && prop.value?.kind === 'Literal') return String(prop.value.value);
  }
  return undefined;
}

function extractVizChart(block: any): string | undefined {
  for (const prop of block.visualization?.properties ?? []) {
    if (prop.key === 'chart' && prop.value?.kind === 'Literal') return String(prop.value.value);
  }
  return undefined;
}

// ── Git read-only helpers (v0.11) ──────────────────────────────────────────
// Shell out to the system `git` binary rather than embed isomorphic-git.
// Users already have git installed to be in a git repo; shelling out keeps
// the notebook bundle lean and avoids re-implementing what `git` already
// does perfectly. All commands run with `cwd = projectRoot` and never take
// user-controlled args (only fixed subcommands + the file path, which we
// pass as a separate execFile arg so it's never interpreted as shell).

export interface GitStatusResult {
  inRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; status: string }>;
  error?: string;
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: err ? ((err as NodeJS.ErrnoException).code ? 1 : (err as any).code ?? 1) : 0,
      });
    });
  });
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  const isRepo = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (isRepo.code !== 0 || isRepo.stdout.trim() !== 'true') return null;
  const root = await execGit(cwd, ['rev-parse', '--show-toplevel']);
  return root.code === 0 && root.stdout.trim() ? root.stdout.trim() : cwd;
}

async function readGitStatus(cwd: string): Promise<GitStatusResult> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) {
    return { inRepo: false, branch: null, ahead: 0, behind: 0, changes: [] };
  }
  const branchRes = await execGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;

  const trackRes = await execGit(gitRoot, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  let ahead = 0;
  let behind = 0;
  if (trackRes.code === 0) {
    const match = trackRes.stdout.trim().split(/\s+/);
    behind = Number(match[0] ?? 0);
    ahead = Number(match[1] ?? 0);
  }

  const statusRes = await execGit(gitRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const changes: Array<{ path: string; status: string }> = [];
  if (statusRes.code === 0) {
    for (const line of statusRes.stdout.split('\n')) {
      if (!line) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3);
      changes.push({ path: p, status: code });
    }
  }
  return { inRepo: true, branch, ahead, behind, changes };
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

async function readGitLog(cwd: string, limit: number): Promise<{ inRepo: boolean; commits: GitCommit[] }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { inRepo: false, commits: [] };
  const sep = '\x1f';
  const end = '\x1e';
  const fmt = ['%H', '%an', '%ad', '%s'].join(sep) + end;
  const res = await execGit(gitRoot, ['log', `-${limit}`, `--pretty=format:${fmt}`, '--date=short']);
  if (res.code !== 0) return { inRepo: true, commits: [] };
  const commits: GitCommit[] = [];
  for (const entry of res.stdout.split(end)) {
    const trimmed = entry.replace(/^\n/, '');
    if (!trimmed) continue;
    const [hash, author, date, subject] = trimmed.split(sep);
    if (hash) commits.push({ hash, author, date, subject });
  }
  return { inRepo: true, commits };
}

function snapshotPathFor(projectRoot: string, notebookPath: string): string | null {
  const abs = safeJoin(projectRoot, notebookPath);
  if (!abs) return null;
  // Strip extension and append `.run.json` so `foo.dqlnb` → `foo.run.json`
  // and `bar.dql` → `bar.run.json`. Keeps the sibling file next to source.
  const dot = abs.lastIndexOf('.');
  const base = dot > abs.lastIndexOf('/') ? abs.slice(0, dot) : abs;
  return `${base}.run.json`;
}

function readRunSnapshot(projectRoot: string, notebookPath: string): { found: boolean; snapshot: unknown | null } {
  const p = snapshotPathFor(projectRoot, notebookPath);
  if (!p || !existsSync(p)) return { found: false, snapshot: null };
  try {
    const raw = readFileSync(p, 'utf-8');
    return { found: true, snapshot: JSON.parse(raw) };
  } catch {
    return { found: false, snapshot: null };
  }
}

function writeRunSnapshot(projectRoot: string, notebookPath: string, snapshot: unknown): void {
  const p = snapshotPathFor(projectRoot, notebookPath);
  if (!p) throw new Error('Invalid path');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(snapshot, null, 2), 'utf-8');
  // Append `*.run.json` to .gitignore once, so snapshots don't pollute git
  // history unless the user deliberately un-ignores them.
  ensureGitignoreEntry(projectRoot, '*.run.json');
}

function ensureGitignoreEntry(projectRoot: string, pattern: string): void {
  try {
    const gitignorePath = join(projectRoot, '.gitignore');
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    const lines = existing.split('\n').map((l) => l.trim());
    if (lines.includes(pattern)) return;
    const next = existing.endsWith('\n') || existing === ''
      ? `${existing}${pattern}\n`
      : `${existing}\n${pattern}\n`;
    writeFileSync(gitignorePath, next, 'utf-8');
  } catch {
    // Best-effort; failure to write .gitignore shouldn't fail the snapshot.
  }
}

async function readGitDiff(
  cwd: string,
  filePath: string,
  staged = false,
): Promise<{
  inRepo: boolean;
  diff: string;
  before: string | null;
  after: string | null;
  diffReport: DiffReport | null;
}> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) {
    return { inRepo: false, diff: '', before: null, after: null, diffReport: null };
  }
  const baseArgs = staged ? ['diff', '--cached', '--no-color'] : ['diff', '--no-color'];
  if (!filePath) {
    const res = await execGit(gitRoot, baseArgs);
    return { inRepo: true, diff: res.stdout, before: null, after: null, diffReport: null };
  }
  const isSemantic = filePath.endsWith('.dql') || filePath.endsWith('.dqlnb');
  const [diffRes, before, after] = await Promise.all([
    execGit(gitRoot, [...baseArgs, '--', filePath]),
    isSemantic ? readHeadBlob(gitRoot, filePath) : Promise.resolve<string | null>(null),
    isSemantic ? readWorkingCopy(join(gitRoot, filePath)) : Promise.resolve<string | null>(null),
  ]);
  const diffText = !staged && !diffRes.stdout.trim()
    ? (await readUntrackedTextDiff(gitRoot, filePath)) || diffRes.stdout
    : diffRes.stdout;
  const diffReport = isSemantic ? computeSemanticDiff(filePath, before, after) : null;
  return { inRepo: true, diff: diffText, before, after, diffReport };
}

const MAX_UNTRACKED_DIFF_FILES = 20;
const MAX_UNTRACKED_DIFF_BYTES = 512 * 1024;

async function readUntrackedTextDiff(cwd: string, filePath: string): Promise<string> {
  const status = await execGit(cwd, ['status', '--porcelain=v1', '--untracked-files=normal', '--', filePath]);
  if (status.code !== 0 || !status.stdout.split('\n').some((line) => line.startsWith('?? '))) {
    return '';
  }

  const listed = await execGit(cwd, ['ls-files', '--others', '--exclude-standard', '--', filePath]);
  if (listed.code !== 0) return '';

  const chunks: string[] = [];
  let totalBytes = 0;
  for (const rawPath of listed.stdout.split('\n').map((p) => p.trim()).filter(Boolean)) {
    if (chunks.length >= MAX_UNTRACKED_DIFF_FILES || totalBytes >= MAX_UNTRACKED_DIFF_BYTES) break;
    const absPath = safeJoin(cwd, rawPath);
    if (!absPath || !existsSync(absPath)) continue;
    const st = statSync(absPath);
    if (!st.isFile()) continue;
    if (st.size > MAX_UNTRACKED_DIFF_BYTES) {
      chunks.push(formatBinaryAddedDiff(rawPath));
      continue;
    }
    const buf = readFileSync(absPath);
    if (buf.includes(0)) {
      chunks.push(formatBinaryAddedDiff(rawPath));
      continue;
    }
    totalBytes += buf.length;
    chunks.push(formatAddedFileDiff(rawPath, buf.toString('utf-8')));
  }
  if (chunks.length === 0) return '';
  const omitted = listed.stdout.split('\n').filter(Boolean).length - chunks.length;
  if (omitted > 0) {
    chunks.push(`diff --git a/${filePath} b/${filePath}\n# ${omitted} additional untracked file${omitted === 1 ? '' : 's'} omitted from preview`);
  }
  return chunks.join('\n');
}

function formatAddedFileDiff(filePath: string, content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const hasFinalNewline = normalized.endsWith('\n');
  const lines = normalized.length === 0
    ? []
    : normalized.split('\n').slice(0, hasFinalNewline ? -1 : undefined);
  const hunk = lines.length > 0
    ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]
    : [];
  if (!hasFinalNewline && normalized.length > 0) hunk.push('\\ No newline at end of file');
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${filePath}`,
    ...hunk,
  ].join('\n');
}

function formatBinaryAddedDiff(filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `Binary file ${filePath} added`,
  ].join('\n');
}

// ── git write operations ──────────────────────────────────────────────────
// Each helper validates inputs, shells out via execFile (no shell expansion),
// then reports the trimmed stderr on failure so the UI can surface it. We
// never accept absolute paths or paths containing `..` — staged paths must
// stay inside the project root.

function validatePaths(cwd: string, paths: string[]): { ok: true; paths: string[] } | { ok: false; error: string } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'No paths provided' };
  }
  const cleaned: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0) return { ok: false, error: 'Invalid path' };
    if (p.startsWith('/')) return { ok: false, error: `Absolute path not allowed: ${p}` };
    if (p.split('/').includes('..')) return { ok: false, error: `Path escape not allowed: ${p}` };
    const resolved = join(cwd, p);
    if (!resolved.startsWith(cwd)) return { ok: false, error: `Path outside project: ${p}` };
    cleaned.push(p);
  }
  return { ok: true, paths: cleaned };
}

function gitErrorOutput(res: { stdout: string; stderr: string }): string {
  return (res.stderr || res.stdout || '').trim();
}

async function gitStage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  const v = validatePaths(gitRoot, paths);
  if (!v.ok) return { ok: false, error: v.error };
  const res = await execGit(gitRoot, ['add', '--', ...v.paths]);
  return res.code === 0 ? { ok: true } : { ok: false, error: gitErrorOutput(res) };
}

async function gitUnstage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  const v = validatePaths(gitRoot, paths);
  if (!v.ok) return { ok: false, error: v.error };
  // `restore --staged` works with or without HEAD; for an initial commit (no
  // HEAD yet) git's `rm --cached` is the fallback. Try restore first.
  const res = await execGit(gitRoot, ['restore', '--staged', '--', ...v.paths]);
  if (res.code === 0) return { ok: true };
  const fallback = await execGit(gitRoot, ['rm', '--cached', '-r', '--', ...v.paths]);
  return fallback.code === 0 ? { ok: true } : { ok: false, error: gitErrorOutput(fallback) };
}

async function gitDiscard(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  const v = validatePaths(gitRoot, paths);
  if (!v.ok) return { ok: false, error: v.error };
  // For tracked files: `restore --worktree` reverts to HEAD. For untracked
  // files: that's a no-op and we delete them via `clean -f`. Run both so
  // the caller doesn't have to know which list each path is in.
  const restore = await execGit(gitRoot, ['restore', '--worktree', '--', ...v.paths]);
  const clean = await execGit(gitRoot, ['clean', '-f', '--', ...v.paths]);
  if (restore.code !== 0 && clean.code !== 0) {
    return { ok: false, error: gitErrorOutput(restore) || gitErrorOutput(clean) };
  }
  return { ok: true };
}

async function gitCommit(cwd: string, message: string, stageAll: boolean): Promise<{ ok: boolean; error?: string; hash?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: 'Commit message required' };
  if (stageAll) {
    const add = await execGit(gitRoot, ['add', '-A']);
    if (add.code !== 0) return { ok: false, error: gitErrorOutput(add) };
  }
  const res = await execGit(gitRoot, ['commit', '-m', trimmed]);
  if (res.code !== 0) return { ok: false, error: gitErrorOutput(res) };
  const hashRes = await execGit(gitRoot, ['rev-parse', 'HEAD']);
  return { ok: true, hash: hashRes.code === 0 ? hashRes.stdout.trim() : undefined };
}

async function gitPush(cwd: string): Promise<{ ok: boolean; error?: string; output?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  const branch = await execGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = await execGit(gitRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remotes = await execGit(gitRoot, ['remote']);
  const remote = remotes.stdout.split('\n').map((s) => s.trim()).find(Boolean) ?? 'origin';
  const branchName = branch.code === 0 ? branch.stdout.trim() : '';
  const args = upstream.code === 0 || !branchName || branchName === 'HEAD'
    ? ['push']
    : ['push', '-u', remote, branchName];
  const res = await execGit(gitRoot, args);
  return res.code === 0
    ? { ok: true, output: gitErrorOutput(res) }
    : { ok: false, error: gitErrorOutput(res) };
}

async function gitPull(cwd: string): Promise<{ ok: boolean; error?: string; output?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  // `--ff-only` keeps the operation non-destructive: if the local branch has
  // diverged from upstream, we surface the error rather than auto-merging.
  // The user can resolve via the terminal or a future merge UI.
  const res = await execGit(gitRoot, ['pull', '--ff-only']);
  return res.code === 0
    ? { ok: true, output: gitErrorOutput(res) }
    : { ok: false, error: gitErrorOutput(res) };
}

async function readGitBranches(cwd: string): Promise<{ inRepo: boolean; current: string | null; branches: string[] }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { inRepo: false, current: null, branches: [] };
  const cur = await execGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const list = await execGit(gitRoot, ['branch', '--list', '--format=%(refname:short)']);
  const branches = list.code === 0
    ? list.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  return { inRepo: true, current: cur.code === 0 ? cur.stdout.trim() : null, branches };
}

async function readGitRemote(cwd: string): Promise<{ inRepo: boolean; url: string | null; name: string | null }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { inRepo: false, url: null, name: null };
  const remoteName = await execGit(gitRoot, ['config', '--get', 'remote.pushDefault']);
  const name = remoteName.code === 0 && remoteName.stdout.trim() ? remoteName.stdout.trim() : 'origin';
  const url = await execGit(gitRoot, ['remote', 'get-url', name]);
  return { inRepo: true, url: url.code === 0 ? url.stdout.trim() : null, name };
}

async function gitCreateBranch(cwd: string, name: string, checkout: boolean): Promise<{ ok: boolean; error?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  const trimmed = name.trim();
  // Branch names can't start with `-` (would be parsed as a flag) and must be
  // non-empty. git itself enforces the rest of the ref-name rules.
  if (!trimmed) return { ok: false, error: 'Branch name required' };
  if (trimmed.startsWith('-')) return { ok: false, error: 'Invalid branch name' };
  const res = checkout
    ? await execGit(gitRoot, ['checkout', '-b', trimmed])
    : await execGit(gitRoot, ['branch', trimmed]);
  return res.code === 0 ? { ok: true } : { ok: false, error: gitErrorOutput(res) };
}

async function gitCheckout(cwd: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const gitRoot = await resolveGitRoot(cwd);
  if (!gitRoot) return { ok: false, error: 'Not a git repository' };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Branch name required' };
  if (trimmed.startsWith('-')) return { ok: false, error: 'Invalid branch name' };
  const res = await execGit(gitRoot, ['checkout', trimmed]);
  return res.code === 0 ? { ok: true } : { ok: false, error: gitErrorOutput(res) };
}

async function readHeadBlob(cwd: string, filePath: string): Promise<string | null> {
  try {
    const res = await execGit(cwd, ['show', `HEAD:${filePath}`]);
    return res.code === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

async function readWorkingCopy(absPath: string): Promise<string | null> {
  try {
    return readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

function computeSemanticDiff(
  filePath: string,
  before: string | null,
  after: string | null,
): DiffReport | null {
  if (before === after) return null;
  try {
    return filePath.endsWith('.dqlnb')
      ? diffNotebook(before, after)
      : diffDQL(before ?? '', after ?? '');
  } catch {
    return null;
  }
}

type SettingsEnvVar = {
  key: string;
  label: string;
  present: boolean;
  optional: boolean;
  description: string;
};

type SettingsEnvGroup = {
  id: string;
  title: string;
  description: string;
  vars: SettingsEnvVar[];
};

function collectSettingsEnvStatus(): SettingsEnvGroup[] {
  const v = (key: string, label: string, description: string, optional = true): SettingsEnvVar => ({
    key,
    label,
    description,
    optional,
    present: typeof process.env[key] === 'string' && process.env[key]!.trim().length > 0,
  });

  return [
    {
      id: 'ai',
      title: 'AI Chat Providers',
      description: 'Configure one or more providers. Missing keys are only a problem when that provider is selected.',
      vars: [
        v('ANTHROPIC_API_KEY', 'Claude Agent SDK', 'Hosted Claude provider for notebook Chat and agent commands.'),
        v('OPENAI_API_KEY', 'OpenAI', 'Hosted OpenAI provider for notebook Chat and agent commands.'),
        v('OPENAI_MODEL', 'OpenAI model', 'Optional override such as gpt-4.1-mini or the model your account uses.'),
        v('GEMINI_API_KEY', 'Gemini', 'Hosted Gemini provider for notebook Chat and agent commands.'),
        v('GEMINI_MODEL', 'Gemini model', 'Optional Gemini model override.'),
        v('OLLAMA_BASE_URL', 'Ollama base URL', 'Local Ollama HTTP endpoint. Docker defaults to http://ollama:11434.'),
        v('OLLAMA_MODEL', 'Ollama model', 'Optional local model name such as llama3.1.'),
      ],
    },
    {
      id: 'slack',
      title: 'Slack',
      description: 'Use webhooks for scheduled App deliveries, or bot credentials for the Slack chat front-end.',
      vars: [
        v('DQL_SLACK_WEBHOOK', 'Schedule webhook', 'Incoming webhook used by App schedules that deliver to Slack.'),
        v('SLACK_SIGNING_SECRET', 'Slack signing secret', 'Required only when running `dql slack serve`.'),
        v('SLACK_BOT_TOKEN', 'Slack bot token', 'Bot token used by Slack chat commands when `dql slack serve` is enabled.'),
      ],
    },
    {
      id: 'email',
      title: 'Email',
      description: 'SMTP is optional. Without it, email schedules stay in stub mode with a clear delivery message.',
      vars: [
        v('DQL_SMTP_URL', 'SMTP URL', 'SMTP connection URL for email schedule delivery.'),
        v('DQL_SMTP_FROM', 'SMTP sender', 'Optional sender address for scheduled emails.'),
      ],
    },
    {
      id: 'runtime',
      title: 'Runtime',
      description: 'Local server and runtime toggles used by Docker and native notebook sessions.',
      vars: [
        v('DQL_HOST', 'Notebook bind host', 'Host interface for the local notebook server. Docker uses 0.0.0.0 inside the container.'),
        v('DQL_RUNTIME_URL', 'Runtime URL', 'Optional URL used by headless agent commands to call an existing runtime.'),
        v('DQL_LLM_KEY', 'Legacy LLM key', 'Fallback key accepted by older Claude provider configurations.'),
      ],
    },
  ];
}

function isProviderSettingsId(value: unknown): value is ProviderSettingsId {
  return value === 'anthropic'
    || value === 'openai'
    || value === 'gemini'
    || value === 'ollama'
    || value === 'custom-openai';
}

function isDeterministicDqlGenerationProvider(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value === 'none' || value === 'deterministic' || value === 'local-deterministic';
}

async function testProviderConfig(projectRoot: string, id: ProviderSettingsId): Promise<{ ok: boolean; message: string }> {
  const config = getEffectiveProviderConfig(projectRoot, id);
  const label = providerSettingsLabel(id);
  const details = providerConfigDetails(id, config);
  if (!config.enabled) {
    return { ok: false, message: `${label} is disabled in Settings.` };
  }
  if (id === 'openai') return testOpenAIProviderConfig(config, label, details);
  if (id === 'anthropic') return testAnthropicProviderConfig(config, label, details);

  let provider: AgentProvider;
  switch (id) {
    case 'gemini':
      provider = new GeminiProvider({ apiKey: config.apiKey, model: config.model });
      break;
    case 'ollama':
      provider = new OllamaProvider({ baseUrl: config.baseUrl, model: config.model });
      break;
    case 'custom-openai':
    default:
      provider = new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, allowNoApiKey: true });
      break;
  }
  const available = await provider.available().catch(() => false);
  if (!available) {
    return {
      ok: false,
      message: `${label} is not configured or reachable${details}. Check API key, base URL, and local service state.`,
    };
  }
  try {
    const text = await provider.generate([
      { role: 'user', content: 'Reply with exactly: OK' },
    ], { maxTokens: 8, temperature: 0 });
    return {
      ok: true,
      message: `${label} responded${details}: ${text.trim().slice(0, 80) || 'OK'}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `${label} is configured but the model call failed${details}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testOpenAIProviderConfig(
  config: ReturnType<typeof getEffectiveProviderConfig>,
  label: string,
  details: string,
): Promise<{ ok: boolean; message: string }> {
  if (!config.apiKey) {
    return { ok: false, message: `${label} is not configured${details}. Add an API key in Settings or OPENAI_API_KEY.` };
  }
  try {
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
    const response = await client.responses.create({
      model: config.model ?? 'gpt-5.5',
      input: 'Reply with exactly: OK',
      max_output_tokens: 16,
    } as never) as unknown as { output_text?: string };
    return {
      ok: true,
      message: `${label} SDK responded${details}: ${(response.output_text ?? 'OK').trim().slice(0, 80) || 'OK'}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `${label} SDK call failed${details}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testAnthropicProviderConfig(
  config: ReturnType<typeof getEffectiveProviderConfig>,
  label: string,
  details: string,
): Promise<{ ok: boolean; message: string }> {
  if (!config.apiKey) {
    return { ok: false, message: `${label} is not configured${details}. Add an API key in Settings or ANTHROPIC_API_KEY.` };
  }
  try {
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create({
      model: config.model ?? 'claude-opus-4-8',
      max_tokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    } as never) as unknown as { content?: Array<{ type?: string; text?: string }> };
    const text = response.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') ?? '';
    return {
      ok: true,
      message: `${label} SDK responded${details}: ${text.trim().slice(0, 80) || 'OK'}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `${label} SDK call failed${details}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function providerSettingsLabel(id: ProviderSettingsId): string {
  switch (id) {
    case 'anthropic': return 'Anthropic Claude';
    case 'openai': return 'OpenAI';
    case 'gemini': return 'Gemini';
    case 'ollama': return 'Ollama';
    case 'custom-openai': return 'Custom OpenAI-compatible provider';
  }
}

function providerConfigDetails(id: ProviderSettingsId, config: ReturnType<typeof getEffectiveProviderConfig>): string {
  const parts = [
    config.model ? `model ${config.model}` : '',
    config.baseUrl ? `base URL ${config.baseUrl}` : '',
    id === 'ollama' ? 'local endpoint' : config.apiKey ? 'API key present' : 'API key missing',
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function isAiPinRefreshDue(lastRefreshedAt?: string): boolean {
  if (!lastRefreshedAt) return true;
  const last = Date.parse(lastRefreshedAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= 24 * 60 * 60 * 1000;
}

async function buildAgentSchemaContextFromCatalog(projectRoot: string, question: string): Promise<AgentSchemaTable[]> {
  const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 80 });
  return buildAgentSchemaContextFromContextPack(question, contextPack);
}

function recordAgentRuntimeSchemaSnapshot(projectRoot: string, schemaContext: AgentSchemaTable[], source: string): void {
  if (schemaContext.length === 0) return;
  try {
    recordRuntimeSchemaSnapshot(projectRoot, {
      source,
      tables: schemaContext.slice(0, 80).map((table) => ({
        relation: table.relation,
        schema: table.schema,
        name: table.name,
        description: table.description,
        source: table.source,
        columns: table.columns.slice(0, 120).map((column) => ({
          name: column.name,
          type: column.type,
          description: column.description,
          sampleValues: column.sampleValues?.slice(0, 8),
        })),
      })),
    });
  } catch {
    // Runtime schema snapshots are advisory local metadata and must not block answers.
  }
}

function notebookResearchString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function notebookResearchRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function notebookResearchSourceCellPayload(body: Record<string, unknown>): NotebookResearchSourceCellInput | undefined {
  const sourceCell = notebookResearchRecord(body.sourceCell)
    ?? notebookResearchRecord(notebookResearchRecord(body.context)?.sourceCell);
  if (!sourceCell) return undefined;
  const payload: NotebookResearchSourceCellInput = {
    id: notebookResearchString(sourceCell.id),
    sourceCellId: notebookResearchString(sourceCell.sourceCellId),
    cellId: notebookResearchString(sourceCell.cellId),
    name: notebookResearchString(sourceCell.name),
    sourceCellName: notebookResearchString(sourceCell.sourceCellName),
    title: notebookResearchString(sourceCell.title),
    fingerprint: notebookResearchString(sourceCell.fingerprint),
    sourceCellFingerprint: notebookResearchString(sourceCell.sourceCellFingerprint),
    sqlFingerprint: notebookResearchString(sourceCell.sqlFingerprint),
    type: notebookResearchString(sourceCell.type),
    sql: notebookResearchString(sourceCell.sql),
    content: notebookResearchString(sourceCell.content),
    source: notebookResearchString(sourceCell.source),
  };
  return Object.values(payload).some(Boolean) ? payload : undefined;
}

function notebookResearchSourceCellId(sourceCell: NotebookResearchSourceCellInput | undefined): string | undefined {
  return notebookResearchString(sourceCell?.id)
    ?? notebookResearchString(sourceCell?.sourceCellId)
    ?? notebookResearchString(sourceCell?.cellId);
}

function notebookResearchSourceCellName(sourceCell: NotebookResearchSourceCellInput | undefined): string | undefined {
  return notebookResearchString(sourceCell?.name)
    ?? notebookResearchString(sourceCell?.sourceCellName)
    ?? notebookResearchString(sourceCell?.title);
}

function notebookResearchSourceCellFingerprint(sourceCell: NotebookResearchSourceCellInput | undefined): string | undefined {
  return notebookResearchString(sourceCell?.sourceCellFingerprint)
    ?? notebookResearchString(sourceCell?.fingerprint)
    ?? notebookResearchString(sourceCell?.sqlFingerprint);
}

function notebookResearchPatchString(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
  return notebookResearchString(body[key]) ?? null;
}

function notebookResearchIntent(value: unknown): NotebookResearchIntent | undefined {
  return value === 'ad_hoc_analysis'
    || value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
    ? value
    : undefined;
}

function notebookResearchReviewStatus(value: unknown): NotebookResearchRun['reviewStatus'] | undefined {
  return value === 'needs_review'
    || value === 'draft_created'
    || value === 'completed'
    || value === 'certified'
    || value === 'rejected'
    ? value
    : undefined;
}

function notebookResearchStatus(value: unknown): NotebookResearchRun['status'] | undefined {
  return value === 'draft'
    || value === 'running'
    || value === 'ready'
    || value === 'error'
    ? value
    : undefined;
}

function notebookResearchPromotionAction(value: unknown): NotebookResearchDqlPromotionAction | undefined {
  return value === 'reuse_existing'
    || value === 'extend_existing'
    || value === 'create_replacement'
    || value === 'create_new'
    || value === 'review_required'
    ? value
    : undefined;
}

function notebookResearchReadiness(value: unknown): NotebookResearchReadinessFilter | undefined {
  return value === 'draft_ready' || value === 'certification_ready' || value === 'blocked' ? value : undefined;
}

function notebookResearchAge(value: unknown): 'stale_open' | 'expired_open' | undefined {
  return value === 'stale_open' || value === 'expired_open' ? value : undefined;
}

function notebookResearchNextAction(value: unknown): NotebookResearchNextActionFilter | undefined {
  return value === 'fix_blockers'
    || value === 'review_sql'
    || value === 'review_context'
    || value === 'run_preview'
    || value === 'reuse_existing'
    || value === 'create_dql_draft'
    || value === 'open_certification'
    || value === 'complete_review'
    || value === 'continue_review'
    ? value
    : undefined;
}

function notebookResearchSort(value: unknown): NotebookResearchSort | undefined {
  return value === 'priority' || value === 'updated_desc' ? value : undefined;
}

type NotebookResearchChecklistItemStatus = 'passed' | 'pending' | 'warning' | 'blocked';
type NotebookResearchReviewChecklist = {
  readyForDqlDraft: boolean;
  readyForCertificationReview: boolean;
  blockers: string[];
  warnings: string[];
  items: Array<{
    id: string;
    label: string;
    status: NotebookResearchChecklistItemStatus;
    detail: string;
  }>;
};

function withNotebookResearchChecklistPage(page: NotebookResearchRunListResult): Omit<NotebookResearchRunListResult, 'runs'> & { runs: Array<NotebookResearchRun & { reviewChecklist: NotebookResearchReviewChecklist }> } {
  return {
    ...page,
    runs: page.runs.map(withNotebookResearchChecklist),
  };
}

function withNotebookResearchChecklist(run: NotebookResearchRun): NotebookResearchRun & { reviewChecklist: NotebookResearchReviewChecklist } {
  const researchPlan = run.researchPlan ?? buildNotebookResearchPlan({
    run,
    evidence: run.evidence,
    resultPreview: run.resultPreview as ReturnType<typeof normalizeQueryResult> | undefined,
    previewError: run.status === 'error' ? run.error : undefined,
    generatedSql: run.generatedSql,
    reviewedSql: run.reviewedSql,
    routeDecision: run.routeDecision,
  });
  return {
    ...run,
    researchPlan,
    reviewChecklist: buildNotebookResearchReviewChecklist(run),
  };
}

function buildNotebookResearchReviewChecklist(run: NotebookResearchRun): NotebookResearchReviewChecklist {
  const questionReady = Boolean(notebookResearchString(run.question));
  const hasReviewedSql = Boolean(notebookResearchString(run.reviewedSql));
  const hasGeneratedSql = Boolean(notebookResearchString(run.generatedSql));
  const hasSql = hasReviewedSql || hasGeneratedSql;
  const preview = notebookResearchPreviewInfo(run.resultPreview);
  const previewReady = run.status === 'ready' && preview.hasPreview;
  const evidenceReady = notebookResearchEvidenceCount(run.evidence) > 0 || Boolean(run.contextPackId);
  const promoted = Boolean(run.dqlPromotion || run.dqlImportId || run.draftBlockPath);
  const duplicateChecked = Boolean(run.dqlPromotionAction || run.dqlPromotion);
  const promotionAction = run.dqlPromotionAction ?? run.dqlPromotion?.recommendedAction;
  const reuseRecommended = promotionAction === 'reuse_existing';
  const promotionReviewRequired = promotionAction === 'review_required';
  const hasDraft = Boolean(notebookResearchString(run.draftBlockPath));
  const sqlForParameterReview = notebookResearchString(run.reviewedSql) ?? notebookResearchString(run.generatedSql);
  const parameterReview = sqlForParameterReview ? parameterizeSqlForDqlImport(sqlForParameterReview) : null;
  const dynamicParameters = parameterReview?.parameterPolicy.filter((item) => item.policy === 'dynamic') ?? [];
  const staticParameters = parameterReview?.parameterPolicy.filter((item) => item.policy !== 'dynamic') ?? [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!questionReady) blockers.push('Add a business question before review.');
  if (!hasSql) blockers.push('Add reviewed SQL or generate SQL before promotion.');
  if (run.status === 'error') blockers.push(run.error ? `Fix preview error: ${run.error}` : 'Fix the failed preview before promotion.');
  if (!previewReady && run.status !== 'error') warnings.push('Run a bounded preview before certification review.');
  if (!evidenceReady) warnings.push('Inspect metadata evidence before turning this into a reusable block.');
  if (hasSql && dynamicParameters.length === 0) warnings.push('No dynamic parameters were detected; confirm this should be a static block before certification.');
  for (const warning of parameterReview?.warnings ?? []) warnings.push(warning);
  if (promoted && !duplicateChecked) warnings.push('Promotion exists but duplicate/reuse evidence is missing.');
  if (reuseRecommended) warnings.push('Reuse the matching block or explicitly document a replacement before certification.');
  if (promotionReviewRequired) warnings.push('Resolve the review-required promotion decision before certification.');

  const items: NotebookResearchReviewChecklist['items'] = [
    {
      id: 'question',
      label: 'Question',
      status: questionReady ? 'passed' : 'blocked',
      detail: questionReady ? 'Business question is captured.' : 'A reusable block needs a clear business question.',
    },
    {
      id: 'sql',
      label: 'Reviewed SQL',
      status: hasReviewedSql ? 'passed' : hasGeneratedSql ? 'warning' : 'blocked',
      detail: hasReviewedSql
        ? 'Reviewer SQL is saved.'
        : hasGeneratedSql
          ? 'Generated SQL exists; review it before promotion.'
          : 'No SQL is available for preview or DQL generation.',
    },
    {
      id: 'preview',
      label: 'Preview',
      status: previewReady ? 'passed' : run.status === 'error' ? 'blocked' : 'pending',
      detail: previewReady
        ? `Preview returned ${preview.rowCount.toLocaleString()} row${preview.rowCount === 1 ? '' : 's'}.`
        : run.status === 'error'
          ? (run.error ?? 'Preview failed.')
          : 'Run a bounded preview to validate the query shape.',
    },
    {
      id: 'evidence',
      label: 'Evidence',
      status: evidenceReady ? 'passed' : 'warning',
      detail: evidenceReady ? 'Metadata evidence or context pack is attached.' : 'No context evidence is attached yet.',
    },
    {
      id: 'duplicates',
      label: 'Reuse check',
      status: duplicateChecked ? (reuseRecommended || promotionReviewRequired ? 'warning' : 'passed') : promoted ? 'warning' : 'pending',
      detail: duplicateChecked
        ? `Promotion decision: ${promotionAction ?? 'review required'}.`
        : promoted
          ? 'Draft was created without stored duplicate evidence.'
          : 'Duplicate check runs when creating a DQL draft.',
    },
    {
      id: 'parameters',
      label: 'Parameter review',
      status: !hasSql ? 'pending' : dynamicParameters.length > 0 ? 'passed' : 'warning',
      detail: !hasSql
        ? 'Add SQL before checking runtime parameters.'
        : dynamicParameters.length > 0
          ? `Detected ${dynamicParameters.length.toLocaleString()} dynamic parameter${dynamicParameters.length === 1 ? '' : 's'}: ${dynamicParameters.slice(0, 6).map((item) => item.name).join(', ')}.`
          : staticParameters.length > 0
            ? `Only static or review-required literals were detected: ${staticParameters.slice(0, 6).map((item) => `${item.name} (${item.policy})`).join(', ')}.`
            : 'No reusable runtime parameters were detected. Certify as static only if the business question is intentionally fixed.',
    },
    {
      id: 'dql_draft',
      label: 'DQL draft',
      status: hasDraft ? 'passed' : hasReviewedSql && evidenceReady ? 'pending' : 'blocked',
      detail: hasDraft
        ? `Draft saved at ${run.draftBlockPath}.`
        : !hasReviewedSql
          ? 'Save reviewed SQL before DQL draft creation.'
          : evidenceReady
            ? 'Create a draft after SQL review.'
            : 'Save metadata evidence before creating a reusable DQL draft.',
    },
  ];

  const readyForDqlDraft = questionReady && hasReviewedSql && evidenceReady && run.status !== 'error';
  const readyForCertificationReview = readyForDqlDraft && previewReady && hasDraft && !reuseRecommended && !promotionReviewRequired;
  return { readyForDqlDraft, readyForCertificationReview, blockers, warnings, items };
}

function buildNotebookResearchPlan(input: {
  run: NotebookResearchRun;
  evidence?: unknown;
  resultPreview?: ReturnType<typeof normalizeQueryResult>;
  previewError?: string;
  generatedSql?: string;
  reviewedSql?: string;
  routeDecision?: unknown;
}): NotebookResearchPlan {
  const reviewedSql = notebookResearchString(input.reviewedSql);
  const generatedSql = notebookResearchString(input.generatedSql);
  const sql = reviewedSql ?? generatedSql;
  const parameterized = sql ? parameterizeSqlForDqlImport(sql) : null;
  const evidence = input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)
    ? input.evidence as Record<string, unknown>
    : {};
  const trustStatus = evidence.trustStatus && typeof evidence.trustStatus === 'object' && !Array.isArray(evidence.trustStatus)
    ? evidence.trustStatus as Record<string, unknown>
    : {};
  const allowedSqlContext = evidence.allowedSqlContext && typeof evidence.allowedSqlContext === 'object' && !Array.isArray(evidence.allowedSqlContext)
    ? evidence.allowedSqlContext as Record<string, unknown>
    : {};
  const previewRows = input.resultPreview?.rowCount ?? input.resultPreview?.rows.length;
  const hasEvidence = notebookResearchEvidenceCount(input.evidence) > 0 || Boolean(input.run.contextPackId);
  const hasPreview = previewRows !== undefined && (previewRows > 0 || Boolean(input.resultPreview?.columns.length));
  const promotionAction = input.run.dqlPromotionAction ?? input.run.dqlPromotion?.recommendedAction;
  const missingContext = Array.isArray(evidence.missingContext) ? evidence.missingContext : [];
  const relations = Array.isArray(allowedSqlContext.relations) ? allowedSqlContext.relations : [];
  return {
    sqlState: reviewedSql ? 'reviewed' : generatedSql ? 'generated' : 'missing',
    grain: sql ? extractDqlGenerationGroupByFields(sql)[0] : undefined,
    parameterPolicy: (parameterized?.parameterPolicy ?? []).slice(0, 16).map((entry) => ({
      name: entry.name,
      policy: entry.policy,
    })),
    allowedFilters: (parameterized?.allowedFilters ?? []).slice(0, 16),
    evidence: {
      trustLabel: notebookResearchString(trustStatus.label),
      contextPackId: notebookResearchString(evidence.contextPackId) ?? input.run.contextPackId,
      evidenceCount: notebookResearchEvidenceCount(input.evidence),
      relationCount: relations.length,
      missingContextCount: missingContext.length,
    },
    preview: {
      status: input.previewError ? 'error' : hasPreview ? 'ready' : 'not_run',
      ...(previewRows === undefined ? {} : { rowCount: previewRows }),
    },
    promotion: {
      path: notebookResearchPlanPromotionPath({
        hasSql: Boolean(sql),
        hasEvidence,
        hasPreview,
        previewError: input.previewError,
        draftBlockPath: input.run.draftBlockPath,
        promotionAction,
      }),
      duplicateDecision: promotionAction,
    },
    reviewFocus: notebookResearchPlanFocus(input.run.intent, {
      hasSql: Boolean(sql),
      hasEvidence,
      hasPreview,
      dynamicParameterCount: parameterized?.parameterPolicy.filter((entry) => entry.policy === 'dynamic').length ?? 0,
      missingContextCount: missingContext.length,
      promotionAction,
    }),
    generatedAt: new Date().toISOString(),
  };
}

function notebookResearchPlanPromotionPath(input: {
  hasSql: boolean;
  hasEvidence: boolean;
  hasPreview: boolean;
  previewError?: string;
  draftBlockPath?: string;
  promotionAction?: string;
}): NotebookResearchPlan['promotion']['path'] {
  if (!input.hasSql) return 'needs_sql';
  if (!input.hasEvidence) return 'review_context';
  if (input.previewError || !input.hasPreview) return 'run_preview';
  if (input.promotionAction === 'reuse_existing') return 'reuse_existing';
  if (input.draftBlockPath) return 'open_certification';
  return 'create_dql_draft';
}

function notebookResearchPlanFocus(
  intent: NotebookResearchIntent,
  input: {
    hasSql: boolean;
    hasEvidence: boolean;
    hasPreview: boolean;
    dynamicParameterCount: number;
    missingContextCount: number;
    promotionAction?: string;
  },
): string[] {
  const focus = new Set<string>();
  if (!input.hasSql) focus.add('Add reviewed SQL or configure AI SQL generation.');
  if (!input.hasEvidence) focus.add('Save metadata context evidence before DQL promotion.');
  if (!input.hasPreview) focus.add('Run a bounded preview and inspect result shape.');
  if (input.dynamicParameterCount === 0) focus.add('Confirm whether this should be static or parameterized.');
  if (input.missingContextCount > 0) focus.add('Resolve missing metadata context before certification.');
  if (input.promotionAction === 'reuse_existing') focus.add('Reuse the existing certified block or document replacement rationale.');
  const pattern = notebookResearchIntentPattern(intent);
  const reviewFocus = Array.isArray(pattern.reviewFocus) ? pattern.reviewFocus : [];
  for (const item of reviewFocus.slice(0, 4)) focus.add(String(item));
  return Array.from(focus).slice(0, 8);
}

function notebookResearchPreviewInfo(value: unknown): { hasPreview: boolean; rowCount: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { hasPreview: false, rowCount: 0 };
  const record = value as Record<string, unknown>;
  const rowCount = typeof record.rowCount === 'number' && Number.isFinite(record.rowCount)
    ? record.rowCount
    : Array.isArray(record.rows)
      ? record.rows.length
      : 0;
  const hasColumns = Array.isArray(record.columns) && record.columns.length > 0;
  return { hasPreview: hasColumns || rowCount > 0, rowCount };
}

function notebookResearchEvidenceCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const record = value as Record<string, unknown>;
  const selected = Array.isArray(record.selectedEvidence) ? record.selectedEvidence.length : 0;
  const citations = Array.isArray(record.citations) ? record.citations.length : 0;
  const roles = Array.isArray(record.evidenceRoles) ? record.evidenceRoles.length : 0;
  return selected + citations + roles;
}

function notebookResearchInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

type NotebookExecutionContextInput = {
  notebookPath?: string;
  cellId?: string;
  cellName?: string;
  researchRunId?: string;
  source?: string;
};

function notebookExecutionContext(value: unknown): NotebookExecutionContextInput | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const notebookPath = notebookResearchString(raw.notebookPath);
  if (!notebookPath) return null;
  return {
    notebookPath,
    cellId: notebookResearchString(raw.cellId),
    cellName: notebookResearchString(raw.cellName),
    researchRunId: notebookResearchString(raw.researchRunId),
    source: notebookResearchString(raw.source),
  };
}

function notebookResearchSelectedContext(run: NotebookResearchRun, context: unknown): Record<string, unknown> {
  return {
    activeSurface: 'notebook',
    notebookPath: run.notebookPath,
    domain: run.domain,
    sourceCellId: run.sourceCellId,
    sourceCellName: run.sourceCellName,
    context,
  };
}

function notebookResearchIntentPattern(intent: NotebookResearchIntent): Record<string, unknown> {
  switch (intent) {
    case 'diagnose_change':
      return {
        label: 'Change diagnosis',
        dqlTarget: 'driver or trend block',
        sqlFocus: ['baseline period', 'comparison period', 'metric delta', 'driver dimensions'],
        reviewFocus: ['time grain', 'comparison filters', 'metric definition', 'explainability evidence'],
      };
    case 'driver_breakdown':
      return {
        label: 'Driver breakdown',
        dqlTarget: 'ranking or contribution block',
        sqlFocus: ['contribution metric', 'ranking', 'tie breaker', 'segment dimensions'],
        reviewFocus: ['metric grain', 'ranking direction', 'parameterized filters', 'duplicate block match'],
      };
    case 'segment_compare':
      return {
        label: 'Segment compare',
        dqlTarget: 'comparison block',
        sqlFocus: ['shared metric', 'segment fields', 'normalized comparisons', 'deltas'],
        reviewFocus: ['segment definitions', 'filter compatibility', 'comparison grain', 'semantic metric alignment'],
      };
    case 'entity_drilldown':
      return {
        label: 'Entity drilldown',
        dqlTarget: 'entity profile or drilldown block',
        sqlFocus: ['entity grain', 'stable identifier', 'detail fields', 'supporting metrics'],
        reviewFocus: ['entity contract', 'primary key', 'allowed filters', 'downstream drill path'],
      };
    case 'anomaly_investigation':
      return {
        label: 'Anomaly investigation',
        dqlTarget: 'monitoring or exception block',
        sqlFocus: ['observed value', 'expected range', 'anomaly rule', 'supporting dimensions'],
        reviewFocus: ['threshold definition', 'time window', 'false-positive risk', 'evidence fields'],
      };
    case 'trust_gap_review':
      return {
        label: 'Trust review',
        dqlTarget: 'replacement or validation block',
        sqlFocus: ['definition comparison', 'lineage trace', 'duplicate candidates', 'conflict evidence'],
        reviewFocus: ['certified block match', 'semantic metric match', 'replacement reason', 'governance blockers'],
      };
    default:
      return {
        label: 'Ad hoc analysis',
        dqlTarget: 'custom block',
        sqlFocus: ['business question', 'grain', 'metrics', 'dimensions', 'filters'],
        reviewFocus: ['reusability', 'parameterization', 'lineage evidence', 'DQL promotion path'],
      };
  }
}

function notebookResearchAgentPrompt(question: string, intent: NotebookResearchIntent): string {
  const pattern = notebookResearchIntentPattern(intent);
  const sqlFocus = Array.isArray(pattern.sqlFocus) ? pattern.sqlFocus.join(', ') : 'business logic';
  const reviewFocus = Array.isArray(pattern.reviewFocus) ? pattern.reviewFocus.join(', ') : 'review evidence';
  return [
    `Research question: ${question}`,
    `Research pattern: ${pattern.label ?? intent}`,
    `DQL target: ${pattern.dqlTarget ?? 'custom block'}`,
    `SQL focus: ${sqlFocus}`,
    `Review focus: ${reviewFocus}`,
    'Generate read-only SQL that can become a reusable, parameterized DQL block after human review.',
  ].join('\n');
}

function notebookResearchRouteDecisionForRun(
  run: NotebookResearchRun,
  routeDecision: LocalContextPack['routeDecision'] | undefined,
  sqlForPreview?: string,
): LocalContextPack['routeDecision'] | undefined {
  if (!routeDecision) return undefined;
  const hasSelectedNotebookSql = Boolean(run.sourceCellId && notebookResearchString(sqlForPreview));
  if (!hasSelectedNotebookSql || routeDecision.route !== 'certified') return routeDecision;

  const certifiedEvidence = routeDecision.selectedEvidence.find((item) => item.role === 'exact_certified_answer')
    ?? routeDecision.selectedEvidence.find((item) => item.role === 'certified_context');
  const certifiedName = certifiedEvidence?.name ?? routeDecision.certifiedApplicability?.objectKey ?? 'matching certified artifact';
  return {
    ...routeDecision,
    route: 'research',
    trustLabel: routeDecision.trustLabel === 'certified' ? 'mixed' : routeDecision.trustLabel,
    reviewStatus: 'needs_review',
    exactObjectKey: undefined,
    reason: `Selected notebook SQL from "${run.sourceCellName ?? run.sourceCellId}" is the source for this research run. Certified artifact "${certifiedName}" is duplicate/reuse evidence until the reviewed SQL, grain, parameters, and preview are accepted.`,
    selectedEvidence: routeDecision.selectedEvidence.map((item) => item.role === 'exact_certified_answer'
      ? {
          ...item,
          role: 'certified_context',
          reason: 'Certified block is reuse or duplicate evidence for the selected notebook SQL; it is not an automatic answer for this research run.',
        }
      : item),
    missingContext: routeDecision.missingContext.length > 0
      ? routeDecision.missingContext
      : [{
          kind: 'metadata',
          severity: 'warning',
          message: 'Selected notebook SQL requires human review before DQL promotion, even when certified context exists.',
        }],
  };
}

function notebookResearchContextPreview(contextPack: LocalContextPack): Record<string, unknown> {
  return {
    contextPackId: contextPack.id,
    trustLabel: contextPack.trustLabel,
    routeDecision: contextPack.routeDecision
      ? {
          route: contextPack.routeDecision.route,
          intent: contextPack.routeDecision.intent,
          reason: contextPack.routeDecision.reason,
        }
      : undefined,
    evidence: contextPack.evidenceRoles.slice(0, 16).map((item) => ({
      objectKey: item.objectKey,
      objectType: item.objectType,
      name: item.name,
      role: item.role,
      reason: item.reason,
    })),
    summaries: contextPack.evidenceSummaries.slice(0, 12).map((item) => ({
      title: item.title,
      detail: item.detail,
      objectType: item.objectType,
      reason: item.reason,
    })),
    relations: contextPack.allowedSqlContext.relations.slice(0, 12).map((relation) => ({
      relation: relation.relation,
      name: relation.name,
      source: relation.source,
      columns: relation.columns.slice(0, 24).map((column) => {
        if (typeof column === 'string') return column;
        if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
          return String((column as { name: unknown }).name);
        }
        return String(column);
      }),
    })),
    missingContext: contextPack.missingContext.slice(0, 12).map((item) => ({
      kind: item.kind,
      message: item.message,
      severity: item.severity,
    })),
    warnings: contextPack.warnings.slice(0, 12),
    topRejected: contextPack.retrievalDiagnostics.topRejected.slice(0, 8).map((item) => ({
      name: item.name,
      objectType: item.objectType,
      reason: item.reason,
      score: item.score,
    })),
    counts: {
      objects: contextPack.objects.length,
      evidence: contextPack.evidenceRoles.length,
      relations: contextPack.allowedSqlContext.relations.length,
      warnings: contextPack.warnings.length + contextPack.missingContext.length,
    },
  };
}

function normalizeNotebookAgentResult(result: AgentResultPayload): ReturnType<typeof normalizeQueryResult> {
  const columns = Array.isArray(result.columns)
    ? result.columns.map((column) => {
        if (typeof column === 'string') return column;
        if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
          return String((column as { name: unknown }).name);
        }
        return String(column);
      })
    : [];
  const rows = Array.isArray(result.rows)
    ? result.rows
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)))
        .map((row) => row)
    : [];
  return {
    columns,
    rows,
    rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length,
    executionTime: typeof result.executionTime === 'number' ? result.executionTime : 0,
  };
}

function notebookResearchSummary(
  question: string,
  result: ReturnType<typeof normalizeQueryResult> | undefined,
  error: string | undefined,
): string {
  if (error) return `Research could not preview results for "${question}". ${error}`;
  if (result) {
    const rowCount = result.rowCount ?? result.rows.length;
    return `Research preview for "${question}" returned ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'} across ${result.columns.length.toLocaleString()} column${result.columns.length === 1 ? '' : 's'}.`;
  }
  return `Research plan created for "${question}". Add or generate SQL, then run a bounded preview.`;
}

function recordNotebookQueryRun(projectRoot: string, input: {
  notebookPath: string;
  cellId?: string;
  cellName?: string;
  researchRunId?: string;
  source: string;
  status: string;
  rowCount?: number;
  durationMs?: number;
  errorCode?: string;
  sql?: string;
  contextPackId?: string;
  objectKey?: string;
}): void {
  try {
    recordQueryRun(projectRoot, {
      objectKey: input.objectKey,
      source: input.source,
      status: input.status,
      rowCount: input.rowCount,
      durationMs: input.durationMs,
      errorCode: input.errorCode,
      payload: {
        notebookPath: input.notebookPath,
        cellId: input.cellId,
        cellName: input.cellName,
        researchRunId: input.researchRunId,
        contextPackId: input.contextPackId,
        sql: input.sql ? compactSqlForRunHistory(input.sql) : undefined,
      },
    });
  } catch {
    // Query history is advisory metadata and must not block notebook execution.
  }
}

function updateNotebookResearchFromCellExecution(
  projectRoot: string,
  execContext: NotebookExecutionContextInput,
  input: {
    status: 'success' | 'error';
    resultPreview?: ReturnType<typeof normalizeQueryResult>;
    error?: string;
    sql?: string;
  },
): void {
  if (!execContext.notebookPath || (!execContext.cellId && !execContext.researchRunId)) return;
  const storage = new LocalNotebookResearchStorage(defaultNotebookResearchDbPath(projectRoot));
  try {
    const page = storage.listRunsPage({
      notebookPath: execContext.notebookPath,
      sort: 'updated_desc',
      limit: 500,
    });
    const matches = page.runs.filter((run) => {
      if (execContext.researchRunId && run.id === execContext.researchRunId) return true;
      return Boolean(execContext.cellId && run.sourceCellId === execContext.cellId);
    });
    const now = new Date().toISOString();
    for (const run of matches.slice(0, 20)) {
      if (input.status === 'success') {
        storage.updateRun(run.id, {
          status: 'ready',
          resultPreview: input.resultPreview,
          summary: notebookResearchSummary(run.question, input.resultPreview, undefined),
          recommendation: run.recommendation ?? 'Review SQL, metadata evidence, grain, filters, and duplicate matches before DQL draft promotion.',
          error: '',
          lastRunAt: now,
        });
      } else {
        storage.updateRun(run.id, {
          status: 'error',
          error: input.error,
          summary: notebookResearchSummary(run.question, undefined, input.error),
          lastRunAt: now,
        });
      }
    }
  } catch {
    // Research run sync is advisory metadata and must not block notebook execution.
  } finally {
    storage.close();
  }
}

function compactSqlForRunHistory(sql: string): string {
  const clean = sql.replace(/\s+/g, ' ').trim();
  return clean.length > 1200 ? `${clean.slice(0, 1197)}...` : clean;
}

function buildAgentSchemaContextFromContextPack(question: string, contextPack: LocalContextPack): AgentSchemaTable[] {
  const byRelation = new Map<string, AgentSchemaTable>();
  const objectsByKey = new Map(contextPack.objects.map((object) => [object.objectKey, object]));

  const upsert = (table: AgentSchemaTable) => {
    if (!table.relation || !table.name) return;
    const key = table.relation.toLowerCase();
    const existing = byRelation.get(key);
    if (!existing) {
      byRelation.set(key, {
        ...table,
        columns: dedupeAgentSchemaColumns(table.columns).slice(0, 80),
      });
      return;
    }
    byRelation.set(key, {
      ...existing,
      description: existing.description ?? table.description,
      source: existing.source === table.source ? existing.source : 'local metadata catalog',
      columns: dedupeAgentSchemaColumns([...existing.columns, ...table.columns]).slice(0, 80),
    });
  };

  for (const object of contextPack.objects) {
    const table = metadataObjectToAgentSchemaTable(object);
    if (table) upsert(table);
  }

  for (const edge of contextPack.edges) {
    if (edge.edgeType !== 'maps_to_dbt_model' && edge.edgeType !== 'uses_dbt_model') continue;
    const from = objectsByKey.get(edge.fromKey);
    const to = objectsByKey.get(edge.toKey);
    const warehouse = from?.objectType === 'warehouse_table' ? from : null;
    const dbtModel = to && (to.objectType === 'dbt_model' || to.objectType === 'dbt_source') ? to : null;
    if (!warehouse || !dbtModel) continue;
    const warehouseTable = metadataObjectToAgentSchemaTable(warehouse);
    const modelTable = metadataObjectToAgentSchemaTable(dbtModel);
    if (!warehouseTable || !modelTable) continue;
    upsert({
      ...warehouseTable,
      description: warehouseTable.description ?? modelTable.description,
      columns: modelTable.columns,
      source: 'local metadata catalog',
    });
  }

  const tokens = agentSchemaTokens(question);
  const shouldProbeValues = extractAgentValueSearchTerms(question).length > 0;
  return Array.from(byRelation.values())
    .map((table) => ({
      table,
      score: scoreAgentSchemaTable(table, tokens) + (shouldProbeValues ? scoreAgentValueProbeTable(table) : 0),
    }))
    .filter((entry) => entry.table.columns.length > 0 && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.table.relation.localeCompare(b.table.relation))
    .slice(0, 12)
    .map((entry) => entry.table);
}

function metadataObjectToAgentSchemaTable(object: MetadataObject): AgentSchemaTable | null {
  if (object.objectType === 'dbt_column' || object.objectType === 'runtime_column') {
    const relation = metadataPayloadString(object, 'relation');
    const model = metadataPayloadString(object, 'model') ?? relation;
    if (!model) return null;
    return {
      relation: relation ?? model,
      schema: relation ? relation.split('.').slice(-2, -1)[0] : undefined,
      name: relation ? relation.split('.').at(-1) ?? model : model,
      source: 'local metadata catalog',
      columns: [{
        name: object.name,
        type: metadataPayloadString(object, 'type'),
        description: object.description,
      }],
    };
  }

  if (object.objectType !== 'dbt_model' && object.objectType !== 'dbt_source' && object.objectType !== 'warehouse_table' && object.objectType !== 'runtime_table') {
    return null;
  }

  const relation = metadataObjectRelation(object);
  if (!relation) return null;
  const relationParts = relation.split('.').filter(Boolean);
  const schema = metadataPayloadString(object, 'schema') ?? (relationParts.length >= 2 ? relationParts[relationParts.length - 2] : undefined);
  const name = relationParts.at(-1) ?? object.name;
  const columns = metadataObjectColumns(object);
  return {
    relation,
    schema,
    name,
    description: object.description,
    columns,
    source: 'local metadata catalog',
  };
}

function metadataObjectRelation(object: MetadataObject): string | undefined {
  const relation = metadataPayloadString(object, 'relation');
  if (relation) return relation;
  const database = metadataPayloadString(object, 'database');
  const schema = metadataPayloadString(object, 'schema');
  if (database && schema) return [database, schema, object.name].join('.');
  return object.fullName ?? object.name;
}

function metadataObjectColumns(object: MetadataObject): AgentSchemaTable['columns'] {
  const columns = object.payload?.columns;
  if (!Array.isArray(columns)) return [];
  return columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const record = column as Record<string, unknown>;
    const name = stringFromRecord(record, 'name') ?? stringFromRecord(record, 'column_name');
    if (!name) return [];
    return [{
      name,
      type: stringFromRecord(record, 'type') ?? stringFromRecord(record, 'data_type'),
      description: stringFromRecord(record, 'description'),
    }];
  });
}

function metadataPayloadString(object: MetadataObject, key: string): string | undefined {
  const value = object.payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dedupeAgentSchemaColumns(columns: AgentSchemaTable['columns']): AgentSchemaTable['columns'] {
  const byName = new Map<string, AgentSchemaTable['columns'][number]>();
  for (const column of columns) {
    const key = column.name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, existing ? {
      ...existing,
      type: existing.type ?? column.type,
      description: existing.description ?? column.description,
      sampleValues: uniqueStrings([...(existing.sampleValues ?? []), ...(column.sampleValues ?? [])]).slice(0, 5),
    } : column);
  }
  return Array.from(byName.values());
}

export function buildAgentSchemaContext(question: string, rows: unknown[]): AgentSchemaTable[] {
  const byRelation = new Map<string, AgentSchemaTable>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const schema = stringFromRecord(record, 'table_schema');
    const table = stringFromRecord(record, 'table_name');
    const column = stringFromRecord(record, 'column_name');
    if (!schema || !table || !column) continue;
    const relation = `${schema}.${table}`;
    const current = byRelation.get(relation) ?? {
      relation,
      schema,
      name: table,
      source: 'runtime information_schema',
      columns: [],
    };
    if (current.columns.length < 80) {
      current.columns.push({
        name: column,
        type: stringFromRecord(record, 'data_type'),
      });
    }
    byRelation.set(relation, current);
  }
  const tokens = agentSchemaTokens(question);
  const shouldProbeValues = extractAgentValueSearchTerms(question).length > 0;
  return Array.from(byRelation.values())
    .map((table) => ({
      table,
      score: scoreAgentSchemaTable(table, tokens) + (shouldProbeValues ? scoreAgentValueProbeTable(table) : 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.table.relation.localeCompare(b.table.relation))
    .slice(0, 12)
    .map((entry) => entry.table);
}

async function enrichAgentSchemaContextWithValueMatches(
  question: string,
  schemaContext: AgentSchemaTable[],
  executor: QueryExecutor,
  connection: ConnectionConfig,
): Promise<AgentSchemaTable[]> {
  const searchTerms = extractAgentValueSearchTerms(question);
  if (schemaContext.length === 0 || searchTerms.length === 0) return schemaContext;

  const matches = new Map<string, Map<string, string[]>>();
  for (const candidate of rankAgentValueProbeColumns(schemaContext).slice(0, 12)) {
    try {
      const result = await executor.executeQuery(
        buildAgentValueProbeSql(candidate.table, candidate.column.name, searchTerms, connection),
        [],
        runtimeVariables({}),
        connection,
      );
      const values = uniqueStrings(result.rows.flatMap(valueProbeRowValues)).slice(0, 5);
      if (values.length === 0) continue;
      const tableMatches = matches.get(candidate.table.relation) ?? new Map<string, string[]>();
      tableMatches.set(candidate.column.name, values);
      matches.set(candidate.table.relation, tableMatches);
    } catch {
      // Value probes are advisory. Unsupported casts, privileges, and large-table
      // failures should not block the metadata-backed answer path.
    }
  }
  if (matches.size === 0) return schemaContext;

  return schemaContext.map((table) => {
    const tableMatches = matches.get(table.relation);
    if (!tableMatches) return table;
    return {
      ...table,
      columns: table.columns.map((column) => {
        const sampleValues = tableMatches.get(column.name);
        return sampleValues?.length
          ? { ...column, sampleValues: uniqueStrings([...(column.sampleValues ?? []), ...sampleValues]).slice(0, 5) }
          : column;
      }),
    };
  });
}

function scoreAgentSchemaTable(table: AgentSchemaTable, tokens: Set<string>): number {
  let score = 0;
  const relationTokens = agentSchemaTokens(`${table.schema ?? ''} ${table.name} ${table.relation}`);
  for (const token of tokens) {
    if (relationTokens.has(token)) score += 8;
  }
  for (const column of table.columns) {
    const columnTokens = agentSchemaTokens(column.name);
    for (const token of tokens) {
      if (columnTokens.has(token)) score += 3;
    }
  }
  if (/(customer|order|revenue|product|location|date|month)/i.test(table.name)) score += 1;
  return score;
}

function scoreAgentValueProbeTable(table: AgentSchemaTable): number {
  let score = 0;
  if (hasAgentSchemaToken(table.name, ['account', 'customer', 'member', 'order', 'product', 'sku', 'subscriber', 'user'])) score += 5;
  for (const column of table.columns) {
    if (!isAgentValueProbeColumn(column)) continue;
    score += 2;
    if (hasAgentSchemaToken(column.name, ['account', 'customer', 'email', 'full', 'member', 'name', 'product', 'sku', 'user'])) score += 2;
  }
  return Math.min(score, 18);
}

function rankAgentValueProbeColumns(schemaContext: AgentSchemaTable[]): Array<{
  table: AgentSchemaTable;
  column: AgentSchemaTable['columns'][number];
  score: number;
}> {
  const ranked: Array<{
    table: AgentSchemaTable;
    column: AgentSchemaTable['columns'][number];
    score: number;
  }> = [];
  for (const table of schemaContext) {
    for (const column of table.columns) {
      if (!isAgentValueProbeColumn(column)) continue;
      ranked.push({
        table,
        column,
        score: scoreAgentValueProbeColumn(table, column),
      });
    }
  }
  return ranked.sort((a, b) => b.score - a.score || a.table.relation.localeCompare(b.table.relation) || a.column.name.localeCompare(b.column.name));
}

function scoreAgentValueProbeColumn(table: AgentSchemaTable, column: AgentSchemaTable['columns'][number]): number {
  let score = 0;
  if (hasAgentSchemaToken(table.name, ['account', 'customer', 'member', 'product', 'sku', 'subscriber', 'user'])) score += 4;
  if (hasAgentSchemaToken(column.name, ['full', 'name', 'email', 'account', 'customer', 'member', 'product', 'sku', 'subscriber', 'user'])) score += 8;
  if (hasAgentSchemaToken(column.name, ['id', 'key', 'code', 'number', 'status', 'segment', 'region', 'category', 'type'])) score += 3;
  return score;
}

function isAgentValueProbeColumn(column: AgentSchemaTable['columns'][number]): boolean {
  const name = column.name.toLowerCase();
  if (/\b(password|secret|token|credential|hash|salt)\b/.test(name)) return false;
  if (!hasAgentSchemaToken(name, [
    'account',
    'category',
    'channel',
    'city',
    'code',
    'country',
    'customer',
    'email',
    'full',
    'id',
    'key',
    'member',
    'name',
    'number',
    'product',
    'region',
    'segment',
    'sku',
    'state',
    'status',
    'subscriber',
    'type',
    'user',
  ])) {
    return false;
  }
  const type = column.type?.toLowerCase() ?? '';
  if (!type) return true;
  return /\b(char|character|clob|email|string|text|uuid|varchar)\b/.test(type);
}

export function buildAgentValueProbeSql(
  table: AgentSchemaTable,
  column: string,
  searchTerms: string[],
  connection: ConnectionConfig,
): string {
  const relation = quoteAgentRelation(table.relation, connection);
  const identifier = quoteAgentIdentifier(column, connection);
  const castValue = `LOWER(CAST(${identifier} AS ${agentTextCastType(connection.driver)}))`;
  const predicates = searchTerms
    .slice(0, 5)
    .map((term) => `${castValue} LIKE ${sqlStringLiteral(`%${escapeSqlLike(term.toLowerCase())}%`)} ESCAPE '\\'`)
    .join(' OR ');
  return [
    `SELECT DISTINCT CAST(${identifier} AS ${agentTextCastType(connection.driver)}) AS value`,
    `FROM ${relation}`,
    `WHERE ${identifier} IS NOT NULL AND (${predicates})`,
    'LIMIT 5',
  ].join('\n');
}

function agentTextCastType(driver?: string): string {
  switch (driver) {
    case 'bigquery':
      return 'STRING';
    case 'clickhouse':
      return 'String';
    case 'fabric':
    case 'mssql':
      return 'NVARCHAR(MAX)';
    case 'mysql':
      return 'CHAR';
    case 'sqlite':
      return 'TEXT';
    default:
      return 'VARCHAR';
  }
}

function quoteAgentRelation(relation: string, connection: ConnectionConfig): string {
  return relation.split('.').map((part) => quoteAgentIdentifier(part, connection)).join('.');
}

function quoteAgentIdentifier(identifier: string, connection: ConnectionConfig): string {
  return getDialect(connection.driver).quoteIdentifier(identifier);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function valueProbeRowValues(row: unknown): string[] {
  if (!row || typeof row !== 'object') return [];
  const record = row as Record<string, unknown>;
  return Object.values(record)
    .filter((value): value is string | number | boolean => (
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ))
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
  }
  return output;
}

function agentSchemaTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    for (const part of raw.split('_')) {
      const normalized = normalizeAgentSchemaToken(part);
      if (!normalized || normalized.length < 3 || AGENT_SCHEMA_STOPWORDS.has(normalized)) continue;
      tokens.add(normalized);
    }
  }
  return tokens;
}

function hasAgentSchemaToken(value: string, expected: string[]): boolean {
  const tokens = agentSchemaTokens(value);
  return expected.some((token) => tokens.has(token));
}

export function extractAgentValueSearchTerms(question: string): string[] {
  const terms: string[] = [];
  for (const match of question.matchAll(/["']([^"']{3,120})["']/g)) {
    terms.push(match[1]);
  }
  for (const match of question.matchAll(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g)) {
    terms.push(match[0]);
  }
  for (const match of question.matchAll(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,3}\b/g)) {
    terms.push(match[0]);
  }
  for (const match of question.matchAll(/\b(?:for|named|called|only|where|customer|user|account|product)\s+([A-Za-z0-9@._-]+(?:\s+[A-Za-z0-9@._-]+){0,3})/gi)) {
    terms.push(match[1]);
  }
  return uniqueStrings(
    terms
      .map(cleanAgentValueSearchTerm)
      .filter((term) => term.length >= 3 && !AGENT_VALUE_SEARCH_STOP_PHRASES.has(term.toLowerCase())),
  ).slice(0, 6);
}

function cleanAgentValueSearchTerm(term: string): string {
  return term
    .replace(/[?.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:account|customer|member|named|called|product|sku|subscriber|user)\s+/i, '')
    .replace(/\s+\b(?:last|next|this)\b.*$/i, '')
    .replace(/\s+\b(?:last|this)\s+(?:day|week|month|quarter|year)\b.*$/i, '')
    .replace(/\s+\b(?:daily|weekly|monthly|quarterly|yearly)\b.*$/i, '')
    .trim();
}

const AGENT_SCHEMA_STOPWORDS = new Set([
  'all', 'and', 'are', 'can', 'data', 'for', 'from', 'have', 'how', 'many', 'me',
  'show', 'the', 'this', 'who', 'with', 'value',
]);

const AGENT_VALUE_SEARCH_STOP_PHRASES = new Set([
  'account',
  'customer',
  'last week',
  'this week',
  'last month',
  'this month',
  'last quarter',
  'this quarter',
  'last year',
  'this year',
  'member',
  'product',
  'sku',
  'subscriber',
  'user',
]);

function normalizeAgentSchemaToken(token: string): string {
  if (token === 'orders') return 'order';
  if (token === 'customers') return 'customer';
  if (token === 'products') return 'product';
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isMemoryScope(value: unknown): value is 'thread' | 'notebook' | 'project' | 'user' | 'artifact' {
  return value === 'thread'
    || value === 'notebook'
    || value === 'project'
    || value === 'user'
    || value === 'artifact';
}
