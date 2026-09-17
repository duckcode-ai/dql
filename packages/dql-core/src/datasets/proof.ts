import { createHash } from 'node:crypto';

/**
 * A durable result of checking a dataset's declared row identity. This is a
 * source-controlled artifact, rather than a preview receipt: a preview can be
 * sampled, filtered, or use another connection and therefore never certifies
 * a dataset grain.
 */
export interface DatasetGrainProofV1 {
  version: 1;
  id: string;
  status: 'passed' | 'failed';
  sourceFingerprint: string;
  queryFingerprint: string;
  keyFingerprint: string;
  /** Exact resolved source parameters used by the complete-source grain probe. */
  parameterFingerprint: string;
  /** Fingerprint of the selected connection/adapter target, never a display name. */
  targetFingerprint: string;
  snapshotId: string;
  snapshotFingerprint: string;
  checkedAt: string;
  uniqueness: {
    rowCount: number;
    distinctKeyCount: number;
    nullKeyCount: number;
    duplicateKeyCount: number;
  };
}

export interface DatasetGrainProofValidationInput {
  proof?: DatasetGrainProofV1;
  sourceFingerprint: string;
  queryFingerprint: string;
  keyFingerprint: string;
  parameterFingerprint: string;
  targetFingerprint: string;
  snapshotId: string;
  snapshotFingerprint: string;
}

export interface DatasetGrainProofValidation {
  valid: boolean;
  reason?: 'missing' | 'malformed' | 'failed' | 'source_mismatch' | 'query_mismatch' | 'key_mismatch' | 'parameter_mismatch' | 'target_mismatch' | 'snapshot_mismatch' | 'uniqueness_failed';
}

/** A stable SHA-256 identity for source/query/key/snapshot proof binding. */
export function datasetProofFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

export function validateDatasetGrainProof(input: DatasetGrainProofValidationInput): DatasetGrainProofValidation {
  const proof = input.proof;
  if (!proof) return { valid: false, reason: 'missing' };
  if (!isDatasetGrainProof(proof)) return { valid: false, reason: 'malformed' };
  if (proof.status !== 'passed') return { valid: false, reason: 'failed' };
  if (proof.sourceFingerprint !== input.sourceFingerprint) return { valid: false, reason: 'source_mismatch' };
  if (proof.queryFingerprint !== input.queryFingerprint) return { valid: false, reason: 'query_mismatch' };
  if (proof.keyFingerprint !== input.keyFingerprint) return { valid: false, reason: 'key_mismatch' };
  if (proof.parameterFingerprint !== input.parameterFingerprint) return { valid: false, reason: 'parameter_mismatch' };
  if (proof.targetFingerprint !== input.targetFingerprint) return { valid: false, reason: 'target_mismatch' };
  if (proof.snapshotId !== input.snapshotId || proof.snapshotFingerprint !== input.snapshotFingerprint) return { valid: false, reason: 'snapshot_mismatch' };
  if (proof.uniqueness.nullKeyCount !== 0 || proof.uniqueness.duplicateKeyCount !== 0 || proof.uniqueness.rowCount !== proof.uniqueness.distinctKeyCount) {
    return { valid: false, reason: 'uniqueness_failed' };
  }
  return { valid: true };
}

export function isDatasetGrainProof(value: unknown): value is DatasetGrainProofV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  const uniqueness = proof.uniqueness;
  return proof.version === 1
    && typeof proof.id === 'string' && Boolean(proof.id.trim())
    && (proof.status === 'passed' || proof.status === 'failed')
    && ['sourceFingerprint', 'queryFingerprint', 'keyFingerprint', 'parameterFingerprint', 'targetFingerprint', 'snapshotId', 'snapshotFingerprint', 'checkedAt']
      .every((key) => typeof proof[key] === 'string' && Boolean(String(proof[key]).trim()))
    && Boolean(uniqueness) && typeof uniqueness === 'object' && !Array.isArray(uniqueness)
    && ['rowCount', 'distinctKeyCount', 'nullKeyCount', 'duplicateKeyCount']
      .every((key) => Number.isSafeInteger((uniqueness as Record<string, unknown>)[key]) && Number((uniqueness as Record<string, unknown>)[key]) >= 0);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
