/** Deterministic manifest-v3 analytical path planning and SQL validation. */
import { analyzeSqlReferences, type DQLManifest, type ManifestModelEntity, type ManifestModelRelationship } from '@duckcodeailabs/dql-core';

export type AnalyticalPolicyCode =
  | 'attribution_policy_required'
  | 'stale_certification'
  | 'relationship_not_certified'
  | 'relationship_not_exported'
  | 'unsafe_relationship'
  | 'unbound_relation'
  | 'unplanned_join'
  | 'join_key_mismatch'
  | 'purpose_not_allowed';

export interface AnalyticalJoinPlanEdge {
  relationshipId: string;
  fromEntity: string;
  toEntity: string;
  fromRelation?: string;
  toRelation?: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: string;
  fanout: string;
  importRefs: string[];
}

export interface AnalyticalPathPlan {
  safe: boolean;
  code?: AnalyticalPolicyCode;
  message?: string;
  entities: string[];
  relationshipIds: string[];
  edges: AnalyticalJoinPlanEdge[];
}

export interface AnalyticalPathRequest {
  entityIds: string[];
  ownerDomain?: string;
  purpose?: string;
  measureEntities?: string[];
  dimensionEntities?: string[];
}

export function planAnalyticalPath(manifest: DQLManifest, request: AnalyticalPathRequest): AnalyticalPathPlan {
  const modeling = manifest.modeling;
  if (manifest.manifestVersion !== 3 || !modeling) return allowed([], []);
  const entities = [...new Set(request.entityIds)].filter((id) => Boolean(modeling.entities[id])).sort();
  if (entities.length < 2) return allowed(entities, []);

  const relationships = Object.values(modeling.relationships);
  const directlyRelevant = relationships.filter((relationship) => entities.includes(relationship.from) || entities.includes(relationship.to));
  const attribution = directlyRelevant.find((relationship) => relationship.fanout === 'attribution_required'
    && entities.includes(relationship.from) && entities.includes(relationship.to));
  if (attribution) return blocked('attribution_policy_required', entities, [attribution], `Relationship "${attribution.id}" requires an attribution policy or allocation policy before DQL can join these entities.`);

  const adjacency = new Map<string, Array<{ next: string; relationship: ManifestModelRelationship }>>();
  for (const entity of Object.keys(modeling.entities)) adjacency.set(entity, []);
  for (const relationship of relationships.filter((value) => value.automaticJoinAllowed)) {
    adjacency.get(relationship.from)?.push({ next: relationship.to, relationship });
    adjacency.get(relationship.to)?.push({ next: relationship.from, relationship });
  }

  const selected = new Map<string, ManifestModelRelationship>();
  const connected = new Set<string>([entities[0]]);
  for (const target of entities.slice(1)) {
    const path = shortestPath([...connected], target, adjacency);
    if (!path) {
      const candidate = relationships.find((relationship) =>
        (connected.has(relationship.from) && relationship.to === target)
        || (connected.has(relationship.to) && relationship.from === target));
      if (candidate?.staleCertification) return blocked('stale_certification', entities, [candidate], `Relationship "${candidate.id}" is stale and cannot authorize generated SQL.`);
      if (candidate?.status !== undefined && candidate.status !== 'certified') return blocked('relationship_not_certified', entities, [candidate], `Relationship "${candidate.id}" is ${candidate.status}, not certified.`);
      if (candidate?.crossDomain) return blocked('relationship_not_exported', entities, candidate ? [candidate] : [], 'The cross-domain path is missing a certified export/import interface or valid purpose.');
      return blocked('unsafe_relationship', entities, candidate ? [candidate] : [], `No certified, validated, fanout-safe DQL path connects ${entities.join(', ')}.`);
    }
    for (const relationship of path) {
      selected.set(relationship.id, relationship);
      connected.add(relationship.from);
      connected.add(relationship.to);
    }
  }

  for (const relationship of selected.values()) {
    if (request.purpose && relationship.importRefs?.length) {
      const imports = Object.values(modeling.interfaces?.imports ?? {}).filter((value) => relationship.importRefs?.includes(value.exportRef));
      if (imports.some((value) => value.purpose !== request.purpose)) {
        return blocked('purpose_not_allowed', entities, [relationship], `Relationship "${relationship.id}" is not imported for purpose "${request.purpose}".`);
      }
    }
    if (relationship.aggregation) {
      const missingMeasure = request.measureEntities?.find((entity) => !relationship.aggregation?.measuresFrom.includes(entity));
      const missingDimension = request.dimensionEntities?.find((entity) => !relationship.aggregation?.dimensionsFrom.includes(entity));
      if (missingMeasure || missingDimension) {
        return blocked('unsafe_relationship', entities, [relationship], `Relationship "${relationship.id}" does not authorize the requested measure/dimension direction.`);
      }
    }
  }
  return allowed(entities, [...selected.values()], manifest);
}

export function validateAnalyticalSql(sql: string, manifest: DQLManifest, dialect = 'duckdb'): AnalyticalPathPlan {
  if (manifest.manifestVersion !== 3 || !manifest.modeling || !manifest.dbtProvenance) return allowed([], []);
  const analysis = analyzeSqlReferences(sql, dialect);
  if (!analysis.parsed) return blocked('unplanned_join', [], [], `DQL could not parse generated SQL for analytical policy validation: ${analysis.error ?? 'unknown parse error'}`);
  const relationEntities = new Map<string, ManifestModelEntity>();
  for (const relation of analysis.tables) {
    const entity = entityForRelation(relation, manifest);
    if (entity) relationEntities.set(normalizeRelation(relation), entity);
  }
  if (analysis.joins.length > 0) {
    const unbound = analysis.tables.filter((relation) => !entityForRelation(relation, manifest));
    if (unbound.length > 0) return blocked('unbound_relation', [...new Set(relationEntities.values())].map((entity) => entity.id), [], `Generated join references unbound relation(s): ${unbound.join(', ')}.`);
  }
  const plan = planAnalyticalPath(manifest, { entityIds: [...new Set(relationEntities.values())].map((entity) => entity.id) });
  if (!plan.safe) return plan;

  for (const join of analysis.joins) {
    const left = join.leftRelation ? entityForRelation(join.leftRelation, manifest) : undefined;
    const right = join.rightRelation ? entityForRelation(join.rightRelation, manifest) : undefined;
    if (!left || !right) return blocked('unbound_relation', plan.entities, [], 'Every generated join endpoint must bind to a DQL analytical entity.');
    const relationship = plan.relationshipIds
      .map((id) => manifest.modeling?.relationships[id])
      .find((value) => value && ((value.from === left.id && value.to === right.id) || (value.from === right.id && value.to === left.id)));
    if (!relationship) return blocked('unplanned_join', plan.entities, [], `No planned relationship authorizes ${left.id} to ${right.id}.`);
    const matches = relationship.keys.some((key) => {
      const direct = relationship.from === left.id && normalizeColumn(join.leftColumn) === normalizeColumn(key.from) && normalizeColumn(join.rightColumn) === normalizeColumn(key.to);
      const reverse = relationship.from === right.id && normalizeColumn(join.leftColumn) === normalizeColumn(key.to) && normalizeColumn(join.rightColumn) === normalizeColumn(key.from);
      return direct || reverse;
    });
    if (!matches) return blocked('join_key_mismatch', plan.entities, [relationship], `Join predicate ${join.leftColumn} = ${join.rightColumn} does not match certified keys for "${relationship.id}".`);
  }
  return plan;
}

function shortestPath(
  starts: string[],
  target: string,
  adjacency: Map<string, Array<{ next: string; relationship: ManifestModelRelationship }>>,
): ManifestModelRelationship[] | undefined {
  const queue = starts.map((entity) => ({ entity, path: [] as ManifestModelRelationship[] }));
  const seen = new Set(starts);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.entity === target) return current.path;
    for (const edge of adjacency.get(current.entity) ?? []) {
      if (seen.has(edge.next)) continue;
      seen.add(edge.next);
      queue.push({ entity: edge.next, path: [...current.path, edge.relationship] });
    }
  }
  return undefined;
}

function entityForRelation(relation: string, manifest: DQLManifest): ManifestModelEntity | undefined {
  const normalized = normalizeRelation(relation);
  return Object.values(manifest.modeling?.entities ?? {}).find((entity) => {
    const node = manifest.dbtProvenance?.nodes[entity.dbtUniqueId];
    return [node?.name, node?.relation].filter(Boolean).some((value) => {
      const candidate = normalizeRelation(String(value));
      return candidate === normalized || candidate.endsWith(`.${normalized}`) || normalized.endsWith(`.${candidate}`);
    });
  });
}

function allowed(entities: string[], relationships: ManifestModelRelationship[], manifest?: DQLManifest): AnalyticalPathPlan {
  return {
    safe: true,
    entities,
    relationshipIds: relationships.map((relationship) => relationship.id),
    edges: relationships.map((relationship) => ({
      relationshipId: relationship.id,
      fromEntity: relationship.from,
      toEntity: relationship.to,
      fromRelation: manifest?.dbtProvenance?.nodes[manifest.modeling?.entities[relationship.from]?.dbtUniqueId ?? '']?.relation,
      toRelation: manifest?.dbtProvenance?.nodes[manifest.modeling?.entities[relationship.to]?.dbtUniqueId ?? '']?.relation,
      keys: relationship.keys,
      cardinality: relationship.cardinality,
      fanout: relationship.fanout,
      importRefs: relationship.importRefs ?? [],
    })),
  };
}

function blocked(code: AnalyticalPolicyCode, entities: string[], relationships: ManifestModelRelationship[], message: string): AnalyticalPathPlan {
  return { safe: false, code, message, entities, relationshipIds: relationships.map((relationship) => relationship.id), edges: [] };
}

function normalizeRelation(value: string): string {
  return value.replace(/["`\[\]]/g, '').trim().toLowerCase();
}

function normalizeColumn(value: string): string {
  return value.replace(/["`\[\]]/g, '').split('.').at(-1)?.trim().toLowerCase() ?? value.toLowerCase();
}
