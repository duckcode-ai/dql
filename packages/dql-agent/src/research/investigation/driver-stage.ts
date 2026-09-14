/**
 * WHERE THE CHANGE CAME FROM. After the headline, the change is broken down
 * by the ranked dimensions, one reading each; the dimension that explains it
 * is drilled into through its top member; and that member is checked against
 * the same periods a year earlier. Every step stops, like every query, when
 * the run is cancelled, out of time or out of statements.
 */
import type { ExactDecimal } from '../../analytical-execution-graph.js';
import { sumDecimals } from '../../analytical-execution-graph.js';
import type { AskStoryStepV1 } from '../../ask-pipeline/outcomes.js';
import { investigationStopReason, runInvestigationQuery, type InvestigationRun } from './context.js';
import type { ContributionRowV1, MixRateSplitV1 } from './contribution.js';
import { candidateDimensions, dimensionCap, dimensionSelectionPrompt, LOW_TIME_MS, parseDimensionSelection, type CandidateDimensionV1, type ExcludedDimensionV1 } from './dimensions.js';
import { measureContribution, type ContributionOutcome } from './drivers.js';
import { bucketDayOf, decimalOf, investigationIntent, resultColumns, timeBucket } from './intents.js';
import type { HeadlineFigures } from './programs.js';
import type { InvestigationDimensionRef, InvestigationFrameV1, InvestigationProgramKind, InvestigationProgramRecordV1, InvestigationReportV1 } from './types.js';
import { dimensionVerdict, drillTarget, seasonalityCheck, type DimensionVerdictV1, type SeasonalityV1 } from './verdicts.js';
import { bucketsIn } from './windows.js';

export interface AnalysedDimensionV1 {
  dimension: InvestigationDimensionRef;
  outcome: Extract<ContributionOutcome, { status: 'measured' }>;
  verdict: DimensionVerdictV1;
  /** For a breakdown inside one member: that member of the parent dimension. */
  parent?: { dimension: InvestigationDimensionRef; row: ContributionRowV1 };
}

export type NotInvestigatedReason = InvestigationReportV1['notInvestigated'][number]['reason'];

export interface DriverFindingsV1 {
  analysed: AnalysedDimensionV1[];
  drilled: AnalysedDimensionV1[];
  notInvestigated: Array<{ dimension: InvestigationDimensionRef; reason: NotInvestigatedReason; detail?: string; queryIds: string[] }>;
  excluded: ExcludedDimensionV1[];
  /** How many dimensions could have been analysed. */
  candidates: number;
  selection: 'ranked' | 'ai';
  mixRate?: { dimension: InvestigationDimensionRef; split: MixRateSplitV1; queryIds: string[] };
  memberSeasonality?: { dimension: InvestigationDimensionRef; member: string; check: SeasonalityV1; queryIds: string[] };
  aiSql: boolean;
}

type Step = (phase: AskStoryStepV1['phase'], title: string, state: AskStoryStepV1['state'], extra?: { detail?: string; ms?: number; programId?: string }) => void;
type RecordProgram = (kind: InvestigationProgramKind, id: string, title: string) => InvestigationProgramRecordV1;

const VERDICT_WORDS: { [verdict in DimensionVerdictV1['verdict']]: string } = {
  explains: 'the change is concentrated in some members',
  ruled_out: 'the change is spread in line with each member’s size',
  inconclusive: 'no clear concentration',
};

/** Breakdowns running at once. */
export const BREAKDOWN_CONCURRENCY = 3;

/** The pipeline's words when a join would multiply the rows a metric totals. */
const FAN_OUT = /multiplies fact rows|would be inflated|fan-?out/i;

const filterValue = (value: unknown): string | number | boolean | undefined =>
  (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined);

export async function investigateDrivers(run: InvestigationRun, frame: InvestigationFrameV1, headline: HeadlineFigures, host: { record: RecordProgram; step: Step }): Promise<DriverFindingsV1 | undefined> {
  if (headline.current === undefined || headline.prior === undefined || headline.noData) return undefined;
  const { runtime } = run;
  const vocabulary = runtime.vocabulary();
  const relations = [...new Set(run.queries.filter((query) => query.purpose === 'headline' && query.outcome === 'answered').flatMap((query) => query.relations ?? []))];
  let compatibleRefs: string[] | undefined;
  try { compatibleRefs = runtime.compatibleDimensionRefs?.(frame.metric.ratio?.numeratorRef ?? frame.metric.ref); } catch { compatibleRefs = undefined; }
  const cap = dimensionCap(frame, runtime.remainingMs());
  const ranked = candidateDimensions({ vocabulary, frame, question: run.question, ...(compatibleRefs ? { compatibleRefs } : {}), ...(relations.length ? { relations } : {}), cap });
  const everyone = [...ranked.candidates, ...ranked.overCap];
  const findings: DriverFindingsV1 = { analysed: [], drilled: [], notInvestigated: [], excluded: ranked.excluded, candidates: everyone.length, selection: 'ranked', aiSql: false };
  if (everyone.length === 0) return findings;

  // More dimensions than one investigation analyses: an AI may choose, from the ranked list only.
  let chosen: CandidateDimensionV1[] = ranked.candidates;
  if (ranked.overCap.length && runtime.selectDimensions && runtime.remainingMs() > LOW_TIME_MS && !investigationStopReason(run)) {
    const started = Date.now();
    try {
      const reply = await runtime.selectDimensions(dimensionSelectionPrompt({
        question: run.question, metricLabel: frame.metric.label, currentLabel: frame.windows.current.label, priorLabel: frame.windows.prior.label, candidates: everyone, cap,
      }));
      run.receipt.budget.aiCalls += 1;
      const picked = parseDimensionSelection(reply, everyone, cap);
      if (picked) { chosen = picked; findings.selection = 'ai'; }
    } catch {
      // The ranked order stands.
    }
    host.step('analyze', findings.selection === 'ai' ? `Chose ${chosen.length} of ${everyone.length} dimensions to break the change down by` : `Kept the ${chosen.length} highest-ranked of ${everyone.length} dimensions`, 'done', { ms: Date.now() - started, programId: 'dimensions' });
  }

  const allowAiSql = frame.lane === 'ai' || headline.aiSql;
  const analyse = async (
    dimension: InvestigationDimensionRef,
    scoped: InvestigationFrameV1,
    totals: { current: ExactDecimal; prior: ExactDecimal },
    parent?: AnalysedDimensionV1['parent'],
  ): Promise<AnalysedDimensionV1 | undefined> => {
    const started = Date.now();
    const kind: InvestigationProgramKind = parent ? 'drill' : 'contribution';
    const id = parent ? `drill:${parent.row.key}:${dimension.ref}` : `contribution:${dimension.ref}`;
    const program = host.record(kind, id, parent ? `Broke ${parent.row.label} down by ${dimension.label}` : `Broke the change down by ${dimension.label}`);
    program.dimension = dimension.ref;
    if (parent) program.parentId = `contribution:${parent.dimension.ref}`;
    const outcome = await measureContribution(run, scoped, dimension, { totals, allowAiSql, programId: id });
    program.queryIds = outcome.queryIds;
    program.ms = Date.now() - started;
    const where = parent ? `${parent.row.label} by ${dimension.label}` : `the change by ${dimension.label}`;
    if (outcome.status !== 'measured') {
      program.outcome = outcome.status === 'stopped' ? 'not_reached' : outcome.status === 'failed' ? 'failed' : 'skipped';
      program.reason = outcome.reason;
      const reason: NotInvestigatedReason = outcome.status === 'stopped' ? outcome.reason as NotInvestigatedReason : outcome.status === 'truncated' ? 'truncated_members' : outcome.status;
      findings.notInvestigated.push({ dimension, reason, detail: outcome.reason, queryIds: outcome.queryIds });
      if (outcome.status !== 'stopped') host.step(parent ? 'drill' : 'analyze', `Could not break ${where} down`, 'missed', { detail: outcome.reason, ms: program.ms, programId: id });
      return undefined;
    }
    findings.aiSql ||= outcome.aiSql;
    const verdict = dimensionVerdict(outcome.table);
    program.verdict = verdict.verdict === 'explains' ? (verdict.members.some((member) => member.verdict === 'supported') ? 'supported' : 'partial') : verdict.verdict;
    host.step(parent ? 'drill' : 'analyze', `Broke ${where} down: ${VERDICT_WORDS[verdict.verdict]}`, 'done', { ms: program.ms, programId: id });
    return { dimension, outcome, verdict, ...(parent ? { parent } : {}) };
  };

  // The chosen dimensions first, then the rest in rank order: a chosen dimension
  // the metric cannot be grouped by does not use up its place, so the next
  // ranked one takes it. As many are analysed as were chosen.
  const totals = { current: headline.current, prior: headline.prior };
  const chosenRefs = new Set(chosen.map((candidate) => candidate.ref));
  const order = [...chosen, ...everyone.filter((candidate) => !chosenRefs.has(candidate.ref))];
  const attempted = new Set<string>();
  // A model whose join multiplies the metric's rows multiplies them for every
  // one of its dimensions: after the first refusal, the rest are not queried.
  const fannedOut = new Map<string, string>();
  const modelOf = (ref: string) => vocabulary.get(ref)?.model;
  // Up to three breakdowns run at once; a place is held while a breakdown runs
  // and given back when the metric turns out not to be groupable by it.
  const results = new Map<string, AnalysedDimensionV1>();
  const running = new Set<Promise<void>>();
  let next = 0;
  let places = 0;
  let holding = 0;
  const start = (candidate: CandidateDimensionV1) => {
    const dimension = { ref: candidate.ref, label: candidate.label };
    const model = modelOf(candidate.ref);
    holding += 1;
    const task = (async () => {
      const analysed = await analyse(dimension, frame, totals);
      const refusal = analysed ? undefined : findings.notInvestigated.find((entry) => entry.dimension.ref === candidate.ref && entry.reason === 'not_expressible');
      if (model && refusal?.detail && FAN_OUT.test(refusal.detail)) fannedOut.set(model, refusal.detail);
      const vacated = !analysed && findings.notInvestigated.some((entry) => entry.dimension.ref === candidate.ref && (entry.reason === 'not_expressible' || entry.reason === 'truncated_members'));
      holding -= 1;
      if (!vacated) places += 1;
      if (analysed) results.set(candidate.ref, analysed);
    })();
    const tracked: Promise<void> = task.finally(() => { running.delete(tracked); });
    running.add(tracked);
  };
  while (next < order.length && places < chosen.length) {
    if (places + holding >= chosen.length || running.size >= BREAKDOWN_CONCURRENCY) {
      await Promise.race(running);
      continue;
    }
    const candidate = order[next++]!;
    attempted.add(candidate.ref);
    const model = modelOf(candidate.ref);
    const known = model ? fannedOut.get(model) : undefined;
    if (known) {
      findings.notInvestigated.push({ dimension: { ref: candidate.ref, label: candidate.label }, reason: 'not_expressible', detail: known, queryIds: [] });
      continue;
    }
    start(candidate);
  }
  await Promise.all(running);
  // In rank order, whatever order they finished in.
  for (const candidate of order) {
    const analysed = results.get(candidate.ref);
    if (!analysed) continue;
    findings.analysed.push(analysed);
    if (frame.metric.ratio && analysed.outcome.mixRate && !findings.mixRate) {
      findings.mixRate = { dimension: analysed.dimension, split: analysed.outcome.mixRate, queryIds: analysed.outcome.queryIds };
    }
  }
  for (const candidate of everyone) {
    if (!attempted.has(candidate.ref)) findings.notInvestigated.push({ dimension: { ref: candidate.ref, label: candidate.label }, reason: 'not_started', detail: 'beyond the number of dimensions one investigation analyses', queryIds: [] });
  }

  // One level down: the top supported member, by the next dimensions.
  const parent = findings.analysed.find((item) => drillTarget(item.verdict));
  const target = parent ? drillTarget(parent.verdict) : undefined;
  const value = target ? filterValue(target.value) : undefined;
  if (!parent || !target || value === undefined || target.current === undefined || target.prior === undefined || investigationStopReason(run)) return findings;
  const inMember = { ...frame, baseFilters: [...frame.baseFilters, { ref: parent.dimension.ref, op: 'eq' as const, values: [value], source: 'inherited' as const }] };
  const measuredRefs = new Set(findings.analysed.map((item) => item.dimension.ref));
  for (const candidate of order.filter((item) => item.ref !== parent.dimension.ref && measuredRefs.has(item.ref)).slice(0, 2)) {
    if (investigationStopReason(run)) break;
    const drilled = await analyse({ ref: candidate.ref, label: candidate.label }, inMember, { current: target.current, prior: target.prior }, { dimension: parent.dimension, row: target });
    if (drilled) findings.drilled.push(drilled);
  }

  // Whether that member moved the same way a year earlier (dates only: a season's year earlier is the season before).
  const { yearAgo, yearAgoPrior } = frame.windows;
  if (frame.periodAxis || frame.metric.additivity !== 'additive' || yearAgo.start === frame.windows.prior.start || !bucketsIn(yearAgo, frame.grain) || !bucketsIn(yearAgoPrior, frame.grain) || investigationStopReason(run)) return findings;
  const started = Date.now();
  const member = `${parent.dimension.label}: ${target.label}`;
  const program = host.record('seasonality', 'seasonality', `Checked ${member} a year earlier`);
  program.dimension = parent.dimension.ref;
  const span = { start: yearAgoPrior.start < yearAgo.start ? yearAgoPrior.start : yearAgo.start, end: yearAgoPrior.end > yearAgo.end ? yearAgoPrior.end : yearAgo.end };
  const result = await runInvestigationQuery(run, {
    purpose: 'seasonality', programId: 'seasonality', allowAiSql,
    label: `${frame.metric.label} for ${member} in ${yearAgoPrior.label} and ${yearAgo.label}`,
    intent: investigationIntent(inMember, { reading: `${frame.metric.label} for ${member} by ${frame.grain} from ${yearAgoPrior.label} to ${yearAgo.label}.`, window: span, groupBy: [timeBucket(inMember)], shape: 'trend' }),
  });
  program.ms = Date.now() - started;
  if (result.status === 'stopped') { program.outcome = 'not_reached'; return findings; }
  program.queryIds = [result.id];
  if (result.status !== 'answered') { program.outcome = 'failed'; program.reason = result.status === 'unanswered' ? result.message : 'no rows a year earlier'; return findings; }
  const picked = resultColumns(result.rows, inMember, vocabulary, { time: true });
  if (!picked.ok) { program.outcome = 'failed'; program.reason = picked.reason; return findings; }
  const inWindow = (window: { start: string; end: string }) => {
    const values = result.rows.rows
      .filter((row) => { const day = bucketDayOf(row[picked.columns.time!]); return day !== undefined && day >= window.start && day < window.end; })
      .map((row) => decimalOf(row[picked.columns.value!]))
      .filter((item): item is ExactDecimal => Boolean(item));
    return values.length ? sumDecimals(values) : undefined;
  };
  const check = seasonalityCheck({ current: target.current, prior: target.prior, yearAgo: inWindow(yearAgo), yearAgoPrior: inWindow(yearAgoPrior) });
  findings.memberSeasonality = { dimension: parent.dimension, member, check, queryIds: [result.id] };
  host.step('verdict', check.seasonal ? `${member} moved the same way a year earlier` : `${member} did not move the same way a year earlier`, 'done', { ms: program.ms, programId: 'seasonality' });
  return findings;
}
