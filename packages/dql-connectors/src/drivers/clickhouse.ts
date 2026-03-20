import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class ClickHouseConnector implements DatabaseConnector {
  readonly driverName = 'clickhouse';
  private endpoint: string | null = null;
  private headers: Record<string, string> = {};

  async connect(config: ConnectionConfig): Promise<void> {
    const protocol = config.ssl === false ? 'http' : 'https';
    const host = config.host ?? 'localhost';
    const port = config.port ?? (config.ssl === false ? 8123 : 8443);
    this.endpoint = `${protocol}://${host}:${port}`;
    this.headers = {
      'Content-Type': 'text/plain; charset=utf-8',
    };

    if (config.username || config.password) {
      const token = Buffer.from(`${config.username ?? 'default'}:${config.password ?? ''}`).toString('base64');
      this.headers.Authorization = `Basic ${token}`;
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.endpoint) {
      throw new Error('ClickHouse connector not connected. Call connect() first.');
    }
    if (params && params.length > 0) {
      throw new Error('ClickHouse connector does not yet support positional parameters.');
    }

    const startTime = performance.now();
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: `${sql.trim().replace(/;$/, '')} FORMAT JSON`,
    });

    if (!response.ok) {
      throw new Error(`ClickHouse query failed: ${await response.text()}`);
    }

    const payload = await response.json() as { meta?: Array<{ name: string; type: string }>; data?: Row[]; rows?: number };
    const executionTimeMs = performance.now() - startTime;
    const rows = payload.data ?? [];
    const columns: ColumnMeta[] = (payload.meta ?? []).map((column) => ({
      name: column.name,
      type: mapColumnType(column.type),
      driverType: column.type,
    }));

    return {
      columns,
      rows,
      rowCount: payload.rows ?? rows.length,
      executionTimeMs,
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
}

function mapColumnType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase();
  if (lower.includes('int') || lower.includes('float') || lower.includes('decimal')) return 'number';
  if (lower.includes('date') && !lower.includes('datetime')) return 'date';
  if (lower.includes('datetime') || lower.includes('timestamp')) return 'datetime';
  if (lower.includes('bool')) return 'boolean';
  if (lower.includes('string') || lower.includes('uuid')) return 'string';
  return 'unknown';
}
