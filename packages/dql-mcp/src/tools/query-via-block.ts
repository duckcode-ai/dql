import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAnalysisQuestionPlan,
  grainMatches,
  requestedGrainFromPlan,
  type MetadataObject,
} from '@duckcodeailabs/dql-agent';
import type { DQLContext } from '../context.js';

export const queryViaBlockInput = {
  name: z.string().describe('Certified block to execute.'),
  limit: z.number().int().min(1).max(10000).optional().describe('Max rows to return.'),
  question: z
    .string()
    .optional()
    .describe(
      'Original question this block is being served for. When provided, query_via_block re-checks the block grain against the requested grain (defense in depth) and refuses on a genuine grain mismatch.',
    ),
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
  args: { name: string; limit?: number; question?: string; serverUrl?: string },
) {
  const block = ctx.manifest.blocks[args.name];
  if (!block) return { error: `No block named "${args.name}".` };
  if (block.status !== 'certified') {
    return {
      error: `Block "${args.name}" is "${block.status ?? 'draft'}" — only certified blocks can be executed via MCP.`,
    };
  }

  // Grain-gate defense in depth. When a question is provided, re-run the same
  // grain check the router uses before serving this certified block. A genuine
  // grain/entity mismatch is refused here even if the tool was called directly,
  // so a near-miss certified block can never be served as a confidently-wrong
  // governed answer. Behavior is unchanged when no question is supplied or when
  // the block / question carries no clearly-extractable grain.
  if (args.question) {
    const plan = buildAnalysisQuestionPlan(args.question);
    const requestedGrain = requestedGrainFromPlan(plan);
    const gate = grainMatches(blockToGrainObject(block), requestedGrain);
    if (!gate.allow) {
      return {
        error: `Block "${args.name}" failed the grain gate: ${gate.reason}. Refusing to serve a near-miss certified answer; generate SQL for the requested grain instead.`,
        routeReason: gate.reason,
        grainGate: {
          allow: gate.allow,
          kind: gate.kind,
          requestedGrain: gate.requestedGrainLabel,
          blockGrain: gate.blockGrainLabel,
        },
      };
    }
  }

  // v1.6 — DataLex contract enforcement (the wedge).
  // When a certified block declares datalex_contract, refuse the call if
  // the reference doesn't resolve in the project's loaded DataLex
  // manifest. We do NOT fail when no manifest is loaded — projects that
  // haven't adopted DataLex still work; the analyzer separately surfaces a
  // warning at compile time so the user is aware.
  const datalexContract = (block as { datalexContract?: string }).datalexContract;
  if (datalexContract && ctx.datalexRegistry.isLoaded()) {
    const resolution = ctx.datalexRegistry.resolve(datalexContract);
    if (!resolution.ok) {
      return {
        error: `Block "${args.name}" references DataLex contract "${datalexContract}" which ${resolution.reason === 'not_found' ? 'is not in the loaded DataLex manifest' : resolution.reason === 'version_mismatch' ? `pins a version that does not exist (available: ${(resolution.availableVersions ?? []).join(', ')})` : `is malformed (${resolution.message})`}. Refusing to serve until the contract resolves.`,
      };
    }
  }

  const base = args.serverUrl ?? process.env.DQL_RUNTIME_URL ?? 'http://127.0.0.1:3474';
  const url = `${base.replace(/\/$/, '')}/api/notebook/execute`;
  let source: string;
  try {
    source = readFileSync(join(ctx.projectRoot, block.filePath), 'utf-8');
  } catch (err) {
    return {
      error: `Could not read block source for "${args.name}" at ${block.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cell: {
          id: `mcp-${args.name}`,
          type: 'dql',
          source,
          title: args.name,
        },
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
    result?: {
      columns?: Array<{ name: string; type?: string }>;
      rows?: unknown[];
      executionTime?: number;
    };
    error?: string;
  };
  if (payload.error) return { error: payload.error };
  const rows = payload.result?.rows ?? [];

  return {
    block: args.name,
    blockPath: block.filePath,
    rowCount: rows.length,
    durationMs: payload.result?.executionTime ?? null,
    columns: payload.result?.columns ?? [],
    rows: args.limit ? rows.slice(0, args.limit) : rows,
  };
}

/**
 * Adapt a manifest block into the minimal `MetadataObject` shape the grain gate
 * reads (it only inspects `payload.grain`, `payload.declaredOutputs`, and
 * `payload.entities`).
 */
function blockToGrainObject(block: {
  name: string;
  grain?: string;
  declaredOutputs?: string[];
  entities?: string[];
}): MetadataObject {
  return {
    objectKey: `dql:block:${block.name}`,
    objectType: 'dql_block',
    name: block.name,
    payload: {
      grain: block.grain,
      declaredOutputs: block.declaredOutputs ?? [],
      entities: block.entities ?? [],
    },
  };
}
