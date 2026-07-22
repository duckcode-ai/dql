import { describe, expect, it } from 'vitest';
import { detectResultSetOperation, computeResultSetOperation, type PriorResultData } from './result-ops.js';

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
