import { describe, expect, it } from 'vitest';
import { matchExampleParaphrase, bestExampleParaphrase } from './example-match.js';
import { defaultEmbeddingProvider, type EmbeddingProvider } from '../embeddings/provider.js';
import type { MetadataObject } from './catalog.js';

function block(examples: string[]): MetadataObject {
  return {
    objectKey: 'dql:block:top_products',
    objectType: 'dql_block',
    name: 'top_products',
    fullName: 'top_products',
    status: 'certified',
    payload: { examples: examples.map((question) => ({ question })) },
  } as MetadataObject;
}

// Deterministic stub: returns a fixed vector per exact text, so we control cosine.
function stubProvider(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    async embed(texts: string[]) {
      return texts.map((t) => vectors[t] ?? [0, 0, 1]);
    },
  };
}

describe('matchExampleParaphrase (W2.1)', () => {
  it('matches a high-cosine paraphrase above threshold', async () => {
    const provider = stubProvider({
      'which products earn the most': [1, 0, 0],
      'top products by revenue': [0.99, 0.14, 0], // ~0.99 cosine with the question
    });
    const matched = await matchExampleParaphrase(
      'which products earn the most',
      block(['top products by revenue']),
      provider,
      { threshold: 0.8 },
    );
    expect(matched).toBe(true);
  });

  it('rejects a low-cosine (unrelated) question', async () => {
    const provider = stubProvider({
      'what is our churn rate': [0, 1, 0],
      'top products by revenue': [1, 0, 0], // orthogonal → cosine 0
    });
    const matched = await matchExampleParaphrase(
      'what is our churn rate',
      block(['top products by revenue']),
      provider,
      { threshold: 0.8 },
    );
    expect(matched).toBe(false);
  });

  it('rejects a direction-incompatible match (bottom vs top) even at high cosine', async () => {
    const provider = stubProvider({
      'bottom products by revenue': [1, 0, 0],
      'top products by revenue': [1, 0, 0], // identical vector → cosine 1
    });
    const matched = await matchExampleParaphrase(
      'bottom products by revenue',
      block(['top products by revenue']),
      provider,
      { threshold: 0.8 },
    );
    expect(matched).toBe(false);
  });

  it('returns no match for a block with no example questions', async () => {
    const result = await bestExampleParaphrase('anything', block([]), defaultEmbeddingProvider());
    expect(result.cosine).toBe(0);
  });

  it('degrades safely on the default hashed provider (near-identical text still matches)', async () => {
    // The hashed bag-of-words embedder captures token overlap; a near-identical
    // question should still cross a modest threshold without a real model.
    const matched = await matchExampleParaphrase(
      'top products by revenue last quarter',
      block(['top products by revenue']),
      defaultEmbeddingProvider(),
      { threshold: 0.6 },
    );
    expect(matched).toBe(true);
  });
});
