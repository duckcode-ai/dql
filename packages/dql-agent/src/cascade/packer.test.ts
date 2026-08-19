import { describe, it, expect } from 'vitest';
import { PROMPT_TOKEN_BUDGETS, estimateTokens, packContext, type PackItem } from './packer.js';

const item = (id: string, text: string, score: number, priority?: number): PackItem => ({
  id, score, render: () => text, ...(priority !== undefined ? { priority } : {}),
});

describe('estimateTokens', () => {
  it('scales with length and treats empty as free', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('packContext', () => {
  it('packs by value per token, not by rank position', () => {
    // The failure this replaces: fixed top-N truncates by POSITION, so a small
    // highly-relevant object is cut because it happened to rank lower than a
    // huge marginal one.
    const result = packContext([
      item('bloated', 'x'.repeat(4000), 10),   // 1000 tokens, score 10 → density 0.01
      item('lean', 'y'.repeat(40), 8),         // 10 tokens, score 8    → density 0.8
    ], 200, { separator: '' });
    expect(result.included).toEqual(['lean']);
    expect(result.dropped).toEqual(['bloated']);
  });

  it('admits hard-priority items first, in priority order', () => {
    const result = packContext([
      item('optional', 'o'.repeat(40), 100),
      item('second', 's'.repeat(40), 1, 2),
      item('first', 'f'.repeat(40), 1, 1),
    ], 1000, { separator: '' });
    expect(result.included.slice(0, 2)).toEqual(['first', 'second']);
  });

  it('keeps required context even when it blows the budget, and says so', () => {
    // A prompt missing the relations its SQL may touch is not a smaller prompt,
    // it is a wrong one. Report it so the caller can widen or shed work rather
    // than silently shipping an over-length request.
    const result = packContext([item('allowed-relations', 'r'.repeat(4000), 1, 1)], 10, { separator: '' });
    expect(result.included).toEqual(['allowed-relations']);
    expect(result.overBudget).toBe(true);
    expect(result.tokensUsed).toBeGreaterThan(10);
  });

  it('reports overBudget false when everything fits', () => {
    const result = packContext([item('a', 'aaaa', 1, 1)], 100, { separator: '' });
    expect(result.overBudget).toBe(false);
  });

  it('counts the separator, so a pack of many small items cannot overrun', () => {
    // Each item is 1 token and each separator is 1 token, so 4 items cost
    // 1 + 3*(1+1) = 7. At a budget of 7 they all fit exactly; at 6 the last one
    // must be dropped — which is the separator being charged for, not ignored.
    const items = ['a', 'b', 'c', 'd'].map((id) => item(id, 'zzzz', 1));
    const exact = packContext(items, 7, { separator: '\n\n\n\n' });
    expect(exact.included).toHaveLength(4);
    expect(exact.tokensUsed).toBe(7);

    const tight = packContext(items, 6, { separator: '\n\n\n\n' });
    expect(tight.included).toHaveLength(3);
    expect(tight.tokensUsed).toBeLessThanOrEqual(6);
  });

  it('drops rather than truncates — a half-rendered relation is worse than none', () => {
    const result = packContext([
      item('keep', 'k'.repeat(40), 5),
      item('drop', 'd'.repeat(4000), 5),
    ], 20, { separator: '' });
    expect(result.text).not.toContain('d'.repeat(100));
    expect(result.dropped).toEqual(['drop']);
  });

  it('renders each item exactly once, so rendering may be expensive', () => {
    let renders = 0;
    packContext([{ id: 'a', score: 1, render: () => { renders += 1; return 'aaaa'; } }], 100);
    expect(renders).toBe(1);
  });

  it('is deterministic when scores and densities tie', () => {
    const items = [item('b', 'bbbb', 1), item('a', 'aaaa', 1)];
    expect(packContext(items, 100, { separator: '' }).included)
      .toEqual(packContext([...items].reverse(), 100, { separator: '' }).included);
  });

  it('handles an empty pack', () => {
    expect(packContext([], 100)).toMatchObject({ text: '', included: [], dropped: [], tokensUsed: 0 });
  });

  it('accepts a pluggable estimator for a real tokenizer later', () => {
    const result = packContext([item('a', 'aaaa', 1)], 100, { estimate: () => 50, separator: '' });
    expect(result.tokensUsed).toBe(50);
  });

  it('sizes budgets so the pack is a share of the window, not all of it', () => {
    expect(PROMPT_TOKEN_BUDGETS.quick).toBeLessThan(PROMPT_TOKEN_BUDGETS.deep);
    expect(PROMPT_TOKEN_BUDGETS.deep).toBeLessThan(PROMPT_TOKEN_BUDGETS.research);
  });
});
