/**
 * `dql eval` — Routing-accuracy harness for the DQL answer agent.
 *
 * Replays a golden set of questions through the EXISTING agent router
 * (`planAgentAnswer`) and scores how well DQL routes each question:
 * certified vs generated vs missing-context (refusal), which certified block
 * it selected, and whether the answer grain matches.
 *
 * The golden set comes from two sources:
 *   1. Every certified block's `examples[].question` in the compiled manifest.
 *      These expect route = certified and expect that same block to be selected.
 *   2. Optional `eval/*.yaml` files in the project, each a list (or { cases: [] })
 *      of `{ question, expectRoute, expectBlock?, expectGrain?, expectRefuse?, name? }`.
 *      These let a repo express the harder categories the block examples cannot:
 *      generated (Tier-2), insufficient-context (refusal), conflict, wrong-grain.
 *
 * This command READS the router output only. It never executes SQL against a
 * warehouse and never changes routing, the manifest schema, or the DQL language.
 *
 * Usage:
 *   dql eval [path]                          Replay the golden set, print a report
 *   dql eval [path] --format json            Emit a machine-readable JSON report
 *   dql eval [path] --min-route-accuracy 0.9 Fail (exit 1) below this route accuracy
 *   dql eval [path] --min-refusal 0.8        Fail (exit 1) below this refusal recall
 *   dql eval [path] --no-examples            Skip manifest block examples (yaml only)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  buildManifest,
  resolveDbtManifestPath,
  type DQLManifest,
  type ManifestBlock,
} from '@duckcodeailabs/dql-core';
import { planAgentAnswer, type PlanAgentAnswerResult } from '@duckcodeailabs/dql-agent';
import type { CLIFlags } from '../args.js';

/** Spec-facing route labels. The router speaks certified/generated_sql/research/clarify. */
export type EvalRoute = 'certified' | 'generated' | 'missing_context' | 'research';

/** The five categories the harness can express and score. */
export type EvalCategory =
  | 'certified'
  | 'generated'
  | 'insufficient_context'
  | 'conflict'
  | 'wrong_grain';

export interface EvalCase {
  /** Stable label for the report. Defaults to the question. */
  name: string;
  question: string;
  /** Where this case came from. */
  source: 'block_example' | 'yaml';
  /** Which scoring category this case exercises. */
  category: EvalCategory;
  expectRoute?: EvalRoute;
  /** Block name we expect the router to select (only meaningful for certified). */
  expectBlock?: string;
  /** Grain we expect the selected block to carry. */
  expectGrain?: string;
  /** When true, we expect a safe refusal (route = missing_context). */
  expectRefuse?: boolean;
}

export interface EvalCaseResult {
  name: string;
  question: string;
  source: EvalCase['source'];
  category: EvalCategory;
  passed: boolean;
  /** What the router actually did. */
  actualRoute: EvalRoute;
  actualBlock?: string;
  actualGrain?: string;
  hasBlockingMissingContext: boolean;
  /** Per-check expectations + outcomes for the human report and JSON. */
  expectRoute?: EvalRoute;
  expectBlock?: string;
  expectGrain?: string;
  expectRefuse?: boolean;
  routeMatch?: boolean;
  blockMatch?: boolean;
  grainMatch?: boolean;
  refusalMatch?: boolean;
  failures: string[];
}

export interface EvalScores {
  total: number;
  passed: number;
  /** route accuracy: cases whose expected route matched / cases with a route expectation. */
  routeAccuracy: number | null;
  /** block-selection accuracy: correct block / cases that expected a specific block. */
  blockSelectionAccuracy: number | null;
  /** grain-match precision: correct grain / cases that expected a specific grain. */
  grainMatchPrecision: number | null;
  /** refusal precision: true refusals / all router refusals across the set. */
  refusalPrecision: number | null;
  /** refusal recall: refusals correctly produced / cases that expected a refusal. */
  refusalRecall: number | null;
}

export interface EvalReport {
  ok: boolean;
  scores: EvalScores;
  thresholds: { minRouteAccuracy: number | null; minRefusal: number | null };
  results: EvalCaseResult[];
}

const ZERO_RESULTS: EvalCaseResult[] = [];

/** Map the router's route vocabulary onto the spec's route labels. */
export function mapRoute(route: PlanAgentAnswerResult['routeDecision']['route']): EvalRoute {
  switch (route) {
    case 'certified':
      return 'certified';
    case 'generated_sql':
      return 'generated';
    case 'clarify':
      return 'missing_context';
    case 'research':
      return 'research';
    default:
      return 'missing_context';
  }
}

function blockNameFromObjectKey(objectKey: string | undefined): string | undefined {
  if (!objectKey) return undefined;
  // Certified block keys are minted as `dql:block:<name>`.
  return objectKey.replace(/^dql:block:/, '');
}

function isCertified(block: ManifestBlock): boolean {
  return String(block.status ?? '').toLowerCase() === 'certified';
}

function normalizeGrain(grain: string | undefined): string {
  return String(grain ?? '').trim().toLowerCase();
}

/**
 * Build the golden set from a compiled manifest plus optional eval/*.yaml.
 * Each certified block contributes one case per example question.
 */
export function collectEvalCases(
  manifest: DQLManifest,
  yamlCases: EvalCase[],
  includeBlockExamples: boolean,
): EvalCase[] {
  const cases: EvalCase[] = [];

  if (includeBlockExamples) {
    for (const block of Object.values(manifest.blocks ?? {})) {
      if (!isCertified(block)) continue;
      for (const example of block.examples ?? []) {
        const question = example.question?.trim();
        if (!question) continue;
        cases.push({
          name: `${block.name} · ${question}`,
          question,
          source: 'block_example',
          category: 'certified',
          expectRoute: 'certified',
          expectBlock: block.name,
          expectGrain: block.grain,
        });
      }
    }
  }

  cases.push(...yamlCases);
  return cases;
}

/** Score a single case against the router's decision. Pure + unit-testable. */
export function scoreCase(
  testCase: EvalCase,
  plan: PlanAgentAnswerResult,
  manifest: DQLManifest,
): EvalCaseResult {
  const actualRoute = mapRoute(plan.routeDecision.route);
  const actualBlock = blockNameFromObjectKey(plan.routeDecision.exactObjectKey);
  const actualGrain = actualBlock ? manifest.blocks?.[actualBlock]?.grain : undefined;
  const hasBlockingMissingContext = (plan.missingContext ?? []).some(
    (item) => item.severity === 'blocking',
  );

  const failures: string[] = [];

  // Refusal expectation takes precedence: a refusal means route = missing_context.
  const expectRoute = testCase.expectRefuse ? 'missing_context' : testCase.expectRoute;

  let routeMatch: boolean | undefined;
  if (expectRoute !== undefined) {
    routeMatch = actualRoute === expectRoute;
    if (!routeMatch) failures.push(`route expected ${expectRoute}, got ${actualRoute}`);
  }

  let refusalMatch: boolean | undefined;
  if (testCase.expectRefuse !== undefined) {
    const actuallyRefused = actualRoute === 'missing_context';
    refusalMatch = actuallyRefused === testCase.expectRefuse;
    if (!refusalMatch) {
      failures.push(
        testCase.expectRefuse
          ? `expected a safe refusal, got route ${actualRoute}`
          : `expected no refusal, but router refused`,
      );
    }
  }

  let blockMatch: boolean | undefined;
  if (testCase.expectBlock !== undefined) {
    blockMatch = actualBlock === testCase.expectBlock;
    if (!blockMatch) {
      failures.push(`block expected ${testCase.expectBlock}, got ${actualBlock ?? 'none'}`);
    }
  }

  let grainMatch: boolean | undefined;
  if (testCase.expectGrain !== undefined) {
    grainMatch = normalizeGrain(actualGrain) === normalizeGrain(testCase.expectGrain);
    if (!grainMatch) {
      failures.push(`grain expected ${testCase.expectGrain}, got ${actualGrain ?? 'none'}`);
    }
  }

  return {
    name: testCase.name,
    question: testCase.question,
    source: testCase.source,
    category: testCase.category,
    passed: failures.length === 0,
    actualRoute,
    actualBlock,
    actualGrain,
    hasBlockingMissingContext,
    expectRoute,
    expectBlock: testCase.expectBlock,
    expectGrain: testCase.expectGrain,
    expectRefuse: testCase.expectRefuse,
    routeMatch,
    blockMatch,
    grainMatch,
    refusalMatch,
    failures,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

/** Aggregate per-case results into the spec's score set. Pure + unit-testable. */
export function computeScores(results: EvalCaseResult[]): EvalScores {
  const routeCases = results.filter((r) => r.expectRoute !== undefined);
  const blockCases = results.filter((r) => r.expectBlock !== undefined);
  const grainCases = results.filter((r) => r.expectGrain !== undefined);
  const refusalExpected = results.filter((r) => r.expectRefuse === true);

  // Refusal precision: of every case where the router refused, how many should have?
  const routerRefused = results.filter((r) => r.actualRoute === 'missing_context');
  const routerRefusedCorrectly = routerRefused.filter((r) => r.expectRefuse === true);

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    routeAccuracy: ratio(routeCases.filter((r) => r.routeMatch).length, routeCases.length),
    blockSelectionAccuracy: ratio(
      blockCases.filter((r) => r.blockMatch).length,
      blockCases.length,
    ),
    grainMatchPrecision: ratio(grainCases.filter((r) => r.grainMatch).length, grainCases.length),
    refusalPrecision: ratio(routerRefusedCorrectly.length, routerRefused.length),
    refusalRecall: ratio(
      refusalExpected.filter((r) => r.refusalMatch).length,
      refusalExpected.length,
    ),
  };
}

interface RawYamlCase {
  name?: string;
  question?: string;
  expectRoute?: string;
  expectBlock?: string;
  expectGrain?: string;
  expectRefuse?: boolean;
  category?: string;
}

function normalizeYamlRoute(value: string | undefined): EvalRoute | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'certified') return 'certified';
  if (v === 'generated' || v === 'generated_sql') return 'generated';
  if (v === 'missing_context' || v === 'missing-context' || v === 'clarify' || v === 'refuse') {
    return 'missing_context';
  }
  if (v === 'research') return 'research';
  return undefined;
}

function inferCategory(raw: RawYamlCase, route: EvalRoute | undefined): EvalCategory {
  const explicit = raw.category?.trim().toLowerCase();
  if (explicit === 'certified') return 'certified';
  if (explicit === 'generated') return 'generated';
  if (explicit === 'insufficient_context' || explicit === 'refusal') return 'insufficient_context';
  if (explicit === 'conflict') return 'conflict';
  if (explicit === 'wrong_grain') return 'wrong_grain';
  // Infer from expectations when the author did not label it.
  if (raw.expectRefuse) return 'insufficient_context';
  if (route === 'missing_context') return 'insufficient_context';
  if (route === 'generated') return 'generated';
  return 'certified';
}

/** Load and normalize all `eval/*.yaml` cases for a project. */
export function loadYamlEvalCases(projectRoot: string): EvalCase[] {
  const evalDir = join(projectRoot, 'eval');
  if (!existsSync(evalDir)) return [];

  const files = readdirSync(evalDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const cases: EvalCase[] = [];

  for (const file of files.sort()) {
    const raw = loadYaml(readFileSync(join(evalDir, file), 'utf-8')) as
      | RawYamlCase[]
      | { cases?: RawYamlCase[] }
      | null;
    const rawCases = Array.isArray(raw) ? raw : raw?.cases ?? [];
    for (const rc of rawCases) {
      const question = rc.question?.trim();
      if (!question) continue;
      const route = normalizeYamlRoute(rc.expectRoute);
      cases.push({
        name: rc.name?.trim() || `${file} · ${question}`,
        question,
        source: 'yaml',
        category: inferCategory(rc, route),
        expectRoute: route,
        expectBlock: rc.expectBlock?.trim() || undefined,
        expectGrain: rc.expectGrain?.trim() || undefined,
        expectRefuse: typeof rc.expectRefuse === 'boolean' ? rc.expectRefuse : undefined,
      });
    }
  }

  return cases;
}

/**
 * Run the full eval: build (or read) the manifest, collect cases, replay each
 * through the router, score, and assemble the report. Side-effect free except
 * for invoking the (read-only) router. Returns a structured report.
 */
export async function runEvalHarness(
  projectRoot: string,
  options: { includeBlockExamples: boolean; minRouteAccuracy: number | null; minRefusal: number | null },
): Promise<EvalReport> {
  const manifest = buildManifest({
    projectRoot,
    dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined,
  });

  const yamlCases = loadYamlEvalCases(projectRoot);
  const cases = collectEvalCases(manifest, yamlCases, options.includeBlockExamples);

  const results: EvalCaseResult[] = [];
  for (const testCase of cases) {
    const plan = await planAgentAnswer(projectRoot, {
      question: testCase.question,
      surface: 'cli',
    });
    results.push(scoreCase(testCase, plan, manifest));
  }

  const scores = computeScores(results.length > 0 ? results : ZERO_RESULTS);
  const ok = meetsThresholds(scores, options.minRouteAccuracy, options.minRefusal);

  return {
    ok,
    scores,
    thresholds: { minRouteAccuracy: options.minRouteAccuracy, minRefusal: options.minRefusal },
    results,
  };
}

/** A threshold gate only fails when a configured threshold has measurable data below it. */
export function meetsThresholds(
  scores: EvalScores,
  minRouteAccuracy: number | null,
  minRefusal: number | null,
): boolean {
  if (
    minRouteAccuracy !== null &&
    scores.routeAccuracy !== null &&
    scores.routeAccuracy < minRouteAccuracy
  ) {
    return false;
  }
  if (minRefusal !== null && scores.refusalRecall !== null && scores.refusalRecall < minRefusal) {
    return false;
  }
  return true;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 1000) / 10}%`;
}

export async function runEval(
  pathArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const allArgs = [...(pathArg ? [pathArg] : []), ...rest];
  const positional = allArgs.filter((a) => !a.startsWith('-'));
  const projectRoot = resolve(positional[0] ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error(
      'No DQL project found (missing dql.config.json). Run from a project root or pass a project path.',
    );
    process.exitCode = 1;
    return;
  }

  const includeBlockExamples = !flags.noExamples;
  const minRouteAccuracy = flags.minRouteAccuracy ?? null;
  const minRefusal = flags.minRefusal ?? null;

  const report = await runEvalHarness(projectRoot, {
    includeBlockExamples,
    minRouteAccuracy,
    minRefusal,
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  printReport(report);
  if (!report.ok) process.exitCode = 1;
}

function printReport(report: EvalReport): void {
  const { results, scores } = report;

  console.log('\n  DQL Eval — routing accuracy');
  console.log('  ' + '='.repeat(50));

  if (results.length === 0) {
    console.log('\n  No eval cases found.');
    console.log('  Add `examples = [{ question = "..." }]` to certified blocks,');
    console.log('  or create eval/*.yaml cases, then run `dql compile` and retry.\n');
    return;
  }

  console.log('');
  for (const result of results) {
    const icon = result.passed ? '✓' : '✕';
    const route = `[${result.actualRoute}]`;
    console.log(`  ${icon} ${route} ${result.name}`);
    for (const failure of result.failures) {
      console.log(`      - ${failure}`);
    }
  }

  console.log('\n  Scores');
  console.log('  ' + '-'.repeat(50));
  console.log(`  Cases passed:            ${scores.passed}/${scores.total}`);
  console.log(`  Route accuracy:          ${formatRate(scores.routeAccuracy)}`);
  console.log(`  Block-selection accuracy:${formatRate(scores.blockSelectionAccuracy).padStart(7)}`);
  console.log(`  Grain-match precision:   ${formatRate(scores.grainMatchPrecision)}`);
  console.log(`  Refusal precision:       ${formatRate(scores.refusalPrecision)}`);
  console.log(`  Refusal recall:          ${formatRate(scores.refusalRecall)}`);

  const t = report.thresholds;
  if (t.minRouteAccuracy !== null || t.minRefusal !== null) {
    console.log('\n  Thresholds');
    console.log('  ' + '-'.repeat(50));
    if (t.minRouteAccuracy !== null) {
      console.log(`  --min-route-accuracy ${t.minRouteAccuracy}  (route accuracy ${formatRate(scores.routeAccuracy)})`);
    }
    if (t.minRefusal !== null) {
      console.log(`  --min-refusal ${t.minRefusal}  (refusal recall ${formatRate(scores.refusalRecall)})`);
    }
    console.log(`\n  ${report.ok ? '✓ PASS — thresholds met.' : '✕ FAIL — below configured thresholds.'}`);
  }
  console.log('');
}
