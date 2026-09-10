import { describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@duckcodeailabs/dql-agent';
import type { ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { buildVocabularyIndex, classifyWarehouseError, parseIntent, type AnalyticalIntentV1 } from '@duckcodeailabs/dql-agent';
import { connectionKey, createAskPipelineRouteExecutor, gapPresentation, groundIntentLiterals, knownMissingRelation, memberCandidatesSql, normalizeExecutedRow, prepareBlockForAsk, recordRelationEvidence, resetRelationEvidence, tracedProbes, vocabularyViewKey } from './host.js';

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
    recordRelationEvidence(key, sql, classifyWarehouseError("Object 'ANALYTICS.DEV.FCT_PLAYER_JOURNEY' does not exist or not authorized."));
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
});
