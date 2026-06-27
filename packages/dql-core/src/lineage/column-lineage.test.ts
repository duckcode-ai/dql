import { describe, it, expect } from 'vitest';
import { extractColumnLineage, extractRefColumnUsage } from './column-lineage.js';

describe('extractColumnLineage — Phase 2.4', () => {
  it('reports plain SELECT * as a single unresolved entry', () => {
    const result = extractColumnLineage('SELECT * FROM customers');
    expect(result.parsed).toBe(true);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].name).toBe('*');
    expect(result.columns[0].unresolved).toBe(true);
  });

  it('extracts simple column references with single-table source', () => {
    const result = extractColumnLineage('SELECT customer_id, customer_email FROM dim_customers');
    expect(result.tables).toEqual(['dim_customers']);
    expect(result.columns).toEqual([
      { name: 'customer_id', sources: [{ table: 'dim_customers', column: 'customer_id' }] },
      { name: 'customer_email', sources: [{ table: 'dim_customers', column: 'customer_email' }] },
    ]);
  });

  it('honors explicit AS alias on bare columns', () => {
    const result = extractColumnLineage(
      'SELECT customer_id AS id FROM dim_customers',
    );
    expect(result.columns[0].name).toBe('id');
    expect(result.columns[0].sources).toEqual([
      { table: 'dim_customers', column: 'customer_id' },
    ]);
  });

  it('resolves qualified column references through table aliases', () => {
    const result = extractColumnLineage(
      'SELECT c.customer_id, c.customer_email FROM dim_customers c',
    );
    expect(result.columns[0].sources[0].table).toBe('dim_customers');
    expect(result.columns[0].sources[0].column).toBe('customer_id');
  });

  it('marks SUM/COUNT/AVG/MIN/MAX as aggregates with the function name', () => {
    const sql = `
      SELECT
        SUM(order_total) AS revenue,
        COUNT(*) AS order_count,
        AVG(order_total) AS avg_order,
        MIN(ordered_at) AS first_order,
        MAX(ordered_at) AS last_order
      FROM fct_orders
    `;
    const result = extractColumnLineage(sql);
    expect(result.columns.map((c) => c.name)).toEqual([
      'revenue',
      'order_count',
      'avg_order',
      'first_order',
      'last_order',
    ]);
    expect(result.columns.every((c) => c.isAggregate)).toBe(true);
    expect(result.columns.map((c) => c.aggregateFn)).toEqual([
      'SUM',
      'COUNT',
      'AVG',
      'MIN',
      'MAX',
    ]);
  });

  it('extracts source columns from inside aggregates', () => {
    const result = extractColumnLineage(
      'SELECT SUM(order_total) AS revenue FROM fct_orders',
    );
    expect(result.columns[0].sources).toEqual([
      { table: 'fct_orders', column: 'order_total' },
    ]);
  });

  it('extracts source columns from binary expressions', () => {
    const result = extractColumnLineage(
      'SELECT (revenue - cost) AS gross_profit FROM fct_orders',
    );
    const entry = result.columns[0];
    expect(entry.name).toBe('gross_profit');
    const cols = entry.sources.map((s) => s.column).sort();
    expect(cols).toEqual(['cost', 'revenue']);
  });

  it('treats numeric literals as columns with no sources', () => {
    const result = extractColumnLineage("SELECT 1 AS one FROM fct_orders");
    expect(result.columns[0].name).toBe('one');
    expect(result.columns[0].sources).toEqual([]);
  });

  it('returns parsed=false on syntactically invalid SQL', () => {
    const result = extractColumnLineage('NOT A QUERY');
    expect(result.parsed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('extracts the matching MAU pattern (jaffle-shop demo)', () => {
    const sql = `
      SELECT
        DATE_TRUNC('month', ordered_at) AS order_month,
        COUNT(DISTINCT customer_id) AS monthly_active_customers
      FROM fct_orders
      WHERE ordered_at IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `;
    const result = extractColumnLineage(sql);
    expect(result.tables).toEqual(['fct_orders']);
    expect(result.columns.map((c) => c.name)).toEqual([
      'order_month',
      'monthly_active_customers',
    ]);
    const customerCount = result.columns[1];
    expect(customerCount.aggregateFn).toBe('COUNT');
    expect(customerCount.sources).toEqual([
      { table: 'fct_orders', column: 'customer_id' },
    ]);
  });

  it('handles multiple-table joins with aliases for source resolution', () => {
    const sql = `
      SELECT
        c.customer_id,
        o.order_id,
        SUM(o.order_total) AS lifetime_spend
      FROM dim_customers c
      JOIN fct_orders o ON c.customer_id = o.customer_id
      GROUP BY 1, 2
    `;
    const result = extractColumnLineage(sql);
    const ids = result.tables.sort();
    expect(ids).toEqual(['dim_customers', 'fct_orders']);
    const spendEntry = result.columns.find((c) => c.name === 'lifetime_spend');
    expect(spendEntry?.sources).toEqual([
      { table: 'fct_orders', column: 'order_total' },
    ]);
    const customerIdEntry = result.columns.find((c) => c.name === 'customer_id');
    expect(customerIdEntry?.sources[0].table).toBe('dim_customers');
  });
});

describe('extractRefColumnUsage — parent → child ref() column usage', () => {
  const sortUsage = (usages: ReturnType<typeof extractRefColumnUsage>) =>
    usages
      .map((u) => ({ block: u.block, columns: [...u.columns].sort() }))
      .sort((a, b) => a.block.localeCompare(b.block));

  it('maps an aliased ref() to the columns the parent references', () => {
    const usage = extractRefColumnUsage(
      `SELECT c.approval_rate_pct, c.region FROM ref("child") c WHERE c.region = 'US'`,
    );
    expect(sortUsage(usage)).toEqual([
      { block: 'child', columns: ['approval_rate_pct', 'region'] },
    ]);
  });

  it('attributes unqualified columns to a sole ref() source', () => {
    const usage = extractRefColumnUsage(`SELECT approval_rate_pct, region FROM ref('child')`);
    expect(sortUsage(usage)).toEqual([
      { block: 'child', columns: ['approval_rate_pct', 'region'] },
    ]);
  });

  it('handles multiple ref() sources joined together', () => {
    // Columns in the JOIN ... ON condition live inside the FROM subtree and are
    // intentionally skipped; only projection/WHERE columns are attributed.
    const usage = extractRefColumnUsage(
      `SELECT a.x, b.y FROM ref("child_a") a JOIN ref("child_b") b ON a.id = b.id WHERE b.active`,
    );
    expect(sortUsage(usage)).toEqual([
      { block: 'child_a', columns: ['x'] },
      { block: 'child_b', columns: ['active', 'y'] },
    ]);
  });

  it('returns nothing for SELECT * (no specific columns referenced)', () => {
    expect(extractRefColumnUsage(`SELECT * FROM ref("child")`)).toEqual([]);
  });

  it('does not attribute unqualified columns when a non-ref table is also present', () => {
    // Ambiguous: `status` could come from either source, so we stay silent.
    const usage = extractRefColumnUsage(
      `SELECT something FROM ref("child") c JOIN raw_table r ON c.id = r.id`,
    );
    // Only qualified ref columns (here only c.id) are attributed.
    expect(usage.every((u) => !u.columns.includes('something'))).toBe(true);
  });

  it('returns nothing when there is no ref() in the FROM clause', () => {
    expect(extractRefColumnUsage(`SELECT a, b FROM plain_table`)).toEqual([]);
  });

  it('returns nothing for unparseable SQL rather than throwing', () => {
    expect(extractRefColumnUsage(`this is not sql ;;;`)).toEqual([]);
  });
});
