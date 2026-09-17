import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from './descriptor.js';
import {
  DatasetAggregateComponentSourceError,
  classifyDatasetAggregateSource,
  compileDatasetAggregateDistinctProbe,
  componentSourceForAlias,
  parseDatasetAggregateComponentSource,
} from './component-proof.node.js';

function descriptor(): DatasetDescriptor {
  return {
    version: 1,
    id: 'customer-daily', kind: 'block', sourceRevision: 'source-v1', snapshotId: 'snapshot-v1',
    contractRef: { kind: 'block_source', id: 'customer-daily', fingerprint: 'contract-v1' },
    binding: { sourceQualifiedId: 'customer-daily', sourceRevision: 'source-v1', contractFingerprint: 'contract-v1', state: 'valid' },
    label: 'Customer daily', lifecycle: 'certified', trust: 'certified',
    grain: { entityIds: ['customer_day'], keyFields: ['customer_day_id', 'order_date'], keyEvidence: 'proof.daily', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true },
    fields: [
      { kind: 'physical', name: 'customer_day_id', qualifiedId: 'field:customer_day_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'customer_id', qualifiedId: 'field:customer_id', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: 'field:order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'] } },
      { kind: 'physical', name: 'region', qualifiedId: 'field:region', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'daily_revenue', qualifiedId: 'field:daily_revenue', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'daily_margin', qualifiedId: 'field:daily_margin', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'daily_orders', qualifiedId: 'field:daily_orders', type: 'number', role: 'attribute', status: 'approved' },
    ],
    operations: ['group', 'trend'], execution: { route: 'certified' },
  };
}

const sourceSql = `
SELECT
  customer_id || ':' || CAST(CAST(order_date AS DATE) AS VARCHAR) AS customer_day_id,
  customer_id,
  CAST(order_date AS DATE) AS order_date,
  region,
  SUM(net_amount) AS daily_revenue,
  SUM(margin_amount) AS daily_margin,
  COUNT(DISTINCT order_id) AS daily_orders
FROM order_lines
WHERE net_amount < 0.1234567890123456789 AND region = $1
GROUP BY customer_id, CAST(order_date AS DATE), region`;

describe('Dataset aggregate source component parser', () => {
  it('classifies a known grouped aggregate even when an author clears the Dataset aggregate declaration', () => {
    expect(classifyDatasetAggregateSource({ sourceSql, driver: 'duckdb' })).toBe('aggregate');
    expect(classifyDatasetAggregateSource({
      sourceSql: 'SELECT order_id, net_amount FROM order_lines',
      driver: 'duckdb',
    })).toBe('row');
  });

  it('preserves exact numeric predicates and all source grouping expressions in a distinct membership probe', () => {
    const source = parseDatasetAggregateComponentSource({ descriptor: descriptor(), sourceSql, driver: 'duckdb' });
    const orders = componentSourceForAlias(source, 'daily_orders');
    expect(orders).toMatchObject({ sourceAggregate: 'count_distinct', countedKeySql: '"order_id"' });
    const probe = compileDatasetAggregateDistinctProbe({ source, component: 'daily_orders' });
    expect(probe.sql).toContain('0.1234567890123456789');
    expect(probe.sql).not.toContain('0.1234567890123456774');
    expect(probe.sql).toContain('$1');
    expect(probe.sql).toContain('GROUP BY "order_id", "customer_id", CAST("order_date" AS DATE), "region"');
    expect(probe.sql).toContain('("order_id") IS NOT NULL');
  });

  it('preserves supported CAST precision and scale in the generated membership probe', () => {
    const source = parseDatasetAggregateComponentSource({
      descriptor: descriptor(),
      sourceSql: sourceSql.replace(
        'net_amount < 0.1234567890123456789 AND region = $1',
        'CAST(net_amount AS DECIMAL(38,19)) < 0.1234567890123456789 AND CAST(region AS VARCHAR(42)) = $1',
      ),
      driver: 'duckdb',
    });
    const probe = compileDatasetAggregateDistinctProbe({ source, component: 'daily_orders' });
    expect(probe.sql).toContain('CAST("net_amount" AS DECIMAL(38, 19))');
    expect(probe.sql).not.toContain('CAST("net_amount" AS DECIMAL)');
    expect(probe.sql).toContain('CAST("region" AS VARCHAR(42))');
  });

  it('refuses a CAST modifier it cannot reproduce without changing source semantics', () => {
    expect(() => parseDatasetAggregateComponentSource({
      descriptor: descriptor(),
      sourceSql: sourceSql.replace(
        'net_amount < 0.1234567890123456789 AND region = $1',
        "CAST(order_date AS TIMESTAMP WITH TIME ZONE) >= '2026-01-01' AND region = $1",
      ),
      driver: 'duckdb',
    })).toThrowError(expect.objectContaining<Partial<DatasetAggregateComponentSourceError>>({
      code: 'DATASET_COMPONENT_EXPRESSION_UNSUPPORTED',
    }));
  });

  it('preserves signed/exponent lexical literals rather than accepting parser-rounded values', () => {
    const source = parseDatasetAggregateComponentSource({
      descriptor: descriptor(),
      sourceSql: sourceSql.replace('0.1234567890123456789', '-9007199254740993').replace('AND region = $1', 'AND margin_amount > 1e-20'),
      driver: 'duckdb',
    });
    const probe = compileDatasetAggregateDistinctProbe({ source, component: 'daily_orders' });
    expect(probe.sql).toContain('- 9007199254740993');
    expect(probe.sql).toContain('1e-20');
  });

  it('refuses volatile or non-deterministic source predicates', () => {
    expect(() => parseDatasetAggregateComponentSource({
      descriptor: descriptor(),
      sourceSql: sourceSql.replace('net_amount < 0.1234567890123456789', 'RANDOM() > 0'),
      driver: 'duckdb',
    })).toThrowError(expect.objectContaining<Partial<DatasetAggregateComponentSourceError>>({
      code: 'DATASET_COMPONENT_EXPRESSION_UNSUPPORTED',
    }));
  });

  it('keeps a direct SUM source structurally eligible on a connector without the DuckDB distinct scope', () => {
    const source = parseDatasetAggregateComponentSource({
      descriptor: descriptor(),
      sourceSql: `
        SELECT
          customer_day_id AS customer_day_id,
          order_date AS order_date,
          SUM(net_amount) AS daily_revenue,
          SUM(margin_amount) AS daily_margin,
          COUNT(DISTINCT order_id) AS daily_orders
        FROM order_lines
        GROUP BY customer_day_id, order_date`,
      driver: 'sqlite',
    });
    expect(componentSourceForAlias(source, 'daily_revenue')).toMatchObject({ sourceAggregate: 'sum' });
    // The parser can establish an exact direct mapping here. A caller that
    // also selects daily_orders still needs a connector-specific scoped proof
    // at runtime; this test deliberately makes no such claim for SQLite.
    expect(componentSourceForAlias(source, 'daily_orders')).toMatchObject({ sourceAggregate: 'count_distinct' });
  });
});
