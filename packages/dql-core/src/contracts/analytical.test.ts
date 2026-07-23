import { describe, expect, it } from 'vitest';
import { analyticalRepairTrustTransition, normalizeAnalyticalFailureV1, normalizeAnalyticalQuestionFrameV2, type AnalyticalQuestionFrameV2 } from './analytical.js';

const comparisonFrame: AnalyticalQuestionFrameV2 = {
  version: 2,
  interpretedQuestion: 'Current and last-year revenue for the top five customers.',
  questionType: 'ranking',
  metricConceptIds: ['commerce::metric::net_revenue'],
  entityGrainIds: ['commerce::entity::customer'],
  dimensions: [
    { dimensionId: 'commerce::dimension::customer_name', role: 'group_by' },
    { dimensionId: 'commerce::dimension::customer_name', role: 'rank_entity' },
    { dimensionId: 'commerce::dimension::report_date', role: 'time_axis' },
  ],
  memberBindings: [],
  timeContext: {
    timeDimensionId: 'commerce::dimension::report_date',
    timeRole: 'report_as_of',
    calendarId: 'calendar:gregorian',
    timezone: 'America/Chicago',
    grain: 'day',
    completenessPolicy: 'latest_complete',
    periods: [
      {
        id: 'current',
        kind: 'current',
        start: '2026-07-01',
        end: '2026-07-22',
      },
      {
        id: 'previous_year',
        kind: 'previous_year',
        start: '2025-07-01',
        end: '2025-07-22',
        alignToPeriodId: 'current',
      },
    ],
  },
  comparison: {
    basePeriodId: 'current',
    comparisonPeriodIds: ['previous_year'],
    alignment: 'elapsed_period',
    outputs: ['value', 'absolute_delta', 'percent_delta'],
    zeroDenominatorPolicy: 'null',
  },
  ranking: {
    entityDimensionId: 'commerce::dimension::customer_name',
    byMetricId: 'commerce::metric::net_revenue',
    byPeriodId: 'current',
    direction: 'desc',
    limit: 5,
    tiePolicy: 'stable_secondary_key',
  },
  requestedOutputs: [
    { id: 'customer_name', kind: 'dimension' },
    {
      id: 'current_revenue',
      kind: 'metric_value',
      metricId: 'commerce::metric::net_revenue',
      periodId: 'current',
    },
    {
      id: 'previous_revenue',
      kind: 'metric_value',
      metricId: 'commerce::metric::net_revenue',
      periodId: 'previous_year',
    },
    {
      id: 'revenue_delta',
      kind: 'delta',
      metricId: 'commerce::metric::net_revenue',
    },
    {
      id: 'revenue_delta_pct',
      kind: 'percent_delta',
      metricId: 'commerce::metric::net_revenue',
    },
  ],
  ambiguity: [],
};

describe('analytical cross-surface contracts (CONTRACT-002 / AGT-017 / API-007)', () => {
  it('normalizes a complete comparison/ranking frame without losing roles or periods', () => {
    expect(normalizeAnalyticalQuestionFrameV2(comparisonFrame)).toEqual(comparisonFrame);
  });

  it('rejects malformed ranking and dimension roles', () => {
    expect(
      normalizeAnalyticalQuestionFrameV2({
        ...comparisonFrame,
        ranking: { ...comparisonFrame.ranking, limit: 0 },
      }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticalQuestionFrameV2({
        ...comparisonFrame,
        dimensions: [{ dimensionId: 'customer', role: 'guess' }],
      }),
    ).toBeUndefined();
  });

  it('normalizes a stable failed-execution contract', () => {
    const failure = normalizeAnalyticalFailureV1({
      version: 1,
      runId: 'run-1',
      failureId: 'failure-1',
      code: 'COLUMN_NOT_FOUND',
      phase: 'execution',
      message: 'The governed reporting-date binding could not be resolved.',
      recoverability: 'refresh_snapshot',
      failedBindings: [
        {
          qualifiedId: 'commerce::dimension::report_date',
          role: 'time_axis',
          reasonCode: 'WAREHOUSE_COLUMN_MISSING',
        },
      ],
      snapshotId: 'snapshot-1',
      planFingerprint: 'plan-fingerprint',
      safeActions: ['Refresh the project snapshot', 'Repair DQL and rerun'],
    });
    expect(failure).toMatchObject({
      code: 'COLUMN_NOT_FOUND',
      phase: 'execution',
      failedBindings: [{ qualifiedId: 'commerce::dimension::report_date' }],
    });
  });

  it('applies the repair trust matrix without preserving certification after source edits', () => {
    expect(
      analyticalRepairTrustTransition({
        previous: 'certified',
        change: 'parameter_only',
      }),
    ).toEqual({
      previous: 'certified',
      next: 'certified',
      requiresNewReceipt: true,
      requiresReview: false,
      preservesCertifiedAssetIdentity: true,
    });
    expect(
      analyticalRepairTrustTransition({
        previous: 'certified',
        change: 'dql_source',
        governedValidationPassed: true,
      }),
    ).toMatchObject({
      next: 'governed',
      requiresReview: true,
      preservesCertifiedAssetIdentity: false,
    });
    expect(
      analyticalRepairTrustTransition({
        previous: 'certified',
        change: 'sql_text',
      }),
    ).toMatchObject({
      next: 'review_required',
      preservesCertifiedAssetIdentity: false,
    });
    expect(
      analyticalRepairTrustTransition({
        previous: 'review_required',
        change: 'reviewed_draft_promotion',
        governedValidationPassed: false,
      }),
    ).toMatchObject({
      next: 'review_required',
      requiresReview: true,
      preservesCertifiedAssetIdentity: false,
    });
  });
});
