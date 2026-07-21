#!/usr/bin/env node
// Smoke test: scaffold the starter template into a tmp dir, assert the
// expected files exist and placeholder substitution ran. Keeps us honest
// about the 5-minute demo gate — if this test fails, create-dql-app is
// broken.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '..', 'bin', 'create-dql-app.mjs');

function scaffold(template, name) {
  const base = mkdtempSync(join(tmpdir(), 'create-dql-app-test-'));
  const target = join(base, name);
  const result = spawnSync('node', [BIN, target, '--template', template], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '1' },
  });
  return { base, target, result };
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// Must pin the current CLI so a fresh scaffold includes the supported OSS layout.
// install of an older CLI fails there and never links the `dql` binary). Keep in
// sync with templates/starter/package.json.
const EXPECTED_CLI_RANGE = '^1.8.7';

function collectFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) collectFiles(abs, predicate, out);
    else if (predicate(abs)) out.push(abs);
  }
  return out;
}

function assertGeneratedPackage(target) {
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf-8'));
  assert(
    pkg.devDependencies?.['@duckcodeailabs/dql-cli'] === EXPECTED_CLI_RANGE,
    `package.json uses @duckcodeailabs/dql-cli ${EXPECTED_CLI_RANGE}`,
  );
  assert(!Object.values(pkg.scripts ?? {}).includes('dql test'), 'package.json does not use deprecated dql test');
}

function assertTemplateDqlSyntax(target) {
  const dqlFiles = collectFiles(target, (abs) => abs.endsWith('.dql'));
  for (const file of dqlFiles) {
    const source = readFileSync(file, 'utf-8');
    assert(!/\blifecycle\s*=/.test(source), `${file.slice(target.length + 1)} uses block status, not lifecycle`);
    assert(!/^\s*block\s+[A-Za-z0-9_]+\s*\{/m.test(source), `${file.slice(target.length + 1)} quotes block names`);
  }
}

function runTest(template, name, expected, placeholderFile) {
  console.log(`\n▸ template: ${template}`);
  const { base, target, result } = scaffold(template, name);
  try {
    assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
    for (const f of expected) {
      assert(existsSync(join(target, f)), `emits ${f}`);
    }
    const placeholder = readFileSync(join(target, placeholderFile), 'utf-8');
    assert(placeholder.includes(name), `${placeholderFile} got PROJECT_NAME substituted`);
    assert(!placeholder.includes('{{PROJECT_NAME}}'), `${placeholderFile} has no unresolved placeholders`);
    assertGeneratedPackage(target);
    assertTemplateDqlSyntax(target);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

runTest('starter', 'smoke-starter', [
  'apps/.gitkeep',
  'domains/.gitkeep',
  'dql.config.json',
  'package.json',
  'README.md',
  'notebooks/welcome.dqlnb',
  'semantic-layer/.gitkeep',
  'skills/.gitkeep',
  'tests/blocks/.gitkeep',
  'tests/agent-evals/.gitkeep',
  '.gitignore',
], 'dql.config.json');

// The default template (no --template flag) must be the starter.
console.log('\n▸ default template');
{
  const base = mkdtempSync(join(tmpdir(), 'create-dql-app-test-'));
  const target = join(base, 'smoke-default');
  const result = spawnSync('node', [BIN, target], { encoding: 'utf-8', env: { ...process.env, CI: '1' } });
  try {
    assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
    assert(existsSync(join(target, 'dql.config.json')), 'default template emits dql.config.json');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log('\n✓ all smoke tests passed');
