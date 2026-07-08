import { describe, expect, it } from 'vitest';
import { findStaleHints } from './staleness.js';
import type { Hint } from './types.js';

function hint(partial: Partial<Hint>): Pick<Hint, 'id' | 'title' | 'scope' | 'status'> {
  return {
    id: partial.id ?? 'hint_1',
    title: partial.title ?? 'h',
    scope: partial.scope ?? {},
    status: partial.status ?? 'approved',
  };
}

describe('findStaleHints (W4.6)', () => {
  // Catalog: fct_orders (dbt), revenue (metric) exist; everything else is gone.
  const exists = (kind: string, name: string) =>
    (kind === 'dbtModel' && name === 'fct_orders') || (kind === 'metric' && name === 'revenue');

  it('flags an approved hint whose dbt model was renamed away', () => {
    const stale = findStaleHints([hint({ id: 'h1', scope: { dbtModel: 'stg_orders_OLD' } })], exists);
    expect(stale).toHaveLength(1);
    expect(stale[0].missing).toEqual([{ kind: 'dbtModel', name: 'stg_orders_OLD' }]);
  });

  it('does not flag a hint whose targets all still exist', () => {
    const stale = findStaleHints([hint({ scope: { dbtModel: 'fct_orders', metric: 'revenue' } })], exists);
    expect(stale).toHaveLength(0);
  });

  it('ignores non-approved hints (they never reach an answer)', () => {
    const stale = findStaleHints([hint({ status: 'candidate', scope: { block: 'gone' } })], exists);
    expect(stale).toHaveLength(0);
  });

  it('reports every missing target on a multi-scope hint', () => {
    const stale = findStaleHints([hint({ scope: { metric: 'revenue', block: 'deleted_block', term: 'GMV' } })], exists);
    expect(stale).toHaveLength(1);
    expect(stale[0].missing.map((m) => m.kind).sort()).toEqual(['block', 'term']);
  });
});
