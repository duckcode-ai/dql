import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbtProvider } from './dbt-provider.js';

describe('DbtProvider', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dbt-provider-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(manifest: object): void {
    const targetDir = join(tmpDir, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  }

  function writeSemanticYaml(path: string, yaml: string): void {
    const full = join(tmpDir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, yaml, 'utf-8');
  }

  it('prefers target/manifest.json over models YAML when both are present', () => {
    // YAML says one metric
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: orders
    model: "ref('orders')"
    measures:
      - name: order_count
        agg: count
metrics:
  - name: yaml_only_metric
    type: simple
    type_params:
      measure: order_count
`,
    );

    // manifest.json says a different metric
    writeManifest({
      semantic_models: {
        'semantic_model.demo.orders': {
          name: 'orders',
          model: "ref('orders')",
          measures: [{ name: 'order_count', agg: 'count' }],
          dimensions: [],
          entities: [],
        },
      },
      metrics: {
        'metric.demo.manifest_metric': {
          name: 'manifest_metric',
          label: 'Manifest Metric',
          type: 'simple',
          type_params: { measure: 'order_count' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);

    const metricNames = layer.listMetrics().map((m) => m.name);
    expect(metricNames).toContain('manifest_metric');
    expect(metricNames).not.toContain('yaml_only_metric');
  });

  it('reads semantic_models and metrics from manifest.json', () => {
    writeManifest({
      semantic_models: {
        'semantic_model.demo.customers': {
          name: 'customers',
          model: "ref('customers')",
          defaults: { agg_time_dimension: 'signed_up_at' },
          entities: [{ name: 'customer_id', type: 'primary' }],
          dimensions: [
            { name: 'region', type: 'categorical' },
            { name: 'signed_up_at', type: 'time', type_params: { time_granularity: 'day' } },
          ],
          measures: [
            { name: 'customer_count', agg: 'count' },
            { name: 'lifetime_value', agg: 'sum', expr: 'ltv' },
          ],
        },
      },
      metrics: {
        'metric.demo.total_customers': {
          name: 'total_customers',
          label: 'Total Customers',
          description: 'Count of all customers',
          type: 'simple',
          type_params: { measure: 'customer_count' },
        },
        'metric.demo.total_ltv': {
          name: 'total_ltv',
          type: 'simple',
          type_params: { measure: 'lifetime_value' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);

    const cubes = layer.listCubes();
    expect(cubes.map((c) => c.name)).toContain('customers');

    const cube = cubes.find((c) => c.name === 'customers')!;
    expect(cube.measures.map((m) => m.name)).toEqual(['customer_count', 'lifetime_value']);
    expect(cube.dimensions.map((d) => d.name)).toContain('region');
    expect(cube.timeDimensions.map((d) => d.name)).toContain('signed_up_at');
    expect(cube.timeDimensions.find((d) => d.name === 'signed_up_at')?.primaryTime).toBe(true);

    const metrics = layer.listMetrics();
    const metricNames = metrics.map((m) => m.name);
    expect(metricNames).toContain('total_customers');
    expect(metricNames).toContain('total_ltv');
    const totalCustomers = metrics.find((m) => m.name === 'total_customers')!;
    expect(totalCustomers.sql).toBe('COUNT(customer_count)');
    expect(totalCustomers.table).toBe('customers');

    const totalLtv = metrics.find((m) => m.name === 'total_ltv')!;
    expect(totalLtv.sql).toBe('SUM(ltv)');
  });

  it('extracts table name from ref() syntax in model field', () => {
    writeManifest({
      semantic_models: {
        'semantic_model.demo.orders': {
          name: 'orders_semantic',
          model: "ref('stg_orders')",
          measures: [{ name: 'n', agg: 'count' }],
        },
      },
      metrics: {
        'metric.demo.n_orders': {
          name: 'n_orders',
          type: 'simple',
          type_params: { measure: 'n' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    const metric = layer.listMetrics()[0];
    expect(metric.table).toBe('stg_orders');
  });

  it('skips metrics whose measure is unknown', () => {
    writeManifest({
      semantic_models: {},
      metrics: {
        'metric.demo.dangling': {
          name: 'dangling',
          type: 'simple',
          type_params: { measure: 'nowhere' },
        },
      },
    });

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics()).toHaveLength(0);
  });

  it('falls back to YAML walker when manifest.json is missing', () => {
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: orders
    model: "ref('orders')"
    measures:
      - name: n
        agg: count
metrics:
  - name: yaml_metric
    type: simple
    type_params:
      measure: n
`,
    );

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics().map((m) => m.name)).toContain('yaml_metric');
  });

  it('falls back to YAML when manifest.json has no semantic content', () => {
    // A stock dbt project without semantic models still emits manifest.json,
    // but with empty semantic_models/metrics objects. We should fall back.
    writeManifest({ semantic_models: {}, metrics: {}, nodes: {} });
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: products
    model: "ref('products')"
    measures:
      - name: product_count
        agg: count
metrics:
  - name: yaml_fallback
    type: simple
    type_params:
      measure: product_count
`,
    );

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics().map((m) => m.name)).toContain('yaml_fallback');
  });

  it('falls back to YAML when manifest.json is malformed', () => {
    mkdirSync(join(tmpDir, 'target'), { recursive: true });
    writeFileSync(join(tmpDir, 'target', 'manifest.json'), '{ not valid json', 'utf-8');
    writeSemanticYaml(
      'models/_semantic.yml',
      `
semantic_models:
  - name: items
    model: "ref('items')"
    measures:
      - name: item_count
        agg: count
metrics:
  - name: malformed_fallback
    type: simple
    type_params:
      measure: item_count
`,
    );

    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics().map((m) => m.name)).toContain('malformed_fallback');
  });

  it('returns an empty layer when neither manifest nor YAML exist', () => {
    const provider = new DbtProvider();
    const layer = provider.load({ provider: 'dbt' }, tmpDir);
    expect(layer.listMetrics()).toEqual([]);
    expect(layer.listCubes()).toEqual([]);
  });
});
