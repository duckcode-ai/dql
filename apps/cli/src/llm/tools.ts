import {
  DQLContext,
  askDql,
  searchBlocks,
  getBlock,
  queryViaBlock,
  querySemanticModel,
  queryViaMetadata,
  expandContext,
  lineageImpact,
  certify,
  suggestBlock,
  kgSearch,
  inspectMetadataContext,
} from '@duckcodeailabs/dql-mcp';
import { dqlToolDefinitionsForSurface, getDqlToolDefinition, type DqlToolName } from '@duckcodeailabs/dql-agent';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown): Promise<unknown>;
}

export function buildAgentTools(ctx: DQLContext): AgentTool[] {
  const handlers = nativeToolHandlers(ctx);
  return dqlToolDefinitionsForSurface('native').map((definition) => {
    const handler = handlers[definition.name];
    if (!handler) throw new Error(`Native DQL tool handler is missing for ${definition.name}`);
    return registryTool(definition.name, handler);
  });
}

function registryTool(name: DqlToolName, run: AgentTool['run']): AgentTool {
  const definition = getDqlToolDefinition(name);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    run,
  };
}

function nativeToolHandlers(ctx: DQLContext): Partial<Record<DqlToolName, AgentTool['run']>> {
  return {
    ask_dql: async (args) => askDql(ctx, args as Parameters<typeof askDql>[1]),
    query_semantic_model: async (args) => querySemanticModel(ctx, args as Parameters<typeof querySemanticModel>[1]),
    kg_search: async (args) => kgSearch(ctx, args as Parameters<typeof kgSearch>[1]),
    search_blocks: async (args) => searchBlocks(ctx, args as Parameters<typeof searchBlocks>[1]),
    get_block: async (args) => getBlock(ctx, args as Parameters<typeof getBlock>[1]),
    query_via_block: async (args) => queryViaBlock(ctx, args as Parameters<typeof queryViaBlock>[1]),
    inspect_metadata_context: async (args) => inspectMetadataContext(ctx, args as Parameters<typeof inspectMetadataContext>[1]),
    query_via_metadata: async (args) => queryViaMetadata(ctx, args as Parameters<typeof queryViaMetadata>[1]),
    expand_context: async (args) => expandContext(ctx, args as Parameters<typeof expandContext>[1]),
    lineage_impact: async (args) => lineageImpact(ctx, args as Parameters<typeof lineageImpact>[1]),
    certify: async (args) => certify(ctx, args as Parameters<typeof certify>[1]),
    suggest_block: async (args) => suggestBlock(ctx, args as Parameters<typeof suggestBlock>[1]),
  };
}
