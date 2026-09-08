import type { AgentMessage, AgentProvider, ProviderRunOptions } from '../providers/types.js';
import { generateStructured } from '../providers/structured-output.js';
import {
  ANALYTICAL_INTENT_JSON_SCHEMA,
  describeIntent,
  intentRefs,
  parseIntent,
  unaccountedInheritedRefs,
  type AnalyticalIntentV1,
  type IntentPredicate,
  type IntentUnresolved,
} from './intent.js';
import { normalizeVocabularyText, trigramSimilarity, type VocabularyEntry, type VocabularyIndex, type VocabularyKind } from './vocabulary.js';

/**
 * THE MODEL'S ONE JOB: say what the question means, in the vocabulary.
 *
 * One structured call. The reply is parsed, every ref is checked against the
 * vocabulary index (and canonicalised when the model wrote a name instead of
 * a ref), roles are checked (a measure ref must be a measure, a group-by
 * must be a key or dimension, a display must be a label), and an inherited
 * clause that vanished must be accounted for. A single bounded corrective
 * call carries the exact problems and the nearest authorized refs back to
 * the model. Every physical call, corrective ones included, is reported
 * through `onDispatch` so the host's one ledger counts it.
 */

export interface ResolveIntentInput {
  question: string;
  vocabulary: VocabularyIndex;
  provider: AgentProvider;
  /** The executed intent of the previous turn, when this turn continues it. */
  prior?: AnalyticalIntentV1;
  priorAnswerSummary?: string;
  /** Host: skip the full-question clause check (research branches phrase hypotheses, not questions). */
  clauseCoverage?: boolean;
  /** Milliseconds the run can still spend; a timed-out interpreter dispatch is retried once when this allows another. */
  budgetMs?: number;
  /** The obligations of the original question, when this resolution is a repair of an earlier reading. */
  ledger?: IntentLedger;
  /** Round number for ledger entries (0 = the first resolution, 1 = the pipeline's repair). */
  ledgerRound?: number;
  /** Optional domain briefing / project guidance rendered above the cards. */
  guidance?: string;
  /** Character budget for the vocabulary cards. */
  cardBudget?: number;
  maxAttempts?: number;
  providerOptions?: ProviderRunOptions;
  onDispatch?: (event: { attempt: number; purpose: 'resolve' | 'correct'; raw: string; ms: number; problems?: IntentProblem[] }) => void;
  now?: () => number;
}

export interface IntentProblem { path: string; message: string; suggestions?: string[] }

/**
 * What the ORIGINAL question obliged, written down from the first reading and
 * immutable afterwards. A later reading (a schema correction, a guard's
 * re-ask, the pipeline's repair after a refused preparation) may discharge an
 * obligation by binding refs that account for it, or keep it listed as
 * unresolved; it may never silently drop it. "Closest available" is not a
 * discharge: a block stands in for a measure only through its own outputs.
 */
export interface IntentLedger {
  /** Material clauses the first reading declared it could not resolve. */
  clauses: Array<{ clause: string; kind?: IntentUnresolved['kind']; question?: string; words: string[] }>;
  /** The first reading's time grouping (a monthly trend is never a ranking). */
  timeGrain?: { ref: string; grain: string };
  /** The first reading's measures by ref (a block may replace one only through its outputs). */
  measures: string[];
  /** Question words no ref of the first reading accounted for (informational; the coverage guards use them). */
  unaccounted: string[];
}

export interface LedgerEntry { clause: string; kind?: string; disposition: 'discharged' | 'unresolved' | 'dropped' | 'restored'; by?: string; round: number }

export type IntentResolution =
  | { status: 'resolved'; intent: AnalyticalIntentV1; attempts: number; problems: IntentProblem[]; ledger?: IntentLedger; ledgerEntries?: LedgerEntry[] }
  | { status: 'clarify'; intent: AnalyticalIntentV1; question: string; options: string[]; attempts: number; ledger?: IntentLedger; ledgerEntries?: LedgerEntry[] }
  | { status: 'conversation'; intent: AnalyticalIntentV1; reply: string; attempts: number }
  | { status: 'definition'; intent: AnalyticalIntentV1; reply: string; attempts: number }
  | { status: 'failed'; reason: 'provider_error' | 'unparseable' | 'invalid'; detail: string; problems: IntentProblem[]; attempts: number; code?: string };

const MEASURE_KINDS: VocabularyKind[] = ['metric', 'measure', 'column', 'block'];
const RATIO_KINDS: VocabularyKind[] = ['metric', 'measure', 'column'];
const GROUP_KINDS: VocabularyKind[] = ['dimension', 'entity', 'column'];
const DISPLAY_KINDS: VocabularyKind[] = ['dimension', 'entity', 'column'];
const FILTER_KINDS: VocabularyKind[] = ['dimension', 'entity', 'column'];

export function buildIntentSystemPrompt(input: { cards: string; guidance?: string; hasPrior: boolean; hints?: string[] }): string {
  return [
    'You are the interpreter for a governed analytics system over a dbt project. You read one question and write down exactly what it means as a JSON AnalyticalIntent. You never write SQL and never invent identifiers: every ref you use must be copied verbatim from the vocabulary below. The host proves and executes what you write.',
    '',
    'RULES',
    '1. IDENTITY IS THE KEY, THE NAME IS THE LABEL. A ranking or breakdown of customers, products, locations or any entity is grouped by that entity\'s key ref (role key) and the human label (role label, e.g. customer_name) goes in `display`. Never group by a name. A display label must belong to the SAME entity as the key (product_name for a product key), never to a finer-grained thing (a supply name beside a product key would multiply the rows).',
    '2. A QUALIFIER RESTRICTS ONLY THE MEASURE IT MODIFIES. "beverage revenue" is the drink-scoped revenue measure (or revenue with a scope predicate on THAT measure), not a global filter. "total revenue and beverage revenue" is two measures.',
    '3. A QUOTED OR PROPER-NAME LITERAL IS A FILTER VALUE on the dimension that holds such values (customer names on customer_name, product names on product_name). Keep the literal exactly as written; the host matches it case-insensitively.',
    '4. PREFER THE GOVERNED DEFINITION. If a metric already expresses the measure the question asks for, use it; only fall back to column refs with an aggregation when no metric fits. A certified block may be named as the ONLY measure ref when the question asks for exactly what the block declares (same measure, same scope, same grain, same ranking); a block-named intent carries NO groupBy, display or filters of its own because the block already fixes them. If you are not sure the block matches exactly, express the analysis with metric and dimension refs instead.',
    '5. SHAPE. "top/best/highest N" is a ranking: ordering desc on the measure and a limit (default 10 when "top" has no number). "by <thing>" is a breakdown. "how many/what is the total" with no breakdown is a scalar. "X and Y" for one subject is a comparison.',
    '5c. A RATIO OVER RAW COLUMNS. When the project has no metric for a part (a dbt project with no semantic layer), a ratio part may be a `column:` ref with its aggregation: `derived: {"kind":"ratio","numerator":"column:<relation>.<col>","numeratorAggregation":"sum","denominator":"column:<relation>.<col2>","denominatorAggregation":"count_distinct"}` (points per game = sum of points / count_distinct of game ids over the rows that count as games). Never invent a measure name.',
    '5d. A THRESHOLD ON AN AGGREGATE. "with at least 20 games", "minimum 100 attempts" is a filter on the aggregated measure, not on rows: add that measure (with an alias) and a filter `{"ref":"measure:<index of that measure>","op":"gte","values":[20]}`; it applies after aggregation.',
    '5b. A RATIO OF TWO GOVERNED MEASURES. "average order value", "revenue per order", "X per Y", "share of", "margin %" is a measure with `derived: {"kind":"ratio","numerator":<metric ref>,"denominator":<metric ref>}` and an `alias`, and no `ref` (average order value = the revenue metric / the order-count metric). A governed derived or ratio metric (its card shows `= formula` and `time <dim>`) may be used instead ONLY when it measures the same thing over the same time role as the question: a metric built from lifetime per-customer measures (lifetime spend / lifetime orders, time = the customer\'s first order date) is a cohort average, so "average order value in 2025", "by month", "last quarter" is NEVER that metric; it is the derived ratio of the period\'s revenue and orders. Use the cohort metric only when the question names the cohort itself ("customers first acquired in 2025", "customers who joined in").',
    '6. TIME. A time axis ("by month") is a groupBy with role time and a grain, using the time dimension of the SAME model as the measure (an order total is by the orders model\'s time, an order-line revenue by the order line model\'s time). A time window ("last quarter", "in 2025") is `time.window` with an ISO half-open range plus the expression. Measures under one window must share their `time` role (see the cards); when they do not, add an `unresolved` entry with material=true and the two time dimension refs as options instead of choosing.',
    '7. CLARIFY ONLY WHAT IS MATERIAL. If two vocabulary entries are both plausible and the answer would differ (for example pretax product revenue vs order total including tax when the question says only "total revenue" and the project defines both), add an `unresolved` entry with material=true, the options as refs, and a one-sentence question. But: a metric whose NAME is the word the question uses ("revenue" is metric revenue, "lifetime spend" is metric lifetime_spend) IS the meaning; clarify only when the question adds a qualifier the vocabulary distinguishes ("gross", "including tax", "order revenue"). Never clarify which of two refs to use when they identify the same entity (a key column on the measure\'s model vs the entity on its own model): pick the one on the measure\'s model. Do not clarify spelling mistakes or obvious paraphrases; resolve them. Never ask whether a dimension or entity is reachable from a measure\'s model, or which join to take: the host proves join paths and grain after you answer. A material clause is only ever a choice between two or more refs, or an empty options list for something this project does not hold.',
    '8. KIND. Greetings, thanks, and questions about what you can do are kind "conversation" with a short `reply`. "What does X mean / how is X defined" is kind "definition" with a `reply` drawn from the vocabulary descriptions. Everything that asks for numbers or rows is kind "analytics". A question about something this project does not hold at all (weather, news, a different business) is kind "analytics" with no measures and one `unresolved` entry {clause: what was asked, options: [], material: true}: never a conversational reply, never a guessed metric.',
    '8b. BUSINESS TERMS ARE THE GOVERNED DEFAULT. When a term in the vocabulary defines a word of the question ("Revenue" defined as product revenue excluding tax), the metric that term names is the meaning; do not treat the word as ambiguous. Only two competing definitions with no governing term are material.',
    '8c. DISPLAY IS THE GRAIN\'S LABEL. A display ref is the name/label of an entity in groupBy (the customer\'s name beside the customer key). Never display an attribute of a finer grain (a supply name when grouping by product): it multiplies the rows.',
    '8d. A NUMERIC COLUMN IS A MEASURE. When the question asks for a quantity that exists only as a numeric column (no metric declares it), use its column: or dimension: ref as a measure with an aggregation (sum, avg, count). Report a clause as not modeled ONLY when no entry of any kind — metric, dimension, column, block, term — matches its words.',
    '9. PROVENANCE. For every ref you use, provenance[ref] is the phrase of the question it came from ("q:<phrase>"), or "inherited" when it is carried from the previous analysis.',
    '11. POPULATION. "including X with no Y", "every store", "all customers, even those with zero orders", "show zeros" means `population: "all"`: every member of the entity in groupBy is a row (grouped by its key ref, role key) and additive measures read 0 where nothing matched. Otherwise omit `population` (only matched members are rows).',
    ...(input.hasPrior ? [
      '10. THIS IS A FOLLOW-UP. The previous executed analysis is given below. Treat the new message as an EDIT of it: keep every clause the message does not change (mark it "inherited"), add or replace what it asks for, and for any prior ref you drop write provenance[ref] = "removed:<why>". "Include X" adds a display or measure and keeps everything else, including scope, ranking and limit. A short correction that repeats a word of the previous analysis ("I need the beverage category", "no, drinks only") without a new measure or a new entity is an EDIT that keeps the previous measures, grain, ranking and limit. Only a message that names a new subject entirely ("what is Ryan Byrd\'s revenue") starts a new analysis; list the dropped refs as removed. When both readings are plausible, ask one bounded clarification instead of choosing.',
    ] : []),
    '',
    'OUTPUT: one JSON object matching this shape, nothing else. `reading` restates the question in one sentence as you understood it.',
    '{"version":1,"kind":"analytics","reading":"...","measures":[{"ref":"metric:...","scope":[{"ref":"dimension:...","op":"eq","values":["..."],"source":"question"}],"aggregation":"sum"},{"derived":{"kind":"ratio","numerator":"metric:...","denominator":"metric:..."},"alias":"..."}],"groupBy":[{"ref":"entity:...","role":"key"},{"ref":"dimension:...","role":"time","grain":"month"}],"display":["dimension:..."],"filters":[{"ref":"dimension:...","op":"eq","values":["literal"],"source":"question"}],"ordering":{"ref":"metric:...","direction":"desc"},"limit":10,"time":{"ref":"dimension:...","window":{"start":"2025-01-01","end":"2026-01-01","expression":"in 2025"}},"expectedShape":"ranking","population":"matching","unresolved":[],"provenance":{"metric:...":"q:phrase"},"reply":"only for conversation/definition"}',
    'Predicates always carry `values` as an array (one element for eq; the literal exactly as written). `scope`, `aggregation`, `derived` and `population` are optional. Omit `ordering`, `limit` and `time` when the question has none.',
    ...(input.guidance ? ['', 'PROJECT GUIDANCE', input.guidance] : []),
    ...(input.hints?.length ? ['', 'SPELLING HINTS (question words that match nothing exactly, with the nearest vocabulary; a misspelling resolves to the obvious entry)', ...input.hints.map((hint) => `- ${hint}`)] : []),
    '',
    'VOCABULARY (the only refs that exist)',
    input.cards,
  ].join('\n');
}

function renderPrior(prior: AnalyticalIntentV1, summary?: string): string {
  return [
    'PREVIOUS ANALYSIS (executed):',
    JSON.stringify({
      reading: prior.reading || describeIntent(prior),
      measures: prior.measures, groupBy: prior.groupBy, display: prior.display, filters: prior.filters,
      ordering: prior.ordering ?? null, limit: prior.limit ?? null, time: prior.time ?? null, expectedShape: prior.expectedShape,
    }),
    ...(summary ? [`Its result: ${summary}`] : []),
  ].join('\n');
}

interface Validation { intent: AnalyticalIntentV1; problems: IntentProblem[]
  /** Set when a follow-up replaced every prior measure while naming nothing new. */
  followUpReplacement?: string;
}

/**
 * Canonicalise every ref against the vocabulary, check roles, and report
 * problems with suggestions. A canonicalised ref replaces what the model
 * wrote so downstream code never sees an alias.
 */
export function validateIntentRefs(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, prior?: AnalyticalIntentV1, question?: string): Validation {
  const problems: IntentProblem[] = [];
  let followUpReplacement: string | undefined;
  const canonical = (ref: string, kinds: VocabularyKind[], path: string, roleCheck?: (entry: VocabularyEntry) => string | undefined): string => {
    const entry = vocabulary.resolve(ref, kinds) ?? vocabulary.resolve(ref);
    if (!entry) {
      problems.push({ path, message: `${ref} is not in the vocabulary`, suggestions: vocabulary.suggest(ref).map((e) => e.ref) });
      return ref;
    }
    if (!kinds.includes(entry.kind)) {
      problems.push({ path, message: `${entry.ref} is a ${entry.kind}; expected one of ${kinds.join(', ')}`, suggestions: vocabulary.lookup(entry.name, { kinds, limit: 4 }).map((hit) => hit.entry.ref) });
      return entry.ref;
    }
    const roleProblem = roleCheck?.(entry);
    if (roleProblem) problems.push({ path, message: roleProblem, suggestions: vocabulary.lookup(entry.name, { kinds, limit: 4 }).map((hit) => hit.entry.ref) });
    return entry.ref;
  };
  // A predicate on an aggregated measure ("at least 20 games") names the
  // measure (`measure:<index>` or its alias) and is applied after aggregation.
  const aggregateRef = (ref: string): string | undefined => {
    if (/^measure:\d+$/.test(ref)) return ref;
    const at = intent.measures.findIndex((measure) => measure.alias && measure.alias.toLowerCase() === ref.toLowerCase());
    return at >= 0 ? `measure:${at}` : undefined;
  };
  const predicate = (p: IntentPredicate, path: string): IntentPredicate => {
    const aggregate = aggregateRef(p.ref);
    if (aggregate) return { ...p, ref: aggregate, on: 'aggregate' };
    return { ...p, ref: canonical(p.ref, FILTER_KINDS, path) };
  };
  // A dbt-inventory model exposes every numeric column both as a dimension
  // and as a physical column. Aggregating it is a measure over the column:
  // the dimension ref is read as its column ref rather than refused.
  const asMeasureRef = (ref: string, aggregation?: string): string => {
    const entry = vocabulary.resolve(ref);
    if (!entry || entry.kind !== 'dimension' || !entry.physical?.relation || !entry.physical.column) return ref;
    // Counting is a measure over any column; other aggregates need a number.
    const counting = aggregation === 'count' || aggregation === 'count_distinct';
    if (!counting && !entry.roles.includes('numeric')) return ref;
    const column = vocabulary.get(`column:${entry.physical.relation}.${entry.physical.column}`);
    return column ? column.ref : ref;
  };
  // Ordering by a measure's alias ("total_points") names that measure.
  const orderingRef = (ref: string): string => {
    if (/^measure:\d+$/.test(ref) || vocabulary.resolve(ref)) return ref;
    // The alias may arrive dressed as a ref ("metric:total_points").
    const bare = ref.replace(/^(?:metric|measure|column|dimension):/, '').toLowerCase();
    const at = intent.measures.findIndex((measure) => measure.alias && measure.alias.toLowerCase() === bare);
    return at >= 0 ? `measure:${at}` : ref;
  };
  const measures = intent.measures.map((measure, index) => {
    if (measure.derived) {
      // A ratio's parts are governed metrics or measures, or physical columns
      // with an explicit aggregation when the project has no metric for them.
      const columnPart = (ref: string, aggregation: string | undefined, path: string) => canonical(asMeasureRef(ref, aggregation), RATIO_KINDS, path, (entry) =>
        entry.kind === 'column' && !aggregation ? `${entry.ref} is a raw column; a ratio part over a column needs numeratorAggregation/denominatorAggregation` : undefined);
      const numerator = columnPart(measure.derived.numerator, measure.derived.numeratorAggregation, `measures[${index}].derived.numerator`);
      const denominator = columnPart(measure.derived.denominator, measure.derived.denominatorAggregation, `measures[${index}].derived.denominator`);
      const scope = measure.scope?.map((p, at) => predicate(p, `measures[${index}].scope[${at}]`));
      const ref = measure.ref.startsWith('ratio:') ? `ratio:${numerator}/${denominator}` : measure.ref;
      return { ...measure, ref, derived: { ...measure.derived, kind: 'ratio' as const, numerator, denominator }, ...(scope?.length ? { scope } : {}) };
    }
    const ref = canonical(asMeasureRef(measure.ref, measure.aggregation), MEASURE_KINDS, `measures[${index}].ref`, (entry) =>
      entry.kind === 'column' && !measure.aggregation ? `${entry.ref} is a raw column; a column measure needs an aggregation` : undefined);
    const scope = measure.scope?.map((p, at) => predicate(p, `measures[${index}].scope[${at}]`));
    // A metric that already embodies a restriction ("drink_revenue" is
    // `case when is_drink_item ...`) does not need it repeated as a scope;
    // repeating it would push the measure off the semantic tier for nothing.
    const entry = vocabulary.get(ref);
    const embodied = (p: IntentPredicate) => {
      const column = (vocabulary.get(p.ref)?.name ?? p.ref.split('.').pop() ?? '').toLowerCase();
      const text = `${entry?.expr ?? ''} ${entry?.description ?? ''}`.toLowerCase();
      return Boolean(column) && (p.op === 'is_true' || p.op === 'eq') && text.includes(column);
    };
    const effective = scope?.filter((p) => !embodied(p));
    return { ...measure, ref, ...(effective?.length ? { scope: effective } : {}) };
  });
  // A time axis belongs to the measure's own model: an order total by the
  // order lines' time multiplies orders across lines. When the same-named
  // time dimension exists on the measure's model, rebind to it.
  const measureModels = new Set(measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]).map((ref) => vocabulary.get(ref)?.model).filter((model): model is string => Boolean(model)));
  const rebindTime = (ref: string): string => {
    const entry = vocabulary.get(ref);
    if (!entry || !entry.roles.includes('time') || !entry.model || measureModels.size === 0 || measureModels.has(entry.model)) return ref;
    for (const model of measureModels) {
      const sibling = vocabulary.get(`dimension:${model}.${entry.name}`);
      if (sibling?.roles.includes('time')) return sibling.ref;
      // Otherwise the model's own time axis, when it has exactly one.
      const own = vocabulary.entries.filter((candidate) => candidate.kind === 'dimension' && candidate.model === model && candidate.roles.includes('time') && candidate.name !== 'metric_time');
      if (own.length === 1) return own[0]!.ref;
    }
    return ref;
  };
  const groupBy = intent.groupBy.map((group, index) => ({
    ...group,
    ref: canonical(group.role === 'time' ? rebindTime(canonical(group.ref, GROUP_KINDS, `groupBy[${index}].ref`)) : group.ref, GROUP_KINDS, `groupBy[${index}].ref`, (entry) => {
      if (group.role === 'key' && entry.roles.includes('label')) return `${entry.ref} is a label; group by the entity key and put the label in display`;
      if (group.role === 'time' && !entry.roles.includes('time')) return `${entry.ref} is not a time dimension`;
      return undefined;
    }),
  }));
  const display = intent.display.map((ref, index) => canonical(ref, DISPLAY_KINDS, `display[${index}]`));
  const filters = intent.filters.map((p, index) => predicate(p, `filters[${index}]`));
  const ordering = intent.ordering
    ? { ...intent.ordering, ref: /^measure:\d+$/.test(orderingRef(intent.ordering.ref)) ? orderingRef(intent.ordering.ref) : canonical(asMeasureRef(intent.ordering.ref), [...MEASURE_KINDS, ...GROUP_KINDS], 'ordering.ref') }
    : undefined;
  let time = intent.time?.ref ? { ...intent.time, ref: canonical(intent.time.ref, ['dimension', 'column'], 'time.ref', (entry) => entry.roles.includes('time') ? undefined : `${entry.ref} is not a time dimension`) } : intent.time;
  let windowDefault: string | undefined;
  if (time?.window && !time.ref) {
    // A window without an axis: the measures' own models decide. Exactly one
    // time dimension across them is the host's default (and is recorded as
    // such); none or several leaves the axis unset, and no tier may then
    // apply the window silently — each refuses instead.
    const axes = new Set<string>();
    for (const model of measureModels) {
      const own = vocabulary.entries.filter((candidate) => candidate.kind === 'dimension' && candidate.model === model && candidate.roles.includes('time') && candidate.name !== 'metric_time');
      if (own.length === 1) axes.add(own[0]!.ref);
      else own.forEach((candidate) => axes.add(candidate.ref));
    }
    if (axes.size === 1) {
      windowDefault = [...axes][0]!;
      time = { ...time, ref: windowDefault };
    }
  }
  const next: AnalyticalIntentV1 = { ...intent, measures, groupBy, display, filters, ...(ordering ? { ordering } : {}), ...(time ? { time } : {}) };
  if (windowDefault) next.provenance = { ...next.provenance, [windowDefault]: `host:time window "${time?.window?.expression ?? `${time?.window?.start}..${time?.window?.end}`}" bound to the measure's own time axis` };
  if (next.population === 'all') {
    // Every member of the grain: the grain must be an entity key with a
    // physical relation to enumerate, and never a time axis. The key is
    // rewritten to the entity's primary owner so the members come from the
    // entity's own relation, not from the fact that references it.
    const keys = next.groupBy.filter((group) => group.role === 'key');
    if (keys.length !== 1) problems.push({ path: 'groupBy', message: 'population "all" needs exactly one entity key in groupBy (role key): the members to include are that entity\'s' });
    else if (next.groupBy.some((group) => group.role === 'time')) problems.push({ path: 'groupBy', message: 'population "all" cannot be combined with a time axis; drop the time groupBy or the population' });
    else {
      const key = keys[0]!;
      const entry = vocabulary.get(key.ref);
      const primary = entry?.kind === 'entity' && entry.entityType !== 'primary'
        ? vocabulary.entries.find((candidate) => candidate.kind === 'entity' && candidate.name === entry.name && candidate.entityType === 'primary' && candidate.physical?.relation)
        : undefined;
      const owner = primary ?? entry;
      if (!owner?.physical?.relation) problems.push({ path: 'groupBy', message: `${key.ref} has no physical relation to enumerate every member from; population "all" needs an entity key with one`, suggestions: vocabulary.entries.filter((candidate) => candidate.kind === 'entity' && candidate.entityType === 'primary' && candidate.physical?.relation).slice(0, 6).map((candidate) => candidate.ref) });
      else if (primary && primary.ref !== key.ref) {
        next.groupBy = next.groupBy.map((group) => group === key ? { ...group, ref: primary.ref } : group);
        next.provenance = { ...next.provenance, [primary.ref]: `host:population "all" enumerates ${primary.ref} from its own relation (was ${key.ref})` };
      }
    }
  }
  if (next.kind === 'analytics' && next.measures.length === 0 && next.unresolved.every((clause) => !clause.material)) {
    problems.push({ path: 'measures', message: 'an analytics intent needs at least one measure ref, or a material unresolved clause explaining what is missing', suggestions: vocabulary.lookup('revenue', { kinds: ['metric', 'block'], limit: 4 }).map((hit) => hit.entry.ref) });
  }
  for (const group of next.groupBy) {
    if (group.role === 'time' && !group.grain) problems.push({ path: 'groupBy', message: `${group.ref} is a time axis and needs a grain` });
  }
  // "Not modeled" is a claim the host checks against the whole vocabulary.
  // A material clause with no options whose words name an authorized entry
  // is sent back with those entries: a numeric column with no metric is
  // still a measure with an aggregation, never a modeling gap.
  for (const clause of next.unresolved) {
    if (!clause.material || clause.options.length > 0 || clause.origin === 'ledger') continue;
    const words = (clause.clause.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((word) => !CLAUSE_STOPWORDS.has(word));
    const hits = new Map<string, VocabularyEntry>();
    for (let i = 0; i < words.length; i += 1) {
      for (const phrase of [words.slice(i, i + 2).join(' '), words[i]!]) {
        for (const hit of vocabulary.lookup(phrase, { limit: 3, minScore: 0.85 })) {
          if (hit.matchedOn !== 'name' && hit.matchedOn !== 'alias') continue;
          if (hit.entry.kind === 'model' || hit.entry.kind === 'relation' || hit.entry.kind === 'entity') continue;
          hits.set(hit.entry.ref, hit.entry);
        }
      }
    }
    if (hits.size === 0) continue;
    const measureLike = [...hits.values()].filter((entry) => entry.kind === 'metric' || entry.kind === 'measure' || entry.kind === 'block' || (entry.kind === 'column' && entry.roles.includes('numeric')) || (entry.kind === 'dimension' && entry.roles.includes('numeric')));
    problems.push({
      path: 'unresolved',
      message: `"${clause.clause}" is modeled: ${[...hits.keys()].join(', ')}. ${measureLike.length ? `Use ${measureLike.map((entry) => entry.ref).join(' or ')} as a measure (a numeric column takes an aggregation such as sum) instead of reporting a gap.` : 'Use these refs instead of reporting a gap.'}`,
      suggestions: [...hits.keys()],
    });
  }
  // A follow-up keeps the previous period unless the message names one: an
  // edit of a 2017 ranking is still about 2017.
  if (prior?.time?.window && next.kind === 'analytics' && !next.time?.window && question !== undefined && !namesPeriod(question)) {
    next.time = { ...(next.time ?? {}), ...prior.time };
    next.provenance[`time:${prior.time.ref ?? 'window'}`] = 'inherited';
  }
  for (const ref of unaccountedInheritedRefs(prior, next)) {
    problems.push({ path: 'provenance', message: `the previous analysis used ${ref}; keep it (provenance "inherited") or list it as "removed:<why>"` });
  }
  // Display refs must not duplicate group-by refs; a key in display is harmless.
  const grouped = new Set(next.groupBy.map((group) => group.ref));
  next.display = next.display.filter((ref) => !grouped.has(ref));
  // A displayed label must belong to the grain. "Supply cost by product"
  // grouped by the product key with the supply NAME displayed is one row per
  // supply line, not per product: the display changed the grain silently.
  // The host replaces such a label with the grain entity's own label, or
  // drops it, and says so in the provenance.
  const grainModels = new Set<string>();
  for (const group of next.groupBy) {
    if (group.role !== 'key') continue;
    const entry = vocabulary.get(group.ref);
    if (!entry) continue;
    const column = entry.physical?.column ?? entry.name;
    const owners = vocabulary.entries.filter((candidate) => candidate.kind === 'entity' && candidate.model && candidate.roles.includes('key') && [candidate.physical?.column, candidate.name, `${candidate.name}_id`, ...candidate.aliases].includes(column));
    const primary = owners.find((candidate) => /primary/i.test(candidate.description ?? '') || candidate.aliases.includes('primary')) ?? (owners.length === 1 ? owners[0] : undefined);
    if (primary?.model) grainModels.add(primary.model);
    else if (entry.kind === 'entity' && entry.model) grainModels.add(entry.model);
    else if (entry.model && !/_id$/i.test(column)) grainModels.add(entry.model);
  }
  if (grainModels.size) {
    next.display = next.display.flatMap((ref) => {
      const entry = vocabulary.get(ref);
      if (!entry || entry.kind !== 'dimension' || !entry.model || grainModels.has(entry.model) || !entry.roles.includes('label')) return [ref];
      const replacement = [...grainModels].flatMap((model) => vocabulary.entries.filter((candidate) => candidate.kind === 'dimension' && candidate.model === model && candidate.roles.includes('label')))[0];
      next.provenance[ref] = `removed:${entry.name} is an attribute of ${entry.model}, finer than the grain ${[...grainModels].join('/')}${replacement ? `; displayed ${replacement.ref} instead` : ''}`;
      if (replacement && !next.display.includes(replacement.ref) && !grouped.has(replacement.ref)) {
        next.provenance[replacement.ref] = next.provenance[replacement.ref] ?? 'host:label of the grain';
        return [replacement.ref];
      }
      return [];
    });
    next.display = [...new Set(next.display)];
  }
  // A follow-up whose every content word already appears in the previous
  // analysis names nothing new. It is a correction of that analysis, never
  // a replacement of its measures: the interpreter is sent back once.
  if (prior && question && prior.measures.length && !next.measures.some((measure) => prior.measures.some((previous) => previous.ref === measure.ref))) {
    const priorText = normalizeVocabularyText([
      prior.reading, ...Object.values(prior.provenance), ...intentRefs(prior).flatMap((ref) => { const entry = vocabulary.get(ref); return [entry?.name, entry?.label, entry?.description, ...(entry?.aliases ?? [])]; }),
    ].filter(Boolean).join(' '));
    const priorWords = new Set(priorText.split(/\s+/).filter((word) => word.length > 2));
    const content = (question.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((word) => !FOLLOW_UP_STOPWORDS.has(word));
    // A word is known when it belongs to the previous analysis or is a
    // generic classifier word ("category", "breakdown"); both are matched
    // with spelling tolerance, so "bevereage catogery" still names nothing new.
    const near = (word: string, candidate: string) => word === candidate || trigramSimilarity(word, candidate) >= 0.6 || (word.length >= 5 && Math.abs(word.length - candidate.length) <= 2 && editDistance(word, candidate) <= 2);
    const known = (word: string) => [...priorWords].some((candidate) => near(word, candidate)) || FOLLOW_UP_GENERIC_WORDS.some((candidate) => near(word, candidate));
    if (content.length && content.every(known)) {
      followUpReplacement = `every word of this message (${content.join(', ')}) already belongs to the previous analysis, so it corrects that analysis rather than replacing it: keep the previous measures ${prior.measures.map((measure) => measure.ref).join(', ')}, grain, ranking and limit, and apply the correction to them (a scope, a display, a filter); ask one clarification only if two readings remain`;
      problems.push({ path: 'measures', message: followUpReplacement });
    }
  }
  return { intent: next, problems, ...(followUpReplacement ? { followUpReplacement } : {}) };
}

/** Plain Levenshtein distance, for misspellings trigrams miss (transpositions). */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[] = new Array(rows * cols).fill(0);
  for (let i = 0; i < rows; i += 1) table[i * cols] = i;
  for (let j = 0; j < cols; j += 1) table[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i * cols + j] = Math.min(table[(i - 1) * cols + j]! + 1, table[i * cols + j - 1]! + 1, table[(i - 1) * cols + j - 1]! + cost);
    }
  }
  return table[rows * cols - 1]!;
}

const CLAUSE_STOPWORDS = new Set(['the', 'and', 'for', 'per', 'each', 'with', 'from', 'that', 'this', 'what', 'which', 'how', 'many', 'much', 'total', 'show', 'give', 'list', 'top', 'all', 'any']);

/** Classifier words a correction may add without naming a new subject. */
const FOLLOW_UP_GENERIC_WORDS = ['category', 'categories', 'breakdown', 'group', 'groups', 'level', 'levels', 'kind', 'kinds'];
const FOLLOW_UP_STOPWORDS = new Set(['the', 'and', 'for', 'need', 'get', 'want', 'show', 'give', 'please', 'can', 'you', 'now', 'just', 'only', 'also', 'but', 'with', 'from', 'that', 'this', 'what', 'about', 'into', 'them', 'those', 'these', 'not', 'yes', 'okay', 'thanks', 'include', 'add', 'results', 'result', 'again', 'instead', 'actually', 'sorry', 'mean', 'meant']);

/**
 * A vocabulary entry whose NAME is a phrase of the question is the governed
 * default for that phrase. When the model asks which of several readings a
 * word means and exactly one option is named by that word, the question
 * already answered it: take that option, keep the note, stop asking.
 */
export function applyGovernedDefaults(intent: AnalyticalIntentV1, question: string, vocabulary: VocabularyIndex): void {
  const normalizedQuestion = ` ${normalizeVocabularyText(question)} `;
  // Words the question spends on the GRAIN ("customers" in "top customers")
  // name the thing being ranked, not a measure: a metric that happens to share
  // that name (a customer count) is never the governed default for it.
  const grainWords = new Set<string>();
  for (const group of intent.groupBy) {
    const entry = vocabulary.get(group.ref);
    for (const word of [entry?.name, entry?.label, entry?.model].map((value) => normalizeVocabularyText(value ?? '')).filter(Boolean)) {
      grainWords.add(word);
      grainWords.add(word.endsWith('s') ? word.slice(0, -1) : `${word}s`);
    }
  }
  for (const clause of intent.unresolved) {
    if (!clause.material) continue;
    // A material clause with at most one distinct option, already used by
    // the intent, is not an ambiguity: the interpreter is asking about
    // something the host proves (reachability, grain), not about meaning.
    // A clause with NO options is the opposite: nothing in the vocabulary
    // answers it, and it stays material so the turn ends as a named gap.
    const distinct = [...new Set(clause.options)];
    if (distinct.length === 1 && intentRefs(intent).includes(distinct[0]!)) {
      clause.material = false;
      clause.question = clause.question ? `${clause.question} (not asked: the host proves reachability and grain)` : undefined;
      continue;
    }
    if (clause.options.length < 2) continue;
    const namedBy = (ref: string) => {
      const entry = vocabulary.get(ref);
      if (!entry) return false;
      const names = [entry.name, entry.label ?? ''].map(normalizeVocabularyText).filter(Boolean);
      if (names.some((name) => grainWords.has(name))) return false;
      return names.some((name) => normalizedQuestion.includes(` ${name} `));
    };
    let named = clause.options.filter(namedBy);
    // CERTIFIED PRECEDENT. When the team certified a block that ranks the
    // same entity the question ranks, the measure that block orders by is
    // the governed reading of "top <entity>": the certification already
    // answered the question the interpreter is asking.
    if (named.length === 0 && intent.groupBy.some((group) => group.role === 'key')) {
      const grainEntities = intent.groupBy.filter((group) => group.role === 'key').map((group) => vocabulary.get(group.ref)).filter((entry): entry is VocabularyEntry => Boolean(entry));
      const grainNames = new Set(grainEntities.flatMap((entry) => [entry.name, entry.model ?? ''].map(normalizeVocabularyText)).filter(Boolean));
      const precedent = vocabulary.entries.filter((entry) => entry.kind === 'block' && entry.certified && entry.contract?.orderBy?.[0] && entry.contract.entities.some((name) => grainNames.has(normalizeVocabularyText(name)) || grainNames.has(normalizeVocabularyText(`${name}s`))));
      const orderedBy = new Set(precedent.map((entry) => normalizeVocabularyText(entry.contract!.orderBy![0]!.column)));
      const byPrecedent = clause.options.filter((ref) => {
        const entry = vocabulary.get(ref);
        return Boolean(entry && (orderedBy.has(normalizeVocabularyText(entry.name)) || orderedBy.has(normalizeVocabularyText(entry.physical?.column ?? ''))));
      });
      if (byPrecedent.length === 1) {
        named = byPrecedent;
        const block = precedent.find((entry) => normalizeVocabularyText(entry.contract!.orderBy![0]!.column) === normalizeVocabularyText(vocabulary.get(byPrecedent[0]!)?.name ?? ''))
          ?? precedent[0]!;
        intent.provenance[byPrecedent[0]!] = intent.provenance[byPrecedent[0]!] ?? `q:${clause.clause} (certified precedent ${block.ref})`;
      }
    }
    // The question may name a metric the model did not list among its options.
    if (named.length === 0) {
      const kinds = new Set(clause.options.map((ref) => vocabulary.get(ref)?.kind).filter(Boolean));
      named = vocabulary.entries.filter((entry) => (kinds.size === 0 || kinds.has(entry.kind)) && (entry.kind === 'metric' || entry.kind === 'measure') && namedBy(entry.ref)).map((entry) => entry.ref);
      if (named.length === 1) clause.options = [...new Set([...clause.options, named[0]!])];
    }
    if (named.length !== 1) continue;
    const chosen = named[0]!;
    clause.material = false;
    clause.question = `Read "${clause.clause}" as ${chosen} because the question names it; say "${clause.options.filter((ref) => ref !== chosen).map((ref) => vocabulary.get(ref)?.label ?? ref).join('" or "')}" for the other reading.`;
    intent.provenance[chosen] = intent.provenance[chosen] ?? `q:${clause.clause} (governed default)`;
    if (!intent.measures.some((measure) => measure.ref === chosen) && vocabulary.get(chosen)?.kind !== 'dimension') {
      const already = intent.measures.find((measure) => clause.options.includes(measure.ref));
      if (already) {
        // The measure the model wrote down is replaced by the governed
        // reading; everything that pointed at it (the ranking order, the
        // provenance) follows, or the answer would silently lose its sort.
        if (intent.ordering?.ref === already.ref) intent.ordering.ref = chosen;
        if (intent.provenance[already.ref] && !intent.provenance[chosen]) intent.provenance[chosen] = intent.provenance[already.ref]!;
        already.ref = chosen;
      } else intent.measures.push({ ref: chosen });
    }
  }
  bindExactNames(intent, normalizedQuestion, grainWords, vocabulary);
  promoteSoleMeasureScope(intent);
}

/** Words that qualify a money measure away from its plain named reading. */
const MEASURE_QUALIFIERS = ['gross', 'including', 'incl', 'tax', 'after tax', 'net', 'order total', 'lifetime', 'ltv'];

/**
 * THE NAME WINS. A question word that exactly names a metric ("revenue")
 * means that metric, unless the question qualifies it ("gross", "including
 * tax", "order total"). A confidently chosen sibling (order_total for
 * "how much revenue do we have") is replaced by the named metric and the
 * provenance says so. Nothing happens when the question names no metric,
 * names several, or already names the chosen one.
 */
export function bindExactNames(intent: AnalyticalIntentV1, normalizedQuestion: string, grainWords: Set<string>, vocabulary: VocabularyIndex): void {
  if (MEASURE_QUALIFIERS.some((qualifier) => normalizedQuestion.includes(` ${qualifier} `))) return;
  const namesOf = (entry: VocabularyEntry) => [entry.name, entry.label ?? '', ...entry.aliases].map(normalizeVocabularyText).filter((name) => name && !grainWords.has(name));
  const namedByQuestion = (entry: VocabularyEntry | undefined) => Boolean(entry && namesOf(entry).some((name) => normalizedQuestion.includes(` ${name} `)));
  // A word that names an entity or a model ("customers") is the thing being
  // measured, never the measure, whether or not the intent groups by it.
  const entityWords = new Set<string>();
  for (const entry of vocabulary.entries) {
    for (const word of [entry.kind === 'entity' ? entry.name : '', entry.kind === 'entity' ? entry.label ?? '' : '', entry.model ?? ''].map((value) => normalizeVocabularyText(value)).filter(Boolean)) {
      entityWords.add(word);
      entityWords.add(word.endsWith('s') ? word.slice(0, -1) : `${word}s`);
    }
  }
  const exactByName = (entry: VocabularyEntry) => {
    const name = normalizeVocabularyText(entry.name);
    return normalizedQuestion.includes(` ${name} `) && !grainWords.has(name) && !entityWords.has(name);
  };
  // A metric outranks a measure of the same name (the metric wraps it).
  const namedMetrics = vocabulary.entries.filter((entry) => entry.kind === 'metric' && exactByName(entry));
  const named = namedMetrics.length ? namedMetrics : vocabulary.entries.filter((entry) => entry.kind === 'measure' && exactByName(entry));
  if (named.length !== 1) return;
  const target = named[0]!;
  // A ratio, derived or windowed metric names a formula, not a base measure:
  // the interpreter's period-versus-lifetime reading of it stands (rule 5b).
  if (target.derived || target.engineOnly || (target.metricType && target.metricType !== 'simple')) return;
  const used = new Set(intentRefs(intent));
  if (used.has(target.ref)) return;
  // The word is spent when the chosen measure's own name carries it:
  // "beverage revenue" read as drink_revenue has used "revenue".
  const targetWords = normalizeVocabularyText(target.name).split(' ').filter(Boolean);
  const absorbs = (entry: VocabularyEntry) => {
    const words = new Set(namesOf(entry).flatMap((name) => name.split(' ')));
    return targetWords.every((word) => words.has(word));
  };
  const rebind = (ref: string): string => {
    const entry = vocabulary.get(ref);
    if (!entry || (entry.kind !== 'metric' && entry.kind !== 'measure') || namedByQuestion(entry) || absorbs(entry)) return ref;
    intent.provenance[target.ref] = `${intent.provenance[ref] ?? `q:${target.name}`} (governed default: the question names the metric "${target.name}")`;
    // The reading line stays honest about what was measured.
    const measuredAs = `measured as ${target.label ?? target.name} because the question names the metric "${target.name}"`;
    if (!intent.reading.includes(measuredAs)) intent.reading = `${intent.reading.replace(/[.\s]+$/, '')}; ${measuredAs}.`;
    if (intent.ordering?.ref === ref) intent.ordering.ref = target.ref;
    return target.ref;
  };
  for (const measure of intent.measures) {
    if (measure.derived) {
      measure.derived.numerator = rebind(measure.derived.numerator);
      measure.derived.denominator = rebind(measure.derived.denominator);
      if (measure.ref.startsWith('ratio:')) measure.ref = `ratio:${measure.derived.numerator}/${measure.derived.denominator}`;
      continue;
    }
    measure.ref = rebind(measure.ref);
  }
}

/**
 * A restriction on the only measure restricts the population: "beverage
 * revenue by product" lists the products that sold beverages, not every
 * product with a zero. The numbers are the same either way; the rows are
 * not. An explicit `population: 'all'` keeps the zeros; a ratio keeps its
 * parts' scopes because each part restricts its own aggregate.
 */
export function promoteSoleMeasureScope(intent: AnalyticalIntentV1): void {
  if (intent.measures.length !== 1 || intent.population === 'all') return;
  const measure = intent.measures[0]!;
  if (measure.derived || !measure.scope?.length) return;
  const promoted = measure.scope;
  delete measure.scope;
  intent.filters = [...intent.filters, ...promoted];
  for (const predicate of promoted) {
    const key = `filter:${predicate.ref}`;
    if (!intent.provenance[key]) intent.provenance[key] = `host:the restriction on the only measure (${measure.ref}) restricts the population`;
  }
}

/**
 * Question words that name a vocabulary entry the intent does not use. Not a
 * refusal (the interpreter may have read them correctly as prose) but a
 * warning the reader sees beside the answer: "the question said beverage;
 * this reading does not use anything named beverage".
 */
const IDENTIFIER_TOKENS = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;

/** Column-like identifiers (`is_drink_item`) a vocabulary entry's own text names. */
function definitionIdentifiers(entry: VocabularyEntry): string[] {
  const text = [entry.description ?? '', entry.expr ?? '', entry.physical?.expr ?? '', ...(entry.columns ?? []), ...(entry.contract?.staticScope ?? []).map((scope) => scope.column)].join(' ').toLowerCase();
  return [...new Set(text.match(IDENTIFIER_TOKENS) ?? [])];
}

export function uncoveredQuestionTerms(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  const used = new Set(intentRefs(intent));
  const usedIdentifiers = new Set([...used].flatMap((ref) => {
    const entry = vocabulary.get(ref);
    if (!entry) return [];
    return [entry.name.toLowerCase(), ...(entry.physical?.column ? [entry.physical.column.toLowerCase()] : []), ...definitionIdentifiers(entry)];
  }));
  const usedText = [...used].map((ref) => `${ref} ${vocabulary.get(ref)?.name ?? ''} ${vocabulary.get(ref)?.label ?? ''} ${(vocabulary.get(ref)?.aliases ?? []).join(' ')} ${vocabulary.get(ref)?.description ?? ''}`).join(' ').toLowerCase();
  const out: string[] = [];
  for (const word of new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])) {
    if (['what', 'which', 'show', 'give', 'list', 'have', 'with', 'from', 'that', 'this', 'each', 'many', 'much', 'total', 'both', 'need', 'please', 'could', 'would', 'should', 'about', 'their', 'there', 'than', 'then', 'into', 'over', 'category', 'product', 'products', 'customer', 'customers'].includes(word)) continue;
    const hits = vocabulary.lookup(word, { limit: 3, minScore: 0.97 }).filter((hit) => hit.matchedOn === 'name' || hit.matchedOn === 'alias');
    if (!hits.length) continue;
    const stem = word.replace(/s$/, '');
    if (usedText.includes(stem)) continue;
    if (hits.some((hit) => used.has(hit.entry.ref))) continue;
    // A business term or block is covered when its own definition names a
    // column the used measures embody ("beverage": filter on is_drink_item;
    // drink_revenue's expression is a case on is_drink_item).
    if (hits.some((hit) => (hit.entry.kind === 'term' || hit.entry.kind === 'block') && definitionIdentifiers(hit.entry).some((identifier) => usedIdentifiers.has(identifier)))) continue;
    out.push(word);
  }
  return out;
}

/** Question words that match nothing exactly, with the nearest vocabulary: the deterministic pre-lookup. */
export function spellingHints(question: string, vocabulary: VocabularyIndex): string[] {
  const hints: string[] = [];
  for (const word of new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])) {
    const exact = vocabulary.lookup(word, { limit: 1, minScore: 0.97 });
    if (exact.length) continue;
    const near = vocabulary.lookup(word, { limit: 3, minScore: 0.55 }).filter((hit) => hit.matchedOn === 'fuzzy');
    if (near.length) hints.push(`"${word}" ~ ${near.map((hit) => `${hit.entry.ref}${hit.entry.label ? ` (${hit.entry.label})` : ''}`).join(', ')}`);
  }
  return hints;
}

function correctionMessage(problems: IntentProblem[]): string {
  return [
    'Your intent had problems. Fix ONLY these and resend the complete JSON object:',
    ...problems.map((problem) => `- ${problem.path}: ${problem.message}${problem.suggestions?.length ? ` (authorized refs: ${problem.suggestions.join(', ')})` : ''}`),
  ].join('\n');
}

/**
 * Measures under one time window must share a time role: each metric
 * aggregates over its own time dimension (a customer count over the first
 * order date, revenue over the order date), and "in 2025" means different
 * things for them. One role is bound as the window's axis (and said so);
 * several become one bounded clarification, unless the question already
 * named the axis itself. Never applied silently.
 */
export function proveTimeRoles(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): void {
  if (!intent.time?.window) return;
  const label = (ref: string) => vocabulary.get(ref)?.label ?? vocabulary.get(ref)?.name ?? ref;
  // A time role is a time MEANING: the same-named dimension on two models
  // (an order date on orders and on order lines) is one role, represented
  // by the first measure's ref.
  const roleName = (ref: string) => vocabulary.get(ref)?.name ?? ref.split('.').pop() ?? ref;
  const roles = new Map<string, string[]>();
  const representative = new Map<string, string>();
  for (const measure of intent.measures) {
    for (const ref of measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]) {
      const role = vocabulary.get(ref)?.timeRef;
      if (!role) continue;
      const name = roleName(role);
      if (!representative.has(name)) representative.set(name, role);
      roles.set(representative.get(name)!, [...(roles.get(representative.get(name)!) ?? []), label(ref)]);
    }
  }
  if (roles.size === 0) return;
  const expression = intent.time.window.expression ?? `${intent.time.window.start}..${intent.time.window.end}`;
  const current = intent.time.ref;
  const hostChosen = Boolean(current && (intent.provenance[current] ?? '').startsWith('host:'));
  const explicit = Boolean(current && !hostChosen && vocabulary.get(current)?.name !== 'metric_time');
  if (roles.size === 1) {
    const [role] = [...roles.keys()] as [string];
    // An axis with the same meaning (same name on another model) already there stays.
    if (current && roleName(current) === roleName(role) && vocabulary.get(current)?.name !== 'metric_time') return;
    if (!explicit && current !== role) {
      intent.time = { ...intent.time, ref: role };
      intent.provenance = { ...intent.provenance, [role]: `host:time window "${expression}" applied on the measures' time role ${label(role)}` };
    }
    return;
  }
  if (explicit) {
    intent.provenance = { ...intent.provenance, [current!]: `${intent.provenance[current!] ?? 'q:time'}; host:time window "${expression}" applies on ${label(current!)} to every measure (their own time roles differ: ${[...roles.entries()].map(([role, names]) => `${label(role)} for ${names.join(', ')}`).join('; ')})` };
    return;
  }
  if (intent.unresolved.some((clause) => clause.options.some((option) => roles.has(option)))) return;
  if (hostChosen && current) {
    delete intent.provenance[current];
    intent.time = { ...intent.time, ref: undefined };
  }
  intent.unresolved.push({
    clause: expression,
    options: [...roles.keys()],
    material: true,
    question: `"${expression}" means a different time for these measures: ${[...roles.entries()].map(([role, names]) => `${label(role)} (${names.join(', ')})`).join(' or ')}. Which time should the window apply to?`,
  });
}

const CAUSAL_OPERATORS = ['why', 'because', 'driver', 'drivers', 'reason', 'reasons', 'invest', 'investment', 'recommend', 'recommendation', 'recommendations', 'should', 'decide', 'decision', 'forecast', 'predict', 'prediction', 'projection'];

/** The causal or decision words a question carries (why, drivers, should, invest...). */
export function causalOperatorsIn(question: string): string[] {
  const words = normalizeVocabularyText(question).split(' ').filter(Boolean);
  return CAUSAL_OPERATORS.filter((word) => words.includes(word));
}
const BREAKDOWN_STOP = new Set(['day', 'week', 'month', 'quarter', 'year', 'date', 'time', 'period', 'each', 'the', 'total', 'far', 'now', 'default', 'itself', 'category', 'type', 'name']);

/**
 * FULL-QUESTION APPLICABILITY. A question that asks WHY, or what to DO, asks
 * for an operation Ask does not perform on governed data; a breakdown "by
 * <noun>" that nothing in the intent or the vocabulary accounts for asks for
 * a model the project does not have. Either is a material clause: the turn
 * ends as a named gap and nothing executes, instead of an adjacent trend
 * being served as the answer.
 */
export function proveClauseCoverage(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): void {
  if (intent.kind !== 'analytics') return;
  if (intent.unresolved.some((clause) => clause.material)) return;
  const words = normalizeVocabularyText(question).split(' ').filter(Boolean);
  const operators = causalOperatorsIn(question);
  if (operators.length > 0) {
    intent.unresolved.push({
      clause: operators.join(', '),
      options: [],
      material: true,
      kind: 'unsupported',
      question: `Explaining why something happened or recommending what to do (${operators.join(', ')}) is not something Ask computes from governed data; Research can investigate the drivers.`,
    });
  }
  // A breakdown the interpreter dropped: "by <noun>" with no categorical or
  // key grouping standing for it (a time grouping cannot stand for "region").
  if (!intent.groupBy.some((group) => group.role !== 'time')) {
    const unaccounted = new Set(unaccountedQuestionWords(question, intent, vocabulary));
    for (const match of question.toLowerCase().matchAll(/\b(?:by|per|across|for each)\s+([a-z][a-z_]+)/g)) {
      const noun = match[1]!;
      if (BREAKDOWN_STOP.has(noun) || !unaccounted.has(noun) && !unaccounted.has(noun.replace(/s$/, ''))) continue;
      if (vocabulary.lookup(noun, { limit: 1, minScore: 0.55 }).length > 0) continue;
      intent.unresolved.push({ clause: `by ${noun}`, options: [], material: true, kind: 'not_modeled', question: `This project has no "${noun}" to break the answer down by.` });
      return;
    }
  }
}

/** An intent whose only content is what it left unresolved. */
function isBareIntent(intent: AnalyticalIntentV1): boolean {
  return intent.measures.length === 0 && intent.groupBy.length === 0 && intent.display.length === 0 && intent.filters.length === 0 && !intent.time && !intent.ordering && !intent.limit;
}

const QUESTION_STOPWORDS = new Set([...CLAUSE_STOPWORDS, ...FOLLOW_UP_STOPWORDS, 'our', 'overall', 'whats', 'does', 'did', 'are', 'was', 'were', 'have', 'has', 'much', 'many', 'number', 'amount', 'sum', 'total', 'totals', 'please', 'tell', 'find', 'out', 'like', 'would']);

/**
 * Question words neither a stopword nor part of any ref the intent uses
 * (name, label, alias, description words): what the intent has not
 * accounted for.
 */
const YEAR_WORD = /^(?:19|20)\d{2}$/;
const PERIOD_WORDS = /\b(?:(?:19|20)\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|today|yesterday|week|month|quarter|year|season|ytd|mtd|qtd|all[- ]time|lifetime|overall|ever|since|until|before|after|between|last|past|recent|latest|current|this|now)\b/i;
/** Whether a message names a period of its own (a year, a month, a relative window, "all time"). */
export function namesPeriod(question: string): boolean {
  return PERIOD_WORDS.test(question);
}

/** The years a question names that the intent's window, filters or scopes do not account for. */
export function droppedYears(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  return unaccountedQuestionWords(question, intent, vocabulary).filter((word) => YEAR_WORD.test(word));
}

const GRAIN_OF_WORD: Record<string, string> = { day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month', quarter: 'quarter', quarterly: 'quarter' };

/** A breakdown grain the question asks for ("by month", "monthly", "weekly") that the reading carries no time grouping for. */
export function droppedGrain(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string | undefined {
  if (intent.groupBy.some((group) => group.role === 'time' && group.grain)) return undefined;
  const unaccounted = unaccountedQuestionWords(question, intent, vocabulary);
  const word = unaccounted.find((candidate) => GRAIN_OF_WORD[candidate]);
  return word ? GRAIN_OF_WORD[word] : undefined;
}

/**
 * The words an intent accounts for: its refs' names, labels, aliases and
 * descriptions, its grains, its window and its filter values. With
 * `blockThroughContract`, a block accounts only for its own contract (name,
 * outputs, measures), never for its description or examples: "closest
 * available" is not accounting for a question.
 */
export function coveredWords(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, options: { blockThroughContract?: boolean } = {}): Set<string> {
  const covered = new Set<string>();
  for (const ref of intentRefs(intent)) {
    const entry = vocabulary.get(ref);
    const texts = options.blockThroughContract && entry?.kind === 'block'
      ? [entry.name, ...(entry.contract?.outputs ?? []), ...(entry.contract?.measures.map((measure) => measure.output) ?? [])]
      : [entry?.name, entry?.label, entry?.model, ...(entry?.aliases ?? []), entry?.description ?? '', ref];
    for (const text of texts) {
      for (const word of normalizeVocabularyText(text ?? '').split(' ')) if (word) { covered.add(word); covered.add(singularWord(word)); }
    }
  }
  const GRAIN_WORDS: Record<string, string[]> = { day: ['day', 'daily'], week: ['week', 'weekly'], month: ['month', 'monthly'], quarter: ['quarter', 'quarterly'], year: ['year', 'yearly', 'annual', 'annually'] };
  for (const grain of [...intent.groupBy.map((group) => group.grain), intent.time?.grain]) for (const word of GRAIN_WORDS[grain ?? ''] ?? []) covered.add(word);
  if (intent.time?.window) {
    for (const word of normalizeVocabularyText(intent.time.window.expression ?? '').split(' ')) if (word) covered.add(word);
    const start = Number(intent.time.window.start.slice(0, 4));
    const end = Number(intent.time.window.end.slice(0, 4));
    for (let year = start; year <= end; year += 1) covered.add(String(year));
  }
  for (const predicate of [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]) {
    for (const value of predicate.values) for (const word of normalizeVocabularyText(String(value)).split(' ')) if (word) covered.add(word);
  }
  return covered;
}

export function unaccountedQuestionWords(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  const covered = coveredWords(intent, vocabulary);
  const out: string[] = [];
  for (const word of normalizeVocabularyText(question).split(' ')) {
    // A year is a clause of its own; other numbers are not words.
    if (word.length < 3 || QUESTION_STOPWORDS.has(word) || (/^\d+$/.test(word) && !YEAR_WORD.test(word))) continue;
    if (covered.has(word) || covered.has(singularWord(word))) continue;
    out.push(word);
  }
  return [...new Set(out)];
}

const singularWord = (word: string): string => word.replace(/ies$/, 'y').replace(/(ses|xes|shes|ches)$/, (m) => m.slice(0, -2)).replace(/s$/, '');

const CLAUSE_WORDS = (text: string) => (normalizeVocabularyText(text).split(' ').filter((word) => word.length > 2 && !QUESTION_STOPWORDS.has(word)));

/** The obligations of the original question, from its first analytics reading. */
export function buildLedger(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): IntentLedger {
  const time = intent.groupBy.find((group) => group.role === 'time' && group.grain);
  return {
    clauses: intent.unresolved.filter((clause) => clause.material).map((clause) => ({ clause: clause.clause, ...(clause.kind ? { kind: clause.kind } : {}), ...(clause.question ? { question: clause.question } : {}), words: CLAUSE_WORDS(clause.clause) })),
    ...(time?.grain ? { timeGrain: { ref: time.ref, grain: time.grain } } : {}),
    measures: intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]),
    unaccounted: unaccountedQuestionWords(question, intent, vocabulary),
  };
}

/** Words of a ledger clause that the intent now accounts for (a block only through its contract). */
function accountedWords(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): Set<string> {
  return coveredWords(intent, vocabulary, { blockThroughContract: true });
}

/**
 * Hold a later reading to the ledger. A clause is discharged when the reading
 * binds refs that account for its words, kept when it is still listed as
 * unresolved, and dropped otherwise. A first-reading monthly grain that the
 * later reading lost, or a measure the later reading replaced by a block that
 * does not carry it, is a drop too.
 */
export function auditLedger(question: string, intent: AnalyticalIntentV1, ledger: IntentLedger, vocabulary: VocabularyIndex): { entries: Omit<LedgerEntry, 'round'>[]; dropped: IntentLedger['clauses'] } {
  const entries: Omit<LedgerEntry, 'round'>[] = [];
  const dropped: IntentLedger['clauses'] = [];
  const covered = accountedWords(intent, vocabulary);
  const listed = new Set(intent.unresolved.filter((clause) => clause.material).map((clause) => normalizeVocabularyText(clause.clause)));
  for (const item of ledger.clauses) {
    const words = item.words.filter((word) => !/^\d+$/.test(word));
    const discharged = words.length > 0 && words.every((word) => covered.has(word) || covered.has(singularWord(word)));
    if (discharged) { entries.push({ clause: item.clause, kind: item.kind, disposition: 'discharged', by: 'refs' }); continue; }
    const stillListed = listed.has(normalizeVocabularyText(item.clause)) || intent.unresolved.some((clause) => clause.material && words.some((word) => normalizeVocabularyText(clause.clause).includes(word)));
    if (stillListed) { entries.push({ clause: item.clause, kind: item.kind, disposition: 'unresolved' }); continue; }
    entries.push({ clause: item.clause, kind: item.kind, disposition: 'dropped' });
    dropped.push(item);
  }
  if (ledger.timeGrain && !intent.groupBy.some((group) => group.role === 'time' && group.grain === ledger.timeGrain!.grain)) {
    const clause = `by ${ledger.timeGrain.grain}`;
    entries.push({ clause, kind: 'not_modeled', disposition: 'dropped' });
    dropped.push({ clause, kind: 'not_modeled', question: `The question asked for a ${ledger.timeGrain.grain} breakdown; a reading without that grain does not answer it.`, words: [ledger.timeGrain.grain] });
  }
  const blocks = intent.measures.map((measure) => vocabulary.get(measure.ref)).filter((entry): entry is VocabularyEntry => entry?.kind === 'block');
  if (blocks.length > 0 && ledger.measures.length > 0) {
    for (const ref of ledger.measures) {
      if (intentRefs(intent).includes(ref)) continue;
      const entry = vocabulary.get(ref);
      if (!entry || entry.kind === 'block') continue;
      const name = normalizeVocabularyText(entry.physical?.column ?? entry.name);
      const carried = blocks.some((block) => [...(block.contract?.outputs ?? []), ...(block.contract?.measures.map((measure) => measure.sourceColumn ?? measure.output) ?? [])].some((column) => normalizeVocabularyText(column) === name));
      if (carried) continue;
      const clause = entry.label ?? entry.name;
      entries.push({ clause, disposition: 'dropped' });
      dropped.push({ clause, question: `The question was read as ${clause}; the block ${blocks.map((block) => block.name).join(', ')} does not carry it, so it does not answer the question.`, words: CLAUSE_WORDS(clause) });
    }
  }
  void question;
  return { entries, dropped };
}

/** A retry after a provider timeout needs room for one more full dispatch (the subscription CLI's 60 s) plus 15 s for the rest of the turn. */
const PROVIDER_TIMEOUT_RETRY_BUDGET_MS = 75_000;

export async function resolveIntent(input: ResolveIntentInput): Promise<IntentResolution> {
  const maxAttempts = Math.max(1, Math.min(3, input.maxAttempts ?? 2));
  let timeoutRetried = false;
  const now = input.now ?? (() => Date.now());
  const seeds = input.question.split(/[^A-Za-z0-9_']+/).filter((word) => word.length > 2);
  const cards = input.vocabulary.renderCards({ maxChars: input.cardBudget ?? 24_000, seeds });
  const system = buildIntentSystemPrompt({ cards, guidance: input.guidance, hasPrior: Boolean(input.prior), hints: spellingHints(input.question, input.vocabulary) });
  const messages: AgentMessage[] = [
    { role: 'system', content: system },
    ...(input.prior ? [{ role: 'user' as const, content: renderPrior(input.prior, input.priorAnswerSummary) }] : []),
    { role: 'user', content: `QUESTION: ${input.question}` },
  ];
  let attempts = 0;
  let lastProblems: IntentProblem[] = [];
  let lastDetail = '';
  let ledger: IntentLedger | undefined = input.ledger;
  const ledgerEntries: LedgerEntry[] = [];
  const round = input.ledgerRound ?? 0;
  let ledgerCorrected = false;
  while (attempts < maxAttempts + (timeoutRetried ? 1 : 0)) {
    attempts += 1;
    const started = now();
    const reply = await generateStructured(input.provider, messages, ANALYTICAL_INTENT_JSON_SCHEMA, input.providerOptions);
    input.onDispatch?.({ attempt: attempts, purpose: attempts === 1 ? 'resolve' : 'correct', raw: reply.raw, ms: now() - started });
    if (reply.error === 'provider_error') {
      // A provider that timed out is retried exactly once, on the same run
      // and request, when the budget can hold another full dispatch. Any
      // other provider failure ends the turn.
      if (reply.code === 'provider_timeout' && !timeoutRetried && (input.budgetMs ?? 0) > PROVIDER_TIMEOUT_RETRY_BUDGET_MS) {
        timeoutRetried = true;
        lastDetail = reply.detail ?? 'provider timeout';
        continue;
      }
      return { status: 'failed', reason: 'provider_error', detail: reply.detail ?? 'provider error', problems: [], attempts, ...(reply.code ? { code: reply.code } : {}) };
    }
    if (reply.error) {
      lastDetail = reply.detail ?? reply.error;
      messages.push({ role: 'assistant', content: reply.raw || '(empty)' }, { role: 'user', content: 'That was not a single JSON object matching the schema. Reply with ONLY the JSON object.' });
      continue;
    }
    const parsed = parseIntent(reply.json);
    if (!parsed.intent) {
      lastProblems = parsed.errors;
      lastDetail = parsed.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
      messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: correctionMessage(parsed.errors) });
      continue;
    }
    if (parsed.intent.kind === 'conversation') {
      // A why/should question over the previous analysis is not small talk:
      // a conversational reply would judge or explain from rows it cannot
      // compute, so it ends as the unsupported gap the analysis deserves,
      // naming what the previous reading can still answer.
      const operators = causalOperatorsIn(input.question);
      if (input.prior && operators.length > 0) {
        const question = `Explaining why something happened or recommending what to do (${operators.join(', ')}) is not something Ask computes from governed data; Research can investigate the drivers.`;
        const intent: AnalyticalIntentV1 = { ...input.prior, reading: parsed.intent.reading, unresolved: [{ clause: operators.join(', '), options: [], material: true, kind: 'unsupported', question }] };
        return { status: 'clarify', intent, question, options: [], attempts };
      }
      return { status: 'conversation', intent: parsed.intent, reply: parsed.intent.reply ?? parsed.intent.reading, attempts };
    }
    if (parsed.intent.kind === 'definition') return { status: 'definition', intent: parsed.intent, reply: parsed.intent.reply ?? parsed.intent.reading, attempts };
    // The first analytics reading of the original question writes the ledger;
    // every later reading is held to it.
    if (!ledger) ledger = buildLedger(input.question, parsed.intent, input.vocabulary);
    else {
      const audit = auditLedger(input.question, parsed.intent, ledger, input.vocabulary);
      ledgerEntries.push(...audit.entries.map((entry) => ({ ...entry, round })));
      if (audit.dropped.length > 0) {
        if (!ledgerCorrected && attempts < maxAttempts) {
          ledgerCorrected = true;
          lastDetail = `the reading dropped what the question asked for: ${audit.dropped.map((item) => item.clause).join('; ')}`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `Your reading dropped part of the question: ${audit.dropped.map((item) => `"${item.clause}"`).join(', ')}. A correction may bind these to governed refs that actually carry them, or keep them listed in unresolved as material with no options; it may not replace them with the closest available block or measure. Resend the COMPLETE JSON intent.` });
          continue;
        }
        // A second drop: the obligations come back as material clauses, so
        // the turn ends in the gap the question deserved, never in a
        // substitute answer.
        for (const item of audit.dropped) {
          parsed.intent.unresolved.push({ clause: item.clause, options: [], material: true, kind: item.kind ?? 'not_modeled', origin: 'ledger', question: item.question ?? `"${item.clause}" is something the project does not model as asked.` });
          ledgerEntries.push({ clause: item.clause, kind: item.kind, disposition: 'restored', round });
        }
      }
    }
    // The follow-up guard sends the interpreter back once. When its second
    // reading still replaces the previous analysis with words that name
    // nothing new, both readings are plausible and the user decides.
    const validation = validateIntentRefs(parsed.intent, input.vocabulary, input.prior, input.question);
    if (validation.followUpReplacement && attempts > 1 && input.prior) {
      const options = [...new Set([...input.prior.measures.map((measure) => measure.ref), ...validation.intent.measures.map((measure) => measure.ref)])];
      const label = (ref: string) => input.vocabulary.get(ref)?.label ?? input.vocabulary.get(ref)?.name ?? ref;
      const clarify: AnalyticalIntentV1 = { ...validation.intent, unresolved: [{ clause: input.question, options, material: true, question: `Keep the previous analysis (${input.prior.measures.map((measure) => label(measure.ref)).join(', ')}) and apply this as a correction, or switch to ${validation.intent.measures.map((measure) => label(measure.ref)).join(', ')}?` }] };
      return { status: 'clarify', intent: clarify, question: clarify.unresolved[0]!.question!, options, attempts };
    }
    if (validation.followUpReplacement && attempts > 1) validation.problems = validation.problems.filter((problem) => problem.message !== validation.followUpReplacement);
    const bare = isBareIntent(parsed.intent);
    const askedQuestions = new Map(validation.intent.unresolved.map((clause) => [clause, clause.question]));
    applyGovernedDefaults(validation.intent, input.question, input.vocabulary);
    proveTimeRoles(validation.intent, input.vocabulary);
    if (input.clauseCoverage !== false) proveClauseCoverage(input.question, validation.intent, input.vocabulary);
    // NO PARTIAL ANSWERS. When the interpreter wrote down nothing but a
    // clarification and the governed default supplied the only measure, the
    // rest of the question (a time axis, a grain, a member) is still
    // unaccounted for. The interpreter is sent back once for the complete
    // intent; if it still returns nothing else, the user is asked, never
    // served a scalar for a breakdown.
    if (bare && validation.problems.length === 0) {
      const defaulted = validation.intent.unresolved.filter((clause) => !clause.material && askedQuestions.get(clause) !== clause.question && clause.question?.startsWith('Read "'));
      if (defaulted.length > 0) {
        const leftover = unaccountedQuestionWords(input.question, validation.intent, input.vocabulary);
        if (leftover.length > 0) {
          if (attempts < maxAttempts) {
            lastDetail = `the question also says "${leftover.join(' ')}"; the intent must carry it`;
            messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The governed default reads ${defaulted.map((clause) => `"${clause.clause}" as ${validation.intent.measures.map((measure) => measure.ref).join(', ')}`).join('; ')}. Your intent carried nothing else, but the question also says "${leftover.join(' ')}". Resend the COMPLETE JSON intent: measures [${validation.intent.measures.map((measure) => measure.ref).join(', ')}] plus every other clause the question asks for (a groupBy time axis with its grain, a breakdown, a filter, an ordering, a limit), with unresolved: [].` });
            continue;
          }
          for (const clause of defaulted) { clause.material = true; clause.question = askedQuestions.get(clause) ?? clause.question; }
        }
      }
    }
    // NO PARTIAL ANSWERS, the period edition: a year the question names must
    // be a window (or a filter) on the intent. The interpreter is sent back
    // once for it; a second reading without it ends as a gap that names the
    // window-less reading rather than an all-time total posing as the year.
    if (validation.problems.length === 0 && validation.intent.kind === 'analytics' && !validation.intent.unresolved.some((clause) => clause.material)) {
      // NO PARTIAL ANSWERS, the grain edition: "by month" is a time grouping,
      // never a scalar over the period. One re-ask, then a material clause.
      const grain = droppedGrain(input.question, validation.intent, input.vocabulary);
      if (grain) {
        if (attempts < maxAttempts) {
          lastDetail = `the question asks for a ${grain} breakdown; the reading carries no time grouping`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question asks for a ${grain} breakdown, but your intent has no groupBy with role "time" and grain "${grain}". Resend the COMPLETE JSON intent with that time grouping on the measures' time dimension, keeping every other clause.` });
          continue;
        }
        validation.intent.unresolved.push({ clause: `by ${grain}`, options: [], material: true, kind: 'not_modeled', origin: 'ledger', question: `The question asked for a ${grain} breakdown; a reading without that grain does not answer it.` });
      }
      const years = droppedYears(input.question, validation.intent, input.vocabulary);
      if (years.length > 0) {
        if (attempts < maxAttempts) {
          lastDetail = `the question names the period ${years.join(', ')}; the intent carries no time window for it`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question names the period "${years.join(', ')}", but your intent carries no time window or filter for it. Resend the COMPLETE JSON intent with time.window covering ${years.join(', ')} (start and end dates, and the expression) on the measures' time dimension, keeping every other clause.` });
          continue;
        }
        validation.intent.unresolved.push({ clause: years.join(', '), options: [], material: true, kind: 'not_modeled', question: `The period "${years.join(', ')}" could not be applied to this reading, so it was not answered as an all-time total.` });
      }
    }
    const material = validation.intent.unresolved.find((clause) => clause.material);
    if (validation.problems.length === 0 || (material && validation.problems.every((problem) => problem.path === 'measures'))) {
      if (material) {
        return { status: 'clarify', intent: validation.intent, question: material.question ?? `Which did you mean for "${material.clause}"?`, options: material.options, attempts, ...(ledger ? { ledger, ledgerEntries } : {}) };
      }
      return { status: 'resolved', intent: validation.intent, attempts, problems: [], ...(ledger ? { ledger, ledgerEntries } : {}) };
    }
    lastProblems = validation.problems;
    lastDetail = validation.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
    messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: correctionMessage(validation.problems) });
  }
  return { status: 'failed', reason: lastProblems.length ? 'invalid' : 'unparseable', detail: lastDetail, problems: lastProblems, attempts };
}

export { intentRefs };
