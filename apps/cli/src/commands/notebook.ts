import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { CLIFlags } from '../args.js';
import {
  assertLocalQueryRuntimeReady,
  findProjectRoot,
  loadProjectConfig,
  startLocalServer,
} from '../local-runtime.js';
import { maybeOpenBrowser } from '../open-browser.js';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
// Bundled assets are always at dist/assets/ relative to the CLI dist root
const REACT_APP_DIR = resolve(COMMAND_DIR, '../assets/dql-notebook');
const LEGACY_APP_DIR = resolve(COMMAND_DIR, '../assets/notebook-browser');
const NOTEBOOK_APP_DIR = existsSync(join(REACT_APP_DIR, 'index.html')) ? REACT_APP_DIR : LEGACY_APP_DIR;

export async function runNotebook(targetArg: string | null, flags: CLIFlags): Promise<void> {
  const baseDir = resolve(targetArg ?? '.');
  const projectRoot = findProjectRoot(baseDir);
  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    throw new Error(
      `No DQL project was found at "${baseDir}". Run "dql notebook" from a project root, or pass a project path such as "dql notebook ./my-dql-project".`,
    );
  }
  const config = loadProjectConfig(projectRoot);
  const executor = new QueryExecutor();
  const connection = config.defaultConnection ?? { driver: 'file' as const, filepath: ':memory:' };

  await assertLocalQueryRuntimeReady(executor, connection);

  const port = await startLocalServer({
    rootDir: NOTEBOOK_APP_DIR,
    projectRoot,
    executor,
    connection,
    preferredPort: flags.port ?? config.preview?.port ?? 3474,
  });

  const url = `http://127.0.0.1:${port}`;
  maybeOpenBrowser(url, flags.open ?? config.preview?.open ?? true);
  console.log(`\n  ✓ Notebook ready: ${url}`);
  console.log('    Press Ctrl+C to stop.');
  console.log('');
}
