import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { compile, writeBundle } from '@duckcodeailabs/dql-compiler';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig } from '../local-runtime.js';

export async function runBuild(filePath: string, flags: CLIFlags): Promise<void> {
  const absoluteFile = resolve(filePath);
  const projectRoot = findProjectRoot(dirname(absoluteFile));
  const config = loadProjectConfig(projectRoot);
  const source = readFileSync(absoluteFile, 'utf-8');
  const result = compile(source, {
    file: absoluteFile,
    theme: config.preview?.theme ?? 'light',
  });

  if (result.errors.length > 0) {
    throw new Error(`Build failed:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
  }

  if (result.dashboards.length === 0) {
    throw new Error('Build requires a charted block, dashboard, or workbook that compiles to HTML output.');
  }

  const name = basename(absoluteFile, extname(absoluteFile));
  const outDir = resolve(flags.outDir || join(projectRoot, 'dist', name));
  mkdirSync(outDir, { recursive: true });
  writeBundle(result.dashboards[0], outDir);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      source: absoluteFile,
      outDir,
      built: true,
      files: ['index.html', 'dql-metadata.json', 'specs/'],
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Built DQL bundle`);
  console.log(`    Source: ${absoluteFile}`);
  console.log(`    Output: ${outDir}`);
  console.log('');
  console.log('  Next step:');
  console.log(`    dql serve ${outDir}`);
  console.log('');
}
