import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { QueryExecutor, type ConnectionConfig, type DatabaseConnector } from '@duckcodeailabs/dql-connectors';
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
  queryCompleteLineagePaths,
  LineageGraph,
  type SemanticLayer,
  type SemanticLayerProviderConfig,
  type SemanticLayerResult,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
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
import type { ProviderId } from './llm/types.js';
import {
  ClaudeProvider,
  GeminiProvider,
  MemoryStore,
  OllamaProvider,
  OpenAIProvider,
  buildLocalContextPack,
  defaultMemoryPath,
  ensureDefaultMemoryFiles,
  ensureMetadataCatalogFresh,
  recordRuntimeSchemaSnapshot,
  type AgentAnswer,
  type AgentResultPayload,
  type AgentProvider,
  type AgentSchemaTable,
  type LocalContextPack,
  type MetadataObject,
  type KGNode,
} from '@duckcodeailabs/dql-agent';
import { handleAppsApi } from './apps-api.js';
import {
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
import { LocalAppStorage, defaultLocalAppsDbPath } from '@duckcodeailabs/dql-project';
import type { BlockRecord, TestAssertionResult, TestResultSummary } from '@duckcodeailabs/dql-project';
import { Certifier } from '@duckcodeailabs/dql-governance';
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
  updateBlockStudioImportCandidate,
  writeBlockStudioImportSession,
  writeBlockStudioImportCandidate,
  type BlockStudioImportCandidate,
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

export interface LocalServerOptions {
  rootDir: string;
  projectRoot?: string;
  executor: QueryExecutor;
  connection: ConnectionConfig;
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
  let connection = normalizeProjectConnection(rawConnection, projectRoot);
  let projectConfig = loadProjectConfig(projectRoot);

  // Load semantic layer via provider system (dql native, dbt, cubejs, etc.)
  let semanticLayer: SemanticLayer | undefined;
  let semanticLayerErrors: string[] = [];
  let semanticDetectedProvider: string | undefined;
  const semanticLayerDir = join(projectRoot, 'semantic-layer');
  let semanticImportManifest = loadSemanticImportManifest(projectRoot);
  const userPrefsPath = join(projectRoot, '.dql-user-prefs.json');
  const semanticConfig = projectConfig.semanticLayer;
  let semanticLastSyncTime: string | null = null;
  {
    const executeQuery = semanticConfig?.provider === 'snowflake'
      ? async (sql: string) => { const r = await executor.executeQuery(sql, [], {}, connection); return { rows: r.rows }; }
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

  const executeLocalSqlForStoredResult = async (sql: string) => {
    const semantic = prepareSemanticSql(sql, semanticLayer);
    if (semantic.unresolvedRefs.length > 0) {
      throw new Error(`Unknown semantic reference${semantic.unresolvedRefs.length > 1 ? 's' : ''}: ${semantic.unresolvedRefs.join(', ')}`);
    }
    const prepared = prepareLocalExecution(semantic.sql, connection, projectRoot, projectConfig);
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
          const tableMapping = await resolveSemanticTableMapping(executor, connection, semanticLayer);
          const plan = buildExecutionPlan(resolved.cell, { semanticLayer, driver: connection.driver, tableMapping });
          if (!plan) {
            snapshotCells.push({ cellId, status: 'idle', executionCount: 0, executedAt });
            continue;
          }
          const prepared = prepareLocalExecution(plan.sql, connection, projectRoot, projectConfig);
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
    const tableMapping = await resolveSemanticTableMapping(executor, connection, semanticLayer);
    const semanticCompose = semanticLayer
      ? composeSemanticBlockSql(source, semanticLayer, {
          driver: connection.driver,
          tableMapping,
          projectRoot,
          projectConfig,
          detectedProvider: semanticDetectedProvider,
        })
      : null;
    const plan = buildExecutionPlan(
      { id: `agent-${block.name}`, type: 'dql', source, title: block.name },
      { semanticLayer, driver: connection.driver, tableMapping },
    );
    if (!plan && !semanticCompose?.sql) {
      const semanticError = semanticCompose?.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message;
      throw new Error(semanticError ?? `Block "${block.name}" produced no executable SQL.`);
    }

    const prepared = prepareLocalExecution(
      semanticCompose?.sql ?? plan!.sql,
      connection,
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
    const boundedSql = buildAgentPreviewSql(sql);
    const semantic = prepareSemanticSql(boundedSql, semanticLayer);
    if (semantic.unresolvedRefs.length > 0) {
      throw new Error(`Unknown semantic reference${semantic.unresolvedRefs.length > 1 ? 's' : ''}: ${semantic.unresolvedRefs.join(', ')}`);
    }
    const prepared = prepareLocalExecution(semantic.sql, connection, projectRoot, projectConfig);
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
      const enriched = await enrichAgentSchemaContextWithValueMatches(question, catalogContext, executor, connection);
      recordAgentRuntimeSchemaSnapshot(projectRoot, enriched, 'catalog enriched runtime schema');
      return enriched;
    }

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
            const executeQuery = semanticConfig?.provider === 'snowflake'
              ? async (sql: string) => { const r = await executor.executeQuery(sql, [], {}, connection); return { rows: r.rows }; }
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
    return { candidate: validated, errors };
  };

  const runBlockStudioPreviewSource = async (
    source: string,
    targetConnection: ConnectionConfig = connection,
  ): Promise<{
    sql: string;
    result: ReturnType<typeof normalizeQueryResult>;
    chartConfig: { chart?: string; x?: string; y?: string; color?: string; title?: string } | null;
  }> => {
    let tableMapping: Record<string, string> | undefined;
    if (semanticLayer) {
      try {
        const tablesResult = await executor.executeQuery(
          `SELECT table_schema, table_name
           FROM information_schema.tables
           WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`,
          [], {}, targetConnection,
        );
        tableMapping = buildSemanticTableMapping(semanticLayer, tablesResult.rows);
      } catch {
        tableMapping = undefined;
      }
    }
    const semanticCompose = semanticLayer
      ? composeSemanticBlockSql(source, semanticLayer, {
          driver: targetConnection.driver,
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
      { semanticLayer, driver: targetConnection.driver, tableMapping },
    );
    const prepared = prepareLocalExecution(
      semanticCompose?.sql ?? plan?.sql ?? executableSql,
      targetConnection,
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
    targetConnection: ConnectionConfig = connection,
  ): Promise<TestResultSummary> => {
    const start = Date.now();
    const tableMapping = await resolveSemanticTableMapping(executor, targetConnection, semanticLayer);
    const plan = buildExecutionPlan(
      { id: 'block-studio-tests', type: 'dql', source, title: 'Block Studio' },
      { semanticLayer, driver: targetConnection.driver, tableMapping },
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

    const prepared = prepareLocalExecution(plan.sql, targetConnection, projectRoot, projectConfig);
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

  const certifyBlockStudioSource = async (source: string, blockPath?: string | null) => {
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
      dependencies: [],
      usedInCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const certification = new Certifier().evaluate(record, testResults ?? undefined);
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
            const prepared = prepareLocalExecution(
              semanticCompose?.sql ?? plan!.sql,
              targetConnection,
              projectRoot,
              projectConfig,
            );
            const result = await executor.executeQuery(
              prepared.sql,
              plan?.sqlParams ?? [],
              runtimeVariables({ ...(plan?.variables ?? {}), ...variables }),
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
    if (path.startsWith('/api/apps') || path === '/api/persona') {
      try {
        const handled = await handleAppsApi({
          req,
          res,
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
      sseClients.add(res);
      req.on('close', () => { sseClients.delete(res); });
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
        const { tables, columnsByPath } = await introspectSchema(executor, connection);
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
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: message, fallback }));
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
        const blocksDir = join(projectRoot, 'blocks');
        const blocks: Array<{
          name: string; domain: string; status: string;
          owner: string | null; tags: string[]; path: string;
          lastModified: string; description: string;
          llmContext: string | null;
        }> = [];
        if (existsSync(blocksDir)) {
          const scanDir = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                scanDir(join(dir, entry.name));
              } else if (entry.name.endsWith('.dql')) {
                const filePath = join(dir, entry.name);
                const relPath = relative(projectRoot, filePath);
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
                    domain: domainMatch?.[1] ?? 'uncategorized',
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
          scanDir(blocksDir);
        }
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
        const result = await certifyBlockStudioSource(source, blockPath);
        const blockers = Array.from(new Set(result.checklist.blockers));
        if (!result.certification.certified || blockers.length > 0) {
          res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ ok: false, ...result, blockers }));
          return;
        }
        if (blockPath) setBlockStudioStatus(projectRoot, blockPath, 'certified');
        await refreshLocalMetadataCatalog(projectRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true, status: 'certified', ...result }));
      } catch (error) {
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
        const savedPath = saveBlockStudioArtifacts(projectRoot, {
          currentPath: typeof body.path === 'string' ? body.path : undefined,
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
        });
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
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ default: defaultKey, connections, dbtProfiles }));
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
          provider: projectConfig.semanticLayer?.provider ?? semanticDetectedProvider ?? null,
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
      const provider = projectConfig.semanticLayer?.provider ?? semanticDetectedProvider ?? 'dql';
      const dbtExecutionReady = provider === 'dbt'
        ? hasDbtSemanticManifest(projectRoot, projectConfig.semanticLayer?.projectPath)
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
              const result = await executor.executeQuery(sql, [], {}, connection);
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
              const result = await executor.executeQuery(sql, [], {}, connection);
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
              const result = await executor.executeQuery(sql, [], {}, connection);
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
              const result = await executor.executeQuery(sql, [], {}, connection);
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
        try {
          const connector = await executor.getConnector(connection);
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
            const result = await executor.executeQuery(sql, [], {}, connection);
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
      const { provider, messages, upstream } = body as {
        provider?: string;
        messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
        upstream?: { cellId?: string; sql?: string };
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

    if (req.method === 'POST' && path === '/api/query') {
      try {
        const body = await readJSON(req);
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
          isConnectionConfig(body.connection) ? body.connection : connection,
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
        const payload = serializeJSON(normalizeQueryResult(result, semantic.semanticRefs));
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
        const targetConnection = isConnectionConfig(body.connection) ? body.connection : connection;
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
        const targetConnection = isConnectionConfig(body.connection) ? body.connection : connection;
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
        const targetConnection = isConnectionConfig(body.connection) ? body.connection : connection;
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
      let target: ConnectionConfig = connection;
      try {
        const body = await readJSON(req);
        target = normalizeProjectConnection(
          isConnectionConfig(body.connection) ? body.connection : connection,
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
          message: formatConnectionTestError(target, error),
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

    if (req.method === 'GET' && path.startsWith('/api/lineage/node/')) {
      const rawNodeId = decodeURIComponent(path.slice('/api/lineage/node/'.length));
      try {
        const graph = buildProjectLineageGraph(projectRoot, semanticLayer);
        const node = resolveLineageNode(graph, rawNodeId);
        if (!node) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Lineage node "${rawNodeId}" not found` }));
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
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: `Node "${rawNodeId}" not found` }));
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
      try {
        const body = await readJSON(req);
        const cell = normalizeNotebookCell(body.cell);
        if (!cell) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing notebook cell payload.' }));
          return;
        }

        const resolved = resolveNotebookBlockReferenceCell(cell, projectRoot);
        const executableCell = resolved.cell;
        const cellConnection = isConnectionConfig(body.connection) ? body.connection : connection;
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
          isConnectionConfig(body.connection) ? body.connection : connection,
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          cellType: cell.type,
          title: plan.title,
          blockName: resolved.blockName,
          blockPath: resolved.blockPath,
          chartConfig: plan.chartConfig,
          tests: plan.tests,
          result: normalizeQueryResult(rawResult),
        }));
      } catch (error) {
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
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': 'no-store, max-age=0',
    });
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
  return value === 'claude-agent-sdk'
    || value === 'claude-code'
    || value === 'openai'
    || value === 'gemini'
    || value === 'ollama'
    || value === 'custom-openai';
}

function resolveDefaultLLMProvider(projectRoot: string): ProviderId | null {
  const settings = listProviderSettings(projectRoot);
  const preferred: ProviderId[] = ['openai', 'gemini', 'ollama', 'custom-openai'];
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
  connection: ConnectionConfig,
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
    const { tables: dbTables, columnsByPath: dbColumnsByPath } = await introspectSchema(executor, connection);

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

function openBlockStudioDocument(
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
  if (!normalizedPath.startsWith('blocks/')) {
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
    domain: parsedMetadata.domain || companion?.domain || normalizedPath.split('/').slice(1, -1).join('/') || 'uncategorized',
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
  if (projectConfig.semanticLayer?.provider === 'dbt' || detectedProvider === 'dbt') return true;
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
    const dbtProjectPath = context.projectConfig.semanticLayer?.projectPath;
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
  const targetRelativePath = `blocks/${safeDomain}/${slug}.dql`;
  const targetPath = join(projectRoot, targetRelativePath);
  const previousPath = options.currentPath ? normalize(options.currentPath).replace(/^\/+/, '') : null;

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

function blockCompanionRelativePath(blockPath: string): string | null {
  const normalized = normalize(blockPath).replace(/^\/+/, '');
  if (!normalized.startsWith('blocks/')) return null;
  const withoutRoot = normalized.slice('blocks/'.length).replace(/\.dql$/, '.yaml');
  return join('semantic-layer', 'blocks', withoutRoot).replaceAll('\\', '/');
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

function parseBlockSourceMetadata(source: string): {
  name: string;
  domain: string;
  description: string;
  owner: string;
  tags: string[];
  status: string;
  blockType: string;
} {
  const name = source.match(/^\s*block\s+"([^"]+)"/i)?.[1] ?? '';
  const extractString = (key: string) => source.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const tags = source.match(/\btags\s*=\s*\[([^\]]*)\]/i);
  return {
    name,
    domain: extractString('domain'),
    description: extractString('description'),
    owner: extractString('owner'),
    tags: tags ? (tags[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)) : [],
    status: extractString('status') || 'draft',
    blockType: extractString('type') || 'custom',
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
  const cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
  const regex = /\b(?:from|join|update|into)\s+([`"[]?[A-Za-z0-9_./:-]+(?:\.[A-Za-z0-9_./:-]+)*[`"\]]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned))) {
    const raw = match[1].replace(/^[`"[]|[`"\]]$/g, '');
    if (raw && !raw.startsWith('(') && !/^(select|values|unnest|lateral)$/i.test(raw)) tables.add(raw);
  }
  return Array.from(tables);
}

function setBlockStudioStatus(projectRoot: string, blockPath: string, newStatus: string): void {
  const normalizedPath = normalize(blockPath).replace(/^\/+/, '');
  if (!normalizedPath.startsWith('blocks/')) throw new Error('Invalid block path');
  const absPath = join(projectRoot, normalizedPath);
  if (!existsSync(absPath)) throw new Error('Block file not found');
  let source = readFileSync(absPath, 'utf-8');
  if (/status\s*=\s*"[^"]*"/.test(source)) {
    source = source.replace(/status\s*=\s*"[^"]*"/, `status = "${newStatus}"`);
  } else {
    source = source.replace(/block\s+"[^"]*"\s*\{/, (match) => `${match}\n  status = "${newStatus}"`);
  }
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
  const selected = requestedProvider
    ? settings.find((provider) => provider.id === requestedProvider && provider.enabled && provider.hasApiKey)
    : settings.find((provider) => provider.enabled && provider.hasApiKey);
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
  const blocksDir = safeDomain ? join(projectRoot, 'blocks', safeDomain) : join(projectRoot, 'blocks');
  mkdirSync(blocksDir, { recursive: true });
  const blockPath = join(blocksDir, `${slug}.dql`);
  if (existsSync(blockPath)) {
    throw new Error('BLOCK_EXISTS');
  }

  const templateContent = options.template
    ? listBlockTemplates().find((template) => template.id === options.template)?.content
    : undefined;
  const relativePath = safeDomain ? `blocks/${safeDomain}/${slug}.dql` : `blocks/${slug}.dql`;
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
  const blocksDir = join(projectRoot, 'blocks', safeDomain);
  mkdirSync(blocksDir, { recursive: true });
  const blockPath = join(blocksDir, `${slug}.dql`);
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
    path: `blocks/${safeDomain}/${slug}.dql`,
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

  const port = numberValue(output, 'port');
  const sslRaw = read('ssl', 'sslmode');
  const ssl = sslRaw === undefined
    ? undefined
    : !['false', '0', 'disable', 'disabled', 'off'].includes(sslRaw.toLowerCase());

  switch (adapter) {
    case 'postgres':
    case 'postgresql':
      return {
        adapter,
        connection: compactConnection({
          driver: 'postgresql',
          host: read('host'),
          port,
          database: read('dbname', 'database'),
          schema: read('schema'),
          username: read('user', 'username'),
          password: read('password', 'pass'),
          ssl,
        }),
        envRefs: [...envRefs],
        warnings,
      };
    case 'redshift':
      return {
        adapter,
        connection: compactConnection({
          driver: 'redshift',
          host: read('host'),
          port: port ?? 5439,
          database: read('dbname', 'database'),
          schema: read('schema'),
          username: read('user', 'username'),
          password: read('password', 'pass'),
          ssl,
        }),
        envRefs: [...envRefs],
        warnings,
      };
    case 'snowflake': {
      const privateKeyPath = read('private_key_path', 'privateKeyPath');
      const privateKey = read('private_key', 'privateKey');
      const authenticator = read('authenticator');
      const normalizedAuthenticator = authenticator?.toLowerCase().replace(/[\s_-]/g, '');
      const authMethod = privateKeyPath || privateKey || normalizedAuthenticator === 'snowflakejwt'
        ? 'key_pair'
        : normalizedAuthenticator === 'externalbrowser'
          ? 'external_browser'
          : normalizedAuthenticator === 'oauth' || normalizedAuthenticator === 'programmaticaccesstoken'
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
        }),
        envRefs: [...envRefs],
        warnings,
      };
    }
    case 'bigquery': {
      const keyFilename = read('keyfile', 'keyFilename');
      return {
        adapter,
        connection: compactConnection({
          driver: 'bigquery',
          projectId: read('project', 'projectId'),
          schema: read('dataset', 'schema'),
          location: read('location'),
          keyFilename,
          authMethod: keyFilename ? 'service_account_key_file' : 'application_default',
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
    case 'databricks':
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
          authMethod: 'token',
        }),
        envRefs: [...envRefs],
        warnings,
      };
    default:
      return null;
  }
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

function numberValue(source: Record<string, unknown>, key: string): number | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
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
    case 'postgresql':
    case 'redshift':
      needs('host');
      needs('database');
      needs('username');
      break;
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
      } else if (connection.authMethod !== 'external_browser') {
        needs('password');
      }
      break;
    case 'bigquery':
      needs('projectId');
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
  const manifestMetricCount = manifest?.metrics && typeof manifest.metrics === 'object'
    ? Object.keys(manifest.metrics).length
    : 0;
  const semanticMetricCount = Array.isArray(semanticManifest?.metrics)
    ? semanticManifest.metrics.length
    : manifestMetricCount;
  const semanticModelCount = Array.isArray(semanticManifest?.semantic_models)
    ? semanticManifest.semantic_models.length
    : 0;
  const savedQueryCount = Array.isArray(semanticManifest?.saved_queries)
    ? semanticManifest.saved_queries.length
    : 0;
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

async function testProviderConfig(projectRoot: string, id: ProviderSettingsId): Promise<{ ok: boolean; message: string }> {
  const config = getEffectiveProviderConfig(projectRoot, id);
  let provider: { available(): Promise<boolean> };
  switch (id) {
    case 'anthropic':
      provider = new ClaudeProvider({ apiKey: config.apiKey, model: config.model });
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
    case 'openai':
    default:
      provider = new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
      break;
  }
  const ok = await provider.available();
  return {
    ok,
    message: ok
      ? `${id} is configured.`
      : `${id} is not configured or not reachable. Check API key, base URL, and local service state.`,
  };
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

function buildAgentValueProbeSql(
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
    .map((term) => `${castValue} LIKE ${sqlStringLiteral(`%${escapeSqlLike(term.toLowerCase())}%`)} ESCAPE '\\\\'`)
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
