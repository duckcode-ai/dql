import { describe, it, expect } from 'vitest';
import {
  resolveDependencies,
  getUpstream,
  getDownstream,
  type BlockDependencyInfo,
} from './dependency-resolver.js';

describe('resolveDependencies', () => {
  it('resolves a simple linear chain via ref()', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'raw_orders', sql: 'SELECT * FROM orders' },
      { name: 'cleaned_orders', sql: 'SELECT * FROM ref("raw_orders") WHERE valid = true' },
      { name: 'order_metrics', sql: 'SELECT count(*) FROM ref("cleaned_orders")' },
    ];

    const result = resolveDependencies(blocks);
    expect(result.cycles).toEqual([]);

    const rawIdx = result.executionOrder.indexOf('raw_orders');
    const cleanIdx = result.executionOrder.indexOf('cleaned_orders');
    const metricIdx = result.executionOrder.indexOf('order_metrics');
    expect(rawIdx).toBeLessThan(cleanIdx);
    expect(cleanIdx).toBeLessThan(metricIdx);
  });

  it('resolves implicit dependencies via SQL table names matching block names', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'customers', sql: "SELECT * FROM read_csv_auto('./data/customers.csv')" },
      { name: 'customer_summary', sql: 'SELECT tier, count(*) FROM customers GROUP BY tier' },
    ];

    const result = resolveDependencies(blocks);
    expect(result.cycles).toEqual([]);
    expect(result.dependencyMap.get('customer_summary')).toContain('customers');

    const custIdx = result.executionOrder.indexOf('customers');
    const summIdx = result.executionOrder.indexOf('customer_summary');
    expect(custIdx).toBeLessThan(summIdx);
  });

  it('detects circular dependencies', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'block_a', sql: 'SELECT * FROM ref("block_b")' },
      { name: 'block_b', sql: 'SELECT * FROM ref("block_c")' },
      { name: 'block_c', sql: 'SELECT * FROM ref("block_a")' },
    ];

    const result = resolveDependencies(blocks);
    expect(result.cycles.length).toBeGreaterThan(0);
    // Not all blocks can be in execution order
    expect(result.executionOrder.length).toBeLessThan(3);
  });

  it('handles blocks with no dependencies', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'standalone_a', sql: "SELECT 1 AS num" },
      { name: 'standalone_b', sql: "SELECT 'hello' AS greeting" },
    ];

    const result = resolveDependencies(blocks);
    expect(result.cycles).toEqual([]);
    expect(result.executionOrder).toHaveLength(2);
    expect(result.executionOrder).toContain('standalone_a');
    expect(result.executionOrder).toContain('standalone_b');
  });

  it('handles diamond dependencies', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'source', sql: 'SELECT * FROM external_data' },
      { name: 'path_a', sql: 'SELECT * FROM ref("source") WHERE type = \'a\'' },
      { name: 'path_b', sql: 'SELECT * FROM ref("source") WHERE type = \'b\'' },
      { name: 'combined', sql: 'SELECT * FROM ref("path_a") UNION ALL SELECT * FROM ref("path_b")' },
    ];

    const result = resolveDependencies(blocks);
    expect(result.cycles).toEqual([]);

    const srcIdx = result.executionOrder.indexOf('source');
    const aIdx = result.executionOrder.indexOf('path_a');
    const bIdx = result.executionOrder.indexOf('path_b');
    const combIdx = result.executionOrder.indexOf('combined');

    expect(srcIdx).toBeLessThan(aIdx);
    expect(srcIdx).toBeLessThan(bIdx);
    expect(aIdx).toBeLessThan(combIdx);
    expect(bIdx).toBeLessThan(combIdx);
  });

  it('handles materialized name mapping', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'revenue_block', sql: 'SELECT * FROM sales', materializedAs: 'fct_revenue' },
      { name: 'dashboard', sql: 'SELECT * FROM fct_revenue' },
    ];

    const result = resolveDependencies(blocks);
    expect(result.dependencyMap.get('dashboard')).toContain('revenue_block');
  });

  it('builds correct dependents (reverse) map', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'base', sql: 'SELECT 1' },
      { name: 'child_a', sql: 'SELECT * FROM ref("base")' },
      { name: 'child_b', sql: 'SELECT * FROM ref("base")' },
    ];

    const result = resolveDependencies(blocks);
    expect(result.dependentsMap.get('base')).toContain('child_a');
    expect(result.dependentsMap.get('base')).toContain('child_b');
  });
});

describe('getUpstream', () => {
  it('returns transitive upstream dependencies', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'a', sql: 'SELECT 1' },
      { name: 'b', sql: 'SELECT * FROM ref("a")' },
      { name: 'c', sql: 'SELECT * FROM ref("b")' },
    ];

    const result = resolveDependencies(blocks);
    const upstream = getUpstream('c', result.dependencyMap);
    expect(upstream).toContain('a');
    expect(upstream).toContain('b');
    expect(upstream).not.toContain('c');
  });
});

describe('getDownstream', () => {
  it('returns transitive downstream dependents', () => {
    const blocks: BlockDependencyInfo[] = [
      { name: 'a', sql: 'SELECT 1' },
      { name: 'b', sql: 'SELECT * FROM ref("a")' },
      { name: 'c', sql: 'SELECT * FROM ref("b")' },
    ];

    const result = resolveDependencies(blocks);
    const downstream = getDownstream('a', result.dependentsMap);
    expect(downstream).toContain('b');
    expect(downstream).toContain('c');
    expect(downstream).not.toContain('a');
  });
});
