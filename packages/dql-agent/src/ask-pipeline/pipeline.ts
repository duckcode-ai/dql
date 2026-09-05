import { createHash } from 'node:crypto';
import type { AgentProvider, ProviderRunOptions } from '../providers/types.js';
import { executeCandidate, type ExecuteDeps } from './execute.js';
import { intentExecutionFingerprint, type AnalyticalIntentV1 } from './intent.js';
import { composeAnsweredText, composeFailedText, composeGapText, labelFor, type GapKind, type PipelineOutcome, type PipelineReceipt } from './outcomes.js';
import { prepare, type PrepareDeps, type PreparedCandidate, type PreparedRefusal, type PrepareResult } from './prepare/index.js';
import { resolveIntent, uncoveredQuestionTerms, type IntentResolution } from './resolve-intent.js';
import type { VocabularyIndex } from './vocabulary.js';

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
  priorAnswerSummary?: string;
  guidance?: string;
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
}

const fingerprintSql = (sql: string) => `sha256:${createHash('sha256').update(sql).digest('hex').slice(0, 24)}`;

function gapFromRefusals(refusals: PreparedRefusal[], intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): { gap: GapKind; message: string; nearest: string[] } {
  const denied = refusals.find((refusal) => refusal.code === 'policy_denied');
  if (denied) return { gap: 'denied', message: denied.message, nearest: [] };
  const unresolved = intent.unresolved.filter((clause) => clause.material);
  if (unresolved.length) return { gap: 'ambiguous', message: unresolved.map((clause) => clause.clause).join('; '), nearest: unresolved.flatMap((clause) => clause.options) };
  const compile = refusals.find((refusal) => refusal.code === 'semantic_compile_failed' || refusal.code === 'relational_compose_failed' || refusal.code === 'join_path_required' || refusal.code === 'measure_scope_not_expressible');
  const nearest = [...new Set(intent.measures.flatMap((measure) => vocabulary.suggest(measure.ref, 3).map((entry) => entry.ref)))].filter((ref) => !intent.measures.some((measure) => measure.ref === ref)).slice(0, 5);
  if (compile) return { gap: 'unsupported', message: compile.message, nearest };
  const first = refusals.find((refusal) => refusal.tier !== 'exploratory');
  return { gap: 'not_modeled', message: first?.message ?? 'no governed tier could prepare the intent', nearest };
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
  const label = labelFor(input.vocabulary);
  const remaining = () => (deadline ? deadline - now() : Number.POSITIVE_INFINITY);
  const mark = (stage: string, from: number) => { timings[stage] = Math.round(now() - from); input.trace?.({ stage, detail: timings[stage] }); };

  // 1. Resolve.
  const resolveStarted = now();
  let resolution: IntentResolution = await resolveIntent({
    question: input.question, vocabulary: input.vocabulary, provider: input.provider, prior: input.prior, priorAnswerSummary: input.priorAnswerSummary,
    guidance: input.guidance, cardBudget: input.cardBudget, providerOptions: input.providerOptions, now,
    maxAttempts: remaining() > 15_000 ? 2 : 1,
    onDispatch: (event) => receipt.dispatches.push({ purpose: `intent:${event.purpose}`, ms: event.ms, reply: event.raw.slice(0, 1500) }),
  });
  mark('resolve', resolveStarted);
  if (resolution.status === 'failed') {
    const message = resolution.reason === 'provider_error' ? `the AI model did not respond (${resolution.detail})` : resolution.reason === 'unparseable' ? 'the AI reply was not a readable interpretation' : `the interpretation named things that do not exist: ${resolution.detail}`;
    receipt.failure = { stage: 'resolve', reason: resolution.reason, message, problems: resolution.problems };
    return { kind: 'failed', stage: 'resolve', message, text: composeFailedText('resolve', message), receipt };
  }
  if (resolution.status === 'conversation' || resolution.status === 'definition') {
    receipt.intent = resolution.intent;
    return { kind: resolution.status, reply: resolution.reply, text: resolution.reply, receipt, intent: resolution.intent };
  }
  receipt.intent = resolution.intent;
  receipt.reading = resolution.intent.reading;
  if (resolution.status === 'clarify') {
    const options = resolution.options.map((ref) => ({ ref, label: label(ref), ...(input.vocabulary.get(ref)?.description ? { description: input.vocabulary.get(ref)!.description } : {}) }));
    if (options.length === 0) {
      // Nothing to choose between: the project simply does not hold it.
      const clause = resolution.intent.unresolved.find((item) => item.material)?.clause ?? input.question;
      const nearest = input.vocabulary.lookup(clause, { limit: 4, minScore: 0.5 }).map((hit) => label(hit.entry.ref));
      return { kind: 'gap', gap: 'not_modeled', message: `"${clause}" is not something this project's governed data describes`, nearest, text: composeGapText('not_modeled', `"${clause}" is not something this project's governed data describes`, nearest, false), receipt, intent: resolution.intent, offerExploration: false };
    }
    return { kind: 'clarify', intent: resolution.intent, question: resolution.question, options, text: resolution.question, receipt };
  }
  let intent = resolution.intent;
  const uncovered = uncoveredQuestionTerms(input.question, intent, input.vocabulary);
  if (uncovered.length) receipt.uncovered = uncovered;

  // 2. Prepare (with cache and one bounded repair).
  const attempted = new Set<string>();
  let prepared: PrepareResult | undefined;
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
    mark(round === 0 ? 'prepare' : 'prepare_repair', prepareStarted);
    for (const item of prepared.candidates) receipt.candidates.push({ tier: item.tier, trust: item.trust, proof: item.proof, sqlFingerprint: fingerprintSql(item.sql), ...(item.engine ? { engine: item.engine } : {}) });
    receipt.refusals.push(...prepared.refusals);
    receipt.tiers.push(...prepared.attempts.map((attempt) => ({ round, ...attempt })));
    if (prepared.chosen) { candidate = prepared.chosen; break; }
    // One bounded repair: a repairable compile refusal goes back to the resolver with the engine's words.
    const repairable = prepared.refusals.find((refusal) => refusal.repairable);
    if (!repairable || round > 0 || remaining() < 12_000) break;
    const repairStarted = now();
    resolution = await resolveIntent({
      question: `${input.question}\n\nThe previous interpretation could not be prepared. ${repairable.tier === 'certified' ? 'The certified block is not applicable: ' : 'The engine said: '}${repairable.message}. ${repairable.tier === 'certified' ? 'Express the analysis with metric, entity and dimension refs instead of the block.' : 'Choose refs the engine can bind.'}`,
      vocabulary: input.vocabulary, provider: input.provider, prior: input.prior, guidance: input.guidance, cardBudget: input.cardBudget, providerOptions: input.providerOptions, now, maxAttempts: 1,
      onDispatch: (event) => receipt.dispatches.push({ purpose: 'intent:repair', ms: event.ms, reply: event.raw.slice(0, 1500) }),
    });
    mark('resolve_repair', repairStarted);
    if (resolution.status !== 'resolved') {
      receipt.failure = { stage: 'prepare', reason: `repair_${resolution.status}`, message: resolution.status === 'failed' ? resolution.detail : resolution.status === 'clarify' ? resolution.question : resolution.status, ...(resolution.status === 'failed' ? { problems: resolution.problems } : {}) };
      break;
    }
    intent = resolution.intent;
    receipt.intent = intent;
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
  let executed = await executeCandidate(candidate, intent, input.executeDeps);
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
    executed = await executeCandidate(candidate, intent, input.executeDeps);
    mark(`execute_${excluded.length + 1}`, executeStarted);
  }
  if (!executed.ok) {
    receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: false } as unknown as PreparedRefusal);
    receipt.failure = { stage: 'execute', reason: executed.code, message: executed.message };
    return { kind: 'failed', stage: 'execute', message: executed.message, text: composeFailedText('execute', executed.message), receipt, intent };
  }
  const cacheKey = `${input.cacheScope ?? ''}|${intentExecutionFingerprint(intent)}`;
  input.preparationCache?.set(cacheKey, candidate);
  receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: executed.result.rowCount, ms: Math.round(executed.result.executionTimeMs), proofs: executed.proofs };
  timings.total = Math.round(now() - started);
  return { kind: 'answered', intent, candidate, result: executed.result, text: composeAnsweredText(intent, executed.result, input.vocabulary, candidate.trust), receipt };
}
