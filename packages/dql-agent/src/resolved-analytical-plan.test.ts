import { describe, expect, it } from 'vitest';
import { buildResolvedAnalyticalPlan, deriveResolvedAnalyticalPlan, resolvePlanTimeRange } from './resolved-analytical-plan.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';

const metric: AgentEvidenceCandidate = {
  id: 'semantic:metric:consumption_model.rollover_balance_amount',
  qualifiedId: 'semantic:consumption:rollover_balance_amount',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Rollover Balance Amount',
  aliases: ['rollover balance'],
  definition: 'Remaining eligible balance carried into the next billing month.',
  domain: 'consumption',
  primaryEntity: 'account',
  dimensions: ['semantic:consumption:dimension:customer', 'semantic:consumption:dimension:month'],
  timeGrains: ['month'],
  relationshipEvidence: ['consumption::relationship::balance_to_customer'],
  relevanceScore: 0.98,
  matchReasons: ['meaning match'],
  compatibility: 'compatible',
  compatibilityFacts: ['dimension: customer', 'time grain: month'],
};

const evidence: AgentRetrievalEvidence = {
  snapshotId: 'snapshot-1',
  sourceFingerprint: 'source-1',
  knowledgeLens: {
    mode: 'pinned',
    activeDomainId: 'consumption',
    skillRefs: ['consumption::skill::rollover-analysis'],
    snapshotId: 'snapshot-1',
    skillFingerprints: { 'consumption::skill::rollover-analysis': 'skill-hash-1' },
  },
  candidates: [metric],
};

const resolution: MeaningResolution = {
  interpretedQuestion: 'Top customers by monthly rollover balance amount.',
  questionType: 'ranking',
  selectedConceptIds: [metric.id],
  recommendedExecutionId: metric.id,
  queryIntent: {
    measures: ['rollover balance'],
    dimensions: ['customer'],
    filters: [],
    timeGrain: 'month',
    order: 'desc',
    limit: 10,
  },
  rejectedCandidates: [],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'semantic',
};

describe('ResolvedAnalyticalPlan (AGT-013 / API-006)', () => {
  it('resolves relative time once against the plan clock', () => {
    expect(resolvePlanTimeRange('last month', new Date('2026-07-22T15:00:00Z'))).toEqual({
      expression: 'last month',
      startInclusive: '2026-06-01T00:00:00.000Z',
      endExclusive: '2026-07-01T00:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(resolvePlanTimeRange('last 7 days', new Date('2026-07-22T15:00:00Z'))).toEqual({
      expression: 'last 7 days',
      startInclusive: '2026-07-15T00:00:00.000Z',
      endExclusive: '2026-07-22T00:00:00.000Z',
      timeZone: 'UTC',
    });
  });

  it('binds canonical IDs, snapshot/Skill hashes, compatibility, and output shape deterministically', () => {
    const first = buildResolvedAnalyticalPlan({
      question: 'Who are the top 10 customers by monthly rollover balance?',
      resolution,
      evidence,
      candidates: [metric],
    });
    const second = buildResolvedAnalyticalPlan({
      question: 'Who are the top 10 customers by monthly rollover balance?',
      resolution,
      evidence,
      candidates: [metric],
    });

    expect(first).toMatchObject({
      mode: 'shadow',
      snapshotId: 'snapshot-1',
      selectedConceptIds: ['semantic:consumption:rollover_balance_amount'],
      executionId: 'semantic:consumption:rollover_balance_amount',
      capability: 'semantic_execution',
      entityGrain: 'account',
      relationshipPathIds: ['consumption::relationship::balance_to_customer'],
      query: {
        measures: [expect.objectContaining({ status: 'resolved' })],
        dimensions: [expect.objectContaining({
          requested: 'customer',
          qualifiedId: 'semantic:consumption:dimension:customer',
          status: 'resolved',
        })],
        timeGrain: 'month',
        order: 'desc',
        limit: 10,
      },
      knowledgeLens: {
        skillFingerprints: { 'consumption::skill::rollover-analysis': 'skill-hash-1' },
      },
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.planId).toBe(second.planId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.query.dimensions)).toBe(true);
  });

  it('fails capability closed when a requested semantic dimension is unresolved', () => {
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by campaign channel.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, dimensions: ['campaign channel'] },
      },
      evidence,
      candidates: [metric],
    });
    expect(plan.query.dimensions).toEqual([
      expect.objectContaining({ requested: 'campaign channel', status: 'unresolved' }),
    ]);
    expect(plan.capability).toBe('blocked');
  });

  it('fails capability closed when a requested measure cannot bind inside the selected meaning', () => {
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover liability by customer.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, measures: ['unrelated liability'] },
      },
      evidence,
      candidates: [metric],
    });
    expect(plan.query.measures).toEqual([
      expect.objectContaining({ requested: 'unrelated liability', status: 'unresolved' }),
    ]);
    expect(plan.capability).toBe('blocked');
  });

  it('applies a typed follow-up delta without reading prior prose or SQL', () => {
    const root = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by customer.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, timeRange: 'last month' },
      },
      evidence,
      candidates: [metric],
      mode: 'authoritative',
      referenceTime: new Date('2026-07-22T15:00:00Z'),
    });
    const followUp = deriveResolvedAnalyticalPlan(root, {
      question: 'Only Melissa, top 3.',
      selectedResultFilter: {
        binding: root.query.dimensions[0]!,
        value: 'Melissa Lopez',
        sourceTurnId: 'turn-1',
      },
      limit: 3,
    });
    expect(followUp).toMatchObject({
      parentPlanId: root.planId,
      rootPlanId: root.planId,
      revision: 1,
      snapshotId: root.snapshotId,
      executionId: root.executionId,
      query: {
        limit: 3,
        timeBounds: {
          startInclusive: '2026-06-01T00:00:00.000Z',
          endExclusive: '2026-07-01T00:00:00.000Z',
        },
        filters: [{
          value: 'Melissa Lopez',
          binding: { qualifiedId: 'semantic:consumption:dimension:customer' },
        }],
      },
    });
    expect(followUp.fingerprint).not.toBe(root.fingerprint);
    expect(followUp.query.timeBounds).toEqual(root.query.timeBounds);
    expect(Object.isFrozen(followUp)).toBe(true);
  });
});
