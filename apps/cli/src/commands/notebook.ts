import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { CLIFlags } from '../args.js';
import type { ProjectConfig } from '../local-runtime.js';
import {
  findProjectRoot,
  loadProjectConfig,
  normalizeProjectConnection,
  startLocalServer,
} from '../local-runtime.js';
import { maybeOpenBrowser } from '../open-browser.js';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
// Bundled assets are always at dist/assets/ relative to the CLI dist root
const REACT_APP_DIR = resolve(COMMAND_DIR, '../assets/dql-notebook');
const LEGACY_APP_DIR = resolve(COMMAND_DIR, '../assets/notebook-browser');
const NOTEBOOK_APP_DIR = existsSync(join(REACT_APP_DIR, 'index.html')) ? REACT_APP_DIR : LEGACY_APP_DIR;

export function resolveNotebookConnection(config: ProjectConfig, projectRoot: string) {
  return config.defaultConnection
    ? normalizeProjectConnection(config.defaultConnection, projectRoot)
    : null;
}

export interface ProjectRuntimeHandle {
  port: number;
  url: string;
  /** Stop the HTTP listener so the process can exit (no-op if already closed). */
  close: () => Promise<void>;
}

/**
 * Start the local notebook/runtime HTTP server for a project and return a handle.
 * Shared by `dql notebook` (long-running) and `dql agent ask` (which starts an
 * ephemeral runtime on a free port — `preferredPort: 0` — and closes it after).
 */
export async function startProjectRuntime(
  projectRoot: string,
  opts: { preferredPort?: number; host?: string } = {},
): Promise<ProjectRuntimeHandle> {
  const config = loadProjectConfig(projectRoot);
  const executor = new QueryExecutor();
  const connection = resolveNotebookConnection(config, projectRoot);
  const host = opts.host ?? process.env.DQL_HOST ?? '127.0.0.1';
  let server: Server | undefined;
  const port = await startLocalServer({
    rootDir: NOTEBOOK_APP_DIR,
    projectRoot,
    executor,
    connection,
    preferredPort: opts.preferredPort ?? 0,
    host,
    captureServer: (created) => { server = created; },
  });
  const printHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return {
    port,
    url: `http://${printHost}:${port}`,
    close: () => new Promise<void>((resolveClose) => {
      if (!server) return resolveClose();
      server.close(() => resolveClose());
    }),
  };
}

export async function runNotebook(targetArg: string | null, flags: CLIFlags): Promise<void> {
  const baseDir = resolve(targetArg ?? '.');
  const projectRoot = findProjectRoot(baseDir);
  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    throw new Error(
      `No DQL project was found at "${baseDir}". Run "dql notebook" from a project root, or pass a project path such as "dql notebook ./my-dql-project".`,
    );
  }
  const config = loadProjectConfig(projectRoot);
  const host = flags.host ?? process.env.DQL_HOST ?? '127.0.0.1';
  const { port, url } = await startProjectRuntime(projectRoot, {
    preferredPort: flags.port ?? config.preview?.port ?? 3474,
    host,
  });

  // Auto-open only on loopback. In a container or on a remote host, opening
  // the host's browser is either useless or wrong.
  const shouldOpen = (flags.open ?? config.preview?.open ?? true) && host === '127.0.0.1';
  maybeOpenBrowser(url, shouldOpen);

  console.log(`\n  ✓ Notebook ready: ${url}`);
  if (host !== '127.0.0.1') {
    console.log(`    Bound on ${host}:${port} — open the URL above from your host.`);
  }
  console.log('    Press Ctrl+C to stop.');
  console.log('');
}
