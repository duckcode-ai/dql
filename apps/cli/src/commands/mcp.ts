import { DQLContext, runStdio, runLoopbackHTTP } from '@duckcodeailabs/dql-mcp';
import {
  defaultKgPath,
  ensureMetadataCatalogFresh,
  reindexProject,
} from '@duckcodeailabs/dql-agent';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

interface McpFlags extends CLIFlags {
  http?: boolean;
}

export async function runMcp(arg: string | null, rest: string[], flags: McpFlags): Promise<void> {
  if (arg === 'test') {
    return runMcpTest(rest[0] ?? null, flags);
  }

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

async function runMcpTest(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(resolve(targetPath ?? process.cwd()));
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({
    name: 'DQL project',
    ok: existsSync(join(projectRoot, 'dql.config.json')),
    detail: existsSync(join(projectRoot, 'dql.config.json')) ? projectRoot : 'dql.config.json not found',
  });

  try {
    const ctx = new DQLContext({ projectRoot });
    const manifest = ctx.manifest;
    checks.push({
      name: 'Manifest context',
      ok: true,
      detail: `${Object.keys(manifest.blocks ?? {}).length} block(s), ${Object.keys(manifest.apps ?? {}).length} app(s)`,
    });
  } catch (error) {
    checks.push({
      name: 'Manifest context',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await ensureMetadataCatalogFresh(projectRoot);
    checks.push({
      name: 'Metadata catalog',
      ok: true,
      detail: `${result.objectCount} object(s), ${result.edgeCount} edge(s) at ${result.path}`,
    });
  } catch (error) {
    checks.push({
      name: 'Metadata catalog',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await reindexProject(projectRoot, { kgPath: defaultKgPath(projectRoot) });
    checks.push({
      name: 'Agent index',
      ok: true,
      detail: `${result.nodes} node(s), ${result.edges} edge(s), ${result.skills} skill(s)`,
    });
  } catch (error) {
    checks.push({
      name: 'Agent index',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  checks.push({
    name: 'MCP tool surface',
    ok: true,
    detail: 'ask_dql, build_dql_block, build_dql_app, inspect_dql_project, certified, metadata, lineage, and governance tools are available',
  });

  const ok = checks.every((check) => check.ok);
  if (flags.format === 'json') {
    console.log(JSON.stringify({ ok, projectRoot, checks }, null, 2));
    return;
  }

  console.log('\n  DQL MCP Test');
  console.log(`    Project: ${projectRoot}`);
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}`);
    console.log(`    ${check.detail}`);
  }
  console.log('');
  console.log(ok
    ? '  Ready: point Claude Code, Codex, Cursor, or Claude Desktop at this project with `dql connect`.'
    : '  Not ready: fix the failed checks above, then rerun `dql mcp test`.');
  console.log('');
}
