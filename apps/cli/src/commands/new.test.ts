import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { runNew } from './new.js';

describe('runNew', () => {
  it('creates a previewable block inside a starter project', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-'));
    const projectDir = join(targetDir, 'demo-project');

    await runInit(projectDir, {
      check: false,
      chart: '',
      domain: '',
      format: 'json',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: '',
      connection: '',
      verbose: false,
      skipTests: false,
    });

    try {
      process.chdir(projectDir);
      await runNew('block', ['Pipeline Health'], {
        check: false,
        chart: 'bar',
        domain: 'sales',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'tester',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false,
      });

      const blockPath = join(projectDir, 'blocks', 'pipeline_health.dql');
      expect(existsSync(blockPath)).toBe(true);

      const block = readFileSync(blockPath, 'utf-8');
      expect(block).toContain('block "Pipeline Health"');
      expect(block).toContain('domain = "sales"');
      expect(block).toContain('owner = "tester"');
      expect(block).toContain('your_table');
      expect(block).toContain('chart = "bar"');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('creates dashboard and workbook scaffolds in their default folders', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-multi-'));
    const projectDir = join(targetDir, 'demo-project');

    await runInit(projectDir, {
      check: false,
      chart: '',
      domain: '',
      format: 'json',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: '',
      connection: '',
      verbose: false,
      skipTests: false,
    });

    try {
      process.chdir(projectDir);

      await runNew('dashboard', ['Revenue Overview'], {
        check: false,
        chart: 'line',
        domain: 'finance',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'tester',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false,
      });

      await runNew('workbook', ['Quarterly Review'], {
        check: false,
        chart: 'bar',
        domain: 'finance',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'tester',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false,
      });

      const dashboardPath = join(projectDir, 'dashboards', 'revenue_overview.dql');
      const workbookPath = join(projectDir, 'workbooks', 'quarterly_review.dql');

      expect(existsSync(dashboardPath)).toBe(true);
      expect(existsSync(workbookPath)).toBe(true);

      const dashboard = readFileSync(dashboardPath, 'utf-8');
      const workbook = readFileSync(workbookPath, 'utf-8');

      expect(dashboard).toContain('dashboard "Revenue Overview"');
      expect(dashboard).toContain('chart.line(');
      expect(workbook).toContain('workbook "Quarterly Review"');
      expect(workbook).toContain('page "Summary"');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('creates a semantic block plus companion semantic-layer files', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-semantic-'));
    const projectDir = join(targetDir, 'demo-project');

    await runInit(projectDir, {
      check: false,
      chart: '',
      domain: '',
      format: 'json',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: '',
      connection: '',
      verbose: false,
      skipTests: false,
    });

    try {
      process.chdir(projectDir);

      await runNew('semantic-block', ['ARR Growth'], {
        check: false,
        chart: 'bar',
        domain: 'finance',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'tester',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false,
      });

      const blockPath = join(projectDir, 'blocks', 'arr_growth.dql');
      const metricPath = join(projectDir, 'semantic-layer', 'metrics', 'arr_growth_metric.yaml');
      const companionPath = join(projectDir, 'semantic-layer', 'blocks', 'arr_growth.yaml');

      expect(existsSync(blockPath)).toBe(true);
      expect(existsSync(metricPath)).toBe(true);
      expect(existsSync(companionPath)).toBe(true);

      const block = readFileSync(blockPath, 'utf-8');
      const metric = readFileSync(metricPath, 'utf-8');

      expect(block).toContain('type = "semantic"');
      expect(block).toContain('metric = "arr_growth_metric"');
      expect(metric).toContain('name: arr_growth_metric');
      expect(metric).toContain('domain: finance');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
