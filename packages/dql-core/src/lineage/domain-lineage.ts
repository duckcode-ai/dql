/**
 * Domain-specific lineage analysis — DQL's key differentiator.
 *
 * Tracks how data flows across business domains, creating "trust chains"
 * where certified blocks serve as trust checkpoints. Enables impact analysis
 * across domain boundaries.
 */

import type { LineageGraph, LineageNode, LineageEdge } from './lineage-graph.js';

// ---- Trust Chain ----

export interface TrustChainNode {
  nodeId: string;
  name: string;
  domain?: string;
  status?: string;
  owner?: string;
  /** Whether this node is a trust checkpoint (certified block) */
  isTrustCheckpoint: boolean;
}

export interface TrustChain {
  /** Ordered nodes from source to target */
  nodes: TrustChainNode[];
  /** Number of certified checkpoints in the chain */
  certifiedCount: number;
  /** Number of uncertified nodes (trust gaps) */
  uncertifiedCount: number;
  /** Trust score: certified / total (0.0 to 1.0) */
  trustScore: number;
  /** Domain boundaries crossed */
  domainCrossings: Array<{ from: string; to: string }>;
}

// ---- Impact Analysis ----

export interface DomainImpact {
  /** Domain name */
  domain: string;
  /** Nodes in this domain that are affected */
  affectedNodes: Array<{ id: string; name: string; status?: string }>;
  /** Number of certified blocks affected */
  certifiedBlocksAffected: number;
}

export interface ImpactAnalysis {
  /** The source node being analyzed */
  sourceNode: string;
  /** Total downstream nodes affected */
  totalAffected: number;
  /** Breakdown by domain */
  domainImpacts: DomainImpact[];
  /** Cross-domain edges in the impact path */
  domainCrossings: Array<{ from: string; to: string; edgeCount: number }>;
}

// ---- Cross-Domain Flow ----

export interface DomainFlow {
  /** Source domain */
  from: string;
  /** Target domain */
  to: string;
  /** Edges connecting these domains */
  edges: LineageEdge[];
  /** Nodes at the boundary (source side) */
  sourceNodes: string[];
  /** Nodes at the boundary (target side) */
  targetNodes: string[];
}

/**
 * Build a trust chain from a source node to a target node.
 * Shows certification status at every step.
 */
export function buildTrustChain(
  graph: LineageGraph,
  fromId: string,
  toId: string,
): TrustChain | null {
  const path = graph.pathBetween(fromId, toId);
  if (path.length === 0) return null;

  const nodes: TrustChainNode[] = [];
  const domainCrossings: Array<{ from: string; to: string }> = [];

  let prevDomain: string | undefined;

  for (const nodeId of path) {
    const node = graph.getNode(nodeId);
    if (!node) continue;

    const isTrustCheckpoint = node.status === 'certified';
    nodes.push({
      nodeId: node.id,
      name: node.name,
      domain: node.domain,
      status: node.status,
      owner: node.owner,
      isTrustCheckpoint,
    });

    if (prevDomain && node.domain && prevDomain !== node.domain) {
      domainCrossings.push({ from: prevDomain, to: node.domain });
    }
    if (node.domain) prevDomain = node.domain;
  }

  const certifiedCount = nodes.filter((n) => n.isTrustCheckpoint).length;
  const total = nodes.length;

  return {
    nodes,
    certifiedCount,
    uncertifiedCount: total - certifiedCount,
    trustScore: total > 0 ? certifiedCount / total : 0,
    domainCrossings,
  };
}

/**
 * Analyze the impact of changing a node — which domains and blocks are affected downstream.
 */
export function analyzeImpact(graph: LineageGraph, nodeId: string): ImpactAnalysis {
  const descendants = graph.descendants(nodeId);

  // Group by domain
  const byDomain = new Map<string, LineageNode[]>();
  for (const node of descendants) {
    const domain = node.domain ?? '(unassigned)';
    const list = byDomain.get(domain) ?? [];
    list.push(node);
    byDomain.set(domain, list);
  }

  const domainImpacts: DomainImpact[] = [];
  for (const [domain, nodes] of byDomain) {
    domainImpacts.push({
      domain,
      affectedNodes: nodes.map((n) => ({ id: n.id, name: n.name, status: n.status })),
      certifiedBlocksAffected: nodes.filter((n) => n.status === 'certified').length,
    });
  }

  // Find domain crossings in the impact zone
  const descendantIds = new Set(descendants.map((n) => n.id));
  descendantIds.add(nodeId);
  const crossingMap = new Map<string, number>();
  const crossingEdges: Array<{ from: string; to: string; edgeCount: number }> = [];

  for (const edge of graph.getCrossDomainEdges()) {
    if (descendantIds.has(edge.source) && descendantIds.has(edge.target)) {
      const key = `${edge.sourceDomain}→${edge.targetDomain}`;
      crossingMap.set(key, (crossingMap.get(key) ?? 0) + 1);
    }
  }

  for (const [key, count] of crossingMap) {
    const [from, to] = key.split('→');
    crossingEdges.push({ from, to, edgeCount: count });
  }

  return {
    sourceNode: nodeId,
    totalAffected: descendants.length,
    domainImpacts,
    domainCrossings: crossingEdges,
  };
}

/**
 * Detect all cross-domain data flows in the graph.
 */
export function detectDomainFlows(graph: LineageGraph): DomainFlow[] {
  const flowMap = new Map<string, DomainFlow>();

  for (const edge of graph.getCrossDomainEdges()) {
    if (!edge.sourceDomain || !edge.targetDomain) continue;
    const key = `${edge.sourceDomain}→${edge.targetDomain}`;

    let flow = flowMap.get(key);
    if (!flow) {
      flow = {
        from: edge.sourceDomain,
        to: edge.targetDomain,
        edges: [],
        sourceNodes: [],
        targetNodes: [],
      };
      flowMap.set(key, flow);
    }

    flow.edges.push(edge);
    if (!flow.sourceNodes.includes(edge.source)) flow.sourceNodes.push(edge.source);
    if (!flow.targetNodes.includes(edge.target)) flow.targetNodes.push(edge.target);
  }

  return [...flowMap.values()];
}

/**
 * Get a trust overview for all blocks in a domain.
 */
export function getDomainTrustOverview(
  graph: LineageGraph,
  domain: string,
): {
  totalBlocks: number;
  certified: number;
  draft: number;
  review: number;
  deprecated: number;
  pendingRecertification: number;
  trustScore: number;
} {
  const nodes = graph.getNodesByDomain(domain).filter((n) => n.type === 'block');
  const total = nodes.length;

  const certified = nodes.filter((n) => n.status === 'certified').length;
  const draft = nodes.filter((n) => n.status === 'draft').length;
  const review = nodes.filter((n) => n.status === 'review').length;
  const deprecated = nodes.filter((n) => n.status === 'deprecated').length;
  const pendingRecertification = nodes.filter((n) => n.status === 'pending_recertification').length;

  return {
    totalBlocks: total,
    certified,
    draft,
    review,
    deprecated,
    pendingRecertification,
    trustScore: total > 0 ? certified / total : 0,
  };
}
