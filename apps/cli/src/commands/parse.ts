import { readFileSync } from 'node:fs';
import { Parser, SemanticAnalyzer, printAST } from '@dql/core';
import type { CLIFlags } from '../args.js';

export async function runParse(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');

  let ast;
  try {
    const parser = new Parser(source, filePath);
    ast = parser.parse();
  } catch (err: any) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({ file: filePath, error: err.message }, null, 2));
    } else {
      console.error(`\n  ✗ Parse error: ${err.message}\n`);
    }
    process.exit(1);
    return;
  }

  const analyzer = new SemanticAnalyzer();
  const diagnostics = analyzer.analyze(ast);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      file: filePath,
      statements: ast.statements.length,
      diagnostics,
      ast: flags.verbose ? ast : undefined,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Parsed: ${filePath}`);
  console.log(`    Statements: ${ast.statements.length}`);

  if (false) {
    const parseErrors: any[] = [];
    console.log(`\n  ✗ Parse errors (${parseErrors.length}):`);
    for (const e of parseErrors) {
      console.log(`    → ${e.message}`);
    }
  }

  if (diagnostics.length > 0) {
    const errors = diagnostics.filter((d: any) => d.severity === 'error');
    const warnings = diagnostics.filter((d: any) => d.severity === 'warning');
    if (errors.length > 0) {
      console.log(`\n  ✗ Errors (${errors.length}):`);
      for (const e of errors) console.log(`    → ${e.message}`);
    }
    if (warnings.length > 0) {
      console.log(`\n  ⚠ Warnings (${warnings.length}):`);
      for (const w of warnings) console.log(`    → ${w.message}`);
    }
  } else {
    console.log('    Diagnostics: ✓ No errors, no warnings');
  }

  if (flags.verbose) {
    console.log('\n  AST:');
    console.log(printAST(ast).split('\n').map((l) => `    ${l}`).join('\n'));
  }

  console.log('');
}
