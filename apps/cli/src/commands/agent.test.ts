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

  it('maps CLI depth and effort flags into exploratory context budgets', () => {
    const plan = buildAnalysisQuestionPlan('show order count');

    expect(__test__.cliAnalysisDepth({ analysisDepth: 'deep' } as any)).toBe('deep');
    expect(__test__.cliAnalysisDepth({ analysisDepth: 'wide' } as any)).toBeUndefined();
    expect(__test__.cliReasoningEffort({ reasoningEffort: 'HIGH' } as any)).toBe('high');
    expect(__test__.cliReasoningEffort({ reasoningEffort: 'max' } as any)).toBeUndefined();
    expect(contextRetrievalBudgetForQuestion({
      questionPlan: plan,
      requestedDepth: __test__.cliAnalysisDepth({ analysisDepth: 'deep' } as any),
    })).toMatchObject({
      analysisDepth: 'deep',
      strictness: 'exploratory',
      limit: 160,
    });
    expect(contextRetrievalBudgetForQuestion({
      questionPlan: plan,
      reasoningEffort: __test__.cliReasoningEffort({ reasoningEffort: 'high' } as any),
    })).toMatchObject({
      analysisDepth: 'deep',
      strictness: 'exploratory',
      limit: 160,
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
});
