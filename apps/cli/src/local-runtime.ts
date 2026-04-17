import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
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
  canonicalize,
} from '@duckcodeailabs/dql-core';
import { listBlockTemplates } from './block-templates.js';
import {
  buildSemanticObjectDetail,
  buildSemanticTree,
  computeSyncDiff,
  loadSemanticImportManifest,
  performSemanticImport,
  previewSemanticImport,
  syncSemanticImport,
} from './semantic-import.js';

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
  const { rootDir, executor, connection: rawConnection, preferredPort, projectRoot = process.cwd() } = opts;
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
        const toWrite = absPath.endsWith('.dql') ? canonicalizeSafe(content) : content;
        writeFileSync(absPath, toWrite, 'utf-8');
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON(scanDataFiles(projectRoot)));
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
        } = body as {
          name: string;
          domain?: string;
          content?: string;
          description?: string;
          tags?: string[];
          metricRefs?: string[];
          template?: string;
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
          content,
          description,
          tags,
          metricRefs,
          template,
        } = body as {
          name: string;
          domain?: string;
          content: string;
          description?: string;
          tags?: string[];
          metricRefs?: string[];
          template?: string;
        };
        if (!name || typeof name !== 'string' || !content || typeof content !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'name and content are required' }));
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
                  blocks.push({
                    name: nameMatch?.[1] ?? entry.name.replace('.dql', ''),
                    domain: domainMatch?.[1] ?? 'uncategorized',
                    status: statusMatch?.[1] ?? 'draft',
                    owner: ownerMatch?.[1] ?? null,
                    tags: parsedTags,
                    path: relPath,
                    lastModified: stat.mtime.toISOString(),
                    description: descMatch?.[1] ?? '',
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
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
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
        const absPath = resolve(projectRoot, blockPath);
        if (!existsSync(absPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block file not found' }));
          return;
        }
        let source = readFileSync(absPath, 'utf-8');
        // Update or insert status field
        if (/status\s*=\s*"[^"]*"/.test(source)) {
          source = source.replace(/status\s*=\s*"[^"]*"/, `status = "${newStatus}"`);
        } else {
          // Insert after first { in block declaration
          source = source.replace(/block\s+"[^"]*"\s*\{/, (match) => `${match}\n  status = "${newStatus}"`);
        }
        writeFileSync(absPath, source, 'utf-8');
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
        // Parse the block to extract tests and query SQL
        const parser = new Parser(source, '<run-tests>');
        const ast = parser.parse();
        const blockNode = ast.statements.find((n: any) => n.kind === 'BlockDecl') as any;
        if (!blockNode) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'No block declaration found in source' }));
          return;
        }
        const testNodes: Array<{ field: string; operator: string; expected: any }> = blockNode.tests ?? [];
        if (testNodes.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ assertions: [], passed: 0, failed: 0, duration: 0 }));
          return;
        }
        // Get the block's base SQL
        const baseSql = blockNode.query?.rawSQL?.trim() ?? '';
        if (!baseSql) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'Block has no query SQL to test against' }));
          return;
        }
        const resolvedSql = resolveProjectRelativeSqlPaths(baseSql, projectRoot, projectConfig.dataDir);

        // Build and run assertions
        const start = Date.now();
        const results: Array<{ field: string; operator: string; expected: string; passed: boolean; actual?: string }> = [];
        for (const test of testNodes) {
          const field = test.field;
          const op = test.operator;
          const expected = test.expected;
          // Extract the expected value from the AST node
          const expectedValue = typeof expected === 'object' && expected !== null
            ? (expected.value ?? String(expected))
            : expected;
          // Build a SQL query that computes the aggregate for this assertion
          const testSql = `SELECT ${field} AS test_value FROM (${resolvedSql}) AS __test_block`;
          try {
            const result = await executor.executeQuery(testSql, [], {}, connection);
            const actualRaw = result.rows?.[0];
            const actual = actualRaw ? Object.values(actualRaw)[0] : undefined;
            const actualNum = Number(actual);
            const expectedNum = Number(expectedValue);
            let passed = false;
            switch (op) {
              case '>': passed = actualNum > expectedNum; break;
              case '<': passed = actualNum < expectedNum; break;
              case '>=': passed = actualNum >= expectedNum; break;
              case '<=': passed = actualNum <= expectedNum; break;
              case '==': passed = String(actual) === String(expectedValue); break;
              case '!=': passed = String(actual) !== String(expectedValue); break;
              default: passed = false;
            }
            results.push({ field, operator: op, expected: String(expectedValue), passed, actual: String(actual ?? '') });
          } catch (err) {
            results.push({ field, operator: op, expected: String(expectedValue), passed: false, actual: `Error: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        const duration = Date.now() - start;
        const passed = results.filter((r) => r.passed).length;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ assertions: results, passed, failed: results.length - passed, duration }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/block-studio/catalog') {
      try {
        const cfg = loadProjectConfig(projectRoot) as any;
        const connections: Record<string, unknown> = cfg.connections ?? {};
        if (Object.keys(connections).length === 0 && cfg.defaultConnection) {
          connections.default = cfg.defaultConnection;
        }
        const defaultKey = cfg.defaultConnection ? 'default' : Object.keys(connections)[0] ?? 'default';
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
          ? composeSemanticBlockSql(source, semanticLayer, { driver: targetConnection.driver, tableMapping })
          : null;
        const validation = validateBlockStudioSource(source, semanticLayer);
        const executableSql = semanticCompose?.sql ?? validation.executableSql;
        if (!executableSql) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          const message = semanticCompose?.diagnostics.find((item) => item.severity === 'error')?.message
            ?? validation.diagnostics.find((item) => item.severity === 'error')?.message
            ?? 'No executable SQL found in block source.';
          res.end(serializeJSON({ error: message, diagnostics: validation.diagnostics }));
          return;
        }
        const sql = resolveProjectRelativeSqlPaths(executableSql, projectRoot, projectConfig.dataDir);
        const result = await executor.executeQuery(sql, [], {}, targetConnection);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          sql: executableSql,
          result: normalizeQueryResult(result),
          chartConfig: validation.chartConfig ?? null,
        }));
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
        });
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
          dimensions: [],
          hierarchies: [],
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
        res.end(serializeJSON({ metrics: [], dimensions: [], hierarchies: [] }));
        return;
      }
      const q = url.searchParams.get('q') ?? '';
      const domain = url.searchParams.get('domain') ?? '';
      const tag = url.searchParams.get('tag') ?? '';
      const type = url.searchParams.get('type') ?? '';
      const results = semanticLayer.searchAdvanced(q, {
        domains: domain ? [domain] : undefined,
        tags: tag ? [tag] : undefined,
        types: type === 'metric' || type === 'dimension' || type === 'hierarchy' ? [type] : undefined,
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
        hierarchies: results.hierarchies.map((h) => ({
          name: h.name,
          label: h.label,
          description: h.description,
          domain: h.domain,
          levels: h.levels.map((l) => ({ name: l.name, label: l.label })),
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

    if (req.method === 'POST' && path === '/api/semantic-builder/preview') {
      try {
        if (!semanticLayer) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'No semantic layer configured.' }));
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
        const composed = semanticLayer.composeQuery({ metrics, dimensions, filters, limit, timeDimension, orderBy, driver, tableMapping });
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
          result: normalizeQueryResult(result),
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ error: error instanceof Error ? error.message : String(error) }));
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
        };
        if (!name || metrics.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJSON({ error: 'name and at least one metric are required.' }));
          return;
        }
        const targetConnection = isConnectionConfig(body.connection) ? body.connection : connection;
        const composed = semanticLayer.composeQuery({
          metrics,
          dimensions,
          filters,
          timeDimension,
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
        result.push({
          name: entry.name.replace(/\.(dql|dqlnb)$/, ''),
          path: relativePath,
          type,
          folder: relativeDir.split('/')[0] ?? relativeDir,
        });
      }
    } catch { /* skip unreadable dirs */ }
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
    reviewStatus: companion?.reviewStatus,
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

function buildSemanticTableMapping(
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

function composeSemanticBlockSql(
  source: string,
  semanticLayer: SemanticLayer,
  options?: {
    driver?: ConnectionConfig['driver'];
    tableMapping?: Record<string, string>;
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

  const composed = semanticLayer.composeQuery({
    metrics,
    dimensions: config.dimensions,
    timeDimension: config.timeDimension && config.granularity
      ? { name: config.timeDimension, granularity: config.granularity }
      : undefined,
    limit: config.limit,
    driver: options?.driver,
    tableMapping: options?.tableMapping,
  });
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

function saveBlockStudioArtifacts(
  projectRoot: string,
  options: {
    currentPath?: string;
    source: string;
    name: string;
    domain?: string;
    description?: string;
    owner?: string;
    tags?: string[];
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
  };
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

export function createBlockArtifacts(
  projectRoot: string,
  options: {
    name: string;
    domain?: string;
    content?: string;
    description?: string;
    tags?: string[];
    metricRefs?: string[];
    template?: string;
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
  const fileContent = canonicalizeSafe(normalizeBlockStudioContent({
    name: options.name,
    domain: safeDomain || 'uncategorized',
    description: options.description,
    tags: options.tags,
    content: options.content?.trim() || templateContent,
  }));

  writeFileSync(blockPath, fileContent, 'utf-8');
  const relativePath = safeDomain ? `blocks/${safeDomain}/${slug}.dql` : `blocks/${slug}.dql`;
  const companionPath = writeBlockCompanionFile(projectRoot, {
    slug,
    name: options.name,
    domain: safeDomain || 'uncategorized',
    description: options.description,
    tags: options.tags,
    provider: 'dql',
    content: fileContent,
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
  if (options.metrics.length === 1) {
    lines.push(`    metric = "${escapeDqlString(options.metrics[0])}"`);
  } else {
    lines.push(`    metrics = [${options.metrics.map((metric) => `"${escapeDqlString(metric)}"`).join(', ')}]`);
  }
  if (options.dimensions.length > 0) {
    lines.push(`    dimensions = [${options.dimensions.map((dimension) => `"${escapeDqlString(dimension)}"`).join(', ')}]`);
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
  description?: string;
  tags?: string[];
  content?: string;
}): string {
  const content = options.content?.trim();
  if (content && /^\s*block\s+"/i.test(content)) {
    return `${content.trimEnd()}\n`;
  }

  return buildBlankBlockContent({
    name: options.name,
    domain: options.domain,
    description: options.description,
    tags: options.tags,
    sql: content || 'SELECT 1 AS value',
  });
}

function buildBlankBlockContent(options: {
  name: string;
  domain: string;
  description?: string;
  tags?: string[];
  sql: string;
}): string {
  const lines = [
    `block "${escapeDqlString(options.name)}" {`,
    `    domain = "${escapeDqlString(options.domain)}"`,
    '    type = "custom"',
    `    description = "${escapeDqlString(options.description?.trim() || options.name)}"`,
    '    owner = ""',
  ];
  lines.push(`    tags = [${(options.tags ?? []).map((tag) => `"${escapeDqlString(tag)}"`).join(', ')}]`);
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

  const dbtManifestPath = resolveDbtManifestPath(projectRoot);
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

function resolveDbtManifestPath(projectRoot: string): string | undefined {
  const candidate = join(projectRoot, 'target', 'manifest.json');
  return existsSync(candidate) ? candidate : undefined;
}

function resolveLineageNode(graph: LineageGraph, rawNodeId: string) {
  if (graph.getNode(rawNodeId)) return graph.getNode(rawNodeId);
  const result = queryLineage(graph, { focus: rawNodeId });
  return result.focalNode;
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
