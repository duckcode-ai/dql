import { describe, expect, it } from 'vitest';
import type { EmbeddingSettingsResponse } from '../../api/client';
import { embeddingReindexOutcome } from './embedding-reindex-model';

const settings = (reindexRequired: boolean): EmbeddingSettingsResponse => ({
  settings: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text', apiKeySet: false },
  activeProviderId: 'ollama:nomic-embed-text',
  semantic: true,
  indexedProviderId: reindexRequired ? 'hashed-token-v1' : 'ollama:nomic-embed-text',
  reindexRequired,
});

describe('embedding re-index status', () => {
  it('does not report success when the authoritative catalog still needs re-indexing', () => {
    expect(embeddingReindexOutcome({
      upgraded: false,
      providerId: 'hashed-token-v1',
      reason: 'Ollama is unavailable',
    }, settings(true))).toEqual({
      ok: false,
      message: 'Re-index did not complete — Ollama is unavailable.',
    });
  });

  it('reports the active provider only after the catalog confirms completion', () => {
    expect(embeddingReindexOutcome({
      upgraded: true,
      providerId: 'ollama:nomic-embed-text',
    }, settings(false))).toEqual({
      ok: true,
      message: 'Catalog re-embedded with ollama:nomic-embed-text.',
    });
  });
});
