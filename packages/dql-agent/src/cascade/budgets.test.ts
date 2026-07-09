import { describe, expect, it } from 'vitest';
import {
  analysisDepthForQuestion,
  canUseEngineEscalation,
  canUseLaneRepair,
  cascadeBudgetTrace,
  contextRetrievalBudgetForQuestion,
  createCascadeBudgetState,
  deepAlternativeCountForQuestion,
  mcpTier2RegroundRepairBudget,
  promptContextBudgetForQuestion,
  proposalToolBudgetForQuestion,
  questionShapeClass,
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
      maxToolCalls: 10,
      effortClass: 'multi_entity',
    });

    // Tool budget follows the question SHAPE, not effort/depth (S1 decouple) — a
    // diagnosis earns the deep_research budget with no effort/depth option at all.
    expect(proposalToolBudgetForQuestion(
      buildAnalysisQuestionPlan('Research why margin dropped in Q2'),
      'diagnose_change',
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

    // Depth follows shape, so a diagnosis widens to the deep policy even at LOW
    // effort — proving the widening is driven by the question, not the effort knob.
    expect(analysisDepthForQuestion(questionPlan, 'low')).toBe('deep');
    expect(contextRetrievalBudgetForQuestion({ questionPlan, reasoningEffort: 'low' })).toEqual({
      analysisDepth: 'deep',
      strictness: 'exploratory',
      limit: 160,
    });
    expect(promptContextBudgetForQuestion({ questionPlan, reasoningEffort: 'low' })).toMatchObject({
      label: 'deep',
      relationCardLimit: 40,
      relationColumnLimit: 120,
      otherRelationStart: 40,
      edgeLimit: 80,
    });
  });

  describe('effort/depth decouple (S1)', () => {
    const lookup = buildAnalysisQuestionPlan('What is the median order value?');
    const multiEntity = buildAnalysisQuestionPlan('What is the order count by region and product category?');
    const deepResearch = buildAnalysisQuestionPlan('Research why margin dropped in Q2 by product and region');

    it('classifies questions by analytical shape', () => {
      expect(questionShapeClass(lookup, 'ad_hoc_analysis')).toBe('lookup');
      expect(questionShapeClass(multiEntity, 'ad_hoc_analysis')).toBe('multi_entity');
      expect(questionShapeClass(deepResearch, 'diagnose_change')).toBe('deep_research');
    });

    it('drives depth by shape, NOT by reasoning effort', () => {
      // A single-table lookup stays on the fast path even when the model is asked
      // to think hard; a join/breakdown/diagnosis runs verification even at low effort.
      expect(analysisDepthForQuestion(lookup, 'high')).toBe('quick');
      expect(analysisDepthForQuestion(multiEntity, 'low')).toBe('deep');
      expect(analysisDepthForQuestion(deepResearch, 'low')).toBe('deep');
    });

    it('lets an explicit requested depth override the shape default', () => {
      expect(analysisDepthForQuestion(lookup, 'low', 'deep')).toBe('deep');
      expect(analysisDepthForQuestion(deepResearch, 'high', 'quick')).toBe('quick');
    });

    it('scales verification candidates to the shape (skip / light / full)', () => {
      expect(deepAlternativeCountForQuestion(lookup, 'ad_hoc_analysis')).toBe(0);
      expect(deepAlternativeCountForQuestion(multiEntity, 'ad_hoc_analysis')).toBe(1);
      expect(deepAlternativeCountForQuestion(deepResearch, 'diagnose_change')).toBe(3);
    });
  });
});
