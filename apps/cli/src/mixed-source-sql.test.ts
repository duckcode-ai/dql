import { describe, expect, it } from 'vitest';
import {
  findMentionedNotebookDataset,
  buildMixedSourceWarehouseFallbackSql,
  planMixedSourceNotebookSql,
  planMixedSourceSql,
} from './mixed-source-sql.js';

describe('mixed-source SQL repair planning', () => {
  it('turns a direct warehouse plus CSV join into a warehouse extraction', () => {
    const plan = planMixedSourceSql(
      'select a.count_food_items from dev.orders a inner join customers_csv b on a.customer_id = b.id',
      ['customers_csv'],
    );
    expect(plan).toMatchObject({
      localDataset: 'customers_csv',
      localAlias: 'b',
      localKey: 'id',
      warehouseKey: 'customer_id',
    });
    expect(plan?.warehouseSql).toBe(
      'SELECT a.count_food_items, a.customer_id AS "customer_id" FROM dev.orders a',
    );
  });

  it('handles the local key on the left side and keeps an already selected key', () => {
    const plan = planMixedSourceSql(
      'SELECT a.customer_id, a.order_total FROM dev.orders a LEFT JOIN "customers_csv" AS csv ON csv.id = a.customer_id WHERE a.order_total > 0',
      ['customers_csv'],
    );
    expect(plan?.warehouseSql).toBe(
      'SELECT a.customer_id, a.order_total FROM dev.orders a WHERE a.order_total > 0',
    );
  });

  it('refuses ambiguous local joins instead of guessing', () => {
    expect(planMixedSourceSql(
      'select * from dev.orders a join customers_csv b on lower(a.customer_id) = lower(b.id)',
      ['customers_csv'],
    )).toBeNull();
  });
});

describe('mixed-source notebook planning', () => {
  const customers = {
    id: 'customers_csv_1',
    name: 'customers_csv',
    alias: 'customers_csv',
    columns: [{ name: 'id', flags: ['identifier'] }, { name: 'name' }],
  };

  it('safely resolves a singular CSV mention to one registered plural alias', () => {
    expect(findMentionedNotebookDataset('join customer_csv with dev orders', [customers]))
      .toEqual(customers);
  });

  it('prepares a warehouse extraction and customer join keys', () => {
    const plan = planMixedSourceNotebookSql(
      'SELECT o.order_id, o.ordered_at, o.order_total FROM dev.orders o',
      customers,
      [{ relation: 'dev.orders', columns: [{ name: 'order_id' }, { name: 'customer_id' }, { name: 'ordered_at' }, { name: 'order_total' }] }],
    );
    expect(plan).toMatchObject({
      datasetId: 'customers_csv_1',
      localDataset: 'customers_csv',
      localKey: 'id',
      warehouseKey: 'customer_id',
    });
    expect(plan?.warehouseSql).toContain('o.customer_id AS "customer_id"');
  });

  it('prefers an exact registered alias over a singular/plural fuzzy match', () => {
    expect(findMentionedNotebookDataset('use customer csv', [
      customers,
      { ...customers, id: 'other', alias: 'customer_csv', name: 'customer_csv' },
    ])?.id).toBe('other');
  });

  it('builds a validated row-level extraction for the explicitly named warehouse entity', () => {
    expect(buildMixedSourceWarehouseFallbackSql(
      'join customer_csv with dev order tables and list order details',
      customers,
      [
        { relation: 'dev.customers', columns: [{ name: 'customer_id' }] },
        { relation: 'dev.orders', columns: [{ name: 'order_id' }, { name: 'customer_id' }, { name: 'order_total' }] },
      ],
    )).toBe([
      'SELECT',
      '  warehouse.*',
      'FROM dev.orders AS warehouse',
    ].join('\n'));
  });

  it('combines multiple explicitly requested warehouse tables before the CSV stage', () => {
    expect(buildMixedSourceWarehouseFallbackSql(
      'Use customers_csv, dev.orders and dev.locations. Show customer name, order details and store location.',
      customers,
      [
        { relation: 'jaffle_shop.dev.orders', columns: [{ name: 'order_id' }, { name: 'customer_id' }, { name: 'location_id' }, { name: 'order_total' }] },
        { relation: 'dev.orders', columns: [{ name: 'order_id' }, { name: 'customer_id' }, { name: 'location_id' }, { name: 'order_total' }] },
        { relation: 'dev.locations', columns: [{ name: 'location_id' }, { name: 'location_name' }, { name: 'tax_rate' }] },
        { relation: 'dev.customers', columns: [{ name: 'customer_id' }, { name: 'customer_name' }] },
      ],
    )).toBe([
      'SELECT',
      '  warehouse.*,',
      '  warehouse_1."location_name" AS "location_name",',
      '  warehouse_1."tax_rate" AS "tax_rate"',
      'FROM dev.orders AS warehouse',
      'LEFT JOIN dev.locations AS warehouse_1',
      '  ON warehouse."location_id" = warehouse_1."location_id"',
    ].join('\n'));
  });
});
