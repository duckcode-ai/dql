import type { DatabaseConnector, ConnectionConfig } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class BigQueryConnector implements DatabaseConnector {
  readonly driverName = 'bigquery';
  private client: any = null;

  async connect(config: ConnectionConfig): Promise<void> {
    // Dynamic import to avoid requiring @google-cloud/bigquery when not used
    const { BigQuery } = await import('@google-cloud/bigquery');

    const options: Record<string, unknown> = {};

    if (config.projectId) {
      options.projectId = config.projectId;
    }

    // BigQuery uses Application Default Credentials (ADC) or service account key
    // The key file path can be set via GOOGLE_APPLICATION_CREDENTIALS env var
    this.client = new BigQuery(options);
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.client) {
      throw new Error('BigQuery connector not connected. Call connect() first.');
    }

    const startTime = performance.now();

    let queryText = sql;
    const queryOptions: Record<string, unknown> = {
      query: queryText,
      location: 'US',
    };

    if (params && params.length > 0) {
      // Prefer named parameters for compatibility. Convert positional "?" into "@pN"
      // and pass { pN: value }.
      const named: Record<string, unknown> = {};
      let idx = 0;
      queryText = replacePositionalQuestionMarks(queryText, () => {
        idx++;
        return `@p${idx}`;
      });
      for (let i = 0; i < params.length; i++) {
        named[`p${i + 1}`] = params[i];
      }
      queryOptions.query = queryText;
      queryOptions.params = named;
    }

    const [rows] = await this.client.query(queryOptions);
    const executionTimeMs = performance.now() - startTime;

    if (!rows || rows.length === 0) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs,
      };
    }

    // Infer columns from first row
    const columns: ColumnMeta[] = Object.keys(rows[0]).map((name) => ({
      name,
      type: inferBigQueryType(rows[0][name]),
      driverType: 'bigquery',
    }));

    // BigQuery returns BigQueryDate, BigQueryTimestamp etc. — normalize to plain values
    const normalizedRows: Row[] = rows.map((row: Record<string, unknown>) => {
      const normalized: Row = {};
      for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizeBigQueryValue(value);
      }
      return normalized;
    });

    return {
      columns,
      rows: normalizedRows,
      rowCount: normalizedRows.length,
      executionTimeMs,
    };
  }

  async disconnect(): Promise<void> {
    // BigQuery client doesn't maintain persistent connections
    this.client = null;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.query({ query: 'SELECT 1' });
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeBigQueryValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  // BigQuery wraps dates/timestamps in special objects with a .value property
  if (typeof value === 'object' && value !== null && 'value' in (value as any)) {
    return (value as any).value;
  }

  return value;
}

function inferBigQueryType(value: unknown): ColumnType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';

  // BigQuery date/timestamp objects
  if (typeof value === 'object' && value !== null) {
    const constructor = (value as any).constructor?.name ?? '';
    if (constructor.includes('Date') || constructor.includes('date')) return 'date';
    if (constructor.includes('Timestamp') || constructor.includes('timestamp')) return 'datetime';
  }

  return 'unknown';
}

function replacePositionalQuestionMarks(sql: string, replacer: () => string): string {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" && !inDouble && !inBacktick) {
      out += ch;
      if (inSingle && sql[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      i += 1;
      continue;
    }

    if (ch === '"' && !inSingle && !inBacktick) {
      out += ch;
      if (inDouble && sql[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      inDouble = !inDouble;
      i += 1;
      continue;
    }

    if (ch === '`' && !inSingle && !inDouble) {
      out += ch;
      if (inBacktick && sql[i + 1] === '`') {
        out += '`';
        i += 2;
        continue;
      }
      inBacktick = !inBacktick;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && ch === '?') {
      out += replacer();
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}
