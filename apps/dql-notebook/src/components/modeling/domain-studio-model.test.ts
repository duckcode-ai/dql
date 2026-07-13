import { describe, expect, it } from 'vitest';
import type { ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';
import { DOMAIN_STUDIO_NAVIGATION, entityRecords, resolveEntityRecordKey } from './domain-studio-model';

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
  it('keeps the locked contextual information architecture', () => {
    expect(DOMAIN_STUDIO_NAVIGATION.map((group) => [group.label, group.items.map((item) => item.label)])).toEqual([
      [undefined, ['Domain', 'Blocks', 'Modeling', 'Skills']],
    ]);
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
