import { describe, expect, it } from 'vitest';
import {
  buildAnalysisQuestionPlan,
  certifiedApplicabilityForObject,
  scoreAllowedSqlRelationWithAnalysisPlan,
  sortAllowedSqlContextForAnalysisPlan,
} from './analysis-planner.js';
import type { MetadataAllowedSqlContext, MetadataObject } from './catalog.js';

describe('analysis planner', () => {
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
    expect(plan.mode).toBe('general_analysis');
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
