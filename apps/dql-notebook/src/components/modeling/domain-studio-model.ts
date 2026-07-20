import type { ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';

export type DomainStudioSection =
  | 'overview'
  | 'diagram'
  | 'knowledge'
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
      { id: 'knowledge', label: 'Knowledge 360' },
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

export type DomainPackageTreeRecord = {
  id: string;
  parent?: string;
  depth: number;
  label: string;
};

export function domainStudioLocationHref(
  href: string,
  location: { domain: string | null; section: DomainStudioSection; modelAreaId?: string | null; selectedId?: string | null },
): string {
  const url = new URL(href);
  if (location.domain) url.searchParams.set('domain', location.domain);
  else url.searchParams.delete('domain');
  url.searchParams.set('domainSection', location.section);
  if (location.modelAreaId) url.searchParams.set('modelArea', location.modelAreaId);
  else url.searchParams.delete('modelArea');
  if (location.selectedId) url.searchParams.set('domainObject', location.selectedId);
  else url.searchParams.delete('domainObject');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Stable parent-first ordering for the Domain Studio selector and breadcrumbs. */
export function domainPackageTree(
  packages: Pick<ManifestDbtFirstModeling, 'packages'>['packages'],
): DomainPackageTreeRecord[] {
  const values = Object.values(packages);
  const children = new Map<string | undefined, typeof values>();
  for (const pkg of values) {
    const parent = pkg.parent && packages[pkg.parent] ? pkg.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), pkg]);
  }
  for (const entries of children.values()) entries.sort((a, b) => a.id.localeCompare(b.id));
  const output: DomainPackageTreeRecord[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | undefined, depth: number) => {
    for (const pkg of children.get(parent) ?? []) {
      if (visited.has(pkg.id)) continue;
      visited.add(pkg.id);
      output.push({
        id: pkg.id,
        parent: pkg.parent,
        depth,
        label: depth === 0 ? pkg.id : `${'— '.repeat(depth)}${pkg.id.split('.').at(-1) ?? pkg.id}`,
      });
      visit(pkg.id, depth + 1);
    }
  };
  visit(undefined, 0);
  for (const pkg of values.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!visited.has(pkg.id)) output.push({ id: pkg.id, parent: pkg.parent, depth: 0, label: pkg.id });
  }
  return output;
}

/**
 * Prototype kind color for a business/data entity card: dimensions are green,
 * event/snapshot (fact-like) are accent purple, bridges warning, unknown grey.
 * The manifest role vocabulary is event | dimension | snapshot | bridge.
 */
export function entityKindColor(role: string | null | undefined): string {
  const value = (role ?? '').toLowerCase();
  if (value === 'dimension') return 'var(--status-success)';
  if (value === 'bridge') return 'var(--status-warning)';
  if (value === 'event' || value === 'snapshot') return 'var(--accent)';
  return 'var(--text-tertiary)';
}

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
