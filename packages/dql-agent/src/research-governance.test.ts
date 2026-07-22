import { describe, expect, it } from 'vitest';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import {
  buildTypedResearchBranches,
  gateResearchConclusion,
  ResearchBudgetController,
  ResearchBudgetExceededError,
} from './research-governance.js';
import type { AgentEvidenceCandidate, MeaningResolution } from './meaning-resolution.js';

const metric: AgentEvidenceCandidate = {
  id: 'semantic:metric:revenue',
  qualifiedId: 'semantic:finance:revenue',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Revenue',
  relevanceScore: 1,
  matchReasons: ['root metric'],
  compatibility: 'compatible',
};
const resolution: MeaningResolution = {
  interpretedQuestion: 'Why did revenue decline?',
  questionType: 'diagnosis',
  selectedConceptIds: [metric.id],
  recommendedExecutionId: metric.id,
  queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
  rejectedCandidates: [],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'semantic',
};
const root = buildResolvedAnalyticalPlan({
  question: resolution.interpretedQuestion,
  resolution,
  evidence: { snapshotId: 'research-snapshot', candidates: [metric] },
  candidates: [metric],
  mode: 'authoritative',
});

describe('bounded typed research (AGT-016)', () => {
  it('caps branches at six and keeps every branch on the root snapshot/concept', () => {
    const branches = buildTypedResearchBranches(root, Array.from({ length: 8 }, (_, index) => ({
      id: `h${index}`,
      label: `Hypothesis ${index}`,
      evidenceIds: [`e${index}`],
      delta: { question: `Breakdown ${index}`, limit: index + 1 },
    })));
    expect(branches).toHaveLength(6);
    expect(branches.every((branch) => branch.plan.rootPlanId === root.planId)).toBe(true);
    expect(branches.every((branch) => branch.plan.snapshotId === root.snapshotId)).toBe(true);
    expect(branches.every((branch) => branch.plan.executionId === root.executionId)).toBe(true);
  });

  it('enforces one planner, six SQL, one repair, one narrator, and deadline', () => {
    let now = 0;
    const budget = new ResearchBudgetController(undefined, () => now);
    budget.consume('plannerCalls');
    for (let i = 0; i < 6; i += 1) budget.consume('sqlExecutions');
    budget.consume('repairs');
    budget.consume('narratorCalls');
    expect(() => budget.consume('sqlExecutions')).toThrow(ResearchBudgetExceededError);
    now = 120_001;
    expect(() => budget.assertWithinDeadline()).toThrow('wallClockMs');
  });

  it('prevents unsupported numeric evidence from becoming a completed causal conclusion', () => {
    expect(gateResearchConclusion([{
      branchId: 'baseline',
      status: 'executed',
      numericClaims: ['claim-baseline'],
      executionReceipt: { resultFingerprint: 'result-1' },
    }, {
      branchId: 'channel',
      status: 'failed',
      numericClaims: ['claim-channel-driver'],
    }])).toEqual({
      status: 'partial',
      supportedClaimIds: ['claim-baseline'],
      unsupportedClaimIds: ['claim-channel-driver'],
      message: 'Research evidence is partial; unsupported numeric claims cannot be presented as a completed causal conclusion.',
    });
  });
});
