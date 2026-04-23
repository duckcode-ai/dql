import { z } from 'zod';
import type { DQLContext } from '../context.js';
import type { ManifestBlock } from '@duckcodeailabs/dql-core';

export const searchBlocksInput = {
  query: z.string().optional().describe('Substring matched against name, description, or tags.'),
  domain: z.string().optional().describe('Filter to a single business domain.'),
  status: z
    .enum(['draft', 'review', 'certified', 'deprecated', 'pending_recertification'])
    .optional()
    .describe('Filter by certification status.'),
  limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50).'),
};

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
  };
}
