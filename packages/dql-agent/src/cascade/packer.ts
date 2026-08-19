/**
 * Token-budgeted context packing.
 *
 * Every prompt budget in `budgets.ts` is an ITEM COUNT — 12 tables, 50 columns,
 * 18 context objects — and there is no token estimator anywhere in the package.
 * Counts are a poor proxy for what actually fits: one wide fact table with 200
 * documented columns costs more than thirty lean dimensions, so a fixed top-N
 * either wastes most of the window or silently overruns it. Worse, it truncates
 * by POSITION rather than by value, so the object that would have answered the
 * question gets cut because it ranked 19th.
 *
 * This packs by value per token instead, with hard-priority tiers that always go
 * in first. It is deliberately a pure function over already-ranked items: the
 * ranking stays where the evidence is, and this only decides what fits.
 */

/** A candidate piece of prompt context, already scored by retrieval. */
export interface PackItem {
  id: string;
  /** Rendered text. Called at most once per item, so it may be expensive. */
  render: () => string;
  /**
   * Relevance, higher is better. Compared only against other items in the same
   * pack, so any consistent scale works.
   */
  score: number;
  /**
   * Items that must be included regardless of budget, lowest number first.
   * Reserved for context whose ABSENCE changes the answer's correctness rather
   * than its quality: the frozen plan's bound identifiers, the certified block's
   * SQL, the relations the query is allowed to touch. Everything else competes.
   */
  priority?: number;
}

export interface PackResult {
  text: string;
  included: string[];
  dropped: string[];
  tokensUsed: number;
  /** True when a hard-priority item alone exceeded the budget. */
  overBudget: boolean;
}

/**
 * Estimate tokens for prompt text.
 *
 * chars/4 is the standard rough ratio and lands within ~10% on schema text,
 * which is mostly short identifiers and punctuation. It is deliberately an
 * ESTIMATE with a pluggable seam rather than a real BPE tokenizer: pulling one
 * in costs a dependency and per-model vocabularies, and a packer only needs to
 * be right enough to stop truncating by position. Swap in a real tokenizer here
 * when a provider's exact window becomes the binding constraint.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type TokenEstimator = (text: string) => number;

export interface PackOptions {
  /** Defaults to {@link estimateTokens}. */
  estimate?: TokenEstimator;
  /** Joined between rendered items. Its cost is counted. */
  separator?: string;
}

/**
 * Pack items into a token budget, best value first.
 *
 * Hard-priority items are admitted in priority order before anything competes,
 * and they are admitted EVEN IF that exceeds the budget — a prompt missing the
 * relations its SQL is allowed to touch is not a smaller prompt, it is a wrong
 * one. `overBudget` reports that so a caller can widen the window or shed work
 * rather than silently shipping an over-length request.
 *
 * The rest are greedy by score-per-token. Greedy is not optimal for knapsack,
 * but the alternative is a DP over a set that changes every turn, and the
 * ordering that matters — high-value-dense context first — is what greedy gets
 * right.
 */
export function packContext(
  items: readonly PackItem[],
  budgetTokens: number,
  options: PackOptions = {},
): PackResult {
  const estimate = options.estimate ?? estimateTokens;
  const separator = options.separator ?? '\n';
  const separatorCost = estimate(separator);

  const rendered = items.map((item) => {
    const text = item.render();
    return { item, text, tokens: estimate(text) };
  });

  const required = rendered
    .filter((entry) => entry.item.priority !== undefined)
    .sort((left, right) =>
      (left.item.priority ?? 0) - (right.item.priority ?? 0)
      || right.item.score - left.item.score
      || left.item.id.localeCompare(right.item.id));

  const optional = rendered
    .filter((entry) => entry.item.priority === undefined)
    .sort((left, right) => {
      // Value per token. A zero-token item is free, so it sorts first rather
      // than dividing by zero.
      const leftDensity = left.tokens === 0 ? Number.POSITIVE_INFINITY : left.item.score / left.tokens;
      const rightDensity = right.tokens === 0 ? Number.POSITIVE_INFINITY : right.item.score / right.tokens;
      return rightDensity - leftDensity
        || right.item.score - left.item.score
        || left.item.id.localeCompare(right.item.id);
    });

  const chosen: typeof rendered = [];
  const dropped: string[] = [];
  let used = 0;

  for (const entry of required) {
    used += entry.tokens + (chosen.length > 0 ? separatorCost : 0);
    chosen.push(entry);
  }
  const overBudget = used > budgetTokens;

  for (const entry of optional) {
    const cost = entry.tokens + (chosen.length > 0 ? separatorCost : 0);
    if (used + cost > budgetTokens) {
      dropped.push(entry.item.id);
      continue;
    }
    used += cost;
    chosen.push(entry);
  }

  return {
    text: chosen.map((entry) => entry.text).join(separator),
    included: chosen.map((entry) => entry.item.id),
    dropped,
    tokensUsed: used,
    overBudget,
  };
}

/**
 * Token budgets by analysis depth, replacing the item counts in `budgets.ts`.
 *
 * Sized against typical provider windows with room for the system prompt, the
 * conversation, and the response — the context pack is a share of the window,
 * never the whole thing.
 */
export const PROMPT_TOKEN_BUDGETS = {
  quick: 6_000,
  deep: 24_000,
  research: 48_000,
} as const;

export type PromptTokenBudget = keyof typeof PROMPT_TOKEN_BUDGETS;
