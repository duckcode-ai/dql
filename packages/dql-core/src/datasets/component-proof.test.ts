import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from './descriptor.js';
import {
  datasetAggregateComponentProofCovers,
  datasetAggregateComponentRequirements,
  type DatasetAggregateComponentProofV1,
} from './component-proof.js';

function descriptor(): DatasetDescriptor {
  return {
    version: 1,
    id: 'customer-daily', kind: 'block', sourceRevision: 'source-v1', snapshotId: 'snapshot-v1',
    contractRef: { kind: 'block_source', id: 'customer-daily', fingerprint: 'contract-v1' },
    binding: { sourceQualifiedId: 'customer-daily', sourceRevision: 'source-v1', contractFingerprint: 'contract-v1', state: 'valid' },
    label: 'Customer daily', lifecycle: 'certified', trust: 'certified',
    grain: { entityIds: ['customer_day'], keyFields: ['customer_day_id', 'order_date'], keyEvidence: 'proof.daily', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true },
    fields: [
      { kind: 'physical', name: 'customer_day_id', qualifiedId: 'field:customer_day_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: 'field:order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'] } },
      { kind: 'physical', name: 'daily_revenue', qualifiedId: 'field:daily_revenue', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'daily_margin', qualifiedId: 'field:daily_margin', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'daily_orders', qualifiedId: 'field:daily_orders', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'measure', name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum', from: 'daily_revenue', dependsOn: ['daily_revenue'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'margin_rate', qualifiedId: 'measure:margin_rate', aggregation: 'ratio', numerator: 'daily_margin', denominator: 'daily_revenue', dependsOn: ['daily_margin', 'daily_revenue'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['ratio'], status: 'approved' },
      { kind: 'measure', name: 'average_order_value', qualifiedId: 'measure:average_order_value', aggregation: 'ratio', numerator: 'daily_revenue', denominator: 'daily_orders', dependsOn: ['daily_revenue', 'daily_orders'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['ratio'], status: 'approved' },
      { kind: 'measure', name: 'customer_count', qualifiedId: 'measure:customer_count', aggregation: 'count_distinct', from: 'daily_orders', dependsOn: ['daily_orders'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
    ],
    operations: ['group', 'trend'], execution: { route: 'certified' },
  };
}

function proof(): DatasetAggregateComponentProofV1 {
  return {
    version: 1,
    status: 'passed',
    binding: {
      sourceId: 'customer-daily', sourceRevision: 'source-v1', contractFingerprint: 'contract-v1',
      sourceSqlFingerprint: 'sha256:source', parameterFingerprint: 'sha256:params', targetFingerprint: 'sha256:target',
      snapshotId: 'snapshot-v1', snapshotFingerprint: 'sha256:snapshot', readScopeId: 'scope-1',
      readScopeContextFingerprint: 'sha256:scope-context',
      groupingFingerprint: 'sha256:grouping', timeBucketFingerprint: 'sha256:bucket', timeGrain: 'day',
    },
    components: [
      { alias: 'daily_revenue', targetOperation: 'sum', sourceAggregate: 'sum', sourceExpressionFingerprint: 'sha256:revenue' },
      { alias: 'daily_margin', targetOperation: 'sum', sourceAggregate: 'sum', sourceExpressionFingerprint: 'sha256:margin' },
      { alias: 'daily_orders', targetOperation: 'sum', sourceAggregate: 'count_distinct', sourceExpressionFingerprint: 'sha256:orders', countedKeyFingerprint: 'sha256:order-key' },
    ],
    evidence: { checkedAt: '2026-09-11T00:00:00.000Z', probeFingerprint: 'sha256:probe', method: 'distinct_membership_scope', checkedDistinctComponents: ['daily_orders'] },
    fingerprint: 'sha256:proof',
  };
}

describe('Dataset aggregate component requirements', () => {
  it('requires the exact native SUM inputs for ratios without treating the output as additive', () => {
    const requirements = datasetAggregateComponentRequirements(descriptor(), {
      measures: [{ measure: 'margin_rate' }, { measure: 'average_order_value' }],
    });
    expect(requirements.supported).toBe(true);
    expect(requirements.requirements.map((entry) => entry.component)).toEqual(['daily_margin', 'daily_orders', 'daily_revenue']);
    expect(datasetAggregateComponentProofCovers(proof(), requirements.requirements)).toBe(true);
  });

  it('refuses a direct distinct output as a rollup component', () => {
    const requirements = datasetAggregateComponentRequirements(descriptor(), { measures: [{ measure: 'customer_count' }] });
    expect(requirements.supported).toBe(false);
    expect(requirements.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DATASET_COMPONENT_UNSUPPORTED_AGGREGATION' }),
    ]));
  });
});
