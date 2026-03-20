import pg from 'pg';
import type { DatabaseConnector, ConnectionConfig, DriverName } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class PostgreSQLConnector implements DatabaseConnector {
  readonly driverName: DriverName = 'postgresql';
  private pool: pg.Pool | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const poolConfig: pg.PoolConfig = config.connectionString
      ? { connectionString: config.connectionString }
      : {
          host: config.host ?? 'localhost',
          port: config.port ?? 5432,
          database: config.database,
          user: config.username,
          password: config.password,
          ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        };

    poolConfig.max = 10;
    poolConfig.idleTimeoutMillis = 30000;

    this.pool = new pg.Pool(poolConfig);
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('PostgreSQL connector not connected. Call connect() first.');
    }

    const startTime = performance.now();
    const result = await this.pool.query(sql, params);
    const executionTimeMs = performance.now() - startTime;

    const columns: ColumnMeta[] = (result.fields ?? []).map((field) => ({
      name: field.name,
      type: mapPgType(field.dataTypeID),
      driverType: String(field.dataTypeID),
    }));

    const rows: Row[] = result.rows ?? [];

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs,
    };
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

function mapPgType(oid: number): ColumnType {
  // Common PostgreSQL OIDs
  switch (oid) {
    case 16:
      return 'boolean'; // bool
    case 20:
    case 21:
    case 23:
    case 700:
    case 701:
    case 1700:
      return 'number'; // int8, int2, int4, float4, float8, numeric
    case 1082:
      return 'date'; // date
    case 1114:
    case 1184:
      return 'datetime'; // timestamp, timestamptz
    case 25:
    case 1042:
    case 1043:
      return 'string'; // text, char, varchar
    default:
      return 'unknown';
  }
}
