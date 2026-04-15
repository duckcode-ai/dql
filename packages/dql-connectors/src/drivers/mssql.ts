import type { DatabaseConnector, ConnectionConfig, DriverName, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class MSSQLConnector implements DatabaseConnector {
  readonly driverName: DriverName = 'mssql';
  private pool: any = null;
  private sql: any = null;

  async connect(config: ConnectionConfig): Promise<void> {
    // Dynamic import to avoid requiring tedious/mssql when not used
    this.sql = await import('mssql');

    const mssqlConfig: Record<string, unknown> = {
      server: config.host ?? 'localhost',
      port: config.port ?? 1433,
      database: config.database,
      user: config.username,
      password: config.password,
      options: {
        encrypt: config.ssl !== false,
        trustServerCertificate: true,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    if (config.connectionString) {
      this.pool = await this.sql.connect(config.connectionString);
    } else {
      this.pool = await this.sql.connect(mssqlConfig);
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('MSSQL connector not connected. Call connect() first.');
    }

    const startTime = performance.now();
    const request = this.pool.request();

    // Bind positional parameters as @p1, @p2, etc.
    if (params && params.length > 0) {
      for (let i = 0; i < params.length; i++) {
        request.input(`p${i + 1}`, params[i]);
      }
      // Replace $N placeholders with @pN for MSSQL syntax
      sql = sql.replace(/\$(\d+)/g, (_match: string, num: string) => `@p${num}`);
    }

    const result = await request.query(sql);
    const executionTimeMs = performance.now() - startTime;

    const recordset = result.recordset;
    if (!recordset || recordset.length === 0) {
      return {
        columns: [],
        rows: [],
        rowCount: result.rowsAffected?.[0] ?? 0,
        executionTimeMs,
      };
    }

    // Extract column metadata from recordset.columns
    const columns: ColumnMeta[] = Object.keys(recordset.columns ?? {}).map((name) => {
      const col = recordset.columns[name];
      return {
        name,
        type: mapMSSQLType(col?.type?.declaration ?? ''),
        driverType: col?.type?.declaration ?? 'unknown',
      };
    });

    // If columns metadata is empty, infer from first row
    if (columns.length === 0 && recordset.length > 0) {
      for (const key of Object.keys(recordset[0])) {
        columns.push({
          name: key,
          type: inferMSSQLType(recordset[0][key]),
          driverType: 'inferred',
        });
      }
    }

    return {
      columns,
      rows: recordset as Row[],
      rowCount: recordset.length,
      executionTimeMs,
    };
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.request().query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'sys')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
       COLUMN_NAME AS column_name, DATA_TYPE AS data_type, ORDINAL_POSITION AS ordinal_position
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'sys')`;
    if (schema) {
      sql += ` AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`;
    }
    if (table) {
      sql += ` AND TABLE_NAME = '${table.replace(/'/g, "''")}'`;
    }
    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
    const result = await this.execute(sql);
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      table: String(row['table_name'] ?? ''),
      name: String(row['column_name'] ?? ''),
      dataType: String(row['data_type'] ?? ''),
      ordinalPosition: Number(row['ordinal_position'] ?? 0),
    }));
  }
}

function mapMSSQLType(declaration: string): ColumnType {
  const lower = (declaration ?? '').toLowerCase();
  if (['int', 'bigint', 'smallint', 'tinyint', 'float', 'real', 'decimal', 'numeric', 'money', 'smallmoney'].some((t) => lower.includes(t))) {
    return 'number';
  }
  if (lower.includes('date') && !lower.includes('datetime')) {
    return 'date';
  }
  if (['datetime', 'datetime2', 'datetimeoffset', 'smalldatetime', 'timestamp'].some((t) => lower.includes(t))) {
    return 'datetime';
  }
  if (lower.includes('bit')) {
    return 'boolean';
  }
  if (['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'xml'].some((t) => lower.includes(t))) {
    return 'string';
  }
  return 'unknown';
}

function inferMSSQLType(value: unknown): ColumnType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value instanceof Date) return 'datetime';
  return 'unknown';
}
