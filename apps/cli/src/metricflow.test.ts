import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compileMetricFlowQuery,
  hasMetricFlowCli,
  metricFlowCompileMode,
  MetricFlowUnavailableError,
  repairMetricFlowGroupBy,
  parseMetricFlowDimensionList,
} from './metricflow.js';

describe('MetricFlow compile wrapper', () => {
  let tmpDir: string;
  let previousBin: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-mf-'));
    previousBin = process.env.DQL_METRICFLOW_BIN;
  });

  afterEach(() => {
    if (previousBin === undefined) {
      delete process.env.DQL_METRICFLOW_BIN;
    } else {
      process.env.DQL_METRICFLOW_BIN = previousBin;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles through mf and extracts SQL from mixed stdout', () => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'semantic_manifest.json'), '{}', 'utf-8');
    const bin = join(tmpDir, 'mf');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then printf "%s\\n" "mf, version 0.13.0"; exit 0; fi',
        'printf "%s\\n" "$*" > args.txt',
        'printf "%s\\n" "info: compiling"',
        'printf "%s\\n" "SELECT metric_time, revenue FROM compiled_metric_sql"',
      ].join('\n'),
      'utf-8',
    );
    chmodSync(bin, 0o755);
    process.env.DQL_METRICFLOW_BIN = bin;

    const result = compileMetricFlowQuery({
      projectRoot: tmpDir,
      metrics: ['revenue'],
      dimensions: ['region'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      filters: [{ expression: "{{ Dimension('region') }} = 'NA'" }],
      limit: 25,
    });

    expect(result.sql).toBe('SELECT metric_time, revenue FROM compiled_metric_sql');
    expect(result.command).toContain('--explain');
    expect(result.command).toContain('--quiet');
    expect(result.command).not.toContain('--compile');
    expect(result.command).toContain('--metrics');
    expect(hasMetricFlowCli()).toBe(true);
  });

  it('keeps the legacy compile flag for older user-managed runtimes', () => {
    expect(metricFlowCompileMode('mf, version 0.13.0')).toBe('explain');
    expect(metricFlowCompileMode('mf, version 0.12.2')).toBe('legacy-compile');
    expect(metricFlowCompileMode('mf test')).toBe('legacy-compile');
  });

  it('returns a setup error when semantic_manifest.json is missing', () => {
    expect(() => compileMetricFlowQuery({
      projectRoot: tmpDir,
      metrics: ['revenue'],
      dimensions: [],
    })).toThrow(MetricFlowUnavailableError);
  });

  it('reports a missing MetricFlow executable as unavailable', () => {
    process.env.DQL_METRICFLOW_BIN = join(tmpDir, 'missing-mf');
    expect(hasMetricFlowCli()).toBe(false);
  });

  it('reports a failing MetricFlow executable as unavailable', () => {
    const bin = join(tmpDir, 'failing-mf');
    writeFileSync(bin, '#!/bin/sh\nexit 1\n', 'utf-8');
    chmodSync(bin, 0o755);
    process.env.DQL_METRICFLOW_BIN = bin;
    expect(hasMetricFlowCli()).toBe(false);
  });
});


describe('repairMetricFlowGroupBy (entity-qualified group-by retry)', () => {
  // Verbatim shape of the office failure: bare dimension name sent, MetricFlow
  // suggests the entity-qualified candidates.
  const OFFICE_ERROR = `ERROR: Got error(s) during query resolution.
Error #1: Message:
The given input does not match any of the available group-by-items for SimpleMetric('total_bcm'). Common issues are:
    Incorrect names.
    No valid join paths exist from the measure to the group-by-item.
Suggestions: [ 'bcm_hdr__effective_customer_account_name', 'bcm_tdp_pc__customer_account_id',
'bcm_hdr__customer_account_id', 'bcm_ccu_pc__customer_account_id',
'bcm_ccu_pc__bcm_dtl__customer_account_id', 'bcm_tdp_pc__bcm_dtl__customer_account_id', ]
Query Input:
effective_customer_account_name
Issue Location:
[Resolve Query(['percent_mom_bcm'])]`;

  const request = {
    projectRoot: '/tmp/p',
    metrics: ['total_bcm'],
    dimensions: ['effective_customer_account_name'],
    orderBy: [{ name: 'total_bcm', direction: 'desc' as const }],
    limit: 10,
  };

  it('rewrites the failing bare dimension to the unique qualified suggestion', () => {
    const repaired = repairMetricFlowGroupBy(request, OFFICE_ERROR);
    expect(repaired?.dimensions).toEqual(['bcm_hdr__effective_customer_account_name']);
    // Untouched fields survive.
    expect(repaired?.metrics).toEqual(['total_bcm']);
    expect(repaired?.limit).toBe(10);
  });

  it('refuses to guess when multiple suggestions tie at the same hop depth', () => {
    const ambiguous = OFFICE_ERROR.replace('effective_customer_account_name\n', 'customer_account_id\n')
      .replace('Query Input:\neffective_customer_account_name', 'Query Input:\ncustomer_account_id');
    const repaired = repairMetricFlowGroupBy(
      { ...request, dimensions: ['customer_account_id'] },
      ambiguous,
    );
    // bcm_tdp_pc__, bcm_hdr__, bcm_ccu_pc__customer_account_id all sit at 2 hops.
    expect(repaired).toBeNull();
  });

  it('ignores unrelated failures', () => {
    expect(repairMetricFlowGroupBy(request, 'ERROR: database is locked')).toBeNull();
  });

  it('qualifies time dimensions and filter dimensions with the same rename', () => {
    const timeError = `The given input does not match any of the available group-by-items for SimpleMetric('total_bcm').
Suggestions: [ 'bcm_hdr__consumption_date', ]
Query Input:
consumption_date`;
    const repaired = repairMetricFlowGroupBy(
      {
        ...request,
        dimensions: [],
        timeDimension: { name: 'consumption_date', granularity: 'day' },
        filters: [{ dimension: 'consumption_date', operator: 'gte', values: ['2026-01-01'] }],
      },
      timeError,
    );
    expect(repaired?.timeDimension?.name).toBe('bcm_hdr__consumption_date');
    expect(repaired?.filters?.[0]?.dimension).toBe('bcm_hdr__consumption_date');
  });
});


describe('parseMetricFlowDimensionList (mf list dimensions output)', () => {
  it('parses entity-qualified names and time-dimension grains', () => {
    const stdout = [
      "✔ 🔍 Found 3 dimensions for metrics ['total_bcm']",
      '• bcm_hdr__customer_name',
      '• bcm_hdr__region',
      '• metric_time',
      "  Queryable Granularities: ['day', 'week', 'month']",
    ].join('\n');
    const dims = parseMetricFlowDimensionList(stdout);
    expect(dims.map((d) => d.qualifiedName)).toEqual([
      'bcm_hdr__customer_name',
      'bcm_hdr__region',
      'metric_time',
    ]);
    const metricTime = dims.find((d) => d.qualifiedName === 'metric_time');
    expect(metricTime?.granularities).toEqual(['day', 'week', 'month']);
    // A non-time dimension carries no grains.
    expect(dims.find((d) => d.qualifiedName === 'bcm_hdr__region')?.granularities).toBeUndefined();
  });

  it('tolerates bare names, alternate bullets, and unknown header lines', () => {
    const dims = parseMetricFlowDimensionList([
      'Dimensions:',
      '- customer_name',
      '  * bcm_ccu_pc__product_category',
      'total: 2',
    ].join('\n'));
    expect(dims.map((d) => d.qualifiedName)).toContain('customer_name');
    expect(dims.map((d) => d.qualifiedName)).toContain('bcm_ccu_pc__product_category');
  });

  it('returns [] for output with no recognizable dimension lines', () => {
    expect(parseMetricFlowDimensionList('ERROR: could not connect to warehouse')).toEqual([]);
  });
});
