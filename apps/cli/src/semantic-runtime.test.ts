import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { saveTestedSemanticRuntimeSettings } from './semantic-runtime-settings.js';
import {
  compileSemanticRuntimeQuery,
  getSemanticRuntimeStatus,
  normalizeSemanticRuntimeQueryRequest,
} from './semantic-runtime.js';
import { managedMetricFlowBin } from './metricflow.js';

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
      {
        name: 'previous_day_revenue',
        label: 'Previous day revenue',
        description: '',
        domain: 'sales',
        sql: 'previous_day_revenue',
        type: 'custom',
        table: '',
        metricType: 'derived',
        typeParams: {
          metrics: [{ name: 'revenue', offset_window: { count: 1, granularity: 'day' } }],
        },
      },
    ],
    dimensions: [],
  });
}

describe('shared semantic runtime selector', () => {
  it('API-004/AGT-001 adds metric_time at the offset grain without overriding an explicit time selection', () => {
    expect(normalizeSemanticRuntimeQueryRequest({
      metrics: ['previous_day_revenue'],
      dimensions: [],
    }, layer())).toMatchObject({
      timeDimension: { name: 'metric_time', granularity: 'day' },
    });
    expect(normalizeSemanticRuntimeQueryRequest({
      metrics: ['previous_day_revenue'],
      dimensions: [],
      timeDimension: { name: 'metric_time', granularity: 'month' },
    }, layer())).toMatchObject({
      timeDimension: { name: 'metric_time', granularity: 'month' },
    });
  });

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

  it('API-004/E2E-008 passes the inferred metric_time group-by to MetricFlow for an offset metric', async () => {
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = join(root, 'mf');
    const argsPath = join(root, 'mf-args.txt');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then exit 0; fi',
      `printf "%s\\n" "$*" > '${argsPath.replace(/'/g, "'\\''")}'`,
      'printf "%s\\n" "SELECT previous_day_revenue FROM metricflow_compiled"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.DQL_METRICFLOW_BIN = bin;

    const result = await compileSemanticRuntimeQuery({
      metrics: ['previous_day_revenue'],
      dimensions: [],
    }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
    });

    expect(result?.effectiveRequest.timeDimension).toEqual({ name: 'metric_time', granularity: 'day' });
    expect(readFileSync(argsPath, 'utf8')).toContain('--group-by metric_time__day');
  });

  it('activates a managed project-local runtime immediately and forwards the configured profiles directory', async () => {
    delete process.env.DQL_METRICFLOW_BIN;
    mkdirSync(join(root, 'target'), { recursive: true });
    mkdirSync(join(root, '.dql', 'runtimes', 'metricflow', 'bin'), { recursive: true });
    writeFileSync(join(root, 'target', 'semantic_manifest.json'), '{}');
    const bin = managedMetricFlowBin(root);
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.13.0"; exit 0; fi',
      'printf "SELECT \'%s\' AS profiles_dir\\n" "$DBT_PROFILES_DIR"',
    ].join('\n'));
    chmodSync(bin, 0o755);

    const status = await getSemanticRuntimeStatus(root);
    expect(status.active).toBe('metricflow-cli');
    expect(status.adapters.find((adapter) => adapter.id === 'metricflow-cli')).toMatchObject({
      configured: true,
      ready: true,
      source: 'local',
    });
    expect(status.adapters.find((adapter) => adapter.id === 'metricflow-cli')?.detail).toContain('project-local managed runtime');

    const result = await compileSemanticRuntimeQuery({ metrics: ['revenue_ratio'], dimensions: [] }, {
      projectRoot: root,
      projectConfig: { dbt: { projectDir: '.', profilesDir: 'profiles' } },
      detectedProvider: 'dbt',
      semanticLayer: layer(),
    });
    expect(result).toMatchObject({ engine: 'metricflow-cli' });
    expect(result?.sql).toContain(join(root, 'profiles'));
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

describe('describeRuntimeCompatibility (native cascade fallback)', () => {
  function bcmLayer(): SemanticLayer {
    // A metric on bcm_hdr with one own-model dimension carrying its qualified name.
    return new SemanticLayer({
      metrics: [
        { name: 'total_bcm', label: 'Total BCM', description: '', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr', objectKind: 'metric' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr', qualifiedName: 'bcm_hdr__customer_name', entityLink: 'bcm_hdr' },
      ],
    });
  }

  it('falls back to native and carries the qualified name when no runtime is active', async () => {
    // The suite's beforeEach points DQL_METRICFLOW_BIN at a missing path and no
    // dbt Cloud is configured, so the active adapter resolves to native.
    const { describeRuntimeCompatibility } = await import('./semantic-runtime.js');
    const result = await describeRuntimeCompatibility(root, bcmLayer(), ['total_bcm']);
    expect(result.engine).toBe('native');
    const customer = result.dimensions.find((d) => d.name === 'customer_name');
    expect(customer?.qualifiedName).toBe('bcm_hdr__customer_name');
  });

  it('returns metric_unresolved for an unknown metric', async () => {
    const { describeRuntimeCompatibility } = await import('./semantic-runtime.js');
    const result = await describeRuntimeCompatibility(root, bcmLayer(), ['nope']);
    expect(result.incompatible).toContainEqual({ name: 'nope', qualifiedName: undefined, reason: 'metric_unresolved' });
  });
});

describe('qualifyForMetricFlow (Phase 3 boundary)', () => {
  function bcmLayer(): SemanticLayer {
    return new SemanticLayer({
      metrics: [
        { name: 'total_bcm', label: 'Total BCM', description: '', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr', objectKind: 'metric' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr', qualifiedName: 'bcm_hdr__customer_name', entityLink: 'bcm_hdr' },
      ],
    });
  }

  it('rewrites bare dimension + order-by names to entity-qualified names', async () => {
    const { qualifyForMetricFlow } = await import('./semantic-runtime.js');
    const { request } = qualifyForMetricFlow({
      metrics: ['total_bcm'],
      dimensions: ['customer_name'],
      orderBy: [{ name: 'customer_name', direction: 'asc' }],
    }, bcmLayer());
    expect(request.dimensions).toEqual(['bcm_hdr__customer_name']);
    expect(request.orderBy?.[0]?.name).toBe('bcm_hdr__customer_name');
  });

  it('passes through unresolvable names and metric_time untouched', async () => {
    const { qualifyForMetricFlow } = await import('./semantic-runtime.js');
    const { request } = qualifyForMetricFlow({
      metrics: ['total_bcm'],
      dimensions: ['not_a_dim', 'bcm_hdr__customer_name'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
    }, bcmLayer());
    expect(request.dimensions).toEqual(['not_a_dim', 'bcm_hdr__customer_name']);
    expect(request.timeDimension?.name).toBe('metric_time');
  });
});

describe('saveSemanticRuntimePreference (Phase 4)', () => {
  it('persists a runtime preference with no dbt Cloud test required', async () => {
    const { saveSemanticRuntimePreference } = await import('./semantic-runtime-settings.js');
    const saved = saveSemanticRuntimePreference(root, 'metricflow-cli');
    expect(saved.preference).toBe('metricflow-cli');
    // Round-trips through the store.
    const { getSemanticRuntimeSettings } = await import('./semantic-runtime-settings.js');
    expect(getSemanticRuntimeSettings(root).preference).toBe('metricflow-cli');
  });
});
