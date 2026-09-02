import { openMetadataCatalog } from './catalog.js';

/**
 * The embedder a project's vector index was actually built with.
 *
 * Retrieval can only search an index with the provider that wrote it, so this
 * — not the project's configured preference — is what describes the state a
 * user is really in. Read-only and never throws: an unreadable or absent
 * catalog simply has no answer.
 */
export function indexedVectorProviderId(projectRoot: string): string | undefined {
  try {
    const catalog = openMetadataCatalog(projectRoot);
    try {
      const provider = catalog.state('vector_provider');
      return typeof provider === 'string' && provider.trim() ? provider.trim() : undefined;
    } finally {
      catalog.close();
    }
  } catch {
    return undefined;
  }
}
