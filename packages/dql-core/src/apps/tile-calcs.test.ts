import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '../datasets/descriptor.js';
import {
  checkTileCalculations,
  formatTileCalcExpr,
  normalizeTileCalculations,
  parseTileFormula,
  quickCalcVerdict,
  measureCalcFacts,
  uniqueCalculationId,
} from './tile-calcs.js';
import { normalizeTileQuery, tileQueryMeasureScope, tileQueryOutputAliases, validateTileQuery } from './tile-query.js';
import type { TileQuery } from './tile-query-types.js';

function orderLines(overrides: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    version: 1,
    id: 'app:block:commerce:order-lines',
    kind: 'block',
    sourceRevision: 'sha256:source',
    snapshotId: 'snapshot-1',
    contractRef: { kind: 'block_source', id: 'commerce::block::order_lines', fingerprint: 'sha256:contract' },
    binding: { sourceQualifiedId: 'commerce::block::order_lines', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract', state: 'valid' },
    label: 'Order lines',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof' },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: 'ol.order_line_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'ordered_at', qualifiedId: 'ol.ordered_at', type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day', 'week', 'month', 'quarter', 'year'], primary: true } },
      { kind: 'physical', name: 'region', qualifiedId: 'ol.region', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'quantity', qualifiedId: 'ol.quantity', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'net_amount', qualifiedId: 'ol.net_amount', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'margin_amount', qualifiedId: 'ol.margin_amount', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'measure', name: 'revenue', qualifiedId: 'ol.m.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], format: { kind: 'currency', currency: 'USD' }, status: 'approved' },
      { kind: 'measure', name: 'margin', qualifiedId: 'ol.m.margin', aggregation: 'sum', from: 'margin_amount', dependsOn: ['margin_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], format: { kind: 'currency', currency: 'USD' }, status: 'approved' },
      { kind: 'measure', name: 'units', qualifiedId: 'ol.m.units', aggregation: 'sum', from: 'quantity', dependsOn: ['quantity'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'orders', qualifiedId: 'ol.m.orders', aggregation: 'count_distinct', from: 'order_line_id', dependsOn: ['order_line_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
      { kind: 'measure', name: 'margin_rate', qualifiedId: 'ol.m.margin_rate', aggregation: 'ratio', numerator: 'margin_amount', denominator: 'net_amount', dependsOn: ['margin_amount', 'net_amount'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['ratio'], status: 'approved' },
      { kind: 'measure', name: 'draft_measure', qualifiedId: 'ol.m.draft', aggregation: 'sum', from: 'quantity', dependsOn: ['quantity'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'suggested' },
    ],
    operations: ['filter', 'group', 'trend', 'rank', 'having', 'detail'],
    execution: { route: 'certified' },
    ...overrides,
  } as DatasetDescriptor;
}

const byRegionMonth: TileQuery = {
  dimensions: [{ field: 'region' }, { field: 'ordered_at', timeGrain: 'month' }],
  measures: [{ measure: 'revenue' }],
};

function parse(text: string) {
  const parsed = parseTileFormula(text, orderLines());
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.expr;
}

describe('formula parsing', () => {
  it('reads arithmetic with precedence and parentheses', () => {
    expect(parse('revenue / orders')).toEqual({ op: '/', left: { measure: 'revenue' }, right: { measure: 'orders' } });
    expect(parse('revenue - margin * 2')).toEqual({ op: '-', left: { measure: 'revenue' }, right: { op: '*', left: { measure: 'margin' }, right: { number: 2 } } });
    expect(parse('(revenue - margin) / revenue')).toEqual({ op: '/', left: { op: '-', left: { measure: 'revenue' }, right: { measure: 'margin' } }, right: { measure: 'revenue' } });
    expect(parse('-revenue')).toEqual({ op: '*', left: { number: -1 }, right: { measure: 'revenue' } });
  });

  it('reads a measure restricted to some rows', () => {
    expect(parse("(revenue where region = 'US') / revenue")).toEqual({
      op: '/',
      left: { measure: 'revenue', where: [{ field: 'region', op: 'eq', values: ['US'] }] },
      right: { measure: 'revenue' },
    });
    expect(parse("revenue where region in ('US', 'CA') and quantity >= 2")).toEqual({
      measure: 'revenue',
      where: [{ field: 'region', op: 'in', values: ['US', 'CA'] }, { field: 'quantity', op: 'gte', values: [2] }],
    });
    expect(parse("units where region not in (\"EU\")")).toEqual({ measure: 'units', where: [{ field: 'region', op: 'not_in', values: ['EU'] }] });
  });

  it('matches measure names regardless of case and accepts backticks', () => {
    expect(parse('Revenue / `orders`')).toEqual({ op: '/', left: { measure: 'revenue' }, right: { measure: 'orders' } });
  });

  it('explains what went wrong and where', () => {
    const column = parseTileFormula('net_amount / orders', orderLines());
    expect(column).toMatchObject({ ok: false, at: 0 });
    expect(!column.ok && column.message).toContain('net_amount is a column. Use a measure: revenue');
    const unknown = parseTileFormula('revenue / profit', orderLines());
    expect(unknown).toMatchObject({ ok: false, at: 10 });
    expect(!unknown.ok && unknown.message).toContain('profit is not a measure of Order lines');
    expect(parseTileFormula('(revenue / orders', orderLines())).toMatchObject({ ok: false, message: 'A ")" is missing.' });
    expect(parseTileFormula('revenue /', orderLines())).toMatchObject({ ok: false, message: 'The formula ends too early.' });
    expect(parseTileFormula('revenue ; drop table x', orderLines())).toMatchObject({ ok: false, message: '";" cannot be used in a formula.' });
    expect(parseTileFormula('', orderLines())).toMatchObject({ ok: false });
    expect(parseTileFormula("revenue where colour = 'red'", orderLines())).toMatchObject({ ok: false, message: 'colour is not a field of Order lines.' });
  });

  it('prints the expression back as a formula', () => {
    for (const text of ['revenue / orders', 'revenue - margin * 2', '(revenue - margin) / revenue', "(revenue where region = 'US') / revenue", 'revenue - (margin - units)']) {
      expect(formatTileCalcExpr(parse(text))).toBe(text);
    }
  });
});

describe('calculated measure checks', () => {
  const check = (expr: ReturnType<typeof parse>, query: TileQuery = byRegionMonth, descriptor = orderLines()) =>
    checkTileCalculations(descriptor, { ...query, calculations: [{ id: 'calc', expr }] });

  it('computes a ratio of two measures as a rate, not additive', () => {
    const result = check(parse('margin / revenue'));
    expect(result.diagnostics).toEqual([]);
    expect(result.outputs[0]).toMatchObject({ kind: 'measure', format: { kind: 'percent' }, facts: { unit: { kind: 'ratio' }, additive: { entities: false, time: false } } });
    expect(result.referencedMeasures.sort()).toEqual(['margin', 'revenue']);
  });

  it('keeps money per count as money (average order value)', () => {
    expect(check(parse('revenue / orders')).outputs[0]).toMatchObject({ format: { kind: 'currency', currency: 'USD' } });
  });

  it('keeps additivity for sums of additive measures and scaling by a constant', () => {
    expect(check(parse('revenue - margin')).outputs[0]!.facts.additive).toEqual({ entities: true, time: true });
    expect(check(parse('revenue * 1.1')).outputs[0]!.facts.additive).toEqual({ entities: true, time: true });
    expect(check(parse('revenue + 100')).outputs[0]!.facts.additive).toEqual({ entities: false, time: false });
  });

  it('refuses mixing units, and names both sides', () => {
    const result = check(parse('revenue + orders'));
    expect(result.diagnostics[0]!.message).toBe('revenue is money (USD) and orders is a count; they cannot be added.');
  });

  it('refuses dividing by zero, constants alone and suggested measures', () => {
    expect(check(parse('revenue / 0')).diagnostics[0]!.message).toBe('A calculation cannot divide by zero.');
    expect(check({ number: 3 }).diagnostics[0]!.message).toContain('has no measure in it');
    expect(check({ measure: 'draft_measure' }).diagnostics[0]!.message).toContain('draft_measure is a suggested measure');
  });

  it('refuses restricting a pre-aggregated Dataset and a formula measure', () => {
    const aggregate = orderLines({ grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof', aggregate: true } as DatasetDescriptor['grain'] });
    expect(check(parse("revenue where region = 'US'"), byRegionMonth, aggregate).diagnostics[0]!.message).toContain('already aggregated');
  });

  it('refuses calculations on a semantic-model Dataset, a detail tile and a comparison tile', () => {
    expect(check(parse('revenue / orders'), byRegionMonth, orderLines({ kind: 'semantic' })).diagnostics[0]!.message).toContain('defined in a semantic model');
    expect(check(parse('revenue / orders'), { dimensions: [], measures: [], detail: true, limit: 10 }).diagnostics[0]!.message).toContain('row-detail tile');
  });

  it('refuses a name that another column already uses', () => {
    const result = checkTileCalculations(orderLines(), { ...byRegionMonth, calculations: [{ id: 'revenue', expr: parse('revenue * 2') }] });
    expect(result.diagnostics[0]!.message).toBe('The name revenue is already used by another column on this tile.');
  });
});

describe('quick calculation checks', () => {
  const dims = [{ alias: 'region', field: 'region' }, { alias: 'ordered_at_month', field: 'ordered_at', timeGrain: 'month' }];
  const facts = (name: string) => {
    const measure = orderLines().fields.find((field) => field.kind === 'measure' && field.name === name);
    return { label: name, facts: measureCalcFacts(measure as never) };
  };

  it('allows every quick calculation on an additive measure', () => {
    for (const kind of ['percent_of_total', 'running_total', 'difference', 'percent_difference', 'rank', 'moving_average', 'year_over_year'] as const) {
      expect(quickCalcVerdict(kind, facts('revenue'), dims).refusal, kind).toBeUndefined();
    }
    expect(quickCalcVerdict('running_total', facts('revenue'), dims).along).toBe('ordered_at_month');
  });

  it('refuses a share or running total of a distinct count, with the rule', () => {
    expect(quickCalcVerdict('percent_of_total', facts('orders'), dims).refusal)
      .toBe('orders is a distinct count, so its parts do not add up to a total and a share of it would be wrong.');
    expect(quickCalcVerdict('running_total', facts('orders'), dims).refusal)
      .toBe('orders is a distinct count, so adding it up along ordered_at_month would double count.');
    expect(quickCalcVerdict('difference', facts('orders'), dims).refusal).toBeUndefined();
    expect(quickCalcVerdict('rank', facts('orders'), dims).refusal).toBeUndefined();
  });

  it('refuses averaging a ratio, and allows its difference', () => {
    expect(quickCalcVerdict('moving_average', facts('margin_rate'), dims).refusal).toContain('would average ratios');
    expect(quickCalcVerdict('percent_of_total', facts('margin_rate'), dims).refusal).toContain('is a ratio or average');
    expect(quickCalcVerdict('difference', facts('margin_rate'), dims).refusal).toBeUndefined();
  });

  it('needs a month, quarter or year for year over year', () => {
    expect(quickCalcVerdict('year_over_year', facts('revenue'), [{ alias: 'region', field: 'region' }]).refusal).toContain('month, quarter or year');
    expect(quickCalcVerdict('year_over_year', facts('revenue'), [{ alias: 'd', field: 'ordered_at', timeGrain: 'week' }]).refusal).toContain('month, quarter or year');
  });

  it('checks a quick calculation over a calculated measure', () => {
    const query: TileQuery = {
      ...byRegionMonth,
      calculations: [
        { id: 'aov', expr: parse('revenue / orders') },
        { id: 'aov_change', quick: { kind: 'difference', of: 'aov' } },
        { id: 'aov_avg', quick: { kind: 'moving_average', of: 'aov' } },
      ],
    };
    const result = checkTileCalculations(orderLines(), query);
    expect(result.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(['aov_avg']);
    expect(result.outputs.find((output) => output.id === 'aov_change')).toMatchObject({ description: 'Difference from previous of aov along ordered_at_month', format: { kind: 'currency' } });
  });

  it('refuses a quick calculation over something that is not a measure on the tile', () => {
    const result = checkTileCalculations(orderLines(), { ...byRegionMonth, calculations: [{ id: 'x', quick: { kind: 'rank', of: 'margin' } }] });
    expect(result.diagnostics[0]!.message).toBe('Rank runs over a measure on this tile; margin is not one.');
  });
});

describe('tile query integration', () => {
  it('normalizes calculations and rejects malformed ones', () => {
    const query = normalizeTileQuery({ ...byRegionMonth, calculations: [{ id: 'aov', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'orders' } } }] });
    expect(query?.calculations).toHaveLength(1);
    expect(normalizeTileQuery({ ...byRegionMonth, calculations: [{ id: 'bad id', expr: { number: 1 } }] })).toBeUndefined();
    expect(normalizeTileQuery({ ...byRegionMonth, calculations: [{ id: 'x', expr: { sql: 'DROP' } }] })).toBeUndefined();
    expect(normalizeTileQuery({ ...byRegionMonth, calculations: [{ id: 'x', expr: { number: 1 }, quick: { kind: 'rank', of: 'revenue' } }] })).toBeUndefined();
    expect(normalizeTileCalculations([{ id: 'x', quick: { kind: 'moving_average', of: 'revenue', window: 99 } }])).toBeUndefined();
  });

  it('lists calculations as measure outputs so they can be sorted and drawn', () => {
    const query: TileQuery = { ...byRegionMonth, calculations: [{ id: 'share', quick: { kind: 'percent_of_total', of: 'revenue' } }], orderBy: [{ alias: 'share', direction: 'desc' }] };
    expect(tileQueryOutputAliases(query).at(-1)).toEqual({ alias: 'share', kind: 'measure' });
    expect(validateTileQuery(orderLines(), query).outcome).toBe('covered');
  });

  it('rejects the tile with the calculation rule, and holds suggested measures read by a formula to review', () => {
    const refused = validateTileQuery(orderLines(), { ...byRegionMonth, calculations: [{ id: 's', quick: { kind: 'percent_of_total', of: 'revenue' } }, { id: 'o', quick: { kind: 'running_total', of: 'revenue', along: 'nope' } }] });
    expect(refused.outcome).toBe('rejected');
    expect(refused.diagnostics[0]).toMatchObject({ code: 'INVALID_CALCULATION', message: 'nope is not a dimension on this tile.' });
  });

  it('adds measures a formula reads to the contract scope', () => {
    const scoped = tileQueryMeasureScope(orderLines(), { ...byRegionMonth, calculations: [{ id: 'aov', expr: parse('revenue / orders') }] });
    expect(scoped.measures).toEqual([{ measure: 'revenue' }, { measure: 'orders', alias: '__calc_orders' }]);
  });

  it('lets a tile hold only a calculated measure', () => {
    expect(validateTileQuery(orderLines(), { dimensions: [{ field: 'region' }], measures: [], calculations: [{ id: 'aov', expr: parse('revenue / orders') }] }).outcome).toBe('covered');
  });

  it('names new calculations without colliding', () => {
    expect(uniqueCalculationId({ ...byRegionMonth, calculations: [{ id: 'revenue_share', quick: { kind: 'percent_of_total', of: 'revenue' } }] }, 'Revenue share')).toBe('revenue_share_2');
    expect(uniqueCalculationId(byRegionMonth, '2024 growth')).toBe('c_2024_growth');
  });
});

describe('calculations on shelves', async () => {
  const { queryFromEncoding, encodingFromQuery } = await import('./viz-encoding.js');
  const withCalcs: TileQuery = {
    ...byRegionMonth,
    calculations: [
      { id: 'aov', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'orders' } } },
      { id: 'running', quick: { kind: 'running_total', of: 'revenue' } },
    ],
  };

  it('keeps a calculation whose pill is on a shelf, and the measure a quick calculation runs over', () => {
    const next = queryFromEncoding({ version: 1, columns: [{ dimension: 'ordered_at' }], rows: [{ measure: 'running' }] }, withCalcs);
    expect(next.measures).toEqual([{ measure: 'revenue' }]);
    expect(next.calculations?.map((calculation) => calculation.id)).toEqual(['running']);
  });

  it('drops a calculation whose pill left the shelves', () => {
    const next = queryFromEncoding({ version: 1, columns: [{ dimension: 'ordered_at' }], rows: [{ measure: 'revenue' }] }, withCalcs);
    expect(next.calculations).toBeUndefined();
  });

  it('draws a quick calculation in place of its measure', () => {
    expect(encodingFromQuery(withCalcs, 'line').rows).toEqual([{ measure: 'aov' }, { measure: 'running' }]);
  });
});
