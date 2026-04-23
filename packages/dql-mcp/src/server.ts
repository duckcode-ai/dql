import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DQLContext, findProjectRoot } from './context.js';
import { searchBlocks, searchBlocksInput } from './tools/search-blocks.js';
import { getBlock, getBlockInput } from './tools/get-block.js';
import { queryViaBlock, queryViaBlockInput } from './tools/query-via-block.js';
import { listMetrics, listMetricsInput, listDimensions, listDimensionsInput } from './tools/semantic.js';
import { lineageImpact, lineageImpactInput } from './tools/lineage-impact.js';
import { certify, certifyInput } from './tools/certify.js';
import { suggestBlock, suggestBlockInput } from './tools/suggest-block.js';

export interface CreateServerOptions {
  projectRoot?: string;
  version?: string;
}

export function createDQLMCPServer(options: CreateServerOptions = {}): McpServer {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const ctx = new DQLContext({ projectRoot, dqlVersion: options.version });

  const server = new McpServer(
    { name: 'dql-mcp', version: options.version ?? '0.1.0' },
    {
      instructions:
        'DQL exposes certified, git-versioned analytics blocks. Every answer you build ' +
        'should be grounded in a block returned by search_blocks / get_block. Use ' +
        'query_via_block to execute — never fabricate SQL. Use suggest_block when a ' +
        'new question needs a new block; the governance gate returns which rules pass.',
    },
  );

  server.registerTool(
    'search_blocks',
    { description: 'Find certified DQL blocks by keyword, domain, or status.', inputSchema: searchBlocksInput },
    async (args) => wrap(await searchBlocks(ctx, args)),
  );
  server.registerTool(
    'get_block',
    { description: 'Return full metadata, dependencies, and SQL for a block.', inputSchema: getBlockInput },
    async (args) => wrap(await getBlock(ctx, args)),
  );
  server.registerTool(
    'query_via_block',
    { description: 'Execute a certified block against the local DQL runtime.', inputSchema: queryViaBlockInput },
    async (args) => wrap(await queryViaBlock(ctx, args)),
  );
  server.registerTool(
    'list_metrics',
    { description: 'List semantic-layer metrics, optionally filtered by domain.', inputSchema: listMetricsInput },
    async (args) => wrap(await listMetrics(ctx, args)),
  );
  server.registerTool(
    'list_dimensions',
    { description: 'List semantic-layer dimensions, optionally filtered by domain.', inputSchema: listDimensionsInput },
    async (args) => wrap(await listDimensions(ctx, args)),
  );
  server.registerTool(
    'lineage_impact',
    { description: 'Return upstream/downstream lineage for a block, metric, or model.', inputSchema: lineageImpactInput },
    async (args) => wrap(await lineageImpact(ctx, args)),
  );
  server.registerTool(
    'certify',
    { description: 'Run governance rules against a block and report pass/fail.', inputSchema: certifyInput },
    async (args) => wrap(await certify(ctx, args)),
  );
  server.registerTool(
    'suggest_block',
    { description: 'Write a proposed block to blocks/_drafts/ and return the governance gate result.', inputSchema: suggestBlockInput },
    async (args) => wrap(await suggestBlock(ctx, args)),
  );

  return server;
}

function wrap(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
