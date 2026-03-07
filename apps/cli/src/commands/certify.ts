import { readFileSync } from 'node:fs';
import { Parser } from '@dql/core';
import { Certifier } from '@dql/governance';
import type { BlockRecord } from '@dql/project';
import type { CLIFlags } from '../args.js';

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

    const result = certifier.evaluate(record);

    if (flags.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      continue;
    }

    console.log(`\n  Block: "${record.name}"`);
    if (result.certified) {
      console.log('  Status: ✓ CERTIFIABLE');
    } else {
      console.log('  Status: ✗ NOT CERTIFIABLE');
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
}
