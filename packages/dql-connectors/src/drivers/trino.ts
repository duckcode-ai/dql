import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

interface TrinoPayload {
  data?: unknown[][];
  columns?: Array<{ name: string; type: string }>;
  nextUri?: string;
  error?: { message?: string };
}

export class TrinoConnector implements DatabaseConnector {
  readonly driverName = 'trino';
  private endpoint: string | null = null;
  private headers: Record<string, string> = {};

  async connect(config: ConnectionConfig): Promise<void> {
    const protocol = config.ssl === false ? 'http' : 'https';
    const host = config.host ?? 'localhost';
    const port = config.port ?? 8080;
    this.endpoint = `${protocol}://${host}:${port}`;
    this.headers = {
      'X-Trino-User': config.username ?? 'dql',
      'X-Trino-Catalog': config.catalog ?? config.database ?? 'system',
      'X-Trino-Schema': config.schema ?? 'default',
      'Content-Type': 'text/plain; charset=utf-8',
    };

    if (config.username && config.password) {
      const token = Buffer.from(`${config.username}:${config.password}`).toString('base64');
      this.headers.Authorization = `Basic ${token}`;
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.endpoint) {
      throw new Error('Trino connector not connected. Call connect() first.');
    }
    if (params && params.length > 0) {
      throw new Error('Trino connector does not yet support positional parameters.');
    }

    const startTime = performance.now();
    const initialResponse = await fetch(`${this.endpoint}/v1/statement`, {
      method: 'POST',
      headers: this.headers,
      body: sql,
    });

    if (!initialResponse.ok) {
      throw new Error(`Trino query failed: ${await initialResponse.text()}`);
    }

    const rows: Row[] = [];
    let columns: ColumnMeta[] = [];
    let payload = await initialResponse.json() as TrinoPayload;

    while (true) {
      if (payload.error?.message) {
        throw new Error(`Trino query failed: ${payload.error.message}`);
      }

      if (payload.columns && columns.length === 0) {
        columns = payload.columns.map((column) => ({
          name: column.name,
          type: mapTrinoType(column.type),
          driverType: column.type,
        }));
      }

      if (payload.data && columns.length > 0) {
        for (const row of payload.data) {
          rows.push(Object.fromEntries(columns.map((column, index) => [column.name, row[index]])) as Row);
        }
      }

      if (!payload.nextUri) {
        break;
      }

      const nextResponse = await fetch(payload.nextUri, { headers: this.headers });
      if (!nextResponse.ok) {
        throw new Error(`Trino pagination failed: ${await nextResponse.text()}`);
      }
      payload = await nextResponse.json() as TrinoPayload;
    }

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: performance.now() - startTime,
    };
  }

  async disconnect(): Promise<void> {
    this.endpoint = null;
    this.headers = {};
  }

  async ping(): Promise<boolean> {
    try {
      await this.execute('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const catalog = this.headers['X-Trino-Catalog'] ?? 'system';
    const result = await this.execute(
      `SELECT table_schema, table_name, table_type
       FROM ${catalog}.information_schema.tables
       WHERE table_schema NOT IN ('information_schema')
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    const catalog = this.headers['X-Trino-Catalog'] ?? 'system';
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position
       FROM ${catalog}.information_schema.columns
       WHERE table_schema NOT IN ('information_schema')`;
    if (schema) {
      sql += ` AND table_schema = '${schema.replace(/'/g, "''")}'`;
    }
    if (table) {
      sql += ` AND table_name = '${table.replace(/'/g, "''")}'`;
    }
    sql += ` ORDER BY table_schema, table_name, ordinal_position`;
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

function mapTrinoType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase();
  if (lower.includes('int') || lower.includes('double') || lower.includes('real') || lower.includes('decimal')) return 'number';
  if (lower === 'date') return 'date';
  if (lower.includes('timestamp')) return 'datetime';
  if (lower === 'boolean') return 'boolean';
  if (lower.includes('char') || lower.includes('varchar')) return 'string';
  return 'unknown';
}
