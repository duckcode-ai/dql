import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { saveTestedSemanticRuntimeSettings } from './semantic-runtime-settings.js';
import { compileSemanticRuntimeQuery, getSemanticRuntimeStatus } from './semantic-runtime.js';

let root: string;
let priorMfBin: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-semantic-runtime-'));
  priorMfBin = process.env.DQL_METRICFLOW_BIN;
  process.env.DQL_METRICFLOW_BIN = join(root, 'missing-mf');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (priorMfBin === undefined) delete process.env.DQL_METRICFLOW_BIN;
  else process.env.DQL_METRICFLOW_BIN = priorMfBin;
});

function layer(): SemanticLayer {
  return new SemanticLayer({
    metrics: [
      { name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'SUM(amount)', type: 'sum', table: 'orders' },
      { name: 'revenue_ratio', label: 'Revenue ratio', description: '', domain: 'sales', sql: 'revenue_ratio', type: 'custom', table: '', metricType: 'ratio' },
    ],
    dimensions: [],
  });
}

describe('shared semantic runtime selector', () => {
  it('uses the bundled native compiler for composable metrics', async () => {
    const result = await compileSemanticRuntimeQuery({ metrics: ['revenue'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: {},
      semanticLayer: layer(),
      tableMapping: { orders: 'analytics.orders' },
    });
    expect(result?.engine).toBe('native');
    expect(result?.sql).toContain('analytics.orders');
  });

  it('uses a detected local MetricFlow runtime for derived metrics without an AI planning call', async () => {
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = join(root, 'mf');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then exit 0; fi',
      'printf "%s\\n" "SELECT revenue_ratio FROM metricflow_compiled"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.DQL_METRICFLOW_BIN = bin;

    const result = await compileSemanticRuntimeQuery({ metrics: ['revenue_ratio'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
    });
    expect(result).toMatchObject({ engine: 'metricflow-cli', sql: 'SELECT revenue_ratio FROM metricflow_compiled' });
  });

  it('selects a successfully tested dbt Cloud adapter without exposing its token', async () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'auto',
      dbtCloud: { host: 'semantic-layer.cloud.getdbt.com', environmentId: '99', serviceToken: 'cloud-secret' },
    }, { ok: true, message: 'Test passed', metricCount: 7_500 });

    const status = await getSemanticRuntimeStatus(root);
    expect(status.active).toBe('dbt-cloud');
    expect(status.adapters.find((adapter) => adapter.id === 'dbt-cloud')).toMatchObject({
      configured: true,
      tested: true,
      ready: true,
    });
    expect(JSON.stringify(status)).not.toContain('cloud-secret');
  });
});
