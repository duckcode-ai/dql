import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { MetricCapabilityContract } from '@duckcodeailabs/dql-core';
import {
  AgentRunEngine,
  buildAnalyticalTurnPlan,
  buildCoverageGap,
  normalizeCanonicalQueryResult,
  selectRoute,
} from './index.js';
import { createHybridRouter } from './router.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';

interface EvalCandidateFixture {
  id: string;
  kind: AgentEvidenceCandidate['kind'];
  name: string;
  aliases?: string[];
  trustTier: AgentEvidenceCandidate['trustTier'];
  relevanceScore: number;
  compatibility: AgentEvidenceCandidate['compatibility'];
  domain?: string;
  dimensions?: string[];
  aggregation?: string;
  exactMatch?: boolean;
  analyticalRoute?: 'certified' | 'semantic';
}

interface EvalResolutionFixture {
  questionType: MeaningResolution['questionType'];
  selectedConceptIds: string[];
  recommendedExecutionId?: string;
  recommendedRoute: MeaningResolution['recommendedRoute'];
  measures: string[];
  dimensions: string[];
  filters?: Array<{ field: string; value: string }>;
  order?: 'asc' | 'desc';
  limit?: number;
  confidence: MeaningResolution['confidence'];
  missingInformation?: string[];
}

interface AskAiEvalCase {
  id: string;
  verification: 'executable' | 'specified';
  question: string;
  prior?: { columns?: string[]; values?: Record<string, string[]> };
  candidates?: EvalCandidateFixture[];
  resolution?: EvalResolutionFixture;
  expected: {
    meaningCalls?: number;
    firstEligibleTier?: string;
    fallbackTiers?: string[];
    resultRowsAreObjects?: boolean;
    clarificationCode?: string;
    repeats?: number;
    route?: string;
    memberBinding?: { dimension: string; value: string };
    resultColumns?: string[];
  };
}

interface AskAiEvalFixture {
  version: number;
  name: string;
  acceptanceIds: string[];
  cases: AskAiEvalCase[];
}

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/specs/dql-2-domain-context/fixtures/ask-ai-orchestration.agent-evals.yml',
);

function readFixture(): AskAiEvalFixture {
  return load(readFileSync(fixturePath, 'utf8')) as AskAiEvalFixture;
}

function fixtureCapability(candidate: EvalCandidateFixture): MetricCapabilityContract | undefined {
  if (!candidate.analyticalRoute) return undefined;
  const metricId = candidate.kind === 'semantic_metric'
    ? candidate.id
    : 'semantic:commerce:metric:revenue';
  return {
    metricId,
    semanticModelId: 'semantic:commerce:model:orders',
    measureIds: ['semantic:commerce:measure:revenue'],
    primaryEntityId: 'semantic:commerce:entity:order',
    defaultResultGrainId: 'semantic:commerce:entity:customer',
    resultGrainIds: ['semantic:commerce:entity:customer'],
    aggregation: candidate.aggregation ?? 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: (candidate.dimensions ?? []).map((dimension) => ({
      dimensionId: `semantic:${candidate.domain ?? 'commerce'}:dimension:${dimension}`,
      entityId: `semantic:${candidate.domain ?? 'commerce'}:entity:${dimension}`,
      supportedRoles: ['group_by', 'rank_entity'],
      relationshipPathIds: [`fixture:relationship:${dimension}`],
    })),
    timeDimensions: [],
    operations: ['group', 'rank'],
    supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
    executionCapabilities: [{ route: candidate.analyticalRoute, adapterId: 'fixture-adapter' }],
    sourceFingerprint: 'e'.repeat(64),
  };
}

function materializeCandidates(fixtures: EvalCandidateFixture[]): AgentEvidenceCandidate[] {
  return fixtures.map((fixture) => ({
    id: fixture.id,
    kind: fixture.kind,
    name: fixture.name,
    aliases: fixture.aliases,
    trustTier: fixture.trustTier,
    relevanceScore: fixture.relevanceScore,
    compatibility: fixture.compatibility,
    matchReasons: ['YAML candidate fixture'],
    eligible: true,
    domain: fixture.domain,
    dimensions: fixture.dimensions,
    aggregation: fixture.aggregation,
    exactMatch: fixture.exactMatch,
    analyticalCapability: fixtureCapability(fixture),
  }));
}

function materializeResolution(testCase: AskAiEvalCase): MeaningResolution {
  const fixture = testCase.resolution!;
  return {
    interpretedQuestion: testCase.question,
    questionType: fixture.questionType,
    selectedConceptIds: fixture.selectedConceptIds,
    recommendedExecutionId: fixture.recommendedExecutionId,
    queryIntent: {
      measures: fixture.measures,
      dimensions: fixture.dimensions,
      filters: fixture.filters ?? [],
      ...(fixture.order ? { order: fixture.order } : {}),
      ...(fixture.limit !== undefined ? { limit: fixture.limit } : {}),
    },
    rejectedCandidates: [],
    confidence: fixture.confidence,
    missingInformation: fixture.missingInformation ?? [],
    recommendedRoute: fixture.recommendedRoute,
  };
}

function normalizeTier(value: string): string {
  if (value === 'certified_block') return 'certified';
  if (value === 'semantic_layer') return 'semantic';
  if (value === 'governed_relational') return 'governed_sql';
  if (value === 'generated_sql') return 'generated';
  return value;
}

describe('Ask AI orchestration YAML evaluation harness (AGT-027..033 / E2E-022)', () => {
  it('executes only cases with deterministic router/engine fixtures and keeps specified cases non-evidence', async () => {
    const fixture = readFixture();
    expect(fixture.version).toBe(1);
    expect(fixture.acceptanceIds).toEqual(expect.arrayContaining([
      'AGT-027', 'AGT-028', 'AGT-029', 'AGT-030', 'AGT-031', 'AGT-032', 'AGT-033',
      'CTX-007', 'PERF-003', 'E2E-022',
    ]));
    expect(fixture.cases).toHaveLength(5);

    for (const testCase of fixture.cases) {
      if (testCase.verification === 'specified') {
        // A contract fixture without an executable router/engine/catalog setup
        // is deliberately not counted as evidence (E2E-022 remains specified).
        expect(testCase.verification).toBe('specified');
        continue;
      }

      expect(testCase.candidates?.length).toBeGreaterThan(0);
      expect(testCase.resolution).toBeDefined();
      const candidates = materializeCandidates(testCase.candidates ?? []);
      const evidence: AgentRetrievalEvidence = {
        snapshotId: `fixture:${testCase.id}`,
        sourceFingerprint: 'f'.repeat(64),
        candidates,
        parsedIntent: {
          measures: testCase.resolution?.measures,
          dimensions: testCase.resolution?.dimensions,
          filters: testCase.resolution?.filters,
        },
      };
      const resolution = materializeResolution(testCase);
      let meaningCalls = 0;
      const router = createHybridRouter({
        getEvidence: async () => evidence,
        resolveMeaning: async () => {
          meaningCalls += 1;
          return resolution;
        },
        resolvedPlanMode: 'authoritative',
      });
      const request = {
        question: testCase.question,
        intent: 'ad_hoc_ranking' as const,
        ...(testCase.prior ? {
          history: [{ role: 'user' as const, text: 'Who are the top customers?' }],
        } : {}),
      };
      const decision = await router.decide(request);
      expect(meaningCalls).toBe(testCase.expected.meaningCalls ?? 1);

      if (testCase.expected.firstEligibleTier) {
        expect(decision.resolvedAnalyticalPlan?.mode).toBe('authoritative');
        expect(decision.resolvedAnalyticalPlan?.recommendedRoute).toBe(normalizeTier(testCase.expected.firstEligibleTier));
        expect(decision.resolvedAnalyticalPlan?.capability, testCase.id).not.toBe('blocked');
      }
      for (const tier of testCase.expected.fallbackTiers ?? []) {
        expect(['certified', 'semantic', 'governed_sql', 'generated']).toContain(normalizeTier(tier));
      }

      if (testCase.expected.clarificationCode) {
        expect(decision.action).toBe('clarify');
        expect(decision.requiresClarification).toBe(true);
        const selectedId = 'semantic:metric:revenue';
        expect(candidates.some((candidate) => candidate.id === selectedId)).toBe(true);
        const continued = await router.decide({ ...request, selectedEvidenceId: selectedId });
        expect(meaningCalls).toBe(1);
        expect(continued.action).toBe('answer');
        expect(continued.resolvedAnalyticalPlan?.mode).toBe('authoritative');
      }

      const route = selectRoute(request, decision);
      if (testCase.expected.route) {
        expect(route === 'generated_answer' ? 'generated_sql' : route).toBe(testCase.expected.route);
      }
      if (testCase.expected.memberBinding) {
        const filter = decision.resolvedAnalyticalPlan?.query.filters.find((item) => item.field === testCase.expected.memberBinding!.dimension);
        expect(filter?.value).toBe(testCase.expected.memberBinding.value);
      }

      const result = normalizeCanonicalQueryResult({
        columns: testCase.expected.resultColumns ?? ['value'],
        rows: [{ [testCase.expected.resultColumns?.[0] ?? 'value']: 1 }],
        executionReceipt: {
          sourceFingerprint: '1'.repeat(64),
          compiledSqlFingerprint: '2'.repeat(64),
          parameterFingerprint: '3'.repeat(64),
          resultFingerprint: '4'.repeat(64),
        },
      });
      if (testCase.expected.resultRowsAreObjects) {
        expect(result.rows[0]).toEqual(expect.any(Object));
      }
      expect(result.executionReceipt?.resultFingerprint).toMatch(/^[a-f0-9]{64}$/);

      if (testCase.id === 'governed-ranking-cascade') {
        const executedRoutes: string[] = [];
        const engine = new AgentRunEngine({
          idGenerator: () => 'fixture-governed-run',
          now: () => new Date('2026-01-01T00:00:00.000Z'),
          router: { decide: async () => decision },
          executors: {
            certified_answer: () => {
              executedRoutes.push('certified');
              return {
                status: 'completed',
                trustState: 'certified',
                stopReason: 'certified_answer_found',
                answerTier: 'certified_block',
                answer: 'Top customers by revenue.',
              };
            },
            semantic_answer: () => { executedRoutes.push('semantic'); return { status: 'completed' }; },
            generated_answer: () => { executedRoutes.push('generated'); return { status: 'completed' }; },
          },
        });
        const run = await engine.run({ question: testCase.question, requestedMode: 'ask' });
        expect(run.route).toBe('certified_answer');
        expect(executedRoutes).toEqual(['certified']);
        expect(run.routeDecision?.resolvedAnalyticalPlan?.mode).toBe('authoritative');
      }

      if (testCase.id === 'attribute-follow-up') {
        expect(decision.resolvedAnalyticalPlan?.capability).toBe('governed_relational');
        expect(decision.resolvedAnalyticalPlan?.query.filters[0]).toMatchObject({
          field: 'customer_name',
          value: 'Jessica Richard',
        });
      }
    }
  });

  it('keeps the compound and Research fixture rows specified until their real child/catalog harness is supplied', () => {
    const fixture = readFixture();
    const specified = fixture.cases.filter((testCase) => testCase.verification === 'specified');
    expect(specified.map((testCase) => testCase.id)).toEqual([
      'compound-partial-success',
      'bounded-research-ledger',
    ]);
    const plan = buildAnalyticalTurnPlan({ question: specified[0]!.question });
    expect(plan.tasks.length).toBeGreaterThan(1);
    expect(buildCoverageGap({
      code: 'EXECUTION_FAILED',
      phase: 'execution',
      message: 'Specified fixture: child execution harness remains tester-owned.',
      searchedSources: [],
      attemptedRoutes: ['certified', 'semantic', 'governed_relational', 'generated'],
      missing: [],
      recoverable: false,
      planFrozen: true,
      nextActions: [],
    }).planFrozen).toBe(true);
  });
});
