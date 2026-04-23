/**
 * @duckcodeailabs/dql-mcp — MCP server exposing DQL blocks, semantic layer,
 * lineage, and governance to LLM agents.
 */

export { createDQLMCPServer } from './server.js';
export { DQLContext } from './context.js';
export type { DQLContextOptions } from './context.js';
export { runStdio } from './transports/stdio.js';
export { runLoopbackHTTP } from './transports/http.js';
