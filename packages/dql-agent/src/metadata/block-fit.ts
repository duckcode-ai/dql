import type { KGNode } from '../kg/types.js';
import type { AnalysisQuestionPlan, RequestedAnswerShape } from './analysis-planner.js';
import type { MetadataObject } from './catalog.js';
import { extractSimpleSelectShape, selectExpressionOutputName } from './sql-shape.js';

export interface CertifiedBlockFit {
  kind: 'exact' | 'trim_safe' | 'context_only' | 'not_applicable';
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  missingOutputs: string[];
  missingDimensions: string[];
  unsupportedFilters: string[];
  grainMismatch?: string;
  topNAction?: 'none' | 'trim' | 'generate';
  inferredContract: boolean;
}

export function requestedShapeFromPlan(plan: AnalysisQuestionPlan): RequestedAnswerShape {
  return plan.requestedShape;
}

export function certifiedFitAllowsTier1(fit: CertifiedBlockFit): boolean {
  return (fit.kind === 'exact' || fit.kind === 'trim_safe') && fit.confidence === 'high';
}

export function evaluateCertifiedBlockFit(input: {
  question: string;
  plan: AnalysisQuestionPlan;
  block: MetadataObject | KGNode;
  exactExampleMatch?: boolean;
  definitionLookup?: boolean;
}): CertifiedBlockFit {
  const requested = requestedShapeFromPlan(input.plan);
  const block = blockShape(input.block);

  if (input.definitionLookup || input.exactExampleMatch) {
    return {
      kind: 'exact',
      confidence: 'high',
      reasons: [input.definitionLookup ? 'definition lookup bypasses shape fit' : 'question matches a certified example'],
      missingOutputs: [],
      missingDimensions: [],
      unsupportedFilters: [],
      topNAction: 'none',
      inferredContract: block.inferredContract,
    };
  }

  const requestedDimensions = requested.dimensions.map(canonicalToken).filter(Boolean);
  const requestedMeasures = requested.measures.map(canonicalToken).filter(Boolean);
  const requiredOutputs = requested.requiredOutputs.map(canonicalColumn).filter(Boolean);
  const blockDimensions = new Set(block.dimensions);
  const blockMeasures = new Set(block.measures);
  const blockOutputs = new Set(block.outputs);

  const missingDimensions = uniqueStrings(requestedDimensions.filter((dimension) =>
    !blockDimensions.has(dimension) && !outputHasEntity(blockOutputs, dimension)
  ));
  const missingOutputs = uniqueStrings(requiredOutputs.filter((output) =>
    !outputRequirementCovered(output, block)
  ));
  const measureMatch = requestedMeasures.length === 0
    || requestedMeasures.some((measure) => blockMeasures.has(measure) || block.textTokens.has(measure) || outputHasEntity(blockOutputs, measure));

  const unsupportedFilters = unsupportedRequestedFilters(requested, block, input.question);
  const grainMismatch = requested.grain && block.grain && canonicalToken(requested.grain) !== block.grain
    && !blockDimensions.has(canonicalToken(requested.grain))
    ? `certified block grain=${block.grain} does not cover requested grain=${canonicalToken(requested.grain)}`
    : scalarRequestCannotUseRowGrainBlock(input.plan, requestedDimensions, block)
      ? `certified block returns rows at ${block.grain ?? block.dimensions[0]} grain but the question requests one aggregate value`
      : undefined;
  const topNAction = topNFitAction(requested, block);

  if (grainMismatch || missingDimensions.length > 0 || missingOutputs.length > 0 || unsupportedFilters.length > 0 || !measureMatch || topNAction === 'generate') {
    const reasons = [
      grainMismatch,
      missingDimensions.length ? `missing requested dimensions: ${missingDimensions.join(', ')}` : '',
      missingOutputs.length ? `missing requested outputs: ${missingOutputs.join(', ')}` : '',
      unsupportedFilters.length ? `unsupported requested filters: ${unsupportedFilters.join(', ')}` : '',
      !measureMatch ? `missing requested measures: ${requestedMeasures.join(', ')}` : '',
      topNAction === 'generate' ? 'certified block limit is narrower than requested top-N' : '',
    ].filter((reason): reason is string => Boolean(reason));
    return {
      kind: block.relevance > 0 ? 'context_only' : 'not_applicable',
      confidence: 'high',
      reasons,
      missingOutputs,
      missingDimensions,
      unsupportedFilters,
      grainMismatch,
      topNAction,
      inferredContract: block.inferredContract,
    };
  }

  const hasRequestedShape = requestedDimensions.length > 0 || requestedMeasures.length > 0 || requiredOutputs.length > 0 || Boolean(requested.grain);
  if (!hasRequestedShape) {
    return {
      kind: 'exact',
      confidence: 'low',
      reasons: ['question has no strong requested answer shape; block fit is not proven'],
      missingOutputs: [],
      missingDimensions: [],
      unsupportedFilters: [],
      topNAction: 'none',
      inferredContract: block.inferredContract,
    };
  }

  const inferredMeasureOnly = block.inferredContract
    && block.outputs.length === 0
    && requestedDimensions.length === 0
    && requiredOutputs.length > 0
    && requiredOutputs.every((output) => outputRequirementCovered(output, block));
  return {
    kind: topNAction === 'trim' ? 'trim_safe' : 'exact',
    confidence: block.inferredContract && block.outputs.length === 0 && !inferredMeasureOnly ? 'medium' : 'high',
    reasons: [
      'certified block covers requested metric, grain, dimensions, filters, and outputs',
      topNAction === 'trim' ? 'certified result can be trimmed to requested top-N' : '',
      block.inferredContract ? 'block contract was safely inferred from available metadata' : '',
    ].filter(Boolean),
    missingOutputs: [],
    missingDimensions: [],
    unsupportedFilters: [],
    topNAction,
    inferredContract: block.inferredContract,
  };
}

/**
 * A block can contain the requested measure and still answer at the wrong
 * cardinality. For example, a customer-profile block exposes lifetime_spend,
 * but it cannot directly answer "total lifetime spend across all customers"
 * because it returns one row per customer. Keep it as trusted context and let
 * the semantic compiler perform the requested aggregate instead. AGT-009/010.
 */
function scalarRequestCannotUseRowGrainBlock(
  plan: AnalysisQuestionPlan,
  requestedDimensions: string[],
  block: BlockShape,
): boolean {
  if (plan.outputShape !== 'value' || requestedDimensions.length > 0) return false;
  return block.dimensions.length > 0;
}

interface BlockShape {
  grain?: string;
  dimensions: string[];
  measures: string[];
  outputs: string[];
  filters: string[];
  /** Static scope proven by the certified name/tags/WHERE clause. */
  scopeTokens: Set<string>;
  limit?: number;
  textTokens: Set<string>;
  relevance: number;
  inferredContract: boolean;
}

function blockShape(block: MetadataObject | KGNode): BlockShape {
  const record = block as unknown as Record<string, unknown>;
  const payload = isMetadataObject(block) ? block.payload ?? {} : record;
  const sql = stringValue(payload.sql) ?? stringValue(record.sql);
  const descriptiveText = [
    stringValue(record.name),
    stringValue(record.description),
    stringValue(payload.description),
    stringValue(payload.llmContext),
    Array.isArray(record.tags) ? (record.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
  ].filter(Boolean).join(' ');
  const sqlOutputs = sql ? extractSqlOutputs(sql) : [];
  const outputs = uniqueStrings([
    ...stringArray(payload.declaredOutputs),
    ...stringArray(record.declaredOutputs),
    ...stringArray(payload.outputs),
    ...stringArray(payload.outputContract),
    ...outputContractColumns(payload.outputContract),
    ...sqlOutputs,
  ].map(canonicalColumn).filter(Boolean));
  const explicitDimensions = uniqueStrings([
    ...stringArray(payload.dimensions),
    ...stringArray(record.dimensions),
    ...outputs.filter(isDimensionLike),
    ...tokensFromValue(stringValue(payload.grain) ?? stringValue(record.grain) ?? '').filter(isDimensionLike),
  ].map(canonicalToken).filter(Boolean));
  const dimensions = uniqueStrings([
    ...explicitDimensions,
    ...inferredTextDimensions(descriptiveText),
  ]);
  const measures = uniqueStrings([
    ...outputs.filter(isMeasureLike),
    ...tokensFromValue(descriptiveText).filter(isMeasureLike),
  ].map(canonicalToken).filter(Boolean));
  const textTokens = new Set(tokensFromValue([
    descriptiveText,
    JSON.stringify(payload),
  ].filter(Boolean).join(' ')).map(canonicalToken));
  const filters = uniqueStrings([
    ...stringArray(payload.allowedFilters),
    ...stringArray(record.allowedFilters),
    ...filterBindingNames(payload.filterBindings),
    ...filterBindingNames(record.filterBindings),
    ...parameterNames(payload.parameters),
    ...parameterNames(record.parameters),
  ].map(canonicalToken).filter(Boolean));
  const scopeText = [
    stringValue(record.name),
    Array.isArray(record.tags) ? (record.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
    Array.isArray(payload.tags) ? (payload.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
    sql ? extractSqlFilterScope(sql) : '',
  ].filter(Boolean).join(' ');
  const scopeTokens = new Set(tokensFromValue(scopeText).map(canonicalToken).filter(Boolean));
  const grain = canonicalToken(stringValue(payload.grain) ?? stringValue(record.grain) ?? explicitDimensions[0] ?? '');
  const relevance = outputs.length + dimensions.length + measures.length;
  return {
    ...(grain ? { grain } : {}),
    dimensions,
    measures,
    outputs,
    filters,
    scopeTokens,
    limit: sql ? parseSqlLimit(sql) : undefined,
    textTokens,
    relevance,
    inferredContract: stringArray(payload.declaredOutputs).length === 0 && stringArray(record.declaredOutputs).length === 0,
  };
}

function parameterNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
    ? [(item as { name: string }).name]
    : []);
}

function inferredTextDimensions(text: string): string[] {
  const normalized = text.replace(/[_-]+/g, ' ').toLowerCase();
  const inferred: string[] = [];
  for (const match of normalized.matchAll(/\b(?:by|per)\s+([a-z][a-z0-9 ]{1,48})/g)) {
    const phrase = (match[1] ?? '')
      .replace(/\b(?:for|from|with|and|or|including|include|where|when|over|during|not)\b.*$/i, '')
      .trim();
    const dimensions = tokensFromValue(phrase).map(canonicalToken).filter(isDimensionLike);
    const dimension = dimensions.at(-1);
    if (dimension) inferred.push(dimension);
  }
  return uniqueStrings(inferred);
}

function unsupportedRequestedFilters(requested: RequestedAnswerShape, block: BlockShape, question: string): string[] {
  const memberBindings = requested.memberBindings ?? [];
  const boundValueTokens = new Set(memberBindings.flatMap((binding) => binding.values.map(canonicalToken)));
  const unsupportedBindings = memberBindings.flatMap((binding) => {
    const dimension = canonicalToken(binding.dimension);
    const dimensionAliases = new Set([dimension, dimension.replace(/_name$/, '')]);
    const staticallyScoped = binding.values.every((value) => block.scopeTokens.has(canonicalToken(value)));
    const exposesBinding = [...dimensionAliases].some((alias) => block.filters.includes(alias) || block.dimensions.includes(alias));
    return staticallyScoped || exposesBinding ? [] : binding.values;
  });
  const requestedFilters = uniqueStrings([
    ...requested.filters.filter((filter) => !boundValueTokens.has(canonicalToken(filter))),
    ...requested.followUpReferences.flatMap((ref) => ref.resolvedValues ?? []),
  ].map(canonicalToken).filter((filter) => Boolean(filter) && !isTemporalFilter(filter)));
  const unboundRequestedFilters = requestedFilters.filter((filter) => !boundValueTokens.has(filter));
  if (unboundRequestedFilters.length === 0) return uniqueStrings(unsupportedBindings);
  // A certified artifact may bake a restriction into its identity and SQL
  // rather than expose it as a dynamic parameter. For example,
  // top_beverage_customers has WHERE products.is_beverage and is already exactly
  // beverage-scoped. This is stronger than a description mention: scopeTokens
  // are sourced only from the certified name, tags, and WHERE clause.
  const uncoveredFilters = unboundRequestedFilters.filter((filter) => !block.scopeTokens.has(filter));
  if (uncoveredFilters.length === 0) return uniqueStrings(unsupportedBindings);
  // A filtered question cannot be answered exactly by an unparameterized block.
  // Returning [] here used to erase the user's restriction and let a broad
  // certified ranking (for example all-customer lifetime spend) answer a
  // category-specific question. A block may still be useful as context, but it
  // cannot terminate the certified lane unless it exposes the requested value
  // through a filter or dimension contract.
  if (block.filters.length === 0) {
    // A certified breakdown can be safely narrowed on one of its own output
    // dimensions when the question explicitly names that binding ("by segment
    // for Enterprise"). The adaptation lane applies the actual restriction.
    const explicitlyFilterable = block.dimensions.some((dimension) => {
      const words = dimension.replace(/_/g, '[ _-]+');
      return new RegExp(`\\b(?:by|per)\\s+${words}\\b`, 'i').test(question)
        || new RegExp(`\\b${words}\\s*(?:=|:|is|equals)`, 'i').test(question);
    });
    if (explicitlyFilterable) return uniqueStrings(unsupportedBindings);
    return uniqueStrings([
      ...unsupportedBindings,
      ...uncoveredFilters.filter((filter) => !block.dimensions.includes(filter)),
    ]);
  }
  const blockFilters = new Set(block.filters);
  return uniqueStrings([
    ...unsupportedBindings,
    ...uncoveredFilters.filter((filter) => !blockFilters.has(filter) && !block.dimensions.includes(filter)),
  ]);
}

function extractSqlFilterScope(sql: string): string {
  const match = /\bwhere\b([\s\S]*?)(?=\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|$)/i.exec(sql);
  return match?.[1] ?? '';
}

function isTemporalFilter(filter: string): boolean {
  return /^(?:day|week|month|quarter|year|season)$/.test(filter)
    || /^(?:last|this|next|previous|prior|current)_(?:day|week|month|quarter|year|season)$/.test(filter)
    || /^\d{4}$/.test(filter);
}

function topNFitAction(requested: RequestedAnswerShape, block: BlockShape): CertifiedBlockFit['topNAction'] {
  if (!requested.topN) return 'none';
  if (!block.limit) return 'none';
  if (block.limit === requested.topN.n) return 'none';
  if (block.limit > requested.topN.n) return 'trim';
  return 'generate';
}

function outputCoversRequired(outputs: string[], required: string): boolean {
  const outputSet = new Set(outputs);
  if (outputSet.has(required)) return true;
  const requiredTokens = required.split('_').filter(Boolean);
  if (requiredTokens.length === 0) return true;
  if (required.endsWith('_name')) {
    const entity = requiredTokens[0] ?? '';
    return outputs.some((output) => {
      const tokens = output.split('_');
      return tokens.includes(entity) && (tokens.includes('name') || tokens.includes('title') || output === entity);
    });
  }
  return outputs.some((output) => requiredTokens.every((token) => output.split('_').includes(token)));
}

function outputRequirementCovered(required: string, block: BlockShape): boolean {
  // Compound dimension outputs are contracts, not loose keyword hints.
  // `beverage_product_types` (a count) must not satisfy `product_type`, and a
  // block that merely touches products must not satisfy `product_name`.
  // Requiring the concrete projected output here prevents a high-overlap block
  // at the wrong grain from being promoted to an exact certified answer.
  if (isStructuredDimensionOutput(required)) {
    const directDimension = required.replace(/_(?:name|title)$/, '');
    return block.outputs.includes(required)
      || (directDimension !== required && block.outputs.includes(directDimension));
  }
  if (outputCoversRequired(block.outputs, required)) return true;
  const token = canonicalToken(required);
  if (block.dimensions.includes(token)) return true;
  if (isMeasureLike(required) || block.measures.includes(token)) {
    return block.measures.includes(token) || block.textTokens.has(token) || outputHasEntity(new Set(block.outputs), token);
  }
  return false;
}

function isStructuredDimensionOutput(value: string): boolean {
  return /_(?:id|key|name|title|type|category|segment|region|country|channel|date|month|quarter|year)$/.test(value)
    && !isMeasureLike(value);
}

function outputHasEntity(outputs: Set<string>, entity: string): boolean {
  for (const output of outputs) {
    if (output === entity || output.split('_').includes(entity)) return true;
  }
  return false;
}

function extractSqlOutputs(sql: string): string[] {
  const shape = extractSimpleSelectShape(sql);
  if (!shape) return [];
  return shape.selectExpressions
    .map(selectExpressionOutputName)
    .filter((value): value is string => Boolean(value));
}

function outputContractColumns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [
      ...stringArray(value),
      ...arrayObjectNames(value),
    ];
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...stringArray(record.columns),
    ...stringArray(record.outputs),
    ...arrayObjectNames(record.columns),
    ...arrayObjectNames(record.outputs),
  ];
}

function filterBindingNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    return [stringValue(record.filter), stringValue(record.name), stringValue(record.binding)].filter((v): v is string => Boolean(v));
  });
}

function arrayObjectNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    return [stringValue(record.name), stringValue(record.field), stringValue(record.column)].filter((v): v is string => Boolean(v));
  });
}

function parseSqlLimit(sql: string): number | undefined {
  const match = sql.match(/\blimit\s+(\d{1,6})\b/i);
  return match ? Number(match[1]) : undefined;
}

function isMetadataObject(value: MetadataObject | KGNode): value is MetadataObject {
  return 'objectKey' in value && 'objectType' in value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return [stringValue(record.name), stringValue(record.field), stringValue(record.column)].filter((v): v is string => Boolean(v));
    }
    return [];
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isDimensionLike(value: string): boolean {
  return /\b(account|category|channel|cohort|country|customer|date|department|geo|hour|item|location|market|member|month|order|period|person|player|product|quarter|region|segment|sku|store|team|territory|type|user|vendor|week|year)\b/.test(value);
}

function isMeasureLike(value: string): boolean {
  return /\b(amount|arr|average|avg|balance|booking|churn|conversion|cost|count|duration|expense|growth|kpi|margin|metric|mrr|number|order|point|profit|quantity|rate|revenue|sale|score|spend|stat|total|usage|value|volume)\b/.test(value);
}

function tokensFromValue(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== 'id')
    .map((token) => (token.endsWith('id') && token.length > 3 ? token.slice(0, -2) : token))
    .map(singularize);
}

function canonicalColumn(value: string): string {
  return tokensFromValue(value).join('_');
}

function canonicalToken(value: string): string {
  const tokens = tokensFromValue(value);
  if (tokens.length === 0) return '';
  if (tokens.includes('product')) return 'product';
  if (tokens.includes('category')) return 'category';
  if (tokens.includes('customer') || tokens.includes('client')) return 'customer';
  if (tokens.includes('account')) return 'account';
  if (tokens.includes('user') || tokens.includes('member')) return 'user';
  if (tokens.includes('region') || tokens.includes('geo') || tokens.includes('market') || tokens.includes('territory')) return 'region';
  if (tokens.includes('segment') || tokens.includes('cohort')) return 'segment';
  if (tokens.includes('channel')) return 'channel';
  if (tokens.includes('order')) return 'order';
  if (tokens.includes('revenue') || tokens.includes('sale') || tokens.includes('spend') || tokens.includes('amount')) return 'revenue';
  if (tokens.includes('score') || tokens.includes('scoring') || tokens.includes('scorer') || tokens.includes('point')) return 'score';
  if (tokens.includes('count') || tokens.includes('number') || tokens.includes('quantity') || tokens.includes('volume')) return 'count';
  if (tokens.includes('week')) return 'week';
  if (tokens.includes('month')) return 'month';
  if (tokens.includes('quarter')) return 'quarter';
  if (tokens.includes('year') || tokens.includes('season')) return 'year';
  if (tokens.includes('day') || tokens.includes('date')) return 'day';
  return tokens[0] ?? '';
}

function singularize(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
  return token;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
