import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileMetricFlowQuery, hasMetricFlowCli, MetricFlowUnavailableError } from './metricflow.js';

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
        'if [ "$1" = "--version" ]; then printf "%s\\n" "mf test"; exit 0; fi',
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
    expect(result.command).toContain('--compile');
    expect(result.command).toContain('--metrics');
    expect(hasMetricFlowCli()).toBe(true);
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
