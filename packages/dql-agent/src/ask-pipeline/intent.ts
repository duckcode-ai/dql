import { createHash } from 'node:crypto';

/**
 * THE ONE INTERPRETATION CONTRACT.
 *
 * An `AnalyticalIntentV1` is what a question MEANS, resolved once by the
 * model against the snapshot vocabulary and then proven by the host. After
 * it exists no code reads the question string again: certified entailment,
 * semantic compilation, relational composition, follow-up edits, persistence
 * and the "I read this as…" line all consume this object.
 *
 * Every `ref` is an exact vocabulary id (`metric:order_item.drink_revenue`,
 * `dimension:customers.customer_name`, `entity:customers.customer`,
 * `block:commerce.top_beverage_customers`, `column:dev.orders.order_total`).
 * The resolver may only emit refs the vocabulary index returned; anything
 * else is a validation failure with the nearest candidates attached.
 *
 * Identity rule: `groupBy` carries the GRAIN and is keyed by entities or
 * categorical dimensions; a label such as a customer's name is projected
 * through `display`, never grouped by, because two customers can share a name.
 */

export type IntentKind = 'analytics' | 'definition' | 'conversation' | 'clarification_answer';
export type IntentShape = 'ranking' | 'grouped' | 'scalar' | 'comparison' | 'lookup' | 'trend';
export type PredicateOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_true' | 'is_false';
export type ClauseSource = 'question' | 'inherited' | 'prior_result' | 'clarification';
export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface IntentPredicate {
  ref: string;
  op: PredicateOperator;
  values: Array<string | number | boolean>;
  source: ClauseSource;
}

export interface IntentMeasure {
  ref: string;
  /** Restriction that belongs to THIS measure only ("beverage revenue" → is_drink_item on this measure). */
  scope?: IntentPredicate[];
  /** Required for a `column:` ref; ignored for metrics, measures and blocks. */
  aggregation?: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'median';
  alias?: string;
}

export interface IntentGroupBy {
  ref: string;
  role: 'key' | 'categorical' | 'time';
  grain?: Grain;
}

export interface IntentTime {
  ref?: string;
  grain?: Grain;
  /** Half-open ISO date window. */
  window?: { start: string; end: string; expression?: string };
}

export interface IntentUnresolved {
  clause: string;
  options: string[];
  material: boolean;
  question?: string;
}

export interface AnalyticalIntentV1 {
  version: 1;
  kind: IntentKind;
  /** The question read back in one sentence, shown to the user. */
  reading: string;
  measures: IntentMeasure[];
  groupBy: IntentGroupBy[];
  display: string[];
  filters: IntentPredicate[];
  ordering?: { ref: string; direction: 'asc' | 'desc' };
  limit?: number;
  time?: IntentTime;
  expectedShape: IntentShape;
  unresolved: IntentUnresolved[];
  /** Every clause says where it came from; an inherited clause that vanishes must be listed as removed. */
  provenance: Record<string, string>;
  /** For a conversational/definition turn: the reply the model proposes. */
  reply?: string;
}

/** The JSON schema handed to providers that can constrain output, and used to validate every reply. */
export const ANALYTICAL_INTENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'kind', 'reading', 'measures', 'groupBy', 'display', 'filters', 'expectedShape', 'unresolved', 'provenance'],
  properties: {
    version: { type: 'integer', enum: [1] },
    kind: { type: 'string', enum: ['analytics', 'definition', 'conversation', 'clarification_answer'] },
    reading: { type: 'string', maxLength: 400 },
    measures: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false, required: ['ref'],
        properties: {
          ref: { type: 'string' },
          aggregation: { type: 'string', enum: ['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'median'] },
          alias: { type: 'string', maxLength: 80 },
          scope: { type: 'array', maxItems: 4, items: { $ref: '#/$defs/predicate' } },
        },
      },
    },
    groupBy: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object', additionalProperties: false, required: ['ref', 'role'],
        properties: {
          ref: { type: 'string' },
          role: { type: 'string', enum: ['key', 'categorical', 'time'] },
          grain: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
        },
      },
    },
    display: { type: 'array', maxItems: 6, items: { type: 'string' } },
    filters: { type: 'array', maxItems: 8, items: { $ref: '#/$defs/predicate' } },
    ordering: {
      type: 'object', additionalProperties: false, required: ['ref', 'direction'],
      properties: { ref: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
    },
    limit: { type: 'integer', minimum: 1, maximum: 10000 },
    time: {
      type: 'object', additionalProperties: false,
      properties: {
        ref: { type: 'string' },
        grain: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
        window: {
          type: 'object', additionalProperties: false, required: ['start', 'end'],
          properties: { start: { type: 'string' }, end: { type: 'string' }, expression: { type: 'string' } },
        },
      },
    },
    expectedShape: { type: 'string', enum: ['ranking', 'grouped', 'scalar', 'comparison', 'lookup', 'trend'] },
    unresolved: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object', additionalProperties: false, required: ['clause', 'options', 'material'],
        properties: {
          clause: { type: 'string', maxLength: 200 },
          options: { type: 'array', maxItems: 6, items: { type: 'string' } },
          material: { type: 'boolean' },
          question: { type: 'string', maxLength: 300 },
        },
      },
    },
    provenance: { type: 'object', additionalProperties: { type: 'string', maxLength: 200 } },
    reply: { type: 'string', maxLength: 2000 },
  },
  $defs: {
    predicate: {
      type: 'object', additionalProperties: false, required: ['ref', 'op', 'values', 'source'],
      properties: {
        ref: { type: 'string' },
        op: { type: 'string', enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_true', 'is_false'] },
        values: { type: 'array', maxItems: 24, items: { type: ['string', 'number', 'boolean'] } },
        source: { type: 'string', enum: ['question', 'inherited', 'prior_result', 'clarification'] },
      },
    },
  },
};

export interface IntentShapeError { path: string; message: string }

const OPERATORS = new Set<PredicateOperator>(['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_true', 'is_false']);
const SOURCES = new Set<ClauseSource>(['question', 'inherited', 'prior_result', 'clarification']);
const SHAPES = new Set<IntentShape>(['ranking', 'grouped', 'scalar', 'comparison', 'lookup', 'trend']);
const KINDS = new Set<IntentKind>(['analytics', 'definition', 'conversation', 'clarification_answer']);
const GRAINS = new Set<Grain>(['day', 'week', 'month', 'quarter', 'year']);
const AGGREGATIONS = new Set(['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'median']);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parsePredicate(value: unknown, path: string, errors: IntentShapeError[]): IntentPredicate | undefined {
  if (!isRecord(value)) { errors.push({ path, message: 'predicate must be an object' }); return undefined; }
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  if (!ref) errors.push({ path: `${path}.ref`, message: 'ref is required' });
  const op = typeof value.op === 'string' && OPERATORS.has(value.op as PredicateOperator) ? value.op as PredicateOperator : undefined;
  if (!op) errors.push({ path: `${path}.op`, message: `op must be one of ${[...OPERATORS].join(', ')}` });
  const rawValues = Array.isArray(value.values) ? value.values : value.value !== undefined && value.value !== null ? [value.value] : [];
  const values = rawValues.filter((item): item is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof item)).slice(0, 24);
  if (op && !['is_true', 'is_false'].includes(op) && values.length === 0) errors.push({ path: `${path}.values`, message: 'values must not be empty' });
  const source = typeof value.source === 'string' && SOURCES.has(value.source as ClauseSource) ? value.source as ClauseSource : 'question';
  return ref && op ? { ref, op, values, source } : undefined;
}

/**
 * Parse an untrusted reply into a typed intent, or explain why not. Shape
 * only: vocabulary existence is the index's job (`validateIntentRefs`).
 */
export function parseIntent(raw: unknown): { intent?: AnalyticalIntentV1; errors: IntentShapeError[] } {
  const errors: IntentShapeError[] = [];
  if (!isRecord(raw)) return { errors: [{ path: '', message: 'the reply is not a JSON object' }] };
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind as IntentKind) ? raw.kind as IntentKind : undefined;
  if (!kind) errors.push({ path: 'kind', message: `kind must be one of ${[...KINDS].join(', ')}` });
  const reading = typeof raw.reading === 'string' ? raw.reading.trim().slice(0, 400) : '';
  const measures: IntentMeasure[] = [];
  for (const [index, item] of (Array.isArray(raw.measures) ? raw.measures : []).slice(0, 8).entries()) {
    if (!isRecord(item) || typeof item.ref !== 'string' || !item.ref.trim()) { errors.push({ path: `measures[${index}]`, message: 'measure needs a ref' }); continue; }
    const aggregation = typeof item.aggregation === 'string' && AGGREGATIONS.has(item.aggregation) ? item.aggregation as IntentMeasure['aggregation'] : undefined;
    const scope = Array.isArray(item.scope)
      ? item.scope.slice(0, 4).map((predicate, at) => parsePredicate(predicate, `measures[${index}].scope[${at}]`, errors)).filter((p): p is IntentPredicate => Boolean(p))
      : undefined;
    measures.push({ ref: item.ref.trim(), ...(aggregation ? { aggregation } : {}), ...(scope?.length ? { scope } : {}), ...(typeof item.alias === 'string' && item.alias.trim() ? { alias: item.alias.trim().slice(0, 80) } : {}) });
  }
  const groupBy: IntentGroupBy[] = [];
  for (const [index, item] of (Array.isArray(raw.groupBy) ? raw.groupBy : []).slice(0, 6).entries()) {
    if (!isRecord(item) || typeof item.ref !== 'string' || !item.ref.trim()) { errors.push({ path: `groupBy[${index}]`, message: 'groupBy needs a ref' }); continue; }
    const role = item.role === 'key' || item.role === 'categorical' || item.role === 'time' ? item.role : undefined;
    if (!role) { errors.push({ path: `groupBy[${index}].role`, message: 'role must be key, categorical or time' }); continue; }
    const grain = typeof item.grain === 'string' && GRAINS.has(item.grain as Grain) ? item.grain as Grain : undefined;
    groupBy.push({ ref: item.ref.trim(), role, ...(grain ? { grain } : {}) });
  }
  const display = (Array.isArray(raw.display) ? raw.display : []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 6);
  const filters = (Array.isArray(raw.filters) ? raw.filters : []).slice(0, 8)
    .map((item, index) => parsePredicate(item, `filters[${index}]`, errors)).filter((p): p is IntentPredicate => Boolean(p));
  let ordering: AnalyticalIntentV1['ordering'];
  if (isRecord(raw.ordering) && typeof raw.ordering.ref === 'string' && (raw.ordering.direction === 'asc' || raw.ordering.direction === 'desc')) {
    ordering = { ref: raw.ordering.ref.trim(), direction: raw.ordering.direction };
  } else if (raw.ordering !== undefined && raw.ordering !== null) errors.push({ path: 'ordering', message: 'ordering needs ref and direction' });
  const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) && raw.limit >= 1 ? Math.min(10000, Math.trunc(raw.limit)) : undefined;
  let time: IntentTime | undefined;
  if (isRecord(raw.time)) {
    const ref = typeof raw.time.ref === 'string' && raw.time.ref.trim() ? raw.time.ref.trim() : undefined;
    const grain = typeof raw.time.grain === 'string' && GRAINS.has(raw.time.grain as Grain) ? raw.time.grain as Grain : undefined;
    const window = isRecord(raw.time.window) && typeof raw.time.window.start === 'string' && typeof raw.time.window.end === 'string'
      ? { start: raw.time.window.start, end: raw.time.window.end, ...(typeof raw.time.window.expression === 'string' ? { expression: raw.time.window.expression } : {}) }
      : undefined;
    if (ref || grain || window) time = { ...(ref ? { ref } : {}), ...(grain ? { grain } : {}), ...(window ? { window } : {}) };
  }
  // The shape is advisory; an unknown word is read from the structure rather than refused.
  const expectedShape = typeof raw.expectedShape === 'string' && SHAPES.has(raw.expectedShape as IntentShape)
    ? raw.expectedShape as IntentShape
    : limit && ordering ? 'ranking' : groupBy.length ? 'grouped' : measures.length > 1 ? 'comparison' : 'scalar';
  const unresolved: IntentUnresolved[] = (Array.isArray(raw.unresolved) ? raw.unresolved : []).slice(0, 4).flatMap((item) => {
    if (!isRecord(item) || typeof item.clause !== 'string') return [];
    return [{
      clause: item.clause.slice(0, 200),
      options: (Array.isArray(item.options) ? item.options : []).filter((option): option is string => typeof option === 'string').slice(0, 6),
      material: item.material === true,
      ...(typeof item.question === 'string' ? { question: item.question.slice(0, 300) } : {}),
    }];
  });
  const provenance: Record<string, string> = {};
  if (isRecord(raw.provenance)) {
    for (const [key, value] of Object.entries(raw.provenance)) if (typeof value === 'string') provenance[key] = value.slice(0, 200);
  }
  const reply = typeof raw.reply === 'string' ? raw.reply.trim().slice(0, 2000) : undefined;
  if (kind === 'analytics' && measures.length === 0 && groupBy.length === 0 && display.length === 0 && unresolved.length === 0) {
    errors.push({ path: 'measures', message: 'an analytics intent names at least one measure, or lists what is unresolved' });
  }
  if (errors.length > 0 || !kind) return { errors };
  return {
    errors,
    intent: {
      version: 1, kind, reading, measures, groupBy, display, filters,
      ...(ordering ? { ordering } : {}), ...(limit ? { limit } : {}), ...(time ? { time } : {}),
      expectedShape, unresolved, provenance, ...(reply ? { reply } : {}),
    },
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

/** Identity of the whole intent, prose included. */
export function intentFingerprint(intent: AnalyticalIntentV1): string {
  return `sha256:${createHash('sha256').update(stable(intent)).digest('hex')}`;
}

/** Identity of what would EXECUTE: refs, predicates, ordering, limit, time — never the prose or provenance. */
export function intentExecutionFingerprint(intent: AnalyticalIntentV1): string {
  const executable = {
    measures: intent.measures.map((measure) => ({ ref: measure.ref, aggregation: measure.aggregation ?? null, scope: (measure.scope ?? []).map((p) => ({ ref: p.ref, op: p.op, values: p.values })) })),
    groupBy: intent.groupBy.map((group) => ({ ref: group.ref, role: group.role, grain: group.grain ?? null })),
    display: [...intent.display].sort(),
    filters: intent.filters.map((p) => ({ ref: p.ref, op: p.op, values: [...p.values].map(String).sort() })),
    ordering: intent.ordering ?? null,
    limit: intent.limit ?? null,
    time: intent.time ?? null,
  };
  return `sha256:${createHash('sha256').update(stable(executable)).digest('hex')}`;
}

/** Every ref the intent names, deduplicated, in a stable order. */
export function intentRefs(intent: AnalyticalIntentV1): string[] {
  const refs = new Set<string>();
  for (const measure of intent.measures) { refs.add(measure.ref); for (const p of measure.scope ?? []) refs.add(p.ref); }
  for (const group of intent.groupBy) refs.add(group.ref);
  for (const ref of intent.display) refs.add(ref);
  for (const p of intent.filters) refs.add(p.ref);
  if (intent.ordering && !intent.ordering.ref.startsWith('measure:')) refs.add(intent.ordering.ref);
  if (intent.time?.ref) refs.add(intent.time.ref);
  return [...refs].sort();
}

/**
 * A follow-up may not silently lose a clause. Given the executed prior intent
 * and the proposed next one, return the prior refs that are neither kept nor
 * accounted for as removed in `provenance` (`removed:<why>`).
 */
export function unaccountedInheritedRefs(prior: AnalyticalIntentV1 | undefined, next: AnalyticalIntentV1): string[] {
  if (!prior) return [];
  const kept = new Set(intentRefs(next));
  const accounted = new Set(Object.entries(next.provenance).filter(([, value]) => value.startsWith('removed')).map(([key]) => key));
  return intentRefs(prior).filter((ref) => !kept.has(ref) && !accounted.has(ref));
}

/** A one-line human reading assembled from the structure, used when the model's `reading` is empty. */
export function describeIntent(intent: AnalyticalIntentV1, label: (ref: string) => string = (ref) => ref): string {
  if (intent.kind !== 'analytics') return intent.reading || intent.kind;
  const measures = intent.measures.map((measure) => {
    const scope = (measure.scope ?? []).map((p) => `${label(p.ref)} ${p.op} ${p.values.join('/')}`).join(', ');
    return scope ? `${label(measure.ref)} where ${scope}` : label(measure.ref);
  }).join(' and ');
  const by = intent.groupBy.length ? ` by ${intent.groupBy.map((group) => `${label(group.ref)}${group.grain ? ` (${group.grain})` : ''}`).join(', ')}` : '';
  const where = intent.filters.length ? ` for ${intent.filters.map((p) => `${label(p.ref)} ${p.op} ${p.values.join('/')}`).join(' and ')}` : '';
  const order = intent.ordering ? `, ${intent.ordering.direction === 'desc' ? 'highest' : 'lowest'} first` : '';
  const limit = intent.limit ? `, top ${intent.limit}` : '';
  const shown = intent.display.length ? `, showing ${intent.display.map(label).join(', ')}` : '';
  return `${measures}${by}${where}${order}${limit}${shown}`.trim();
}
