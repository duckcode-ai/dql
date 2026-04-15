/**
 * Lineage Query Engine — focused, searchable lineage views.
 *
 * Replaces the "show everything" approach with targeted subgraph queries:
 * - Focus on a specific node and get its upstream/downstream chain
 * - Search nodes by name across all types
 * - Filter by type, domain, depth
 */

import { LineageGraph, type LineageNode, type LineageNodeType, type LineageGraphJSON } from './lineage-graph.js';

// ---- Query Types ----

export interface LineageQuery {
  /** Node name or ID to center the query on */
  focus?: string;
  /** Search by name (case-insensitive substring match) */
  search?: string;
  /** Filter by node types */
  types?: LineageNodeType[];
  /** Filter by domain */
  domain?: string;
  /** Max hops upstream from focal node (default: Infinity) */
  upstreamDepth?: number;
  /** Max hops downstream from focal node (default: Infinity) */
  downstreamDepth?: number;
}

export interface LineageQueryResult {
  /** Focused subgraph containing only relevant nodes and edges */
  graph: LineageGraphJSON;
  /** The focal node (if focus was specified and resolved) */
  focalNode?: LineageNode;
  /** Search matches with relevance scores (if search was specified) */
  matches?: Array<{ node: LineageNode; score: number }>;
}

// ---- Node ID Resolution ----

/** Type prefixes to try when resolving a name to a node ID */
const NODE_PREFIXES = [
  'block:',
  'metric:',
  'table:',
  'dbt_model:',
  'dbt_source:',
  'dashboard:',
  'dimension:',
  'chart:',
  'domain:',
];

/**
 * Resolve a name or ID to a node in the graph.
 * Tries exact match first, then prefixed matches.
 */
function resolveNode(graph: LineageGraph, nameOrId: string): LineageNode | undefined {
  // Exact match (already prefixed)
  const exact = graph.getNode(nameOrId);
  if (exact) return exact;

  // Try each prefix
  for (const prefix of NODE_PREFIXES) {
    const node = graph.getNode(`${prefix}${nameOrId}`);
    if (node) return node;
  }

  // Fuzzy: find first node whose name matches (case-insensitive)
  const lower = nameOrId.toLowerCase();
  for (const node of graph.getAllNodes()) {
    if (node.name.toLowerCase() === lower) return node;
  }

  return undefined;
}

// ---- Search Scoring ----

function scoreMatch(nodeName: string, query: string): number {
  const name = nodeName.toLowerCase();
  const q = query.toLowerCase();

  if (name === q) return 100;             // exact match
  if (name.startsWith(q)) return 80;      // starts with
  if (name.endsWith(q)) return 60;        // ends with
  if (name.includes(q)) return 40;        // substring
  return 0;                                // no match
}

// ---- Depth-Limited BFS ----

/**
 * BFS traversal with depth limiting.
 * direction='upstream' follows incoming edges, 'downstream' follows outgoing.
 */
function depthLimitedBFS(
  graph: LineageGraph,
  startId: string,
  direction: 'upstream' | 'downstream',
  maxDepth: number,
): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    const edges = direction === 'upstream'
      ? graph.getIncomingEdges(id)
      : graph.getOutgoingEdges(id);

    for (const edge of edges) {
      const nextId = direction === 'upstream' ? edge.source : edge.target;
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ id: nextId, depth: depth + 1 });
      }
    }
  }

  return visited;
}

// ---- Query Execution ----

/**
 * Execute a lineage query against the graph.
 *
 * Examples:
 *   queryLineage(graph, { focus: 'total_revenue' })
 *     → subgraph centered on metric:total_revenue with full upstream/downstream
 *
 *   queryLineage(graph, { search: 'revenue' })
 *     → all nodes matching "revenue" with relevance scores
 *
 *   queryLineage(graph, { focus: 'fct_orders', upstreamDepth: 2, downstreamDepth: 1 })
 *     → 2 hops upstream, 1 hop downstream from dbt_model:fct_orders
 *
 *   queryLineage(graph, { domain: 'finance', types: ['metric', 'block'] })
 *     → all finance metrics and blocks with their immediate connections
 */
export function queryLineage(graph: LineageGraph, query: LineageQuery): LineageQueryResult {
  // Search mode: return matching nodes with scores
  if (query.search && !query.focus) {
    return executeSearch(graph, query);
  }

  // Focus mode: return subgraph centered on a node
  if (query.focus) {
    return executeFocus(graph, query);
  }

  // Filter mode: domain and/or type filter
  if (query.domain || query.types) {
    return executeFilter(graph, query);
  }

  // Default: return the full graph
  return { graph: graph.toJSON() };
}

function executeSearch(graph: LineageGraph, query: LineageQuery): LineageQueryResult {
  const searchTerm = query.search!;
  const matches: Array<{ node: LineageNode; score: number }> = [];

  for (const node of graph.getAllNodes()) {
    // Apply type filter
    if (query.types && !query.types.includes(node.type)) continue;
    // Apply domain filter
    if (query.domain && node.domain !== query.domain) continue;

    const score = scoreMatch(node.name, searchTerm);
    if (score > 0) {
      matches.push({ node, score });
    }
  }

  // Sort by score descending, then alphabetically
  matches.sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name));

  // Build a subgraph of matched nodes with their immediate edges
  const matchedIds = new Set(matches.map((m) => m.node.id));
  const sub = graph.subgraph((n) => matchedIds.has(n.id));

  return {
    graph: sub.toJSON(),
    matches,
  };
}

function executeFocus(graph: LineageGraph, query: LineageQuery): LineageQueryResult {
  const focalNode = resolveNode(graph, query.focus!);
  if (!focalNode) {
    return { graph: { nodes: [], edges: [] }, matches: [] };
  }

  const upstreamDepth = query.upstreamDepth ?? Infinity;
  const downstreamDepth = query.downstreamDepth ?? Infinity;

  // Collect all nodes in the focused subgraph
  const nodeIds = new Set<string>([focalNode.id]);

  // Upstream BFS
  const upstreamIds = depthLimitedBFS(graph, focalNode.id, 'upstream', upstreamDepth);
  for (const id of upstreamIds) nodeIds.add(id);

  // Downstream BFS
  const downstreamIds = depthLimitedBFS(graph, focalNode.id, 'downstream', downstreamDepth);
  for (const id of downstreamIds) nodeIds.add(id);

  // Apply type/domain filters if specified
  const sub = graph.subgraph((n) => {
    if (!nodeIds.has(n.id)) return false;
    if (query.types && !query.types.includes(n.type) && n.id !== focalNode.id) return false;
    if (query.domain && n.domain !== query.domain && n.id !== focalNode.id) return false;
    return true;
  });

  return {
    graph: sub.toJSON(),
    focalNode,
  };
}

function executeFilter(graph: LineageGraph, query: LineageQuery): LineageQueryResult {
  // Get matching nodes
  const matchedNodes = graph.getAllNodes().filter((n) => {
    if (query.types && !query.types.includes(n.type)) return false;
    if (query.domain && n.domain !== query.domain) return false;
    return true;
  });

  const matchedIds = new Set(matchedNodes.map((n) => n.id));

  // Also include immediate neighbors to show connections
  for (const node of matchedNodes) {
    for (const edge of graph.getIncomingEdges(node.id)) {
      matchedIds.add(edge.source);
    }
    for (const edge of graph.getOutgoingEdges(node.id)) {
      matchedIds.add(edge.target);
    }
  }

  const sub = graph.subgraph((n) => matchedIds.has(n.id));

  return { graph: sub.toJSON() };
}

/**
 * Lightweight search — returns matching nodes without building a subgraph.
 * Suitable for autocomplete / search-as-you-type.
 */
export function searchNodes(
  graph: LineageGraph,
  searchTerm: string,
  limit = 20,
): Array<{ node: LineageNode; score: number }> {
  const matches: Array<{ node: LineageNode; score: number }> = [];

  for (const node of graph.getAllNodes()) {
    const score = scoreMatch(node.name, searchTerm);
    if (score > 0) {
      matches.push({ node, score });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name));
  return matches.slice(0, limit);
}
