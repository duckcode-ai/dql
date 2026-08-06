import { describe, expect, it } from 'vitest';
import type { ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';
import { DOMAIN_STUDIO_NAVIGATION, domainPackageTree, domainStudioLocationHref, entityRecords, isDescriptiveOnlyChange, isDomainStudioSection, resolveEntityRecordKey, withoutDomainStudioLocationHref } from './domain-studio-model';

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
    // The five task destinations from `05-domain-studio-ui.md`. Modeling AI is
    // deliberately absent: it is an action on the canvas that docks beside the
    // diagram it edits, not a place you navigate to.
    expect(DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items.map((item) => item.label))).toEqual([
      'Modeling',
      'Skills',
      'Blocks',
      'Notebooks',
      'Apps',
    ]);
    expect(isDomainStudioSection('diagram')).toBe(true);
    expect(isDomainStudioSection('skills')).toBe(true);
    expect(isDomainStudioSection('blocks')).toBe(true);
    expect(isDomainStudioSection('notebooks')).toBe(true);
    expect(isDomainStudioSection('apps')).toBe(true);
    // Removed sections normalize to the canvas rather than resolving.
    expect(isDomainStudioSection('ai')).toBe(false);
    expect(isDomainStudioSection('overview')).toBe(false);
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

describe('two-tier authoring write path (00-decisions.md#a-001)', () => {
  const existing: ManifestModelEntity = {
    id: 'order', localId: 'order', qualifiedId: 'commerce::entity::order', domain: 'commerce',
    areaId: 'commerce::area::core', dbtUniqueId: 'model.shop.fct_orders',
    businessName: 'Order', grain: 'order_id', keys: ['order_id'], status: 'draft',
    sourcePath: 'domains/commerce/modeling/model.dql.yaml', identityFingerprint: 'fp',
  } as ManifestModelEntity;

  const upsert = (value: Partial<ManifestModelEntity> & Record<string, unknown>) => ({
    operation: 'upsert_entity' as const,
    value: {
      id: 'order', domain: 'commerce', areaId: 'core', dbtModel: 'model.shop.fct_orders',
      grain: 'order_id', keys: ['order_id'], status: 'draft', ...value,
    },
  });

  it('saves prose edits directly: they carry no join or lifecycle meaning', () => {
    expect(isDescriptiveOnlyChange(upsert({ businessContext: 'One completed purchase.' }) as never, existing)).toBe(true);
    expect(isDescriptiveOnlyChange(upsert({ businessName: 'Customer order' }) as never, existing)).toBe(true);
    expect(isDescriptiveOnlyChange(upsert({ analyticalRole: 'event' }) as never, existing)).toBe(true);
  });

  it('keeps the full proposal review for anything structural', () => {
    // Creating an object.
    expect(isDescriptiveOnlyChange(upsert({}) as never, undefined)).toBe(false);
    // Rebinding the dbt model.
    expect(isDescriptiveOnlyChange(upsert({ dbtModel: 'model.shop.stg_orders' }) as never, existing)).toBe(false);
    // Asserting a different grain or keys.
    expect(isDescriptiveOnlyChange(upsert({ grain: 'line_item_id' }) as never, existing)).toBe(false);
    expect(isDescriptiveOnlyChange(upsert({ keys: ['order_id', 'customer_id'] }) as never, existing)).toBe(false);
    // Moving lifecycle or ownership.
    expect(isDescriptiveOnlyChange(upsert({ status: 'certified' }) as never, existing)).toBe(false);
    expect(isDescriptiveOnlyChange(upsert({ domain: 'growth' }) as never, existing)).toBe(false);
    expect(isDescriptiveOnlyChange(upsert({ areaId: 'billing' }) as never, existing)).toBe(false);
    // Relationships are never descriptive-only.
    expect(isDescriptiveOnlyChange({ operation: 'upsert_relationship', value: { id: 'r' } } as never, existing)).toBe(false);
  });
});
