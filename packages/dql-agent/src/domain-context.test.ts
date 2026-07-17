import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { domainContextSearchDomains, resolveDomainContextEnvelope } from './domain-context.js';

describe('resolveDomainContextEnvelope', () => {
  const manifest = {
    manifestVersion: 3,
    dbtProvenance: { manifestFingerprint: 'snapshot-1' },
    modeling: {
      mode: 'dbt-first',
      packages: {
        company: { id: 'company', filePath: 'domains/company/domain.dql', exports: [] },
        growth: { id: 'growth', filePath: 'domains/growth/domain.dql', parent: 'company', exports: [] },
        commerce: { id: 'commerce', filePath: 'domains/commerce/domain.dql', exports: [] },
      },
      areas: {
        'growth::model_area::acquisition': {
          id: 'growth::model_area::acquisition', localId: 'acquisition', qualifiedId: 'growth::model_area::acquisition',
          domain: 'growth', name: 'Acquisition', intentExamples: [], entityIds: [], relationshipIds: [], referencedEntityIds: [],
          sourcePath: 'domains/growth/modeling/areas/acquisition.dql.yaml',
        },
        'commerce::model_area::acquisition': {
          id: 'commerce::model_area::acquisition', localId: 'acquisition', qualifiedId: 'commerce::model_area::acquisition',
          domain: 'commerce', name: 'Customer acquisition', intentExamples: [], entityIds: [], relationshipIds: [], referencedEntityIds: [],
          sourcePath: 'domains/commerce/modeling/areas/acquisition.dql.yaml',
        },
      },
      entities: {}, relationships: {}, contracts: {
        'commerce::contract::customer_contract': {
          id: 'commerce::contract::customer_contract', localId: 'customer_contract', qualifiedId: 'commerce::contract::customer_contract',
          domain: 'commerce', entities: [], blocks: [], status: 'certified', purpose: 'growth_attribution',
          sourcePath: 'contracts', requiredEvaluation: false,
        },
      }, conformance: {}, rules: {}, domainLineage: [],
      interfaces: {
        exports: {
          'commerce.customer@1': {
            id: 'commerce::export::customer', localId: 'customer', qualifiedId: 'commerce::export::customer', domain: 'commerce', version: 1,
            metrics: [], blocks: [], allowedKeys: ['customer_id'], allowedDimensions: [], allowedFilters: [],
            purposes: ['growth_attribution'], consumerDomains: ['growth'], contract: 'customer_contract', status: 'certified', sourcePath: 'interfaces', fingerprint: 'x',
          },
        },
        imports: {
          customer: {
            id: 'growth::import::customer', localId: 'customer', qualifiedId: 'growth::import::customer', domain: 'growth',
            exportRef: 'commerce.customer@1', purpose: 'growth_attribution', status: 'certified', sourcePath: 'interfaces',
          },
        },
      },
    },
  } as unknown as DQLManifest;

  it('resolves ancestors and exact-purpose certified imports', () => {
    const context = resolveDomainContextEnvelope({ manifest, activeDomain: 'growth', purpose: 'growth_attribution', source: 'explicit_ui' });
    expect(context.ancestors).toEqual(['company']);
    expect(context.allowedImports).toEqual([{ providerDomain: 'commerce', exportRef: 'commerce.customer@1', purpose: 'growth_attribution' }]);
    expect(domainContextSearchDomains(context)).toEqual(['growth', 'company', 'commerce']);
    expect(context.snapshotId).toBe('snapshot-1');
  });

  it('does not grant a provider domain for a different purpose', () => {
    const context = resolveDomainContextEnvelope({ manifest, activeDomain: 'growth', purpose: 'executive_reporting' });
    expect(context.allowedImports).toEqual([]);
    expect(domainContextSearchDomains(context)).toEqual(['growth', 'company']);
  });

  it('rejects unknown domains instead of falling back', () => {
    expect(() => resolveDomainContextEnvelope({ manifest, activeDomain: 'unknown' })).toThrow('Unknown domain');
  });

  it('accepts a focused area only within the active domain', () => {
    const context = resolveDomainContextEnvelope({ manifest, activeDomain: 'growth', modelAreaId: 'acquisition' });
    expect(context.modelAreaId).toBe('growth::model_area::acquisition');
    expect(resolveDomainContextEnvelope({ manifest, activeDomain: 'commerce', modelAreaId: 'acquisition' }).modelAreaId).toBe('commerce::model_area::acquisition');
    expect(() => resolveDomainContextEnvelope({ manifest, activeDomain: 'commerce', modelAreaId: 'growth::model_area::acquisition' })).toThrow('does not belong');
    expect(() => resolveDomainContextEnvelope({ manifest, modelAreaId: 'acquisition' })).toThrow('Ambiguous model area');
  });
});
