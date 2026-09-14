import { describe, expect, it } from 'vitest';
import { formatDecimal, parseExactDecimal } from '../../analytical-execution-graph.js';
import type { AnalyticalIntentV1 } from '../../ask-pipeline/intent.js';
import type { PipelineOutcome, PipelineReceipt } from '../../ask-pipeline/outcomes.js';
import { buildVocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import type { InvestigationRun } from './context.js';
import { measureContribution } from './drivers.js';
import type { InvestigationFrameV1, InvestigationRuntime } from './types.js';

const TIME = 'dimension:orders.ordered_at';
const CATEGORY = 'dimension:orders.category';
const REVENUE = 'metric:orders.revenue';
const SEASON = 'dimension:player_seasons.season';
const TEAM = 'dimension:player_seasons.team';
const POINTS = 'metric:player_seasons.points';

const vocabulary = buildVocabularyIndex({
  metrics: [
    { name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' },
    { name: 'points', model: 'player_seasons', label: 'Points', aggregation: 'sum' },
  ],
  dimensions: [
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
    { name: 'category', model: 'orders', label: 'Category', dataType: 'string' },
    { name: 'season', model: 'player_seasons', label: 'Season', dataType: 'number' },
    { name: 'team', model: 'player_seasons', label: 'Team', dataType: 'string' },
  ],
});

const receipt = (): PipelineReceipt => ({ version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, warehouse: { attempts: 1, failures: 0 } } as PipelineReceipt);

function answered(intent: AnalyticalIntentV1, columns: Array<{ name: string; ref: string; kind: string }>, rows: Array<Record<string, unknown>>, truncated = false): PipelineOutcome {
  return {
    kind: 'answered', intent, text: '',
    result: { columns: columns.map((column) => column.name), rows, rowCount: rows.length, executionTimeMs: 1, columnsMeta: columns as never, ...(truncated ? { truncated: true } : {}) },
    candidate: { tier: 'semantic', trust: 'governed', sql: 'SELECT 1', proof: [] } as never,
    receipt: receipt(),
  } as PipelineOutcome;
}

function runOver(runIntent: InvestigationRuntime['runIntent']) {
  const ran: AnalyticalIntentV1[] = [];
  const runtime: InvestigationRuntime = {
    read: async () => { throw new Error('not read'); },
    runIntent: async (intent, options) => { ran.push(intent); return runIntent(intent, options); },
    vocabulary: () => vocabulary,
    remainingMs: () => 180_000,
    onStep: () => undefined,
  };
  const run: InvestigationRun = {
    question: 'why', runtime, limits: { maxStatements: 20, minRemainingMs: 25_000 }, queries: [], caveats: [],
    receipt: { version: 1, programs: [], queries: [], budget: { statementsCap: 20, statementsUsed: 0, aiCalls: 0 }, contextSources: [] },
  };
  return { run, ran };
}

const monthFrame: InvestigationFrameV1 = {
  version: 1, question: 'why did revenue drop?', reading: 'Revenue in August 2025.', source: { kind: 'question' },
  metric: { ref: REVENUE, label: 'Revenue', additivity: 'additive' }, timeRef: TIME, grain: 'month',
  windows: {
    current: { start: '2025-08-01', end: '2025-09-01', label: 'August 2025' },
    prior: { start: '2025-07-01', end: '2025-08-01', label: 'July 2025' },
    yearAgo: { start: '2024-08-01', end: '2024-09-01', label: 'August 2024' },
    yearAgoPrior: { start: '2024-07-01', end: '2024-08-01', label: 'July 2024' },
  },
  windowBasis: 'stated', baseFilters: [], shape: 'change', lane: 'governed', notes: [],
};

const MONTHLY = [
  { ordered_at__month: '2025-07-01', category: 'food', value: 700 },
  { ordered_at__month: '2025-07-01', category: 'beverage', value: 300 },
  { ordered_at__month: '2025-08-01', category: 'food', value: 700 },
  { ordered_at__month: '2025-08-01', category: 'beverage', value: 150 },
];
const MONTHLY_COLUMNS = [{ name: 'category', ref: CATEGORY, kind: 'text' }, { name: 'ordered_at__month', ref: TIME, kind: 'date' }, { name: 'value', ref: REVENUE, kind: 'currency' }];
const totals = { current: parseExactDecimal(850)!, prior: parseExactDecimal(1000)! };

describe('the contribution program', () => {
  it('reads the metric by the dimension and the month over both periods in one query, and splits the change', async () => {
    const { run, ran } = runOver(async (intent) => answered(intent, MONTHLY_COLUMNS, MONTHLY));
    const outcome = await measureContribution(run, monthFrame, { ref: CATEGORY, label: 'Category' }, { totals, allowAiSql: false });
    if (outcome.status !== 'measured') throw new Error(`expected a measured contribution, got ${outcome.status}`);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.groupBy).toEqual([{ ref: CATEGORY, role: 'categorical' }, { ref: TIME, role: 'time', grain: 'month' }]);
    expect(ran[0]!.time?.window).toEqual({ start: '2025-07-01', end: '2025-09-01' });
    expect(outcome.table.reconciles).toBe(true);
    const [top] = outcome.table.rows;
    expect([top!.label, formatDecimal(top!.delta!), formatDecimal(top!.share!), formatDecimal(top!.excess!)]).toEqual(['beverage', '-150', '1', '0.7']);
    expect(outcome.queryIds).toEqual(['q1']);
    expect(run.queries[0]).toMatchObject({ purpose: 'contribution', programId: `contribution:${CATEGORY}` });
  });

  it('a result cut at the row cap is not split: too many members to account for', async () => {
    const { run } = runOver(async (intent) => answered(intent, MONTHLY_COLUMNS, MONTHLY, true));
    const outcome = await measureContribution(run, monthFrame, { ref: CATEGORY, label: 'Category' }, { totals, allowAiSql: false });
    expect(outcome).toMatchObject({ status: 'truncated', queryIds: ['q1'] });
  });

  it('a dimension the metric cannot be grouped by is not expressible, never approximated', async () => {
    const { run } = runOver(async (intent) => ({ kind: 'gap', gap: 'not_modeled', message: 'the native semantic engine could not compose metrics revenue by orders.category: no join path', nearest: [], text: '', offerExploration: false, intent, receipt: receipt() }) as PipelineOutcome);
    const outcome = await measureContribution(run, monthFrame, { ref: CATEGORY, label: 'Category' }, { totals, allowAiSql: false });
    expect(outcome.status).toBe('not_expressible');
  });

  it('over seasons, it groups by the dimension and the season and places each row by its season', async () => {
    const seasonFrame: InvestigationFrameV1 = {
      ...monthFrame, reading: 'Points in the 2017 season.', metric: { ref: POINTS, label: 'Points', additivity: 'additive' }, timeRef: SEASON, grain: 'year',
      windows: {
        current: { start: '2017', end: '2018', label: '2017 season' }, prior: { start: '2016', end: '2017', label: '2016 season' },
        yearAgo: { start: '2016', end: '2017', label: '2016 season' }, yearAgoPrior: { start: '2015', end: '2016', label: '2015 season' },
      },
      periodAxis: { ref: SEASON, name: 'season' },
    };
    const rows = [
      { team: 'CLE', season: 2016, points: 2000 }, { team: 'LAL', season: 2016, points: 585 },
      { team: 'CLE', season: 2017, points: 3016 },
    ];
    const { run, ran } = runOver(async (intent) => answered(intent, [{ name: 'team', ref: TEAM, kind: 'text' }, { name: 'season', ref: SEASON, kind: 'number' }, { name: 'points', ref: POINTS, kind: 'number' }], rows));
    const outcome = await measureContribution(run, seasonFrame, { ref: TEAM, label: 'Team' }, { totals: { current: parseExactDecimal(3016)!, prior: parseExactDecimal(2585)! }, allowAiSql: false });
    if (outcome.status !== 'measured') throw new Error(`expected a measured contribution, got ${outcome.status}`);
    expect(ran[0]!.groupBy).toEqual([{ ref: TEAM, role: 'categorical' }, { ref: SEASON, role: 'categorical' }]);
    expect(ran[0]!.filters).toEqual([{ ref: SEASON, op: 'gte', values: [2016], source: 'inherited' }, { ref: SEASON, op: 'lt', values: [2018], source: 'inherited' }]);
    const byTeam = Object.fromEntries(outcome.table.rows.map((row) => [row.label, row]));
    expect(formatDecimal(byTeam.CLE!.delta!)).toBe('1016');
    expect(byTeam.LAL).toMatchObject({ status: 'gone', role: 'offset' });
    expect(outcome.table.reconciles).toBe(true);
  });
});
