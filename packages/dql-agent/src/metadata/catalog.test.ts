import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLocalContextPack,
  defaultMetadataPath,
  ensureMetadataCatalogFresh,
  openMetadataCatalog,
  planAgentAnswer,
  recordRuntimeSchemaSnapshot,
  recordQueryRun,
} from './catalog.js';

describe('local metadata catalog', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempProject();
    seedDqlProject(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('builds a SQLite catalog with DQL, dbt, FTS, diagnostics, and query-run evidence', async () => {
    const refresh = await ensureMetadataCatalogFresh(projectRoot);

    expect(refresh.refreshed).toBe(true);
    expect(existsSync(defaultMetadataPath(projectRoot))).toBe(true);
    expect(refresh.objectCount).toBeGreaterThan(4);
    expect(refresh.edgeCount).toBeGreaterThan(0);
    expect(refresh.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'semantic',
          severity: 'warning',
        }),
      ]),
    );

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('dql:block:Top 10 Goal Scorers')).toMatchObject({
        objectType: 'dql_block',
        status: 'certified',
        payload: expect.objectContaining({
          sql: expect.stringContaining('ORDER BY total_points DESC'),
          tableDependencies: expect.arrayContaining(['fct_player_performance']),
        }),
      });
      expect(catalog.getObject('dbt:model:fct_player_performance')).toMatchObject({
        objectType: 'dbt_model',
        status: 'dbt_imported',
      });
      expect(catalog.edgesForKeys(['dql:block:Top 10 Goal Scorers'], 1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'uses_dbt_model',
            fromKey: 'dql:block:Top 10 Goal Scorers',
            toKey: 'dbt:model:fct_player_performance',
          }),
        ]),
      );
      expect(catalog.searchObjects({ query: 'least points player', limit: 10 }).map((row) => row.objectKey)).toEqual(
        expect.arrayContaining([
          'dql:block:Top 10 Goal Scorers',
          'dbt:column:fct_player_performance.total_points',
        ]),
      );
    } finally {
      catalog.close();
    }

    recordQueryRun(projectRoot, {
      objectKey: 'dbt:model:fct_player_performance',
      source: 'ai_draft',
      status: 'executed',
      rowCount: 10,
      durationMs: 42,
      payload: { sql: 'select player_name, total_points from fct_player_performance order by total_points asc limit 10' },
    });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Who scored the least points?',
      limit: 20,
    });

    expect(pack.id).toMatch(/^ctx_/);
    expect(pack.trustLabel).not.toBe('certified');
    expect(pack.objects.map((row) => row.objectKey)).toEqual(
      expect.arrayContaining([
        'dql:block:Top 10 Goal Scorers',
        'dbt:model:fct_player_performance',
        'dbt:column:fct_player_performance.total_points',
      ]),
    );
    expect(pack.queryRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'ai_draft', status: 'executed', rowCount: 10 }),
      ]),
    );
    expect(pack.warnings.join('\n')).toContain('No semantic');
    expect(pack.retrievalDiagnostics.selectedEvidence.length).toBeGreaterThan(0);
    expect(pack.citations.map((citation) => citation.objectKey)).toContain('dql:block:Top 10 Goal Scorers');
    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'ad_hoc_ranking',
      reviewStatus: 'draft_ready',
    });
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining(['NBA_DB.ANALYTICS.fct_player_performance']),
    );
  });

  it('routes exact certified block-name questions to certified execution', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Run Top 10 Goal Scorers',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      intent: 'exact_certified_lookup',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
    });
  });

  it('routes exact certified example questions to certified execution', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Who were the top scorers?',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      intent: 'ad_hoc_ranking',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
    });
  });

  it('routes certified blocks by business content even when the block name is not used', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Which NBA players are the leading scorers?',
      limit: 20,
    });

    expect(plan.contextPack.questionPlan).toMatchObject({
      mode: 'ranking',
      routeIntent: 'ad_hoc_ranking',
    });
    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
      certifiedApplicability: expect.objectContaining({
        kind: 'exact_answer',
        name: 'Top 10 Goal Scorers',
      }),
    });
  });

  it('routes direct KPI value questions to certified blocks without requiring an example', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'What was revenue last week?',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      intent: 'exact_certified_lookup',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Revenue Total',
    });
  });

  it('pins source certified block and follow-up request context for drilldowns', async () => {
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Drill into Stephen Curry by game date',
      followUp: {
        kind: 'drilldown',
        sourceBlockName: 'Top 10 Goal Scorers',
        sourceQuestion: 'Run Top 10 Goal Scorers',
        filters: ['Stephen Curry'],
        dimensions: ['game date'],
      },
      limit: 20,
    });

    expect(pack.followUp).toMatchObject({
      kind: 'drilldown',
      sourceBlockName: 'Top 10 Goal Scorers',
    });
    expect(pack.objects.map((row) => row.objectKey)).toEqual(
      expect.arrayContaining([
        'dql:block:Top 10 Goal Scorers',
        expect.stringMatching(/^selected:followup:/),
      ]),
    );
    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'entity_drilldown',
      reviewStatus: 'draft_ready',
    });
  });

  it('uses certified blocks as context for entity profile questions and generates SQL from metadata', async () => {
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Research Kevin Durant profile and complete stats',
      limit: 20,
    });

    expect(pack.questionPlan).toMatchObject({
      mode: 'entity_profile',
      routeIntent: 'entity_drilldown',
    });
    expect(pack.questionPlan.entities.map((entity) => entity.text)).toContain('Kevin Durant');
    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'entity_drilldown',
      reviewStatus: 'draft_ready',
      certifiedApplicability: expect.objectContaining({
        kind: 'context_only',
      }),
    });
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining(['NBA_DB.ANALYTICS.int_player_stats']),
    );
    const sourceShapeRelation = pack.allowedSqlContext.relations.find((relation) =>
      relation.relation.endsWith('int_player_stats'),
    );
    expect(sourceShapeRelation?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['dataset_name', 'row_count']),
    );
  });

  it('keeps SQL relation context bounded and ranked in noisy dbt projects', async () => {
    addNoisyDbtModels(projectRoot, 80);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 120,
    });

    expect(pack.allowedSqlContext.relations.length).toBeLessThanOrEqual(40);
    expect(pack.allowedSqlContext.relations[0]?.relation).toContain('fct_player_performance');
    expect(pack.retrievalDiagnostics.selectedRelations?.[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
    });
    expect(pack.retrievalDiagnostics.selectedRelations?.[0]?.reason).toMatch(/metric terms matched|dimension terms matched|relation shape/);
  });

  it('adds schema-shape dbt candidates when entity values do not appear in metadata text', async () => {
    addNoisyDbtModels(projectRoot, 120);
    addGenericAthleteBoxScoreModel(projectRoot);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can you research Kevin Durant profile and provide complete stats',
      limit: 40,
    });

    expect(pack.questionPlan).toMatchObject({
      mode: 'entity_profile',
      routeIntent: 'entity_drilldown',
    });
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('NBA_DB.ANALYTICS.athlete_box_scores');
    expect(pack.retrievalDiagnostics.schemaShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dbt:model:athlete_box_scores',
          relation: 'NBA_DB.ANALYTICS.athlete_box_scores',
          reason: expect.stringContaining('entity identifiers: athlete_name'),
          columns: expect.arrayContaining(['athlete_name', 'game_date', 'pts', 'ast', 'reb']),
        }),
      ]),
    );
    expect(pack.retrievalDiagnostics.selectedRelations?.map((relation) => relation.relation)).toContain('NBA_DB.ANALYTICS.athlete_box_scores');
  });

  it('finds schema-shape dbt candidates beyond the first large-repo scan window', async () => {
    addNoisyDbtModels(projectRoot, 1800);
    addGenericAthleteBoxScoreModel(projectRoot, 'zz_athlete_box_scores');

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can you research Kevin Durant profile and provide complete stats',
      limit: 40,
    });

    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('NBA_DB.ANALYTICS.zz_athlete_box_scores');
    expect(pack.retrievalDiagnostics.schemaShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dbt:model:zz_athlete_box_scores',
          relation: 'NBA_DB.ANALYTICS.zz_athlete_box_scores',
          reason: expect.stringContaining('entity identifiers: athlete_name'),
          columns: expect.arrayContaining(['athlete_name', 'game_date', 'pts', 'ast', 'reb']),
        }),
      ]),
    );
  });

  it('exposes selected join paths between dbt relations with shared keys', async () => {
    addPlayerDimensionModel(projectRoot);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show player points by position',
      limit: 40,
    });

    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining([
        'NBA_DB.ANALYTICS.fct_player_performance',
        'NBA_DB.ANALYTICS.dim_players',
      ]),
    );
    expect(pack.retrievalDiagnostics.selectedJoinPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leftRelation: 'NBA_DB.ANALYTICS.fct_player_performance',
          leftColumn: 'player_id',
          rightRelation: 'NBA_DB.ANALYTICS.dim_players',
          rightColumn: 'player_id',
          reason: 'shared key player_id',
        }),
      ]),
    );
  });

  it('retains parent dbt model columns when retrieval starts from column hits', async () => {
    addNoisyDbtModels(projectRoot, 80);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show player points by season',
      objectTypes: ['dbt_column'],
      limit: 2,
    });

    const relation = pack.allowedSqlContext.relations.find((candidate) =>
      candidate.relation.endsWith('fct_player_performance'),
    );

    expect(relation?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['player_name', 'season', 'points', 'total_points']),
    );
    expect(pack.retrievalDiagnostics.selectedRelations?.[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
      columns: expect.arrayContaining(['player_name', 'season', 'points', 'total_points']),
    });
  });

  it('does not use generated draft blocks as allowed SQL context', async () => {
    mkdirSync(join(projectRoot, 'blocks', '_drafts'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'blocks', '_drafts', 'draft_fraud_pipeline.dql'),
      `block "Draft Fraud Pipeline" {
  domain = "risk"
  type = "custom"
  status = "draft"
  description = "AI-generated draft that has not been certified."
  asked_times = 1
  query = """
    SELECT account_id, risk_score
    FROM draft_only_table
  """
}`,
      'utf-8',
    );

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'review draft fraud pipeline',
      limit: 20,
    });

    expect(pack.objects.map((row) => row.objectKey)).toContain('dql:block:Draft Fraud Pipeline');
    expect(pack.allowedSqlContext.sourceBlockSql.map((source) => source.objectKey)).not.toContain('dql:block:Draft Fraud Pipeline');
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).not.toContain('draft_only_table');
  });

  it('asks for missing baseline context instead of proxying change analysis to an unrelated table', async () => {
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'What changed in Player Stats Data Availability?',
      focusObjectKey: 'dql:block:Player Stats Data Availability',
      limit: 20,
    });

    expect(pack.routeDecision.route).toBe('clarify');
    expect(pack.routeDecision.intent).toBe('diagnose_change');
    expect(pack.missingContext).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'baseline',
          severity: 'blocking',
        }),
      ]),
    );
  });

  it('uses runtime schema snapshots as allowed SQL context', async () => {
    recordRuntimeSchemaSnapshot(projectRoot, {
      source: 'test runtime',
      tables: [{
        relation: 'NBA_DB.RAW.player_box_scores',
        schema: 'RAW',
        name: 'player_box_scores',
        columns: [
          { name: 'player_name', type: 'VARCHAR', sampleValues: ['Stephen Curry'] },
          { name: 'points', type: 'NUMBER' },
          { name: 'game_date', type: 'DATE' },
        ],
      }],
    });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show Stephen Curry points by game date',
      limit: 20,
    });

    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('NBA_DB.RAW.player_box_scores');
    expect(pack.evidenceRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'runtime_schema',
          name: 'player_box_scores',
        }),
      ]),
    );
  });
});

function mkdtempProject(): string {
  return mkdtempSync(join(tmpdir(), 'dql-metadata-catalog-'));
}

function addNoisyDbtModels(root: string, count: number): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  for (let index = 0; index < count; index += 1) {
    manifest.nodes[`model.nba_analysis.noisy_${index}`] = {
      resource_type: 'model',
      name: `noisy_${index}`,
      alias: `noisy_${index}`,
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: `Unrelated noisy model ${index} for large repo retrieval testing.`,
      depends_on: { nodes: [] },
      tags: ['noise'],
      original_file_path: `models/noisy/noisy_${index}.sql`,
      config: { materialized: 'table' },
      columns: {
        id: { name: 'id', data_type: 'number' },
        created_at: { name: 'created_at', data_type: 'timestamp' },
      },
    };
  }
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addGenericAthleteBoxScoreModel(root: string, modelName = 'athlete_box_scores'): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  manifest.nodes[`model.nba_analysis.${modelName}`] = {
    resource_type: 'model',
    name: modelName,
    alias: modelName,
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Box score rows at game grain.',
    depends_on: { nodes: [] },
    tags: ['analytics'],
    original_file_path: `models/marts/${modelName}.sql`,
    config: { materialized: 'table' },
    columns: {
      athlete_name: {
        name: 'athlete_name',
        data_type: 'text',
        description: 'Name of the athlete.',
      },
      game_id: {
        name: 'game_id',
        data_type: 'text',
        description: 'Game identifier.',
      },
      game_date: {
        name: 'game_date',
        data_type: 'date',
        description: 'Date of the game.',
      },
      pts: {
        name: 'pts',
        data_type: 'number',
        description: 'Points recorded.',
      },
      ast: {
        name: 'ast',
        data_type: 'number',
        description: 'Assists recorded.',
      },
      reb: {
        name: 'reb',
        data_type: 'number',
        description: 'Rebounds recorded.',
      },
    },
  };
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addPlayerDimensionModel(root: string): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  const fact = manifest.nodes['model.nba_analysis.fct_player_performance'];
  if (fact) {
    fact.depends_on = { nodes: ['model.nba_analysis.dim_players'] };
    fact.columns = {
      ...((fact.columns as Record<string, unknown> | undefined) ?? {}),
      player_id: {
        name: 'player_id',
        data_type: 'text',
        description: 'Player identifier for joining to player attributes.',
      },
    };
  }
  manifest.nodes['model.nba_analysis.dim_players'] = {
    resource_type: 'model',
    name: 'dim_players',
    alias: 'dim_players',
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Player dimension table with profile attributes.',
    depends_on: { nodes: [] },
    tags: ['nba', 'player'],
    original_file_path: 'models/marts/dim_players.sql',
    config: { materialized: 'table' },
    columns: {
      player_id: {
        name: 'player_id',
        data_type: 'text',
        description: 'Player identifier.',
      },
      position: {
        name: 'position',
        data_type: 'text',
        description: 'Primary court position.',
      },
    },
  };
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function seedDqlProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'nba_ops' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'top_10_goal_scorers.dql'),
    `block "Top 10 Goal Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top 10 NBA players by total points scored."
  tags = ["nba", "player", "points", "scoring"]
  llmContext = "Use for top scorers only. Do not use as a least-points or bottom-ranking answer."
  examples = [{ question = "Who were the top scorers?" }]
  query = """
    SELECT player_name, season, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1, 2
    ORDER BY total_points DESC
    LIMIT 10
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'blocks', 'player_stats_data_availability.dql'),
    `block "Player Stats Data Availability" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Current availability summary for player stats records."
  tags = ["nba", "player", "availability"]
  llmContext = "Use for current data availability only. Do not use for change analysis unless a baseline period is supplied."
  query = """
    SELECT dataset_name, COUNT(*) AS row_count
    FROM int_player_stats
    GROUP BY 1
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'blocks', 'revenue_total.dql'),
    `block "Revenue Total" {
  domain = "revenue"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Certified total revenue for the last completed week."
  tags = ["revenue", "kpi", "weekly"]
  query = """
    SELECT 42500 AS revenue_total
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'nba_analysis' },
      nodes: {
        'model.nba_analysis.fct_player_performance': {
          resource_type: 'model',
          name: 'fct_player_performance',
          alias: 'fct_player_performance',
          database: 'NBA_DB',
          schema: 'ANALYTICS',
          description: 'Player performance fact table with scoring, assists, and season grain.',
          depends_on: { nodes: [] },
          tags: ['nba', 'player'],
          original_file_path: 'models/marts/fct_player_performance.sql',
          config: { materialized: 'table' },
          columns: {
            player_name: {
              name: 'player_name',
              data_type: 'text',
              description: 'Player full name.',
            },
            season: {
              name: 'season',
              data_type: 'number',
              description: 'NBA season year.',
            },
            points: {
              name: 'points',
              data_type: 'number',
              description: 'Points scored in a game.',
            },
            total_points: {
              name: 'total_points',
              data_type: 'number',
              description: 'Aggregated points for a player and season.',
            },
          },
        },
        'model.nba_analysis.int_player_stats': {
          resource_type: 'model',
          name: 'int_player_stats',
          alias: 'int_player_stats',
          database: 'NBA_DB',
          schema: 'ANALYTICS',
          description: 'Current player stats intermediate table without historical availability snapshots.',
          depends_on: { nodes: [] },
          tags: ['nba', 'player'],
          original_file_path: 'models/intermediate/int_player_stats.sql',
          config: { materialized: 'table' },
          columns: {
            dataset_name: {
              name: 'dataset_name',
              data_type: 'text',
              description: 'Source dataset name.',
            },
            player_id: {
              name: 'player_id',
              data_type: 'text',
              description: 'Player identifier.',
            },
            row_count: {
              name: 'row_count',
              data_type: 'number',
              description: 'Current row count.',
            },
          },
        },
      },
      sources: {},
    }),
    'utf-8',
  );
}
