import { describe, expect, it } from 'vitest';
import {
  configuredWarehouseTargetIdentity,
  connectionReference,
  observeWarehouseTargetIdentity,
} from './connection-identity.js';

describe('semantic execution connection identity', () => {
  it('does not change when credentials change', () => {
    const base = {
      driver: 'snowflake' as const,
      account: 'xy123',
      database: 'ANALYTICS',
      schema: 'COMMON',
      role: 'ANALYST',
      warehouse: 'COMPUTE_WH',
      username: 'service',
      password: 'first-secret',
    };
    expect(connectionReference(base)).toBe(connectionReference({
      ...base,
      password: 'second-secret',
      privateKey: 'private-secret',
    }));
  });

  it('uses observed Snowflake CURRENT_* context', async () => {
    const executor = {
      executePositional: async () => ({
        columns: [],
        rows: [{
          DQL_ACCOUNT: 'XY123',
          DQL_DATABASE: 'PROD',
          DQL_SCHEMA: 'COMMON',
          DQL_ROLE: 'ANALYST',
          DQL_WAREHOUSE: 'REPORTING_WH',
        }],
        rowCount: 1,
        executionTimeMs: 1,
      }),
    };
    const identity = await observeWarehouseTargetIdentity(executor as any, {
      driver: 'snowflake',
      account: 'xy123',
      database: 'DEV',
      schema: 'COMMON',
    });
    expect(identity.redactedContext).toMatchObject({
      account: 'XY123',
      database: 'PROD',
      warehouse: 'REPORTING_WH',
    });
  });

  it('creates a deterministic configured target for offline validation', () => {
    const identity = configuredWarehouseTargetIdentity({
      driver: 'databricks',
      host: 'adb.example.com',
      catalog: 'main',
      schema: 'analytics',
      warehouse: 'warehouse-id',
    });
    expect(identity.redactedContext).toMatchObject({
      account: 'ADB.EXAMPLE.COM',
      catalog: 'MAIN',
      schema: 'ANALYTICS',
    });
  });
});
