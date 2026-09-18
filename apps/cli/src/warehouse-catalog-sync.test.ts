import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readWarehouseCatalog } from '@duckcodeailabs/dql-core';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { assembleWarehouseCatalog, buildWarehouseCatalogQueries, syncWarehouseCatalog } from './warehouse-catalog-sync.js';
import type { ConnectionMetadataScopeV1 } from './warehouse-metadata.js';

const scope = (catalogOrDatabase: string, schemas: string[]): ConnectionMetadataScopeV1 => ({
  version: 1, connectionId: 'default', driver: 'x', mode: 'selected_scopes',
  scopes: [{ catalogOrDatabase, schemas }], selectedScopes: [{ catalogOrDatabase, schemas }], relations: [], scopeFingerprint: 'f',
});

describe('assembling a warehouse catalog from metadata rows', () => {
  it('DuckDB: columns, comments, declared keys and view SQL (rows as a real DuckDB returns them)', () => {
    const queries = buildWarehouseCatalogQueries('duckdb', { catalogOrDatabase: 'memory', schemas: ['sales'] });
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('duckdb', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'customers', column_name: 'customer_id', data_type: 'INTEGER', is_nullable: false, comment: null },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'customers', column_name: 'name', data_type: 'VARCHAR', is_nullable: true, comment: 'Full name' },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'orders', column_name: 'order_id', data_type: 'INTEGER', is_nullable: false, comment: null },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'orders', column_name: 'customer_id', data_type: 'INTEGER', is_nullable: true, comment: null },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'big_orders', column_name: 'order_id', data_type: 'INTEGER', is_nullable: true, comment: null },
      ] },
      { query: byKind('tables'), rows: [{ table_catalog: 'memory', table_schema: 'sales', table_name: 'customers', table_type: 'BASE TABLE', comment: 'One row per customer', row_count: 0 }] },
      { query: byKind('views'), rows: [{ table_catalog: 'memory', table_schema: 'sales', table_name: 'big_orders', comment: null, view_definition: 'CREATE VIEW sales.big_orders AS SELECT o.order_id FROM sales.orders AS o' }] },
      { query: byKind('keys'), rows: [
        { table_schema: 'sales', table_name: 'customers', constraint_type: 'PRIMARY KEY', constraint_column_names: ['customer_id'], referenced_table: null, referenced_column_names: [] },
        { table_schema: 'sales', table_name: 'orders', constraint_type: 'PRIMARY KEY', constraint_column_names: ['order_id'], referenced_table: null, referenced_column_names: [] },
        { table_schema: 'sales', table_name: 'orders', constraint_type: 'FOREIGN KEY', constraint_column_names: ['customer_id'], referenced_table: 'customers', referenced_column_names: ['customer_id'] },
      ] },
    ]);
    const byName = Object.fromEntries(relations.map((relation) => [relation.name, relation]));
    expect(byName.customers).toMatchObject({ id: 'warehouse.sales.customers', relation: 'sales.customers', kind: 'table', comment: 'One row per customer', primaryKey: ['customer_id'] });
    expect(byName.customers!.columns).toEqual([{ name: 'customer_id', type: 'INTEGER', nullable: false }, { name: 'name', type: 'VARCHAR', comment: 'Full name', nullable: true }]);
    expect(byName.orders!.foreignKeys).toEqual([{ columns: ['customer_id'], references: { relation: 'sales.customers', columns: ['customer_id'] } }]);
    expect(byName.big_orders).toMatchObject({ kind: 'view', viewSql: expect.stringContaining('CREATE VIEW') });
  });

  it('Snowflake: keys from SHOW PRIMARY KEYS / SHOW IMPORTED KEYS, relations qualified with the database', () => {
    const queries = buildWarehouseCatalogQueries('snowflake', { catalogOrDatabase: 'ACME', schemas: ['SALES'] });
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables', 'views', 'primary_keys', 'foreign_keys']);
    expect(queries[0]!.sql).toContain('"ACME".INFORMATION_SCHEMA.COLUMNS');
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('snowflake', [
      { query: byKind('columns'), rows: [
        { TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ORDER_ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO', COMMENT: 'The order' },
        { TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'CUSTOMER_ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'YES', COMMENT: null },
        { TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'CUSTOMERS', COLUMN_NAME: 'CUSTOMER_ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO', COMMENT: null },
      ] },
      { query: byKind('tables'), rows: [{ TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'BASE TABLE', COMMENT: 'Orders', ROW_COUNT: 1200 }] },
      { query: byKind('primary_keys'), rows: [{ schema_name: 'SALES', table_name: 'ORDERS', column_name: 'ORDER_ID', key_sequence: 1 }] },
      { query: byKind('foreign_keys'), rows: [{ pk_database_name: 'ACME', pk_schema_name: 'SALES', pk_table_name: 'CUSTOMERS', pk_column_name: 'CUSTOMER_ID', fk_schema_name: 'SALES', fk_table_name: 'ORDERS', fk_column_name: 'CUSTOMER_ID', key_sequence: 1, fk_name: 'FK_ORDERS_CUSTOMER' }] },
    ]);
    const orders = relations.find((relation) => relation.name === 'ORDERS')!;
    expect(orders).toMatchObject({ id: 'warehouse.acme.sales.orders', relation: 'ACME.SALES.ORDERS', comment: 'Orders', rowCountEstimate: 1200, primaryKey: ['ORDER_ID'] });
    expect(orders.foreignKeys).toEqual([{ columns: ['CUSTOMER_ID'], references: { relation: 'ACME.SALES.CUSTOMERS', columns: ['CUSTOMER_ID'] }, name: 'FK_ORDERS_CUSTOMER' }]);
  });

  it('Postgres: keys from information_schema with the referenced side resolved', () => {
    const queries = buildWarehouseCatalogQueries('postgres', { catalogOrDatabase: 'app', schemas: ['public'] });
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('postgres', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'app', table_schema: 'public', table_name: 'line_items', column_name: 'order_id', data_type: 'integer', is_nullable: 'NO', comment: null },
        { table_catalog: 'app', table_schema: 'public', table_name: 'line_items', column_name: 'line_no', data_type: 'integer', is_nullable: 'NO', comment: null },
      ] },
      { query: byKind('keys'), rows: [
        { constraint_type: 'PRIMARY KEY', constraint_name: 'line_items_pkey', table_schema: 'public', table_name: 'line_items', column_name: 'line_no', position: 2 },
        { constraint_type: 'PRIMARY KEY', constraint_name: 'line_items_pkey', table_schema: 'public', table_name: 'line_items', column_name: 'order_id', position: 1 },
        { constraint_type: 'FOREIGN KEY', constraint_name: 'line_items_order_fk', table_schema: 'public', table_name: 'line_items', column_name: 'order_id', position: 1, ref_schema: 'public', ref_table: 'orders', ref_column: 'id' },
      ] },
    ]);
    expect(relations[0]).toMatchObject({ relation: 'public.line_items', primaryKey: ['order_id', 'line_no'] });
    expect(relations[0]!.foreignKeys).toEqual([{ columns: ['order_id'], references: { relation: 'public.orders', columns: ['id'] }, name: 'line_items_order_fk' }]);
  });

  it('another driver reads tables, views and columns from information_schema only', () => {
    expect(buildWarehouseCatalogQueries('mysql', { catalogOrDatabase: 'shop', schemas: ['shop'] }).map((query) => query.kind)).toEqual(['columns', 'tables']);
  });
});

describe('syncing a live SQLite warehouse', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('reads declared keys and views, writes the snapshot, and reports an unreadable optional part as a warning', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-sync-'));
    roots.push(projectRoot);
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id), amount REAL);
      CREATE VIEW big_orders AS SELECT order_id FROM orders WHERE amount > 100;
    `);
    const executor = {
      executePositional: async (sql: string) => {
        if (/pragma_foreign_key_list/.test(sql) && failForeignKeys) throw new Error('permission denied');
        return { rows: db.prepare(sql).all(), columns: [], rowCount: 0 };
      },
    } as unknown as QueryExecutor;
    let failForeignKeys = false;
    const connection = { driver: 'sqlite' } as ConnectionConfig;

    const first = await syncWarehouseCatalog({ projectRoot, executor, connection, scope: scope('main', ['main']) });
    expect(first.warnings).toEqual([]);
    const snapshot = readWarehouseCatalog(projectRoot).snapshot!;
    expect(snapshot.fingerprint).toBe(first.snapshot.fingerprint);
    const byName = Object.fromEntries(snapshot.relations.map((relation) => [relation.name, relation]));
    expect(byName.customers).toMatchObject({ relation: 'main.customers', primaryKey: ['customer_id'] });
    expect(byName.customers!.columns.find((column) => column.name === 'name')).toMatchObject({ nullable: false });
    expect(byName.orders!.foreignKeys).toEqual([{ columns: ['customer_id'], references: { relation: 'main.customers', columns: ['customer_id'] }, name: '0' }]);
    expect(byName.big_orders).toMatchObject({ kind: 'view', viewSql: expect.stringContaining('CREATE VIEW') });

    failForeignKeys = true;
    const second = await syncWarehouseCatalog({ projectRoot, executor, connection, scope: scope('main', ['main']) });
    expect(second.warnings.join(' ')).toMatch(/foreign keys of main not read: permission denied/);
    expect(second.snapshot.relations.find((relation) => relation.name === 'orders')!.foreignKeys).toBeUndefined();
  });
});
