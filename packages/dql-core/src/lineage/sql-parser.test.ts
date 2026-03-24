import { describe, it, expect } from 'vitest';
import { extractTablesFromSql } from './sql-parser.js';

describe('extractTablesFromSql', () => {
  it('extracts a single table from a simple SELECT', () => {
    const result = extractTablesFromSql('SELECT * FROM orders');
    expect(result.tables).toEqual(['orders']);
    expect(result.ctes).toEqual([]);
    expect(result.refs).toEqual([]);
  });

  it('extracts multiple tables from JOINs', () => {
    const result = extractTablesFromSql(`
      SELECT o.id, c.name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN products p ON o.product_id = p.id
    `);
    expect(result.tables).toContain('orders');
    expect(result.tables).toContain('customers');
    expect(result.tables).toContain('products');
    expect(result.tables).toHaveLength(3);
  });

  it('extracts schema-qualified table names', () => {
    const result = extractTablesFromSql('SELECT * FROM analytics.fct_revenue');
    expect(result.tables).toContain('analytics.fct_revenue');
  });

  it('extracts quoted table names', () => {
    const result = extractTablesFromSql('SELECT * FROM "my-table"');
    expect(result.tables).toContain('my-table');
  });

  it('filters out CTE names', () => {
    const result = extractTablesFromSql(`
      WITH monthly_revenue AS (
        SELECT date_trunc('month', created_at) AS month, SUM(amount) AS revenue
        FROM orders
      )
      SELECT * FROM monthly_revenue
    `);
    expect(result.tables).toEqual(['orders']);
    expect(result.ctes).toEqual(['monthly_revenue']);
  });

  it('handles multiple CTEs', () => {
    const result = extractTablesFromSql(`
      WITH
        active_customers AS (
          SELECT * FROM customers WHERE status = 'active'
        ),
        recent_orders AS (
          SELECT * FROM orders WHERE created_at > '2024-01-01'
        )
      SELECT ac.name, ro.amount
      FROM active_customers ac
      JOIN recent_orders ro ON ac.id = ro.customer_id
    `);
    expect(result.tables).toContain('customers');
    expect(result.tables).toContain('orders');
    expect(result.tables).not.toContain('active_customers');
    expect(result.tables).not.toContain('recent_orders');
    expect(result.ctes).toContain('active_customers');
    expect(result.ctes).toContain('recent_orders');
  });

  it('handles recursive CTEs', () => {
    const result = extractTablesFromSql(`
      WITH RECURSIVE hierarchy AS (
        SELECT id, parent_id, name FROM departments WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, d.parent_id, d.name FROM departments d
        JOIN hierarchy h ON d.parent_id = h.id
      )
      SELECT * FROM hierarchy
    `);
    expect(result.tables).toContain('departments');
    expect(result.tables).not.toContain('hierarchy');
    expect(result.ctes).toContain('hierarchy');
  });

  it('extracts ref() calls', () => {
    const result = extractTablesFromSql(`
      SELECT * FROM ref("revenue_by_segment")
      JOIN ref('customer_metrics') ON 1=1
    `);
    expect(result.refs).toContain('revenue_by_segment');
    expect(result.refs).toContain('customer_metrics');
  });

  it('ignores tables inside string literals', () => {
    const result = extractTablesFromSql(`
      SELECT 'FROM fake_table' AS label FROM real_table
    `);
    expect(result.tables).toContain('real_table');
    expect(result.tables).not.toContain('fake_table');
  });

  it('ignores tables inside comments', () => {
    const result = extractTablesFromSql(`
      -- FROM commented_table
      SELECT * FROM actual_table
      /* FROM another_comment */
    `);
    expect(result.tables).toContain('actual_table');
    expect(result.tables).not.toContain('commented_table');
    expect(result.tables).not.toContain('another_comment');
  });

  it('filters out DuckDB functions like read_csv_auto', () => {
    const result = extractTablesFromSql(`
      SELECT * FROM read_csv_auto('./data/orders.csv')
    `);
    expect(result.tables).not.toContain('read_csv_auto');
  });

  it('handles subqueries without extracting them as tables', () => {
    const result = extractTablesFromSql(`
      SELECT * FROM orders
      WHERE customer_id IN (SELECT id FROM customers WHERE tier = 'gold')
    `);
    expect(result.tables).toContain('orders');
    expect(result.tables).toContain('customers');
  });

  it('handles UNION queries', () => {
    const result = extractTablesFromSql(`
      SELECT id, name FROM customers
      UNION ALL
      SELECT id, name FROM prospects
    `);
    expect(result.tables).toContain('customers');
    expect(result.tables).toContain('prospects');
  });

  it('returns empty for a query with no tables', () => {
    const result = extractTablesFromSql("SELECT 1 AS one, 'hello' AS greeting");
    expect(result.tables).toEqual([]);
    expect(result.ctes).toEqual([]);
    expect(result.refs).toEqual([]);
  });

  it('handles case-insensitive FROM/JOIN', () => {
    const result = extractTablesFromSql('select * from Orders join Customers on 1=1');
    expect(result.tables).toContain('Orders');
    expect(result.tables).toContain('Customers');
  });

  it('handles INSERT INTO', () => {
    const result = extractTablesFromSql(`
      INSERT INTO target_table
      SELECT * FROM source_table
    `);
    expect(result.tables).toContain('target_table');
    expect(result.tables).toContain('source_table');
  });

  it('does not extract ref() calls inside comments', () => {
    const result = extractTablesFromSql(`
      -- ref("old_block") was removed
      SELECT * FROM actual_table
    `);
    expect(result.refs).toEqual([]);
    expect(result.tables).toContain('actual_table');
  });

  it('does not extract ref() calls inside string literals', () => {
    const result = extractTablesFromSql(`
      SELECT 'ref("fake")' AS label FROM real_table
    `);
    expect(result.refs).toEqual([]);
    expect(result.tables).toContain('real_table');
  });

  it('returns deduplicated table names', () => {
    const result = extractTablesFromSql(`
      SELECT a.id FROM orders a
      JOIN orders b ON a.id = b.id
    `);
    const orderCount = result.tables.filter((t) => t === 'orders').length;
    expect(orderCount).toBe(1);
  });

  it('handles empty SQL string', () => {
    const result = extractTablesFromSql('');
    expect(result.tables).toEqual([]);
    expect(result.ctes).toEqual([]);
    expect(result.refs).toEqual([]);
  });

  it('handles DQL triple-quoted SQL with read_csv_auto', () => {
    const result = extractTablesFromSql(`
      SELECT segment_tier AS segment, SUM(amount) AS revenue
      FROM read_csv_auto('./data/revenue.csv')
      GROUP BY segment_tier
    `);
    expect(result.tables).toEqual([]);
  });
});
