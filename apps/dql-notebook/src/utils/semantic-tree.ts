import type { SemanticLayerState, SemanticTreeNode } from '../store/types';

type LayerItem = Record<string, any>;
type LeafKind = Extract<
  SemanticTreeNode['kind'],
  'metric' | 'measure' | 'dimension' | 'time_dimension' | 'entity' | 'hierarchy' | 'saved_query'
>;

const MODEL_COLLECTIONS: Array<{
  collection: 'metrics' | 'measures' | 'dimensions' | 'timeDimensions' | 'entities';
  kind: LeafKind;
  label: string;
}> = [
  { collection: 'metrics', kind: 'metric', label: 'Metrics' },
  { collection: 'dimensions', kind: 'dimension', label: 'Dimensions' },
  { collection: 'timeDimensions', kind: 'time_dimension', label: 'Time Dimensions' },
  { collection: 'entities', kind: 'entity', label: 'Entities' },
  { collection: 'measures', kind: 'measure', label: 'Underlying measures' },
];

function normalizedDomain(value: unknown): string {
  const domain = String(value ?? '').trim();
  return domain || 'uncategorized';
}

function modelOwners(item: LayerItem): string[] {
  const explicit = Array.isArray(item.semanticModelIds)
    ? item.semanticModelIds.map(String).filter(Boolean)
    : [];
  if (explicit.length > 0) return Array.from(new Set(explicit)).sort((a, b) => a.localeCompare(b));
  return item.cube ? [String(item.cube)] : [];
}

function itemReference(item: LayerItem, kind: LeafKind): string {
  return kind === 'dimension' || kind === 'time_dimension'
    ? String(item.reference || item.name)
    : String(item.name);
}

function toLeaf(item: LayerItem, kind: LeafKind, provider: string): SemanticTreeNode {
  const reference = itemReference(item, kind);
  const domain = normalizedDomain(item.domain);
  return {
    id: `${kind}:${reference}`,
    label: String(item.label || item.name),
    kind,
    meta: {
      provider,
      domain,
      localName: String(item.name),
      reference,
      ...(item.canonicalId ? { canonicalId: String(item.canonicalId) } : {}),
      ...(item.qualifiedName ? { qualifiedName: String(item.qualifiedName) } : {}),
      ...(item.entityLink ? { entityLink: String(item.entityLink) } : {}),
      ...(item.table ? { table: String(item.table) } : {}),
      ...(item.cube ? { cube: String(item.cube) } : {}),
      ...(modelOwners(item).length > 0 ? { semanticModelIds: modelOwners(item).join(',') } : {}),
      ...(item.owner ? { owner: String(item.owner) } : {}),
      ...(Array.isArray(item.tags) && item.tags.length > 0 ? { tags: item.tags.join(',') } : {}),
    },
  };
}

function groupNode(
  id: string,
  label: string,
  kind: LeafKind,
  items: LayerItem[],
  provider: string,
): SemanticTreeNode | null {
  if (items.length === 0) return null;
  const children = items
    .map((item) => toLeaf(item, kind, provider))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return {
    id,
    label,
    kind: 'group',
    count: children.length,
    meta: { provider, objectKind: kind },
    children,
  };
}

function leafCount(node: SemanticTreeNode): number {
  if (!node.children?.length) return 1;
  return node.children.reduce((sum, child) => sum + leafCount(child), 0);
}

/**
 * ID-001 / UI-009: render the semantic catalog by canonical semantic-model
 * ownership. Business metrics live under their model, technical measures are
 * explicitly subordinate, and cross-model or unresolved objects are labelled
 * instead of being mixed into one global "uncategorized" picker.
 */
export function buildSemanticTreeFromLayer(layer: SemanticLayerState): SemanticTreeNode | null {
  const provider = layer.provider ?? 'dql';
  const allItems = [
    ...layer.metrics,
    ...layer.measures,
    ...layer.dimensions,
    ...layer.timeDimensions,
    ...layer.entities,
    ...layer.hierarchies,
    ...layer.savedQueries,
  ] as LayerItem[];
  if (allItems.length === 0 && layer.semanticModels.length === 0) return null;

  const semanticModelsByName = new Map(layer.semanticModels.map((model) => [model.name, model]));
  const modelNames = new Set<string>(layer.semanticModels.map((model) => model.name));
  for (const item of allItems) for (const owner of modelOwners(item)) modelNames.add(owner);

  const modelDomain = (modelName: string): string => {
    const model = semanticModelsByName.get(modelName);
    if (model) return normalizedDomain(model.domain);
    const ownedItem = allItems.find((item) => modelOwners(item).includes(modelName));
    return normalizedDomain(ownedItem?.domain);
  };

  const domains = new Set<string>([
    ...layer.domains.map(normalizedDomain),
    ...layer.semanticModels.map((model) => normalizedDomain(model.domain)),
    ...allItems.map((item) => normalizedDomain(item.domain)),
  ]);

  const domainNodes = Array.from(domains)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((domain): SemanticTreeNode[] => {
      const domainModelNames = Array.from(modelNames)
        .filter((modelName) => modelDomain(modelName) === domain)
        .sort((left, right) => left.localeCompare(right));

      const modelNodes = domainModelNames.flatMap((modelName): SemanticTreeNode[] => {
        const model = semanticModelsByName.get(modelName);
        const children = MODEL_COLLECTIONS.flatMap(({ collection, kind, label }) => {
          const items = (layer[collection] as LayerItem[]).filter((item) => {
            const owners = modelOwners(item);
            return owners.length === 1
              && owners[0] === modelName
              && (collection !== 'dimensions' || !item.isTimeDimension);
          });
          const group = groupNode(
            `group:${domain}:${modelName}:${kind}`,
            label,
            kind,
            items,
            provider,
          );
          return group ? [group] : [];
        });
        if (children.length === 0 && !model) return [];
        const node: SemanticTreeNode = {
          id: `semantic_model:${modelName}`,
          label: model?.label || modelName,
          kind: 'semantic_model',
          count: children.reduce((sum, child) => sum + leafCount(child), 0),
          meta: {
            provider,
            domain,
            cube: modelName,
            ...(model?.table ? { table: model.table } : {}),
            ...(model?.owner ? { owner: model.owner } : {}),
          },
          children,
        };
        return [node];
      });

      const crossModelMetrics = layer.metrics.filter((metric) =>
        normalizedDomain(metric.domain) === domain && modelOwners(metric).length > 1);
      const unassignedMetrics = layer.metrics.filter((metric) =>
        normalizedDomain(metric.domain) === domain && modelOwners(metric).length === 0);

      const unassignedObjects = [
        groupNode(
          `group:${domain}:unassigned-dimensions`,
          'Dimensions',
          'dimension',
          layer.dimensions.filter((item) =>
            normalizedDomain(item.domain) === domain
            && modelOwners(item).length === 0
            && !item.isTimeDimension),
          provider,
        ),
        groupNode(
          `group:${domain}:unassigned-time-dimensions`,
          'Time Dimensions',
          'time_dimension',
          layer.timeDimensions.filter((item) => normalizedDomain(item.domain) === domain && modelOwners(item).length === 0),
          provider,
        ),
        groupNode(
          `group:${domain}:unassigned-measures`,
          'Underlying measures',
          'measure',
          layer.measures.filter((item) => normalizedDomain(item.domain) === domain && modelOwners(item).length === 0),
          provider,
        ),
        groupNode(
          `group:${domain}:unassigned-entities`,
          'Entities',
          'entity',
          layer.entities.filter((item) => normalizedDomain(item.domain) === domain && modelOwners(item).length === 0),
          provider,
        ),
      ].filter((node): node is SemanticTreeNode => Boolean(node));

      const domainChildren: SemanticTreeNode[] = [...modelNodes];
      const crossGroup = groupNode(
        `group:${domain}:cross-model-metrics`,
        'Cross-model metrics',
        'metric',
        crossModelMetrics,
        provider,
      );
      if (crossGroup) domainChildren.push(crossGroup);
      const unresolvedGroup = groupNode(
        `group:${domain}:unassigned-metrics`,
        'Unassigned metrics',
        'metric',
        unassignedMetrics,
        provider,
      );
      if (unresolvedGroup) domainChildren.push(unresolvedGroup);
      if (unassignedObjects.length > 0) {
        domainChildren.push({
          id: `group:${domain}:unassigned-objects`,
          label: 'Unassigned objects',
          kind: 'group',
          count: unassignedObjects.reduce((sum, node) => sum + leafCount(node), 0),
          meta: { provider, domain },
          children: unassignedObjects,
        });
      }

      const hierarchyGroup = groupNode(
        `group:${domain}:hierarchies`,
        'Hierarchies',
        'hierarchy',
        layer.hierarchies.filter((item) => normalizedDomain(item.domain) === domain),
        provider,
      );
      if (hierarchyGroup) domainChildren.push(hierarchyGroup);
      const savedQueryGroup = groupNode(
        `group:${domain}:saved-queries`,
        'Saved Queries',
        'saved_query',
        layer.savedQueries.filter((item) => normalizedDomain(item.domain) === domain),
        provider,
      );
      if (savedQueryGroup) domainChildren.push(savedQueryGroup);

      if (domainChildren.length === 0) return [];
      return [{
        id: `domain:${provider}:${domain}`,
        label: domain,
        kind: 'domain',
        count: domainChildren.reduce((sum, child) => sum + leafCount(child), 0),
        meta: { provider, domain },
        children: domainChildren,
      }];
    });

  if (domainNodes.length === 0) return null;
  // A missing business domain is not an information architecture. Promote its
  // semantic-model folders to the provider level and leave only explicitly
  // labelled "Unassigned" groups for objects whose ownership is genuinely
  // unresolved.
  const providerChildren = domainNodes.flatMap((domain) =>
    domain.label === 'uncategorized' ? domain.children ?? [] : [domain]);
  return {
    id: 'root:semantic',
    label: 'Semantic Layer',
    kind: 'group',
    children: [{
      id: `provider:${provider}`,
      label: provider.toUpperCase(),
      kind: 'provider',
      count: providerChildren.reduce((sum, child) => sum + leafCount(child), 0),
      meta: { provider },
      children: providerChildren,
    }],
  };
}

export type SemanticCompositionScopeState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * UI-009: a metric-first composition projection of the canonical tree. Before
 * selection it contains only executable business metrics; afterwards it adds
 * only the exact model-qualified dimensions returned by the compatibility
 * service. Technical measures and unrelated semantic objects never become
 * accidental query inputs.
 */
export function scopeSemanticTreeForComposition(
  tree: SemanticTreeNode,
  selectedMetricCount: number,
  compatibleDimensionReferences: ReadonlySet<string> | null,
  compatibilityState: SemanticCompositionScopeState,
): SemanticTreeNode {
  const keep = (node: SemanticTreeNode): SemanticTreeNode | null => {
    if (!node.children?.length) {
      if (node.kind === 'metric') return { ...node };
      if (node.kind === 'dimension' || node.kind === 'time_dimension') {
        if (selectedMetricCount === 0 || compatibilityState !== 'ready' || !compatibleDimensionReferences) return null;
        const reference = String(node.meta?.reference || node.id.slice(node.id.indexOf(':') + 1));
        return compatibleDimensionReferences.has(reference) ? { ...node } : null;
      }
      return null;
    }
    const children = node.children.map(keep).filter((child): child is SemanticTreeNode => Boolean(child));
    if (children.length === 0) return null;
    return {
      ...node,
      count: children.reduce((sum, child) => sum + leafCount(child), 0),
      children,
    };
  };
  return keep(tree) ?? { ...tree, children: [] };
}
