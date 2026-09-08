import type { AnalyticalIntentV1, IntentPredicate } from '../intent.js';
import type { VocabularyEntry, VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal, SemanticCompileRequest } from './types.js';

/**
 * SEMANTIC: bind the intent to the governed metric layer and compile.
 *
 * Every measure must be a metric or measure; every grouping, display, and
 * filter ref must be a semantic dimension or entity. The compiler is asked
 * with model-scoped names (`customers.customer_name`), the engine's own
 * error text comes back verbatim, and a per-measure scope the metric does
 * not already embody is refused here (the relational tier can express it).
 */

// Long-form operator names: the native composer accepts only these, and the
// MetricFlow and dbt Cloud adapters accept both spellings.
const OPERATORS: Record<IntentPredicate['op'], string> = {
  eq: 'equals', neq: 'not_equals', in: 'in', not_in: 'not_in', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', contains: 'contains', is_true: 'equals', is_false: 'equals',
};

function semanticName(entry: VocabularyEntry): string {
  if (entry.kind === 'metric' || entry.kind === 'measure') return entry.sourceId ?? entry.name;
  return entry.sourceId ?? (entry.model ? `${entry.model}.${entry.name}` : entry.name);
}

function predicateToFilter(predicate: IntentPredicate, entry: VocabularyEntry): SemanticCompileRequest['filters'] extends Array<infer T> | undefined ? T : never {
  const values = predicate.op === 'is_true' ? ['true'] : predicate.op === 'is_false' ? ['false'] : predicate.values.map(String);
  return { dimension: semanticName(entry), operator: OPERATORS[predicate.op], values };
}

export function bindSemanticRequest(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, engine?: PrepareDeps['engine']): { request?: SemanticCompileRequest; refusal?: PreparedRefusal; groupedByLabel?: boolean; derived?: NonNullable<PreparedCandidate['derived']> } {
  const entry = (ref: string) => vocabulary.get(ref);
  if (intent.population === 'all') {
    return { refusal: { tier: 'semantic', code: 'not_semantic', message: 'the semantic layer returns the members it matched; including every member of the entity is composed relationally', repairable: false } };
  }
  const metrics: string[] = [];
  const derived: NonNullable<PreparedCandidate['derived']> = [];
  const asked = new Set<string>();
  for (const measure of intent.measures) {
    if (measure.derived) {
      if (measure.derived.denominatorScope === 'overall') return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${measure.alias ?? measure.ref} divides by the whole period; the semantic tier computes ratios at one grouping only`, repairable: false } };
      // A ratio is two governed metrics compiled together and divided after execution.
      const parts = [measure.derived.numerator, measure.derived.denominator].map((ref) => entry(ref));
      if (parts.some((part) => !part || (part.kind !== 'metric' && part.kind !== 'measure'))) {
        return { refusal: { tier: 'semantic', code: 'not_semantic', message: `the ratio ${measure.ref} needs two semantic metrics`, repairable: false } };
      }
      if (measure.scope?.length) {
        return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `${measure.ref} carries a restriction the semantic layer cannot apply to one measure`, repairable: false } };
      }
      if (intent.ordering && (intent.ordering.ref === measure.ref || intent.ordering.ref === `measure:${intent.measures.indexOf(measure)}`)) {
        return { refusal: { tier: 'semantic', code: 'not_semantic', message: `ordering by the ratio ${measure.ref} is composed relationally`, repairable: false } };
      }
      const [numerator, denominator] = parts.map((part) => semanticName(part!)) as [string, string];
      for (const name of [numerator, denominator]) if (!metrics.includes(name)) metrics.push(name);
      derived.push({ alias: measure.alias ?? measure.ref.replace(/^ratio:/, '').replace(/[^A-Za-z0-9_]+/g, '_'), numerator, denominator });
      continue;
    }
    const found = entry(measure.ref);
    if (!found || (found.kind !== 'metric' && found.kind !== 'measure')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${measure.ref} is not a semantic metric`, repairable: false } };
    }
    if (measure.scope?.length) {
      return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `${measure.ref} carries a restriction (${measure.scope.map((p) => `${p.ref} ${p.op} ${p.values.join('/')}`).join(', ')}) that the semantic layer cannot apply to one measure`, repairable: false } };
    }
    const name = semanticName(found);
    asked.add(name);
    if (!metrics.includes(name)) metrics.push(name);
  }
  for (const item of derived) if (asked.has(item.numerator) || asked.has(item.denominator)) item.keepInputs = true;
  // MetricFlow and dbt Cloud address a metric's own aggregation time as
  // `metric_time`; offset and cumulative metrics resolve only on it. A time
  // grouping, ordering or window on a used measure's aggregation time is
  // therefore `metric_time` on those engines; the native composer knows
  // only concrete dimensions.
  const metricTime = engine && engine !== 'native';
  const aggregationTimes = new Set(intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]).map((ref) => entry(ref)?.timeRef).filter((ref): ref is string => Boolean(ref)));
  const timeName = (ref: string, found: VocabularyEntry) => (metricTime && aggregationTimes.has(ref) ? 'metric_time' : semanticName(found));
  const dimensions: string[] = [];
  let timeDimension: SemanticCompileRequest['timeDimension'];
  for (const group of intent.groupBy) {
    const found = entry(group.ref);
    if (!found || (found.kind !== 'dimension' && found.kind !== 'entity')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${group.ref} is not a semantic dimension or entity`, repairable: false } };
    }
    if (group.role === 'time' && group.grain) timeDimension = { name: timeName(group.ref, found), granularity: group.grain };
    else dimensions.push(semanticName(found));
  }
  for (const ref of intent.display) {
    const found = entry(ref);
    if (!found || (found.kind !== 'dimension' && found.kind !== 'entity')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${ref} is not a semantic dimension`, repairable: false } };
    }
    const name = semanticName(found);
    if (!dimensions.includes(name)) dimensions.push(name);
  }
  const filters: NonNullable<SemanticCompileRequest['filters']> = [];
  for (const predicate of intent.filters) {
    const found = entry(predicate.ref);
    if (!found || (found.kind !== 'dimension' && found.kind !== 'entity')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${predicate.ref} is not a semantic dimension`, repairable: false } };
    }
    filters.push(predicateToFilter(predicate, found));
  }
  if (intent.time?.window) {
    const axis = intent.time.ref ? entry(intent.time.ref) : undefined;
    // A window the host bound to the measures' own time role is each
    // metric's aggregation time. MetricFlow and dbt Cloud express that as
    // `metric_time`, which lets metrics on different models share one
    // window; the native composer knows only concrete dimensions.
    let name = axis ? semanticName(axis) : timeDimension?.name;
    const hostChosen = Boolean(intent.time.ref && (intent.provenance[intent.time.ref] ?? '').startsWith('host:'));
    if (axis && metricTime && (hostChosen || aggregationTimes.has(intent.time.ref!))) name = 'metric_time';
    if (!name) return { refusal: { tier: 'semantic', code: 'not_semantic', message: 'a time window needs a semantic time dimension', repairable: true } };
    filters.push({ dimension: name, operator: 'gte', values: [intent.time.window.start.slice(0, 10)] }, { dimension: name, operator: 'lt', values: [intent.time.window.end.slice(0, 10)] });
  }
  if (intent.time?.ref && intent.time.grain && !timeDimension) {
    const axis = entry(intent.time.ref);
    if (axis) timeDimension = { name: timeName(intent.time.ref, axis), granularity: intent.time.grain };
  }
  let orderBy: SemanticCompileRequest['orderBy'];
  if (intent.ordering) {
    const orderEntry = entry(intent.ordering.ref);
    const name = intent.ordering.ref.startsWith('measure:')
      ? metrics[Number(intent.ordering.ref.slice('measure:'.length)) || 0]
      : orderEntry ? timeName(intent.ordering.ref, orderEntry) : semanticName({ kind: 'dimension', name: intent.ordering.ref, ref: intent.ordering.ref, aliases: [], roles: [] });
    if (name) orderBy = [{ name, direction: intent.ordering.direction }];
  }
  return {
    request: {
      metrics, dimensions,
      ...(filters.length ? { filters } : {}),
      ...(timeDimension ? { timeDimension } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(intent.limit ? { limit: intent.limit } : {}),
    },
    ...(derived.length ? { derived } : {}),
  };
}

export async function prepareSemantic(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): Promise<{ candidates: PreparedCandidate[]; refusals: PreparedRefusal[] }> {
  if (!deps.compileSemantic) return { candidates: [], refusals: [{ tier: 'semantic', code: 'semantic_runtime_unavailable', message: 'no semantic layer is loaded for this project', repairable: false }] };
  const bound = bindSemanticRequest(intent, vocabulary, deps.engine);
  if (!bound.request) return { candidates: [], refusals: [bound.refusal!] };
  try {
    const compiled = await deps.compileSemantic(bound.request);
    return {
      candidates: [{
        tier: 'semantic', trust: 'governed', sql: compiled.sql, engine: compiled.engine,
        ...(compiled.columns ? { columns: compiled.columns } : {}),
        ...(compiled.fanoutProbeSql ? { fanoutProbeSql: compiled.fanoutProbeSql } : {}),
        ...(compiled.artifact !== undefined ? { artifact: compiled.artifact } : {}),
        ...(bound.derived ? { derived: bound.derived } : {}),
        compileRequest: bound.request,
        proof: [
          `compiled on the ${compiled.engine} semantic engine from metrics ${bound.request.metrics.join(', ')}${bound.request.dimensions.length ? ` by ${bound.request.dimensions.join(', ')}` : ''}${compiled.strategy ? ` (${compiled.strategy})` : ''}`,
          ...(bound.derived ?? []).map((item) => `${item.alias} = ${item.numerator} / ${item.denominator}, computed from the executed metrics (null when the denominator is 0)`),
        ],
      }],
      refusals: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidates: [],
      refusals: [{ tier: 'semantic', code: 'semantic_compile_failed', message, repairable: /not found|unknown|no such|could not resolve|ambiguous|cannot be grouped|not a dimension/i.test(message), detail: bound.request }],
    };
  }
}
