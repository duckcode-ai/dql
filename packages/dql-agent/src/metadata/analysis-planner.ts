import type {
  MetadataAgentIntent,
  MetadataAllowedSqlContext,
  MetadataObject,
} from './catalog.js';
import { buildAnalyticalRequirementSet, normalizeAnalyticalMeasureTerms, type AnalyticalRequirementSetV1 } from '../analytical-orchestration.js';

export type AnalysisQuestionMode =
  | 'exact_lookup'
  | 'definition'
  | 'list_by_dimension'
  | 'ranking'
  | 'entity_profile'
  | 'entity_drilldown'
  | 'trend'
  | 'comparison'
  | 'driver_breakdown'
  | 'diagnose_change'
  | 'anomaly'
  | 'trust_review'
  | 'general_analysis'
  | 'clarify';

export interface AnalysisEntityMention {
  text: string;
  source: 'quoted' | 'named_entity' | 'explicit_filter' | 'email' | 'id';
  typeHint?: string;
}

/**
 * A phrase that may be a stored member value rather than a metadata object.
 * Keep the original phrase intact so later, field-scoped value resolution can
 * distinguish `Melissa Lopez` (a customer_name value) from `customer` (an
 * entity) and `revenue` (a metric). AGT-005/AGT-009.
 */
export interface AnalysisValueMention {
  text: string;
  normalizedText: string;
  source: AnalysisEntityMention['source'];
  syntacticRole: 'filter_value' | 'entity_identifier' | 'unknown';
  typeHint?: string;
}

export interface AnalysisQuestionPlan {
  question: string;
  normalizedQuestion: string;
  mode: AnalysisQuestionMode;
  routeIntent: MetadataAgentIntent;
  entities: AnalysisEntityMention[];
  valueMentions: AnalysisValueMention[];
  metricTerms: string[];
  /**
   * The execution-facing reading of the same question — measures, groupings,
   * entity display terms, members, ranking, time — computed ONCE from this
   * plan's own terms so no consumer reads the question a second time with
   * different inputs. Host-first execution, the floor and retrieval share it.
   */
  requirements: AnalyticalRequirementSetV1;
  /**
   * Words the question put directly before a measure or a grouping noun that
   * no kept term covers — "beverage" in "beverage revenue", "BCM" in "BCM
   * customers". A non-empty list means the plan's terms do NOT fully describe
   * what was asked, and every consumer that would bind plain `revenue` or
   * plain `customers` (retrieval, the certified proof, host-first execution,
   * the floor) must treat the question as unresolved rather than answer the
   * wider one.
   */
  unboundQualifiers: string[];
  dimensionTerms: string[];
  filterTerms: string[];
  timeTerms: string[];
  outputShape: 'value' | 'table' | 'chart' | 'profile' | 'narrative';
  needsGeneratedSql: boolean;
  shouldConsiderCertifiedExact: boolean;
  needsResearchWorkspace: boolean;
  searchQueries: string[];
  searchTerms: string[];
  requestedShape: RequestedAnswerShape;
  confidence: number;
  reasons: string[];
}

export interface RequestedAnswerShape {
  grain?: string;
  dimensions: string[];
  measures: string[];
  requiredOutputs: string[];
  filters: string[];
  /** Typed warehouse members that every terminal route must honor. AGT-012. */
  memberBindings?: Array<{
    dimension: string;
    values: string[];
    source: 'prior_result' | 'question' | 'clarification';
    confidence: 'exact' | 'unique_partial' | 'deictic';
    sourceTurnId?: string;
  }>;
  topN?: {
    n: number;
    scope: 'overall' | 'per_group';
  };
  rankingDirection?: 'top' | 'bottom';
  followUpReferences: Array<{
    phrase: string;
    kind: 'prior_dimension_values' | 'prior_entities' | 'prior_timeframe' | 'ambiguous';
    resolvedValues?: string[];
  }>;
  ambiguities: Array<{
    term: string;
    defaultInterpretation?: string;
    requiresClarification: boolean;
  }>;
}

export type CertifiedApplicabilityKind =
  | 'exact_answer'
  | 'safe_parameterized'
  | 'context_only'
  | 'not_applicable';

export interface CertifiedBlockApplicability {
  objectKey: string;
  name: string;
  kind: CertifiedApplicabilityKind;
  score: number;
  reasons: string[];
}

export interface AllowedSqlRelationScore {
  relation: string;
  name: string;
  source: string;
  score: number;
  reasons: string[];
}

interface ScoredTextMatch {
  score: number;
  matched: string[];
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'all', 'also', 'and', 'answer', 'any', 'are', 'around',
  'based', 'before', 'between', 'build', 'can', 'complete', 'could', 'data', 'dataset', 'datasets',
  'deep', 'detail', 'detailed', 'does', 'for', 'from', 'give', 'have', 'help', 'into', 'latest',
  'in', 'is', 'more', 'need', 'needs', 'of', 'our', 'over', 'please', 'provide', 'question', 'research', 'reserach', 'show',
  'that', 'the', 'their', 'them', 'this', 'through', 'use', 'using', 'what', 'when', 'where',
  'which', 'was', 'were', 'with', 'would', 'you',
]);

const METRIC_WORDS = [
  'amount', 'arr', 'average', 'avg', 'balance', 'bookings', 'churn', 'consumption', 'conversion', 'cost',
  'count', 'duration', 'expense', 'growth', 'kpi', 'margin', 'metric', 'mrr', 'orders',
  'percent', 'percentage', 'pct', 'points', 'profit', 'quantity', 'rate', 'ratio', 'revenue', 'sales',
  'score', 'scorer', 'scoring', 'share', 'spend', 'stats',
  'statistics', 'tax', 'total', 'usage', 'value', 'volume',
];

// These words describe an aggregation operation, not a business measure.  They
// remain useful to the result-shape/compiler stages, but must not compete with
// an authored metric identity during retrieval (for example, `total supply
// cost` is the `supply_cost` measure, not a `total` measure plus a `supply`
// dimension).
const AGGREGATION_OPERATOR_WORDS = new Set([
  'total', 'sum', 'average', 'avg', 'minimum', 'min', 'maximum', 'max',
]);

const DIMENSION_WORDS = [
  'account', 'category', 'channel', 'cohort', 'customer', 'department', 'entity', 'geo',
  'location', 'market', 'merchant', 'month', 'person', 'player', 'product', 'profile',
  'region', 'segment', 'sku', 'supply', 'team', 'type', 'user', 'vendor', 'week', 'year',
];

/**
 * Small, domain-neutral vocabulary clusters used only to broaden metadata
 * retrieval. These are ordinary-language equivalents, not project-specific
 * value-to-column mappings; physical filter binding still comes from sampled
 * warehouse values or semantic definitions.
 */
const SEARCH_TERM_SYNONYMS: string[][] = [
  ['beverage', 'drink'],
  ['customer', 'client', 'buyer', 'shopper'],
  ['product', 'item', 'sku'],
  ['spend', 'spent', 'spending', 'revenue', 'sales'],
];

const SEARCH_TERM_SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>();
  for (const cluster of SEARCH_TERM_SYNONYMS) {
    for (const word of cluster) index.set(word, new Set(cluster));
  }
  return index;
})();

const PROFILE_WORDS = [
  'bio', 'biography', 'career', 'complete stats', 'details', 'entity 360', 'overview',
  'profile', 'record', 'snapshot', 'stats', 'statistics', 'summary',
];

/**
 * Words the reader placed immediately before a measure that no requirement
 * kept.
 *
 * "beverage revenue" normalizes to the measure `revenue`, and the qualifier
 * vanishes at parse time — so the deterministic path bound plain revenue, ran
 * it, and presented total revenue as beverage revenue. The reader had no way
 * to tell. This finds that word again by looking at the question itself.
 *
 * Deliberately narrow. Aggregation words ("total revenue"), comparators
 * ("highest revenue"), time words ("monthly revenue") and determiners do not
 * change WHICH measure is meant, so they are not qualifiers. What remains is a
 * business noun that does: beverage, food, net, gross, recurring.
 */
const MEASURE_QUALIFIER_STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'their', 'his', 'her', 'its',
  'total', 'sum', 'average', 'avg', 'mean', 'median', 'count', 'number', 'amount', 'overall',
  'highest', 'lowest', 'top', 'bottom', 'most', 'least', 'best', 'worst', 'largest', 'smallest',
  'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'annual', 'cumulative',
  'and', 'or', 'with', 'by', 'per', 'for', 'of', 'in', 'on', 'at', 'to', 'from', 'is', 'was', 'are',
  'each', 'every', 'all', 'any', 'which', 'across', 'among', 'between',
  'more', 'less', 'much', 'many', 'what', 'which', 'who', 'whose', 'give', 'show', 'me', 'us',
  'customer', 'customers', 'account', 'accounts', 'client', 'clients', 'product', 'products',
]);

export function unboundMeasureQualifierTerms(question: string, measures: readonly string[]): string[] {
  if (measures.length === 0) return [];
  const words = question.toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? [];
  // Every token any retained measure already accounts for.
  const covered = new Set(measures.flatMap((measure) => measure.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
  const qualifiers: string[] = [];
  // "customers" in the question is the term "customer" in the plan.
  const singular = (word: string) => word.replace(/(ies)$/, 'y').replace(/(ses|xes|shes|ches)$/, (match) => match.slice(0, -2)).replace(/s$/, '');
  for (const measure of measures) {
    const head = measure.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).at(0);
    if (!head) continue;
    for (let index = 1; index < words.length; index += 1) {
      if (words[index] !== head && singular(words[index]!) !== singular(head)) continue;
      const previous = words[index - 1]!;
      if (covered.has(previous) || covered.has(singular(previous)) || MEASURE_QUALIFIER_STOPWORDS.has(previous) || previous.length < 3) continue;
      qualifiers.push(previous);
    }
  }
  return [...new Set(qualifiers)].slice(0, 4);
}

export function buildAnalysisQuestionPlan(
  question: string,
  followUp?: unknown,
): AnalysisQuestionPlan {
  const cleanQuestion = question.replace(/\s+/g, ' ').trim();
  const normalizedQuestion = normalizeSearchText(cleanQuestion);
  // Stakeholders occasionally paste semantic/dbt identifiers directly. Treat
  // underscores as word boundaries for intent extraction while retaining the
  // original question for exact output identifiers and auditability.
  const languageQuestion = cleanQuestion
    .replace(/@(?:metric|dimension|measure|entity|model|block|term)\(([^)]+)\)/gi, (_match, identity: string) =>
      identity.split(/[.:]/).at(-1) ?? identity)
    .replace(/_/g, ' ');
  const lower = languageQuestion.toLowerCase();
  const definitionArtifactReference = namedArtifactDefinitionReference(cleanQuestion);
  const entities = extractEntities(cleanQuestion);
  const valueMentions = extractValueMentions(entities);
  const extractedMetricTerms = normalizeAnalyticalMeasureTerms(
    cleanQuestion,
    resolveQuestionMetricTerms(
      lower,
      uniqueStrings([
        ...extractQuotedAnalyticalIdentifiers(cleanQuestion),
        ...extractMetricTerms(languageQuestion),
      ]),
      extractFollowUpMetricTerms(followUp, lower),
    ),
    // The planner owns retrieval identity, not display formatting. A sticky
    // prior measure can be a qualified metric identifier and must survive a
    // measure-less refinement byte-for-byte; downstream scoring normalizes
    // independently for lexical matching.
    { preserveIdentity: true },
  );
  const extractedDimensionTerms = normalizeExplicitGroupingGrammar(
    languageQuestion,
    reconcileRankingRoles(
      languageQuestion,
      extractDimensionTerms(languageQuestion),
      extractedMetricTerms,
    ),
  );
  const typedAggregationRoles = normalizeTypedAggregationRoles(
    languageQuestion,
    extractedMetricTerms,
    extractedDimensionTerms,
  );
  // A named artifact-definition request explains the artifact; its own ID is
  // not a requested query output.  Keep the original words as retrieval terms
  // below, but do not let an identifier such as `top_customers` manufacture a
  // measure/dimension contract or trigger SQL execution.
  const metricTerms = definitionArtifactReference ? [] : typedAggregationRoles.metricTerms;
  const normalizedDimensionTerms = definitionArtifactReference ? [] : typedAggregationRoles.dimensionTerms;
  const filterTerms = extractFilterTerms(languageQuestion, entities);
  const timeTerms = extractTimeTerms(languageQuestion);
  const dimensionTerms = removeTemporalFilterDimensionTerms(
    languageQuestion,
    removeFilterOnlyDimensionTerms(languageQuestion, normalizedDimensionTerms),
    timeTerms,
  );
  const mode = definitionArtifactReference
    ? 'definition'
    : inferQuestionMode({ question: cleanQuestion, lower, entities, metricTerms, dimensionTerms, followUp });
  const routeIntent = routeIntentForMode(mode);
  const outputShape = outputShapeForMode(mode, lower, dimensionTerms);
  // Certified capability matching is contract-first. An explicit analytical
  // shape ("lifetime spend by customer") is a reason to reject a definition
  // term, not a reason to skip a fully compatible certified block.
  const shouldConsiderCertifiedExact = certifiedExactIsPlausible(mode, entities);
  const needsGeneratedSql = generatedSqlIsLikely(mode, shouldConsiderCertifiedExact);
  const needsResearchWorkspace = researchWorkspaceIsLikely(mode, lower);
  const requestedShapeBase = buildRequestedAnswerShape(cleanQuestion, {
    lower,
    mode,
    metricTerms,
    dimensionTerms,
    filterTerms,
    timeTerms,
    followUp,
  });
  const requestedShape = definitionArtifactReference
    ? {
        ...requestedShapeBase,
        requiredOutputs: requestedShapeBase.requiredOutputs.filter((output) =>
          canonicalShapeTerm(output) !== definitionArtifactReference),
      }
    : requestedShapeBase;
  const searchTerms = uniqueStrings(uniqueStrings([
    ...tokenize(cleanQuestion),
    ...entities.flatMap((entity) => tokenize(entity.text)),
    ...metricTerms,
    ...dimensionTerms,
    ...filterTerms,
    ...timeTerms,
    ...modeSearchTerms(mode),
  ]).flatMap(expandSearchTerm)).filter((term) => !STOP_WORDS.has(term)).slice(0, 36);
  const searchQueries = buildSearchQueries({
    question: cleanQuestion,
    mode,
    entities,
    metricTerms,
    dimensionTerms,
    filterTerms,
    timeTerms,
    searchTerms,
  });
  const reasons = buildPlanReasons(mode, entities, metricTerms, dimensionTerms, timeTerms, shouldConsiderCertifiedExact);

  return {
    question: cleanQuestion,
    normalizedQuestion,
    mode,
    routeIntent,
    entities,
    valueMentions,
    metricTerms,
    // "BCM customers" and "beverage revenue" drop a word the same way; a
    // qualifier before the grouping noun is as much a filter as one before
    // the measure. Every term the plan kept covers its own words.
    unboundQualifiers: unboundMeasureQualifierTerms(cleanQuestion, [...metricTerms, ...dimensionTerms]),
    // The question alone: retrieval-side parser hints are broader and staler
    // than the question, and the requirement set is host authority.
    requirements: buildAnalyticalRequirementSet({ question: cleanQuestion }),
    dimensionTerms,
    filterTerms,
    timeTerms,
    outputShape,
    needsGeneratedSql,
    shouldConsiderCertifiedExact,
    needsResearchWorkspace,
    searchQueries,
    searchTerms,
    requestedShape,
    confidence: planConfidence(mode, entities, metricTerms, dimensionTerms),
    reasons,
  };
}

export function certifiedApplicabilityForObject(
  object: MetadataObject,
  plan: AnalysisQuestionPlan,
): CertifiedBlockApplicability {
  const reasons: string[] = [];
  if (object.objectType !== 'dql_block' || !isCertifiedObject(object)) {
    return { objectKey: object.objectKey, name: object.name, kind: 'not_applicable', score: 0, reasons: ['not a certified DQL block'] };
  }

  const text = objectSearchText(object);
  const questionText = plan.normalizedQuestion;
  const name = normalizeSearchText(object.name);
  const explicitName = Boolean(name && questionText.includes(name));
  const exactExample = hasExactExampleQuestion(object, plan.normalizedQuestion);
  const metricMatch = scoreTerms(text, plan.metricTerms);
  const dimensionMatch = scoreTerms(text, plan.dimensionTerms);
  const searchMatch = scoreTerms(text, plan.searchTerms);
  const directionCompatible = rankingDirectionCompatible(plan.question, directionalTextForObject(object));
  const asksDifferentGrain = plan.entities.length > 0 || plan.mode === 'entity_profile';
  const score = Number((
    (explicitName ? 45 : 0) +
    (exactExample ? 55 : 0) +
    metricMatch.score * 12 +
    dimensionMatch.score * 8 +
    searchMatch.score * 3 +
    (directionCompatible ? 10 : -25) +
    (isDirectCertifiedQuestion(plan) ? 15 : 0) -
    (asksDifferentGrain ? 24 : 0)
  ).toFixed(3));

  if (explicitName) reasons.push('question names this certified block');
  if (exactExample) reasons.push('question matches a certified example');
  if (metricMatch.matched.length) reasons.push(`metric terms matched: ${metricMatch.matched.join(', ')}`);
  if (dimensionMatch.matched.length) reasons.push(`dimension terms matched: ${dimensionMatch.matched.join(', ')}`);
  if (!directionCompatible) reasons.push('ranking direction conflicts with certified block wording');

  const hasRankingEvidence = plan.mode !== 'ranking' || Boolean(rankingDirection(text)) || /\b(order\s+by|rank|ranking|limit|top|bottom|leader|leading)\b/i.test(text);
  const hasMetricEvidence = metricMatch.score > 0 || exactExample || explicitName || plan.metricTerms.length === 0;
  if ((explicitName || exactExample || score >= 70 || (
    plan.shouldConsiderCertifiedExact &&
    score >= 40 &&
    hasMetricEvidence &&
    (metricMatch.score > 0 || dimensionMatch.score > 0 || searchMatch.score >= 2)
  )) && directionCompatible && hasRankingEvidence && !asksDifferentGrain) {
    return {
      objectKey: object.objectKey,
      name: object.name,
      kind: 'exact_answer',
      score,
      reasons: reasons.length ? reasons : ['certified block contract matches the requested answer shape'],
    };
  }

  const parameters = Array.isArray(object.payload?.parameters) ? object.payload.parameters : [];
  const dynamicParameters = parameters.filter((entry) => entry && typeof entry === 'object' && (entry as { policy?: unknown }).policy === 'dynamic');
  const parameterPolicy = metadataString(object.payload?.parameterPolicy ?? object.payload?.parameter_policy);
  if ((dynamicParameters.length > 0 || (parameterPolicy && /safe_filter|safe_group_by|template/i.test(parameterPolicy))) && score >= 58 && directionCompatible) {
    return {
      objectKey: object.objectKey,
      name: object.name,
      kind: 'safe_parameterized',
      score,
      reasons: [...reasons, dynamicParameters.length > 0
        ? `certified block declares ${dynamicParameters.length} typed dynamic parameter${dynamicParameters.length === 1 ? '' : 's'}`
        : `certified block declares parameter policy ${parameterPolicy}`],
    };
  }

  if (score >= 28 || metricMatch.score > 0 || dimensionMatch.score > 0) {
    return {
      objectKey: object.objectKey,
      name: object.name,
      kind: 'context_only',
      score,
      reasons: [
        ...reasons,
        asksDifferentGrain
          ? 'question asks for a different entity, filter, or grain; use certified block as context only'
          : 'certified block is relevant but not exact enough for direct execution',
      ],
    };
  }

  return {
    objectKey: object.objectKey,
    name: object.name,
    kind: 'not_applicable',
    score,
    reasons: reasons.length ? reasons : ['low semantic overlap with the requested analysis'],
  };
}

export function scoreMetadataObjectWithAnalysisPlan(
  object: MetadataObject,
  plan: AnalysisQuestionPlan,
): { score: number; reasons: string[] } {
  const text = objectSearchText(object);
  const search = scoreTerms(text, plan.searchTerms);
  const metrics = scoreTerms(text, plan.metricTerms);
  const dimensions = scoreTerms(text, plan.dimensionTerms);
  const entity = scoreTerms(text, plan.entities.flatMap((item) => tokenize(item.text)));
  const sourceShape = scoreSourceShape(object, plan);
  const certified = certifiedApplicabilityForObject(object, plan);
  const score = Number((
    search.score * 2.6 +
    metrics.score * 7 +
    dimensions.score * 5 +
    entity.score * 4 +
    sourceShape +
    (certified.kind === 'exact_answer' ? 36 : certified.kind === 'safe_parameterized' ? 28 : certified.kind === 'context_only' ? 14 : 0)
  ).toFixed(3));
  const reasons = [
    search.matched.length ? `analysis terms matched: ${search.matched.slice(0, 5).join(', ')}` : '',
    metrics.matched.length ? `metric terms matched: ${metrics.matched.slice(0, 4).join(', ')}` : '',
    dimensions.matched.length ? `dimension terms matched: ${dimensions.matched.slice(0, 4).join(', ')}` : '',
    entity.matched.length ? `entity terms matched: ${entity.matched.slice(0, 4).join(', ')}` : '',
    sourceShape > 0 ? 'source shape matches requested analytical task' : '',
    certified.kind !== 'not_applicable' ? `certified applicability: ${certified.kind}` : '',
  ].filter(Boolean);
  return { score, reasons };
}

export function sortAllowedSqlContextForAnalysisPlan(
  context: MetadataAllowedSqlContext,
  plan: AnalysisQuestionPlan,
  options: { maxRelations?: number } = {},
): MetadataAllowedSqlContext {
  const relations = [...context.relations]
    .sort((a, b) =>
      scoreAllowedSqlRelationWithAnalysisPlan(b, plan).score - scoreAllowedSqlRelationWithAnalysisPlan(a, plan).score
      || a.relation.localeCompare(b.relation)
    )
    .slice(0, options.maxRelations ?? 40);
  return {
    relations,
    sourceBlockSql: context.sourceBlockSql,
  };
}

export function scoreAllowedSqlRelationWithAnalysisPlan(
  relation: MetadataAllowedSqlContext['relations'][number],
  plan: AnalysisQuestionPlan,
): AllowedSqlRelationScore {
  const text = normalizeSearchText(relationSearchText(relation));
  const search = scoreTerms(text, plan.searchTerms);
  const metrics = scoreTerms(text, plan.metricTerms);
  const dimensions = scoreTerms(text, plan.dimensionTerms);
  const entities = scoreTerms(text, plan.entities.flatMap((entity) => tokenize(entity.text)));
  const shape = scoreSourceShape({
    objectKey: relation.objectKey ?? relation.relation,
    objectType: 'runtime_table',
    name: relation.name,
    fullName: relation.relation,
    sourceSystem: relation.source,
    payload: { columns: relation.columns },
  }, plan);
  const sourceBonus = relation.source.includes('certified source SQL') ? 14
    : relation.source.includes('certified block') ? 8
      : relation.source.includes('runtime') ? 6
        : 0;
  const usabilityBonus = generatedSqlUsabilityScore(relation, plan);
  const columnShapeBonus = relationColumnShapeScore(relation, plan);
  const semanticColumnBonus = semanticColumnMapScore(relation, plan);
  const incompleteSourceShapePenalty = relation.source.includes('certified source SQL') &&
    sourceShapeMustCoverRequestedOutputs(plan) &&
    semanticColumnBonus.missingRequired.length > 0
    ? Math.min(42, semanticColumnBonus.missingRequired.length * 34)
    : 0;
  const score = Number((
    search.score * 3 +
    metrics.score * 8 +
    dimensions.score * 6 +
    entities.score * 3 +
    shape +
    sourceBonus +
    usabilityBonus +
    columnShapeBonus +
    semanticColumnBonus.score +
    -incompleteSourceShapePenalty +
    Math.min(relation.columns.length, 24) * 0.2
  ).toFixed(3));
  const reasons = [
    search.matched.length ? `analysis terms matched: ${search.matched.slice(0, 5).join(', ')}` : '',
    metrics.matched.length ? `metric terms matched: ${metrics.matched.slice(0, 4).join(', ')}` : '',
    dimensions.matched.length ? `dimension terms matched: ${dimensions.matched.slice(0, 4).join(', ')}` : '',
    entities.matched.length ? `entity terms matched: ${entities.matched.slice(0, 4).join(', ')}` : '',
    shape > 0 ? 'relation shape matches requested analysis mode' : '',
    sourceBonus > 0 ? `trusted source context: ${relation.source}` : '',
    usabilityBonus > 0 ? 'relation has usable columns for generated SQL' : '',
    usabilityBonus < 0 ? 'relation has no inspected/projected columns for generated SQL' : '',
    columnShapeBonus > 0 ? 'columns match requested analytical shape' : '',
    semanticColumnBonus.matched.length ? `semantic column map matched: ${semanticColumnBonus.matched.slice(0, 6).join(', ')}` : '',
    incompleteSourceShapePenalty > 0 ? `certified source SQL shape is missing requested output(s): ${semanticColumnBonus.missingRequired.join(', ')}` : '',
    relation.columns.length > 0 ? `${relation.columns.length} inspected/projected columns` : '',
  ].filter(Boolean);
  return {
    relation: relation.relation,
    name: relation.name,
    source: relation.source,
    score,
    reasons,
  };
}

function generatedSqlUsabilityScore(
  relation: MetadataAllowedSqlContext['relations'][number],
  plan: AnalysisQuestionPlan,
): number {
  if (!plan.needsGeneratedSql) return 0;
  if (relation.columns.length === 0) return -14;
  return Math.min(18, 8 + relation.columns.length * 0.8);
}

function relationColumnShapeScore(
  relation: MetadataAllowedSqlContext['relations'][number],
  plan: AnalysisQuestionPlan,
): number {
  const columns = relation.columns.map((column) => normalizeSearchText(column.name));
  if (columns.length === 0) return 0;
  let score = 0;
  if (plan.mode === 'entity_profile') {
    if (columns.some((column) => /\b(player|customer|account|user|member|person|product|vendor|name|title)\b/.test(column))) {
      score += 7;
    }
    if (columns.some((column) => /\b(total|count|score|point|assist|rebound|game|minute|revenue|amount|spend|order|stat|rate|value)\b/.test(column))) {
      score += 9;
    }
  }
  if (plan.mode === 'ranking' && columns.some((column) => /\b(total|count|score|point|amount|revenue|sales|order|rank|value)\b/.test(column))) {
    score += 8;
  }
  if ((plan.mode === 'trend' || plan.mode === 'diagnose_change') && columns.some((column) => /\b(date|time|day|week|month|quarter|year|season|period)\b/.test(column))) {
    score += 8;
  }
  return score;
}

function semanticColumnMapScore(
  relation: MetadataAllowedSqlContext['relations'][number],
  plan: AnalysisQuestionPlan,
): { score: number; matched: string[]; missingRequired: string[] } {
  if (relation.columns.length === 0) return { score: 0, matched: [], missingRequired: [] };
  const requiredConcepts = uniqueStrings(plan.requestedShape.requiredOutputs.map(canonicalColumnConcept).filter(Boolean));
  const requestedOutputs = uniqueStrings([
    ...requiredConcepts,
    ...plan.requestedShape.dimensions,
    ...plan.requestedShape.measures,
    ...plan.dimensionTerms,
    ...plan.metricTerms,
  ].map(canonicalColumnConcept).filter(Boolean));
  const matched: string[] = [];
  const missingRequired: string[] = [];
  let score = 0;
  for (const concept of requestedOutputs) {
    const best = bestColumnConceptScore(concept, relation.columns);
    if (best.score <= 0) {
      if (requiredConcepts.includes(concept)) {
        missingRequired.push(concept);
        score -= 12;
      }
      continue;
    }
    matched.push(`${concept}->${best.column}`);
    score += best.score * (requiredConcepts.includes(concept) ? 1.35 : 1);
  }
  const capped = Math.max(-36, Math.min(score, plan.needsGeneratedSql ? 44 : 28));
  return { score: capped, matched: uniqueStrings(matched), missingRequired: uniqueStrings(missingRequired) };
}

function sourceShapeMustCoverRequestedOutputs(plan: AnalysisQuestionPlan): boolean {
  return plan.mode === 'ranking' ||
    plan.mode === 'driver_breakdown' ||
    plan.mode === 'comparison' ||
    plan.mode === 'trend' ||
    plan.mode === 'general_analysis';
}

function canonicalColumnConcept(value: string): string {
  return normalizeTerm(value)
    .replace(/\bname\b$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bestColumnConceptScore(
  concept: string,
  columns: MetadataAllowedSqlContext['relations'][number]['columns'],
): { score: number; column: string } {
  let best = { score: 0, column: '' };
  for (const column of columns) {
    const score = columnConceptScore(concept, column);
    if (score > best.score) best = { score, column: column.name };
  }
  return best;
}

function columnConceptScore(
  concept: string,
  column: MetadataAllowedSqlContext['relations'][number]['columns'][number],
): number {
  const normalizedConcept = normalizeTerm(concept.replace(/_name$/, ''));
  if (!normalizedConcept) return 0;
  const columnName = normalizeSearchText(column.name);
  const columnTokens = tokenize(column.name);
  const columnText = normalizeSearchText([
    column.name,
    column.description ?? '',
  ].join(' '));
  const aliases = semanticColumnAliases(normalizedConcept);
  let score = 0;
  if (columnName === normalizedConcept || columnName === `${normalizedConcept} name`) score += 12;
  if (columnTokens.includes(normalizedConcept)) score += 9;
  for (const alias of aliases) {
    const aliasText = normalizeSearchText(alias);
    const aliasTokens = tokenize(alias).filter((token) => !GENERIC_COLUMN_ALIAS_TOKENS.has(token));
    if (!aliasText) continue;
    if (columnName === aliasText) score += 11;
    else if (columnText.includes(aliasText)) score += 7;
    else if (aliasTokens.some((token) => columnTokens.includes(token))) score += 5;
  }
  if (lineageAliasesIncludeConcept(column.description, normalizedConcept, aliases)) score += 12;
  if (isCertifiedSourceShapeDescription(column.description)) score -= 16;
  if (isMetricConcept(normalizedConcept) && isIdentifierLikeColumn(column.name)) score -= 8;
  if (isDimensionConcept(normalizedConcept) && isMetricLikeColumn(column.name)) score -= 6;
  return Math.max(0, score);
}

const GENERIC_COLUMN_ALIAS_TOKENS = new Set(['name', 'title', 'type', 'value', 'total']);

function lineageAliasesIncludeConcept(
  description: string | undefined,
  concept: string,
  aliases: string[],
): boolean {
  const match = /governed aliases from lineage:\s*([^.]*)/i.exec(description ?? '');
  if (!match?.[1]) return false;
  const aliasText = normalizeSearchText(match[1]);
  const candidates = [concept, ...aliases].map(normalizeSearchText).filter(Boolean);
  return candidates.some((candidate) =>
    aliasText === candidate ||
    aliasText.split(/\s*,\s*/).some((alias) => normalizeSearchText(alias) === candidate)
  );
}

function isCertifiedSourceShapeDescription(description: string | undefined): boolean {
  return /projected by certified source sql shape/i.test(description ?? '');
}

function semanticColumnAliases(concept: string): string[] {
  switch (concept) {
    case 'revenue':
    case 'sale':
    case 'sales':
      return ['revenue', 'sales', 'amount', 'gross amount', 'net amount', 'price', 'product price', 'order amount', 'total'];
    case 'usage':
      return ['usage', 'use', 'consumption', 'activity', 'events', 'sessions', 'volume'];
    case 'order':
    case 'orders':
      return ['order count', 'orders', 'order total', 'count lifetime orders'];
    case 'product':
      return ['product', 'product name', 'product title', 'sku', 'item', 'item name'];
    case 'category':
      return ['category', 'category name', 'product category', 'product type', 'type', 'class'];
    case 'customer':
      return ['customer', 'customer name', 'buyer', 'client', 'account name', 'full name'];
    case 'segment':
      return ['segment', 'customer segment', 'market segment'];
    case 'region':
    case 'market':
      return ['region', 'market', 'geo', 'location', 'country', 'state'];
    case 'player':
      return ['player', 'player name', 'athlete', 'athlete name'];
    case 'month':
    case 'week':
    case 'year':
      return [concept, `${concept} date`, `${concept} start`, 'date', 'period'];
    default:
      return [concept.replace(/_/g, ' ')];
  }
}

function isMetricConcept(concept: string): boolean {
  return METRIC_WORDS.includes(concept) || ['sale', 'sales', 'order', 'orders'].includes(concept);
}

function isDimensionConcept(concept: string): boolean {
  return DIMENSION_WORDS.includes(concept);
}

function isIdentifierLikeColumn(column: string): boolean {
  return /\b(id|key|uuid|code|hash)\b/i.test(column.replace(/_/g, ' '));
}

function isMetricLikeColumn(column: string): boolean {
  return /\b(revenue|sales|amount|price|spend|cost|total|count|score|points?|quantity|value|rate|volume)\b/i.test(column.replace(/_/g, ' '));
}

/**
 * Recognize only the explicit artifact-definition grammar.  A bare analytical
 * phrase such as "what does revenue mean" stays available to the ordinary
 * definition/semantic path; this helper is for an authored artifact name and
 * deliberately refuses query-shaped suffixes.
 */
function namedArtifactDefinitionReference(question: string): string | undefined {
  const match = /^\s*what\s+does\s+(?:the\s+)?(.+?)\s+(?:measure|mean|define|represent)\s*[?.!]*\s*$/i.exec(question);
  if (!match?.[1]) return undefined;
  const originalSubject = match[1].trim();
  if (/\b(?:by|per|for each|group(?:ed)? by|filter(?:ed)? by|top\s+\d+|show|list|compare)\b/i.test(originalSubject)) {
    return undefined;
  }
  const subject = originalSubject
    .replace(/\s+(?:certified\s+)?(?:block|metric|model|artifact|semantic\s+model)\s*$/i, '')
    .trim();
  if (!subject) return undefined;
  // Natural language can name an artifact with "block"/"metric", while an
  // identifier is unambiguous on its own.  Do not turn arbitrary prose into a
  // no-SQL terminal merely because it uses "what does ... mean".
  if (!/[_:./-]/.test(subject) && !/\b(?:block|metric|model|artifact)\b/i.test(originalSubject)) return undefined;
  return canonicalShapeTerm(subject) || undefined;
}

/**
 * Prefer the longest typed analytical span over its component words.  This is
 * extraction normalization only; the router still has to prove the selected
 * physical fields and no relationship is inferred here.
 */
function normalizeTypedAggregationRoles(
  question: string,
  metricTerms: string[],
  dimensionTerms: string[],
): { metricTerms: string[]; dimensionTerms: string[] } {
  const match = /\b(?:total|sum|average|avg|minimum|min|maximum|max)\s+([a-z][a-z0-9_ -]{1,60}?)\s+(?:per|by|for\s+each)\s+([a-z][a-z0-9_-]*)\b/i.exec(question);
  if (!match?.[1] || !match[2]) {
    return {
      metricTerms,
      dimensionTerms: preferLongestDimensionTerms(dimensionTerms),
    };
  }
  const measure = canonicalShapeTerm(match[1]);
  const dimension = canonicalShapeTerm(match[2]);
  if (!measure || !dimension) {
    return {
      metricTerms,
      dimensionTerms: preferLongestDimensionTerms(dimensionTerms),
    };
  }
  const measureParts = new Set(measure.split('_').filter(Boolean));
  const normalizedMetrics = metricTerms.map(canonicalShapeTerm).filter(Boolean);
  const retainedMetrics = normalizedMetrics.filter((term) =>
    term !== measure
    && !AGGREGATION_OPERATOR_WORDS.has(term)
    && term !== `total_${measure}`
    && !measureParts.has(term),
  );
  const retainedDimensions = dimensionTerms
    .map(canonicalShapeTerm)
    .filter((term) => term && !measureParts.has(term));
  return {
    metricTerms: uniqueStrings([measure, ...retainedMetrics]).slice(0, 16),
    dimensionTerms: preferLongestDimensionTerms(uniqueStrings([dimension, ...retainedDimensions])).slice(0, 16),
  };
}

/** Remove generic component roles when an explicit compound role is present. */
function preferLongestDimensionTerms(terms: string[]): string[] {
  // Dimension roles are canonical identifiers, not display labels. Applying
  // the same normalizer to both `product_category` and `product category`
  // keeps parser variants from becoming two competing dimensions.
  const normalized = uniqueStrings(terms.map(canonicalShapeTerm).filter(Boolean));
  const ordered = [...normalized].sort((left, right) =>
    right.split(/[_\s]+/).filter(Boolean).length - left.split(/[_\s]+/).filter(Boolean).length
    || left.localeCompare(right));
  const selected: string[] = [];
  for (const candidate of ordered) {
    const tokens = candidate.split(/[_\s]+/).filter(Boolean);
    const coveredByLonger = selected.some((longer) => {
      const longerTokens = new Set(longer.split(/[_\s]+/).filter(Boolean));
      return tokens.length < longerTokens.size && tokens.every((token) => longerTokens.has(token));
    });
    if (!coveredByLonger) selected.push(candidate);
  }
  return selected.sort((left, right) => normalized.indexOf(left) - normalized.indexOf(right));
}

function inferQuestionMode(input: {
  question: string;
  lower: string;
  entities: AnalysisEntityMention[];
  metricTerms: string[];
  dimensionTerms: string[];
  followUp?: unknown;
}): AnalysisQuestionMode {
  const { lower } = input;
  // A relative measure predicate is not an ordinary entity drilldown. It asks for
  // a peer set whose aggregate is compared with a named entity's aggregate (for
  // example, "customers who paid less tax than Melissa"). Classify it before the
  // conversation drilldown carry so a prior certified block cannot turn the ask
  // into a simple equality filter or a single global KPI.
  if (isEntityRelativeMeasureComparison(lower)) return 'comparison';
  if (followUpKind(input.followUp) === 'drilldown') return 'entity_drilldown';
  if (/^\s*(run|execute|open)\b/i.test(lower)) return 'exact_lookup';
  if (/\b(trust|rely|certif|certified|lineage|owner|caveat|gap|governance|can .* trust)\b/i.test(lower)) return 'trust_review';
  if (/\b(anomal|exception|outlier|spike|dip)\b/i.test(lower)) return 'anomaly';
  if (/\b(compare|versus|vs\.?|cohort)\b/i.test(lower)) return 'comparison';
  if (/\b(why|changed?|change|drop|dropped|decline|declined|increase|increased|decrease|decreased|delta|variance|what happened)\b/i.test(lower)) return 'diagnose_change';
  if (/\b(driver|drivers|drove|break\s*down|breakdown|contribute|contribution|top movers?)\b/i.test(lower)) return 'driver_breakdown';
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|minimum|min|maximum|max|rank|ranking|most|leading|leader|leaders)\b/i.test(lower)
    || hasComparativeMetricRanking(lower)) return 'ranking';
  if (/\b(profile|overview|360|complete\s+(?:stats|statistics|view)|full\s+(?:stats|statistics|view)|all\s+(?:stats|statistics|metrics)|research|reserach)\b/i.test(lower)) return 'entity_profile';
  if (/\b(trend|over time|by\s+(?:day|week|month|quarter|year|season)|daily|weekly|monthly|quarterly|yearly)\b/i.test(lower)) return 'trend';
  // "Across all customers" states the population for one aggregate; it does
  // not request a customer breakdown. Resolve direct KPI shape before the
  // generic each/every/all list heuristic.
  if (isDirectKpiValueQuestion(lower)) return 'exact_lookup';
  if (input.metricTerms.length > 0 && input.dimensionTerms.length > 0
    && /\b(each|every|all|list|show|give|provide)\b/i.test(lower)) return 'list_by_dimension';
  // "What is" is not, by itself, a definition request. Questions such as
  // "what is revenue by customer and product?" carry an explicit analytical
  // shape and must reach the data cascade. Keep genuine single-concept meaning
  // questions on the fast definition path while treating multi-dimensional or
  // explicitly grouped measure requests as analysis (AGT-001).
  if (/\b(define|definition|meaning of|what is|what are|what does .+ mean)\b/i.test(lower)
    && !definitionPhraseCarriesAnalyticalShape(input)) return 'definition';
  if (input.entities.length > 0 && (input.metricTerms.length > 0 || /\b(show|list|find|give|provide|performance|activity|history|details)\b/i.test(lower))) return 'entity_drilldown';
  if (/\b(block|certified|saved|existing|approved|governed)\b/i.test(lower)) return 'exact_lookup';
  if (/\b(show|list|find|which|who|how many|how much|metric|kpi|dashboard|performance|revenue|sales|orders|customers|users)\b/i.test(lower)) return 'general_analysis';
  // A question that carries real analytical structure — named grouping dimensions
  // and/or a measure to aggregate — is a general analysis, not an ambiguous ask.
  // Without this, "give me the average tax by location by product" (no whitelisted
  // verb) falls to clarify and then over-escalates into a slow research investigation
  // instead of a fast direct answer.
  if (input.dimensionTerms.length > 0 || input.metricTerms.length > 0) return 'general_analysis';
  return 'clarify';
}

function definitionPhraseCarriesAnalyticalShape(input: {
  lower: string;
  entities: AnalysisEntityMention[];
  metricTerms: string[];
  dimensionTerms: string[];
}): boolean {
  if (input.metricTerms.length === 0) return false;
  if (input.entities.length > 0) return true;
  if (input.dimensionTerms.length >= 2) return true;
  return input.dimensionTerms.length > 0
    && /\b(top|bottom|highest|lowest|most|least|by|per|each|every|group(?:ed)? by|split by|break(?:down| down)|info for|details for|got|bought|purchased)\b/i.test(input.lower);
}

function routeIntentForMode(mode: AnalysisQuestionMode): MetadataAgentIntent {
  switch (mode) {
    case 'exact_lookup': return 'exact_certified_lookup';
    case 'definition': return 'definition_lookup';
    case 'list_by_dimension': return 'ad_hoc_ranking';
    case 'ranking': return 'ad_hoc_ranking';
    case 'entity_profile':
    case 'entity_drilldown': return 'entity_drilldown';
    case 'trend': return 'segment_compare';
    case 'comparison': return 'segment_compare';
    case 'driver_breakdown': return 'driver_breakdown';
    case 'diagnose_change': return 'diagnose_change';
    case 'anomaly': return 'anomaly_investigation';
    case 'trust_review': return 'trust_gap_review';
    case 'general_analysis': return 'ad_hoc_ranking';
    case 'clarify': return 'clarify';
  }
}

function certifiedExactIsPlausible(mode: AnalysisQuestionMode, entities: AnalysisEntityMention[]): boolean {
  void entities;
  return mode !== 'clarify' && mode !== 'trust_review';
}

function generatedSqlIsLikely(mode: AnalysisQuestionMode, certifiedExact: boolean): boolean {
  void certifiedExact;
  if (mode === 'clarify' || mode === 'definition' || mode === 'trust_review') return false;
  // This flag controls whether dbt/schema evidence is hydrated as the final
  // fallback. It must not suppress contract-first certified/semantic matching.
  return mode !== 'exact_lookup';
}

function researchWorkspaceIsLikely(mode: AnalysisQuestionMode, lower: string): boolean {
  return ['entity_profile', 'driver_breakdown', 'diagnose_change', 'anomaly', 'trust_review'].includes(mode)
    || /\b(deep\s+research|research|reserach|investigate|investigation|root cause)\b/i.test(lower);
}

function outputShapeForMode(
  mode: AnalysisQuestionMode,
  lower: string,
  dimensionTerms: string[],
): AnalysisQuestionPlan['outputShape'] {
  if (mode === 'entity_profile') return 'profile';
  if (mode === 'definition' || mode === 'trust_review') return 'narrative';
  if (/\b(chart|graph|visual|plot|sankey|flow\s+diagram|source.?to.?target\s+flow)\b/i.test(lower) || mode === 'trend') return 'chart';
  if (mode === 'list_by_dimension' || dimensionTerms.length >= 2 || /\b(info for|details for|for each|group(?:ed)? by|split by|break(?:down| down))\b/i.test(lower)) return 'table';
  if (/\b(table|list|show all|complete|full)\b/i.test(lower) || mode === 'ranking' || mode === 'entity_drilldown') return 'table';
  if (/\bwhat (?:is|was|were|are)|how many|how much|total|count|kpi|metric\b/i.test(lower)) return 'value';
  return 'narrative';
}

function extractEntities(question: string): AnalysisEntityMention[] {
  const entities: AnalysisEntityMention[] = [];
  for (const match of question.matchAll(/["']([^"']{2,120})["']/g)) {
    entities.push({ text: match[1].trim(), source: 'quoted' });
  }
  for (const match of question.matchAll(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g)) {
    entities.push({ text: match[0], source: 'email', typeHint: 'email' });
  }
  for (const match of question.matchAll(/\b(?:id|account id|customer id|user id|sku)\s*[:=]?\s*([A-Za-z0-9_.-]{3,80})\b/gi)) {
    entities.push({ text: match[1].trim(), source: 'id' });
  }
  for (const match of question.matchAll(/\b(?:for|from|where|only|specific|named|called|profile\s+for|research\s+on|reserach\s+on)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,5})/g)) {
    entities.push({ text: cleanEntityText(match[1]), source: 'explicit_filter' });
  }
  // A one-token person/account reference after a comparator ("less than
  // Melissa") is still a data value. The generic named-entity regex below only
  // accepts two title-cased words, so without this rule the baseline entity is
  // lost and retrieval repeatedly selects a broad metric or the previous block.
  for (const match of question.matchAll(/\b(?:than|versus|vs\.?)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,4})/g)) {
    const text = cleanEntityText(match[1]);
    if (text) entities.push({ text, source: 'explicit_filter' });
  }
  for (const match of question.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g)) {
    const text = cleanEntityText(match[1]);
    if (text && !/^(SQL|DQL|KPI|ARR|MRR|NBA|AI|LLM)$/.test(text)) {
      entities.push({ text, source: 'named_entity' });
    }
  }
  return uniqueEntities(entities).slice(0, 8);
}

function extractValueMentions(entities: AnalysisEntityMention[]): AnalysisValueMention[] {
  return entities.map((entity) => ({
    text: entity.text,
    normalizedText: normalizeSearchText(entity.text),
    source: entity.source,
    syntacticRole: entity.source === 'id' || entity.source === 'email'
      ? 'entity_identifier'
      : entity.source === 'quoted' || entity.source === 'explicit_filter' || entity.source === 'named_entity'
        ? 'filter_value'
        : 'unknown',
    ...(entity.typeHint ? { typeHint: entity.typeHint } : {}),
  }));
}

function extractMetricTerms(question: string): string[] {
  // "%" is how users actually type percent questions ("consumption % by
  // customer"); normalize it so the measure-word scan can see it.
  const lower = question.toLowerCase().replace(/%/g, ' percent ');
  const terms = new Set<string>();
  for (const match of question.matchAll(/["']([^"']{2,120})["']/g)) {
    const identifier = match[1].trim();
    if (isQuotedAnalyticalIdentifier(identifier, question)) terms.add(identifier);
  }
  if (/\b(scorer|scorers|scoring|scored)\b/i.test(lower)) {
    terms.add('score');
    terms.add('scoring');
  }
  if (/\b(how many|number of)\b/i.test(lower)) {
    terms.add('count');
  }
  if (/\bhow much\b/i.test(lower)) {
    terms.add('amount');
  }
  if (/\b(spend|spends|spent|spending)\b/i.test(lower)) {
    terms.add('spend');
  }
  // Coordinated revenue questions must retain each business concept without
  // turning the connector into part of a metric name.  Previously the generic
  // `total <tail>` matcher stopped at `with` but retained the preceding word
  // `along`, producing fake measures such as `total_revenue_along` and
  // `revenue_along`.  These are search hints only; qualified metric identities
  // are still selected later from retrieved evidence.
  for (const match of lower.matchAll(/\b(beverage|drink|food|gross|net|product|order)\s+(revenue|sales|spend)\b/g)) {
    terms.add(normalizeTerm(`${match[1]} ${match[2]}`));
  }
  for (const word of METRIC_WORDS) {
    if (new RegExp(`\\b${escapeRegExp(word)}s?\\b`, 'i').test(lower)) terms.add(normalizeTerm(word));
  }
  for (const match of lower.matchAll(/\b(total|average|avg|count|sum|min|max)\s+([a-z][a-z0-9_ -]{2,40})/g)) {
    // Keep only the measure noun-phrase up to the first grouping/clause boundary,
    // so "average tax info by location by product" yields the measure "tax info",
    // not a 6-word blob that pollutes retrieval and masquerades as a column.
    const tail = match[2].replace(/\s+\b(along\s+with|by|per|for|across|grouped?|over|where|with|and|or|from|in|of)\b.*$/i, '').trim();
    if (tail.length < 2) continue;
    terms.add(normalizeTerm(`${match[1]} ${tail}`));
    terms.add(normalizeTerm(tail));
  }
  return uniqueStrings([...terms]).slice(0, 16);
}

function extractDimensionTerms(question: string): string[] {
  const lower = question.toLowerCase();
  const terms = new Set<string>();
  const rankingByMeasure = /\b(?:top|bottom|highest|lowest|most|least|best|worst|rank(?:ed|ing)?)\b[^?.!,;]{0,80}\bby\s+/i.test(lower);
  if (/\b(?:cusomers?|custmers?|costomers?|clients?|buyers?)\b/i.test(lower)) terms.add('customer');
  // Preserve authored compound roles before the generic vocabulary contributes
  // their component words. `product category` is one business dimension, not
  // two independent groupings named product + category.
  if (/\b(?:by|per|for\s+each|group(?:ed)?\s+by|split\s+by)\s+product\s+categor(?:y|ies)\b/i.test(lower)) {
    terms.add('product_category');
  }
  for (const word of DIMENSION_WORDS) {
    if (new RegExp(`\\b(?:${escapeRegExp(word)}|${escapeRegExp(pluralizeDimensionWord(word))})\\b`, 'i').test(lower)) terms.add(normalizeTerm(word));
  }
  for (const match of lower.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,60})/g)) {
    // "by A by B" is captured as one blob; split it back into the individual
    // grouping dimensions and stop each at a clause boundary, so we get ["a", "b"]
    // rather than a bogus single dimension "a_by_b" that later poisons retrieval
    // and shows up as a phantom required-output column.
    for (const piece of match[1].split(/\s+by\s+/)) {
      const value = piece.replace(/\b(where|for|with|and|or|from|over|in|per|of)\b.*$/i, '').trim();
      const normalized = normalizeTerm(value);
      const isRankingMeasurePhrase = rankingByMeasure
        && normalized.split(/\s+/).length > 1
        && METRIC_WORDS.some((word) => new RegExp(`\\b${escapeRegExp(word)}s?\\b`, 'i').test(normalized));
      if (normalized && !isRankingMeasurePhrase) terms.add(normalized);
    }
  }
  return preferLongestDimensionTerms([...terms]).slice(0, 16);
}

/**
 * Normalize one unambiguous natural-language grouping construction before it
 * can become retrieval authority.  In "revenue by sales based on the region",
 * `by` starts a malformed parser span, while "based on the region" names the
 * actual grouping role.  `sales` is already normalized as the revenue alias
 * by the host-owned measure parser; retaining the entire span as a dimension
 * would make the same immutable requirement seed disagree with retrieval and
 * prevent the bounded same-snapshot MetricFlow role extension from running.
 *
 * This is grammar only: it does not map a business term to a physical field,
 * infer a join, or make location a general synonym for region.  Candidate
 * selection still has to prove the one declared grouping field later.
 */
function normalizeExplicitGroupingGrammar(question: string, dimensions: string[]): string[] {
  if (!/\b(?:revenue|sales?)\s+based\s+on\s+(?:the\s+)?region\b/i.test(question)) {
    return dimensions;
  }
  const retained = dimensions.filter((dimension) => !/\b(?:revenue|sales?)\b.*\bbased\s+on\b.*\bregion\b/i.test(
    dimension.replace(/_/g, ' '),
  ));
  return preferLongestDimensionTerms([...retained, 'region']);
}

/**
 * In ranking grammar, `by <measure>` names the sort authority, while the noun
 * after `top`/`highest` names the row grain. Reconcile those roles only when an
 * extracted `by` term exactly matches a requested metric; unknown or ambiguous
 * nouns remain dimensions for bounded meaning resolution.
 */
function reconcileRankingRoles(
  question: string,
  dimensions: string[],
  metrics: string[],
): string[] {
  const lower = question.toLowerCase();
  const rankingConstruction = /\b(?:top|bottom|highest|lowest|most|least|best|worst|rank(?:ed|ing)?)\b[^?.!,;]{0,80}\bby\s+/i;
  if (!rankingConstruction.test(lower)) return dimensions;

  const metricKeys = new Set(metrics.map(normalizeTerm).filter(Boolean));
  const sortMetricKeys = new Set<string>();
  const sortTail = /\b(?:top|bottom|highest|lowest|most|least|best|worst|rank(?:ed|ing)?)\b[^?.!,;]{0,80}?\bby\s+([^?.!,;]+)/i.exec(lower)?.[1];
  if (sortTail) {
    for (const phrase of sortTail.split(/\s+(?:and|or)\s+|\s*,\s*/)) {
      const normalized = normalizeTerm(phrase.replace(/\b(by|for|where|with|from|over|in|per|of)\b.*$/i, '').trim());
      if (metricKeys.has(normalized)) sortMetricKeys.add(normalized);
    }
  }

  const reconciled = dimensions.filter((dimension) => !sortMetricKeys.has(normalizeTerm(dimension)));
  const subject = /\b(?:top|bottom|highest|lowest|most|least|best|worst|rank(?:ed|ing)?)\b(?:\s+\d+)?\s+(?:the\s+)?([a-z][a-z0-9_-]*)\s+by\b/i.exec(lower)?.[1];
  const normalizedSubject = subject ? normalizeTerm(subject) : '';
  const subjectRole = normalizedSubject.endsWith('s')
    && normalizedSubject.length > 3
    && !normalizedSubject.endsWith('ss')
    && !normalizedSubject.endsWith('us')
    ? normalizedSubject.slice(0, -1)
    : normalizedSubject;
  if (subjectRole && !metricKeys.has(subjectRole) && !reconciled.includes(subjectRole)) {
    reconciled.push(subjectRole);
  }
  return uniqueStrings(reconciled).slice(0, 16);
}

function removeFilterOnlyDimensionTerms(question: string, dimensions: string[]): string[] {
  const lower = question.toLowerCase();
  const filterDescriptors = /\b(?:on|in|within|from|among)\s+(?:the\s+)?(?:[a-z0-9&'_-]+\s+){0,3}?((?:[a-z][a-z0-9&'_-]*\s+)?(?:category|type|segment|class|group|channel|region|market))\b/g;
  const filterOnly = new Set<string>();
  for (const match of lower.matchAll(filterDescriptors)) {
    const descriptor = match[1] ?? '';
    const outsideDescriptor = `${lower.slice(0, match.index)} ${lower.slice((match.index ?? 0) + match[0].length)}`;
    for (const dimension of dimensions) {
      const word = escapeRegExp(dimension);
      if (!new RegExp(`\\b${word}s?\\b`, 'i').test(descriptor)) continue;
      const explicitlyGrouped = new RegExp(`\\b(?:by|per|for each|group(?:ed)? by|split by)\\b[^?.!,;]{0,40}\\b${word}s?\\b`, 'i').test(lower);
      const mentionedOutsideDescriptor = new RegExp(`\\b${word}s?\\b`, 'i').test(outsideDescriptor);
      if (!explicitlyGrouped && !mentionedOutsideDescriptor) filterOnly.add(dimension);
    }
  }
  // Natural-language purchase restrictions often put the filtered object after
  // its qualifier instead of before it: "customers who spent on beverage
  // category products". In that sentence the answer grain is customer; products
  // describe what was purchased and must not become an output dimension. Limit
  // this broader rule to transactional grammar so named subjects such as "What
  // changed in Player Stats Data Availability?" retain their analytical grain.
  const hasTransactionalRestriction = /\b(?:spend|spends|spent|spending|buy|buys|bought|buying|purchase|purchases|purchased|purchasing|order|orders|ordered|ordering|sell|sells|sold|selling)\b[^?.!,;]{0,80}\b(?:on|in|within|from|among)\b/i.test(lower);
  if (hasTransactionalRestriction) {
    for (const dimension of dimensions) {
      const word = escapeRegExp(dimension);
      const restriction = new RegExp(
        `\\b(?:on|in|within|from|among)\\s+(?:the\\s+)?[^?.!,;]{0,60}\\b${word}s?\\b`,
        'ig',
      );
      for (const match of lower.matchAll(restriction)) {
        const outsideRestriction = `${lower.slice(0, match.index)} ${lower.slice((match.index ?? 0) + match[0].length)}`;
        const explicitlyGrouped = new RegExp(
          `\\b(?:by|per|for each|group(?:ed)? by|split by)\\b[^?.!,;]{0,40}\\b${word}s?\\b`,
          'i',
        ).test(lower);
        const mentionedOutsideRestriction = new RegExp(`\\b${word}s?\\b`, 'i').test(outsideRestriction);
        if (!explicitlyGrouped && !mentionedOutsideRestriction) filterOnly.add(dimension);
      }
    }
  }
  return dimensions.filter((dimension) => !filterOnly.has(dimension));
}

function removeTemporalFilterDimensionTerms(
  question: string,
  dimensions: string[],
  timeTerms: string[],
): string[] {
  const relativeTemporalFilter = timeTerms.some((term) =>
    /^(?:today|yesterday|ytd|mtd|qtd|wtd|(?:last|this|next|previous|prior|past)\s+)/.test(term));
  if (!relativeTemporalFilter) return dimensions;
  return dimensions.filter((dimension) => {
    if (!/^(?:day|week|month|quarter|year|season|period)$/.test(dimension)) return true;
    const word = escapeRegExp(dimension);
    return new RegExp(
      `\\b(?:by|per)\\s+(?:the\\s+)?${word}s?\\b|\\b(?:for each|group(?:ed)? by|split by)\\b[^?.!,;]{0,24}\\b${word}s?\\b`,
      'i',
    ).test(question);
  });
}

function pluralizeDimensionWord(word: string): string {
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function extractFilterTerms(question: string, entities: AnalysisEntityMention[]): string[] {
  // Filter VALUES come from the question's own entities, time phrases, and
  // explicit analytical restriction grammar. Real value-to-column binding still
  // happens later against the runtime value index / sampled column values.
  const analyticalValues: string[] = [];
  const valuePatterns = [
    /\b(?:category|segment|type|class|group|channel|region|market)\s*(?:=|:|is|equals|of)\s+(?:the\s+)?([a-z][a-z0-9&'_-]*(?:\s+[a-z][a-z0-9&'_-]*){0,3})/gi,
    /\b(?:on|in|within|from|among)\s+(?:the\s+)?([a-z][a-z0-9&'_-]*(?:\s+[a-z][a-z0-9&'_-]*){0,2}?)(?=\s+(?:[a-z][a-z0-9&'_-]*\s+)?(?:category|type|segment|class|group|channel|region|market)\b)/gi,
    /\b(?:spend|spends|spent|spending)\b[^?.!,;]{0,60}?\bon\s+(?:the\s+)?([a-z][a-z0-9&'_-]*(?:\s+[a-z][a-z0-9&'_-]*){0,3}?)(?=\s+(?:product|products|item|items|category|segment|type)\b|[?.,!;]|$)/gi,
    /\b(?:buy|buys|bought|buying|purchase|purchases|purchased|purchasing)\s+(?:the\s+)?([a-z][a-z0-9&'_-]*(?:\s+[a-z][a-z0-9&'_-]*){0,3}?)(?=\s+(?:product|products|item|items|category|segment|type)\b|[?.,!;]|$)/gi,
  ];
  for (const pattern of valuePatterns) {
    for (const match of question.matchAll(pattern)) {
      const value = cleanAnalyticalFilterValue(match[1]);
      if (value) analyticalValues.push(value);
    }
  }
  return uniqueStrings([
    // Stored member values are phrases, not metadata tokens. Search can still
    // tokenize them separately, but the executable filter contract must not.
    ...entities
      .filter((entity) => entity.source !== 'quoted' || !isQuotedAnalyticalIdentifier(entity.text, question))
      .map((entity) => entity.text),
    ...analyticalValues,
    ...Array.from(question.matchAll(/\b(?:last|this|next|previous|prior|current|past)\s+(?:(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+)?(days?|weeks?|months?|quarters?|years?|seasons?)\b/gi)).map((match) => match[0].toLowerCase()),
  ]).slice(0, 16);
}

/**
 * Quoted snake_case names in analytical questions are commonly exact semantic
 * member IDs, not warehouse filter values. Treating them as values made a
 * multi-metric request fail semantic composition before the compiler ran.
 */
function isQuotedAnalyticalIdentifier(value: string, question: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(value)) return false;
  const words = value.replace(/_/g, ' ');
  if (METRIC_WORDS.some((word) => new RegExp(`\\b${escapeRegExp(word)}s?\\b`, 'i').test(words))) return true;
  const quotedIdentifiers = [...question.matchAll(/["']([^"']{2,120})["']/g)]
    .map((match) => match[1].trim())
    .filter((item) => /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(item));
  return quotedIdentifiers.length > 1 && /\b(?:metrics?|measures?|kpis?|what is|what are|show|compare)\b/i.test(question);
}

function extractQuotedAnalyticalIdentifiers(question: string): string[] {
  return uniqueStrings(
    [...question.matchAll(/["']([^"']{2,120})["']/g)]
      .map((match) => match[1].trim())
      .filter((value) => isQuotedAnalyticalIdentifier(value, question)),
  );
}

function cleanAnalyticalFilterValue(value: string | undefined): string {
  const cleaned = (value ?? '')
    .toLowerCase()
    .replace(/\b(?:highest|lowest|most|least|top|bottom|best|worst|the)\b/g, ' ')
    .replace(/^.*\b(?:on|in|within)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ies$/, 'y')
    .replace(/s$/, '');
  // Deictic phrases are resolved from the typed prior-result context; they are
  // not warehouse member values. Treating "for this amount" as a literal
  // filter polluted value search and produced invalid SQL predicates.
  if (/^(?:for\s+)?(?:this|that|same|previous|prior)\s+(?:amount|value|result|row)$/.test(cleaned)) return '';
  return cleaned;
}

function expandSearchTerm(raw: string): string[] {
  const term = normalizeTerm(raw);
  if (!term) return [];
  const singular = term.replace(/ies$/, 'y').replace(/s$/, '');
  return uniqueStrings([
    term,
    ...(singular.length > 1 ? [singular] : []),
    ...Array.from(SEARCH_TERM_SYNONYM_INDEX.get(term) ?? []),
    ...Array.from(SEARCH_TERM_SYNONYM_INDEX.get(singular) ?? []),
  ]);
}

function extractTimeTerms(question: string): string[] {
  const terms: string[] = [];
  // Relative determiners are temporal only when followed by a temporal noun.
  // A broad `this \w+` match classified deictic result references such as
  // "this amount" as a time grain and polluted both retrieval and SQL planning.
  //
  // An optional COUNT is allowed between determiner and noun: "last two
  // months" and "past 60 days" are windows over time, and requiring adjacency
  // made them invisible — the window then degraded into a bare `month`
  // grouping dimension while its count was misread as a row limit.
  for (const match of question.matchAll(/\b(?:today|yesterday|ytd|mtd|qtd|wtd|(?:last|this|next|previous|prior|past)\s+(?:(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+)?(?:(?:fiscal|calendar)\s+)?(?:hours?|days?|weeks?|months?|quarters?|years?|seasons?|periods?)|\d{4})\b/gi)) {
    terms.push(match[0].toLowerCase());
  }
  for (const word of ['date', 'day', 'week', 'month', 'quarter', 'year', 'season', 'period']) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(question)) terms.push(word);
  }
  const adjectiveGrains: Array<[RegExp, string]> = [
    [/\bdaily\b/i, 'day'],
    [/\bweekly\b/i, 'week'],
    [/\bmonthly\b/i, 'month'],
    [/\bquarterly\b/i, 'quarter'],
    [/\b(?:yearly|annual(?:ly)?)\b/i, 'year'],
  ];
  for (const [pattern, grain] of adjectiveGrains) if (pattern.test(question)) terms.push(grain);
  return uniqueStrings(terms).slice(0, 12);
}

function extractFollowUpMetricTerms(followUp: unknown, lowerQuestion?: string): string[] {
  if (!followUp || typeof followUp !== 'object' || Array.isArray(followUp)) return [];
  const record = followUp as Record<string, unknown>;
  // Advisory 'contextual' carry must not inject prior measures into a genuinely-new
  // question's plan (it would bias retrieval and the block-fit gate toward the old
  // topic). Carry prior measures only when the question textually refers back.
  if (record.kind === 'contextual' && lowerQuestion !== undefined
    && !/\b(these|those|that|them|this|same|prior|previous|above)\b/.test(lowerQuestion)) {
    return [];
  }
  return uniqueStrings([
    ...cleanStringArray(record.priorMeasures),
    ...cleanStringArray(record.priorResultColumns).filter((column) =>
      METRIC_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(column.replace(/_/g, ' ')))
    ),
  ]).slice(0, 8);
}

function resolveQuestionMetricTerms(
  lowerQuestion: string,
  directTerms: string[],
  followUpTerms: string[],
): string[] {
  if (!/\b(?:this|that|same|previous|prior)\s+(?:amount|value)\b/.test(lowerQuestion) || followUpTerms.length === 0) {
    // A follow-up that DECLARES its own measure ("consumption % by customer")
    // must not have the prior turn's measure competing in metric ranking — the
    // carry exists for measure-less refinements ("and by region?"), not to let
    // the previous metric outrank a newly named intent. This was the sticky-
    // metric bug: prior measure tokens rode into measureTerms and out-scored
    // the ratio metric the user actually asked for.
    if (directTerms.length > 0 && followUpTerms.length > 0) {
      return uniqueStrings(directTerms);
    }
    return uniqueStrings([...directTerms, ...followUpTerms]);
  }
  const monetary = followUpTerms.filter((term) =>
    /(?:amount|revenue|sales?|spend|value|price|cost|profit|margin|bookings?|arr|mrr)/i.test(term));
  const resolved = monetary.length > 0 ? monetary : [followUpTerms[0]!];
  return uniqueStrings([
    ...directTerms.filter((term) => term !== 'amount' && term !== 'value'),
    ...resolved,
  ]);
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

function buildRequestedAnswerShape(
  question: string,
  input: {
    lower: string;
    mode: AnalysisQuestionMode;
    metricTerms: string[];
    dimensionTerms: string[];
    filterTerms: string[];
    timeTerms: string[];
    followUp?: unknown;
  },
): RequestedAnswerShape {
  const topN = parseTopN(question);
  const memberBindings = extractMemberBindings(input.followUp);
  const followUpReferences = extractFollowUpReferences(question, input.followUp);
  const rawDimensions = uniqueStrings([
    ...input.dimensionTerms.map(canonicalShapeTerm),
    ...memberBindings.map((binding) => contextDimensionTerm(binding.dimension)),
    ...followUpDimensionsForRequestedShape(input.followUp, followUpReferences),
  ].filter(Boolean));
  const dimensions = scalarValueQuestionUsesEntitiesAsMeasures(input.mode, input.lower, rawDimensions)
    ? []
    : rawDimensions;
  const measures = uniqueStrings(input.metricTerms.map(canonicalShapeTerm).filter(Boolean));
  const requiredOutputs = extractRequiredOutputs(question, dimensions, measures);
  const filters = uniqueStrings([
    ...input.filterTerms,
    ...memberBindings.flatMap((binding) => binding.values),
    ...followUpFiltersForRequestedShape(input.followUp, followUpReferences),
  ]);
  const ambiguities = /\bimpact(?:ed|s|ing)?\b/i.test(question)
    ? [{
        term: 'impacted',
        defaultInterpretation: 'highest contribution to the requested metric',
        requiresClarification: false,
      }]
    : [];
  return {
    grain: inferRequestedShapeGrain(dimensions, input.timeTerms),
    dimensions,
    measures,
    requiredOutputs,
    filters,
    memberBindings,
    ...(topN ? { topN } : {}),
    rankingDirection: rankingDirection(question),
    followUpReferences,
    ambiguities,
  };
}

function scalarValueQuestionUsesEntitiesAsMeasures(
  mode: AnalysisQuestionMode,
  lower: string,
  dimensions: string[],
): boolean {
  if (mode !== 'exact_lookup' && mode !== 'general_analysis') return false;
  if (dimensions.length >= 2 || /\b(info for|details for|for each|group(?:ed)? by|split by|break(?:down| down))\b/.test(lower)) return false;
  return /\b(how many|how much|what is|what was|total|count|number of)\b/.test(lower)
    && !/\b(by|per|each|every|top|bottom|rank|ranking|list|which|who|break\s*down|breakdown|split|segment|trend|over time)\b/.test(lower);
}

/**
 * "last two months" is a TIME WINDOW, not a ranking. `first` and `last` sit in
 * the rank-keyword alternation because "first 3 rows" / "last 5 customers" are
 * genuine limits — but when the counted noun is a unit of time, the phrase
 * restricts WHEN, not HOW MANY. Treating it as a limit produced the reported
 * silent wrongness: "last two month with high revenue by customer name" ran as
 * an unordered LIMIT 2 with no date filter, and the invented limit even
 * overrode the safe implicit top-10 the ranking words would have earned.
 */
const TOP_N_TIME_NOUN_RE = /^\s*(?:days?|weeks?|months?|quarters?|years?|seasons?|periods?|hours?|minutes?)\b/;

function topNCountIsTimeWindow(lower: string, match: RegExpMatchArray): boolean {
  const keyword = match[0].trim().split(/\s+/)[0];
  if (keyword !== 'first' && keyword !== 'last') return false;
  const rest = lower.slice((match.index ?? 0) + match[0].length);
  return TOP_N_TIME_NOUN_RE.test(rest);
}

function parseTopN(question: string): RequestedAnswerShape['topN'] | undefined {
  const lower = question.toLowerCase();
  const numericMatch = lower.match(/\b(?:top|bottom|first|last)\s+(\d{1,3})\b/);
  const numeric = numericMatch && !topNCountIsTimeWindow(lower, numericMatch) ? numericMatch : null;
  const explicitN = numeric ? Number(numeric[1]) : wordNumberFromTopN(lower);
  // A ranking request without a literal N still needs a bounded result contract.
  // Ten is the product's concise table default; this prevents the provider from
  // silently widening "customers who spent most" to LIMIT 100.
  const n = explicitN ?? (hasImplicitRankingRequest(lower) ? 10 : undefined);
  if (!n || n <= 0) return undefined;
  const scope: 'overall' | 'per_group' = /\b(?:per|for each|within each)\s+\w+/i.test(lower)
    || /\bby\s+(?:category|segment|region|channel|product|customer|account|user|month|week|year)\b/i.test(lower)
    ? 'per_group'
    : 'overall';
  return { n, scope };
}

function hasImplicitRankingRequest(lower: string): boolean {
  return /\b(top|bottom|most|least|highest|lowest|largest|smallest|greatest|best|worst|leading)\b/.test(lower)
    || hasComparativeMetricRanking(lower)
    // A bounded high/low next to a measure is a ranking ask even without a
    // rank keyword — direction alone changes nothing unless the implicit
    // bounded-result default fires with it.
    || boundedHighLowDirection(lower) !== undefined;
}

function hasComparativeMetricRanking(lower: string): boolean {
  return /\bmore\s+(?:amount|bookings|cost|count|margin|orders?|points?|profit|quantity|revenue|sales|score|spend|spending|tax|usage|value|volume)\b/.test(lower);
}

function isEntityRelativeMeasureComparison(value: string): boolean {
  return /\b(?:less|lower|fewer|more|higher|greater)\b[^?.!]{0,80}\bthan\b\s+[a-z0-9@._'-]+/i.test(value)
    || /\b(?:below|under|above|over)\b\s+that\s+of\s+[a-z0-9@._'-]+/i.test(value);
}

function wordNumberFromTopN(lower: string): number | undefined {
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const match = lower.match(/\b(?:top|bottom|first|last)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (!match || topNCountIsTimeWindow(lower, match)) return undefined;
  return words[match[1]!];
}

// A required OUTPUT column is a hard contract on the result shape, so only a short,
// concrete identifier qualifies — never a multi-clause phrase scraped from the
// question (e.g. "location by product") that happens to leak through term extraction.
function isPlausibleRequiredColumn(term: string): boolean {
  const tokens = term.split(/[_\s]+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 2 && !tokens.includes('by');
}

function extractRequiredOutputs(question: string, dimensions: string[], measures: string[]): string[] {
  const lower = question.toLowerCase();
  const outputs = new Set<string>();
  for (const match of lower.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,3})\b/g)) {
    const identifier = canonicalShapeTerm(match[1]);
    if (isPlausibleRequiredColumn(identifier)) outputs.add(identifier);
  }
  for (const dim of dimensions) {
    if (isPlausibleRequiredColumn(dim)) outputs.add(dim);
  }
  for (const measure of measures) {
    // A measure pins the result shape only when it names a concrete single concept
    // ("revenue", "count", "orders"). A multi-word phrase scraped from the question
    // ("average tax info", "tax info by location") is a fuzzy search hint, not a
    // literal column the generated SQL must return — promoting it falsely flags a
    // valid answer as "partial". Single tokens (incl. "count" for KPI blocks) stay.
    const aggregationOperators = new Set(['total', 'sum', 'average', 'avg', 'minimum', 'min', 'maximum', 'max']);
    if (measure.split(/[_\s]+/).filter(Boolean).length === 1 && !aggregationOperators.has(measure)) outputs.add(measure);
  }
  if (/\bproduct\s+name\b/i.test(lower)) outputs.add('product_name');
  if (/\bcustomer\s+name\b/i.test(lower)) outputs.add('customer_name');
  if (/\bcategory\s+name\b/i.test(lower)) outputs.add('category_name');
  if (/\b(?:name|names)\b/i.test(lower)) {
    if (dimensions.includes('product')) outputs.add('product_name');
    if (dimensions.includes('customer')) outputs.add('customer_name');
    if (dimensions.includes('category')) outputs.add('category_name');
  }
  return uniqueStrings([...outputs]).slice(0, 24);
}

function extractFollowUpReferences(question: string, followUp?: unknown): RequestedAnswerShape['followUpReferences'] {
  const refs: RequestedAnswerShape['followUpReferences'] = [];
  const lower = question.toLowerCase();
  const record = followUpRecord(followUp);
  for (const binding of extractMemberBindings(followUp)) {
    refs.push({
      phrase: binding.values.join(', '),
      kind: 'prior_dimension_values',
      resolvedValues: binding.values,
    });
  }
  const hasFollowUp = Boolean(record);
  for (const match of lower.matchAll(/\b(this|these|those|that|same|prior|previous)\s+([a-z][a-z0-9_ -]{1,30})\b/g)) {
    const phrase = match[0];
    const noun = canonicalShapeTerm(match[2]);
    let kind: RequestedAnswerShape['followUpReferences'][number]['kind'] = 'ambiguous';
    if (/period|date|day|week|month|quarter|year|time/.test(noun)) kind = 'prior_timeframe';
    else if (hasFollowUp && /\b(category|product|customer|account|user|region|segment|channel|row|result)\b/.test(noun)) kind = 'prior_dimension_values';
    else if (hasFollowUp) kind = 'prior_entities';
    refs.push({
      phrase,
      kind,
      ...resolvedFollowUpValues(record, noun, kind),
    });
  }
  if (record && /\b(they|their|them)\b/.test(lower)) {
    const dimension = pronounFollowUpDimension(lower, record);
    refs.push({
      phrase: lower.match(/\b(they|their|them)\b/)?.[0] ?? 'they',
      kind: dimension ? 'prior_dimension_values' : 'prior_entities',
      ...resolvedFollowUpValues(record, dimension, dimension ? 'prior_dimension_values' : 'prior_entities'),
    });
  }
  if (refs.length === 0 && record) {
    const bare = lower.match(/\b(this|these|those|that|it|them|same)\b/);
    const dimension = bare ? singleFollowUpDimension(record) : undefined;
    if (bare && dimension) {
      refs.push({
        phrase: bare[0],
        kind: 'prior_dimension_values',
        ...resolvedFollowUpValues(record, dimension, 'prior_dimension_values'),
      });
    }
  }
  return refs.slice(0, 8);
}

function extractMemberBindings(followUp: unknown): NonNullable<RequestedAnswerShape['memberBindings']> {
  const record = followUpRecord(followUp);
  if (!record || !Array.isArray(record.memberBindings)) return [];
  return record.memberBindings.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const binding = item as Record<string, unknown>;
    const dimension = typeof binding.dimension === 'string' ? binding.dimension.trim() : '';
    const values = cleanStringArray(binding.values);
    if (!dimension || values.length === 0) return [];
    const source: NonNullable<RequestedAnswerShape['memberBindings']>[number]['source'] =
      binding.source === 'question' || binding.source === 'clarification' ? binding.source : 'prior_result';
    const confidence: NonNullable<RequestedAnswerShape['memberBindings']>[number]['confidence'] =
      binding.confidence === 'unique_partial' || binding.confidence === 'deictic'
        ? binding.confidence
        : 'exact';
    return [{
      dimension,
      values: uniqueStrings(values).slice(0, 24),
      source,
      confidence,
      ...(typeof binding.sourceTurnId === 'string' && binding.sourceTurnId.trim()
        ? { sourceTurnId: binding.sourceTurnId.trim() }
        : {}),
    }];
  }).slice(0, 12);
}

function pronounFollowUpDimension(question: string, record: Record<string, unknown>): string | undefined {
  const values = cleanStringRecord(record.priorResultValues);
  const available = new Set(Object.keys(values).map(contextDimensionTerm));
  if (available.has('customer') && /\b(they|their|them)\b[^.?!]{0,40}\b(buy|bought|purchase|purchased|order|ordered|spend|spent|use|used)\b/.test(question)) {
    return 'customer';
  }
  if (available.has('product') && /\b(they|their|them)\b[^.?!]{0,40}\b(sell|sold|cost|priced)\b/.test(question)) {
    return 'product';
  }
  return singleFollowUpDimension(record);
}

function followUpDimensionsForRequestedShape(
  followUp: unknown,
  refs: RequestedAnswerShape['followUpReferences'],
): string[] {
  const record = followUpRecord(followUp);
  if (!record) return [];
  const boundDimensions = extractMemberBindings(followUp).map((binding) => contextDimensionTerm(binding.dimension));
  if (boundDimensions.length > 0) return uniqueStrings(boundDimensions);
  if (refs.every((ref) => ref.kind !== 'prior_dimension_values')) return [];
  const explicit = cleanStringArray(record.dimensions).map(contextDimensionTerm).filter(Boolean);
  if (explicit.length > 0) return uniqueStrings(explicit);
  const single = singleFollowUpDimension(record);
  return single ? [single] : [];
}

function followUpFiltersForRequestedShape(
  followUp: unknown,
  refs: RequestedAnswerShape['followUpReferences'],
): string[] {
  const record = followUpRecord(followUp);
  if (!record) return [];
  const boundValues = extractMemberBindings(followUp).flatMap((binding) => binding.values);
  if (boundValues.length > 0) return uniqueStrings(boundValues);
  if (refs.every((ref) => ref.kind !== 'prior_dimension_values')) return [];
  return uniqueStrings([
    ...cleanStringArray(record.filters),
    ...refs.flatMap((ref) => ref.resolvedValues ?? []),
  ]);
}

function resolvedFollowUpValues(
  record: Record<string, unknown> | undefined,
  dimension: string | undefined,
  kind: RequestedAnswerShape['followUpReferences'][number]['kind'],
): { resolvedValues?: string[] } {
  if (!record || kind !== 'prior_dimension_values') return {};
  const values = followUpValuesForDimension(record, dimension);
  return values.length > 0 ? { resolvedValues: values } : {};
}

function followUpValuesForDimension(record: Record<string, unknown>, dimension: string | undefined): string[] {
  const valuesByDimension = cleanStringRecord(record.priorResultValues);
  const canonicalDimension = dimension ? contextDimensionTerm(dimension) : singleFollowUpDimension(record);
  const values = canonicalDimension
    ? valuesByDimension[canonicalDimension] ?? valuesByDimension[`${canonicalDimension}_name`] ?? []
    : [];
  return uniqueStrings([
    ...values,
    ...cleanStringArray(record.filters),
  ]).slice(0, 24);
}

function singleFollowUpDimension(record: Record<string, unknown>): string | undefined {
  const explicit = uniqueStrings(cleanStringArray(record.dimensions).map(contextDimensionTerm).filter(Boolean));
  if (explicit.length === 1) return explicit[0];
  if (explicit.length > 1) return undefined;
  const valuesByDimension = cleanStringRecord(record.priorResultValues);
  const inferred = uniqueStrings(
    Object.keys(valuesByDimension)
      .map(contextDimensionTerm)
      .filter((term) => term && !METRIC_WORDS.includes(term)),
  );
  return inferred.length === 1 ? inferred[0] : undefined;
}

function contextDimensionTerm(value: string): string {
  const term = canonicalShapeTerm(value);
  if (term.includes('category')) return 'category';
  if (term.includes('product')) return 'product';
  if (term.includes('customer')) return 'customer';
  if (term.includes('account')) return 'account';
  if (term.includes('user')) return 'user';
  if (term.includes('region')) return 'region';
  if (term.includes('segment')) return 'segment';
  if (term.includes('channel')) return 'channel';
  return term;
}

function cleanStringRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = contextDimensionTerm(key);
    const values = cleanStringArray(raw).slice(0, 24);
    if (cleanKey && values.length > 0) out[cleanKey] = values;
  }
  return out;
}

function followUpRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inferRequestedShapeGrain(dimensions: string[], timeTerms: string[]): string | undefined {
  if (dimensions.length > 0) return dimensions[0];
  const time = timeTerms.find((term) => /\b(hour|day|week|month|quarter|year|season|period|date)\b/i.test(term));
  return time ? canonicalShapeTerm(time) : undefined;
}

function canonicalShapeTerm(value: string): string {
  return normalizeTerm(value).replace(/\s+/g, '_');
}

function buildSearchQueries(input: {
  question: string;
  mode: AnalysisQuestionMode;
  entities: AnalysisEntityMention[];
  metricTerms: string[];
  dimensionTerms: string[];
  filterTerms: string[];
  timeTerms: string[];
  searchTerms: string[];
}): string[] {
  const entityText = input.entities.map((entity) => entity.text).join(' ');
  const profileTerms = input.mode === 'entity_profile' ? PROFILE_WORDS.join(' ') : '';
  return uniqueStrings([
    input.question,
    [entityText, ...input.metricTerms, ...input.dimensionTerms].filter(Boolean).join(' '),
    [...input.metricTerms, ...input.dimensionTerms, ...input.timeTerms].join(' '),
    [profileTerms, ...input.searchTerms.slice(0, 12)].filter(Boolean).join(' '),
    input.searchTerms.slice(0, 18).join(' '),
  ].map((query) => query.replace(/\s+/g, ' ').trim()).filter(Boolean)).slice(0, 5);
}

function buildPlanReasons(
  mode: AnalysisQuestionMode,
  entities: AnalysisEntityMention[],
  metrics: string[],
  dimensions: string[],
  timeTerms: string[],
  certifiedExact: boolean,
): string[] {
  return [
    `classified as ${mode}`,
    entities.length ? `entities: ${entities.map((entity) => entity.text).join(', ')}` : '',
    metrics.length ? `metrics: ${metrics.join(', ')}` : '',
    dimensions.length ? `dimensions: ${dimensions.join(', ')}` : '',
    timeTerms.length ? `time context: ${timeTerms.join(', ')}` : '',
    certifiedExact ? 'certified exact answer is plausible' : 'generated SQL may be needed if no exact certified contract matches',
  ].filter(Boolean);
}

function modeSearchTerms(mode: AnalysisQuestionMode): string[] {
  switch (mode) {
    case 'entity_profile': return ['profile', 'summary', 'details', 'stats', 'statistics', 'history'];
    case 'entity_drilldown': return ['detail', 'filter', 'name', 'id'];
    case 'list_by_dimension': return ['list', 'detail', 'group'];
    case 'ranking': return ['rank', 'top', 'bottom', 'total'];
    case 'trend': return ['date', 'time', 'month', 'week', 'year', 'trend'];
    case 'comparison': return ['compare', 'segment', 'cohort'];
    case 'driver_breakdown': return ['driver', 'breakdown', 'contribution'];
    case 'diagnose_change': return ['change', 'baseline', 'period', 'date'];
    case 'anomaly': return ['anomaly', 'exception', 'outlier'];
    case 'trust_review': return ['lineage', 'owner', 'certified', 'caveat'];
    default: return [];
  }
}

function scoreSourceShape(object: MetadataObject, plan: AnalysisQuestionPlan): number {
  const text = objectSearchText(object);
  let score = 0;
  if ((object.objectType === 'dbt_model' || object.objectType === 'warehouse_table' || object.objectType === 'runtime_table') && plan.needsGeneratedSql) score += 12;
  if (plan.mode === 'entity_profile' && /\b(dim|entity|profile|customer|account|user|product|player|vendor|person|member)\b/i.test(text)) score += 8;
  if (plan.mode === 'entity_profile' && /\b(fct|fact|event|transaction|activity|performance|stats|history)\b/i.test(text)) score += 8;
  if (plan.mode === 'trend' && /\b(date|time|day|week|month|quarter|year|season|period)\b/i.test(text)) score += 10;
  if (plan.mode === 'ranking' && /\b(total|amount|score|count|rank|revenue|sales|points|orders)\b/i.test(text)) score += 8;
  return score;
}

function relationSearchText(relation: MetadataAllowedSqlContext['relations'][number]): string {
  return [
    relation.relation,
    relation.name,
    relation.source,
    relation.columns.map((column) => `${column.name} ${column.description ?? ''}`).join(' '),
  ].join(' ');
}

function isDirectCertifiedQuestion(plan: AnalysisQuestionPlan): boolean {
  return plan.mode === 'exact_lookup' || plan.mode === 'definition' || plan.shouldConsiderCertifiedExact;
}

function hasExactExampleQuestion(object: MetadataObject, normalizedQuestion: string): boolean {
  const examples = Array.isArray(object.payload?.examples) ? object.payload.examples : [];
  return examples.some((example) => {
    if (!example || typeof example !== 'object') return false;
    const question = (example as { question?: unknown }).question;
    return typeof question === 'string' && normalizeSearchText(question) === normalizedQuestion;
  });
}

function rankingDirectionCompatible(question: string, targetText: string): boolean {
  const questionDirection = rankingDirection(question);
  if (!questionDirection) return true;
  const targetDirection = rankingDirection(targetText);
  return !targetDirection || targetDirection === questionDirection;
}

/**
 * "high revenue" / "low margin" are ranking language, but bare `high|low` is
 * not: "high level overview" and "low priority" rank nothing. Bound the words
 * to a measure within the same clause, in either order ("high revenue",
 * "revenue is low"). Without this, "customers with high revenue" earned no
 * direction and no implicit limit — the plan was literally "limit N, no
 * order", which executed as an arbitrary unordered LIMIT.
 */
const RANKING_MEASURE_WORDS = 'revenue|sales|spend|spending|amount|count|orders?|margin|profit|value|volume|usage|cost|quantity|points?|score|tax|bookings';
function boundedHighLowDirection(lower: string): 'top' | 'bottom' | undefined {
  const high = new RegExp(`\\bhigh(?:est)?\\b(?!\\s*(?:-\\s*)?level\\b)(?=[^?.!,;]{0,40}\\b(?:${RANKING_MEASURE_WORDS})\\b)`).test(lower)
    || new RegExp(`\\b(?:${RANKING_MEASURE_WORDS})\\b(?=[^?.!,;]{0,24}\\bhigh(?:est)?\\b)`).test(lower);
  const low = new RegExp(`\\blow(?:est)?\\b(?=[^?.!,;]{0,40}\\b(?:${RANKING_MEASURE_WORDS})\\b)`).test(lower)
    || new RegExp(`\\b(?:${RANKING_MEASURE_WORDS})\\b(?=[^?.!,;]{0,24}\\blow(?:est)?\\b)`).test(lower);
  if (high && !low) return 'top';
  if (low && !high) return 'bottom';
  return undefined;
}

function rankingDirection(value: string): 'top' | 'bottom' | undefined {
  const lower = value.toLowerCase();
  const bottom = /\b(bottom|worst|lowest|least|fewest|minimum|min|smallest)\b/.test(lower)
    || /\b(?:less|lower|fewer)\b[^?.!]{0,80}\bthan\b/.test(lower)
    || /\b(?:below|under)\b\s+that\s+of\s+[a-z0-9@._'-]+/.test(lower);
  const top = /\b(top|best|highest|most|maximum|max|largest|leading|leaders?)\b/.test(lower)
    || hasComparativeMetricRanking(lower)
    || /\b(?:more|higher|greater)\b[^?.!]{0,80}\bthan\b/.test(lower)
    || /\b(?:above|over)\b\s+that\s+of\s+[a-z0-9@._'-]+/.test(lower);
  if (bottom && !top) return 'bottom';
  if (top && !bottom) return 'top';
  if (!top && !bottom) return boundedHighLowDirection(lower);
  return undefined;
}

function scoreTerms(text: string, terms: string[]): ScoredTextMatch {
  const matched: string[] = [];
  let score = 0;
  for (const term of uniqueStrings(terms.map(normalizeTerm).filter(Boolean))) {
    if (!term || term.length < 2) continue;
    const tokens = term.split(/\s+/).filter(Boolean);
    const hit = tokens.length > 1
      ? text.includes(term)
      : new RegExp(`\\b${escapeRegExp(term)}s?\\b`, 'i').test(text);
    if (!hit) continue;
    matched.push(term);
    score += tokens.length > 1 ? 1.4 : 1;
  }
  return { score, matched };
}

function objectSearchText(object: MetadataObject): string {
  return normalizeSearchText([
    object.objectType,
    object.objectKey,
    object.name,
    object.fullName ?? '',
    object.domain ?? '',
    object.owner ?? '',
    object.status ?? '',
    object.description ?? '',
    object.sourceSystem ?? '',
    JSON.stringify(object.payload ?? {}),
  ].join(' '));
}

function directionalTextForObject(object: MetadataObject): string {
  return normalizeSearchText([
    object.name,
    object.description ?? '',
    Array.isArray(object.payload?.tags) ? object.payload.tags.join(' ') : '',
    typeof object.payload?.sql === 'string' ? object.payload.sql : '',
  ].join(' '));
}

function planConfidence(
  mode: AnalysisQuestionMode,
  entities: AnalysisEntityMention[],
  metrics: string[],
  dimensions: string[],
): number {
  let score = mode === 'clarify' ? 0.25 : 0.55;
  if (entities.length) score += 0.14;
  if (metrics.length) score += 0.12;
  if (dimensions.length) score += 0.08;
  if (mode === 'entity_profile') score += 0.08;
  return Math.min(0.92, Number(score.toFixed(2)));
}

function followUpKind(value: unknown): string | undefined {
  return value && typeof value === 'object' ? String((value as { kind?: unknown }).kind ?? '') : undefined;
}

function uniqueEntities(items: AnalysisEntityMention[]): AnalysisEntityMention[] {
  const seen = new Set<string>();
  const out: AnalysisEntityMention[] = [];
  for (const item of items) {
    const text = cleanEntityText(item.text);
    const key = normalizeSearchText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, text });
  }
  return out;
}

function cleanEntityText(value: string): string {
  return value
    .replace(/^(?:can\s+you\s+)?(?:research|reserach|show|find|provide|give|list|tell\s+me|run|execute|open)\s+/i, '')
    .replace(/\b(profile|stats?|statistics|complete|full|details?|summary|with|and|by|for|from|in|on)\b.*$/i, '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDirectKpiValueQuestion(lower: string): boolean {
  const asksForValue = /\b(what\s+(?:is|was|were|are)|how\s+(?:much|many)|show|report|calculate|give\s+me|tell\s+me)\b/.test(lower);
  const aggregateCue = /\b(how\s+(?:much|many)|show|report|calculate|give\s+me|tell\s+me|total|sum|count|number of|average|avg|minimum|min|maximum|max|across\s+all|overall)\b/.test(lower);
  const temporalScope = /\b(?:last|this|previous|prior|current)\s+(?:day|week|month|quarter|year)\b/.test(lower);
  const metricLanguage = /\b(revenue|sales|spend|spending|cost|profit|margin|value|amount|usage|arr|mrr|bookings|orders|customers|users|churn|retention|conversion|rate|count|total|points|goals|kpi|metric)\b/.test(lower);
  const customGrain = /\b(by|break\s*down|breakdown|drill|compare|versus|vs\.?|segment|cohort|top|bottom|best|worst|highest|lowest|least|fewest|rank|ranking|most|why|changed?|driver|anomal|exception)\b/.test(lower);
  return asksForValue && (aggregateCue || temporalScope) && metricLanguage && !customGrain;
}

function tokenize(value: string): string[] {
  const tokens = new Set<string>();
  for (const raw of normalizeSearchText(value).split(/\s+/)) {
    const normalized = normalizeTerm(raw);
    if (!normalized || normalized.length < 2 || STOP_WORDS.has(normalized)) continue;
    tokens.add(normalized);
  }
  return [...tokens];
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9@. ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTerm(value: string): string {
  const clean = normalizeSearchText(value);
  if (/^(cusomer|custmer|costomer|client|buyer)s?$/.test(clean)) return 'customer';
  if (clean.endsWith('ies') && clean.length > 4) return `${clean.slice(0, -3)}y`;
  if (clean.endsWith('s') && clean.length > 4) return clean.slice(0, -1);
  return clean;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function isCertifiedObject(object: MetadataObject): boolean {
  return object.status === 'certified' || object.status === 'approved' || object.payload?.certification === 'certified';
}

function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
