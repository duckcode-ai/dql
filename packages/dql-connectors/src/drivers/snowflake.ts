import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createPrivateKey } from 'node:crypto';
import { importConnectorDependency } from '../optional-dependency.js';

export class SnowflakeConnector implements DatabaseConnector {
  readonly driverName = 'snowflake';
  private connection: any = null;
  private sdk: any = null;

  async connect(config: ConnectionConfig): Promise<void> {
    // snowflake-sdk is a CJS module, so the API lives on .default
    const mod = await importConnectorDependency('snowflake-sdk', config);
    this.sdk = (mod as any).default ?? mod;

    const connectionConfig: Record<string, unknown> = {
      account: config.account ?? '',
      username: config.username ?? '',
      database: config.database,
      warehouse: config.warehouse,
    };

    // Schema, role, and enterprise driver options.
    if (config.schema) connectionConfig.schema = config.schema;
    if (config.role) connectionConfig.role = config.role;
    applySnowflakeConnectionOptions(connectionConfig, config);

    const privateKeySource = config.privateKeyPath
      ? await readFile(resolvePrivateKeyPath(config.privateKeyPath), 'utf-8')
      : config.privateKey;
    const privateKey = privateKeySource
      ? normalizeSnowflakePrivateKeyForAuth(privateKeySource, config.privateKeyPassphrase)
      : undefined;

    // Auth: key-pair, OAuth, PAT, workload identity, SSO/MFA, or password.
    if (privateKey || config.authMethod === 'key_pair') {
      if (!privateKey) {
        throw new Error('Snowflake key-pair authentication requires privateKey or privateKeyPath.');
      }
      connectionConfig.authenticator = 'SNOWFLAKE_JWT';
      connectionConfig.privateKey = privateKey;
      if (config.privateKeyPassphrase) {
        connectionConfig.privateKeyPass = config.privateKeyPassphrase;
      }
    } else if (config.authMethod === 'oauth') {
      connectionConfig.authenticator = config.authenticator ?? 'OAUTH';
      connectionConfig.token = config.token ?? config.password ?? '';
    } else if (config.authMethod === 'oauth_authorization_code') {
      connectionConfig.authenticator = config.authenticator ?? 'OAUTH_AUTHORIZATION_CODE';
    } else if (config.authMethod === 'oauth_client_credentials') {
      connectionConfig.authenticator = config.authenticator ?? 'OAUTH_CLIENT_CREDENTIALS';
    } else if (config.authMethod === 'programmatic_access_token') {
      connectionConfig.authenticator = config.authenticator ?? 'PROGRAMMATIC_ACCESS_TOKEN';
      connectionConfig.token = config.token ?? config.password ?? '';
    } else if (config.authMethod === 'workload_identity') {
      connectionConfig.authenticator = config.authenticator ?? 'WORKLOAD_IDENTITY';
      if (config.token) {
        connectionConfig.token = config.token;
      }
    } else if (config.authMethod === 'mfa') {
      connectionConfig.authenticator = config.authenticator ?? 'USERNAME_PASSWORD_MFA';
      connectionConfig.password = config.password ?? '';
    } else if (config.authMethod === 'external_browser') {
      connectionConfig.authenticator = config.authenticator ?? 'EXTERNALBROWSER';
    } else {
      connectionConfig.password = config.password ?? '';
      connectionConfig.authenticator = config.authenticator ?? 'SNOWFLAKE';
    }

    if (config.host) {
      connectionConfig.host = config.host;
    }

    await new Promise<void>((resolve, reject) => {
      this.connection = this.sdk.createConnection(connectionConfig);
      this.connection.connect((err: Error | undefined) => {
        if (err) {
          reject(new Error(`Snowflake connection failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });

  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('Snowflake connector not connected. Call connect() first.');
    }

    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      this.connection.execute({
        sqlText: sql,
        binds: params ?? [],
        complete: (err: Error | undefined, stmt: any, rows: any[]) => {
          const executionTimeMs = performance.now() - startTime;

          if (err) {
            reject(new Error(`Snowflake query failed: ${err.message}`));
            return;
          }

          if (!rows || rows.length === 0) {
            resolve({
              columns: [],
              rows: [],
              rowCount: 0,
              executionTimeMs,
            });
            return;
          }

          const columns: ColumnMeta[] = stmt.getColumns().map((col: any) => ({
            name: col.getName(),
            type: mapSnowflakeType(col.getType()),
            driverType: col.getType(),
          }));

          resolve({
            columns,
            rows: rows as Row[],
            rowCount: rows.length,
            executionTimeMs,
          });
        },
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      return new Promise((resolve) => {
        this.connection.destroy((err: Error | undefined) => {
          if (err) {
            console.warn('Snowflake disconnect warning:', err.message);
          }
          this.connection = null;
          resolve();
        });
      });
    }
  }

  async ping(): Promise<boolean> {
    if (!this.connection) return false;
    try {
      await this.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('INFORMATION_SCHEMA')
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['TABLE_SCHEMA'] ?? row['table_schema'] ?? ''),
      name: String(row['TABLE_NAME'] ?? row['table_name'] ?? ''),
      type: String(row['TABLE_TYPE'] ?? row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('INFORMATION_SCHEMA')`;
    if (schema) {
      sql += ` AND table_schema = '${schema.replace(/'/g, "''")}'`;
    }
    if (table) {
      sql += ` AND table_name = '${table.replace(/'/g, "''")}'`;
    }
    sql += ` ORDER BY table_schema, table_name, ordinal_position`;
    const result = await this.execute(sql);
    return result.rows.map((row) => ({
      schema: String(row['TABLE_SCHEMA'] ?? row['table_schema'] ?? ''),
      table: String(row['TABLE_NAME'] ?? row['table_name'] ?? ''),
      name: String(row['COLUMN_NAME'] ?? row['column_name'] ?? ''),
      dataType: String(row['DATA_TYPE'] ?? row['data_type'] ?? ''),
      ordinalPosition: Number(row['ORDINAL_POSITION'] ?? row['ordinal_position'] ?? 0),
    }));
  }
}

function applySnowflakeConnectionOptions(
  connectionConfig: Record<string, unknown>,
  config: ConnectionConfig,
): void {
  const optionKeys: Array<keyof ConnectionConfig> = [
    'accessUrl',
    'application',
    'browserActionTimeout',
    'clientRequestMFAToken',
    'clientStoreTemporaryCredential',
    'clientSessionKeepAlive',
    'clientSessionKeepAliveHeartbeatFrequency',
    'credentialCacheDir',
    'keepAlive',
    'noProxy',
    'oauthAuthorizationUrl',
    'oauthClientId',
    'oauthClientSecret',
    'oauthRedirectUri',
    'oauthScope',
    'oauthTokenRequestUrl',
    'passcode',
    'passcodeInPassword',
    'proxyHost',
    'proxyPassword',
    'proxyPort',
    'proxyProtocol',
    'proxyUser',
    'queryTag',
    'timeout',
    'workloadIdentityProvider',
    'workloadIdentityAzureClientId',
    'workloadIdentityImpersonationPath',
  ];

  for (const key of optionKeys) {
    const value = config[key];
    if (value !== undefined && value !== null && value !== '') {
      connectionConfig[key] = value;
    }
  }
}

function resolvePrivateKeyPath(path: string): string {
  const expandedEnv = path.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    return process.env[key] ?? match;
  });

  if (expandedEnv === '~') return homedir();
  if (expandedEnv.startsWith('~/')) return `${homedir()}${expandedEnv.slice(1)}`;
  return expandedEnv;
}

export function normalizeSnowflakePrivateKeyForAuth(
  privateKey: string,
  passphrase?: string,
): string {
  const cleaned = privateKey
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\n/g, '\n');

  try {
    const keyObject = createPrivateKey({
      key: cleaned,
      format: 'pem',
      passphrase: passphrase || undefined,
    });
    return keyObject.export({
      format: 'pem',
      type: 'pkcs8',
    }).toString();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Snowflake private key could not be parsed or decrypted. Check that the pasted key includes the full PEM header/footer, uses the matching passphrase if encrypted, and belongs to the Snowflake user. Original error: ${detail}`,
    );
  }
}

function mapSnowflakeType(sfType: string): ColumnType {
  const lower = (sfType ?? '').toLowerCase();
  // Snowflake SDK internal types: fixed, real, text, boolean, date, timestamp_ltz/ntz/tz, variant, binary
  if (['fixed', 'real', 'number', 'decimal', 'numeric', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'float', 'float4', 'float8', 'double', 'double precision'].includes(lower)) {
    return 'number';
  }
  if (lower === 'date') {
    return 'date';
  }
  if (['datetime', 'timestamp', 'timestamp_ltz', 'timestamp_ntz', 'timestamp_tz'].includes(lower)) {
    return 'datetime';
  }
  if (lower === 'boolean') {
    return 'boolean';
  }
  if (['text', 'varchar', 'char', 'character', 'string'].includes(lower)) {
    return 'string';
  }
  if (['variant', 'object', 'array'].includes(lower)) {
    return 'string';
  }
  return 'unknown';
}
