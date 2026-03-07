import type { DatabaseConnector, ConnectionConfig } from './connector.js';
import { PostgreSQLConnector } from './drivers/postgresql.js';
import { SQLiteConnector } from './drivers/sqlite.js';
import { MySQLConnector } from './drivers/mysql.js';
import { SnowflakeConnector } from './drivers/snowflake.js';
import { BigQueryConnector } from './drivers/bigquery.js';
import { DuckDBConnector } from './drivers/duckdb.js';
import { MSSQLConnector } from './drivers/mssql.js';
import { FileConnector } from './drivers/file.js';
import { createHash } from 'node:crypto';

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableSerialize(v)).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    entries.push(`${JSON.stringify(k)}:${stableSerialize(v)}`);
  }
  return `{${entries.join(',')}}`;
}

export function createConnectionConfigKey(config: ConnectionConfig): string {
  const normalized: Record<string, unknown> = {
    driver: config.driver,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    ssl: config.ssl,
    filepath: config.filepath,
    projectId: config.projectId,
    account: config.account,
    warehouse: config.warehouse,
    connectionString: config.connectionString,
  };
  const payload = stableSerialize(normalized);
  return createHash('sha1').update(payload).digest('hex');
}

export class ConnectionPoolManager {
  private connectors: Map<string, DatabaseConnector> = new Map();

  async getConnector(config: ConnectionConfig): Promise<DatabaseConnector> {
    const key = this.configKey(config);
    let connector = this.connectors.get(key);

    if (!connector) {
      connector = this.createConnector(config);
      await connector.connect(config);
      this.connectors.set(key, connector);
    }

    return connector;
  }

  async removeConnector(config: ConnectionConfig): Promise<void> {
    const key = this.configKey(config);
    const connector = this.connectors.get(key);
    if (connector) {
      await connector.disconnect();
      this.connectors.delete(key);
    }
  }

  async disconnectAll(): Promise<void> {
    const promises = [...this.connectors.values()].map((c) => c.disconnect());
    await Promise.all(promises);
    this.connectors.clear();
  }

  private createConnector(config: ConnectionConfig): DatabaseConnector {
    switch (config.driver) {
      case 'postgresql':
        return new PostgreSQLConnector();
      case 'sqlite':
        return new SQLiteConnector();
      case 'mysql':
        return new MySQLConnector();
      case 'snowflake':
        return new SnowflakeConnector();
      case 'bigquery':
        return new BigQueryConnector();
      case 'duckdb':
        return new DuckDBConnector();
      case 'mssql':
        return new MSSQLConnector();
      case 'file':
        return new FileConnector();
      default:
        throw new Error(`Unsupported database driver: ${config.driver}`);
    }
  }

  private configKey(config: ConnectionConfig): string {
    return `${config.driver}:${createConnectionConfigKey(config)}`;
  }
}
