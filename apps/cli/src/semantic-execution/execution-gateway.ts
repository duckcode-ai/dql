import { randomUUID } from 'node:crypto';
import {
  semanticExecutionFingerprint,
  type SemanticAdapterIdV1,
  type SemanticExecutionReceiptV1,
  type SemanticRuntimeMemberBindingV1,
  type SemanticTargetBindingV1,
  type WarehouseTargetIdentityV1,
} from '@duckcodeailabs/dql-core';
import {
  ConnectorQueryError,
  type ConnectionConfig,
  type QueryExecutor,
  type QueryResult,
} from '@duckcodeailabs/dql-connectors';
import type {
  SemanticRuntimeCompileResult,
  SemanticRuntimeTrace,
} from '../semantic-runtime.js';
import { observeWarehouseTargetIdentity } from './connection-identity.js';
import {
  SemanticAdapterDriftError,
  buildSemanticTargetBinding,
  type MetricFlowTargetMetadata,
} from './target-binding.js';

export class SemanticPhysicalPreflightError extends Error {
  readonly code = 'PHYSICAL_PREFLIGHT_FAILED';
  readonly details: {
    adapterId: SemanticAdapterIdV1;
    phase: 'validation';
    queryId?: string;
    sqlState?: string;
    vendorCode?: string;
    line?: number;
    position?: number;
  };

  constructor(adapterId: SemanticAdapterIdV1, error: unknown) {
    const connector = error instanceof ConnectorQueryError ? error : undefined;
    super(
      `The semantic query compiled, but warehouse validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? { cause: error } : undefined,
    );
    this.name = 'SemanticPhysicalPreflightError';
    this.details = {
      adapterId,
      phase: 'validation',
      queryId: connector?.queryId,
      sqlState: connector?.sqlState,
      vendorCode: connector?.vendorCode,
      line: connector?.line,
      position: connector?.position,
    };
  }
}

export interface SemanticExecutionGatewayResult {
  compiled: SemanticRuntimeCompileResult;
  preparedSql: string;
  executionTarget: WarehouseTargetIdentityV1;
  targetBinding: SemanticTargetBindingV1;
  result: QueryResult;
  executionReceipt: SemanticExecutionReceiptV1;
  semanticTrace: SemanticRuntimeTrace;
}

export async function executeTargetBoundSemanticQuery(input: {
  executor: QueryExecutor;
  connection: ConnectionConfig;
  projectRoot: string;
  plannedAdapter: SemanticAdapterIdV1;
  metricFlow?: MetricFlowTargetMetadata;
  compile: () => Promise<SemanticRuntimeCompileResult | null>;
  prepareSql?: (sql: string) => { sql: string; connection?: ConnectionConfig };
  rowBound?: number;
}): Promise<SemanticExecutionGatewayResult | null> {
  const startedAt = Date.now();
  const executionTarget = await observeWarehouseTargetIdentity(input.executor, input.connection);
  // Target validation intentionally happens before a remote compiler is called.
  buildSemanticTargetBinding({
    projectRoot: input.projectRoot,
    adapterId: input.plannedAdapter,
    executionTarget,
    metricFlow: input.metricFlow,
  });
  const compileStartedAt = Date.now();
  const compiled = await input.compile();
  if (!compiled) return null;
  if (compiled.engine !== input.plannedAdapter) {
    throw new SemanticAdapterDriftError(input.plannedAdapter, compiled.engine);
  }
  const targetBinding = buildSemanticTargetBinding({
    projectRoot: input.projectRoot,
    adapterId: compiled.engine,
    executionTarget,
    metricFlow: input.metricFlow,
  });
  const prepared = input.prepareSql?.(compiled.sql) ?? { sql: compiled.sql, connection: input.connection };
  const preparedConnection = prepared.connection ?? input.connection;
  const validationStartedAt = Date.now();
  await preflightCompiledSql(
    input.executor,
    preparedConnection,
    prepared.sql,
    compiled.engine,
  );
  const executionStartedAt = Date.now();
  const rowBound = Math.max(1, Math.min(input.rowBound ?? 10_000, 100_000));
  const result = await input.executor.executePositional(
    prepared.sql,
    [],
    preparedConnection,
    {
      maxRows: rowBound,
      maxBytes: 16 * 1024 * 1024,
      batchSize: 500,
      deadlineMs: 120_000,
    },
  );
  const runtimeBindings = runtimeBindingsFromTrace(compiled.semanticTrace);
  const compiledSqlFingerprint = semanticExecutionFingerprint(compiled.sql);
  const executedSqlFingerprint = semanticExecutionFingerprint(prepared.sql);
  const planFingerprint = semanticExecutionFingerprint({
    request: compiled.effectiveRequest,
    adapterId: compiled.engine,
    snapshotId: targetBinding.semanticSnapshot.snapshotId,
  });
  const executablePlanFingerprint = semanticExecutionFingerprint({
    planFingerprint,
    targetBindingFingerprint: targetBinding.bindingFingerprint,
    executedSqlFingerprint,
  });
  const receipt: SemanticExecutionReceiptV1 = {
    version: 1,
    receiptId: `semantic-receipt:${randomUUID()}`,
    runId: `semantic-run:${randomUUID()}`,
    snapshotId: targetBinding.semanticSnapshot.snapshotId,
    planId: `semantic-plan:${planFingerprint.slice(0, 24)}`,
    planFingerprint,
    executablePlanId: `semantic-executable:${executablePlanFingerprint.slice(0, 24)}`,
    executablePlanFingerprint,
    targetBindingFingerprint: targetBinding.bindingFingerprint,
    adapterId: compiled.engine,
    executionTargetFingerprint: executionTarget.identityFingerprint,
    runtimeBindings,
    compiledSqlFingerprint,
    executedSqlFingerprint,
    parameterFingerprint: semanticExecutionFingerprint([]),
    queryId: result.queryId,
    sqlState: result.sqlState,
    vendorCode: result.vendorCode,
    outcome: 'succeeded',
    outputColumns: result.columns.map((column) => column.name),
    rowCount: result.rowCount,
    rowBound,
    resultFingerprint: semanticExecutionFingerprint({
      columns: result.columns.map((column) => column.name),
      rows: result.rows,
      rowCount: result.rowCount,
    }),
    timingsMs: {
      planning: compileStartedAt - startedAt,
      compilation: validationStartedAt - compileStartedAt,
      validation: executionStartedAt - validationStartedAt,
      execution: Date.now() - executionStartedAt,
    },
  };
  return {
    compiled,
    preparedSql: prepared.sql,
    executionTarget,
    targetBinding,
    result,
    executionReceipt: receipt,
    semanticTrace: traceAfterExecution(
      compiled.semanticTrace,
      targetBinding,
      receipt,
      result.queryId,
    ),
  };
}

async function preflightCompiledSql(
  executor: QueryExecutor,
  connection: ConnectionConfig,
  sql: string,
  adapterId: SemanticAdapterIdV1,
): Promise<void> {
  // Snowflake EXPLAIN resolves relations, columns, aliases and permissions
  // without accepting the result as an analytical execution.
  if (connection.driver !== 'snowflake') return;
  try {
    await executor.executePositional(
      `EXPLAIN USING TEXT ${sql}`,
      [],
      connection,
      { maxRows: 500, maxBytes: 1024 * 1024, batchSize: 100, deadlineMs: 60_000 },
    );
  } catch (error) {
    throw new SemanticPhysicalPreflightError(adapterId, error);
  }
}

function runtimeBindingsFromTrace(trace: SemanticRuntimeTrace): SemanticRuntimeMemberBindingV1[] {
  return trace.bindings.map((binding) => ({
    role: binding.role,
    qualifiedId: semanticExecutionFingerprint({
      authoringReference: binding.authoringReference,
      runtimeReference: binding.runtimeReference,
      entityPath: binding.entityPath,
    }),
    authoringReference: binding.authoringReference,
    runtimeReference: binding.runtimeReference,
    entityPath: [...binding.entityPath],
  }));
}

function traceAfterExecution(
  trace: SemanticRuntimeTrace,
  targetBinding: SemanticTargetBindingV1,
  executionReceipt: SemanticExecutionReceiptV1,
  queryId?: string,
): SemanticRuntimeTrace {
  return {
    ...trace,
    targetBinding,
    executionReceipt,
    steps: trace.steps.flatMap((step) => step.id === 'execute_query'
      ? [
          {
            id: 'validate_execution_target' as const,
            label: 'Validate semantic and warehouse targets',
            status: 'completed' as const,
            detail: `Bound ${targetBinding.adapterId} to target ${targetBinding.executionTarget.identityFingerprint.slice(0, 12)}.`,
          },
          {
            id: 'preflight_physical_sql' as const,
            label: 'Preflight compiled physical SQL',
            status: 'completed' as const,
            detail: targetBinding.executionTarget.driver === 'snowflake'
              ? 'Snowflake EXPLAIN resolved physical relations, columns, aliases, and access before execution.'
              : 'The connector does not expose a separate physical preflight; bounded execution retained the target contract.',
          },
          {
            ...step,
            status: 'completed' as const,
            detail: queryId
              ? `Executed on the bound warehouse target · query ${queryId}.`
              : 'Executed on the bound warehouse target.',
          },
        ]
      : [step]),
  };
}

export function semanticExecutionFailureCode(error: unknown): string | undefined {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

export function semanticExecutionFailureDetails(error: unknown): unknown {
  if (
    error
    && typeof error === 'object'
    && 'details' in error
    && (error as { details?: unknown }).details !== undefined
  ) {
    return (error as { details: unknown }).details;
  }
  if (error instanceof ConnectorQueryError) {
    return {
      driver: error.driver,
      queryId: error.queryId,
      sqlState: error.sqlState,
      vendorCode: error.vendorCode,
      line: error.line,
      position: error.position,
      retryable: error.retryable,
    };
  }
  return undefined;
}
