import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const DIST_ROOT = resolve(CLI_ROOT, 'dist');
const ASSETS_ROOT = join(DIST_ROOT, 'assets');

const assets = [
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

// ── Resolve workspace:* dependencies for npm install -g compatibility ───────
// pnpm's workspace:* protocol breaks `npm install -g .` because npm doesn't
// understand it. Replace workspace:* with the actual versions from each
// package's package.json so the CLI can be installed globally from source.
const cliPkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf-8'));
const deps = cliPkg.dependencies ?? {};
let changed = false;

for (const [name, version] of Object.entries(deps)) {
  if (typeof version === 'string' && version.startsWith('workspace:')) {
    // Find the package's actual version in the monorepo
    const shortName = name.replace('@duckcodeailabs/', '');
    const candidates = [
      join(REPO_ROOT, 'packages', shortName, 'package.json'),
      join(REPO_ROOT, 'apps', shortName, 'package.json'),
    ];
    let resolvedVersion;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        resolvedVersion = pkg.version;
        break;
      }
    }
    if (resolvedVersion) {
      deps[name] = `^${resolvedVersion}`;
      changed = true;
    }
  }
}

if (changed) {
  cliPkg.dependencies = deps;
  // Fix paths for installing from dist/ directory directly:
  // bin points to ./dist/index.js from repo root, but from dist/ it's ./index.js
  if (cliPkg.bin) {
    for (const [cmd, path] of Object.entries(cliPkg.bin)) {
      cliPkg.bin[cmd] = path.replace('./dist/', './');
    }
  }
  // files: dist/* is already at the root when installing from dist/
  cliPkg.files = ['.'];
  writeFileSync(join(CLI_ROOT, 'dist', 'package.json'), JSON.stringify(cliPkg, null, 2) + '\n');
}
