import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentValueProbeSql,
  applyDashboardFiltersToBlockExecution,
  buildAgentPreviewSql,
  buildAgentSchemaContext,
  buildDbtStatus,
  buildProposeReadiness,
  buildSemanticLayerDiagnostics,
  createBlockArtifacts,
  createDqlGenerationSessionForProject,
  createSemanticBuilderBlock,
  discoverDbtProfileConnections,
  evaluateBlockInvariants,
  extractAgentValueSearchTerms,
  extractBlockInvariants,
  formatLocalQueryRuntimeError,
  getConnectorInstallStatuses,
  loadProjectConfig,
  normalizeProjectConnection,
  openBlockStudioDocument,
  parseBlockSourceMetadata,
  prepareLocalExecution,
  dashboardRuntimeVariables,
  resolveDefaultLLMProvider,
  resolveDbtMacrosForExecution,
  resolveProjectRelativeSqlPaths,
  saveBlockStudioArtifacts,
  saveBlockStudioDraftArtifacts,
  setBlockStudioStatus,
  serializeJSON,
  validateBlockStudioSource,
  validateConnectionForTest,
} from './local-runtime.js';
import { Certifier, ENTERPRISE_RULES } from '@duckcodeailabs/dql-governance';
import {
  getActiveProvider,
  providerSettingsPath,
  saveProviderSettings,
} from './settings/provider-settings.js';
import { afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import type { DatabaseConnector, QueryResult } from '@duckcodeailabs/dql-connectors';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatLocalQueryRuntimeError', () => {
  it('explains missing DuckDB native bindings with actionable guidance', () => {
    const message = formatLocalQueryRuntimeError(
      { driver: 'file', filepath: ':memory:' },
      new Error("Cannot find module '/tmp/duckdb/lib/binding/duckdb.node'"),
    );

    expect(message).toContain('DuckDB native bindings could not be loaded');
    expect(message).toContain(`Current Node.js runtime: ${process.versions.node}`);
    expect(message).toContain('Node 18, 20, or 22');
    expect(message).toContain('pnpm install');
  });
});

describe('serializeJSON', () => {
  it('serializes safe bigint values as numbers', () => {
    expect(serializeJSON({ revenue: 42n })).toBe('{"revenue":42}');
  });

  it('serializes unsafe bigint values as strings', () => {
    const value = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(serializeJSON({ revenue: value })).toBe(`{"revenue":"${value.toString()}"}`);
  });
});

describe('AI provider settings', () => {
  it('makes saved OpenAI settings the active default instead of falling through to Ollama', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-provider-openai-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-test-openai',
      model: 'gpt-test',
    });

    expect(getActiveProvider(projectRoot)).toBe('openai');
    expect(resolveDefaultLLMProvider(projectRoot)).toBe('openai');
    expect(readFileSync(providerSettingsPath(projectRoot), 'utf-8')).toContain('"activeProvider": "openai"');
  });

  it('keeps an enabled but incomplete OpenAI setup active so chat shows an OpenAI error', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-provider-openai-missing-key-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
    });

    expect(getActiveProvider(projectRoot)).toBe('openai');
    expect(resolveDefaultLLMProvider(projectRoot)).toBe('openai');
  });

  it('clears the active default when that provider is disabled', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-provider-disable-'));
    tempDirs.push(projectRoot);

    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-test-openai',
    });
    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: false,
    });

    expect(getActiveProvider(projectRoot)).toBeUndefined();
    expect(resolveDefaultLLMProvider(projectRoot)).toBe('ollama');
  });

  it('normalizes structured AI metadata arrays during SQL import', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-structured-arrays-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'terms'), { recursive: true });
    writeFileSync(join(projectRoot, 'terms', 'player_points.dql'), `
term "Player Points" {
  domain = "nba"
  type = "metric"
  status = "certified"
  description = "Total NBA points scored by a player."
  owner = "analytics"
}
`, 'utf-8');
    saveProviderSettings(projectRoot, {
      id: 'openai',
      enabled: true,
      apiKey: 'sk-test-openai',
      model: 'gpt-test',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            name: 'NBA Player Points',
            description: 'Ranks NBA players by total points. Review required.',
            tags: [{ value: 'nba' }, { name: 'scoring' }],
            terms: [{ name: 'Player Points' }, { name: 'Invented Term' }],
            entities: [{ name: 'Player' }],
            outputs: [{ name: 'player_name' }, { field: 'total_points' }],
            dimensions: [{ column: 'team_name' }],
            sourceSystems: [{ name: 'TRANSFORMED' }],
            reviewCadence: 'quarterly',
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'upload',
      sourceKind: 'raw-sql',
      sources: [{
        path: 'top_players.sql',
        content: 'SELECT player_name, SUM(pts) AS total_points FROM TRANSFORMED.int_player_stats GROUP BY player_name LIMIT 5;',
      }],
      domain: 'nba',
      owner: 'analytics',
      provider: 'openai',
    });

    const candidate = session.candidates[0];
    expect(candidate.generationMode).toBe('ai');
    expect(candidate.dqlSource).not.toContain('[object Object]');
    expect(candidate.dqlSource).toContain('entities = ["Player"]');
    expect(candidate.dqlSource).toContain('outputs = ["player_name", "total_points"]');
    expect(candidate.terms).toEqual(['Player Points']);
    expect(candidate.dqlSource).toContain('terms = ["Player Points"]');
    expect(candidate.dqlSource).not.toContain('Invented Term');
    expect(candidate.dqlSource).toContain('dimensions = ["team_name"]');
    expect(candidate.dqlSource).toContain('sourceSystems = ["TRANSFORMED"]');
    expect(candidate.reviewCadence).toBe('quarterly');
    expect(candidate.dqlSource).toContain('reviewCadence = "quarterly"');
  });

  it('keeps deterministic AI import local and infers ranking after parameterization', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-import-deterministic-ranking-'));
    tempDirs.push(projectRoot);

    const session = await createDqlGenerationSessionForProject(projectRoot, {
      inputMode: 'upload',
      sourceKind: 'raw-sql',
      sources: [{
        path: 'top_players.sql',
        content: `
SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) IN (2016, 2017)
GROUP BY player_name
ORDER BY total_points DESC
LIMIT 5;
`,
      }],
      domain: 'transformed',
      owner: 'analytics',
      provider: 'none',
    });

    const candidate = session.candidates[0];
    expect(session.generation.provider).toBe('local-deterministic');
    expect(session.generation.aiEnabled).toBe(false);
    expect(session.generation.warnings).toEqual([]);
    expect(candidate.pattern).toBe('ranking');
    expect(candidate.entities).toEqual(['Player']);
    expect(candidate.reviewCadence).toBe('monthly');
    expect(candidate.parameterPolicy).toEqual(expect.arrayContaining([
      { name: 'season_start', policy: 'dynamic' },
      { name: 'season_end', policy: 'dynamic' },
      { name: 'top_n', policy: 'dynamic' },
    ]));
    expect(candidate.dqlSource).toContain('pattern = "ranking"');
    expect(candidate.dqlSource).toContain('entities = ["Player"]');
    expect(candidate.dqlSource).toContain('reviewCadence = "monthly"');
    expect(candidate.dqlSource).toContain('LIMIT ${top_n}');
  });

  it('preserves dynamic parameter metadata for enterprise certification', () => {
    const source = `
block "Top Players" {
    status = "draft"
    domain = "transformed"
    type = "custom"
    description = "Ranks NBA players by total points across a configurable season range."
    tags = ["nba", "ranking"]
    owner = "analytics"
    pattern = "ranking"
    grain = "player_name"
    entities = ["Player"]
    outputs = ["player_name", "total_points", "games_played"]
    dimensions = ["player_name"]
    allowedFilters = ["season_start", "season_end", "top_n"]
    parameterPolicy {
        season_start = "dynamic"
        season_end = "dynamic"
        top_n = "dynamic"
    }
    filterBindings {
        season_start = "game_date_est"
        season_end = "game_date_est"
        top_n = "limit"
    }
    sourceSystems = ["TRANSFORMED"]
    reviewCadence = "monthly"

    query = """
SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points, COUNT(DISTINCT details_game_id) AS games_played
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN \${season_start} AND \${season_end}
GROUP BY player_name
ORDER BY total_points DESC
LIMIT \${top_n}
    """

    tests {
        assert_row_count > 0
    }
}`;

    const parsed = parseBlockSourceMetadata(source);

    expect(parsed.dimensions).toEqual(['player_name']);
    expect(parsed.parameterPolicy).toEqual([
      { name: 'season_start', policy: 'dynamic' },
      { name: 'season_end', policy: 'dynamic' },
      { name: 'top_n', policy: 'dynamic' },
    ]);
    expect(parsed.filterBindings).toEqual([
      { filter: 'season_start', binding: 'game_date_est' },
      { filter: 'season_end', binding: 'game_date_est' },
      { filter: 'top_n', binding: 'limit' },
    ]);

    const result = new Certifier(ENTERPRISE_RULES).evaluate({
      id: parsed.name,
      name: parsed.name,
      domain: parsed.domain,
      type: parsed.blockType,
      version: '0.0.0',
      status: 'draft',
      gitRepo: '',
      gitPath: 'domains/transformed/blocks/_drafts/top-players.dql',
      gitCommitSha: '',
      description: parsed.description,
      owner: parsed.owner,
      tags: parsed.tags,
      pattern: parsed.pattern,
      grain: parsed.grain,
      entities: parsed.entities,
      declaredOutputs: parsed.outputs,
      dimensions: parsed.dimensions,
      allowedFilters: parsed.allowedFilters,
      parameterPolicy: parsed.parameterPolicy,
      filterBindings: parsed.filterBindings,
      sourceSystems: parsed.sourceSystems,
      replacementFor: parsed.replacementFor,
      reviewCadence: parsed.reviewCadence,
      dependencies: [],
      usedInCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, {
      passed: 1,
      failed: 0,
      skipped: 0,
      duration: 0,
      assertions: [{ name: 'assert_row_count > 0', passed: true }],
      runAt: new Date(),
    });

    expect(result.errors).toEqual([]);
    expect(result.certified).toBe(true);
  });
});

describe('resolveProjectRelativeSqlPaths', () => {
  it('rewrites notebook sample file paths relative to the selected project', () => {
    const sql = "SELECT * FROM read_csv_auto('./data/revenue.csv')";
    const resolved = resolveProjectRelativeSqlPaths(sql, '/tmp/demo-project');

    expect(resolved).toBe("SELECT * FROM read_csv_auto('/tmp/demo-project/data/revenue.csv')");
  });

  it('leaves unrelated string literals untouched', () => {
    const sql = "SELECT './data/revenue.csv' AS label";
    expect(resolveProjectRelativeSqlPaths(sql, '/tmp/demo-project')).toBe(sql);
  });
});

describe('normalizeProjectConnection', () => {
  it('resolves relative local database paths against the project root', () => {
    expect(normalizeProjectConnection(
      { driver: 'duckdb', filepath: './local/dev.duckdb' },
      '/tmp/demo-project',
    )).toEqual({
      driver: 'duckdb',
      filepath: '/tmp/demo-project/local/dev.duckdb',
      moduleSearchPaths: [
        '/tmp/demo-project/.dql/connectors',
        '/tmp/demo-project',
      ],
    });
  });

  it('expands environment placeholders when the value is available', () => {
    const previous = process.env.DQL_TEST_DATABASE;
    process.env.DQL_TEST_DATABASE = 'analytics';
    try {
      expect(normalizeProjectConnection(
        { driver: 'postgresql', host: 'localhost', database: '${DQL_TEST_DATABASE}', username: 'dql' },
        '/tmp/demo-project',
      )).toEqual({ driver: 'postgresql', host: 'localhost', database: 'analytics', username: 'dql' });
    } finally {
      if (previous === undefined) delete process.env.DQL_TEST_DATABASE;
      else process.env.DQL_TEST_DATABASE = previous;
    }
  });
});

describe('getConnectorInstallStatuses', () => {
  it('reports optional connector packages and built-in Databricks support', () => {
    const statuses = getConnectorInstallStatuses('/tmp/demo-project');

    expect(statuses.find((status) => status.driver === 'duckdb')).toMatchObject({
      packageName: 'duckdb',
      packageSpec: 'duckdb@^1.1.0',
      builtIn: false,
      installPath: '/tmp/demo-project/.dql/connectors',
    });
    expect(statuses.find((status) => status.driver === 'snowflake')).toMatchObject({
      packageName: 'snowflake-sdk',
      packageSpec: 'snowflake-sdk@^1.12.0',
      builtIn: false,
    });
    expect(statuses.find((status) => status.driver === 'databricks')).toMatchObject({
      builtIn: true,
      installed: true,
    });
  });
});

describe('loadProjectConfig', () => {
  it('uses the configured named Snowflake connection for execution', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-config-default-name-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      defaultConnectionName: 'warehouse',
      connections: {
        default: { driver: 'duckdb', filepath: ':memory:' },
        warehouse: {
          driver: 'snowflake',
          account: 'acme',
          username: 'analyst',
          database: 'analytics',
          warehouse: 'compute_wh',
          schema: 'public',
        },
      },
    }), 'utf-8');

    const config = loadProjectConfig(projectRoot);

    expect(config.defaultConnectionName).toBe('warehouse');
    expect(config.defaultConnection).toMatchObject({
      driver: 'snowflake',
      account: 'acme',
      database: 'analytics',
    });
  });

  it('auto-promotes the only real connection over an in-memory starter DuckDB placeholder', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-config-auto-default-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      connections: {
        default: { driver: 'duckdb', filepath: ':memory:' },
        snowflake: {
          driver: 'snowflake',
          account: 'acme',
          username: 'analyst',
          database: 'analytics',
          warehouse: 'compute_wh',
        },
      },
    }), 'utf-8');

    const config = loadProjectConfig(projectRoot);

    expect(config.defaultConnectionName).toBe('snowflake');
    expect(config.defaultConnection?.driver).toBe('snowflake');
  });

  it('keeps a detected DuckDB file as default when it is a real project connection', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-config-real-duckdb-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      connections: {
        default: { driver: 'duckdb', filepath: 'jaffle_shop.duckdb' },
        snowflake: {
          driver: 'snowflake',
          account: 'acme',
          username: 'analyst',
          database: 'analytics',
          warehouse: 'compute_wh',
        },
      },
    }), 'utf-8');

    const config = loadProjectConfig(projectRoot);

    expect(config.defaultConnectionName).toBe('default');
    expect(config.defaultConnection).toMatchObject({
      driver: 'duckdb',
      filepath: 'jaffle_shop.duckdb',
    });
  });
});

describe('discoverDbtProfileConnections', () => {
  it('maps only lightweight-supported dbt profiles.yml targets into DQL connection drafts', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-profiles-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: banking\nprofile: banking\n', 'utf-8');
    writeFileSync(join(projectRoot, 'profiles.yml'), [
      'banking:',
      '  target: dev',
      '  outputs:',
      '    dev:',
      '      type: postgres',
      '      host: "{{ env_var(\'PGHOST\', \'localhost\') }}"',
      '      port: 5432',
      '      dbname: analytics',
      '      schema: marts',
      '      user: analyst',
      '      password: "{{ env_var(\'PGPASSWORD\') }}"',
      '    local:',
      '      type: duckdb',
      '      path: banking.duckdb',
    ].join('\n'), 'utf-8');

    const profilePath = join(projectRoot, 'profiles.yml');
    const candidates = discoverDbtProfileConnections(projectRoot, {});
    const candidate = candidates.find((item) => item.path === profilePath && item.profileName === 'banking' && item.targetName === 'local');

    expect(candidate).toBeDefined();
    expect(candidate?.connection).toMatchObject({
      driver: 'duckdb',
      filepath: 'banking.duckdb',
    });
    expect(candidate?.warnings).toContain('Not the default dbt target "dev".');
    expect(candidates.some((item) => item.adapter === 'postgres')).toBe(false);
  });

  it('maps Snowflake dbt key-pair profiles from inline keys and key files', () => {
    const previousPrivateKey = process.env.SNOWFLAKE_PRIVATE_KEY;
    const previousPrivateKeyPath = process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
    const previousPrivateKeyPassphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
    delete process.env.SNOWFLAKE_PRIVATE_KEY;
    delete process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
    delete process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;

    try {
      const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-snowflake-profiles-'));
      tempDirs.push(projectRoot);
      writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: analytics\nprofile: analytics\n', 'utf-8');
      writeFileSync(join(projectRoot, 'profiles.yml'), [
        'analytics:',
        '  target: inline',
        '  outputs:',
        '    inline:',
        '      type: snowflake',
        '      account: xy12345.us-east-1',
        '      warehouse: ANALYTICS_WH',
        '      database: PROD',
        '      schema: MARTS',
        '      user: svc_dql',
        '      role: ANALYST',
        '      private_key: "{{ env_var(\'SNOWFLAKE_PRIVATE_KEY\') }}"',
        '      private_key_passphrase: "{{ env_var(\'SNOWFLAKE_PRIVATE_KEY_PASSPHRASE\', \'\') }}"',
        '    keyfile:',
        '      type: snowflake',
        '      account: xy12345.us-east-1',
        '      warehouse: ANALYTICS_WH',
        '      database: PROD',
        '      schema: MARTS',
        '      user: svc_dql',
        '      role: ANALYST',
        '      authenticator: SNOWFLAKE_JWT',
        '      private_key_path: "{{ env_var(\'SNOWFLAKE_PRIVATE_KEY_PATH\') }}"',
      ].join('\n'), 'utf-8');

      const candidates = discoverDbtProfileConnections(projectRoot, {});
      const inline = candidates.find((item) => item.profileName === 'analytics' && item.targetName === 'inline');
      const keyfile = candidates.find((item) => item.profileName === 'analytics' && item.targetName === 'keyfile');

      expect(inline?.connection).toMatchObject({
        driver: 'snowflake',
        account: 'xy12345.us-east-1',
        warehouse: 'ANALYTICS_WH',
        database: 'PROD',
        schema: 'MARTS',
        username: 'svc_dql',
        role: 'ANALYST',
        privateKey: '${SNOWFLAKE_PRIVATE_KEY}',
        authMethod: 'key_pair',
      });
      expect(inline?.missingFields).toContain('env:SNOWFLAKE_PRIVATE_KEY');
      expect(inline?.missingFields).not.toContain('privateKeyPath');

      expect(keyfile?.connection).toMatchObject({
        driver: 'snowflake',
        privateKeyPath: '${SNOWFLAKE_PRIVATE_KEY_PATH}',
        authenticator: 'SNOWFLAKE_JWT',
        authMethod: 'key_pair',
      });
      expect(keyfile?.missingFields).toContain('env:SNOWFLAKE_PRIVATE_KEY_PATH');
      expect(keyfile?.missingFields).not.toContain('privateKeyPath');
      expect(keyfile?.warnings).toContain('Not the default dbt target "inline".');
    } finally {
      if (previousPrivateKey === undefined) delete process.env.SNOWFLAKE_PRIVATE_KEY;
      else process.env.SNOWFLAKE_PRIVATE_KEY = previousPrivateKey;
      if (previousPrivateKeyPath === undefined) delete process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
      else process.env.SNOWFLAKE_PRIVATE_KEY_PATH = previousPrivateKeyPath;
      if (previousPrivateKeyPassphrase === undefined) delete process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
      else process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE = previousPrivateKeyPassphrase;
    }
  });

  it('maps enterprise Snowflake and Databricks dbt profile options', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-enterprise-profiles-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: analytics\nprofile: analytics\n', 'utf-8');
    writeFileSync(join(projectRoot, 'profiles.yml'), [
      'analytics:',
      '  target: snowflake_prod',
      '  outputs:',
      '    snowflake_prod:',
      '      type: snowflake',
      '      account: xy12345.us-east-1',
      '      warehouse: ANALYTICS_WH',
      '      database: PROD',
      '      schema: MARTS',
      '      user: svc_dql',
      '      authenticator: PROGRAMMATIC_ACCESS_TOKEN',
      '      token: "{{ env_var(\'SNOWFLAKE_PAT\') }}"',
      '      query_tag: team=analytics;app=dql',
      '      proxy_host: proxy.internal',
      '      proxy_port: 8080',
      '    databricks_prod:',
      '      type: databricks',
      '      host: adb-123.4.azuredatabricks.net',
      '      http_path: /sql/1.0/warehouses/9196548d010cf14d',
      '      catalog: main',
      '      schema: marts',
      '      auth_type: oauth',
      '      token: "{{ env_var(\'DATABRICKS_TOKEN\') }}"',
      '      wait_timeout: 50s',
      '      byte_limit: 1000000',
    ].join('\n'), 'utf-8');

    const candidates = discoverDbtProfileConnections(projectRoot, {});
    const snowflake = candidates.find((item) => item.targetName === 'snowflake_prod');
    const databricks = candidates.find((item) => item.targetName === 'databricks_prod');

    expect(snowflake?.connection).toMatchObject({
      driver: 'snowflake',
      authMethod: 'programmatic_access_token',
      token: '${SNOWFLAKE_PAT}',
      queryTag: 'team=analytics;app=dql',
      proxyHost: 'proxy.internal',
      proxyPort: 8080,
    });
    expect(snowflake?.missingFields).toContain('env:SNOWFLAKE_PAT');
    expect(snowflake?.missingFields).not.toContain('password');

    expect(databricks?.connection).toMatchObject({
      driver: 'databricks',
      host: 'adb-123.4.azuredatabricks.net',
      httpPath: '/sql/1.0/warehouses/9196548d010cf14d',
      catalog: 'main',
      authMethod: 'oauth',
      token: '${DATABRICKS_TOKEN}',
      waitTimeout: '50s',
      byteLimit: 1000000,
    });
    expect(databricks?.missingFields).toContain('env:DATABRICKS_TOKEN');
    expect(databricks?.missingFields).not.toContain('httpPath');
  });
});

describe('prepareLocalExecution', () => {
  it('fills block parameters from dashboard filters before execution', () => {
    const variables = dashboardRuntimeVariables(
      {
        filters: [
          { id: 'season_range', type: 'daterange', default: [2016, 2017] },
        ],
      },
      { top_n: 5 },
    );
    const applied = applyDashboardFiltersToBlockExecution({
      sql: 'SELECT player_name, total_points FROM player_points WHERE season BETWEEN $1 AND $2 LIMIT $3',
      sqlParams: [
        { name: 'season_start', position: 1 },
        { name: 'season_end', position: 2 },
        { name: 'top_n', position: 3 },
      ],
      variables,
      block: {
        name: 'Top Players',
        parameterPolicy: [
          { name: 'season_start', policy: 'dynamic' },
          { name: 'season_end', policy: 'dynamic' },
          { name: 'top_n', policy: 'dynamic' },
        ],
      },
      dashboard: {
        filters: [
          { id: 'season_range', type: 'daterange', default: [2016, 2017] },
        ],
      },
    });

    expect(applied.sql).toBe('SELECT player_name, total_points FROM player_points WHERE season BETWEEN $1 AND $2 LIMIT $3');
    expect(applied.sqlParams).toHaveLength(3);
    expect(applied.variables).toMatchObject({
      season_start: 2016,
      season_end: 2017,
      top_n: 5,
    });
    expect(applied.appliedFilters).toEqual([
      {
        filter: 'season_range',
        mode: 'parameter',
        paramNames: ['season_start', 'season_end'],
      },
    ]);
  });

  it('wraps block SQL with safe dashboard predicates from filter bindings', () => {
    const applied = applyDashboardFiltersToBlockExecution({
      sql: 'SELECT region, SUM(revenue) AS revenue FROM marts.orders GROUP BY 1',
      sqlParams: [],
      variables: { region: ['East', 'West'] },
      block: {
        name: 'Revenue By Region',
        allowedFilters: ['region'],
        filterBindings: [{ filter: 'region', binding: 'region' }],
      },
      dashboard: {
        filters: [{ id: 'region', type: 'select' }],
      },
    });

    expect(applied.sql).toBe('SELECT * FROM (SELECT region, SUM(revenue) AS revenue FROM marts.orders GROUP BY 1) _dql_filter WHERE _dql_filter.region IN ($1, $2)');
    expect(applied.sqlParams).toEqual([
      { name: '__dashboard_filter_region_value_1', position: 1 },
      { name: '__dashboard_filter_region_value_2', position: 2 },
    ]);
    expect(applied.variables).toMatchObject({
      __dashboard_filter_region_value_1: 'East',
      __dashboard_filter_region_value_2: 'West',
    });
    expect(applied.appliedFilters[0]).toMatchObject({
      filter: 'region',
      binding: 'region',
      mode: 'predicate',
    });
  });

  it('rewrites SQL paths for file-backed notebook queries', () => {
    const prepared = prepareLocalExecution(
      "SELECT * FROM read_csv_auto('./data/revenue.csv')",
      { driver: 'file', filepath: ':memory:' },
      '/tmp/demo-project',
      { dataDir: './data' },
    );

    expect(prepared.connection).toEqual({
      driver: 'file',
      filepath: ':memory:',
      moduleSearchPaths: [
        '/tmp/demo-project/.dql/connectors',
        '/tmp/demo-project',
      ],
    });
    expect(prepared.sql).toBe("SELECT * FROM read_csv_auto('/tmp/demo-project/data/revenue.csv')");
  });

  it('resolves dbt ref macros from a parent project manifest before Snowflake execution', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-ref-parent-'));
    tempDirs.push(repoRoot);
    const projectRoot = join(repoRoot, 'dql');
    const targetDir = join(repoRoot, 'target');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      nodes: {
        'model.nba_analysis.fct_player_performance': {
          resource_type: 'model',
          name: 'fct_player_performance',
          alias: 'fct_player_performance',
          database: 'NBA_GAMES',
          schema: 'RAW',
          relation_name: 'NBA_GAMES.RAW.FCT_PLAYER_PERFORMANCE',
        },
      },
      sources: {},
    }), 'utf-8');

    const prepared = prepareLocalExecution(
      "SELECT * FROM {{ ref('fct_player_performance') }} LIMIT 10",
      { driver: 'snowflake', account: 'test', username: 'user', warehouse: 'WH', database: 'NBA_GAMES', schema: 'RAW' },
      projectRoot,
      {},
    );

    expect(prepared.sql).toBe('SELECT * FROM NBA_GAMES.RAW.FCT_PLAYER_PERFORMANCE LIMIT 10');
  });

  it('resolves dbt source macros from configured dbt project metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-source-config-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: nba_analysis\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      nodes: {},
      sources: {
        'source.nba_analysis.raw.games': {
          source_name: 'raw',
          name: 'games',
          identifier: 'GAMES',
          database: 'NBA_GAMES',
          schema: 'RAW',
          relation_name: 'NBA_GAMES.RAW.GAMES',
        },
      },
    }), 'utf-8');

    expect(resolveDbtMacrosForExecution(
      "SELECT * FROM {{ source('raw', 'games') }}",
      projectRoot,
      { dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' } },
    )).toBe('SELECT * FROM NBA_GAMES.RAW.GAMES');
  });

  it('fails fast with a clear message when dbt macros cannot be resolved', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-ref-missing-'));
    tempDirs.push(projectRoot);

    expect(() => resolveDbtMacrosForExecution(
      "SELECT * FROM {{ ref('missing_model') }}",
      projectRoot,
      {},
    )).toThrow(/target\/manifest\.json was not available/);
  });
});

describe('buildAgentPreviewSql', () => {
  it('wraps read-only generated SQL in a bounded preview', () => {
    expect(buildAgentPreviewSql('SELECT status, COUNT(*) AS n FROM orders GROUP BY status;')).toBe(
      'SELECT * FROM (\nSELECT status, COUNT(*) AS n FROM orders GROUP BY status\n) AS dql_agent_preview LIMIT 200',
    );
  });

  it('rejects generated SQL that is not a single read-only statement', () => {
    expect(() => buildAgentPreviewSql('SELECT 1; DROP TABLE orders')).toThrow('one statement');
    expect(() => buildAgentPreviewSql('DELETE FROM orders')).toThrow('read-only SELECT or WITH');
  });
});

describe('validateConnectionForTest', () => {
  function result(rows: Record<string, unknown>[]): QueryResult {
    return {
      columns: [],
      rows,
      rowCount: rows.length,
      executionTimeMs: 1,
    };
  }

  function fakeSnowflakeConnector(
    execute: (sql: string) => Promise<QueryResult>,
  ): DatabaseConnector {
    return {
      driverName: 'snowflake',
      connect: async () => {},
      disconnect: async () => {},
      ping: async () => true,
      execute,
    };
  }

  it('rejects a Snowflake warehouse that is visible but suspended', async () => {
    const executed: string[] = [];
    const connector = fakeSnowflakeConnector(async (sql) => {
      executed.push(sql);
      if (sql.startsWith('SHOW WAREHOUSES')) {
        return result([{ name: 'ANALYTICS_WH', state: 'SUSPENDED' }]);
      }
      throw new Error('context query should not run while warehouse is suspended');
    });

    const validation = await validateConnectionForTest(connector, {
      driver: 'snowflake',
      account: 'acct',
      username: 'analyst',
      password: 'wrong-or-right',
      database: 'PROD',
      schema: 'MARTS',
      warehouse: 'ANALYTICS_WH',
    });

    expect(validation.ok).toBe(false);
    expect(validation.message).toContain('SUSPENDED');
    expect(executed.some((sql) => sql.includes('CURRENT_ACCOUNT'))).toBe(false);
  });

  it('validates a running Snowflake warehouse with current context', async () => {
    const connector = fakeSnowflakeConnector(async (sql) => {
      if (sql.startsWith('SHOW WAREHOUSES')) {
        return result([{ name: 'ANALYTICS_WH', state: 'STARTED' }]);
      }
      if (sql.includes('CURRENT_ACCOUNT')) {
        return result([{
          ACCOUNT_NAME: 'ACME',
          USER_NAME: 'ANALYST',
          ROLE_NAME: 'ANALYST_ROLE',
          DATABASE_NAME: 'PROD',
          SCHEMA_NAME: 'MARTS',
          WAREHOUSE_NAME: 'ANALYTICS_WH',
        }]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const validation = await validateConnectionForTest(connector, {
      driver: 'snowflake',
      account: 'acct',
      username: 'analyst',
      password: 'secret',
      database: 'PROD',
      schema: 'MARTS',
      warehouse: 'ANALYTICS_WH',
    });

    expect(validation.ok).toBe(true);
    expect(validation.message).toContain('Connected to Snowflake as ANALYST');
    expect(validation.details?.warehouseState).toBe('STARTED');
  });
});

describe('buildAgentSchemaContext', () => {
  it('keeps likely entity tables for value-led single-customer questions', () => {
    const rows = [
      { table_schema: 'dev', table_name: 'customers', column_name: 'customer_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'customers', column_name: 'customer_name', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'orders', column_name: 'order_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'orders', column_name: 'customer_id', data_type: 'VARCHAR' },
      { table_schema: 'dev', table_name: 'orders', column_name: 'order_total', data_type: 'DECIMAL' },
      { table_schema: 'dev', table_name: 'inventory', column_name: 'sku', data_type: 'VARCHAR' },
    ];

    const context = buildAgentSchemaContext('What did Matthew Meyer order?', rows);

    expect(context.map((table) => table.relation)).toEqual(
      expect.arrayContaining(['dev.customers', 'dev.orders']),
    );
    expect(context.find((table) => table.relation === 'dev.customers')?.columns.map((column) => column.name)).toEqual([
      'customer_id',
      'customer_name',
    ]);
  });
});

describe('extractAgentValueSearchTerms', () => {
  it('extracts names, quoted values, and emails for bounded value search', () => {
    expect(extractAgentValueSearchTerms('What is revenue for customer Matthew Meyer?')).toContain('Matthew Meyer');
    expect(extractAgentValueSearchTerms('Show orders for "Acme West"')).toContain('Acme West');
    expect(extractAgentValueSearchTerms('Usage for jane@example.com')).toContain('jane@example.com');
    expect(extractAgentValueSearchTerms('What is revenue for customer matthew meyer last month?')).toContain('matthew meyer');
    expect(extractAgentValueSearchTerms('What is revenue for customer matthew meyer last month?')).not.toContain('customer matthew meyer last month');
    expect(extractAgentValueSearchTerms('Break that down by segment for Enterprise last week')).toContain('Enterprise');
  });
});

describe('buildAgentValueProbeSql', () => {
  it('uses a one-character LIKE escape for DuckDB/file runtime probes', () => {
    const sql = buildAgentValueProbeSql(
      {
        relation: 'main.revenue',
        schema: 'main',
        name: 'revenue',
        source: 'runtime information_schema',
        columns: [{ name: 'segment', type: 'VARCHAR' }],
      },
      'segment',
      ['Enterprise'],
      { driver: 'file', filepath: ':memory:' },
    );

    expect(sql).toContain("LIKE '%enterprise%' ESCAPE '\\'");
    expect(sql).not.toContain("ESCAPE '\\\\'");
  });
});

describe('semantic block save artifacts', () => {
  it('autosaves generated blocks under draft paths without promoting to canonical blocks', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-draft-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const firstPath = saveBlockStudioDraftArtifacts(projectRoot, {
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Draft revenue block',
      owner: 'analytics',
      tags: ['ai-generated'],
      source: 'block "Revenue Draft" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 1\n  """\n}',
      stableSuffix: 'cand123',
    });
    const secondPath = saveBlockStudioDraftArtifacts(projectRoot, {
      currentPath: firstPath,
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Draft revenue block',
      source: 'block "Revenue Draft" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 2\n  """\n}',
      stableSuffix: 'cand123',
    });

    expect(firstPath).toBe('blocks/_drafts/finance/revenue-draft-cand123.dql');
    expect(secondPath).toBe(firstPath);
    expect(readFileSync(join(projectRoot, firstPath), 'utf-8')).toContain('select 2');
    expect(() => readFileSync(join(projectRoot, 'blocks/finance/revenue-draft.dql'), 'utf-8')).toThrow();
  });

  it('promotes domain-first drafts into the domain block folder and removes stale draft artifacts', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-promote-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    writeFileSync(join(projectRoot, 'domains', 'finance', 'domain.dql'), 'domain "Finance" {\n  owner = "analytics"\n}\n');

    const draftPath = saveBlockStudioDraftArtifacts(projectRoot, {
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Draft revenue block',
      owner: 'analytics',
      tags: ['finance'],
      source: 'block "Revenue Draft" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 1\n  """\n}',
      stableSuffix: 'cand123',
    });

    expect(draftPath).toBe('domains/finance/blocks/_drafts/revenue-draft-cand123.dql');
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'blocks', '_drafts', 'finance', 'revenue-draft-cand123.yaml'), 'utf-8')).toContain('domain: _drafts/finance');

    const canonicalPath = saveBlockStudioArtifacts(projectRoot, {
      currentPath: draftPath,
      name: 'Revenue Draft',
      domain: 'finance',
      description: 'Certified revenue block',
      owner: 'analytics',
      tags: ['finance'],
      source: 'block "Revenue Draft" {\n  status = "certified"\n  domain = "finance"\n  type = "custom"\n  query = """\nselect 2\n  """\n}',
    });

    expect(canonicalPath).toBe('domains/finance/blocks/revenue-draft.dql');
    expect(readFileSync(join(projectRoot, canonicalPath), 'utf-8')).toContain('select 2');
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'blocks', 'finance', 'revenue-draft.yaml'), 'utf-8')).toContain('domain: finance');
    expect(() => readFileSync(join(projectRoot, draftPath), 'utf-8')).toThrow();
    expect(() => readFileSync(join(projectRoot, 'semantic-layer', 'blocks', '_drafts', 'finance', 'revenue-draft-cand123.yaml'), 'utf-8')).toThrow();
  });

  it('opens and updates status for domain-first block paths', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-status-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const blockPath = saveBlockStudioArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      description: 'Finance revenue summary',
      owner: 'analytics',
      tags: ['finance'],
      source: 'block "Revenue Summary" {\n  status = "draft"\n  domain = "finance"\n  type = "custom"\n  description = "Finance revenue summary"\n  owner = "analytics"\n  tags = ["finance"]\n  query = """\nselect 1\n  """\n}\n',
    });

    expect(blockPath).toBe('domains/finance/blocks/revenue-summary.dql');
    const opened = openBlockStudioDocument(projectRoot, blockPath);
    expect(opened.metadata.domain).toBe('finance');
    expect(opened.companionPath).toBe('semantic-layer/blocks/finance/revenue-summary.yaml');

    setBlockStudioStatus(projectRoot, blockPath, 'review');

    expect(readFileSync(join(projectRoot, blockPath), 'utf-8')).toContain('status = "review"');
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'blocks', 'finance', 'revenue-summary.yaml'), 'utf-8')).toContain('reviewStatus: review');
    expect(openBlockStudioDocument(projectRoot, blockPath).metadata.reviewStatus).toBe('review');
  });

  it('writes both the block file and semantic companion metadata for save-from-cell flows', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createBlockArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      content: 'SELECT @metric(total_revenue), @dim(order_date);',
      description: 'Finance summary block',
      tags: ['finance', 'exec'],
    });

    expect(created.path).toBe('blocks/finance/revenue-summary.dql');
    expect(created.companionPath).toBe('semantic-layer/blocks/finance/revenue-summary.yaml');
    expect(readFileSync(join(projectRoot, created.path), 'utf-8')).toContain('@metric(total_revenue)');

    const companion = readFileSync(join(projectRoot, created.companionPath), 'utf-8');
    expect(companion).toContain('provider: dql');
    expect(companion).toContain('semanticMetrics:');
    expect(companion).toContain('  - total_revenue');
    expect(companion).toContain('semanticDimensions:');
    expect(companion).toContain('  - order_date');
    expect(companion).toContain('reviewStatus: draft');
  });

  it('writes manual block artifacts under domains/<domain>/blocks when the domain exists', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-block-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const created = createBlockArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      content: 'SELECT @metric(total_revenue), @dim(order_date);',
      description: 'Finance summary block',
      owner: 'finance-analytics',
      tags: ['finance', 'exec'],
    });

    expect(created.path).toBe('domains/finance/blocks/revenue-summary.dql');
    expect(() => readFileSync(join(projectRoot, 'blocks', 'finance', 'revenue-summary.dql'), 'utf-8')).toThrow();
    expect(readFileSync(join(projectRoot, created.path), 'utf-8')).toContain('@metric(total_revenue)');
    expect(readFileSync(join(projectRoot, created.companionPath), 'utf-8')).toContain('domain: finance');
  });

  it('writes semantic builder blocks with lineage companion metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-builder-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createSemanticBuilderBlock(projectRoot, {
      name: 'Executive Revenue',
      domain: 'finance',
      description: 'Executive revenue cut',
      owner: 'finance-analytics',
      tags: ['finance'],
      metrics: ['total_revenue'],
      dimensions: ['sales_channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      chart: 'line',
      blockType: 'semantic',
      sql: 'SELECT 1',
      tables: ['analytics.orders'],
      provider: 'dbt',
    });

    expect(created.path).toBe('blocks/finance/executive-revenue.dql');
    expect(created.content).toContain('type = "semantic"');
    expect(created.content).toContain('metric = "total_revenue"');

    const companion = readFileSync(join(projectRoot, created.companionPath), 'utf-8');
    expect(companion).toContain('provider: dbt');
    expect(companion).toContain('lineage:');
    expect(companion).toContain('analytics.orders');
    expect(companion).toContain('semanticMetrics:');
    expect(companion).toContain('  - total_revenue');
    expect(companion).toContain('semanticDimensions:');
    expect(companion).toContain('  - sales_channel');
    expect(companion).toContain('  - order_date');
  });

  it('writes semantic builder blocks under the domain-first block folder when the domain exists', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-first-builder-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const created = createSemanticBuilderBlock(projectRoot, {
      name: 'Executive Revenue',
      domain: 'finance',
      description: 'Executive revenue cut',
      owner: 'finance-analytics',
      tags: ['finance'],
      metrics: ['total_revenue'],
      dimensions: ['sales_channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      chart: 'line',
      blockType: 'semantic',
      sql: 'SELECT 1',
      tables: ['analytics.orders'],
      provider: 'dbt',
    });

    expect(created.path).toBe('domains/finance/blocks/executive-revenue.dql');
    expect(() => readFileSync(join(projectRoot, 'blocks', 'finance', 'executive-revenue.dql'), 'utf-8')).toThrow();
    expect(readFileSync(join(projectRoot, created.path), 'utf-8')).toContain('metric = "total_revenue"');
    expect(readFileSync(join(projectRoot, created.companionPath), 'utf-8')).toContain('provider: dbt');
  });

  it('writes a blank semantic block when created from the Semantic Block path', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-blank-semantic-block-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createBlockArtifacts(projectRoot, {
      name: 'Approval Rate',
      domain: 'cards',
      blockType: 'semantic',
      owner: 'cards-analytics',
      description: 'Semantic metric starter',
      tags: ['cards'],
    });

    expect(created.path).toBe('blocks/cards/approval-rate.dql');
    expect(created.content).toContain('type = "semantic"');
    expect(created.content).toContain('metric = ""');
    expect(created.content).toContain('dimensions = []');
    expect(created.content).not.toContain('query = """');
  });
});

describe('buildDbtStatus', () => {
  it('reports configured dbt artifacts and counts for the Block Studio start page', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-status-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: banking\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'banking', generated_at: '2026-04-30T12:00:00Z' },
      nodes: {
        'model.banking.fct_cards': { resource_type: 'model' },
        'test.banking.not_null': { resource_type: 'test' },
      },
      sources: {
        'source.banking.raw.cards': {},
      },
    }), 'utf-8');
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      metadata: { generated_at: '2026-04-30T12:01:00Z' },
      metrics: [{ name: 'approval_rate' }],
      semantic_models: [{ name: 'cards' }],
      saved_queries: [{ name: 'daily_cards' }],
    }), 'utf-8');

    const status = buildDbtStatus(projectRoot, {
      semanticLayer: { provider: 'dbt', projectPath: './dbt' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    }, '2026-04-30T12:02:00Z');

    expect(status.configured).toBe(true);
    expect(status.projectName).toBe('banking');
    expect(status.artifacts.manifest.exists).toBe(true);
    expect(status.artifacts.semanticManifest.exists).toBe(true);
    expect(status.counts.models).toBe(1);
    expect(status.counts.sources).toBe(1);
    expect(status.counts.metrics).toBe(1);
    expect(status.counts.semanticModels).toBe(1);
    expect(status.counts.savedQueries).toBe(1);
    expect(status.lastSyncTime).toBe('2026-04-30T12:02:00Z');
    expect(status.setupHint).toContain('dbt artifacts are ready');
  });

  it('counts object-shaped dbt semantic artifacts and reports actionable diagnostics', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-diagnostics-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: banking\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'banking', generated_at: '2026-04-30T12:00:00Z' },
      nodes: {
        'model.banking.fct_cards': { resource_type: 'model' },
      },
      sources: {},
      metrics: {
        'metric.banking.approval_rate': { name: 'approval_rate' },
      },
      semantic_models: {
        'semantic_model.banking.cards': { name: 'cards' },
      },
    }), 'utf-8');
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      metadata: { generated_at: '2026-04-30T12:01:00Z' },
      metrics: {
        'metric.banking.approval_rate': { name: 'approval_rate' },
      },
      semantic_models: {
        'semantic_model.banking.cards': { name: 'cards' },
      },
      saved_queries: {
        'saved_query.banking.daily_cards': { name: 'daily_cards' },
      },
    }), 'utf-8');

    const projectConfig = {
      semanticLayer: { provider: 'dbt' as const, projectPath: './dbt' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    };
    const status = buildDbtStatus(projectRoot, projectConfig, null);
    const diagnostics = buildSemanticLayerDiagnostics(projectRoot, projectConfig, {
      semanticLayer: new SemanticLayer(),
      semanticConfig: projectConfig.semanticLayer,
      lastSyncTime: null,
    });

    expect(status.counts.metrics).toBe(1);
    expect(status.counts.semanticModels).toBe(1);
    expect(status.counts.savedQueries).toBe(1);
    expect(diagnostics.sourceOfTruth).toContain('dbt MetricFlow');
    expect(diagnostics.issues.map((issue) => issue.code)).not.toContain('metricflow_semantic_manifest_missing');
  });

  it('diagnoses missing MetricFlow semantic manifest separately from dbt model metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-missing-semantic-manifest-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: banking\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'banking' },
      nodes: {
        'model.banking.fct_cards': { resource_type: 'model' },
      },
      sources: {},
    }), 'utf-8');

    const diagnostics = buildSemanticLayerDiagnostics(projectRoot, {
      semanticLayer: { provider: 'dbt', projectPath: './dbt' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    }, {
      semanticLayer: new SemanticLayer(),
      semanticConfig: { provider: 'dbt', projectPath: './dbt' },
      lastSyncTime: null,
    });

    expect(diagnostics.dbt.artifacts.manifest.exists).toBe(true);
    expect(diagnostics.dbt.artifacts.semanticManifest.exists).toBe(false);
    expect(diagnostics.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'metricflow_semantic_manifest_missing',
          path: expect.stringContaining('semantic_manifest.json'),
        }),
      ]),
    );
    expect(diagnostics.warnings.join('\n')).toContain('dbt MetricFlow semantic_manifest.json is missing');
  });

  it('surfaces empty MetricFlow artifacts even when local DQL semantic layer is active', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-empty-semantic-manifest-'));
    tempDirs.push(projectRoot);
    const dbtRoot = join(projectRoot, 'dbt');
    const targetDir = join(dbtRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: nba_analysis\nversion: 1.0\n', 'utf-8');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'nba_analysis' },
      nodes: {
        'model.nba_analysis.int_player_stats': { resource_type: 'model' },
      },
      sources: {},
    }), 'utf-8');
    writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify({
      semantic_models: [],
      metrics: [],
      saved_queries: [],
    }), 'utf-8');

    const projectConfig = {
      semanticLayer: { provider: 'dql' as const, path: 'semantic-layer' },
      dbt: { projectDir: './dbt', manifestPath: 'target/manifest.json' },
    };
    const status = buildDbtStatus(projectRoot, projectConfig, null);
    const diagnostics = buildSemanticLayerDiagnostics(projectRoot, projectConfig, {
      semanticLayer: new SemanticLayer({
        metrics: [{ name: 'draft_block_metric', label: 'Draft block metric', description: '', domain: 'business', sql: 'count(*)', type: 'count', table: 'blocks' }],
        dimensions: [],
        hierarchies: [],
        segments: [],
        preAggregations: [],
        measures: [],
        entities: [],
        semanticModels: [],
        savedQueries: [],
      }),
      semanticConfig: projectConfig.semanticLayer,
      lastSyncTime: null,
    });

    expect(status.counts.models).toBe(1);
    expect(status.counts.metrics).toBe(0);
    expect(status.setupHint).toContain('MetricFlow semantic_manifest.json is empty');
    expect(diagnostics.provider).toBe('dql');
    expect(diagnostics.counts.metrics).toBe(1);
    expect(diagnostics.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'metricflow_semantic_manifest_empty',
          path: expect.stringContaining('semantic_manifest.json'),
        }),
      ]),
    );
  });
});

describe('validateBlockStudioSource', () => {
  const semanticLayer = new SemanticLayer({
    metrics: [
      {
        name: 'total_revenue',
        label: 'Total Revenue',
        description: 'Revenue metric',
        domain: 'finance',
        sql: 'SUM(revenue)',
        type: 'sum',
        table: 'orders',
        tags: [],
      },
    ],
    dimensions: [
      {
        name: 'customer_type',
        label: 'Customer Type',
        description: 'Customer type dimension',
        domain: 'finance',
        sql: 'customer_type',
        type: 'string',
        table: 'orders',
        tags: [],
      },
    ],
    hierarchies: [],
  });

  it('composes executable SQL for semantic blocks with metric and dimensions', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  metric = "total_revenue"
  dimensions = ["customer_type"]
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(true);
    expect(validation.executableSql).toContain('SUM(revenue) AS total_revenue');
    expect(validation.executableSql).toContain('customer_type AS customer_type');
    expect(validation.executableSql).toContain('GROUP BY customer_type');
  });

  it('returns an actionable diagnostic when a semantic block is missing a metric', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  dimensions = ["customer_type"]
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.executableSql).toBeNull();
    expect(validation.diagnostics.some((item) => item.code === 'semantic_metric_missing')).toBe(true);
  });

  it('returns a semantic validation error for unknown dimensions', () => {
    const source = `block "Revenue by Type" {
  domain = "finance"
  type = "semantic"
  description = ""
  owner = ""
  tags = []
  metric = "total_revenue"
  dimensions = ["missing_dimension"]
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((item) => item.code === 'semantic_ref' && item.message.includes('missing_dimension'))).toBe(true);
  });

  it('keeps custom block validation behavior unchanged', () => {
    const source = `block "Custom Revenue" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT revenue
FROM orders
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(true);
    expect(validation.executableSql).toContain('SELECT revenue');
  });

  it('rejects non-read-only custom block SQL before save or certification', () => {
    const source = `block "Unsafe Revenue" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
DELETE FROM orders
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((item) => item.code === 'sql_read_only')).toBe(true);
  });

  it('resolves semantic refs inside custom block SQL before execution', () => {
    const source = `block "Revenue Query" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT
  @metric(total_revenue),
  @dim(customer_type)
FROM orders
GROUP BY @dim(customer_type)
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(true);
    expect(validation.executableSql).toContain('SUM(revenue) AS total_revenue');
    expect(validation.executableSql).toContain('customer_type AS customer_type');
    expect(validation.executableSql).toContain('GROUP BY customer_type');
  });

  it('returns a semantic validation error for unresolved refs in custom SQL', () => {
    const source = `block "Broken Revenue Query" {
  domain = "finance"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT @metric(missing_metric)
"""
}`;

    const validation = validateBlockStudioSource(source, semanticLayer);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((item) => item.code === 'semantic_ref' && item.message.includes('missing_metric'))).toBe(true);
  });
});

describe('block invariant evaluation (run-time wiring)', () => {
  const blockWithInvariants = `block "Approval Rate" {
  domain = "ops"
  type = "custom"
  description = "Approval rate."
  owner = "ops@example.com"
  query = """SELECT 1"""
  invariants = ["approval_rate_pct <= 100", "arr >= 0"]
}`;

  it('extracts declared invariants from block source', () => {
    expect(extractBlockInvariants(blockWithInvariants)).toEqual([
      'approval_rate_pct <= 100',
      'arr >= 0',
    ]);
  });

  it('returns an empty array for a block with no invariants', () => {
    const source = `block "Plain" {
  domain = "ops"
  type = "custom"
  description = ""
  owner = ""
  query = """SELECT 1"""
}`;
    expect(extractBlockInvariants(source)).toEqual([]);
  });

  it('returns null for blocks without invariants so the run output is unchanged', () => {
    const source = `block "Plain" {
  domain = "ops"
  type = "custom"
  description = ""
  owner = ""
  query = """SELECT 1"""
}`;
    expect(evaluateBlockInvariants(source, { columns: ['x'], rows: [{ x: 1 }] })).toBeNull();
  });

  it('passes when the result honors every invariant', () => {
    const out = evaluateBlockInvariants(blockWithInvariants, {
      columns: ['approval_rate_pct', 'arr'],
      rows: [{ approval_rate_pct: 80, arr: 1000 }],
    });
    expect(out).not.toBeNull();
    expect(out!.invariantViolation).toBe(false);
    expect(out!.invariantResults.every((entry) => entry.passed)).toBe(true);
  });

  it('flags a violation when the result breaks an invariant', () => {
    const out = evaluateBlockInvariants(blockWithInvariants, {
      columns: ['approval_rate_pct', 'arr'],
      rows: [{ approval_rate_pct: 137, arr: 1000 }],
    });
    expect(out!.invariantViolation).toBe(true);
    expect(out!.invariantResults.find((entry) => entry.expr === 'approval_rate_pct <= 100')?.passed).toBe(false);
  });
});

describe('buildProposeReadiness (/api/propose handler core)', () => {
  // Minimal synthetic dbt manifest at <projectRoot>/target/manifest.json so the
  // readiness handler resolves it via the same lookup the local runtime uses.
  function writeManifest(projectRoot: string): void {
    const targetDir = join(projectRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'jaffle_shop' },
      nodes: {
        'model.jaffle_shop.stg_orders': {
          resource_type: 'model',
          name: 'stg_orders',
          schema: 'staging',
          database: 'analytics',
          description: '',
          original_file_path: 'models/staging/stg_orders.sql',
          config: { materialized: 'view' },
          tags: [],
          depends_on: { nodes: ['source.jaffle_shop.raw.orders'] },
          columns: { order_id: { name: 'order_id' } },
          meta: {},
        },
        'model.jaffle_shop.dim_customers': {
          resource_type: 'model',
          name: 'dim_customers',
          schema: 'marts',
          database: 'analytics',
          description: 'One row per customer with lifetime attributes.',
          original_file_path: 'models/marts/dim_customers.sql',
          config: { materialized: 'table' },
          tags: ['core'],
          depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
          columns: {
            customer_id: { name: 'customer_id', description: 'Customer surrogate key.' },
            customer_name: { name: 'customer_name' },
          },
          meta: {},
        },
        'model.jaffle_shop.fct_orders': {
          resource_type: 'model',
          name: 'fct_orders',
          schema: 'marts',
          database: 'analytics',
          description: 'Order-grain fact with amounts.',
          original_file_path: 'models/marts/fct_orders.sql',
          config: { materialized: 'table' },
          tags: ['core'],
          depends_on: { nodes: ['model.jaffle_shop.stg_orders', 'model.jaffle_shop.dim_customers'] },
          columns: {
            order_id: { name: 'order_id' },
            order_date: { name: 'order_date' },
            amount: { name: 'amount' },
          },
          meta: {},
        },
      },
      sources: {
        'source.jaffle_shop.raw.orders': {
          name: 'orders',
          identifier: 'orders',
          schema: 'raw',
          database: 'analytics',
          tags: [],
        },
      },
    }), 'utf-8');
  }

  it('returns a not-ready readiness result when no dbt manifest is present', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-readiness-empty-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');

    const result = buildProposeReadiness(projectRoot);

    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/dbt manifest/i);
    expect(result.proposals).toEqual([]);
    expect(result.summary.modelsScanned).toBe(0);
    expect(result.summary.proposalsRanked).toBe(0);
  });

  it('returns ranked DRAFT proposals with stored certifier verdicts (nothing certified)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-readiness-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    writeManifest(projectRoot);

    const result = buildProposeReadiness(projectRoot, undefined, { owner: 'me@example.com' });

    expect(result.ready).toBe(true);
    expect(result.summary.projectName).toBe('jaffle_shop');
    expect(result.summary.modelsScanned).toBe(3);
    expect(result.summary.proposalsRanked).toBe(3);
    expect(result.proposals).toHaveLength(3);

    // Every proposal is a DRAFT and carries a Certifier verdict; none certified.
    for (const proposal of result.proposals) {
      expect(proposal.certification.certified).toBe(false);
      expect(Array.isArray(proposal.certification.errors)).toBe(true);
      expect(Array.isArray(proposal.certification.warnings)).toBe(true);
    }

    // Ranked: scores are non-increasing across the queue.
    const scores = result.proposals.map((p) => p.ranking.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // Summary aggregates mirror the per-proposal certifier counts.
    const blocking = result.proposals.reduce((sum, p) => sum + p.certification.errors.length, 0);
    const warnings = result.proposals.reduce((sum, p) => sum + p.certification.warnings.length, 0);
    expect(result.summary.blockingTotal).toBe(blocking);
    expect(result.summary.warningTotal).toBe(warnings);
    expect(result.summary.readyForReview).toBe(
      result.proposals.filter((p) => p.certification.errors.length === 0).length,
    );
  });

  it('does not write any draft files (dryRun preview only)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-readiness-dryrun-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    writeManifest(projectRoot);

    buildProposeReadiness(projectRoot);

    // The readiness preview must never mutate the project with draft blocks.
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(false);
  });
});
