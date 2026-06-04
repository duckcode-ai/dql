#!/usr/bin/env node
// Smoke test: scaffold both templates into tmp dirs, assert the expected
// files exist and placeholder substitution ran. Keeps us honest about the
// 5-minute demo gate — if this test fails, create-dql-app is broken.
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

const EXPECTED_CLI_RANGE = '^1.6.1';

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

runTest('acme-bank', 'smoke-acme-bank', [
  'dql.config.json',
  'package.json',
  'README.md',
  'data/transactions.csv',
  'data/fraud_alerts.csv',
  'data/deposits.csv',
  'data/loans.csv',
  'blocks/cards/fraud_alerts_by_region.dql',
  'blocks/cards/card_approval_rate.dql',
  'blocks/deposits/deposit_trend.dql',
  'blocks/lending/loan_delinquency_by_region.dql',
  'blocks/executive/bank_health_scorecard.dql',
  'apps/cards-ops/dql.app.json',
  'apps/cards-ops/dashboards/daily-ops.dqld',
  'apps/cards-ops/dashboards/fraud-watch.dqld',
  'apps/retail-deposits/dashboards/deposit-growth.dqld',
  'apps/risk-office/dashboards/credit-risk.dqld',
  'apps/executive-cockpit/dashboards/bank-overview.dqld',
  'notebooks/cards_fraud_ops.dqlnb',
  'notebooks/retail_deposits_review.dqlnb',
  'notebooks/credit_risk_review.dqlnb',
  'notebooks/executive_weekly_review.dqlnb',
  '.dql/skills/mei.chen@acme-bank.com/cards-fraud.skill.md',
  'semantic-layer/metrics/banking.yaml',
  '.gitignore',
], 'dql.config.json');

console.log('\n✓ all smoke tests passed');
