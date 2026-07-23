import { describe, expect, it, vi } from 'vitest';
import {
  compileDbtCloudSemanticQuery,
  listDbtCloudCompatibleDimensions,
  listDbtCloudSemanticMetrics,
  testDbtCloudSemanticConnection,
} from './dbt-cloud-semantic.js';
import type { EffectiveDbtCloudSemanticSettings } from './semantic-runtime-settings.js';

const settings: EffectiveDbtCloudSemanticSettings = {
  host: 'https://semantic-layer.cloud.getdbt.com',
  endpoint: 'https://semantic-layer.cloud.getdbt.com/api/graphql',
  environmentId: '12345',
  serviceToken: 'secret-service-token',
  source: 'local',
  configured: true,
  testState: 'configured',
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dbt Cloud semantic adapter', () => {
  it('tests authentication with a redacted result and the service-token header', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-service-token');
      const body = JSON.parse(String(init?.body)) as { query: string };
      return body.query.includes('DqlSemanticMetricInventory')
        ? jsonResponse({ data: { metricsPaginated: {
            items: [{ name: 'orders' }, { name: 'revenue' }, { name: 'revenue_yoy' }],
            totalItems: 3,
            totalPages: 1,
          } } })
        : jsonResponse({ data: { environmentInfo: { dialect: 'snowflake' }, metricsPaginated: { totalItems: 3 } } });
    });

    const result = await testDbtCloudSemanticConnection(settings, fetchMock as typeof fetch);
    expect(result).toMatchObject({
      ok: true,
      dialect: 'snowflake',
      metricCount: 3,
      metricNames: ['orders', 'revenue', 'revenue_yoy'],
      metricInventoryComplete: true,
      semanticCatalogFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain('secret-service-token');
  });

  it('API-004 paginates and fingerprints the actual runtime metric inventory', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { pageNum: number } };
      return jsonResponse({ data: { metricsPaginated: {
        items: body.variables.pageNum === 1
          ? [{ name: 'revenue' }, { name: 'orders' }]
          : [{ name: 'revenue_yoy' }],
        totalItems: 3,
        totalPages: 2,
      } } });
    });

    const inventory = await listDbtCloudSemanticMetrics(settings, fetchMock as typeof fetch);
    expect(inventory).toMatchObject({
      names: ['orders', 'revenue', 'revenue_yoy'],
      totalItems: 3,
      complete: true,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('compiles unsaved member selections, filters, ordering, and limit through compileSql', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain('compileSql');
      expect(body.variables).toMatchObject({
        environmentId: '12345',
        metrics: [{ name: 'revenue' }],
        groupBy: [{ name: 'region' }],
        limit: 10,
      });
      expect(JSON.stringify(body.variables)).toContain("Dimension('region')");
      return jsonResponse({ data: { compileSql: { sql: 'select region, sum(revenue) from governed_query' } } });
    });

    const result = await compileDbtCloudSemanticQuery(settings, {
      metrics: ['revenue'],
      dimensions: ['region'],
      filters: [{ dimension: 'region', operator: 'equals', values: ['North America'] }],
      orderBy: [{ name: 'revenue', direction: 'desc' }],
      limit: 10,
    }, fetchMock as typeof fetch);
    expect(result).toEqual({ sql: 'select region, sum(revenue) from governed_query', engine: 'dbt-cloud' });
  });

  it('paginates compatible dimensions for the selected metrics', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { pageNum: number } };
      return jsonResponse({ data: { dimensionsPaginated: {
        items: body.variables.pageNum === 1
          ? [{ name: 'region', type: 'CATEGORICAL', queryableGranularities: [] }]
          : [{ name: 'metric_time', type: 'TIME', queryableGranularities: ['DAY', 'MONTH'] }],
        totalPages: 2,
      } } });
    });

    const result = await listDbtCloudCompatibleDimensions(settings, ['revenue'], fetchMock as typeof fetch);
    expect(result.map((dimension) => dimension.name)).toEqual(['region', 'metric_time']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
