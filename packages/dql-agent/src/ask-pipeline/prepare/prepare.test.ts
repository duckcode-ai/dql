import { describe, expect, it } from 'vitest';
import { extractBlockContract } from '../block-contract.js';
import { parseIntent, type AnalyticalIntentV1 } from '../intent.js';
import { buildVocabularyIndex, type VocabularySource } from '../vocabulary.js';
import { bindSemanticRequest, composeRelational, entails, prepare } from './index.js';
import type { PrepareDeps } from './types.js';

const source: VocabularySource = {
  metrics: [
    { name: 'revenue', model: 'order_item', aggregation: 'sum', expr: 'SUM(product_price)', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } },
    { name: 'drink_revenue', model: 'order_item', aggregation: 'sum', expr: 'SUM(case when is_drink_item then product_price else 0 end)', description: 'Revenue from drink items', physical: { relation: 'dev.order_items', expr: 'case when "dev"."order_items"."is_drink_item" then "dev"."order_items"."product_price" else 0 end', aggregate: 'sum' } },
    { name: 'order_total', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'sum' } },
  ],
  dimensions: [
    { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } },
    { name: 'is_drink_item', model: 'order_item', dataType: 'boolean', physical: { relation: 'dev.order_items', column: 'is_drink_item' } },
    { name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.order_items', column: 'ordered_at' } },
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.orders', column: 'ordered_at' } },
  ],
  entities: [
    { name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } },
  ],
  blocks: [{
    name: 'top_beverage_customers', domain: 'commerce', certified: true, sql: 'SELECT customer_name, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_name ORDER BY beverage_revenue DESC LIMIT 10',
    contract: extractBlockContract({ name: 'top_beverage_customers', sql: 'SELECT customer_name, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_name ORDER BY beverage_revenue DESC LIMIT 10' }),
  }, {
    name: 'beverage_by_customer_id', domain: 'commerce', certified: true, sql: 'SELECT customer_id, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_id ORDER BY beverage_revenue DESC LIMIT 10',
    contract: extractBlockContract({ name: 'beverage_by_customer_id', sql: 'SELECT customer_id, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_id ORDER BY beverage_revenue DESC LIMIT 10' }),
  }],
};
const vocabulary = buildVocabularyIndex(source);

const joinPath: PrepareDeps['joinPath'] = (from, to) => {
  const edges: Record<string, Array<{ relation: string; on: string }>> = {
    'dev.order_items>dev.orders': [{ relation: 'dev.orders', on: '"dev"."order_items".order_id = "dev"."orders".order_id' }],
    'dev.order_items>dev.customers': [{ relation: 'dev.orders', on: '"dev"."order_items".order_id = "dev"."orders".order_id' }, { relation: 'dev.customers', on: '"dev"."orders".customer_id = "dev"."customers".customer_id' }],
    'dev.orders>dev.customers': [{ relation: 'dev.customers', on: '"dev"."orders".customer_id = "dev"."customers".customer_id' }],
  };
  return edges[`${from}>${to}`];
};
const deps: PrepareDeps = { joinPath, blockSql: (ref) => vocabulary.get(ref)?.sql };

const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
  const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw });
  if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.intent;
};

describe('certified entailment', () => {
  it('a block named by ref that groups by a label is served as published, with the identity caveat recorded', () => {
    const verdict = entails(vocabulary.get('block:commerce.top_beverage_customers')!, intent({ measures: [{ ref: 'block:commerce.top_beverage_customers' }], expectedShape: 'ranking' }), vocabulary);
    expect(verdict.ok).toBe(true);
    expect(verdict.caveats.join(' ')).toMatch(/label.*no identity key/);
  });
  it('a label-grouped block matched only through its measures must prove identity', () => {
    const verdict = entails(vocabulary.get('block:commerce.top_beverage_customers')!, intent({ measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10, expectedShape: 'ranking' }), vocabulary);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/recertify it with the key column/);
  });
  it('a keyed block named exactly is entailed', () => {
    const verdict = entails(vocabulary.get('block:commerce.beverage_by_customer_id')!, intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], expectedShape: 'ranking' }), vocabulary);
    expect(verdict.ok).toBe(true);
  });
  it('an intent with no measures never entails, and an extra filter the block cannot take refuses', () => {
    const block = vocabulary.get('block:commerce.beverage_by_customer_id')!;
    expect(entails(block, intent({ measures: [], display: ['dimension:customers.customer_name'], unresolved: [{ clause: 'x', options: [], material: false }] }), vocabulary).ok).toBe(false);
    expect(entails(block, intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan Byrd'], source: 'question' }] }), vocabulary).missing.join(' ')).toMatch(/does not accept a filter/);
  });
});

describe('semantic binding', () => {
  it('maps metrics, key and label to model-scoped names and a literal to an equality filter', () => {
    const bound = bindSemanticRequest(intent({
      measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }], ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10, expectedShape: 'ranking',
    }), vocabulary);
    expect(bound.request).toEqual({
      metrics: ['drink_revenue'], dimensions: ['customers.customer', 'customers.customer_name'],
      filters: [{ dimension: 'customers.customer_name', operator: '=', values: ['Ryan byrd'] }], orderBy: [{ name: 'drink_revenue', direction: 'desc' }], limit: 10,
    });
  });
  it('a per-measure scope the metric does not embody is not semantic', () => {
    const bound = bindSemanticRequest(intent({ measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }] }), vocabulary);
    expect(bound.refusal?.code).toBe('measure_scope_not_expressible');
  });
});

describe('relational composition', () => {
  it('composes a keyed ranking with the label displayed, joined along governed paths, with a boolean scope', () => {
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'eq', values: ['true'], source: 'question' }] }],
      groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10, expectedShape: 'ranking',
    }), vocabulary, deps);
    expect(composed.candidate?.sql).toContain('JOIN "dev"."customers"');
    expect(composed.candidate?.sql).toContain('"is_drink_item" = TRUE');
    expect(composed.candidate?.sql).toMatch(/GROUP BY "dev"\."customers"\."customer_id", "dev"\."customers"\."customer_name"/);
    expect(composed.candidate?.sql).toMatch(/ORDER BY "revenue" DESC\nLIMIT 10$/);
  });
  it('measures on different fact grains become aggregate islands joined on the keys', () => {
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:orders.order_total' }, { ref: 'metric:order_item.drink_revenue' }],
      filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }], expectedShape: 'comparison',
    }), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH island_1 AS/);
    expect(sql).toContain('island_2');
    expect(sql).toContain('CROSS JOIN');
    expect(sql).not.toMatch(/FROM "dev"\."orders"\nJOIN "dev"\."order_items"/);
    expect(composed.candidate!.params).toEqual(['ryan byrd', 'ryan byrd']);
    expect(composed.candidate!.proof[0]).toMatch(/aggregate islands/);
  });
  it('a time window without an axis is refused, never dropped', () => {
    const composed = composeRelational(intent({ measures: [{ ref: 'metric:orders.order_total' }], expectedShape: 'scalar', time: { window: { start: '2031-01-01', end: '2032-01-01' } } }), vocabulary, deps);
    expect(composed.candidate).toBeUndefined();
    expect(composed.refusal?.code).toBe('not_relational');
    expect(composed.refusal?.message).toMatch(/names no time dimension/);
    const bound = composeRelational(intent({ measures: [{ ref: 'metric:order_item.revenue' }], expectedShape: 'scalar', time: { ref: 'dimension:order_item.ordered_at', window: { start: '2031-01-01', end: '2032-01-01' } } }), vocabulary, deps);
    expect(bound.candidate?.params).toEqual(['2031-01-01', '2032-01-01']);
  });
  it('refuses when no governed join path reaches a relation', () => {
    const composed = composeRelational(intent({ measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'dimension:order_item.is_drink_item', role: 'categorical' }], expectedShape: 'grouped' }), vocabulary, { ...deps, joinPath: () => undefined });
    expect(composed.refusal?.code).toBe('join_path_required');
  });
});

describe('prepare order', () => {
  it('a refused block falls to semantic, a semantic refusal falls to relational, and exploration needs an opt-in', async () => {
    const result = await prepare({
      intent: intent({ measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }], expectedShape: 'scalar' }),
      vocabulary, deps: { ...deps, compileSemantic: async () => { throw new Error('should not compile a scoped measure'); } },
    });
    expect(result.attempts.map((attempt) => `${attempt.tier}:${attempt.outcome}`)).toEqual(['certified:refused', 'semantic:refused', 'relational:prepared']);
    expect(result.chosen?.tier).toBe('relational');
    const gap = await prepare({ intent: intent({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], expectedShape: 'grouped' }), vocabulary, deps: { compileSemantic: async () => { throw new Error('Dimension customer_name is not reachable from order_item'); } } });
    expect(gap.chosen).toBeUndefined();
    expect(gap.refusals.map((refusal) => refusal.code)).toEqual(['block_not_applicable', 'semantic_compile_failed', 'join_path_required', 'exploration_not_opted_in']);
    expect(gap.refusals[1]!.message).toBe('Dimension customer_name is not reachable from order_item');
  });
});

describe('relational ratio and population', () => {
  const ratio = (extra: Record<string, unknown> = {}) => intent({
    measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.order_total' }, alias: 'revenue_share' }],
    expectedShape: 'scalar', ...extra,
  });
  it('a ratio of two measures on different grains divides the islands, never the rows', () => {
    const composed = composeRelational(ratio(), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH island_1 AS/);
    expect(sql).toContain('SUM("dev"."order_items"."product_price") AS "__num_1"');
    expect(sql).toContain('SUM("dev"."orders"."order_total") AS "__den_1"');
    expect(sql).toMatch(/CAST\(island_1\."__num_1" AS DOUBLE\) \/ NULLIF\(island_2\."__den_1", 0\) AS "revenue_share"/);
    expect(composed.candidate!.columns).toEqual(['revenue_share']);
    expect(composed.candidate!.proof.join(' ')).toMatch(/revenue_share = .* \/ .*, divided after each part is aggregated/);
  });
  it('a window binds to each island\'s own same-named time column, never through a multiplying join', () => {
    const composed = composeRelational(ratio({ time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01' } } }), vocabulary, { ...deps, joinPath: () => { throw new Error('no join should be needed'); } });
    const sql = composed.candidate!.sql;
    expect(sql).toContain('WHERE "dev"."order_items"."ordered_at" >= ? AND "dev"."order_items"."ordered_at" < ?');
    expect(sql).toContain('WHERE "dev"."orders"."ordered_at" >= ? AND "dev"."orders"."ordered_at" < ?');
    expect(composed.candidate!.params).toEqual(['2025-01-01', '2026-01-01', '2025-01-01', '2026-01-01']);
  });
  it('a single-island ratio is wrapped so the projection can order by it', () => {
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:order_item.revenue' }, { derived: { kind: 'ratio', numerator: 'metric:order_item.drink_revenue', denominator: 'metric:order_item.revenue' }, alias: 'drink_share' }],
      groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'measure:1', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
    }), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH island_1 AS/);
    expect(sql).toMatch(/island_1\."customer_id" AS "customer_id", island_1\."customer_name" AS "customer_name", island_1\."revenue" AS "revenue", CAST\(island_1\."__num_2" AS DOUBLE\) \/ NULLIF\(island_1\."__den_2", 0\) AS "drink_share"/);
    expect(sql).toMatch(/ORDER BY "drink_share" DESC\nLIMIT 5$/);
  });
  it('population "all" enumerates every member from the entity relation and zero-fills additive measures only', () => {
    const source: VocabularySource = {
      metrics: [
        { name: 'order_total', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'sum' } },
        { name: 'avg_order', model: 'orders', aggregation: 'avg', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'avg' } },
      ],
      entities: [{ name: 'location', model: 'locations', type: 'primary', physical: { relation: 'dev.locations', column: 'location_id' } }],
      dimensions: [
        { name: 'location_name', model: 'locations', dataType: 'string', physical: { relation: 'dev.locations', column: 'location_name' } },
        { name: 'customer_type', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_type' } },
      ],
    };
    const local = buildVocabularyIndex(source);
    const paths: PrepareDeps['joinPath'] = (from, to) => from === 'dev.orders' && to === 'dev.locations' ? [{ relation: 'dev.locations', on: '"dev"."orders".location_id = "dev"."locations".location_id' }] : undefined;
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:orders.order_total' }, { ref: 'metric:orders.avg_order' }], groupBy: [{ ref: 'entity:locations.location', role: 'key' }], display: ['dimension:locations.location_name'],
      filters: [{ ref: 'dimension:locations.location_name', op: 'neq', values: ['Closed'], source: 'question' }], population: 'all', expectedShape: 'grouped', ordering: { ref: 'measure:0', direction: 'desc' },
    }), local, { joinPath: paths });
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH population AS \(\nSELECT DISTINCT "dev"\."locations"\."location_id" AS "location_id", "dev"\."locations"\."location_name" AS "location_name"\nFROM "dev"\."locations"\nWHERE "dev"\."locations"\."location_name" <> \?\n\)/);
    expect(sql).toContain('LEFT JOIN island_1 ON population."location_id" = island_1."location_id" AND population."location_name" = island_1."location_name"');
    expect(sql).toContain('COALESCE(island_1."order_total", 0) AS "order_total", island_1."avg_order" AS "avg_order"');
    expect(sql).toMatch(/ORDER BY "order_total" DESC$/);
    expect(composed.candidate!.params).toEqual(['Closed', 'Closed']);
    expect(composed.candidate!.proof[0]).toMatch(/every member of dev\.locations is a row .* order_total read 0 where nothing matched; avg_order stay null/);
    const timed = composeRelational(intent({ measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'entity:locations.location', role: 'key' }, { ref: 'dimension:customers.customer_type', role: 'categorical' }], population: 'all', expectedShape: 'grouped' }), local, { joinPath: paths });
    expect(timed.refusal?.message).toMatch(/live elsewhere/);
  });
  it('a certified block never serves a ratio or a population', () => {
    const block = vocabulary.get('block:commerce.beverage_by_customer_id')!;
    expect(entails(block, intent({ measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.order_total' } }] }), vocabulary).missing[0]).toMatch(/derived ratio/);
    expect(entails(block, intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], population: 'all' }), vocabulary).missing[0]).toMatch(/every member/);
  });
});
