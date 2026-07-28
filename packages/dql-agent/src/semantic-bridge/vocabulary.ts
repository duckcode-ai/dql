import type { DQLManifest } from '@duckcodeailabs/dql-core';
import type { SemanticVocabulary } from './compose.js';

/**
 * Build the semantic vocabulary a project has authored in its DQL terms.
 *
 * A term already carried the vocabulary half of the business layer — its name,
 * `synonyms`, `identifiers` — but could only ever attach to blocks and business
 * views, so none of it reached metric matching. The agent's synonym clusters
 * were therefore hardcoded and domain-neutral, and an internal term like "BCM"
 * could only be taught to DQL by editing its TypeScript. With `metricRefs` a
 * term names the governed metrics it describes, and this turns the glossary
 * into vocabulary the semantic bridge can actually use.
 *
 * Only terms that are not deprecated contribute, so retiring a term retires its
 * vocabulary with it.
 */
export function buildSemanticVocabulary(manifest: DQLManifest | undefined): SemanticVocabulary | undefined {
  const terms = Object.values(manifest?.terms ?? {});
  if (terms.length === 0) return undefined;

  const synonymClusters: string[][] = [];
  const metricAliases: Record<string, string[]> = {};

  for (const term of terms) {
    if (term.status && term.status.toLowerCase() === 'deprecated') continue;
    const phrases = [term.name, ...(term.synonyms ?? []), ...(term.identifiers ?? [])]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value));
    const unique = [...new Set(phrases)];

    // A cluster only means anything with two or more members.
    if (unique.length > 1) synonymClusters.push(unique);

    const metricRefs = (term.metricRefs ?? []).map((ref) => ref.trim()).filter(Boolean);
    if (metricRefs.length === 0) continue;
    for (const phrase of unique) {
      metricAliases[phrase] = [...new Set([...(metricAliases[phrase] ?? []), ...metricRefs])];
    }
  }

  if (synonymClusters.length === 0 && Object.keys(metricAliases).length === 0) return undefined;
  return {
    ...(synonymClusters.length > 0 ? { synonymClusters } : {}),
    ...(Object.keys(metricAliases).length > 0 ? { metricAliases } : {}),
  };
}
