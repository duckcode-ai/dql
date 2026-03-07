export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'null' | 'unknown';

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  driverType: string;
}

export type Row = Record<string, unknown>;

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Row[];
  rowCount: number;
  executionTimeMs: number;
}
