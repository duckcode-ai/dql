import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDQLMCPServer, type CreateServerOptions } from '../server.js';

export interface LoopbackHTTPOptions extends CreateServerOptions {
  /** Explicit port; 0 = pick a free port (default). */
  port?: number;
  /** Pre-generated auth token; a random one is generated when omitted. */
  token?: string;
}

export interface LoopbackHTTPHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * Run an MCP server over loopback HTTP (127.0.0.1 only). Intended for the
 * VS Code extension, the notebook web UI, and developer-local CLIs that
 * cannot spawn a stdio child. Any non-loopback listener is refused —
 * remote HTTP transport stays in the Cloud build.
 */
export async function runLoopbackHTTP(options: LoopbackHTTPOptions = {}): Promise<LoopbackHTTPHandle> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const server = createDQLMCPServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomBytes(12).toString('hex') });
  await server.connect(transport);

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.socket.remoteAddress && !isLoopback(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end('dql-mcp: non-loopback connections are refused');
      return;
    }
    const header = req.headers['authorization'];
    if (header !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end('dql-mcp: missing or invalid Authorization header');
      return;
    }
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const addr = http.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to resolve HTTP listening address');
  }
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    token,
    async close() {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await transport.close();
      await server.close();
    },
  };
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
