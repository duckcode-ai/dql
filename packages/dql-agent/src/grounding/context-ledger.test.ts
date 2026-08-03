import { describe, expect, it } from 'vitest';
import { createContextLedger } from './context-ledger.js';

describe('ContextLedger', () => {
  it('qualifies bare SQL relations through the runtime schema context', () => {
    const ledger = createContextLedger({
      schemaContext: [{
        relation: 'dev.order_items',
        name: 'order_items',
        columns: [{ name: 'order_id' }, { name: 'product_price' }],
      }],
    });

    const qualified = ledger.qualifySql('SELECT order_id FROM order_items');

    expect(qualified.sql).toBe('SELECT order_id FROM dev.order_items');
    expect(qualified.rewrites).toEqual([{ from: 'order_items', to: 'dev.order_items' }]);
  });

  it('qualifies graph relation identities through the same runtime schema context', () => {
    const ledger = createContextLedger({
      schemaContext: [{
        relation: 'dev_kkondapaka_reporting.consumption_metrics.consumption_daily_metrics_header_combined',
        name: 'consumption_daily_metrics_header_combined',
        columns: [{ name: 'mthly_fcst_consumption_eff_amt' }],
      }],
      dialect: 'snowflake',
    });

    const qualified = ledger.qualifySql(
      'SELECT SUM(mthly_fcst_consumption_eff_amt) FROM source::dev_kkondapaka_reporting.consumption_metrics.consumption_daily_metrics_header_combined',
    );

    expect(qualified.sql).toContain(
      'FROM dev_kkondapaka_reporting.consumption_metrics.consumption_daily_metrics_header_combined',
    );
    expect(ledger.validateSql(qualified.sql).ok).toBe(true);
  });

  it('decodes qualified graph identities when runtime schema retrieval is empty', () => {
    const ledger = createContextLedger({ schemaContext: [], dialect: 'snowflake' });

    const qualified = ledger.qualifySql(
      'SELECT order_id FROM source::analytics.reporting.orders',
    );

    expect(qualified.sql).toBe('SELECT order_id FROM analytics.reporting.orders');
    expect(qualified.rewrites).toEqual([{
      from: 'source::analytics.reporting.orders',
      to: 'analytics.reporting.orders',
    }]);
  });

  it('keeps bare graph identities unresolved without a unique runtime relation', () => {
    const ledger = createContextLedger({ schemaContext: [] });

    expect(ledger.qualifySql('SELECT order_id FROM source::orders')).toEqual({
      sql: 'SELECT order_id FROM source::orders',
      rewrites: [],
    });
  });

  it('validates SQL against the same runtime schema context used for qualification', () => {
    const ledger = createContextLedger({
      schemaContext: [{
        relation: 'dev.order_items',
        name: 'order_items',
        columns: [{ name: 'order_id' }, { name: 'product_price' }],
      }],
    });
    const sql = ledger.qualifySql('SELECT product_price FROM order_items').sql;

    expect(ledger.validateSql(sql).ok).toBe(true);
    expect(ledger.validateSql('SELECT supply_name FROM dev.supplies')).toMatchObject({
      ok: false,
      code: 'unknown_relation',
      offending: { relation: 'dev.supplies' },
    });
  });

  it('does not reintroduce stale catalog columns after complete target verification', () => {
    const ledger = createContextLedger({
      contextPack: {
        allowedSqlContext: {
          relations: [{
            relation: 'jaffle_shop.main.dim_customers',
            name: 'dim_customers',
            source: 'dbt metadata',
            columnCompleteness: 'partial',
            columns: [
              { name: 'customer_id' },
              { name: 'customer_name', description: 'Stale declared customer name' },
            ],
          }],
          sourceBlockSql: [],
        },
      } as never,
      schemaContext: [{
        relation: 'jaffle_shop.main.dim_customers',
        name: 'dim_customers',
        columns: [{ name: 'customer_id' }, { name: 'name' }],
      }],
    });

    expect(ledger.validateSql('SELECT name FROM jaffle_shop.main.dim_customers').ok).toBe(true);
    expect(ledger.validateSql('SELECT customer_name FROM jaffle_shop.main.dim_customers')).toMatchObject({
      ok: false,
      code: 'unknown_column',
      offending: { column: 'customer_name' },
    });
  });

  it('merges grounding expansion into the validation and qualification ledger', () => {
    const ledger = createContextLedger({
      schemaContext: [{
        relation: 'dev.order_items',
        name: 'order_items',
        columns: [{ name: 'product_id' }, { name: 'product_price' }],
      }],
    });

    const expanded = ledger.withExpansion({
      relations: [{
        relation: 'dev.supplies',
        name: 'supplies',
        source: 'runtime schema snapshot',
        columnCompleteness: 'complete',
        columns: [{ name: 'product_id' }, { name: 'supply_name' }],
      }],
      notes: ['dev.supplies columns: product_id, supply_name'],
    });

    expect(expanded.notes).toEqual(['dev.supplies columns: product_id, supply_name']);
    const sql = expanded.ledger.qualifySql([
      'SELECT oi.product_id, s.supply_name',
      'FROM order_items oi',
      'JOIN supplies s ON oi.product_id = s.product_id',
    ].join('\n')).sql;

    expect(sql).toContain('FROM dev.order_items oi');
    expect(sql).toContain('JOIN dev.supplies s');
    expect(expanded.ledger.validateSql(sql).ok).toBe(true);
  });
});
