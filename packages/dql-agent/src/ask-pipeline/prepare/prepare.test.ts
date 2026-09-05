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
