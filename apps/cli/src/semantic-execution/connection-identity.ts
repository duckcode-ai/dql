import {
  createWarehouseTargetIdentity,
  semanticExecutionFingerprint,
  type WarehouseTargetContextV1,
  type WarehouseTargetIdentityV1,
} from '@duckcodeailabs/dql-core';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';

export class WarehouseTargetIdentityObservationError extends Error {
  readonly code = 'WAREHOUSE_TARGET_IDENTITY_UNAVAILABLE';
  readonly details: { driver: string };

  constructor(driver: string, cause?: unknown) {
    super(
      `Could not observe the active ${driver} warehouse identity. `
      + 'DQL did not save or validate a semantic target binding; test the SQL connection and retry.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'WarehouseTargetIdentityObservationError';
    this.details = { driver };
  }
}

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
           CURRENT_ACCOUNT() AS DQL_ACCOUNT_LOCATOR,
           CURRENT_ACCOUNT_NAME() AS DQL_ACCOUNT_NAME,
           CURRENT_ORGANIZATION_NAME() AS DQL_ORGANIZATION,
           CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME() AS DQL_ACCOUNT,
           CURRENT_DATABASE() AS DQL_DATABASE,
           CURRENT_SCHEMA() AS DQL_SCHEMA,
           CURRENT_ROLE() AS DQL_ROLE,
           CURRENT_WAREHOUSE() AS DQL_WAREHOUSE`,
        [],
        connection,
        { maxRows: 1, maxBytes: 64 * 1024, deadlineMs: 30_000 },
      );
      const row = result.rows[0];
      const accountLocator = row ? rowString(row, 'DQL_ACCOUNT_LOCATOR') : undefined;
      const accountName = row ? rowString(row, 'DQL_ACCOUNT_NAME') : undefined;
      const organization = row ? rowString(row, 'DQL_ORGANIZATION') : undefined;
      if (!row || (!accountLocator && !accountName)) {
        throw new Error('Snowflake returned no observable account identity.');
      }
      observed = {
        account: rowString(row, 'DQL_ACCOUNT')
          ?? (organization && accountName ? `${organization}-${accountName}` : accountName ?? accountLocator),
        accountLocator,
        accountName,
        organization,
        database: rowString(row, 'DQL_DATABASE') ?? configured.database,
        schema: rowString(row, 'DQL_SCHEMA') ?? configured.schema,
        role: rowString(row, 'DQL_ROLE') ?? configured.role,
        warehouse: rowString(row, 'DQL_WAREHOUSE') ?? configured.warehouse,
      };
    } catch (error) {
      throw new WarehouseTargetIdentityObservationError(connection.driver, error);
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
    account: connection.driver === 'snowflake'
      ? normalizeConfiguredSnowflakeAccount(connection.account ?? connection.host)
      : connection.account ?? connection.host,
    database: connection.database,
    catalog: connection.catalog,
    schema: connection.schema,
    role: connection.role,
    warehouse: connection.warehouse,
  };
}

function normalizeConfiguredSnowflakeAccount(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  const withoutPath = withoutProtocol.split('/')[0]?.split(':')[0];
  return withoutPath?.replace(/\.snowflakecomputing\.com$/i, '') || undefined;
}

function rowString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key] ?? row[key.toLowerCase()];
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}
