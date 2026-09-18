import { describe, expect, it } from 'vitest';
import { isDatasetGrainProof, validateDatasetGrainProof, type DatasetGrainProofV1 } from './proof.js';

function proof(overrides: Partial<DatasetGrainProofV1> = {}): DatasetGrainProofV1 {
  return {
    version: 1,
    id: 'proof.order-lines',
    status: 'passed',
    sourceFingerprint: 'source-v1',
    queryFingerprint: 'query-v1',
    keyFingerprint: 'keys-v1',
    parameterFingerprint: 'parameters-v1',
    targetFingerprint: 'warehouse-a',
    snapshotId: 'dataset-scope:orders-v1',
    snapshotFingerprint: 'scope-v1',
    checkedAt: '2026-09-10T00:00:00.000Z',
    uniqueness: { rowCount: 4, distinctKeyCount: 4, nullKeyCount: 0, duplicateKeyCount: 0 },
    ...overrides,
  };
}

const current = {
  sourceFingerprint: 'source-v1',
  queryFingerprint: 'query-v1',
  keyFingerprint: 'keys-v1',
  parameterFingerprint: 'parameters-v1',
  targetFingerprint: 'warehouse-a',
  snapshotId: 'dataset-scope:orders-v1',
  snapshotFingerprint: 'scope-v1',
};

describe('dataset grain proof validation', () => {
  it('accepts only a passed unique proof bound to the current source, scope, and target', () => {
    expect(validateDatasetGrainProof({ proof: proof(), ...current })).toEqual({ valid: true });
  });

  it('fails closed when the active warehouse target changed', () => {
    expect(validateDatasetGrainProof({ proof: proof(), ...current, targetFingerprint: 'warehouse-b' }))
      .toEqual({ valid: false, reason: 'target_mismatch' });
  });

  it('fails closed when the declared source or dependency-scoped snapshot changed', () => {
    expect(validateDatasetGrainProof({ proof: proof(), ...current, sourceFingerprint: 'source-v2' }))
      .toEqual({ valid: false, reason: 'source_mismatch' });
    expect(validateDatasetGrainProof({ proof: proof(), ...current, snapshotFingerprint: 'scope-v2' }))
      .toEqual({ valid: false, reason: 'snapshot_mismatch' });
  });

  it('fails closed when the resolved source parameters changed', () => {
    expect(validateDatasetGrainProof({ proof: proof(), ...current, parameterFingerprint: 'parameters-v2' }))
      .toEqual({ valid: false, reason: 'parameter_mismatch' });
  });

  it('does not accept a forged or incomplete uniqueness result', () => {
    const forged = { ...proof(), targetFingerprint: '' };
    expect(isDatasetGrainProof(forged)).toBe(false);
    expect(validateDatasetGrainProof({ proof: proof({ uniqueness: { rowCount: 4, distinctKeyCount: 3, nullKeyCount: 0, duplicateKeyCount: 1 } }), ...current }))
      .toEqual({ valid: false, reason: 'uniqueness_failed' });
  });
});
