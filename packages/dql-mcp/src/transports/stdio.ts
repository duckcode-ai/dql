import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDQLMCPServer, type CreateServerOptions } from '../server.js';

/**
 * Run an MCP server over stdio. Intended for child-process use by
 * Claude Code, Cursor, Claude Desktop, and similar agents.
 */
export async function runStdio(options: CreateServerOptions = {}): Promise<void> {
  const server = createDQLMCPServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
