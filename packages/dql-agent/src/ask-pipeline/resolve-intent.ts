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

export type IntentResolution =
  | { status: 'resolved'; intent: AnalyticalIntentV1; attempts: number; problems: IntentProblem[] }
  | { status: 'clarify'; intent: AnalyticalIntentV1; question: string; options: string[]; attempts: number }
  | { status: 'conversation'; intent: AnalyticalIntentV1; reply: string; attempts: number }
  | { status: 'definition'; intent: AnalyticalIntentV1; reply: string; attempts: number }
  | { status: 'failed'; reason: 'provider_error' | 'unparseable' | 'invalid'; detail: string; problems: IntentProblem[]; attempts: number };

const MEASURE_KINDS: VocabularyKind[] = ['metric', 'measure', 'column', 'block'];
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
    '6. TIME. A time axis ("by month") is a groupBy with role time and a grain, using the time dimension of the SAME model as the measure (an order total is by the orders model\'s time, an order-line revenue by the order line model\'s time). A time window ("last quarter", "in 2025") is `time.window` with an ISO half-open range plus the expression.',
    '7. CLARIFY ONLY WHAT IS MATERIAL. If two vocabulary entries are both plausible and the answer would differ (for example pretax product revenue vs order total including tax when the question says only "total revenue" and the project defines both), add an `unresolved` entry with material=true, the options as refs, and a one-sentence question. But: a metric whose NAME is the word the question uses ("revenue" is metric revenue, "lifetime spend" is metric lifetime_spend) IS the meaning; clarify only when the question adds a qualifier the vocabulary distinguishes ("gross", "including tax", "order revenue"). Never clarify which of two refs to use when they identify the same entity (a key column on the measure\'s model vs the entity on its own model): pick the one on the measure\'s model. Do not clarify spelling mistakes or obvious paraphrases; resolve them. Never ask whether a dimension or entity is reachable from a measure\'s model, or which join to take: the host proves join paths and grain after you answer. A material clause is only ever a choice between two or more refs, or an empty options list for something this project does not hold.',
    '8. KIND. Greetings, thanks, and questions about what you can do are kind "conversation" with a short `reply`. "What does X mean / how is X defined" is kind "definition" with a `reply` drawn from the vocabulary descriptions. Everything that asks for numbers or rows is kind "analytics". A question about something this project does not hold at all (weather, news, a different business) is kind "analytics" with no measures and one `unresolved` entry {clause: what was asked, options: [], material: true}: never a conversational reply, never a guessed metric.',
    '8b. BUSINESS TERMS ARE THE GOVERNED DEFAULT. When a term in the vocabulary defines a word of the question ("Revenue" defined as product revenue excluding tax), the metric that term names is the meaning; do not treat the word as ambiguous. Only two competing definitions with no governing term are material.',
    '8c. DISPLAY IS THE GRAIN\'S LABEL. A display ref is the name/label of an entity in groupBy (the customer\'s name beside the customer key). Never display an attribute of a finer grain (a supply name when grouping by product): it multiplies the rows.',
    '8d. A NUMERIC COLUMN IS A MEASURE. When the question asks for a quantity that exists only as a numeric column (no metric declares it), use its column: or dimension: ref as a measure with an aggregation (sum, avg, count). Report a clause as not modeled ONLY when no entry of any kind — metric, dimension, column, block, term — matches its words.',
    '9. PROVENANCE. For every ref you use, provenance[ref] is the phrase of the question it came from ("q:<phrase>"), or "inherited" when it is carried from the previous analysis.',
    ...(input.hasPrior ? [
      '10. THIS IS A FOLLOW-UP. The previous executed analysis is given below. Treat the new message as an EDIT of it: keep every clause the message does not change (mark it "inherited"), add or replace what it asks for, and for any prior ref you drop write provenance[ref] = "removed:<why>". "Include X" adds a display or measure and keeps everything else, including scope, ranking and limit. A short correction that repeats a word of the previous analysis ("I need the beverage category", "no, drinks only") without a new measure or a new entity is an EDIT that keeps the previous measures, grain, ranking and limit. Only a message that names a new subject entirely ("what is Ryan Byrd\'s revenue") starts a new analysis; list the dropped refs as removed. When both readings are plausible, ask one bounded clarification instead of choosing.',
    ] : []),
    '',
    'OUTPUT: one JSON object matching this shape, nothing else. `reading` restates the question in one sentence as you understood it.',
    '{"version":1,"kind":"analytics","reading":"...","measures":[{"ref":"metric:...","scope":[{"ref":"dimension:...","op":"eq","values":["..."],"source":"question"}],"aggregation":"sum"}],"groupBy":[{"ref":"entity:...","role":"key"},{"ref":"dimension:...","role":"time","grain":"month"}],"display":["dimension:..."],"filters":[{"ref":"dimension:...","op":"eq","values":["literal"],"source":"question"}],"ordering":{"ref":"metric:...","direction":"desc"},"limit":10,"expectedShape":"ranking","unresolved":[],"provenance":{"metric:...":"q:phrase"},"reply":"only for conversation/definition"}',
    'Predicates always carry `values` as an array (one element for eq; the literal exactly as written). `scope` and `aggregation` are optional. Omit `ordering`, `limit` and `time` when the question has none.',
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
  const predicate = (p: IntentPredicate, path: string): IntentPredicate => ({ ...p, ref: canonical(p.ref, FILTER_KINDS, path) });
  const measures = intent.measures.map((measure, index) => {
    const ref = canonical(measure.ref, MEASURE_KINDS, `measures[${index}].ref`, (entry) =>
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
  const measureModels = new Set(measures.map((measure) => vocabulary.get(measure.ref)?.model).filter((model): model is string => Boolean(model)));
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
    ? { ...intent.ordering, ref: intent.ordering.ref.startsWith('measure:') && /^measure:\d+$/.test(intent.ordering.ref) ? intent.ordering.ref : canonical(intent.ordering.ref, [...MEASURE_KINDS, ...GROUP_KINDS], 'ordering.ref') }
    : undefined;
  const time = intent.time?.ref ? { ...intent.time, ref: canonical(intent.time.ref, ['dimension', 'column'], 'time.ref', (entry) => entry.roles.includes('time') ? undefined : `${entry.ref} is not a time dimension`) } : intent.time;
  const next: AnalyticalIntentV1 = { ...intent, measures, groupBy, display, filters, ...(ordering ? { ordering } : {}), ...(time ? { time } : {}) };
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
    if (!clause.material || clause.options.length > 0) continue;
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
    const known = (word: string) => priorWords.has(word) || [...priorWords].some((candidate) => trigramSimilarity(word, candidate) >= 0.6 || (word.length >= 5 && Math.abs(word.length - candidate.length) <= 2 && editDistance(word, candidate) <= 2));
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
    const distinct = [...new Set(clause.options)];
    if (distinct.length <= 1 && distinct.every((ref) => intentRefs(intent).includes(ref))) {
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
}

/**
 * Question words that name a vocabulary entry the intent does not use. Not a
 * refusal (the interpreter may have read them correctly as prose) but a
 * warning the reader sees beside the answer: "the question said beverage;
 * this reading does not use anything named beverage".
 */
export function uncoveredQuestionTerms(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  const used = new Set(intentRefs(intent));
  const usedText = [...used].map((ref) => `${ref} ${vocabulary.get(ref)?.name ?? ''} ${vocabulary.get(ref)?.label ?? ''} ${(vocabulary.get(ref)?.aliases ?? []).join(' ')} ${vocabulary.get(ref)?.description ?? ''}`).join(' ').toLowerCase();
  const out: string[] = [];
  for (const word of new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])) {
    if (['what', 'which', 'show', 'give', 'list', 'have', 'with', 'from', 'that', 'this', 'each', 'many', 'much', 'total', 'both', 'need', 'please', 'could', 'would', 'should', 'about', 'their', 'there', 'than', 'then', 'into', 'over', 'category', 'product', 'products', 'customer', 'customers'].includes(word)) continue;
    const hits = vocabulary.lookup(word, { limit: 3, minScore: 0.97 }).filter((hit) => hit.matchedOn === 'name' || hit.matchedOn === 'alias');
    if (!hits.length) continue;
    const stem = word.replace(/s$/, '');
    if (usedText.includes(stem)) continue;
    if (hits.some((hit) => used.has(hit.entry.ref))) continue;
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

export async function resolveIntent(input: ResolveIntentInput): Promise<IntentResolution> {
  const maxAttempts = Math.max(1, Math.min(3, input.maxAttempts ?? 2));
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
  while (attempts < maxAttempts) {
    attempts += 1;
    const started = now();
    const reply = await generateStructured(input.provider, messages, ANALYTICAL_INTENT_JSON_SCHEMA, input.providerOptions);
    input.onDispatch?.({ attempt: attempts, purpose: attempts === 1 ? 'resolve' : 'correct', raw: reply.raw, ms: now() - started });
    if (reply.error === 'provider_error') return { status: 'failed', reason: 'provider_error', detail: reply.detail ?? 'provider error', problems: [], attempts };
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
    if (parsed.intent.kind === 'conversation') return { status: 'conversation', intent: parsed.intent, reply: parsed.intent.reply ?? parsed.intent.reading, attempts };
    if (parsed.intent.kind === 'definition') return { status: 'definition', intent: parsed.intent, reply: parsed.intent.reply ?? parsed.intent.reading, attempts };
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
    applyGovernedDefaults(validation.intent, input.question, input.vocabulary);
    const material = validation.intent.unresolved.find((clause) => clause.material);
    if (validation.problems.length === 0 || (material && validation.problems.every((problem) => problem.path === 'measures'))) {
      if (material) {
        return { status: 'clarify', intent: validation.intent, question: material.question ?? `Which did you mean for "${material.clause}"?`, options: material.options, attempts };
      }
      return { status: 'resolved', intent: validation.intent, attempts, problems: [] };
    }
    lastProblems = validation.problems;
    lastDetail = validation.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
    messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: correctionMessage(validation.problems) });
  }
  return { status: 'failed', reason: lastProblems.length ? 'invalid' : 'unparseable', detail: lastDetail, problems: lastProblems, attempts };
}

export { intentRefs };
