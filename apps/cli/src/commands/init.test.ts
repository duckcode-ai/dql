import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';

describe('runInit', () => {
  it('scaffolds a DQL project with config, blocks dir, and notebook', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-init-'));
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

    const contents = readdirSync(projectDir);
    expect(contents).toContain('blocks');
    expect(contents).toContain('dql.config.json');
    expect(contents).toContain('notebooks');

    const config = readFileSync(join(projectDir, 'dql.config.json'), 'utf-8');
    expect(config).toContain('demo-project');
    expect(config).toContain('duckdb');

    const notebook = readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf-8');
    expect(notebook).toContain('DQL');
  });

  it('detects a Jaffle Shop-style dbt project and DuckDB file', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-'));
    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');

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

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      connections: { default: { filepath: string } };
      semanticLayer: { provider: string; projectPath: string };
    };

    expect(config.connections.default.filepath).toBe('jaffle_shop.duckdb');
    expect(config.semanticLayer.provider).toBe('dbt');
    expect(config.semanticLayer.projectPath).toBe('.');
    expect(readdirSync(projectDir)).not.toContain('semantic-layer');
  });

  it('auto-imports dbt semantic definitions into local semantic-layer YAML on init', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-semantic-'));
    const metricsDir = join(projectDir, 'models', 'metrics');
    mkdirSync(metricsDir, { recursive: true });

    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');
    writeFileSync(
      join(metricsDir, 'orders.yml'),
      `semantic_models:
  - name: orders
    model: ref('fct_orders')
    defaults:
      agg_time_dimension: ordered_at
    entities:
      - name: order
        type: primary
        expr: order_id
    dimensions:
      - name: ordered_at
        type: time
        type_params:
          time_granularity: day
    measures:
      - name: order_total
        agg: sum
        expr: order_total
metrics:
  - name: order_total
    type: simple
    type_params:
      measure: order_total
`,
    );

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

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      semanticLayer: { provider: string; path?: string };
    };

    expect(config.semanticLayer.provider).toBe('dql');
    expect(config.semanticLayer.path).toBe('./semantic-layer');
    expect(readdirSync(projectDir)).toContain('semantic-layer');
    expect(readFileSync(join(projectDir, 'semantic-layer', 'imports', 'manifest.json'), 'utf-8')).toContain('"provider": "dbt"');
  });
});
