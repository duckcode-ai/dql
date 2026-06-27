import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import type { PlanAgentAnswerResult } from '@duckcodeailabs/dql-agent';
import {
  collectEvalCases,
  computeScores,
  loadYamlEvalCases,
  mapRoute,
  meetsThresholds,
  runEval,
  scoreCase,
  type EvalCase,
} from './eval.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Synthetic router-result builders (keeps unit tests deterministic) ----

function makePlan(overrides: {
  route: PlanAgentAnswerResult['routeDecision']['route'];
  exactObjectKey?: string;
  blocking?: boolean;
}): PlanAgentAnswerResult {
  const missingContext = overrides.blocking
    ? [{ kind: 'metadata' as const, message: 'no safe source', severity: 'blocking' as const }]
    : [];
  return {
    contextPackId: 'pack-1',
    contextPack: {} as PlanAgentAnswerResult['contextPack'],
    routeDecision: {
      route: overrides.route,
      intent: 'exact_certified_lookup',
      reason: 'test',
      trustLabel: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: overrides.exactObjectKey,
      selectedEvidence: [],
      missingContext,
      followUps: [],
    },
    evidenceRoles: [] as PlanAgentAnswerResult['evidenceRoles'],
    allowedSqlContext: { relations: [], sourceBlockSql: [] },
    missingContext,
    warnings: [],
    freshness: {} as PlanAgentAnswerResult['freshness'],
  };
}

function makeManifest(
  blocks: Record<string, { status?: string; grain?: string; examples?: { question: string }[] }>,
): DQLManifest {
  const fullBlocks: DQLManifest['blocks'] = {};
  for (const [name, b] of Object.entries(blocks)) {
    fullBlocks[name] = {
      name,
      filePath: `blocks/${name}.dql`,
      status: b.status,
      grain: b.grain,
      examples: b.examples,
    } as DQLManifest['blocks'][string];
  }
  return { blocks: fullBlocks } as DQLManifest;
}

describe('mapRoute', () => {
  it('maps the router vocabulary onto spec route labels', () => {
    expect(mapRoute('certified')).toBe('certified');
    expect(mapRoute('generated_sql')).toBe('generated');
    expect(mapRoute('clarify')).toBe('missing_context');
    expect(mapRoute('research')).toBe('research');
  });
});

describe('collectEvalCases', () => {
  it('turns each certified block example into a certified-expecting case', () => {
    const manifest = makeManifest({
      revenue_total: {
        status: 'certified',
        grain: 'week',
        examples: [{ question: 'What was revenue last week?' }],
      },
      draft_block: {
        status: 'draft',
        examples: [{ question: 'ignored because not certified' }],
      },
    });
    const cases = collectEvalCases(manifest, [], true);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      source: 'block_example',
      category: 'certified',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
      expectGrain: 'week',
    });
  });

  it('skips block examples when includeBlockExamples is false', () => {
    const manifest = makeManifest({
      revenue_total: { status: 'certified', examples: [{ question: 'q' }] },
    });
    const yaml: EvalCase[] = [
      { name: 'y', question: 'q2', source: 'yaml', category: 'certified', expectRoute: 'certified' },
    ];
    const cases = collectEvalCases(manifest, yaml, false);
    expect(cases).toHaveLength(1);
    expect(cases[0].source).toBe('yaml');
  });
});

describe('scoreCase', () => {
  const manifest = makeManifest({
    revenue_total: { status: 'certified', grain: 'week' },
    customer_revenue: { status: 'certified', grain: 'customer_id' },
  });

  it('passes a certified-exact case (route + block + grain)', () => {
    const testCase: EvalCase = {
      name: 'certified',
      question: 'What was revenue last week?',
      source: 'block_example',
      category: 'certified',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
      expectGrain: 'week',
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:revenue_total' }),
      manifest,
    );
    expect(result.passed).toBe(true);
    expect(result.actualBlock).toBe('revenue_total');
    expect(result.actualGrain).toBe('week');
    expect(result.routeMatch && result.blockMatch && result.grainMatch).toBe(true);
  });

  it('scores a generated (Tier-2) case', () => {
    const testCase: EvalCase = {
      name: 'generated',
      question: 'revenue by region ranked',
      source: 'yaml',
      category: 'generated',
      expectRoute: 'generated',
    };
    const result = scoreCase(testCase, makePlan({ route: 'generated_sql' }), manifest);
    expect(result.passed).toBe(true);
    expect(result.actualRoute).toBe('generated');
  });

  it('scores an insufficient-context refusal case', () => {
    const testCase: EvalCase = {
      name: 'refusal',
      question: 'unanswerable question with no source',
      source: 'yaml',
      category: 'insufficient_context',
      expectRefuse: true,
    };
    const result = scoreCase(testCase, makePlan({ route: 'clarify', blocking: true }), manifest);
    expect(result.passed).toBe(true);
    expect(result.actualRoute).toBe('missing_context');
    expect(result.refusalMatch).toBe(true);
    expect(result.hasBlockingMissingContext).toBe(true);
  });

  it('fails a refusal case when the router answered instead of refusing', () => {
    const testCase: EvalCase = {
      name: 'refusal-should-have-happened',
      question: 'q',
      source: 'yaml',
      category: 'insufficient_context',
      expectRefuse: true,
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:revenue_total' }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.refusalMatch).toBe(false);
    expect(result.failures.join(' ')).toContain('expected a safe refusal');
  });

  it('detects a wrong-grain mismatch even when route + block match', () => {
    const testCase: EvalCase = {
      name: 'wrong-grain',
      question: 'revenue per customer',
      source: 'yaml',
      category: 'wrong_grain',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
      // We expect customer_id grain, but revenue_total is week grain.
      expectGrain: 'customer_id',
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:revenue_total' }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.grainMatch).toBe(false);
    expect(result.failures.join(' ')).toContain('grain expected customer_id');
  });

  it('detects a conflict / wrong-block selection', () => {
    const testCase: EvalCase = {
      name: 'conflict',
      question: 'ambiguous revenue question',
      source: 'yaml',
      category: 'conflict',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:customer_revenue' }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.blockMatch).toBe(false);
    expect(result.failures.join(' ')).toContain('block expected revenue_total, got customer_revenue');
  });
});

describe('computeScores', () => {
  it('aggregates route, block, grain, and refusal scores', () => {
    const manifest = makeManifest({
      a: { status: 'certified', grain: 'week' },
      b: { status: 'certified', grain: 'customer_id' },
    });
    const results = [
      // certified-exact, fully correct
      scoreCase(
        { name: '1', question: 'q1', source: 'block_example', category: 'certified', expectRoute: 'certified', expectBlock: 'a', expectGrain: 'week' },
        makePlan({ route: 'certified', exactObjectKey: 'dql:block:a' }),
        manifest,
      ),
      // generated, correct route
      scoreCase(
        { name: '2', question: 'q2', source: 'yaml', category: 'generated', expectRoute: 'generated' },
        makePlan({ route: 'generated_sql' }),
        manifest,
      ),
      // refusal expected and produced
      scoreCase(
        { name: '3', question: 'q3', source: 'yaml', category: 'insufficient_context', expectRefuse: true },
        makePlan({ route: 'clarify', blocking: true }),
        manifest,
      ),
      // wrong grain: route ok, grain wrong
      scoreCase(
        { name: '4', question: 'q4', source: 'yaml', category: 'wrong_grain', expectRoute: 'certified', expectBlock: 'a', expectGrain: 'customer_id' },
        makePlan({ route: 'certified', exactObjectKey: 'dql:block:a' }),
        manifest,
      ),
    ];
    const scores = computeScores(results);
    expect(scores.total).toBe(4);
    // route expectations on cases 1, 2, 4 — all routes matched
    expect(scores.routeAccuracy).toBe(1);
    // block expectations on cases 1, 4 — both selected block a
    expect(scores.blockSelectionAccuracy).toBe(1);
    // grain expectations on cases 1 (pass) and 4 (fail) => 0.5
    expect(scores.grainMatchPrecision).toBe(0.5);
    // only case 3 refused, and it was correct => precision 1, recall 1
    expect(scores.refusalPrecision).toBe(1);
    expect(scores.refusalRecall).toBe(1);
  });

  it('returns null scores when a dimension has no expectations', () => {
    const scores = computeScores([]);
    expect(scores.routeAccuracy).toBeNull();
    expect(scores.refusalRecall).toBeNull();
  });
});

describe('meetsThresholds', () => {
  const base = {
    total: 10,
    passed: 9,
    routeAccuracy: 0.9,
    blockSelectionAccuracy: 0.8,
    grainMatchPrecision: 0.7,
    refusalPrecision: 1,
    refusalRecall: 0.85,
  };

  it('passes when above both thresholds', () => {
    expect(meetsThresholds(base, 0.85, 0.8)).toBe(true);
  });

  it('fails when route accuracy is below the route threshold', () => {
    expect(meetsThresholds(base, 0.95, null)).toBe(false);
  });

  it('fails when refusal recall is below the refusal threshold', () => {
    expect(meetsThresholds(base, null, 0.9)).toBe(false);
  });

  it('ignores a threshold when the dimension has no measurable data (null score)', () => {
    expect(meetsThresholds({ ...base, refusalRecall: null }, null, 0.9)).toBe(true);
  });
});

describe('loadYamlEvalCases', () => {
  it('loads and normalizes eval/*.yaml cases including expectRefuse shorthand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-eval-yaml-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'routing.yaml'),
      [
        '- question: "rank revenue by region"',
        '  expectRoute: generated',
        '- question: "what is the meaning of life?"',
        '  expectRefuse: true',
        '- name: "explicit conflict"',
        '  question: "ambiguous revenue"',
        '  expectRoute: certified',
        '  expectBlock: "revenue_total"',
        '  category: conflict',
      ].join('\n'),
    );
    const cases = loadYamlEvalCases(dir);
    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({ category: 'generated', expectRoute: 'generated', source: 'yaml' });
    expect(cases[1]).toMatchObject({ category: 'insufficient_context', expectRefuse: true });
    expect(cases[2]).toMatchObject({ category: 'conflict', expectBlock: 'revenue_total' });
  });

  it('returns [] when there is no eval directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-eval-empty-'));
    tempDirs.push(dir);
    expect(loadYamlEvalCases(dir)).toEqual([]);
  });
});

// ---- End-to-end: run the REAL router against a temp project ----

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-eval-e2e-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'eval_demo' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'top_scorers.dql'),
    `block "Top 10 Goal Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top 10 NBA players by total points scored."
  tags = ["nba", "player", "points", "scoring"]
  grain = "player_id"
  llmContext = "Use for top scorers only."
  examples = [{ question = "Who were the top scorers?" }]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
    ORDER BY total_points DESC
    LIMIT 10
  """
}`,
    'utf-8',
  );
  mkdirSync(join(root, 'eval'), { recursive: true });
  writeFileSync(
    join(root, 'eval', 'refusal.yaml'),
    [
      '- name: "off-topic refusal"',
      '  question: "What is the airspeed velocity of an unladen swallow?"',
      '  expectRefuse: true',
    ].join('\n'),
  );
  return root;
}

describe('runEval (end-to-end against the real router)', () => {
  it('emits a JSON report scoring a certified-exact example and a refusal', async () => {
    const projectRoot = seedProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runEval(projectRoot, [], { format: 'json' } as never);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.scores.total).toBe(2);

    const certified = payload.results.find((r: { source: string }) => r.source === 'block_example');
    expect(certified.actualRoute).toBe('certified');
    expect(certified.actualBlock).toBe('Top 10 Goal Scorers');
    expect(certified.passed).toBe(true);

    const refusal = payload.results.find((r: { source: string }) => r.source === 'yaml');
    expect(refusal.expectRefuse).toBe(true);
    // An off-topic question must not be answered by a certified block.
    expect(refusal.actualRoute).not.toBe('certified');
  });

  it('wires the threshold gate to the process exit code', async () => {
    const projectRoot = seedProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // The certified-exact example routes to `certified`, so route accuracy is 1.
    // A satisfiable threshold (0.5) must therefore pass and leave exitCode unset.
    await runEval(projectRoot, [], { format: 'json', minRouteAccuracy: 0.5 } as never);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.scores.routeAccuracy).toBe(1);
    expect(payload.ok).toBe(true);
    // ok report => exit code stays unset (treated as success by CI).
    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when the refusal recall threshold is not met', async () => {
    const projectRoot = seedProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Demand perfect refusal recall. If the router fails to refuse the off-topic
    // yaml case, recall < 1 and the gate must fail (exit 1). If it does refuse,
    // recall is 1 and the report is ok. Either way the exit code must agree with
    // the report's `ok` flag — that is the contract we assert.
    await runEval(projectRoot, [], { format: 'json', minRefusal: 1 } as never);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    if (payload.ok) {
      expect(process.exitCode).toBeUndefined();
    } else {
      expect(process.exitCode).toBe(1);
    }
  });
});
