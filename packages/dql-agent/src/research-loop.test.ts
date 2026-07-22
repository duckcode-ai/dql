import { describe, it, expect } from 'vitest';
import { planResearch } from './research-loop.js';
import type { PlanBlock } from './app-planner.js';
import type { KGNode } from './kg/types.js';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';

const revenueMetric: KGNode = {
  nodeId: 'metric:revenue',
  kind: 'metric',
  name: 'revenue',
  description: 'Total product revenue',
  llmContext: 'label: revenue\naggregation: sum\ntable: order_items\nsql: SUM(product_price)',
};

const revenueBlock: PlanBlock = {
  name: 'revenue',
  domain: 'marts',
  metricRef: 'revenue',
  allowedFilters: ['ordered_at', 'region'],
};

const ctx = { metrics: [revenueMetric], blocks: [revenueBlock] };

describe('planResearch', () => {
  it('answers directly when a certified block covers the question', async () => {
    const plan = await planResearch({ question: 'what is total revenue', intent: 'exact_certified_lookup', ...ctx });
    expect(plan.decision).toBe('answer');
    expect(plan.done).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.sources).toContain('revenue');
  });

  it('researches multi-step for a why/diagnose question, grounded in real assets', async () => {
    const plan = await planResearch({ question: 'why is revenue down by region', intent: 'diagnose_change', ...ctx });
    expect(plan.decision).toBe('investigate');
    expect(plan.done).toBe(false);
    const kinds = plan.steps.map((s) => s.action.kind);
    expect(kinds).toContain('compare_time');   // ordered_at is available
    expect(kinds).toContain('breakdown');
    const breakdown = plan.steps.find((s) => s.action.kind === 'breakdown');
    expect(breakdown?.action.target).toBe('region');
  });

  it('reuses the root plan qualified metric instead of re-matching a similar name', async () => {
    const plannedMetric: KGNode = {
      nodeId: 'metric:rollover_balance',
      kind: 'metric',
      name: 'rollover_balance',
      payload: { qualifiedId: 'semantic:consumption:rollover_balance' },
    };
    const wrongMetric: KGNode = {
      nodeId: 'metric:rollover_risk',
      kind: 'metric',
      name: 'rollover_risk',
      description: 'Why rollover risk is down by region.',
    };
    const rootPlan = {
      planId: 'rap:root',
      capability: 'semantic_execution',
      questionType: 'diagnosis',
      confidence: 'high',
      selectedConceptIds: ['semantic:consumption:rollover_balance'],
      executionId: 'semantic:consumption:rollover_balance',
      query: { measures: [], dimensions: [], filters: [] },
    } as unknown as ResolvedAnalyticalPlan;
    const plan = await planResearch({
      question: 'Why is rollover risk down by region?',
      metrics: [wrongMetric, plannedMetric],
      blocks: [],
      rootPlan,
      forceInvestigate: true,
    });
    expect(plan.rootPlanId).toBe('rap:root');
    expect(plan.sources).toContain('semantic:consumption:rollover_balance');
    expect(plan.steps.find((step) => step.action.kind === 'lookup_metric')?.action.target)
      .toBe('semantic:consumption:rollover_balance');
    expect(plan.budget).toMatchObject({ sqlExecutions: 6, repairs: 1, wallClockMs: 120_000 });
  });

  it('asks a follow-up with concrete options when the subject is unclear', async () => {
    const plan = await planResearch({ question: 'tell me something interesting', intent: 'clarify', ...ctx });
    expect(plan.decision).toBe('clarify');
    expect(plan.followUp).toBeDefined();
    expect(plan.followUp!.options.length).toBeGreaterThan(0);
    expect(plan.followUp!.options).toContain('revenue'); // a real catalog metric, not open-ended
  });

  it('investigates a forced-research turn even when it would otherwise soft-clarify', async () => {
    // Explicit research mode must dig, not stop to ask, when nothing matched cleanly
    // but the ask isn't genuinely ambiguous (a SOFT clarify). Guards the descriptive-
    // breakdown routing fix that removed "by <dim>" from the soft-investigate regex.
    const plan = await planResearch({
      question: 'customer revenue by segment',
      intent: 'definition_lookup',
      forceInvestigate: true,
      metrics: [],
      blocks: [],
    });
    expect(plan.decision).toBe('investigate');
  });

  it('still honors a genuinely-ambiguous hard clarify even under forced research', async () => {
    const plan = await planResearch({
      question: 'tell me something interesting',
      intent: 'clarify',
      forceInvestigate: true,
      ...ctx,
    });
    expect(plan.decision).toBe('clarify');
  });

  it('offers the certified breakdown dimensions when a metric matched but no breakdown was asked', async () => {
    // A bare metric question with no "by X" — if the controller clarifies, options are real dims.
    const plan = await planResearch({ question: 'revenue please', intent: 'clarify', ...ctx });
    if (plan.decision === 'clarify') {
      expect(plan.followUp!.options.some((o) => o.includes('region') || o.includes('overall'))).toBe(true);
    }
  });

  it('hands a build request to the app planner (compose_app)', async () => {
    const plan = await planResearch({ question: 'build me a revenue dashboard', intent: 'ad_hoc_ranking', ...ctx });
    expect(plan.decision).toBe('compose_app');
    expect(plan.steps[0]?.action.kind).toBe('compose_app');
  });
});
