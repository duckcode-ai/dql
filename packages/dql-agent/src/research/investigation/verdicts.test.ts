import { describe, expect, it } from 'vitest';
import { formatDecimal, parseExactDecimal, type ExactDecimal } from '../../analytical-execution-graph.js';
import { contributionTable, type ContributionMemberInput } from './contribution.js';
import { dimensionVerdict, drillTarget, globalShare, investigationConfidence, memberVerdict, seasonalityCheck } from './verdicts.js';

const d = (value: number): ExactDecimal => parseExactDecimal(value)!;
const member = (key: string, prior?: number, current?: number): ContributionMemberInput => ({
  key, value: key, label: key, ...(prior !== undefined ? { prior: d(prior) } : {}), ...(current !== undefined ? { current: d(current) } : {}),
});
const table = (members: ContributionMemberInput[], totals?: { prior: number; current: number }) => contributionTable({
  additivity: 'additive', members,
  totalPrior: d(totals?.prior ?? members.reduce((sum, item) => sum + Number(item.prior ? formatDecimal(item.prior) : 0), 0)),
  totalCurrent: d(totals?.current ?? members.reduce((sum, item) => sum + Number(item.current ? formatDecimal(item.current) : 0), 0)),
});

describe('verdicts on members and dimensions', () => {
  it('a member that made the whole drop at 30% of the prior period is supported, and the dimension explains the change', () => {
    const result = table([member('food', 700, 700), member('beverage', 300, 150)]);
    const verdict = dimensionVerdict(result);
    expect(verdict.verdict).toBe('explains');
    expect(verdict.members.map((item) => [item.row.label, item.verdict])).toEqual([['beverage', 'supported']]);
    expect(drillTarget(verdict)?.label).toBe('beverage');
  });

  it('a change spread in line with every member’s size rules the dimension out', () => {
    const verdict = dimensionVerdict(table([member('a', 100, 90), member('b', 100, 90), member('c', 100, 90)]));
    expect(verdict).toMatchObject({ verdict: 'ruled_out', maxExcess: 0, members: [] });
  });

  it('with no supported member, three members making most of the change, one beyond its size, still explain it', () => {
    const result = table([member('a', 150, 50), member('b', 200, 100), member('c', 250, 150), member('d', 400, 300)]);
    const verdict = dimensionVerdict(result);
    expect(verdict.verdict).toBe('explains');
    expect(verdict.members.map((item) => [item.row.label, item.verdict])).toEqual([['a', 'partial'], ['b', 'partial']]);
    expect(drillTarget(verdict)).toBeUndefined();
  });

  it('a member moving against the change is an offset when it is large enough', () => {
    const result = table([member('a', 100, 40), member('b', 100, 130)]);
    const byLabel = Object.fromEntries(result.rows.map((row) => [row.label, memberVerdict(row, result)]));
    expect(byLabel).toEqual({ a: 'supported', b: 'offset' });
  });

  it('members that do not reconcile, offsetting movements and a non-additive metric are inconclusive, with the reason', () => {
    expect(dimensionVerdict(table([member('a', 400, 380), member('b', 500, 470)], { prior: 1000, current: 850 }))).toMatchObject({ verdict: 'inconclusive', reason: 'the members add up to -50 of a change of -150, so their shares are not reliable' });
    expect(dimensionVerdict(table([member('a', 100, 150), member('b', 100, 50)])).reason).toMatch(/offsetting/);
    expect(dimensionVerdict(contributionTable({ additivity: 'non_additive', members: [member('a', 10, 12)], totalPrior: d(10), totalCurrent: d(12) })).reason).toMatch(/does not add up/);
  });

  it('a drilled member’s share of the whole change is its local share times its parent’s', () => {
    expect(formatDecimal(globalShare(d(0.5), d(0.8)))).toBe('0.4');
  });
});

describe('seasonality', () => {
  it('the same drop a year earlier, within five points, is seasonal', () => {
    expect(seasonalityCheck({ current: d(90), prior: d(100), yearAgo: d(91), yearAgoPrior: d(100) })).toEqual({ seasonal: true, pct: '-10', yearAgoPct: '-9' });
  });
  it('a year earlier that rose, or is unknown, is not', () => {
    expect(seasonalityCheck({ current: d(90), prior: d(100), yearAgo: d(110), yearAgoPrior: d(100) }).seasonal).toBe(false);
    expect(seasonalityCheck({ current: d(90), prior: d(100) }).seasonal).toBe(false);
    expect(seasonalityCheck({ current: d(80), prior: d(100), yearAgo: d(91), yearAgoPrior: d(100) }).seasonal).toBe(false);
  });
});

describe('confidence', () => {
  it('starts high and names every limit that caps it', () => {
    expect(investigationConfidence({ driversExpected: true, dimensionsAnalysed: 3, maxResidualPct: 0, topSupportedShare: 0.9 })).toEqual({ level: 'high', reasons: [] });
    expect(investigationConfidence({ driversExpected: true, dimensionsAnalysed: 3, anyAiSql: true, seasonal: true })).toEqual({ level: 'medium', reasons: ['some figures come from AI-written SQL', 'the same change happened a year earlier'] });
    expect(investigationConfidence({ driversExpected: true, dimensionsAnalysed: 0, coverageGap: true })).toMatchObject({ level: 'low', reasons: ['the current period has data on far fewer days than the prior one', 'no dimension could be analysed'] });
    expect(investigationConfidence({ driversExpected: true, dimensionsAnalysed: 1, maxResidualPct: 3 }).reasons).toEqual(['a breakdown misses 3.0% of the change', 'only one dimension was analysed']);
    expect(investigationConfidence({ maxResidualPct: 8 }).level).toBe('low');
    expect(investigationConfidence({ driversExpected: true, dimensionsAnalysed: 2, topSupportedShare: 0.45, relabel: true }).reasons).toEqual(['the strongest driver made less than half of the change', 'a member may have been renamed between the periods']);
  });
});
