#!/usr/bin/env node

/**
 * Run DQL Agent tests in two deterministic lanes.
 *
 * `catalog.test.ts` and `project-state.test.ts` intentionally build large
 * local indexes. They remain unchanged and run in every package test. To avoid
 * CPU/file-system contention under Turbo, they run separately from the
 * deterministic serial ordinary suite.
 *
 * This runner executes the ordinary suite deterministically and serially, then
 * executes the two heavy files serially in a separate Vitest process. The
 * aggregate JSON receipts
 * prove the complete, non-skipped suite still ran exactly once.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestCli = require.resolve('vitest/vitest.mjs');

const HEAVY_TEST_FILES = [
  'src/metadata/catalog.test.ts',
  'src/project-state.test.ts',
];
// The authoritative V2 kernel is a release-critical Ask surface. Keep an
// explicit discovery assertion so a future glob or lane refactor cannot omit
// its regression suite while still producing a superficially complete count.
const REQUIRED_TEST_FILES = [
  'src/ask-runtime/ask-agent-runtime-v2.test.ts',
];
// Keep this audited set explicit: new Ask analytical-frame and observability
// regressions must participate in the same serial package gate rather than
// being silently omitted from the receipt audit.
const EXPECTED_TEST_FILES = 159;
// Keep the aggregate receipt exact. The current Ask routing, semantic-proof,
// trace, product-category, exploratory-output, governed-proof, compound
// metric-binding, V6 decision-story, V2 continuation persistence, and the
// final bounded Ask planner/execution, constrained recovery (including a
// full initial package plus #17 targeted extension), explicit
// filter/time/ranking regressions, the authoritative V2 runtime suite,
// certified profile, exact semantic order-count fast paths, durable
// failed-planner V6 receipt regressions, and controller-progress recovery
// across text/OpenAI/Claude transports, including terminal-control
// clarification, native budget-stop, and post-execution terminalization
// regressions, including model-qualified MetricFlow time-capability identity
// coverage, including immutable certified-completeness reload and semantic
// execution-readiness regressions, plus the exact-certified fast-path
// lifecycle/provenance regression, plus the pronoun/named-member follow-up
// continuity regressions (third-person topic classification, prior-result
// member clarification, unmodeled-dimension truthfulness, and honest
// orchestration-budget labelling), plus the V2 lane response-contract and
// narrowed-tool-availability regressions, plus the time-window-vs-row-limit
// parser table and the executed-ranking-clause (invented/unordered limit)
// coverage, plus the typed time-window clause (requirement-clauses) suite,
// plus the shape-clause task-merge regressions, total 2,290 non-skipped
// tests; a
// future accidental skip must not be hidden by a broad package pass.
const EXPECTED_TESTS = 2315;

function discoverTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return discoverTestFiles(target);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [target] : [];
  });
}

function runLane({ name, args, reportPath }) {
  const result = spawnSync(process.execPath, [
    vitestCli,
    'run',
    '--passWithNoTests',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    ...args,
  ], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} test lane failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return JSON.parse(readFileSync(reportPath, 'utf8'));
}

function laneSummary(report) {
  return {
    files: report.testResults.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
    paths: report.testResults.map((result) => realpathSync(result.name)),
  };
}

function assertAggregate({ ordinary, heavy }) {
  const summaries = [ordinary, heavy].map(laneSummary);
  const paths = summaries.flatMap((summary) => summary.paths);
  const uniquePaths = new Set(paths);
  const heavyPaths = new Set(HEAVY_TEST_FILES.map((file) => realpathSync(join(packageRoot, file))));
  const discoveredPaths = new Set(discoverTestFiles(join(packageRoot, 'src')).map((file) => realpathSync(file)));
  const requiredPaths = REQUIRED_TEST_FILES.map((file) => realpathSync(join(packageRoot, file)));

  const failures = [];
  if (discoveredPaths.size !== EXPECTED_TEST_FILES) {
    failures.push(`discovered ${discoveredPaths.size} test files; expected ${EXPECTED_TEST_FILES}`);
  }
  if (paths.length !== EXPECTED_TEST_FILES || uniquePaths.size !== EXPECTED_TEST_FILES) {
    failures.push(`ran ${paths.length} file receipts / ${uniquePaths.size} unique files; expected ${EXPECTED_TEST_FILES} exactly once`);
  }
  if (paths.some((path) => !discoveredPaths.has(path)) || [...discoveredPaths].some((path) => !uniquePaths.has(path))) {
    failures.push('Vitest file receipts do not exactly match the discovered test-file set');
  }
  if (requiredPaths.some((path) => !discoveredPaths.has(path) || !uniquePaths.has(path))) {
    failures.push('required Ask V2 test files were not included exactly once in the package lanes');
  }
  if (summaries[0].paths.some((path) => heavyPaths.has(path))
    || heavyPaths.size !== summaries[1].paths.length
    || summaries[1].paths.some((path) => !heavyPaths.has(path))) {
    failures.push('heavy files were not run exactly once in the isolated lane');
  }

  const totalTests = summaries.reduce((sum, summary) => sum + summary.tests, 0);
  const totalPassed = summaries.reduce((sum, summary) => sum + summary.passed, 0);
  const totalFailed = summaries.reduce((sum, summary) => sum + summary.failed, 0);
  const totalPending = summaries.reduce((sum, summary) => sum + summary.pending, 0);
  const totalTodo = summaries.reduce((sum, summary) => sum + summary.todo, 0);
  if (totalTests !== EXPECTED_TESTS || totalPassed !== EXPECTED_TESTS) {
    failures.push(`ran ${totalPassed}/${totalTests} tests; expected ${EXPECTED_TESTS}/${EXPECTED_TESTS}`);
  }
  if (totalFailed !== 0 || totalPending !== 0 || totalTodo !== 0) {
    failures.push(`found failed=${totalFailed}, skipped=${totalPending}, todo=${totalTodo}; expected all tests to run and pass`);
  }
  if (failures.length > 0) throw new Error(`DQL Agent test-lane audit failed: ${failures.join('; ')}`);

  console.log(
    `\nDQL Agent test-lane audit: ${uniquePaths.size}/${EXPECTED_TEST_FILES} files, `
    + `${totalPassed}/${EXPECTED_TESTS} tests, no skips `
    + `(${summaries[0].files} ordinary bounded + ${summaries[1].files} isolated serial).`,
  );
}

const reportsDirectory = mkdtempSync(join(tmpdir(), 'dql-agent-test-lanes-'));
try {
  const ordinary = runLane({
    name: 'ordinary bounded',
    reportPath: join(reportsDirectory, 'ordinary.json'),
    // Under Turbo's workspace graph, even a percentage-based worker pool can
    // contend with simultaneous package builds/tests enough to breach an
    // unchanged local-index assertion elsewhere in this lane. Run this lane
    // deterministically and serially; the separate heavy lane below remains
    // the only place that changes file grouping or test isolation.
    args: [
      '--maxWorkers=1',
      '--minWorkers=1',
      '--no-file-parallelism',
      ...HEAVY_TEST_FILES.flatMap((file) => [`--exclude=${file}`]),
    ],
  });
  const heavy = runLane({
    name: 'isolated heavy',
    reportPath: join(reportsDirectory, 'heavy.json'),
    args: [
      '--maxWorkers=1',
      '--minWorkers=1',
      '--no-file-parallelism',
      ...HEAVY_TEST_FILES,
    ],
  });
  assertAggregate({ ordinary, heavy });
} finally {
  rmSync(reportsDirectory, { recursive: true, force: true });
}
