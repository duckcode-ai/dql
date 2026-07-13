/** Deterministic manifest-v3 analytical path planning and SQL validation. */
import {
  analyzeSqlReferences,
  relationshipValidationProofFingerprint,
  type DQLManifest,
  type ManifestModelEntity,
  type ManifestModelRelationship,
} from '@duckcodeailabs/dql-core';
import type { DomainContextEnvelope } from '../domain-context.js';

export type AnalyticalPolicyCode =
  | 'attribution_policy_required'
  | 'stale_certification'
  | 'relationship_not_certified'
  | 'relationship_evidence_missing'
  | 'relationship_evidence_expired'
  | 'relationship_proof_invalid'
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
  /** Server-resolved authorization boundary. Raw client domain hints are insufficient. */
  domainContext?: DomainContextEnvelope;
  measureEntities?: string[];
  dimensionEntities?: string[];
}

export interface AnalyticalRelationshipDecision {
  executable: boolean;
  code?: AnalyticalPolicyCode;
  message: string;
}

/**
 * Re-check the complete executable-join invariant at the point of use.
 *
 * `automaticJoinAllowed` is the compiler's summary bit and remains mandatory,
 * but consumers also validate its source proof so stale/corrupt hand-authored
 * manifests cannot turn a review-only relationship into SQL authorization.
 */
export function assessAnalyticalRelationship(
  relationship: ManifestModelRelationship,
  manifest?: DQLManifest,
  now = new Date(),
): AnalyticalRelationshipDecision {
  if (relationship.status !== 'certified') {
    return denied('relationship_not_certified', `Relationship "${relationship.id}" is ${relationship.status}, not certified.`);
  }
  if (relationship.staleCertification) {
    return denied('stale_certification', `Relationship "${relationship.id}" is stale and cannot authorize generated SQL.`);
  }
  if (!relationship.certificationFingerprint?.trim()) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has no valid certification fingerprint.`);
  }
  const validation = relationship.validation;
  if (!validation) {
    return denied('relationship_evidence_missing', `Relationship "${relationship.id}" has no warehouse validation evidence.`);
  }
  if (validation.status !== 'passed') {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" warehouse validation is ${validation.status}, not passed.`);
  }
  if (!validDate(validation.checkedAt) || !validation.queryFingerprint?.trim() || !validValidationCounts(validation)) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has invalid warehouse validation proof.`);
  }
  const modeling = manifest?.modeling;
  const fromEntity = modeling?.entities[relationship.from];
  const toEntity = modeling?.entities[relationship.to];
  const fromRelation = manifest?.dbtProvenance?.nodes[fromEntity?.dbtUniqueId ?? '']?.relation;
  const toRelation = manifest?.dbtProvenance?.nodes[toEntity?.dbtUniqueId ?? '']?.relation;
  if (!validation.proofFingerprint?.trim()) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has legacy or unbound warehouse evidence; run relationship validation again.`);
  }
  if (!manifest || !fromEntity || !toEntity) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" validation proof cannot be bound to its manifest-v3 entities.`);
  }
  const expectedProof = relationshipValidationProofFingerprint({
    fromRelation,
    toRelation,
    keys: relationship.keys,
    cardinality: relationship.cardinality,
    fanout: relationship.fanout,
    queryFingerprint: validation.queryFingerprint,
  });
  if (validation.proofFingerprint !== expectedProof) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" validation proof no longer matches its query, relations, keys, cardinality, or fanout policy.`);
  }
  if (relationship.evidenceExpiresAt) {
    const expiresAt = Date.parse(relationship.evidenceExpiresAt);
    if (!Number.isFinite(expiresAt)) {
      return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has an invalid evidence expiry timestamp.`);
    }
    if (expiresAt <= now.getTime()) {
      return denied('relationship_evidence_expired', `Relationship "${relationship.id}" warehouse validation evidence expired at ${relationship.evidenceExpiresAt}.`);
    }
  }
  if (relationship.keys.length === 0 || relationship.keys.some((key) => !key.from.trim() || !key.to.trim())) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has no valid physical join-key proof.`);
  }
  if (relationship.fanout !== 'safe'
    || !['one_to_one', 'one_to_many', 'many_to_one'].includes(relationship.cardinality)) {
    return denied('unsafe_relationship', `Relationship "${relationship.id}" is not fanout-safe for automatic joins.`);
  }
  if (!relationship.automaticJoinAllowed) {
    return denied('unsafe_relationship', `Relationship "${relationship.id}" is not authorized for automatic joins.`);
  }
  return { executable: true, message: `Relationship "${relationship.id}" is certified for automatic joins.` };
}

export function planAnalyticalPath(manifest: DQLManifest, request: AnalyticalPathRequest): AnalyticalPathPlan {
  const modeling = manifest.modeling;
  if (manifest.manifestVersion !== 3 || !modeling) return allowed([], []);
  const requested = [...new Set(request.entityIds)];
  const resolvedEntities = requested.map((id) => {
    if (modeling.entities[id]) return id;
    const ownerDomain = request.domainContext?.activeDomain ?? request.ownerDomain;
    const matches = Object.entries(modeling.entities).filter(([, entity]) =>
      entity.qualifiedId === id
      || (Boolean(ownerDomain) && entity.domain === ownerDomain && entity.localId === id));
    return matches.length === 1 ? matches[0]![0] : undefined;
  });
  const unresolved = requested.filter((_id, index) => !resolvedEntities[index]);
  if (unresolved.length > 0) {
    return blocked('unbound_relation', [], [], `Unknown or ambiguous qualified analytical entity id(s): ${unresolved.join(', ')}.`);
  }
  const entities = resolvedEntities.filter((id): id is string => Boolean(id)).sort();
  if (entities.length < 2) return allowed(entities, []);

  const relationships = Object.values(modeling.relationships);
  const directlyRelevant = relationships.filter((relationship) => entities.includes(relationship.from) || entities.includes(relationship.to));
  const attribution = directlyRelevant.find((relationship) => relationship.fanout === 'attribution_required'
    && entities.includes(relationship.from) && entities.includes(relationship.to));
  if (attribution) return blocked('attribution_policy_required', entities, [attribution], `Relationship "${attribution.id}" requires an attribution policy or allocation policy before DQL can join these entities.`);

  const adjacency = new Map<string, Array<{ next: string; relationship: ManifestModelRelationship }>>();
  for (const entity of Object.keys(modeling.entities)) adjacency.set(entity, []);
  for (const relationship of relationships.filter((value) => assessAnalyticalRelationship(value, manifest).executable)) {
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
      if (candidate) {
        const decision = assessAnalyticalRelationship(candidate, manifest);
        if (!decision.executable && decision.code !== 'unsafe_relationship') {
          return blocked(decision.code ?? 'unsafe_relationship', entities, [candidate], decision.message);
        }
      }
      if (candidate?.crossDomain) return blocked('relationship_not_exported', entities, candidate ? [candidate] : [], 'The cross-domain path is missing a certified export/import interface or valid purpose.');
      return blocked('unsafe_relationship', entities, candidate ? [candidate] : [], `No certified, validated, fanout-safe DQL path connects ${entities.join(', ')}.`);
    }
    for (const relationship of path) {
      selected.set(relationship.qualifiedId ?? relationship.id, relationship);
      connected.add(relationship.from);
      connected.add(relationship.to);
    }
  }

  for (const relationship of selected.values()) {
    if (relationship.crossDomain) {
      const authorization = authorizeCrossDomainRelationship(manifest, relationship, request.domainContext, request.purpose);
      if (!authorization.safe) return blocked(authorization.code!, entities, [relationship], authorization.message!);
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

function denied(code: AnalyticalPolicyCode, message: string): AnalyticalRelationshipDecision {
  return { executable: false, code, message };
}

function authorizeCrossDomainRelationship(
  manifest: DQLManifest,
  relationship: ManifestModelRelationship,
  context: DomainContextEnvelope | undefined,
  requestedPurpose: string | undefined,
): Pick<AnalyticalPathPlan, 'safe' | 'code' | 'message'> {
  const purpose = context?.purpose?.trim();
  if (!context || !purpose) {
    return { safe: false, code: 'purpose_not_allowed', message: `Cross-domain relationship "${relationship.localId}" requires an explicit analytical purpose.` };
  }
  if (requestedPurpose?.trim() && requestedPurpose.trim() !== purpose) {
    return { safe: false, code: 'purpose_not_allowed', message: `Requested purpose "${requestedPurpose}" does not match the resolved domain context purpose "${purpose}".` };
  }
  if (!context.activeDomain || (relationship.ownerDomain && context.activeDomain !== relationship.ownerDomain)) {
    return { safe: false, code: 'relationship_not_exported', message: `Cross-domain relationship "${relationship.localId}" is not owned by the active domain context.` };
  }
  const importRefs = relationship.importRefs ?? [];
  if (importRefs.length === 0) {
    return { safe: false, code: 'relationship_not_exported', message: `Cross-domain relationship "${relationship.localId}" has no explicit import interface.` };
  }
  const exports = manifest.modeling?.interfaces?.exports ?? {};
  const contracts = Object.values(manifest.modeling?.contracts ?? {});
  for (const exportRef of importRefs) {
    const allowed = context.allowedImports.find((value) => value.exportRef === exportRef && value.purpose === purpose);
    const exported = exports[exportRef];
    if (!allowed || !exported || exported.status !== 'certified') {
      return { safe: false, code: 'relationship_not_exported', message: `Cross-domain relationship "${relationship.localId}" is missing a certified allowed import for "${exportRef}" and purpose "${purpose}".` };
    }
    const contract = exported.contract
      ? contracts.find((value) => value.qualifiedId === exported.contract
        || value.id === exported.contract
        || (value.domain === exported.domain && value.localId === exported.contract))
      : undefined;
    const contractEntityCompatible = !exported.entity || Boolean(contract?.entities.includes(exported.entity));
    const contractPurposeCompatible = !contract?.purpose || contract.purpose === purpose;
    if (!contract || contract.status !== 'certified' || !contractEntityCompatible || !contractPurposeCompatible) {
      return { safe: false, code: 'relationship_not_exported', message: `Cross-domain export "${exportRef}" has no compatible certified contract for purpose "${purpose}".` };
    }
  }
  return { safe: true };
}

function validDate(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validValidationCounts(validation: NonNullable<ManifestModelRelationship['validation']>): boolean {
  return [
    validation.fromRows,
    validation.toRows,
    validation.joinedRows,
    validation.fromNullKeys,
    validation.toNullKeys,
    validation.unmatchedFrom,
    validation.maxFromPerKey,
    validation.maxToPerKey,
  ].every((value) => Number.isFinite(value) && value >= 0);
}

export function validateAnalyticalSql(
  sql: string,
  manifest: DQLManifest,
  dialect = 'duckdb',
  purpose?: string,
  domainContext?: DomainContextEnvelope,
): AnalyticalPathPlan {
  if (manifest.manifestVersion !== 3 || !manifest.modeling || !manifest.dbtProvenance) return allowed([], []);
  const analysis = analyzeSqlReferences(sql, dialect);
  if (!analysis.parsed) return blocked('unplanned_join', [], [], `DQL could not parse generated SQL for analytical policy validation: ${analysis.error ?? 'unknown parse error'}`);
  const relationEntities = new Map<string, { key: string; entity: ManifestModelEntity }>();
  for (const relation of analysis.tables) {
    const entity = entityForRelation(relation, manifest);
    const key = entity ? entityRecordKey(manifest, entity) : undefined;
    if (entity && key) relationEntities.set(normalizeRelation(relation), { key, entity });
  }
  if (analysis.joins.length > 0) {
    const unbound = analysis.tables.filter((relation) => !entityForRelation(relation, manifest));
    if (unbound.length > 0) return blocked('unbound_relation', [...new Set([...relationEntities.values()].map((value) => value.key))], [], `Generated join references unbound relation(s): ${unbound.join(', ')}.`);
  }
  const plan = planAnalyticalPath(manifest, {
    entityIds: [...new Set([...relationEntities.values()].map((value) => value.key))],
    purpose,
    domainContext,
  });
  if (!plan.safe) return plan;

  for (const join of analysis.joins) {
    const left = join.leftRelation ? entityForRelation(join.leftRelation, manifest) : undefined;
    const right = join.rightRelation ? entityForRelation(join.rightRelation, manifest) : undefined;
    if (!left || !right) return blocked('unbound_relation', plan.entities, [], 'Every generated join endpoint must bind to a DQL analytical entity.');
    const leftKey = entityRecordKey(manifest, left);
    const rightKey = entityRecordKey(manifest, right);
    if (!leftKey || !rightKey) return blocked('unbound_relation', plan.entities, [], 'Every generated join endpoint must resolve to a qualified DQL analytical entity.');
    const relationship = plan.relationshipIds
      .map((id) => manifest.modeling?.relationships[id])
      .find((value) => value && ((value.from === leftKey && value.to === rightKey) || (value.from === rightKey && value.to === leftKey)));
    if (!relationship) return blocked('unplanned_join', plan.entities, [], `No planned relationship authorizes ${left.id} to ${right.id}.`);
    const matches = relationship.keys.some((key) => {
      const direct = relationship.from === leftKey && normalizeColumn(join.leftColumn) === normalizeColumn(key.from) && normalizeColumn(join.rightColumn) === normalizeColumn(key.to);
      const reverse = relationship.from === rightKey && normalizeColumn(join.leftColumn) === normalizeColumn(key.to) && normalizeColumn(join.rightColumn) === normalizeColumn(key.from);
      return direct || reverse;
    });
    if (!matches) return blocked('join_key_mismatch', plan.entities, [relationship], `Join predicate ${join.leftColumn} = ${join.rightColumn} does not match certified keys for "${relationship.id}".`);
  }
  return plan;
}

function entityRecordKey(manifest: DQLManifest, entity: ManifestModelEntity): string | undefined {
  return Object.entries(manifest.modeling?.entities ?? {}).find(([, candidate]) => candidate === entity || (Boolean(entity.qualifiedId) && candidate.qualifiedId === entity.qualifiedId))?.[0];
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
    relationshipIds: relationships.map((relationship) => relationshipRecordKey(manifest, relationship)),
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

function relationshipRecordKey(manifest: DQLManifest | undefined, relationship: ManifestModelRelationship): string {
  return Object.entries(manifest?.modeling?.relationships ?? {}).find(([, candidate]) => candidate === relationship || (Boolean(relationship.qualifiedId) && candidate.qualifiedId === relationship.qualifiedId))?.[0]
    ?? relationship.qualifiedId
    ?? relationship.id;
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
