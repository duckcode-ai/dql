import { describe, expect, it } from 'vitest';
import { ConnectionPoolManager, createConnectionConfigKey } from './connection-pool.js';

describe('createConnectionConfigKey', () => {
  it('returns the same key for logically identical configs', () => {
    const a = {
      driver: 'snowflake' as const,
      account: 'acct',
      username: 'user',
      password: 'pw',
      database: 'db',
      warehouse: 'wh',
    };
    const b = {
      warehouse: 'wh',
      database: 'db',
      password: 'pw',
      username: 'user',
      account: 'acct',
      driver: 'snowflake' as const,
    };
    expect(createConnectionConfigKey(a)).toBe(createConnectionConfigKey(b));
  });

  it('returns different keys when config changes', () => {
    const a = {
      driver: 'snowflake' as const,
      account: 'acct',
      username: 'user',
      password: 'pw',
      database: 'db1',
      warehouse: 'wh',
    };
    const b = {
      ...a,
      database: 'db2',
    };
    expect(createConnectionConfigKey(a)).not.toBe(createConnectionConfigKey(b));
  });

  it('includes enterprise credential fields in the key', () => {
    const databricks = {
      driver: 'databricks' as const,
      host: 'adb-123.cloud.databricks.com',
      warehouse: 'prod-warehouse',
      token: 'prod-token',
    };
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      token: 'staging-token',
    }));
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      warehouse: 'staging-warehouse',
    }));
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      httpPath: '/sql/1.0/warehouses/staging-warehouse',
    }));
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      waitTimeout: '5s',
    }));

    const snowflake = {
      driver: 'snowflake' as const,
      account: 'xy12345.us-east-1',
      username: 'svc_dql',
      database: 'PROD',
      schema: 'MARTS',
      warehouse: 'ANALYTICS_WH',
      authMethod: 'key_pair' as const,
      privateKeyPath: '/secure/prod/snowflake_key.p8',
      privateKeyPassphrase: 'prod-passphrase',
    };
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      privateKeyPath: '/secure/staging/snowflake_key.p8',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      privateKeyPath: undefined,
      privateKey: '-----BEGIN PRIVATE KEY-----\nstaging\n-----END PRIVATE KEY-----',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      privateKeyPassphrase: 'staging-passphrase',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      proxyHost: 'proxy.internal',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      queryTag: 'team=finance',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      authMethod: 'workload_identity' as const,
      workloadIdentityProvider: 'AWS',
    }));
  });
});

describe('ConnectionPoolManager singleflight', () => {
  it('shares one in-flight connector creation for concurrent callers', async () => {
    const pool = new ConnectionPoolManager();
    let connectCalls = 0;
    let releaseConnect: (() => void) | undefined;
    const connector = {
      driverName: 'snowflake' as const,
      connect: async () => {
        connectCalls += 1;
        await new Promise<void>((resolve) => {
          releaseConnect = resolve;
        });
      },
      execute: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }),
      disconnect: async () => undefined,
      ping: async () => true,
    };
    (pool as any).createConnector = () => connector;
    const config = { driver: 'snowflake' as const, account: 'acct', username: 'user' };

    const first = pool.getConnector(config);
    const second = pool.getConnector(config);
    await Promise.resolve();
    expect(connectCalls).toBe(1);
    releaseConnect?.();

    expect(await first).toBe(connector);
    expect(await second).toBe(connector);
  });
});
