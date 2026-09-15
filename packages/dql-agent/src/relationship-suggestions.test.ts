import { describe, expect, it } from 'vitest';
import { suggestRelationshipKeys } from './relationship-suggestions.js';
import { profileRelationshipOnWarehouse, proposeRelationshipCardinality } from './relationship-validation.js';

describe('relationship key suggestions', () => {
  it('puts the dbt test first and reads a test declared on the other model the right way round', () => {
    const suggestions = suggestRelationshipKeys({
      fromColumns: ['order_id', 'customer_id', 'location_id'],
      toColumns: ['customer_id', 'customer_name'],
      fromRelation: 'dev.orders',
      toRelation: 'dev.customers',
      dbtTests: [{ fromColumn: 'customer_id', toColumn: 'customer_id', reversed: true, testName: 'relationships_orders_customer_id' }],
    });
    expect(suggestions[0]).toMatchObject({ source: 'dbt_test', keys: [{ from: 'customer_id', to: 'customer_id' }] });
    // The same pair is not offered twice under a weaker reason.
    expect(suggestions.filter((item) => item.keys[0]!.from === 'customer_id')).toHaveLength(1);
  });

  it('matches a key named for the other table to its id, through stg_/plural prefixes', () => {
    expect(suggestRelationshipKeys({ fromColumns: ['id', 'customer_id'], toColumns: ['id', 'name'], fromRelation: 'dev.stg_orders', toRelation: 'dev.stg_customers' })[0])
      .toMatchObject({ source: 'named_for_table', keys: [{ from: 'customer_id', to: 'id' }] });
    expect(suggestRelationshipKeys({ fromColumns: ['id'], toColumns: ['category_id', 'id'], fromRelation: 'categories', toRelation: 'products' })[0])
      .toMatchObject({ source: 'named_for_table', keys: [{ from: 'id', to: 'category_id' }] });
  });

  it('prefers the shared key named for a table over other shared identifiers, and ignores plain id', () => {
    const suggestions = suggestRelationshipKeys({ fromColumns: ['location_id', 'order_id', 'id'], toColumns: ['order_id', 'location_id', 'id'], fromRelation: 'order_items', toRelation: 'orders' });
    expect(suggestions.map((item) => item.keys[0]!.from)).toEqual(['order_id', 'location_id']);
  });

  it('suggests nothing when no column reads like a key', () => {
    expect(suggestRelationshipKeys({ fromColumns: ['amount'], toColumns: ['name'] })).toEqual([]);
  });
});

describe('relationship profile', () => {
  it('proposes the cardinality the warehouse shows, with the fanout that follows', () => {
    expect(proposeRelationshipCardinality({ fromRows: 10, toRows: 5, maxFromPerKey: 4, maxToPerKey: 1 })).toEqual({ cardinality: 'many_to_one', fanout: 'safe' });
    expect(proposeRelationshipCardinality({ fromRows: 5, toRows: 10, maxFromPerKey: 1, maxToPerKey: 4 })).toEqual({ cardinality: 'one_to_many', fanout: 'safe' });
    expect(proposeRelationshipCardinality({ fromRows: 5, toRows: 5, maxFromPerKey: 1, maxToPerKey: 1 })).toEqual({ cardinality: 'one_to_one', fanout: 'safe' });
    expect(proposeRelationshipCardinality({ fromRows: 5, toRows: 5, maxFromPerKey: 2, maxToPerKey: 3 })).toEqual({ cardinality: 'many_to_many', fanout: 'forbidden' });
    expect(proposeRelationshipCardinality({ fromRows: 0, toRows: 5, maxFromPerKey: 0, maxToPerKey: 1 })).toEqual({ cardinality: 'unknown', fanout: 'unknown' });
  });

  it('runs one statement and returns evidence that passes for the proposed many-to-one join', async () => {
    const statements: string[] = [];
    const profile = await profileRelationshipOnWarehouse(
      { fromRelation: 'dev.orders', toRelation: 'dev.customers', keys: [{ from: 'customer_id', to: 'customer_id' }] },
      async (sql) => {
        statements.push(sql);
        return { rows: [{ from_rows: 61948, to_rows: 935, joined_rows: 61948, from_null_keys: 0, to_null_keys: 0, unmatched_from: 0, max_from_per_key: 181, max_to_per_key: 1 }] };
      },
      (identifier) => `"${identifier}"`,
      new Date('2026-09-15T00:00:00Z'),
    );
    expect(statements).toHaveLength(1);
    expect(profile.proposed).toEqual({ cardinality: 'many_to_one', fanout: 'safe' });
    expect(profile.evidence).toMatchObject({ status: 'passed', maxFromPerKey: 181, maxToPerKey: 1, unmatchedFrom: 0 });
  });

  it('fails the evidence of a many-to-many join', async () => {
    const profile = await profileRelationshipOnWarehouse(
      { fromRelation: 'a', toRelation: 'b', keys: [{ from: 'k', to: 'k' }] },
      async () => ({ rows: [{ from_rows: 10, to_rows: 10, joined_rows: 40, max_from_per_key: 2, max_to_per_key: 2 }] }),
      (identifier) => identifier,
    );
    expect(profile.proposed.cardinality).toBe('many_to_many');
    expect(profile.evidence.status).toBe('failed');
  });
});
