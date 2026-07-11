/**
 * Manifest v3 relationship guard for generated analytics SQL.
 *
 * dbt DAG lineage is deliberately absent from this proof: only an explicit,
 * certified, fresh DQL relationship with `fanout: safe` can authorize an
 * automatic generated join.
 */

import { extractTablesFromSql, type DQLManifest, type ManifestDbtNodeProvenance } from '@duckcodeailabs/dql-core';

export type DbtFirstJoinSafetyCode =
  | 'attribution_policy_required'
  | 'stale_certification'
  | 'relationship_not_certified'
  | 'relationship_not_exported'
  | 'unsafe_relationship';

export interface DbtFirstJoinSafetyDecision {
  safe: boolean;
  code?: DbtFirstJoinSafetyCode;
  message?: string;
  entities: string[];
  relationshipIds: string[];
}

/**
 * Validate every dbt-backed entity pair referenced by generated SQL. The
 * relationship graph is undirected for proof reachability; its declared key
 * direction remains available in `manifest.modeling.relationships` for SQL
 * generation and lineage rendering.
 */
export function evaluateDbtFirstGeneratedSql(sql: string, manifest: DQLManifest): DbtFirstJoinSafetyDecision {
  const modeling = manifest.modeling;
  const provenance = manifest.dbtProvenance;
  if (manifest.manifestVersion !== 3 || !modeling || !provenance) {
    return { safe: true, entities: [], relationshipIds: [] };
  }

  const tables = extractTablesFromSql(sql).tables.map(normalize);
  const entityIds = Object.values(modeling.entities)
    .filter((entity) => tableReferencesEntity(tables, provenance.nodes[entity.dbtUniqueId]))
    .map((entity) => entity.id)
    .sort();
  if (entityIds.length < 2) return { safe: true, entities: entityIds, relationshipIds: [] };

  const relevant = Object.values(modeling.relationships)
    .filter((relationship) => entityIds.includes(relationship.from) && entityIds.includes(relationship.to));
  const blocked = relevant.find((relationship) => relationship.fanout === 'attribution_required');
  if (blocked) {
    return {
      safe: false,
      code: 'attribution_policy_required',
      entities: entityIds,
      relationshipIds: [blocked.id],
      message: `This joins ${blocked.from} and ${blocked.to} through a many-touch attribution path. Choose an attribution policy (for example first-touch, last-touch, or fractional) before DQL can calculate the metric.`,
    };
  }
  const stale = relevant.find((relationship) => relationship.staleCertification);
  if (stale) {
    return {
      safe: false,
      code: 'stale_certification',
      entities: entityIds,
      relationshipIds: [stale.id],
      message: `The certified relationship "${stale.id}" is stale because its dbt key or grain changed. Review and re-certify it before using this cross-entity query.`,
    };
  }
  const unsafe = relevant.find((relationship) => relationship.fanout !== 'safe' || relationship.cardinality === 'many_to_many' || relationship.cardinality === 'unknown');
  if (unsafe) {
    return {
      safe: false,
      code: 'unsafe_relationship',
      entities: entityIds,
      relationshipIds: [unsafe.id],
      message: `Relationship "${unsafe.id}" is not fanout-safe for automatic SQL generation. Use a certified block or add a reviewed analytical policy.`,
    };
  }
  const notCertified = relevant.find((relationship) => relationship.status !== 'certified');
  if (notCertified) {
    return {
      safe: false,
      code: 'relationship_not_certified',
      entities: entityIds,
      relationshipIds: [notCertified.id],
      message: `Relationship "${notCertified.id}" is ${notCertified.status}, not certified. DQL will not use it as automatic join proof.`,
    };
  }
  const automatic = relevant.filter((relationship) => relationship.automaticJoinAllowed);
  if (!allEntitiesConnected(entityIds, automatic.map((relationship) => [relationship.from, relationship.to] as const))) {
    const crossDomain = relevant.find((relationship) => relationship.crossDomain && !relationship.automaticJoinAllowed);
    return {
      safe: false,
      code: crossDomain ? 'relationship_not_exported' : 'relationship_not_certified',
      entities: entityIds,
      relationshipIds: relevant.map((relationship) => relationship.id),
      message: crossDomain
        ? `The cross-domain relationship "${crossDomain.id}" is not an exported, certified, fanout-safe contract. DQL will not infer this join from dbt lineage.`
        : `No certified, fanout-safe DQL relationship proves the join between ${entityIds.join(', ')}. dbt lineage alone is not join proof.`,
    };
  }
  return { safe: true, entities: entityIds, relationshipIds: automatic.map((relationship) => relationship.id) };
}

function tableReferencesEntity(tables: string[], node: ManifestDbtNodeProvenance | undefined): boolean {
  if (!node) return false;
  const references = [node.name, node.relation].filter((value): value is string => typeof value === 'string').map(normalize);
  return tables.some((table) => references.some((reference) => table === reference || table.endsWith(`.${reference}`) || reference.endsWith(`.${table}`)));
}

function allEntitiesConnected(entities: string[], pairs: Array<readonly [string, string]>): boolean {
  const adjacency = new Map<string, Set<string>>();
  for (const entity of entities) adjacency.set(entity, new Set());
  for (const [from, to] of pairs) {
    adjacency.get(from)?.add(to);
    adjacency.get(to)?.add(from);
  }
  const seen = new Set<string>();
  const queue = entities.length > 0 ? [entities[0]] : [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) queue.push(next);
  }
  return seen.size === entities.length;
}

function normalize(value: string): string {
  return value.replace(/["`\[\]]/g, '').toLowerCase();
}
