import type { SemanticLayerState, SemanticTreeNode } from '../store/types';

type SemanticCollectionKey =
  | 'metrics'
  | 'measures'
  | 'dimensions'
  | 'timeDimensions'
  | 'entities'
  | 'hierarchies'
  | 'semanticModels'
  | 'savedQueries';

const GROUPS: Array<{
  collection: SemanticCollectionKey;
  kind: SemanticTreeNode['kind'];
  label: string;
}> = [
  { collection: 'metrics', kind: 'metric', label: 'Metrics' },
  { collection: 'measures', kind: 'measure', label: 'Measures' },
  { collection: 'dimensions', kind: 'dimension', label: 'Dimensions' },
  { collection: 'timeDimensions', kind: 'time_dimension', label: 'Time Dimensions' },
  { collection: 'entities', kind: 'entity', label: 'Entities' },
  { collection: 'hierarchies', kind: 'hierarchy', label: 'Hierarchies' },
  { collection: 'semanticModels', kind: 'semantic_model', label: 'Semantic Models' },
  { collection: 'savedQueries', kind: 'saved_query', label: 'Saved Queries' },
];

/**
 * PERF-001: render the semantic explorer from the canonical layer response.
 * This avoids downloading and parsing a second tree-shaped copy of thousands
 * of metrics solely for sidebar presentation.
 */
export function buildSemanticTreeFromLayer(layer: SemanticLayerState): SemanticTreeNode | null {
  const provider = layer.provider ?? 'dql';
  const domains = new Map<string, Map<string, SemanticTreeNode[]>>();

  for (const group of GROUPS) {
    for (const item of layer[group.collection] as Array<Record<string, any>>) {
      const domain = String(item.domain || 'uncategorized');
      const domainGroups = domains.get(domain) ?? new Map<string, SemanticTreeNode[]>();
      const entries = domainGroups.get(group.label) ?? [];
      entries.push({
        id: `${group.kind}:${item.name}`,
        label: String(item.label || item.name),
        kind: group.kind,
        meta: {
          provider,
          domain,
          ...(item.table ? { table: String(item.table) } : {}),
          ...(item.cube ? { cube: String(item.cube) } : {}),
          ...(item.owner ? { owner: String(item.owner) } : {}),
          ...(Array.isArray(item.tags) && item.tags.length > 0 ? { tags: item.tags.join(',') } : {}),
        },
      });
      domainGroups.set(group.label, entries);
      domains.set(domain, domainGroups);
    }
  }

  if (domains.size === 0) return null;

  const domainNodes = [...domains.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, domainGroups]) => ({
      id: `domain:${provider}:${domain}`,
      label: domain,
      kind: 'domain' as const,
      count: [...domainGroups.values()].reduce((sum, items) => sum + items.length, 0),
      meta: { provider, domain },
      children: GROUPS.flatMap((group) => {
        const items = domainGroups.get(group.label);
        if (!items?.length) return [];
        return [{
          id: `group:${domain}:${group.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          label: group.label,
          kind: 'group' as const,
          count: items.length,
          meta: { provider, domain, objectKind: group.kind },
          children: items.sort((left, right) => left.label.localeCompare(right.label)),
        }];
      }),
    }));

  return {
    id: 'root:semantic',
    label: 'Semantic Layer',
    kind: 'group',
    children: [{
      id: `provider:${provider}`,
      label: provider.toUpperCase(),
      kind: 'provider',
      count: domainNodes.length,
      meta: { provider },
      children: domainNodes,
    }],
  };
}
