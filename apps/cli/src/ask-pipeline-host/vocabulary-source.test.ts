import { describe, expect, it } from 'vitest';
import type { SemanticLayer } from '@duckcodeailabs/dql-core';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { modelingJoinPaths } from './host.js';
import { leafName, nativeAggregateBinding, normalizeRelationName, parseMetricFilter, qualifyExpression, buildVocabularySource } from './vocabulary-source.js';

describe('vocabulary source helpers', () => {
  it('qualifies bare columns in a measure expression, leaving keywords, functions and literals alone', () => {
    expect(qualifyExpression('case when is_drink_item then product_price else 0 end', 'dev.order_items', ['product_price']))
      .toBe('case when "dev"."order_items"."is_drink_item" then "dev"."order_items"."product_price" else 0 end');
    expect(qualifyExpression("coalesce(status, 'unknown')", 'dev.orders', [])).toBe('coalesce("dev"."orders"."status", \'unknown\')');
    expect(qualifyExpression('1', 'dev.orders', [])).toBe('1');
    expect(qualifyExpression('"dev"."orders"."order_total" * 2', 'dev.orders', ['order_total'])).toBe('"dev"."orders"."order_total" * 2');
  });
  it('reads a MetricFlow where filter into a column and a condition', () => {
    expect(parseMetricFilter({ where_filters: [{ where_sql_template: "{{ Dimension('order_id__is_drink_order') }} = true\n" }] }))
      .toEqual([{ column: 'is_drink_order', entityPath: ['order_id'], condition: '= true' }]);
    expect(parseMetricFilter("{{ Dimension('order_id__order_total_dim') }} >= 20")).toEqual([{ column: 'order_total_dim', entityPath: ['order_id'], condition: '>= 20' }]);
    expect(parseMetricFilter(null)).toEqual([]);
  });
  it('normalizes three-part relation names to schema.table', () => {
    expect(normalizeRelationName('"jaffle_shop"."dev"."customers"')).toBe('dev.customers');
    expect(normalizeRelationName('dev.orders')).toBe('dev.orders');
    expect(normalizeRelationName(undefined)).toBeUndefined();
  });
});

describe('declared relationship join paths', () => {
  const manifest = {
    modeling: {
      entities: {
        supply: { id: 'supply', localId: 'supply', qualifiedId: 'commerce.supply', dbtUniqueId: 'model.jaffle_shop.supplies' },
        product: { id: 'product', localId: 'product', qualifiedId: 'commerce.product', dbtUniqueId: 'model.jaffle_shop.products' },
        order_item: { id: 'order_item', localId: 'order_item', qualifiedId: 'commerce.order_item', dbtUniqueId: 'model.jaffle_shop.order_items' },
      },
      relationships: {
        supply_to_product: { id: 'supply_to_product', from: 'supply', to: 'product', keys: [{ from: 'product_id', to: 'product_id' }], status: 'draft' },
        order_item_to_product: { id: 'order_item_to_product', from: 'order_item', to: 'product', keys: [{ from: 'product_id', to: 'product_id' }], status: 'deprecated' },
      },
    },
    dbtProvenance: {
      nodes: {
        'model.jaffle_shop.supplies': { relation: '"jaffle_shop"."dev"."supplies"' },
        'model.jaffle_shop.products': { relation: '"jaffle_shop"."dev"."products"' },
        'model.jaffle_shop.order_items': { relation: '"jaffle_shop"."dev"."order_items"' },
      },
    },
  } as unknown as DQLManifest;
  const quote = (relation: string) => relation.split('.').map((part) => `"${part}"`).join('.');
  const joinPath = modelingJoinPaths(manifest, quote);
  it('walks a declared relationship in either direction and renders the key equality', () => {
    expect(joinPath('dev.supplies', 'dev.products')).toEqual([{ relation: 'dev.products', on: '"dev"."supplies".product_id = "dev"."products".product_id' }]);
    expect(joinPath('dev.products', 'dev.supplies')).toEqual([{ relation: 'dev.supplies', on: '"dev"."supplies".product_id = "dev"."products".product_id' }]);
  });
  it('a deprecated relationship never joins, and a missing manifest yields no path', () => {
    expect(joinPath('dev.order_items', 'dev.products')).toBeUndefined();
    expect(joinPath('dev.order_items', 'dev.supplies')).toBeUndefined();
    expect(modelingJoinPaths(undefined, quote)('dev.supplies', 'dev.products')).toBeUndefined();
  });
});

describe('derived metrics bind physically only when SQL can express them', () => {
  const simple = (name: string, cube: string, expr: string, agg = 'sum') => ({ name, cube, semanticModelIds: [cube], metricType: 'simple', typeParams: { measure: { name } }, label: name, description: '', sql: expr, type: agg, table: '', aggregation: agg });
  const metrics = [
    simple('revenue', 'order_item', 'product_price'),
    simple('order_cost', 'orders', 'order_cost'),
    { name: 'revenue_growth_mom', cube: 'order_item', semanticModelIds: ['order_item'], metricType: 'derived', label: 'Revenue growth MoM', description: '', sql: '(current_revenue - revenue_prev_month)*100/revenue_prev_month', type: 'derived', table: '',
      typeParams: { expr: '(current_revenue - revenue_prev_month)*100/revenue_prev_month', metrics: [{ name: 'revenue', alias: 'current_revenue', offset_window: null }, { name: 'revenue', alias: 'revenue_prev_month', offset_window: { count: 1, granularity: 'month' } }] } },
    { name: 'order_gross_profit', cube: 'order_item', semanticModelIds: ['order_item'], metricType: 'derived', label: 'Gross profit', description: '', sql: 'revenue - cost', type: 'derived', table: '',
      typeParams: { expr: 'revenue - cost', metrics: [{ name: 'revenue', alias: null }, { name: 'order_cost', alias: 'cost' }] } },
    { name: 'drink_share', cube: 'order_item', semanticModelIds: ['order_item'], metricType: 'ratio', label: 'Drink share', description: '', sql: '', type: 'ratio', table: '',
      typeParams: { numerator: { name: 'revenue' }, denominator: { name: 'revenue' } } },
  ];
  const measures = [
    { name: 'revenue', cube: 'order_item', agg: 'sum', expr: 'product_price', label: 'revenue', description: '' },
    { name: 'order_cost', cube: 'orders', agg: 'sum', expr: 'order_cost', label: 'order_cost', description: '' },
  ];
  const layer = {
    listCubes: () => [
      { name: 'order_item', table: 'dev.order_items', dimensions: [{ name: 'ordered_at', type: 'timestamp' }], measures: [{ name: 'revenue' }] },
      { name: 'orders', table: 'dev.orders', dimensions: [{ name: 'ordered_at', type: 'timestamp' }], measures: [{ name: 'order_cost' }] },
    ],
    listMetrics: () => metrics,
    listMeasures: () => measures,
    listTimeDimensions: () => [],
    listDimensions: () => [],
    listEntities: () => [],
    listSemanticModels: () => [{ name: 'order_item', defaults: { agg_time_dimension: 'ordered_at' } }, { name: 'orders', defaults: { agg_time_dimension: 'ordered_at' } }],
    findJoinPath: () => [],
    displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations: [] } as never);
  const metric = (name: string) => source.metrics!.find((item) => item.name === name)!;
  it('a prior-period offset is the semantic engine alone: no physical binding, and the card says why', () => {
    expect(metric('revenue_growth_mom').physical).toBeUndefined();
    expect(metric('revenue_growth_mom').engineOnly).toBe('a prior-period offset on revenue');
    expect(metric('revenue_growth_mom').description).toMatch(/semantic engine only, a prior-period offset on revenue/);
  });
  it('a plain formula over two relations exposes its inputs for island composition instead of a flattened binding', () => {
    expect(metric('order_gross_profit').physical).toBeUndefined();
    expect(metric('order_gross_profit').derived).toEqual({ expr: 'revenue - cost', inputs: [{ alias: 'revenue', ref: 'metric:order_item.revenue' }, { alias: 'cost', ref: 'metric:orders.order_cost' }] });
    expect(metric('order_gross_profit').engineOnly).toBeUndefined();
  });
  it('the same input metric under two aliases is never flattened into one aggregate', () => {
    expect(metric('drink_share').physical).toBeUndefined();
    expect(metric('drink_share').engineOnly).toMatch(/same input metric under several aliases/);
  });
  it('a simple metric still binds physically', () => {
    expect(metric('revenue').physical).toMatchObject({ relation: 'dev.order_items', aggregate: 'sum' });
  });
});

describe('a dimension without a governed description is defined by its dbt column', () => {
  const layer = {
    listCubes: () => [{ name: 'customers', table: 'dev.customers', dimensions: [{ name: 'customer_type', type: 'string' }, { name: 'first_ordered_at', type: 'timestamp' }], measures: [] }],
    listMetrics: () => [],
    listMeasures: () => [],
    listTimeDimensions: () => [{ name: 'first_ordered_at', cube: 'customers', type: 'timestamp', granularities: ['day'] }],
    listDimensions: () => [{ name: 'customer_type', cube: 'customers', type: 'string' }, { name: 'first_ordered_at', cube: 'customers', type: 'timestamp', isTimeDimension: true }],
    listEntities: () => [],
    listSemanticModels: () => [{ name: 'customers', defaults: {} }],
    findJoinPath: () => [],
    displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const manifest = {
    sources: {
      customers: { name: 'customers', dbtModel: { uniqueId: 'model.jaffle.customers', schema: 'dev', columns: {
        customer_type: { name: 'customer_type', description: "Options are 'new' or 'returning', indicating if a customer has ordered more than once or has only placed their first order to date." },
        first_ordered_at: { name: 'first_ordered_at', description: 'The timestamp of the first order.' },
      } } },
    },
  } as unknown as DQLManifest;
  const source = buildVocabularySource({ manifest, semanticLayer: layer, relations: [] } as never);
  it('a dimension with no expression is its own column, so the dbt description defines it', () => {
    const type = source.dimensions!.find((dimension) => dimension.name === 'customer_type')!;
    expect(type.description).toMatch(/ordered more than once/);
    expect(type.physical).toEqual({ relation: 'dev.customers', column: 'customer_type' });
    expect(source.dimensions!.find((dimension) => dimension.name === 'first_ordered_at')!.description).toBe('The timestamp of the first order.');
  });
});

describe('a dbt-inventory model names its columns once', () => {
  const layer = {
    listCubes: () => [{ name: 'player_game_stats', table: 'dev.player_game_stats', dimensions: [{ name: 'player_game_stats.pts', type: 'number' }, { name: 'player_game_stats.game_date', type: 'date' }], measures: [] }],
    listMetrics: () => [], listMeasures: () => [],
    listTimeDimensions: () => [{ name: 'player_game_stats.game_date', cube: 'player_game_stats', type: 'date', sql: 'game_date', granularities: ['day'] }],
    listDimensions: () => [{ name: 'player_game_stats.pts', cube: 'player_game_stats', type: 'number', sql: 'pts' }, { name: 'player_game_stats.game_date', cube: 'player_game_stats', type: 'date', sql: 'game_date', isTimeDimension: true }],
    listEntities: () => [], listSemanticModels: () => [{ name: 'player_game_stats', defaults: {} }], findJoinPath: () => [], displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations: [] } as never);
  it('the prefix is stripped from dimensions and relation columns', () => {
    expect(leafName('player_game_stats', 'player_game_stats.pts')).toBe('pts');
    expect(leafName('player_game_stats', 'pts')).toBe('pts');
    expect(source.dimensions!.map((dimension) => dimension.name).sort()).toEqual(['game_date', 'pts']);
    expect(source.dimensions!.find((dimension) => dimension.name === 'pts')?.physical).toEqual({ relation: 'dev.player_game_stats', column: 'pts' });
    expect(source.relations!.find((relation) => relation.name === 'player_game_stats')?.columns.map((column) => column.name)).toEqual(['pts', 'game_date']);
  });
});

describe('contradictory block metadata is never certified evidence', () => {
  it('a certified block whose description or tags say review-required is left out', () => {
    const manifest = { blocks: {
      a: { name: 'a', status: 'certified', filePath: 'blocks/a.dql', description: 'Review-required draft comparing scorers', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: [] },
      b: { name: 'b', status: 'certified', filePath: 'blocks/b.dql', description: 'Top scorers', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: ['review-required'] },
      c: { name: 'c', status: 'certified', filePath: 'blocks/c.dql', description: 'Top scorers', sql: 'SELECT 1 AS x', declaredOutputs: ['x'], tags: ['scoring'] },
    } } as unknown as DQLManifest;
    const source = buildVocabularySource({ manifest, semanticLayer: undefined, relations: [] } as never);
    expect(source.blocks!.map((block) => block.name)).toEqual(['c']);
    expect(source.blocks![0]!.sourcePath).toBe('blocks/c.dql');
  });
});

describe('a native DQL semantic layer binds through its own table', () => {
  it('reads the aggregate out of the expression, or takes the declared type', () => {
    expect(nativeAggregateBinding('SUM(points)', 'sum')).toEqual({ expr: 'points', aggregate: 'sum' });
    expect(nativeAggregateBinding('points', 'sum')).toEqual({ expr: 'points', aggregate: 'sum' });
    expect(nativeAggregateBinding('COUNT(DISTINCT game_id)', 'count')).toEqual({ expr: 'game_id', aggregate: 'count_distinct' });
    expect(nativeAggregateBinding('CASE WHEN played = 1 THEN points END', 'sum')).toEqual({ expr: 'CASE WHEN played = 1 THEN points END', aggregate: 'sum' });
    // A formula of aggregates cannot be wrapped in another aggregate.
    expect(nativeAggregateBinding('SUM(made) / SUM(attempted)', 'custom')).toBeUndefined();
    expect(nativeAggregateBinding('SUM(a) + SUM(b)', 'sum')).toBeUndefined();
    expect(nativeAggregateBinding('points', 'custom')).toBeUndefined();
    expect(nativeAggregateBinding('', 'sum')).toBeUndefined();
  });
  const layer = {
    listCubes: () => [],
    listMetrics: () => [
      { name: 'total_points', label: 'Total points', description: 'Points scored', sql: 'SUM(points)', type: 'sum', table: 'TRANSFORMED.local_player_season_facts' },
      { name: 'points_per_game', label: 'Points per game', description: '', sql: 'SUM(points) / NULLIF(SUM(games_played), 0)', type: 'custom', table: 'TRANSFORMED.local_player_season_facts' },
    ],
    listMeasures: () => [],
    listTimeDimensions: () => [{ name: 'game_date', type: 'date', sql: 'game_date', table: 'TRANSFORMED.local_player_game_facts' }],
    listDimensions: () => [
      { name: 'season', type: 'number', sql: 'season', table: 'TRANSFORMED.local_player_season_facts' },
      { name: 'game_date', type: 'date', sql: 'game_date', table: 'TRANSFORMED.local_player_game_facts', isTimeDimension: true },
    ],
    listEntities: () => [], listSemanticModels: () => [], findJoinPath: () => [], displayFormatFor: () => undefined,
  } as unknown as SemanticLayer;
  const relations = [
    { schema: 'TRANSFORMED', name: 'local_player_season_facts', columns: [{ name: 'player_id' }, { name: 'season', dataType: 'INTEGER' }, { name: 'points' }, { name: 'games_played' }] },
    { schema: 'TRANSFORMED', name: 'local_player_game_facts', columns: [{ name: 'game_id' }, { name: 'game_date', dataType: 'DATE' }, { name: 'points' }] },
  ];
  const source = buildVocabularySource({ manifest: undefined, semanticLayer: layer, relations } as never);
  it('a metric with no cube and no measure still executes: table, expression and type are its binding', () => {
    const total = source.metrics!.find((metric) => metric.name === 'total_points');
    expect(total?.physical).toEqual({ relation: 'TRANSFORMED.local_player_season_facts', expr: '"TRANSFORMED"."local_player_season_facts"."points"', aggregate: 'sum' });
    // A ratio of aggregates is not a simple physical binding.
    expect(source.metrics!.find((metric) => metric.name === 'points_per_game')?.physical).toBeUndefined();
  });
  it('its dimensions are admitted with their own relation, named by that relation', () => {
    const season = source.dimensions!.find((dimension) => dimension.name === 'season');
    expect(season).toMatchObject({ model: 'local_player_season_facts', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'season' } });
    const date = source.dimensions!.find((dimension) => dimension.name === 'game_date');
    expect(date).toMatchObject({ model: 'local_player_game_facts', isTime: true, physical: { relation: 'TRANSFORMED.local_player_game_facts', column: 'game_date' } });
  });
});
