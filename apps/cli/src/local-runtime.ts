import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import {
  buildExecutionPlan,
  createWelcomeNotebook,
  deserializeNotebook,
  getConnectorFormSchemas,
  type NotebookCell,
} from '@duckcodeailabs/dql-notebook';
import {
  loadSemanticLayerFromDir,
  resolveSemanticLayerAsync,
  getDialect,
  Parser,
  buildLineageGraph,
  analyzeImpact,
  buildTrustChain,
  detectDomainFlows,
  getDomainTrustOverview,
  type SemanticLayer,
  type SemanticLayerProviderConfig,
  type SemanticLayerResult,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
} from '@duckcodeailabs/dql-core';

export interface ProjectConfig {
  project?: string;
  defaultConnection?: ConnectionConfig;
  dataDir?: string;
  semanticLayer?: SemanticLayerProviderConfig;
  preview?: {
    port?: number;
    theme?: string;
    open?: boolean;
  };
}

export interface LocalServerOptions {
  rootDir: string;
  projectRoot?: string;
  executor: QueryExecutor;
  connection: ConnectionConfig;
  preferredPort: number;
}

export async function startLocalServer(opts: LocalServerOptions): Promise<number> {
  const { rootDir, executor, connection, preferredPort, projectRoot = process.cwd() } = opts;
  const projectConfig = loadProjectConfig(projectRoot);

  // Load semantic layer via provider system (dql native, dbt, cubejs, etc.)
  let semanticLayer: SemanticLayer | undefined;
  let semanticLayerErrors: string[] = [];
  let semanticDetectedProvider: string | undefined;
  const semanticLayerDir = join(projectRoot, 'semantic-layer');
  const semanticConfig = projectConfig.semanticLayer;
  {
    const executeQuery = semanticConfig?.provider === 'snowflake'
      ? async (sql: string) => { const r = await executor.executeQuery(sql, [], {}, connection); return { rows: r.rows }; }
      : undefined;
    const result = await resolveSemanticLayerAsync(semanticConfig, projectRoot, executeQuery);
    semanticLayer = result.layer;
    semanticLayerErrors = result.errors;
    semanticDetectedProvider = result.detectedProvider;
    // Legacy fallback if provider system returned nothing and no errors
    if (!semanticLayer && semanticLayerErrors.length === 0 && existsSync(semanticLayerDir)) {
      try { semanticLayer = loadSemanticLayerFromDir(semanticLayerDir); } catch { /* continue without */ }
    }
  }

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

  const server = createServer(async (req, res) => {
    const requestUrl = req.url || '/';
    const url = new URL(requestUrl, 'http://127.0.0.1');
    const path = url.pathname || '/';

    // CORS — needed for dql-notebook SPA dev mode
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
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
        writeFileSync(absPath, content, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/schema') {
      try {
        const dataFiles = scanDataFiles(projectRoot);
        // Also query database tables from the connected database
        let dbTables: { name: string; path: string; columns: never[]; source: string }[] = [];
        try {
          const connector = await executor.getConnector(connection);
          if (typeof connector.listTables === 'function') {
            const tables = await connector.listTables();
            dbTables = tables.map((t) => {
              const qualifiedName = t.schema ? `${t.schema}.${t.name}` : t.name;
              return { name: qualifiedName, path: qualifiedName, columns: [] as never[], source: 'database' };
            });
          } else {
            // Fallback: query information_schema directly
            const result = await executor.executeQuery(
              `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name`,
              [], {}, connection,
            );
            dbTables = result.rows.map((row) => {
              const schema = String(row['table_schema'] ?? '');
              const name = String(row['table_name'] ?? '');
              const qualifiedName = schema ? `${schema}.${name}` : name;
              return { name: qualifiedName, path: qualifiedName, columns: [] as never[], source: 'database' };
            });
          }
        } catch {
          // Non-fatal: schema discovery from DB may fail if not connected
        }
        // Merge: data files first, then db tables (dedup by name)
        const seen = new Set(dataFiles.map((f) => f.name));
        const merged = [
          ...dataFiles.map((f) => ({ ...f, source: 'file' })),
          ...dbTables.filter((t) => !seen.has(t.name)),
        ];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(merged));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(scanDataFiles(projectRoot)));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/blocks') {
      try {
        const body = await readJSON(req);
        const { name } = body as { name: string };
        if (!name || typeof name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Missing block name' }));
          return;
        }
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
        const blocksDir = join(projectRoot, 'blocks');
        mkdirSync(blocksDir, { recursive: true });
        const blockPath = join(blocksDir, `${slug}.dql`);
        if (existsSync(blockPath)) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block already exists' }));
          return;
        }
        const content = `-- ${name}\nSELECT 1;\n`;
        writeFileSync(blockPath, content, 'utf-8');
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ path: `blocks/${slug}.dql`, content }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/connections') {
      const cfg = loadProjectConfig(projectRoot);
      const raw = cfg as any;
      const connections: Record<string, unknown> = raw.connections ?? {};
      // If no explicit connections map, surface the defaultConnection as "default"
      if (Object.keys(connections).length === 0 && cfg.defaultConnection) {
        connections['default'] = cfg.defaultConnection;
      }
      const defaultKey = raw.defaultConnection
        ? 'default'
        : Object.keys(connections)[0] ?? 'default';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ default: defaultKey, connections }));
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
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
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
      if (!semanticLayer) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          available: false,
          provider: projectConfig.semanticLayer?.provider ?? semanticDetectedProvider ?? null,
          errors: semanticLayerErrors,
          metrics: [],
          dimensions: [],
          hierarchies: [],
        }));
        return;
      }
      const metrics = semanticLayer.listMetrics().map((m) => ({
        name: m.name,
        label: m.label,
        description: m.description,
        domain: m.domain,
        type: m.type,
        table: m.table,
        tags: m.tags ?? [],
        owner: m.owner ?? null,
      }));
      const dimensions = semanticLayer.listDimensions().map((d) => ({
        name: d.name,
        label: d.label,
        description: d.description,
        type: d.type,
        table: d.table,
        tags: d.tags ?? [],
      }));
      const hierarchies = semanticLayer.listHierarchies().map((h) => ({
        name: h.name,
        label: h.label,
        description: h.description,
        domain: h.domain,
        levels: h.levels.map((l) => ({ name: l.name, label: l.label })),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({
        available: true,
        provider: projectConfig.semanticLayer?.provider ?? semanticDetectedProvider ?? 'dql',
        errors: semanticLayerErrors,
        metrics,
        dimensions,
        hierarchies,
      }));
      return;
    }
    // ── Semantic completions for SQL cells ─────────────────────────────────────
    if (req.method === 'GET' && path === '/api/semantic-completions') {
      const completions: Array<{ type: string; name: string; label: string; description: string; sql: string }> = [];
      if (semanticLayer) {
        for (const m of semanticLayer.listMetrics()) {
          completions.push({ type: 'metric', name: m.name, label: m.label, description: m.description ?? '', sql: m.sql });
        }
        for (const d of semanticLayer.listDimensions()) {
          completions.push({ type: 'dimension', name: d.name, label: d.label, description: d.description ?? '', sql: d.sql });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON({ completions }));
      return;
    }
    // ── end dql-notebook API ──────────────────────────────────────────────────

    if (req.method === 'POST' && path === '/api/query') {
      try {
        const body = await readJSON(req);
        if (typeof body.sql !== 'string' || body.sql.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ columns: [], rows: [], error: 'Missing SQL in request body.' }));
          return;
        }
        const prepared = prepareLocalExecution(
          typeof body.sql === 'string' ? body.sql : '',
          isConnectionConfig(body.connection) ? body.connection : connection,
          projectRoot,
          projectConfig,
        );
        const result = await executor.executeQuery(
          prepared.sql,
          Array.isArray(body.sqlParams) ? body.sqlParams : [],
          body.variables && typeof body.variables === 'object' ? body.variables : {},
          prepared.connection,
        );
        const payload = serializeJSON(normalizeQueryResult(result));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(payload);
      } catch (error) {
        if (res.headersSent || res.writableEnded) {
          res.end();
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
        const { metrics = [], dimensions = [], filters = [], limit, timeDimension, orderBy } = body as {
          metrics: string[];
          dimensions: string[];
          filters?: Array<{ dimension: string; operator: string; values: string[] }>;
          timeDimension?: { name: string; granularity: string };
          orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
          limit?: number;
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
        const composed = semanticLayer.composeQuery({ metrics, dimensions, filters, limit, timeDimension, orderBy, driver, tableMapping });
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
          result: normalizeQueryResult(result),
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/test-connection') {
      try {
        const body = await readJSON(req);
        const target = normalizeProjectConnection(
          isConnectionConfig(body.connection) ? body.connection : connection,
          projectRoot,
        );
        const connector = await executor.getConnector(target);
        const ok = await connector.ping();
        const driver = target.driver ?? 'unknown';
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok,
          message: ok ? `Connected to ${driver} successfully` : `Connection to ${driver} failed`,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
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

        const cellConnection = isConnectionConfig(body.connection) ? body.connection : connection;
        const plan = buildExecutionPlan(cell, { semanticLayer, driver: cellConnection.driver });
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
        const rawResult = await executor.executeQuery(prepared.sql, plan.sqlParams, plan.variables, prepared.connection);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          cellType: cell.type,
          title: plan.title,
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
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(content);
  });

  return new Promise<number>((resolvePromise, reject) => {
    let retriedWithRandomPort = false;

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && !retriedWithRandomPort) {
        retriedWithRandomPort = true;
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(error);
    });

    server.listen(preferredPort, '127.0.0.1', () => {
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

/**
 * Normalize connector QueryResult → SPA-friendly shape.
 * Connector returns columns as ColumnMeta[] ({name,type,driverType}).
 * The notebook SPA expects columns as string[] (just names).
 */
function normalizeQueryResult(result: any): {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTime: number;
} {
  const rawCols: unknown[] = Array.isArray(result?.columns) ? result.columns : [];
  const columns = rawCols.map((c) =>
    typeof c === 'string' ? c : typeof (c as any)?.name === 'string' ? (c as any).name : String(c)
  );
  return {
    columns,
    rows: Array.isArray(result?.rows) ? result.rows : [],
    rowCount: typeof result?.rowCount === 'number' ? result.rowCount : (result?.rows?.length ?? 0),
    executionTime: typeof result?.executionTimeMs === 'number'
      ? result.executionTimeMs
      : typeof result?.executionTime === 'number'
        ? result.executionTime
        : 0,
  };
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

  // Normalize modern `connections.default` format to `defaultConnection`
  if (!config.defaultConnection && raw.connections) {
    const connections = raw.connections as Record<string, Record<string, unknown>>;
    const defaultConn = connections.default;
    if (defaultConn?.driver) {
      // Support both `filepath` (correct) and `path` (legacy/init compat)
      const filepath = (defaultConn.filepath ?? defaultConn.path) as string | undefined;
      config.defaultConnection = {
        driver: defaultConn.driver as ConnectionConfig['driver'],
        ...(filepath ? { filepath } : {}),
      };
    }
  }

  return config;
}

export function prepareLocalExecution(
  sql: string,
  connection: ConnectionConfig,
  projectRoot: string,
  projectConfig: ProjectConfig,
): { sql: string; connection: ConnectionConfig } {
  const normalizedConnection = normalizeProjectConnection(connection, projectRoot);
  return {
    sql: shouldResolveProjectPaths(normalizedConnection)
      ? resolveProjectRelativeSqlPaths(sql, projectRoot, projectConfig.dataDir)
      : sql,
    connection: normalizedConnection,
  };
}

export function normalizeProjectConnection(connection: ConnectionConfig, projectRoot: string): ConnectionConfig {
  const normalized: ConnectionConfig = { ...connection };

  if ((normalized.driver === 'file' || normalized.driver === 'duckdb') && normalized.filepath && normalized.filepath !== ':memory:' && !isAbsoluteLikePath(normalized.filepath)) {
    normalized.filepath = resolve(projectRoot, normalized.filepath);
  }

  if (normalized.driver === 'sqlite' && normalized.database && normalized.database !== ':memory:' && !isAbsoluteLikePath(normalized.database)) {
    normalized.database = resolve(projectRoot, normalized.database);
  }

  return normalized;
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

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  return Boolean(value && typeof value === 'object' && 'driver' in (value as Record<string, unknown>));
}

// ── dql-notebook helper functions ─────────────────────────────────────────────

type NotebookFileEntry = {
  name: string;
  path: string;
  type: 'notebook' | 'workbook' | 'block' | 'dashboard';
  folder: string;
};

function scanNotebookFiles(projectRoot: string): NotebookFileEntry[] {
  const result: NotebookFileEntry[] = [];
  const folderMap: Record<string, NotebookFileEntry['type']> = {
    notebooks: 'notebook',
    workbooks: 'workbook',
    blocks: 'block',
    dashboards: 'dashboard',
  };
  for (const [folder, type] of Object.entries(folderMap)) {
    const dir = join(projectRoot, folder);
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.dql') && !entry.name.endsWith('.dqlnb')) continue;
        result.push({
          name: entry.name.replace(/\.(dql|dqlnb)$/, ''),
          path: `${folder}/${entry.name}`,
          type,
          folder,
        });
      }
    } catch { /* skip unreadable dirs */ }
  }
  return result;
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
function buildProjectLineageGraph(projectRoot: string, semanticLayer: SemanticLayer | null | undefined) {
  const blocks: LineageBlockInput[] = [];
  const metrics: LineageMetricInput[] = [];
  const dimensions: LineageDimensionInput[] = [];

  // Scan .dql files
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

  // Load from semantic layer
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
