import { describe, it, expect } from 'vitest';

import { getBlock } from '../get-block.js';
import { makeCtx, makeManifestBlock } from './_helpers.js';

describe('getBlock tool', () => {
  it('returns an error when the block is missing', () => {
    const ctx = makeCtx({});
    const result = getBlock(ctx, { name: 'Nonexistent' });
    expect(result).toMatchObject({ error: expect.stringContaining('Nonexistent') });
  });

  it('returns the manifest block envelope when found', () => {
    const block = makeManifestBlock({ name: 'My Block', llmContext: 'Used by tests.' });
    const ctx = makeCtx({ 'My Block': block });
    const result = getBlock(ctx, { name: 'My Block' });
    expect(result).toMatchObject({ name: 'My Block' });
  });
});
