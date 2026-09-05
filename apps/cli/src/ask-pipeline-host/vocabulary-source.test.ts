import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { modelingJoinPaths } from './host.js';
import { normalizeRelationName, parseMetricFilter, qualifyExpression } from './vocabulary-source.js';

describe('vocabulary source helpers', () => {
  it('qualifies bare columns in a measure expression, leaving keywords, functions and literals alone', () => {
    expect(qualifyExpression('case when is_drink_item then product_price else 0 end', 'dev.order_items', ['product_price']))
      .toBe('case when "dev"."order_items"."is_drink_item" then "dev"."order_items"."product_price" else 0 end');
    expect(qualifyExpression("coalesce(status, 'unknown')", 'dev.orders', [])).toBe('coalesce("dev"."orders"."status", \'unknown\')');
    expect(qualifyExpression('1', 'dev.orders', [])).toBe('1');
    expect(qualifyExpression('"dev"."orders"."order_total" * 2', 'dev.orders', ['order_total'])).toBe('"dev"."orders"."order_total" * 2');
  });
  it('reads a MetricFlow where filter into a column and a condition', () => {
    expect(parseMetricFilter({ where_filters: [{ where_sql_template: "{{ Dimension('order_id__is_drink_order') }} = true\n" }] }))
      .toEqual([{ column: 'is_drink_order', entityPath: ['order_id'], condition: '= true' }]);
    expect(parseMetricFilter("{{ Dimension('order_id__order_total_dim') }} >= 20")).toEqual([{ column: 'order_total_dim', entityPath: ['order_id'], condition: '>= 20' }]);
    expect(parseMetricFilter(null)).toEqual([]);
  });
  it('normalizes three-part relation names to schema.table', () => {
    expect(normalizeRelationName('"jaffle_shop"."dev"."customers"')).toBe('dev.customers');
    expect(normalizeRelationName('dev.orders')).toBe('dev.orders');
    expect(normalizeRelationName(undefined)).toBeUndefined();
  });
});

describe('declared relationship join paths', () => {
  const manifest = {
    modeling: {
      entities: {
        supply: { id: 'supply', localId: 'supply', qualifiedId: 'commerce.supply', dbtUniqueId: 'model.jaffle_shop.supplies' },
        product: { id: 'product', localId: 'product', qualifiedId: 'commerce.product', dbtUniqueId: 'model.jaffle_shop.products' },
        order_item: { id: 'order_item', localId: 'order_item', qualifiedId: 'commerce.order_item', dbtUniqueId: 'model.jaffle_shop.order_items' },
      },
      relationships: {
        supply_to_product: { id: 'supply_to_product', from: 'supply', to: 'product', keys: [{ from: 'product_id', to: 'product_id' }], status: 'draft' },
        order_item_to_product: { id: 'order_item_to_product', from: 'order_item', to: 'product', keys: [{ from: 'product_id', to: 'product_id' }], status: 'deprecated' },
      },
    },
    dbtProvenance: {
      nodes: {
        'model.jaffle_shop.supplies': { relation: '"jaffle_shop"."dev"."supplies"' },
        'model.jaffle_shop.products': { relation: '"jaffle_shop"."dev"."products"' },
        'model.jaffle_shop.order_items': { relation: '"jaffle_shop"."dev"."order_items"' },
      },
    },
  } as unknown as DQLManifest;
  const quote = (relation: string) => relation.split('.').map((part) => `"${part}"`).join('.');
  const joinPath = modelingJoinPaths(manifest, quote);
  it('walks a declared relationship in either direction and renders the key equality', () => {
    expect(joinPath('dev.supplies', 'dev.products')).toEqual([{ relation: 'dev.products', on: '"dev"."supplies".product_id = "dev"."products".product_id' }]);
    expect(joinPath('dev.products', 'dev.supplies')).toEqual([{ relation: 'dev.supplies', on: '"dev"."supplies".product_id = "dev"."products".product_id' }]);
  });
  it('a deprecated relationship never joins, and a missing manifest yields no path', () => {
    expect(joinPath('dev.order_items', 'dev.products')).toBeUndefined();
    expect(joinPath('dev.order_items', 'dev.supplies')).toBeUndefined();
    expect(modelingJoinPaths(undefined, quote)('dev.supplies', 'dev.products')).toBeUndefined();
  });
});
