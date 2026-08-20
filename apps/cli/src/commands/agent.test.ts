import { describe, expect, it } from 'vitest';
import {
  buildAnalysisQuestionPlan,
  contextRetrievalBudgetForQuestion,
  type AgentAnswer,
  type AgentFollowUpContext,
} from '@duckcodeailabs/dql-agent';
import { __test__ } from './agent.js';

function answerResult(overrides: Partial<AgentAnswer> = {}): AgentAnswer {
  return {
    kind: 'uncertified',
    sourceTier: 'dbt_manifest',
    certification: 'ai_generated',
    reviewStatus: 'draft_ready',
    text: 'Answer',
    citations: [],
    considered: [],
    proposedSql: 'select 1 as orders',
    contextPack: {
      id: 'ctx_eval_1',
      objects: [],
      evidenceRoles: [],
      allowedSqlContext: {
        relations: [{ relation: 'dev.orders', columns: [{ name: 'orders' }] }],
        sourceBlockSql: [],
      },
      retrievalDiagnostics: {
        selectedRelations: [{ relation: 'dev.orders', score: 1, reason: 'test' }],
        selectedEvidence: [],
        selectedJoinPaths: [],
        schemaShapeCandidates: [],
      },
      missingContext: [],
      routeDecision: {
        route: 'generated_sql',
        intent: 'ad_hoc_ranking',
        reason: 'test',
        trustLabel: 'review_required',
        reviewStatus: 'draft_ready',
        selectedEvidence: [],
        missingContext: [],
        followUps: [],
      },
      freshness: {},
      warnings: [],
    } as unknown as AgentAnswer['contextPack'],
    result: {
      columns: [{ name: 'orders' }],
      rows: [{ orders: 1 }],
      rowCount: 1,
      executionTime: 12,
      sql: 'select 1 as orders',
    },
    evidence: {
      route: [{
        tool: 'inspect_metadata_context',
        status: 'checked',
        label: 'Runtime tables and columns attached',
      }],
      lineage: [],
      businessContext: [],
      selectedAssets: [],
      sourceTables: [],
      semanticObjects: [],
      toolCalls: [{
        name: 'inspect_metadata_context',
        status: 'checked',
        inputSummary: '{"question":"orders"}',
        outputSummary: '{"contextPackId":"ctx_eval_1"}',
        order: 1,
      }],
      citations: [],
    } as AgentAnswer['evidence'],
    ...overrides,
  };
}

describe('agent eval answer harness', () => {
  it('scores expected rows as an execution match', () => {
    const evaluation = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          rows: [{ orders: 1 }],
        },
      },
      answerResult(),
    );

    expect(evaluation.failures).toEqual([]);
    expect(evaluation.executionMatched).toBe(true);
  });

  it('enforces minimum observed tool calls for agentic eval cases', () => {
    const passing = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          minToolCalls: 1,
        },
      },
      answerResult(),
    );
    const failing = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          minToolCalls: 2,
        },
      },
      answerResult(),
    );

    expect(passing.failures).toEqual([]);
    expect(failing.failures).toEqual(['toolCalls expected at least 2, got 1']);
  });

  it('maps the CLI depth flag into an exploratory budget; effort no longer forces depth (S1)', () => {
    const plan = buildAnalysisQuestionPlan('show order count');

    expect(__test__.cliAnalysisDepth({ analysisDepth: 'deep' } as any)).toBe('deep');
    expect(__test__.cliAnalysisDepth({ analysisDepth: 'wide' } as any)).toBeUndefined();
    expect(__test__.cliReasoningEffort({ reasoningEffort: 'HIGH' } as any)).toBe('high');
    expect(__test__.cliReasoningEffort({ reasoningEffort: 'max' } as any)).toBeUndefined();

    // An explicit --analysis-depth deep still widens the retrieval budget.
    expect(contextRetrievalBudgetForQuestion({
      questionPlan: plan,
      requestedDepth: __test__.cliAnalysisDepth({ analysisDepth: 'deep' } as any),
    })).toMatchObject({
      analysisDepth: 'deep',
      strictness: 'exploratory',
      limit: 160,
    });

    // But --reasoning-effort high ALONE no longer widens it (the S1 decouple):
    // a simple lookup keeps the quick/balanced budget even at high effort.
    expect(contextRetrievalBudgetForQuestion({
      questionPlan: plan,
      reasoningEffort: __test__.cliReasoningEffort({ reasoningEffort: 'high' } as any),
    })).toMatchObject({
      analysisDepth: 'quick',
      strictness: 'balanced',
      limit: 100,
    });
  });

  it('includes execution-match rate in aggregate metrics', () => {
    const metrics = __test__.computeEvalMetrics([
      {
        name: 'match',
        passed: true,
        failures: [],
        durationMs: 20,
        executionMs: 12,
        executionMatched: true,
        kind: 'uncertified',
        route: 'generated_sql',
        contextObjects: 1,
        followUp: false,
        draftSaved: false,
        toolCalls: 1,
        expected: { minToolCalls: 1 },
        trace: [],
      },
      {
        name: 'miss',
        passed: false,
        failures: ['executed rows did not match expected rows'],
        durationMs: 20,
        executionMs: 10,
        executionMatched: false,
        kind: 'uncertified',
        route: 'generated_sql',
        contextObjects: 1,
        followUp: false,
        draftSaved: false,
        toolCalls: 0,
        expected: { minToolCalls: 1 },
        trace: [],
      },
    ]);

    expect(metrics.execution_match_rate).toBe(0.5);
    expect(metrics.tool_requirement_pass_rate).toBe(0.5);
    expect(metrics.tool_observed_case_count).toBe(1);
    expect(metrics.avg_tool_calls).toBe(0.5);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: 0.5 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: 0.75 })).toBe(false);
    expect(__test__.agentEvalThresholdsPass({ ...metrics, tool_requirement_pass_rate: null }, { minToolRequirement: 1 })).toBe(true);

    // Class-B wrong-number gate: execution_match_rate is 0.5 here, so a 0.5 bar
    // passes and a 1.0 bar fails — this is the gate that guards a speed lever from
    // shipping a fan-out/grain regression.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minExecutionMatch: 0.5 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minExecutionMatch: 1 })).toBe(false);
    // A rate gate with no applicable cases (judge_pass_rate is null here) is
    // vacuously satisfied — you never fail on a metric you did not measure.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minJudgePass: 1 })).toBe(true);
    // Trust-mislabel ceiling: 0 wrong-certified passes a ceiling of 0; 1 would fail it.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, maxWrongCertified: 0 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass({ ...metrics, wrong_certified_count: 1 }, { minToolRequirement: null, maxWrongCertified: 0 })).toBe(false);
  });

  it('derives grounded-narration metrics only from durable receipts, never rows or fallback prose', () => {
    const success = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'verified_facts',
      outcome: 'success',
      attempted: true,
      factCount: 3,
      maxRows: 10,
      validationFailures: [],
    });
    const fallback = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'verified_facts',
      outcome: 'deterministic_fallback',
      attempted: true,
      factCount: 3,
      maxRows: 10,
      validationFailures: ['UNPARSEABLE_CLAIMS'],
    });
    const errored = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'verified_facts',
      outcome: 'error',
      attempted: true,
      factCount: 3,
      maxRows: 10,
      validationFailures: [],
      errorCode: 'narration_error',
    });
    // A row-bearing skipped result must not silently enter the denominator.
    const skipped = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'skip',
      outcome: 'skipped',
      attempted: false,
      factCount: 0,
      maxRows: 0,
      validationFailures: [],
      skipReason: 'no_provider',
    });
    expect(success).toEqual({ narrationAttempted: true, narrationFallback: false });
    expect(fallback).toEqual({ narrationAttempted: true, narrationFallback: true });
    // A provider error is an attempted but ungrounded narration.  Counting it
    // as a success would mask a hot-path failure behind a healthy-looking rate.
    expect(errored).toEqual({ narrationAttempted: true, narrationFallback: true });
    expect(skipped).toEqual({});

    const base = {
      passed: true, failures: [] as string[], durationMs: 1, kind: 'uncertified' as const,
      contextObjects: 1, followUp: false, draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'success with arbitrary prose', ...success },
      { ...base, name: 'fallback without reader marker', ...fallback },
      { ...base, name: 'error without reader marker', ...errored },
      { ...base, name: 'skipped despite rows', ...skipped },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);
    expect(metrics.grounded_narration_attempted).toBe(3);
    expect(metrics.grounded_narration_rate).toBeCloseTo(1 / 3);
  });

  it('builds structured trace stages for offline analysis', () => {
    const result = answerResult({
      draftBlock: {
        path: 'blocks/_drafts/orders.dql',
        askedTimes: 1,
        proposedContractId: 'sales.Order.orders',
      },
    });
    const evaluation = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          rows: [{ orders: 1 }],
        },
      },
      result,
    );
    const trace = __test__.buildEvalTrace({
      testCase: {
        question: 'orders',
        expected: { rows: [{ orders: 1 }] },
      },
      result,
      evaluation,
      durationMs: 25,
      draftSaved: true,
    });

    expect(trace.map((stage) => stage.stage)).toEqual([
      'context',
      'rewrite',
      'lane',
      'tools',
      'answer',
      'validation',
      'execution',
      'draft',
      'scoring',
    ]);
    expect(trace.find((stage) => stage.stage === 'execution')).toMatchObject({
      status: 'passed',
      payload: {
        rowCount: 1,
        executionMatched: true,
        columns: ['orders'],
      },
    });
    expect(trace.find((stage) => stage.stage === 'tools')).toMatchObject({
      status: 'passed',
      payload: {
        observedToolCalls: 1,
        providerToolCalls: [
          expect.objectContaining({
            name: 'inspect_metadata_context',
            status: 'checked',
          }),
        ],
        routeEvidence: [
          expect.objectContaining({
            tool: 'inspect_metadata_context',
            status: 'checked',
          }),
        ],
      },
    });
    expect(trace.find((stage) => stage.stage === 'rewrite')).toMatchObject({
      status: 'not_run',
      message: 'No follow-up rewrite/context was supplied for this case.',
    });
    expect(trace.find((stage) => stage.stage === 'draft')).toMatchObject({
      status: 'passed',
      payload: { draftPath: 'blocks/_drafts/orders.dql' },
    });
  });

  it('captures follow-up rewrite context in the eval trace', () => {
    const followUp: AgentFollowUpContext = {
      kind: 'generic',
      sourceTurnId: 'turn_supply',
      sourceQuestion: 'give me product and supply info',
      sourceBlockName: 'product_supply_breakdown',
      filters: ['product_id in previous result'],
      dimensions: ['product_id', 'supply_id'],
      priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
      priorResultValues: {
        product_id: ['BEV-001', 'JAF-001'],
      },
      priorResultRef: {
        id: 'turn_supply',
        question: 'give me product and supply info',
        columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        rowCount: 65,
        sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10',
      },
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
        source: 'block "product_supply_breakdown" {\n  type = "custom"\n  query = """SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10"""\n}',
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
      priorLimit: 10,
      priorMeasures: ['supply_cost'],
      resolvedReferences: ['previous results'],
    };
    const result = answerResult();
    const evaluation = __test__.evaluateCase(
      {
        question: 'include product details with previous results',
        followUp,
      },
      result,
    );
    const trace = __test__.buildEvalTrace({
      testCase: {
        question: 'include product details with previous results',
        followUp,
      },
      result,
      evaluation,
      durationMs: 25,
      draftSaved: false,
    });

    expect(trace.find((stage) => stage.stage === 'rewrite')).toMatchObject({
      status: 'passed',
      message: 'Follow-up context attached (generic).',
      payload: {
        kind: 'generic',
        sourceTurnId: 'turn_supply',
        sourceQuestion: 'give me product and supply info',
        sourceBlockName: 'product_supply_breakdown',
        priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        priorResultRef: {
          id: 'turn_supply',
          rowCount: 65,
          columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
          sourceSql: expect.stringContaining('analytics.product_supplies'),
        },
        priorDqlArtifact: {
          kind: 'sql_block',
          name: 'product_supply_breakdown',
          source: expect.stringContaining('block "product_supply_breakdown"'),
          orderBy: [{ name: 'supply_cost', direction: 'desc' }],
          limit: 10,
        },
        priorLimit: 10,
        priorMeasures: ['supply_cost'],
        resolvedReferences: ['previous results'],
      },
    });
  });

  it('marks the tools trace stage failed when a required tool-call floor is missed', () => {
    const result = answerResult();
    const evaluation = __test__.evaluateCase(
      {
        question: 'orders',
        expected: { minToolCalls: 2 },
      },
      result,
    );
    const trace = __test__.buildEvalTrace({
      testCase: {
        question: 'orders',
        expected: { minToolCalls: 2 },
      },
      result,
      evaluation,
      durationMs: 25,
      draftSaved: false,
    });

    expect(trace.find((stage) => stage.stage === 'tools')).toMatchObject({
      status: 'failed',
      message: 'Observed 1 provider tool call(s), below the minimum of 2.',
      payload: {
        observedToolCalls: 1,
        expectedMinToolCalls: 2,
      },
    });
    expect(trace.find((stage) => stage.stage === 'scoring')).toMatchObject({
      status: 'failed',
      payload: {
        expected: { minToolCalls: 2 },
      },
    });
  });
  it('scores false refusals on answerable cases, and keeps genuine refusals honest', () => {
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      // Answerable by inference (a real expectation, not a refusal expectation),
      // but the run refused → FALSE REFUSAL. This is the reported BCM shape.
      { ...base, name: 'bcm-ranking', passed: false, kind: 'no_answer', route: 'clarify',
        expected: { kind: 'certified' } },
      // Answerable and answered.
      { ...base, name: 'answered', passed: true, kind: 'uncertified', route: 'generated_sql',
        expected: { kind: 'uncertified' } },
      // Explicitly answerable, answered.
      { ...base, name: 'explicit-answerable', passed: true, kind: 'uncertified', route: 'generated_sql',
        expected: { answerable: true } },
      // Must refuse, and did → protects against "never dead-end" becoming hallucination.
      { ...base, name: 'weather', passed: true, kind: 'no_answer', route: 'clarify',
        expected: { kind: 'no_answer' } },
      // No expectations at all → excluded from both denominators.
      { ...base, name: 'unscored', passed: true, kind: 'uncertified', route: 'generated_sql' },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);

    expect(metrics.answerable_case_count).toBe(3);
    expect(metrics.false_refusal_count).toBe(1);
    expect(metrics.false_refusal_rate).toBeCloseTo(1 / 3);
    expect(metrics.refusal_required_case_count).toBe(1);
    expect(metrics.refusal_recall).toBe(1);

    // Ceiling gates on the measured value.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, maxFalseRefusal: 0.5 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, maxFalseRefusal: 0.1 })).toBe(false);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minRefusalRecall: 1 })).toBe(true);
    // No answerable case scored means "unknown", never "perfect".
    expect(__test__.agentEvalThresholdsPass(
      { ...metrics, false_refusal_rate: null }, { minToolRequirement: null, maxFalseRefusal: 0 },
    )).toBe(true);
  });

  it('treats an explicit answerable:false as a genuine-refusal case even with other expectations', () => {
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'policy-blocked', passed: true, kind: 'no_answer', route: 'clarify',
        expected: { answerable: false, certification: 'analyst_review_required' } },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);
    expect(metrics.answerable_case_count).toBe(0);
    expect(metrics.false_refusal_rate).toBeNull();
    expect(metrics.refusal_recall).toBe(1);
  });

  it('separates a dead end from an answerable clarification and a conversational decline', () => {
    // Three outcomes, learned from a live runtime run against the jaffle fixture:
    //   - no options            → dead end (the reported BCM loop)
    //   - options offered       → answerable next turn; a cost, not a defect
    //   - conversational reply  → asserts nothing about the data, so for an
    //                             out-of-scope question it is the CORRECT outcome
    // Collapsing any two of these misreports the product.
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'dead-end', passed: false, kind: 'no_answer', route: 'clarify',
        clarificationOptionCount: 0, expected: { answerable: true } },
      { ...base, name: 'asked-well', passed: true, kind: 'no_answer', route: 'clarify',
        clarificationOptionCount: 2, expected: { answerable: true } },
      { ...base, name: 'answered', passed: true, kind: 'uncertified', route: 'generated_sql',
        expected: { answerable: true } },
      { ...base, name: 'weather', passed: true, kind: 'uncertified', route: undefined,
        conversational: true, expected: { answerable: false } },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);

    expect(metrics.answerable_case_count).toBe(3);
    expect(metrics.false_refusal_count).toBe(1);          // only the zero-option one
    expect(metrics.false_refusal_rate).toBeCloseTo(1 / 3);
    expect(metrics.clarification_rate).toBeCloseTo(1 / 3); // only the option-bearing one
    // A conversational decline counts as correctly refusing an out-of-scope ask.
    expect(metrics.refusal_recall).toBe(1);
  });

  it('counts a substantive conversational reply as an answer, not a dead end', () => {
    // A governed definition ("**top_customers** — Top 10 customers by lifetime
    // spend…") is exactly what a "what does X mean?" turn should return. The
    // first version of this scorer treated every conversational reply as a
    // decline and reported the feature working as the feature failing — caught
    // by a live run, not by a unit test.
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'definition', passed: true, kind: 'uncertified', route: undefined,
        conversational: true, conversationalAnswer: true, expected: { answerable: true } },
      { ...base, name: 'weather', passed: true, kind: 'uncertified', route: undefined,
        conversational: true, conversationalAnswer: true, expected: { answerable: false } },
      { ...base, name: 'dead-end', passed: false, kind: 'no_answer', route: 'clarify',
        clarificationOptionCount: 0, expected: { answerable: true } },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);

    expect(metrics.answerable_case_count).toBe(2);
    // Only the true dead end counts against us; the definition does not.
    expect(metrics.false_refusal_count).toBe(1);
    // And an out-of-scope question answered conversationally still counts as
    // correctly declining.
    expect(metrics.refusal_recall).toBe(1);
  });

});
