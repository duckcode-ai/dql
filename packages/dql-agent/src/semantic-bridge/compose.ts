import type {
  ComposeQueryResult,
  DimensionDefinition,
  DqlArtifactReference,
  MetricDefinition,
  SemanticLayer,
} from '@duckcodeailabs/dql-core';
import type { KGNode } from '../kg/types.js';
import type { AnalysisQuestionPlan } from '../metadata/analysis-planner.js';

export interface SemanticBridgeFilter {
  dimension: string;
  operator: string;
  values: string[];
}

export interface SemanticBridgeOrderBy {
  name: string;
  direction: 'asc' | 'desc';
}

export interface SemanticDqlArtifactInput {
  question: string;
  name?: string;
  metrics: string[];
  domain?: string;
  titleFallback?: string;
  dimensions: string[];
  filters: SemanticBridgeFilter[];
  timeDimension?: { name: string; granularity: string };
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
}

export interface SemanticBridgeQueryResult {
  sql: string;
  /** Primary metric kept for backward-compatible route labels and citations. */
  metric: string;
  metrics: string[];
  dimensions: string[];
  filters: SemanticBridgeFilter[];
  timeDimension?: { name: string; granularity: string };
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
  dqlArtifact: DqlArtifactReference & { kind: 'semantic_block' };
  composeResult: ComposeQueryResult;
}

export interface ComposeSemanticQueryInput {
  semanticLayer: SemanticLayer;
  question: string;
  questionPlan: AnalysisQuestionPlan;
  matchedMetric?: KGNode;
  driver?: string;
  tableMapping?: Record<string, string>;
  /**
   * Resolve a filter literal to the physical column name(s) whose sampled values
   * contain it (from the runtime value index / schema sample values). Lets us bind
   * a value like "beverage" to whichever dimension actually carries it, instead of
   * hard-coding project-specific value→dimension guesses.
   */
  filterValueColumns?: (value: string) => string[];
}

export function composeSemanticQueryForQuestion(input: ComposeSemanticQueryInput): SemanticBridgeQueryResult | undefined {
  if (input.questionPlan.requestedShape.topN?.scope === 'per_group') return undefined;

  const metrics = selectMetrics(input.semanticLayer.listMetrics(), input);
  const primaryMetric = metrics[0];
  if (!primaryMetric) return undefined;

  const timeDimension = selectTimeDimension(input.semanticLayer, input.question, input.questionPlan);
  const allDimensions = input.semanticLayer.listDimensions();
  const dimensionSelection = selectDimensions(allDimensions, input.questionPlan, timeDimension?.name);
  const dimensions = dimensionSelection.dimensions;
  const filters = selectFilters(allDimensions, dimensions, input.question, input.questionPlan, timeDimension?.name, input.filterValueColumns);
  if (input.questionPlan.requestedShape.filters.length > 0 && filters.length === 0) return undefined;
  // Abort only on a LOAD-BEARING unresolved dimension — one that isn't actually a
  // filter value or a time grain we already captured. Previously ANY unresolved
  // term (compose.ts:75) killed the governed compile, so "revenue for beverages by
  // month" fell to raw generation because "beverages" (a filter value) and "month"
  // (the time grain) parsed as dimension terms that no dimension is named after.
  const consumed = consumedTermTokens(filters, timeDimension);
  const loadBearing = dimensionSelection.unresolved.filter((term) => {
    const tokens = tokenize(term);
    return tokens.length > 0 && !tokens.every((token) => consumed.has(token));
  });
  if (loadBearing.length > 0) return undefined;
  const limit = input.questionPlan.requestedShape.topN?.n;
  const buildFor = (candidateMetrics: MetricDefinition[]): SemanticBridgeQueryResult | undefined => {
    const primary = candidateMetrics[0];
    if (!primary) return undefined;
    const orderBy = input.questionPlan.requestedShape.topN
      ? [{ name: primary.name, direction: input.questionPlan.requestedShape.rankingDirection === 'bottom' ? 'asc' as const : 'desc' as const }]
      : undefined;
    return buildSemanticBridgeResult({
      semanticLayer: input.semanticLayer,
      question: input.question,
      metrics: candidateMetrics,
      dimensions,
      filters,
      timeDimension,
      orderBy,
      limit,
      driver: input.driver,
      tableMapping: input.tableMapping,
    });
  };

  const primary = buildFor(metrics);
  if (primary || dimensions.length === 0) return primary;
  // Grain-aware disambiguation: the chosen metric could not compose with the
  // requested breakdown (wrong grain — e.g. an all-orders `total_revenue` asked
  // "by product", when a product-grain `product_revenue` exists). Retry with each
  // OTHER family/concept-matching metric as the sole primary until one whose grain
  // actually joins the requested dimensions composes. This is what makes "revenue
  // by product" land on product_revenue instead of falling to raw generation.
  const tried = new Set(metrics.map((metric) => metric.name));
  for (const alternative of alternativePrimaryMetrics(input, tried)) {
    const result = buildFor([alternative]);
    if (result) return result;
  }
  return undefined;
}

/** A validated member selection, e.g. from an LLM emitting the query_semantic_model contract. */
export interface SemanticMemberSelection {
  metrics: string[];
  dimensions?: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: SemanticBridgeFilter[];
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
}

/**
 * Compose from an EXPLICIT member selection (metrics/dimensions/grain/filters),
 * validating each member against the layer before compiling. This is the Lane-2
 * fallback when deterministic token-overlap selection misses but the semantic
 * layer still covers the question — an LLM picks members, the compiler owns SQL.
 */
export function composeSemanticQueryFromMembers(input: {
  semanticLayer: SemanticLayer;
  question: string;
  selection: SemanticMemberSelection;
  driver?: string;
  tableMapping?: Record<string, string>;
}): SemanticBridgeQueryResult | undefined {
  const metricByName = new Map(input.semanticLayer.listMetrics().map((metric) => [metric.name.toLowerCase(), metric]));
  const metrics = uniqueStrings(input.selection.metrics ?? [])
    .map((name) => metricByName.get(name.toLowerCase()))
    .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
  if (metrics.length === 0) return undefined;

  const dimensionNames = new Set(input.semanticLayer.listDimensions().map((dimension) => dimension.name.toLowerCase()));
  const dimensions = uniqueStrings(input.selection.dimensions ?? [])
    .map((name) => input.semanticLayer.listDimensions().find((dimension) => dimension.name.toLowerCase() === name.toLowerCase())?.name)
    .filter((name): name is string => Boolean(name));
  // A hallucinated dimension is a hard miss — refuse rather than silently drop it.
  if ((input.selection.dimensions ?? []).some((name) => !dimensionNames.has(name.toLowerCase()))) return undefined;
  const filters = (input.selection.filters ?? []).filter((filter) => dimensionNames.has(filter.dimension.toLowerCase()));
  if ((input.selection.filters ?? []).length > 0 && filters.length === 0) return undefined;

  return buildSemanticBridgeResult({
    semanticLayer: input.semanticLayer,
    question: input.question,
    metrics,
    dimensions,
    filters,
    timeDimension: input.selection.timeDimension,
    orderBy: input.selection.orderBy,
    limit: input.selection.limit,
    driver: input.driver,
    tableMapping: input.tableMapping,
  });
}

function buildSemanticBridgeResult(input: {
  semanticLayer: SemanticLayer;
  question: string;
  metrics: MetricDefinition[];
  dimensions: string[];
  filters: SemanticBridgeFilter[];
  timeDimension?: { name: string; granularity: string };
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
  driver?: string;
  tableMapping?: Record<string, string>;
}): SemanticBridgeQueryResult | undefined {
  const { metrics, dimensions, filters, timeDimension, orderBy, limit } = input;
  const primaryMetric = metrics[0];
  if (!primaryMetric) return undefined;
  const composed = input.semanticLayer.composeQuery({
    metrics: metrics.map((metric) => metric.name),
    dimensions,
    ...(filters.length > 0 ? { filters } : {}),
    ...(timeDimension ? { timeDimension } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(limit ? { limit } : {}),
    ...(input.driver ? { driver: input.driver } : {}),
    ...(input.tableMapping ? { tableMapping: input.tableMapping } : {}),
  });
  if (!composed) return undefined;
  // A degenerate compile — empty/blank SQL — is NOT a governed answer. It happens
  // when the (LLM- or token-) selected metric×dimension combo can't be expressed
  // by the layer (e.g. a cumulative metric sliced by an unjoined product dimension:
  // `cumulative_revenue by product_description`). Returning it would surface a
  // confident "Answered from governed semantic metrics…" with an EMPTY SQL preview
  // and no rows — a hollow answer. Reject it so the answer loop falls through to
  // Lane-3 generation, which can express the join and actually execute.
  if (typeof composed.sql !== 'string' || composed.sql.trim().length === 0) return undefined;
  const artifactName = semanticDqlArtifactName({
    question: input.question,
    metrics: metrics.map((metric) => metric.name),
    dimensions,
    filters,
    timeDimension,
    orderBy,
    limit,
  });
  return {
    sql: composed.sql,
    metric: primaryMetric.name,
    metrics: metrics.map((metric) => metric.name),
    dimensions,
    filters,
    ...(timeDimension ? { timeDimension } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(limit ? { limit } : {}),
    dqlArtifact: {
      kind: 'semantic_block',
      name: artifactName,
      source: renderSemanticDqlArtifact({
        name: artifactName,
        question: input.question,
        metrics: metrics.map((metric) => metric.name),
        domain: sharedMetricDomain(metrics),
        titleFallback: primaryMetric.label || primaryMetric.name,
        dimensions,
        filters,
        timeDimension,
        orderBy,
        limit,
      }),
      metrics: metrics.map((metric) => metric.name),
      dimensions,
      ...(filters.length > 0 ? { filters } : {}),
      ...(timeDimension ? { timeDimension } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(limit ? { limit } : {}),
    },
    composeResult: composed,
  };
}

function selectMetrics(metrics: MetricDefinition[], input: ComposeSemanticQueryInput): MetricDefinition[] {
  if (metrics.length === 0) return [];
  const selected: MetricDefinition[] = [];
  const hintedNames = input.matchedMetric
    ? [input.matchedMetric.name, leafName(input.matchedMetric.name)]
    : [];
  for (const hint of hintedNames) {
    const hit = metrics.find((metric) => semanticNameMatches(metric, hint));
    if (hit) {
      selected.push(hit);
      break;
    }
  }

  const concepts = metricSelectionConcepts(input.questionPlan);
  for (const concept of concepts) {
    const tokens = new Set(tokenize(concept));
    if (tokens.size === 0 || selected.some((metric) => scoreMetric(metric, tokens) > 0)) {
      continue;
    }
    const hit = bestMetricForConcept(metrics, tokens, selected);
    if (hit) selected.push(hit);
  }

  if (selected.length > 0) return selected.slice(0, 4);

  const fallbackTerms = new Set([...input.questionPlan.metricTerms, ...input.questionPlan.requestedShape.measures].flatMap(tokenize));
  if (fallbackTerms.size === 0) return [];
  return metrics
    .map((metric) => ({ metric, score: scoreMetric(metric, fallbackTerms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.metric.name.localeCompare(b.metric.name))
    .slice(0, 1)
    .map((candidate) => candidate.metric);
}

/**
 * Family/concept-matching metrics NOT already tried as primary, ranked by concept
 * score, for the grain-aware disambiguation retry. When several metrics share a
 * measure family ("revenue"), the first-picked one may sit at the wrong grain for
 * the requested breakdown; these are the alternatives to try, best concept-match
 * first, so the compose can land on the metric whose grain actually joins the
 * requested dimensions. Bounded to a handful so the retry stays cheap.
 */
function alternativePrimaryMetrics(input: ComposeSemanticQueryInput, tried: Set<string>): MetricDefinition[] {
  const concepts = metricSelectionConcepts(input.questionPlan);
  const conceptTokens = new Set(concepts.flatMap((concept) => tokenize(concept)));
  if (conceptTokens.size === 0) return [];
  return input.semanticLayer.listMetrics()
    .filter((metric) => !tried.has(metric.name))
    .map((metric) => ({ metric, score: scoreMetric(metric, conceptTokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.metric.name.localeCompare(b.metric.name))
    .slice(0, 6)
    .map((candidate) => candidate.metric);
}

function bestMetricForConcept(
  metrics: MetricDefinition[],
  tokens: Set<string>,
  selected: MetricDefinition[],
): MetricDefinition | undefined {
  const selectedNames = new Set(selected.map((metric) => metric.name));
  return metrics
    .filter((metric) => !selectedNames.has(metric.name))
    .map((metric) => ({ metric, score: scoreMetric(metric, tokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.metric.name.localeCompare(b.metric.name))[0]?.metric;
}

function scoreMetric(metric: MetricDefinition, terms: Set<string>): number {
  return scoreSemanticText([
    metric.name,
    metric.label,
    metric.description,
    metric.domain,
    ...(metric.tags ?? []),
  ].join(' '), terms);
}

function metricSelectionConcepts(questionPlan: AnalysisQuestionPlan): string[] {
  const raw = uniqueStrings([
    ...questionPlan.requestedShape.measures,
    ...questionPlan.metricTerms,
  ].map((term) => normalizeSemanticText(term)).filter(Boolean));
  const meaningful = raw.filter((term) => !GENERIC_METRIC_CONCEPTS.has(term));
  return (meaningful.length > 0 ? meaningful : raw).slice(0, 4);
}

function sharedMetricDomain(metrics: MetricDefinition[]): string | undefined {
  const first = metrics[0]?.domain;
  if (!first) return undefined;
  return metrics.every((metric) => metric.domain === first) ? first : undefined;
}

function selectDimensions(
  dimensions: DimensionDefinition[],
  questionPlan: AnalysisQuestionPlan,
  timeDimensionName: string | undefined,
): { dimensions: string[]; unresolved: string[] } {
  const metricTerms = new Set([
    ...questionPlan.requestedShape.measures,
    ...questionPlan.metricTerms,
  ].map((term) => normalizeSemanticText(term)).filter(Boolean));
  const terms = uniqueStrings([
    ...questionPlan.requestedShape.dimensions,
    ...questionPlan.dimensionTerms,
  ])
    .filter((term) => !isTimeGrainTerm(term))
    .filter((term) => !metricTerms.has(normalizeSemanticText(term)));
  const selected: string[] = [];
  const unresolved: string[] = [];
  for (const term of terms) {
    // Expand the QUERY term with common analytics synonyms + singular/plural so a
    // question saying "product" can resolve a dimension named `sku`/`item`, or
    // "region" a dimension named `geo`/`market`. The dimension's own aliases
    // (name/label/leaf) are added to its searchable text on the other side.
    const tokens = expandDimensionQueryTokens(term);
    const hit = dimensions
      .filter((dimension) => dimension.name !== timeDimensionName)
      .map((dimension) => ({
        dimension,
        score: scoreSemanticText([
          ...semanticDimensionAliases(dimension),
          dimension.description,
          dimension.domain ?? '',
          ...(dimension.tags ?? []),
        ].join(' '), tokens),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.dimension.name.localeCompare(b.dimension.name))[0]?.dimension;
    if (hit && !selected.includes(hit.name)) selected.push(hit.name);
    if (!hit) unresolved.push(term);
  }
  return { dimensions: selected, unresolved };
}

/**
 * Generic analytics dimension-synonym seed. Each row is a synonym cluster: any
 * term in the cluster expands to all of them for dimension matching. Curated to
 * be domain-neutral (no project-specific values), so it's safe to apply broadly.
 */
const DIMENSION_SYNONYMS: string[][] = [
  ['product', 'item', 'sku', 'article', 'goods'],
  ['region', 'geo', 'geography', 'area', 'market', 'territory', 'zone', 'locale', 'location', 'site'],
  ['country', 'nation'],
  ['state', 'province'],
  ['city', 'metro', 'municipality'],
  ['customer', 'account', 'client', 'buyer', 'shopper', 'user', 'member'],
  ['channel', 'source', 'medium', 'origin'],
  ['category', 'segment', 'class', 'group', 'type', 'kind'],
  ['store', 'shop', 'outlet', 'location', 'branch'],
  ['supplier', 'vendor', 'merchant'],
  ['employee', 'staff', 'agent', 'rep', 'representative'],
  ['department', 'team', 'division', 'unit'],
  ['status', 'state', 'stage'],
];

const DIMENSION_SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>();
  for (const cluster of DIMENSION_SYNONYMS) {
    const set = new Set(cluster);
    for (const word of cluster) {
      const existing = index.get(word);
      if (existing) for (const w of set) existing.add(w);
      else index.set(word, new Set(set));
    }
  }
  return index;
})();

/** Query-side token expansion: the term's tokens + synonyms + singular/plural. */
function expandDimensionQueryTokens(term: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(term)) {
    out.add(token);
    const singular = token.replace(/ies$/, 'y').replace(/s$/, '');
    if (singular.length > 1) out.add(singular);
    out.add(`${token}s`);
    for (const synonym of DIMENSION_SYNONYM_INDEX.get(token) ?? []) out.add(synonym);
    for (const synonym of DIMENSION_SYNONYM_INDEX.get(singular) ?? []) out.add(synonym);
  }
  return out;
}

/** Tokens already consumed by selected filters or the chosen time dimension. */
function consumedTermTokens(
  filters: SemanticBridgeFilter[],
  timeDimension: { name: string; granularity: string } | undefined,
): Set<string> {
  const consumed = new Set<string>();
  for (const filter of filters) {
    for (const token of tokenize(filter.dimension)) consumed.add(token);
    for (const value of filter.values) for (const token of tokenize(value)) consumed.add(token);
  }
  if (timeDimension) {
    for (const token of tokenize(timeDimension.name)) consumed.add(token);
    for (const token of tokenize(timeDimension.granularity)) consumed.add(token);
    for (const grain of ['day', 'date', 'week', 'month', 'quarter', 'year', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'annual']) {
      consumed.add(grain);
    }
  }
  return consumed;
}

function selectFilters(
  dimensions: DimensionDefinition[],
  selectedDimensions: string[],
  question: string,
  questionPlan: AnalysisQuestionPlan,
  timeDimensionName: string | undefined,
  filterValueColumns: ((value: string) => string[]) | undefined,
): SemanticBridgeFilter[] {
  const available = dimensions.filter((dimension) => dimension.name !== timeDimensionName);
  const selected = new Map<string, SemanticBridgeFilter>();
  for (const candidate of extractInlineFilterCandidates(question, available)) {
    selected.set(candidate.dimension, {
      dimension: candidate.dimension,
      operator: 'equals',
      values: uniqueStrings([...(selected.get(candidate.dimension)?.values ?? []), candidate.value]),
    });
  }

  for (const raw of questionPlan.requestedShape.filters) {
    const value = cleanFilterValue(raw);
    if (!value || [...selected.values()].some((filter) => filter.values.some((existing) => sameFilterValue(existing, value)))) {
      continue;
    }
    const dimension = selectFilterDimension(value, available, selectedDimensions, filterValueColumns);
    if (!dimension) continue;
    selected.set(dimension.name, {
      dimension: dimension.name,
      operator: 'equals',
      values: uniqueStrings([...(selected.get(dimension.name)?.values ?? []), value]),
    });
  }

  return [...selected.values()]
    .filter((filter) => filter.values.length > 0)
    .sort((a, b) => a.dimension.localeCompare(b.dimension));
}

function extractInlineFilterCandidates(
  question: string,
  dimensions: DimensionDefinition[],
): Array<{ dimension: string; value: string }> {
  const candidates: Array<{ dimension: string; value: string }> = [];
  for (const dimension of dimensions) {
    for (const alias of semanticDimensionAliases(dimension)) {
      const aliasPattern = alias.split(/\s+/).map(escapeRegExp).join('\\s+');
      const valueBeforeDimension = new RegExp(
        `\\b(?:for|where|only|with|in)\\s+([A-Za-z0-9&.'_-]+(?:\\s+[A-Za-z0-9&.'_-]+){0,3})\\s+${aliasPattern}\\b`,
        'gi',
      );
      for (const match of question.matchAll(valueBeforeDimension)) {
        const value = cleanFilterValue(match[1]);
        if (value) candidates.push({ dimension: dimension.name, value });
      }

      const dimensionBeforeValue = new RegExp(
        `\\b${aliasPattern}\\s*(?:=|:|is|equals|of)\\s+["']?([A-Za-z0-9&.'_-]+(?:\\s+[A-Za-z0-9&.'_-]+){0,3})["']?`,
        'gi',
      );
      for (const match of question.matchAll(dimensionBeforeValue)) {
        const value = cleanFilterValue(match[1]);
        if (value) candidates.push({ dimension: dimension.name, value });
      }
    }
  }
  return candidates;
}

function selectFilterDimension(
  value: string,
  dimensions: DimensionDefinition[],
  selectedDimensions: string[],
  filterValueColumns: ((value: string) => string[]) | undefined,
): DimensionDefinition | undefined {
  const selectedSet = new Set(selectedDimensions);

  // Bind the literal to the dimension that actually carries it: ask the value
  // index which physical column(s) sampled this value, then match a dimension
  // whose expression/name references one of those columns. This is generic —
  // driven by real warehouse values, not a hard-coded value→dimension table.
  const valueColumns = filterValueColumns?.(value) ?? [];
  if (valueColumns.length > 0) {
    const normalizedColumns = new Set(valueColumns.map((column) => normalizeColumnToken(column)));
    const matched = dimensions.find((dimension) =>
      dimensionColumnTokens(dimension).some((token) => normalizedColumns.has(token)),
    );
    if (matched) return matched;
  }

  const selected = dimensions.filter((dimension) => selectedSet.has(dimension.name));
  if (selected.length === 1) return selected[0];
  return undefined;
}

/** Physical column tokens a dimension might reference (leaf of name/expr/sql). */
function dimensionColumnTokens(dimension: DimensionDefinition): string[] {
  return uniqueStrings([
    dimension.name,
    leafName(dimension.name),
    dimension.expr,
    dimension.sql,
  ].filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(/[^A-Za-z0-9_]+/))
    .map((token) => normalizeColumnToken(token))
    .filter((token) => token.length > 1 && !SEMANTIC_STOPWORDS.has(token)));
}

function normalizeColumnToken(value: string): string {
  return value.replace(/["'`]/g, '').trim().toLowerCase();
}

function semanticDimensionAliases(dimension: DimensionDefinition): string[] {
  return uniqueStrings([
    dimension.name,
    dimension.label,
    leafName(dimension.name),
    dimension.name.replace(/[_-]+/g, ' '),
    dimension.label?.replace(/[_-]+/g, ' '),
  ].filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeSemanticText(value))
    .filter((value) => value.length > 1 && !SEMANTIC_STOPWORDS.has(value)));
}

function selectTimeDimension(
  layer: SemanticLayer,
  question: string,
  questionPlan: AnalysisQuestionPlan,
): { name: string; granularity: string } | undefined {
  const granularity = inferTimeGranularity(question, questionPlan);
  if (!granularity) return undefined;
  const timeDimensions = layer.listTimeDimensions();
  if (timeDimensions.length === 0) return undefined;
  const timeTerms = new Set([...questionPlan.timeTerms, ...questionPlan.dimensionTerms].flatMap(tokenize));
  const hit = timeDimensions
    .map((dimension) => ({
      dimension,
      score: scoreSemanticText([
        dimension.name,
        dimension.label,
        dimension.description,
        dimension.domain ?? '',
        ...(dimension.tags ?? []),
      ].join(' '), timeTerms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.dimension.name.localeCompare(b.dimension.name))[0]?.dimension
    ?? (timeDimensions.length === 1 ? timeDimensions[0] : undefined);
  return hit ? { name: hit.name, granularity } : undefined;
}

function inferTimeGranularity(question: string, questionPlan: AnalysisQuestionPlan): string | undefined {
  const text = `${question} ${questionPlan.timeTerms.join(' ')} ${questionPlan.dimensionTerms.join(' ')}`.toLowerCase();
  if (/\b(daily|day|date)\b/.test(text)) return 'day';
  if (/\b(weekly|week)\b/.test(text)) return 'week';
  if (/\b(monthly|month)\b/.test(text)) return 'month';
  if (/\b(quarterly|quarter|q[1-4])\b/.test(text)) return 'quarter';
  if (/\b(yearly|annual|year)\b/.test(text)) return 'year';
  return undefined;
}

export function renderSemanticDqlArtifact(input: SemanticDqlArtifactInput): string {
  const lines = [
    `block "${escapeDqlString(input.name ?? titleFromQuestion(input.question, input.titleFallback ?? input.metrics[0] ?? 'semantic_query'))}" {`,
    '  status = "draft"',
    `  domain = "${escapeDqlString(input.domain || 'uncategorized')}"`,
    '  type = "semantic"',
    `  description = "${escapeDqlString(input.question)}"`,
    input.metrics.length === 1
      ? `  metric = "${escapeDqlString(input.metrics[0] ?? '')}"`
      : `  metrics = [${input.metrics.map((metric) => `"${escapeDqlString(metric)}"`).join(', ')}]`,
    `  dimensions = [${input.dimensions.map((dimension) => `"${escapeDqlString(dimension)}"`).join(', ')}]`,
  ];
  if (input.timeDimension) {
    lines.push(`  time_dimension = "${escapeDqlString(input.timeDimension.name)}"`);
    lines.push(`  granularity = "${escapeDqlString(input.timeDimension.granularity)}"`);
  }
  if (input.filters.length > 0) {
    lines.push(`  requested_filters = [${input.filters.flatMap(filterToRequestedFilterStrings).map((filter) => `"${escapeDqlString(filter)}"`).join(', ')}]`);
  }
  if (input.orderBy?.length) {
    lines.push(`  order_by = [${input.orderBy.map((order) => `"${escapeDqlString(`${order.name} ${order.direction}`)}"`).join(', ')}]`);
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0) {
    lines.push(`  limit = ${Math.floor(input.limit)}`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function semanticDqlArtifactName(input: SemanticDqlArtifactInput): string {
  const metricPart = input.metrics.length === 1
    ? leafName(input.metrics[0] ?? 'semantic_metric').replace(/^total[_-]+/i, '')
    : 'semantic_metrics';
  const grainPart = input.timeDimension ? grainName(input.timeDimension.granularity) : undefined;
  const dimensionPart = input.dimensions.length > 0
    ? ['by', ...input.dimensions.map((dimension) => leafName(dimension))]
    : [];
  const filterPart = input.filters.length > 0
    ? ['for', ...input.filters.flatMap((filter) => [leafName(filter.dimension), ...filter.values.slice(0, 2)])]
    : [];
  const raw = [
    grainPart,
    metricPart,
    ...dimensionPart,
    ...filterPart,
  ].filter((part): part is string => Boolean(part?.trim())).join(' ');
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 80)
    .replace(/_+$/g, '');
  return slug || 'semantic_query';
}

function grainName(granularity: string): string {
  switch (granularity.toLowerCase()) {
    case 'day':
      return 'daily';
    case 'week':
      return 'weekly';
    case 'month':
      return 'monthly';
    case 'quarter':
      return 'quarterly';
    case 'year':
      return 'yearly';
    default:
      return granularity;
  }
}

function filterToRequestedFilterStrings(filter: SemanticBridgeFilter): string[] {
  return filter.values.map((value) =>
    filter.operator === 'equals'
      ? `${filter.dimension}=${value}`
      : `${filter.dimension} ${filter.operator} ${value}`
  );
}

function semanticNameMatches(metric: MetricDefinition, raw: string): boolean {
  const target = normalizeSemanticName(raw);
  return normalizeSemanticName(metric.name) === target
    || normalizeSemanticName(`${metric.cube ?? ''}.${metric.name}`) === target
    || normalizeSemanticName(metric.label) === target;
}

function scoreSemanticText(text: string, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  const haystack = new Set(tokenize(text));
  let score = 0;
  for (const term of terms) {
    if (haystack.has(term)) score += 3;
    else if ([...haystack].some((token) => token.includes(term) || term.includes(token))) score += 1;
  }
  return score;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !SEMANTIC_STOPWORDS.has(token));
}

function normalizeSemanticName(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

function normalizeSemanticText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function leafName(value: string): string {
  return value.split('.').pop() ?? value;
}

function isTimeGrainTerm(term: string): boolean {
  return /\b(day|date|week|month|quarter|year|daily|weekly|monthly|quarterly|yearly|annual)\b/i.test(term);
}

function titleFromQuestion(question: string, fallback: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length <= 80 ? clean : `${clean.slice(0, 77)}...`;
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cleanFilterValue(value: string | undefined): string {
  return (value ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/\b(?:channel|category|segment|region|market|product|customer|account|user|team|type)\b$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameFilterValue(left: string, right: string): boolean {
  return normalizeSemanticText(left) === normalizeSemanticText(right);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

const SEMANTIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'by', 'for', 'from', 'with', 'show', 'give',
  'me', 'what', 'is', 'are', 'our', 'total', 'all', 'per', 'each',
]);

const GENERIC_METRIC_CONCEPTS = new Set([
  'amount',
  'average',
  'avg',
  'count',
  'kpi',
  'metric',
  'number',
  'sum',
  'total',
  'value',
]);
