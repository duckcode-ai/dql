import { describe, expect, it } from 'vitest';
import {
  buildAnalysisQuestionPlan,
  certifiedApplicabilityForObject,
  scoreAllowedSqlRelationWithAnalysisPlan,
  sortAllowedSqlContextForAnalysisPlan,
} from './analysis-planner.js';
import type { MetadataAllowedSqlContext, MetadataObject } from './catalog.js';

describe('analysis planner', () => {
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
