import {
  DQLContext,
  searchBlocks,
  getBlock,
  listMetrics,
  listDimensions,
  lineageImpact,
  certify,
  suggestBlock,
} from '@duckcodeailabs/dql-mcp';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown): Promise<unknown>;
}

const SEARCH_BLOCKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Substring matched against name, description, or tags.' },
    domain: { type: 'string', description: 'Filter to a single business domain.' },
    status: {
      type: 'string',
      enum: ['draft', 'review', 'certified', 'deprecated', 'pending_recertification'],
      description: 'Filter by certification status.',
    },
    limit: { type: 'number', description: 'Max results (default 50).' },
  },
} as const;

const GET_BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', description: 'Block name (as shown in search_blocks).' },
    includeSource: { type: 'boolean', description: 'Include full .dql source text. Default true.' },
  },
} as const;

const DOMAIN_FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string', description: 'Filter to a single domain.' },
  },
} as const;

const LINEAGE_IMPACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['focus'],
  properties: {
    focus: { type: 'string', description: 'Node id ("block:revenue") or bare name.' },
    upstreamDepth: { type: 'number' },
    downstreamDepth: { type: 'number' },
    paths: { type: 'boolean', description: 'Include full source→leaf paths (slower on large graphs).' },
  },
} as const;

const CERTIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', description: 'Block name to certify.' },
  },
} as const;

const SUGGEST_BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'domain', 'owner', 'description', 'sql'],
  properties: {
    name: { type: 'string', description: 'Proposed block name (kebab_case).' },
    domain: { type: 'string', description: 'Business domain (finance, product, …).' },
    owner: { type: 'string', description: 'Block owner identity (email or team handle).' },
    description: { type: 'string', description: 'One-line description.' },
    sql: { type: 'string', description: 'The block body SQL.' },
    tags: { type: 'array', items: { type: 'string' } },
    chartType: { type: 'string', description: 'Optional visualization type.' },
  },
} as const;

export function buildAgentTools(ctx: DQLContext): AgentTool[] {
  return [
    {
      name: 'search_blocks',
      description: 'Find certified DQL blocks by keyword, domain, or status.',
      inputSchema: SEARCH_BLOCKS_SCHEMA,
      run: async (args) => searchBlocks(ctx, args as Parameters<typeof searchBlocks>[1]),
    },
    {
      name: 'get_block',
      description: 'Return full metadata, dependencies, and SQL for a block.',
      inputSchema: GET_BLOCK_SCHEMA,
      run: async (args) => getBlock(ctx, args as Parameters<typeof getBlock>[1]),
    },
    {
      name: 'list_metrics',
      description: 'List semantic-layer metrics, optionally filtered by domain.',
      inputSchema: DOMAIN_FILTER_SCHEMA,
      run: async (args) => listMetrics(ctx, args as Parameters<typeof listMetrics>[1]),
    },
    {
      name: 'list_dimensions',
      description: 'List semantic-layer dimensions, optionally filtered by domain.',
      inputSchema: DOMAIN_FILTER_SCHEMA,
      run: async (args) => listDimensions(ctx, args as Parameters<typeof listDimensions>[1]),
    },
    {
      name: 'lineage_impact',
      description: 'Return upstream/downstream lineage for a block, metric, or model.',
      inputSchema: LINEAGE_IMPACT_SCHEMA,
      run: async (args) => lineageImpact(ctx, args as Parameters<typeof lineageImpact>[1]),
    },
    {
      name: 'certify',
      description: 'Run governance rules against a block and report pass/fail.',
      inputSchema: CERTIFY_SCHEMA,
      run: async (args) => certify(ctx, args as Parameters<typeof certify>[1]),
    },
    {
      name: 'suggest_block',
      description:
        'Write a proposed block to blocks/_drafts/ and return governance results. ' +
        'Use this at the end of a conversation to hand the user a reviewable draft.',
      inputSchema: SUGGEST_BLOCK_SCHEMA,
      run: async (args) => suggestBlock(ctx, args as Parameters<typeof suggestBlock>[1]),
    },
  ];
}
