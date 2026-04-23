import { z } from 'zod';
import { queryLineage, queryCompleteLineagePaths } from '@duckcodeailabs/dql-core';
import type { DQLContext } from '../context.js';

export const lineageImpactInput = {
  focus: z.string().describe('Node id ("block:revenue") or bare name — resolved against the lineage graph.'),
  upstreamDepth: z.number().int().min(0).max(20).optional(),
  downstreamDepth: z.number().int().min(0).max(20).optional(),
  paths: z
    .boolean()
    .optional()
    .describe('When true, include full source→leaf paths (slower on large graphs).'),
};

export function lineageImpact(
  ctx: DQLContext,
  args: {
    focus: string;
    upstreamDepth?: number;
    downstreamDepth?: number;
    paths?: boolean;
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

  return response;
}

function formatPath(path: { nodes: Array<{ id: string; name: string; type: string }>; layers: string[] }) {
  return {
    chain: path.nodes.map((n) => `${n.type}:${n.name}`).join(' → '),
    layers: path.layers,
  };
}
