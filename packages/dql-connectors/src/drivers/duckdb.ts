import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { importConnectorDependency } from '../optional-dependency.js';

export class DuckDBConnector implements DatabaseConnector {
  readonly driverName = 'duckdb';
  private db: any = null;
  private connection: any = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const duckdbModule = await importConnectorDependency('duckdb', config);
    const duckdb = resolveDuckDBModule(duckdbModule);

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

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('DuckDB connector not connected. Call connect() first.');
    }

    if (options.signal?.aborted) throw duckDbCancellationError(options.signal.reason);
    if (options.deadlineMs !== undefined && options.deadlineMs <= 0) throw duckDbDeadlineError(options.deadlineMs);

    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      const cleanup = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        finish();
      };
      const interrupt = () => {
        // node-duckdb exposes interrupt on different objects depending on the
        // version/build. Try the active connection first, then its database.
        // Cancellation must never close a pooled connector merely to stop one
        // query; late callbacks are ignored below.
        const candidates = [this.connection, this.db, this.connection?.db];
        for (const candidate of candidates) {
          const stop = candidate?.interrupt ?? candidate?.cancel;
          if (typeof stop !== 'function') continue;
          try { stop.call(candidate); } catch { /* cancellation remains local */ }
          return;
        }
      };
      const cancel = (error: Error) => {
        interrupt();
        settle(() => reject(error));
      };
      const onAbort = () => cancel(duckDbCancellationError(signal?.reason));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs)) {
        deadlineTimer = setTimeout(() => cancel(duckDbDeadlineError(options.deadlineMs!)), Math.max(0, options.deadlineMs));
      }
      const callback = (err: Error | null, result: any) => {
        // The native binding may call back after interrupt(); never turn that
        // late result into an answer after Ask already recorded cancellation.
        if (settled) return;
        if (signal?.aborted) {
          cancel(duckDbCancellationError(signal.reason));
          return;
        }
        const executionTimeMs = performance.now() - startTime;

        if (err) {
          settle(() => reject(new Error(`DuckDB query failed: ${withMissingTableHint(err.message)}`)));
          return;
        }

        if (!result || !Array.isArray(result) || result.length === 0) {
          settle(() => resolve({
            columns: [],
            rows: [],
            rowCount: 0,
            executionTimeMs,
          }));
          return;
        }

        const normalizedRows = result.map((row: Row) => normalizeDuckDBRow(row));

        // Infer columns from first normalized row so JSON-facing types match runtime values.
        const columns: ColumnMeta[] = Object.keys(normalizedRows[0]).map((name) => ({
          name,
          type: inferDuckDBType(normalizedRows[0][name]),
          driverType: 'duckdb',
        }));

        settle(() => resolve({
          columns,
          rows: normalizedRows,
          rowCount: normalizedRows.length,
          executionTimeMs,
        }));
      };

      try {
        if (params && params.length > 0) {
          this.connection.all(sql, ...params, callback);
        } else {
          this.connection.all(sql, callback);
        }
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
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

function duckDbCancellationError(reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : undefined;
  return new Error(`DuckDB query was cancelled${detail ? `: ${detail}` : ''}.`);
}

function duckDbDeadlineError(deadlineMs: number): Error {
  return new Error(`DuckDB query exceeded the ${Math.max(0, deadlineMs)}ms deadline.`);
}

export function resolveDuckDBModule(module: unknown): { Database: new (path: string, callback: (err: Error | null) => void) => any } {
  const candidate = (
    module &&
    typeof module === 'object' &&
    'Database' in module &&
    typeof (module as { Database?: unknown }).Database === 'function'
  )
    ? module
    : (
      module &&
      typeof module === 'object' &&
      'default' in module &&
      (module as { default?: unknown }).default &&
      typeof (module as { default: { Database?: unknown } }).default.Database === 'function'
    )
      ? (module as { default: { Database: new (path: string, callback: (err: Error | null) => void) => any } }).default
      : null;

  if (!candidate) {
    throw new Error('DuckDB module did not expose a Database constructor.');
  }

  return candidate as { Database: new (path: string, callback: (err: Error | null) => void) => any };
}

/**
 * When a query fails because a table/catalog is missing, the most common cause is
 * an empty database or a connection pointed at the wrong `.duckdb` file. Append a
 * one-line hint so the user isn't left guessing.
 */
function withMissingTableHint(message: string): string {
  if (/does not exist|Catalog Error|Table with name|Referenced table/i.test(message)) {
    return `${message}\nHint: that table isn't in this database — it may be empty or the connection may point at the wrong .duckdb file. Build your dbt models (e.g. \`dbt build\`) to populate it, then retry.`;
  }
  return message;
}

export function normalizeDuckDBRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeDuckDBValue(value)]),
  ) as Row;
}

export function normalizeDuckDBValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDuckDBValue(item));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeDuckDBValue(nested)]),
    );
  }
  return value;
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
