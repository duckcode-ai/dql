import { createHash } from 'node:crypto';
import type { AgentProvider, ProviderRunOptions } from '../providers/types.js';
import { executeCandidate, fillPeriodGaps, type ExecuteDeps, type ExecutedRows } from './execute.js';
import { describeIntent, intentExecutionFingerprint, type AnalyticalIntentV1, type IntentPredicate } from './intent.js';
import { composeAnsweredText, composeFailedText, composeGapText, describeResultColumns, labelFor, type GapKind, type PipelineOutcome, type PipelineReceipt } from './outcomes.js';
import { prepare, type PrepareDeps, type PreparedCandidate, type PreparedRefusal, type PrepareResult } from './prepare/index.js';
import { keepMembersApart, resolveIntent, uncoveredQuestionTerms, unmetFacets, type IntentResolution } from './resolve-intent.js';
import type { VocabularyEntry, VocabularyIndex } from './vocabulary.js';

/**
 * INTENT → PREPARE → EXECUTE, as one host-neutral function.
 *
 * The host supplies the vocabulary, the provider, the compilers and the
 * warehouse; this function owns the order and the bounds. Bounds are a
 * wall-clock deadline, one bounded corrective re-ask, one preparation
 * repair, and the rule that an unchanged failed attempt is never repeated
 * (the fingerprint of intent + tier + bindings is remembered). Every
 * provider call is reported so the host's one ledger counts it.
 */

export interface PreparationCache {
  get(key: string): PreparedCandidate | undefined;
  set(key: string, candidate: PreparedCandidate): void;
}

export interface RunAskPipelineInput {
  question: string;
  vocabulary: VocabularyIndex;
  provider: AgentProvider;
  prepareDeps: PrepareDeps;
  executeDeps: ExecuteDeps;
  prior?: AnalyticalIntentV1;
  /** False when the prior turn was blocked: its question stands, its result does not exist. */
  priorExecuted?: boolean;
  priorAnswerSummary?: string;
  guidance?: string;
  /** The governed meaning the user picked from a clarification's options. */
  selection?: { ref: string; label?: string };
  /** False for research branches: their questions are hypotheses, not asks for causes or decisions. */
  clauseCoverage?: boolean;
  explorationOptIn?: boolean;
  deadlineMs?: number;
  cardBudget?: number;
  providerOptions?: ProviderRunOptions;
  preparationCache?: PreparationCache;
  /** Keys that make a prepared executable reusable: snapshot, engine, target, policy. */
  cacheScope?: string;
  build?: Record<string, string>;
  now?: () => number;
  trace?: (event: { stage: string; detail?: unknown }) => void;
  /**
   * Host-owned literal grounding: replace a member literal with the value
   * the warehouse actually holds (its casing, its spelling) on columns the
   * project explicitly allowlists, and say so. Never invents a value.
   */
  groundLiterals?: (intent: AnalyticalIntentV1) => Promise<{ intent: AnalyticalIntentV1; notes: string[] }>;
  /**
   * The members of a column whose stored value CONTAINS a literal, asked only
   * after an exact match on that same column returned nothing. "Curry" is not
   * absent from the data; it names two players, and the honest answer shows
   * both rather than reporting the surname as unknown.
   */
  suggestMembers?: (ref: string, literal: string) => Promise<string[]>;
  /**
   * The member the user picked from an identity clarification: the dimension
   * and the values chosen. A name that reads several people is settled by the
   * person asking, never by the interpreter's prose or by adding them up.
   */
  memberSelection?: { ref: string; values: string[] };
}

const fingerprintSql = (sql: string) => `sha256:${createHash('sha256').update(sql).digest('hex').slice(0, 24)}`;

function summarizeRefusal(refusal: PreparedRefusal): string {
  const firstLine = refusal.message.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? refusal.message;
  const clipped = firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
  return refusal.code === 'semantic_compile_failed' ? `the semantic engine could not compile this reading: ${clipped}` : clipped;
}

function gapFromRefusals(refusals: PreparedRefusal[], intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): { gap: GapKind; message: string; nearest: string[] } {
  const denied = refusals.find((refusal) => refusal.code === 'policy_denied');
  if (denied) return { gap: 'denied', message: denied.message, nearest: [] };
  const unresolved = intent.unresolved.filter((clause) => clause.material);
  if (unresolved.length) return { gap: 'ambiguous', message: unresolved.map((clause) => clause.clause).join('; '), nearest: unresolved.flatMap((clause) => clause.options) };
  const compile = refusals.find((refusal) => refusal.code === 'semantic_compile_failed' || refusal.code === 'relational_compose_failed' || refusal.code === 'join_path_required' || refusal.code === 'measure_scope_not_expressible');
  const nearest = [...new Set(intent.measures.flatMap((measure) => vocabulary.suggest(measure.ref, 3).map((entry) => entry.ref)))].filter((ref) => !intent.measures.some((measure) => measure.ref === ref)).slice(0, 5);
  // The reader gets the first line of the engine's message; the receipt keeps it verbatim.
  if (compile) return { gap: 'unsupported', message: summarizeRefusal(compile), nearest };
  // The deepest governed refusal is the one worth reading. A project with no
  // certified blocks refuses at the certified tier for every question ever
  // asked, so "the project has no certified block" tells nobody why THIS
  // question stopped; the binding or composition failure underneath does.
  const depth = (refusal: PreparedRefusal): number => (refusal.code === 'no_certified_block' ? 3 : refusal.tier === 'certified' ? 2 : refusal.tier === 'semantic' ? 1 : 0);
  const deepest = [...refusals.filter((refusal) => refusal.tier !== 'exploratory')].sort((left, right) => depth(left) - depth(right))[0];
  return { gap: 'not_modeled', message: deepest?.message ?? 'no governed tier could prepare the intent', nearest };
}

/**
 * THE LABEL THE QUESTION ASKED FOR. "Which teams" is answered by names. When a
 * repair dropped the requested label because no governed relationship reaches
 * it, the rows carry a key and nothing else. The numbers may still be right,
 * so the answer is served, but the omission is named and the check does not
 * pass: opaque identifiers do not answer "which".
 */
export function unmetDisplayObligation(
  requested: string[],
  intent: AnalyticalIntentV1,
  refusals: PreparedRefusal[],
  label: (ref: string) => string,
  question?: string,
): { message: string; refs: string[] } | undefined {
  const keys = intent.groupBy.filter((group) => group.role === 'key');
  if (keys.length === 0 || intent.display.length > 0) return undefined;
  const lost = requested.filter((ref) => !intent.display.includes(ref) && !intent.groupBy.some((group) => group.ref === ref) && !(intent.provenance[ref] ?? '').startsWith('removed'));
  // A question that asks WHICH ones is answered by names. Even when no reading
  // ever asked for the label, rows identified only by a key have not answered
  // it — unless the question asked for the ids themselves.
  const asksWhich = Boolean(question && /\b(which|who|whom|whose|name|names|list)\b/i.test(question) && !/\b(id|ids|identifier|identifiers|key|keys)\b/i.test(question));
  if (lost.length === 0 && !asksWhich) return undefined;
  const join = refusals.find((refusal) => refusal.code === 'join_path_required');
  const because = join ? `, because ${summarizeRefusal(join).replace(/^no governed join path/, 'no governed relationship reaches it')}` : ' from this reading';
  const identified = keys.map((group) => label(group.ref)).join(', ');
  return {
    message: lost.length
      ? `the rows are identified by ${identified} only: ${lost.map((ref) => label(ref)).join(', ')} could not be shown beside them${because}`
      : `the rows are identified by ${identified} only: this project's governed vocabulary reaches no human-readable label for them${because}`,
    refs: lost,
  };
}

/** Words a capitalised run may start with and still be a name the question stresses. */
const NAME_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'by', 'to', 'from', 'at', 'with', 'show', 'give', 'compare', 'how', 'what', 'which', 'who', 'whose', 'when', 'where', 'why', 'did', 'do', 'does', 'is', 'are', 'was', 'were', 'our', 'my', 'their', 'his', 'her', 'its']);

/**
 * A NAME THE QUESTION LEANS ON. Capitalised runs of the question that are not
 * its first word, not vocabulary words, and not numbers: the candidates for
 * "whose facts is this about". This is a hint, never a proof — everything
 * built on it must be confirmed against the warehouse before it changes an
 * answer.
 */
export function namesInQuestion(question: string, vocabulary: VocabularyIndex): string[] {
  const names: string[] = [];
  for (const sentence of question.split(/(?<=[.?!])\s+/)) {
    const tokens = [...sentence.matchAll(/[A-Za-z][A-Za-z'`.-]*/g)];
    let run: string[] = [];
    let runStart = -1;
    const flush = () => {
      if (run.length > 0) {
        const first = run[0]!.toLowerCase();
        const capitalisedStart = runStart > 0 || run.length > 1;
        // A possessive is the name plus grammar: "LeBron James's" is a man.
        if (capitalisedStart && !NAME_STOPWORDS.has(first)) names.push(run.join(' ').replace(/['’]s$/i, '').replace(/[.'’]+$/, ''));
      }
      run = [];
    };
    for (const [index, token] of tokens.entries()) {
      const word = token[0];
      if (/^[A-Z]/.test(word) && !NAME_STOPWORDS.has(word.toLowerCase())) {
        if (run.length === 0) runStart = index;
        run.push(word);
        continue;
      }
      flush();
    }
    flush();
  }
  // A word this project already names something by is a term, not a person.
  return [...new Set(names)].filter((name) => !vocabulary.lookup(name, { limit: 1, minScore: 0.9 }).length);
}

/**
 * THE SUBJECT THE READING CLAIMS MUST BE IN THE POPULATION. An interpretation
 * that says "LeBron James's total points" and restricts nobody answers for
 * every player in the warehouse under one man's name, and every check passes:
 * the SQL is valid, the filters it does carry are all applied, the number is
 * real. The host therefore checks the reading's own claim against its own
 * filters, and where a name is missing it asks the warehouse whether that name
 * is a member. A member it confirms becomes the restriction the reading
 * promised; a name the warehouse does not hold changes nothing, because this
 * reading of prose is a hint and a hint may not rewrite an answer.
 */
export async function bindNamedSubject(
  intent: AnalyticalIntentV1,
  question: string,
  vocabulary: VocabularyIndex,
  suggestMembers: (ref: string, literal: string) => Promise<string[]>,
  maxProbes = 3,
): Promise<string[]> {
  if (intent.kind !== 'analytics') return [];
  // A filter carries a name only when it carries THAT name. "Curry" is not
  // Stephen Curry: a broader match is exactly the case where the reading names
  // one person and the query reads several, and it is what this proves away.
  const bound = new Set(intent.filters.flatMap((filter) => filter.values.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase())));
  const claimed = namesInQuestion(question, vocabulary)
    .filter((name) => intent.reading.toLowerCase().includes(name.toLowerCase()))
    .filter((name) => !bound.has(name.toLowerCase()));
  if (claimed.length === 0) return [];
  // Only the label columns of the relations this reading already reads.
  const relations = new Set(intent.measures.flatMap((measure) => {
    const refs = measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref];
    return refs.map((ref) => vocabulary.get(ref)?.physical?.relation).filter((relation): relation is string => Boolean(relation));
  }));
  // A column that can hold a person's name: not a date, a number, a flag or a
  // key. The role is a hint and not every project spells its label columns the
  // same way — a dimension called "player" over a player_name column is a
  // label whatever the heuristic said — so the columns a name COULD live in
  // are probed, most likely first, and the warehouse decides.
  const named = (entry: VocabularyEntry): boolean =>
    (entry.kind === 'dimension' || entry.kind === 'column')
    && Boolean(entry.physical?.relation)
    && !entry.roles.some((role) => role === 'time' || role === 'numeric' || role === 'boolean' || role === 'key' || role === 'measure');
  const rank = (entry: VocabularyEntry): number =>
    Number(relations.has(entry.physical!.relation)) * 2 + Number(entry.roles.includes('label'));
  const labels = vocabulary.entries.filter(named).sort((left, right) => rank(right) - rank(left));
  const notes: string[] = [];
  let probes = 0;
  for (const name of claimed) {
    for (const entry of labels) {
      if (probes >= maxProbes) return notes;
      probes += 1;
      let members: string[] = [];
      try { members = await suggestMembers(entry.ref, name); } catch { continue; }
      const exact = members.find((member) => member.toLowerCase() === name.toLowerCase());
      if (!exact) continue;
      // A broader restriction on the same column is REPLACED, not added to:
      // "contains Curry" beside "is Stephen Curry" would read as both.
      const existing = intent.filters.findIndex((filter) => filter.ref === entry.ref && filter.on !== 'aggregate');
      const broadened = existing >= 0;
      const applied: IntentPredicate = { ref: entry.ref, op: 'eq', values: [exact], source: 'question' };
      if (broadened) intent.filters[existing] = applied; else intent.filters.push(applied);
      intent.provenance[entry.ref] = `host:the reading is about ${exact}, and the warehouse holds that member: the reading's own subject is what the query reads`;
      notes.push(`identity: the reading names ${JSON.stringify(exact)} and the restriction ${broadened ? 'was broader than that name' : 'was missing'}; ${entry.label ?? entry.name} holds that member exactly, so the query reads it`);
      return notes;
    }
  }
  return notes;
}

/** The id an identity clarification option carries: the dimension, and the values the user picked. */
export function memberOptionId(ref: string, values: string[]): string {
  return `member:${ref}=${JSON.stringify(values)}`;
}

/** The dimension and values behind such an id; anything else is not one. */
export function parseMemberOption(id: string): { ref: string; values: string[] } | undefined {
  if (!id.startsWith('member:')) return undefined;
  const split = id.indexOf('=');
  if (split <= 'member:'.length) return undefined;
  const ref = id.slice('member:'.length, split);
  try {
    const values = JSON.parse(id.slice(split + 1)) as unknown;
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string') || values.length === 0) return undefined;
    return { ref, values: values as string[] };
  } catch { return undefined; }
}

/**
 * THE MEMBER THE USER PICKED. An identity clarification comes back as the
 * dimension and the values chosen: the reading's filter on that dimension
 * becomes exactly those values, and several chosen members are separated so
 * each one keeps its own row. The user settles an identity the data could not.
 */
export function applyMemberSelection(intent: AnalyticalIntentV1, selection: { ref: string; values: string[] }, vocabulary: VocabularyIndex): void {
  if (intent.kind !== 'analytics' || selection.values.length === 0) return;
  const applied: IntentPredicate = { ref: selection.ref, op: selection.values.length === 1 ? 'eq' : 'in', values: [...selection.values], source: 'clarification' };
  const index = intent.filters.findIndex((filter) => filter.ref === selection.ref && filter.on !== 'aggregate');
  if (index >= 0) intent.filters[index] = applied; else intent.filters.push(applied);
  intent.provenance[selection.ref] = `clarification:the ${selection.values.length === 1 ? 'member' : 'members'} you chose`;
  const subject = selection.values.join(', ');
  if (!selection.values.every((value) => intent.reading.toLowerCase().includes(value.toLowerCase()))) {
    intent.reading = `${intent.reading.replace(/[.\s]+$/, '')} — for ${subject}.`;
  }
  if (selection.values.length > 1) keepMembersApart(intent, vocabulary);
}

/**
 * THE SUBJECT AND THE POPULATION ARE THE SAME THING. A member filter carrying
 * several values reads several members; with no breakdown at all, their facts
 * are added into one row that belongs to nobody — and the prose above it will
 * still name whoever the interpreter had in mind. The proof is structural: it
 * never reads the prose, and it runs before an executable is accepted, so no
 * path that widens a filter can serve one name over many people's numbers.
 */
export function proveSubjectMatchesPopulation(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string | undefined {
  if (intent.kind !== 'analytics' || intent.groupBy.length > 0) return undefined;
  for (const filter of intent.filters) {
    if (filter.on === 'aggregate') continue;
    const values = filter.values.filter((value): value is string => typeof value === 'string');
    if (values.length < 2) continue;
    const entry = vocabulary.get(filter.ref);
    if (!entry || (entry.kind !== 'dimension' && entry.kind !== 'column' && entry.kind !== 'entity')) continue;
    if (entry.roles.includes('time') || entry.roles.includes('numeric') || entry.roles.includes('boolean')) continue;
    return `${entry.label ?? entry.name} reads ${values.length} members (${values.join(', ')}) and the reading separates none of them: one row would carry all of their facts together`;
  }
  return undefined;
}

/** Guidance that carries a settled identity into the reading the interpreter writes. */
function memberGuidance(input: RunAskPipelineInput): string | undefined {
  if (!input.memberSelection) return input.guidance;
  const chosen = input.memberSelection.values.join(', ');
  const said = `The person asking has settled who this is about: ${chosen}. Read the question about ${input.memberSelection.values.length === 1 ? 'that member' : 'those members'} and name no other.`;
  return input.guidance ? `${input.guidance}\n${said}` : said;
}

export async function runAskPipeline(input: RunAskPipelineInput): Promise<PipelineOutcome> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const deadline = input.deadlineMs ? started + input.deadlineMs : undefined;
  const timings: Record<string, number> = {};
  const receipt: PipelineReceipt = {
    version: 1, vocabularyFingerprint: input.vocabulary.fingerprint, dispatches: [], candidates: [], refusals: [], tiers: [], timings, reuse: 'none',
    ...(input.build ? { build: input.build } : {}),
  };
  // Every warehouse dispatch is counted; a failed statement is an attempt, not "no query ran".
  const countedExecute: typeof executeCandidate = async (...args) => {
    receipt.warehouse = { attempts: (receipt.warehouse?.attempts ?? 0) + 1, failures: receipt.warehouse?.failures ?? 0, executions: receipt.warehouse?.executions ?? 0 };
    const executed = await executeCandidate(...args);
    if (!executed.ok && executed.code === 'execution_failed') receipt.warehouse.failures += 1;
    else receipt.warehouse.executions = (receipt.warehouse.executions ?? 0) + 1;
    return executed;
  };
  const label = labelFor(input.vocabulary);
  const remaining = () => (deadline ? deadline - now() : Number.POSITIVE_INFINITY);
  const mark = (stage: string, from: number) => { timings[stage] = Math.round(now() - from); input.trace?.({ stage, detail: timings[stage] }); };

  // 1. Resolve.
  const resolveStarted = now();
  let resolution: IntentResolution = await resolveIntent({
    question: input.question, vocabulary: input.vocabulary, provider: input.provider, prior: input.prior, priorExecuted: input.priorExecuted, priorAnswerSummary: input.priorAnswerSummary, clauseCoverage: input.clauseCoverage, budgetMs: remaining(), ...(input.selection ? { selection: input.selection } : {}),
    guidance: memberGuidance(input), cardBudget: input.cardBudget, providerOptions: input.providerOptions, now,
    maxAttempts: remaining() > 15_000 ? 2 : 1,
    onDispatch: (event) => receipt.dispatches.push({ purpose: `intent:${event.purpose}`, ms: event.ms, reply: event.raw.slice(0, 1500) }),
  });
  mark('resolve', resolveStarted);
  const recordLedger = (resolved: IntentResolution) => {
    if (resolved.status !== 'resolved' && resolved.status !== 'clarify') return;
    if (!resolved.ledger) return;
    receipt.ledger = { clauses: resolved.ledger.clauses.map((clause) => ({ clause: clause.clause, ...(clause.kind ? { kind: clause.kind } : {}) })), ...(resolved.ledger.timeGrain ? { timeGrain: resolved.ledger.timeGrain } : {}), measures: resolved.ledger.measures, entries: [...(receipt.ledger?.entries ?? []), ...(resolved.ledgerEntries ?? [])] };
  };
  recordLedger(resolution);
  if (resolution.status === 'failed') {
    // The reader gets one sentence; the receipt keeps the provider's words.
    const timedOut = resolution.reason === 'provider_error' && resolution.code === 'provider_timeout';
    const message = timedOut ? 'the AI model took too long to read the question; retry the same question' : resolution.reason === 'provider_error' ? `the AI model did not respond (${resolution.detail})` : resolution.reason === 'unparseable' ? 'the AI reply was not a readable interpretation' : `the interpretation named things that do not exist: ${resolution.detail}`;
    receipt.failure = { stage: 'resolve', reason: timedOut ? 'provider_timeout' : resolution.reason, message: timedOut ? `${message} (${resolution.detail})` : message, problems: resolution.problems };
    return { kind: 'failed', stage: 'resolve', message, text: composeFailedText('resolve', message), receipt };
  }
  if (resolution.status === 'conversation' || resolution.status === 'definition') {
    receipt.intent = resolution.intent;
    return { kind: resolution.status, reply: resolution.reply, text: resolution.reply, receipt, intent: resolution.intent };
  }
  receipt.intent = resolution.intent;
  receipt.reading = resolution.intent.reading;
  // A DESCRIPTION IS NOT A RECOMMENDATION, AND REFUSING ONE SHOULD NOT WITHHOLD
  // THE OTHER. "Which of these should we build around, and why?" carries a
  // reading this project can measure and a judgment it cannot compute. Naming
  // the measurable part in prose and running nothing leaves the reader to ask
  // the same question again in smaller words; so the comparison is delivered,
  // and the judgment is refused out loud rather than quietly attempted.
  let judgmentCaveat: string | undefined;
  if (resolution.status === 'clarify') {
    const material = resolution.intent.unresolved.filter((clause) => clause.material);
    const operators = material.filter((clause) => clause.kind === 'unsupported' && clause.options.length === 0);
    if (operators.length > 0 && operators.length === material.length && resolution.intent.measures.length > 0) {
      for (const clause of operators) clause.material = false;
      judgmentCaveat = `${operators.map((clause) => `"${clause.clause}"`).join(' and ')} ${operators.length === 1 ? 'is' : 'are'} not computed here: what follows is the measured comparison, not a recommendation and not a cause. Research can investigate the drivers`;
      resolution = { status: 'resolved', intent: resolution.intent, attempts: resolution.attempts, problems: [], ...(resolution.ledger ? { ledger: resolution.ledger } : {}), ...(resolution.ledgerEntries ? { ledgerEntries: resolution.ledgerEntries } : {}) };
    }
  }
  if (resolution.status === 'clarify') {
    const options = resolution.options.map((ref) => ({ ref, label: label(ref), ...(input.vocabulary.get(ref)?.description ? { description: input.vocabulary.get(ref)!.description } : {}) }));
    // A continuity question the host asked (which population does this
    // follow-up mean?) has no options and no unresolved clause: it is a real
    // question for the user, not a modeling gap.
    if (options.length === 0 && !resolution.intent.unresolved.some((item) => item.material)) {
      return { kind: 'clarify', intent: resolution.intent, question: resolution.question, options, text: resolution.question, receipt };
    }
    if (options.length === 0) {
      // Nothing to choose between: the project simply does not hold it.
      const materials = resolution.intent.unresolved.filter((item) => item.material);
      const material = materials[0];
      const clause = material?.clause ?? input.question;
      // No partial answers: nothing executes, but the reading that WAS
      // answerable is named so the user can ask for exactly that.
      const answerable = resolution.intent.measures.length > 0 ? ` Answerable from this reading: ${describeIntent(resolution.intent, label).replace(/[.\s]+$/, '')}.` : '';
      // When the reading itself carries nothing, name the measures this
      // project does hold for the words the question used: a refusal that
      // points at the answerable neighbour is worth more than a full stop.
      const nearestMeasures = resolution.intent.measures.length === 0
        ? [...new Set(input.vocabulary.lookup(input.question, { limit: 6, minScore: 0.5 }).map((hit) => hit.entry).filter((entry) => entry.kind === 'metric' || entry.kind === 'measure').map((entry) => entry.label ?? entry.name))].slice(0, 3)
        : [];
      const offered = nearestMeasures.length ? ` This project does measure ${nearestMeasures.join(', ')}: ask for ${nearestMeasures.length === 1 ? 'it' : 'one of them'} over a period and I can show it.` : '';
      if (material?.kind === 'unsupported') {
        // Every clause the project cannot serve is named, not only the first.
        const message = materials.map((item) => item.question ?? `"${item.clause}" asks for an operation Ask does not perform`).map((text) => text.replace(/[.\s]+$/, '')).join('. ');
        return { kind: 'gap', gap: 'unsupported', message, nearest: [], text: `${composeGapText('unsupported', message.replace(/[.\s]+$/, ''), [], false)}${answerable}${offered}`, receipt, intent: resolution.intent, offerExploration: false };
      }
      const nearest = input.vocabulary.lookup(clause, { limit: 4, minScore: 0.5 }).map((hit) => label(hit.entry.ref));
      // A clause that came with its own explanation says more than the
      // generic sentence: read it out instead of restating the clause.
      const message = material?.question ?? `"${clause}" is not something this project's governed data describes`;
      return { kind: 'gap', gap: 'not_modeled', message, nearest, text: `${composeGapText('not_modeled', message.replace(/[.\s]+$/, ''), nearest, false)}${answerable}${offered}`, receipt, intent: resolution.intent, offerExploration: false };
    }
    return { kind: 'clarify', intent: resolution.intent, question: resolution.question, options, text: resolution.question, receipt };
  }
  let intent = resolution.intent;
  if (input.memberSelection) applyMemberSelection(intent, input.memberSelection, input.vocabulary);
  // What the first reading promised to SHOW. A repair may drop a label the
  // engine could not reach; the answer must say so rather than quietly
  // identifying its rows by an opaque key.
  const requestedDisplay = [...resolution.intent.display];
  if (input.groundLiterals) {
    const groundStarted = now();
    try {
      const grounded = await input.groundLiterals(intent);
      intent = grounded.intent;
      if (grounded.notes.length) receipt.grounding = grounded.notes;
    } catch (error) {
      receipt.grounding = [`literal grounding skipped: ${error instanceof Error ? error.message : String(error)}`];
    }
    mark('ground', groundStarted);
  }
  // A name the reading leans on that the filters never carried is bound from
  // the warehouse before anything is prepared.
  if (input.suggestMembers && remaining() > 8_000) {
    try {
      const bound = await bindNamedSubject(intent, input.question, input.vocabulary, input.suggestMembers);
      if (bound.length) receipt.grounding = [...(receipt.grounding ?? []), ...bound];
    } catch { /* a probe that fails leaves the reading as the interpreter wrote it */ }
  }
  // Whatever produced this reading — the interpreter, a follow-up edit, the
  // host's own grounding — a single row may not carry several members' facts.
  if (proveSubjectMatchesPopulation(intent, input.vocabulary)) keepMembersApart(intent, input.vocabulary);
  const merged = proveSubjectMatchesPopulation(intent, input.vocabulary);
  if (merged) {
    receipt.failure = { stage: 'prepare', reason: 'subject_population_mismatch', message: merged };
    return { kind: 'gap', gap: 'ambiguous', message: merged, nearest: [], text: `${composeGapText('ambiguous', merged, [], false)} Name the one you mean, or ask for them side by side.`, receipt, intent, offerExploration: false };
  }
  // Grounding and the host's own proofs replace the intent object, so the
  // receipt must be repointed: a receipt showing a reading the query did not
  // run is exactly the mismatch this pipeline exists to prevent.
  receipt.intent = intent;
  receipt.reading = intent.reading;
  const uncovered = uncoveredQuestionTerms(input.question, intent, input.vocabulary);
  if (uncovered.length) receipt.uncovered = uncovered;

  // 2. Prepare (with cache and one bounded repair).
  const attempted = new Set<string>();
  let provedJoin = false;
  let prepared: PrepareResult | undefined;
  let firstPrepared: PrepareResult | undefined;
  let firstIntent: AnalyticalIntentV1 | undefined;
  let candidate: PreparedCandidate | undefined;
  for (let round = 0; round < 2; round += 1) {
    const prepareStarted = now();
    const cacheKey = `${input.cacheScope ?? ''}|${intentExecutionFingerprint(intent)}`;
    const cached = input.preparationCache?.get(cacheKey);
    if (cached) {
      candidate = cached;
      receipt.reuse = 'preparation';
      receipt.candidates.push({ tier: cached.tier, trust: cached.trust, proof: [...cached.proof, 'reused a previously validated preparation'], sqlFingerprint: fingerprintSql(cached.sql), ...(cached.engine ? { engine: cached.engine } : {}) });
      mark('prepare', prepareStarted);
      break;
    }
    if (attempted.has(cacheKey)) break; // never repeat an unchanged failed attempt
    attempted.add(cacheKey);
    prepared = await prepare({ intent, vocabulary: input.vocabulary, deps: input.prepareDeps, explorationOptIn: input.explorationOptIn });
    if (round === 0) { firstPrepared = prepared; firstIntent = intent; }
    mark(round === 0 ? 'prepare' : 'prepare_repair', prepareStarted);
    for (const item of prepared.candidates) receipt.candidates.push({ tier: item.tier, trust: item.trust, proof: item.proof, sqlFingerprint: fingerprintSql(item.sql), ...(item.engine ? { engine: item.engine } : {}) });
    receipt.refusals.push(...prepared.refusals);
    receipt.tiers.push(...prepared.attempts.map((attempt) => ({ round, ...attempt })));
    if (prepared.chosen) { candidate = prepared.chosen; break; }
    // A RELATIONSHIP NOBODY DECLARED MAY STILL HOLD. Before spending a
    // dispatch on rewriting the question, ask the warehouse whether the key
    // this reading needs is unique in the relation that carries the label and
    // covers every row of the facts. A proof admits the join and the same
    // reading is prepared again; no proof, and the refusal stands.
    const needsJoin = prepared.refusals.find((refusal) => refusal.code === 'join_path_required' && refusal.relations);
    if (needsJoin?.relations && input.prepareDeps.proveJoinPath && !provedJoin && remaining() > 8_000) {
      provedJoin = true;
      const proveStarted = now();
      let proven: unknown;
      try { proven = await input.prepareDeps.proveJoinPath(needsJoin.relations[0], needsJoin.relations[1]); } catch { proven = undefined; }
      mark('prove_join', proveStarted);
      if (proven) {
        receipt.grounding = [...(receipt.grounding ?? []), `relationship: no declared relationship reaches ${needsJoin.relations[1]} from ${needsJoin.relations[0]}, and the warehouse proved one (the key is unique there and covers every row of the facts)`];
        attempted.delete(cacheKey);
        round -= 1;
        continue;
      }
    }
    // One bounded repair: a repairable compile refusal goes back to the resolver with the engine's words.
    const repairable = prepared.refusals.find((refusal) => refusal.repairable);
    if (!repairable || round > 0 || remaining() < 12_000) break;
    const repairStarted = now();
    resolution = await resolveIntent({
      question: `${input.question}\n\nThe previous interpretation could not be prepared. ${repairable.tier === 'certified' ? 'The certified block is not applicable: ' : 'The engine said: '}${repairable.message}. ${repairable.tier === 'certified' ? 'Express the analysis with metric, entity and dimension refs instead of the block.' : 'Choose refs the engine can bind.'}`,
      vocabulary: input.vocabulary, provider: input.provider, prior: input.prior, priorExecuted: input.priorExecuted, guidance: input.guidance, cardBudget: input.cardBudget, providerOptions: input.providerOptions, now, maxAttempts: 1, clauseCoverage: input.clauseCoverage, ...(input.selection ? { selection: input.selection } : {}),
      // The repair is held to the original question's obligations.
      ...(resolution.status === 'resolved' && resolution.ledger ? { ledger: resolution.ledger, ledgerRound: round + 1 } : {}),
      onDispatch: (event) => receipt.dispatches.push({ purpose: 'intent:repair', ms: event.ms, reply: event.raw.slice(0, 1500) }),
    });
    mark('resolve_repair', repairStarted);
    recordLedger(resolution);
    if (resolution.status !== 'resolved') {
      receipt.failure = { stage: 'prepare', reason: `repair_${resolution.status}`, message: resolution.status === 'failed' ? resolution.detail : resolution.status === 'clarify' ? resolution.question : resolution.status, ...(resolution.status === 'failed' ? { problems: resolution.problems } : {}) };
      // A repair that came back with a QUESTION is a question for the user, not
      // an engine failure: asking it is the honest end of the turn, and the
      // compiler's message stays in the receipt.
      // ... unless a certified block is still standing as the answer of last
      // resort: serving what the team certified beats asking again.
      const fallbackWaiting = Boolean(prepared?.fallbacks?.[0] ?? firstPrepared?.fallbacks?.[0]);
      if (resolution.status === 'clarify' && resolution.question && !fallbackWaiting) {
        receipt.intent = resolution.intent;
        const options = resolution.options.map((ref) => ({ ref, label: label(ref), ...(input.vocabulary.get(ref)?.description ? { description: input.vocabulary.get(ref)!.description } : {}) }));
        return { kind: 'clarify', intent: resolution.intent, question: resolution.question, options, text: resolution.question, receipt };
      }
      break;
    }
    intent = resolution.intent;
    receipt.intent = intent;
  }
  // The answer of last resort: a certified block refused only for label-only
  // identity is served as published, with its caveat, when the repair re-ask
  // could not express the analysis by entity key. Never a dead end.
  if (!candidate) {
    const fallback = prepared?.fallbacks?.[0] ?? firstPrepared?.fallbacks?.[0];
    if (fallback) {
      // Served from the certified block, but not certified FOR this question:
      // the badge is governed, the source stays the block.
      candidate = { ...fallback, trust: 'governed' };
      if (firstPrepared && fallback === firstPrepared.fallbacks[0]) intent = firstIntent ?? intent;
      receipt.intent = intent;
      for (let index = receipt.refusals.length - 1; index >= 0; index -= 1) {
        if (receipt.refusals[index]!.tier === 'certified' && /no identity key/.test(receipt.refusals[index]!.message)) receipt.refusals.splice(index, 1);
      }
      receipt.candidates.push({ tier: fallback.tier, trust: fallback.trust, proof: fallback.proof, sqlFingerprint: fingerprintSql(fallback.sql) });
      receipt.tiers.push({ round: 99, tier: 'certified', outcome: 'prepared', detail: 'served as published: no keyed governed answer could be composed' });
    }
  }
  if (!candidate) {
    const gap = gapFromRefusals(receipt.refusals, intent, input.vocabulary);
    const offerExploration = !input.explorationOptIn && receipt.refusals.some((refusal) => refusal.code === 'exploration_not_opted_in');
    return { kind: 'gap', gap: gap.gap, message: gap.message, nearest: gap.nearest.map(label), text: composeGapText(gap.gap, gap.message, gap.nearest.map(label), offerExploration), receipt, intent, offerExploration };
  }

  // 3. Execute and prove. A candidate that fails a proof (a dropped filter, a
  // multiplying join) is refused and the next governed tier is prepared for
  // the same intent; an unchanged attempt is never repeated.
  const excluded: PreparedCandidate['tier'][] = [];
  let executeStarted = now();
  let executed = await countedExecute(candidate, intent, input.executeDeps);
  mark('execute', executeStarted);
  while (!executed.ok && (executed.code === 'filter_not_applied' || executed.code === 'fanout_detected') && excluded.length < 3 && remaining() > 5_000) {
    receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: false } as unknown as PreparedRefusal);
    receipt.tiers.push({ round: 9, tier: candidate.tier, outcome: 'refused', detail: `${executed.code}: ${executed.message.slice(0, 160)}` });
    excluded.push(candidate.tier);
    const again = await prepare({ intent, vocabulary: input.vocabulary, deps: input.prepareDeps, explorationOptIn: input.explorationOptIn, excludeTiers: excluded });
    for (const item of again.candidates) receipt.candidates.push({ tier: item.tier, trust: item.trust, proof: item.proof, sqlFingerprint: fingerprintSql(item.sql), ...(item.engine ? { engine: item.engine } : {}) });
    receipt.refusals.push(...again.refusals.filter((refusal) => !excluded.includes(refusal.tier)));
    receipt.tiers.push(...again.attempts.map((attempt) => ({ round: 9, ...attempt })));
    if (!again.chosen) {
      const gap = gapFromRefusals(receipt.refusals, intent, input.vocabulary);
      return { kind: 'gap', gap: gap.gap, message: gap.message, nearest: gap.nearest.map(label), text: composeGapText(gap.gap, gap.message, gap.nearest.map(label), false), receipt, intent, offerExploration: false };
    }
    candidate = again.chosen;
    executeStarted = now();
    executed = await countedExecute(candidate, intent, input.executeDeps);
    mark(`execute_${excluded.length + 1}`, executeStarted);
  }
  // A NAME THAT MATCHED NOTHING EXACTLY MAY NAME SEVERAL MEMBERS. The query
  // already filtered that column, so asking which of its values contain the
  // literal is no wider a reach; one match is canonicalised, several are all
  // shown and named, and too many stay an honest no-match.
  if (!executed.ok && executed.code === 'no_rows_matched' && executed.cause?.kind === 'member' && input.suggestMembers && remaining() > 5_000) {
    const candidates: Array<{ predicate: IntentPredicate; values: string[] }> = [];
    for (const predicate of intent.filters) {
      if (predicate.op !== 'eq' && predicate.op !== 'in') continue;
      const literal = predicate.values.find((value): value is string => typeof value === 'string' && value.trim().length > 2);
      if (!literal || !executed.cause.literals.includes(literal)) continue;
      try {
        const found = await input.suggestMembers(predicate.ref, literal);
        if (found.length > 0 && found.length <= 6 && !found.some((value) => value.toLowerCase() === literal.toLowerCase())) candidates.push({ predicate, values: found });
      } catch { /* a probe that fails leaves the honest no-match in place */ }
    }
    if (candidates.length > 0) {
      // SEVERAL PEOPLE ARE NOT ONE PERSON. A singular name that matched no
      // member exactly, and several members that contain it, is a question:
      // which one? Adding their facts together answers about nobody, and the
      // reading above that row would still name whichever one it had in mind.
      const ambiguous = candidates.find((item) => item.values.length > 1 && item.predicate.op === 'eq' && item.predicate.values.length === 1);
      if (ambiguous) {
        const literal = String(ambiguous.predicate.values[0]);
        const name = label(ambiguous.predicate.ref);
        const options = [
          ...ambiguous.values.map((value) => ({ ref: memberOptionId(ambiguous.predicate.ref, [value]), label: value })),
          { ref: memberOptionId(ambiguous.predicate.ref, ambiguous.values), label: `All ${ambiguous.values.length}, one row each`, description: ambiguous.values.join(', ') },
        ];
        const question = `${JSON.stringify(literal)} matches ${ambiguous.values.length} members of ${name}: ${ambiguous.values.join(', ')}. Which one do you mean?`;
        receipt.grounding = [...(receipt.grounding ?? []), `identity: ${name} ${JSON.stringify(literal)} matched no member exactly and names ${ambiguous.values.length} members (${ambiguous.values.join(', ')}); the turn asked which one instead of adding them together`];
        receipt.tiers.push({ round: 9, tier: candidate.tier, outcome: 'refused', detail: `member_ambiguous: ${ambiguous.values.length} members contain ${JSON.stringify(literal)}` });
        receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: 0, ms: Math.round(now() - executeStarted), proofs: executed.proofs };
        return { kind: 'clarify', intent, question, options, text: question, receipt };
      }
      const notes: string[] = [];
      const widened: AnalyticalIntentV1 = {
        ...intent,
        filters: intent.filters.map((predicate) => {
          const found = candidates.find((item) => item.predicate === predicate);
          if (!found) return predicate;
          notes.push(`identity: ${label(predicate.ref)} ${JSON.stringify(String(predicate.values[0]))} matched no member exactly; ${found.values.length === 1 ? 'it is' : 'these are'} the ${found.values.length === 1 ? 'member' : `${found.values.length} members`} whose name contains it: ${found.values.join(', ')}`);
          return { ...predicate, op: 'in' as const, values: found.values };
        }),
      };
      // A set that widened to several members keeps them apart, and the
      // executable is not accepted until the population it reads is the
      // subject the reading claims.
      keepMembersApart(widened, input.vocabulary);
      const merged = proveSubjectMatchesPopulation(widened, input.vocabulary);
      if (!merged) {
        receipt.grounding = [...(receipt.grounding ?? []), ...notes];
        const again = await prepare({ intent: widened, vocabulary: input.vocabulary, deps: input.prepareDeps, explorationOptIn: input.explorationOptIn });
        if (again.chosen) {
          const retried = await countedExecute(again.chosen, widened, input.executeDeps);
          if (retried.ok) { candidate = again.chosen; executed = retried; intent = widened; receipt.intent = widened; }
        }
      } else {
        receipt.grounding = [...(receipt.grounding ?? []), `identity: the widened reading was not run because ${merged}`];
      }
    }
  }
  if (!executed.ok && executed.code === 'no_rows_matched') {
    receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: false } as unknown as PreparedRefusal);
    receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: 0, ms: Math.round(now() - executeStarted), proofs: executed.proofs };
    const nearest = (receipt.grounding ?? []).filter((note) => note.includes('nearest'));
    const advice = executed.cause?.kind === 'window'
      ? 'The data may end before that period; ask for the latest period it holds.'
      : executed.cause?.kind === 'predicate'
        ? 'Loosen the restriction, or ask for the values this field holds.'
        : 'Check the spelling of the member, or ask for the values this field holds.';
    return { kind: 'gap', gap: 'not_retrieved', message: executed.message, nearest, text: `The governed query ran, but ${executed.message}.${nearest.length ? ` ${nearest.join('; ')}.` : ''} ${advice}`, receipt, intent, offerExploration: false };
  }
  if (!executed.ok) {
    receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: false } as unknown as PreparedRefusal);
    receipt.failure = { stage: 'execute', reason: executed.code, message: executed.message, ...(executed.warehouse ? { warehouse: executed.warehouse } : {}) };
    return { kind: 'failed', stage: 'execute', message: executed.message, text: composeFailedText('execute', executed.message, executed.warehouse), receipt, intent };
  }
  const cacheKey = `${input.cacheScope ?? ''}|${intentExecutionFingerprint(intent)}`;
  input.preparationCache?.set(cacheKey, candidate);
  receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: executed.result.rowCount, ms: Math.round(executed.result.executionTimeMs), proofs: executed.proofs };
  timings.total = Math.round(now() - started);
  const described: ExecutedRows = { ...executed.result, columnsMeta: describeResultColumns(intent, executed.result, input.vocabulary) };
  // A series must cover the period it claims: a month the warehouse returned
  // no rows for is a month with nothing in it, not a month left out.
  const filled = fillPeriodGaps(intent, described);
  const result = filled.result;
  // A certified block served as published with an identity caveat says so in the answer.
  const tieNote = executed.proofs.find((line) => line.startsWith('tie: '))?.slice('tie: '.length);
  const caveats = candidate.tier === 'certified' ? candidate.proof.filter((line) => /no identity key/.test(line)).map((line) => `${line.replace(/; the certified block is served as published$/, '')}; recertify it with the entity key to keep them apart`) : [];
  // THE LABEL THE QUESTION ASKED FOR. "Which teams" is answered by names; when
  // the repair dropped the label because no governed relationship reaches it,
  // the rows carry a key and nothing else. The numbers can still be right, so
  // the answer is served, but the omission is named and the check does not
  // pass: opaque identifiers are not the answer to "which".
  if (filled.added > 0) receipt.executed = { ...receipt.executed!, proofs: [...(receipt.executed?.proofs ?? []), `${filled.added} ${intent.groupBy.find((group) => group.role === 'time')?.grain ?? 'period'}s of the window held no rows and are shown as zero`] };
  // A request that listed its parts is answered part by part: the ones no ref
  // is named for are said out loud, not left for the reader to notice.
  // Several rows tied for the top: the answer names the tie rather than
  // presenting one of them as the single best.
  if (tieNote) caveats.push(tieNote);
  if (judgmentCaveat) caveats.unshift(judgmentCaveat);
  const facets = unmetFacets(input.question, intent, input.vocabulary);
  if (facets.length > 0) {
    const message = `this answer carries nothing for ${facets.map((facet) => `"${facet}"`).join(', ')}: no governed metric or dimension of this project is named for ${facets.length === 1 ? 'it' : 'them'}`;
    receipt.unmet = [...(receipt.unmet ?? []), { obligation: 'coverage', message }];
    caveats.push(message);
  }
  const unmetLabel = unmetDisplayObligation(requestedDisplay, intent, receipt.refusals, label, input.question);
  if (unmetLabel) {
    receipt.unmet = [...(receipt.unmet ?? []), { obligation: 'display_label', message: unmetLabel.message, refs: unmetLabel.refs }];
    caveats.push(`${unmetLabel.message}; declare a governed relationship to that label (with its uniqueness and coverage proof), or add the label to the fact relation`);
  }
  // A member the host did not resolve to a key is matched by text, and the
  // answer says so: the reading may name a person, the predicate names a
  // string. A `contains` match can cover several members.
  const grounded = new Set((receipt.grounding ?? []).map((note) => note.toLowerCase()));
  const textMatches = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]
    .filter((predicate) => (predicate.op === 'contains' || predicate.op === 'eq' || predicate.op === 'in') && predicate.values.some((value) => typeof value === 'string'))
    .filter((predicate) => { const entry = input.vocabulary.get(predicate.ref); return Boolean(entry && (entry.kind === 'dimension' || entry.kind === 'column') && !entry.roles.includes('time') && !entry.roles.includes('numeric') && !entry.roles.includes('boolean')); })
    .filter((predicate) => !predicate.values.some((value) => [...grounded].some((note) => note.includes(String(value).toLowerCase()))))
    .map((predicate) => {
      const entry = input.vocabulary.get(predicate.ref)!;
      const label = entry.label ?? entry.name;
      const literal = predicate.values.map((value) => JSON.stringify(String(value))).join(', ');
      return predicate.op === 'contains'
        ? `identity: ${label} matched by text containing ${literal}; that can cover several members, none was resolved to a key`
        : `identity: ${label} matched by exact text ${literal}, not resolved to a key`;
    });
  return { kind: 'answered', intent, candidate, result, text: composeAnsweredText(intent, result, input.vocabulary, candidate.trust, { notes: [...(receipt.grounding ?? []), ...textMatches], caveats }), receipt };
}
