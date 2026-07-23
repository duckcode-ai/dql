import {
  createWarehouseTargetIdentity,
  semanticExecutionFingerprint,
  type WarehouseTargetContextV1,
  type WarehouseTargetIdentityV1,
} from '@duckcodeailabs/dql-core';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';

/**
 * Acquire the redacted warehouse identity on the same connector lease used by
 * semantic validation/execution. Snowflake CURRENT_* values are authoritative;
 * configured values remain the bounded fallback for other adapters.
 */
export async function observeWarehouseTargetIdentity(
  executor: QueryExecutor,
  connection: ConnectionConfig,
): Promise<WarehouseTargetIdentityV1> {
  const configured = configuredWarehouseContext(connection);
  let observed = configured;
  if (connection.driver === 'snowflake') {
    try {
      const result = await executor.executePositional(
        `SELECT
           CURRENT_ACCOUNT() AS DQL_ACCOUNT,
           CURRENT_DATABASE() AS DQL_DATABASE,
           CURRENT_SCHEMA() AS DQL_SCHEMA,
           CURRENT_ROLE() AS DQL_ROLE,
           CURRENT_WAREHOUSE() AS DQL_WAREHOUSE`,
        [],
        connection,
        { maxRows: 1, maxBytes: 64 * 1024, deadlineMs: 30_000 },
      );
      const row = result.rows[0];
      if (row) {
        observed = {
          account: rowString(row, 'DQL_ACCOUNT') ?? configured.account,
          database: rowString(row, 'DQL_DATABASE') ?? configured.database,
          schema: rowString(row, 'DQL_SCHEMA') ?? configured.schema,
          role: rowString(row, 'DQL_ROLE') ?? configured.role,
          warehouse: rowString(row, 'DQL_WAREHOUSE') ?? configured.warehouse,
        };
      }
    } catch {
      // The later target/preflight step preserves a real connector failure.
      // Identity acquisition remains useful for dialects without CURRENT_*.
    }
  }
  return createWarehouseTargetIdentity({
    connectionRef: connectionReference(connection),
    driver: connection.driver,
    dialect: connection.driver,
    redactedContext: observed,
  });
}

export function configuredWarehouseTargetIdentity(
  connection: ConnectionConfig,
): WarehouseTargetIdentityV1 {
  return createWarehouseTargetIdentity({
    connectionRef: connectionReference(connection),
    driver: connection.driver,
    dialect: connection.driver,
    redactedContext: configuredWarehouseContext(connection),
  });
}

export function connectionReference(connection: ConnectionConfig): string {
  return `connection:${semanticExecutionFingerprint({
    driver: connection.driver,
    host: connection.host,
    account: connection.account,
    database: connection.database,
    catalog: connection.catalog,
    schema: connection.schema,
    role: connection.role,
    warehouse: connection.warehouse,
    filepath: connection.filepath,
    projectId: connection.projectId,
    httpPath: connection.httpPath,
  }).slice(0, 24)}`;
}

function configuredWarehouseContext(connection: ConnectionConfig): WarehouseTargetContextV1 {
  return {
    account: connection.account ?? connection.host,
    database: connection.database,
    catalog: connection.catalog,
    schema: connection.schema,
    role: connection.role,
    warehouse: connection.warehouse,
  };
}

function rowString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key] ?? row[key.toLowerCase()];
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}
