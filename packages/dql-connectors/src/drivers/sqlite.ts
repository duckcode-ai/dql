import Database from 'better-sqlite3';
import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult, ColumnMeta, Row } from '../result-types.js';

export class SQLiteConnector implements DatabaseConnector {
  readonly driverName = 'sqlite';
  private db: Database.Database | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const filepath = config.filepath ?? config.database ?? ':memory:';
    this.db = new Database(filepath);
    this.db.pragma('journal_mode = WAL');
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.db) {
      throw new Error('SQLite connector not connected. Call connect() first.');
    }

    const startTime = performance.now();
    const stmt = this.db.prepare(sql);

    if (stmt.reader) {
      const rows = (params ? stmt.all(...params) : stmt.all()) as Row[];
      const executionTimeMs = performance.now() - startTime;

      const columns: ColumnMeta[] =
        rows.length > 0
          ? Object.keys(rows[0]).map((name) => ({
              name,
              type: inferType(rows[0][name]),
              driverType: 'unknown',
            }))
          : [];

      return {
        columns,
        rows,
        rowCount: rows.length,
        executionTimeMs,
      };
    }

    const result = params ? stmt.run(...params) : stmt.run();
    const executionTimeMs = performance.now() - startTime;

    return {
      columns: [],
      rows: [],
      rowCount: result.changes,
      executionTimeMs,
    };
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
}

function inferType(value: unknown): 'string' | 'number' | 'boolean' | 'null' | 'unknown' {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}
