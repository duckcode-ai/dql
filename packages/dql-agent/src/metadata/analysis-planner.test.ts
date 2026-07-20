import { describe, expect, it } from 'vitest';
import {
  buildAnalysisQuestionPlan,
  certifiedApplicabilityForObject,
  scoreAllowedSqlRelationWithAnalysisPlan,
  sortAllowedSqlContextForAnalysisPlan,
} from './analysis-planner.js';
import type { MetadataAllowedSqlContext, MetadataObject } from './catalog.js';

describe('analysis planner', () => {
  it('AGT-005 models entity-relative measures as peer comparisons', () => {
    const plan = buildAnalysisQuestionPlan('Who are the other customers who paid less tax than Melissa?');

    expect(plan.mode).toBe('comparison');
    expect(plan.routeIntent).toBe('segment_compare');
    expect(plan.needsGeneratedSql).toBe(true);
    expect(plan.dimensionTerms).toContain('customer');
    expect(plan.metricTerms).toContain('tax');
    expect(plan.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Melissa', source: 'explicit_filter' }),
    ]));
    expect(plan.valueMentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Melissa', syntacticRole: 'filter_value' }),
    ]));
    expect(plan.requestedShape).toMatchObject({
      dimensions: ['customer'],
      measures: ['tax'],
      filters: ['Melissa'],
      rankingDirection: 'bottom',
    });
  });

  it('classifies higher-than entity questions as upward comparisons', () => {
    const plan = buildAnalysisQuestionPlan('Which accounts generated more revenue than Acme?');

    expect(plan.mode).toBe('comparison');
    expect(plan.requestedShape.rankingDirection).toBe('top');
    expect(plan.requestedShape.filters).toContain('Acme');
  });

  it('AGT-005 classifies a new-session named-value product question as ranking, not definition', () => {
    const plan = buildAnalysisQuestionPlan('what are the top product Melissa Lopex got it? what is the revenue?');

    expect(plan.mode).toBe('ranking');
    expect(plan.routeIntent).toBe('ad_hoc_ranking');
    expect(plan.requestedShape).toMatchObject({
      grain: 'product',
      dimensions: ['product'],
      measures: ['revenue'],
      filters: ['Melissa Lopex'],
      topN: { n: 10, scope: 'overall' },
      rankingDirection: 'top',
    });
    expect(plan.valueMentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Melissa Lopex', syntacticRole: 'filter_value' }),
    ]));
    expect(plan.requestedShape.filters).not.toEqual(expect.arrayContaining(['melissa', 'lopex']));
  });

  it('keeps certified contracts eligible for lifetime-spend list paraphrases', () => {
    for (const question of [
      'Can you give each customer with lifetime spend info',
      'List every customer and their lifetime spend',
      'Show lifetime spend by customer',
      "What is each customer's lifetime spend?",
    ]) {
      const plan = buildAnalysisQuestionPlan(question);
      expect(plan.mode, question).not.toBe('definition');
      expect(plan.shouldConsiderCertifiedExact, question).toBe(true);
      expect(plan.requestedShape.dimensions, question).toContain('customer');
      expect(plan.requestedShape.measures, question).toContain('spend');
    }
  });

  it('treats across-all entity wording as one scalar aggregate, not a breakdown', () => {
    const plan = buildAnalysisQuestionPlan('What is total lifetime spend across all customers?');

    expect(plan.mode).toBe('exact_lookup');
    expect(plan.outputShape).toBe('value');
    expect(plan.requestedShape.dimensions).toEqual([]);
    expect(plan.requestedShape.grain).toBeUndefined();
    expect(plan.requestedShape.measures).toEqual(expect.arrayContaining(['spend', 'lifetime_spend']));
    expect(plan.requestedShape.requiredOutputs).toContain('spend');
    expect(plan.requestedShape.requiredOutputs).not.toContain('customer');
    expect(plan.requestedShape.requiredOutputs).not.toContain('total');
  });

  it('AGT-001 treats a temporally scoped KPI question as a scalar value', () => {
    const plan = buildAnalysisQuestionPlan('What was revenue last week?');

    expect(plan.mode).toBe('exact_lookup');
    expect(plan.routeIntent).toBe('exact_certified_lookup');
    expect(plan.outputShape).toBe('value');
    expect(plan.requestedShape.dimensions).toEqual([]);
  });

  it('keeps requested supply detail distinct from a product-only answer shape', () => {
    const plan = buildAnalysisQuestionPlan('Which supplies are perishable by product?');

    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['supply', 'product']));
    expect(plan.requestedShape.requiredOutputs).toEqual(expect.arrayContaining(['supply', 'product']));
  });

  it('AGT-005 preserves measure, grain, qualifier, and ranking for category-scoped spend questions', () => {
    const plan = buildAnalysisQuestionPlan('who are the customers who spent most on beverages?');

    expect(plan.mode).toBe('ranking');
    expect(plan.metricTerms).toContain('spend');
    expect(plan.dimensionTerms).toContain('customer');
    expect(plan.filterTerms).toContain('beverage');
    expect(plan.requestedShape.filters).toContain('beverage');
    expect(plan.requestedShape.rankingDirection).toBe('top');
    expect(plan.requestedShape.topN).toEqual({ n: 10, scope: 'overall' });
    expect(plan.searchTerms).toEqual(expect.arrayContaining(['beverage', 'drink', 'spend', 'revenue']));
    expect(new Set(plan.searchTerms).size).toBe(plan.searchTerms.length);
  });

  it('treats a product-category phrase as a filter when ranking customers by more revenue', () => {
    const plan = buildAnalysisQuestionPlan('who are the customers who bought more revenue on beverage product category?');

    expect(plan.mode).toBe('ranking');
    expect(plan.dimensionTerms).toEqual(['customer']);
    expect(plan.filterTerms).toContain('beverage');
    expect(plan.requestedShape).toMatchObject({
      grain: 'customer',
      dimensions: ['customer'],
      measures: ['revenue'],
      topN: { n: 10, scope: 'overall' },
      rankingDirection: 'top',
    });
    expect(plan.requestedShape.requiredOutputs).toEqual(expect.arrayContaining(['customer', 'revenue']));
    expect(plan.requestedShape.requiredOutputs).not.toEqual(expect.arrayContaining(['product', 'category']));
  });

  it('treats a category-products phrase as filter context rather than customer-ranking output grain (AGT-009, AGT-010)', () => {
    const plan = buildAnalysisQuestionPlan('who are the top customers who spent on beverage category products?');

    expect(plan.mode).toBe('ranking');
    expect(plan.dimensionTerms).toEqual(['customer']);
    expect(plan.filterTerms).toContain('beverage');
    expect(plan.requestedShape).toMatchObject({
      grain: 'customer',
      dimensions: ['customer'],
      measures: ['spend'],
      filters: ['beverage'],
      topN: { n: 10, scope: 'overall' },
      rankingDirection: 'top',
    });
    expect(plan.requestedShape.requiredOutputs).not.toEqual(expect.arrayContaining(['product', 'category']));
  });

  it('applies the same filter-only grain rule to arbitrary entity and segment names', () => {
    const plan = buildAnalysisQuestionPlan('which accounts generated more revenue in enterprise customer segment?');

    expect(plan.mode).toBe('ranking');
    expect(plan.dimensionTerms).toEqual(['account']);
    expect(plan.filterTerms).toContain('enterprise');
    expect(plan.requestedShape).toMatchObject({
      grain: 'account',
      dimensions: ['account'],
      measures: ['revenue'],
      topN: { n: 10, scope: 'overall' },
      rankingDirection: 'top',
    });
  });

  it('extracts requested shape for product revenue rankings', () => {
    const plan = buildAnalysisQuestionPlan('Give me the most revenue products with product name, category and revenue');

    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['product', 'category']));
    expect(plan.requestedShape.measures).toContain('revenue');
    expect(plan.requestedShape.requiredOutputs).toEqual(expect.arrayContaining(['product_name', 'category', 'revenue']));
    expect(plan.requestedShape.rankingDirection).toBe('top');
  });

  it('classifies a multi-dimension breakdown as analysis, not clarify, with clean outputs', () => {
    // Regression: "average tax info by location by product" used to (a) fall to a
    // clarify intent (brittle keyword classifier), which then over-escalated to a
    // slow research investigation, and (b) manufacture phantom required-output
    // columns ("location_by_product", "average_tax_info_by_location_by_product")
    // from greedy term regexes, falsely flagging a correct answer as "partial".
    const plan = buildAnalysisQuestionPlan('Can you give me the average tax info by location by product?');

    // A breakdown with named dimensions is analytical (routes to a fast direct answer).
    expect(plan.mode).toBe('list_by_dimension');
    expect(plan.routeIntent).toBe('ad_hoc_ranking');
    // Clean grouping dimensions — no "a by b" blob.
    expect(plan.dimensionTerms).toEqual(expect.arrayContaining(['location', 'product']));
    expect(plan.dimensionTerms).not.toContain('location by product');
    // No phantom multi-clause required-output columns.
    for (const output of plan.requestedShape.requiredOutputs) {
      expect(output).not.toMatch(/_by_|\bby\b/);
    }
    expect(plan.requestedShape.requiredOutputs).toEqual(expect.arrayContaining(['location', 'product']));
  });

  it('AGT-001 treats analytical what-is phrasing as a data request', () => {
    const plan = buildAnalysisQuestionPlan('what is the tax and product info for customer life span?');

    expect(plan.mode).toBe('general_analysis');
    expect(plan.routeIntent).toBe('ad_hoc_ranking');
    expect(plan.needsGeneratedSql).toBe(true);
    expect(plan.outputShape).toBe('table');
    expect(plan.metricTerms).toContain('tax');
    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['customer', 'product']));
    expect(plan.requestedShape.requiredOutputs).toEqual(expect.arrayContaining(['customer', 'product', 'tax']));
  });

  it('keeps a single-concept what-is question on the definition path', () => {
    const plan = buildAnalysisQuestionPlan('what is customer lifetime value?');

    expect(plan.mode).toBe('definition');
    expect(plan.routeIntent).toBe('definition_lookup');
  });

  it('extracts top-N and follow-up references', () => {
    const plan = buildAnalysisQuestionPlan('who are the top 5 customers for these categories?', { kind: 'drilldown' });

    expect(plan.requestedShape.topN).toEqual({ n: 5, scope: 'overall' });
    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['customer', 'category']));
    expect(plan.requestedShape.followUpReferences[0]).toMatchObject({
      phrase: 'these categories',
      kind: 'prior_dimension_values',
    });
  });

  it('carries deictic-only follow-up values into the requested answer shape', () => {
    const plan = buildAnalysisQuestionPlan('who are the top 5 customers for those?', {
      kind: 'drilldown',
      dimensions: ['category'],
      filters: ['Food', 'Drink'],
      priorResultValues: { category: ['Food', 'Drink'] },
      priorMeasures: ['revenue'],
    });

    expect(plan.requestedShape.topN).toEqual({ n: 5, scope: 'overall' });
    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['customer', 'category']));
    expect(plan.requestedShape.measures).toContain('revenue');
    expect(plan.requestedShape.filters).toEqual(expect.arrayContaining(['Food', 'Drink']));
    expect(plan.requestedShape.followUpReferences[0]).toMatchObject({
      phrase: 'those',
      kind: 'prior_dimension_values',
      resolvedValues: ['Food', 'Drink'],
    });
  });

  it('AGT-012 preserves explicit prior-result members as typed query constraints', () => {
    const plan = buildAnalysisQuestionPlan('who are the customer from flame impala', {
      kind: 'drilldown',
      filters: ['flame impala'],
      dimensions: ['customer', 'product'],
      priorResultValues: { product_name: ['flame impala'] },
      memberBindings: [{
        dimension: 'product',
        values: ['flame impala'],
        source: 'prior_result',
        confidence: 'exact',
        sourceTurnId: 'turn_products',
      }],
    });

    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['customer', 'product']));
    expect(plan.requestedShape.filters).toContain('flame impala');
    expect(plan.requestedShape.memberBindings).toEqual([{
      dimension: 'product',
      values: ['flame impala'],
      source: 'prior_result',
      confidence: 'exact',
      sourceTurnId: 'turn_products',
    }]);
    expect(plan.requestedShape.followUpReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'prior_dimension_values',
        resolvedValues: ['flame impala'],
      }),
    ]));
  });

  it('CTX-003 resolves customer pronouns and amount references from the prior result', () => {
    const plan = buildAnalysisQuestionPlan('what product they bought for this amount?', {
      kind: 'drilldown',
      dimensions: ['customer', 'product'],
      priorResultValues: {
        customer_name: ['Adele Ace'],
        product_name: ['Vanilla Ice'],
      },
      priorMeasures: ['revenue'],
    });

    expect(plan.requestedShape.followUpReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phrase: 'they',
        kind: 'prior_dimension_values',
        resolvedValues: ['Adele Ace'],
      }),
      expect.objectContaining({ phrase: expect.stringContaining('this amount'), kind: 'prior_entities' }),
    ]));
    expect(plan.requestedShape.filters).toContain('Adele Ace');
    expect(plan.filterTerms).not.toContain('for this amount');
    expect(plan.metricTerms).toContain('revenue');
    expect(plan.metricTerms).not.toContain('amount');
    expect(plan.requestedShape.requiredOutputs).not.toContain('amount');
    expect(plan.timeTerms).not.toContain('this amount');
    expect(plan.requestedShape.grain).not.toBe('this amount');
  });

  it('classifies entity profile research without hard-coding the entity domain', () => {
    const plan = buildAnalysisQuestionPlan('Can you research on Kevin Durant profile and provide me the complete stats');

    expect(plan.mode).toBe('entity_profile');
    expect(plan.routeIntent).toBe('entity_drilldown');
    expect(plan.outputShape).toBe('profile');
    expect(plan.needsGeneratedSql).toBe(true);
    expect(plan.needsResearchWorkspace).toBe(true);
    expect(plan.entities.map((entity) => entity.text)).toContain('Kevin Durant');
    expect(plan.searchTerms).toEqual(expect.arrayContaining(['profile', 'stat']));
  });

  it('treats certified blocks as exact by business content when grain matches', () => {
    const plan = buildAnalysisQuestionPlan('Which NBA players are the leading scorers?');
    const block = certifiedBlock({
      description: 'Top 10 NBA players by total points scored.',
      tags: ['nba', 'player', 'points', 'scoring'],
      sql: 'select player_name, total_points from fct_player_performance order by total_points desc limit 10',
    });

    const applicability = certifiedApplicabilityForObject(block, plan);

    expect(applicability.kind).toBe('exact_answer');
    expect(applicability.reasons.join(' ')).toContain('metric terms matched');
  });

  it('downgrades relevant certified blocks to context for entity profile questions', () => {
    const plan = buildAnalysisQuestionPlan('Research Kevin Durant profile and complete stats');
    const block = certifiedBlock({
      description: 'Certified player stats context with scoring and performance fields.',
      tags: ['nba', 'player', 'stats', 'points', 'scoring'],
      sql: 'select player_name, total_points from fct_player_performance order by total_points desc limit 10',
    });

    const applicability = certifiedApplicabilityForObject(block, plan);

    expect(applicability.kind).toBe('context_only');
    expect(applicability.reasons.join(' ')).toContain('different entity');
  });

  it('prioritizes allowed SQL relations that match requested metrics and dimensions', () => {
    const plan = buildAnalysisQuestionPlan('Show customer revenue by month');
    const context: MetadataAllowedSqlContext = {
      relations: [
        {
          relation: 'analytics.dim_products',
          name: 'dim_products',
          source: 'dbt manifest',
          columns: [{ name: 'product_id' }, { name: 'product_name' }],
        },
        {
          relation: 'analytics.fct_customer_revenue',
          name: 'fct_customer_revenue',
          source: 'dbt manifest',
          columns: [{ name: 'customer_id' }, { name: 'revenue' }, { name: 'month' }],
        },
      ],
      sourceBlockSql: [],
    };

    const sorted = sortAllowedSqlContextForAnalysisPlan(context, plan);

    expect(sorted.relations[0]?.relation).toBe('analytics.fct_customer_revenue');
    expect(scoreAllowedSqlRelationWithAnalysisPlan(sorted.relations[0]!, plan).reasons.join(' ')).toContain('metric terms matched');
  });

  it('caps noisy allowed SQL context while keeping the strongest relation first', () => {
    const plan = buildAnalysisQuestionPlan('Show customer revenue by month');
    const context: MetadataAllowedSqlContext = {
      relations: [
        ...Array.from({ length: 60 }, (_, index) => ({
          relation: `analytics.noisy_${index}`,
          name: `noisy_${index}`,
          source: 'dbt manifest',
          columns: [{ name: 'id' }, { name: 'created_at' }],
        })),
        {
          relation: 'analytics.fct_customer_revenue',
          name: 'fct_customer_revenue',
          source: 'dbt manifest',
          columns: [{ name: 'customer_id' }, { name: 'revenue' }, { name: 'month' }],
        },
      ],
      sourceBlockSql: [],
    };

    const sorted = sortAllowedSqlContextForAnalysisPlan(context, plan);

    expect(sorted.relations).toHaveLength(40);
    expect(sorted.relations[0]?.relation).toBe('analytics.fct_customer_revenue');
  });

  it('prefers column-backed profile relations over sparse name-only matches', () => {
    const plan = buildAnalysisQuestionPlan('Can you research on Kevin Durant profile and provide complete stats');
    const context: MetadataAllowedSqlContext = {
      relations: [
        {
          relation: 'NBA_ANALYTICS.TRANSFORMED.int_player_stats',
          name: 'int_player_stats',
          source: 'dbt manifest',
          columns: [],
        },
        {
          relation: 'NBA_GAMES.RAW.fct_player_performance',
          name: 'fct_player_performance',
          source: 'certified source SQL shape',
          columns: [
            { name: 'player_name' },
            { name: 'season' },
            { name: 'total_points' },
            { name: 'total_assists' },
            { name: 'total_rebounds' },
          ],
        },
      ],
      sourceBlockSql: [],
    };

    const sorted = sortAllowedSqlContextForAnalysisPlan(context, plan);
    const score = scoreAllowedSqlRelationWithAnalysisPlan(sorted.relations[0]!, plan);

    expect(sorted.relations[0]?.relation).toBe('NBA_GAMES.RAW.fct_player_performance');
    expect(score.reasons.join(' ')).toContain('relation has usable columns');
  });

  it('uses semantic column aliases to prefer physical product revenue columns over certified source-shape aliases', () => {
    const plan = buildAnalysisQuestionPlan('Give me the most revenue products with product name, category and revenue');
    const context: MetadataAllowedSqlContext = {
      relations: [
        {
          relation: 'certified.food_vs_drink_revenue',
          name: 'food_vs_drink_revenue',
          source: 'certified source SQL shape',
          columns: [{ name: 'category' }, { name: 'revenue' }],
        },
        {
          relation: 'SHOP.ANALYTICS.order_items',
          name: 'order_items',
          source: 'runtime schema',
          columns: [
            { name: 'order_id' },
            { name: 'product_name' },
            { name: 'product_type' },
            { name: 'product_price' },
          ],
        },
      ],
      sourceBlockSql: [],
    };

    const sorted = sortAllowedSqlContextForAnalysisPlan(context, plan);
    const score = scoreAllowedSqlRelationWithAnalysisPlan(sorted.relations[0]!, plan);

    expect(sorted.relations[0]?.relation).toBe('SHOP.ANALYTICS.order_items');
    expect(score.reasons.join(' ')).toContain('semantic column map matched');
    expect(score.reasons.join(' ')).toContain('category->product_type');
    expect(score.reasons.join(' ')).toContain('revenue->product_price');
  });

  it('uses column descriptions for business metric matching', () => {
    const plan = buildAnalysisQuestionPlan('Show revenue by market');
    const context: MetadataAllowedSqlContext = {
      relations: [
        {
          relation: 'analytics.customer_markets',
          name: 'customer_markets',
          source: 'dbt manifest',
          columns: [{ name: 'market' }, { name: 'customer_count' }],
        },
        {
          relation: 'analytics.market_finance',
          name: 'market_finance',
          source: 'dbt manifest',
          columns: [
            { name: 'market' },
            { name: 'net_amount', description: 'Recognized revenue after refunds.' },
          ],
        },
      ],
      sourceBlockSql: [],
    };

    const sorted = sortAllowedSqlContextForAnalysisPlan(context, plan);
    const score = scoreAllowedSqlRelationWithAnalysisPlan(sorted.relations[0]!, plan);

    expect(sorted.relations[0]?.relation).toBe('analytics.market_finance');
    expect(score.reasons.join(' ')).toContain('revenue->net_amount');
  });

  it('treats semantic identifiers and source-to-target wording as a multi-dimensional flow', () => {
    const plan = buildAnalysisQuestionPlan(
      'Render a Sankey: product_type to product_name weighted by total revenue. Return exactly product_type, product_name, and revenue.',
    );

    expect(plan.outputShape).toBe('chart');
    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['product', 'type']));
    expect(plan.requestedShape.requiredOutputs).toEqual(
      expect.arrayContaining(['product_type', 'product_name', 'revenue']),
    );
    expect(plan.requestedShape.requiredOutputs).not.toEqual(['revenue']);
  });
});

function certifiedBlock(input: { description: string; tags: string[]; sql: string }): MetadataObject {
  return {
    objectKey: 'dql:block:Top 10 Goal Scorers',
    objectType: 'dql_block',
    name: 'Top 10 Goal Scorers',
    status: 'certified',
    description: input.description,
    payload: {
      tags: input.tags,
      sql: input.sql,
    },
  };
}
