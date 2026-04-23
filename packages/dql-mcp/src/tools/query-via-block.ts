import { z } from 'zod';
import type { DQLContext } from '../context.js';

export const queryViaBlockInput = {
  name: z.string().describe('Certified block to execute.'),
  limit: z.number().int().min(1).max(10000).optional().describe('Max rows to return.'),
  serverUrl: z
    .string()
    .optional()
    .describe(
      'Base URL of the local DQL runtime (default http://127.0.0.1:3474). Start it with `dql serve`.',
    ),
};

/**
 * Execute a certified block by name. Delegates SQL prep + warehouse execution
 * to the local-runtime HTTP server, so results honor the same semantic resolver
 * and connection config as the notebook UI — the agent never sees raw SQL.
 */
export async function queryViaBlock(
  ctx: DQLContext,
  args: { name: string; limit?: number; serverUrl?: string },
) {
  const block = ctx.manifest.blocks[args.name];
  if (!block) return { error: `No block named "${args.name}".` };
  if (block.status !== 'certified') {
    return {
      error: `Block "${args.name}" is "${block.status ?? 'draft'}" — only certified blocks can be executed via MCP.`,
    };
  }

  const base = args.serverUrl ?? process.env.DQL_RUNTIME_URL ?? 'http://127.0.0.1:3474';
  const url = `${base.replace(/\/$/, '')}/api/query`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sql: block.sql,
        blockName: args.name,
        limit: args.limit,
      }),
    });
  } catch (err) {
    return {
      error: `Could not reach DQL runtime at ${base}. Start it with \`dql serve\` in ${ctx.projectRoot}. (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (!response.ok) {
    return { error: `Runtime returned ${response.status}: ${await response.text()}` };
  }

  const payload = (await response.json()) as {
    columns?: Array<{ name: string; type?: string }>;
    rows?: unknown[][];
    durationMs?: number;
  };

  return {
    block: args.name,
    blockPath: block.filePath,
    rowCount: payload.rows?.length ?? 0,
    durationMs: payload.durationMs ?? null,
    columns: payload.columns ?? [],
    rows: payload.rows ?? [],
  };
}
