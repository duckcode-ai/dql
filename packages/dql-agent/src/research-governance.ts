/** Bounded, receipt-backed research built from typed deltas over one root plan. */

import {
  deriveResolvedAnalyticalPlan,
  type ResolvedAnalyticalPlan,
  type ResolvedAnalyticalPlanDelta,
} from './resolved-analytical-plan.js';
import { RESEARCH_BUDGET, type ResearchBudget } from './research-loop.js';

export type ResearchBudgetCounter = 'plannerCalls' | 'sqlExecutions' | 'repairs' | 'narratorCalls';

export class ResearchBudgetExceededError extends Error {
  readonly code = 'RESEARCH_BUDGET_EXCEEDED';
  constructor(readonly counter: ResearchBudgetCounter | 'wallClockMs') {
    super(`Research budget exceeded: ${counter}.`);
    this.name = 'ResearchBudgetExceededError';
  }
}

export class ResearchBudgetController {
  private readonly used = { plannerCalls: 0, sqlExecutions: 0, repairs: 0, narratorCalls: 0 };
  private readonly startedAt: number;
  constructor(
    readonly budget: ResearchBudget = RESEARCH_BUDGET,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  consume(counter: ResearchBudgetCounter): void {
    this.assertWithinDeadline();
    const next = this.used[counter] + 1;
    if (next > this.budget[counter]) throw new ResearchBudgetExceededError(counter);
    this.used[counter] = next;
  }

  assertWithinDeadline(): void {
    if (this.now() - this.startedAt > this.budget.wallClockMs) {
      throw new ResearchBudgetExceededError('wallClockMs');
    }
  }

  snapshot(): Readonly<typeof this.used & { elapsedMs: number }> {
    return Object.freeze({ ...this.used, elapsedMs: Math.max(0, this.now() - this.startedAt) });
  }
}

export interface TypedResearchBranchInput {
  id: string;
  label: string;
  delta: ResolvedAnalyticalPlanDelta;
  evidenceIds: string[];
}

export interface TypedResearchBranch {
  id: string;
  label: string;
  plan: ResolvedAnalyticalPlan;
  evidenceIds: string[];
}

export function buildTypedResearchBranches(
  root: ResolvedAnalyticalPlan,
  inputs: TypedResearchBranchInput[],
): TypedResearchBranch[] {
  return inputs.slice(0, RESEARCH_BUDGET.sqlExecutions).map((input) => ({
    id: input.id,
    label: input.label,
    plan: deriveResolvedAnalyticalPlan(root, input.delta),
    evidenceIds: [...new Set(input.evidenceIds)].sort(),
  }));
}

export interface ResearchObservation {
  branchId: string;
  status: 'executed' | 'failed' | 'not_run';
  numericClaims: string[];
  executionReceipt?: {
    sqlFingerprint?: string;
    compiledSqlFingerprint?: string;
    resultFingerprint?: string;
    result?: { resultFingerprint?: string };
  };
}

export interface ResearchConclusionGate {
  status: 'complete' | 'partial';
  supportedClaimIds: string[];
  unsupportedClaimIds: string[];
  message: string;
}

/** Every numeric claim needs a successful execution and a result fingerprint. */
export function gateResearchConclusion(observations: ResearchObservation[]): ResearchConclusionGate {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const observation of observations) {
    const hasReceipt = observation.status === 'executed'
      && Boolean(observation.executionReceipt?.resultFingerprint
        ?? observation.executionReceipt?.result?.resultFingerprint);
    for (const claim of observation.numericClaims) (hasReceipt ? supported : unsupported).push(claim);
  }
  const status = unsupported.length === 0 ? 'complete' as const : 'partial' as const;
  return {
    status,
    supportedClaimIds: [...new Set(supported)].sort(),
    unsupportedClaimIds: [...new Set(unsupported)].sort(),
    message: status === 'complete'
      ? 'Every numeric research claim is backed by a successful execution receipt.'
      : 'Research evidence is partial; unsupported numeric claims cannot be presented as a completed causal conclusion.',
  };
}
