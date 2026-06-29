import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataLexContractRegistry, parseContractRef, type DataLexManifest } from './index.js';

function tinyManifest(overrides?: Partial<DataLexManifest>): DataLexManifest {
  return {
    manifestSpecVersion: '1.0.0',
    datalexVersion: '1.8.2',
    generatedAt: '2026-05-01T12:00:00Z',
    project: { name: 'test_project', dialect: 'duckdb' },
    domains: [
      {
        name: 'commerce',
        entities: [
          {
            name: 'Customer',
            contracts: [
              {
                id: 'commerce.Customer.monthly_active_customers',
                name: 'monthly_active_customers',
                version: 1,
                description: 'MAU contract.',
                signature: {
                  inputs: [{ name: 'order_month', type: 'date' }],
                  outputs: [
                    { name: 'monthly_active_customers', type: 'integer', constraints: ['positive'] },
                  ],
                },
              },
              {
                id: 'commerce.Customer.monthly_active_customers',
                name: 'monthly_active_customers',
                version: 2,
                description: 'MAU contract v2 (added per-region breakdown).',
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('parseContractRef', () => {
  it('accepts a bare id', () => {
    const out = parseContractRef('commerce.Customer.monthly_active_customers');
    expect(out).toEqual({ ok: true, id: 'commerce.Customer.monthly_active_customers' });
  });

  it('accepts an id with a positive integer version pin', () => {
    const out = parseContractRef('commerce.Customer.monthly_active_customers@2');
    expect(out).toEqual({
      ok: true,
      id: 'commerce.Customer.monthly_active_customers',
      version: 2,
    });
  });

  it('rejects an empty string', () => {
    expect(parseContractRef('').ok).toBe(false);
  });

  it('rejects ids that violate the <domain>.<Entity>.<contract_name> pattern', () => {
    expect(parseContractRef('Commerce.customer.foo').ok).toBe(false); // entity must be PascalCase
    expect(parseContractRef('commerce.Customer.Foo').ok).toBe(false); // contract must be snake_case
    expect(parseContractRef('commerce..foo').ok).toBe(false);
    expect(parseContractRef('commerce.Customer').ok).toBe(false);
  });

  it('rejects non-positive or non-integer versions', () => {
    expect(parseContractRef('commerce.Customer.monthly_active_customers@0').ok).toBe(false);
    expect(parseContractRef('commerce.Customer.monthly_active_customers@-1').ok).toBe(false);
    expect(parseContractRef('commerce.Customer.monthly_active_customers@1.0').ok).toBe(false);
    expect(parseContractRef('commerce.Customer.monthly_active_customers@latest').ok).toBe(false);
  });
});

describe('DataLexContractRegistry — in-memory manifest', () => {
  it('isLoaded() reflects whether contracts were indexed', () => {
    const empty = new DataLexContractRegistry();
    expect(empty.isLoaded()).toBe(false);

    const loaded = new DataLexContractRegistry({ manifest: tinyManifest() });
    expect(loaded.isLoaded()).toBe(true);
  });

  it('lists indexed contracts in id-then-version order', () => {
    const registry = new DataLexContractRegistry({ manifest: tinyManifest() });
    const list = registry.list();
    expect(list.map((c) => c.contract.version)).toEqual([1, 2]);
    expect(list[0].domain).toBe('commerce');
    expect(list[0].entity).toBe('Customer');
  });

  it('resolves an unversioned ref to the highest version', () => {
    const registry = new DataLexContractRegistry({ manifest: tinyManifest() });
    const result = registry.resolve('commerce.Customer.monthly_active_customers');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.version).toBe(2);
      expect(result.domain).toBe('commerce');
      expect(result.entity).toBe('Customer');
    }
  });

  it('resolves a pinned version exactly', () => {
    const registry = new DataLexContractRegistry({ manifest: tinyManifest() });
    const result = registry.resolve('commerce.Customer.monthly_active_customers@1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.version).toBe(1);
      expect(result.contract.signature?.outputs?.[0]?.name).toBe('monthly_active_customers');
    }
  });

  it('returns version_mismatch when a pinned version is missing', () => {
    const registry = new DataLexContractRegistry({ manifest: tinyManifest() });
    const result = registry.resolve('commerce.Customer.monthly_active_customers@99');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('version_mismatch');
      expect(result.availableVersions).toEqual([1, 2]);
    }
  });

  it('returns not_found when the contract id is unknown', () => {
    const registry = new DataLexContractRegistry({ manifest: tinyManifest() });
    const result = registry.resolve('commerce.Customer.does_not_exist');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });

  it('returns malformed_ref for invalid syntax', () => {
    const registry = new DataLexContractRegistry({ manifest: tinyManifest() });
    const result = registry.resolve('not-a-valid-ref');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed_ref');
    }
  });

  it('tolerates manifests with no domains / no entities / no contracts', () => {
    const registry = new DataLexContractRegistry({
      manifest: { ...tinyManifest(), domains: [] },
    });
    expect(registry.isLoaded()).toBe(false);
    expect(registry.resolve('commerce.Customer.monthly_active_customers').ok).toBe(false);
  });
});

describe('DataLexContractRegistry — filesystem manifest', () => {
  it('loads, indexes, and resolves a manifest from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'datalex-registry-'));
    const path = join(dir, 'datalex-manifest.json');
    try {
      writeFileSync(path, JSON.stringify(tinyManifest()));
      const registry = new DataLexContractRegistry({ manifestPath: path });
      expect(registry.isLoaded()).toBe(true);
      const result = registry.resolve('commerce.Customer.monthly_active_customers@2');
      expect(result.ok).toBe(true);
      expect(registry.loadDiagnostics()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a diagnostic when the path does not exist', () => {
    const registry = new DataLexContractRegistry({
      manifestPath: '/tmp/does/not/exist/datalex-manifest.json',
    });
    expect(registry.isLoaded()).toBe(false);
    expect(registry.loadDiagnostics()[0]).toMatch(/not found/i);
  });

  it('emits a diagnostic when the file is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'datalex-registry-'));
    const path = join(dir, 'datalex-manifest.json');
    try {
      writeFileSync(path, '{not-valid-json');
      const registry = new DataLexContractRegistry({ manifestPath: path });
      expect(registry.isLoaded()).toBe(false);
      expect(registry.loadDiagnostics()[0]).toMatch(/parse/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reload() picks up filesystem changes between calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'datalex-registry-'));
    const path = join(dir, 'datalex-manifest.json');
    try {
      writeFileSync(path, JSON.stringify(tinyManifest()));
      const registry = new DataLexContractRegistry({ manifestPath: path });
      expect(registry.list()).toHaveLength(2);

      const updated = tinyManifest();
      updated.domains[0].entities[0].contracts!.push({
        id: 'commerce.Customer.churn_rate',
        name: 'churn_rate',
        version: 1,
      });
      writeFileSync(path, JSON.stringify(updated));
      registry.reload();
      const ids = new Set(registry.list().map((c) => c.contract.id));
      expect(ids.has('commerce.Customer.churn_rate')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DataLexContractRegistry — relationships and conformance', () => {
  function relManifest(): DataLexManifest {
    return {
      ...tinyManifest(),
      relationships: [
        {
          name: 'customer_places_order',
          type: 'reference',
          layer: 'conceptual',
          from: { domain: 'sales', entity: 'Customer' },
          to: { domain: 'sales', entity: 'Order' },
          cardinality: 'one_to_many',
        },
        {
          name: 'order_customer_fk',
          type: 'reference',
          layer: 'logical',
          from: { domain: 'sales', entity: 'Order', column: 'customer_id' },
          to: { domain: 'sales', entity: 'Customer', column: 'customer_id' },
          cardinality: 'many_to_one',
        },
      ],
      conformance: [
        {
          concept: 'Customer',
          domain: 'sales',
          layer: 'logical',
          canonical_key: ['customer_id'],
          business_key: ['email'],
          implements: ['customer'],
          physical: [{ entity: 'DimCustomer', binding: { kind: 'table', ref: 'dim_customer' } }],
        },
      ],
    };
  }

  it('indexes relationships and conformance from the manifest', () => {
    const registry = new DataLexContractRegistry({ manifest: relManifest() });
    expect(registry.relationships()).toHaveLength(2);
    expect(registry.conformance()).toHaveLength(1);
  });

  it('resolves conformance for a concept (case-insensitive, domain-scoped)', () => {
    const registry = new DataLexContractRegistry({ manifest: relManifest() });
    const customer = registry.conformanceFor('customer', 'sales');
    expect(customer?.canonical_key).toEqual(['customer_id']);
    expect(customer?.physical?.[0]?.binding?.ref).toBe('dim_customer');
  });

  it('joins Order -> Customer without fan-out, preferring the column-carrying relationship', () => {
    const registry = new DataLexContractRegistry({ manifest: relManifest() });
    const path = registry.joinPath('Order', 'Customer');
    expect(path.ok).toBe(true);
    if (path.ok) {
      expect(path.relationship.name).toBe('order_customer_fk');
      expect(path.cardinality).toBe('many_to_one');
      expect(path.fansOut).toBe(false);
      expect(path.base.column).toBe('customer_id');
      expect(path.target.column).toBe('customer_id');
    }
  });

  it('flags fan-out when joining Customer -> Order (one_to_many)', () => {
    const registry = new DataLexContractRegistry({ manifest: relManifest() });
    const path = registry.joinPath('Customer', 'Order');
    expect(path.ok).toBe(true);
    if (path.ok) {
      expect(path.cardinality).toBe('one_to_many');
      expect(path.fansOut).toBe(true);
    }
  });

  it('returns no_relationship for unconnected entities', () => {
    const registry = new DataLexContractRegistry({ manifest: relManifest() });
    const path = registry.joinPath('Order', 'Channel');
    expect(path.ok).toBe(false);
    if (!path.ok) expect(path.reason).toBe('no_relationship');
  });

  it('serves relationships and join paths even when no certified contracts exist', () => {
    const registry = new DataLexContractRegistry({
      manifest: { ...relManifest(), domains: [] },
    });
    expect(registry.isLoaded()).toBe(false);
    expect(registry.relationships()).toHaveLength(2);
    expect(registry.joinPath('Order', 'Customer').ok).toBe(true);
  });
});
