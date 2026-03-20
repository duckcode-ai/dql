import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import {
  buildExecutionPlan,
  createWelcomeNotebook,
  deserializeNotebook,
  getConnectorFormSchemas,
  type NotebookCell,
} from '@duckcodeailabs/dql-notebook';

export interface ProjectConfig {
  project?: string;
  defaultConnection?: ConnectionConfig;
  dataDir?: string;
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
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serializeJSON(scanDataFiles(projectRoot)));
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
        const payload = serializeJSON(result);
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

    if (req.method === 'POST' && path === '/api/test-connection') {
      try {
        const body = await readJSON(req);
        const target = normalizeProjectConnection(
          isConnectionConfig(body.connection) ? body.connection : connection,
          projectRoot,
        );
        const connector = await executor.getConnector(target);
        const ok = await connector.ping();
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({ ok: false, error: error instanceof Error ? error.message : String(error) }));
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

        const plan = buildExecutionPlan(cell);
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
        const result = await executor.executeQuery(prepared.sql, plan.sqlParams, plan.variables, prepared.connection);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJSON({
          cellType: cell.type,
          title: plan.title,
          chartConfig: plan.chartConfig,
          tests: plan.tests,
          result,
        }));
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

  return JSON.parse(readFileSync(configPath, 'utf-8')) as ProjectConfig;
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
