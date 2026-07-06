import type { DQLContext } from '../context.js';
import type { ManifestBlock } from '@duckcodeailabs/dql-core';
import { zodInputShapeForTool } from '../tool-schema.js';

export const searchBlocksInput = zodInputShapeForTool('search_blocks');

export function searchBlocks(
  ctx: DQLContext,
  args: {
    query?: string;
    domain?: string;
    status?: string;
    limit?: number;
  },
) {
  const { query, domain, status, limit = 50 } = args;
  const needle = query?.trim().toLowerCase();

  const blocks = Object.values(ctx.manifest.blocks).filter((block) => {
    if (domain && block.domain !== domain) return false;
    if (status && block.status !== status) return false;
    if (needle) {
      const haystack = [block.name, block.description ?? '', (block.tags ?? []).join(' ')]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const results = blocks.slice(0, limit).map(summarize);
  return {
    total: blocks.length,
    returned: results.length,
    blocks: results,
  };
}

function summarize(block: ManifestBlock) {
  return {
    name: block.name,
    path: block.filePath,
    domain: block.domain ?? null,
    owner: block.owner ?? null,
    status: block.status ?? 'draft',
    description: block.description ?? null,
    tags: block.tags ?? [],
    dependencies: block.allDependencies,
    chartType: block.chartType ?? null,
    // v1.2 Track G — agent-facing metadata. Surfaced so agents can prefer
    // blocks with richer grounding without a second tool round-trip.
    llmContext: block.llmContext ?? null,
    hasExamples: !!(block.examples && block.examples.length > 0),
    hasInvariants: !!(block.invariants && block.invariants.length > 0),
  };
}
