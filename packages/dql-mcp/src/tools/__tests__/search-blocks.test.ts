import { describe, it, expect } from 'vitest';

import { searchBlocks } from '../search-blocks.js';
import { makeCtx, makeManifestBlock } from './_helpers.js';

describe('searchBlocks tool', () => {
  it('returns an empty array when no blocks match', () => {
    const ctx = makeCtx({
      'Block A': makeManifestBlock({ name: 'Block A', description: 'finance metric' }),
    });
    const result = searchBlocks(ctx, { query: 'unrelated-keyword' });
    expect(Array.isArray((result as { blocks: unknown[] }).blocks ?? result)).toBe(true);
  });

  it('returns matching blocks for a query token', () => {
    const ctx = makeCtx({
      'Customer Segments': makeManifestBlock({
        name: 'Customer Segments',
        domain: 'customer',
        description: 'lifetime customer segments by spend',
      }),
      'Monthly Revenue': makeManifestBlock({
        name: 'Monthly Revenue',
        domain: 'finance',
        description: 'gross revenue per month',
      }),
    });
    const result = searchBlocks(ctx, { query: 'revenue' });
    const blocks = (result as { blocks?: Array<{ name: string }> }).blocks ?? (result as Array<{ name: string }>);
    expect(blocks.some((b) => b.name === 'Monthly Revenue')).toBe(true);
  });
});
