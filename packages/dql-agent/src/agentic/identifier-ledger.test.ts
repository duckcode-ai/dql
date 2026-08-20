import { describe, it, expect } from 'vitest';
import { IdentifierLedger, editDistance } from './identifier-ledger.js';

describe('IdentifierLedger', () => {
  it('admits only what a tool observation proved', () => {
    const ledger = new IdentifierLedger();
    expect(ledger.isAdmitted('orders')).toBe(false);
    ledger.admit('compiler', ['analytics.public.orders'], 'compile-1');
    expect(ledger.isAdmitted('analytics.public.orders')).toBe(true);
    expect(ledger.isAdmitted('customers')).toBe(false);
  });

  it('does not let a bare name cross a qualified identity boundary', () => {
    const ledger = new IdentifierLedger();
    ledger.admit('compiler', ['analytics.public.orders'], 'compile-1');
    expect(ledger.isAdmitted('orders')).toBe(false);

    const reverse = new IdentifierLedger();
    reverse.admit('schema_tool', ['orders'], 'schema-1');
    expect(reverse.isAdmitted('analytics.public.orders')).toBe(false);
  });

  it('keeps the strongest provenance rather than the most recent', () => {
    const ledger = new IdentifierLedger();
    ledger.admit('compiler', ['orders'], 'compile-1');
    ledger.admit('catalog', ['orders'], 'catalog-1');
    expect(ledger.entries()[0]).toMatchObject({ source: 'compiler', receiptId: 'compile-1' });
  });

  it('adjudicates references and suggests the nearest admitted name', () => {
    const ledger = new IdentifierLedger();
    ledger.admit('preview', ['customer_name', 'lifetime_spend'], 'preview-1');
    const verdict = ledger.adjudicate({ columns: ['customer_nmae', 'lifetime_spend'] });
    expect(verdict.ok).toBe(false);
    expect(verdict.unadmitted).toEqual(['customer_nmae']);
    expect(verdict.nearest['customer_nmae']).toBe('customer_name');
  });

  it('does not suggest a distant identifier as a correction', () => {
    // A confident wrong "did you mean" sends the model further off course than
    // saying nothing.
    const ledger = new IdentifierLedger();
    ledger.admit('preview', ['customer_name'], 'preview-1');
    const verdict = ledger.adjudicate({ columns: ['gross_margin_pct'] });
    expect(verdict.unadmitted).toEqual(['gross_margin_pct']);
    expect(verdict.nearest['gross_margin_pct']).toBeUndefined();
  });

  it('passes clean SQL through', () => {
    const ledger = new IdentifierLedger();
    ledger.admit('compiler', ['analytics.public.orders'], 'c1');
    ledger.admit('preview', ['analytics.public.orders.order_total'], 'p1');
    expect(ledger.adjudicate({
      relations: ['analytics.public.orders'],
      columns: ['analytics.public.orders.order_total'],
    }))
      .toEqual({ ok: true, unadmitted: [], nearest: {} });
  });

  it('keeps same-named columns isolated by their fully qualified relation', () => {
    const ledger = new IdentifierLedger();
    ledger.admit('schema_tool', ['analytics.orders.id'], 'orders-schema');
    ledger.admit('schema_tool', ['analytics.customers.id'], 'customers-schema');
    expect(ledger.adjudicate({ columns: ['analytics.orders.id'] }, { requireObserved: true }).ok).toBe(true);
    expect(ledger.adjudicate({ columns: ['warehouse.orders.id'] }, { requireObserved: true }))
      .toMatchObject({ ok: false, unadmitted: ['warehouse.orders.id'] });
  });

  it('renders a correction the model can act on, and nothing when clean', () => {
    const ledger = new IdentifierLedger();
    ledger.admit('preview', ['customer_name'], 'p1');
    const failed = ledger.adjudicate({ columns: ['customer_nmae', 'unrelated_thing'] });
    const text = IdentifierLedger.renderCorrection(failed)!;
    expect(text).toContain('customer_nmae (did you mean customer_name?)');
    expect(text).toContain('unrelated_thing');
    expect(IdentifierLedger.renderCorrection({ ok: true, unadmitted: [], nearest: {} })).toBeUndefined();
  });

  it('ignores empty and non-string admissions rather than poisoning the set', () => {
    const ledger = new IdentifierLedger();
    ledger.admit('catalog', ['', '  ', 'orders'], 'c1');
    expect(ledger.size()).toBe(1);
  });

  it('computes a transposition-aware distance', () => {
    expect(editDistance('orders', 'orders')).toBe(0);
    expect(editDistance('ordres', 'orders')).toBe(1); // transposition, not 2 edits
    expect(editDistance('abc', 'xyz')).toBe(3);
  });
});
