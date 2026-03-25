import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish');

if (!dryRun && !publish) {
  console.error('Usage: node scripts/release-packages.mjs --dry-run | --publish');
  process.exit(1);
}

const packages = [
  'packages/dql-core',
  'packages/dql-compiler',
  'packages/dql-runtime',
  'packages/dql-charts',
  'packages/dql-project',
  'packages/dql-governance',
  'packages/dql-connectors',
  'packages/dql-notebook',
  'packages/dql-lsp',
  'apps/cli',
];

const artifactsDir = path.join(root, '.release-artifacts');

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed in ${cwd} with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

/**
 * Replace all "workspace:*" dependency versions with the actual package version.
 * pnpm publish is supposed to do this automatically, but it doesn't always work
 * reliably (especially in CI or when running from the release script).
 *
 * Returns a Map of filePath -> originalContent for restoration after publish.
 */
function resolveWorkspaceDeps() {
  // Build a map of package name -> version from all workspace packages
  const versionMap = new Map();
  for (const relPath of packages) {
    const pkgPath = path.join(root, relPath, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    versionMap.set(pkg.name, pkg.version);
  }

  const originals = new Map();

  for (const relPath of packages) {
    const pkgPath = path.join(root, relPath, 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    let changed = false;

    for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[depField];
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          const resolvedVersion = versionMap.get(name);
          if (resolvedVersion) {
            deps[name] = `^${resolvedVersion}`;
            changed = true;
          } else {
            console.warn(`  Warning: ${relPath} depends on ${name} (${version}) but no workspace package found`);
          }
        }
      }
    }

    if (changed) {
      originals.set(pkgPath, raw);
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`  Resolved workspace:* deps in ${relPath}/package.json`);
    }
  }

  return originals;
}

function restoreOriginals(originals) {
  for (const [filePath, content] of originals) {
    writeFileSync(filePath, content);
  }
  if (originals.size > 0) {
    console.log(`\n  Restored ${originals.size} package.json file(s) to workspace:* versions`);
  }
}

await mkdir(artifactsDir, { recursive: true });

// Replace workspace:* with real versions before pack/publish
console.log('\nResolving workspace:* dependencies...');
const originals = resolveWorkspaceDeps();

let exitCode = 0;
try {
  for (const relPath of packages) {
    const cwd = path.join(root, relPath);
    if (dryRun) {
      console.log(`\n==> Packing ${relPath}`);
      await run('pnpm', ['pack', '--pack-destination', artifactsDir], cwd);
    } else {
      console.log(`\n==> Publishing ${relPath}`);
      await run('pnpm', ['publish', '--access', 'public', '--no-git-checks'], cwd);
    }
  }
} catch (err) {
  console.error(`\nPublish failed: ${err.message}`);
  exitCode = 1;
} finally {
  // Always restore originals so workspace:* stays in the repo
  restoreOriginals(originals);
}

process.exit(exitCode);
