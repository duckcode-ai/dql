import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestRuntimeSchemaSnapshotForProject } from '@duckcodeailabs/dql-agent';
import type { ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import {
  buildWarehouseMetadataQueries,
  normalizeConnectionMetadataScope,
  syncWarehouseMetadata,
} from './warehouse-metadata.js';

const snowflakeConnection: ConnectionConfig = {
  driver: 'snowflake',
  account: 'acme-prod',
  database: 'ANALYTICS_PROD',
  schema: 'SALES',
  role: 'ANALYST',
  warehouse: 'REPORTING_WH',
  username: 'service_user',
  password: 'secret-one',
};

describe('warehouse metadata scope', () => {
  it('defaults to exact dbt relations instead of scanning every schema', () => {
    const scope = normalizeConnectionMetadataScope(
      'primary',
      snowflakeConnection,
      { mode: 'dbt_relations' },
      {
        relations: [
          'ANALYTICS_PROD.SALES.ORDERS',
          'REFERENCE_DATA.SHARED.CALENDAR',
        ],
        dbtFingerprint: 'manifest-a',
      },
    );

    expect(scope.scopes).toEqual([
      { catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] },
      { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
    ]);
    const queries = buildWarehouseMetadataQueries(snowflakeConnection, scope);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain('"ANALYTICS_PROD".INFORMATION_SCHEMA.COLUMNS');
    expect(queries[0]?.sql).toContain("UPPER(table_name) IN (UPPER('ORDERS'))");
    expect(queries[0]?.sql).not.toContain('FROM INFORMATION_SCHEMA.COLUMNS');
  });

  it('combines exact dbt relations with explicitly selected schemas', () => {
    const scope = normalizeConnectionMetadataScope(
      'primary',
      snowflakeConnection,
      {
        mode: 'dbt_plus_selected',
        scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['FINANCE'] }],
      },
      { relations: ['ANALYTICS_PROD.SALES.ORDERS'] },
    );

    const query = buildWarehouseMetadataQueries(snowflakeConnection, scope)[0]?.sql ?? '';
    expect(query).toContain("UPPER(table_name) IN (UPPER('ORDERS'))");
    expect(query).toContain("UPPER(table_schema) IN (UPPER('FINANCE'))");
    expect(query).not.toContain("UPPER(table_schema) IN (UPPER('FINANCE'), UPPER('SALES'))");
    expect(query).toContain(' OR ');
  });

  it('never adds unselected databases to a selected-scope query plan', () => {
    const scope = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
      mode: 'selected_scopes',
      scopes: [
        { catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES', 'FINANCE'] },
        { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
      ],
    });
    const queries = buildWarehouseMetadataQueries(snowflakeConnection, scope);

    expect(queries.map((query) => query.catalogOrDatabase)).toEqual([
      'ANALYTICS_PROD',
      'REFERENCE_DATA',
    ]);
    expect(queries.every((query) => query.sql.includes('LIMIT 50000'))).toBe(true);
  });

  it('does not fingerprint credentials but does fingerprint scope and role changes', () => {
    const base = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
      mode: 'selected_scopes',
      scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
    });
    const credentialChange = normalizeConnectionMetadataScope('primary', {
      ...snowflakeConnection,
      password: 'secret-two',
      privateKey: 'private-material',
      token: 'oauth-token',
    }, {
      mode: 'selected_scopes',
      scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
    });
    const roleChange = normalizeConnectionMetadataScope('primary', {
      ...snowflakeConnection,
      role: 'FINANCE_ANALYST',
    }, {
      mode: 'selected_scopes',
      scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
    });

    expect(credentialChange.scopeFingerprint).toBe(base.scopeFingerprint);
    expect(roleChange.scopeFingerprint).not.toBe(base.scopeFingerprint);
  });

  it('replaces persisted dbt-derived relations when the current manifest changes', () => {
    const scope = normalizeConnectionMetadataScope(
      'primary',
      snowflakeConnection,
      {
        mode: 'dbt_relations',
        relations: ['ANALYTICS_PROD.SALES.REMOVED_MODEL'],
        dbtFingerprint: 'old-manifest',
      },
      {
        relations: ['ANALYTICS_PROD.SALES.CURRENT_MODEL'],
        dbtFingerprint: 'current-manifest',
      },
    );

    expect(scope.relations).toEqual(['ANALYTICS_PROD.SALES.CURRENT_MODEL']);
    expect(scope.dbtFingerprint).toBe('current-manifest');
  });

  it('activates one bounded generation after identity and scoped metadata checks pass', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-metadata-'));
    const calls: Array<{ sql: string; options: Record<string, unknown> }> = [];
    const executor = {
      executePositional: async (
        sql: string,
        _params: unknown[],
        _connection: ConnectionConfig,
        options: Record<string, unknown> = {},
      ) => {
        calls.push({ sql, options });
        if (sql.includes('CURRENT_ACCOUNT')) {
          return {
            columns: [],
            rows: [{
              DQL_ACCOUNT: 'ACME-PROD',
              DQL_ACCOUNT_LOCATOR: 'XY123',
              DQL_ACCOUNT_NAME: 'PROD',
              DQL_ORGANIZATION: 'ACME',
              DQL_DATABASE: 'ANALYTICS_PROD',
              DQL_SCHEMA: 'SALES',
              DQL_ROLE: 'ANALYST',
              DQL_WAREHOUSE: 'REPORTING_WH',
            }],
            rowCount: 1,
            executionTimeMs: 1,
          };
        }
        return {
          columns: [],
          rows: [{
            TABLE_CATALOG: 'ANALYTICS_PROD',
            TABLE_SCHEMA: 'SALES',
            TABLE_NAME: 'ORDERS',
            COLUMN_NAME: 'CUSTOMER_ID',
            DATA_TYPE: 'NUMBER',
            ORDINAL_POSITION: 1,
          }],
          rowCount: 1,
          executionTimeMs: 2,
          truncated: false,
        };
      },
    };
    try {
      const scope = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
        mode: 'selected_scopes',
        scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
      });
      const synced = await syncWarehouseMetadata({
        projectRoot,
        executor: executor as never,
        connection: snowflakeConnection,
        scope,
      });
      const active = latestRuntimeSchemaSnapshotForProject(projectRoot);

      expect(synced.snapshot.generationId).toMatch(/^warehouse_/);
      expect(active).toMatchObject({
        generationId: synced.snapshot.generationId,
        scopeFingerprint: scope.scopeFingerprint,
        connectionId: 'primary',
        status: 'ready',
        tables: [{
          relation: 'ANALYTICS_PROD.SALES.ORDERS',
          catalogOrDatabase: 'ANALYTICS_PROD',
          schema: 'SALES',
          name: 'ORDERS',
          columns: [{ name: 'CUSTOMER_ID', type: 'NUMBER' }],
        }],
      });
      expect(calls[1]?.options).toMatchObject({
        maxRows: 50_000,
        maxBytes: 24 * 1024 * 1024,
        deadlineMs: 60_000,
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when observed target identity differs from configuration', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-metadata-mismatch-'));
    const executor = {
      executePositional: async () => ({
        columns: [],
        rows: [{
          DQL_ACCOUNT: 'ACME-PROD',
          DQL_ACCOUNT_LOCATOR: 'XY123',
          DQL_ACCOUNT_NAME: 'PROD',
          DQL_ORGANIZATION: 'ACME',
          DQL_DATABASE: 'UNEXPECTED_DEV',
          DQL_SCHEMA: 'SALES',
          DQL_ROLE: 'ANALYST',
          DQL_WAREHOUSE: 'REPORTING_WH',
        }],
        rowCount: 1,
        executionTimeMs: 1,
      }),
    };
    try {
      const scope = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
        mode: 'selected_scopes',
        scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
      });
      await expect(syncWarehouseMetadata({
        projectRoot,
        executor: executor as never,
        connection: snowflakeConnection,
        scope,
      })).rejects.toThrow('does not match the active target');
      expect(latestRuntimeSchemaSnapshotForProject(projectRoot)).toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
