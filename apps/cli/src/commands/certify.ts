import { readFileSync } from 'node:fs';
import { Parser } from '@duckcodeailabs/dql-core';
import { Certifier } from '@duckcodeailabs/dql-governance';
import type { BlockRecord, TestResultSummary, TestAssertionResult } from '@duckcodeailabs/dql-project';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { buildExecutionPlan, type NotebookCell } from '@duckcodeailabs/dql-notebook';
import { loadProjectConfig, prepareLocalExecution } from '../local-runtime.js';
import type { CLIFlags } from '../args.js';

function resolveConnection(flags: CLIFlags): ConnectionConfig {
  const conn = flags.connection;
  if (!conn || conn === 'duckdb' || conn === 'file') {
    return { driver: 'file', filepath: ':memory:' };
  }
  return { driver: 'duckdb', filepath: conn };
}

function compareValues(actual: unknown, operator: string, expected: unknown): boolean {
  const a = Number(actual);
  const e = Number(expected);
  switch (operator) {
    case '>': return a > e;
    case '>=': return a >= e;
    case '<': return a < e;
    case '<=': return a <= e;
    case '==': case '=': return actual == expected;
    case '!=': return actual != expected;
    default: return false;
  }
}

function formatExpected(expr: any): string {
  if (expr === null || expr === undefined) return 'null';
  if (typeof expr !== 'object') return String(expr);
  if (Object.prototype.hasOwnProperty.call(expr, 'value')) return String(expr.value);
  if (Object.prototype.hasOwnProperty.call(expr, 'name')) return String(expr.name);
  if (expr.kind === 'ArrayLiteral' && Array.isArray(expr.elements)) {
    return `[${expr.elements.map((e: any) => formatExpected(e)).join(', ')}]`;
  }
  return JSON.stringify(expr);
}

async function runBlockTests(
  b: any,
  source: string,
  flags: CLIFlags,
): Promise<TestResultSummary | null> {
  const tests: any[] = b.tests ?? [];
  if (tests.length === 0) return null;

  const projectRoot = process.cwd();
  const projectConfig = loadProjectConfig(projectRoot);
  const connection = resolveConnection(flags);
  const executor = new QueryExecutor();
  const start = Date.now();
  const assertions: TestAssertionResult[] = [];
  let passed = 0;
  let failed = 0;

  try {
    const cell: NotebookCell = { id: b.name, type: 'dql', source, title: b.name };
    const plan = buildExecutionPlan(cell);
    if (!plan) {
      return {
        passed: 0,
        failed: tests.length,
        skipped: 0,
        duration: Date.now() - start,
        assertions: tests.map((t: any) => ({
          name: `assert ${t.field} ${t.operator} ${formatExpected(t.expected)}`,
          passed: false,
          error: 'Could not build execution plan for block',
        })),
        runAt: new Date(),
      };
    }

    const prepared = prepareLocalExecution(plan.sql, connection, projectRoot, projectConfig);
    const rawResult = await executor.executeQuery(prepared.sql, plan.sqlParams, plan.variables, prepared.connection);

    const columns = Array.isArray(rawResult?.columns)
      ? rawResult.columns.map((c: any) => typeof c === 'string' ? c : c?.name ?? String(c))
      : [];
    const rows = Array.isArray(rawResult?.rows) ? rawResult.rows : [];
    const rowCount = rows.length;

    for (const test of plan.tests) {
      const name = `assert ${test.field} ${test.operator} ${formatExpected(test.expected)}`;
      let actual: unknown;
      let pass: boolean;

      if (test.field === 'row_count') {
        actual = rowCount;
        pass = compareValues(actual, test.operator, test.expected);
      } else if (!columns.includes(test.field)) {
        assertions.push({ name, passed: false, error: `Column '${test.field}' not found in results` });
        failed++;
        continue;
      } else {
        actual = rows[0]?.[test.field];
        pass = compareValues(actual, test.operator, test.expected);
      }

      if (pass) {
        assertions.push({ name, passed: true, actual });
        passed++;
      } else {
        assertions.push({
          name,
          passed: false,
          actual,
          expected: test.expected,
          error: `${String(actual)} ${test.operator} ${formatExpected(test.expected)} is false`,
        });
        failed++;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const test of tests) {
      assertions.push({
        name: `assert ${test.field} ${test.operator} ${formatExpected(test.expected)}`,
        passed: false,
        error: msg,
      });
      failed++;
    }
  }

  return {
    passed,
    failed,
    skipped: 0,
    duration: Date.now() - start,
    assertions,
    runAt: new Date(),
  };
}

export async function runCertify(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const parser = new Parser(source, filePath);
  const ast = parser.parse();

  const blocks = ast.statements.filter((s: any) => s.kind === 'BlockDecl');

  if (blocks.length === 0) {
    console.log('\n  ⚠ No block declarations found in file.');
    console.log('');
    return;
  }

  const certifier = new Certifier();
  let anyFailed = false;

  for (const block of blocks) {
    const b = block as any;
    const record: BlockRecord = {
      id: 'local',
      name: b.name ?? 'unnamed',
      domain: b.domain ?? '',
      type: b.type ?? '',
      version: '0.0.0',
      status: 'draft',
      gitRepo: '',
      gitPath: filePath,
      gitCommitSha: '',
      description: b.description ?? '',
      owner: b.owner ?? '',
      tags: b.tags ?? [],
      dependencies: [],
      usedInCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Run tests unless --skip-tests is set
    let testResults: TestResultSummary | null = null;
    if (!flags.skipTests && (b.tests ?? []).length > 0) {
      if (!flags.connection) {
        if (flags.format !== 'json') {
          console.log(`\n  Block: "${record.name}"`);
          console.log('  ⚠ Tests skipped: no database connection. Use --connection to run assertions.');
        }
      } else {
        testResults = await runBlockTests(b, source, flags);
      }
    }

    const result = certifier.evaluate(record, testResults ?? undefined);

    if (flags.format === 'json') {
      console.log(JSON.stringify({ ...result, testResults }, null, 2));
      continue;
    }

    console.log(`\n  Block: "${record.name}"`);
    if (result.certified) {
      console.log('  Status: ✓ CERTIFIABLE');
    } else {
      console.log('  Status: ✗ NOT CERTIFIABLE');
      anyFailed = true;
    }

    // Print test results
    if (testResults) {
      console.log(`\n  Tests (${testResults.passed + testResults.failed} assertions):`);
      for (const a of testResults.assertions) {
        if (a.passed) {
          const actual = a.actual !== undefined ? ` (actual: ${String(a.actual)})` : '';
          console.log(`    ✓ ${a.name}${actual}`);
        } else {
          console.log(`    ✗ ${a.name}${a.error ? ` — ${a.error}` : ''}`);
          anyFailed = true;
        }
      }
    }

    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const e of result.errors) {
        console.log(`    ✗ ${e.rule}: ${e.message}`);
      }
    }
    if (result.warnings.length > 0) {
      console.log(`\n  Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) {
        console.log(`    ⚠ ${w.rule}: ${w.message}`);
      }
    }
  }
  console.log('');

  if (anyFailed) {
    process.exitCode = 1;
  }
}
