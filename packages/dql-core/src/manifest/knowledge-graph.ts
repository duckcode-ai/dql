import { createHash } from 'node:crypto';
import type {
  DQLManifest,
  ManifestCrossDomainRoute,
  ManifestDiagnostic,
  ManifestDomainCapsule,
  ManifestKnowledgeEdge,
  ManifestKnowledgeEdgeKind,
  ManifestKnowledgeGraph,
  ManifestKnowledgeObject,
  ManifestKnowledgeObjectKind,
  ManifestKnowledgeRouteState,
} from './types.js';
import type { ManifestKnowledgeSkillDescriptor } from './knowledge-skills.js';
import type { ManifestBlock } from './types.js';

export interface BuildManifestKnowledgeGraphInput {
  manifest: Omit<DQLManifest, 'knowledgeGraph'>;
  skills: ManifestKnowledgeSkillDescriptor[];
  /** Full qualified scan, including same local block names in other domains. */
  blocks?: ManifestBlock[];
}

export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 4;

/** Build the single qualified policy graph after every source object resolves. */
export function buildManifestKnowledgeGraph(input: BuildManifestKnowledgeGraphInput): ManifestKnowledgeGraph {
  const { manifest, skills } = input;
  const knowledgeBlocks = input.blocks ?? Object.values(manifest.blocks);
  const diagnostics: ManifestDiagnostic[] = [];
  const objects: Record<string, ManifestKnowledgeObject> = {};
  const edges: ManifestKnowledgeEdge[] = [];
  const edgeKeys = new Set<string>();
  const domainAliases = buildDomainAliases(manifest);
  const canonicalDomain = (value: string | undefined) => value ? domainAliases.get(value.toLowerCase()) ?? value : undefined;
  const qualified = (kind: ManifestKnowledgeObjectKind, localId: string, domain?: string) => `${domain ?? 'global'}::${kind}::${localId}`;

  const addObject = (object: ManifestKnowledgeObject) => {
    const existing = objects[object.id];
    if (existing && stable(existing) !== stable(object)) {
      diagnostics.push({ kind: 'resolve', filePath: object.source.path, severity: 'error', message: `Knowledge object identity collision for "${object.id}".` });
      return;
    }
    objects[object.id] = object;
  };
  const addEdge = (
    kind: ManifestKnowledgeEdgeKind,
    from: string,
    to: string,
    extra: Omit<ManifestKnowledgeEdge, 'id' | 'kind' | 'from' | 'to' | 'fingerprint'> = {},
  ) => {
    const key = `${kind}:${from}:${to}:${stable(extra)}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const fingerprint = digest(key);
    edges.push({ id: `edge::${fingerprint.slice(0, 20)}`, kind, from, to, ...extra, fingerprint });
  };

  for (const [key, domain] of Object.entries(manifest.domains ?? {})) {
    const domainId = domain.id ?? key;
    addObject(object('domain', `domain::${domainId}`, domainId, domain.filePath, {
      domainId,
      owner: domain.owner,
      aliases: unique([domain.name, key, domainId]),
      payload: {
        name: domain.name,
        parent: domain.parent,
        boundedContext: domain.boundedContext,
        description: domain.description,
        inScope: domain.inScope ?? [],
        outOfScope: domain.outOfScope ?? [],
        sourceSystems: domain.sourceSystems ?? [],
        primaryTerms: domain.primaryTerms ?? [],
      },
    }));
    if (domain.parent) addEdge('parent_domain', `domain::${canonicalDomain(domain.parent)}`, `domain::${domainId}`);
  }

  for (const area of Object.values(manifest.modeling?.areas ?? {})) {
    addObject(object('model_area', area.qualifiedId, area.localId, area.sourcePath, {
      domainId: area.domain,
      aliases: unique([area.name, area.localId, area.qualifiedId]),
      payload: { description: area.description, intentExamples: area.intentExamples, referencedEntityIds: area.referencedEntityIds },
    }));
    addEdge('contains', `domain::${area.domain}`, area.qualifiedId);
  }

  const blockIds = new Map<string, string[]>();
  for (const block of knowledgeBlocks) {
    const domainId = canonicalDomain(block.domain);
    const id = qualified('block', block.name, domainId);
    addLookup(blockIds, block.name, id, domainId);
    addObject(object('block', id, block.name, block.filePath, {
      domainId,
      owner: block.owner,
      status: block.status,
      aliases: unique([block.name, block.description ?? '']),
      payload: {
        description: block.description,
        grain: block.grain,
        entities: block.entities ?? [],
        metricRefs: unique([...(block.metricsRef ?? []), ...(block.metricRef ? [block.metricRef] : []), ...(block.metricRefs ?? [])]),
        dimensions: block.dimensions ?? [],
        allowedFilters: block.allowedFilters ?? [],
        declaredOutputs: block.declaredOutputs ?? [],
        outputContract: block.outputContract ?? [],
        dataState: block.dataState,
      },
    }));
    if (domainId) addEdge('contains', `domain::${domainId}`, id);
  }

  const termIds = new Map<string, string[]>();
  for (const term of Object.values(manifest.terms ?? {})) {
    const domainId = canonicalDomain(term.domain);
    const id = qualified('term', term.name, domainId);
    addLookup(termIds, term.name, id, domainId);
    addObject(object('term', id, term.name, term.filePath, {
      domainId,
      owner: term.owner,
      status: term.status,
      aliases: unique([term.name, ...(term.identifiers ?? []), ...(term.synonyms ?? [])]),
      payload: { description: term.description, businessRules: term.businessRules ?? [], caveats: term.caveats ?? [] },
    }));
    if (domainId) addEdge('contains', `domain::${domainId}`, id);
  }

  const viewIds = new Map<string, string[]>();
  for (const view of Object.values(manifest.businessViews ?? {})) {
    const domainId = canonicalDomain(view.domain);
    const id = qualified('business_view', view.name, domainId);
    addLookup(viewIds, view.name, id, domainId);
    addObject(object('business_view', id, view.name, view.filePath, {
      domainId,
      owner: view.owner,
      status: view.status,
      aliases: unique([view.name, view.description ?? '']),
      payload: { description: view.description, caveats: view.caveats ?? [] },
    }));
    if (domainId) addEdge('contains', `domain::${domainId}`, id);
  }

  const metricIds = new Map<string, string[]>();
  for (const metric of Object.values(manifest.metrics ?? {})) {
    const domainId = canonicalDomain(metric.domain);
    const id = qualified('metric', metric.name, domainId);
    addLookup(metricIds, metric.name, id, domainId);
    addObject(object('metric', id, metric.name, metric.filePath, {
      domainId,
      owner: metric.owner,
      status: metric.status,
      aliases: unique([metric.name, metric.label ?? '', metric.description ?? '']),
      sourceSystem: 'semantic',
      payload: { description: metric.description, type: metric.type, table: metric.table },
    }));
    if (domainId) addEdge('contains', `domain::${domainId}`, id);
  }

  const dimensionIds = new Map<string, string[]>();
  for (const dimension of Object.values(manifest.dimensions ?? {})) {
    const domainId = canonicalDomain(dimension.domain);
    const id = qualified('dimension', dimension.name, domainId);
    addLookup(dimensionIds, dimension.name, id, domainId);
    addObject(object('dimension', id, dimension.name, dimension.filePath, {
      domainId,
      owner: dimension.owner,
      status: dimension.status,
      aliases: unique([dimension.name, dimension.label ?? '', dimension.description ?? '']),
      sourceSystem: 'semantic',
      payload: { description: dimension.description, type: dimension.type, table: dimension.table },
    }));
    if (domainId) addEdge('contains', `domain::${domainId}`, id);
  }

  for (const source of Object.values(manifest.sources ?? {})) {
    const nativeId = source.dbtModel?.uniqueId;
    const kind: ManifestKnowledgeObjectKind = nativeId?.startsWith('source.') ? 'dbt_source' : nativeId ? 'dbt_model' : 'source_table';
    const id = nativeId ? `dbt::${nativeId}` : `source::${source.name.toLowerCase()}`;
    addObject(object(kind, id, source.name, undefined, {
      sourceSystem: source.origin === 'dbt' ? 'dbt' : 'dql',
      nativeId,
      aliases: [source.name],
      payload: { origin: source.origin, referencedBy: source.referencedBy },
    }));
  }
  for (const node of Object.values(manifest.dbtProvenance?.nodes ?? {})) {
    const id = `dbt::${node.uniqueId}`;
    addObject(object(node.resourceType === 'source' ? 'dbt_source' : 'dbt_model', id, node.name, node.sourcePath, {
      sourceSystem: 'dbt',
      nativeId: node.uniqueId,
      sourceFingerprint: node.identityFingerprint,
      aliases: unique([node.name, node.relation ?? '', node.uniqueId]),
      payload: { packageName: node.packageName, relation: node.relation, available: node.available },
    }));
  }
  for (const metric of Object.values(manifest.dbtProvenance?.metricFlow ?? {})) {
    const id = `semantic::${metric.uniqueId}`;
    addObject(object('metric', id, metric.name, metric.sourcePath, {
      sourceSystem: 'semantic',
      nativeId: metric.uniqueId,
      sourceFingerprint: metric.fingerprint,
      aliases: unique([metric.name, metric.uniqueId]),
      payload: { semanticModel: metric.semanticModel },
    }));
  }

  const entityIds = new Map<string, string[]>();
  for (const entity of Object.values(manifest.modeling?.entities ?? {})) {
    const id = entity.qualifiedId;
    addLookup(entityIds, entity.localId, id, entity.domain);
    addLookup(entityIds, entity.id, id, entity.domain);
    addObject(object('entity', id, entity.localId, entity.sourcePath, {
      domainId: entity.domain,
      owner: entity.owner,
      status: entity.status,
      modelAreaIds: entity.areaId ? [entity.areaId] : [],
      aliases: unique([entity.localId, entity.businessName ?? '', entity.dbtUniqueId]),
      sourceFingerprint: entity.identityFingerprint,
      payload: { businessName: entity.businessName, businessContext: entity.businessContext, grain: entity.grain, keys: entity.keys, analyticalRole: entity.analyticalRole, dbtUniqueId: entity.dbtUniqueId },
    }));
    addEdge('contains', `domain::${entity.domain}`, id);
    if (entity.areaId) addEdge('contains', entity.areaId, id);
    addEdge('binds_to', id, `dbt::${entity.dbtUniqueId}`);
  }

  const relationshipIds = new Map<string, string[]>();
  for (const relationship of Object.values(manifest.modeling?.relationships ?? {})) {
    const id = relationship.qualifiedId;
    addLookup(relationshipIds, relationship.localId, id, relationship.ownerDomain);
    addLookup(relationshipIds, relationship.id, id, relationship.ownerDomain);
    const fromId = resolveModelEntity(manifest, relationship.from);
    const toId = resolveModelEntity(manifest, relationship.to);
    const fromDomain = modelEntity(manifest, relationship.from)?.domain;
    const toDomain = modelEntity(manifest, relationship.to)?.domain;
    const state: ManifestKnowledgeRouteState = relationship.staleCertification
      ? 'stale'
      : relationship.automaticJoinAllowed
        ? 'authorized'
        : 'blocked';
    addObject(object('relationship', id, relationship.localId, relationship.sourcePath, {
      domainId: relationship.ownerDomain,
      owner: relationship.owner,
      status: relationship.staleCertification ? 'stale' : relationship.status,
      modelAreaIds: relationship.areaId ? [relationship.areaId] : [],
      sourceFingerprint: relationship.fingerprint,
      aliases: unique([relationship.localId, relationship.verb ?? '', relationship.description ?? '']),
      payload: { ...relationship },
    }));
    addEdge('proves_join', fromId, id, { state, domainPair: pair(fromDomain, toDomain), evidenceRefs: relationship.validation ? [relationship.certificationFingerprint ?? relationship.fingerprint] : [], reasonCodes: relationshipReasonCodes(relationship) });
    addEdge('proves_join', id, toId, { state, domainPair: pair(fromDomain, toDomain), evidenceRefs: relationship.validation ? [relationship.certificationFingerprint ?? relationship.fingerprint] : [], reasonCodes: relationshipReasonCodes(relationship) });
    if (relationship.areaId) addEdge('contains', relationship.areaId, id);
  }

  const contractIds = new Map<string, string[]>();
  for (const contract of Object.values(manifest.modeling?.contracts ?? {})) {
    const id = contract.qualifiedId;
    addLookup(contractIds, contract.localId, id, contract.domain);
    addLookup(contractIds, contract.id, id, contract.domain);
    addObject(object('contract', id, contract.localId, contract.sourcePath, {
      domainId: contract.domain,
      owner: contract.owner,
      status: contract.status,
      payload: { ...contract },
    }));
    addEdge('contains', `domain::${contract.domain}`, id);
    for (const entity of contract.entities) addEdge('governed_by', resolveModelEntity(manifest, entity), id);
    for (const block of contract.blocks) for (const blockId of lookup(blockIds, block, contract.domain)) addEdge('governed_by', blockId, id);
  }

  const exportObjects = new Map<string, string>();
  for (const [key, exported] of Object.entries(manifest.modeling?.interfaces?.exports ?? {})) {
    const id = exported.qualifiedId;
    addObject(object('domain_export', id, exported.localId, exported.sourcePath, { domainId: exported.domain, owner: exported.owner, status: exported.status, sourceFingerprint: exported.fingerprint, payload: { ...exported } }));
    addEdge('exports', `domain::${exported.domain}`, id);
    if (exported.entity) addEdge('exports', resolveModelEntity(manifest, exported.entity), id);
    for (const alias of exportAliases(key, exported)) exportObjects.set(alias, id);
  }

  const importObjects = new Map<string, string>();
  for (const [key, imported] of Object.entries(manifest.modeling?.interfaces?.imports ?? {})) {
    const id = imported.qualifiedId;
    addObject(object('domain_import', id, imported.localId, imported.sourcePath, { domainId: imported.domain, owner: imported.owner, status: imported.status, payload: { ...imported } }));
    addEdge('imports', `domain::${imported.domain}`, id);
    const exported = exportObjects.get(imported.exportRef);
    if (exported) addEdge('imports', exported, id);
    for (const alias of unique([key, imported.id, imported.localId, imported.qualifiedId])) importObjects.set(alias, id);
  }

  for (const declaration of Object.values(manifest.modeling?.conformance ?? {})) {
    addObject(object('conformance', declaration.qualifiedId, declaration.localId, declaration.sourcePath, { domainId: declaration.domain, payload: { ...declaration } }));
    addEdge('contains', `domain::${declaration.domain}`, declaration.qualifiedId);
    for (const entity of declaration.entities) addEdge('conforms_to', resolveModelEntity(manifest, entity), declaration.qualifiedId);
  }
  for (const rule of Object.values(manifest.modeling?.rules ?? {})) {
    addObject(object('policy', rule.qualifiedId, rule.localId, rule.sourcePath, { domainId: rule.domain, payload: { ...rule } }));
    addEdge('contains', `domain::${rule.domain}`, rule.qualifiedId);
  }

  for (const skill of skills) {
    addObject(object('skill', skill.qualifiedId, skill.localId, skill.sourcePath, {
      domainId: skill.domain,
      owner: skill.owner,
      status: skill.status,
      modelAreaIds: skill.modelAreaRefs,
      sourceFingerprint: skill.contentHash,
      aliases: unique([skill.localId, skill.description ?? '', ...skill.triggers, ...Object.keys(skill.vocabulary)]),
      payload: { ...skill },
    }));
    for (const domain of skill.domains) addEdge('contains', `domain::${domain}`, skill.qualifiedId);
    for (const area of skill.modelAreaRefs) addEdge('contains', area, skill.qualifiedId);
  }

  for (const [path, notebook] of Object.entries(manifest.notebooks ?? {})) {
    const id = `global::notebook::${path}`;
    addObject(object('notebook', id, path, notebook.filePath, { domainId: canonicalDomain(notebook.ownerDomain), aliases: [notebook.title, path], payload: { title: notebook.title, ...productPayload(notebook) } }));
    connectProduct(id, notebook, canonicalDomain, addEdge);
  }
  for (const app of Object.values(manifest.apps ?? {})) {
    const id = `global::app::${app.id}`;
    addObject(object('app', id, app.id, app.filePath, { domainId: canonicalDomain(app.ownerDomain ?? app.domain), owner: app.owners[0], status: app.lifecycle, aliases: [app.id, app.name], payload: { name: app.name, ...productPayload(app) } }));
    connectProduct(id, app, canonicalDomain, addEdge);
  }
  for (const dashboard of Object.values(manifest.dashboards ?? {})) {
    const id = `global::dashboard::${dashboard.qualifiedId}`;
    const domainId = canonicalDomain(dashboard.domain);
    addObject(object('dashboard', id, dashboard.qualifiedId, dashboard.filePath, { domainId, aliases: [dashboard.id, dashboard.qualifiedId, dashboard.title], payload: { title: dashboard.title, appId: dashboard.appId } }));
    if (domainId) addEdge('consumed_by', `domain::${domainId}`, id);
    addEdge('contains', `global::app::${dashboard.appId}`, id);
  }

  // Resolve the free references only after every potential target exists.
  for (const block of knowledgeBlocks) {
    const domainId = canonicalDomain(block.domain);
    const id = qualified('block', block.name, domainId);
    for (const term of block.termRefs ?? []) for (const target of lookup(termIds, term, domainId)) addEdge('defines', target, id);
    for (const metric of unique([...(block.metricsRef ?? []), ...(block.metricRef ? [block.metricRef] : []), ...(block.metricRefs ?? [])])) for (const target of lookup(metricIds, metric, domainId)) addEdge('implements', id, target);
    for (const entity of block.entities ?? []) for (const target of lookup(entityIds, entity, domainId)) addEdge('implements', id, target);
    for (const ref of block.refDependencies ?? []) for (const target of lookup(blockIds, ref, domainId)) addEdge('depends_on', target, id);
    for (const table of block.tableDependencies ?? []) {
      const target = sourceObjectId(manifest, table);
      if (target) addEdge('reads_from', target, id);
    }
  }
  for (const view of Object.values(manifest.businessViews ?? {})) {
    const domainId = canonicalDomain(view.domain);
    const id = qualified('business_view', view.name, domainId);
    for (const term of view.termRefs ?? []) for (const target of lookup(termIds, term, domainId)) addEdge('defines', target, id);
    for (const block of view.blockRefs ?? []) for (const target of lookup(blockIds, block, domainId)) addEdge('implements', target, id);
    for (const child of view.businessViewRefs ?? []) for (const target of lookup(viewIds, child, domainId)) addEdge('implements', target, id);
  }
  for (const skill of skills) {
    for (const ref of skill.preferredMetrics) for (const target of lookup(metricIds, ref, skill.domain)) addEdge('guided_by', target, skill.qualifiedId);
    for (const ref of skill.preferredBlocks) for (const target of lookup(blockIds, ref, skill.domain)) addEdge('guided_by', target, skill.qualifiedId);
    for (const ref of skill.preferredDimensions) for (const target of lookup(dimensionIds, ref, skill.domain)) addEdge('guided_by', target, skill.qualifiedId);
  }

  // Preserve dbt transformation flow as observed context, never join proof.
  for (const edge of manifest.lineage.edges) {
    if (edge.type !== 'depends_on') continue;
    const from = lineageObjectId(edge.source, objects);
    const to = lineageObjectId(edge.target, objects);
    if (from && to) addEdge('transforms', from, to, { state: 'observed', domainPair: pair(canonicalDomain(edge.sourceDomain), canonicalDomain(edge.targetDomain)) });
  }

  const crossDomainRoutes = buildCrossDomainRoutes(manifest, exportObjects, importObjects, contractIds, canonicalDomain);
  const routePairs = new Set(crossDomainRoutes.map((route) => `${route.providerDomainId}:${route.consumerDomainId}`));
  for (const flow of manifest.lineage.crossDomainFlows) {
    const providerDomainId = canonicalDomain(flow.from) ?? flow.from;
    const consumerDomainId = canonicalDomain(flow.to) ?? flow.to;
    if (routePairs.has(`${providerDomainId}:${consumerDomainId}`)) continue;
    const key = `observed:${providerDomainId}:${consumerDomainId}`;
    crossDomainRoutes.push({ id: `route::${digest(key).slice(0, 20)}`, providerDomainId, consumerDomainId, purpose: '', relationshipId: `observed::${providerDomainId}::${consumerDomainId}`, state: 'observed', reasonCodes: ['OBSERVED_DEPENDENCY_ONLY'], path: [`domain::${providerDomainId}`, `domain::${consumerDomainId}`], fingerprint: digest(key) });
  }

  const domainCapsules = buildDomainCapsules(manifest, skills, crossDomainRoutes, canonicalDomain, qualified, knowledgeBlocks);
  edges.sort(edgeSort);
  crossDomainRoutes.sort((a, b) => a.id.localeCompare(b.id));
  const graphContent = { schemaVersion: 1 as const, objects: sortRecord(objects), edges, domainCapsules, crossDomainRoutes };
  return { ...graphContent, schemaVersion: 1, storageMode: 'inline', sourceFingerprint: digest(stable(graphContent)), diagnostics };
}

/** Compact control-plane projection; detailed rows live in metadata.sqlite. */
export function compactManifestKnowledgeGraph(graph: ManifestKnowledgeGraph): ManifestKnowledgeGraph {
  const objects = Object.values(graph.objects ?? {});
  const edges = graph.edges ?? [];
  const domainIds = [...new Set(objects.flatMap((item) => item.domainId ? [item.domainId] : []))].sort();
  const shards = ['global', ...domainIds].map((domainId) => {
    const shardObjects = objects.filter((item) => domainId === 'global' ? !item.domainId : item.domainId === domainId);
    const ids = new Set(shardObjects.map((item) => item.id));
    const shardEdges = edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to));
    const content = {
      domainId: domainId === 'global' ? undefined : domainId,
      objectIds: shardObjects.map((item) => item.id).sort(),
      edgeIds: shardEdges.map((item) => item.id).sort(),
    };
    return {
      id: domainId === 'global' ? 'global' : `domain:${domainId}`,
      domainId: content.domainId,
      fingerprint: digest(stable(content)),
      objectCount: shardObjects.length,
      edgeCount: shardEdges.length,
    };
  });
  return {
    schemaVersion: 2,
    storageMode: 'indexed',
    sourceFingerprint: graph.sourceFingerprint,
    counts: {
      objects: objects.length,
      edges: edges.length,
      skills: objects.filter((item) => item.kind === 'skill').length,
      routes: graph.crossDomainRoutes.length,
    },
    shards,
    index: { schemaVersion: KNOWLEDGE_INDEX_SCHEMA_VERSION, fingerprint: graph.sourceFingerprint },
    objectRefs: objects.map(({ id, kind, localId, domainId, modelAreaIds, status, owner, source }) => ({
      id, kind, localId, domainId, modelAreaIds, status, owner, source,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    domainCapsules: graph.domainCapsules,
    crossDomainRoutes: graph.crossDomainRoutes,
    diagnostics: graph.diagnostics,
  };
}

function object(
  kind: ManifestKnowledgeObjectKind,
  id: string,
  localId: string,
  sourcePath: string | undefined,
  options: {
    domainId?: string;
    modelAreaIds?: string[];
    aliases?: string[];
    status?: string;
    owner?: string;
    sourceSystem?: 'dql' | 'dbt' | 'semantic';
    nativeId?: string;
    sourceFingerprint?: string;
    payload?: Record<string, unknown>;
  } = {},
): ManifestKnowledgeObject {
  const source = { system: options.sourceSystem ?? 'dql', path: sourcePath, nativeId: options.nativeId, fingerprint: options.sourceFingerprint ?? digest(stable({ kind, id, sourcePath, payload: options.payload })) };
  return { id, kind, localId, domainId: options.domainId, modelAreaIds: options.modelAreaIds?.length ? unique(options.modelAreaIds) : undefined, aliases: options.aliases?.length ? unique(options.aliases.filter(Boolean)) : undefined, status: options.status, owner: options.owner, source, payload: options.payload };
}

function buildDomainAliases(manifest: Omit<DQLManifest, 'knowledgeGraph'>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [key, domain] of Object.entries(manifest.domains ?? {})) {
    const id = domain.id ?? key;
    for (const alias of unique([key, id, domain.name])) aliases.set(alias.toLowerCase(), id);
  }
  for (const pkg of Object.values(manifest.modeling?.packages ?? {})) aliases.set(pkg.id.toLowerCase(), pkg.id);
  return aliases;
}

function buildCrossDomainRoutes(
  manifest: Omit<DQLManifest, 'knowledgeGraph'>,
  exportObjects: Map<string, string>,
  importObjects: Map<string, string>,
  contractIds: Map<string, string[]>,
  canonicalDomain: (value: string | undefined) => string | undefined,
): ManifestCrossDomainRoute[] {
  const routes: ManifestCrossDomainRoute[] = [];
  const exports = Object.entries(manifest.modeling?.interfaces?.exports ?? {});
  const imports = Object.entries(manifest.modeling?.interfaces?.imports ?? {});
  for (const relationship of Object.values(manifest.modeling?.relationships ?? {})) {
    if (!relationship.crossDomain) continue;
    const fromDomain = modelEntity(manifest, relationship.from)?.domain;
    const toDomain = modelEntity(manifest, relationship.to)?.domain;
    const matchingImports = imports.filter(([key, imported]) => {
      // Relationship declarations normally cite the exported interface
      // (`commerce.customer_identity@1`), while the consumer import has its own
      // local identity. Both are valid references to the same governed hop.
      const aliases = unique([key, imported.id, imported.localId, imported.qualifiedId, imported.exportRef]);
      return relationship.importRefs?.length ? relationship.importRefs.some((ref) => aliases.includes(ref)) : imported.domain === fromDomain || imported.domain === toDomain;
    });
    if (matchingImports.length === 0) {
      routes.push(routeRecord(relationship.qualifiedId, fromDomain ?? '', toDomain ?? '', '', relationship, undefined, undefined, undefined, ['MISSING_IMPORT']));
      continue;
    }
    for (const [importKey, imported] of matchingImports) {
      const exportEntry = exports.find(([key, exported]) => exportAliases(key, exported).includes(imported.exportRef));
      const exported = exportEntry?.[1];
      const providerDomainId = canonicalDomain(exported?.domain ?? (imported.domain === fromDomain ? toDomain : fromDomain)) ?? '';
      const consumerDomainId = canonicalDomain(imported.domain) ?? imported.domain;
      const contractRef = exported?.contract;
      const contract = contractRef ? Object.values(manifest.modeling?.contracts ?? {}).find((item) => unique([item.id, item.localId, item.qualifiedId]).includes(contractRef)) : undefined;
      const reasons = relationshipReasonCodes(relationship);
      if (!exported) reasons.push('MISSING_EXPORT');
      if (imported.status !== 'certified') reasons.push('IMPORT_NOT_CERTIFIED');
      if (exported && exported.status !== 'certified') reasons.push('EXPORT_NOT_CERTIFIED');
      if (!contract) reasons.push('MISSING_CONTRACT');
      else if (contract.status !== 'certified') reasons.push('CONTRACT_NOT_CERTIFIED');
      if (exported && exported.purposes.length > 0 && !exported.purposes.includes(imported.purpose)) reasons.push('PURPOSE_NOT_ALLOWED');
      if (exported && exported.consumerDomains.length > 0 && !exported.consumerDomains.includes(consumerDomainId)) reasons.push('CONSUMER_NOT_ALLOWED');
      routes.push(routeRecord(
        relationship.qualifiedId,
        providerDomainId,
        consumerDomainId,
        imported.purpose,
        relationship,
        exported ? exportObjects.get(exportEntry?.[0] ?? '') ?? exported.qualifiedId : undefined,
        importObjects.get(importKey) ?? imported.qualifiedId,
        contract ? lookup(contractIds, contract.localId, contract.domain)[0] ?? contract.qualifiedId : undefined,
        unique(reasons),
      ));
    }
  }
  return routes;
}

function routeRecord(
  relationshipId: string,
  providerDomainId: string,
  consumerDomainId: string,
  purpose: string,
  relationship: NonNullable<DQLManifest['modeling']>['relationships'][string],
  exportId: string | undefined,
  importId: string | undefined,
  contractId: string | undefined,
  reasonCodes: string[],
): ManifestCrossDomainRoute {
  const state: ManifestKnowledgeRouteState = relationship.staleCertification
    ? 'stale'
    : reasonCodes.length === 0 && relationship.automaticJoinAllowed
      ? 'authorized'
      : 'blocked';
  const path = unique([`domain::${providerDomainId}`, exportId ?? '', contractId ?? '', importId ?? '', relationshipId, `domain::${consumerDomainId}`].filter(Boolean));
  const content = { providerDomainId, consumerDomainId, purpose, relationshipId, exportId, importId, contractId, state, reasonCodes: unique(reasonCodes).sort(), path };
  const fingerprint = digest(stable(content));
  return { id: `route::${fingerprint.slice(0, 20)}`, ...content, fingerprint };
}

function buildDomainCapsules(
  manifest: Omit<DQLManifest, 'knowledgeGraph'>,
  skills: ManifestKnowledgeSkillDescriptor[],
  routes: ManifestCrossDomainRoute[],
  canonicalDomain: (value: string | undefined) => string | undefined,
  qualified: (kind: ManifestKnowledgeObjectKind, localId: string, domain?: string) => string,
  knowledgeBlocks: ManifestBlock[],
): Record<string, ManifestDomainCapsule> {
  const capsules: Record<string, ManifestDomainCapsule> = {};
  for (const [key, domain] of Object.entries(manifest.domains ?? {})) {
    const domainId = domain.id ?? key;
    const build = (areaId?: string, areaName?: string, intentExamples: string[] = [], description?: string) => {
      const terms = Object.values(manifest.terms ?? {}).filter((item) => canonicalDomain(item.domain) === domainId);
      const domainSkills = skills.filter((item) => item.domains.includes(domainId) && (!areaId || item.modelAreaRefs.length === 0 || item.modelAreaRefs.includes(areaId)));
      const entities = Object.values(manifest.modeling?.entities ?? {}).filter((item) => item.domain === domainId && (!areaId || item.areaId === areaId));
      const metrics = Object.values(manifest.metrics ?? {}).filter((item) => canonicalDomain(item.domain) === domainId);
      const blocks = knowledgeBlocks.filter((item) => canonicalDomain(item.domain) === domainId && item.status === 'certified');
      const relevantRoutes = routes.filter((route) => route.providerDomainId === domainId || route.consumerDomainId === domainId);
      const content = {
        domainId,
        modelAreaId: areaId,
        name: areaName ?? domain.name,
        description: description ?? domain.boundedContext ?? domain.description,
        intentExamples,
        exclusions: unique(domain.outOfScope ?? []),
        termRefs: terms.map((item) => qualified('term', item.name, domainId)).sort(),
        skillRefs: domainSkills.map((item) => item.qualifiedId).sort(),
        entityRefs: entities.map((item) => item.qualifiedId).sort(),
        metricRefs: metrics.map((item) => qualified('metric', item.name, domainId)).sort(),
        blockRefs: blocks.map((item) => qualified('block', item.name, domainId)).sort(),
        routeRefs: relevantRoutes.map((item) => item.id).sort(),
        caveats: unique(terms.flatMap((item) => item.caveats ?? [])),
        requiredFilters: unique(domainSkills.flatMap((item) => item.requiredFilters)),
      };
      const fingerprint = digest(stable(content));
      const id = areaId ? `${areaId}::capsule` : `${domainId}::capsule`;
      capsules[id] = { id, ...content, fingerprint };
    };
    build(undefined, undefined, [], domain.boundedContext ?? domain.description);
    for (const area of Object.values(manifest.modeling?.areas ?? {}).filter((item) => item.domain === domainId)) build(area.qualifiedId, area.name, area.intentExamples, area.description);
  }
  return sortRecord(capsules);
}

function connectProduct(
  id: string,
  product: { ownerDomain?: string; usesDomains?: string[]; skillRefs?: string[] },
  canonicalDomain: (value: string | undefined) => string | undefined,
  addEdge: (kind: ManifestKnowledgeEdgeKind, from: string, to: string, extra?: Omit<ManifestKnowledgeEdge, 'id' | 'kind' | 'from' | 'to' | 'fingerprint'>) => void,
) {
  for (const domain of unique([product.ownerDomain ?? '', ...(product.usesDomains ?? [])]).filter(Boolean)) {
    const domainId = canonicalDomain(domain);
    if (domainId) addEdge('consumed_by', `domain::${domainId}`, id);
  }
  for (const skill of product.skillRefs ?? []) addEdge('guided_by', id, skill);
}

function productPayload(product: { ownerDomain?: string; usesDomains?: string[]; purpose?: string; requiredExports?: string[]; skillRefs?: string[]; classification?: string }) {
  return { ownerDomain: product.ownerDomain, usesDomains: product.usesDomains ?? [], purpose: product.purpose, requiredExports: product.requiredExports ?? [], skillRefs: product.skillRefs ?? [], classification: product.classification };
}

function relationshipReasonCodes(relationship: NonNullable<DQLManifest['modeling']>['relationships'][string]): string[] {
  const reasons: string[] = [];
  if (relationship.status !== 'certified') reasons.push('RELATIONSHIP_NOT_CERTIFIED');
  if (relationship.staleCertification) reasons.push('STALE_PROOF');
  if (!relationship.validation || relationship.validation.status !== 'passed') reasons.push('VALIDATION_NOT_PASSED');
  if (relationship.fanout === 'unsafe' || relationship.fanout === 'unknown') reasons.push('UNSAFE_FANOUT');
  if (relationship.keys.length === 0) reasons.push('MISSING_KEYS');
  return reasons;
}

function exportAliases(key: string, exported: NonNullable<NonNullable<DQLManifest['modeling']>['interfaces']>['exports'][string]): string[] {
  return unique([key, exported.id, exported.localId, exported.qualifiedId, `${exported.domain}.${exported.localId}@${exported.version}`]);
}

function resolveModelEntity(manifest: Omit<DQLManifest, 'knowledgeGraph'>, ref: string): string {
  return modelEntity(manifest, ref)?.qualifiedId ?? ref;
}

function modelEntity(manifest: Omit<DQLManifest, 'knowledgeGraph'>, ref: string) {
  return manifest.modeling?.entities[ref] ?? Object.values(manifest.modeling?.entities ?? {}).find((entity) => entity.id === ref || entity.localId === ref || entity.qualifiedId === ref);
}

function sourceObjectId(manifest: Omit<DQLManifest, 'knowledgeGraph'>, table: string): string | undefined {
  const normalized = table.toLowerCase();
  const dbt = Object.values(manifest.dbtProvenance?.nodes ?? {}).find((node) => unique([node.name, node.relation ?? '', node.uniqueId]).some((value) => value.toLowerCase() === normalized));
  if (dbt) return `dbt::${dbt.uniqueId}`;
  return Object.values(manifest.sources ?? {}).some((source) => source.name.toLowerCase() === normalized) ? `source::${normalized}` : undefined;
}

function lineageObjectId(id: string, objects: Record<string, ManifestKnowledgeObject>): string | undefined {
  if (objects[id]) return id;
  const [kind, ...rest] = id.split(':');
  const value = rest.join(':');
  if (kind === 'dbt_model' || kind === 'dbt_source') {
    const found = Object.values(objects).find((object) => (object.kind === 'dbt_model' || object.kind === 'dbt_source') && (object.localId === value || object.source.nativeId === value));
    return found?.id;
  }
  const found = Object.values(objects).filter((object) => object.kind === kind && (object.localId === value || object.aliases?.includes(value)));
  return found.length === 1 ? found[0].id : undefined;
}

function addLookup(map: Map<string, string[]>, local: string, id: string, domain?: string) {
  for (const key of unique([local, id, domain ? `${domain}:${local}` : '']).filter(Boolean)) map.set(key, unique([...(map.get(key) ?? []), id]));
}

function lookup(map: Map<string, string[]>, ref: string, domain?: string): string[] {
  // Local names may exist in several domain packages. Prefer the active
  // domain's qualified lookup before falling back to the global alias.
  return (domain ? map.get(`${domain}:${ref}`) : undefined) ?? map.get(ref) ?? [];
}

function pair(provider: string | undefined, consumer: string | undefined) {
  return provider && consumer && provider !== consumer ? { provider, consumer } : undefined;
}

function edgeSort(a: ManifestKnowledgeEdge, b: ManifestKnowledgeEdge) {
  return `${a.kind}:${a.from}:${a.to}:${a.id}`.localeCompare(`${b.kind}:${b.from}:${b.to}:${b.id}`);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
