import type { QueryResult } from './result-types.js';

export interface ConnectionConfig {
  driver:
    | 'postgresql'
    | 'mysql'
    | 'sqlite'
    | 'bigquery'
    | 'snowflake'
    | 'duckdb'
    | 'mssql'
    | 'file'
    | 'redshift'
    | 'fabric'
    | 'clickhouse'
    | 'databricks'
    | 'athena'
    | 'trino';
  host?: string;
  port?: number;
  database?: string;
  catalog?: string;
  username?: string;
  password?: string;
  token?: string;
  ssl?: boolean;
  filepath?: string;
  projectId?: string;
  account?: string;
  warehouse?: string;
  workgroup?: string;
  schema?: string;
  role?: string;
  region?: string;
  outputLocation?: string;
  httpPath?: string;
  privateKey?: string;
  connectionString?: string;
}

export type DriverName = ConnectionConfig['driver'];

export interface TableInfo {
  schema: string;
  name: string;
  type: string; // 'BASE TABLE' | 'VIEW' | etc.
}

export interface DatabaseConnector {
  readonly driverName: DriverName;
  connect(config: ConnectionConfig): Promise<void>;
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  listTables?(): Promise<TableInfo[]>;
}
