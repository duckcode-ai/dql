import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish');
const otpArgIndex = process.argv.findIndex((arg) => arg === '--otp');
const otpEqualsArg = process.argv.find((arg) => arg.startsWith('--otp='));
const otp = process.env.NPM_CONFIG_OTP
  ?? process.env.npm_config_otp
  ?? (otpArgIndex >= 0 ? process.argv[otpArgIndex + 1] : undefined)
  ?? (otpEqualsArg ? otpEqualsArg.slice('--otp='.length) : undefined);

if (!dryRun && !publish) {
  console.error('Usage: node scripts/release-packages.mjs --dry-run | --publish [--otp <code>]');
  process.exit(1);
}

// Order matters — leaf packages first, leaves of leaves before that. The
// CLI is published last because it depends on every other workspace package.
const packages = [
  'packages/dql-telemetry',
  'packages/dql-openlineage',
  'packages/dql-plugin-api',
  'packages/dql-ui',
  'packages/dql-core',
  'packages/dql-compiler',
  'packages/dql-runtime',
  'packages/dql-charts',
  'packages/dql-project',
  'packages/dql-governance',
  'packages/dql-connectors',
  'packages/dql-notebook',
  'packages/dql-agent',
  'packages/dql-mcp',
  'packages/dql-slack',
  'packages/dql-lsp',
  'apps/vscode-extension',
  'apps/cli',
  'packages/create-dql-app',
];

const artifactsDir = path.join(root, '.release-artifacts');

async function run(command, args, cwd) {
  const redactedArgs = args.map((arg, index) => {
    if (arg === '--otp') return arg;
    if (args[index - 1] === '--otp') return '***';
    if (arg.startsWith('--otp=')) return '--otp=***';
    return arg;
  });
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${redactedArgs.join(' ')} failed in ${cwd} with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function packageVersionExists(packageName, version) {
  return await new Promise((resolve) => {
    const child = spawn('npm', ['view', `${packageName}@${version}`, 'version', '--silent'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: false,
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Prepare package manifests for npm pack/publish.
 *
 * - Replace all "workspace:*" dependency versions with the actual package
 *   version. pnpm publish is supposed to do this automatically, but it doesn't
 *   always work reliably when running from the release script.
 * - Remove per-package prepublishOnly hooks. The script has already run the
 *   workspace build once, and those hooks rebuild dist/ after pruning compiled
 *   test files from the package payload.
 *
 * Returns a Map of filePath -> originalContent for restoration after publish.
 */
function preparePackageManifests() {
  // Build a map of package name -> version from every workspace package,
  // including private packages used only for local build/dev dependencies.
  const versionMap = new Map();
  for (const workspaceDir of ['packages', 'apps']) {
    const absWorkspaceDir = path.join(root, workspaceDir);
    if (!existsSync(absWorkspaceDir)) continue;
    for (const entry of readdirSync(absWorkspaceDir)) {
      const pkgPath = path.join(absWorkspaceDir, entry, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name && pkg.version) {
        versionMap.set(pkg.name, pkg.version);
      }
    }
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

    if (pkg.scripts?.prepublishOnly) {
      delete pkg.scripts.prepublishOnly;
      if (Object.keys(pkg.scripts).length === 0) {
        delete pkg.scripts;
      }
      changed = true;
    }

    if (changed) {
      originals.set(pkgPath, raw);
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`  Prepared ${relPath}/package.json`);
    }
  }

  return originals;
}

function restoreOriginals(originals) {
  for (const [filePath, content] of originals) {
    writeFileSync(filePath, content);
  }
  if (originals.size > 0) {
    console.log(`\n  Restored ${originals.size} package.json file(s)`);
  }
}

function pruneDistTestArtifacts(packageDir) {
  const distDir = path.join(packageDir, 'dist');
  if (!existsSync(distDir)) return;

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        if (entry === '__tests__') {
          rmSync(abs, { recursive: true, force: true });
          continue;
        }
        walk(abs);
        continue;
      }
      if (/\.(test|spec)\.(js|js\.map|d\.ts|d\.ts\.map)$/.test(entry)) {
        rmSync(abs, { force: true });
      }
    }
  };

  walk(distDir);
}

await mkdir(artifactsDir, { recursive: true });

// Build everything first so the CLI tarball picks up a fresh notebook UI
// bundle. The CLI's own `prepublishOnly` rebuilds `apps/cli` but not
// `apps/dql-notebook`, whose `dist/` gets copied into the CLI's
// `dist/assets/dql-notebook/` by copy-runtime-assets.mjs. Past releases
// shipped a stale React build because that app wasn't rebuilt.
console.log('\nBuilding all packages (so CLI ships fresh notebook UI)...');
await run('pnpm', ['-w', 'build'], root);

// Replace workspace:* with real versions and disable redundant package-level
// publish hooks before pack/publish.
console.log('\nPreparing package manifests...');
const originals = preparePackageManifests();

let exitCode = 0;
try {
  for (const relPath of packages) {
    const cwd = path.join(root, relPath);
    pruneDistTestArtifacts(cwd);
    if (dryRun) {
      console.log(`\n==> Packing ${relPath}`);
      await run('pnpm', ['pack', '--pack-destination', artifactsDir], cwd);
    } else {
      const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (await packageVersionExists(pkg.name, pkg.version)) {
        console.log(`\n==> Skipping ${relPath} (${pkg.name}@${pkg.version} already exists)`);
        continue;
      }
      console.log(`\n==> Publishing ${relPath}`);
      await run('pnpm', [
        'publish',
        '--access',
        'public',
        '--no-git-checks',
        ...(otp ? ['--otp', otp] : []),
      ], cwd);
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
