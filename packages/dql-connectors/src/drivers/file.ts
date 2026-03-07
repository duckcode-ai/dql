import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult } from '../result-types.js';
import { DuckDBConnector } from './duckdb.js';

/**
 * FileConnector — uses DuckDB under the hood to query CSV, Parquet, JSON,
 * and Excel files directly with SQL.
 *
 * Usage in dql.config.ts:
 *   { driver: 'file', filepath: ':memory:' }
 *
 * Then in .dql files:
 *   SELECT * FROM read_csv('./data/sales.csv')
 *   SELECT * FROM read_parquet('./data/events.parquet')
 *   SELECT * FROM read_json('./data/config.json')
 */
export class FileConnector implements DatabaseConnector {
  readonly driverName = 'file';
  private duckdb: DuckDBConnector;

  constructor() {
    this.duckdb = new DuckDBConnector();
  }

  async connect(config: ConnectionConfig): Promise<void> {
    // Use in-memory DuckDB by default for file queries
    const duckdbConfig: ConnectionConfig = {
      driver: 'duckdb',
      filepath: config.filepath ?? ':memory:',
    };
    await this.duckdb.connect(duckdbConfig);
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.duckdb.execute(sql, params);
  }

  async disconnect(): Promise<void> {
    return this.duckdb.disconnect();
  }

  async ping(): Promise<boolean> {
    return this.duckdb.ping();
  }
}
