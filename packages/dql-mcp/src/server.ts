import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DQLContext, findProjectRoot } from './context.js';
import { searchBlocks, searchBlocksInput } from './tools/search-blocks.js';
import { getBlock, getBlockInput } from './tools/get-block.js';
import { queryViaBlock, queryViaBlockInput } from './tools/query-via-block.js';
import { listMetrics, listMetricsInput, listDimensions, listDimensionsInput } from './tools/semantic.js';
import { lineageImpact, lineageImpactInput } from './tools/lineage-impact.js';
import { certify, certifyInput } from './tools/certify.js';
import { suggestBlock, suggestBlockInput } from './tools/suggest-block.js';
import { queryViaMetadata, queryViaMetadataInput } from './tools/query-via-metadata.js';
import { listProposals, listProposalsInput } from './tools/list-proposals.js';
import { kgSearch, kgSearchInput, feedbackRecord, feedbackRecordInput } from './tools/kg.js';

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
        'DQL exposes certified, git-versioned analytics blocks under graduated trust:\n' +
        ' Tier 1 — Always try `query_via_block` first. It only serves blocks that are ' +
        '`status = "certified"` AND have a resolved `datalex_contract`. The answer is ' +
        'safe to ship to dashboards.\n' +
        ' Tier 2 — When no certified block matches, call `query_via_metadata` with the ' +
        'SQL you inferred from the manifest + dbt schema. The result is returned with ' +
        '`uncertified: true` — surface that flag to the user verbatim. The proposal is ' +
        'auto-saved as a draft block under blocks/_drafts/ for human certification.\n' +
        ' Tier 3 — If the question is unanswerable from the available data, refuse and ' +
        'tell the user why.\n' +
        'Other tools support the loop: `search_blocks` / `get_block` to discover Tier-1 ' +
        'matches, `list_proposals` to see the review queue, `suggest_block` to propose ' +
        'a new block source-of-truth, `certify` to evaluate governance rules, ' +
        '`lineage_impact` to trace upstream/downstream, `list_metrics` / ' +
        '`list_dimensions` for the semantic layer. Never fabricate SQL outside ' +
        '`query_via_metadata` — it captures provenance the human needs to certify.',
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
    {
      description:
        'Tier-1 of graduated trust. Execute a certified block against the local DQL runtime. Refuses non-certified blocks AND certified blocks whose datalex_contract reference is unresolved. Always try this first; fall back to query_via_metadata only when this returns "no block named".',
      inputSchema: queryViaBlockInput,
    },
    async (args) => wrap(await queryViaBlock(ctx, args)),
  );
  server.registerTool(
    'query_via_metadata',
    {
      description:
        'Tier-2 of graduated trust. Use ONLY when query_via_block has no matching certified block. Provide the SQL you inferred from the manifest + dbt schema; the runtime executes it and returns the result with `uncertified: true`. The proposal is auto-saved as a draft block under blocks/_drafts/. Surface the `uncertified` flag verbatim and tell the user about the `dql certify --from-draft` command if they want the answer certified for next time.',
      inputSchema: queryViaMetadataInput,
    },
    async (args) => wrap(await queryViaMetadata(ctx, args)),
  );
  server.registerTool(
    'list_proposals',
    {
      description:
        'List Tier-2 draft proposals from blocks/_drafts/ ordered by askedTimes DESC. Filter with askedAtLeastTimes / since. Use this to surface "questions that get asked repeatedly are good certify candidates" — the prioritization signal for the human review queue.',
      inputSchema: listProposalsInput,
    },
    async (args) => wrap(listProposals(ctx, args)),
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
    {
      description:
        'Write a curated proposed block to blocks/_drafts/ with a hand-shaped name + structure, plus the governance gate result. Use when proposing a SHARED building block on top of multiple Tier-2 proposals. For one-shot ad-hoc Tier-2 captures, use `query_via_metadata` instead — it auto-saves the draft.',
      inputSchema: suggestBlockInput,
    },
    async (args) => wrap(await suggestBlock(ctx, args)),
  );
  server.registerTool(
    'kg_search',
    { description: 'Search the agent knowledge graph (FTS5) over blocks, metrics, dimensions, dashboards, apps.', inputSchema: kgSearchInput },
    async (args) => wrap(kgSearch(ctx, args)),
  );
  server.registerTool(
    'feedback_record',
    { description: 'Record thumbs-up/down feedback on an answer; feeds self-learning + promotion suggestions.', inputSchema: feedbackRecordInput },
    async (args) => wrap(feedbackRecord(ctx, args)),
  );

  return server;
}

function wrap(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
