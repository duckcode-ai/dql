import type { ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';

export type DomainStudioSection =
  | 'overview'
  | 'diagram'
  | 'terms'
  | 'skills'
  | 'blocks'
  | 'views'
  | 'join-proofs'
  | 'contracts'
  | 'interfaces'
  | 'evaluations'
  | 'notebooks'
  | 'apps'
  | 'dbt'
  | 'ai';

export type DomainStudioNavigationItem = {
  id: DomainStudioSection;
  label: string;
};

export type DomainStudioNavigationGroup = {
  label?: string;
  items: DomainStudioNavigationItem[];
};

export const DOMAIN_STUDIO_NAVIGATION: DomainStudioNavigationGroup[] = [
  {
    items: [
      { id: 'diagram', label: 'Model' },
      { id: 'skills', label: 'Skills' },
    ],
  },
];

const NAVIGATION_IDS = new Set(DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items.map((item) => item.id)));
const HIDDEN_SECTION_IDS = new Set<DomainStudioSection>([
  'terms', 'views', 'join-proofs', 'contracts', 'interfaces', 'evaluations',
  'notebooks', 'apps', 'dbt',
]);

export function isDomainStudioSection(value: string | null): value is DomainStudioSection {
  return value === 'ai' || (value !== null && (NAVIGATION_IDS.has(value as DomainStudioSection) || HIDDEN_SECTION_IDS.has(value as DomainStudioSection)));
}

export type EntityRecord = {
  recordKey: string;
  entity: ManifestModelEntity;
};

/**
 * Manifest maps are identity-bearing records. Never derive graph identity from
 * `entity.id`: local ids may repeat in different domains.
 */
export function entityRecords(modeling: Pick<ManifestDbtFirstModeling, 'entities'>): EntityRecord[] {
  return Object.entries(modeling.entities).map(([recordKey, entity]) => ({ recordKey, entity }));
}

/** Resolve a relationship endpoint while retaining v2-compatible local ids. */
export function resolveEntityRecordKey(
  modeling: Pick<ManifestDbtFirstModeling, 'entities'>,
  reference: string,
): string | undefined {
  if (modeling.entities[reference]) return reference;
  const matches = entityRecords(modeling).filter(({ entity }) => entity.id === reference || entity.qualifiedId === reference);
  return matches.length === 1 ? matches[0]!.recordKey : undefined;
}

export function domainEntityRecords(
  modeling: Pick<ManifestDbtFirstModeling, 'entities'>,
  domain: string | null,
): EntityRecord[] {
  return entityRecords(modeling).filter(({ entity }) => !domain || entity.domain === domain);
}
