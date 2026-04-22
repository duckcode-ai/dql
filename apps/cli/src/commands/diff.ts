import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffDQL, diffNotebook, renderDiffText, type DiffReport } from '@duckcodeailabs/dql-core';
import { findRepoContext, readHeadBlob } from '../git-service.js';
import type { CLIFlags } from '../args.js';

export async function runDiff(
  firstArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const secondArg = rest[0];

  if (!firstArg) {
    console.error('Usage: dql diff <path> | dql diff <before> <after>');
    process.exit(1);
  }

  const report = secondArg
    ? await diffTwoFiles(firstArg, secondArg)
    : await diffAgainstHead(firstArg);

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDiffText(report));
  }

  // Exit 1 when there are changes — makes it scriptable as a gate
  // (`dql diff a b && echo unchanged`), mirroring git-diff and fmt --check.
  if (!report.identical) process.exit(1);
}

async function diffTwoFiles(beforePath: string, afterPath: string): Promise<DiffReport> {
  const before = readFileSync(beforePath, 'utf-8');
  const after = readFileSync(afterPath, 'utf-8');
  return diffByExtension(afterPath, before, after);
}

async function diffAgainstHead(path: string): Promise<DiffReport> {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    console.error(`Error: file not found: ${path}`);
    process.exit(1);
  }
  const ctx = findRepoContext(absPath);
  if (!ctx) {
    console.error(`Error: ${path} is not inside a git repository. Use: dql diff <before> <after>`);
    process.exit(1);
  }
  const before = await readHeadBlob(ctx);
  const after = readFileSync(absPath, 'utf-8');
  return diffByExtension(absPath, before, after);
}

function diffByExtension(path: string, before: string | null, after: string): DiffReport {
  if (path.endsWith('.dqlnb')) {
    return diffNotebook(before, after);
  }
  // diffDQL doesn't accept null — newly added files diff against empty source.
  return diffDQL(before ?? '', after);
}
