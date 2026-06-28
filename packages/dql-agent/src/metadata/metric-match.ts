/**
 * Semantic-metric matching (spec 17, part C).
 *
 * The answer-loop already has a `semantic_layer` tier in its route order
 * (certified → business_context → semantic_layer → dbt_manifest → generated →
 * refuse). The miss it fixes here: matching a clear metric question to a governed
 * metric was purely string-based (FTS token overlap), so "what is our total
 * revenue" did not connect to a revenue-family metric like `cumulative_revenue`,
 * `food_revenue`, or `lifetime_spend` — no metric is literally named "revenue" —
 * and the loop refused instead of routing to the semantic tier.
 *
 * `matchSemanticMetric` ranks candidate metric KG nodes against the question
 * using:
 *   - a synonym/family expansion of the question's measure terms (revenue ⇄
 *     spend/sales/income/arr; orders ⇄ purchases; ...), and of each metric's
 *     searchable text (name + synonyms + label + description + tags),
 *   - lexical token overlap blended through the spec-11 `hybridRank`
 *     (alpha defaults to 0 → pure lexical, offline-stable for tests),
 *   - a strong boost when a measure FAMILY (e.g. "revenue") is shared between
 *     the question and the metric, which is what makes "total revenue" reach the
 *     revenue family even though the exact word never appears in a metric name.
 *
 * It returns the single best metric only when the score clears a confidence
 * threshold, so genuinely ad-hoc questions ("median order value by region")
 * still fall through to generated SQL, and questions with no measure at all
 * still refuse honestly.
 */

import { defaultEmbeddingProvider, hybridRank, type EmbeddingProvider } from '../embeddings/provider.js';
import type { KGNode } from '../kg/types.js';

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** Stopwords that should never count toward a measure/metric match. */
const STOPWORDS = new Set([
  'what', 'whats', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'our', 'my', 'we',
  'of', 'for', 'in', 'on', 'to', 'by', 'and', 'or', 'show', 'me', 'give', 'tell',
  'how', 'much', 'many', 'this', 'that', 'these', 'those', 'do', 'does', 'did',
  'total', 'overall', 'current', 'all', 'per', 'each', 'value', 'amount', 'number',
  'count', 'sum', 'average', 'avg', 'get', 'find', 'whole', 'entire',
]);

/**
 * Measure synonym families. Each family maps a canonical measure to the set of
 * words that signal it. A question and a metric "share a family" when any word
 * from the question and any word from the metric resolve to the same family.
 */
const MEASURE_FAMILIES: Record<string, string[]> = {
  revenue: ['revenue', 'revenues', 'sales', 'income', 'turnover', 'earnings', 'gmv', 'arr', 'mrr', 'bookings', 'topline'],
  spend: ['spend', 'spending', 'spent', 'cost', 'costs', 'expense', 'expenses', 'cogs'],
  profit: ['profit', 'profits', 'margin', 'margins', 'gross', 'net', 'ebitda'],
  orders: ['order', 'orders', 'purchase', 'purchases', 'transaction', 'transactions', 'checkout', 'checkouts'],
  customers: ['customer', 'customers', 'user', 'users', 'account', 'accounts', 'buyer', 'buyers', 'shopper', 'shoppers'],
  churn: ['churn', 'churned', 'attrition', 'cancel', 'cancellation', 'cancellations', 'logo'],
  retention: ['retention', 'retained', 'renewal', 'renewals'],
  quantity: ['quantity', 'units', 'volume', 'qty'],
  aov: ['aov', 'basket'],
};

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/** Content tokens (stopwords stripped) used for measure/family signal. */
function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/** The measure families a set of words resolves to. */
function familiesFor(words: Iterable<string>): Set<string> {
  const set = new Set<string>(words);
  const families = new Set<string>();
  for (const [family, members] of Object.entries(MEASURE_FAMILIES)) {
    if (members.some((member) => set.has(member))) families.add(family);
  }
  return families;
}

/** Searchable text for a metric KG node: name, synonyms, label, description, tags. */
function metricSearchText(metric: KGNode): string {
  return [
    metric.name,
    metric.name.replace(/[_.]+/g, ' '),
    metric.description ?? '',
    metric.llmContext ?? '',
    ...(metric.tags ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

export interface MetricMatch {
  metric: KGNode;
  /** Blended relevance in [0, 1]. */
  score: number;
  /** The shared measure family that justified the match, if any. */
  family?: string;
}

export interface MatchSemanticMetricOptions {
  /**
   * Confidence threshold. A match below this is treated as "no confident metric"
   * so ad-hoc questions still fall through to generated SQL. Default 0.34.
   */
  threshold?: number;
  /** Vector-similarity weight; 0 (default) = offline-stable pure lexical. */
  alpha?: number;
  provider?: EmbeddingProvider;
}

/**
 * Pick the single best governed metric for a question, or `null` when no metric
 * clears the confidence bar. Deterministic + offline by default (alpha=0).
 *
 * Scoring per candidate metric:
 *   base   = lexical token overlap fraction (question content tokens present in
 *            the metric's searchable text), in [0, 1]
 *   family = +0.6 when the question and metric share a measure family
 *   name   = +0.25 when a question content token appears in the metric NAME
 *            (so "food revenue" prefers `food_revenue` over `drink_revenue`)
 * The blended FTS score is fed to `hybridRank` so spec-11 embeddings can refine
 * it when a provider/alpha is supplied.
 */
export async function matchSemanticMetric(
  question: string,
  metrics: KGNode[],
  options: MatchSemanticMetricOptions = {},
): Promise<MetricMatch | null> {
  const candidates = metrics.filter((m) => m.kind === 'metric');
  if (candidates.length === 0) return null;

  const threshold = options.threshold ?? 0.34;
  const qContent = new Set(contentTokens(question));
  if (qContent.size === 0) return null;
  const qFamilies = familiesFor(qContent);

  // A measure question must carry at least one content word OR a measure family;
  // a bare "what is this" carries neither and should not match a metric.
  const items = candidates.map((metric) => {
    const text = metricSearchText(metric).toLowerCase();
    const nameTokens = new Set(tokenize(metric.name));
    const metricWords = new Set(contentTokens(text));
    const metricFamilies = familiesFor(metricWords);

    let overlap = 0;
    let nameHit = 0;
    for (const token of qContent) {
      if (text.includes(token)) overlap += 1;
      if (nameTokens.has(token)) nameHit += 1;
    }
    const lexical = overlap / qContent.size;
    // Fraction of question content tokens present in the metric NAME — this is
    // what separates `food_revenue` from `cumulative_revenue` for "food revenue".
    const nameFraction = nameHit / qContent.size;

    let sharedFamily: string | undefined;
    for (const family of qFamilies) {
      if (metricFamilies.has(family)) {
        sharedFamily = family;
        break;
      }
    }

    // Blend the signals on a fixed budget so no single component saturates the
    // clamp and hides a more specific name match.
    const familyBoost = sharedFamily ? 0.45 : 0;
    const fts = clamp01(0.35 * lexical + familyBoost + 0.35 * nameFraction);
    return { metric, text: metricSearchText(metric), ftsScore: fts, family: sharedFamily };
  });

  const ranked = await hybridRank(
    question,
    items.map((entry) => ({ item: entry, text: entry.text, ftsScore: entry.ftsScore })),
    { alpha: options.alpha ?? 0, provider: options.provider ?? (options.alpha ? defaultEmbeddingProvider() : undefined) },
  );

  const best = ranked[0];
  if (!best || best.score < threshold) return null;
  return { metric: best.item.metric, score: best.score, family: best.item.family };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
