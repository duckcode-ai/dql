/**
 * RFC 0007 end to end through the local runtime: a project with no dbt, a
 * real SQLite warehouse, Settings → Sync schema, then Modeling over the
 * warehouse's own relations.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from './local-runtime.js';

describe('warehouse-first modeling in the local runtime', () => {
  const roots: string[] = [];
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('syncs the warehouse catalog, lists its relations, binds entities with `relation:` and validates a join on the warehouse', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-runtime-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id), amount REAL);
      INSERT INTO customers VALUES (1, 'Ann'), (2, 'Bo');
      INSERT INTO orders VALUES (10, 1, 50), (11, 1, 150), (12, 2, 70);
    `);
    db.close();
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop',
      manifestVersion: 3,
      modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'sqlite', filepath: './shop.sqlite' } },
    }));

    const executor = new QueryExecutor();
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor,
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, init);
      return { status: response.status, body: await response.json() as any };
    };

    // Modeling is available without dbt, and says what to do before a sync.
    const before = await json('/api/modeling/dbt-first');
    expect(before.status).toBe(200);
    expect(before.body.modeling.mode).toBe('warehouse-first');
    expect(before.body.diagnostics.map((item: { message: string }) => item.message).join('\n')).toMatch(/dql sync warehouse/);

    // Settings → Sync schema reads the catalog as well as Ask's schema metadata.
    const discovery = await json('/api/connections/default/metadata-scope/discovery', { method: 'POST' });
    expect(discovery.body).toMatchObject({ supported: true, scopes: [{ catalogOrDatabase: 'main', schemas: [{ name: 'main' }] }] });
    const synced = await json('/api/connections/default/metadata-scope', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }] }),
    });
    expect(synced.status).toBe(200);
    expect(synced.body.status).toMatchObject({ state: 'ready', relationCount: 2 });
    expect(synced.body.warehouseCatalog).toMatchObject({ relations: 2, connectionId: 'default', warnings: [] });
    expect(existsSync(join(projectRoot, '.dql', 'warehouse-catalog.json'))).toBe(true);
    const status = await json('/api/connections/default/metadata-scope');
    expect(status.body.warehouseCatalog).toMatchObject({ relations: 2, fingerprint: synced.body.warehouseCatalog.fingerprint });

    // The Database browser lists the warehouse relations; their detail comes from the snapshot.
    const inventory = await json('/api/modeling/dbt-first/inventory?physicalOnly=true');
    expect(inventory.status).toBe(200);
    expect(inventory.body.scope).toBe('warehouse_relations');
    expect(inventory.body.items.map((item: { uniqueId: string }) => item.uniqueId).sort()).toEqual(['warehouse.main.customers', 'warehouse.main.orders']);
    const detail = await json('/api/modeling/dbt-first/nodes/warehouse.main.orders');
    expect(detail.body).toMatchObject({ resourceType: 'warehouse', relation: 'main.orders', dqlMeta: { keys: ['order_id'] } });
    expect(detail.body.columns.map((column: { name: string }) => column.name)).toEqual(['order_id', 'customer_id', 'amount']);

    // Modeling authoring writes `relation:` for a warehouse relation.
    const apply = async (change: Record<string, unknown>) => {
      const snapshotId = (await json('/api/modeling/dbt-first')).body.snapshotId;
      const preview = await json('/api/modeling/dbt-first/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change, expectedSnapshotId: snapshotId }) });
      expect(preview.status).toBe(200);
      const applied = await json('/api/modeling/dbt-first/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change, fingerprint: preview.body.fingerprint, expectedSnapshotId: snapshotId }) });
      expect(applied.status).toBe(200);
      return applied.body;
    };
    await apply({ operation: 'upsert_domain', value: { id: 'sales', name: 'Sales', owner: 'sales@shop.test' } });
    await apply({ operation: 'upsert_entity', value: { id: 'order', domain: 'sales', dbtModel: 'warehouse.main.orders' } });
    const applied = await apply({ operation: 'upsert_entity', value: { id: 'customer', domain: 'sales', dbtModel: 'warehouse.main.customers' } });
    expect(applied.modeling.entities['sales::entity::order']).toMatchObject({ dbtUniqueId: 'warehouse.main.orders', relation: 'main.orders', grain: 'order_id' });
    const entityYaml = readFileSync(join(projectRoot, 'domains', 'sales', 'modeling', 'model.dql.yaml'), 'utf-8');
    expect(entityYaml).toContain('relation: main.orders');
    expect(entityYaml).not.toContain('dbt_model');

    // A join is validated by running it on the warehouse, as for dbt models.
    const snapshotId = (await json('/api/modeling/dbt-first')).body.snapshotId;
    const validated = await json('/api/modeling/dbt-first/relationships/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedSnapshotId: snapshotId,
        relationship: { id: 'order_to_customer', domain: 'sales', from: 'sales::entity::order', to: 'sales::entity::customer', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'draft' },
      }),
    });
    expect(validated.status).toBe(200);
    expect(validated.body.evidence).toMatchObject({ status: 'passed', fromRows: 3, joinedRows: 3, unmatchedFrom: 0 });
    await executor.disconnect();
  }, 60_000);
});
