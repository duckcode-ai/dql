import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { importConnectorDependency } from '../optional-dependency.js';

/**
 * A dedicated connection from the already-open DuckDB database. Dataset
 * evidence uses this one transaction for its probe and the tile it proves, so
 * reconnect/pool behavior cannot silently mix database snapshots.
 */
export interface DuckDBConsistentReadScope {
  readonly id: string;
  readonly context: {
    schema?: string;
    timeZone?: string;
    fingerprint: string;
  };
  execute(sql: string, params?: unknown[], options?: QueryExecutionOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

export class DuckDBConnector implements DatabaseConnector {
  readonly driverName = 'duckdb';
  private db: any = null;
  private connection: any = null;
  private releaseDatabase: (() => Promise<void>) | null = null;
  private readonly openScopes = new Set<() => Promise<void>>();

  async connect(config: ConnectionConfig): Promise<void> {
    await this.disconnect();
    const duckdbModule = await importConnectorDependency('duckdb', config);
    const duckdb = resolveDuckDBModule(duckdbModule);

    const dbPath = config.filepath ?? ':memory:';
    const { db, release } = await acquireDuckDBDatabase(duckDBDatabaseKey(dbPath), async () => {
      const database = await new Promise<any>((resolve, reject) => {
        const opened = new duckdb.Database(dbPath, (err: Error | null) => {
          if (err) {
            reject(new Error(`DuckDB connection failed: ${err.message}`));
            return;
          }
          resolve(opened);
        });
      });
      const setup = database.connect();
      try {
        await executeDuckDBConnection(setup, database, 'PRAGMA disable_checkpoint_on_shutdown');
      } catch (error) {
        await closeDuckDBConnection(setup);
        await closeDuckDBDatabase(database, false);
        throw error;
      }
      await closeDuckDBConnection(setup);
      return database;
    });
    this.db = db;
    this.connection = db.connect();
    this.releaseDatabase = release;
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('DuckDB connector not connected. Call connect() first.');
    }
    return executeDuckDBConnection(this.connection, this.db, sql, params, options);
  }

  /**
   * Preserve the active schema and time zone on a separate connection, then
   * hold a transaction open across the App's related read operations. The
   * normal connector keeps its 1.16 cancellation semantics; the scope simply
   * invokes the same execution helper against its own connection.
   */
  async openConsistentReadScope(): Promise<DuckDBConsistentReadScope> {
    if (!this.db || !this.connection) {
      throw new Error('DuckDB connector not connected. Call connect() first.');
    }
    const db = this.db;
    const context = await readDuckDBSessionContext(this.connection, db);
    const connection = db.connect();
    let closed = false;
    let pending = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      const task = pending.then(work, work);
      pending = task.then(() => undefined, () => undefined);
      return task;
    };
    try {
      if (context.schema) await executeDuckDBConnection(connection, db, `SET schema = ${quoteDuckDBString(context.schema)}`);
      if (context.timeZone) await executeDuckDBConnection(connection, db, `SET TimeZone = ${quoteDuckDBString(context.timeZone)}`);
      await executeDuckDBConnection(connection, db, 'BEGIN TRANSACTION');
    } catch (error) {
      await closeDuckDBConnection(connection);
      throw error;
    }
    const close = async () => {
      if (closed) return;
      closed = true;
      this.openScopes.delete(close);
      await pending;
      try {
        await executeDuckDBConnection(connection, db, 'ROLLBACK');
      } finally {
        await closeDuckDBConnection(connection);
      }
    };
    this.openScopes.add(close);
    return {
      id: `duckdb_scope_${randomUUID()}`,
      context,
      execute: (sql, params, options) => enqueue(async () => {
        if (closed) throw new Error('DuckDB consistent read scope is closed.');
        return executeDuckDBConnection(connection, db, sql, params, options);
      }),
      close,
    };
  }

  /**
   * Close this connector's connections (including open read scopes, whose
   * transactions would otherwise block the final checkpoint), then release its
   * share of the file's Database. See `acquireDuckDBDatabase`.
   */
  async disconnect(): Promise<void> {
    const connection = this.connection;
    const release = this.releaseDatabase;
    const scopes = [...this.openScopes];
    this.db = null;
    this.connection = null;
    this.releaseDatabase = null;
    this.openScopes.clear();
    await Promise.allSettled(scopes.map((close) => close()));
    if (connection) await closeDuckDBConnection(connection);
    await release?.();
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

function executeDuckDBConnection(
  connection: any,
  database: any,
  sql: string,
  params?: unknown[],
  options: QueryExecutionOptions = {},
): Promise<QueryResult> {
  if (!connection) return Promise.reject(new Error('DuckDB connector not connected. Call connect() first.'));
  if (options.signal?.aborted) return Promise.reject(duckDbCancellationError(options.signal.reason));
  if (options.deadlineMs !== undefined && options.deadlineMs <= 0) return Promise.reject(duckDbDeadlineError(options.deadlineMs));

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
      const candidates = [connection, database, connection?.db];
      for (const candidate of candidates) {
        const stop = candidate?.interrupt ?? candidate?.cancel;
        if (typeof stop !== 'function') continue;
        try { stop.call(candidate); } catch { /* local cancellation still wins */ }
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
        settle(() => resolve({ columns: [], rows: [], rowCount: 0, executionTimeMs }));
        return;
      }
      const normalizedRows = result.map((row: Row) => normalizeDuckDBRow(row));
      const columns: ColumnMeta[] = Object.keys(normalizedRows[0]).map((name) => ({
        name,
        type: inferDuckDBType(normalizedRows[0][name]),
        driverType: 'duckdb',
      }));
      settle(() => resolve({ columns, rows: normalizedRows, rowCount: normalizedRows.length, executionTimeMs }));
    };
    try {
      if (params && params.length > 0) connection.all(sql, ...params, callback);
      else connection.all(sql, callback);
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

async function readDuckDBSessionContext(connection: any, database: any): Promise<DuckDBConsistentReadScope['context']> {
  const [schema, timeZone] = await Promise.all([
    executeDuckDBConnection(connection, database, 'SELECT current_schema() AS "__dql_schema"'),
    executeDuckDBConnection(connection, database, "SELECT current_setting('TimeZone') AS \"__dql_timezone\""),
  ]);
  const schemaValue = typeof schema.rows[0]?.__dql_schema === 'string' ? schema.rows[0].__dql_schema : undefined;
  const timeZoneValue = typeof timeZone.rows[0]?.__dql_timezone === 'string' ? timeZone.rows[0].__dql_timezone : undefined;
  return {
    ...(schemaValue ? { schema: schemaValue } : {}),
    ...(timeZoneValue ? { timeZone: timeZoneValue } : {}),
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify({ schema: schemaValue ?? null, timeZone: timeZoneValue ?? null })).digest('hex')}`,
  };
}

function quoteDuckDBString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * duckdb-node's `Database#close` only drops the Database handle. Every
 * Connection and every Statement (`Statement#finalize` is a no-op in 1.1)
 * still holds the native instance, which lives on until garbage collection.
 * When it is finally destroyed, DuckDB's shutdown checkpoint writes the
 * snapshot that instance last saw and then deletes the WAL, even if the
 * instance wrote nothing. Commits made meanwhile through a newer instance on
 * the same file (a reconnect, or another pool key naming that file) are
 * lost at a GC-dependent moment, and readers see an older state.
 *
 * So: every connector on one file in this process shares one Database, each
 * Database disables its shutdown checkpoint, and the last release checkpoints
 * explicitly while it is still the only instance. A late destructor then has
 * nothing to write and no WAL to delete.
 */
interface SharedDuckDBDatabase {
  readonly database: Promise<any>;
  refs: number;
}

const sharedDuckDBDatabases = new Map<string, SharedDuckDBDatabase>();
const closingDuckDBDatabases = new Map<string, Promise<void>>();

async function acquireDuckDBDatabase(
  key: string | null,
  open: () => Promise<any>,
): Promise<{ db: any; release: () => Promise<void> }> {
  if (key === null) {
    const db = await open();
    return { db, release: () => closeDuckDBDatabase(db, false) };
  }
  let entry = sharedDuckDBDatabases.get(key);
  if (!entry) {
    // Never open a file while its previous instance is still checkpointing.
    const previousClose = closingDuckDBDatabases.get(key) ?? Promise.resolve();
    const created: SharedDuckDBDatabase = { database: previousClose.then(open), refs: 0 };
    created.database.catch(() => {
      if (sharedDuckDBDatabases.get(key) === created) sharedDuckDBDatabases.delete(key);
    });
    sharedDuckDBDatabases.set(key, created);
    entry = created;
  }
  const acquired = entry;
  acquired.refs += 1;
  let db: any;
  try {
    db = await acquired.database;
  } catch (error) {
    acquired.refs -= 1;
    throw error;
  }
  let released = false;
  return {
    db,
    release: async () => {
      if (released) return;
      released = true;
      acquired.refs -= 1;
      if (acquired.refs > 0) return;
      if (sharedDuckDBDatabases.get(key) === acquired) sharedDuckDBDatabases.delete(key);
      const closing: Promise<void> = closeDuckDBDatabase(db, true).finally(() => {
        if (closingDuckDBDatabases.get(key) === closing) closingDuckDBDatabases.delete(key);
      });
      closingDuckDBDatabases.set(key, closing);
      await closing;
    },
  };
}

/** In-memory databases are private to their connector; files are shared by real path. */
function duckDBDatabaseKey(dbPath: string): string | null {
  if (!dbPath || dbPath.startsWith(':memory:')) return null;
  const absolute = resolvePath(dbPath);
  try {
    return realpathSync(absolute);
  } catch {
    // Not created yet: resolve the directory so the key matches the file's
    // real path once it exists (for example /var -> /private/var on macOS).
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

async function closeDuckDBDatabase(db: any, checkpoint: boolean): Promise<void> {
  if (checkpoint) {
    const connection = db.connect();
    try {
      await executeDuckDBConnection(connection, db, 'CHECKPOINT');
    } catch (error) {
      // The WAL stays in place and is replayed by the next open.
      console.warn('DuckDB checkpoint warning:', error instanceof Error ? error.message : String(error));
    } finally {
      await closeDuckDBConnection(connection);
    }
  }
  await new Promise<void>((resolve) => {
    db.close((err: Error | null) => {
      if (err) {
        console.warn('DuckDB disconnect warning:', err.message);
      }
      resolve();
    });
  });
}

async function closeDuckDBConnection(connection: any): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!connection || typeof connection.close !== 'function') {
      resolve();
      return;
    }
    connection.close(() => resolve());
  });
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
