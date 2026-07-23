/**
 * Target-bound semantic execution contracts shared by Ask, Notebook, Preview,
 * Block Studio, CLI, MCP, and Chat.
 *
 * Credentials never enter these serializable contracts. Runtime adapters hold
 * them only in server-side connector leases.
 *
 * Acceptance: CTX-005, AGT-013, AGT-014, API-006, API-007, SEC-004.
 */

import { createHash } from 'node:crypto';

export const SEMANTIC_EXECUTION_CONTRACT_VERSION = 1 as const;

export type SemanticAdapterIdV1 = 'native' | 'metricflow-cli' | 'dbt-cloud';

export interface SemanticSnapshotRefV1 {
  version: 1;
  snapshotId: string;
  sourceFingerprint: string;
  semanticCatalogFingerprint: string;
  artifact?: {
    kind: 'semantic_manifest' | 'manifest' | 'semantic_yaml' | 'dbt_cloud_catalog';
    fingerprint: string;
    generatedAt?: string;
  };
}

export interface WarehouseTargetContextV1 {
  account?: string;
  database?: string;
  schema?: string;
  role?: string;
  warehouse?: string;
  catalog?: string;
}

export interface WarehouseTargetIdentityV1 {
  version: 1;
  /** Opaque server-owned reference; never a credential or user-provided proof. */
  connectionRef: string;
  identityFingerprint: string;
  driver: string;
  dialect: string;
  redactedContext: WarehouseTargetContextV1;
  observedAt: string;
}

export type SemanticCompileTargetV1 =
  | {
      kind: 'native_snapshot';
      semanticLayerFingerprint: string;
      dialect: string;
    }
  | {
      kind: 'metricflow_target';
      dbtProjectFingerprint: string;
      profilesFingerprint: string;
      profileName: string;
      targetName: string;
      semanticManifestFingerprint: string;
      runtimeVersion: string;
      dialect: string;
    }
  | {
      kind: 'dbt_cloud_environment';
      hostFingerprint: string;
      environmentId: string;
      semanticCatalogFingerprint: string;
      deploymentFingerprint?: string;
      dialect: string;
    };

export type SemanticTargetProofKind =
  | 'semantic_source'
  | 'adapter_target_pin'
  | 'dialect'
  | 'warehouse_context'
  | 'relation_contract';

export interface SemanticTargetBindingV1 {
  version: 1;
  bindingId: string;
  bindingFingerprint: string;
  adapterId: SemanticAdapterIdV1;
  adapterImplementationFingerprint: string;
  /** Opaque revision, changed when credentials are replaced; never a secret hash. */
  credentialRevision: string;
  semanticSnapshot: SemanticSnapshotRefV1;
  compileTarget: SemanticCompileTargetV1;
  executionTarget: WarehouseTargetIdentityV1;
  proof: {
    status: 'verified';
    checks: Array<{ kind: SemanticTargetProofKind; fingerprint: string }>;
  };
}

export interface SemanticRuntimeMemberBindingV1 {
  role: 'metric' | 'dimension' | 'time_dimension' | 'filter' | 'order_by' | 'technical';
  qualifiedId: string;
  authoringReference: string;
  runtimeReference: string;
  entityPath: string[];
}

export interface ExecutableSemanticQueryPlanV1 {
  version: 1;
  executablePlanId: string;
  fingerprint: string;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  targetBinding: SemanticTargetBindingV1;
  runtimeBindings: SemanticRuntimeMemberBindingV1[];
  query: {
    dialect: string;
    sql: string;
    renderedSqlFingerprint: string;
    parameters: Array<{ name: string; type: string }>;
  };
  lineage: {
    relations: string[];
    requiredColumns: Array<{ relation: string; column: string }>;
    assurance: 'adapter_proven' | 'parsed' | 'warehouse_preflight';
    fingerprint: string;
  };
  outputContract: {
    fields: string[];
    grain?: string;
    rowBound: number;
  };
}

export interface SemanticExecutionReceiptV1 {
  version: 1;
  receiptId: string;
  runId: string;
  snapshotId: string;
  planId: string;
  planFingerprint: string;
  executablePlanId: string;
  executablePlanFingerprint: string;
  targetBindingFingerprint: string;
  adapterId: SemanticAdapterIdV1;
  executionTargetFingerprint: string;
  runtimeBindings: SemanticRuntimeMemberBindingV1[];
  compiledSqlFingerprint: string;
  executedSqlFingerprint?: string;
  parameterFingerprint: string;
  queryId?: string;
  sqlState?: string;
  vendorCode?: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  failedPhase?: 'planning' | 'compilation' | 'validation' | 'execution' | 'result_validation';
  outputColumns: string[];
  rowCount: number;
  rowBound: number;
  resultFingerprint?: string;
  timingsMs: Partial<Record<'planning' | 'compilation' | 'validation' | 'execution' | 'result_validation', number>>;
}

export interface WarehouseTargetMismatchV1 {
  field: keyof WarehouseTargetContextV1 | 'driver' | 'dialect';
  expected?: string;
  actual?: string;
}

export function createWarehouseTargetIdentity(input: {
  connectionRef: string;
  driver: string;
  dialect?: string;
  redactedContext?: WarehouseTargetContextV1;
  observedAt?: string;
}): WarehouseTargetIdentityV1 {
  const driver = normalizeIdentifier(input.driver);
  const dialect = normalizeIdentifier(input.dialect ?? input.driver);
  const redactedContext = normalizeWarehouseTargetContext(input.redactedContext ?? {});
  return {
    version: SEMANTIC_EXECUTION_CONTRACT_VERSION,
    connectionRef: input.connectionRef,
    identityFingerprint: semanticExecutionFingerprint({
      driver,
      dialect,
      redactedContext,
    }),
    driver,
    dialect,
    redactedContext,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

export function createSemanticTargetBinding(
  input: Omit<SemanticTargetBindingV1, 'version' | 'bindingFingerprint'>,
): SemanticTargetBindingV1 {
  const payload = {
    bindingId: input.bindingId,
    adapterId: input.adapterId,
    adapterImplementationFingerprint: input.adapterImplementationFingerprint,
    credentialRevision: input.credentialRevision,
    semanticSnapshot: input.semanticSnapshot,
    compileTarget: input.compileTarget,
    executionTarget: input.executionTarget,
    proof: {
      status: input.proof.status,
      checks: [...input.proof.checks].sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.fingerprint.localeCompare(right.fingerprint)),
    },
  } satisfies Omit<SemanticTargetBindingV1, 'version' | 'bindingFingerprint'>;
  return {
    version: SEMANTIC_EXECUTION_CONTRACT_VERSION,
    ...payload,
    bindingFingerprint: semanticExecutionFingerprint(payload),
  };
}

export function compareWarehouseTargets(
  expected: WarehouseTargetIdentityV1,
  actual: WarehouseTargetIdentityV1,
): WarehouseTargetMismatchV1[] {
  const mismatches: WarehouseTargetMismatchV1[] = [];
  if (expected.driver !== actual.driver) {
    mismatches.push({ field: 'driver', expected: expected.driver, actual: actual.driver });
  }
  if (expected.dialect !== actual.dialect) {
    mismatches.push({ field: 'dialect', expected: expected.dialect, actual: actual.dialect });
  }
  for (const field of ['account', 'database', 'schema', 'role', 'warehouse', 'catalog'] as const) {
    const expectedValue = expected.redactedContext[field];
    const actualValue = actual.redactedContext[field];
    if (expectedValue !== undefined && expectedValue !== actualValue) {
      mismatches.push({ field, expected: expectedValue, actual: actualValue });
    }
  }
  return mismatches;
}

export function semanticExecutionFingerprint(value: unknown): string {
  return createHash('sha256').update(stableExecutionValue(value)).digest('hex');
}

function normalizeWarehouseTargetContext(value: WarehouseTargetContextV1): WarehouseTargetContextV1 {
  return Object.fromEntries(
    Object.entries(value)
      .flatMap(([key, item]) => {
        const normalized = normalizeOptionalIdentifier(item);
        return normalized ? [[key, normalized]] : [];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.toUpperCase() : undefined;
}

function stableExecutionValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableExecutionValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableExecutionValue(item)}`)
    .join(',')}}`;
}
