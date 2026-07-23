import { describe, expect, it } from 'vitest';
import {
  compareWarehouseTargets,
  createSemanticTargetBinding,
  createWarehouseTargetIdentity,
} from './semantic-execution.js';

describe('target-bound semantic execution contracts', () => {
  it('normalizes warehouse identity and excludes the opaque connection ref from identity', () => {
    const first = createWarehouseTargetIdentity({
      connectionRef: 'connection-a',
      driver: 'Snowflake',
      redactedContext: {
        account: ' xy123 ',
        database: 'analytics',
        schema: 'common',
        role: 'analyst',
        warehouse: 'compute_wh',
      },
      observedAt: '2026-07-23T00:00:00.000Z',
    });
    const second = createWarehouseTargetIdentity({
      connectionRef: 'connection-b',
      driver: 'snowflake',
      redactedContext: {
        warehouse: 'COMPUTE_WH',
        role: 'ANALYST',
        schema: 'COMMON',
        database: 'ANALYTICS',
        account: 'XY123',
      },
      observedAt: '2026-07-24T00:00:00.000Z',
    });

    expect(first.identityFingerprint).toBe(second.identityFingerprint);
    expect(first.redactedContext.database).toBe('ANALYTICS');
  });

  it('reports target drift field by field', () => {
    const expected = createWarehouseTargetIdentity({
      connectionRef: 'prod',
      driver: 'snowflake',
      redactedContext: { database: 'PROD', schema: 'COMMON', role: 'ANALYST' },
    });
    const actual = createWarehouseTargetIdentity({
      connectionRef: 'dev',
      driver: 'snowflake',
      redactedContext: { database: 'DEV', schema: 'COMMON', role: 'DEVELOPER' },
    });

    expect(compareWarehouseTargets(expected, actual)).toEqual([
      { field: 'database', expected: 'PROD', actual: 'DEV' },
      { field: 'role', expected: 'ANALYST', actual: 'DEVELOPER' },
    ]);
  });

  it('treats Snowflake locator and organization-account name as one account', () => {
    const configured = createWarehouseTargetIdentity({
      connectionRef: 'dbt-profile',
      driver: 'snowflake',
      redactedContext: {
        account: 'acme-prod',
        database: 'ANALYTICS',
        schema: 'COMMON',
      },
    });
    const observed = createWarehouseTargetIdentity({
      connectionRef: 'dql-connection',
      driver: 'snowflake',
      redactedContext: {
        account: 'ACME-PROD',
        accountLocator: 'XY12345',
        accountName: 'PROD',
        organization: 'ACME',
        database: 'ANALYTICS',
        schema: 'COMMON',
      },
    });

    expect(compareWarehouseTargets(configured, observed)).toEqual([]);
    expect(compareWarehouseTargets(createWarehouseTargetIdentity({
      connectionRef: 'legacy-profile',
      driver: 'snowflake',
      redactedContext: {
        account: 'XY12345.us-east-2.aws',
        database: 'ANALYTICS',
        schema: 'COMMON',
      },
    }), observed)).toEqual([]);
  });

  it('still rejects genuinely different Snowflake accounts', () => {
    const expected = createWarehouseTargetIdentity({
      connectionRef: 'prod',
      driver: 'snowflake',
      redactedContext: {
        account: 'ACME-PROD',
        accountLocator: 'XY12345',
        accountName: 'PROD',
        organization: 'ACME',
      },
    });
    const actual = createWarehouseTargetIdentity({
      connectionRef: 'dev',
      driver: 'snowflake',
      redactedContext: {
        account: 'ACME-DEV',
        accountLocator: 'AB98765',
        accountName: 'DEV',
        organization: 'ACME',
      },
    });

    expect(compareWarehouseTargets(expected, actual)).toEqual([
      { field: 'account', expected: 'ACME-PROD', actual: 'ACME-DEV' },
    ]);
  });

  it('fingerprints proof checks deterministically', () => {
    const target = createWarehouseTargetIdentity({
      connectionRef: 'prod',
      driver: 'snowflake',
      redactedContext: { database: 'PROD' },
    });
    const base = {
      bindingId: 'binding-1',
      adapterId: 'dbt-cloud' as const,
      adapterImplementationFingerprint: 'adapter-v1',
      credentialRevision: 'revision-1',
      semanticSnapshot: {
        version: 1 as const,
        snapshotId: 'snapshot-1',
        sourceFingerprint: 'source-1',
        semanticCatalogFingerprint: 'catalog-1',
      },
      compileTarget: {
        kind: 'dbt_cloud_environment' as const,
        hostFingerprint: 'host-1',
        environmentId: '1234',
        semanticCatalogFingerprint: 'catalog-1',
        dialect: 'snowflake',
      },
      executionTarget: target,
      proof: {
        status: 'verified' as const,
        checks: [
          { kind: 'warehouse_context' as const, fingerprint: 'warehouse' },
          { kind: 'semantic_source' as const, fingerprint: 'source' },
        ],
      },
    };
    const reversed = {
      ...base,
      proof: { ...base.proof, checks: [...base.proof.checks].reverse() },
    };

    expect(createSemanticTargetBinding(base).bindingFingerprint)
      .toBe(createSemanticTargetBinding(reversed).bindingFingerprint);
  });
});
