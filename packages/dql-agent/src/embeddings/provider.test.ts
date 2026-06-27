import { describe, expect, it } from 'vitest';
import {
  HashedTokenEmbeddingProvider,
  cosineSimilarity,
  defaultEmbeddingProvider,
  hybridRank,
} from './provider.js';

describe('deterministic embedding provider', () => {
  it('is deterministic — identical text yields identical vectors', async () => {
    const provider = new HashedTokenEmbeddingProvider(128);
    const [a] = await provider.embed(['revenue net amount excludes refunds']);
    const [b] = await provider.embed(['revenue net amount excludes refunds']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(128);
  });

  it('scores semantically-overlapping text higher than unrelated text', async () => {
    const provider = defaultEmbeddingProvider();
    const [query, related, unrelated] = await provider.embed([
      'revenue net amount excludes refunds',
      'net revenue should exclude refunds and returns',
      'player rebounds and assists per game by team',
    ]);
    const simRelated = cosineSimilarity(query, related);
    const simUnrelated = cosineSimilarity(query, unrelated);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it('cosine similarity handles degenerate vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
  });
});

describe('hybrid rank', () => {
  const items = [
    { item: 'a', text: 'revenue net amount refunds', ftsScore: 0.4 },
    { item: 'b', text: 'churn logo retention quarterly', ftsScore: 0.6 },
  ];

  it('alpha=0 is a pure FTS5 pass-through (safe default)', async () => {
    const ranked = await hybridRank('revenue net', items, { alpha: 0 });
    expect(ranked[0].item).toBe('b'); // higher ftsScore wins, vector ignored
    expect(ranked.every((r) => r.vectorScore === 0)).toBe(true);
  });

  it('alpha>0 blends vector similarity and can re-order', async () => {
    const ranked = await hybridRank('revenue net amount refunds', items, { alpha: 1 });
    // With full vector weight, the lexically-identical item wins despite lower fts.
    expect(ranked[0].item).toBe('a');
    expect(ranked[0].vectorScore).toBeGreaterThan(ranked[1].vectorScore);
  });

  it('is deterministic across runs', async () => {
    const r1 = await hybridRank('revenue net', items, { alpha: 0.5 });
    const r2 = await hybridRank('revenue net', items, { alpha: 0.5 });
    expect(r1.map((x) => [x.item, x.score])).toEqual(r2.map((x) => [x.item, x.score]));
  });
});
