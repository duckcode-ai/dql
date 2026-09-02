import { describe, expect, it } from 'vitest';
import { embeddingProviderFromIndexedId } from './provider.js';

/**
 * A vector index is readable only by the embedder that wrote it. When a
 * project has no explicit embedding setting it resolves to the offline hashed
 * default, so after a background upgrade re-embedded the index with a local
 * model, every later process asked for hashed, matched nothing, and the vector
 * lane silently vanished from retrieval — `contextCoverage` reported the source
 * as empty while 53,842 real vectors sat in the file.
 */
describe('reconstructing the embedder an index was built with', () => {
  it('rebuilds an Ollama provider from the id recorded beside the index', () => {
    const provider = embeddingProviderFromIndexedId('cached:resilient:ollama:nomic-embed-text');
    expect(provider?.id).toBe('cached:resilient:ollama:nomic-embed-text');
  });

  it('keeps the model name intact when it carries a tag', () => {
    const provider = embeddingProviderFromIndexedId('cached:resilient:ollama:mxbai-embed-large:335m');
    expect(provider?.id).toContain('mxbai-embed-large:335m');
  });

  it('declines an id it cannot honestly reconstruct', () => {
    expect(embeddingProviderFromIndexedId('hashed-token-v1')).toBeUndefined();
    expect(embeddingProviderFromIndexedId('openai:text-embedding-3-small')).toBeUndefined();
    expect(embeddingProviderFromIndexedId('cached:resilient:ollama:')).toBeUndefined();
  });
});
