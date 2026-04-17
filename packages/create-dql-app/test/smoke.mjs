#!/usr/bin/env node
// Smoke test: scaffold both templates into tmp dirs, assert the expected
// files exist and placeholder substitution ran. Keeps us honest about the
// 5-minute demo gate — if this test fails, create-dql-app is broken.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

runTest('jaffle-shop', 'smoke-jaffle', [
  'dql.config.json',
  'package.json',
  'README.md',
  'notebooks/welcome.dqlnb',
  'blocks/revenue_by_segment.dql',
  'semantic-layer/metrics/revenue.yaml',
  'dashboards/overview.dql',
  '.gitignore',
], 'dql.config.json');

runTest('empty', 'smoke-empty', [
  'dql.config.json',
  'package.json',
  'README.md',
  'notebooks/welcome.dqlnb',
  '.gitignore',
], 'dql.config.json');

console.log('\n✓ all smoke tests passed');
