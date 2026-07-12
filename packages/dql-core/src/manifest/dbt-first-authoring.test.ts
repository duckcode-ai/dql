import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyModelingChange, loadDbtNodeAuthoringDetail, previewModelingChange } from './dbt-first-authoring.js';

describe('dbt-first Domain Package authoring', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-authoring-'));
    mkdirSync(join(root, 'domains', 'commerce'), { recursive: true });
    writeFileSync(join(root, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" { id = "commerce" owner = "data@example.com" }\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('previews and applies a deterministic entity binding without copying dbt schema', () => {
    const change = {
      operation: 'upsert_entity' as const,
      value: { id: 'order', domain: 'commerce', dbtModel: 'model.shop.orders', grain: 'order_id', keys: ['order_id'] },
    };
    const preview = previewModelingChange(root, change);
    expect(preview.patches[0]).toMatchObject({ path: 'domains/commerce/modeling/entities.dql.yaml', changed: true });
    expect(preview.patches[0]?.after).toContain('dbt_model: model.shop.orders');
    expect(preview.patches[0]?.after).not.toContain('columns:');

    applyModelingChange(root, change, preview.fingerprint);
    const rebuilt = previewModelingChange(root, change);
    expect(rebuilt.patches[0]?.changed).toBe(false);
  });

  it('rejects an apply when source changed after preview', () => {
    const change = { operation: 'upsert_domain' as const, value: { id: 'growth', name: 'Growth', exports: [] } };
    const preview = previewModelingChange(root, change);
    expect(preview.patches).toHaveLength(1);
    expect(preview.patches[0]?.path).toBe('domains/growth/domain.dql');
    mkdirSync(join(root, 'domains', 'growth'), { recursive: true });
    writeFileSync(join(root, 'domains', 'growth', 'domain.dql'), 'domain "Growth" { id = "growth" owner = "someone@example.com" }\n');
    expect(() => applyModelingChange(root, change, preview.fingerprint)).toThrow(/changed after the preview/);
  });

  it('persists relationship validation evidence in the sparse overlay', () => {
    const change = {
      operation: 'upsert_relationship' as const,
      value: {
        id: 'order_to_customer', domain: 'commerce', from: 'order', to: 'customer',
        keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one' as const,
        fanout: 'safe' as const, status: 'certified' as const,
        validation: {
          status: 'passed' as const, checkedAt: '2026-07-11T00:00:00.000Z', queryFingerprint: 'proof',
          fromRows: 10, toRows: 5, joinedRows: 10, fromNullKeys: 0, toNullKeys: 0,
          unmatchedFrom: 0, maxFromPerKey: 3, maxToPerKey: 1,
        },
      },
    };
    applyModelingChange(root, change);
    const source = readFileSync(join(root, 'domains', 'commerce', 'modeling', 'relationships.dql.yaml'), 'utf8');
    expect(source).toContain('query_fingerprint: proof');
    expect(source).toContain('max_to_per_key: 1');
  });

  it('attaches dbt generic test constraints to their columns', () => {
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({
      nodes: {
        'model.shop.orders': { unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders', columns: { order_id: {} } },
        'test.shop.unique_orders_order_id': { unique_id: 'test.shop.unique_orders_order_id', resource_type: 'test', name: 'unique_orders_order_id', column_name: 'order_id', test_metadata: { name: 'unique', kwargs: { column_name: 'order_id' } } },
        'test.shop.not_null_orders_order_id': { unique_id: 'test.shop.not_null_orders_order_id', resource_type: 'test', name: 'not_null_orders_order_id', column_name: 'order_id', test_metadata: { name: 'not_null', kwargs: { column_name: 'order_id' } } },
      },
      sources: {},
      child_map: { 'model.shop.orders': ['test.shop.unique_orders_order_id', 'test.shop.not_null_orders_order_id'] },
    }));
    const detail = loadDbtNodeAuthoringDetail(join(target, 'manifest.json'), 'model.shop.orders');
    expect(detail?.columns[0]?.tests).toEqual(['not_null', 'unique']);
  });
});
