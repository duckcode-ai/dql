import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DQLContext } from '../context.js';
import { getTableSchema, searchMetadata, validateSql } from '../tools/metadata.js';

function writeProject(root: string): void {
  // A dbt project config + manifest where order_items lives at dev.order_items.
  writeFileSync(
    join(root, 'dql.config.json'),
    JSON.stringify({ project: 'p', dbt: { projectDir: '.' }, dbtManifestPath: 'target/manifest.json' }),
    'utf-8',
  );
  writeFileSync(join(root, 'dbt_project.yml'), 'name: jaffle_shop\n', 'utf-8');
  mkdirSync(join(root, 'target'), { recursive: true });
  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.order_items': {
        resource_type: 'model',
        name: 'order_items',
        schema: 'dev',
        original_file_path: 'models/marts/order_items.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
        columns: { order_id: { name: 'order_id' }, amount: { name: 'amount' } },
        meta: {},
      },
      'model.jaffle_shop.stg_orders': {
        resource_type: 'model',
        name: 'stg_orders',
        schema: 'dev',
        original_file_path: 'models/staging/stg_orders.sql',
        config: { materialized: 'view' },
        tags: [],
        depends_on: { nodes: [] },
        columns: { order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' } },
        meta: {},
      },
    },
    sources: {},
    exposures: {},
  };
  writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify(manifest), 'utf-8');
}

describe('MCP grounded-SQL metadata tools (spec 15.5)', () => {
  let root: string;
  let ctx: DQLContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-metadata-'));
    writeProject(root);
    ctx = new DQLContext({ projectRoot: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('search_metadata returns qualified relations + ref forms', async () => {
    const result = await searchMetadata(ctx, { query: 'order items' });
    const orderItems = result.tables.find((t) => t.name === 'order_items')!;
    expect(orderItems.qualifiedRelation).toBe('dev.order_items');
    expect(orderItems.refForm).toBe("{{ ref('order_items') }}");
  });

  it('get_table_schema resolves a bare name to its qualified relation + join keys', () => {
    const result = getTableSchema(ctx, { table: 'order_items' });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.qualifiedRelation).toBe('dev.order_items');
      expect(result.columns.map((c) => c.name)).toContain('amount');
      expect(result.joinKeys.length).toBeGreaterThan(0);
    }
  });

  it('validate_sql passes a known relation and flags an unknown one', async () => {
    const ok = await validateSql(ctx, { sql: 'SELECT amount FROM dev.order_items' });
    expect(ok.ok).toBe(true);

    const bad = await validateSql(ctx, { sql: 'SELECT * FROM made_up_table' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('unknown_relation');
  });
});
