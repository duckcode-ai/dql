import { describe, expect, it } from 'vitest';
import {
  evaluateInvariant,
  evaluateInvariants,
  hasInvariantViolation,
  parseInvariant,
  type InvariantResultSet,
} from './invariant-evaluator.js';

function result(columns: string[], rows: Array<Record<string, unknown>>): InvariantResultSet {
  return { columns, rows };
}

function single(column: string, value: unknown): InvariantResultSet {
  return result([column], [{ [column]: value }]);
}

describe('parseInvariant', () => {
  it('parses comparison operators, longest-first', () => {
    expect(parseInvariant('arr >= 0')).toMatchObject({ kind: 'comparison', column: 'arr', op: '>=', value: 0 });
    expect(parseInvariant('rate <= 100')).toMatchObject({ kind: 'comparison', column: 'rate', op: '<=', value: 100 });
    expect(parseInvariant('count > 5')).toMatchObject({ kind: 'comparison', column: 'count', op: '>', value: 5 });
    expect(parseInvariant('count < 5')).toMatchObject({ kind: 'comparison', column: 'count', op: '<', value: 5 });
    expect(parseInvariant('flag != 0')).toMatchObject({ kind: 'comparison', column: 'flag', op: '!=', value: 0 });
    expect(parseInvariant('flag == 1')).toMatchObject({ kind: 'comparison', column: 'flag', op: '==', value: 1 });
    expect(parseInvariant('flag = 1')).toMatchObject({ kind: 'comparison', column: 'flag', op: '==', value: 1 });
  });

  it('parses between and not between', () => {
    expect(parseInvariant('health_score between 0 and 100')).toMatchObject({
      kind: 'between', column: 'health_score', low: 0, high: 100, negated: false,
    });
    expect(parseInvariant('x NOT BETWEEN 1 and 2')).toMatchObject({
      kind: 'between', column: 'x', low: 1, high: 2, negated: true,
    });
  });

  it('parses null checks', () => {
    expect(parseInvariant('customer_id is not null')).toMatchObject({ kind: 'null', column: 'customer_id', negated: true });
    expect(parseInvariant('deleted_at is null')).toMatchObject({ kind: 'null', column: 'deleted_at', negated: false });
  });

  it('reports unparseable invariants instead of throwing', () => {
    expect(parseInvariant('approval_rate is mostly fine')).toMatchObject({ kind: 'unparseable' });
    expect(parseInvariant('')).toMatchObject({ kind: 'unparseable' });
    expect(parseInvariant('arr >= banana')).toMatchObject({ kind: 'unparseable' });
  });
});

describe('evaluateInvariant — comparisons', () => {
  it('passes when the bound holds', () => {
    expect(evaluateInvariant('arr >= 0', single('arr', 42))).toMatchObject({ passed: true });
    expect(evaluateInvariant('approval_rate_pct <= 100', single('approval_rate_pct', 100))).toMatchObject({ passed: true });
  });

  it('fails when the bound is violated and reports the offending value', () => {
    const out = evaluateInvariant('approval_rate_pct <= 100', single('approval_rate_pct', 137));
    expect(out.passed).toBe(false);
    expect(out.detail).toContain('137');
  });

  it('checks the column across every row and reports the first violation', () => {
    const set = result(['arr'], [{ arr: 10 }, { arr: 20 }, { arr: -5 }]);
    const out = evaluateInvariant('arr >= 0', set);
    expect(out.passed).toBe(false);
    expect(out.detail).toContain('row 3');
  });
});

describe('evaluateInvariant — between', () => {
  it('passes inclusive bounds and fails outside', () => {
    expect(evaluateInvariant('health_score between 0 and 100', single('health_score', 0))).toMatchObject({ passed: true });
    expect(evaluateInvariant('health_score between 0 and 100', single('health_score', 100))).toMatchObject({ passed: true });
    const out = evaluateInvariant('health_score between 0 and 100', single('health_score', 150));
    expect(out.passed).toBe(false);
    expect(out.detail).toContain('[0, 100]');
  });
});

describe('evaluateInvariant — null checks', () => {
  it('enforces is not null', () => {
    expect(evaluateInvariant('id is not null', single('id', 7))).toMatchObject({ passed: true });
    expect(evaluateInvariant('id is not null', single('id', null)).passed).toBe(false);
  });

  it('enforces is null', () => {
    expect(evaluateInvariant('deleted_at is null', single('deleted_at', null))).toMatchObject({ passed: true });
    expect(evaluateInvariant('deleted_at is null', single('deleted_at', 'x')).passed).toBe(false);
  });
});

describe('evaluateInvariant — uncheckable cases warn rather than fail closed', () => {
  it('marks an unparseable invariant uncheckable and passing', () => {
    const out = evaluateInvariant('approval_rate is mostly fine', single('approval_rate', 1));
    expect(out.uncheckable).toBe(true);
    expect(out.passed).toBe(true);
    expect(out.detail).toMatch(/Uncheckable/i);
  });

  it('marks a missing column uncheckable rather than a violation', () => {
    const out = evaluateInvariant('missing_col >= 0', single('present_col', 1));
    expect(out.uncheckable).toBe(true);
    expect(out.passed).toBe(true);
    expect(out.detail).toContain('not found');
  });

  it('flags non-numeric cell values for numeric predicates as a real violation', () => {
    const out = evaluateInvariant('arr >= 0', single('arr', 'not-a-number'));
    expect(out.passed).toBe(false);
    expect(out.uncheckable).toBeUndefined();
  });
});

describe('evaluateInvariant — edge cases', () => {
  it('treats an empty result as vacuously holding', () => {
    expect(evaluateInvariant('arr >= 0', result(['arr'], [])).passed).toBe(true);
  });

  it('coerces numeric strings from the warehouse', () => {
    expect(evaluateInvariant('arr >= 0', single('arr', '42')).passed).toBe(true);
    expect(evaluateInvariant('rate <= 100', single('rate', '99%')).passed).toBe(true);
  });
});

describe('evaluateInvariants + hasInvariantViolation', () => {
  it('returns empty for no invariants', () => {
    expect(evaluateInvariants(undefined, single('x', 1))).toEqual([]);
    expect(evaluateInvariants([], single('x', 1))).toEqual([]);
  });

  it('detects a real violation but ignores uncheckable ones', () => {
    const set = result(['arr', 'rate'], [{ arr: -1, rate: 50 }]);
    const results = evaluateInvariants(['arr >= 0', 'rate is nice'], set);
    expect(hasInvariantViolation(results)).toBe(true);

    const ok = evaluateInvariants(['rate is nice'], set); // only uncheckable
    expect(hasInvariantViolation(ok)).toBe(false);
  });
});
