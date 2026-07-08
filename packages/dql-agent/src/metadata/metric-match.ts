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
 *     (small non-zero alpha by default when lexical signal exists),
 *   - a strong boost when a measure FAMILY (e.g. "revenue") is shared between
 *     the question and the metric, which is what makes "total revenue" reach the
 *     revenue family even though the exact word never appears in a metric name.
 *
 * It returns the single best metric only when the score clears a confidence
 * threshold, so genuinely ad-hoc questions ("median order value by region")
 * still fall through to generated SQL, and questions with no measure at all
 * still refuse honestly.
 */

import { defaultEmbeddingProvider, envEmbeddingProvider, hybridRank, type EmbeddingProvider } from '../embeddings/provider.js';
import type { KGNode } from '../kg/types.js';
import type { SemanticLayer } from '@duckcodeailabs/dql-core';

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

/**
 * Row/record-listing intent. A question asking to ENUMERATE rows or identifiers
 * ("list the 5 most recent orders with their ids") is not a metric question even
 * though it names a measure entity ("orders") — it wants raw rows, so it should
 * fall through to grounded generated SQL, not a governed aggregate. Conservative:
 * only the clearest listing signals, so true aggregate questions ("how many
 * orders", "total revenue", "average order value") are never suppressed.
 */
const ROW_REQUEST_RE = /\b(list|listing|rows?|records?|individual|line[\s-]?items?|ids?)\b/i;
const RECENCY_RE = /\b(most\s+recent|latest|newest|oldest|last\s+\d+)\b/i;

function looksLikeRowRequest(question: string): boolean {
  return ROW_REQUEST_RE.test(question) || RECENCY_RE.test(question);
}

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

/**
 * Text used ONLY for measure-FAMILY detection: the metric's name + description +
 * tags, but NOT its `llmContext`. The llmContext carries `table:`/`sql:` lines, so
 * including it wrongly assigns a metric to the family of its backing TABLE (a
 * `tax_paid` measure on the `orders` table would falsely read as the "orders"
 * family). Family must reflect what the metric MEASURES, i.e. its name/label.
 */
function metricFamilyText(metric: KGNode): string {
  return [metric.name, metric.name.replace(/[_.]+/g, ' '), metric.description ?? '', ...(metric.tags ?? [])]
    .filter(Boolean)
    .join(' ');
}

/** The measure families a metric KG node resolves to (revenue, orders, ...). */
export function metricFamilies(metric: KGNode): Set<string> {
  return familiesFor(contentTokens(metricFamilyText(metric)));
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
  /** Vector-similarity weight; defaults to a small conservative blend. */
  alpha?: number;
  provider?: EmbeddingProvider;
}

export const DEFAULT_METRIC_MATCH_EMBEDDING_ALPHA = 0.18;

/**
 * Pick the single best governed metric for a question, or `null` when no metric
 * clears the confidence bar. Deterministic + offline by default because the
 * default provider is the hashed-token embedding.
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

  // A row/record-listing question wants raw rows, not a governed aggregate —
  // let it fall through to grounded generated SQL even if it names a measure.
  if (looksLikeRowRequest(question)) return null;

  const threshold = options.threshold ?? 0.34;
  const qContent = new Set(contentTokens(question));
  if (qContent.size === 0) return null;
  const qFamilies = familiesFor(qContent);

  // A measure question must carry at least one content word OR a measure family;
  // a bare "what is this" carries neither and should not match a metric.
  const items = candidates.map((metric) => {
    const text = metricSearchText(metric).toLowerCase();
    const nameTokens = new Set(tokenize(metric.name));
    // Family is derived from the metric's name/label only (not its `table:`), so a
    // measure is never mis-assigned to the family of the relation it sits on.
    const metricFams = familiesFor(contentTokens(metricFamilyText(metric)));

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
      if (metricFams.has(family)) {
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

  const hasLexicalSignal = items.some((entry) => entry.ftsScore > 0);
  const ranked = await hybridRank(
    question,
    items.map((entry) => ({ item: entry, text: entry.text, ftsScore: entry.ftsScore })),
    {
      alpha: hasLexicalSignal ? options.alpha ?? DEFAULT_METRIC_MATCH_EMBEDDING_ALPHA : 0,
      provider: options.provider ?? envEmbeddingProvider(),
    },
  );

  const best = ranked[0];
  if (!best || best.score < threshold) return null;
  return { metric: best.item.metric, score: best.score, family: best.item.family };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Parse a metric KG node's governed definition: the aggregate `sql:` expression
 * and its `table:` relation, stored on `llmContext`. Returns undefined when the
 * `sql:` is not an aggregate expression (a bare metric-name reference) or there is
 * no table — those are not directly executable.
 */
export function parseMetricDefinition(
  metric: KGNode,
  semanticLayer?: SemanticLayer,
): { expr: string; table: string } | undefined {
  // Prefer the STRUCTURED metric definition from the semantic layer when
  // available — no fragile text parsing. Fall back to reading the KG node's
  // llmContext blob for manifest-native metrics that carry no structured def.
  if (semanticLayer) {
    const structured = structuredMetricDefinition(metric, semanticLayer);
    if (structured) return structured;
  }
  const context = metric.llmContext ?? '';
  const expr = context.match(/(?:^|\n)\s*sql:\s*(.+?)\s*(?:\n|$)/i)?.[1]?.trim();
  const table = context.match(/(?:^|\n)\s*table:\s*(.+?)\s*(?:\n|$)/i)?.[1]?.trim();
  if (!expr || !table || !looksLikeExecutableMetricExpr(expr)) return undefined;
  return { expr, table };
}

/**
 * A metric expression is only executable when it is a real aggregate/function call
 * with a NON-EMPTY argument — SUM(x), COUNT(*), AVG(order_total). The old bare
 * `/[()]/` presence test accepted degenerate exprs like `COUNT()` / `()`, which
 * synthesize a hollow `SELECT COUNT() AS x` that errors or returns a meaningless
 * value. Require an identifier head, `(`, then at least one non-`)` argument char
 * (or `*`), so degenerate exprs fall through to honest refusal / generation instead.
 */
function looksLikeExecutableMetricExpr(expr: string): boolean {
  return /[A-Za-z_][A-Za-z0-9_]*\s*\(\s*(?:\*|[^)\s])/.test(expr);
}

/** Look up a metric's structured {expr, table} from the semantic layer by name/leaf. */
function structuredMetricDefinition(
  metric: KGNode,
  semanticLayer: SemanticLayer,
): { expr: string; table: string } | undefined {
  const candidates = [metric.name, metric.name.split('.').pop() ?? metric.name];
  for (const name of candidates) {
    const def = semanticLayer.getMetric(name);
    // Trim the structured definition (the blob path already trims); an untrimmed
    // `table: '  '` would synthesize a broken `FROM   `. Require a real executable
    // aggregate expression, same gate as the blob path.
    const sql = def?.sql?.trim();
    const table = def?.table?.trim();
    if (sql && table && looksLikeExecutableMetricExpr(sql)) {
      return { expr: sql, table };
    }
  }
  return undefined;
}

/**
 * Deterministic, offline-safe governed SQL for a matched metric (spec 17, part C):
 * a single read-only `SELECT <expr> AS <alias> FROM <table>` synthesised from the
 * metric's governed definition. Returns undefined when the definition is too thin
 * to execute, preserving honest refusal.
 */
export function metricToGovernedSql(metric: KGNode, semanticLayer?: SemanticLayer): string | undefined {
  const def = parseMetricDefinition(metric, semanticLayer);
  if (!def) return undefined;
  const alias = metric.name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'metric_value';
  return `SELECT ${def.expr} AS ${alias}\nFROM ${def.table}`;
}

/**
 * Resolve a matched metric to executable governed SQL. dbt's semantic layer splits
 * a metric from its measure: a derived MetricFlow metric (e.g. `revenue`, type=simple
 * over measure `revenue`) carries no `table:`/`sql:` of its own — the aggregate lives
 * on the backing measure node (`order_item.revenue` → `SUM(product_price)` over
 * `order_items`). When the matched metric is itself synthesizable we use it directly;
 * otherwise we fall back to a sibling whose LEAF name matches (`revenue` ⇒
 * `<model>.revenue`). No fuzzy family guessing — precise resolution or nothing.
 */
export function resolveGovernedMetricSql(
  metric: KGNode,
  pool: KGNode[],
  semanticLayer?: SemanticLayer,
): { sql: string; metric: KGNode } | undefined {
  const resolved = resolveGovernedMetricDefinition(metric, pool, semanticLayer);
  return resolved ? { sql: metricToGovernedSql(resolved.metric, semanticLayer)!, metric: resolved.metric } : undefined;
}

/** Resolve a metric (or its leaf-named sibling measure) to an executable definition. */
export function resolveGovernedMetricDefinition(
  metric: KGNode,
  pool: KGNode[],
  semanticLayer?: SemanticLayer,
): { def: { expr: string; table: string }; metric: KGNode } | undefined {
  const direct = parseMetricDefinition(metric, semanticLayer);
  if (direct) return { def: direct, metric };
  const leaf = metric.name.split('.').pop()?.toLowerCase();
  if (!leaf) return undefined;
  const leafSibling = pool
    .filter((node) => node.nodeId !== metric.nodeId && node.name.split('.').pop()?.toLowerCase() === leaf)
    .sort((a, b) => a.name.length - b.name.length)
    .find((node) => parseMetricDefinition(node, semanticLayer));
  if (!leafSibling) return undefined;
  return { def: parseMetricDefinition(leafSibling, semanticLayer)!, metric: leafSibling };
}

export interface GovernedMetricFirstResult {
  sql: string;
  metric: KGNode;
  dimensions: string[];
}

/**
 * Tier 2 of the governed answer hierarchy (certified blocks → semantic-layer
 * metrics + dimensions → generated SQL): deterministically synthesize executable
 * SQL for a confidently matched metric WHEN its governed definition can express
 * the question's full requested shape — a scalar KPI, or a group-by whose
 * requested dimensions ALL resolve to real columns on the metric's own table
 * (verified against the runtime schema). Precise-or-nothing: any unresolvable
 * dimension, explicit filter, extra measure, or per-group top-N returns
 * undefined so the question falls through to generation, where the metric still
 * grounds the prompt as context.
 */
export function buildGovernedMetricFirstSql(input: {
  metric: KGNode;
  pool: KGNode[];
  requestedShape: {
    dimensions: string[];
    measures: string[];
    filters: string[];
    topN?: { n: number; scope: 'overall' | 'per_group' };
    rankingDirection?: 'top' | 'bottom';
  };
  schemaTables: Array<{ relation: string; name?: string; columns: Array<{ name: string }> }>;
  semanticLayer?: SemanticLayer;
}): GovernedMetricFirstResult | undefined {
  const { requestedShape } = input;
  // Conservative gates: ONE measure family (the planner expands a single ask
  // into variants — 'revenue'/'total'/'total_revenue' — so count families, not
  // terms), no explicit filter values (value binding stays with generation),
  // and no per-group ranking.
  const families = new Set(
    requestedShape.measures
      .map((measure) => measureFamilyOf(measure))
      .filter((family): family is string => Boolean(family)),
  );
  if (families.size > 1) return undefined;
  if (requestedShape.filters.length > 0) return undefined;
  if (requestedShape.topN?.scope === 'per_group') return undefined;
  const resolved = resolveGovernedMetricDefinition(input.metric, input.pool, input.semanticLayer);
  if (!resolved) return undefined;
  const alias = resolved.metric.name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'metric_value';

  if (requestedShape.dimensions.length === 0) {
    return {
      sql: `SELECT ${resolved.def.expr} AS ${alias}\nFROM ${resolved.def.table}`,
      metric: resolved.metric,
      dimensions: [],
    };
  }

  const table = findSchemaTable(resolved.def.table, input.schemaTables);
  if (!table) return undefined;
  const columns: string[] = [];
  for (const dimension of requestedShape.dimensions) {
    const column = resolveDimensionColumn(dimension, table.columns);
    if (!column) return undefined;
    if (!columns.includes(column)) columns.push(column);
  }
  const direction = requestedShape.rankingDirection === 'bottom' ? 'ASC' : 'DESC';
  const limit = requestedShape.topN?.n;
  return {
    sql: [
      `SELECT ${columns.join(', ')}, ${resolved.def.expr} AS ${alias}`,
      `FROM ${resolved.def.table}`,
      `GROUP BY ${columns.join(', ')}`,
      `ORDER BY ${alias} ${direction}`,
      ...(limit ? [`LIMIT ${limit}`] : []),
    ].join('\n'),
    metric: resolved.metric,
    dimensions: columns,
  };
}

/** Resolve a measure term to its synonym family (undefined for generic words like 'total'). */
function measureFamilyOf(term: string): string | undefined {
  const tokens = term.toLowerCase().match(TOKEN_RE) ?? [];
  for (const [family, words] of Object.entries(MEASURE_FAMILIES)) {
    if (tokens.some((token) => words.includes(token))) return family;
  }
  return undefined;
}

function findSchemaTable(
  table: string,
  schemaTables: Array<{ relation: string; name?: string; columns: Array<{ name: string }> }>,
): { relation: string; columns: Array<{ name: string }> } | undefined {
  const target = table.toLowerCase();
  const targetLeaf = target.split('.').pop() ?? target;
  return schemaTables.find((candidate) => {
    const relation = candidate.relation.toLowerCase();
    const name = candidate.name?.toLowerCase();
    return relation === target
      || relation.split('.').pop() === targetLeaf
      || name === target
      || name === targetLeaf;
  });
}

/** Map a requested dimension term to a real column on the metric's table (exact-ish only). */
function resolveDimensionColumn(dimension: string, columns: Array<{ name: string }>): string | undefined {
  const term = dimension.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const singular = term.replace(/s$/, '');
  const candidates = [term, singular, `${term}_name`, `${singular}_name`];
  for (const candidate of candidates) {
    const hit = columns.find((column) => column.name.toLowerCase() === candidate);
    if (hit) return hit.name;
  }
  const suffixHit = columns.find((column) => {
    const name = column.name.toLowerCase();
    return name.endsWith(`_${singular}`) || name.endsWith(`_${term}`);
  });
  return suffixHit?.name;
}
