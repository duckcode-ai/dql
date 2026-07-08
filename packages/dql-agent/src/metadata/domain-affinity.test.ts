import { describe, expect, it } from 'vitest';
import { applyDomainAffinityBoost } from './catalog.js';
import type { MetadataObject } from './catalog.js';

function scored(entries: Array<{ domain?: string; score: number; key: string }>) {
  return entries.map((e) => ({
    row: { objectKey: e.key, objectType: 'dql_block', name: e.key, domain: e.domain } as MetadataObject,
    score: e.score,
  }));
}

describe('applyDomainAffinityBoost (W3.2)', () => {
  it('boosts objects from the dominant domain in a multi-domain catalog', () => {
    const items = scored([
      { key: 'a', domain: 'sales', score: 10 },
      { key: 'b', domain: 'sales', score: 8 },
      { key: 'c', domain: 'growth', score: 6 },
    ]);
    const dominant = applyDomainAffinityBoost(items);
    expect(dominant).toBe('sales'); // sales aggregate (18) > growth (6)
    // Sales objects got +10% of max (10) = +1.
    expect(items.find((i) => i.row.objectKey === 'a')!.score).toBe(11);
    expect(items.find((i) => i.row.objectKey === 'b')!.score).toBe(9);
    // Growth object unchanged (still ranked, just not boosted).
    expect(items.find((i) => i.row.objectKey === 'c')!.score).toBe(6);
  });

  it('is a no-op for a single-domain catalog', () => {
    const items = scored([
      { key: 'a', domain: 'sales', score: 10 },
      { key: 'b', domain: 'sales', score: 8 },
    ]);
    expect(applyDomainAffinityBoost(items)).toBeUndefined();
    expect(items.map((i) => i.score)).toEqual([10, 8]);
  });

  it('is recall-preserving: a much stronger cross-domain object still outranks a boosted one', () => {
    const items = scored([
      { key: 'strong_growth', domain: 'growth', score: 20 },
      { key: 'weak_sales', domain: 'sales', score: 9 },
      { key: 'sales_filler', domain: 'sales', score: 8.5 },
    ]);
    applyDomainAffinityBoost(items);
    // sales is dominant by aggregate, but the strong growth object (20 + 0 boost)
    // still beats the boosted weak sales object (9 + 2 = 11).
    const strong = items.find((i) => i.row.objectKey === 'strong_growth')!;
    const boosted = items.find((i) => i.row.objectKey === 'weak_sales')!;
    expect(strong.score).toBeGreaterThan(boosted.score);
  });
});
