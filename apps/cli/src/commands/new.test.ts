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
      skipTests: false, version: false,
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
        skipTests: false, version: false,
      });

      const blockPath = join(projectDir, 'domains', 'sales', 'blocks', 'pipeline_health.dql');
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
      skipTests: false, version: false,
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
        skipTests: false, version: false,
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
        skipTests: false, version: false,
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
      skipTests: false, version: false,
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
        skipTests: false, version: false,
      });

      const blockPath = join(projectDir, 'domains', 'finance', 'blocks', 'arr_growth.dql');
      const metricPath = join(projectDir, 'semantic-layer', 'metrics', 'arr_growth_metric.yaml');
      const companionPath = join(projectDir, 'semantic-layer', 'blocks', 'finance', 'arr_growth.yaml');

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

  it('creates a business view scaffold in the business-views folder', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-business-view-'));
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
      skipTests: false, version: false,
    });

    try {
      process.chdir(projectDir);

      await runNew('business-view', ['Customer 360'], {
        check: false,
        chart: 'bar',
        domain: 'customer',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'analytics',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      const viewPath = join(projectDir, 'domains', 'customer', 'views', 'customer_360.dql');
      expect(existsSync(viewPath)).toBe(true);

      const view = readFileSync(viewPath, 'utf-8');
      expect(view).toContain('business_view "Customer 360"');
      expect(view).toContain('domain = "customer"');
      expect(view).toContain('owner = "analytics"');
      expect(view).toContain('includes {');
      expect(view).toContain('block "Customer Identity"');
      expect(view).toContain('business_view "Customer Service Summary"');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('creates a business term scaffold in the terms folder', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-term-'));
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
      skipTests: false, version: false,
    });

    try {
      process.chdir(projectDir);

      await runNew('term', ['Customer'], {
        check: false,
        chart: 'bar',
        domain: 'customer',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'analytics',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      const termPath = join(projectDir, 'domains', 'customer', 'terms', 'customer.dql');
      expect(existsSync(termPath)).toBe(true);

      const term = readFileSync(termPath, 'utf-8');
      expect(term).toContain('term "Customer"');
      expect(term).toContain('domain = "customer"');
      expect(term).toContain('type = "entity"');
      expect(term).toContain('identifiers = ["customer_id"]');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('creates a domain-first folder and patterned block scaffold', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-domain-'));
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
      skipTests: false, version: false,
    });

    try {
      process.chdir(projectDir);

      await runNew('domain', ['Customer'], {
        check: false,
        chart: '',
        domain: '',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'customer-analytics',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      await runNew('block', ['Customer Profile'], {
        check: false,
        chart: 'table',
        domain: 'customer',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'customer-analytics',
        port: null,
        queryOnly: false,
        template: 'entity_profile',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      await runNew('view', ['Customer 360'], {
        check: false,
        chart: '',
        domain: 'customer',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'customer-analytics',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      const domainPath = join(projectDir, 'domains', 'customer', 'domain.dql');
      const blockPath = join(projectDir, 'domains', 'customer', 'blocks', 'customer_profile.dql');
      const viewPath = join(projectDir, 'domains', 'customer', 'views', 'customer_360.dql');

      expect(existsSync(domainPath)).toBe(true);
      expect(existsSync(join(projectDir, 'domains', 'customer', 'terms'))).toBe(true);
      expect(existsSync(join(projectDir, 'domains', 'customer', 'views'))).toBe(true);
      expect(existsSync(blockPath)).toBe(true);
      expect(existsSync(viewPath)).toBe(true);

      const domain = readFileSync(domainPath, 'utf-8');
      const block = readFileSync(blockPath, 'utf-8');
      const view = readFileSync(viewPath, 'utf-8');
      expect(domain).toContain('domain "Customer"');
      expect(domain).toContain('boundedContext = "Describe the business boundary for customer."');
      expect(block).toContain('block "Customer Profile"');
      expect(block).toContain('tags = ["starter", "customer", "entity_profile"]');
      expect(block).toContain('pattern = "entity_profile"');
      expect(block).toContain('grain = "customer_id"');
      expect(block).toContain('entities = ["Customer"]');
      expect(block).toContain('outputs = ["customer_id", "customer_name"]');
      expect(block).toContain('reviewCadence = "monthly"');
      expect(view).toContain('business_view "Customer 360"');
      expect(view).toContain('domain = "customer"');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('creates domain-first semantic block companions under the domain namespace', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-domain-semantic-'));
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
      skipTests: false, version: false,
    });

    try {
      process.chdir(projectDir);

      await runNew('domain', ['Revenue'], {
        check: false,
        chart: '',
        domain: '',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'finance-analytics',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      await runNew('semantic-block', ['ARR Growth'], {
        check: false,
        chart: 'bar',
        domain: 'revenue',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'finance-analytics',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      const blockPath = join(projectDir, 'domains', 'revenue', 'blocks', 'arr_growth.dql');
      const metricPath = join(projectDir, 'semantic-layer', 'metrics', 'arr_growth_metric.yaml');
      const companionPath = join(projectDir, 'semantic-layer', 'blocks', 'revenue', 'arr_growth.yaml');

      expect(existsSync(blockPath)).toBe(true);
      expect(existsSync(metricPath)).toBe(true);
      expect(existsSync(companionPath)).toBe(true);
      expect(readFileSync(companionPath, 'utf-8')).toContain('domain: revenue');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('creates bridge block scaffolds with cross-domain contract placeholders', async () => {
    const originalCwd = process.cwd();
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-new-bridge-'));
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
      skipTests: false, version: false,
    });

    try {
      process.chdir(projectDir);

      await runNew('block', ['Customer Revenue Bridge'], {
        check: false,
        chart: 'table',
        domain: 'customer',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: 'customer-analytics',
        port: null,
        queryOnly: false,
        template: 'bridge',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });

      const blockPath = join(projectDir, 'domains', 'customer', 'blocks', 'customer_revenue_bridge.dql');
      expect(existsSync(blockPath)).toBe(true);

      const block = readFileSync(blockPath, 'utf-8');
      expect(block).toContain('pattern = "bridge"');
      expect(block).toContain('grain = "bridge_key"');
      expect(block).toContain('entities = ["Source Entity", "Target Entity"]');
      expect(block).toContain('outputs = ["bridge_key", "source_entity_id", "target_entity_id"]');
      expect(block).toContain('allowedFilters = ["source_entity_id", "target_entity_id"]');
      expect(block).toContain('filterBindings {');
      expect(block).toContain('source_entity_id = "source_entity_id"');
      expect(block).toContain('target_entity_id = "target_entity_id"');
      expect(block).toContain('sourceSystems = ["source_system", "target_system"]');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
