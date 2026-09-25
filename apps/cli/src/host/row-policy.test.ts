import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig, type DatabaseConnector, type QueryResult } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { withRequestContext, type DqlHostHooks, type DqlPrincipal } from './request-context.js';
import { RowPolicyRefusedError, withRowPolicy, type DqlQueryContext, type DqlRowPolicy } from './row-policy.js';

/**
 * RFC 0010 HH-3: one query path. With a host row policy, every statement the
 * server sends to a warehouse passes the policy first, once.
 */
const here = dirname(fileURLToPath(import.meta.url));
const EMPTY: QueryResult = { columns: [], rows: [], rowCount: 0, executionTime: 0 } as unknown as QueryResult;
const maria: DqlPrincipal = { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', attributes: { region: 'CA' }, source: 'host' };

class RecordingExecutor extends QueryExecutor {
  readonly ran: Array<{ via: string; sql: string; values?: unknown[] }> = [];
  override async executePositional(sql: string, values: unknown[], _config?: ConnectionConfig, _options?: unknown): Promise<QueryResult> {
    this.ran.push({ via: 'executor', sql, values });
    return EMPTY;
  }
  override async getConnector(_config?: ConnectionConfig): Promise<DatabaseConnector> {
    const ran = this.ran;
    const connector = {
      driverName: 'duckdb',
      async execute(sql: string, values?: unknown[]) { ran.push({ via: 'connector', sql, values }); return EMPTY; },
      async *stream(sql: string, values?: unknown[]) { ran.push({ via: 'stream', sql, values }); yield { rows: [] }; },
      async openConsistentReadScope() {
        return { id: 's1', async execute(sql: string, values?: unknown[]) { ran.push({ via: 'scope', sql, values }); return EMPTY; }, async close() {} };
      },
      async ping() { return true; },
    };
    return connector as unknown as DatabaseConnector;
  }
}

describe('the one query path (RFC 0010 HH-3)', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', filepath: ':memory:' };

  it('checks every kind of statement once, as the signed-in person, and runs what the policy returns', async () => {
    const seen: DqlQueryContext[] = [];
    const policy: DqlRowPolicy = (query) => {
      seen.push(query);
      return { sql: `${query.sql} /* as ${query.principal?.id ?? 'system'} */` };
    };
    const inner = new RecordingExecutor();
    const executor = withRowPolicy(inner, policy);

    await withRequestContext({ principal: maria, requestId: 'r1' }, async () => {
      await executor.executeQuery('SELECT * FROM main.order_lines WHERE region = ?', [{ name: 'region', position: 1 } as never], { region: 'CA' }, connection);
      await executor.executePositional('SELECT 1', [], connection, { purpose: 'metadata' });
      const connector = await executor.getConnector(connection);
      await connector.execute('SELECT 2');
      for await (const _batch of connector.stream!('SELECT 3')) { /* drain */ }
      const scope = await (connector as unknown as { openConsistentReadScope(): Promise<{ execute(sql: string): Promise<QueryResult> }> }).openConsistentReadScope();
      await scope.execute('SELECT 4');
    });
    await executor.executePositional('SELECT 5', [], connection);

    expect(inner.ran.map((entry) => [entry.via, entry.sql])).toEqual([
      ['executor', 'SELECT * FROM main.order_lines WHERE region = ? /* as u-maria */'],
      ['executor', 'SELECT 1 /* as u-maria */'],
      ['connector', 'SELECT 2 /* as u-maria */'],
      ['stream', 'SELECT 3 /* as u-maria */'],
      ['scope', 'SELECT 4 /* as u-maria */'],
      ['executor', 'SELECT 5 /* as system */'],
    ]);
    expect(seen).toHaveLength(6);
    expect(seen[0]).toMatchObject({ relations: ['main.order_lines'], params: ['CA'], purpose: 'data', connection: { driver: 'duckdb' } });
    expect(seen[1]?.purpose).toBe('metadata');
    expect(seen[5]?.principal).toBeNull();
  });

  it('runs nothing when the policy refuses, fails, or answers with no SQL', async () => {
    for (const policy of [
      (() => ({ refuse: 'Claims data is restricted.' })) as DqlRowPolicy,
      (() => { throw new Error('policy store down'); }) as DqlRowPolicy,
      (() => ({ sql: '   ' })) as DqlRowPolicy,
    ]) {
      const inner = new RecordingExecutor();
      const executor = withRowPolicy(inner, policy);
      await expect(executor.executePositional('SELECT * FROM claims', [], connection)).rejects.toBeInstanceOf(RowPolicyRefusedError);
      await expect((await executor.getConnector(connection)).execute('SELECT * FROM claims')).rejects.toBeInstanceOf(RowPolicyRefusedError);
      expect(inner.ran).toEqual([]);
    }
    const refused = withRowPolicy(new RecordingExecutor(), () => ({ refuse: 'Claims data is restricted.' }));
    await expect(refused.executePositional('SELECT 1', [], connection)).rejects.toThrow('Claims data is restricted.');
  });

  it('has no other way to a warehouse in server code: no second executor, pool or connector', () => {
    const src = resolve(here, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) files.push(path);
      }
    };
    walk(src);
    const direct = files
      .filter((file) => /new (QueryExecutor|ConnectionPoolManager|[A-Za-z]+Connector)\(/.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(src, file).replaceAll('\\', '/'))
      .sort();
    // One-shot CLI commands own their process; the block scheduler runs only
    // under `dql notebook` (schedules join the one path in HH-8); `dql agent`
    // tools run in the CLI, not the server.
    const allowed = new Set([
      'commands/certify.ts', 'commands/doctor.ts', 'commands/model.ts', 'commands/notebook.ts', 'commands/preview.ts',
      'commands/schedule.ts', 'commands/semantic.ts', 'commands/serve.ts', 'commands/sync.ts', 'commands/test.ts',
      'schedule/service.ts', 'llm/answer-loop-tools.ts',
    ]);
    expect(direct.filter((file) => !allowed.has(file))).toEqual([]);
    for (const pkg of ['dql-agent', 'dql-mcp']) {
      const manifest = JSON.parse(readFileSync(resolve(here, `../../../../packages/${pkg}/package.json`), 'utf-8')) as { dependencies?: Record<string, string> };
      expect(Object.keys(manifest.dependencies ?? {}), `${pkg} must reach warehouses only through the server`).not.toContain('@duckcodeailabs/dql-connectors');
    }
  });
});

const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(here, '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(here, '../../../../scripts/seed-eval-warehouse.mjs');

describe('two people, the same questions, different rows (RFC 0010 HH-3)', () => {
  duckDbIt('narrows a certified Dataset and SQL a person writes, and refuses what the policy refuses', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-row-policy-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    const people: Record<string, DqlPrincipal> = {
      admin: { id: 'u-admin', kind: 'person', email: 'admin@insurer.example', groups: ['admins'], source: 'host' },
      ca: { id: 'u-ca', kind: 'person', email: 'ca@insurer.example', attributes: { region: 'CA' }, source: 'host' },
      us: { id: 'u-us', kind: 'person', email: 'us@insurer.example', attributes: { region: 'US' }, source: 'host' },
      none: { id: 'u-none', kind: 'person', email: 'none@insurer.example', source: 'host' },
    };
    const policy: DqlRowPolicy = ({ principal, sql, purpose, relations }) => {
      if (purpose === 'metadata' || principal === null || principal.groups?.includes('admins')) return { sql };
      if (!relations.includes('main.order_lines')) return { sql };
      const region = principal.attributes?.region;
      if (typeof region !== 'string') return { refuse: 'Your profile has no region, so you may not see order lines.' };
      return { sql: sql.replace(/(?:"main"|main)\."?order_lines"?/g, `(SELECT * FROM "main"."order_lines" WHERE "region" = '${region.replace(/'/g, "''")}') AS "order_lines"`) };
    };
    const hostHooks: DqlHostHooks = {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      rowPolicy: policy,
    };
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const call = async (person: string, path: string, body?: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-person': person },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
      };

      // An admin creates a certified Dataset from the table; the schema listing is metadata.
      const tables = await call('ca', '/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      const table = tables.body.tables.find((entry: { name: string }) => entry.name === 'order_lines');
      const created = await call('admin', '/api/app-datasets/tables/create', { tableId: table.id, name: 'Order lines', domain: 'commerce' });
      expect(created.status, created.text).toBe(201);
      expect(created.body.status).toBe('certified');

      // The same Dataset question, asked by each person.
      const byRegion = { dimensions: [{ field: 'region' }], measures: [{ measure: 'order_line_count' }] };
      const rows = async (person: string) => {
        const run = await call(person, '/api/app-datasets/run', { sourceId: created.body.sourceId, query: byRegion });
        expect(run.status, `${person}: ${run.text}`).toBe(200);
        return (run.body.result.rows as Array<{ region: string; order_line_count: number }>).map((row) => [row.region, Number(row.order_line_count)]).sort();
      };
      expect(await rows('admin')).toEqual([['CA', 3], ['US', 5]]);
      expect(await rows('ca')).toEqual([['CA', 3]]);
      expect(await rows('us')).toEqual([['US', 5]]);

      // SQL a person writes, through the same path.
      const sql = { sql: 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region' };
      const mine = await call('ca', '/api/query', sql);
      expect(mine.status, mine.text).toBe(200);
      expect(JSON.stringify(mine.body)).toContain('CA');
      expect(JSON.stringify(mine.body)).not.toContain('"US"');

      // Someone the policy refuses gets the refusal, not rows.
      const refusedRun = await call('none', '/api/app-datasets/run', { sourceId: created.body.sourceId, query: byRegion });
      expect(refusedRun.body.ok).toBe(false);
      expect(refusedRun.body.result?.rows ?? []).toEqual([]);
      expect(refusedRun.text).toContain('Your profile has no region');
      const refusedSql = await call('none', '/api/query', sql);
      expect(refusedSql.text).toContain('Your profile has no region');
      expect(refusedSql.text).not.toMatch(/"n":\s*\d/);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
