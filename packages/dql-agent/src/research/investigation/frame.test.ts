import { describe, expect, it } from 'vitest';
import type { AnalyticalIntentV1, IntentPredicate } from '../../ask-pipeline/intent.js';
import { buildVocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import { frameNeedsFreshness, investigationWindowsFor, planInvestigationFrame, type InvestigationFramePlan } from './frame.js';

const vocabulary = buildVocabularyIndex({
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [
    { name: 'region', model: 'orders', label: 'Region', dataType: 'string' },
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
});
const TIME = 'dimension:orders.ordered_at';
const REVENUE = 'metric:orders.revenue';

const reading = (overrides: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 => ({
  version: 1, kind: 'analytics', reading: 'Revenue in August 2025.',
  measures: [{ ref: REVENUE }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {},
  time: { ref: TIME, grain: 'month', window: { start: '2025-08-01', end: '2025-09-01' } },
  ...overrides,
} as AnalyticalIntentV1);

const between = (start: string, end: string): IntentPredicate[] => [
  { ref: TIME, op: 'gte', values: [start] }, { ref: TIME, op: 'lt', values: [end] },
] as IntentPredicate[];

function planned(intent: AnalyticalIntentV1, lane: 'governed' | 'ai' = 'governed'): InvestigationFramePlan {
  const result = planInvestigationFrame({ reading: intent, vocabulary, lane });
  if (result.status !== 'planned') throw new Error(`expected a plan, got ${result.status}`);
  return result.plan;
}

describe('framing an investigation from a reading', () => {
  it('a stated period is investigated as stated, against the period before and the same period a year earlier', () => {
    const plan = planned(reading());
    expect(plan).toMatchObject({ metric: { ref: REVENUE, label: 'Revenue', additivity: 'additive' }, timeRef: TIME, grain: 'month', shape: 'level', stated: { current: { start: '2025-08-01', end: '2025-09-01' } } });
    expect(frameNeedsFreshness(plan)).toBe(false);
    const windows = investigationWindowsFor(plan, { now: new Date('2026-09-12T00:00:00Z') });
    expect(windows.windowBasis).toBe('stated');
    expect(windows.windows.current.label).toBe('August 2025');
    expect(windows.windows.prior.label).toBe('July 2025');
    expect(windows.windows.yearAgo.label).toBe('August 2024');
    expect(windows.windows.yearAgoPrior.label).toBe('July 2024');
    expect(investigationWindowsFor(plan, { now: new Date(), fromSourceRun: true }).windowBasis).toBe('source_run');
  });

  it('a relative period after the data ends moves to the latest complete period, and says so', () => {
    const plan = planned(reading({ time: { ref: TIME, grain: 'month', window: { start: '2026-08-01', end: '2026-09-01', expression: 'last month' } } }));
    expect(frameNeedsFreshness(plan)).toBe(true);
    const windows = investigationWindowsFor(plan, { observedThrough: '2025-08-21', now: new Date('2026-09-12T00:00:00Z') });
    expect(windows.windowBasis).toBe('shifted_to_data');
    expect(windows.windows.current).toEqual({ start: '2025-07-01', end: '2025-08-01', label: 'July 2025' });
    expect(windows.notes.join(' ')).toContain('the data runs through 2025-08-20');

    const inside = investigationWindowsFor(planned(reading({ time: { ref: TIME, grain: 'month', window: { start: '2025-07-01', end: '2025-08-01', expression: 'last month' } } })), { observedThrough: '2025-09-01', now: new Date('2025-08-12T00:00:00Z') });
    expect(inside.windowBasis).toBe('stated');
    expect(inside.windows.current.label).toBe('July 2025');
  });

  it('without a stated period, the latest complete period of the data, or of today when the data end is unknown', () => {
    const plan = planned(reading({ time: { ref: TIME, grain: 'month' } }));
    expect(frameNeedsFreshness(plan)).toBe(true);
    expect(investigationWindowsFor(plan, { observedThrough: '2025-09-01', now: new Date('2026-09-12T00:00:00Z') })).toMatchObject({ windowBasis: 'latest_complete', windows: { current: { label: 'August 2025' } } });
    const fromToday = investigationWindowsFor(plan, { now: new Date('2026-09-12T00:00:00Z') });
    expect(fromToday.windows.current.label).toBe('August 2026');
    expect(fromToday.notes).toHaveLength(1);
  });

  it('a change between two scoped measures compares the periods each names', () => {
    const plan = planned(reading({
      time: { ref: TIME, grain: 'month' },
      measures: [
        { ref: REVENUE, alias: 'july', scope: between('2025-07-01', '2025-08-01') },
        { ref: REVENUE, alias: 'august', scope: between('2025-08-01', '2025-09-01') },
        { ref: 'change:august-july', alias: 'change', change: { base: 'july', comparison: 'august' } },
      ] as AnalyticalIntentV1['measures'],
    }));
    expect(plan.shape).toBe('change');
    expect(plan.stated).toMatchObject({ current: { start: '2025-08-01', end: '2025-09-01' }, prior: { start: '2025-07-01', end: '2025-08-01' } });
    expect(investigationWindowsFor(plan, { now: new Date() }).windows.prior.label).toBe('July 2025');
  });

  it('every query keeps the reading\'s restrictions except the dates the periods replace', () => {
    const region = { ref: 'dimension:orders.region', op: 'eq', values: ['West'] } as IntentPredicate;
    const plan = planned(reading({ filters: [region, ...between('2025-01-01', '2026-01-01')] }));
    expect(plan.baseFilters).toEqual([region]);
  });

  it('a ratio compares its parts, and an average is not added across periods', () => {
    const ratio = planned(reading({ measures: [{ ref: 'ratio:food/revenue', alias: 'food_share', derived: { numerator: 'metric:orders.food_revenue', denominator: REVENUE } }] as AnalyticalIntentV1['measures'] }));
    expect(ratio.metric).toMatchObject({ additivity: 'ratio', label: 'food share', ratio: { numeratorRef: 'metric:orders.food_revenue', denominatorRef: REVENUE } });
    const average = planned(reading({ measures: [{ ref: 'column:dev.orders.amount', aggregation: 'avg' }] }), 'ai');
    expect(average.metric).toMatchObject({ additivity: 'non_additive', aggregation: 'avg' });
    expect(average.lane).toBe('ai');
  });

  it('asks for a measure when there is none, and declines what is not a change over time', () => {
    expect(planInvestigationFrame({ reading: reading({ measures: [] }), vocabulary, lane: 'governed' }).status).toBe('clarify');
    expect(planInvestigationFrame({ reading: reading({ kind: 'conversation' } as Partial<AnalyticalIntentV1>), vocabulary, lane: 'governed' }).status).toBe('not_investigable');
    const timeless = buildVocabularyIndex({ metrics: [{ name: 'headcount', model: 'teams', aggregation: 'sum' }] });
    const result = planInvestigationFrame({ reading: reading({ measures: [{ ref: 'metric:teams.headcount' }], time: undefined }), vocabulary: timeless, lane: 'governed' });
    expect(result).toMatchObject({ status: 'not_investigable' });
  });
});
