import { describe, expect, it } from 'vitest';
import {
  analyticalRepairTrustTransition,
  normalizeAnalyticalRepairCapabilityV1,
  normalizeAnalyticalFailureV1,
  normalizeAnalyticalFailureV2,
  normalizeAnalyticalQuestionFrameV2,
  normalizeProviderEgressReceiptV1,
  type AnalyticalQuestionFrameV2,
} from './analytical.js';

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

  it('normalizes target mismatch and redacted connector diagnostics in v2', () => {
    const failure = normalizeAnalyticalFailureV2({
      version: 2,
      runId: 'run-1',
      failureId: 'failure-1',
      code: 'EXECUTION_TARGET_MISMATCH',
      phase: 'validation',
      message: 'The semantic compiler target does not match the active connection.',
      recoverability: 'change_authorized_connection',
      failedBindings: [{ role: 'execution_target', reasonCode: 'database_mismatch' }],
      snapshotId: 'snapshot-1',
      expectedTargetFingerprint: 'expected-target',
      actualTargetFingerprint: 'actual-target',
      adapterId: 'dbt-cloud',
      queryId: 'query-1',
      sqlState: '42000',
      vendorCode: '000904',
      safeActions: ['Reapply setup', 'Choose the mapped connection'],
    });

    expect(failure).toMatchObject({
      version: 2,
      code: 'EXECUTION_TARGET_MISMATCH',
      phase: 'validation',
      expectedTargetFingerprint: 'expected-target',
      actualTargetFingerprint: 'actual-target',
      adapterId: 'dbt-cloud',
      queryId: 'query-1',
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

  it('normalizes typed automatic repair authority and fails closed on incomplete authority', () => {
    const capability = normalizeAnalyticalRepairCapabilityV1({
      version: 1,
      automatic: {
        eligible: true,
        action: 'repair_embedded_sql',
        correctionCode: 'SQL_EXECUTION_REPAIR',
        attemptsRemaining: 1,
      },
      failureFingerprint: 'sha256:failure',
      sourceFingerprint: 'sha256:source',
      planFingerprint: 'sha256:plan',
      dqlFingerprint: 'sha256:dql',
      sqlFingerprint: 'sha256:sql',
      targetFingerprint: 'sha256:target',
      routeLocked: true,
      targetLocked: true,
      sourceImmutable: true,
      manualActions: ['edit_dql', 'open_sql_notebook'],
    });

    expect(capability?.automatic).toEqual({
      eligible: true,
      action: 'repair_embedded_sql',
      correctionCode: 'SQL_EXECUTION_REPAIR',
      attemptsRemaining: 1,
    });
    expect(normalizeAnalyticalRepairCapabilityV1({
      ...capability,
      automatic: { eligible: true, action: 'none', correctionCode: 'MANUAL_REVIEW_REQUIRED', attemptsRemaining: 0 },
    })).toBeUndefined();
  });

  it('normalizes content-free egress receipts and rejects unconsented row counts', () => {
    const receipt = normalizeProviderEgressReceiptV1({
      version: 1,
      purpose: 'research_narration',
      dispatchPhase: 'narration',
      provider: 'openai',
      permittedCategories: ['question', 'schema_metadata', 'result_rows'],
      resultRowCount: 20,
      cumulativeResultRowCount: 20,
      columnCount: 3,
      redactionPolicyId: 'research-result-rows-v1',
      optIn: true,
      payloadFingerprint: 'sha256:payload',
    });
    expect(receipt).toMatchObject({ dispatchPhase: 'narration', resultRowCount: 20, cumulativeResultRowCount: 20, columnCount: 3, optIn: true });
    expect(JSON.stringify(receipt)).not.toContain('Ada Canary');
    expect(normalizeProviderEgressReceiptV1({ ...receipt, optIn: false })).toBeUndefined();
    expect(normalizeProviderEgressReceiptV1({ ...receipt, cumulativeResultRowCount: 19 })).toBeUndefined();
    expect(normalizeProviderEgressReceiptV1({ ...receipt, dispatchPhase: 'untrusted_phase' })).toBeUndefined();
    expect(normalizeProviderEgressReceiptV1({ ...receipt, dispatchPhase: undefined })).toMatchObject({
      version: 1,
      purpose: 'research_narration',
    });
    expect(normalizeProviderEgressReceiptV1({
      ...receipt,
      purpose: 'classification',
      dispatchPhase: 'classification',
      resultRowCount: 0,
      cumulativeResultRowCount: 0,
      columnCount: 0,
      optIn: false,
      permittedCategories: ['question', 'schema_metadata'],
      redactionPolicyId: 'no-result-rows-v1',
    })).toMatchObject({ purpose: 'classification', dispatchPhase: 'classification', resultRowCount: 0 });
    const retryReceipt = normalizeProviderEgressReceiptV1({
      ...receipt,
      purpose: 'answer_generation',
      dispatchPhase: 'generation',
      attemptIndex: 2,
      retryOfAttemptIndex: 1,
      resultRowCount: 0,
      cumulativeResultRowCount: 0,
      columnCount: 0,
      optIn: false,
      permittedCategories: ['question', 'schema_metadata'],
      redactionPolicyId: 'no-result-rows-v1',
    });
    expect(retryReceipt).toMatchObject({
      dispatchPhase: 'generation', attemptIndex: 2, retryOfAttemptIndex: 1,
    });
    expect(normalizeProviderEgressReceiptV1({ ...retryReceipt!, retryOfAttemptIndex: 0 })).toBeUndefined();
    // V1/V2 receipts did not retain a dispatch phase. A historical ordinary
    // narration remains readable, but the host stamps it read-only so it can
    // never be reused as an egress grant for a new Ask run.
    expect(normalizeProviderEgressReceiptV1({
      ...receipt,
      purpose: 'answer_narration',
      dispatchPhase: undefined,
    })).toMatchObject({ purpose: 'answer_narration', legacyReadOnly: true, resultRowCount: 20 });
  });

  it('rejects imported row-bearing receipts outside explicitly opted-in Research', () => {
    const researchReceipt = {
      version: 1,
      purpose: 'research_narration',
      dispatchPhase: 'narration',
      provider: 'openai',
      permittedCategories: ['question', 'schema_metadata', 'result_rows'],
      resultRowCount: 1,
      cumulativeResultRowCount: 1,
      columnCount: 2,
      redactionPolicyId: 'research-result-rows-v1',
      optIn: true,
      payloadFingerprint: 'sha256:research-row',
    } as const;
    expect(normalizeProviderEgressReceiptV1(researchReceipt)).toMatchObject({
      purpose: 'research_narration', resultRowCount: 1, optIn: true,
    });
    expect(normalizeProviderEgressReceiptV1({
      ...researchReceipt,
      purpose: 'research_tool',
      dispatchPhase: 'generation',
    })).toMatchObject({ purpose: 'research_tool', resultRowCount: 1, optIn: true });

    // These shapes simulate hand-edited or stale local run JSON. Normalizing
    // them on import drops the entire receipt, so old content-free Ask phases
    // cannot claim that provider result rows were permitted or disclosed.
    for (const invalid of [
      { purpose: 'classification', dispatchPhase: 'classification' },
      { purpose: 'answer_generation', dispatchPhase: 'meaning_resolution' },
      { purpose: 'answer_narration', dispatchPhase: 'narration' },
      { purpose: 'research_narration', dispatchPhase: 'classification' },
      { purpose: 'research_tool', dispatchPhase: 'narration' },
      { purpose: 'research_narration', dispatchPhase: 'narration', optIn: false },
      { purpose: 'research_tool', dispatchPhase: 'generation', optIn: false },
      {
        purpose: 'classification',
        dispatchPhase: 'classification',
        resultRowCount: 0,
        cumulativeResultRowCount: 1,
      },
    ]) {
      expect(normalizeProviderEgressReceiptV1({ ...researchReceipt, ...invalid })).toBeUndefined();
    }
  });
});
