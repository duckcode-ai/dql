/**
 * THE INVESTIGATION LOOP. Read the question once (or start from the answer
 * being investigated), frame the periods, measure the headline change, check
 * the data covers both periods, and write the report. Every step streams to
 * the host and every query leaves its pipeline receipt behind.
 */
import type { AnalyticalIntentV1 } from '../../ask-pipeline/intent.js';
import type { AskStoryStepV1 } from '../../ask-pipeline/outcomes.js';
import { readingLane } from '../../ask-pipeline/resolve-intent.js';
import { investigationStopReason, recordReadingCalls, type InvestigationRun } from './context.js';
import { frameNeedsFreshness, investigationWindowsFor, planInvestigationFrame } from './frame.js';
import { checkCoverage, measureHeadline, observeFreshness } from './programs.js';
import { buildInvestigationReport } from './report.js';
import { lastDayBefore } from './windows.js';
import type {
  InvestigationCaveatV1, InvestigationContextItemV1, InvestigationFrameSource, InvestigationFrameV1, InvestigationLimits, InvestigationOutcome,
  InvestigationProgramKind, InvestigationProgramRecordV1, InvestigationReceiptV1, InvestigationRuntime,
} from './types.js';

export const DEFAULT_INVESTIGATION_LIMITS: InvestigationLimits = { maxStatements: 20, minRemainingMs: 25_000 };

export async function runInvestigation(input: {
  question: string;
  source: InvestigationFrameSource;
  runtime: InvestigationRuntime;
  limits?: Partial<InvestigationLimits>;
  now?: () => Date;
}): Promise<InvestigationOutcome> {
  const { runtime } = input;
  const limits: InvestigationLimits = { ...DEFAULT_INVESTIGATION_LIMITS, ...input.limits };
  const receipt: InvestigationReceiptV1 = { version: 1, programs: [], queries: [], budget: { statementsCap: limits.maxStatements, statementsUsed: 0, aiCalls: 0 }, contextSources: [] };
  const run: InvestigationRun = { question: input.question, runtime, limits, queries: [], receipt, caveats: [] };
  const step = (phase: AskStoryStepV1['phase'], title: string, state: AskStoryStepV1['state'], extra: { detail?: string; ms?: number; programId?: string } = {}) => {
    try { runtime.onStep({ version: 1, phase, title, state, at: Date.now(), ...(extra.detail ? { detail: extra.detail.slice(0, 600) } : {}), ...(extra.ms !== undefined ? { ms: extra.ms } : {}), ...(extra.programId ? { programId: extra.programId } : {}) }); } catch { /* a progress view never fails a run */ }
  };
  const record = (kind: InvestigationProgramKind, id: string, title: string): InvestigationProgramRecordV1 => {
    const entry: InvestigationProgramRecordV1 = { id, kind, title, outcome: 'done', queryIds: [] };
    receipt.programs.push(entry);
    return entry;
  };

  // 1. The reading: the answer being investigated, or one reading of the question.
  const frameStarted = Date.now();
  let reading: AnalyticalIntentV1;
  let lane: 'governed' | 'ai';
  if (input.source.kind === 'run') {
    reading = input.source.intent;
    lane = readingLane(reading, runtime.vocabulary());
    step('frame', 'Started from the answer being investigated', 'done', { detail: reading.reading, programId: 'frame' });
  } else {
    const outcome = await runtime.read(input.question);
    recordReadingCalls(run, outcome);
    if (outcome.kind !== 'reading') return { kind: 'reading_ended', outcome, receipt };
    reading = outcome.intent;
    lane = outcome.lane;
  }
  const planned = planInvestigationFrame({ reading, vocabulary: runtime.vocabulary(), lane, question: input.question });
  const frameRecord = record('frame', 'frame', 'Framed the change to investigate');
  if (planned.status === 'clarify') {
    frameRecord.outcome = 'skipped'; frameRecord.reason = planned.question;
    return { kind: 'clarify', question: planned.question, options: planned.options, receipt };
  }
  if (planned.status === 'not_investigable') {
    frameRecord.outcome = 'skipped'; frameRecord.reason = planned.reason;
    return { kind: 'not_investigable', reason: planned.reason, receipt };
  }
  const { plan } = planned;
  step('frame', `Framed the change in ${plan.metric.label}`, 'done', {
    programId: 'frame',
    ...(frameNeedsFreshness(plan) ? { detail: 'Checking how far the data runs before choosing the periods.' } : {}),
  });

  // 2. How far the data runs, when the periods depend on it.
  let observedThrough: string | undefined;
  let freshnessApproximate = false;
  if (frameNeedsFreshness(plan)) {
    const started = Date.now();
    const freshnessRecord = record('freshness', 'freshness', 'Checked how far the data runs');
    const fresh = await observeFreshness(run, plan);
    freshnessRecord.queryIds = fresh.queryIds;
    freshnessRecord.ms = Date.now() - started;
    observedThrough = fresh.observedThrough;
    freshnessApproximate = Boolean(fresh.approximate);
    if (!observedThrough) freshnessRecord.outcome = 'failed';
    step('check', observedThrough ? `The data runs through ${lastDayBefore(observedThrough)}` : 'Could not read how far the data runs', observedThrough ? 'done' : 'missed', { ms: freshnessRecord.ms, programId: 'freshness' });
  }
  const windows = investigationWindowsFor(plan, { ...(observedThrough ? { observedThrough } : {}), now: (input.now ?? (() => new Date()))(), fromSourceRun: input.source.kind === 'run' });
  const frame: InvestigationFrameV1 = {
    version: 1, question: input.question, reading: plan.reading,
    source: input.source.kind === 'run' ? { kind: 'run', runId: input.source.runId } : { kind: 'question' },
    metric: plan.metric, timeRef: plan.timeRef, grain: plan.grain, baseFilters: plan.baseFilters, shape: plan.shape, lane: plan.lane,
    ...windows,
  };
  receipt.frame = frame;
  frameRecord.ms = Date.now() - frameStarted;
  step('frame', `Comparing ${frame.metric.label} in ${frame.windows.current.label} with ${frame.windows.prior.label}`, 'done', {
    detail: `and with ${frame.windows.yearAgo.label}${frame.baseFilters.length ? `; keeping the question's ${frame.baseFilters.length === 1 ? 'filter' : 'filters'}` : ''}`,
    programId: 'frame',
  });
  const caveats: InvestigationCaveatV1[] = [];
  if (frame.windowBasis === 'shifted_to_data') caveats.push({ code: 'shifted_to_data', text: 'The periods were moved to the latest complete data.' });
  if (frameNeedsFreshness(plan) && !observedThrough) caveats.push({ code: 'freshness_unknown', text: 'How far the data runs could not be read, so the latest complete period may still be filling in.' });
  if (freshnessApproximate) caveats.push({ code: 'freshness_unknown', text: 'Only the last month with data could be read, not its last day, so that month was treated as incomplete.' });

  const context: InvestigationContextItemV1[] = [];
  const gather = async (stage: 'after_frame' | 'after_drivers') => {
    for (const source of runtime.contextSources ?? []) {
      if (investigationStopReason(run)) return;
      const started = Date.now();
      try {
        const items = await source.gather({ frame, stage, budgetMs: Math.min(10_000, Math.max(0, runtime.remainingMs() / 4)), ...(runtime.signal ? { signal: runtime.signal } : {}) });
        context.push(...items.map((item) => ({ ...item, sourceId: source.id, provenance: 'external' as const })));
        receipt.contextSources.push({ id: source.id, items: items.length, ms: Date.now() - started });
      } catch (error) {
        receipt.contextSources.push({ id: source.id, items: 0, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await gather('after_frame');

  // 3. The headline change.
  const headlineStarted = Date.now();
  const headlineRecord = record('headline', 'headline', `Measured ${frame.metric.label} in each period`);
  const headline = await measureHeadline(run, frame);
  headlineRecord.queryIds = headline.queryIds;
  headlineRecord.ms = Date.now() - headlineStarted;
  if (headline.failure && headline.current === undefined) { headlineRecord.outcome = 'failed'; headlineRecord.reason = headline.failure; }
  step('analyze', headline.current !== undefined && headline.prior !== undefined ? `Measured ${frame.metric.label} in ${frame.windows.current.label} and ${frame.windows.prior.label}` : `Could not measure ${frame.metric.label} in both periods`, headline.current !== undefined && headline.prior !== undefined ? 'done' : 'failed', { ms: headlineRecord.ms, programId: 'headline', ...(headline.failure ? { detail: headline.failure } : {}) });

  // 4. Whether both periods are covered by data.
  let coverage;
  if (!headline.noData && headline.current !== undefined) {
    const started = Date.now();
    const coverageRecord = record('coverage', 'coverage', 'Checked the data covers both periods');
    coverage = await checkCoverage(run, frame, { allowAiSql: frame.lane === 'ai' || headline.aiSql });
    coverageRecord.queryIds = coverage.queryIds;
    coverageRecord.ms = Date.now() - started;
    if (coverage.current === undefined) coverageRecord.outcome = frame.grain === 'day' ? 'skipped' : 'failed';
    else step('check', `Data covers ${Math.round(coverage.current * 100)}% of the days in ${frame.windows.current.label} and ${Math.round((coverage.prior ?? 0) * 100)}% in ${frame.windows.prior.label}`, 'done', { ms: coverageRecord.ms, programId: 'coverage' });
  }

  await gather('after_drivers');
  const report = buildInvestigationReport({
    question: input.question, frame, headline, ...(coverage ? { coverage } : {}), caveats, queries: run.queries, context,
    ...(receipt.budget.stoppedBy ? { stoppedBy: receipt.budget.stoppedBy } : {}),
  });
  record('report', 'report', 'Wrote the report');
  step('report', 'Wrote the report', 'done', { programId: 'report', detail: report.headline.text });
  return { kind: 'report', report, receipt };
}
