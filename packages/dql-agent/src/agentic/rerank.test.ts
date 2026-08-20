import { describe, expect, it } from 'vitest';
import { applyRerank, parseRerankReply, rerankCandidates } from './rerank.js';

const allowed = new Set(['a', 'b', 'c']);
const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, summary: `${id} summary` }));

describe('LLM reranker', () => {
  it('reorders and carries the reason', () => {
    const out = parseRerankReply('{"ranked":[{"id":"c","why":"names the metric"},{"id":"a","why":"same grain"}]}', allowed);
    expect(out?.order).toEqual(['c', 'a']);
    expect(out?.reasons.get('c')).toBe('names the metric');
  });

  it('DISCARDS an id retrieval never returned', () => {
    // The safety property: a reranker may reorder, never introduce. Otherwise a
    // malformed reply could put an invented object into a governed pack.
    const out = parseRerankReply('{"ranked":[{"id":"zzz"},{"id":"b"}]}', allowed);
    expect(out?.order).toEqual(['b']);
  });

  it('ignores duplicates and caps the list', () => {
    const many = new Set(Array.from({ length: 30 }, (_, i) => `id${i}`));
    const raw = JSON.stringify({ ranked: [...Array.from({ length: 30 }, (_, i) => ({ id: `id${i}` })), { id: 'id0' }] });
    expect(parseRerankReply(raw, many)!.order.length).toBeLessThanOrEqual(15);
  });

  it('returns undefined for prose, so the caller keeps its order', () => {
    expect(parseRerankReply('I think c is best.', allowed)).toBeUndefined();
    expect(parseRerankReply('{"ranked":[]}', allowed)).toBeUndefined();
  });

  it('keeps omitted items BEHIND the ranked ones rather than dropping them', () => {
    // Dropping omissions would let one bad reply silently shrink the context.
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = applyRerank(items, (i) => i.id, { order: ['c'], reasons: new Map() });
    expect(out.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('leaves the order untouched when there is no outcome', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    expect(applyRerank(items, (i) => i.id, undefined).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('never fails the turn when the provider throws', async () => {
    expect(await rerankCandidates(
      { generate: async () => { throw new Error('down'); } }, 'q', pool,
    )).toBeUndefined();
  });

  it('does not call the provider when there is too little to reorder', async () => {
    let called = false;
    await rerankCandidates(
      { generate: async () => { called = true; return '{}'; } }, 'q', pool.slice(0, 3),
    );
    expect(called).toBe(false);
  });
});
