import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelingChanges, previewModelingChanges } from './dbt-first-authoring.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('batch modeling authoring', () => {
  it('composes multiple entity bindings in one write-free preview', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-modeling-batch-'));
    roots.push(root);
    mkdirSync(join(root, 'domains', 'commerce'), { recursive: true });
    writeFileSync(join(root, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n  reviewCadence = "quarterly"\n}\n');
    const changes = ['orders', 'customers'].map((id) => ({
      operation: 'upsert_entity' as const,
      value: { id, domain: 'commerce', dbtModel: `model.shop.${id}`, status: 'draft' as const },
    }));

    const preview = previewModelingChanges(root, changes);
    const target = join(root, preview.patches[0]!.path);
    expect(existsSync(target)).toBe(false);
    expect(preview.patches).toHaveLength(1);
    expect(preview.patches[0]?.after).toContain('model.shop.orders');
    expect(preview.patches[0]?.after).toContain('model.shop.customers');

    applyModelingChanges(root, changes, preview.fingerprint);
    expect(readFileSync(target, 'utf8')).toContain('model.shop.customers');
  });
});
