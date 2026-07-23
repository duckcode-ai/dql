export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'null' | 'unknown';

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  driverType: string;
}

export type Row = Record<string, unknown>;

export interface QueryExecutionOptions {
  signal?: AbortSignal;
  /** Maximum rows returned to the caller. Connectors must enforce this. */
  maxRows?: number;
  /** Maximum serialized bytes returned to the caller. Connectors must enforce this. */
  maxBytes?: number;
  /** Maximum rows held in one streaming batch. */
  batchSize?: number;
  /** Relative deadline for connector execution and result consumption. */
  deadlineMs?: number;
}

export interface QueryBatch {
  columns: ColumnMeta[];
  rows: Row[];
  rowCount: number;
  byteCount: number;
  queryId?: string;
  truncated?: boolean;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Row[];
  rowCount: number;
  executionTimeMs: number;
  queryId?: string;
  sqlState?: string;
  vendorCode?: string;
  truncated?: boolean;
  bytesRead?: number;
}

/**
 * Redacted structured connector error. Vendor fields required for diagnosis
 * survive transport without exposing SQL text, binds, or credentials.
 */
export class ConnectorQueryError extends Error {
  readonly driver: string;
  readonly code = 'CONNECTOR_QUERY_FAILED';
  readonly vendorCode?: string;
  readonly sqlState?: string;
  readonly queryId?: string;
  readonly line?: number;
  readonly position?: number;
  readonly retryable?: boolean;

  constructor(input: {
    driver: string;
    message: string;
    vendorCode?: string;
    sqlState?: string;
    queryId?: string;
    line?: number;
    position?: number;
    retryable?: boolean;
    cause?: Error;
  }) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.name = 'ConnectorQueryError';
    this.driver = input.driver;
    this.vendorCode = input.vendorCode;
    this.sqlState = input.sqlState;
    this.queryId = input.queryId;
    this.line = input.line;
    this.position = input.position;
    this.retryable = input.retryable;
  }
}
