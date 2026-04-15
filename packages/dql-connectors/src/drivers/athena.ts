import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

export class AthenaConnector implements DatabaseConnector {
  readonly driverName = 'athena';
  private client: any = null;
  private athenaModule: any = null;
  private database?: string;
  private outputLocation?: string;
  private workgroup?: string;

  async connect(config: ConnectionConfig): Promise<void> {
    const moduleName = '@aws-sdk/client-athena';
    this.athenaModule = await import(moduleName as string);
    this.client = new this.athenaModule.AthenaClient({ region: config.region ?? config.host ?? 'us-east-1' });
    this.database = config.database;
    this.outputLocation = config.outputLocation ?? config.schema;
    this.workgroup = config.workgroup ?? config.warehouse;
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.client || !this.athenaModule) {
      throw new Error('Athena connector not connected. Call connect() first.');
    }
    if (params && params.length > 0) {
      throw new Error('Athena connector does not yet support positional parameters.');
    }
    if (!this.outputLocation) {
      throw new Error('Athena connector requires outputLocation or schema to point to an S3 query-results path.');
    }

    const startTime = performance.now();
    const started = await this.client.send(new this.athenaModule.StartQueryExecutionCommand({
      QueryString: sql,
      QueryExecutionContext: this.database ? { Database: this.database } : undefined,
      ResultConfiguration: { OutputLocation: this.outputLocation },
      WorkGroup: this.workgroup,
    }));
    const queryExecutionId = started.QueryExecutionId;
    if (!queryExecutionId) {
      throw new Error('Athena did not return a query execution id.');
    }

    while (true) {
      const statusResult = await this.client.send(new this.athenaModule.GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
      const state = statusResult.QueryExecution?.Status?.State;
      if (state === 'SUCCEEDED') {
        break;
      }
      if (state === 'FAILED' || state === 'CANCELLED') {
        throw new Error(statusResult.QueryExecution?.Status?.StateChangeReason ?? `Athena query ${state?.toLowerCase()}.`);
      }
      await delay(500);
    }

    const rows: Row[] = [];
    let columns: ColumnMeta[] = [];
    let nextToken: string | undefined;

    do {
      const resultPage = await this.client.send(new this.athenaModule.GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
      }));

      const columnInfo = resultPage.ResultSet?.ResultSetMetadata?.ColumnInfo ?? [];
      if (columns.length === 0) {
        columns = columnInfo.map((column: any) => ({
          name: column.Name,
          type: mapAthenaType(column.Type),
          driverType: column.Type,
        }));
      }

      const pageRows = resultPage.ResultSet?.Rows ?? [];
      for (let index = 0; index < pageRows.length; index++) {
        const data = pageRows[index].Data ?? [];
        const record = Object.fromEntries(columns.map((column, columnIndex) => [column.name, data[columnIndex]?.VarCharValue ?? null])) as Row;

        const isHeaderRow = index === 0 && rows.length === 0 && columns.every((column) => String(record[column.name] ?? '') === column.name);
        if (!isHeaderRow) {
          rows.push(record);
        }
      }

      nextToken = resultPage.NextToken;
    } while (nextToken);

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: performance.now() - startTime,
    };
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.athenaModule = null;
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
    const db = this.database ?? 'default';
    const result = await this.execute(`SHOW TABLES IN \`${db}\``);
    return result.rows.map((row) => {
      const name = String(Object.values(row)[0] ?? '');
      return { schema: db, name, type: 'BASE TABLE' };
    });
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    const db = schema ?? this.database ?? 'default';
    const tables = table
      ? [{ schema: db, name: table, type: 'BASE TABLE' }]
      : await this.listTables();
    const columns: ColumnInfo[] = [];
    for (const t of tables) {
      try {
        const result = await this.execute(`DESCRIBE \`${db}\`.\`${t.name}\``);
        let pos = 1;
        for (const row of result.rows) {
          const colName = String(row['col_name'] ?? Object.values(row)[0] ?? '');
          const dataType = String(row['data_type'] ?? Object.values(row)[1] ?? '');
          if (colName && !colName.startsWith('#')) {
            columns.push({ schema: db, table: t.name, name: colName, dataType, ordinalPosition: pos++ });
          }
        }
      } catch {
        // table may not be describable — skip
      }
    }
    return columns;
  }
}

function mapAthenaType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase();
  if (lower.includes('int') || lower.includes('double') || lower.includes('real') || lower.includes('decimal')) return 'number';
  if (lower === 'date') return 'date';
  if (lower.includes('timestamp')) return 'datetime';
  if (lower === 'boolean') return 'boolean';
  if (lower.includes('char') || lower.includes('string') || lower.includes('varchar')) return 'string';
  return 'unknown';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
