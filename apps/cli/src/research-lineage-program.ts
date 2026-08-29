/**
 * Research lineage program
 *
 * `check_lineage` is a structural evidence program, not an analytical Ask.
 * It is deliberately kept outside the Ask router/provider/SQL/repair loop so
 * that an investigation can inspect a frozen graph without spending a model
 * dispatch or turning an edge into a query result.
 */
import { createHash } from 'node:crypto';
import {
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
} from '@duckcodeailabs/dql-core';
import type {
  ResearchLineageEvidenceReceiptV1,
  ResearchLineageNodeTypeV1,
  ResearchLineageResolutionV1,
} from '@duckcodeailabs/dql-agent';

export const RESEARCH_LINEAGE_MAX_DEPTH = 6;
export const RESEARCH_LINEAGE_MAX_PATHS = 12;
export const RESEARCH_LINEAGE_MAX_NODES = 96;
export const RESEARCH_LINEAGE_MAX_EDGES = 160;

export interface ResearchLineageProgramInputV1 {
  graph?: LineageGraph;
  graphFingerprint?: string;
  target: string;
  /** The frozen root snapshot. A graph constructed from another snapshot is stale. */
  expectedSnapshotId?: string;
  currentSnapshotId?: string;
  snapshotFingerprint?: string;
  snapshotStale?: boolean;
  maxDepth?: number;
  maxPaths?: number;
  maxNodes?: number;
  maxEdges?: number;
  /** Checked throughout the bounded local walk; it never starts a repair. */
  signal?: AbortSignal;
}

export interface ResearchLineageProgramResultV1 {
  receipt: ResearchLineageEvidenceReceiptV1;
  /** A concise, non-causal story for a Research inspector or synthesis. */
  summary: string;
}

interface TraversalLimits {
  maxDepth: number;
  maxPaths: number;
  maxNodes: number;
  maxEdges: number;
}

interface BoundedTraversal {
  nodeIds: Set<string>;
  edgeKeys: Set<string>;
  pathCount: number;
  truncated: boolean;
}

/**
 * Shared across both directions. The caps therefore constrain the whole
 * structural program rather than allowing each direction to independently
 * consume a full node/edge allowance. `remainingWork` additionally prevents
 * a high-fanout DAG from spending unbounded CPU merely inspecting adjacency.
 */
interface TraversalBudget {
  nodeIds: Set<string>;
  edgeKeys: Set<string>;
  remainingWork: number;
  /** Shared across both directions; terminal routes cannot exceed maxPaths. */
  remainingPaths: number;
  /** Resolver retains at most two exact-name candidates: enough to prove ambiguity. */
  remainingCandidates: number;
}

interface TargetResolution {
  node?: LineageNode;
  candidateCount: number;
  resolution: ResearchLineageResolutionV1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The direct program accepts local runtime identities, but the receipt is
 * portable. Preserve a canonical digest when the caller already supplied one;
 * otherwise hash it before it crosses the structural-evidence boundary.
 */
function opaqueFingerprint(value: string | undefined, unavailable = 'unavailable'): string {
  const normalized = value?.trim();
  if (!normalized) return unavailable;
  if (/^[a-f0-9]{64}$/i.test(normalized)) return normalized.toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/i.test(normalized)) return normalized.toLowerCase();
  return sha256(normalized);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function limitsOf(input: ResearchLineageProgramInputV1): TraversalLimits {
  return {
    maxDepth: boundedInteger(input.maxDepth, RESEARCH_LINEAGE_MAX_DEPTH, RESEARCH_LINEAGE_MAX_DEPTH),
    maxPaths: boundedInteger(input.maxPaths, RESEARCH_LINEAGE_MAX_PATHS, RESEARCH_LINEAGE_MAX_PATHS),
    maxNodes: boundedInteger(input.maxNodes, RESEARCH_LINEAGE_MAX_NODES, RESEARCH_LINEAGE_MAX_NODES),
    maxEdges: boundedInteger(input.maxEdges, RESEARCH_LINEAGE_MAX_EDGES, RESEARCH_LINEAGE_MAX_EDGES),
  };
}

function nodeType(node: LineageNode | undefined): ResearchLineageNodeTypeV1 | undefined {
  return node?.type as ResearchLineageNodeTypeV1 | undefined;
}

function edgeKey(edge: LineageEdge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
}

/**
 * The planner target is a qualified hint from the frozen research plan, but
 * different DQL surfaces encode the same semantic object differently. These
 * are authority-preserving, qualified aliases only; no bare metric leaf,
 * lexical, or fuzzy fallback is permitted.
 */
function canonicalQualifiedAliases(rawTarget: string): string[] {
  const raw = rawTarget.trim().toLowerCase();
  if (!raw) return [];
  const aliases = new Set<string>();
  const semantic = raw.match(/^semantic:(?:(metric|dimension):)?(.+)$/);
  if (!semantic) return [];
  const kind = semantic[1];
  const qualifiedBody = semantic[2]!.trim().replace(/:/g, '.');
  if (!qualifiedBody) return [];
  if (kind) {
    aliases.add(`${kind}:${qualifiedBody}`);
  } else {
    // A `semantic:<qualified-model>:<field>` target can be either a metric
    // or dimension only when the graph itself has exactly one qualified ID.
    aliases.add(`metric:${qualifiedBody}`);
    aliases.add(`dimension:${qualifiedBody}`);
  }
  aliases.delete(raw);
  return [...aliases];
}

function isQualifiedTarget(rawTarget: string): boolean {
  return /^[a-z_]+:/i.test(rawTarget.trim());
}

/**
 * Exact resolution only. A unique exact ID wins. A semantic alias can map only
 * to one fully-qualified node ID. Exact display names are permitted only for
 * unqualified planner targets. A qualified request may never degrade to a
 * bare leaf name such as `gross_revenue` in another model/domain. An
 * unqualified display name may be accepted only after the bounded local scan
 * proves it unique; a cap-reached scan is typed unavailable rather than a
 * first-match selection.
 */
function resolveResearchLineageTargetV1(
  graph: LineageGraph,
  target: string,
  budget: TraversalBudget,
  signal: AbortSignal | undefined,
): TargetResolution {
  const supplied = target.trim();
  const raw = supplied.toLowerCase();
  if (!raw) return { candidateCount: 0, resolution: 'missing' };
  // Qualified graph IDs are map lookups, not a project-wide search. This
  // keeps the direct structural program bounded even on a graph with a very
  // high fanout or node count.
  const exactId = graph.getNode(supplied) ?? graph.getNode(raw);
  if (exactId) return { node: exactId, candidateCount: 1, resolution: 'exact_id' };

  const aliasesById = new Map<string, LineageNode>();
  for (const alias of canonicalQualifiedAliases(target)) {
    const node = graph.getNode(alias);
    if (node) aliasesById.set(node.id, node);
  }
  const aliases = [...aliasesById.values()];
  if (aliases.length === 1) {
    return { node: aliases[0], candidateCount: 1, resolution: 'canonical_alias' };
  }
  if (aliases.length > 1) return { candidateCount: aliases.length, resolution: 'ambiguous' };

  // Qualified targets have already exhausted their exact node authority. Do
  // not let a display-name match silently substitute another model/domain.
  if (isQualifiedTarget(target)) return { candidateCount: 0, resolution: 'missing' };
  const exactNames: LineageNode[] = [];
  let stoppedForWork = false;
  let stoppedForAmbiguity = false;
  let stoppedForCandidateCap = false;
  const completed = graph.visitNodes((node) => {
    throwIfAborted(signal);
    if (!consumeTraversalWork(budget)) {
      stoppedForWork = true;
      return false;
    }
    if (node.name.trim().toLowerCase() !== raw) return true;
    if (budget.remainingCandidates <= 0) {
      stoppedForCandidateCap = true;
      return false;
    }
    budget.remainingCandidates -= 1;
    exactNames.push(node);
    // The second exact candidate proves ambiguity. Stop without scanning or
    // retaining unrelated graph content beyond the bounded candidate budget.
    if (exactNames.length >= 2) {
      stoppedForAmbiguity = true;
      return false;
    }
    return true;
  });
  if (stoppedForAmbiguity) return { candidateCount: exactNames.length, resolution: 'ambiguous' };
  if (!completed || stoppedForWork || stoppedForCandidateCap) {
    // A single candidate is not authority without a completed exact-name
    // scan: another same-name object could be beyond the bounded prefix.
    return { candidateCount: exactNames.length, resolution: 'unavailable' };
  }
  if (exactNames.length === 1) return { node: exactNames[0], candidateCount: 1, resolution: 'exact_name' };
  return { candidateCount: 0, resolution: 'missing' };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error('Research lineage traversal was cancelled.');
}

function consumeTraversalWork(budget: TraversalBudget): boolean {
  if (budget.remainingWork <= 0) return false;
  budget.remainingWork -= 1;
  return true;
}

function traverseBounded(
  graph: LineageGraph,
  rootId: string,
  direction: 'upstream' | 'downstream',
  limits: TraversalLimits,
  budget: TraversalBudget,
  signal: AbortSignal | undefined,
): BoundedTraversal {
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const stack: Array<{ id: string; depth: number; path: ReadonlySet<string> }> = [{
    id: rootId,
    depth: 0,
    path: new Set([rootId]),
  }];
  let pathCount = 0;
  let truncated = false;

  const recordTerminalRoute = () => {
    if (budget.remainingPaths <= 0) {
      truncated = true;
      return false;
    }
    budget.remainingPaths -= 1;
    pathCount += 1;
    return true;
  };

  if (budget.remainingPaths <= 0) {
    return { nodeIds, edgeKeys, pathCount, truncated: true };
  }

  while (stack.length > 0) {
    throwIfAborted(signal);
    if (!consumeTraversalWork(budget)) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    // Do not copy/sort the whole adjacency list: a high-fanout node can have
    // millions of edges. The graph builder's insertion order is snapshot
    // deterministic; the shared work budget makes the prefix we inspect both
    // deterministic and bounded.
    const edges = direction === 'upstream'
      ? graph.getIncomingEdges(current.id)
      : graph.getOutgoingEdges(current.id);
    let foundTraversableEdge = false;
    for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
      throwIfAborted(signal);
      if (!consumeTraversalWork(budget)) {
        truncated = true;
        break;
      }
      const edge = edges[edgeIndex]!;
      const nextId = direction === 'upstream' ? edge.source : edge.target;
      // A cyclic graph is valid lineage data.  Do not re-enter the current
      // path, and do not call a benign cycle a truncation/failure.
      if (current.path.has(nextId)) continue;
      foundTraversableEdge = true;
      if (current.depth >= limits.maxDepth) {
        recordTerminalRoute();
        truncated = true;
        break;
      }
      const key = edgeKey(edge);
      const newEdge = !budget.edgeKeys.has(key);
      const newNode = !budget.nodeIds.has(nextId);
      if (newEdge && budget.edgeKeys.size >= limits.maxEdges) {
        truncated = true;
        break;
      }
      if (newNode && budget.nodeIds.size >= limits.maxNodes) {
        truncated = true;
        break;
      }
      if (newEdge) budget.edgeKeys.add(key);
      if (newNode) budget.nodeIds.add(nextId);
      edgeKeys.add(key);
      nodeIds.add(nextId);
      stack.push({
        id: nextId,
        depth: current.depth + 1,
        path: new Set([...current.path, nextId]),
      });
    }
    if (!foundTraversableEdge) recordTerminalRoute();
    if (budget.remainingPaths <= 0 && stack.length > 0) {
      truncated = true;
      break;
    }
  }
  return { nodeIds, edgeKeys, pathCount, truncated };
}

function noCallCounters(): ResearchLineageEvidenceReceiptV1['zeroCallCounters'] {
  return { providerCalls: 0, sqlExecutions: 0, warehouseExecutions: 0, repairAttempts: 0 };
}

function baseReceipt(input: ResearchLineageProgramInputV1, limits: TraversalLimits): Pick<
  ResearchLineageEvidenceReceiptV1,
  'version' | 'evidenceKind' | 'snapshotId' | 'snapshotFingerprint' | 'graphFingerprint' | 'targetFingerprint'
  | 'upstreamNodeCount' | 'downstreamNodeCount' | 'upstreamPathCount' | 'downstreamPathCount'
  | 'traversedNodeCount' | 'traversedEdgeCount' | 'maxDepth' | 'maxPaths' | 'maxNodes' | 'maxEdges'
  | 'truncated' | 'validator' | 'zeroCallCounters'
> {
  return {
    version: 1,
    evidenceKind: 'lineage_graph',
    ...(input.expectedSnapshotId ? { snapshotId: opaqueFingerprint(input.expectedSnapshotId) } : {}),
    ...(input.snapshotFingerprint ? { snapshotFingerprint: opaqueFingerprint(input.snapshotFingerprint) } : {}),
    graphFingerprint: opaqueFingerprint(input.graphFingerprint),
    targetFingerprint: sha256(input.target.trim()),
    upstreamNodeCount: 0,
    downstreamNodeCount: 0,
    upstreamPathCount: 0,
    downstreamPathCount: 0,
    traversedNodeCount: 0,
    traversedEdgeCount: 0,
    maxDepth: limits.maxDepth,
    maxPaths: limits.maxPaths,
    maxNodes: limits.maxNodes,
    maxEdges: limits.maxEdges,
    truncated: false,
    validator: {
      version: 1,
      kind: 'structural_dependency',
      evaluated: false,
      outcome: 'inconclusive',
      nonCausal: true,
    },
    zeroCallCounters: noCallCounters(),
  };
}

export function runResearchLineageProgramV1(input: ResearchLineageProgramInputV1): ResearchLineageProgramResultV1 {
  throwIfAborted(input.signal);
  const limits = limitsOf(input);
  const base = baseReceipt(input, limits);
  if (input.snapshotStale || (input.expectedSnapshotId && input.currentSnapshotId && input.expectedSnapshotId !== input.currentSnapshotId)) {
    return {
      receipt: {
        ...base,
        status: 'stale',
        resolution: 'stale',
        candidateCount: 0,
      },
      summary: 'Lineage evidence was not used because the frozen Research snapshot is stale. Refresh the source snapshot and retry.',
    };
  }
  if (!input.graph) {
    return {
      receipt: {
        ...base,
        status: 'unavailable',
        resolution: 'unavailable',
        candidateCount: 0,
      },
      summary: 'Lineage evidence is unavailable in this local project. Rebuild the local graph and retry.',
    };
  }
  const budget: TraversalBudget = {
    nodeIds: new Set(),
    edgeKeys: new Set(),
    remainingWork: limits.maxNodes + limits.maxEdges + limits.maxPaths,
    remainingPaths: limits.maxPaths,
    remainingCandidates: 2,
  };
  const resolution = resolveResearchLineageTargetV1(input.graph, input.target, budget, input.signal);
  if (!resolution.node) {
    const status = resolution.resolution === 'ambiguous'
      ? 'ambiguous'
      : resolution.resolution === 'unavailable'
        ? 'unavailable'
        : 'missing';
    return {
      receipt: {
        ...base,
        status,
        resolution: resolution.resolution,
        candidateCount: resolution.candidateCount,
      },
      summary: status === 'ambiguous'
        ? 'Lineage evidence could not choose one exact target from the frozen graph. Narrow the governed target and retry.'
        : status === 'unavailable'
          ? 'Lineage evidence could not complete bounded exact-target resolution in the frozen local graph. No broader search or query was attempted.'
          : 'Lineage evidence did not find the exact frozen target in the local graph. Refresh or model the target before retrying.',
    };
  }
  // This is the only post-resolution graph work. It owns every retained
  // predicate/count/fingerprint and shares caps across directions. In
  // particular, do not call the older focused/path helpers here: they can
  // materialize an unbounded high-fanout subgraph before these caps apply.
  budget.nodeIds.add(resolution.node.id);
  const upstream = traverseBounded(input.graph, resolution.node.id, 'upstream', limits, budget, input.signal);
  const downstream = traverseBounded(input.graph, resolution.node.id, 'downstream', limits, budget, input.signal);
  const truncated = upstream.truncated || downstream.truncated;
  const structuralNodes = new Set([...budget.nodeIds]);
  structuralNodes.delete(resolution.node.id);
  const structuralEdges = new Set([...budget.edgeKeys]);
  const structuralFingerprint = sha256([
    resolution.node.id,
    ...[...structuralNodes].sort(),
    ...[...structuralEdges].sort(),
  ].join('\u0000'));
  const observedDependency = structuralEdges.size > 0;
  const receipt: ResearchLineageEvidenceReceiptV1 = {
    ...base,
    status: truncated ? 'truncated' : 'completed',
    resolution: resolution.resolution,
    candidateCount: resolution.candidateCount,
    ...(nodeType(resolution.node) ? { targetType: nodeType(resolution.node) } : {}),
    upstreamNodeCount: upstream.nodeIds.size,
    downstreamNodeCount: downstream.nodeIds.size,
    upstreamPathCount: upstream.pathCount,
    downstreamPathCount: downstream.pathCount,
    traversedNodeCount: structuralNodes.size,
    traversedEdgeCount: structuralEdges.size,
    truncated,
    structuralFingerprint,
    validator: {
      version: 1,
      kind: 'structural_dependency',
      evaluated: true,
      outcome: observedDependency ? 'dependency_observed' : 'inconclusive',
      nonCausal: true,
    },
  };
  return {
    receipt,
    summary: truncated
      ? 'Lineage evidence inspected a bounded portion of the frozen local graph. The structural view is incomplete and is not causal evidence.'
      : observedDependency
        ? 'Lineage evidence found bounded structural dependencies in the frozen local graph. It does not establish a causal explanation.'
        : 'Lineage evidence found no traversable structural dependency for the exact frozen target. This is not causal evidence.',
  };
}
