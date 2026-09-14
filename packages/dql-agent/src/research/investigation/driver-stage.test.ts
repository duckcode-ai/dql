import { describe, expect, it } from 'vitest';
import type { AnalyticalIntentV1 } from '../../ask-pipeline/intent.js';
import type { PipelineOutcome, PipelineReceipt } from '../../ask-pipeline/outcomes.js';
import { buildVocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import { verifyAskNarration } from '../../ask-result-narration.js';
import { runInvestigation } from './loop.js';
import type { InvestigationLimits, InvestigationReportV1, InvestigationRuntime } from './types.js';

const TIME = 'dimension:orders.ordered_at';
const REVENUE = 'metric:orders.revenue';
const CATEGORY = 'dimension:orders.category';
const LOCATION = 'dimension:orders.location';
const EXTRA = ['channel', 'segment', 'region', 'brand', 'size'];

const baseSource = {
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
    { name: 'category', model: 'orders', label: 'Category', dataType: 'string', description: 'Product category' },
    { name: 'location', model: 'orders', label: 'Location', dataType: 'string' },
  ],
};
const vocabulary = buildVocabularyIndex(baseSource);
const wideVocabulary = buildVocabularyIndex({ ...baseSource, dimensions: [...baseSource.dimensions, ...EXTRA.map((name) => ({ name, model: 'orders', dataType: 'string' }))] });
const FIELD: Record<string, 'category' | 'location'> = { [CATEGORY]: 'category', [LOCATION]: 'location' };

/**
 * Revenue by month, category and location. July and August 2024 and July 2025
 * are 1000 (beverage 300, food 700, split evenly between two locations); in
 * August 2025 beverage halves in both locations, so revenue is 850. The whole
 * drop is beverage, and it is spread evenly across locations.
 */
const ROWS: Array<{ month: string; category: string; location: string; revenue: number }> = [];
for (const [month, beverage] of [['2024-07-01', 150], ['2024-08-01', 150], ['2025-07-01', 150], ['2025-08-01', 75]] as const) {
  for (const location of ['Downtown', 'Airport']) {
    ROWS.push({ month, category: 'beverage', location, revenue: beverage }, { month, category: 'food', location, revenue: 350 });
  }
}

const receipt = (): PipelineReceipt => ({ version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, warehouse: { attempts: 1, failures: 0 } } as PipelineReceipt);

function answer(intent: AnalyticalIntentV1): PipelineOutcome {
  // The other dimensions of the wide vocabulary have no data here: the pipeline cannot group by them.
  const unknown = intent.groupBy.find((group) => group.role !== 'time' && !FIELD[group.ref]);
  if (unknown) {
    return { kind: 'gap', gap: 'not_modeled', message: `the native semantic engine could not compose metrics revenue by ${unknown.ref}: no join path`, nearest: [], text: '', offerExploration: false, intent, receipt: receipt() } as PipelineOutcome;
  }
  const window = intent.time?.window;
  let rows = ROWS.filter((row) => !window || (row.month >= window.start && row.month < window.end));
  for (const filter of intent.filters) {
    const field = FIELD[filter.ref];
    if (field && filter.op === 'eq') rows = rows.filter((row) => row[field] === filter.values[0]);
  }
  const columnOf = (group: AnalyticalIntentV1['groupBy'][number]) => (group.role === 'time' ? `ordered_at__${group.grain}` : FIELD[group.ref]!);
  const groups = new Map<string, { key: Record<string, unknown>; value: number }>();
  for (const row of rows) {
    const key = Object.fromEntries(intent.groupBy.map((group) => [columnOf(group), group.role === 'time' ? row.month : row[FIELD[group.ref]!]]));
    const id = JSON.stringify(key);
    const entry = groups.get(id) ?? { key, value: 0 };
    entry.value += row.revenue;
    groups.set(id, entry);
  }
  const columns = [...intent.groupBy.map(columnOf), 'value'];
  return {
    kind: 'answered', intent, text: '',
    result: {
      columns,
      rows: [...groups.values()].map((entry) => ({ ...entry.key, value: entry.value })),
      rowCount: groups.size,
      executionTimeMs: 1,
      columnsMeta: [
        ...intent.groupBy.map((group) => (group.role === 'time' ? { name: columnOf(group), kind: 'date' as const, ref: TIME } : { name: columnOf(group), kind: 'text' as const, ref: group.ref })),
        { name: 'value', kind: 'currency' as const, unit: 'USD', ref: REVENUE },
      ] as never,
    },
    candidate: { tier: 'semantic', trust: 'governed', sql: 'SELECT 1', proof: [] } as never,
    receipt: receipt(),
  } as PipelineOutcome;
}

const august = {
  version: 1, kind: 'analytics', reading: 'Revenue in August 2025.', measures: [{ ref: REVENUE }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {},
  time: { ref: TIME, grain: 'month', window: { start: '2025-08-01', end: '2025-09-01' } },
} as AnalyticalIntentV1;

async function investigate(options: { vocabulary?: typeof vocabulary; selectDimensions?: InvestigationRuntime['selectDimensions']; limits?: Partial<InvestigationLimits> } = {}) {
  const ran: AnalyticalIntentV1[] = [];
  const runtime: InvestigationRuntime = {
    read: async () => { throw new Error('an investigation started from an answer must not read the question again'); },
    runIntent: async (intent) => { ran.push(intent); return answer(intent); },
    vocabulary: () => options.vocabulary ?? vocabulary,
    remainingMs: () => 180_000,
    onStep: () => undefined,
    ...(options.selectDimensions ? { selectDimensions: options.selectDimensions } : {}),
  };
  const outcome = await runInvestigation({
    question: 'Why did revenue drop in August 2025?', source: { kind: 'run', runId: 'run-1', intent: august }, runtime,
    ...(options.limits ? { limits: options.limits } : {}), now: () => new Date('2026-09-13T12:00:00Z'),
  });
  if (outcome.kind !== 'report') throw new Error(`expected a report, got ${outcome.kind}`);
  return { ...outcome, ran };
}

const expectVerified = (report: InvestigationReportV1) => {
  expect(verifyAskNarration({ text: report.text, factSet: report.facts }), report.text).toMatchObject({ ok: true });
};

describe('where the change came from', () => {
  it('breaks the drop down by each dimension, finds it all in beverage, rules out location, drills into beverage and checks it a year earlier', async () => {
    const { report, receipt: ledger } = await investigate();
    expect(report.headline).toMatchObject({ verdict: 'change', text: 'Revenue fell 150.00 (15.0%) in August 2025 compared with July 2025: 850.00 against 1000.00. Compared with August 2024 (1000.00), it was down 150.00 (15.0%).' });
    expect(report.drivers.map((driver) => [driver.path.map((step) => step.member.label).join(' › '), driver.verdict, driver.share, driver.excess, driver.delta.value])).toEqual([
      ['beverage', 'supported', '1', '0.7', '-150'],
    ]);
    expect(report.ruledOut.map((entry) => entry.text)).toEqual([
      "By Location, the change was spread in line with each member's size.",
      "By Location within Category: beverage, the change was spread in line with each member's size.",
    ]);
    expect(ledger.programs.map((program) => [program.kind, program.verdict ?? null])).toEqual([
      ['frame', null], ['headline', null], ['coverage', null],
      ['contribution', 'supported'], ['contribution', 'ruled_out'], ['drill', 'ruled_out'], ['seasonality', null], ['report', null],
    ]);
    expect(ledger.programs.find((program) => program.kind === 'drill')).toMatchObject({ id: `drill:beverage:${LOCATION}`, parentId: `contribution:${CATEGORY}` });
    expect(ledger.budget.statementsUsed).toBe(6);
    expect(report.text).toContain('Category: beverage accounted for 100.0% of the change, from 300.00 to 150.00, though it was 30.0% of Revenue in July 2025.');
    expect(report.confidence).toEqual({ level: 'high', reasons: [] });
    expect(report.notInvestigated).toEqual([]);
    expect(report.breakdowns?.map((entry) => [entry.dimension.label, entry.within?.member ?? null, entry.verdict, entry.reconciles, entry.members])).toEqual([
      ['Category', null, 'explains', true, 2],
      ['Location', null, 'ruled_out', true, 2],
      ['Location', 'beverage', 'ruled_out', true, 2],
    ]);
    expectVerified(report);
  });

  it('runs up to three breakdowns at once, keeps them in rank order, and never goes over the statement budget', async () => {
    let active = 0;
    let most = 0;
    const ran: string[] = [];
    const runtime: InvestigationRuntime = {
      read: async () => { throw new Error('not read'); },
      runIntent: async (intent) => {
        active += 1;
        most = Math.max(most, active);
        const breakdown = intent.groupBy.find((group) => group.role !== 'time');
        if (breakdown) ran.push(breakdown.ref);
        // The later-ranked dimension answers first.
        await new Promise((resolve) => setTimeout(resolve, breakdown?.ref === CATEGORY ? 15 : 2));
        active -= 1;
        return answer(intent);
      },
      vocabulary: () => wideVocabulary,
      remainingMs: () => 180_000,
      onStep: () => undefined,
    };
    const outcome = await runInvestigation({ question: 'Why did revenue drop in August 2025?', source: { kind: 'run', runId: 'run-1', intent: august }, runtime, now: () => new Date('2026-09-13T12:00:00Z') });
    if (outcome.kind !== 'report') throw new Error(outcome.kind);
    expect(most).toBe(3);
    expect(outcome.report.breakdowns?.filter((entry) => !entry.within).map((entry) => entry.dimension.label)).toEqual(['Category', 'Location']);
    expect(outcome.report.drivers[0]!.path[0]!.member.label).toBe('beverage');

    const tight = await investigate({ vocabulary: wideVocabulary, limits: { maxStatements: 4 } });
    expect(tight.receipt.budget.statementsUsed).toBeLessThanOrEqual(4);
  });

  it('with more dimensions than one investigation analyses, an AI chooses from the ranked list and the rest are not started', async () => {
    const prompts: string[] = [];
    const { report, receipt: ledger } = await investigate({
      vocabulary: wideVocabulary,
      selectDimensions: async (prompt) => { prompts.push(prompt); return `{"dimensions": ["${LOCATION}"]}`; },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`- ${CATEGORY}: Category (Product category)`);
    expect(ledger.budget.aiCalls).toBe(1);
    expect(ledger.programs.filter((program) => program.kind === 'contribution').map((program) => program.dimension)).toEqual([LOCATION]);
    expect(report.drivers).toEqual([]);
    expect(report.notInvestigated.map((entry) => [entry.dimension?.label, entry.reason])).toContainEqual(['Category', 'not_started']);
    expect(report.notInvestigated).toHaveLength(6);
    expectVerified(report);
  });

  it('an AI reply that names a dimension not on the list is ignored; a dimension the metric cannot be grouped by does not use up a place', async () => {
    const { report, receipt: ledger } = await investigate({ vocabulary: wideVocabulary, selectDimensions: async () => '{"dimensions": ["dimension:orders.made_up"]}' });
    // Category and location are measured; the five others cannot be grouped by, so every ranked dimension is tried.
    expect(ledger.programs.filter((program) => program.kind === 'contribution').map((program) => program.dimension)).toHaveLength(7);
    expect(report.notInvestigated.filter((entry) => entry.reason === 'not_expressible')).toHaveLength(5);
    expect(report.notInvestigated.some((entry) => entry.reason === 'not_started')).toBe(false);
  });

  it("once a model's join multiplies the metric's rows, its other dimensions are not queried", async () => {
    const itemVocabulary = buildVocabularyIndex({
      ...baseSource,
      dimensions: [
        ...baseSource.dimensions,
        { name: 'product', model: 'order_items', label: 'Product', dataType: 'string', reachableFrom: ['orders'], description: 'What was ordered' },
        { name: 'size', model: 'order_items', label: 'Size', dataType: 'string', reachableFrom: ['orders'], description: 'Cup size' },
      ],
    });
    const ran: AnalyticalIntentV1[] = [];
    const runtime: InvestigationRuntime = {
      read: async () => { throw new Error('not read'); },
      runIntent: async (intent) => {
        ran.push(intent);
        const itemLevel = intent.groupBy.some((group) => group.ref.startsWith('dimension:order_items.'));
        if (itemLevel) return { kind: 'gap', gap: 'not_modeled', message: 'the join multiplies fact rows (2088 base rows became 2910); the aggregate would be inflated, so nothing was executed', nearest: [], text: '', offerExploration: false, intent, receipt: receipt() } as PipelineOutcome;
        return answer(intent);
      },
      vocabulary: () => itemVocabulary,
      remainingMs: () => 180_000,
      onStep: () => undefined,
    };
    const outcome = await runInvestigation({ question: 'Why did revenue drop in August 2025?', source: { kind: 'run', runId: 'run-1', intent: august }, runtime, now: () => new Date('2026-09-13T12:00:00Z') });
    if (outcome.kind !== 'report') throw new Error(outcome.kind);
    const itemQueries = ran.filter((intent) => intent.groupBy.some((group) => group.ref.startsWith('dimension:order_items.')));
    expect(itemQueries).toHaveLength(1);
    expect(outcome.report.notInvestigated.filter((entry) => entry.reason === 'not_expressible').map((entry) => entry.dimension?.label).sort()).toEqual(['Product', 'Size']);
  });

  it('out of statements after one breakdown, it reports what was not broken down and why, at lower confidence', async () => {
    const { report, receipt: ledger } = await investigate({ limits: { maxStatements: 3 } });
    expect(ledger.budget).toMatchObject({ statementsUsed: 3, stoppedBy: 'budget' });
    expect(report.drivers.map((driver) => driver.path[0]!.member.label)).toEqual(['beverage']);
    expect(report.notInvestigated).toEqual([{ dimension: { ref: LOCATION, label: 'Location' }, reason: 'budget', detail: 'budget' }]);
    expect(report.text).toContain('Not broken down by Location: the query budget ran out.');
    expect(report.confidence.level).toBe('medium');
    expect(report.confidence.reasons).toEqual(expect.arrayContaining(['the investigation did not finish', 'only one dimension was analysed']));
    expectVerified(report);
  });
});
