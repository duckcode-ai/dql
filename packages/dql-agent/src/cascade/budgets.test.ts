import { describe, expect, it } from 'vitest';
import {
  analysisDepthForQuestion,
  canUseEngineEscalation,
  canUseLaneRepair,
  cascadeBudgetTrace,
  contextRetrievalBudgetForQuestion,
  createCascadeBudgetState,
  mcpTier2RegroundRepairBudget,
  promptContextBudgetForQuestion,
  proposalToolBudgetForQuestion,
  recordEngineEscalation,
  recordLaneRepair,
} from './budgets.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';

describe('cascade budgets', () => {
  it('tracks lane repairs separately from engine escalations', () => {
    const state = createCascadeBudgetState({ lane: { execution: 1 }, engineEscalations: 1 });

    expect(canUseLaneRepair(state, 'execution')).toBe(true);
    expect(canUseEngineEscalation(state)).toBe(true);

    recordLaneRepair(state, 'execution');
    recordEngineEscalation(state);

    expect(canUseLaneRepair(state, 'execution')).toBe(false);
    expect(canUseEngineEscalation(state)).toBe(false);
    expect(cascadeBudgetTrace(state).usage).toEqual({
      laneRegroundAttemptsUsed: 0,
      laneExecutionAttemptsUsed: 1,
      engineEscalationsUsed: 1,
    });
  });

  it('advertises the bounded MCP tier-2 re-ground policy', () => {
    expect(mcpTier2RegroundRepairBudget()).toEqual({
      kind: 'reground',
      attemptsUsed: 0,
      maxAttempts: 1,
      attemptsRemaining: 1,
      nextTool: 'expand_context',
    });
  });

  it('uses lookup, multi-entity, and deep research tool-call budgets from one policy', () => {
    expect(proposalToolBudgetForQuestion(
      buildAnalysisQuestionPlan('What is the median order value?'),
      'ad_hoc_analysis',
    )).toMatchObject({
      maxToolCalls: 3,
      effortClass: 'lookup',
    });

    expect(proposalToolBudgetForQuestion(
      buildAnalysisQuestionPlan('What is the order count by region and product category?'),
      'ad_hoc_analysis',
    )).toMatchObject({
      maxToolCalls: 8,
      effortClass: 'multi_entity',
    });

    expect(proposalToolBudgetForQuestion(
      buildAnalysisQuestionPlan('Research why margin dropped in Q2'),
      'diagnose_change',
      { analysisDepth: 'deep' },
    )).toMatchObject({
      maxToolCalls: 15,
      effortClass: 'deep_research',
    });
  });

  it('uses one quick policy for prompt rendering and metadata retrieval', () => {
    const questionPlan = buildAnalysisQuestionPlan('What is the median order value?');

    expect(analysisDepthForQuestion(questionPlan)).toBe('quick');
    expect(contextRetrievalBudgetForQuestion({ questionPlan })).toEqual({
      analysisDepth: 'quick',
      strictness: 'balanced',
      limit: 100,
    });
    expect(promptContextBudgetForQuestion({ questionPlan })).toMatchObject({
      label: 'quick',
      relationCardLimit: 12,
      relationColumnLimit: 32,
      otherRelationStart: 12,
      edgeLimit: 0,
    });
  });

  it('widens prompt rendering and metadata retrieval from the same deep policy', () => {
    const questionPlan = buildAnalysisQuestionPlan('Research why margin dropped in Q2 by product and region');

    expect(analysisDepthForQuestion(questionPlan, 'high')).toBe('deep');
    expect(contextRetrievalBudgetForQuestion({ questionPlan, reasoningEffort: 'high' })).toEqual({
      analysisDepth: 'deep',
      strictness: 'exploratory',
      limit: 160,
    });
    expect(promptContextBudgetForQuestion({ questionPlan, reasoningEffort: 'high' })).toMatchObject({
      label: 'deep',
      relationCardLimit: 40,
      relationColumnLimit: 120,
      otherRelationStart: 40,
      edgeLimit: 80,
    });
  });
});
