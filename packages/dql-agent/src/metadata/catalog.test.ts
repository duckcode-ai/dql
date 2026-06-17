import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      intent: 'ad_hoc_ranking',
      reviewStatus: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
    });
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

  it('carries selected app block context into drilldown follow-ups', async () => {
    const selectedContext = {
      cellId: 'scope:nba',
      sql: JSON.stringify({
        scope: 'selected-dashboard-block',
        dashboardTitle: 'NBA Operations',
        selectedBlock: {
          blockId: 'Top 10 Goal Scorers',
          title: 'Top 10 Goal Scorers',
          tileId: 'tile-top-scorers',
          rowCount: 10,
          columns: ['player_name', 'season', 'total_points'],
          sampleRows: [{ player_name: 'James Harden', season: 2016, total_points: 1881 }],
        },
      }),
    };
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'I need to focus on only 2016 year',
      followUp: { kind: 'drilldown', sourceBlockName: 'Top 10 Goal Scorers', filters: ['season = 2016'] },
      selectedContext,
      limit: 20,
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'entity_drilldown',
      reviewStatus: 'draft_ready',
    });
    expect(pack.focusObjectKey).toBe('dql:block:Top 10 Goal Scorers');
    expect(pack.objects[0]?.objectKey).toBe('dql:block:Top 10 Goal Scorers');
    expect(pack.objects.map((row) => row.objectKey)).toContain('dql:block:Top 10 Goal Scorers');
    expect(pack.objects.map((row) => row.objectType)).toContain('selected_context');
    expect(pack.allowedSqlContext.sourceBlockSql).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Top 10 Goal Scorers',
          status: 'certified',
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
