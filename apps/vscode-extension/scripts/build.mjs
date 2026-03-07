import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { context, build } from 'esbuild';

const root = process.cwd();
const outdir = path.join(root, 'dist');
const watchMode = process.argv.includes('--watch');

await mkdir(outdir, { recursive: true });

const extensionBuild = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(outdir, 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  target: ['node18'],
  external: ['vscode'],
};

const lspBuild = {
  entryPoints: [path.resolve(root, '../../packages/dql-lsp/src/cli.ts')],
  outfile: path.join(outdir, 'lsp-server.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  target: ['node18'],
};

if (watchMode) {
  const extensionCtx = await context(extensionBuild);
  const lspCtx = await context(lspBuild);
  await extensionCtx.watch();
  await lspCtx.watch();
  console.log('[dql-vscode-extension] watching extension and LSP bundles...');
} else {
  await build(extensionBuild);
  await build(lspBuild);
  console.log('[dql-vscode-extension] build complete');
}
