import { describe, expect, it } from 'vitest';
import type { AnalyticalIntentV1 } from './intent.js';
import { applySkillPolicies, bindRequiredFilter } from './policies.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

const source: VocabularySource = {
  metrics: [
    { name: 'revenue', model: 'order_item', label: 'Revenue', aggregation: 'sum', sourceId: 'revenue' },
    { name: 'order_total', model: 'orders', label: 'Order Total', aggregation: 'sum', sourceId: 'order_total' },
  ],
  dimensions: [
    { name: 'is_test', model: 'orders', dataType: 'boolean' },
    { name: 'region', model: 'orders', dataType: 'string' },
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
    { name: 'shipped_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
};

function vocabularyWith(skills: NonNullable<VocabularySource['skills']>) {
  return buildVocabularyIndex({ ...source, skills });
}

function intent(overrides: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 {
  return {
    version: 1, kind: 'analytics', reading: 'revenue by region',
    measures: [{ ref: 'metric:order_item.revenue' }],
    groupBy: [{ ref: 'dimension:orders.region', role: 'categorical' }],
    display: [], filters: [], expectedShape: 'grouped', unresolved: [], provenance: {},
    ...overrides,
  };
}

describe('bindRequiredFilter', () => {
  const vocabulary = vocabularyWith([]);
  it('binds "<field> <op> <value>" to a governed ref and types the literal', () => {
    expect(bindRequiredFilter('is_test = false', vocabulary)).toEqual({ predicate: { ref: 'dimension:orders.is_test', op: 'eq', values: [false], source: 'question' } });
    expect(bindRequiredFilter("region in ('EMEA', 'APAC')", vocabulary)).toEqual({ predicate: { ref: 'dimension:orders.region', op: 'in', values: ['EMEA', 'APAC'], source: 'question' } });
    expect(bindRequiredFilter('orders.is_test', vocabulary)).toEqual({ predicate: { ref: 'dimension:orders.is_test', op: 'eq', values: [true], source: 'question' } });
  });
  it('refuses a field that names nothing governed, and never guesses a metric', () => {
    expect(bindRequiredFilter('is_internal = false', vocabulary)).toEqual({ problem: expect.stringContaining('"is_internal" names no governed dimension') });
    expect(bindRequiredFilter('revenue > 0', vocabulary)).toEqual({ problem: expect.stringContaining('"revenue" names no governed dimension') });
  });
});

describe('applySkillPolicies', () => {
  it('adds a selected skill\'s required filter to the intent with policy provenance, once', () => {
    const vocabulary = vocabularyWith([{ ref: 'skill:commerce.clean-orders', id: 'clean-orders', domain: 'commerce', requiredFilters: ['is_test = false'] }]);
    const target = intent();
    const outcome = applySkillPolicies(target, vocabulary, { now: () => NOW });
    expect(target.filters).toEqual([{ ref: 'dimension:orders.is_test', op: 'eq', values: [false], source: 'question' }]);
    expect(target.provenance['dimension:orders.is_test']).toBe('policy:skill:commerce.clean-orders:required filter is_test = false');
    expect(outcome.requiredFilters).toEqual(['is_test = false']);
    expect(outcome.refusal).toBeUndefined();
    // Already restricted on that ref: the question's own restriction stands.
    const restricted = intent({ filters: [{ ref: 'dimension:orders.is_test', op: 'eq', values: [true], source: 'question' }] });
    const second = applySkillPolicies(restricted, vocabulary, { now: () => NOW });
    expect(restricted.filters).toHaveLength(1);
    expect(second.applied.map((effect) => effect.effect)).toContain('already restricted on dimension:orders.is_test');
  });
  it('a required filter that cannot be bound is a typed refusal, never a dropped predicate', () => {
    const vocabulary = vocabularyWith([{ ref: 'skill:commerce.clean-orders', id: 'clean-orders', requiredFilters: ['is_internal = false'] }]);
    const target = intent();
    const outcome = applySkillPolicies(target, vocabulary, { now: () => NOW });
    expect(outcome.refusal).toMatchObject({ code: 'policy_filter_unbindable', repairable: false });
    expect(outcome.refusal?.message).toContain('is_internal');
    expect(target.filters).toEqual([]);
  });
  it('the domain\'s required filters bind the same way', () => {
    const target = intent();
    applySkillPolicies(target, vocabularyWith([]), { now: () => NOW, extraRequiredFilters: ['is_test = false'] });
    expect(target.provenance['dimension:orders.is_test']).toBe('policy:domain:required filter is_test = false');
  });
  it('a policy scoped to metrics applies only when one of them is read', () => {
    const policy = { policyId: 'closed-months', metricIds: ['order_total'], completenessPolicy: 'latest_complete' };
    const vocabulary = vocabularyWith([{ ref: 'skill:commerce.closed-months', id: 'closed-months', policy }]);
    const window = { start: '2026-01-01', end: '2026-12-31', expression: '2026' };
    const unrelated = intent({ time: { ref: 'dimension:orders.ordered_at', window } });
    const skipped = applySkillPolicies(unrelated, vocabulary, { now: () => NOW });
    expect(unrelated.time?.window.end).toBe('2026-12-31');
    expect(skipped.applied).toEqual([{ policyId: 'closed-months', field: 'applicability', effect: 'skipped: none of its metrics is read' }]);
    const related = intent({ measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'dimension:orders.ordered_at', role: 'time', grain: 'month' }], time: { ref: 'dimension:orders.ordered_at', window } });
    const applied = applySkillPolicies(related, vocabulary, { now: () => NOW });
    // The running month (September 2026) is left out; the window closes at its first day.
    expect(related.time?.window).toEqual({ start: '2026-01-01', end: '2026-09-01', expression: '2026 (complete months only)' });
    expect(related.provenance.time).toContain('latest_complete');
    expect(applied.applied.some((effect) => effect.field === 'completenessPolicy')).toBe(true);
  });
  it('a completeness policy uses the grouping grain and refuses a window with no complete period', () => {
    const vocabulary = vocabularyWith([{ ref: 'skill:commerce.closed', id: 'closed', policy: { completenessPolicy: 'closed_period' } }]);
    const monthly = intent({ groupBy: [{ ref: 'dimension:orders.ordered_at', role: 'time', grain: 'month' }], time: { ref: 'dimension:orders.ordered_at', window: { start: '2026-07-01', end: '2026-10-01', expression: 'Q3 2026' } } });
    applySkillPolicies(monthly, vocabulary, { now: () => NOW });
    expect(monthly.time?.window).toEqual({ start: '2026-07-01', end: '2026-09-01', expression: 'Q3 2026 (complete months only)' });
    const running = intent({ time: { ref: 'dimension:orders.ordered_at', window: { start: '2026-09-01', end: '2026-10-01', expression: 'this month' } } });
    const outcome = applySkillPolicies(running, vocabulary, { now: () => NOW });
    expect(running.time?.window.end).toBe('2026-10-01');
    expect(outcome.gaps[0]).toContain('no complete month lies inside "this month"');
  });
  it('a time role binds a ref-less window and resolves a two-option period clause', () => {
    const vocabulary = vocabularyWith([{ ref: 'skill:commerce.ship-basis', id: 'ship-basis', policy: { timeRole: 'shipped_at' } }]);
    const bare = intent({ time: { window: { start: '2026-01-01', end: '2026-02-01', expression: 'January 2026' } } as AnalyticalIntentV1['time'] });
    applySkillPolicies(bare, vocabulary, { now: () => NOW });
    expect(bare.time?.ref).toBe('dimension:orders.shipped_at');
    expect(bare.provenance['dimension:orders.shipped_at']).toBe('policy:skill:commerce.ship-basis:time role');
    const ambiguous = intent({ unresolved: [{ clause: 'which date', options: ['dimension:orders.ordered_at', 'dimension:orders.shipped_at'], material: true }] });
    const outcome = applySkillPolicies(ambiguous, vocabulary, { now: () => NOW });
    // The clause is decided, not deleted: it stays as the record of the choice and no longer blocks execution.
    expect(ambiguous.unresolved).toEqual([expect.objectContaining({ clause: 'which date', material: false })]);
    expect(ambiguous.time?.ref).toBe('dimension:orders.shipped_at');
    expect(outcome.applied.some((effect) => effect.field === 'timeRole' && effect.effect.includes('resolved'))).toBe(true);
  });
  it('a default ranking period orders an unordered two-period ranking, and fiscal alignment needs a calendar', () => {
    const vocabulary = vocabularyWith([{ ref: 'skill:commerce.ranking', id: 'ranking', policy: { defaultRankingPeriod: 'current', comparisonAlignment: 'fiscal_period' } }]);
    const target = intent({
      expectedShape: 'ranking',
      measures: [
        { ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:orders.ordered_at', op: 'gte', values: ['2025-01-01'], source: 'question' }, { ref: 'dimension:orders.ordered_at', op: 'lt', values: ['2026-01-01'], source: 'question' }] },
        { ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:orders.ordered_at', op: 'gte', values: ['2026-01-01'], source: 'question' }, { ref: 'dimension:orders.ordered_at', op: 'lt', values: ['2027-01-01'], source: 'question' }] },
      ],
    });
    const outcome = applySkillPolicies(target, vocabulary, { now: () => NOW });
    expect(target.ordering).toEqual({ ref: 'measure:1', direction: 'desc' });
    expect(outcome.gaps).toEqual(['skill:commerce.ranking: fiscal alignment declared with no calendar']);
  });
  it('a skill with neither policy nor required filters changes nothing, and a non-analytics intent is untouched', () => {
    const vocabulary = vocabularyWith([{ ref: 'skill:commerce.notes', id: 'notes', description: 'Prose only.' }]);
    const target = intent();
    const before = JSON.stringify(target);
    expect(applySkillPolicies(target, vocabulary, { now: () => NOW })).toEqual({ applied: [], requiredFilters: [], gaps: [] });
    expect(JSON.stringify(target)).toBe(before);
    const chat = intent({ kind: 'conversation' });
    expect(applySkillPolicies(chat, vocabularyWith([{ ref: 'skill:x', id: 'x', requiredFilters: ['nothing = 1'] }]), { now: () => NOW }).refusal).toBeUndefined();
  });
});
