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
import {
  feedbackRecord,
  feedbackRecordInput,
  inspectMetadataContext,
  inspectMetadataContextInput,
  kgSearch,
  kgSearchInput,
} from './tools/kg.js';
import {
  askDql,
  askDqlInput,
  buildDqlApp,
  buildDqlAppInput,
  buildDqlBlock,
  buildDqlBlockInput,
  inspectDqlProject,
  inspectDqlProjectInput,
} from './tools/workflows.js';

export interface CreateServerOptions {
  projectRoot?: string;
  version?: string;
}

export const DQL_MCP_INSTRUCTIONS =
  'DQL is a governed analytics MCP server. Start each session with ' +
  '`inspect_dql_project`; route every analytics question through `ask_dql` ' +
  'before writing SQL. It returns the safe route, trust label, certified ' +
  'candidate when available, allowed SQL context, and next tool.\n' +
  'Tier 1 certified: for an exact saved block or direct KPI, use ' +
  '`search_blocks`/`get_block` for discovery and `query_via_block` only when ' +
  'a certified block grain exactly answers the question.\n' +
  'Tier 2 generated: for named customer/user/account questions, custom filters, ' +
  'rankings, breakdowns, comparisons, drill-throughs, or different grain, use ' +
  'certified assets only as context. Call `inspect_metadata_context`, then `query_via_metadata` with ' +
  'one read-only SELECT/WITH query from the inspected context. Surface ' +
  '`uncertified: true`, the trust status, and draft path verbatim.\n' +
  'Tier 3 missing context: if metadata does not identify a safe table, metric, ' +
  'dimension, or grain, refuse and ask for what is missing.\n' +
  'Use `build_dql_block` for reusable draft blocks, `build_dql_app` for app ' +
  'drafts with certified tiles plus review-only gaps, `certify` for governance, ' +
  '`lineage_impact` for dependencies, `kg_search` for the knowledge graph, and ' +
  '`feedback_record` for answer quality. Never present generated SQL or draft ' +
  'output as certified.';

export function createDQLMCPServer(options: CreateServerOptions = {}): McpServer {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const ctx = new DQLContext({ projectRoot, dqlVersion: options.version });

  const server = new McpServer(
    { name: 'dql-mcp', version: options.version ?? '0.1.0' },
    { instructions: DQL_MCP_INSTRUCTIONS },
  );

  server.registerTool(
    'inspect_dql_project',
    {
      description:
        'Front-door project health/context tool for MCP clients. Refreshes metadata/index by default and returns block, app, dashboard, semantic, catalog, and recommended-next-step status.',
      inputSchema: inspectDqlProjectInput,
    },
    async (args) => wrap(await inspectDqlProject(ctx, args)),
  );
  server.registerTool(
    'ask_dql',
    {
      description:
        'High-level governed ask router. Use first for business questions. Returns certified-vs-generated route, contextPackId, exact block candidate, allowed SQL context, missing context, trust status, and next safe DQL tool.',
      inputSchema: askDqlInput,
    },
    async (args) => wrap(await askDql(ctx, args)),
  );
  server.registerTool(
    'build_dql_block',
    {
      description:
        'High-level draft-block tool. Writes a proposed block to blocks/_drafts/ with governance results. Does not certify automatically.',
      inputSchema: buildDqlBlockInput,
    },
    async (args) => wrap(await buildDqlBlock(ctx, args)),
  );
  server.registerTool(
    'build_dql_app',
    {
      description:
        'High-level app builder. Creates or plans a governed DQL app draft from a prompt using certified tiles first and review-only placeholders for missing evidence.',
      inputSchema: buildDqlAppInput,
    },
    async (args) => wrap(await buildDqlApp(ctx, args)),
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
        'Tier-1 of graduated trust. Execute a certified block against the local DQL runtime when the block grain exactly answers the user question. Refuses non-certified blocks and refuses unresolved datalex_contract references when a DataLex manifest is loaded. For named-entity filters, custom rankings, breakdowns, comparisons, or drill-throughs, use the block as context and call query_via_metadata instead.',
      inputSchema: queryViaBlockInput,
    },
    async (args) => wrap(await queryViaBlock(ctx, args)),
  );
  server.registerTool(
    'query_via_metadata',
    {
      description:
        'Tier-2 of graduated trust. Use when no certified block exactly answers the requested grain, including why-changed diagnostics, named customer/user/account filters, rankings, breakdowns, comparisons, anomalies, and drill-throughs. Call inspect_metadata_context first; pass its contextPackId when available. If proposedSql is omitted, this returns the catalog route plan, allowed SQL context, and missing context. If proposedSql is supplied, it must be one read-only SELECT/WITH query using only inspected relations/columns. The runtime executes a bounded preview, returns `uncertified: true` plus trustStatus/evidence, and saves a draft block under blocks/_drafts/. Surface the `uncertified` flag and review path verbatim.',
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
    { description: 'Search the agent knowledge graph (FTS5) over terms, business views, blocks, metrics, dimensions, dashboards, apps, notebooks, and dbt/source metadata.', inputSchema: kgSearchInput },
    async (args) => wrap(await kgSearch(ctx, args)),
  );
  server.registerTool(
    'inspect_metadata_context',
    {
      description:
        'Build the local SQLite metadata context pack for a question. Use before Tier-2 SQL generation to inspect certified blocks, semantic metrics, DQL terms/views, dbt/warehouse objects, lineage edges, diagnostics, selected evidence, rejected candidates, and trust labels.',
      inputSchema: inspectMetadataContextInput,
    },
    async (args) => wrap(await inspectMetadataContext(ctx, args)),
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
