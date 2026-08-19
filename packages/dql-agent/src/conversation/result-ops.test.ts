import { describe, expect, it } from 'vitest';
import { detectResultSetOperation, computeResultSetOperation, type PriorResultData, refersToPriorResult } from './result-ops.js';

const priorResult: PriorResultData = {
  columns: ['customer_name', 'bcm'],
  rows: [
    ['Genesys', 2_096_396],
    ['Capital One', 1_333_994],
    ['Volkswagen', 1_275_636],
  ],
  measureColumns: ['bcm'],
  rowCount: 3,
};

describe('detectResultSetOperation', () => {
  it('requires a back-reference to the prior result', () => {
    // No demonstrative → not an operation over the prior result (fresh query).
    expect(detectResultSetOperation('what is the average bcm')).toBeNull();
    expect(detectResultSetOperation('total revenue')).toBeNull();
  });

  it('detects aggregates over the prior result', () => {
    expect(detectResultSetOperation('of the results above, what is the average?')).toMatchObject({ kind: 'aggregate', aggregate: 'avg' });
    expect(detectResultSetOperation('sum those')).toMatchObject({ kind: 'aggregate', aggregate: 'sum' });
    expect(detectResultSetOperation('how many of these are there')).toMatchObject({ kind: 'aggregate', aggregate: 'count' });
    expect(detectResultSetOperation('what is the median of these')).toMatchObject({ kind: 'aggregate', aggregate: 'median' });
    expect(detectResultSetOperation('which of these is the highest')).toMatchObject({ kind: 'aggregate', aggregate: 'max' });
  });

  it('detects a re-rank over the prior result', () => {
    expect(detectResultSetOperation('top 2 of these')).toMatchObject({ kind: 'rerank', topK: { n: 2, direction: 'top' } });
    expect(detectResultSetOperation('bottom 3 of those')).toMatchObject({ kind: 'rerank', topK: { n: 3, direction: 'bottom' } });
  });
});

describe('computeResultSetOperation', () => {
  it('averages the measure column over the prior rows', () => {
    const op = detectResultSetOperation('of the results above, what is the average?')!;
    const out = computeResultSetOperation(op, priorResult)!;
    expect(out.targetColumn).toBe('bcm');
    // (2,096,396 + 1,333,994 + 1,275,636) / 3 = 1,568,675.33
    expect(out.text).toContain('1,568,675.33');
    expect(out.partial).toBe(false);
    expect(out.coveredRows).toBe(3);
  });

  it('sums the measure column', () => {
    const out = computeResultSetOperation(detectResultSetOperation('sum those')!, priorResult)!;
    expect(out.text).toContain('4,706,026');
  });

  it('counts rows without needing a numeric column', () => {
    const out = computeResultSetOperation(detectResultSetOperation('how many of these')!, priorResult)!;
    expect(out.text).toContain('3');
  });

  it('re-ranks to the top-K sub-table', () => {
    const out = computeResultSetOperation(detectResultSetOperation('top 2 of these')!, priorResult)!;
    expect(out.result?.rows).toEqual([
      ['Genesys', 2_096_396],
      ['Capital One', 1_333_994],
    ]);
  });

  it('tolerates formatted numbers ($ and commas)', () => {
    const formatted: PriorResultData = {
      columns: ['name', 'spend'],
      rows: [['A', '$1,000'], ['B', '$3,000']],
      measureColumns: ['spend'],
      rowCount: 2,
    };
    const out = computeResultSetOperation(detectResultSetOperation('average of these')!, formatted)!;
    expect(out.text).toContain('2,000');
  });

  it('is honest when the sample is smaller than the full result', () => {
    const partial: PriorResultData = { ...priorResult, rowCount: 200 };
    const out = computeResultSetOperation(detectResultSetOperation('average of these')!, partial)!;
    expect(out.partial).toBe(true);
    expect(out.text).toContain('re-ask as a fresh query');
    expect(out.text).toContain('200');
  });

  it('returns null when there is no numeric column for a numeric aggregate', () => {
    const textOnly: PriorResultData = { columns: ['name'], rows: [['A'], ['B']], rowCount: 2 };
    expect(computeResultSetOperation(detectResultSetOperation('average of these')!, textOnly)).toBeNull();
  });

  it('returns null with no rows', () => {
    expect(computeResultSetOperation(detectResultSetOperation('sum these')!, { columns: ['x'], rows: [], rowCount: 0 })).toBeNull();
  });
});

describe('refersToPriorResult — relaxing the demonstrative requirement safely', () => {
  const prior = { columns: ['customer_name', 'lifetime_spend'], measureColumns: ['lifetime_spend'] };

  it('still accepts an explicit demonstrative', () => {
    expect(refersToPriorResult('of these, the average revenue', prior)).toBe(true);
    expect(refersToPriorResult('top 3 of those')).toBe(true);
    expect(refersToPriorResult('sum them')).toBe(true);
  });

  it('accepts a follow-up that names a column the prior result actually has', () => {
    // The reported gap: this used to re-enter the full cascade and come back as a
    // metric-composition clarification — a warehouse round-trip for arithmetic
    // over rows already on screen.
    expect(refersToPriorResult("what's the average lifetime_spend?", prior)).toBe(true);
    expect(refersToPriorResult('average lifetime spend', prior)).toBe(true);
  });

  it('refuses a fresh question that names NO prior column', () => {
    expect(refersToPriorResult('what is total revenue', prior)).toBe(false);
    expect(refersToPriorResult('how many orders were there', prior)).toBe(false);
  });

  it('refuses everything without prior columns to anchor on', () => {
    // Nothing to be sure about, so let the normal cascade run.
    expect(refersToPriorResult("what's the average lifetime_spend?")).toBe(false);
    expect(refersToPriorResult("what's the average lifetime_spend?", { columns: [] })).toBe(false);
  });

  it('vetoes a new time frame even when a prior column is named', () => {
    // The dangerous direction: silently computing "last quarter" over whatever
    // happened to be on screen. Being wrong here is invisible to the user;
    // being wrong the other way just costs a query.
    expect(refersToPriorResult('average lifetime_spend last quarter', prior)).toBe(false);
    expect(refersToPriorResult('average lifetime_spend year to date', prior)).toBe(false);
    expect(refersToPriorResult('average lifetime_spend since January', prior)).toBe(false);
  });

  it('vetoes a new breakdown, population, or an explicit re-run', () => {
    expect(refersToPriorResult('average lifetime_spend by region', prior)).toBe(false);
    expect(refersToPriorResult('average lifetime_spend for all customers', prior)).toBe(false);
    expect(refersToPriorResult('rerun that with average lifetime_spend', prior)).toBe(false);
  });

  it('lets a new-query signal override even an explicit demonstrative', () => {
    // "of these ... by region" is asking for a grouping the prior rows may not
    // carry, so it is a new query wearing a back-reference.
    expect(refersToPriorResult('of these, average lifetime_spend by region', prior)).toBe(false);
  });
});

describe('detectResultSetOperation with prior shape', () => {
  const prior = { columns: ['customer_name', 'lifetime_spend'], measureColumns: ['lifetime_spend'] };

  it('detects an aggregate without a demonstrative when a column is named', () => {
    expect(detectResultSetOperation("what's the average lifetime_spend?", prior))
      .toMatchObject({ kind: 'aggregate', aggregate: 'avg' });
  });

  it('keeps returning null for a fresh question, preserving the old behaviour', () => {
    expect(detectResultSetOperation('what is total revenue', prior)).toBeNull();
    expect(detectResultSetOperation('what is total revenue')).toBeNull();
  });

  it('is unchanged for bare callers that pass no prior shape', () => {
    expect(detectResultSetOperation('of these, the average revenue'))
      .toMatchObject({ kind: 'aggregate', aggregate: 'avg' });
    expect(detectResultSetOperation('average revenue')).toBeNull();
  });
});
