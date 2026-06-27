import { z } from 'zod';
import {
  queryLineage,
  queryCompleteLineagePaths,
  computeImpact,
  type ChangedBlock,
} from '@duckcodeailabs/dql-core';
import type { DQLContext } from '../context.js';

export const lineageImpactInput = {
  focus: z.string().describe('Node id ("block:revenue") or bare name — resolved against the lineage graph.'),
  upstreamDepth: z.number().int().min(0).max(20).optional(),
  downstreamDepth: z.number().int().min(0).max(20).optional(),
  paths: z
    .boolean()
    .optional()
    .describe('When true, include full source→leaf paths (slower on large graphs).'),
  recert: z
    .boolean()
    .optional()
    .describe(
      'When true, treat `focus` as a changed block and return the re-cert impact: ' +
        'full transitive downstream, invalidated cross-domain edges, domainTrust delta, ' +
        'and the certified artifacts that require re-certification.',
    ),
  nonSemantic: z
    .boolean()
    .optional()
    .describe(
      'When true with `recert`, treats the change as non-semantic (description/comment/tag only) ' +
        'so no re-cert is required. Default false (conservative: assume semantic).',
    ),
};

export function lineageImpact(
  ctx: DQLContext,
  args: {
    focus: string;
    upstreamDepth?: number;
    downstreamDepth?: number;
    paths?: boolean;
    recert?: boolean;
    nonSemantic?: boolean;
  },
) {
  const graph = ctx.lineageGraph;
  const result = queryLineage(graph, {
    focus: args.focus,
    upstreamDepth: args.upstreamDepth,
    downstreamDepth: args.downstreamDepth,
  });

  if (!result.focalNode) {
    return { error: `No node matches "${args.focus}".` };
  }

  const response: Record<string, unknown> = {
    focalNode: result.focalNode,
    nodeCount: result.graph.nodes.length,
    edgeCount: result.graph.edges.length,
    nodes: result.graph.nodes,
    edges: result.graph.edges,
  };

  if (args.paths) {
    const paths = queryCompleteLineagePaths(graph, result.focalNode.id);
    if (paths) {
      response.upstreamPaths = paths.upstreamPaths.map(formatPath);
      response.downstreamPaths = paths.downstreamPaths.map(formatPath);
      response.layerSummary = paths.layerSummary;
    }
  }

  // Re-cert impact: treat the focal block as changed and compute the
  // downstream invalidation + required re-cert list. Mirrors the
  // `dql diff --impact` CLI gate, surfaced structurally for agents.
  if (args.recert) {
    const blockName =
      result.focalNode.type === 'block'
        ? result.focalNode.name
        : result.focalNode.id.replace(/^block:/, '');
    const changed: ChangedBlock = {
      name: blockName,
      verdict: args.nonSemantic ? 'non-semantic' : 'semantic',
      changedFields: [],
      structural: false,
    };
    const impact = computeImpact(graph, [changed]);
    response.impact = {
      changedBlocks: impact.changedBlocks,
      semanticChanges: impact.semanticChanges,
      downstream: impact.downstream,
      crossDomainImpacts: impact.crossDomainImpacts,
      requiresRecert: impact.requiresRecert,
      domainTrustDelta: impact.domainTrustDelta,
      hasCertifiedInvalidation: impact.hasCertifiedInvalidation,
    };
  }

  return response;
}

function formatPath(path: { nodes: Array<{ id: string; name: string; type: string }>; layers: string[] }) {
  return {
    chain: path.nodes.map((n) => `${n.type}:${n.name}`).join(' → '),
    layers: path.layers,
  };
}
