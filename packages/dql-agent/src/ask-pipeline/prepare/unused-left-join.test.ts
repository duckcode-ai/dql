import { describe, expect, it } from 'vitest';
import { unusedLeftJoins } from './sql-checks.js';

const columns: Record<string, string[]> = {
  orders: ['order_id', 'order_number', 'customer_id'],
  line_items: ['line_item_id', 'order_id', 'amount'],
  refunds: ['line_item_id'],
  customers: ['customer_id', 'segment_id'],
  segments: ['segment_id', 'name'],
};
const columnsOf = (relation: string) => columns[relation.split('.').pop()!.replace(/"/g, '')];

describe('LEFT JOINs that do nothing', () => {
  it('flags a joined table used nowhere else: the restriction it was meant to apply is missing', () => {
    const sql = `SELECT c.order_number, SUM(li.amount) AS refund_amount
FROM "dev"."orders" c
LEFT JOIN "dev"."line_items" li ON li.order_id = c.order_id
LEFT JOIN "dev"."refunds" r ON r.line_item_id = li.line_item_id
GROUP BY c.order_number`;
    expect(unusedLeftJoins(sql, columnsOf)).toEqual(['"dev"."refunds"']);
  });

  it('passes a joined table whose columns are selected, filtered or joined on further', () => {
    const selected = 'SELECT o.order_id, SUM(CASE WHEN r.line_item_id IS NOT NULL THEN li.amount ELSE 0 END) FROM orders o LEFT JOIN line_items li ON li.order_id = o.order_id LEFT JOIN refunds r ON r.line_item_id = li.line_item_id GROUP BY o.order_id';
    const filtered = 'SELECT o.order_id FROM orders o LEFT JOIN refunds r ON r.line_item_id = o.order_id WHERE r.line_item_id IS NULL';
    const chained = 'SELECT o.order_id, s.name FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id LEFT JOIN segments s ON s.segment_id = c.segment_id';
    const noAlias = 'SELECT orders.order_id, line_items.amount FROM orders LEFT JOIN line_items ON line_items.order_id = orders.order_id';
    for (const sql of [selected, filtered, chained, noAlias]) expect(unusedLeftJoins(sql, columnsOf)).toEqual([]);
  });

  it('counts a bare column of the joined table as a use, and never judges a table whose columns are unknown', () => {
    expect(unusedLeftJoins('SELECT o.order_id, amount FROM orders o LEFT JOIN line_items li ON li.order_id = o.order_id', columnsOf)).toEqual([]);
    expect(unusedLeftJoins('SELECT o.order_id FROM orders o LEFT JOIN audit_log a ON a.order_id = o.order_id', columnsOf)).toEqual([]);
  });
});
