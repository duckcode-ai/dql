import { describe, expect, it } from 'vitest';
import type { KGNode } from './kg/types.js';
import { matchSemanticMetric } from './metadata/metric-match.js';

const metric = (name: string, description: string): KGNode => ({
  nodeId: `semantic:metric:${name}`,
  kind: 'metric',
  name,
  description,
  sourceTier: 'semantic_layer',
  certification: 'certified',
  provenance: 'test',
} as KGNode);

const metrics = [
  metric('revenue', 'Total revenue from orders.'),
  metric('order_count', 'Number of orders placed.'),
];

/**
 * `zorblax` is deliberately nonsense. Real synonyms like "turnover" are already
 * resolved by the measure-family tables — verified by running the matcher with
 * an all-zero embedder, which still returned `revenue`. Only an invented token
 * isolates the VECTOR lane, which is what this slice changed.
 */
const embedderOnly = {
  id: 'test:embedder-only',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => (/zorblax|revenue/i.test(text) ? [1, 0] : [0, 1]));
  },
};

describe('zero-lexical-overlap candidates reach the vector lane', () => {
  it('binds a term only the embedder can relate to the metric', async () => {
    // Before this slice the candidate was filtered out on `ftsScore === 0`
    // before embeddings ran, and alpha was zeroed when nothing matched
    // lexically — so the lane that could recognise it never saw it. Verified
    // that the old code returns null for exactly this case.
    const match = await matchSemanticMetric('what is our zorblax', metrics, {
      provider: embedderOnly as never,
      alpha: 0.95,
    });
    expect(match?.metric.name).toBe('revenue');
  });

  it('still prefers the lexically exact metric when the question names it', async () => {
    const match = await matchSemanticMetric('what is our order count', metrics, {
      provider: embedderOnly as never,
      alpha: 0.95,
    });
    expect(match?.metric.name).toBe('order_count');
  });

  it('does not invent a match when nothing relates', async () => {
    const inert = { id: 'test:inert', embed: async (t: string[]) => t.map(() => [0, 0]) };
    const match = await matchSemanticMetric('what is our zorblax', metrics, {
      provider: inert as never,
      alpha: 0.95,
    });
    expect(match).toBeNull();
  });

  it('returns nothing when there are no metrics to admit', async () => {
    expect(await matchSemanticMetric('what is our zorblax', [], {
      provider: embedderOnly as never,
    })).toBeNull();
  });
});
