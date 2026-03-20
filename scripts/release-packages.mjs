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

await mkdir(artifactsDir, { recursive: true });

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
