export const AGGREGATION_SAFETY_PROOF_VERSION = 1 as const;
export const AGENT_RUN_TELEMETRY_VERSION = 1 as const;
export const ANALYTICAL_EXECUTION_RECEIPT_VERSION = 1 as const;

export type AnalyticalExecutionRouteV1 =
  | 'certified'
  | 'semantic'
  | 'governed_sql'
  | 'exploratory';

/**
 * Canonical, content-free receipt for one analytical execution. The original
 * artifact and frozen plan are identified by fingerprints; a repair therefore
 * creates another receipt instead of mutating this one.
 *
 * The optional linkage fields are retained for graph-only callers that do not
 * own a warehouse target. ExecutionService callers populate every linkage.
 */
export interface AnalyticalExecutionReceiptV1 {
  version: 1;
  receiptId: string;
  graphId: string;
  graphFingerprint: string;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  route: AnalyticalExecutionRouteV1;
  trustState: 'certified' | 'governed' | 'review_required';
  subReceipts: Array<{ nodeId: string; receiptFingerprint: string }>;
  outputColumns: string[];
  rowCount: number;
  rowBound: number;
  resultFingerprint: string;
  targetFingerprint?: string;
  parameterFingerprint?: string;
  compiledSqlFingerprints?: string[];
  artifactFingerprint?: string;
  aggregationProofFingerprint?: string;
  providerEgressReceiptFingerprints?: string[];
  telemetryFingerprint?: string;
}

export type AggregationSafetyStatus = 'safe' | 'targeted_repair_available' | 'blocked';
export type AggregationAdditivity = 'additive' | 'semi_additive' | 'non_additive' | 'unknown';
export type AggregationFanoutEvidence = 'proven_absent' | 'possible' | 'present' | 'unknown';
export type AggregationRoundingEvidence = 'none' | 'outer' | 'inner' | 'unknown';

/**
 * Content-free, positive-evidence proof for aggregation policy decisions.
 * Warehouse execution success is deliberately absent: it is diagnostic, never
 * authority for metric/additivity/grain safety.
 */
export interface AggregationSafetyProofV1 {
  version: 1;
  status: AggregationSafetyStatus;
  metricIds: string[];
  metricProvenanceFingerprints: string[];
  nativeGrain: string[];
  requestedGrain: string[];
  additivity: AggregationAdditivity;
  joinCardinalities: string[];
  fanout: AggregationFanoutEvidence;
  rounding: AggregationRoundingEvidence;
  issueCodes: string[];
  correctionCodes: string[];
  sqlFingerprint: string;
  planFingerprint?: string;
  evidenceFingerprint: string;
}

export type AgentRunTelemetryStage =
  | 'snapshot'
  | 'retrieval'
  | 'schema'
  | 'meaning'
  | 'provider'
  | 'tools'
  | 'validation'
  | 'repair'
  | 'execution'
  | 'narration'
  | 'persistence'
  | 'total';

export interface AgentRunTelemetryV1 {
  version: 1;
  stageDurationsMs: Partial<Record<AgentRunTelemetryStage, number>>;
  providerRoundTrips: number;
  toolCalls: number;
  sqlExecutions: number;
  repairs: number;
  egressReceipts: number;
  warehouseDurationMs?: number;
  fallbackReason?: string;
}

const MAX_RECORDED_DURATION_MS = 24 * 60 * 60 * 1000;

/** Fail-closed normalizer for durable telemetry. It accepts numbers and codes only. */
export function normalizeAgentRunTelemetryV1(value: unknown): AgentRunTelemetryV1 | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== 1) return undefined;
  const durations = objectRecord(record.stageDurationsMs) ?? {};
  const stageDurationsMs: AgentRunTelemetryV1['stageDurationsMs'] = {};
  const stages: AgentRunTelemetryStage[] = [
    'snapshot', 'retrieval', 'schema', 'meaning', 'provider', 'tools', 'validation',
    'repair', 'execution', 'narration', 'persistence', 'total',
  ];
  for (const stage of stages) {
    const duration = boundedDuration(durations[stage]);
    if (duration !== undefined) stageDurationsMs[stage] = duration;
  }
  const providerRoundTrips = nonNegativeInteger(record.providerRoundTrips);
  const toolCalls = nonNegativeInteger(record.toolCalls);
  const sqlExecutions = nonNegativeInteger(record.sqlExecutions);
  const repairs = nonNegativeInteger(record.repairs);
  const egressReceipts = nonNegativeInteger(record.egressReceipts);
  if ([providerRoundTrips, toolCalls, sqlExecutions, repairs, egressReceipts].some((count) => count === undefined)) {
    return undefined;
  }
  const warehouseDurationMs = boundedDuration(record.warehouseDurationMs);
  const fallbackReason = safeCode(record.fallbackReason);
  return {
    version: 1,
    stageDurationsMs,
    providerRoundTrips: providerRoundTrips!,
    toolCalls: toolCalls!,
    sqlExecutions: sqlExecutions!,
    repairs: repairs!,
    egressReceipts: egressReceipts!,
    ...(warehouseDurationMs === undefined ? {} : { warehouseDurationMs }),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

/** Fail-closed normalizer for persisted analytical execution receipts. */
export function normalizeAnalyticalExecutionReceiptV1(value: unknown): AnalyticalExecutionReceiptV1 | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== 1) return undefined;
  const route = stringUnion(record.route, ['certified', 'semantic', 'governed_sql', 'exploratory'] as const);
  const trustState = stringUnion(record.trustState, ['certified', 'governed', 'review_required'] as const);
  const receiptId = safeIdentifier(record.receiptId);
  const graphId = safeIdentifier(record.graphId);
  const graphFingerprint = safeFingerprint(record.graphFingerprint);
  const planId = safeIdentifier(record.planId);
  const planFingerprint = safeFingerprint(record.planFingerprint);
  const snapshotId = safeIdentifier(record.snapshotId);
  const resultFingerprint = safeFingerprint(record.resultFingerprint);
  const outputColumns = safeStringArray(record.outputColumns, 256, 256);
  const rowCount = nonNegativeInteger(record.rowCount);
  const rowBound = nonNegativeInteger(record.rowBound);
  if (!route || !trustState || !receiptId || !graphId || !graphFingerprint || !planId
    || !planFingerprint || !snapshotId || !resultFingerprint || !outputColumns
    || rowCount === undefined || rowBound === undefined || rowCount > rowBound) return undefined;
  const subReceipts = Array.isArray(record.subReceipts)
    ? record.subReceipts.map((item) => {
        const entry = objectRecord(item);
        const nodeId = safeIdentifier(entry?.nodeId);
        const receiptFingerprint = safeFingerprint(entry?.receiptFingerprint);
        return nodeId && receiptFingerprint ? { nodeId, receiptFingerprint } : undefined;
      })
    : undefined;
  if (!subReceipts || subReceipts.some((entry) => !entry)) return undefined;
  const optionalFingerprint = (key: string): string | undefined => record[key] === undefined
    ? undefined
    : safeFingerprint(record[key]);
  const targetFingerprint = optionalFingerprint('targetFingerprint');
  const parameterFingerprint = optionalFingerprint('parameterFingerprint');
  const artifactFingerprint = optionalFingerprint('artifactFingerprint');
  const aggregationProofFingerprint = optionalFingerprint('aggregationProofFingerprint');
  const telemetryFingerprint = optionalFingerprint('telemetryFingerprint');
  if (['targetFingerprint', 'parameterFingerprint', 'artifactFingerprint', 'aggregationProofFingerprint', 'telemetryFingerprint']
    .some((key) => record[key] !== undefined && !optionalFingerprint(key))) return undefined;
  const compiledSqlFingerprints = optionalFingerprintArray(record.compiledSqlFingerprints);
  const providerEgressReceiptFingerprints = optionalFingerprintArray(record.providerEgressReceiptFingerprints);
  if ((record.compiledSqlFingerprints !== undefined && !compiledSqlFingerprints)
    || (record.providerEgressReceiptFingerprints !== undefined && !providerEgressReceiptFingerprints)) return undefined;
  return {
    version: 1,
    receiptId,
    graphId,
    graphFingerprint,
    planId,
    planFingerprint,
    snapshotId,
    route,
    trustState,
    subReceipts: subReceipts as AnalyticalExecutionReceiptV1['subReceipts'],
    outputColumns,
    rowCount,
    rowBound,
    resultFingerprint,
    ...(targetFingerprint ? { targetFingerprint } : {}),
    ...(parameterFingerprint ? { parameterFingerprint } : {}),
    ...(compiledSqlFingerprints ? { compiledSqlFingerprints } : {}),
    ...(artifactFingerprint ? { artifactFingerprint } : {}),
    ...(aggregationProofFingerprint ? { aggregationProofFingerprint } : {}),
    ...(providerEgressReceiptFingerprints ? { providerEgressReceiptFingerprints } : {}),
    ...(telemetryFingerprint ? { telemetryFingerprint } : {}),
  };
}

function boundedDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_RECORDED_DURATION_MS, Math.round(value))
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value)
    ? value
    : undefined;
}

function safeFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9:_-]{8,256}$/i.test(value) ? value : undefined;
}

function safeStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result = value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= maxLength);
  return result.length === value.length ? result : undefined;
}

function optionalFingerprintArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const fingerprints = value.map(safeFingerprint);
  return fingerprints.every((item): item is string => Boolean(item)) ? fingerprints : undefined;
}

function stringUnion<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
