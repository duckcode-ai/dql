import { describe, expect, it } from 'vitest';
import {
  normalizeAgentRunTelemetryV1,
  normalizeAnalyticalExecutionReceiptV1,
} from './execution.js';

describe('normalizeAgentRunTelemetryV1', () => {
  it('retains only bounded timings, counts, and a stable fallback code', () => {
    expect(normalizeAgentRunTelemetryV1({
      version: 1,
      stageDurationsMs: { retrieval: 12.6, total: 999_999_999, prompt: 'secret' },
      providerRoundTrips: 2,
      toolCalls: 4,
      sqlExecutions: 1,
      repairs: 0,
      egressReceipts: 2,
      warehouseDurationMs: 7.2,
      fallbackReason: 'deadline.generated',
      rows: [{ canary: 'never persist' }],
      prompt: 'never persist',
    })).toEqual({
      version: 1,
      stageDurationsMs: { retrieval: 13, total: 86_400_000 },
      providerRoundTrips: 2,
      toolCalls: 4,
      sqlExecutions: 1,
      repairs: 0,
      egressReceipts: 2,
      warehouseDurationMs: 7,
      fallbackReason: 'deadline.generated',
    });
  });

  it('rejects missing counts and content-shaped fallback reasons', () => {
    expect(normalizeAgentRunTelemetryV1({ version: 1, stageDurationsMs: {} })).toBeUndefined();
    expect(normalizeAgentRunTelemetryV1({
      version: 1,
      stageDurationsMs: {},
      providerRoundTrips: 0,
      toolCalls: 0,
      sqlExecutions: 0,
      repairs: 0,
      egressReceipts: 0,
      fallbackReason: 'contains user prompt text',
    })?.fallbackReason).toBeUndefined();
  });
});

describe('normalizeAnalyticalExecutionReceiptV1', () => {
  const receipt = {
    version: 1,
    receiptId: 'analytical-receipt:12345678',
    graphId: 'analytical-graph:12345678',
    graphFingerprint: 'sha256:graph12345678',
    planId: 'resolved-plan:12345678',
    planFingerprint: 'sha256:plan12345678',
    snapshotId: 'snapshot:12345678',
    route: 'semantic',
    trustState: 'governed',
    subReceipts: [{ nodeId: 'source:metric', receiptFingerprint: 'sha256:source12345678' }],
    outputColumns: ['customer_id', 'total_revenue'],
    rowCount: 2,
    rowBound: 100,
    resultFingerprint: 'sha256:result12345678',
    targetFingerprint: 'sha256:target12345678',
    parameterFingerprint: 'sha256:params12345678',
    compiledSqlFingerprints: ['sha256:sql12345678'],
    artifactFingerprint: 'sha256:artifact12345678',
    aggregationProofFingerprint: 'sha256:proof12345678',
    providerEgressReceiptFingerprints: [],
    telemetryFingerprint: 'sha256:telemetry12345678',
  } as const;

  it('retains canonical plan, target, SQL, result, proof, egress, and telemetry linkage', () => {
    expect(normalizeAnalyticalExecutionReceiptV1(receipt)).toEqual(receipt);
  });

  it('rejects invalid result contracts and content-shaped fingerprints', () => {
    expect(normalizeAnalyticalExecutionReceiptV1({ ...receipt, rowCount: 101 })).toBeUndefined();
    expect(normalizeAnalyticalExecutionReceiptV1({ ...receipt, targetFingerprint: 'customer@example.com' })).toBeUndefined();
    expect(normalizeAnalyticalExecutionReceiptV1({ ...receipt, subReceipts: [{ nodeId: 'source', receiptFingerprint: 'row content' }] })).toBeUndefined();
  });
});
