import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { loadSkills } from '@duckcodeailabs/dql-agent';

const INIT_FLAGS = {
  check: false,
  chart: '',
  domain: '',
  format: 'json' as const,
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
  version: false,
};

const DBT_SEMANTIC_YAML = `semantic_models:
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
`;

describe('runInit', () => {
  it('scaffolds a domain-first OSS project with visible shared skills', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-init-'));
    const projectDir = join(targetDir, 'demo-project');

    await runInit(projectDir, INIT_FLAGS);

    const contents = readdirSync(projectDir);
    expect(contents).toContain('apps');
    expect(contents).toContain('domains');
    expect(contents).toContain('skills');
    expect(contents).toContain('tests');
    expect(contents).toContain('dql.config.json');
    expect(contents).toContain('notebooks');

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      project: string;
      connections?: Record<string, unknown>;
    };
    expect(config.project).toBe('demo-project');
    expect(config.connections).toBeUndefined();

    const notebook = readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf-8');
    expect(notebook).toContain('DQL');

    // `dql init` seeds the editable starter skills (spec 16).
    expect(loadSkills(projectDir).skills.map((skill) => skill.id).sort()).toEqual([
      'block-authoring',
      'domain-rules',
      'metrics-glossary',
      'sql-conventions',
    ]);
  });

  it('detects a Jaffle Shop-style dbt project and DuckDB file', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-'));
    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');

    await runInit(projectDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      defaultConnectionName: string;
      connections: { default: { filepath: string } };
      semanticLayer: { provider: string; projectPath: string };
      manifestVersion: number;
      modeling: { mode: string };
      dbt: { projectDir: string; manifestPath: string };
    };

    expect(config.defaultConnectionName).toBe('default');
    expect(config.connections.default.filepath).toBe('jaffle_shop.duckdb');
    expect(config.semanticLayer.provider).toBe('dbt');
    expect(config.semanticLayer.projectPath).toBe('.');
    expect(config.manifestVersion).toBe(3);
    expect(config.modeling).toEqual({ mode: 'dbt-first' });
    expect(config.dbt).toEqual({ projectDir: '.', manifestPath: 'target/manifest.json' });
    expect(readdirSync(projectDir)).not.toContain('semantic-layer');
  });

  it('keeps DQL isolated under ./dql while wiring to a parent dbt repo', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-parent-'));
    const dqlDir = join(repoDir, 'dql');
    writeFileSync(join(repoDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');

    await runInit(dqlDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(dqlDir, 'dql.config.json'), 'utf-8')) as {
      semanticLayer: { provider: string; projectPath: string };
      dbt: { projectDir: string; manifestPath: string };
      manifestVersion: number;
      modeling: { mode: string };
    };
    const contents = readdirSync(dqlDir);

    expect(contents).toContain('apps');
    expect(contents).toContain('domains');
    expect(contents).toContain('skills');
    expect(contents).toContain('tests');
    expect(contents).toContain('notebooks');
    expect(config.semanticLayer).toEqual({ provider: 'dbt', projectPath: '..' });
    expect(config.dbt).toEqual({ projectDir: '..', manifestPath: 'target/manifest.json' });
    expect(config.manifestVersion).toBe(3);
    expect(config.modeling).toEqual({ mode: 'dbt-first' });
  });

  it('keeps dbt semantic definitions read-only instead of copying them into DQL', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-semantic-'));
    const metricsDir = join(projectDir, 'models', 'metrics');
    mkdirSync(metricsDir, { recursive: true });

    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');
    writeFileSync(join(metricsDir, 'orders.yml'), DBT_SEMANTIC_YAML);

    await runInit(projectDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      semanticLayer: { provider: string; projectPath?: string };
      manifestVersion: number;
      modeling: { mode: string };
    };

    expect(config.semanticLayer).toEqual({ provider: 'dbt', projectPath: '.' });
    expect(config.manifestVersion).toBe(3);
    expect(config.modeling).toEqual({ mode: 'dbt-first' });
    expect(readdirSync(projectDir)).not.toContain('semantic-layer');
  });

  it('references parent dbt semantic definitions without importing local copies', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-parent-semantic-'));
    const dqlDir = join(repoDir, 'dql');
    const metricsDir = join(repoDir, 'models', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(join(repoDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(metricsDir, 'orders.yml'), DBT_SEMANTIC_YAML);

    await runInit(dqlDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(dqlDir, 'dql.config.json'), 'utf-8')) as {
      semanticLayer: { provider: string; projectPath?: string };
      dbt: { projectDir: string; manifestPath: string };
    };

    expect(config.semanticLayer).toEqual({ provider: 'dbt', projectPath: '..' });
    expect(config.dbt).toEqual({ projectDir: '..', manifestPath: 'target/manifest.json' });
    expect(readdirSync(dqlDir)).not.toContain('semantic-layer');
  });

  it('preserves an existing project config and content when force only patches missing directories', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-existing-'));
    const originalConfig = {
      project: 'legacy-project',
      manifestVersion: 2,
      semanticLayer: { provider: 'dql', path: './semantic-layer' },
    };
    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify(originalConfig, null, 2) + '\n');
    mkdirSync(join(projectDir, 'notebooks'), { recursive: true });
    writeFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'existing notebook\n');

    await runInit(projectDir, { ...INIT_FLAGS, force: true });

    expect(JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8'))).toEqual(originalConfig);
    expect(readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf-8')).toBe('existing notebook\n');
    expect(readdirSync(projectDir)).toEqual(expect.arrayContaining(['apps', 'domains', 'skills', 'tests']));
    expect(readdirSync(join(projectDir, 'skills'))).toEqual([]);
    expect(readdirSync(projectDir)).not.toContain('.gitignore');
    expect(readdirSync(projectDir)).not.toContain('semantic-layer');
  });
});
