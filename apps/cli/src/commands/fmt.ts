import { readFileSync, writeFileSync } from 'node:fs';
import { formatDQL } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

export async function runFmt(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const formatted = formatDQL(source);
  const changed = source !== formatted;

  if (flags.check) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({ file: filePath, changed, mode: 'check' }, null, 2));
    } else if (changed) {
      console.log(`\n  ✗ Needs formatting: ${filePath}\n`);
    } else {
      console.log(`\n  ✓ Already formatted: ${filePath}\n`);
    }
    if (changed) process.exit(1);
    return;
  }

  if (changed) {
    writeFileSync(filePath, formatted, 'utf-8');
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ file: filePath, changed, mode: 'write' }, null, 2));
  } else if (changed) {
    console.log(`\n  ✓ Formatted: ${filePath}\n`);
  } else {
    console.log(`\n  ✓ No changes: ${filePath}\n`);
  }
}
