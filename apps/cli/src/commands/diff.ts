import { readFileSync } from 'node:fs';
import { diffDQL, renderDiffText } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

export async function runDiff(
  beforePath: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const afterPath = rest[0];
  if (!beforePath || !afterPath) {
    console.error('Usage: dql diff <before.dql> <after.dql>');
    process.exit(1);
  }

  const before = readFileSync(beforePath, 'utf-8');
  const after = readFileSync(afterPath, 'utf-8');
  const report = diffDQL(before, after);

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDiffText(report));
  }

  // Exit 1 when there are changes — makes it scriptable as a gate
  // (`dql diff a b && echo unchanged`), mirroring git-diff and fmt --check.
  if (!report.identical) process.exit(1);
}
