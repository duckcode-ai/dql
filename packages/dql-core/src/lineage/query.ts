import { LineageGraph, type LineageGraphJSON, type LineageNode, type LineageEdge, type LineageNodeType, type LineageLayer, getLayerForNodeType } from './lineage-graph.js';

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

// ---- Complete Lineage Paths ----

export interface LineagePath {
  /** Nodes in order from start to end of the path */
  nodes: LineageNode[];
  /** Edges connecting the nodes in sequence */
  edges: LineageEdge[];
  /** Layers traversed in order */
  layers: LineageLayer[];
}

export interface CompletePathResult {
  /** The focal node this query centered on */
  focalNode: LineageNode;
  /** Paths from sources (roots) to the focal node */
  upstreamPaths: LineagePath[];
  /** Paths from the focal node to consumption (leaves) */
  downstreamPaths: LineagePath[];
  /** Layer distribution summary */
  layerSummary: Record<LineageLayer, number>;
}

export interface CompletePathOptions {
  /** Maximum traversal depth (default 10) */
  maxDepth?: number;
  /** Maximum number of paths to return per direction (default 20) */
  maxPaths?: number;
}

/**
 * Compute complete lineage paths for a focal node.
 *
 * Upstream paths trace from source roots to the focal node.
 * Downstream paths trace from the focal node to consumption leaves.
 * Paths are deduplicated and capped to avoid explosion on large graphs.
 */
export function queryCompleteLineagePaths(
  graph: LineageGraph,
  focalNodeId: string,
  options: CompletePathOptions = {},
): CompletePathResult | null {
  const focalNode = resolveFocusNode(graph, focalNodeId);
  if (!focalNode) return null;

  const maxDepth = options.maxDepth ?? 10;
  const maxPaths = options.maxPaths ?? 20;

  const upstreamPaths = collectPaths(graph, focalNode.id, 'upstream', maxDepth, maxPaths);
  const downstreamPaths = collectPaths(graph, focalNode.id, 'downstream', maxDepth, maxPaths);

  // Count nodes per layer across all paths
  const layerSummary: Record<LineageLayer, number> = { source: 0, transform: 0, answer: 0, consumption: 0 };
  const counted = new Set<string>();
  for (const path of [...upstreamPaths, ...downstreamPaths]) {
    for (const node of path.nodes) {
      if (!counted.has(node.id)) {
        counted.add(node.id);
        const layer = node.layer ?? getLayerForNodeType(node.type);
        layerSummary[layer]++;
      }
    }
  }
  // Count focal node too
  if (!counted.has(focalNode.id)) {
    const focalLayer = focalNode.layer ?? getLayerForNodeType(focalNode.type);
    layerSummary[focalLayer]++;
  }

  return { focalNode, upstreamPaths, downstreamPaths, layerSummary };
}

/**
 * Collect all root-to-node (upstream) or node-to-leaf (downstream) paths using DFS.
 */
function collectPaths(
  graph: LineageGraph,
  startId: string,
  direction: 'upstream' | 'downstream',
  maxDepth: number,
  maxPaths: number,
): LineagePath[] {
  const paths: LineagePath[] = [];
  const currentPath: string[] = [startId];
  const currentEdges: LineageEdge[] = [];
  const visited = new Set<string>([startId]);

  function dfs(nodeId: string, depth: number): void {
    if (paths.length >= maxPaths) return;
    if (depth >= maxDepth) {
      // Reached max depth — emit this as a path
      emitPath();
      return;
    }

    const edges = direction === 'upstream'
      ? graph.getIncomingEdges(nodeId)
      : graph.getOutgoingEdges(nodeId);

    // Filter to non-visited neighbors
    const nextEdges = edges.filter((e) => {
      const nextId = direction === 'upstream' ? e.source : e.target;
      return !visited.has(nextId);
    });

    if (nextEdges.length === 0) {
      // Leaf/root — emit the path
      emitPath();
      return;
    }

    for (const edge of nextEdges) {
      if (paths.length >= maxPaths) return;
      const nextId = direction === 'upstream' ? edge.source : edge.target;
      visited.add(nextId);
      currentPath.push(nextId);
      currentEdges.push(edge);
      dfs(nextId, depth + 1);
      currentPath.pop();
      currentEdges.pop();
      visited.delete(nextId);
    }
  }

  function emitPath(): void {
    // Build the path in natural order (source → target)
    const nodeIds = direction === 'upstream' ? [...currentPath].reverse() : [...currentPath];
    const edgesCopy = direction === 'upstream' ? [...currentEdges].reverse() : [...currentEdges];

    const nodes = nodeIds
      .map((id) => graph.getNode(id))
      .filter((n): n is LineageNode => n !== undefined);

    const layers = nodes.map((n) => n.layer ?? getLayerForNodeType(n.type));
    // Deduplicate layers while preserving order
    const seenLayers = new Set<LineageLayer>();
    const uniqueLayers: LineageLayer[] = [];
    for (const layer of layers) {
      if (!seenLayers.has(layer)) {
        seenLayers.add(layer);
        uniqueLayers.push(layer);
      }
    }

    paths.push({ nodes, edges: edgesCopy, layers: uniqueLayers });
  }

  dfs(startId, 0);
  return paths;
}
