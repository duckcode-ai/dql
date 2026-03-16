import { readFileSync } from 'node:fs';
import { Parser } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

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

export async function runTest(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const parser = new Parser(source, filePath);
  const ast = parser.parse();

  // Find block declarations with tests
  const blocks = ast.statements.filter((s: any) => s.kind === 'BlockDecl');

  if (blocks.length === 0) {
    console.log('\n  ⚠ No block declarations found in file.');
    console.log('');
    return;
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      file: filePath,
      blocks: blocks.map((b: any) => ({
        name: b.name,
        tests: b.tests?.length ?? 0,
      })),
      note: 'Test execution requires a database connection. Use --connection to specify.',
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Found ${blocks.length} block(s) in ${filePath}`);
  for (const block of blocks) {
    const b = block as any;
    const testCount = b.tests?.length ?? 0;
    console.log(`\n  Block: "${b.name}"`);
    console.log(`    Tests: ${testCount} assertion(s)`);
    if (testCount > 0) {
      for (const test of b.tests) {
        console.log(`    → assert ${test.field} ${test.operator} ${formatExpected(test.expected)}`);
      }
    }
    console.log('    Status: ⚠ Dry run (no database connection)');
    console.log('    Hint: Connect a database to execute assertions');
  }
  console.log('');
}
