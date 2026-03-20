import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compile, writeBundle } from '@duckcodeailabs/dql-compiler';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig, startLocalServer } from '../local-runtime.js';
import { maybeOpenBrowser } from '../open-browser.js';

export async function runPreview(filePath: string, flags: CLIFlags): Promise<void> {
  const absoluteFile = resolve(filePath);
  const projectRoot = findProjectRoot(dirname(absoluteFile));
  const config = loadProjectConfig(projectRoot);
  const source = readFileSync(absoluteFile, 'utf-8');
  const result = compile(source, {
    file: absoluteFile,
    theme: config.preview?.theme ?? 'light',
  });

  if (result.errors.length > 0) {
    throw new Error(`Preview compilation failed:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
  }

  if (result.dashboards.length === 0) {
    throw new Error('Preview requires a charted block, dashboard, or workbook that compiles to HTML output.');
  }

  const previewDir = join(tmpdir(), 'dql-preview', `${Date.now()}`);
  mkdirSync(previewDir, { recursive: true });
  writeBundle(result.dashboards[0], previewDir);

  const executor = new QueryExecutor();
  const connection = config.defaultConnection ?? { driver: 'file', filepath: ':memory:' };
  process.chdir(projectRoot);
  const port = await startLocalServer({
    rootDir: previewDir,
    executor,
    connection,
    preferredPort: config.preview?.port ?? 3474,
  });
  const url = `http://127.0.0.1:${port}`;
  maybeOpenBrowser(url, flags.open ?? config.preview?.open ?? true);
  console.log(`\n  ✓ Preview ready: ${url}`);
  console.log('    Press Ctrl+C to stop.');
  console.log('');
}
