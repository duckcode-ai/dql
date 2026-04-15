import { LineageGraph, type LineageGraphJSON, type LineageNode, type LineageNodeType } from './lineage-graph.js';

export interface LineageQuery {
  focus?: string;
  search?: string;
  types?: LineageNodeType[];
  domain?: string;
  upstreamDepth?: number;
  downstreamDepth?: number;
}

export interface LineageQueryResult {
  graph: LineageGraphJSON;
  focalNode?: LineageNode;
  matches?: Array<{ node: LineageNode; score: number }>;
}

const NODE_PREFIXES: LineageNodeType[] = [
  'block',
  'dashboard',
  'dbt_model',
  'dbt_source',
  'source_table',
  'metric',
  'dimension',
  'domain',
  'chart',
];

export function queryLineage(graph: LineageGraph, query: LineageQuery): LineageQueryResult {
  const matches = query.search ? searchLineage(graph, query.search) : [];
  const focalNode = query.focus ? resolveFocusNode(graph, query.focus) : undefined;

  let resultGraph = focalNode
    ? buildFocusedSubgraph(
        graph,
        focalNode.id,
        query.upstreamDepth,
        query.downstreamDepth,
      )
    : graph;

  if (query.types?.length || query.domain) {
    const allowedTypes = query.types ? new Set(query.types) : null;
    resultGraph = resultGraph.subgraph((node) => {
      if (allowedTypes && !allowedTypes.has(node.type)) return false;
      if (query.domain && node.domain !== query.domain) return false;
      return true;
    });
  }

  if (!query.focus && query.search) {
    const matchIds = new Set(matches.map((match) => match.node.id));
    resultGraph = graph.subgraph((node) => {
      if (query.domain && node.domain !== query.domain) return false;
      if (query.types?.length && !query.types.includes(node.type)) return false;
      return matchIds.has(node.id);
    });
  }

  return {
    graph: resultGraph.toJSON(),
    focalNode,
    matches,
  };
}

function buildFocusedSubgraph(
  graph: LineageGraph,
  focusId: string,
  upstreamDepth?: number,
  downstreamDepth?: number,
): LineageGraph {
  const includedIds = new Set<string>([focusId]);

  walkDirection(graph, focusId, 'upstream', normalizeDepth(upstreamDepth), includedIds);
  walkDirection(graph, focusId, 'downstream', normalizeDepth(downstreamDepth), includedIds);

  return graph.subgraph((node) => includedIds.has(node.id));
}

function walkDirection(
  graph: LineageGraph,
  startId: string,
  direction: 'upstream' | 'downstream',
  maxDepth: number,
  includedIds: Set<string>,
): void {
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
  const seen = new Set<string>([startId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const edges = direction === 'upstream'
      ? graph.getIncomingEdges(current.id)
      : graph.getOutgoingEdges(current.id);

    for (const edge of edges) {
      const nextId = direction === 'upstream' ? edge.source : edge.target;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      includedIds.add(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }
}

function normalizeDepth(depth: number | undefined): number {
  return depth === undefined || !Number.isFinite(depth) || depth < 0
    ? Number.POSITIVE_INFINITY
    : depth;
}

function resolveFocusNode(graph: LineageGraph, rawFocus: string): LineageNode | undefined {
  if (graph.getNode(rawFocus)) return graph.getNode(rawFocus);

  for (const prefix of NODE_PREFIXES) {
    const candidate = graph.getNode(`${prefix}:${rawFocus}`);
    if (candidate) return candidate;
  }

  const normalized = rawFocus.trim().toLowerCase();
  return graph
    .getAllNodes()
    .find((node) => node.name.toLowerCase() === normalized);
}

function searchLineage(graph: LineageGraph, rawTerm: string): Array<{ node: LineageNode; score: number }> {
  const term = rawTerm.trim().toLowerCase();
  if (!term) return [];

  return graph
    .getAllNodes()
    .map((node) => ({
      node,
      score: scoreMatch(node, term),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name));
}

function scoreMatch(node: LineageNode, term: string): number {
  const name = node.name.toLowerCase();
  const id = node.id.toLowerCase();
  if (name === term || id === term) return 100;
  if (name.startsWith(term)) return 75;
  if (id.startsWith(term)) return 60;
  if (name.includes(term)) return 40;
  if (id.includes(term)) return 30;
  return 0;
}
