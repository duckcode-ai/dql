import { describe, expect, it } from 'vitest';
import { parseAnalyticalTimeWindow } from './requirement-clauses.js';
import { buildAnalyticalRequirementSet, buildAnalyticalRequirementSeedV1 } from './analytical-orchestration.js';
import { resolvePlanTimeRange } from './resolved-analytical-plan.js';

/**
 * The single grammar for time windows, and the anti-drift lock: everything
 * this parser produces must resolve through `resolvePlanTimeRange`, because
 * the canonical `expression` is the resolver's input format. A window that
 * parses but does not resolve would re-create the very gap this closes —
 * a clause the system claims to understand and then silently drops.
 */
describe('parseAnalyticalTimeWindow', () => {
  it('parses counted relative windows in words and digits', () => {
    expect(parseAnalyticalTimeWindow('revenue for the last two months')).toMatchObject({
      kind: 'relative',
      expression: 'last 2 months',
      relative: { count: 2, unit: 'month', complete: false },
    });
    expect(parseAnalyticalTimeWindow('past 60 days of orders')).toMatchObject({
      expression: 'last 60 days',
      relative: { count: 60, unit: 'day' },
    });
  });

  it('parses the uncounted previous period as a complete one', () => {
    expect(parseAnalyticalTimeWindow('revenue last month')).toMatchObject({
      expression: 'last month',
      relative: { count: 1, unit: 'month', complete: true },
    });
  });

  it('parses this-period and absolute ranges', () => {
    expect(parseAnalyticalTimeWindow('sales this quarter')).toMatchObject({ expression: 'this 1 quarter' });
    expect(parseAnalyticalTimeWindow('orders 2024-01-01 to 2024-03-01')).toMatchObject({
      kind: 'absolute',
      absolute: { startInclusive: '2024-01-01', endExclusive: '2024-03-01' },
    });
  });

  it('treats a bare grain as a grouping, not a window', () => {
    expect(parseAnalyticalTimeWindow('revenue by month')).toBeUndefined();
    expect(parseAnalyticalTimeWindow('monthly revenue')).toBeUndefined();
  });

  it('every relative expression it produces resolves to concrete UTC bounds', () => {
    const reference = new Date('2026-08-31T12:00:00Z');
    for (const question of [
      'last two months', 'last 2 months', 'past 60 days', 'last month',
      'previous quarter', 'last three years',
    ]) {
      const window = parseAnalyticalTimeWindow(question);
      expect(window, question).toBeDefined();
      if (window!.kind !== 'relative') continue;
      const bounds = resolvePlanTimeRange(window!.expression, reference);
      expect(bounds, `${question} → ${window!.expression}`).toBeDefined();
      expect(new Date(bounds!.startInclusive) < new Date(bounds!.endExclusive)).toBe(true);
    }
  });
});

describe('window in the requirement contract', () => {
  it('the reported question finally carries its window end to end', () => {
    const question = 'Can you give me the last two month with high revenue by customer name';
    const requirements = buildAnalyticalRequirementSet({ question });
    expect(requirements.time?.window).toMatchObject({ expression: 'last 2 months' });
    // The seed's queryIntent.timeRange is what lights up resolvePlanTimeRange
    // (and with it query.timeBounds) — the resolver that was fully written and
    // never called, because no producer ever set this field.
    const seed = buildAnalyticalRequirementSeedV1({ question });
    expect(seed.queryIntent.timeRange).toBe('last 2 months');
  });

  it('a window never doubles as a ranking', () => {
    const requirements = buildAnalyticalRequirementSet({ question: 'revenue for the last two months' });
    expect(requirements.time?.window).toBeDefined();
    expect(requirements.ranking).toBeUndefined();
  });
});

import { splitAnalyticalTasks } from './analytical-orchestration.js';

/**
 * "… and give me top 5 rows" is a ranking clause of the same request, not an
 * independent question. Splitting it minted a task titled "give me top 5
 * rows" that could never resolve, and the phantom task spent the dispatch
 * budget the real question needed.
 */
describe('shape clauses never become tasks', () => {
  it('keeps the reported compound question as one task', () => {
    expect(splitAnalyticalTasks('I need last two months highest revenue and give me top 5 rows'))
      .toEqual(['I need last two months highest revenue and give me top 5 rows']);
  });

  it('folds shape-only fragments across separators too', () => {
    expect(splitAnalyticalTasks('show revenue by customer? give me the top 10'))
      .toEqual(['show revenue by customer and give me the top 10']);
  });

  it('still splits genuinely independent questions', () => {
    expect(splitAnalyticalTasks('who are the top customers? what customer type is Wesley Jenkins'))
      .toEqual(['who are the top customers', 'what customer type is Wesley Jenkins']);
    expect(splitAnalyticalTasks('show revenue by month and give me top 5 products'))
      .toEqual(['show revenue by month and give me top 5 products'.split(' and give')[0], 'give me top 5 products'].map(s=>s.trim()));
  });
});
