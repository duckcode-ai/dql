import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getEffectiveDbtCloudSemanticSettings,
  getSemanticRuntimeSettings,
  saveTestedSemanticRuntimeSettings,
  semanticLayerGraphqlEndpoint,
  semanticRuntimeSettingsPath,
} from './semantic-runtime-settings.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-semantic-runtime-settings-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST;
  delete process.env.DBT_CLOUD_ENVIRONMENT_ID;
  delete process.env.DBT_CLOUD_SERVICE_TOKEN;
});

describe('semantic runtime settings', () => {
  it('normalizes regional hosts to the GraphQL endpoint', () => {
    expect(semanticLayerGraphqlEndpoint('semantic-layer.emea.dbt.com/')).toBe(
      'https://semantic-layer.emea.dbt.com/api/graphql',
    );
    expect(semanticLayerGraphqlEndpoint('https://example.test/api/graphql')).toBe(
      'https://example.test/api/graphql',
    );
  });

  it('preserves a tested token when a later successful edit leaves it blank and never returns it raw', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'https://semantic-layer.cloud.getdbt.com',
        environmentId: '12345',
        serviceToken: 'dbtc_secret_value',
      },
    }, { ok: true, message: 'Test passed', dialect: 'snowflake', metricCount: 7_500 });

    saveTestedSemanticRuntimeSettings(root, {
      dbtCloud: { host: 'semantic-layer.emea.dbt.com', environmentId: '67890', serviceToken: '' },
    }, { ok: true, message: 'Test passed again', dialect: 'databricks' });

    expect(getEffectiveDbtCloudSemanticSettings(root)).toMatchObject({
      serviceToken: 'dbtc_secret_value',
      environmentId: '67890',
      testState: 'passed',
    });
    const redacted = getSemanticRuntimeSettings(root);
    expect(redacted.dbtCloud.hasServiceToken).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('dbtc_secret_value');
    expect(readFileSync(semanticRuntimeSettingsPath(root), 'utf8')).toContain('dbtc_secret_value');
  });

  it('detects a complete environment configuration without persisting credentials', () => {
    process.env.DBT_CLOUD_SEMANTIC_LAYER_HOST = 'semantic-layer.au.dbt.com';
    process.env.DBT_CLOUD_ENVIRONMENT_ID = '42';
    process.env.DBT_CLOUD_SERVICE_TOKEN = 'env-secret';

    expect(getSemanticRuntimeSettings(root).dbtCloud).toMatchObject({
      configured: true,
      source: 'env',
      hasServiceToken: true,
      testState: 'configured',
    });
  });

  it('does not overwrite working settings with a failed test result', () => {
    saveTestedSemanticRuntimeSettings(root, {
      dbtCloud: { host: 'semantic-layer.cloud.getdbt.com', environmentId: '1', serviceToken: 'working' },
    }, { ok: true, message: 'Test passed' });

    expect(() => saveTestedSemanticRuntimeSettings(root, {
      dbtCloud: { host: 'broken.example', environmentId: '2', serviceToken: 'broken' },
    }, { ok: false, message: 'Connection failed' })).toThrow('Connection failed');
    expect(getEffectiveDbtCloudSemanticSettings(root)).toMatchObject({
      host: 'https://semantic-layer.cloud.getdbt.com',
      environmentId: '1',
      serviceToken: 'working',
    });
  });
});
