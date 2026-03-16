import * as duckdb from '@duckdb/duckdb-wasm';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

export async function initDuckDB(): Promise<void> {
  if (db) return;

  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })
  );

  const worker = new Worker(worker_url);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  URL.revokeObjectURL(worker_url);
}

export async function loadCSV(name: string, csvText: string): Promise<void> {
  if (!db || !conn) throw new Error('DuckDB not initialized');
  await db.registerFileText(`${name}.csv`, csvText);
  await conn.query(`DROP TABLE IF EXISTS "${name}"`);
  await conn.query(`CREATE TABLE "${name}" AS SELECT * FROM read_csv_auto('${name}.csv')`);
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
}

export async function runQuery(sql: string): Promise<QueryResult> {
  if (!conn) throw new Error('DuckDB not initialized');
  const result = await conn.query(sql);
  const schema = result.schema.fields;
  const columns = schema.map(f => ({ name: f.name, type: f.type.toString() }));
  const rows = result.toArray().map(row => {
    const obj: Record<string, unknown> = {};
    for (const f of schema) obj[f.name] = row[f.name];
    return obj;
  });
  return { columns, rows };
}
