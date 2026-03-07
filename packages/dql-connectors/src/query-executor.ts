import type { DatabaseConnector, ConnectionConfig } from './connector.js';
import type { QueryResult } from './result-types.js';
import { ConnectionPoolManager } from './connection-pool.js';
import { buildParamValues, normalizeSQLPlaceholders, type SQLParamSpec } from './sql-params.js';

export class QueryExecutor {
  private pool: ConnectionPoolManager;

  constructor(pool?: ConnectionPoolManager) {
    this.pool = pool ?? new ConnectionPoolManager();
  }

  async getConnector(config: ConnectionConfig): Promise<DatabaseConnector> {
    return this.pool.getConnector(config);
  }

  async executeQuery(
    sql: string,
    params: SQLParamSpec[],
    variables: Record<string, unknown>,
    config: ConnectionConfig,
  ): Promise<QueryResult> {
    const paramValues = buildParamValues(params ?? [], variables ?? {});
    return this.executePositional(sql, paramValues, config);
  }

  async executePositional(
    sql: string,
    paramValues: unknown[],
    config: ConnectionConfig,
  ): Promise<QueryResult> {
    const connector = await this.pool.getConnector(config);
    const normalizedSQL = normalizeSQLPlaceholders(sql, config.driver);
    return connector.execute(
      normalizedSQL,
      paramValues && paramValues.length > 0 ? paramValues : undefined,
    );
  }

  async disconnect(): Promise<void> {
    await this.pool.disconnectAll();
  }
}
