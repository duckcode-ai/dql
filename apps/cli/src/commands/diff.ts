import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  diffDQL,
  diffNotebook,
  renderDiffText,
  computeImpactFromDiff,
  renderImpactText,
  changedBlocksFromDiff,
  LineageGraph,
  type DiffReport,
  type ImpactReport,
} from '@duckcodeailabs/dql-core';
import { findRepoContext, readHeadBlob } from '../git-service.js';
import type { CLIFlags } from '../args.js';

export async function runDiff(
  firstArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const secondArg = rest.find((a) => !a.startsWith('-')) ?? undefined;

  if (!firstArg) {
    console.error('Usage: dql diff <path> [--impact] | dql diff <before> <after> [--impact]');
    process.exit(1);
  }

  const report = secondArg
    ? await diffTwoFiles(firstArg, secondArg)
    : await diffAgainstHead(firstArg);

  // ---- Impact mode: --impact turns `dql diff` into an impact/re-cert gate ----
  if (flags.impact) {
    const impact = computeImpact(firstArg, report, flags);
    emitImpact(report, impact, flags);
    // Gate: non-zero when certified downstream is invalidated without re-cert.
    if (impact && impact.hasCertifiedInvalidation) process.exit(1);
    return;
  }

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

// ---- Impact analysis (--impact) ----

/**
 * Compute the downstream impact + re-cert report for a diff. Resolves the
 * project's lineage graph by walking up from the changed file to the nearest
 * `dql.config.json`, then reading `dql-manifest.json` (the compiled lineage).
 * Returns `null` when no project/manifest can be located — in that case the
 * gate is a no-op (we cannot know downstream impact without a graph).
 */
function computeImpact(changedPath: string, report: DiffReport, flags: CLIFlags): ImpactReport | null {
  const graph = loadProjectLineageGraph(changedPath, flags);
  if (!graph) return null;
  return computeImpactFromDiff(graph, report.changes);
}

function emitImpact(report: DiffReport, impact: ImpactReport | null, flags: CLIFlags): void {
  if (flags.format === 'json') {
    if (impact) {
      console.log(JSON.stringify(impact, null, 2));
    } else {
      // No graph available — emit a minimal, still-structured payload so the
      // `--format json` contract holds and consumers can detect the gap.
      console.log(
        JSON.stringify(
          {
            changedBlocks: changedBlocksFromDiff(report.changes),
            downstream: [],
            crossDomainImpacts: [],
            requiresRecert: [],
            domainTrustDelta: [],
            hasCertifiedInvalidation: false,
            note: 'No compiled lineage graph found (dql-manifest.json). Run `dql compile` for downstream impact.',
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (!impact) {
    console.log(renderDiffText(report));
    console.log('');
    console.log('  Impact: no compiled lineage graph found (dql-manifest.json).');
    console.log('  Run `dql compile` to enable downstream impact + re-cert gating.');
    return;
  }
  console.log(renderImpactText(impact));
}

/**
 * Locate the project root for a changed file and load its compiled lineage
 * graph from `dql-manifest.json`. Walks up from the file looking for
 * `dql.config.json`; falls back to cwd. Returns `null` if no manifest is found.
 */
function loadProjectLineageGraph(changedPath: string, _flags: CLIFlags): LineageGraph | null {
  const projectRoot = findProjectRoot(resolve(changedPath));
  if (!projectRoot) return null;

  const manifestPath = join(projectRoot, 'dql-manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (manifest.lineage?.nodes && manifest.lineage?.edges) {
      return LineageGraph.fromJSON({
        nodes: manifest.lineage.nodes,
        edges: manifest.lineage.edges,
      });
    }
  } catch {
    return null;
  }
  return null;
}

/** Walk up from a path to the nearest directory containing `dql.config.json`. */
function findProjectRoot(fromPath: string): string | null {
  let dir = existsSync(fromPath) && isDirectory(fromPath) ? fromPath : dirname(fromPath);
  while (true) {
    if (existsSync(join(dir, 'dql.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to cwd if it is itself a project.
  const cwd = resolve('.');
  if (existsSync(join(cwd, 'dql.config.json'))) return cwd;
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
