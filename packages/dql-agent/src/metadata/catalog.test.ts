import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLocalContextPack,
  defaultMetadataPath,
  ensureMetadataCatalogFresh,
  MetadataCatalog,
  openMetadataCatalog,
  planAgentAnswer,
  recordRuntimeSchemaSnapshot,
  recordQueryRun,
} from './catalog.js';
import { buildBlockBusinessFingerprint, buildBlockSqlFingerprints } from './block-fingerprints.js';
import { resolveSemanticLayerWithDiagnostics } from '@duckcodeailabs/dql-core';
import { recordCorrectionTrace, reviewHint } from '../hints/git-store.js';
import { defaultKgPath, reindexProject } from '../index.js';
import { KGStore } from '../kg/sqlite-fts.js';

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
          sqlFingerprints: expect.objectContaining({
            version: 'sql-fingerprint-v1',
            exact: expect.any(String),
            parameterized: expect.any(String),
          }),
          businessFingerprint: expect.objectContaining({
            version: 'business-shape-v1',
            hash: expect.any(String),
            tokens: expect.arrayContaining(['domain:nba']),
          }),
        }),
      });
      expect(catalog.getObject('dql:block:Top 10 Goal Scorers')?.payload?.sqlFingerprints).toMatchObject(
        buildBlockSqlFingerprints(`
    SELECT player_name, season, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1, 2
    ORDER BY total_points DESC
    LIMIT 10
  `),
      );
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
      expect(catalog.sourceFingerprints().map((item) => item.sourcePath)).toEqual(
        expect.arrayContaining(['blocks/top_10_goal_scorers.dql']),
      );
      expect(catalog.domainShards().map((item) => item.domain)).toEqual(
        expect.arrayContaining(['nba']),
      );
      expect(catalog.searchObjects({ query: 'least points player', limit: 10 }).map((row) => row.objectKey)).toEqual(
        expect.arrayContaining([
          'dql:block:Top 10 Goal Scorers',
          'dbt:column:fct_player_performance.total_points',
        ]),
      );
      expect(catalog.searchObjects({ query: 'scor', limit: 10 }).map((row) => row.objectKey)).toEqual(
        expect.arrayContaining([
          'dql:block:Top 10 Goal Scorers',
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
      trustLabelInfo: {
        id: 'ai_generated',
      },
    });
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining(['NBA_DB.ANALYTICS.fct_player_performance']),
    );
  });

  it('hands the whole small catalog to deep research and keeps ranked selection otherwise', async () => {
    // Deep mode (strictness: exploratory) over a tiny catalog: skip top-k pruning
    // and include every relation, even for a question that would not lexically
    // select it.
    const deep = await buildLocalContextPack(projectRoot, {
      question: 'give me an overview of everything available',
      strictness: 'exploratory',
    });
    expect(deep.retrievalDiagnostics.strategy).toBe('full_catalog');
    expect(deep.allowedSqlContext.relations.map((relation) => relation.relation)).toEqual(
      expect.arrayContaining(['NBA_DB.ANALYTICS.fct_player_performance']),
    );

    // Quick mode keeps ranked (sqlite_fts) selection — no full-catalog dump.
    const quick = await buildLocalContextPack(projectRoot, {
      question: 'give me an overview of everything available',
    });
    expect(quick.retrievalDiagnostics.strategy).not.toBe('full_catalog');
  });

  it('lets reindexProject skip unchanged metadata catalog rebuilds by fingerprint', async () => {
    const firstStats = await reindexProject(projectRoot, { loadSkills: false });
    const first = openMetadataCatalog(projectRoot);
    const firstBuiltAt = first.state('built_at');
    first.close();

    expect(firstBuiltAt).toBeTruthy();
    expect(firstStats.metadataRefreshed).toBe(true);
    expect(firstStats.metadataFingerprint).toBeTruthy();

    const secondStats = await reindexProject(projectRoot, { loadSkills: false });
    const second = openMetadataCatalog(projectRoot);
    try {
      expect(second.state('built_at')).toBe(firstBuiltAt);
    } finally {
      second.close();
    }
    expect(secondStats.metadataRefreshed).toBe(false);
    expect(secondStats.metadataFingerprint).toBe(firstStats.metadataFingerprint);
  });

  it('lets reindexProject skip unchanged KG rebuilds by graph fingerprint', async () => {
    const firstStats = await reindexProject(projectRoot, { loadSkills: false });
    const first = new KGStore(defaultKgPath(projectRoot));
    const firstBuiltAt = first.meta('built_at');
    const firstFingerprint = first.meta('fingerprint');
    first.close();

    expect(firstBuiltAt).toBeTruthy();
    expect(firstFingerprint).toBeTruthy();
    expect(firstStats.kgRebuilt).toBe(true);
    expect(firstStats.kgFingerprint).toBe(firstFingerprint);

    await sleep(10);
    const secondStats = await reindexProject(projectRoot, { loadSkills: false });
    const second = new KGStore(defaultKgPath(projectRoot));
    const secondBuiltAt = second.meta('built_at');
    const secondFingerprint = second.meta('fingerprint');
    second.close();

    expect(secondBuiltAt).toBe(firstBuiltAt);
    expect(secondFingerprint).toBe(firstFingerprint);
    expect(secondStats.kgRebuilt).toBe(false);
    expect(secondStats.kgFingerprint).toBe(firstStats.kgFingerprint);

    await sleep(10);
    const forcedStats = await reindexProject(projectRoot, { loadSkills: false, forceKgIndex: true });
    const forced = new KGStore(defaultKgPath(projectRoot));
    try {
      expect(forced.meta('fingerprint')).toBe(firstFingerprint);
      expect(forced.meta('built_at')).not.toBe(firstBuiltAt);
    } finally {
      forced.close();
    }
    expect(forcedStats.kgRebuilt).toBe(true);
    expect(forcedStats.kgFingerprint).toBe(firstStats.kgFingerprint);
  });

  it('indexes block output column lineage as traversable metadata edges', async () => {
    await ensureMetadataCatalogFresh(projectRoot);

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('dql:block_output:Top 10 Goal Scorers.total_points')).toMatchObject({
        objectType: 'dql_block_output',
        name: 'total_points',
        payload: expect.objectContaining({
          block: 'Top 10 Goal Scorers',
          output: 'total_points',
          isAggregate: true,
          aggregateFn: 'SUM',
          sources: expect.arrayContaining([
            expect.objectContaining({ table: 'fct_player_performance', column: 'points' }),
          ]),
        }),
      });
      expect(catalog.edgesForKeys(['dql:block:Top 10 Goal Scorers'], 3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'contains',
            fromKey: 'dql:block:Top 10 Goal Scorers',
            toKey: 'dql:block_output:Top 10 Goal Scorers.total_points',
          }),
          expect.objectContaining({
            edgeType: 'derives_from',
            fromKey: 'dql:block_output:Top 10 Goal Scorers.total_points',
            toKey: 'dbt:column:fct_player_performance.points',
          }),
        ]),
      );
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can I trust the total points lineage?',
      limit: 30,
    });

    expect(pack.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'derives_from',
          fromKey: 'dql:block_output:Top 10 Goal Scorers.total_points',
          toKey: 'dbt:column:fct_player_performance.points',
        }),
      ]),
    );
    expect(pack.objects.map((object) => object.objectKey)).toContain('dql:block_output:Top 10 Goal Scorers.total_points');
    const scoringRelation = pack.allowedSqlContext.relations.find((relation) =>
      relation.relation.endsWith('fct_player_performance'),
    );
    expect(scoringRelation?.columns.find((column) => column.name === 'points')?.description).toContain(
      'Governed aliases from lineage: total_points.',
    );
  });

  it('indexes dbt compiled SQL column lineage as traversable metadata edges', async () => {
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    manifest.nodes['model.nba_analysis.stg_player_games'] = {
      resource_type: 'model',
      name: 'stg_player_games',
      alias: 'stg_player_games',
      database: 'NBA_DB',
      schema: 'STAGING',
      description: 'Staging player game rows.',
      depends_on: { nodes: [] },
      tags: ['nba', 'player'],
      original_file_path: 'models/staging/stg_player_games.sql',
      config: { materialized: 'view' },
      columns: {
        player_name: { name: 'player_name', data_type: 'text', description: 'Player full name.' },
        season: { name: 'season', data_type: 'number', description: 'NBA season year.' },
        points: { name: 'points', data_type: 'number', description: 'Points scored in a game.' },
      },
    };
    manifest.nodes['model.nba_analysis.fct_player_performance'] = {
      ...manifest.nodes['model.nba_analysis.fct_player_performance'],
      depends_on: { nodes: ['model.nba_analysis.stg_player_games'] },
      compiled_code: `
        SELECT player_name, season, SUM(points) AS total_points
        FROM stg_player_games
        GROUP BY 1, 2
      `,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    await ensureMetadataCatalogFresh(projectRoot);

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('dbt:column:fct_player_performance.total_points')).toMatchObject({
        objectType: 'dbt_column',
        payload: expect.objectContaining({
          compiledSqlLineage: true,
          aggregateFn: 'SUM',
          lineageSources: expect.arrayContaining([
            expect.objectContaining({ table: 'stg_player_games', column: 'points' }),
          ]),
        }),
      });
      expect(catalog.edgesForKeys(['dbt:model:fct_player_performance'], 3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'derives_from',
            fromKey: 'dbt:column:fct_player_performance.total_points',
            toKey: 'dbt:column:stg_player_games.points',
          }),
        ]),
      );
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can I trust dbt total_points lineage from stg player games?',
      limit: 40,
    });

    expect(pack.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'derives_from',
          fromKey: 'dbt:column:fct_player_performance.total_points',
          toKey: 'dbt:column:stg_player_games.points',
        }),
      ]),
    );
  });

  it('uses governed lineage aliases to map business metrics onto physical columns', async () => {
    writeFileSync(
      join(projectRoot, 'blocks', 'product_revenue_context.dql'),
      `block "Product Revenue Context" {
  domain = "orders"
  type = "custom"
  status = "certified"
  description = "Certified product revenue context."
  tags = ["product", "revenue"]
  grain = "product"
  entities = ["Product"]
  outputs = ["product_name", "revenue"]
  query = """
    SELECT product_name, SUM(product_price) AS revenue
    FROM order_items
    GROUP BY 1
  """
}`,
      'utf-8',
    );
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    manifest.nodes['model.nba_analysis.order_items'] = {
      resource_type: 'model',
      name: 'order_items',
      alias: 'order_items',
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: 'Order item rows with product details and item price.',
      depends_on: { nodes: [] },
      tags: ['orders', 'product'],
      original_file_path: 'models/marts/order_items.sql',
      config: { materialized: 'table' },
      columns: {
        product_name: { name: 'product_name', data_type: 'text', description: 'Product display name.' },
        product_price: { name: 'product_price', data_type: 'number', description: 'Item sale price.' },
        product_type: { name: 'product_type', data_type: 'text', description: 'Food or drink category.' },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show revenue by product',
      limit: 40,
    });

    const orderItems = pack.allowedSqlContext.relations.find((relation) =>
      relation.relation.endsWith('order_items'),
    );
    expect(orderItems?.columns.find((column) => column.name === 'product_price')?.description).toContain(
      'Governed aliases from lineage: revenue.',
    );
    expect(pack.retrievalDiagnostics.selectedRelations?.find((relation) =>
      relation.relation.endsWith('order_items'),
    )?.reason).toContain('semantic column map matched');
    expect(pack.retrievalDiagnostics.selectedRelations?.find((relation) =>
      relation.relation.endsWith('order_items'),
    )?.reason).toContain('revenue->product_price');
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

  it('indexes optional DataLex contract evidence and links bound DQL blocks', async () => {
    writeFileSync(
      join(projectRoot, 'datalex-manifest.json'),
      JSON.stringify({
        manifestSpecVersion: '1.0.0',
        datalexVersion: 'test',
        generatedAt: '2026-06-20T00:00:00.000Z',
        project: { name: 'nba_contracts' },
        domains: [
          {
            name: 'nba',
            description: 'NBA player analytics contracts.',
            owners: ['data-governance'],
            glossary: [
              {
                term: 'Top Scorer',
                definition: 'A player ranked by total points scored.',
                tags: ['nba', 'scoring'],
              },
            ],
            entities: [
              {
                name: 'Player',
                description: 'NBA player business entity.',
                fields: [
                  { name: 'player_name', type: 'string', description: 'Player display name.' },
                  { name: 'total_points', type: 'number', description: 'Total points scored.' },
                ],
                contracts: [
                  {
                    id: 'nba.Player.top_scorers',
                    name: 'Top Scorers',
                    version: 1,
                    description: 'Contract for ranking NBA players by points.',
                    owner: 'analytics@example.com',
                    signature: {
                      outputs: [
                        { name: 'player_name', type: 'string' },
                        { name: 'total_points', type: 'number' },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'blocks', 'contracted_top_scorers.dql'),
      `block "Contracted Top Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  datalex_contract = "nba.Player.top_scorers@1"
  owner = "analytics@example.com"
  description = "Contract-backed top scorer ranking."
  tags = ["nba", "player", "points"]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
  """
}`,
      'utf-8',
    );

    await ensureMetadataCatalogFresh(projectRoot);
    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.getObject('datalex:domain:nba')).toMatchObject({
        objectType: 'datalex_domain',
        owner: 'data-governance',
      });
      expect(catalog.getObject('datalex:entity:nba.Player')).toMatchObject({
        objectType: 'datalex_entity',
        description: 'NBA player business entity.',
      });
      expect(catalog.getObject('datalex:contract:nba.Player.top_scorers@1')).toMatchObject({
        objectType: 'datalex_contract',
        description: 'Contract for ranking NBA players by points.',
      });
      expect(catalog.edgesForKeys(['dql:block:Contracted Top Scorers'], 1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edgeType: 'resolves_contract',
            fromKey: 'dql:block:Contracted Top Scorers',
            toKey: 'datalex:contract:nba.Player.top_scorers@1',
          }),
        ]),
      );
    } finally {
      catalog.close();
    }
  });

  it('turns DataLex relationships into grain-safe datalex join paths (R2.8)', async () => {
    // Two dbt models sharing player_id, and a DataLex manifest that models the
    // relationship between the entities bound to them.
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes: Record<string, Record<string, unknown>> };
    manifest.nodes['model.nba_analysis.dim_players'] = {
      resource_type: 'model', name: 'dim_players', alias: 'dim_players', database: 'NBA_DB', schema: 'ANALYTICS',
      description: 'Player dimension.', depends_on: { nodes: [] }, original_file_path: 'models/dim_players.sql',
      columns: {
        player_id: { name: 'player_id', data_type: 'text', description: 'Player id.' },
        player_name: { name: 'player_name', data_type: 'text', description: 'Player name.' },
      },
    };
    manifest.nodes['model.nba_analysis.fct_games'] = {
      resource_type: 'model', name: 'fct_games', alias: 'fct_games', database: 'NBA_DB', schema: 'ANALYTICS',
      description: 'Game facts by player.', depends_on: { nodes: [] }, original_file_path: 'models/fct_games.sql',
      columns: {
        player_id: { name: 'player_id', data_type: 'text', description: 'Player id.' },
        points: { name: 'points', data_type: 'number', description: 'Points scored.' },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    writeFileSync(
      join(projectRoot, 'datalex-manifest.json'),
      JSON.stringify({
        manifestSpecVersion: '1.0.0', datalexVersion: 'test', generatedAt: '2026-06-20T00:00:00.000Z',
        project: { name: 'nba_contracts' },
        domains: [{
          name: 'nba', entities: [
            { name: 'Player', binding: { kind: 'dbt_model', ref: 'dim_players' }, fields: [{ name: 'player_id', primary_key: true }] },
            { name: 'Game', binding: { kind: 'dbt_model', ref: 'fct_games' }, fields: [{ name: 'player_id' }] },
          ],
        }],
        relationships: [{
          name: 'player_plays_game', type: 'reference', identifying: true, cardinality: 'one_to_many',
          from: { entity: 'Player', column: 'player_id' },
          to: { entity: 'Game', column: 'player_id' },
        }],
      }),
      'utf-8',
    );

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'points by player joining players and games',
      limit: 40,
    });

    expect(pack.retrievalDiagnostics.selectedJoinPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'datalex',
          leftColumn: 'player_id',
          rightColumn: 'player_id',
          reason: expect.stringContaining('DataLex relationship player_plays_game'),
        }),
      ]),
    );
  });

  it('ingests DataLex conformance as searchable concept objects (W5.1)', async () => {
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes: Record<string, Record<string, unknown>> };
    manifest.nodes['model.nba_analysis.dim_players_w51'] = {
      resource_type: 'model', name: 'dim_players_w51', alias: 'dim_players_w51', database: 'NBA_DB', schema: 'ANALYTICS',
      description: 'Player dimension.', depends_on: { nodes: [] }, original_file_path: 'models/dim_players_w51.sql',
      columns: { player_id: { name: 'player_id', data_type: 'text' } },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    writeFileSync(
      join(projectRoot, 'datalex-manifest.json'),
      JSON.stringify({
        manifestSpecVersion: '1.0.0', datalexVersion: 'test', generatedAt: '2026-06-20T00:00:00.000Z',
        project: { name: 'nba_contracts' },
        domains: [{ name: 'nba', entities: [] }],
        conformance: [{
          concept: 'PlayerProfile', domain: 'nba', canonical_key: ['player_id'],
          physical: [{ entity: 'DimPlayers', binding: { kind: 'dbt_model', ref: 'dim_players_w51' } }],
        }],
      }),
      'utf-8',
    );

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'PlayerProfile concept',
      limit: 40,
    });
    const concept = pack.objects.find((o) => o.objectType === 'datalex_concept' && o.name === 'PlayerProfile');
    expect(concept).toBeDefined();
    expect(concept?.payload?.canonicalKey).toEqual(['player_id']);
    expect(concept?.payload?.physicalRefs).toEqual(['dbt:model:dim_players_w51']);
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

  it('grain gate: demotes a wrong-grain certified block to generated SQL (Tier 2)', async () => {
    // A player-grain certified block exists; the question asks for a team grain.
    // Retrieval surfaces the player block as the best certified candidate, but
    // its declared grain does not satisfy the requested grain, so the answer is
    // demoted to Tier 2 instead of served as a near-miss certified answer.
    addGrainedTeamScoringModel(projectRoot);
    writeFileSync(
      join(projectRoot, 'blocks', 'player_scoring_leaders.dql'),
      `block "Player Scoring Leaders" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Certified ranking of player scoring leaders by total points."
  tags = ["nba", "player", "points", "scoring"]
  grain = "player_id"
  entities = ["Player"]
  outputs = ["player_name", "total_points"]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
    ORDER BY total_points DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const plan = await planAgentAnswer(projectRoot, {
      question: 'Show total points by team',
      limit: 30,
    });

    expect(plan.routeDecision.route).toBe('generated_sql');
    expect(plan.routeDecision.routeReason).toMatch(/player.*team.*Tier 2/i);
    expect(plan.routeDecision.grainGate).toMatchObject({
      allow: false,
      kind: 'mismatch',
      blockName: 'Player Scoring Leaders',
    });
  });

  it('grain gate: keeps an exact-grain certified question on Tier 1 (no regression)', async () => {
    writeFileSync(
      join(projectRoot, 'blocks', 'player_scoring_leaders.dql'),
      `block "Player Scoring Leaders" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Certified ranking of player scoring leaders by total points."
  tags = ["nba", "player", "points", "scoring"]
  grain = "player_id"
  entities = ["Player"]
  outputs = ["player_name", "total_points"]
  examples = [{ question = "Show total points by player" }]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
    ORDER BY total_points DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const plan = await planAgentAnswer(projectRoot, {
      question: 'Show total points by player',
      limit: 30,
    });

    expect(plan.routeDecision.route).toBe('certified');
    expect(plan.routeDecision.exactObjectKey).toBe('dql:block:Player Scoring Leaders');
  });

  it('block-fit gate: demotes a category certified block for product-grain revenue questions', async () => {
    addJaffleOrderItemsModel(projectRoot);
    writeFileSync(
      join(projectRoot, 'blocks', 'food_vs_drink_revenue.dql'),
      `block "food_vs_drink_revenue" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Revenue split between food and drink categories from order items."
  tags = ["revenue", "category", "food", "drink"]
  llmContext = "Use only for Food vs Drink category-level revenue, not product-level revenue."
  grain = "category"
  entities = ["Category"]
  outputs = ["category", "revenue"]
  dimensions = ["category"]
  query = """
    SELECT product_type AS category, SUM(product_price) AS revenue
    FROM order_items
    GROUP BY 1
    ORDER BY revenue DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue',
      limit: 40,
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      intent: 'ad_hoc_ranking',
      reviewStatus: 'draft_ready',
      trustLabelInfo: {
        id: 'ai_generated',
      },
      certifiedApplicability: expect.objectContaining({
        name: 'food_vs_drink_revenue',
        kind: 'context_only',
      }),
      blockFit: expect.objectContaining({
        kind: 'context_only',
        confidence: 'high',
        missingDimensions: expect.arrayContaining(['product']),
        missingOutputs: expect.arrayContaining(['product_name']),
      }),
    });
    expect(pack.routeDecision.routeReason).toMatch(/product/i);
    expect(pack.routeDecision.exactObjectKey).toBeUndefined();
    expect(pack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain('SHOP.ANALYTICS.order_items');
    const orderItems = pack.allowedSqlContext.relations.find((relation) => relation.relation === 'SHOP.ANALYTICS.order_items');
    const orderItemColumns = orderItems?.columns.map((column) => column.name) ?? [];
    expect(orderItemColumns.indexOf('product_type')).toBeGreaterThanOrEqual(0);
    expect(orderItemColumns.indexOf('product_price')).toBeGreaterThanOrEqual(0);
    expect(orderItemColumns.indexOf('product_type')).toBeLessThan(orderItemColumns.indexOf('category'));
    expect(orderItemColumns.indexOf('product_price')).toBeLessThan(orderItemColumns.indexOf('revenue'));
    expect(pack.retrievalDiagnostics.certifiedCandidateFits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'food_vs_drink_revenue',
          applicabilityKind: 'exact_answer',
          action: 'context_only',
          fit: expect.objectContaining({
            kind: 'context_only',
            missingOutputs: expect.arrayContaining(['product_name']),
            missingDimensions: expect.arrayContaining(['product']),
          }),
        }),
      ]),
    );
	  });

  it('ingests dbt catalog.json columns as complete physical metadata', async () => {
    addJaffleOrderItemsModel(projectRoot);
    const manifestPath = join(projectRoot, 'target', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nodes: Record<string, { columns?: Record<string, unknown> }>;
    };
    delete manifest.nodes['model.nba_analysis.order_items']?.columns?.product_price;
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    writeFileSync(join(projectRoot, 'target', 'catalog.json'), JSON.stringify({
      nodes: {
        'model.nba_analysis.order_items': {
          columns: {
            order_item_id: { name: 'order_item_id', type: 'NUMBER', comment: 'Order item identifier.' },
            product_name: { name: 'product_name', type: 'TEXT', comment: 'Product display name.' },
            product_type: { name: 'product_type', type: 'TEXT', comment: 'Product category.' },
            product_price: { name: 'product_price', type: 'NUMBER', comment: 'Warehouse-resolved product revenue amount.' },
          },
        },
      },
    }), 'utf-8');
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show product revenue by product name',
      limit: 40,
    });

    const orderItems = pack.allowedSqlContext.relations.find((relation) => relation.relation === 'SHOP.ANALYTICS.order_items');
    expect(orderItems).toMatchObject({
      columnCompleteness: 'complete',
      columns: expect.arrayContaining([
        expect.objectContaining({ name: 'product_price', type: 'NUMBER' }),
      ]),
    });
  });

  it('preserves compiler-inferred output contracts for certified block fit', async () => {
    addJaffleOrderItemsModel(projectRoot);
    writeFileSync(
      join(projectRoot, 'blocks', 'product_revenue_inferred_contract.dql'),
      `block "Product Revenue Inferred Contract" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Revenue by product and category from order items."
  tags = ["revenue", "product", "category"]
  grain = "product"
  entities = ["Product"]
  dimensions = ["product", "category"]
  query = """
    SELECT product_name, product_type AS category, SUM(product_price) AS revenue
    FROM order_items
    GROUP BY 1, 2
    ORDER BY revenue DESC
  """
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const catalog = openMetadataCatalog(projectRoot);
    try {
      const object = catalog.getObject('dql:block:Product Revenue Inferred Contract');
      expect((object?.payload?.outputs as Array<{ name: string }> | undefined)?.map((output) => output.name)).toEqual(
        expect.arrayContaining(['product_name', 'category', 'revenue']),
      );
      expect((object?.payload?.outputContract as Array<{ name: string }> | undefined)?.map((output) => output.name)).toEqual(
        expect.arrayContaining(['product_name', 'category', 'revenue']),
      );
    } finally {
      catalog.close();
    }

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show revenue by product with product name, category, and revenue',
      limit: 40,
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'certified',
      exactObjectKey: 'dql:block:Product Revenue Inferred Contract',
      trustLabelInfo: {
        id: 'certified',
      },
      blockFit: expect.objectContaining({
        kind: 'exact',
        confidence: 'high',
        missingOutputs: [],
        missingDimensions: [],
      }),
    });
  });

  it('promotes medium certified block fit only when confirmation accepts it', async () => {
    writeLegacyProductUsageBlock(projectRoot);
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
    let calls = 0;

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show usage by product',
      focusObjectKey: 'dql:block:Legacy Product Usage',
      runtimeSchemaSnapshot: productUsageRuntimeSchema(),
      confirmCertifiedFit: async ({ fit, block }) => {
        calls += 1;
        expect(block.name).toBe('Legacy Product Usage');
        expect(fit).toMatchObject({ kind: 'exact', confidence: 'medium' });
        return { allow: true, confidence: 'high', reason: 'legacy block declares product grain and usage metric' };
      },
    });

    expect(calls).toBe(1);
    expect(pack.routeDecision).toMatchObject({
      route: 'certified',
      exactObjectKey: 'dql:block:Legacy Product Usage',
      blockFit: expect.objectContaining({
        kind: 'exact',
        confidence: 'high',
        reasons: expect.arrayContaining([
          expect.stringContaining('fit confirmation accepted'),
        ]),
      }),
    });
  });

  it('demotes medium certified block fit when confirmation rejects it', async () => {
    writeLegacyProductUsageBlock(projectRoot);
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show usage by product',
      focusObjectKey: 'dql:block:Legacy Product Usage',
      runtimeSchemaSnapshot: productUsageRuntimeSchema(),
      confirmCertifiedFit: async () => ({ allow: false, confidence: 'high', reason: 'missing required output proof' }),
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      reviewStatus: 'draft_ready',
      certifiedApplicability: expect.objectContaining({ kind: 'context_only' }),
      blockFit: expect.objectContaining({
        kind: 'context_only',
        confidence: 'high',
        reasons: expect.arrayContaining([
          expect.stringContaining('fit confirmation rejected'),
        ]),
      }),
    });
    expect(pack.routeDecision.exactObjectKey).toBeUndefined();
  });

  it('keeps medium certified block fit review-required when confirmation fails', async () => {
    writeLegacyProductUsageBlock(projectRoot);
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show usage by product',
      focusObjectKey: 'dql:block:Legacy Product Usage',
      runtimeSchemaSnapshot: productUsageRuntimeSchema(),
      confirmCertifiedFit: async () => {
        throw new Error('provider unavailable');
      },
    });

    expect(pack.routeDecision).toMatchObject({
      route: 'generated_sql',
      reviewStatus: 'draft_ready',
      blockFit: expect.objectContaining({
        kind: 'exact',
        confidence: 'medium',
        reasons: expect.arrayContaining([
          expect.stringContaining('fit confirmation unavailable'),
        ]),
      }),
    });
    expect(pack.routeDecision.exactObjectKey).toBeUndefined();
  });

  it('grain gate: does not demote certified routes for grain-free questions (no regression)', async () => {
    const plan = await planAgentAnswer(projectRoot, {
      question: 'Who were the top scorers?',
      limit: 20,
    });

    expect(plan.routeDecision).toMatchObject({
      route: 'certified',
      exactObjectKey: 'dql:block:Top 10 Goal Scorers',
    });
    // grain gate must be a no-op when the question carries no extractable grain.
    expect(plan.routeDecision.grainGate?.allow).not.toBe(false);
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

  it('preserves prior DQL artifact context for generic previous-result follow-ups', async () => {
    const sourceSql = 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10';
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'can you include product details with previous results and give final',
      followUp: {
        kind: 'generic',
        sourceQuestion: 'give me product and supply info',
        priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        priorResultRef: {
          id: 'turn_supply',
          question: 'give me product and supply info',
          columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
          rowCount: 65,
          sourceSql,
        },
        priorDqlArtifact: {
          kind: 'sql_block',
          name: 'product_supply_breakdown',
          source: `block "product_supply_breakdown" {
  type = "custom"
  query = """${sourceSql}"""
}`,
          orderBy: [{ name: 'supply_cost', direction: 'desc' }],
          limit: 10,
        },
      },
      limit: 20,
    });

    expect(pack.followUp).toMatchObject({
      kind: 'generic',
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
    });
    const followUpObject = pack.objects.find((object) => object.objectKey.startsWith('selected:followup:'));
    expect(followUpObject).toBeDefined();
    expect(followUpObject?.description).toContain('product_supply_breakdown');
    expect(followUpObject?.description).toContain('supply_cost desc');
    expect(followUpObject?.description).toContain('limit 10');
    expect(followUpObject?.payload).toMatchObject({
      priorResultRef: {
        id: 'turn_supply',
        rowCount: 65,
        sourceSql,
      },
      priorDqlArtifact: {
        name: 'product_supply_breakdown',
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
    });
  });

  it('seeds prior context-pack objects for refinements without short-circuiting retrieval', async () => {
    const priorPack = await buildLocalContextPack(projectRoot, {
      question: 'Who scored the least points?',
      limit: 20,
    });

    const refinedPack = await buildLocalContextPack(projectRoot, {
      question: 'same result but only 2024',
      priorContextPackId: priorPack.id,
      conversationTopicRelation: 'refinement',
      limit: 20,
    });

    expect(refinedPack.retrievalDiagnostics.strategy).toBe('sqlite_fts');
    expect(refinedPack.objects.map((row) => row.objectKey)).toEqual(
      expect.arrayContaining([
        'dql:block:Top 10 Goal Scorers',
        'dbt:model:fct_player_performance',
      ]),
    );
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

  it('indexes enterprise-scale dbt models and MetricFlow metrics with bounded retrieval', async () => {
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'nba_ops',
      dbt: { projectDir: '.' },
    }), 'utf-8');
    addNoisyDbtModels(projectRoot, 3998);
    addLargeSemanticManifest(projectRoot, 3000);

    const semanticLayer = resolveSemanticLayerWithDiagnostics({
      provider: 'dbt',
      projectPath: '.',
    }, projectRoot).layer;
    expect(semanticLayer?.listMetrics().length).toBeGreaterThanOrEqual(3000);

    const refresh = await ensureMetadataCatalogFresh(projectRoot, { force: true, semanticLayer });
    expect(refresh.objectCount).toBeGreaterThan(10_000);

    const catalog = openMetadataCatalog(projectRoot);
    try {
      expect(catalog.objectCount()).toBeGreaterThan(10_000);
      expect(catalog.getObject('dbt:model:noisy_3997')).toMatchObject({
        objectType: 'dbt_model',
      });
      expect(catalog.getObject('semantic:metric:enterprise_metrics.enterprise_metric_2999')).toMatchObject({
        objectType: 'semantic_metric',
      });
      expect(catalog.sourceFingerprints().length).toBeGreaterThan(10);
      expect(catalog.domainShards().some((shard) => shard.semanticMetricCount >= 3000)).toBe(true);
    } finally {
      catalog.close();
    }

    const start = Date.now();
    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show enterprise metric 2999 by enterprise segment',
      objectTypes: ['semantic_metric', 'semantic_model', 'dbt_model'],
      limit: 80,
    });
    const elapsed = Date.now() - start;

    expect(pack.objects.length).toBeLessThanOrEqual(80);
    expect(pack.objects.map((object) => object.objectKey)).toContain('semantic:metric:enterprise_metrics.enterprise_metric_2999');
    expect(pack.retrievalDiagnostics.topRejected.length).toBeGreaterThan(0);
    // Keep a meaningful performance bound while allowing normal CI scheduler
    // variance for a 4k-model/3k-metric fixture.
    expect(elapsed).toBeLessThan(4_000);
  }, 60_000);

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
          reason: expect.stringContaining('dbt lineage'),
          source: 'dbt_lineage',
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

  it('balances relation and column budgets so column floods do not evict table context', async () => {
    addColumnFloodModels(projectRoot, 16, 12);

    const pack = await buildLocalContextPack(projectRoot, {
      question: 'Show supply metric by supply stage',
      objectTypes: ['dbt_model', 'dbt_column'],
      limit: 12,
    });

    const selectedSupplyModels = pack.objects.filter((object) =>
      object.objectType === 'dbt_model' && object.name.startsWith('supply_wide_'),
    );
    expect(selectedSupplyModels.length).toBeGreaterThanOrEqual(6);
    expect(pack.retrievalDiagnostics.topRejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: 'dbt_column',
          reason: expect.stringContaining('Outside balanced context window'),
        }),
      ]),
    );
  });

  it('caches schema-shape scans for repeated generated questions on the same catalog fingerprint', async () => {
    addNoisyDbtModels(projectRoot, 80);
    addGenericAthleteBoxScoreModel(projectRoot, 'cache_probe_box_scores');
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const scanSpy = vi.spyOn(MetadataCatalog.prototype, 'scanObjects');
    try {
      await buildLocalContextPack(projectRoot, {
        question: 'Can you research Kevin Durant profile and provide complete stats for cache probe',
        limit: 40,
      });
      const scansAfterFirstPack = scanSpy.mock.calls.length;
      expect(scansAfterFirstPack).toBeGreaterThan(0);

      await buildLocalContextPack(projectRoot, {
        question: 'Can you research Kevin Durant profile and provide complete stats for cache probe',
        limit: 40,
      });
      expect(scanSpy.mock.calls.length).toBe(scansAfterFirstPack);
    } finally {
      scanSpy.mockRestore();
    }
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
    const catalog = openMetadataCatalog(projectRoot);
    try {
      const matches = catalog.searchRuntimeValues(['Stephen Curry']);
      expect(matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: 'NBA_DB.RAW.player_box_scores',
            columnName: 'player_name',
            value: 'Stephen Curry',
          }),
        ]),
      );
      expect(catalog.state('runtime_value_index_count')).toBe('1');
    } finally {
      catalog.close();
    }

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
        expect.objectContaining({
          role: 'value_match',
          name: 'player_name = Stephen Curry',
        }),
      ]),
    );
    const relation = pack.allowedSqlContext.relations.find((item) => item.relation === 'NBA_DB.RAW.player_box_scores');
    expect(relation?.columns.find((column) => column.name === 'player_name')?.sampleValues).toContain('Stephen Curry');
  });

  it('folds an approved, scoped correction hint into a matching Tier-2 context pack (cited)', async () => {
    // No hints yet → backward compatible (empty applied set).
    const before = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 40,
    });
    expect(before.appliedHints).toEqual([]);

    // Record + approve a correction scoped to the nba domain.
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'Show NBA player points by season',
      scope: { domain: 'nba' },
      wrongAnswer: 'SELECT player_name, points FROM fct_player_performance',
      correction: 'Always SUM points and GROUP BY player_name, season for season totals.',
      author: 'analyst@nba.test',
    });

    // Candidate must NOT be applied (approved-only).
    const candidatePack = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 40,
    });
    expect(candidatePack.appliedHints).toEqual([]);

    reviewHint(projectRoot, { hintId: hint.id, decision: 'approved', reviewer: 'lead@nba.test' });

    // In-scope Tier-2 question → hint is applied and cited.
    const matched = await buildLocalContextPack(projectRoot, {
      question: 'Show NBA player points by season',
      limit: 40,
    });
    expect(matched.appliedHints.map((h) => h.hintId)).toContain(hint.id);
    expect(matched.appliedHints[0].guidance).toContain('SUM points');
    expect(matched.appliedHints[0].scopeReason).toContain('domain=nba');
  });
});

describe('block fingerprints', () => {
  it('separates exact SQL copies from parameterized business-shape copies', () => {
    const left = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE season = 2016
      GROUP BY 1
      ORDER BY total_points DESC
      LIMIT 5
    `);
    const right = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE season = 2017
      GROUP BY 1
      ORDER BY total_points DESC
      LIMIT 10
    `);

    expect(left.exact).not.toBe(right.exact);
    expect(left.parameterized).toBe(right.parameterized);
  });

  it('treats different selected-set literal counts as the same parameterized SQL shape', () => {
    const oneTeam = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE team_abbreviation IN ('LAL')
      GROUP BY 1
    `);
    const twoTeams = buildBlockSqlFingerprints(`
      SELECT player_name, SUM(points) AS total_points
      FROM fct_player_performance
      WHERE team_abbreviation IN ('LAL', 'BOS')
      GROUP BY 1
    `);

    expect(oneTeam.exact).not.toBe(twoTeams.exact);
    expect(oneTeam.parameterized).toBe(twoTeams.parameterized);
  });

  it('includes declared dimensions in business-shape fingerprints', () => {
    const bySegment = buildBlockBusinessFingerprint({
      domain: 'revenue',
      pattern: 'ranking',
      grain: 'customer_id',
      outputs: ['customer_id', 'total_revenue'],
      dimensions: ['segment'],
      sources: ['marts.orders'],
    });
    const byRegion = buildBlockBusinessFingerprint({
      domain: 'revenue',
      pattern: 'ranking',
      grain: 'customer_id',
      outputs: ['customer_id', 'total_revenue'],
      dimensions: ['region'],
      sources: ['marts.orders'],
    });

    expect(bySegment.hash).not.toBe(byRegion.hash);
    expect(bySegment.tokens).toContain('dimension:segment');
  });
});

function mkdtempProject(): string {
  return mkdtempSync(join(tmpdir(), 'dql-metadata-catalog-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function addLargeSemanticManifest(root: string, metricCount: number): void {
  const measures = Array.from({ length: metricCount }, (_, index) => ({
    name: `enterprise_measure_${index}`,
    expr: `metric_value_${index}`,
    agg: 'sum',
    description: `Enterprise measure ${index}.`,
  }));
  const metrics = Object.fromEntries(Array.from({ length: metricCount }, (_, index) => [
    `metric.nba_analysis.enterprise_metric_${index}`,
    {
      name: `enterprise_metric_${index}`,
      label: `Enterprise Metric ${index}`,
      description: `Enterprise scale semantic metric ${index}.`,
      type: 'simple',
      type_params: { measure: `enterprise_measure_${index}` },
      tags: ['enterprise', 'scale'],
    },
  ]));
  writeFileSync(join(root, 'target', 'semantic_manifest.json'), JSON.stringify({
    semantic_models: {
      'semantic_model.nba_analysis.enterprise_metrics': {
        name: 'enterprise_metrics',
        model: "ref('fct_enterprise_metric_0')",
        defaults: { agg_time_dimension: 'metric_date' },
        entities: [{ name: 'enterprise_account', type: 'primary', expr: 'account_id' }],
        dimensions: [
          { name: 'enterprise_segment', type: 'categorical', expr: 'segment' },
          { name: 'metric_date', type: 'time', type_params: { time_granularity: 'day' }, expr: 'metric_date' },
        ],
        measures,
      },
    },
    metrics,
    saved_queries: {},
  }), 'utf-8');
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

function addJaffleOrderItemsModel(root: string): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  manifest.nodes['model.nba_analysis.order_items'] = {
    resource_type: 'model',
    name: 'order_items',
    alias: 'order_items',
    database: 'SHOP',
    schema: 'ANALYTICS',
    description: 'Order item rows with product name, product category/type, and product price.',
    depends_on: { nodes: [] },
    tags: ['orders', 'products', 'revenue'],
    original_file_path: 'models/marts/order_items.sql',
    config: { materialized: 'table' },
    columns: {
      order_item_id: {
        name: 'order_item_id',
        data_type: 'number',
        description: 'Order item identifier.',
      },
      product_name: {
        name: 'product_name',
        data_type: 'text',
        description: 'Product display name.',
      },
      product_type: {
        name: 'product_type',
        data_type: 'text',
        description: 'Product category such as food or drink.',
      },
      product_price: {
        name: 'product_price',
        data_type: 'number',
        description: 'Product revenue amount.',
      },
    },
  };
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
}

function addGrainedTeamScoringModel(root: string): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  manifest.nodes['model.nba_analysis.fct_team_scoring'] = {
    resource_type: 'model',
    name: 'fct_team_scoring',
    alias: 'fct_team_scoring',
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Team scoring fact table with total points at team grain.',
    depends_on: { nodes: [] },
    tags: ['nba', 'team', 'points'],
    original_file_path: 'models/marts/fct_team_scoring.sql',
    config: { materialized: 'table' },
    columns: {
      team_name: { name: 'team_name', data_type: 'text', description: 'Team name.' },
      season: { name: 'season', data_type: 'number', description: 'NBA season year.' },
      total_points: { name: 'total_points', data_type: 'number', description: 'Total team points.' },
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

function addColumnFloodModels(root: string, modelCount: number, columnCount: number): void {
  const path = join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  for (let modelIndex = 0; modelIndex < modelCount; modelIndex += 1) {
    const columns: Record<string, Record<string, string>> = {};
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const name = `supply_metric_${modelIndex}_${columnIndex}`;
      columns[name] = {
        name,
        data_type: 'number',
        description: `Supply metric ${columnIndex} for stage analysis.`,
      };
    }
    columns.supply_stage = {
      name: 'supply_stage',
      data_type: 'text',
      description: 'Supply stage dimension.',
    };
    manifest.nodes[`model.nba_analysis.supply_wide_${modelIndex}`] = {
      resource_type: 'model',
      name: `supply_wide_${modelIndex}`,
      alias: `supply_wide_${modelIndex}`,
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: `Supply metric wide table ${modelIndex}.`,
      depends_on: { nodes: [] },
      tags: ['supply', 'metric'],
      original_file_path: `models/supply/supply_wide_${modelIndex}.sql`,
      config: { materialized: 'table' },
      columns,
    };
  }
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

function writeLegacyProductUsageBlock(root: string): void {
  writeFileSync(
    join(root, 'blocks', 'legacy_product_usage.dql'),
    `block "Legacy Product Usage" {
  domain = "product"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Legacy certified usage metric by product."
  tags = ["usage", "product", "metric"]
  grain = "product"
  entities = ["Product"]
  dimensions = ["product"]
}`,
    'utf-8',
  );
}

function productUsageRuntimeSchema() {
  return {
    source: 'test runtime schema',
    tables: [{
      relation: 'APP.ANALYTICS.product_usage',
      schema: 'ANALYTICS',
      name: 'product_usage',
      source: 'runtime',
      columns: [
        { name: 'product_name', type: 'text' },
        { name: 'usage', type: 'number' },
      ],
    }],
  };
}
