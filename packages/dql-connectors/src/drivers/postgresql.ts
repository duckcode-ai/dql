import pg from 'pg';
import type { DatabaseConnector, ConnectionConfig, DriverName, TableInfo, ColumnInfo } from '../connector.js';
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

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`;
    const params: unknown[] = [];
    if (schema) {
      params.push(schema);
      sql += ` AND table_schema = $${params.length}`;
    }
    if (table) {
      params.push(table);
      sql += ` AND table_name = $${params.length}`;
    }
    sql += ` ORDER BY table_schema, table_name, ordinal_position`;
    const result = await this.execute(sql, params);
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      table: String(row['table_name'] ?? ''),
      name: String(row['column_name'] ?? ''),
      dataType: String(row['data_type'] ?? ''),
      ordinalPosition: Number(row['ordinal_position'] ?? 0),
    }));
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
