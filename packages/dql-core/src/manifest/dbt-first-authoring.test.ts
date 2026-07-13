import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDbtSourcePatch, applyModelingChange, dbtArtifactReadCount, loadDbtNodeAuthoringDetail, previewDbtSourcePatch, previewModelingChange, resetDbtArtifactReadCount } from './dbt-first-authoring.js';

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
    expect(preview.patches[0]).toMatchObject({ path: 'domains/commerce/modeling/model.dql.yaml', changed: true });
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
    const source = readFileSync(join(root, 'domains', 'commerce', 'modeling', 'model.dql.yaml'), 'utf8');
    expect(source).toContain('query_fingerprint: proof');
    expect(source).toContain('max_to_per_key: 1');
  });

  it('edits an existing split source in place during compatibility migration', () => {
    const modeling = join(root, 'domains', 'commerce', 'modeling');
    mkdirSync(modeling, { recursive: true });
    writeFileSync(join(modeling, 'entities.dql.yaml'), 'entities:\n  - id: order\n    dbt_model: model.shop.old_orders\n');
    const preview = previewModelingChange(root, {
      operation: 'upsert_entity',
      value: { id: 'order', domain: 'commerce', dbtModel: 'model.shop.orders' },
    });
    expect(preview.patches[0]?.path).toBe('domains/commerce/modeling/entities.dql.yaml');
  });

  it('keeps a focused model area as one Git-backed source file', () => {
    const area = {
      operation: 'upsert_area' as const,
      value: {
        id: 'customer_lifecycle', domain: 'commerce', name: 'Customer lifecycle',
        description: 'How customers progress from first order to repeat purchase.',
        intentExamples: ['Which customers made a second purchase?'],
        references: ['customer'],
      },
    };
    const areaPreview = previewModelingChange(root, area);
    expect(areaPreview.patches[0]?.path).toBe('domains/commerce/modeling/areas/customer_lifecycle.dql.yaml');
    applyModelingChange(root, area, areaPreview.fingerprint);

    const entity = {
      operation: 'upsert_entity' as const,
      value: {
        id: 'lifecycle_order', domain: 'commerce', areaId: 'customer_lifecycle', dbtModel: 'model.shop.orders',
        businessName: 'Customer order', businessContext: 'An order used to understand repeat purchasing.',
        conceptRefs: ['customer_lifecycle'], analyticalRole: 'event' as const, owner: 'commerce@example.com',
      },
    };
    const entityPreview = previewModelingChange(root, entity);
    expect(entityPreview.patches[0]?.path).toBe('domains/commerce/modeling/areas/customer_lifecycle.dql.yaml');
    applyModelingChange(root, entity, entityPreview.fingerprint);

    const source = readFileSync(join(root, 'domains', 'commerce', 'modeling', 'areas', 'customer_lifecycle.dql.yaml'), 'utf8');
    expect(source).toContain('business_name: Customer order');
    expect(source).toContain('intent_examples:');
    expect(source).toContain('references:');
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
    resetDbtArtifactReadCount();
    loadDbtNodeAuthoringDetail(join(target, 'manifest.json'), 'model.shop.orders');
    expect(dbtArtifactReadCount()).toBe(0);
  });

  it('previews and applies dbt-owned descriptions/tests to dbt YAML only', () => {
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'models', 'orders.yml'), 'version: 2\nmodels:\n  - name: orders\n    description: Old description\n');
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({
      nodes: {
        'model.shop.orders': {
          unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders',
          patch_path: 'shop://models/orders.yml', original_file_path: 'models/orders.sql',
        },
      },
      sources: {},
    }));
    const input = {
      uniqueId: 'model.shop.orders',
      description: 'One row per order.',
      columns: [{ name: 'order_id', description: 'Order key.', tests: ['unique', 'not_null'] }],
    };
    const preview = previewDbtSourcePatch(root, join(target, 'manifest.json'), input);
    expect(preview.patch.path).toBe('models/orders.yml');
    expect(preview.patch.after).toContain('description: One row per order.');
    expect(preview.patch.after).toContain('data_tests:');
    applyDbtSourcePatch(root, join(target, 'manifest.json'), input, preview.fingerprint);
    expect(readFileSync(join(root, 'models', 'orders.yml'), 'utf8')).toBe(preview.patch.after);
    expect(() => applyDbtSourcePatch(root, join(target, 'manifest.json'), { ...input, description: 'Changed' }, preview.fingerprint)).toThrow(/changed after the preview/);
  });

  it('rejects Domain Package writes redirected through a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dql-authoring-outside-'));
    writeFileSync(join(outside, 'domain.dql'), 'domain "Commerce" { id = "commerce" }\n');
    rmSync(join(root, 'domains', 'commerce'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'domains', 'commerce'), 'dir');
    try {
      expect(() => previewModelingChange(root, {
        operation: 'upsert_domain',
        value: { id: 'commerce', name: 'Commerce' },
      })).toThrow(/symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects dbt source patches redirected through a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dql-dbt-source-outside-'));
    rmSync(join(root, 'models'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'models'), 'dir');
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify({
      nodes: { 'model.shop.orders': { resource_type: 'model', name: 'orders', patch_path: 'shop://models/orders.yml' } },
      sources: {},
    }));
    try {
      expect(() => previewDbtSourcePatch(root, join(root, 'target', 'manifest.json'), {
        uniqueId: 'model.shop.orders', description: 'Unsafe redirect',
      })).toThrow(/symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
