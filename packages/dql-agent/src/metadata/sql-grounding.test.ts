import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDbtArtifacts, type DbtArtifacts } from '../propose/dbt-artifacts.js';
import {
  buildSchemaGrounding,
  buildGroundingFromRuntimeRelations,
  renderGroundingForPrompt,
  resolveRelationsInSql,
  validateSqlAgainstGrounding,
} from './sql-grounding.js';

/**
 * A dbt manifest mirroring the reported bug: `order_items` lives at
 * `dev.order_items` (schema `dev`), and `stg_orders` at `dev.stg_orders`.
 * The model NAME is bare; the qualified relation is `dev.<alias>`.
 */
function writeManifest(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.order_items': {
        resource_type: 'model',
        name: 'order_items',
        schema: 'dev',
        // No database → qualified relation is `dev.order_items`.
        original_file_path: 'models/marts/order_items.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
        columns: { order_id: { name: 'order_id' }, product_id: { name: 'product_id' }, amount: { name: 'amount' } },
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
        columns: { order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' }, ordered_at: { name: 'ordered_at' } },
        meta: {},
      },
    },
    sources: {},
    exposures: {},
  };
  const path = join(targetDir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
  return path;
}

describe('sql-grounding', () => {
  let root: string;
  let artifacts: DbtArtifacts;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sql-grounding-'));
    artifacts = loadDbtArtifacts(writeManifest(join(root, 'target')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('dbt-artifacts qualified relation', () => {
    it('exposes qualifiedRelation and {{ ref() }} form', () => {
      const orderItems = artifacts.models.find((m) => m.name === 'order_items')!;
      expect(orderItems.qualifiedRelation).toBe('dev.order_items');
      expect(orderItems.refForm).toBe("{{ ref('order_items') }}");
    });
  });

  describe('buildSchemaGrounding', () => {
    it('grounds qualified relation + ref form + columns/types + join keys', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const orderItems = grounding.tables.find((t) => t.name === 'order_items')!;
      expect(orderItems.qualifiedRelation).toBe('dev.order_items');
      expect(orderItems.refForm).toBe("{{ ref('order_items') }}");
      expect(orderItems.columns.map((c) => c.name)).toContain('order_id');

      // Join keys: order_items depends_on stg_orders, shared order_id.
      const join = grounding.joinKeys.find(
        (j) => j.leftColumn === 'order_id' && j.rightColumn === 'order_id',
      );
      expect(join).toBeDefined();
      expect([join!.leftRelation, join!.rightRelation].sort()).toEqual(['dev.order_items', 'dev.stg_orders']);
    });

    it('renders both qualified relation and ref form in the prompt', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const cellPrompt = renderGroundingForPrompt(grounding, 'cell');
      expect(cellPrompt).toContain('dev.order_items');
      expect(cellPrompt).toContain("{{ ref('order_items') }}");
      expect(cellPrompt).toContain('Join keys:');
    });
  });

  describe('resolveRelationsInSql (relation resolver)', () => {
    it('rewrites the bare name order_items → dev.order_items', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        'SELECT * FROM order_items oi JOIN stg_orders o ON oi.order_id = o.order_id',
        grounding,
      );
      expect(sql).toContain('FROM dev.order_items');
      expect(sql).toContain('JOIN dev.stg_orders');
      expect(rewrites).toEqual(
        expect.arrayContaining([
          { from: 'order_items', to: 'dev.order_items' },
          { from: 'stg_orders', to: 'dev.stg_orders' },
        ]),
      );
    });

    it('leaves an already-qualified relation untouched', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql('SELECT * FROM dev.order_items', grounding);
      expect(sql).toBe('SELECT * FROM dev.order_items');
      expect(rewrites).toEqual([]);
    });

    it('rewrites to the {{ ref() }} form for block SQL', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql } = resolveRelationsInSql('SELECT * FROM order_items', grounding, { prefer: 'ref' });
      expect(sql).toContain("FROM {{ ref('order_items') }}");
    });

    it('resolves an internal source graph identity to the inspected physical relation', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        'SELECT order_id FROM source::dev.order_items',
        grounding,
      );

      expect(sql).toBe('SELECT order_id FROM dev.order_items');
      expect(rewrites).toEqual([
        { from: 'source::dev.order_items', to: 'dev.order_items' },
      ]);
    });

    /**
     * REPORTED REPEATEDLY. The original rule only rewrote an internal identity
     * when the grounding already proved the relation, so the bug looked fixed
     * whenever retrieval happened to include the table and returned the moment
     * it did not — and the leftover `source::` is rejected 100% of the time.
     * A QUALIFIED suffix is the physical relation by construction.
     */
    it('strips a qualified internal identity even when retrieval never saw the table', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        'SELECT * FROM source::transformed_staging.semantic_models.metricflow_time_spine time_spine_src',
        grounding,
      );

      expect(sql).toContain('FROM transformed_staging.semantic_models.metricflow_time_spine time_spine_src');
      expect(sql).not.toContain('source::');
      expect(rewrites).toEqual([{
        from: 'source::transformed_staging.semantic_models.metricflow_time_spine',
        to: 'transformed_staging.semantic_models.metricflow_time_spine',
      }]);
    });

    it('strips every internal identity in one statement', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql } = resolveRelationsInSql(
        'SELECT * FROM source::dev_kkondapaka_reporting.consumption_metrics.consumption_daily_metrics_detail d'
        + ' JOIN source::transformed_staging.semantic_models.metricflow_time_spine t ON t.d = d.d',
        grounding,
      );
      expect(sql).not.toContain('source::');
      expect(sql).toContain('FROM dev_kkondapaka_reporting.consumption_metrics.consumption_daily_metrics_detail d');
      expect(sql).toContain('JOIN transformed_staging.semantic_models.metricflow_time_spine t');
    });

    // A BARE identity carries no database or schema, so there is nothing to
    // decode — the validator's complaint is the right outcome there.
    it('leaves an unqualified internal graph identity intact for fail-closed validation', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        'SELECT * FROM source::unknown_orders',
        grounding,
      );

      expect(sql).toContain('source::unknown_orders');
      expect(rewrites).toEqual([]);
    });

    // A CTE that shadows a grounded relation name used to be rewritten to the
    // physical relation. The query still EXECUTED and returned the unfiltered
    // total — a wrong number under a passing trust label.
    it('never rewrites a CTE that shadows a grounded relation name', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        `WITH order_items AS (
           SELECT order_id, amount FROM dev.order_items WHERE amount > 0
         )
         SELECT SUM(amount) AS total FROM order_items`,
        grounding,
      );

      expect(sql).toContain('FROM order_items');
      expect(sql).not.toMatch(/FROM dev\.order_items WHERE amount > 0[\s\S]*FROM dev\.order_items/);
      expect(rewrites).toEqual([]);
    });

    it('qualifies a real relation joined against a shadowing CTE', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        `WITH order_items AS (SELECT order_id FROM dev.order_items)
         SELECT * FROM order_items oi JOIN stg_orders o ON oi.order_id = o.order_id`,
        grounding,
      );

      expect(sql).toContain('FROM order_items oi');
      expect(sql).toContain('JOIN dev.stg_orders o');
      expect(rewrites).toEqual([{ from: 'stg_orders', to: 'dev.stg_orders' }]);
    });

    it('leaves a CTE name alone even when the statement does not parse', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        `WITH order_items AS (SELECT 1) SELECT * FROM order_items QUALIFY ~~~ broken`,
        grounding,
      );

      expect(sql).toContain('FROM order_items QUALIFY');
      expect(rewrites).toEqual([]);
    });

    it('leaves a subquery alias that shadows a grounded relation name', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const { sql, rewrites } = resolveRelationsInSql(
        'SELECT * FROM (SELECT order_id FROM dev.stg_orders) AS order_items',
        grounding,
      );

      expect(sql).toBe('SELECT * FROM (SELECT order_id FROM dev.stg_orders) AS order_items');
      expect(rewrites).toEqual([]);
    });
  });

  describe('validateSqlAgainstGrounding', () => {
    it('passes a query over a known qualified relation', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const result = validateSqlAgainstGrounding('SELECT order_id FROM dev.order_items', grounding);
      expect(result.ok).toBe(true);
    });

    it('flags an unknown table', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const result = validateSqlAgainstGrounding('SELECT * FROM made_up_table', grounding);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('unknown_relation');
        expect(result.offending?.relation).toBe('made_up_table');
      }
    });

    it('flags an unknown column on a known relation', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const result = validateSqlAgainstGrounding('SELECT dev.order_items.nope FROM dev.order_items', grounding);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('unknown_column');
        expect(result.offending?.column).toBe('nope');
      }
    });

    it('flags an unqualified column shared by joined runtime relations', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const result = validateSqlAgainstGrounding(`
        SELECT order_id
        FROM dev.order_items AS oi
        JOIN dev.stg_orders AS o ON oi.order_id = o.order_id
      `, grounding);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('unknown_column');
        expect(result.offending?.column).toBe('order_id');
        expect(result.error).toContain('oi (dev.order_items)');
        expect(result.error).toContain('o (dev.stg_orders)');
      }
    });

    it('rejects non-SELECT statements', () => {
      const grounding = buildSchemaGrounding(artifacts);
      const result = validateSqlAgainstGrounding('DELETE FROM dev.order_items', grounding);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('unsafe_sql');
    });
  });

  describe('buildGroundingFromRuntimeRelations (shared with the answer-loop)', () => {
    it('qualifies a bare name against pre-qualified runtime relations', () => {
      const grounding = buildGroundingFromRuntimeRelations([
        { relation: 'dev.order_items', name: 'order_items', columns: [{ name: 'order_id' }] },
      ]);
      const { sql } = resolveRelationsInSql('SELECT order_id FROM order_items', grounding);
      expect(sql).toContain('FROM dev.order_items');
    });
  });
});

/**
 * The decisive case. A leaked `source::` identity survives precisely when
 * retrieval came back thin — and an empty grounding used to make
 * `resolveRelationsInSql` return immediately, before any decoding happened.
 * That early return is why this bug kept reappearing.
 */
describe('internal identities are decoded even with no grounding at all', () => {
  const EMPTY = { tables: [], joinKeys: [], byKey: new Map() };

  it('strips qualified identities when the grounding is empty', () => {
    const { sql, rewrites } = resolveRelationsInSql(
      'SELECT * FROM source::transformed_staging.semantic_models.metricflow_time_spine t',
      EMPTY as never,
    );
    expect(sql).not.toContain('source::');
    expect(sql).toContain('FROM transformed_staging.semantic_models.metricflow_time_spine t');
    expect(rewrites).toHaveLength(1);
  });

  it('still leaves a bare identity for the validator', () => {
    const { sql } = resolveRelationsInSql('SELECT * FROM source::orders', EMPTY as never);
    expect(sql).toContain('source::orders');
  });

  it('leaves ordinary SQL untouched when there is no grounding', () => {
    const sqlText = 'SELECT a FROM db.schema.table t WHERE t.a > 1';
    expect(resolveRelationsInSql(sqlText, EMPTY as never).sql).toBe(sqlText);
  });
});
