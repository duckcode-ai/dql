import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class MySQLConnector implements DatabaseConnector {
  readonly driverName = 'mysql';
  private pool: any = null;

  async connect(config: ConnectionConfig): Promise<void> {
    // Dynamic import to avoid requiring mysql2 when not used
    const mysql = await import('mysql2/promise');

    const poolConfig: Record<string, unknown> = {
      host: config.host ?? 'localhost',
      port: config.port ?? 3306,
      database: config.database,
      user: config.username,
      password: config.password,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    };

    if (config.connectionString) {
      poolConfig.uri = config.connectionString;
    }

    if (config.ssl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    this.pool = mysql.createPool(poolConfig);
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('MySQL connector not connected. Call connect() first.');
    }

    const startTime = performance.now();
    const [rows, fields] = await this.pool.execute(sql, params);
    const executionTimeMs = performance.now() - startTime;

    if (!Array.isArray(rows)) {
      // Non-SELECT statement (INSERT, UPDATE, DELETE)
      return {
        columns: [],
        rows: [],
        rowCount: (rows as any).affectedRows ?? 0,
        executionTimeMs,
      };
    }

    const columns: ColumnMeta[] = (fields ?? []).map((field: any) => ({
      name: field.name,
      type: mapMySQLType(field.columnType),
      driverType: String(field.columnType),
    }));

    return {
      columns,
      rows: rows as Row[],
      rowCount: (rows as Row[]).length,
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
      await this.pool.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

// MySQL column type constants
// See: https://dev.mysql.com/doc/dev/mysql-server/latest/field__types_8h.html
function mapMySQLType(typeId: number): ColumnType {
  switch (typeId) {
    case 0: // DECIMAL
    case 1: // TINY
    case 2: // SHORT
    case 3: // LONG
    case 4: // FLOAT
    case 5: // DOUBLE
    case 8: // LONGLONG
    case 9: // INT24
    case 246: // NEWDECIMAL
      return 'number';
    case 10: // DATE
    case 14: // NEWDATE
      return 'date';
    case 7: // TIMESTAMP
    case 12: // DATETIME
      return 'datetime';
    case 16: // BIT
      return 'boolean';
    case 15: // VARCHAR
    case 253: // VAR_STRING
    case 254: // STRING
    case 252: // BLOB (text types)
      return 'string';
    default:
      return 'unknown';
  }
}
