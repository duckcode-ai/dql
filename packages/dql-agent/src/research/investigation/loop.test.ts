import { describe, expect, it } from 'vitest';
import type { AnalyticalIntentV1 } from '../../ask-pipeline/intent.js';
import type { AskStoryStepV1, PipelineOutcome, PipelineReceipt } from '../../ask-pipeline/outcomes.js';
import { buildVocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import { verifyAskNarration } from '../../ask-result-narration.js';
import { runInvestigation } from './loop.js';
import type { InvestigationContextSource, InvestigationFrameSource, InvestigationLimits, InvestigationOutcome, InvestigationReportV1, InvestigationRuntime } from './types.js';

const TIME = 'dimension:orders.ordered_at';
const REVENUE = 'metric:orders.revenue';
const FOOD = 'metric:orders.food_revenue';

const vocabulary = buildVocabularyIndex({
  metrics: [
    { name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' },
    { name: 'food_revenue', model: 'orders', label: 'Food revenue', aggregation: 'sum' },
  ],
  dimensions: [{ name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] }],
});

/**
 * One row per day from June 2024 to August 20 2025. Revenue is 100 a day until
 * July 2025, 80 a day in July 2025 and 90 a day in August; food revenue is 60
 * a day, then 40 from July 2025. The oracle below is arithmetic on these.
 */
const DAYS: Array<{ day: string; revenue: number; food: number }> = [];
for (let at = Date.UTC(2024, 5, 1); at < Date.UTC(2025, 7, 21); at += 86_400_000) {
  const day = new Date(at).toISOString().slice(0, 10);
  DAYS.push({ day, revenue: day >= '2025-08-01' ? 90 : day >= '2025-07-01' ? 80 : 100, food: day >= '2025-07-01' ? 40 : 60 });
}
const FIELD: Record<string, 'revenue' | 'food'> = { [REVENUE]: 'revenue', [FOOD]: 'food' };

const receipt = (extra: Partial<PipelineReceipt> = {}): PipelineReceipt => ({
  version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, ...extra,
} as PipelineReceipt);

/** What the pipeline would return for a settled reading over DAYS. */
function answer(intent: AnalyticalIntentV1, tier: 'semantic' | 'exploratory' = 'semantic', data: typeof DAYS = DAYS): PipelineOutcome {
  const window = intent.time?.window;
  const rows = data.filter((row) => !window || (row.day >= window.start && row.day < window.end));
  const time = intent.groupBy.find((group) => group.role === 'time');
  if (!time && rows.length === 0) {
    return { kind: 'gap', gap: 'not_retrieved', message: 'no rows matched', nearest: [], text: '', offerExploration: false, intent, receipt: receipt({ warehouse: { attempts: 1, failures: 0 }, executed: { tier: 'semantic', sqlFingerprint: 'x', rowCount: 0, ms: 1, proofs: [] } }) };
  }
  const timeColumn = `ordered_at__${time?.grain}`;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = time ? (time.grain === 'day' ? row.day : `${row.day.slice(0, 7)}-01`) : 'all';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const names = intent.measures.map((measure) => measure.alias ?? measure.ref);
  const result = {
    columns: [...(time ? [timeColumn] : []), ...names],
    rows: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => ({
      ...(time ? { [timeColumn]: key } : {}),
      ...Object.fromEntries(intent.measures.map((measure, index) => [names[index], members.reduce((sum, row) => sum + row[FIELD[measure.ref]!], 0)])),
    })),
    rowCount: time ? groups.size : 1,
    executionTimeMs: 1,
    columnsMeta: [
      ...(time ? [{ name: timeColumn, kind: 'date' as const, ref: TIME, grain: time.grain }] : []),
      ...intent.measures.map((measure, index) => ({ name: names[index]!, kind: 'currency' as const, unit: 'USD', ref: measure.ref })),
    ],
  };
  return {
    kind: 'answered', intent, text: '', result,
    candidate: { tier, trust: tier === 'exploratory' ? 'review_required' : 'governed', sql: 'SELECT 1', proof: [] } as unknown as Extract<PipelineOutcome, { kind: 'answered' }>['candidate'],
    receipt: receipt({ warehouse: { attempts: 1, failures: 0 }, dispatches: [] }),
  };
}

const reading = (overrides: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 => ({
  version: 1, kind: 'analytics', reading: 'Revenue last month.',
  measures: [{ ref: REVENUE }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {},
  time: { ref: TIME, grain: 'month', window: { start: '2026-08-01', end: '2026-09-01', expression: 'last month' } },
  ...overrides,
} as AnalyticalIntentV1);

const august = reading({ reading: 'Revenue in August 2025.', time: { ref: TIME, grain: 'month', window: { start: '2025-08-01', end: '2025-09-01' } } });

function scripted(options: { read?: PipelineOutcome; remainingMs?: number; signal?: AbortSignal; contextSources?: InvestigationContextSource[]; tier?: 'semantic' | 'exploratory'; data?: typeof DAYS } = {}) {
  const ran: AnalyticalIntentV1[] = [];
  const allowed: boolean[] = [];
  const steps: AskStoryStepV1[] = [];
  let reads = 0;
  const runtime: InvestigationRuntime = {
    read: async () => {
      reads += 1;
      if (!options.read) throw new Error('an investigation started from an answer must not read the question again');
      return options.read;
    },
    runIntent: async (intent, runOptions) => { ran.push(intent); allowed.push(runOptions.allowAiSql); return answer(intent, options.tier, options.data); },
    vocabulary: () => vocabulary,
    remainingMs: () => options.remainingMs ?? 180_000,
    onStep: (step) => { steps.push(step); },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.contextSources ? { contextSources: options.contextSources } : {}),
  };
  return { runtime, ran, allowed, steps, reads: () => reads };
}

const readingOutcome = (intent: AnalyticalIntentV1): PipelineOutcome => ({ kind: 'reading', intent, lane: 'governed', text: intent.reading, receipt: receipt({ dispatches: [{ purpose: 'intent:resolve', ms: 1 }] }) });
const fromRun = (intent: AnalyticalIntentV1): InvestigationFrameSource => ({ kind: 'run', runId: 'run-1', intent });

async function investigate(source: InvestigationFrameSource, script: ReturnType<typeof scripted>, limits?: Partial<InvestigationLimits>): Promise<Extract<InvestigationOutcome, { kind: 'report' }>> {
  const outcome = await runInvestigation({ question: 'why did revenue drop?', source, runtime: script.runtime, ...(limits ? { limits } : {}), now: () => new Date('2026-09-12T12:00:00Z') });
  if (outcome.kind !== 'report') throw new Error(`expected a report, got ${outcome.kind}`);
  return outcome;
}

const expectVerified = (report: InvestigationReportV1) => {
  const verification = verifyAskNarration({ text: report.text, factSet: report.facts });
  expect(verification, report.text).toMatchObject({ ok: true });
};

describe('an investigation of a change', () => {
  it('reads the question once, finds where the data ends, moves "last month" to the latest complete month and measures it exactly', async () => {
    const script = scripted({ read: readingOutcome(reading()) });
    const { report, receipt: ledger } = await investigate({ kind: 'question' }, script);

    expect(script.reads()).toBe(1);
    expect(report.frame).toMatchObject({ windowBasis: 'shifted_to_data', observedThrough: '2025-08-21' });
    expect(report.frame.windows.current).toEqual({ start: '2025-07-01', end: '2025-08-01', label: 'July 2025' });
    expect(report.frame.windows.prior.label).toBe('June 2025');
    expect(report.headline).toMatchObject({ verdict: 'change', pct: '-17.3' });
    expect(Number(report.headline.current!.value)).toBe(31 * 80);
    expect(Number(report.headline.prior!.value)).toBe(30 * 100);
    expect(Number(report.headline.delta!.value)).toBe(31 * 80 - 30 * 100);
    expect(Number(report.headline.yearAgo!.value)).toBe(31 * 100);
    expect(report.headline.text).toBe('Revenue fell 520.00 (17.3%) in July 2025 compared with June 2025: 2480.00 against 3000.00. Compared with July 2024 (3100.00), it was down 620.00 (20.0%).');
    expect(report.caveats.map((caveat) => caveat.code)).toEqual(['shifted_to_data']);
    expect(report.confidence.level).toBe('high');
    expectVerified(report);

    expect(ledger.programs.map((program) => program.kind)).toEqual(['frame', 'freshness', 'headline', 'coverage', 'report']);
    expect(ledger.budget).toMatchObject({ statementsUsed: 4, aiCalls: 1 });
    expect(report.queries.map((query) => query.purpose)).toEqual(['freshness', 'freshness', 'headline', 'coverage']);
    expect(ledger.queries).toHaveLength(4);
    expect(script.steps.map((step) => step.title)).toContain('The data runs through 2025-08-20');
    expect(script.steps.every((step) => step.programId)).toBe(true);
  });

  it('started from an answer, it asks the AI nothing and says when a period has far fewer days of data', async () => {
    const script = scripted();
    const { report, receipt: ledger } = await investigate(fromRun(august), script);

    expect(script.reads()).toBe(0);
    expect(ledger.budget).toMatchObject({ statementsUsed: 2, aiCalls: 0 });
    expect(report.frame).toMatchObject({ windowBasis: 'source_run', source: { kind: 'run', runId: 'run-1' } });
    expect(Number(report.headline.current!.value)).toBe(20 * 90);
    expect(Number(report.headline.prior!.value)).toBe(31 * 80);
    expect(report.caveats.map((caveat) => caveat.code)).toEqual(['coverage_gap']);
    expect(report.caveats[0]!.text).toContain('65%');
    expect(report.confidence.level).toBe('low');
    expectVerified(report);
  });

  it('when a governed metric falls to AI-written SQL, the coverage check may draft SQL too, and the report says why confidence is low', async () => {
    const script = scripted({ tier: 'exploratory' });
    const { report, receipt: ledger } = await investigate(fromRun(august), script);
    expect(report.frame.lane).toBe('governed');
    expect(ledger.programs.find((program) => program.kind === 'coverage')?.outcome).toBe('done');
    // headline, then coverage: the coverage query is allowed to draft because the headline had to.
    expect(script.allowed).toEqual([true, true]);
    expect(report.caveats.map((caveat) => caveat.code)).toEqual(['ai_sql', 'coverage_gap']);
    expect(report.confidence).toMatchObject({ level: 'low', reasons: expect.arrayContaining(['the governed metric could not be computed, so AI-written SQL was used']) });
  });

  it('data stamped once a month (every row on the 1st) counts its last month as complete', async () => {
    const stamped = Array.from({ length: 15 }, (_, index) => ({ day: new Date(Date.UTC(2024, 5 + index, 1)).toISOString().slice(0, 10), revenue: 1000 + index * 10, food: 500 }));
    const script = scripted({ read: readingOutcome(reading()), data: stamped });
    const { report } = await investigate({ kind: 'question' }, script);
    expect(report.frame).toMatchObject({ observedThrough: '2025-09-01', windowBasis: 'shifted_to_data' });
    expect(report.frame.windows.current.label).toBe('August 2025');
    expect(Number(report.headline.current!.value)).toBe(1000 + 14 * 10);
    expect(Number(report.headline.prior!.value)).toBe(1000 + 13 * 10);
  });

  it('a share reads as a percent and changes in points', async () => {
    const share = reading({
      reading: 'Food share of revenue in July 2025.',
      measures: [{ ref: 'ratio:food/revenue', alias: 'food_share', derived: { numerator: FOOD, denominator: REVENUE } }] as AnalyticalIntentV1['measures'],
      time: { ref: TIME, grain: 'month', window: { start: '2025-07-01', end: '2025-08-01' } },
    });
    const script = scripted({ read: readingOutcome(share) });
    const { report } = await investigate({ kind: 'question' }, script);
    expect(script.ran[0]!.measures.map((measure) => measure.alias)).toEqual(['numerator', 'denominator']);
    expect(report.headline.text).toBe('Food share fell 10.0 points in July 2025 compared with June 2025: 50.0% against 60.0%. Compared with July 2024 (60.0%), it was down 10.0 points.');
    expectVerified(report);
  });

  it('a period with no data is reported as no data, not as a fall to zero', async () => {
    const script = scripted();
    const { report } = await investigate(fromRun(reading({ time: { ref: TIME, grain: 'month', window: { start: '2023-01-01', end: '2023-02-01' } } })), script);
    expect(report).toMatchObject({ status: 'no_data', headline: { verdict: 'no_data' }, confidence: { level: 'low' } });
    expect(report.headline.text).toBe('No Revenue was recorded for January 2023 or December 2022.');
  });

  it('a period that starts before the data does is not measured, never summed from the part the data holds', async () => {
    const script = scripted();
    const { report } = await investigate(fromRun(reading({ time: { ref: TIME, grain: 'month', window: { start: '2024-06-01', end: '2024-09-01' } } })), script);
    expect(report.frame.windows.prior.label).toBe('March 2024 to May 2024');
    expect(Number(report.headline.current!.value)).toBe(30 * 100 + 31 * 100 + 31 * 100);
    expect(report.headline.prior).toBeUndefined();
    expect(report.headline.yearAgo).toBeUndefined();
    expect(report.status).toBe('no_data');
    expect(report.headline.text).toContain('March 2024 to May 2024 starts before the data does (the first month with data is June 2024)');

    // A semantic engine that returns the months before the data as zero rows
    // does not turn them into a measured zero.
    const zeroFilled = scripted();
    const plain = zeroFilled.runtime.runIntent;
    zeroFilled.runtime.runIntent = async (intent, options) => {
      const outcome = await plain(intent, options);
      const monthly = intent.groupBy.some((group) => group.role === 'time' && group.grain === 'month');
      if (outcome.kind !== 'answered' || !monthly) return outcome;
      const column = outcome.result.columns[0]!;
      const start = intent.time?.window?.start ?? '';
      const filler = ['2024-03-01', '2024-04-01', '2024-05-01'].filter((day) => day >= start).map((day) => ({ [column]: day, value: 0 }));
      return { ...outcome, result: { ...outcome.result, rows: [...filler, ...outcome.result.rows], rowCount: outcome.result.rowCount + filler.length } };
    };
    const filled = await investigate(fromRun(reading({ time: { ref: TIME, grain: 'month', window: { start: '2024-06-01', end: '2024-09-01' } } })), zeroFilled);
    expect(filled.report.headline.prior).toBeUndefined();
    expect(filled.report.headline.yearAgo).toBeUndefined();
    expect(filled.report.headline.text).toContain('the first month with data is June 2024');
  });

  it('stops at the statement budget: a measured headline keeps its figures, an unmeasured one is incomplete', async () => {
    const partial = await investigate(fromRun(august), scripted(), { maxStatements: 1 });
    expect(partial.receipt.budget).toMatchObject({ statementsUsed: 1, stoppedBy: 'budget' });
    expect(partial.report.status).toBe('answered');
    expect(partial.report.caveats.map((caveat) => caveat.code)).toContain('budget');
    expect(partial.report.confidence.level).toBe('medium');

    const none = scripted();
    const stopped = await investigate(fromRun(august), none, { maxStatements: 0 });
    expect(none.ran).toHaveLength(0);
    expect(stopped.report).toMatchObject({ status: 'incomplete', headline: { verdict: 'incomplete' }, confidence: { level: 'low' } });
    expectVerified(stopped.report);
  });

  it('starts no query once the run is cancelled or out of time', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = scripted({ signal: controller.signal });
    const outcome = await investigate(fromRun(august), cancelled);
    expect(cancelled.ran).toHaveLength(0);
    expect(outcome.receipt.budget.stoppedBy).toBe('cancelled');

    const late = scripted({ remainingMs: 10_000 });
    const deadline = await investigate(fromRun(august), late);
    expect(late.ran).toHaveLength(0);
    expect(deadline.report.caveats.map((caveat) => caveat.code)).toContain('deadline');
  });

  it('asks every context source after the frame and after the drivers, and a failing source never fails the run', async () => {
    const stages: string[] = [];
    const docs: InvestigationContextSource = {
      id: 'docs', kind: 'document',
      gather: async ({ stage }) => { stages.push(stage); return [{ sourceId: 'ignored', title: 'Menu change', excerpt: 'A note from the team.', provenance: 'external' }]; },
    };
    const broken: InvestigationContextSource = { id: 'broken', kind: 'mcp', gather: async () => { throw new Error('server unavailable'); } };
    const { report, receipt: ledger } = await investigate(fromRun(august), scripted({ contextSources: [docs, broken] }));
    expect(stages).toEqual(['after_frame', 'after_drivers']);
    expect(report.context).toHaveLength(2);
    expect(report.context.every((item) => item.sourceId === 'docs')).toBe(true);
    expect(ledger.contextSources.filter((entry) => entry.id === 'broken').map((entry) => entry.error)).toEqual(['server unavailable', 'server unavailable']);
  });

  it('a reading that ends the turn is handed back, and a reading with no measure asks for one', async () => {
    const conversation: PipelineOutcome = { kind: 'conversation', reply: 'Hello!', text: 'Hello!', receipt: receipt() };
    const ended = await runInvestigation({ question: 'hi', source: { kind: 'question' }, runtime: scripted({ read: conversation }).runtime });
    expect(ended.kind).toBe('reading_ended');

    const clarify = await runInvestigation({ question: 'why?', source: { kind: 'question' }, runtime: scripted({ read: readingOutcome(reading({ measures: [] })) }).runtime });
    expect(clarify.kind).toBe('clarify');
  });
});
