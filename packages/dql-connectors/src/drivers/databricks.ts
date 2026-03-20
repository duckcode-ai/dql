import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

interface DatabricksStatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  manifest?: { schema?: { columns?: Array<{ name: string; type_text: string }> } };
  result?: { data_array?: unknown[][] };
}

export class DatabricksConnector implements DatabaseConnector {
  readonly driverName = 'databricks';
  private baseUrl: string | null = null;
  private token: string | null = null;
  private warehouseId: string | null = null;
  private catalog?: string;
  private schema?: string;

  async connect(config: ConnectionConfig): Promise<void> {
    if (!config.host) {
      throw new Error('Databricks connection requires a host.');
    }
    if (!(config.token ?? config.password)) {
      throw new Error('Databricks connection requires a token.');
    }
    if (!(config.warehouse ?? config.httpPath)) {
      throw new Error('Databricks connection requires a warehouse identifier in the warehouse field.');
    }

    this.baseUrl = config.host.startsWith('http') ? config.host : `https://${config.host}`;
    this.token = config.token ?? config.password ?? null;
    this.warehouseId = config.warehouse ?? config.httpPath ?? null;
    this.catalog = config.catalog ?? config.database;
    this.schema = config.schema;
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.baseUrl || !this.token || !this.warehouseId) {
      throw new Error('Databricks connector not connected. Call connect() first.');
    }
    if (params && params.length > 0) {
      throw new Error('Databricks connector does not yet support positional parameters.');
    }

    const startTime = performance.now();
    const response = await fetch(`${this.baseUrl}/api/2.0/sql/statements`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        statement: sql,
        warehouse_id: this.warehouseId,
        catalog: this.catalog,
        schema: this.schema,
        disposition: 'INLINE',
      }),
    });

    if (!response.ok) {
      throw new Error(`Databricks query failed: ${await response.text()}`);
    }

    let payload = await response.json() as DatabricksStatementResponse;
    while (payload.status?.state === 'PENDING' || payload.status?.state === 'RUNNING') {
      await delay(500);
      const poll = await fetch(`${this.baseUrl}/api/2.0/sql/statements/${payload.statement_id}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!poll.ok) {
        throw new Error(`Databricks polling failed: ${await poll.text()}`);
      }
      payload = await poll.json() as DatabricksStatementResponse;
    }

    if (payload.status?.error?.message) {
      throw new Error(`Databricks query failed: ${payload.status.error.message}`);
    }

    const columns: ColumnMeta[] = (payload.manifest?.schema?.columns ?? []).map((column) => ({
      name: column.name,
      type: mapWarehouseType(column.type_text),
      driverType: column.type_text,
    }));
    const rows = (payload.result?.data_array ?? []).map((row) => Object.fromEntries(columns.map((column, index) => [column.name, row[index]])) as Row);

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: performance.now() - startTime,
    };
  }

  async disconnect(): Promise<void> {
    this.baseUrl = null;
    this.token = null;
    this.warehouseId = null;
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

function mapWarehouseType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase();
  if (lower.includes('int') || lower.includes('decimal') || lower.includes('double') || lower.includes('float')) return 'number';
  if (lower === 'date') return 'date';
  if (lower.includes('timestamp')) return 'datetime';
  if (lower === 'boolean') return 'boolean';
  if (lower.includes('string') || lower.includes('char')) return 'string';
  return 'unknown';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
