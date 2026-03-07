import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class SnowflakeConnector implements DatabaseConnector {
  readonly driverName = 'snowflake';
  private connection: any = null;
  private sdk: any = null;
  private warehouse: string = '';

  async connect(config: ConnectionConfig): Promise<void> {
    // Dynamic import to avoid requiring snowflake-sdk when not used
    // snowflake-sdk is a CJS module, so the API lives on .default
    const mod = await import('snowflake-sdk');
    this.sdk = (mod as any).default ?? mod;

    this.warehouse = config.warehouse ?? '';

    const connectionConfig: Record<string, unknown> = {
      account: config.account ?? '',
      username: config.username ?? '',
      database: config.database,
      warehouse: config.warehouse,
    };

    // Schema and role
    if (config.schema) connectionConfig.schema = config.schema;
    if (config.role) connectionConfig.role = config.role;

    // Auth: private key (key-pair) or password
    if (config.privateKey) {
      connectionConfig.authenticator = 'SNOWFLAKE_JWT';
      connectionConfig.privateKey = config.privateKey;
    } else {
      connectionConfig.password = config.password ?? '';
      connectionConfig.authenticator = 'SNOWFLAKE';
    }

    if (config.host) {
      connectionConfig.host = config.host;
    }

    await new Promise<void>((resolve, reject) => {
      this.connection = this.sdk.createConnection(connectionConfig);
      this.connection.connect((err: Error | undefined) => {
        if (err) {
          reject(new Error(`Snowflake connection failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });

    // Auto-resume warehouse if suspended (matching DuckCode-Modeling pattern)
    if (this.warehouse) {
      try {
        await this.executeRaw(`ALTER WAREHOUSE IF EXISTS ${this.warehouse} RESUME IF SUSPENDED`);
      } catch (_) { /* ignore — permission denied or warehouse doesn't exist */ }
    }
  }

  private executeRaw(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.execute({
        sqlText: sql,
        complete: (err: Error | undefined) => {
          if (err) reject(err); else resolve();
        },
      });
    });
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('Snowflake connector not connected. Call connect() first.');
    }

    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      this.connection.execute({
        sqlText: sql,
        binds: params ?? [],
        complete: (err: Error | undefined, stmt: any, rows: any[]) => {
          const executionTimeMs = performance.now() - startTime;

          if (err) {
            reject(new Error(`Snowflake query failed: ${err.message}`));
            return;
          }

          if (!rows || rows.length === 0) {
            resolve({
              columns: [],
              rows: [],
              rowCount: 0,
              executionTimeMs,
            });
            return;
          }

          const columns: ColumnMeta[] = stmt.getColumns().map((col: any) => ({
            name: col.getName(),
            type: mapSnowflakeType(col.getType()),
            driverType: col.getType(),
          }));

          resolve({
            columns,
            rows: rows as Row[],
            rowCount: rows.length,
            executionTimeMs,
          });
        },
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      return new Promise((resolve) => {
        this.connection.destroy((err: Error | undefined) => {
          if (err) {
            console.warn('Snowflake disconnect warning:', err.message);
          }
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

function mapSnowflakeType(sfType: string): ColumnType {
  const lower = (sfType ?? '').toLowerCase();
  // Snowflake SDK internal types: fixed, real, text, boolean, date, timestamp_ltz/ntz/tz, variant, binary
  if (['fixed', 'real', 'number', 'decimal', 'numeric', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'float', 'float4', 'float8', 'double', 'double precision'].includes(lower)) {
    return 'number';
  }
  if (lower === 'date') {
    return 'date';
  }
  if (['datetime', 'timestamp', 'timestamp_ltz', 'timestamp_ntz', 'timestamp_tz'].includes(lower)) {
    return 'datetime';
  }
  if (lower === 'boolean') {
    return 'boolean';
  }
  if (['text', 'varchar', 'char', 'character', 'string'].includes(lower)) {
    return 'string';
  }
  if (['variant', 'object', 'array'].includes(lower)) {
    return 'string';
  }
  return 'unknown';
}
