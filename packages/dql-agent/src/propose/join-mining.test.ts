import { describe, expect, it } from 'vitest';
import { mineJoinPatterns } from './join-mining.js';

describe('mineJoinPatterns (W4.4)', () => {
  it('surfaces a join shape that recurs across >= minSupport blocks', () => {
    const blocks = [
      { name: 'revenue_by_customer', sql: 'SELECT c.name, SUM(o.total) FROM fct_orders o JOIN dim_customers c ON o.customer_id = c.customer_id GROUP BY 1' },
      { name: 'orders_by_customer', sql: 'SELECT c.name, COUNT(*) FROM dim_customers c JOIN fct_orders o ON c.customer_id = o.customer_id GROUP BY 1' },
      { name: 'unrelated', sql: 'SELECT SUM(amount) FROM payments' },
    ];
    const patterns = mineJoinPatterns(blocks, 2);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({
      leftRelation: 'dim_customers',
      leftColumn: 'customer_id',
      rightRelation: 'fct_orders',
      rightColumn: 'customer_id',
      support: 2,
    });
    // Order-independent: both blocks (A JOIN B and B JOIN A) counted once each.
    expect(patterns[0].donorBlocks).toEqual(['orders_by_customer', 'revenue_by_customer']);
  });

  it('ignores a join seen in only one block below minSupport', () => {
    const blocks = [
      { name: 'a', sql: 'SELECT * FROM fct_orders o JOIN dim_products p ON o.product_id = p.product_id' },
    ];
    expect(mineJoinPatterns(blocks, 2)).toEqual([]);
  });

  it('counts a repeated join within one block only once (dedup per block)', () => {
    const blocks = [
      { name: 'a', sql: 'SELECT * FROM fct_orders o JOIN dim_customers c ON o.customer_id = c.customer_id' },
      { name: 'b', sql: 'SELECT * FROM fct_orders o JOIN dim_customers c ON o.customer_id = c.customer_id JOIN dim_customers c2 ON o.customer_id = c2.customer_id' },
    ];
    const patterns = mineJoinPatterns(blocks, 2);
    expect(patterns[0].support).toBe(2); // block b's duplicate join does not inflate support
  });

  it('skips unparseable SQL without throwing', () => {
    const blocks = [{ name: 'bad', sql: 'NOT SQL {{{' }, { name: 'bad2', sql: 'ALSO {{{' }];
    expect(mineJoinPatterns(blocks, 2)).toEqual([]);
  });
});
