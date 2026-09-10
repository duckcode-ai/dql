import { describe, expect, it } from 'vitest';
import { parseIntent } from './intent.js';
import { dateLiteralBounds, fieldKind, proveLiterals, relativePeriodBounds } from './literal-proof.js';
import { composeRelational } from './prepare/index.js';
import { buildVocabularyIndex } from './vocabulary.js';

const NOW = new Date('2026-09-10T15:00:00.000Z');

describe('a relative period is the window it names, against today', () => {
  it('current, last and next units; to-date; spans of complete units; day words', () => {
    expect(relativePeriodBounds('current_month', NOW)).toEqual({ start: '2026-09-01', end: '2026-10-01', label: 'current month' });
    expect(relativePeriodBounds('last month', NOW)).toEqual({ start: '2026-08-01', end: '2026-09-01', label: 'last month' });
    expect(relativePeriodBounds('previous-quarter', NOW)).toEqual({ start: '2026-04-01', end: '2026-07-01', label: 'previous quarter' });
    expect(relativePeriodBounds('this year', NOW)).toEqual({ start: '2026-01-01', end: '2027-01-01', label: 'this year' });
    expect(relativePeriodBounds('next week', NOW)).toEqual({ start: '2026-09-14', end: '2026-09-21', label: 'next week' });
    expect(relativePeriodBounds('ytd', NOW)).toEqual({ start: '2026-01-01', end: '2026-09-11', label: 'ytd' });
    expect(relativePeriodBounds('last_3_months', NOW)).toEqual({ start: '2026-06-01', end: '2026-09-01', label: 'last 3 months' });
    expect(relativePeriodBounds('yesterday', NOW)).toEqual({ start: '2026-09-09', end: '2026-09-10', label: 'yesterday' });
    expect(relativePeriodBounds('soon', NOW)).toBeUndefined();
    expect(relativePeriodBounds('last season', NOW)).toBeUndefined();
  });
  it('a partial date is its whole period; a full timestamp is a point', () => {
    expect(dateLiteralBounds('2025')).toEqual({ start: '2025-01-01', end: '2026-01-01', label: '2025' });
    expect(dateLiteralBounds('2025-03')).toEqual({ start: '2025-03-01', end: '2025-04-01', label: '2025-03' });
    expect(dateLiteralBounds('2025-Q2')).toEqual({ start: '2025-04-01', end: '2025-07-01', label: '2025-Q2' });
    expect(dateLiteralBounds('2025-03-14')).toEqual({ start: '2025-03-14', end: '2025-03-15', label: '2025-03-14' });
    expect(dateLiteralBounds('2025-03-14T10:00:00Z')).toEqual({ point: '2025-03-14T10:00:00Z' });
    expect(dateLiteralBounds('2025-13')).toBeUndefined();
    expect(dateLiteralBounds('march')).toBeUndefined();
  });
});

describe('every literal is proven against its field before SQL', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_bcm', model: 'header', aggregation: 'sum', physical: { relation: 'cm.header', expr: 'SUM(cm.header.total_bcm)', aggregate: 'sum' } }],
    dimensions: [
      { name: 'report_as_of_dt', model: 'header', dataType: 'DATE', physical: { relation: 'cm.header', column: 'report_as_of_dt' } },
      { name: 'customer_name', model: 'header', dataType: 'VARCHAR', physical: { relation: 'cm.header', column: 'customer_name' } },
      { name: 'is_active', model: 'header', dataType: 'BOOLEAN', physical: { relation: 'cm.header', column: 'is_active' } },
      { name: 'score', model: 'header', dataType: 'NUMBER', physical: { relation: 'cm.header', column: 'score' } },
    ],
    relations: [{ schema: 'cm', name: 'header', columns: [{ name: 'total_bcm', dataType: 'NUMBER' }, { name: 'report_as_of_dt', dataType: 'DATE' }, { name: 'customer_name', dataType: 'VARCHAR' }, { name: 'is_active', dataType: 'BOOLEAN' }, { name: 'score', dataType: 'NUMBER' }] }],
  });
  const intent = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw }).intent!;
  it('fields are typed from their declared type', () => {
    expect(fieldKind(vocabulary.get('dimension:header.report_as_of_dt'))).toBe('date');
    expect(fieldKind(vocabulary.get('dimension:header.customer_name'))).toBe('text');
    expect(fieldKind(vocabulary.get('dimension:header.is_active'))).toBe('boolean');
    expect(fieldKind(vocabulary.get('dimension:header.score'))).toBe('numeric');
  });
  it('"current_month" and "last_month" in two scoped measures become their dates, and the composed SQL binds four date bounds', () => {
    const two = intent({
      measures: [
        { ref: 'metric:header.total_bcm', alias: 'total_bcm_current_month', scope: [{ ref: 'dimension:header.report_as_of_dt', op: 'eq', values: ['current_month'] }] },
        { ref: 'metric:header.total_bcm', alias: 'total_bcm_last_month', scope: [{ ref: 'dimension:header.report_as_of_dt', op: 'eq', values: ['last_month'] }] },
      ],
      filters: [{ ref: 'dimension:header.customer_name', op: 'eq', values: ['Capital One'] }],
    });
    const proven = proveLiterals(two, vocabulary, NOW);
    expect(proven.problems).toEqual([]);
    expect(proven.intent.measures[0]!.scope).toEqual([
      { ref: 'dimension:header.report_as_of_dt', op: 'gte', values: ['2026-09-01'], source: 'question' },
      { ref: 'dimension:header.report_as_of_dt', op: 'lt', values: ['2026-10-01'], source: 'question' },
    ]);
    expect(proven.intent.measures[1]!.scope?.map((p) => p.values[0])).toEqual(['2026-08-01', '2026-09-01']);
    expect(proven.notes).toEqual(['literal: report_as_of_dt: "current month" is 2026-09-01 to 2026-10-01 (half-open)', 'literal: report_as_of_dt: "last month" is 2026-08-01 to 2026-09-01 (half-open)']);
    // The text filter is untouched, and the composed program carries every bound as a parameter.
    expect(proven.intent.filters).toEqual(two.filters);
    const composed = composeRelational(proven.intent, vocabulary, {});
    expect(composed.candidate?.params?.filter((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))).toEqual(['2026-09-01', '2026-10-01', '2026-08-01', '2026-09-01']);
    expect(composed.candidate?.params).not.toContain('current_month');
  });
  it('a partial date on a date field is its window; a full date and a range operator keep their meaning', () => {
    const month = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.report_as_of_dt', op: 'eq', values: ['2025-03'] }] }), vocabulary, NOW);
    expect(month.intent.filters.map((p) => `${p.op} ${p.values[0]}`)).toEqual(['gte 2025-03-01', 'lt 2025-04-01']);
    const since = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.report_as_of_dt', op: 'gte', values: ['last_month'] }] }), vocabulary, NOW);
    expect(since.intent.filters).toEqual([{ ref: 'dimension:header.report_as_of_dt', op: 'gte', values: ['2026-08-01'], source: 'question' }]);
    const before = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.report_as_of_dt', op: 'lt', values: ['current_month'] }] }), vocabulary, NOW);
    expect(before.intent.filters[0]).toMatchObject({ op: 'lt', values: ['2026-09-01'] });
    const day = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.report_as_of_dt', op: 'gte', values: ['2025-03-14'] }] }), vocabulary, NOW);
    expect(day.intent.filters[0]).toMatchObject({ op: 'gte', values: ['2025-03-14'] });
  });
  it('a value no field of that kind can take is asked back, naming the field and what it accepts — never sent to the warehouse', () => {
    const vague = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.report_as_of_dt', op: 'eq', values: ['recently'] }] }), vocabulary, NOW);
    expect(vague.problems).toEqual([{ ref: 'dimension:header.report_as_of_dt', value: 'recently', message: expect.stringContaining('report_as_of_dt is a date; "recently" is neither a date nor a period') }]);
    const word = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.score', op: 'gt', values: ['high'] }] }), vocabulary, NOW);
    expect(word.problems[0]?.message).toBe('score is a number; "high" is not one');
    const flag = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.is_active', op: 'eq', values: ['yes'] }, { ref: 'dimension:header.is_active', op: 'eq', values: ['maybe'] }] }), vocabulary, NOW);
    expect(flag.intent.filters[0]!.values).toEqual([true]);
    expect(flag.problems[0]?.message).toBe('is_active is true or false; "maybe" is neither');
    const text = proveLiterals(intent({ measures: [{ ref: 'metric:header.total_bcm' }], filters: [{ ref: 'dimension:header.customer_name', op: 'eq', values: ['whatever'] }] }), vocabulary, NOW);
    expect(text.problems).toEqual([]);
  });
});
