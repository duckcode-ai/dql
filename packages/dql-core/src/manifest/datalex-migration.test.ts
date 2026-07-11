import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDataLexMigration, planDataLexMigration } from './datalex-migration.js';

describe('DataLex migration planner', () => {
  let root: string;
  let datalexManifestPath: string;
  let dbtManifestPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-datalex-migration-'));
    datalexManifestPath = join(root, 'datalex-manifest.json');
    dbtManifestPath = join(root, 'manifest.json');
    writeFileSync(datalexManifestPath, JSON.stringify({
      manifestSpecVersion: '1.0.0',
      datalexVersion: '1.0.0',
      generatedAt: '2026-07-10T00:00:00Z',
      project: { name: 'commerce' },
      domains: [{
        name: 'commerce',
        entities: [{
          name: 'Order',
          description: 'DataLex order semantics that belong in dbt YAML.',
          binding: { kind: 'dbt_model', ref: 'fct_orders' },
          grain: 'order_id',
          candidate_keys: ['order_id'],
          fields: [{ name: 'order_id', description: 'A divergent DataLex field description.', type: 'integer' }],
          contracts: [{ id: 'commerce.Order.gross_revenue', name: 'gross_revenue', version: 1 }],
        }, {
          name: 'Customer',
          binding: { kind: 'dbt_model', ref: 'dim_customers' },
          grain: 'customer_id',
          candidate_keys: ['customer_id'],
        }, {
          name: 'Unmatched',
          binding: { kind: 'dbt_model', ref: 'does_not_exist' },
        }],
      }],
      relationships: [{
        name: 'order_customer',
        from: { domain: 'commerce', entity: 'Order', column: 'customer_id' },
        to: { domain: 'commerce', entity: 'Customer', column: 'customer_id' },
        cardinality: 'many_to_one',
      }],
    }));
    writeFileSync(dbtManifestPath, JSON.stringify({
      nodes: {
        'model.commerce.fct_orders': {
          resource_type: 'model', name: 'fct_orders', alias: 'fct_orders', database: 'analytics', schema: 'commerce',
          description: 'dbt-owned order description', original_file_path: 'models/fct_orders.sql',
          columns: { order_id: { description: 'dbt-owned key' }, customer_id: { description: 'dbt-owned customer key' } },
        },
        'model.commerce.dim_customers': {
          resource_type: 'model', name: 'dim_customers', alias: 'dim_customers', database: 'analytics', schema: 'commerce',
          columns: { customer_id: { description: 'dbt-owned customer key' } },
        },
      },
      sources: {},
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('converts only sparse semantics, emits dbt patches, reports loss, and never auto-certifies', () => {
    const plan = planDataLexMigration({ projectRoot: root, datalexManifestPath, dbtManifestPath });
    const overlay = plan.files.find((file) => file.kind === 'domain_overlay');

    expect(overlay?.content).toContain('dbt_model: model.commerce.fct_orders');
    expect(overlay?.content).toContain('status: draft');
    expect(overlay?.content).not.toContain('A divergent DataLex field description');
    expect(plan.files.find((file) => file.kind === 'domain_declaration')?.content).toContain('id = "commerce"');
    expect(plan.report.droppedDbtMirrors).toContainEqual({
      path: 'domains.commerce.entities.Order',
      fields: ['description', 'fields.order_id'],
    });
    expect(plan.report.losses).toContainEqual(expect.objectContaining({ path: 'domains.commerce.entities.Unmatched' }));
    expect(plan.report.autoCertified).toBe(0);
    expect(plan.files.some((file) => file.kind === 'dbt_yaml_patch' && file.content.includes('A divergent DataLex field description'))).toBe(true);
  });

  it('applies idempotently and keeps dbt patch suggestions outside dbt source paths', () => {
    const plan = planDataLexMigration({ projectRoot: root, datalexManifestPath, dbtManifestPath });
    const first = applyDataLexMigration(root, plan);
    const second = applyDataLexMigration(root, plan);

    expect(first.written.length).toBe(plan.files.length);
    expect(second.written).toEqual([]);
    expect(second.unchanged.length).toBe(plan.files.length);
    expect(existsSync(join(root, 'migrations', 'datalex', 'commerce.dbt-schema.patch.yaml'))).toBe(true);
    expect(readFileSync(join(root, 'migrations', 'datalex', 'report.json'), 'utf8')).toContain('autoCertified');
  });
});
