import { describe, expect, it } from 'vitest';
import { narrationMaxTokensForFacts } from './analytical-result-facts.js';

describe('the narration ceiling covers the contract it enforces', () => {
  it('gives a ten-row result room the flat 350 did not', () => {
    // The exact shape that failed live: ~11 facts for a 10-row answer, each
    // claim echoing every fact id. At 350 the reply was truncated mid-word and
    // both attempts died as UNPARSEABLE_CLAIMS.
    expect(narrationMaxTokensForFacts(11)).toBeGreaterThan(800);
  });

  it('still starts small for a single-value answer', () => {
    expect(narrationMaxTokensForFacts(0)).toBe(350);
    expect(narrationMaxTokensForFacts(1)).toBe(395);
  });

  it('grows with the fact set, because the fact ids do', () => {
    expect(narrationMaxTokensForFacts(20)).toBeGreaterThan(narrationMaxTokensForFacts(10));
  });

  it('is capped, so a huge result cannot ask for an unbounded reply', () => {
    expect(narrationMaxTokensForFacts(10_000)).toBe(1600);
  });

  it('treats a negative count as zero rather than shrinking below the floor', () => {
    expect(narrationMaxTokensForFacts(-5)).toBe(350);
  });
});
