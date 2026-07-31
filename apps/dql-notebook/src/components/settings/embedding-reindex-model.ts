import type { EmbeddingReindexResult, EmbeddingSettingsResponse } from '../../api/client';

export function embeddingReindexOutcome(
  result: EmbeddingReindexResult,
  current: EmbeddingSettingsResponse,
): { ok: boolean; message: string } {
  if (current.reindexRequired) {
    return {
      ok: false,
      message: `Re-index did not complete — ${result.reason ?? 'the catalog is still using a different embedding index'}.`,
    };
  }
  if (result.upgraded) {
    return { ok: true, message: `Catalog re-embedded with ${current.activeProviderId}.` };
  }
  return { ok: true, message: `No re-index needed — ${result.reason ?? 'already current'}.` };
}
