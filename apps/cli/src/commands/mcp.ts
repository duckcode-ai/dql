import { runStdio, runLoopbackHTTP } from '@duckcodeailabs/dql-mcp';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

interface McpFlags extends CLIFlags {
  http?: boolean;
}

export async function runMcp(arg: string | null, flags: McpFlags): Promise<void> {
  const projectRoot = findProjectRoot(arg ?? process.cwd());

  if (flags.http) {
    const handle = await runLoopbackHTTP({ projectRoot, port: flags.port ?? 0 });
    process.stderr.write(`dql-mcp listening on ${handle.url}\n`);
    process.stderr.write(`  Authorization: Bearer ${handle.token}\n`);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => void handle.close().then(() => process.exit(0)));
    }
    return;
  }

  await runStdio({ projectRoot });
}
