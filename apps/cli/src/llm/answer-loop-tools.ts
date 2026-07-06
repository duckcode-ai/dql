import {
  dqlToolNamesForSurface,
  expandGroundingFromCatalog,
  openMetadataCatalog,
  type AgentToolDefinition,
} from '@duckcodeailabs/dql-agent';
import { DQLContext } from '@duckcodeailabs/dql-mcp';
import { buildAgentTools, type AgentTool } from './tools.js';

export interface AnswerLoopToolOptions {
  serverUrl?: string;
}

export function createGroundingContextExpander(projectRoot: string) {
  return async (request: Parameters<typeof expandGroundingFromCatalog>[1]) => {
    const catalog = openMetadataCatalog(projectRoot);
    try {
      return expandGroundingFromCatalog(catalog, request);
    } finally {
      catalog.close();
    }
  };
}

export function buildAnswerLoopTools(
  projectRoot: string,
  options: AnswerLoopToolOptions = {},
): AgentToolDefinition[] {
  const ctx = new DQLContext({ projectRoot });
  const allowed = new Set<string>(dqlToolNamesForSurface('answer_loop'));
  return buildAgentTools(ctx)
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => wrapAnswerLoopTool(tool, options));
}

function wrapAnswerLoopTool(tool: AgentTool, options: AnswerLoopToolOptions): AgentToolDefinition {
  if (tool.name === 'query_via_metadata') return wrapMetadataPlanningTool(tool, options);
  if (tool.name === 'query_via_block') return wrapRuntimeTool(tool, options);
  return tool;
}

function wrapMetadataPlanningTool(
  tool: AgentTool,
  options: AnswerLoopToolOptions,
): AgentToolDefinition {
  return {
    ...tool,
    run: async (args) => {
      const input = objectArgs(args);
      return tool.run({
        ...input,
        dryRun: true,
        saveDraft: false,
        ...runtimeToolArgs(input, options),
      });
    },
  };
}

function wrapRuntimeTool(
  tool: AgentTool,
  options: AnswerLoopToolOptions,
): AgentToolDefinition {
  if (!options.serverUrl) return tool;
  return {
    ...tool,
    run: async (args) => {
      const input = objectArgs(args);
      return tool.run({
        ...input,
        ...runtimeToolArgs(input, options),
      });
    },
  };
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

function runtimeToolArgs(
  input: Record<string, unknown>,
  options: AnswerLoopToolOptions,
): Record<string, unknown> {
  return options.serverUrl && typeof input.serverUrl !== 'string'
    ? { serverUrl: options.serverUrl }
    : {};
}
