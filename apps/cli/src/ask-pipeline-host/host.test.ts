import { describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@duckcodeailabs/dql-agent';
import type { ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { buildVocabularyIndex, classifyWarehouseError, createAgentRunBudget, parseIntent, physicalRelationBinding, type AnalyticalIntentV1 } from '@duckcodeailabs/dql-agent';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { missingFieldWords, relationsWithColumnWords, columnProbeBudgetMs, columnsForPhysicalEntry, connectionKey, physicalRelationName, relationColumnsProbeSql, relationDatabases, relationsFromProbeRows, relevantRelationsForQuestion, snowflakeShowColumnsRows, underAskedNames, coverageEvaluations, createAskPipelineRouteExecutor, explainOutOfScope, explainOutOfScopeWords, gapPresentation, groundIntentLiterals, knownMissingRelation, memberCandidatesSql, normalizeExecutedRow, prepareBlockForAsk, recordRelationEvidence, resetRelationEvidence, runtimeSchemaForVocabulary, tracedProbes, vocabularyViewKey } from './host.js';

function scripted(replies: string[]): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return {
    name: 'ollama',
    calls,
    available: async () => true,
    generate: async (messages) => { calls.push(messages); return replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''; },
  };
}

const conversation = JSON.stringify({
  version: 1, kind: 'conversation', reading: 'A greeting.', reply: 'Hello! Ask me about the governed data.',
  measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
});
const analytics = JSON.stringify({
  version: 1, kind: 'analytics', reading: 'Total revenue.', measures: [{ ref: 'metric:order_item.revenue' }],
  groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' }, expectedShape: 'scalar',
});

function executorFor(provider: AgentProvider, manifest: unknown) {
  return createAskPipelineRouteExecutor({
    projectRoot: '/tmp/none',
    executor: {} as QueryExecutor,
    resolveConnection: async () => { throw new Error('No database connection is configured yet. Open Connections, add a warehouse or local DuckDB/file connection, then retry.'); },
    getSemanticLayer: () => undefined,
    getManifest: () => ({ manifest: manifest as never, snapshotId: 'snapshot:test' }),
    selectProvider: async () => provider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
}

const run = (executor: ReturnType<typeof createAskPipelineRouteExecutor>, question: string) => executor({
  runId: 'run-1', request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
});

describe('a ref outside the envelope is explained as out of scope, never as nonexistent (Codex E02)', () => {
  const inventory = buildVocabularyIndex({
    relations: [
      { schema: 'TRANSFORMED', name: 'team_directory', columns: [{ name: 'team_id', dataType: 'INTEGER' }, { name: 'city', dataType: 'VARCHAR' }], domain: 'nba.games', domains: ['nba.games'] },
      { schema: 'TRANSFORMED', name: 'player_game_facts', columns: [{ name: 'points', dataType: 'INTEGER' }], domain: 'nba.performance', domains: ['nba.performance'] },
    ],
  });
  const problems = [{ path: 'display[0]', message: 'column:TRANSFORMED.team_directory.city is not in the vocabulary' }];
  it('names the owning domain, the scope that lacks it and what admits it — and nothing of its data', () => {
    const explained = explainOutOfScope(problems, inventory, { activeDomain: 'nba.performance', purpose: undefined })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('owned by nba.games');
    expect(explained.message).toContain('the nba.performance scope (no purpose given)');
    expect(explained.message).toContain('purpose whose import carries it');
    expect(explained.message).toContain('Nothing outside the scope was read');
    expect(explainOutOfScope(problems, inventory, { activeDomain: 'nba.performance', purpose: 'player_team_reporting' })!.message).toContain('for purpose player_team_reporting');
  });
  it('a word of the question or of the gap that names an object another domain owns is explained the same way; words in scope are not', () => {
    const scoped = buildVocabularyIndex({ relations: [{ schema: 'TRANSFORMED', name: 'player_game_facts', columns: [{ name: 'points', dataType: 'INTEGER' }], domain: 'nba.performance' }] });
    const explained = explainOutOfScopeWords('show the top five team cities by total player points; no city label or dimension is defined for it', inventory, scoped, { activeDomain: 'nba.performance' })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('"city" (column:TRANSFORMED.team_directory.city, owned by nba.games)');
    expect(explained.message).toContain('not in the nba.performance scope (no purpose given)');
    expect(explainOutOfScopeWords('total player points by team', inventory, scoped, { activeDomain: 'nba.performance' })).toBeUndefined();
  });
  it('a word of the question or of the gap that names an object another domain owns is explained the same way; words in scope are not', () => {
    const scoped = buildVocabularyIndex({ relations: [{ schema: 'TRANSFORMED', name: 'player_game_facts', columns: [{ name: 'points', dataType: 'INTEGER' }], domain: 'nba.performance' }] });
    const explained = explainOutOfScopeWords('show the top five team cities by total player points; no city label or dimension is defined for it', inventory, scoped, { activeDomain: 'nba.performance' })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('"city" (column:TRANSFORMED.team_directory.city, owned by nba.games)');
    expect(explained.message).toContain('not in the nba.performance scope (no purpose given)');
    expect(explainOutOfScopeWords('total player points by team', inventory, scoped, { activeDomain: 'nba.performance' })).toBeUndefined();
  });
  it('a ref the whole inventory does not hold stays an unknown ref', () => {
    expect(explainOutOfScope([{ path: 'measures[0]', message: 'metric:nowhere.thing is not in the vocabulary' }], inventory, { activeDomain: 'nba.performance' })).toBeUndefined();
    expect(explainOutOfScope([{ path: 'groupBy', message: 'the question asks for a total, not a breakdown' }], inventory, { activeDomain: null as never })).toBeUndefined();
  });
  it('coverage evaluations: an unapplied restriction warns, a mentioned word informs, neither passes', () => {
    const evaluations = coverageEvaluations({ uncovered: ['team_won', 'losses'], coverage: [{ word: 'team_won', state: 'unsatisfied' }, { word: 'losses', state: 'uncertain' }] });
    expect(evaluations.map((item) => [item.id, item.severity, item.passed])).toEqual([['pipeline-coverage', 'warning', false], ['pipeline-coverage-uncertain', 'info', false]]);
    expect(evaluations[0]!.message).toContain('restricts on "team_won"');
    expect(evaluations[1]!.message).toContain('may cover it under another');
    expect(coverageEvaluations({ uncovered: ['x'] })[0]!.severity).toBe('info');
    expect(coverageEvaluations({})).toEqual([]);
  });
});

describe('a Snowflake relation is addressed with its database (Codex: the relational route dropped it)', () => {
  const manifest = { dbtProvenance: { nodes: { 'model.p.header': { relation: '"ANALYTICS"."CONSUMPTION_METRICS"."HEADER"' }, 'model.p.two': { relation: 'consumption_metrics.two' } } } };
  it('provenance names the database; the vocabulary name is completed only on Snowflake and only when known', () => {
    const databases = relationDatabases(manifest as never);
    expect(databases.get('consumption_metrics.header')).toBe('"ANALYTICS"');
    expect(physicalRelationName('consumption_metrics.header', databases, 'snowflake')).toBe('"ANALYTICS".consumption_metrics.header');
    expect(physicalRelationName('consumption_metrics.two', databases, 'snowflake')).toBe('consumption_metrics.two');
    expect(physicalRelationName('consumption_metrics.header', databases, 'duckdb')).toBe('consumption_metrics.header');
  });
});

describe('request-local runtime schema keeps same-tail Snowflake columns apart', () => {
  it('never gives DB_A.PUBLIC.EVENTS the columns admitted for DB_B.PUBLIC.EVENTS', () => {
    const relation = (database: string, column: string) => ({
      schema: 'PUBLIC', name: 'EVENTS', columns: [{ name: column, dataType: 'NUMBER' }], columnCompleteness: 'complete' as const,
      binding: physicalRelationBinding({
        logicalRelation: 'PUBLIC.EVENTS', physicalRelation: `${database}.PUBLIC.EVENTS`,
        source: 'warehouse_probe', columnCompleteness: 'complete', columns: [{ name: column, type: 'NUMBER' }],
      }),
    });
    const vocabulary = buildVocabularyIndex({ relations: [relation('DB_A', 'A_ONLY'), relation('DB_B', 'B_ONLY')] });
    const runtime = runtimeSchemaForVocabulary(vocabulary);
    expect(runtime.find((entry) => entry.relation === 'DB_A.PUBLIC.EVENTS')?.columns.map((column) => column.name)).toEqual(['A_ONLY']);
    expect(runtime.find((entry) => entry.relation === 'DB_B.PUBLIC.EVENTS')?.columns.map((column) => column.name)).toEqual(['B_ONLY']);
    const dbA = vocabulary.entries.find((entry) => entry.kind === 'relation' && entry.physical?.binding?.database?.value === 'DB_A');
    expect(columnsForPhysicalEntry(vocabulary, dbA).map((column) => column.name)).toEqual(['A_ONLY']);
  });

  it('hands semantic compilation the hydrated selected target binding and current vocabulary', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'event_total', label: 'Event total', description: '', domain: 'events',
        sql: 'event_value', type: 'sum', metricType: 'simple', table: 'PUBLIC.EVENTS',
      }],
      dimensions: [],
    });
    const connection: ConnectionConfig = { driver: 'snowflake', account: 'acct', database: 'DB_B', schema: 'PUBLIC', role: 'ANALYST', warehouse: 'WH' };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Event total.', measures: [{ ref: 'metric:event_total' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:event_total': 'q:event total' }, expectedShape: 'scalar',
    })]);
    const executeQuery = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return {
          columns: [], rowCount: 1, executionTimeMs: 1,
          rows: [{ table_catalog: 'DB_B', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: 'EVENT_VALUE', data_type: 'NUMBER', ordinal_position: 1, dql_column_total: 1 }],
        };
      }
      return { columns: ['event_total'], rowCount: 1, executionTimeMs: 1, rows: [{ event_total: 7 }] };
    });
    let context: { snapshotId: string; executionTargetFingerprint: string; vocabulary: ReturnType<typeof buildVocabularyIndex>; physicalBindings: Array<{ database?: { value: string }; table: { value: string }; columns: Array<{ name: string }> }> } | undefined;
    const executor = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-selected-target',
      executor: { executeQuery } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({
        snapshotId: 'snapshot:selected-db-b',
        manifest: {
          sources: {
            events: {
              name: 'EVENTS', origin: 'dbt', referencedBy: [],
              dbtModel: { uniqueId: 'model.events', schema: 'PUBLIC', columns: { EVENT_VALUE: { name: 'EVENT_VALUE', type: 'NUMBER' } } },
            },
          },
        } as never,
      }),
      selectProvider: async () => provider,
      semanticEngine: async () => 'native',
      compileSemantic: async (_request, _connection, compileContext) => {
        context = compileContext as typeof context;
        return { sql: 'SELECT 7 AS event_total', engine: 'native' };
      },
      priorIntent: () => undefined,
    });

    await executor({
      runId: 'run:selected-target', request: { question: 'What is event total?', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });

    expect(context?.snapshotId).toBe('snapshot:selected-db-b');
    expect(context?.vocabulary.entries.some((entry) => entry.kind === 'column' && entry.name === 'EVENT_VALUE')).toBe(true);
    expect(context?.physicalBindings).toHaveLength(1);
    expect(context?.physicalBindings[0]).toMatchObject({ database: { value: 'DB_B' }, table: { value: 'EVENTS' }, columns: [{ name: 'EVENT_VALUE' }] });
  });
});

describe('the column probe is bounded', () => {
  it('returns a probed relation under the name it asked for, so the warehouse spelling merges into the manifest relation', () => {
    const named = underAskedNames([{ schema: 'CONSUMPTION_METRICS', name: 'HEADER', columns: [{ name: 'TOTAL_BCM', dataType: 'NUMBER' }] }, { schema: 'OTHER', name: 'THING', columns: [] }], ['consumption_metrics.header']);
    expect(named[0]).toMatchObject({ schema: 'consumption_metrics', name: 'header' });
    expect(named[0]!.columns[0]!.name).toBe('TOTAL_BCM');
    expect(named[1]).toMatchObject({ schema: 'OTHER', name: 'THING' });
  });
  it('has a default budget and an override', () => {
    expect(columnProbeBudgetMs({})).toBe(12_000);
    expect(columnProbeBudgetMs({ DQL_ASK_COLUMN_PROBE_MS: '3000' })).toBe(3_000);
    expect(columnProbeBudgetMs({ DQL_ASK_COLUMN_PROBE_MS: 'nope' })).toBe(12_000);
  });
});

describe('question-directed relation discovery', () => {
  it('hydrates semantic filter and time homes instead of letting repeated wide-model prose consume all three slots', () => {
    const source = {
      relations: [
        {
          schema: 'TRANSFORMED', name: 'fct_player_journey', columnCompleteness: 'partial' as const,
          // A wide season table repeats these words across many descriptions.
          description: 'Player season totals: points scored and games played. Player points scored and games played.',
          columns: [
            { name: 'total_points', description: 'Points scored by the player in games played.' },
            { name: 'games_played', description: 'Games played by the player.' },
          ],
        },
        {
          schema: 'TRANSFORMED', name: 'local_player_season_facts', columnCompleteness: 'partial' as const,
          description: 'Player-season aggregate from participated player-game rows.',
          columns: [{ name: 'games_played' }],
        },
        {
          schema: 'TRANSFORMED', name: 'local_player_game_facts', columnCompleteness: 'partial' as const,
          // The manifest has only keys and participated. `player_name`,
          // `is_home`, and points must be discovered before Ask can bind them.
          description: 'Player-game fact; participated player rows.',
          columns: [{ name: 'game_id' }, { name: 'player_id' }, { name: 'participated' }],
        },
        {
          schema: 'TRANSFORMED', name: 'local_team_game_facts', columnCompleteness: 'partial' as const,
          description: 'Team-game fact with home and away rows.',
          columns: [{ name: 'game_id' }, { name: 'is_home' }],
        },
      ],
      dimensions: [
        {
          name: 'game_date', model: 'local_player_game_facts', label: 'Game date', dataType: 'date', isTime: true,
          physical: { relation: 'TRANSFORMED.local_player_game_facts', column: 'game_date' },
        },
        {
          name: 'is_home', model: 'local_team_game_facts', label: 'Home game', dataType: 'boolean',
          physical: { relation: 'TRANSFORMED.local_team_game_facts', column: 'is_home' },
        },
      ],
    };

    const selected = relevantRelationsForQuestion(
      source,
      'For Stephen Curry, show games played and points scored by month in calendar 2017, only home games in which he participated.',
    );

    expect(selected).toHaveLength(3);
    expect(selected).toEqual(expect.arrayContaining([
      'TRANSFORMED.local_player_game_facts',
      'TRANSFORMED.local_team_game_facts',
    ]));
  });

  it('keeps a partial physical metric home when a lexical decoy also matches', () => {
    const source = {
      relations: [
        {
          schema: 'PUBLIC', name: 'FACT', columnCompleteness: 'partial' as const,
          // The manifest only documented a key. `amount` and `event_date`
          // belong to this relation through the semantic layer and must cause
          // it to be hydrated even though its current text has no lexical hit.
          columns: [{ name: 'id' }],
          binding: physicalRelationBinding({
            logicalRelation: 'PUBLIC.FACT', physicalRelation: 'DB_A.PUBLIC.FACT',
            source: 'dbt_manifest', columnCompleteness: 'partial', columns: [{ name: 'id' }],
          }),
        },
        {
          schema: 'PUBLIC', name: 'DECOY', columnCompleteness: 'partial' as const,
          description: 'Revenue overview for a different operational feed.',
          columns: [{ name: 'id' }],
          binding: physicalRelationBinding({
            logicalRelation: 'PUBLIC.DECOY', physicalRelation: 'DB_A.PUBLIC.DECOY',
            source: 'dbt_manifest', columnCompleteness: 'partial', columns: [{ name: 'id' }],
          }),
        },
      ],
      metrics: [{
        name: 'revenue', model: 'fact', label: 'Revenue', description: '',
        physical: { relation: 'PUBLIC.FACT', column: 'amount' },
      }],
      dimensions: [{
        name: 'metric_time', model: 'fact', label: 'Metric time', description: '', dataType: 'date', isTime: true,
        physical: { relation: 'PUBLIC.FACT', column: 'event_date' },
      }],
    } as never;

    const selected = relevantRelationsForQuestion(source, 'Show revenue by month');

    expect(selected).toEqual(expect.arrayContaining([
      'DB_A.PUBLIC.FACT',
      'DB_A.PUBLIC.DECOY',
    ]));
  });
});

describe('a column is found by the words of its name', () => {
  it('COMPETITOR_C is found by the word competitor', () => {
    const source = {
      relations: [
        { schema: 'sales', name: 'opportunity_enhanced', columnCompleteness: 'partial' as const, columns: [{ name: 'OPPORTUNITY_ID' }, { name: 'AMOUNT' }] },
        { schema: 'sfdc', name: 'opportunity_history', columnCompleteness: 'partial' as const, columns: [{ name: 'ID' }, { name: 'COMPETITOR_C' }] },
      ],
    } as never;
    expect(relevantRelationsForQuestion(source, 'lost deals where the competitor involved is Splunk', 3, { splitNames: true })).toEqual(['sfdc.opportunity_history']);
    // The governed context keeps whole names, so its recorded prompts do not move.
    expect(relevantRelationsForQuestion(source, 'lost deals where the competitor involved is Splunk')).toEqual([]);
  });

  it('the wider look ranks words the question used above words only the decline used', () => {
    const source = {
      relations: [
        { schema: 'crm', name: 'deal_notes', columns: [{ name: 'deal_ref' }, { name: 'rival_vendor', description: 'the competitor named on the deal' }] },
        { schema: 'crm', name: 'accounts', columns: [{ name: 'primary_owner' }] },
        { schema: 'sales', name: 'opportunities', columns: [{ name: 'deal_ref' }] },
      ],
    } as never;
    expect(relationsWithColumnWords(source, missingFieldWords('No competitor column (such as PRIMARY_COMPETITOR) is available'), 'lost to a competitor', ['sales.opportunities'])).toEqual(['crm.deal_notes', 'crm.accounts']);
  });
});

describe('a question that matches no relation hydrates none', () => {
  it('returns no candidates instead of the alphabetically first partial relations', () => {
    const source = {
      relations: [
        { schema: 'PUBLIC', name: 'AAA_FIRST', columnCompleteness: 'partial' as const, columns: [{ name: 'id' }] },
        { schema: 'PUBLIC', name: 'BBB_SECOND', columnCompleteness: 'partial' as const, columns: [{ name: 'id' }] },
      ],
    } as never;
    expect(relevantRelationsForQuestion(source, 'what is the % DOD ACM value?')).toEqual([]);
  });
});

describe('the Ask host uses AgentRunBudget remaining duration at every boundary', () => {
  it('hydrates metadata and reaches SQL with positive relative deadlines from a duration budget', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'event_total', label: 'Event total', description: '', domain: 'events',
        sql: 'event_value', type: 'sum', metricType: 'simple', table: 'PUBLIC.EVENTS',
      }],
      dimensions: [],
    });
    const connection: ConnectionConfig = { driver: 'snowflake', account: 'acct', database: 'DB_B', schema: 'PUBLIC', role: 'ANALYST', warehouse: 'WH' };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Event total.', measures: [{ ref: 'metric:event_total' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:event_total': 'q:event total' }, expectedShape: 'scalar',
    })]);
    const metadataDeadlines: number[] = [];
    const executionDeadlines: number[] = [];
    const executeQuery = vi.fn(async (
      sql: string,
      _params: unknown[],
      _variables: Record<string, unknown>,
      _connection: ConnectionConfig,
      options?: { deadlineMs?: number },
    ) => {
      // SHOW COLUMNS is asked first on Snowflake; this warehouse double does not answer it.
      if (/^SHOW COLUMNS IN /.test(sql)) {
        metadataDeadlines.push(options?.deadlineMs ?? 0);
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }
      if (sql.includes('information_schema.columns')) {
        metadataDeadlines.push(options?.deadlineMs ?? 0);
        return {
          columns: [], rowCount: 1, executionTimeMs: 1,
          rows: [{ table_catalog: 'DB_B', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: 'EVENT_VALUE', data_type: 'NUMBER', ordinal_position: 1, dql_column_total: 1 }],
        };
      }
      executionDeadlines.push(options?.deadlineMs ?? 0);
      return { columns: ['event_total'], rowCount: 1, executionTimeMs: 1, rows: [{ event_total: 7 }] };
    });
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-budget-duration',
      executor: { executeQuery } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({
        snapshotId: 'snapshot:budget-duration',
        manifest: {
          sources: {
            events: {
              name: 'EVENTS', origin: 'dbt', referencedBy: [],
              dbtModel: { uniqueId: 'model.events', schema: 'PUBLIC', columns: { EVENT_VALUE: { name: 'EVENT_VALUE', type: 'NUMBER' } } },
            },
          },
        } as never,
      }),
      selectProvider: async () => provider,
      semanticEngine: async () => 'native',
      compileSemantic: async () => ({ sql: 'SELECT 7 AS event_total', engine: 'native' }),
      priorIntent: () => undefined,
    });
    const budget = createAgentRunBudget({ requestedMode: 'ask' });
    expect(budget.hardDeadlineMs).toBeGreaterThan(0);
    expect(budget.remainingMs()).toBeGreaterThan(0);

    const result = await route({
      runId: 'run:budget-duration',
      request: { question: 'What is event total?', requestedMode: 'ask', runBudget: budget, signal: budget.hardSignal } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });

    expect(result.status).toBe('completed');
    expect(metadataDeadlines).toHaveLength(2);
    expect(metadataDeadlines.every((deadline) => deadline > 0)).toBe(true);
    expect(executionDeadlines).toHaveLength(1);
    expect(executionDeadlines[0]).toBeGreaterThan(0);
  });

  it('does not begin interpretation once the real run budget has expired and its hard signal is aborted', async () => {
    const expired = new AbortController();
    expired.abort(new Error('deadline elapsed'));
    const budget = createAgentRunBudget({
      requestedMode: 'ask',
      startedAtMs: 0,
      nowMs: () => 1_000_000,
      inheritedSignal: expired.signal,
      timeoutSignal: () => expired.signal,
    });
    const provider = scripted([conversation]);
    const result = await executorFor(provider, undefined)({
      runId: 'run:expired-budget',
      request: { question: 'hello', requestedMode: 'ask', runBudget: budget, signal: budget.hardSignal } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });

    expect(budget.remainingMs()).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(result.status).toBe('blocked');
    expect(result.askPipelineReceipt?.failure).toMatchObject({ reason: 'cancelled' });
  });
});

describe('the projected vocabulary is keyed by the whole envelope selection', () => {
  const pack = { skills: [], appliedHints: [], eligible: undefined, domainBriefing: undefined };
  const envelope = (purpose: string | undefined, imports: Array<{ providerDomain: string; exportRef: string; purpose: string }>) => ({ activeDomain: 'consumer', purpose, modelAreaId: undefined, allowedImports: imports, descendants: [] });
  it('a different purpose, and therefore a different export, is a different key', () => {
    const identity = vocabularyViewKey('base', envelope('identity_lookup', [{ providerDomain: 'provider', exportRef: 'provider:provider_identity@1.0.0', purpose: 'identity_lookup' }]), pack);
    const orders = vocabularyViewKey('base', envelope('order_reporting', [{ providerDomain: 'provider', exportRef: 'provider:provider_orders@1.0.0', purpose: 'order_reporting' }]), pack);
    expect(identity).not.toBe(orders);
    expect(vocabularyViewKey('base', envelope('identity_lookup', [{ providerDomain: 'provider', exportRef: 'provider:provider_identity@1.0.0', purpose: 'identity_lookup' }]), pack)).toBe(identity);
    expect(vocabularyViewKey('base', envelope(undefined, []), pack)).not.toBe(identity);
  });
});

describe('the pipeline host without a warehouse', () => {
  it('answers a conversational turn with one interpreter send and no connection', async () => {
    const provider = scripted([conversation]);
    const result = await run(executorFor(provider, undefined), 'hi');
    expect(result.status).toBe('completed');
    expect(result.resolvedRoute).toBe('conversation');
    expect(result.answer).toBe('Hello! Ask me about the governed data.');
    expect(provider.calls).toHaveLength(1);
  });
  it('reports the missing connection verbatim only when a prepared query would execute', async () => {
    const manifest = {
      sources: [{ schema: 'dev', name: 'order_items', columns: [{ name: 'product_price', dataType: 'DOUBLE' }] }],
      blocks: [],
    };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Total product price.', measures: [{ ref: 'column:dev.order_items.product_price', aggregation: 'sum' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
    }), analytics]);
    const result = await run(executorFor(provider, manifest), 'total product price');
    // Either the relational tier prepared and execution named the missing
    // connection, or no tier could prepare without a semantic layer; in
    // neither case did interpretation itself need a warehouse.
    expect(result.status).toBe('blocked');
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    const receipt = result.askPipelineReceipt;
    expect(receipt).toBeDefined();
    if (receipt?.failure?.stage === 'execute') expect(receipt.failure.message).toMatch(/No database connection is configured yet/);
  });
});

describe('a gap is headed by what it is', () => {
  it('no matching data is not a modeling gap', () => {
    expect(gapPresentation('not_retrieved')).toEqual({ title: 'No matching data for that period', code: 'no_data' });
    // The heading names what came back empty, not always the period.
    expect(gapPresentation('not_retrieved', 'no rows matched "Totally Imaginary Person" on the warehouse').title).toBe('No matching data for that name');
    expect(gapPresentation('not_retrieved', 'no rows matched the restriction on is_drink_item').title).toBe('No matching data under those filters');
    expect(gapPresentation('not_retrieved', 'no rows fell inside the window 2030-01-01..2031-01-01').title).toBe('No matching data for that period');
    expect(gapPresentation('not_modeled').code).toBe('modeling_gap');
    expect(gapPresentation('unsupported')).toEqual({ title: 'No governed answer', code: 'modeling_gap' });
    expect(gapPresentation('denied').code).toBe('policy_blocked');
    expect(gapPresentation('ambiguous').code).toBe('ambiguous');
  });
});

describe('member literal grounding', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } },
      { name: 'customer_type', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_type' } },
    ],
    entities: [{ name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } }],
  });
  const intent = (filters: AnalyticalIntentV1['filters']): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters, unresolved: [], provenance: {}, expectedShape: 'scalar' });
    if (!parsed.intent) throw new Error('bad intent');
    return parsed.intent;
  };
  const connection = { driver: 'duckdb' } as ConnectionConfig;
  const probes: string[] = [];
  const deps = {
    literalProbeAllowed: (relation: string, column: string) => `${relation}.${column}` === 'dev.customers.customer_name',
    probeLiteral: async (_relation: string, column: string, value: string) => {
      probes.push(`${column}=${value}`);
      return value.toLowerCase() === 'ryan byrd' ? ['Ryan Byrd'] : [];
    },
  };
  it('replaces a literal with its stored casing on an allowlisted column and says so', async () => {
    const grounded = await groundIntentLiterals(intent([{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }]), vocabulary, connection, deps);
    expect(grounded.intent.filters[0]!.values).toEqual(['Ryan Byrd']);
    expect(grounded.notes).toEqual(['customer_name: "Ryan byrd" is stored as "Ryan Byrd"']);
  });
  it('records an absent member and never probes a column outside the allowlist', async () => {
    probes.length = 0;
    const grounded = await groundIntentLiterals(intent([
      { ref: 'dimension:customers.customer_name', op: 'eq', values: ['Nobody Here'], source: 'question' },
      { ref: 'dimension:customers.customer_type', op: 'eq', values: ['returning'], source: 'question' },
    ]), vocabulary, connection, deps);
    expect(grounded.intent.filters.map((filter) => filter.values)).toEqual([['Nobody Here'], ['returning']]);
    expect(grounded.notes).toEqual(['customer_name: no stored value matches "Nobody Here"']);
    expect(probes).toEqual(['customer_name=Nobody Here']);
  });
});

describe('identity behind a label', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'lifetime_spend', model: 'customers', aggregation: 'sum', physical: { relation: 'dev.customers', expr: '"dev"."customers"."lifetime_spend"', aggregate: 'sum' } }],
    dimensions: [{ name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } }],
    entities: [{ name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } }],
  });
  const connection = { driver: 'duckdb' } as ConnectionConfig;
  const ask = (name: string): AnalyticalIntentV1 => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:customers.lifetime_spend' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: [name], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  const members: Record<string, Array<{ key: string; label: string }>> = { 'jordan lee': [{ key: 'a', label: 'Jordan Lee' }, { key: 'b', label: 'Jordan Lee' }], 'ryan byrd': [{ key: 'r', label: 'Ryan Byrd' }] };
  const probed: string[] = [];
  const deps = {
    literalProbeAllowed: (relation: string, column: string) => `${relation}.${column}` === 'dev.customers.customer_name',
    probeLiteral: async (_relation: string, _column: string, value: string) => members[value.toLowerCase()]?.map((member) => member.label).slice(0, 1) ?? [],
    probeLabelKeys: async (_relation: string, key: string, label: string, value: string) => { probed.push(`${key}/${label}=${value}`); return members[value.toLowerCase()] ?? []; },
  };
  it('several keys behind one name make the answer one row per member, keyed, with the name displayed', async () => {
    const grounded = await groundIntentLiterals(ask('jordan lee'), vocabulary, connection, deps);
    expect(grounded.intent.groupBy).toEqual([{ ref: 'entity:customers.customer', role: 'key' }]);
    expect(grounded.intent.display).toEqual(['dimension:customers.customer_name']);
    expect(grounded.intent.expectedShape).toBe('grouped');
    expect(grounded.intent.filters[0]!.values).toEqual(['Jordan Lee']);
    expect(grounded.notes).toContain('identity: 2 customers share the name "Jordan Lee"; one row per customer, keyed by customer_id');
    expect(grounded.intent.provenance['entity:customers.customer']).toMatch(/host:2 customers share/);
  });
  it('one key leaves the scalar alone and says whom it identifies; a column outside the allowlist is never probed', async () => {
    probed.length = 0;
    const one = await groundIntentLiterals(ask('ryan byrd'), vocabulary, connection, deps);
    expect(one.intent.groupBy).toEqual([]);
    expect(one.notes).toContain('identity: "Ryan Byrd" identifies one customer');
    const closed = await groundIntentLiterals(ask('jordan lee'), vocabulary, connection, { ...deps, literalProbeAllowed: () => false });
    expect(closed.intent.groupBy).toEqual([]);
    expect(probed).toEqual(['customer_id/customer_name=Ryan Byrd']);
  });
});

describe('executed rows', () => {
  it('calendar cells become ISO instants so narration, persistence and the table read one value', () => {
    const row = normalizeExecutedRow({ month: new Date('2025-03-01T00:00:00.000Z'), revenue: 12.5, name: 'Ryan Byrd', empty: null });
    expect(row).toEqual({ month: '2025-03-01T00:00:00.000Z', revenue: 12.5, name: 'Ryan Byrd', empty: null });
    const untouched = { revenue: 1 };
    expect(normalizeExecutedRow(untouched)).toBe(untouched);
  });
});

describe('physical trace spans', () => {
  it('a value probe is one search_values tool span carrying fingerprints only, and a failed probe finishes as an error', async () => {
    const spans: string[] = [];
    const connection = { driver: 'duckdb' } as ConnectionConfig;
    const request = { question: 'q', requestedMode: 'ask' } as AgentRunRequest;
    const probes = tracedProbes({
      literalProbeAllowed: () => true,
      probeLiteral: async () => ['Ryan Byrd'],
      probeLabelKeys: async () => { throw new Error('boom'); },
      traceExecution: (_request, span) => { spans.push(span.name === 'tool.call' ? `${span.name}:${span.toolKind}:${span.inputFingerprint.length}` : span.name); return { finish: (outcome, extra) => { spans.push(`finish:${outcome}${extra?.safeErrorCode ? `:${extra.safeErrorCode}` : ''}`); } }; },
    }, request);
    expect(await probes.probeLiteral!('dev.customers', 'customer_name', 'ryan byrd', connection)).toEqual(['Ryan Byrd']);
    await expect(probes.probeLabelKeys!('dev.customers', 'customer_id', 'customer_name', 'ryan byrd', connection)).rejects.toThrow('boom');
    expect(spans).toEqual(['tool.call:search_values:24', 'finish:ok', 'tool.call:search_values:24', 'finish:error:probe_failure']);
    // Without a tracer the deps are handed through untouched.
    const plain = { literalProbeAllowed: () => true, probeLiteral: async () => [] };
    expect(tracedProbes(plain, request)).toBe(plain);
  });
});

describe('a certified block is compiled and bound like every other surface runs it', () => {
  const blockSource = `// dql-format: 1
block "top_players" {
  domain = "nba"
  type = "custom"
  status = "certified"
  description = "Top players by points between two calendar years."
  owner = "x"
  outputs = ["player_name", "total_points"]
  params {
    season_start = 2016
    season_end = 2017
    top_n = 5
  }
  query = """
    SELECT player_name, SUM(pts) AS total_points FROM dev.player_game_stats
    WHERE CAST(strftime('%Y', game_date) AS INTEGER) BETWEEN \${season_start} AND \${season_end}
    GROUP BY player_name ORDER BY total_points DESC LIMIT \${top_n}
  """
}
`;
  it('binds declared defaults and values the question states, in placeholder order, and leaves no template', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'dql-block-'));
    mkdirSync(join(root, 'blocks'), { recursive: true });
    writeFileSync(join(root, 'blocks', 'top_players.dql'), blockSource);
    const entry = { ref: 'block:nba.top_players', kind: 'block', name: 'top_players', aliases: [], roles: [], sourcePath: 'blocks/top_players.dql', contract: { outputs: ['player_name', 'total_points'], measures: [], groupBy: [], staticScope: [], allowedFilters: [], parameters: ['season_start', 'season_end', 'top_n'], structural: true } } as never;
    const prepared = prepareBlockForAsk(root, entry, { question: 'Top 3 players by points in 2016 and 2017' }, 'sqlite');
    expect(prepared && 'sql' in prepared ? prepared.sql : prepared).toMatch(/BETWEEN \$1 AND \$2[\s\S]*LIMIT \$3/);
    if (!prepared || !('sql' in prepared)) return;
    expect(prepared.sql).not.toMatch(/\$\{/);
    expect(prepared.params).toEqual([2016, 2017, 3]);
    expect(prepared.parameters.map((parameter) => `${parameter.name}:${parameter.source}`)).toEqual(['season_start:question', 'season_end:question', 'top_n:question']);
    const defaults = prepareBlockForAsk(root, entry, { question: 'who are the top players' }, 'sqlite');
    expect(defaults && 'params' in defaults ? defaults.params : defaults).toEqual([2016, 2017, 5]);
  });
  it('a block without a declaration on disk is usable only when it has no parameters', () => {
    const plain = { ref: 'block:x.plain', kind: 'block', name: 'plain', aliases: [], roles: [], sql: 'SELECT 1 AS one' } as never;
    expect(prepareBlockForAsk('/nowhere', plain, {})).toEqual({ sql: 'SELECT 1 AS one', params: [], parameters: [] });
    const templated = { ref: 'block:x.t', kind: 'block', name: 't', aliases: [], roles: [], sql: 'SELECT 1 WHERE y = ${limit}' } as never;
    expect(prepareBlockForAsk('/nowhere', templated, {})).toMatchObject({ error: expect.stringMatching(/not available/) });
  });
});

describe('a connection remembers what it cannot see', () => {
  const key = 'snowflake|acme|ANALYTICS';
  it('a relation the warehouse denied once is refused before the next query, and a success forgets it', () => {
    resetRelationEvidence();
    const sql = 'SELECT COUNT(*) FROM "ANALYTICS"."DEV"."FCT_PLAYER_JOURNEY" AS j JOIN "ANALYTICS"."DEV"."GAMES" g ON g.id = j.id';
    expect(knownMissingRelation(key, sql)).toBeUndefined();
    recordRelationEvidence(key, sql, classifyWarehouseError("Object 'ANALYTICS.DEV.FCT_PLAYER_JOURNEY' does not exist."), "Object 'ANALYTICS.DEV.FCT_PLAYER_JOURNEY' does not exist.");
    expect(knownMissingRelation(key, sql)).toBe('ANALYTICS.DEV.FCT_PLAYER_JOURNEY');
    // Another connection knows nothing about it.
    expect(knownMissingRelation('duckdb|jaffle', sql)).toBeUndefined();
    // The same table under a different qualifier is the same table.
    expect(knownMissingRelation(key, 'SELECT 1 FROM dev.fct_player_journey')).toBe('ANALYTICS.DEV.FCT_PLAYER_JOURNEY');
    recordRelationEvidence(key, 'SELECT 1 FROM dev.fct_player_journey');
    expect(knownMissingRelation(key, sql)).toBeUndefined();
  });
  it('a failure that names no single relation teaches nothing, and a syntax error is never a missing table', () => {
    resetRelationEvidence();
    recordRelationEvidence(key, 'SELECT 1 FROM a.b JOIN a.c ON TRUE', classifyWarehouseError('SQL compilation error: object does not exist'));
    expect(knownMissingRelation(key, 'SELECT 1 FROM a.b')).toBeUndefined();
    recordRelationEvidence(key, 'SELECT 1 FROM a.b', classifyWarehouseError('SQL compilation error: syntax error line 1 at position 7'));
    expect(knownMissingRelation(key, 'SELECT 1 FROM a.b')).toBeUndefined();
  });
  it('does not turn Snowflake’s ambiguous missing-or-not-authorized wording into cached absence', () => {
    resetRelationEvidence();
    const sql = 'SELECT 1 FROM "ANALYTICS"."DEV"."FCT_PLAYER_JOURNEY"';
    const message = "Object 'ANALYTICS.DEV.FCT_PLAYER_JOURNEY' does not exist or not authorized.";
    recordRelationEvidence(key, sql, classifyWarehouseError(message), message);
    expect(knownMissingRelation(key, sql)).toBeUndefined();
  });
  it('the key is the account and database, never a credential', () => {
    const config = { driver: 'snowflake', account: 'acme', database: 'ANALYTICS', schema: 'DEV', username: 'svc', password: 'secret', token: 'tok' } as ConnectionConfig;
    const composed = connectionKey(config);
    expect(composed).toContain('acme');
    expect(composed).toContain('ANALYTICS');
    expect(composed).not.toContain('secret');
    expect(composed).not.toContain('tok');
  });
});

describe('the members a name could mean', () => {
  it('reads the column the query already filtered, bounded and case-insensitively', () => {
    const sql = memberCandidatesSql('TRANSFORMED.local_player_game_facts', 'player_name', (name) => `"${name}"`);
    expect(sql).toContain('FROM "TRANSFORMED"."local_player_game_facts"');
    expect(sql).toContain('LOWER(CAST("player_name" AS VARCHAR)) LIKE ?');
    expect(sql).toContain('LIMIT 7');
    expect(sql).toContain('DISTINCT');
  });
  it('keeps a quoted dot inside a physical database identifier', () => {
    const sql = memberCandidatesSql('"Db.With.Dot"."Public"."Events"', 'EventId', (name) => `"${name}"`);
    expect(sql).toContain('FROM "Db.With.Dot"."Public"."Events"');
    expect(sql).not.toContain('"Db"."With"."Dot"');
  });
});

describe('Snowflake physical metadata identity', () => {
  it('keeps quoted dotted databases separate in probes and never chooses an ambiguous short alias', () => {
    const sql = relationColumnsProbeSql([
      '"Db.With.Dot"."Public"."Events"',
      'DB_B.PUBLIC.EVENTS',
    ])!;
    expect(sql).toContain('FROM "Db.With.Dot".information_schema.columns');
    expect(sql).toContain('FROM DB_B.information_schema.columns');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain("table_catalog");

    const databases = relationDatabases({
      dbtProvenance: {
        nodes: {
          a: { relation: 'DB_A.PUBLIC.EVENTS' },
          b: { relation: 'DB_B.PUBLIC.EVENTS' },
        },
      },
    });
    expect(databases.size).toBe(0);
    expect(physicalRelationName('PUBLIC.EVENTS', databases, 'snowflake')).toBe('PUBLIC.EVENTS');
  });

  it('keeps the relation identity while using the local information schema for DuckDB', () => {
    const sql = relationColumnsProbeSql(['MAIN.PUBLIC.EVENTS'], 1, 0, 'duckdb')!;
    expect(sql).toContain('FROM information_schema.columns');
    expect(sql).not.toContain('FROM MAIN.information_schema.columns');
    expect(sql).toContain("'MAIN' AS table_catalog");
  });

  it('maps a probe result only to the exact requested database and keys cache evidence by role', () => {
    const [mapped] = underAskedNames([
      { database: 'DB_A', schema: 'PUBLIC', name: 'EVENTS', columns: [{ name: 'EVENT_ID', dataType: 'NUMBER' }], columnCompleteness: 'partial' },
    ], ['DB_A.PUBLIC.EVENTS', 'DB_B.PUBLIC.EVENTS']);
    expect(mapped?.binding?.database?.value).toBe('DB_A');
    expect(mapped?.binding?.table.value).toBe('EVENTS');
    const base = { driver: 'snowflake', account: 'acme', database: 'DB_A', schema: 'PUBLIC', warehouse: 'WH', username: 'analyst' } as ConnectionConfig;
    expect(connectionKey({ ...base, role: 'ROLE_A' })).not.toBe(connectionKey({ ...base, role: 'ROLE_B' }));
  });

  it('marks metadata completeness per relation and carries an exact page cursor', () => {
    const rows = [
      ...Array.from({ length: 800 }, (_, index) => ({ table_catalog: 'DB_A', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: `A_${index}`, data_type: 'NUMBER', dql_column_total: 801 })),
      { table_catalog: 'DB_B', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: 'B_ONLY', data_type: 'NUMBER', dql_column_total: 1 },
    ];
    const relations = relationsFromProbeRows(rows);
    expect(relations.find((relation) => relation.database === 'DB_A')).toMatchObject({ columnCompleteness: 'partial', truncated: true });
    expect(relations.find((relation) => relation.database === 'DB_B')).toMatchObject({ columnCompleteness: 'complete' });
    expect(relationColumnsProbeSql(['DB_A.PUBLIC.EVENTS'], 1, 800)).toContain('dql_column_page > 800');
  });
});

describe('the Snowflake column probe asks SHOW COLUMNS first', () => {
  it('maps SHOW COLUMNS rows, including JSON data types, into complete probe relations', () => {
    const rows = snowflakeShowColumnsRows([
      { table_name: 'OPPORTUNITIES', schema_name: 'SALES', column_name: 'AMOUNT', data_type: '{"type":"FIXED","precision":38,"scale":2,"nullable":true}', database_name: 'DB_A' },
      { table_name: 'OPPORTUNITIES', schema_name: 'SALES', column_name: 'STAGE', data_type: '{"type":"TEXT","length":16777216,"nullable":true}', database_name: 'DB_A' },
      { table_name: 'OPPORTUNITIES', schema_name: 'SALES', column_name: 'CLOSE_DATE', data_type: '{"type":"DATE","nullable":true}', database_name: 'DB_A' },
    ]);
    expect(rows.map((row) => [row.table_catalog, row.table_schema, row.table_name, row.column_name, row.data_type, row.dql_column_total])).toEqual([
      ['DB_A', 'SALES', 'OPPORTUNITIES', 'AMOUNT', 'NUMBER(38,2)', 3],
      ['DB_A', 'SALES', 'OPPORTUNITIES', 'STAGE', 'VARCHAR(16777216)', 3],
      ['DB_A', 'SALES', 'OPPORTUNITIES', 'CLOSE_DATE', 'DATE', 3],
    ]);
    const relations = relationsFromProbeRows(rows, true, 0);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ database: 'DB_A', schema: 'SALES', name: 'OPPORTUNITIES', columnCompleteness: 'complete' });
    expect(relations[0]!.columns.map((column) => column.dataType)).toEqual(['NUMBER(38,2)', 'VARCHAR(16777216)', 'DATE']);
  });

  it('hydrates a Snowflake relation with SHOW COLUMNS and never scans information_schema when it answers', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'event_total', label: 'Event total', description: '', domain: 'events', sql: 'event_value', type: 'sum', metricType: 'simple', table: 'PUBLIC.EVENTS' }],
      dimensions: [],
    });
    const connection: ConnectionConfig = { driver: 'snowflake', account: 'acct', database: 'DB_B', schema: 'PUBLIC', role: 'ANALYST', warehouse: 'WH' };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Event total.', measures: [{ ref: 'metric:event_total' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:event_total': 'q:event total' }, expectedShape: 'scalar',
    })]);
    const statements: string[] = [];
    const executeQuery = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (/^SHOW COLUMNS IN /.test(sql)) {
        return { columns: [], rowCount: 1, executionTimeMs: 1, rows: [{ table_name: 'EVENTS', schema_name: 'PUBLIC', column_name: 'EVENT_VALUE', data_type: '{"type":"FIXED","precision":38,"scale":0}', database_name: 'DB_B' }] };
      }
      if (sql.includes('information_schema.columns')) throw new Error('information_schema must not be scanned when SHOW COLUMNS answered');
      return { columns: ['event_total'], rowCount: 1, executionTimeMs: 1, rows: [{ event_total: 7 }] };
    });
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-show-columns',
      executor: { executeQuery } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({
        snapshotId: 'snapshot:show-columns',
        manifest: { sources: { events: { name: 'EVENTS', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.events', schema: 'PUBLIC', columns: { EVENT_VALUE: { name: 'EVENT_VALUE', type: 'NUMBER' } } } } } } as never,
      }),
      selectProvider: async () => provider,
      semanticEngine: async () => 'native',
      compileSemantic: async () => ({ sql: 'SELECT 7 AS event_total', engine: 'native' }),
      priorIntent: () => undefined,
    });
    const result = await route({
      runId: 'run:show-columns',
      request: { question: 'What is event total?', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(result.status).toBe('completed');
    // The connection's database qualifies the relation, so SHOW asks the exact object.
    expect(statements.filter((sql) => /^SHOW COLUMNS IN /.test(sql))).toEqual(['SHOW COLUMNS IN DB_B.PUBLIC.EVENTS']);
    expect(statements.some((sql) => sql.includes('information_schema.columns'))).toBe(false);
    expect(result.askPipelineReceipt?.physicalBindings?.find((binding) => /EVENTS$/i.test(binding.relation))?.completeness).toBe('complete');
  });
});

describe('an out-of-scope ref spelled with the wrong kind and a schema is still explained', () => {
  // The fixture holds the city as a DIMENSION of the team directory; the model
  // wrote it as a schema-qualified COLUMN. The owning domain is still known.
  const inventory = buildVocabularyIndex({
    dimensions: [{ name: 'city', model: 'team_directory', label: 'City', dataType: 'string', physical: { relation: 'TRANSFORMED.dim_teams_cleansed', column: 'city' } }],
    relations: [{ schema: 'TRANSFORMED', name: 'dim_teams_cleansed', columns: [], domain: 'nba.games', domains: ['nba.games'] }],
  });
  it('finds the dimension by its dotted tail and names its owning domain', () => {
    const explained = explainOutOfScope([{ path: 'display[0]', message: 'column:TRANSFORMED.team_directory.city is not in the vocabulary' }], inventory, { activeDomain: 'nba.performance', purpose: undefined })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('owned by nba.games');
  });
  it('never guesses from a bare field name on a relation nobody holds', () => {
    expect(explainOutOfScope([{ path: 'display[0]', message: 'column:TRANSFORMED.nowhere.city is not in the vocabulary' }], inventory, { activeDomain: 'nba.performance', purpose: undefined })).toBeUndefined();
  });
});

describe('a run that cannot reach an AI model says so, with its story', () => {
  it('keeps the specific reason and a failed step instead of a generic sentence', async () => {
    const executor = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/none', executor: {} as QueryExecutor,
      resolveConnection: async () => { throw new Error('unused'); },
      getSemanticLayer: () => undefined,
      getManifest: () => ({ manifest: {} as never, snapshotId: 'snapshot:no-provider' }),
      selectProvider: async () => undefined,
      compileSemantic: async () => { throw new Error('unused'); },
      priorIntent: () => undefined,
    });
    const result = await run(executor, 'total revenue');
    expect(result.answer).toContain('No AI model is configured');
    expect(result.askPipelineReceipt?.story).toEqual([expect.objectContaining({ title: 'Could not reach an AI model', state: 'failed', detail: expect.stringContaining('No AI model is configured') })]);
  });
});

describe('the schema lane on the host: no governed reading, the AI drafts SQL from the tables it inspects', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const manifest = { sources: { opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { opportunity_id: { name: 'opportunity_id' }, stage: { name: 'stage' }, competitor: { name: 'competitor' }, amount: { name: 'amount' } } } } } };
  const unreadable = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Lost deals to a competitor.', measures: [{ ref: 'metric:crm.lost_deal_count' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  const drafter = (draft: string): AgentProvider & { draftPrompts: string[] } => {
    const draftPrompts: string[] = [];
    return {
      name: 'ollama', draftPrompts, available: async () => true,
      generate: async (messages) => {
        if (messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) { draftPrompts.push(messages.map((message) => message.content).join('\n')); return draft; }
        return unreadable;
      },
    };
  };
  const routeFor = (provider: AgentProvider, statements: string[]) => createAskPipelineRouteExecutor({
    projectRoot: '/tmp/ask-schema-lane',
    executor: { executeQuery: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('information_schema.columns')) {
        return { columns: [], rowCount: 4, executionTimeMs: 1, rows: ['opportunity_id', 'stage', 'competitor', 'amount'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: column === 'amount' ? 'DOUBLE' : 'VARCHAR' })) };
      }
      return { columns: ['lost_deals'], rowCount: 1, executionTimeMs: 1, rows: [{ lost_deals: 12 }] };
    }) } as unknown as QueryExecutor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: 'snapshot:schema-lane', manifest: manifest as never }),
    selectProvider: async () => provider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  const ask = (route: ReturnType<typeof createAskPipelineRouteExecutor>) => route({
    runId: 'run:schema-lane',
    request: { question: 'How many opportunities did we lose to Splunk?', requestedMode: 'ask' } as AgentRunRequest,
    route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
  });

  it('drafts one statement over the inspected opportunities table, runs it, and labels the answer review-required', async () => {
    const provider = drafter("SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'");
    const statements: string[] = [];
    const result = await ask(routeFor(provider, statements));
    expect(provider.draftPrompts).toHaveLength(1);
    expect(provider.draftPrompts[0]).toContain('WHY NO GOVERNED ANSWER');
    expect(provider.draftPrompts[0]).toContain('competitor');
    expect(statements.some((sql) => sql.includes('FROM sales.opportunities WHERE'))).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.askPipelineReceipt?.executed?.tier).toBe('exploratory');
    expect(result.answer).toContain('written by AI from the schema');
    expect(result.artifacts?.find((artifact) => artifact.kind === 'answer')?.title).toBe('AI-drafted answer');
    expect(result.trustState).toBe('review_required');
  });

  it('a decline over the first tables searches every table for the missing field, adds it, and drafts again', async () => {
    const wide = { sources: {
      opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { opportunity_id: { name: 'opportunity_id' }, deal_ref: { name: 'deal_ref' }, stage: { name: 'stage' } } } },
      deal_notes: { name: 'deal_notes', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.deal_notes', schema: 'crm', columns: { deal_ref: { name: 'deal_ref' }, rival_vendor: { name: 'rival_vendor', description: 'the competitor named on the deal' } } } },
    } };
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return prompts.length === 1
          ? 'NO_SQL: No competitor column is available in sales.opportunities.'
          : "SELECT COUNT(*) AS lost_deals FROM sales.opportunities o JOIN crm.deal_notes d ON d.deal_ref = o.deal_ref WHERE LOWER(o.stage) = 'closed lost' AND LOWER(d.rival_vendor) = 'splunk'";
      },
    };
    const statements: string[] = [];
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-wide',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('information_schema.columns')) {
          const rows = [
            ...(/'opportunities'/.test(sql) ? ['opportunity_id', 'deal_ref', 'stage'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: 'VARCHAR' })) : []),
            ...(/'deal_notes'/.test(sql) ? ['deal_ref', 'rival_vendor'].map((column) => ({ table_schema: 'crm', table_name: 'deal_notes', column_name: column, data_type: 'VARCHAR' })) : []),
          ];
          return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
        }
        return { columns: ['lost_deals'], rowCount: 1, executionTimeMs: 1, rows: [{ lost_deals: 4 }] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-wide', manifest: wide as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
    });
    const result = await ask(route);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('crm.deal_notes');
    expect(prompts[1]).toContain('crm.deal_notes');
    expect(prompts[1]).toContain('NOTE: A first draft over sales.opportunities found no field for this');
    expect(result.status).toBe('completed');
    expect(result.askPipelineReceipt?.story?.some((entry) => entry.title === 'Searched every table for the missing field: found crm.deal_notes')).toBe(true);
  });

  it('what the user said in the conversation chooses tables and reaches the draft', async () => {
    const wide = { sources: {
      opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { deal_ref: { name: 'deal_ref' }, stage: { name: 'stage' } } } },
      deal_notes: { name: 'deal_notes', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.deal_notes', schema: 'crm', columns: { deal_ref: { name: 'deal_ref' }, rival_vendor: { name: 'rival_vendor' } } } },
    } };
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-context',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        const rows = sql.includes('information_schema.columns') ? [
          ...(/'opportunities'/.test(sql) ? ['deal_ref', 'stage'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: 'VARCHAR' })) : []),
          ...(/'deal_notes'/.test(sql) ? ['deal_ref', 'rival_vendor'].map((column) => ({ table_schema: 'crm', table_name: 'deal_notes', column_name: column, data_type: 'VARCHAR' })) : []),
        ] : [];
        return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-context', manifest: wide as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
      conversation: () => ({ summary: 'The user said the competitor is kept in the deal notes rival vendor field.' }),
    });
    await ask(route);
    expect(prompts[0]).toContain('crm.deal_notes');
    expect(prompts[0]).toContain('CONTEXT:\n- conversation so far: The user said the competitor is kept in the deal notes rival vendor field.');
  });

  it('a decline is an honest gap: nothing is executed beyond describing the table', async () => {
    const provider = drafter('NO_SQL: nothing in sales.opportunities records a lost deal count by quarter of the fiscal calendar.');
    const statements: string[] = [];
    const result = await ask(routeFor(provider, statements));
    expect(provider.draftPrompts).toHaveLength(1);
    expect(statements.every((sql) => sql.includes('information_schema'))).toBe(true);
    expect(result.status).not.toBe('completed');
    expect(JSON.stringify(result)).toContain('nothing in sales.opportunities records a lost deal count');
  });
});
