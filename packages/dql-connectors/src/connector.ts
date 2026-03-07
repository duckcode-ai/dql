import type { QueryResult } from './result-types.js';

export interface ConnectionConfig {
  driver: 'postgresql' | 'mysql' | 'sqlite' | 'bigquery' | 'snowflake' | 'duckdb' | 'mssql' | 'file';
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  filepath?: string;
  projectId?: string;
  account?: string;
  warehouse?: string;
  schema?: string;
  role?: string;
  privateKey?: string;
  connectionString?: string;
}

export interface DatabaseConnector {
  readonly driverName: string;
  connect(config: ConnectionConfig): Promise<void>;
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
}
