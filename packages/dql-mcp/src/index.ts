/**
 * @duckcodeailabs/dql-mcp — MCP server exposing DQL blocks, semantic layer,
 * lineage, and governance to LLM agents.
 */

export { createDQLMCPServer } from './server.js';
export { DQLContext, findProjectRoot } from './context.js';
export type { DQLContextOptions } from './context.js';
export { runStdio } from './transports/stdio.js';
export { runLoopbackHTTP } from './transports/http.js';

export { searchBlocks, searchBlocksInput } from './tools/search-blocks.js';
export { getBlock, getBlockInput } from './tools/get-block.js';
export { queryViaBlock, queryViaBlockInput } from './tools/query-via-block.js';
export {
  listMetrics,
  listMetricsInput,
  listDimensions,
  listDimensionsInput,
} from './tools/semantic.js';
export { lineageImpact, lineageImpactInput } from './tools/lineage-impact.js';
export { certify, certifyInput } from './tools/certify.js';
export { suggestBlock, suggestBlockInput } from './tools/suggest-block.js';
