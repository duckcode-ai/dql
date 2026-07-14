import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDomainPackageRegistry } from './domain-package-registry.js';

describe('DomainPackageRegistry', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-domain-registry-'));
    mkdirSync(join(root, 'domains', 'commerce', 'orders', 'blocks'), { recursive: true });
    writeFileSync(join(root, 'domains', 'commerce', 'domain.dql'), `domain "Commerce" {
  id = "commerce"
  owner = "commerce-analytics"
  exports = ["customer"]
}
`);
    writeFileSync(join(root, 'domains', 'commerce', 'orders', 'domain.dql'), `domain "Orders" {
  id = "commerce.orders"
  parent = "commerce"
}
`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('discovers one canonical recursive hierarchy and resolves owning packages', () => {
    const registry = loadDomainPackageRegistry(root);
    expect(registry.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(registry.values().map((pkg) => pkg.id)).toEqual(['commerce', 'commerce.orders']);
    expect(registry.get('commerce.orders')).toMatchObject({ ancestry: ['commerce'], depth: 1 });
    expect(registry.get('commerce')?.exports).toEqual(['customer']);
    expect(registry.packageForPath('domains/commerce/orders/blocks/revenue.dql')?.id).toBe('commerce.orders');
    expect(registry.descendants('commerce').map((pkg) => pkg.id)).toEqual(['commerce.orders']);
  });

  it('accepts a legacy YAML-only package with a migration warning', () => {
    mkdirSync(join(root, 'domains', 'growth'), { recursive: true });
    writeFileSync(join(root, 'domains', 'growth', 'domain.dql.yaml'), 'id: growth\nowner: growth-analytics\n');
    const registry = loadDomainPackageRegistry(root);
    expect(registry.get('growth')).toMatchObject({ legacyYamlPath: 'domains/growth/domain.dql.yaml' });
    expect(registry.diagnostics.some((diagnostic) => diagnostic.message.includes('compatibility-only'))).toBe(true);
  });

  it('rejects missing parents and path/parent mismatches', () => {
    mkdirSync(join(root, 'domains', 'orphan'), { recursive: true });
    writeFileSync(join(root, 'domains', 'orphan', 'domain.dql'), 'domain "Orphan" { id = "growth.orphan" parent = "growth" }\n');
    const registry = loadDomainPackageRegistry(root);
    expect(registry.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.message.includes('missing parent'))).toBe(true);
  });
});
