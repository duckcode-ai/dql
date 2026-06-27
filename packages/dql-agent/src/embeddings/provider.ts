/**
 * Pluggable semantic retrieval (Part B).
 *
 * `EmbeddingProvider` is the interface real providers (a local model, an API)
 * plug into. The DEFAULT provider is a deterministic, offline, hashed-token
 * vector — NO heavy model dependency is added. FTS5/BM25 remains the safe
 * default ranker; hybrid ranking blends FTS relevance with cosine similarity
 * from the configured provider.
 *
 * Determinism matters: the default provider must produce identical vectors for
 * identical text so tests are stable offline.
 */

import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  /** Provider id, surfaced in diagnostics, e.g. "hashed-token-v1". */
  readonly id: string;
  /** Vector dimensionality. */
  readonly dimensions: number;
  /** Embed a batch of texts. Must be deterministic for the default provider. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity in [-1, 1]; 0 for degenerate vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/**
 * Deterministic, dependency-free embedding via the hashing trick: each token is
 * hashed to a bucket and a sign; counts accumulate into a fixed-width vector,
 * then the vector is L2-normalised. Captures lexical overlap so semantically
 * similar (shared-token) texts score higher under cosine similarity — enough to
 * make hybrid ranking testable offline without any model.
 */
export class HashedTokenEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hashed-token-v1';
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = Math.max(16, dimensions);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const h = hashToken(token);
      const bucket = h % this.dimensions;
      const sign = (h >>> 8) % 2 === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    // L2 normalise so cosine reduces to a dot product and magnitudes are comparable.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}

function hashToken(token: string): number {
  const digest = createHash('sha1').update(token).digest();
  // First 4 bytes as an unsigned int.
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

/** The safe default provider: deterministic + offline. */
export function defaultEmbeddingProvider(): EmbeddingProvider {
  return new HashedTokenEmbeddingProvider();
}

export interface HybridRankItem<T> {
  item: T;
  /** Text the item is embedded/searched on. */
  text: string;
  /** FTS/BM25-derived relevance in [0, 1] (higher better). */
  ftsScore: number;
}

export interface HybridRankOptions {
  /**
   * Weight on the vector-similarity component in [0, 1]. 0 = pure FTS5 (the safe
   * default). The blended score is `(1 - alpha) * fts + alpha * cosine01`.
   */
  alpha?: number;
  provider?: EmbeddingProvider;
}

export interface HybridRanked<T> {
  item: T;
  ftsScore: number;
  vectorScore: number;
  score: number;
}

/**
 * Blend FTS5 relevance with embedding cosine similarity. When `alpha` is 0 (the
 * default) this is a pure pass-through of the FTS ordering — FTS5 stays the safe
 * default and embeddings are strictly additive/opt-in.
 */
export async function hybridRank<T>(
  query: string,
  items: HybridRankItem<T>[],
  options: HybridRankOptions = {},
): Promise<HybridRanked<T>[]> {
  const alpha = clamp01(options.alpha ?? 0);
  if (alpha === 0 || items.length === 0) {
    return items
      .map((entry) => ({ item: entry.item, ftsScore: entry.ftsScore, vectorScore: 0, score: entry.ftsScore }))
      .sort((a, b) => b.score - a.score);
  }
  const provider = options.provider ?? defaultEmbeddingProvider();
  const [queryVec, ...itemVecs] = await provider.embed([query, ...items.map((entry) => entry.text)]);
  return items
    .map((entry, index) => {
      const cosine = cosineSimilarity(queryVec, itemVecs[index] ?? []);
      const cosine01 = (cosine + 1) / 2; // map [-1,1] → [0,1]
      const score = (1 - alpha) * entry.ftsScore + alpha * cosine01;
      return { item: entry.item, ftsScore: entry.ftsScore, vectorScore: cosine01, score };
    })
    .sort((a, b) => b.score - a.score);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
