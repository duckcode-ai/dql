import Database from 'better-sqlite3';
import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
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

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    return result.rows.map((row) => ({
      schema: 'main',
      name: String(row['name'] ?? ''),
      type: String(row['type'] ?? '') === 'table' ? 'BASE TABLE' : 'VIEW',
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    const tables = await this.listTables();
    const filtered = table ? tables.filter((t) => t.name === table) : tables;
    const columns: ColumnInfo[] = [];
    for (const t of filtered) {
      const result = await this.execute(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`);
      for (const row of result.rows) {
        columns.push({
          schema: 'main',
          table: t.name,
          name: String(row['name'] ?? ''),
          dataType: String(row['type'] ?? 'TEXT'),
          ordinalPosition: Number(row['cid'] ?? 0) + 1,
        });
      }
    }
    return columns;
  }
}

function inferType(value: unknown): 'string' | 'number' | 'boolean' | 'null' | 'unknown' {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}
