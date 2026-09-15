import { assessAnalyticalRelationship } from '@duckcodeailabs/dql-agent';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { normalizeRelationName } from './vocabulary-source.js';

/**
 * MODELING RELATIONSHIPS MEET AI-WRITTEN SQL.
 *
 * Joins over tables stay the AI's to write (owner direction, 178eeeb0). What
 * a person certified in Modeling still binds it: when the statement joins two
 * tables a certified relationship connects, it must join them on exactly the
 * certified keys. Every join the statement makes is also recorded with the
 * relationship behind it (or none), so the answer can say how its tables were
 * joined and offer to save an undeclared join as a relationship.
 */

export type RelationshipJoinLevel = 'certified' | 'validated' | 'draft' | 'stale';

export interface ModelingRelationshipEdge {
  relationshipId: string;
  name: string;
  fromRelation: string;
  toRelation: string;
  keys: Array<{ from: string; to: string }>;
  level: RelationshipJoinLevel;
  cardinality: string;
}

const LEVEL_RANK: Record<RelationshipJoinLevel, number> = { certified: 3, validated: 2, stale: 1, draft: 0 };

/** Every relationship on the map as an edge between warehouse relations, with what Ask may do with it. */
export function modelingRelationshipEdges(manifest: DQLManifest | undefined): ModelingRelationshipEdge[] {
  const modeling = manifest?.modeling;
  if (!modeling) return [];
  const relationOf = new Map<string, string>();
  for (const [recordKey, entity] of Object.entries(modeling.entities ?? {})) {
    const relation = normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation);
    if (!relation) continue;
    for (const key of [recordKey, entity.id, entity.localId, entity.qualifiedId]) if (key) relationOf.set(key, relation);
  }
  const edges: ModelingRelationshipEdge[] = [];
  for (const relationship of Object.values(modeling.relationships ?? {})) {
    if (relationship.status === 'deprecated' || relationship.keys.length === 0) continue;
    const fromRelation = relationOf.get(relationship.from);
    const toRelation = relationOf.get(relationship.to);
    if (!fromRelation || !toRelation || fromRelation === toRelation) continue;
    const level: RelationshipJoinLevel = assessAnalyticalRelationship(relationship, manifest).executable
      ? 'certified'
      : relationship.status === 'certified'
        ? 'stale'
        : relationship.validation?.status === 'passed' && relationship.status !== 'draft' ? 'validated' : 'draft';
    edges.push({ relationshipId: relationship.qualifiedId ?? relationship.id, name: relationship.localId ?? relationship.id, fromRelation, toRelation, keys: relationship.keys, level, cardinality: relationship.cardinality });
  }
  return edges;
}

/** Two spellings of a relation agree on schema and table; a bare table name matches on the table alone. */
export function sameRelation(left: string, right: string): boolean {
  const a = normalizeRelationName(left)?.toLowerCase();
  const b = normalizeRelationName(right)?.toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes('.') && b.includes('.')) return false;
  return a.split('.').pop() === b.split('.').pop();
}

export interface SqlJoinPair { left: { relation: string; column: string }; right: { relation: string; column: string } }

export interface SqlJoinUse {
  relations: [string, string];
  /** The key pairs the statement joins on, oriented `relations[0]` → `relations[1]`. */
  keys: Array<{ from: string; to: string }>;
  /** The strongest relationship between the two relations, if any. */
  relationship?: ModelingRelationshipEdge;
  /** Its keys oriented like `keys`. */
  relationshipKeys?: Array<{ from: string; to: string }>;
  /** The statement joins on exactly the relationship's keys. */
  matchesRelationship: boolean;
}

const bare = (column: string) => column.replace(/["`\[\]]/g, '').toLowerCase();
const pairKey = (pair: { from: string; to: string }) => `${bare(pair.from)}=${bare(pair.to)}`;

/** The statement's joins, one per pair of relations, each with the relationship that connects them. */
export function classifySqlJoins(pairs: SqlJoinPair[], edges: ModelingRelationshipEdge[]): SqlJoinUse[] {
  const uses: SqlJoinUse[] = [];
  for (const pair of pairs) {
    let use = uses.find((item) => (sameRelation(item.relations[0], pair.left.relation) && sameRelation(item.relations[1], pair.right.relation))
      || (sameRelation(item.relations[0], pair.right.relation) && sameRelation(item.relations[1], pair.left.relation)));
    if (!use) {
      use = { relations: [pair.left.relation, pair.right.relation], keys: [], matchesRelationship: false };
      uses.push(use);
    }
    const forward = sameRelation(use.relations[0], pair.left.relation);
    const key = forward ? { from: pair.left.column, to: pair.right.column } : { from: pair.right.column, to: pair.left.column };
    if (!use.keys.some((existing) => pairKey(existing) === pairKey(key))) use.keys.push(key);
  }
  for (const use of uses) {
    const candidates = edges
      .map((edge) => sameRelation(edge.fromRelation, use.relations[0]) && sameRelation(edge.toRelation, use.relations[1])
        ? { edge, keys: edge.keys }
        : sameRelation(edge.fromRelation, use.relations[1]) && sameRelation(edge.toRelation, use.relations[0])
          ? { edge, keys: edge.keys.map((key) => ({ from: key.to, to: key.from })) }
          : undefined)
      .filter((item): item is { edge: ModelingRelationshipEdge; keys: Array<{ from: string; to: string }> } => Boolean(item));
    const matching = candidates.filter((candidate) => sameKeys(candidate.keys, use.keys));
    const best = (matching.length ? matching : candidates).sort((a, b) => LEVEL_RANK[b.edge.level] - LEVEL_RANK[a.edge.level])[0];
    if (!best) continue;
    use.relationship = best.edge;
    use.relationshipKeys = best.keys;
    use.matchesRelationship = matching.includes(best);
  }
  return uses;
}

function sameKeys(declared: Array<{ from: string; to: string }>, used: Array<{ from: string; to: string }>): boolean {
  const wanted = new Set(declared.map(pairKey));
  // A statement's parser reads the first equality of each ON clause, so a
  // multi-key join can show fewer pairs than it has: every pair read must be
  // declared, and at least one must be read.
  return used.length > 0 && used.every((key) => wanted.has(pairKey(key)));
}

/** Whether the statement text joins on a key pair, in either order and with any qualifiers. */
function joinsOn(sql: string, key: { from: string; to: string }): boolean {
  const escape = (value: string) => bare(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const side = (column: string) => `(?:[\\w$"\`\\[\\]]+\\.)*["\`\\[]?${escape(column)}["\`\\]]?`;
  return new RegExp(`${side(key.from)}\\s*=\\s*${side(key.to)}|${side(key.to)}\\s*=\\s*${side(key.from)}`, 'i').test(sql);
}

/**
 * A certified relationship's keys are the only way to join its two relations.
 * Returns one plain-language failure per certified relationship the statement
 * joins on other keys, or on only part of a multi-key relationship.
 */
export function certifiedJoinViolations(sql: string, uses: SqlJoinUse[]): string[] {
  return uses.flatMap((use) => {
    if (use.relationship?.level !== 'certified' || !use.relationshipKeys) return [];
    const complete = use.matchesRelationship && use.relationshipKeys.every((key) => joinsOn(sql, key));
    if (complete) return [];
    const [left, right] = use.relations;
    const show = (keys: Array<{ from: string; to: string }>) => keys.map((key) => `${left}.${key.from} = ${right}.${key.to}`).join(' AND ');
    return [`it joins ${left} and ${right} on ${show(use.keys)}, but the certified relationship ${use.relationship.name} joins them on ${show(use.relationshipKeys)}; join on exactly those keys`];
  });
}

/**
 * The relations a fact relation reaches without multiplying its rows: the
 * "one" side of a validated or certified relationship. Research breaks a
 * change down by their columns too, and the join it needs is one a person
 * checked in the warehouse.
 */
export function joinableRelations(edges: ModelingRelationshipEdge[], relations: string[]): string[] {
  const reached: string[] = [];
  const add = (relation: string) => {
    if (!relations.some((known) => sameRelation(known, relation)) && !reached.some((known) => sameRelation(known, relation))) reached.push(relation);
  };
  for (const edge of edges) {
    if (edge.level !== 'certified' && edge.level !== 'validated') continue;
    for (const relation of relations) {
      if ((edge.cardinality === 'many_to_one' || edge.cardinality === 'one_to_one') && sameRelation(edge.fromRelation, relation)) add(edge.toRelation);
      if ((edge.cardinality === 'one_to_many' || edge.cardinality === 'one_to_one') && sameRelation(edge.toRelation, relation)) add(edge.fromRelation);
    }
  }
  return reached;
}

export interface LedgerJoin {
  source: 'dql_relationship' | 'ai_sql';
  relationshipId?: string;
  name?: string;
  authority: RelationshipJoinLevel | 'none';
  relations: string[];
  keys: Array<{ from: string; to: string }>;
}

/** What the receipt records for each join: the relationship it followed, or that the AI joined without one. */
export function ledgerJoins(uses: SqlJoinUse[]): LedgerJoin[] {
  return uses.map((use) => (use.relationship && use.matchesRelationship
    ? { source: 'dql_relationship', relationshipId: use.relationship.relationshipId, name: use.relationship.name, authority: use.relationship.level, relations: [...use.relations], keys: use.keys }
    : { source: 'ai_sql', authority: 'none', relations: [...use.relations], keys: use.keys, ...(use.relationship ? { relationshipId: use.relationship.relationshipId, name: use.relationship.name } : {}) }));
}
