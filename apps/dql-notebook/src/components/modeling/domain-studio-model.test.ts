import { describe, expect, it } from 'vitest';
import type { ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';
import { DOMAIN_STUDIO_NAVIGATION, domainPackageTree, domainStudioLocationHref, entityRecords, isDomainStudioSection, resolveEntityRecordKey, withoutDomainStudioLocationHref } from './domain-studio-model';

function entity(domain: string, localId: string): ManifestModelEntity {
  return {
    id: `${domain}::entity::${localId}`,
    localId,
    qualifiedId: `${domain}::entity::${localId}`,
    domain,
    dbtUniqueId: `model.fixture.${domain}_${localId}`,
    keys: [],
    sourcePath: `domains/${domain}/modeling/entities.dql.yaml`,
    identityFingerprint: `${domain}-${localId}`,
  };
}

function modeling(entities: Record<string, ManifestModelEntity>): Pick<ManifestDbtFirstModeling, 'entities'> {
  return { entities };
}

describe('Domain Studio navigation', () => {
  it('keeps the Domain workspace focused on agent context and related products', () => {
    expect(DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items.map((item) => item.label))).toEqual([
      'Modeling',
      'Modeling AI',
      'Skills',
      'Blocks',
      'Notebooks',
      'Apps',
    ]);
    expect(isDomainStudioSection('diagram')).toBe(true);
    expect(isDomainStudioSection('ai')).toBe(true);
    expect(isDomainStudioSection('skills')).toBe(true);
    expect(isDomainStudioSection('blocks')).toBe(true);
    expect(isDomainStudioSection('notebooks')).toBe(true);
    expect(isDomainStudioSection('apps')).toBe(true);
    expect(isDomainStudioSection('knowledge')).toBe(false);
    expect(isDomainStudioSection('join-proofs')).toBe(false);
    expect(isDomainStudioSection('contracts')).toBe(false);
  });

  it('orders nested Domain Packages parent-first with simple hierarchy labels', () => {
    expect(domainPackageTree({
      'customers.lifecycle.churn': { id: 'customers.lifecycle.churn', parent: 'customers.lifecycle', filePath: 'domains/customers/lifecycle/churn/domain.dql', exports: [] },
      customers: { id: 'customers', filePath: 'domains/customers/domain.dql', exports: [] },
      'customers.lifecycle': { id: 'customers.lifecycle', parent: 'customers', filePath: 'domains/customers/lifecycle/domain.dql', exports: [] },
      products: { id: 'products', filePath: 'domains/products/domain.dql', exports: [] },
    }).map(({ id, depth, label }) => ({ id, depth, label }))).toEqual([
      { id: 'customers', depth: 0, label: 'customers' },
      { id: 'customers.lifecycle', depth: 1, label: '— lifecycle' },
      { id: 'customers.lifecycle.churn', depth: 2, label: '— — churn' },
      { id: 'products', depth: 0, label: 'products' },
    ]);
  });

  it('round-trips the selected domain, Area, and object without dropping unrelated URL state', () => {
    expect(domainStudioLocationHref('http://127.0.0.1:3474/?theme=paper', {
      domain: 'customers.lifecycle',
      section: 'diagram',
      modelAreaId: 'customers.lifecycle::model_area::retention',
      selectedId: 'customers.lifecycle::entity::orders',
    })).toBe('/?theme=paper&domain=customers.lifecycle&domainSection=diagram&modelArea=customers.lifecycle%3A%3Amodel_area%3A%3Aretention&domainObject=customers.lifecycle%3A%3Aentity%3A%3Aorders');
  });

  it('removes Domain Studio state without dropping unrelated URL state', () => {
    expect(withoutDomainStudioLocationHref(
      'http://127.0.0.1:3474/?theme=paper&domain=core&domainSection=skills&modelArea=core%3A%3Aarea&domainObject=model%3Aorders#token',
    )).toBe('/?theme=paper#token');
  });
});

describe('qualified entity record identity', () => {
  const entities = modeling({
    'commerce::entity::customer': entity('commerce', 'customer'),
    'growth::entity::customer': entity('growth', 'customer'),
  });

  it('uses manifest record keys even when local ids collide', () => {
    expect(entityRecords(entities).map((item) => item.recordKey)).toEqual(['commerce::entity::customer', 'growth::entity::customer']);
  });

  it('does not guess an ambiguous local id', () => {
    expect(resolveEntityRecordKey(entities, 'customer')).toBeUndefined();
    expect(resolveEntityRecordKey(entities, 'growth::entity::customer')).toBe('growth::entity::customer');
  });
});
