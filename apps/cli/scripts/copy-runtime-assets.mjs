import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const DIST_ROOT = resolve(CLI_ROOT, 'dist');
const ASSETS_ROOT = join(DIST_ROOT, 'assets');

const assets = [
  {
    source: resolve(REPO_ROOT, 'templates'),
    target: join(ASSETS_ROOT, 'templates'),
  },
  {
    source: resolve(REPO_ROOT, 'apps/notebook-browser'),
    target: join(ASSETS_ROOT, 'notebook-browser'),
  },
  {
    source: resolve(REPO_ROOT, 'apps/dql-notebook/dist'),
    target: join(ASSETS_ROOT, 'dql-notebook'),
  },
];

mkdirSync(ASSETS_ROOT, { recursive: true });

for (const asset of assets) {
  if (!existsSync(asset.source)) {
    throw new Error(`Missing runtime asset directory: ${asset.source}`);
  }

  rmSync(asset.target, { recursive: true, force: true });
  cpSync(asset.source, asset.target, { recursive: true });
}

