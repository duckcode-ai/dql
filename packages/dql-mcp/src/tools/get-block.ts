import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DQLContext } from '../context.js';

export const getBlockInput = {
  name: z.string().describe('Block name (as shown in search_blocks).'),
  includeSource: z
    .boolean()
    .optional()
    .describe('When true, include the full .dql source text. Default true.'),
};

export function getBlock(
  ctx: DQLContext,
  args: { name: string; includeSource?: boolean },
) {
  const block = ctx.manifest.blocks[args.name];
  if (!block) {
    return { error: `No block named "${args.name}". Run search_blocks first.` };
  }

  const absPath = join(ctx.projectRoot, block.filePath);
  const source =
    args.includeSource !== false && existsSync(absPath)
      ? readFileSync(absPath, 'utf-8')
      : null;

  return {
    name: block.name,
    path: block.filePath,
    domain: block.domain ?? null,
    owner: block.owner ?? null,
    status: block.status ?? 'draft',
    description: block.description ?? null,
    tags: block.tags ?? [],
    chartType: block.chartType ?? null,
    metricRef: block.metricRef ?? null,
    dependencies: {
      tables: block.tableDependencies,
      refs: block.refDependencies,
      metrics: block.metricRefs ?? [],
      dimensions: block.dimensionRefs ?? [],
    },
    tests: block.tests,
    sql: block.sql,
    source,
  };
}
