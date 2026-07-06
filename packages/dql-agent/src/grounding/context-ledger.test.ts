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
