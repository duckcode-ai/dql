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

/** A path of modeled relationships that connects two chosen tables. */
export interface ModeledJoinPath {
  between: [string, string];
  /** Edges in walking order; `edge.fromRelation`/`toRelation` keep the relationship's own direction. */
  edges: ModelingRelationshipEdge[];
  /** Tables on the path that were not chosen. */
  through: string[];
}

// A certified hop is the cheapest; a draft hop is allowed but costs more than
// a three-hop certified route, so certified knowledge wins whenever it reaches
// within the hop limit. A stale certification counts as a draft.
const HOP_COST: Record<RelationshipJoinLevel, number> = { certified: 1, validated: 1.5, stale: 3.5, draft: 3.5 };

/**
 * THE TABLES BETWEEN. A question names the tables it is about (claims,
 * policies); the tables that connect them (a coverage bridge) are rarely named,
 * so an AI drafting SQL over only the named tables finds "no column links
 * claim to policy" although the team modeled exactly that link. For every pair
 * of chosen tables, the cheapest route over the Modeling map (certified hops
 * preferred, at most `maxHops`) is found; its intermediate tables are added
 * (at most `maxAdded`, cheapest routes first) and its hops become join hints.
 * Nothing here is a gate: the AI still chooses the joins, and certified keys
 * still bind any join it makes (`certifiedJoinViolations`).
 */
export function modeledJoinPaths(
  chosen: string[],
  edges: ModelingRelationshipEdge[],
  options: { maxHops?: number; maxAdded?: number } = {},
): { paths: ModeledJoinPath[]; added: string[] } {
  const maxHops = options.maxHops ?? 3;
  const maxAdded = options.maxAdded ?? 4;
  const nodeOf = (relation: string): string | undefined => {
    for (const edge of edges) {
      if (sameRelation(edge.fromRelation, relation)) return edge.fromRelation;
      if (sameRelation(edge.toRelation, relation)) return edge.toRelation;
    }
    return undefined;
  };
  const neighbours = new Map<string, Array<{ to: string; edge: ModelingRelationshipEdge }>>();
  const link = (from: string, to: string, edge: ModelingRelationshipEdge) => {
    if (!neighbours.has(from)) neighbours.set(from, []);
    neighbours.get(from)!.push({ to, edge });
  };
  for (const edge of edges) {
    link(edge.fromRelation, edge.toRelation, edge);
    link(edge.toRelation, edge.fromRelation, edge);
  }
  const chosenNodes = [...new Set(chosen.map(nodeOf).filter((node): node is string => Boolean(node)))];
  const isChosen = (node: string) => chosenNodes.includes(node);

  const cheapest = (start: string, goal: string): { cost: number; nodes: string[]; edges: ModelingRelationshipEdge[] } | undefined => {
    // Dijkstra over a small graph; ties keep the first-declared relationship.
    const best = new Map<string, { cost: number; hops: number; nodes: string[]; edges: ModelingRelationshipEdge[] }>([[start, { cost: 0, hops: 0, nodes: [start], edges: [] }]]);
    const open = [start];
    while (open.length > 0) {
      open.sort((a, b) => best.get(a)!.cost - best.get(b)!.cost);
      const node = open.shift()!;
      const here = best.get(node)!;
      if (node === goal) return here;
      if (here.hops >= maxHops) continue;
      for (const { to, edge } of neighbours.get(node) ?? []) {
        // A route runs through tables nobody chose; it never detours through another chosen table.
        if (to !== goal && isChosen(to)) continue;
        if (here.nodes.includes(to)) continue;
        const cost = here.cost + HOP_COST[edge.level];
        const known = best.get(to);
        if (known && known.cost <= cost) continue;
        best.set(to, { cost, hops: here.hops + 1, nodes: [...here.nodes, to], edges: [...here.edges, edge] });
        if (!open.includes(to)) open.push(to);
      }
    }
    return undefined;
  };

  const routes: Array<{ cost: number; path: ModeledJoinPath }> = [];
  for (let i = 0; i < chosenNodes.length; i += 1) {
    for (let j = i + 1; j < chosenNodes.length; j += 1) {
      const route = cheapest(chosenNodes[i]!, chosenNodes[j]!);
      if (!route) continue;
      routes.push({ cost: route.cost, path: { between: [chosenNodes[i]!, chosenNodes[j]!], edges: route.edges, through: route.nodes.slice(1, -1) } });
    }
  }
  routes.sort((a, b) => a.cost - b.cost);
  const added: string[] = [];
  const paths: ModeledJoinPath[] = [];
  for (const { path } of routes) {
    const fresh = path.through.filter((node) => !added.includes(node));
    if (added.length + fresh.length > maxAdded) continue;
    added.push(...fresh);
    paths.push(path);
  }
  return { paths, added };
}

/** A table that only marks rows of another: it holds nothing but the one-to-one key. */
export interface MarkerTable {
  marker: string;
  base: string;
  /** Key pairs oriented marker → base. */
  keys: Array<{ from: string; to: string }>;
  relationshipName: string;
}

/**
 * MARKER TABLES. A modeled one-to-one relationship whose one side has no
 * column besides its key (a `premium` table holding only a policy amount id)
 * says that side is a kind of the other: its rows mark which base rows belong
 * to it, and the values live on the base. An AI drafting SQL over the marker
 * alone finds "no amount column" and stops; told what the marker means, it
 * joins the base to it and uses the base's values.
 */
export function markerTables(
  relations: string[],
  edges: ModelingRelationshipEdge[],
  columnsOf: (relation: string) => string[],
): MarkerTable[] {
  const found: MarkerTable[] = [];
  const onlyKeys = (relation: string, keys: string[]) => {
    const columns = columnsOf(relation).map((column) => column.toLowerCase());
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    return columns.length > 0 && columns.every((column) => wanted.has(column));
  };
  for (const edge of edges) {
    if (edge.cardinality !== 'one_to_one') continue;
    const sides: Array<[string, string, Array<{ from: string; to: string }>]> = [
      [edge.fromRelation, edge.toRelation, edge.keys],
      [edge.toRelation, edge.fromRelation, edge.keys.map((key) => ({ from: key.to, to: key.from }))],
    ];
    for (const [marker, base, keys] of sides) {
      const chosen = relations.find((relation) => sameRelation(relation, marker));
      if (!chosen) continue;
      if (!onlyKeys(chosen, keys.map((key) => key.from))) continue;
      // A base that is itself only keys marks nothing; skip a key-only pair.
      const baseChosen = relations.find((relation) => sameRelation(relation, base));
      if (baseChosen && onlyKeys(baseChosen, keys.map((key) => key.to))) continue;
      if (found.some((item) => sameRelation(item.marker, marker) && sameRelation(item.base, base))) continue;
      found.push({ marker: chosen, base: baseChosen ?? base, keys, relationshipName: edge.name });
    }
  }
  return found;
}

/** The line an AI drafting SQL reads for one marker table. */
export function markerTableLine(item: MarkerTable): string {
  const name = (relation: string) => relation.split('.').pop()!.replace(/"/g, '');
  const on = item.keys.map((key) => `${item.marker}.${key.from} = ${item.base}.${key.to}`).join(' AND ');
  return `- ${item.marker} holds no values of its own (only its key): a row in it marks the ${item.base} row with the same key as a ${name(item.marker).replace(/_/g, ' ')} (modeled one-to-one: ${item.relationshipName}). For "${name(item.marker).replace(/_/g, ' ')}" values, use the ${item.base} rows that have a matching ${item.marker} row (JOIN ${item.marker} ON ${on}); the values are the columns of ${item.base}.`;
}
