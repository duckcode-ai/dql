/**
 * Paraphrase-tolerant certified-example matching (W2.1).
 *
 * `hasExactExampleQuestion` matches a question to a block's `examples[].question`
 * by normalized string equality, so a paraphrase ("which 5 products earn the most"
 * vs the certified "top 5 products by revenue") misses Tier 1 and falls through to
 * generation. This module adds a semantic (embedding cosine) match. It is used only
 * to PROMOTE a block to the certified candidate — the promoted block still runs the
 * full shape/grain fit + direction check, so a paraphrase never bypasses grain the
 * way a user naming the block directly does. Degrades safely on the default hashed
 * embedder (behaves like fuzzy token overlap); lights up with a real provider.
 */
import { cosineSimilarity, type EmbeddingProvider } from '../embeddings/provider.js';
import type { MetadataObject } from './catalog.js';

/** Default cosine threshold for a paraphrase match over the resolved provider. */
export const DEFAULT_PARAPHRASE_THRESHOLD = 0.82;

export interface ParaphraseMatchOptions {
  threshold?: number;
}

function exampleQuestions(block: MetadataObject): string[] {
  const examples: unknown[] = Array.isArray(block.payload?.examples) ? block.payload!.examples : [];
  return examples
    .map((example: unknown) => (example && typeof example === 'object' ? (example as { question?: unknown }).question : undefined))
    .filter((question: unknown): question is string => typeof question === 'string' && question.trim().length > 0);
}

/** A "top" question must not match a "bottom" example (and vice-versa). */
function rankingDirection(value: string): 'top' | 'bottom' | undefined {
  const lower = value.toLowerCase();
  const bottom = /\b(bottom|worst|lowest|least|fewest|minimum|min|smallest)\b/.test(lower);
  const top = /\b(top|best|highest|most|maximum|max|largest|leading|leaders?)\b/.test(lower);
  if (bottom && !top) return 'bottom';
  if (top && !bottom) return 'top';
  return undefined;
}

function directionCompatible(question: string, example: string): boolean {
  const q = rankingDirection(question);
  if (!q) return true;
  const e = rankingDirection(example);
  return !e || e === q;
}

/** The highest cosine between the question and any of the block's example questions. */
export async function bestExampleParaphrase(
  question: string,
  block: MetadataObject,
  provider: EmbeddingProvider,
): Promise<{ cosine: number; example?: string }> {
  const examples = exampleQuestions(block);
  if (examples.length === 0) return { cosine: 0 };
  const vectors = await provider.embed([question, ...examples]);
  const questionVector = vectors[0];
  let best = 0;
  let bestExample: string | undefined;
  for (let i = 0; i < examples.length; i++) {
    const cosine = cosineSimilarity(questionVector, vectors[i + 1]);
    if (cosine > best) {
      best = cosine;
      bestExample = examples[i];
    }
  }
  return { cosine: best, example: bestExample };
}

/**
 * True when the question paraphrases one of the block's certified example
 * questions (cosine ≥ threshold) AND the ranking direction is compatible.
 */
export async function matchExampleParaphrase(
  question: string,
  block: MetadataObject,
  provider: EmbeddingProvider,
  options: ParaphraseMatchOptions = {},
): Promise<boolean> {
  const threshold = options.threshold ?? DEFAULT_PARAPHRASE_THRESHOLD;
  const { cosine, example } = await bestExampleParaphrase(question, block, provider);
  if (cosine < threshold) return false;
  return example ? directionCompatible(question, example) : true;
}
