#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageSpec = process.argv[2] ?? '@duckcodeailabs/dql-cli@latest';
const expectedVersion = packageSpec.match(/@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1] ?? null;
const root = mkdtempSync(join(tmpdir(), 'dql-published-install-'));
const localDir = join(root, 'local');
const globalPrefix = join(root, 'global');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit code ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

try {
  console.log(`\nVerifying published CLI install: ${packageSpec}`);
  mkdirSync(localDir, { recursive: true });
  mkdirSync(globalPrefix, { recursive: true });
  run('npm', ['init', '--yes'], localDir);
  run('npm', ['install', '--save-dev', '--no-audit', '--no-fund', packageSpec], localDir);

  const localBin = join(localDir, 'node_modules', '.bin', process.platform === 'win32' ? 'dql.cmd' : 'dql');
  assert(existsSync(localBin), 'project-local install links node_modules/.bin/dql');
  const localVersion = run(localBin, ['--version'], localDir);
  assert(localVersion.startsWith('dql '), `project-local dql runs (${localVersion})`);
  if (expectedVersion) assert(localVersion === `dql ${expectedVersion}`, `project-local version is ${expectedVersion}`);

  run('npm', ['install', '--global', '--prefix', globalPrefix, '--no-audit', '--no-fund', packageSpec], root);
  const globalBin = process.platform === 'win32'
    ? join(globalPrefix, 'dql.cmd')
    : join(globalPrefix, 'bin', 'dql');
  assert(existsSync(globalBin), 'global install links the dql command');
  const globalVersion = run(globalBin, ['--version'], root);
  assert(globalVersion.startsWith('dql '), `global dql runs (${globalVersion})`);
  if (expectedVersion) assert(globalVersion === `dql ${expectedVersion}`, `global version is ${expectedVersion}`);

  const installedPackage = JSON.parse(readFileSync(join(
    localDir,
    'node_modules',
    '@duckcodeailabs',
    'dql-cli',
    'package.json',
  ), 'utf-8'));
  assert(installedPackage.bin?.dql?.replace(/^\.\//, '') === 'dist/index.js', 'installed package retains the dql bin mapping');
  console.log('\n✓ published CLI local/global install smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
