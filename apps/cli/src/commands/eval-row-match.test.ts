import { describe, expect, it } from 'vitest';
import { goldRowsMatch, normalizeGoldValue } from './eval-row-match.js';

describe('matching an answer to a benchmark correct answer', () => {
  it('ignores column names and column order', () => {
    const gold = [{ policy_number: 'P1', total_loss: 10 }, { policy_number: 'P2', total_loss: 20 }];
    expect(goldRowsMatch([{ sum_of_loss: 20, policy: 'P2' }, { sum_of_loss: 10, policy: 'P1' }], gold)).toEqual({ match: true });
    expect(goldRowsMatch([[10, 'P1'], [20, 'P2']], gold)).toEqual({ match: true });
  });

  it('compares numbers by value, and dates by day', () => {
    expect(goldRowsMatch([{ x: 0.1 + 0.2 }], [{ x: 0.3 }]).match).toBe(true);
    expect(goldRowsMatch([{ x: '10.0' }], [{ x: 10 }]).match).toBe(true);
    expect(goldRowsMatch([{ x: BigInt(10) }], [{ x: 10 }]).match).toBe(true);
    expect(goldRowsMatch([{ x: 10.01 }], [{ x: 10 }]).match).toBe(false);
    expect(goldRowsMatch([{ d: '2025-08-01T00:00:00Z' }], [{ d: '2025-08-01' }]).match).toBe(true);
    expect(goldRowsMatch([{ d: '2025-08-01T13:00:00' }], [{ d: '2025-08-01' }]).match).toBe(false);
  });

  it('counts duplicate rows and reports a different row count', () => {
    const gold = [{ a: 1 }, { a: 1 }, { a: 2 }];
    expect(goldRowsMatch([{ a: 1 }, { a: 2 }, { a: 2 }], gold).match).toBe(false);
    expect(goldRowsMatch([{ a: 2 }, { a: 1 }, { a: 1 }], gold).match).toBe(true);
    expect(goldRowsMatch([{ a: 1 }], gold)).toEqual({ match: false, reason: 'returned 1 row(s); the correct answer has 3' });
  });

  it('checks order only when the question asks for one', () => {
    const gold = [{ a: 1 }, { a: 2 }];
    expect(goldRowsMatch([{ a: 2 }, { a: 1 }], gold).match).toBe(true);
    expect(goldRowsMatch([{ a: 2 }, { a: 1 }], gold, { ordered: true })).toEqual({ match: false, reason: 'row 1 differs from the correct answer' });
  });

  it('allows extra columns only when told to, and still checks rows as units', () => {
    const gold = [{ total: 10 }, { total: 20 }];
    const withNames = [{ id: 1, name: 'East', total: 10 }, { id: 2, name: 'West', total: 20 }];
    expect(goldRowsMatch(withNames, gold).match).toBe(false);
    expect(goldRowsMatch(withNames, gold, { allowExtraColumns: true }).match).toBe(true);
    const paired = [{ region: 'East', total: 10 }, { region: 'West', total: 20 }];
    const swapped = [{ region: 'East', total: 20, id: 1 }, { region: 'West', total: 10, id: 2 }];
    expect(goldRowsMatch(swapped, paired, { allowExtraColumns: true }).match).toBe(false);
  });

  it('matches empty answers only to empty answers', () => {
    expect(goldRowsMatch([], [])).toEqual({ match: true });
    expect(goldRowsMatch([], [{ a: 1 }]).match).toBe(false);
  });

  it('keeps null, booleans and text apart', () => {
    expect(normalizeGoldValue(null)).not.toBe(normalizeGoldValue('null'));
    expect(normalizeGoldValue(true)).not.toBe(normalizeGoldValue('true'));
    expect(normalizeGoldValue('  East ')).toBe(normalizeGoldValue('East'));
  });
});
