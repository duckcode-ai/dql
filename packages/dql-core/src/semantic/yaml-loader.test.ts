import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSemanticLayerFromDir } from './yaml-loader.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadSemanticLayerFromDir', () => {
  it('loads nested semantic folders recursively, including segments and pre-aggregations', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-semantic-loader-'));
    tempDirs.push(root);
    const semanticDir = join(root, 'semantic-layer');

    mkdirSync(join(semanticDir, 'metrics', 'finance'), { recursive: true });
    mkdirSync(join(semanticDir, 'dimensions', 'finance', 'orders'), { recursive: true });
    mkdirSync(join(semanticDir, 'segments', 'finance'), { recursive: true });
    mkdirSync(join(semanticDir, 'pre_aggregations', 'finance'), { recursive: true });
    mkdirSync(join(semanticDir, 'cubes', 'finance'), { recursive: true });

    writeFileSync(join(semanticDir, 'metrics', 'finance', 'gross_revenue.yaml'), [
      'name: gross_revenue',
      'label: Gross Revenue',
      'description: Imported flat metric',
      'domain: finance',
      'sql: |',
      '  SUM(amount)',
      'type: sum',
      'table: fact_orders',
      'tags:',
      '  - finance',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'dimensions', 'finance', 'orders', 'sales_channel.yaml'), [
      'name: sales_channel',
      'label: Sales Channel',
      'description: Channel dimension',
      'domain: finance',
      'sql: |',
      '  channel',
      'type: string',
      'table: fact_orders',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'segments', 'finance', 'high_value_orders.yaml'), [
      'name: high_value_orders',
      'label: High Value Orders',
      'description: Orders above threshold',
      'domain: finance',
      'cube: orders',
      'sql: |',
      '  amount > 1000',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'pre_aggregations', 'finance', 'orders_daily_rollup.yaml'), [
      'name: orders_daily_rollup',
      'label: Orders Daily Rollup',
      'description: Daily rollup for finance',
      'domain: finance',
      'cube: orders',
      'measures:',
      '  - order_total',
      'dimensions:',
      '  - order_status',
      'time_dimension: ordered_at',
      'granularity: day',
      'refresh_key: every 1 hour',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'cubes', 'finance', 'orders.yaml'), [
      'name: orders',
      'label: Orders',
      'description: Finance orders cube',
      'domain: finance',
      'table: fact_orders',
      'sql: |',
      '  SELECT * FROM fact_orders',
      'measures:',
      '  - name: order_total',
      '    label: Order Total',
      '    description: Cube metric',
      '    sql: |',
      '      SUM(amount)',
      '    type: sum',
      'dimensions:',
      '  - name: order_status',
      '    label: Order Status',
      '    description: Order status',
      '    sql: |',
      '      status',
      '    type: string',
      'time_dimensions:',
      '  - name: ordered_at',
      '    label: Ordered At',
      '    description: Order timestamp',
      '    sql: |',
      '      ordered_at',
      '    granularities:',
      '      - day',
      '      - month',
      '',
    ].join('\n'));

    const layer = loadSemanticLayerFromDir(semanticDir);

    expect(layer.getMetric('gross_revenue')?.domain).toBe('finance');
    expect(layer.getDimension('sales_channel')?.domain).toBe('finance');
    expect(layer.getCube('orders')?.measures.map((metric) => metric.name)).toContain('order_total');
    expect(layer.listSegments('finance').map((segment) => segment.name)).toEqual(['high_value_orders']);
    expect(layer.listPreAggregations('finance').map((preAggregation) => preAggregation.name)).toEqual(['orders_daily_rollup']);
    expect(layer.listDomains()).toEqual(['finance']);
    expect(layer.listTags()).toContain('finance');
  });
});
