import { describe, expect, it } from 'vitest';
import { analyzeSqlReferences } from '@duckcodeailabs/dql-core';
import { buildGrainLedger, detectFanoutRisks, type GrainLedger } from './grain-ledger.js';
import { extractDbtUniqueColumns } from './catalog.js';
import type { MetadataObject } from './catalog.js';

// Ledger matching the jaffle-supply-chain grains (one row per: order, order line, customer, supply).
function jaffleLedger(): GrainLedger {
  return new Map([
    ['fct_orders', { relation: 'fct_orders', uniqueKeys: new Set(['order_id']), source: 'test' }],
    ['order_items', { relation: 'order_items', uniqueKeys: new Set(['order_item_id']), source: 'test' }],
    ['dim_customers', { relation: 'dim_customers', uniqueKeys: new Set(['customer_id']), source: 'test' }],
    ['supplies', { relation: 'supplies', uniqueKeys: new Set(['supply_id']), source: 'test' }],
  ]);
}

function risks(sql: string, ledger: GrainLedger) {
  return detectFanoutRisks(analyzeSqlReferences(sql), ledger);
}

describe('detectFanoutRisks (W1.3)', () => {
  const ledger = jaffleLedger();

  it('flags trap 1: revenue per customer fanned out through order_items', () => {
    const found = risks(
      `SELECT c.customer_name, SUM(o.order_total) AS revenue
       FROM fct_orders o
       JOIN dim_customers c ON o.customer_id = c.customer_id
       JOIN order_items oi ON oi.order_id = o.order_id
       GROUP BY c.customer_name`,
      ledger,
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].aggregatedRelation).toBe('fct_orders');
    expect(found[0].fanoutRelation).toBe('order_items');
  });

  it('does NOT flag the grain-safe revenue per customer (order grain, no order_items join)', () => {
    const found = risks(
      `SELECT c.customer_name, SUM(o.order_total) AS revenue
       FROM fct_orders o
       JOIN dim_customers c ON o.customer_id = c.customer_id
       GROUP BY c.customer_name`,
      ledger,
    );
    expect(found).toEqual([]);
  });

  it('flags trap 3: perishable revenue fanned out across supply rows', () => {
    const found = risks(
      `SELECT SUM(oi.product_price) AS revenue
       FROM order_items oi
       JOIN supplies s ON s.product_id = oi.product_id
       WHERE s.is_perishable_supply = true`,
      ledger,
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].fanoutRelation).toBe('supplies');
  });

  it('does NOT flag the grain-safe EXISTS form (no join)', () => {
    const found = risks(
      `SELECT SUM(oi.product_price) AS revenue
       FROM order_items oi
       WHERE EXISTS (SELECT 1 FROM supplies s WHERE s.product_id = oi.product_id AND s.is_perishable_supply = true)`,
      ledger,
    );
    expect(found).toEqual([]);
  });

  it('does NOT flag a safe N:1 join (aggregating the many side)', () => {
    // SUM(order_total) with only the dim_customers join: dim is 1 row per order → safe.
    const found = risks(
      `SELECT c.customer_name, SUM(o.order_total) AS revenue
       FROM fct_orders o JOIN dim_customers c ON o.customer_id = c.customer_id
       GROUP BY c.customer_name`,
      ledger,
    );
    expect(found).toEqual([]);
  });

  it('does NOT flag COUNT(DISTINCT ...) — distinct is fan-out safe', () => {
    const found = risks(
      `SELECT COUNT(DISTINCT o.order_id) AS orders
       FROM fct_orders o JOIN order_items oi ON oi.order_id = o.order_id`,
      ledger,
    );
    expect(found).toEqual([]);
  });

  it('is conservative: empty ledger yields no flags', () => {
    const found = risks(
      `SELECT SUM(o.order_total) FROM fct_orders o JOIN order_items oi ON oi.order_id = o.order_id`,
      new Map(),
    );
    expect(found).toEqual([]);
  });
});

describe('buildGrainLedger (W1.3)', () => {
  it('reads a single primary-key field from a DataLex entity', () => {
    const entity: MetadataObject = {
      objectKey: 'datalex:entity:sales.Order',
      objectType: 'datalex_entity',
      name: 'Order',
      fullName: 'sales.Order',
      status: 'contract_evidence',
      payload: {
        binding: { ref: 'analytics.fct_orders' },
        fields: [
          { name: 'order_id', primaryKey: true },
          { name: 'customer_id' },
        ],
      },
    } as MetadataObject;
    const ledger = buildGrainLedger([entity]);
    expect(ledger.get('fct_orders')?.uniqueKeys.has('order_id')).toBe(true);
  });

  it('skips composite primary keys (no single column is unique)', () => {
    const entity: MetadataObject = {
      objectKey: 'datalex:entity:sales.Bridge',
      objectType: 'datalex_entity',
      name: 'Bridge',
      fullName: 'sales.Bridge',
      status: 'contract_evidence',
      payload: {
        binding: { ref: 'analytics.order_product_bridge' },
        fields: [
          { name: 'order_id', primaryKey: true },
          { name: 'product_id', primaryKey: true },
        ],
      },
    } as MetadataObject;
    const ledger = buildGrainLedger([entity]);
    expect(ledger.has('order_product_bridge')).toBe(false);
  });

  it('reads unique keys from a dbt model uniqueColumns payload (W5.3)', () => {
    const model: MetadataObject = {
      objectKey: 'dbt:model:fct_orders',
      objectType: 'dbt_model',
      name: 'fct_orders',
      fullName: 'analytics.fct_orders',
      status: 'dbt_catalog',
      payload: { relation: 'analytics.fct_orders', uniqueColumns: ['order_id'] },
    } as MetadataObject;
    const ledger = buildGrainLedger([model]);
    expect(ledger.get('fct_orders')?.uniqueKeys.has('order_id')).toBe(true);
  });
});

describe('extractDbtUniqueColumns (W5.3)', () => {
  it('extracts single-column unique tests keyed by model name', () => {
    const nodes = {
      'test.pkg.unique_fct_orders_order_id': {
        resource_type: 'test',
        test_metadata: { name: 'unique', kwargs: { column_name: 'order_id' } },
        depends_on: { nodes: ['model.pkg.fct_orders'] },
      },
      'test.pkg.unique_dim_customers_customer_id': {
        resource_type: 'test',
        column_name: 'customer_id',
        test_metadata: { name: 'unique' },
        attached_node: 'model.pkg.dim_customers',
      },
      'test.pkg.not_null_x': { resource_type: 'test', test_metadata: { name: 'not_null', kwargs: { column_name: 'x' } }, attached_node: 'model.pkg.fct_orders' },
      'model.pkg.fct_orders': { resource_type: 'model', name: 'fct_orders' },
    } as Record<string, Record<string, unknown>>;
    const map = extractDbtUniqueColumns(nodes);
    expect(map.get('fct_orders')).toEqual(['order_id']); // not_null ignored
    expect(map.get('dim_customers')).toEqual(['customer_id']);
  });
});
