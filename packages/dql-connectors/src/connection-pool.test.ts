import { describe, expect, it } from 'vitest';
import { createConnectionConfigKey } from './connection-pool.js';

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
    const base = {
      driver: 'bigquery' as const,
      projectId: 'analytics-prod',
      authMethod: 'service_account_key_file' as const,
      keyFilename: '/secure/prod.json',
    };
    expect(createConnectionConfigKey(base)).not.toBe(createConnectionConfigKey({
      ...base,
      keyFilename: '/secure/staging.json',
    }));

    const athena = {
      driver: 'athena' as const,
      region: 'us-east-1',
      database: 'analytics',
      outputLocation: 's3://query-results/',
      profile: 'prod',
    };
    expect(createConnectionConfigKey(athena)).not.toBe(createConnectionConfigKey({
      ...athena,
      profile: 'staging',
    }));
  });
});
