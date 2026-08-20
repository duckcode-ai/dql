import { describe, expect, it } from 'vitest';
import { detectResultSetOperation } from './conversation/result-ops.js';

const prior = { columns: ['customer_name', 'count_lifetime_orders'], rowCount: 935 } as never;

describe('an explanation question is not arithmetic over the prior result', () => {
  it('declines "why is he top most in the list"', () => {
    // Matched the max-family pattern on "top most" and answered "The maximum of
    // count_lifetime_orders is 156" — wrong column, wrong customer, computed
    // over the rows that happened to be on screen.
    expect(detectResultSetOperation('why he is top most in the list?', prior)).toBeNull();
  });

  it('declines other explanation shapes', () => {
    for (const q of ['explain why these are the highest', 'what caused the largest one', 'how did he end up top']) {
      expect(detectResultSetOperation(q, prior)).toBeNull();
    }
  });

  it('STILL answers a genuine aggregate over the prior result', () => {
    const op = detectResultSetOperation('what is the max of count_lifetime_orders of these?', prior);
    expect(op?.kind).toBe('aggregate');
  });

  it('STILL answers a genuine re-rank', () => {
    expect(detectResultSetOperation('top 3 of these', prior)?.kind).toBe('rerank');
  });
});
