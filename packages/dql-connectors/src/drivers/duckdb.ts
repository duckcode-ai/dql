import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class DuckDBConnector implements DatabaseConnector {
  readonly driverName = 'duckdb';
  private db: any = null;
  private connection: any = null;

  async connect(config: ConnectionConfig): Promise<void> {
    // Dynamic import to avoid requiring duckdb when not used
    const duckdb = await import('duckdb');

    const dbPath = config.filepath ?? ':memory:';

    return new Promise((resolve, reject) => {
      this.db = new duckdb.Database(dbPath, (err: Error | null) => {
        if (err) {
          reject(new Error(`DuckDB connection failed: ${err.message}`));
          return;
        }
        this.connection = this.db.connect();
        resolve();
      });
    });
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('DuckDB connector not connected. Call connect() first.');
    }

    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      const callback = (err: Error | null, result: any) => {
        const executionTimeMs = performance.now() - startTime;

        if (err) {
          reject(new Error(`DuckDB query failed: ${err.message}`));
          return;
        }

        if (!result || !Array.isArray(result) || result.length === 0) {
          resolve({
            columns: [],
            rows: [],
            rowCount: 0,
            executionTimeMs,
          });
          return;
        }

        // Infer columns from first row
        const columns: ColumnMeta[] = Object.keys(result[0]).map((name) => ({
          name,
          type: inferDuckDBType(result[0][name]),
          driverType: 'duckdb',
        }));

        resolve({
          columns,
          rows: result as Row[],
          rowCount: result.length,
          executionTimeMs,
        });
      };

      if (params && params.length > 0) {
        this.connection.all(sql, ...params, callback);
      } else {
        this.connection.all(sql, callback);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      return new Promise((resolve) => {
        this.db.close((err: Error | null) => {
          if (err) {
            console.warn('DuckDB disconnect warning:', err.message);
          }
          this.db = null;
          this.connection = null;
          resolve();
        });
      });
    }
  }

  async ping(): Promise<boolean> {
    if (!this.connection) return false;
    try {
      await this.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

function inferDuckDBType(value: unknown): ColumnType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value instanceof Date) return 'datetime';
  return 'unknown';
}
