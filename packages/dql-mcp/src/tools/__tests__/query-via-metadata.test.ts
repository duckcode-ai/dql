import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveSlug, queryViaMetadata } from '../query-via-metadata.js';
import { makeCtx } from './_helpers.js';

describe('deriveSlug', () => {
  it('drops stopwords + lowercases + snake_cases', () => {
    expect(deriveSlug('How many active customers in Q1?')).toBe('many_active_customers_q1');
  });

  it('produces the same slug on paraphrase that hits the same content tokens', () => {
    const a = deriveSlug('what was monthly revenue last month?');
    const b = deriveSlug('What was last month\'s monthly revenue?');
    // Token sets are: {monthly, revenue, last, month} for both. v1 keeps insertion order.
    expect(a).toContain('monthly_revenue');
    expect(b).toContain('monthly_revenue');
  });

  it('falls back to a sentinel for empty / pure-stopword inputs', () => {
    expect(deriveSlug('   the of  ')).toBe('untitled_proposal');
  });

  it('truncates very long questions', () => {
    const question = 'how many distinct customer ids placed at least one order ' +
      'each calendar month last year by region and channel and product type';
    expect(deriveSlug(question).length).toBeLessThanOrEqual(60);
  });
});

describe('queryViaMetadata — Tier-2 promotion loop entry point', () => {
  let tmpProject: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'dql-tier2-'));
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpProject, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function ctxFor(root: string) {
    return makeCtx({}, { projectRoot: root } as never);
  }

  it('executes the proposed SQL and surfaces uncertified=true on the happy path', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { columns: [{ name: 'n', type: 'integer' }], rows: [{ n: 42 }], executionTime: 5 },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'How many active customers last month?',
      proposedSql: 'SELECT COUNT(DISTINCT customer_id) AS n FROM fct_orders',
      proposedDomain: 'customer',
      proposedEntity: 'Customer',
      upstreamRefs: ['fct_orders'],
    });

    expect(result.uncertified).toBe(true);
    expect((result as { reviewStatus: string }).reviewStatus).toBe('draft_ready');
    expect((result as { trustStatus: { uncertified: boolean } }).trustStatus.uncertified).toBe(true);
    expect((result as { evidence: { planner: { mode: string; steps: string[] } } }).evidence.planner.mode).toBe('metadata_text_to_sql');
    expect((result as { evidence: { planner: { steps: string[] } } }).evidence.planner.steps).toContain('trust check');
    expect((result as { rowCount: number }).rowCount).toBe(1);
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(call[1].body));
    expect(body.cell.source).toContain('SELECT * FROM (');
    expect(body.cell.source).toContain('LIMIT 200');
    expect(result.draftBlock?.path).toMatch(/blocks\/_drafts\/.*\.dql$/);
    expect(result.draftBlock?.proposedContractId).toBe(
      'customer.Customer.many_active_customers_last_month',
    );
    expect(result.promote).toContain('dql certify --from-draft');
  });

  it('writes a draft .dql file with status=draft and the proposal metadata', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'What was monthly revenue last quarter?',
      proposedSql: 'SELECT 1',
      proposedDomain: 'finance',
      proposedEntity: 'Order',
    });

    const draftPath = join(tmpProject, out.draftBlock!.path);
    const content = readFileSync(draftPath, 'utf-8');
    expect(content).toContain('status = "draft"');
    expect(content).toContain('asked_times = 1');
    expect(content).toContain('proposed_contract_id = "finance.Order.monthly_revenue_last_quarter"');
    expect(content).toContain('What was monthly revenue last quarter?');
  });

  it('increments asked_times when the same question is asked again (dedupe via slug)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const ctx = ctxFor(tmpProject);
    const first = await queryViaMetadata(ctx, {
      question: 'how many active customers?',
      proposedSql: 'SELECT 1',
    });
    const second = await queryViaMetadata(ctx, {
      question: 'how many active customers?',
      proposedSql: 'SELECT 1',
    });
    expect(first.draftBlock?.askedTimes).toBe(1);
    expect(second.draftBlock?.askedTimes).toBe(2);

    const draftPath = join(tmpProject, second.draftBlock!.path);
    expect(readFileSync(draftPath, 'utf-8')).toContain('asked_times = 2');
  });

  it('skips the draft when saveDraft=false (one-off introspection)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'just curious',
      proposedSql: 'SELECT 1',
      saveDraft: false,
    });
    expect(out.draftBlock).toBeUndefined();
  });

  it('returns the proposal without executing when dryRun=true', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'how many?',
      proposedSql: 'SELECT 99',
      dryRun: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.uncertified).toBe(true);
    expect((out as { proposedSql: string }).proposedSql).toBe('SELECT 99');
    expect((out as { trustStatus: { label: string; reviewStatus: string } }).trustStatus.label).toBe('AI-generated metadata research');
    expect((out as { evidence: { execution: { status: string } } }).evidence.execution.status).toBe('dry_run');
    expect(out.draftBlock).toBeDefined();
  });

  it('returns selected relation reasoning when planning from metadata', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show NBA player points by season',
    });

    expect(out.uncertified).toBe(true);
    expect((out as { planningOnly: boolean }).planningOnly).toBe(true);
    expect((out as { selectedRelations: Array<{ relation: string; reason: string; columns: string[] }> }).selectedRelations[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
    });
    expect((out as { selectedRelations: Array<{ relation: string; reason: string; columns: string[] }> }).selectedRelations[0]?.reason).toMatch(/metric terms matched|dimension terms matched|relation shape/);
    expect((out as { selectedRelations: Array<{ relation: string; reason: string; columns: string[] }> }).selectedRelations[0]?.columns).toEqual(
      expect.arrayContaining(['player_name', 'season', 'total_points']),
    );
    expect((out as {
      evidence: {
        certifiedContext: {
          selectedRelations: Array<{ relation: string; reason: string; rank: number }>;
          selectedJoinPaths: Array<{ leftRelation: string; leftColumn: string; rightRelation: string; rightColumn: string }>;
        };
      };
    }).evidence.certifiedContext.selectedRelations[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
      rank: 1,
    });
  });

  it('returns selected join paths when planning needs related dbt models', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Show NBA player points by position',
    });

    expect(out.uncertified).toBe(true);
    expect((out as { planningOnly: boolean }).planningOnly).toBe(true);
    expect((out as {
      selectedJoinPaths: Array<{ leftRelation: string; leftColumn: string; rightRelation: string; rightColumn: string }>;
    }).selectedJoinPaths[0]).toMatchObject({
      leftRelation: expect.stringContaining('fct_player_performance'),
      leftColumn: 'player_id',
      rightRelation: expect.stringContaining('dim_players'),
      rightColumn: 'player_id',
    });
    expect((out as {
      evidence: {
        certifiedContext: {
          selectedJoinPaths: Array<{ leftColumn: string; rightColumn: string }>;
        };
      };
    }).evidence.certifiedContext.selectedJoinPaths[0]).toMatchObject({
      leftColumn: 'player_id',
      rightColumn: 'player_id',
    });
  });

  it('returns schema-shape candidates when planning over catalog-only dbt models', async () => {
    seedLargeDbtProfileProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Can you research Kevin Durant profile and provide complete stats',
    });

    expect(out.uncertified).toBe(true);
    expect((out as { planningOnly: boolean }).planningOnly).toBe(true);
    expect((out as {
      schemaShapeCandidates: Array<{ objectKey: string; relation: string; reason: string; columns: string[] }>;
    }).schemaShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dbt:model:athlete_box_scores',
          relation: 'NBA_DB.ANALYTICS.athlete_box_scores',
          reason: expect.stringContaining('entity identifiers: athlete_name'),
          columns: expect.arrayContaining(['athlete_name', 'game_date', 'pts']),
        }),
      ]),
    );
    expect((out as {
      evidence: {
        certifiedContext: {
          schemaShapeCandidates: Array<{ objectKey: string; relation: string }>;
        };
      };
    }).evidence.certifiedContext.schemaShapeCandidates[0]).toMatchObject({
      objectKey: 'dbt:model:athlete_box_scores',
      relation: 'NBA_DB.ANALYTICS.athlete_box_scores',
    });
  });

  it('carries selected relation reasoning through dry-run evidence', async () => {
    seedNbaMetadataProject(tmpProject);

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'Who scored least points?',
      proposedSql: 'SELECT player_name, season, total_points FROM NBA_DB.ANALYTICS.fct_player_performance ORDER BY total_points ASC LIMIT 10',
      dryRun: true,
    });

    expect((out as { reviewStatus: string }).reviewStatus).toBe('draft_ready');
    expect((out as {
      evidence: {
        certifiedContext: {
          selectedRelations: Array<{ relation: string; reason: string; columns: string[] }>;
        };
      };
    }).evidence.certifiedContext.selectedRelations[0]).toMatchObject({
      relation: expect.stringContaining('fct_player_performance'),
      columns: expect.arrayContaining(['player_name', 'season', 'total_points']),
    });
  });

  it('reports a clear runtime-down error and still saves the draft for later', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'how many active customers?',
      proposedSql: 'SELECT 1',
    });
    expect((out as { error: string }).error).toMatch(/Could not reach DQL runtime/);
    expect(out.draftBlock).toBeDefined();
  });

  it('honors the limit parameter on returned rows', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { columns: [], rows: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }], executionTime: 1 },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'sample',
      proposedSql: 'SELECT 1',
      limit: 2,
    });
    expect((out as { rows: unknown[] }).rows).toHaveLength(2);
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(call[1].body));
    expect(body.cell.source).toContain('LIMIT 2');
  });

  it('rejects unsafe SQL before execution or draft capture', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'delete bad data',
      proposedSql: 'DELETE FROM orders',
    });
    expect(out.uncertified).toBe(true);
    expect((out as { reviewStatus: string }).reviewStatus).toBe('rejected');
    expect((out as { error: string }).error).toContain('read-only SELECT or WITH');
    expect(out.draftBlock).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(tmpProject, 'blocks', '_drafts'))).toBe(false);
  });
});

function seedNbaMetadataProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'nba_ops' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'top_10_scorers.dql'),
    `block "Top 10 Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top NBA players by total points scored."
  tags = ["nba", "player", "points", "scoring"]
  llmContext = "Use for top scorers. For bottom rankings, use this as context only."
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
          depends_on: { nodes: ['model.nba_analysis.dim_players'] },
          tags: ['nba', 'player'],
          original_file_path: 'models/marts/fct_player_performance.sql',
          config: { materialized: 'table' },
          columns: {
            player_id: {
              name: 'player_id',
              data_type: 'text',
              description: 'Player identifier for joining to player attributes.',
            },
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
        'model.nba_analysis.dim_players': {
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
        },
      },
      sources: {},
    }),
    'utf-8',
  );
}

function seedLargeDbtProfileProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'large_dbt_profile' }), 'utf-8');
  mkdirSync(join(root, 'target'), { recursive: true });
  const nodes: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < 220; index += 1) {
    nodes[`model.large_dbt_profile.noisy_${index}`] = {
      resource_type: 'model',
      name: `noisy_${index}`,
      alias: `noisy_${index}`,
      database: 'NBA_DB',
      schema: 'ANALYTICS',
      description: `Unrelated model ${index} in a large dbt repo.`,
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
  nodes['model.large_dbt_profile.athlete_box_scores'] = {
    resource_type: 'model',
    name: 'athlete_box_scores',
    alias: 'athlete_box_scores',
    database: 'NBA_DB',
    schema: 'ANALYTICS',
    description: 'Box score rows at game grain for each athlete.',
    depends_on: { nodes: [] },
    tags: ['profile', 'stats'],
    original_file_path: 'models/marts/athlete_box_scores.sql',
    config: { materialized: 'table' },
    columns: {
      athlete_name: {
        name: 'athlete_name',
        data_type: 'text',
        description: 'Name of the athlete.',
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
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'large_dbt_profile' },
      nodes,
      sources: {},
    }),
    'utf-8',
  );
}
