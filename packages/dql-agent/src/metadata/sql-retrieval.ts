/**
 * Table retrieval (spec 15, part 3) — give the model the RELEVANT tables, not
 * 40 arbitrary ones. Ranks dbt models against the request using lexical
 * overlap (a lightweight, offline FTS/BM25-style score over model name +
 * columns + description) blended with the spec-11 `EmbeddingProvider` cosine
 * similarity via `hybridRank`. Returns the top-K model names to feed into
 * `buildSchemaGrounding`.
 *
 * Deterministic + offline by default: the default embedding provider is the
 * hashed-token vector. A small non-zero blend lets a pluggable provider refine
 * paraphrase matches while lexical recall remains the gate.
 */

import { defaultEmbeddingProvider, hybridRank, type EmbeddingProvider } from '../embeddings/provider.js';
import type { DbtArtifacts, DbtModelNode } from '../propose/dbt-artifacts.js';

export interface SelectRelevantModelsOptions {
  /** Max models to return. */
  topK?: number;
  /** Vector-similarity weight in [0,1]; 0 (default) = pure lexical, offline-stable. */
  alpha?: number;
  provider?: EmbeddingProvider;
}

export const DEFAULT_SQL_RETRIEVAL_EMBEDDING_ALPHA = 0.18;

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/** Searchable text for a model: name, columns, description, tags, domain. */
function modelText(model: DbtModelNode, artifacts: DbtArtifacts): string {
  const cols = (artifacts.catalogColumns.get(model.uniqueId) ?? model.columns).map((c) => c.name);
  return [
    model.name,
    model.alias ?? '',
    model.qualifiedRelation,
    model.description ?? '',
    model.domainHint ?? '',
    model.folder ?? '',
    ...model.tags,
    ...cols,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * A simple normalized lexical relevance: fraction of query tokens that appear
 * in the model's searchable text, with a small boost for name matches. In [0,1].
 */
function lexicalScore(queryTokens: string[], model: DbtModelNode, artifacts: DbtArtifacts): number {
  if (queryTokens.length === 0) return 0;
  const text = modelText(model, artifacts).toLowerCase();
  const nameTokens = new Set(tokenize(`${model.name} ${model.alias ?? ''}`));
  let hits = 0;
  let nameHits = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) hits += 1;
    if (nameTokens.has(token)) nameHits += 1;
  }
  const coverage = hits / queryTokens.length;
  const nameBoost = nameHits > 0 ? 0.25 : 0;
  return Math.min(1, coverage + nameBoost);
}

/**
 * Rank models by relevance to `request` and return the top-K model names
 * (logical `name`, suitable for `buildSchemaGrounding`'s `relevantModels`).
 * When no model has any lexical or embedding overlap, falls back to the most
 * frequently run models (dbt run_results), then alphabetical — so the grounding
 * is never empty and never arbitrary insertion order.
 */
export async function selectRelevantModels(
  artifacts: DbtArtifacts | undefined,
  request: string,
  options: SelectRelevantModelsOptions = {},
): Promise<string[]> {
  if (!artifacts || artifacts.models.length === 0) return [];
  const topK = Math.max(1, options.topK ?? 12);
  const queryTokens = tokenize(request);

  const items = artifacts.models.map((model) => ({
    item: model,
    text: modelText(model, artifacts),
    ftsScore: lexicalScore(queryTokens, model, artifacts),
  }));

  const hasLexicalSignal = items.some((item) => item.ftsScore > 0);
  const ranked = await hybridRank(request, items, {
    alpha: hasLexicalSignal ? options.alpha ?? DEFAULT_SQL_RETRIEVAL_EMBEDDING_ALPHA : 0,
    provider: options.provider ?? defaultEmbeddingProvider(),
  });

  const withSignal = ranked.filter((r) => r.ftsScore > 0 || (hasLexicalSignal && r.score > 0));
  let chosen: typeof ranked;
  if (withSignal.length > 0) {
    chosen = withSignal.slice(0, topK);
  } else {
    // No lexical or embedding signal at all. Rather than returning models in
    // arbitrary insertion order, prefer the ones that actually matter: most
    // frequently run (dbt run_results) first, then alphabetical for stability.
    chosen = [...ranked]
      .sort((a, b) => {
        const runsA = artifacts.runCounts.get(a.item.uniqueId) ?? 0;
        const runsB = artifacts.runCounts.get(b.item.uniqueId) ?? 0;
        if (runsB !== runsA) return runsB - runsA;
        return a.item.name.localeCompare(b.item.name);
      })
      .slice(0, topK);
  }
  return chosen.map((r) => r.item.name);
}
