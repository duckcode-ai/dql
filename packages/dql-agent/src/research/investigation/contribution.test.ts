import { describe, expect, it } from 'vitest';
import { formatDecimal, parseExactDecimal, sumDecimals, subtractDecimal, multiplyDecimal, addDecimal, type ExactDecimal } from '../../analytical-execution-graph.js';
import { contributionTable, memberKey, memberLabel, mixRateSplit, NOT_SET_LABEL, type ContributionMemberInput } from './contribution.js';

const d = (value: string | number): ExactDecimal => parseExactDecimal(value)!;
const text = (value: ExactDecimal | undefined) => (value === undefined ? undefined : formatDecimal(value));
const member = (key: string, prior?: number, current?: number): ContributionMemberInput => ({
  key, value: key, label: key, ...(prior !== undefined ? { prior: d(prior) } : {}), ...(current !== undefined ? { current: d(current) } : {}),
});
const table = (members: ContributionMemberInput[], totals?: { prior: number; current: number }) => {
  const prior = totals?.prior ?? members.reduce((sum, item) => sum + Number(item.prior ? formatDecimal(item.prior) : 0), 0);
  const current = totals?.current ?? members.reduce((sum, item) => sum + Number(item.current ? formatDecimal(item.current) : 0), 0);
  return contributionTable({ additivity: 'additive', members, totalPrior: d(prior), totalCurrent: d(current) });
};

describe('how a change splits across the members of a dimension', () => {
  it('a member that made the whole drop, though it was 30% of the prior period, is the driver with 70 points of excess', () => {
    const result = table([member('food', 700, 700), member('beverage', 300, 150)]);
    expect(text(result.change)).toBe('-150');
    expect(result.reconciles).toBe(true);
    expect(text(result.residual)).toBe('0');
    const [beverage, food] = result.rows;
    expect(beverage).toMatchObject({ label: 'beverage', status: 'both', role: 'driver' });
    expect([text(beverage!.delta), text(beverage!.share), text(beverage!.priorWeight), text(beverage!.excess)]).toEqual(['-150', '1', '0.3', '0.7']);
    expect(food).toMatchObject({ label: 'food', role: 'flat' });
    expect([text(food!.share), text(food!.excess)]).toEqual(['0', '-0.7']);
  });

  it('new and gone members count from zero; one moving against the change is an offset with a negative share', () => {
    const result = table([member('a', 100, 100), member('b', 50), member('c', undefined, 60)]);
    expect(text(result.change)).toBe('10');
    const byLabel = Object.fromEntries(result.rows.map((row) => [row.label, row]));
    expect(byLabel.b).toMatchObject({ status: 'gone', role: 'offset' });
    expect([text(byLabel.b!.current), text(byLabel.b!.delta), text(byLabel.b!.share)]).toEqual(['0', '-50', '-5']);
    expect(byLabel.c).toMatchObject({ status: 'new', role: 'driver' });
    expect(text(byLabel.c!.share)).toBe('6');
    expect(result.rows.map((row) => row.label)).toEqual(['c', 'b', 'a']);
    expect(result.relabel).toBeUndefined();
  });

  it('shares of a reconciled change add up to one', () => {
    const result = table([member('north', 333, 400), member('south', 333, 350), member('east', 334, 260), member('west', 0, 7)]);
    const shares = sumDecimals(result.rows.map((row) => row.share!));
    expect(Math.abs(Number(formatDecimal(shares)) - 1)).toBeLessThan(1e-9);
  });

  it('a whole that did not change while its members did is offsetting movements, ranked by size, with no shares', () => {
    const result = table([member('a', 100, 150), member('b', 100, 50)]);
    expect(result.offsetting).toBe(true);
    expect(result.rows.every((row) => row.share === undefined && row.role === 'driver')).toBe(true);
    // Equal movements are ordered by label.
    expect(result.rows.map((row) => [row.label, text(row.delta)])).toEqual([['a', '50'], ['b', '-50']]);
  });

  it('members that do not add up to the headline do not reconcile, and the residual says by how much', () => {
    const result = table([member('a', 400, 380), member('b', 500, 470)], { prior: 1000, current: 850 });
    expect(text(result.residual)).toBe('-100');
    expect(result.reconciles).toBe(false);
    // Within half a percent of the larger of the change and the prior total, it reconciles.
    expect(table([member('a', 400, 380), member('b', 596, 470)], { prior: 1000, current: 850 }).reconciles).toBe(true);
  });

  it('a gone member replaced by a new one of the same size looks like a rename', () => {
    const result = table([member('Store 1', 500, 520), member('Old name', 300), member('New name', undefined, 297)]);
    expect(result.relabel).toEqual({ gone: 'Old name', new: 'New name' });
  });

  it('an empty value is one member, "(not set)"', () => {
    expect(memberKey(null)).toBe(memberKey(''));
    expect(memberLabel(undefined)).toBe(NOT_SET_LABEL);
    expect(memberKey(2017)).toBe('2017');
    const result = contributionTable({ additivity: 'additive', members: [{ key: memberKey(null), value: null, label: memberLabel(null), prior: d(5), current: d(8) }], totalPrior: d(5), totalCurrent: d(8) });
    expect(result.nullMember).toBe(true);
  });

  it('a non-additive metric has member changes only: no shares, no residual, and a missing period is unknown', () => {
    const result = contributionTable({ additivity: 'non_additive', members: [member('a', 10, 12), member('b', 9)], totalPrior: d(9.5), totalCurrent: d(12) });
    expect(result.additive).toBe(false);
    expect(result.residual).toBeUndefined();
    expect(result.rows.find((row) => row.label === 'a')).toMatchObject({ role: 'driver' });
    expect(result.rows.find((row) => row.label === 'a')!.share).toBeUndefined();
    const b = result.rows.find((row) => row.label === 'b')!;
    expect([b.status, b.current, b.delta, b.role]).toEqual(['gone', undefined, undefined, 'flat']);
  });
});

describe("a ratio's change as mix and rate", () => {
  // Food revenue as a share of revenue, by location. Downtown grew its weight
  // (a mix effect) while the airport's own food share fell (a rate effect).
  const members = [
    { key: 'downtown', label: 'Downtown', priorNumerator: d(300), priorDenominator: d(500), currentNumerator: d(480), currentDenominator: d(800) },
    { key: 'airport', label: 'Airport', priorNumerator: d(250), priorDenominator: d(500), currentNumerator: d(80), currentDenominator: d(200) },
    { key: 'mall', label: 'Mall', currentNumerator: d(50), currentDenominator: d(100) },
  ];

  it('mix and rate add up to the change exactly, and rate matches its own formula', () => {
    const split = mixRateSplit(members)!;
    expect(text(split.priorRatio)).toBe('0.55');
    expect(text(split.currentRatio)).toBe('0.554545454545455');
    expect(formatDecimal(addDecimal(split.mix, split.rate))).toBe(formatDecimal(split.change));
    // Σ w₁·(r₁ − r₀), with the new member at the prior overall rate.
    const direct = split.members.reduce((sum, row) => addDecimal(sum, multiplyDecimal(row.currentWeight, subtractDecimal(row.currentRatio!, row.priorRatio ?? split.priorRatio))), d(0));
    expect(Math.abs(Number(formatDecimal(subtractDecimal(direct, split.rate))))).toBeLessThan(1e-12);
  });

  it('a period with no denominator has no ratio to split', () => {
    expect(mixRateSplit([{ key: 'a', label: 'A', currentNumerator: d(1), currentDenominator: d(0), priorNumerator: d(1), priorDenominator: d(2) }])).toBeUndefined();
  });
});
