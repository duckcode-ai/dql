import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSemanticLayerFromDir } from '@duckcodeailabs/dql-core';
import {
  buildSemanticObjectDetail,
  buildSemanticTree,
  loadSemanticImportManifest,
  performSemanticImport,
  syncSemanticImport,
} from './semantic-import.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('semantic import workflow', () => {
  it('imports dbt semantics into canonical local YAML and builds tree/detail views', async () => {
    const projectRoot = createTempProject();
    const sourceRoot = join(projectRoot, 'dbt-source');
    mkdirSync(join(sourceRoot, 'models', 'marts'), { recursive: true });

    writeFileSync(join(sourceRoot, 'models', 'marts', 'orders.yml'), [
      'semantic_models:',
      '  - name: orders',
      '    model: ref("stg_orders")',
      '    defaults:',
      '      agg_time_dimension: ordered_at',
      '    entities:',
      '      - name: customer',
      '        type: foreign',
      '        expr: customer_id',
      '    dimensions:',
      '      - name: ordered_at',
      '        type: time',
      '      - name: order_status',
      '        type: categorical',
      '        expr: status',
      '    measures:',
      '      - name: revenue',
      '        agg: sum',
      '        expr: amount',
      '        description: Revenue measure',
      'metrics:',
      '  - name: total_revenue',
      '    label: Total Revenue',
      '    description: Revenue metric',
      '    type: simple',
      '    type_params:',
      '      measure: revenue',
      '',
    ].join('\n'));

    const result = await performSemanticImport({
      targetProjectRoot: projectRoot,
      provider: 'dbt',
      sourceConfig: {
        provider: 'dbt',
        projectPath: 'dbt-source',
      },
    });

    expect(result.counts.cube).toBe(1);
    expect(result.counts.metric).toBe(2);
    expect(result.counts.dimension).toBe(2);
    expect(result.manifest.generatedFiles).toContain('semantic-layer/imports/manifest.json');
    expect(result.manifest.warnings).toContain('No dbt hierarchies were imported; dbt semantic models were normalized into cubes, measures, dimensions, and joins.');

    const config = JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8')) as { semanticLayer?: { provider?: string; path?: string } };
    expect(config.semanticLayer).toEqual({ provider: 'dql', path: './semantic-layer' });

    const importedLayer = loadSemanticLayerFromDir(join(projectRoot, 'semantic-layer'));
    const manifest = loadSemanticImportManifest(projectRoot);
    const tree = buildSemanticTree(importedLayer, manifest);
    const metricDetail = buildSemanticObjectDetail(importedLayer, manifest, 'metric:total_revenue');
    const cubeDetail = buildSemanticObjectDetail(importedLayer, manifest, 'cube:orders');

    expect(tree.label).toBe('dbt import');
    expect(tree.children?.map((child) => child.id)).toContain('domain:uncategorized');
    expect(metricDetail?.source?.provider).toBe('dbt');
    expect(metricDetail?.filePath).toBe('semantic-layer/metrics/uncategorized/total_revenue.yaml');
    expect(cubeDetail?.joins?.map((join) => join.right)).toContain('customer');
  });

  it('syncs the last import using the manifest source settings', async () => {
    const projectRoot = createTempProject();
    const sourceRoot = join(projectRoot, 'dbt-source');
    mkdirSync(join(sourceRoot, 'models', 'marts'), { recursive: true });

    const sourceFile = join(sourceRoot, 'models', 'marts', 'orders.yml');
    writeFileSync(sourceFile, [
      'semantic_models:',
      '  - name: orders',
      '    model: ref("stg_orders")',
      '    dimensions:',
      '      - name: ordered_at',
      '        type: time',
      '    measures:',
      '      - name: revenue',
      '        agg: sum',
      '        expr: amount',
      'metrics:',
      '  - name: total_revenue',
      '    type: simple',
      '    type_params:',
      '      measure: revenue',
      '',
    ].join('\n'));

    await performSemanticImport({
      targetProjectRoot: projectRoot,
      provider: 'dbt',
      sourceConfig: {
        provider: 'dbt',
        projectPath: 'dbt-source',
      },
    });

    writeFileSync(sourceFile, [
      'semantic_models:',
      '  - name: orders',
      '    model: ref("stg_orders")',
      '    dimensions:',
      '      - name: ordered_at',
      '        type: time',
      '    measures:',
      '      - name: revenue',
      '        agg: sum',
      '        expr: amount',
      'metrics:',
      '  - name: total_revenue',
      '    label: Total Revenue',
      '    type: simple',
      '    type_params:',
      '      measure: revenue',
      '  - name: total_revenue_duplicate',
      '    label: Total Revenue Duplicate',
      '    type: simple',
      '    type_params:',
      '      measure: revenue',
      '',
    ].join('\n'));

    const synced = await syncSemanticImport({ targetProjectRoot: projectRoot });
    const importedLayer = loadSemanticLayerFromDir(join(projectRoot, 'semantic-layer'));

    expect(synced.counts.metric).toBe(3);
    expect(importedLayer.getMetric('total_revenue_duplicate')).toBeDefined();
    expect(loadSemanticImportManifest(projectRoot)?.source.projectPath).toBe('dbt-source');
  });

  it('imports cubejs cubes including joins, segments, and pre-aggregations', async () => {
    const projectRoot = createTempProject();
    const sourceRoot = join(projectRoot, 'cube-source');
    mkdirSync(join(sourceRoot, 'model'), { recursive: true });

    writeFileSync(join(sourceRoot, 'model', 'commerce.yml'), [
      'cubes:',
      '  - name: orders',
      '    sql_table: analytics.orders',
      '    title: Orders',
      '    description: Orders cube',
      '    measures:',
      '      - name: revenue',
      '        type: sum',
      '        sql: amount',
      '        title: Revenue',
      '      - name: order_count',
      '        type: count',
      '        sql: id',
      '    dimensions:',
      '      - name: status',
      '        type: string',
      '        sql: status',
      '        title: Status',
      '      - name: created_at',
      '        type: time',
      '        sql: created_at',
      '        title: Created At',
      '    joins:',
      '      - name: customers',
      '        relationship: many_to_one',
      '        sql: ${CUBE}.customer_id = ${customers}.id',
      '    segments:',
      '      - name: completed_orders',
      "        sql: \"{CUBE}.status = 'completed'\"",
      '        title: Completed Orders',
      '    pre_aggregations:',
      '      - name: revenue_by_day',
      '        measures:',
      '          - revenue',
      '        dimensions:',
      '          - status',
      '        time_dimension: created_at',
      '        granularity: day',
      '        refresh_key: every 1 hour',
      '        title: Revenue By Day',
      '  - name: customers',
      '    sql_table: analytics.customers',
      '    title: Customers',
      '    dimensions:',
      '      - name: country',
      '        type: string',
      '        sql: country',
      '        title: Country',
      '',
    ].join('\n'));

    const result = await performSemanticImport({
      targetProjectRoot: projectRoot,
      provider: 'cubejs',
      sourceConfig: {
        provider: 'cubejs',
        projectPath: 'cube-source',
      },
    });

    const importedLayer = loadSemanticLayerFromDir(join(projectRoot, 'semantic-layer'));
    const manifest = loadSemanticImportManifest(projectRoot);
    const tree = buildSemanticTree(importedLayer, manifest);
    const segmentDetail = buildSemanticObjectDetail(importedLayer, manifest, 'segment:completed_orders');
    const preAggregationDetail = buildSemanticObjectDetail(importedLayer, manifest, 'pre_aggregation:revenue_by_day');

    expect(result.counts.cube).toBe(2);
    expect(result.counts.segment).toBe(1);
    expect(result.counts.pre_aggregation).toBe(1);
    expect(importedLayer.getCube('orders')?.joins.map((join) => join.right)).toContain('customers');
    expect(segmentDetail?.cube).toBe('orders');
    expect(segmentDetail?.source?.provider).toBe('cubejs');
    expect(preAggregationDetail?.timeDimension).toBe('created_at');
    expect(preAggregationDetail?.refreshKey).toBe('every 1 hour');
    expect(tree.children?.[0]?.children?.some((node) => node.kind === 'cube')).toBe(true);
  });

  it('imports snowflake semantic views with relationships using the shared manifest workflow', async () => {
    const projectRoot = createTempProject();
    const executeQuery = async (sql: string) => {
      if (sql.startsWith('SHOW SEMANTIC VIEWS')) {
        return {
          rows: [
            { NAME: 'ORDERS_SV', DATABASE_NAME: 'ANALYTICS', SCHEMA_NAME: 'SALES' },
          ],
        };
      }
      if (sql.includes('DESC SEMANTIC VIEW "ANALYTICS"."SALES"."ORDERS_SV"')) {
        return {
          rows: [
            { NAME: 'TOTAL_REVENUE', TYPE: 'NUMBER', SEMANTIC_ROLE: 'MEASURE', EXPRESSION: 'SUM(amount)', COMMENT: 'Revenue metric' },
            { NAME: 'ORDER_DATE', TYPE: 'DATE', SEMANTIC_ROLE: 'DIMENSION', COMMENT: 'Order date' },
          ],
        };
      }
      if (sql.includes(`INFORMATION_SCHEMA.SEMANTIC_VIEW_RELATIONSHIPS('"ANALYTICS"."SALES"."ORDERS_SV"')`)) {
        return {
          rows: [
            {
              LEFT_TABLE: 'ANALYTICS.SALES.ORDERS_SV',
              RIGHT_TABLE: 'ANALYTICS.SALES.CUSTOMERS_SV',
              JOIN_TYPE: 'LEFT',
              JOIN_CONDITION: 'ORDERS_SV.CUSTOMER_ID = CUSTOMERS_SV.ID',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    const result = await performSemanticImport({
      targetProjectRoot: projectRoot,
      provider: 'snowflake',
      sourceConfig: {
        provider: 'snowflake',
        projectPath: 'ANALYTICS',
        connection: 'default',
      },
      executeQuery,
    });

    const importedLayer = loadSemanticLayerFromDir(join(projectRoot, 'semantic-layer'));
    const manifest = loadSemanticImportManifest(projectRoot);
    const metricDetail = buildSemanticObjectDetail(importedLayer, manifest, 'metric:ORDERS_SV.TOTAL_REVENUE');
    const cubeDetail = buildSemanticObjectDetail(importedLayer, manifest, 'cube:ORDERS_SV');
    const tree = buildSemanticTree(importedLayer, manifest);

    expect(result.counts.metric).toBe(1);
    expect(result.counts.dimension).toBe(1);
    expect(result.counts.cube).toBe(2);
    expect(manifest?.source.connection).toBe('default');
    expect(metricDetail?.source?.provider).toBe('snowflake');
    expect(metricDetail?.domain).toBe('SALES');
    expect(cubeDetail?.joins?.map((join) => join.right)).toContain('CUSTOMERS_SV');
    expect(tree.label).toBe('snowflake import');
  });
});

function createTempProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-semantic-import-'));
  tempDirs.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'test-project' }, null, 2) + '\n');
  return projectRoot;
}
