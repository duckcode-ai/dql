import { readFileSync } from 'node:fs';
import { Parser } from '@duckcodeailabs/dql-core';
import { TestRunner, type BlockTestAssertion } from '@duckcodeailabs/dql-governance';
import type { CLIFlags } from '../args.js';

// ── DuckDB executor ───────────────────────────────────────────────────────────

async function makeDuckDBExecutor(dbPath: string) {
  // Dynamic import — duckdb is an optional native dep (not available in wasm builds)
  const duckdb = await import('duckdb').catch(() => null);
  if (!duckdb) {
    throw new Error(
      'duckdb is not installed. Run: npm install duckdb\n' +
      'Or connect a remote database with --connection.',
    );
  }

  const db = new duckdb.default.Database(dbPath === ':memory:' ? ':memory:' : dbPath);
  return {
    execute(sql: string): Promise<Record<string, unknown>[]> {
      return new Promise((resolve, reject) => {
        db.all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
          if (err) reject(err);
          else resolve(rows ?? []);
        });
      });
    },
    close(): void {
      db.close();
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Map a parsed AST test node to the shape TestRunner expects.
 */
function astTestToAssertion(test: any, blockName: string, index: number): BlockTestAssertion {
  // The assertion SQL is the query being checked (may be stored in different AST fields
  // depending on DQL version — handle both shapes gracefully)
  const sql = test.sql ?? test.query ?? `SELECT COUNT(*) AS cnt FROM (${test.expression ?? '1'})`;
  const operator = test.operator ?? '>';
  const threshold = test.expected?.value ?? test.threshold ?? 0;

  return {
    name: test.name ?? `${blockName}:test-${index + 1}`,
    sql,
    operator,
    threshold,
  };
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function runTest(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const parser = new Parser(source, filePath);
  const ast = parser.parse();

  const blocks = ast.statements.filter((s: any) => s.kind === 'BlockDecl');

  if (blocks.length === 0) {
    console.log('\n  ⚠  No block declarations found in file.\n');
    return;
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      file: filePath,
      blocks: blocks.map((b: any) => ({ name: b.name, tests: b.tests?.length ?? 0 })),
    }, null, 2));
    return;
  }

  // Build DuckDB executor for local test runs.
  // --db flag selects the database file; defaults to :memory: so pure-SQL assertions
  // (e.g. SELECT 1 AS n) work without a real dataset.
  const dbPath = (flags as any).db ?? ':memory:';
  let executor: Awaited<ReturnType<typeof makeDuckDBExecutor>> | null = null;
  try {
    executor = await makeDuckDBExecutor(dbPath);
  } catch (err: any) {
    console.error(`\n  ✗ Could not connect to database: ${err.message}\n`);
    process.exit(1);
  }

  const runner = new TestRunner(executor);
  let totalPassed = 0;
  let totalFailed = 0;

  console.log(`\n  Running tests in ${filePath} against ${dbPath === ':memory:' ? 'in-memory DuckDB' : dbPath}\n`);

  for (const block of blocks) {
    const b = block as any;
    const testNodes: any[] = b.tests ?? [];
    const blockName = b.name ?? '(unnamed)';

    console.log(`  Block: "${blockName}"`);

    if (testNodes.length === 0) {
      console.log('    (no assertions)\n');
      continue;
    }

    const assertions = testNodes.map((t: any, i: number) => astTestToAssertion(t, blockName, i));
    const summary = await runner.runTests(assertions);

    for (const result of summary.assertions) {
      const icon = result.passed ? '  ✓' : '  ✗';
      const color = result.passed ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      if (result.error) {
        console.log(`${color}${icon} ${result.name}${reset}`);
        console.log(`       Error: ${result.error}`);
      } else {
        console.log(`${color}${icon} ${result.name}${reset}`);
      }
    }

    totalPassed += summary.passed;
    totalFailed += summary.failed;
    console.log(`\n    ${summary.passed}/${summary.passed + summary.failed} passed (${summary.duration}ms)\n`);
  }

  executor.close();

  const overall = totalFailed === 0 ? '\x1b[32m✓ All tests passed\x1b[0m' : `\x1b[31m✗ ${totalFailed} test(s) failed\x1b[0m`;
  console.log(`  ${overall}\n`);

  if (totalFailed > 0) process.exit(1);
}
