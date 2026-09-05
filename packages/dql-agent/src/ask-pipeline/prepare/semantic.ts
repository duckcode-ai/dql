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

const OPERATORS: Record<IntentPredicate['op'], string> = {
  eq: '=', neq: '!=', in: 'in', not_in: 'not in', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'like', is_true: '=', is_false: '=',
};

function semanticName(entry: VocabularyEntry): string {
  if (entry.kind === 'metric' || entry.kind === 'measure') return entry.sourceId ?? entry.name;
  return entry.sourceId ?? (entry.model ? `${entry.model}.${entry.name}` : entry.name);
}

function predicateToFilter(predicate: IntentPredicate, entry: VocabularyEntry): SemanticCompileRequest['filters'] extends Array<infer T> | undefined ? T : never {
  const values = predicate.op === 'is_true' ? ['true'] : predicate.op === 'is_false' ? ['false'] : predicate.values.map(String);
  return { dimension: semanticName(entry), operator: OPERATORS[predicate.op], values };
}

export function bindSemanticRequest(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): { request?: SemanticCompileRequest; refusal?: PreparedRefusal; groupedByLabel?: boolean } {
  const entry = (ref: string) => vocabulary.get(ref);
  const metrics: string[] = [];
  for (const measure of intent.measures) {
    const found = entry(measure.ref);
    if (!found || (found.kind !== 'metric' && found.kind !== 'measure')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${measure.ref} is not a semantic metric`, repairable: false } };
    }
    if (measure.scope?.length) {
      return { refusal: { tier: 'semantic', code: 'measure_scope_not_expressible', message: `${measure.ref} carries a restriction (${measure.scope.map((p) => `${p.ref} ${p.op} ${p.values.join('/')}`).join(', ')}) that the semantic layer cannot apply to one measure`, repairable: false } };
    }
    metrics.push(semanticName(found));
  }
  const dimensions: string[] = [];
  let timeDimension: SemanticCompileRequest['timeDimension'];
  for (const group of intent.groupBy) {
    const found = entry(group.ref);
    if (!found || (found.kind !== 'dimension' && found.kind !== 'entity')) {
      return { refusal: { tier: 'semantic', code: 'not_semantic', message: `${group.ref} is not a semantic dimension or entity`, repairable: false } };
    }
    if (group.role === 'time' && group.grain) timeDimension = { name: semanticName(found), granularity: group.grain };
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
    const name = axis ? semanticName(axis) : timeDimension?.name;
    if (!name) return { refusal: { tier: 'semantic', code: 'not_semantic', message: 'a time window needs a semantic time dimension', repairable: true } };
    filters.push({ dimension: name, operator: '>=', values: [intent.time.window.start.slice(0, 10)] }, { dimension: name, operator: '<', values: [intent.time.window.end.slice(0, 10)] });
  }
  if (intent.time?.ref && intent.time.grain && !timeDimension) {
    const axis = entry(intent.time.ref);
    if (axis) timeDimension = { name: semanticName(axis), granularity: intent.time.grain };
  }
  let orderBy: SemanticCompileRequest['orderBy'];
  if (intent.ordering) {
    const name = intent.ordering.ref.startsWith('measure:') ? metrics[Number(intent.ordering.ref.slice('measure:'.length)) || 0] : semanticName(entry(intent.ordering.ref) ?? { kind: 'dimension', name: intent.ordering.ref, ref: intent.ordering.ref, aliases: [], roles: [] });
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
  };
}

export async function prepareSemantic(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): Promise<{ candidates: PreparedCandidate[]; refusals: PreparedRefusal[] }> {
  if (!deps.compileSemantic) return { candidates: [], refusals: [{ tier: 'semantic', code: 'semantic_runtime_unavailable', message: 'no semantic layer is loaded for this project', repairable: false }] };
  const bound = bindSemanticRequest(intent, vocabulary);
  if (!bound.request) return { candidates: [], refusals: [bound.refusal!] };
  try {
    const compiled = await deps.compileSemantic(bound.request);
    return {
      candidates: [{
        tier: 'semantic', trust: 'governed', sql: compiled.sql, engine: compiled.engine,
        ...(compiled.columns ? { columns: compiled.columns } : {}),
        ...(compiled.fanoutProbeSql ? { fanoutProbeSql: compiled.fanoutProbeSql } : {}),
        ...(compiled.artifact !== undefined ? { artifact: compiled.artifact } : {}),
        compileRequest: bound.request,
        proof: [`compiled on the ${compiled.engine} semantic engine from metrics ${bound.request.metrics.join(', ')}${bound.request.dimensions.length ? ` by ${bound.request.dimensions.join(', ')}` : ''}${compiled.strategy ? ` (${compiled.strategy})` : ''}`],
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
