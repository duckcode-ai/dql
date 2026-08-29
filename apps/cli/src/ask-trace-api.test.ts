import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import {
  AskTraceSqliteStoreV1,
  buildMeaningEvidencePackage,
  createAskTraceObserverV1,
  defaultAskTraceSqlitePath,
  exportAskTraceBundleV1,
  buildAnalyticalRequirementSet,
  buildLocalContextPack,
  recordAuthoritativeRouterDecisionV1,
  replayAskTraceReceiptV1,
  toAgentRetrievalEvidence,
  validateAskTraceBundleV1,
  type AgentProvider,
  type AgentRunRequest,
  type AgentRunExecutors,
} from '@duckcodeailabs/dql-agent';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import {
  CLI_ASK_TRACE_CAPABILITY_TTL_MS,
  askTraceQuestionPreview,
  createLocalCliAskTraceCapabilityRegistryV1,
  isAskTraceClientDetailPath,
  startLocalServer,
} from './local-runtime.js';
import { runCanonicalCliAsk } from './commands/agent.js';

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-ask-trace-api-'));
  directories.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'ask-trace-api' }));
  return root;
}

async function start(root: string, options: {
  agentRunExecutors?: AgentRunExecutors;
  executor?: QueryExecutor;
  connection?: ConnectionConfig;
  requireMeaningCallForNaturalLanguage?: boolean;
  askAnalyticalPlannerProviderFactory?: (input: {
    projectRoot: string;
    request: AgentRunRequest;
  }) => AgentProvider | null | Promise<AgentProvider | null>;
} = {}): Promise<string> {
  let server: Server | undefined;
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor: options.executor ?? {} as QueryExecutor,
    preferredPort: 0,
    ...(options.connection ? { connection: options.connection } : {}),
    ...(options.agentRunExecutors ? { agentRunExecutors: options.agentRunExecutors } : {}),
    ...(options.requireMeaningCallForNaturalLanguage !== undefined
      ? { requireMeaningCallForNaturalLanguage: options.requireMeaningCallForNaturalLanguage }
      : {}),
    ...(options.askAnalyticalPlannerProviderFactory
      ? { askAnalyticalPlannerProviderFactory: options.askAnalyticalPlannerProviderFactory }
      : {}),
    captureServer: (created) => { server = created; },
  });
  if (!server) throw new Error('Local runtime server was not captured.');
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

describe('local Ask trace API errors (OBS-009)', () => {
  it('attributes CLI traces only through a one-shot, scoped, loopback runtime capability', () => {
    let now = 1_000;
    const registry = createLocalCliAskTraceCapabilityRegistryV1({
      now: () => now,
      mint: () => 'server-minted',
    });
    const minted = registry.issue();
    expect(minted).toMatchObject({ capability: 'server-minted', scope: 'agent-runs' });

    // A client-written surface/header is not enough. The caller falls back to
    // the browser surface when a capability cannot be consumed.
    expect(registry.consume({ capability: undefined, scope: 'agent-runs', loopbackServer: true, remoteAddress: '127.0.0.1' })).toBeUndefined();
    expect(registry.consume({ capability: 'browser-supplied', scope: 'agent-runs', loopbackServer: true, remoteAddress: '127.0.0.1' })).toBeUndefined();
    expect(registry.consume({ capability: ['server-minted'], scope: 'agent-runs', loopbackServer: true, remoteAddress: '127.0.0.1' })).toBeUndefined();
    expect(registry.consume({ capability: 'server-minted', scope: 'agent-runs', loopbackServer: false, remoteAddress: '127.0.0.1' })).toBeUndefined();
    expect(registry.consume({ capability: 'server-minted', scope: 'agent-runs', loopbackServer: true, remoteAddress: '192.0.2.5' })).toBeUndefined();

    expect(registry.consume({ capability: minted.capability, scope: 'agent-runs', loopbackServer: true, remoteAddress: '::ffff:127.0.0.1' })).toBe('cli');
    // Capabilities cannot be replayed after a single AgentRun admission.
    expect(registry.consume({ capability: minted.capability, scope: 'agent-runs', loopbackServer: true, remoteAddress: '127.0.0.1' })).toBeUndefined();

    const expiring = registry.issue({ capability: 'expires', ttlMs: 1 });
    now += 2;
    expect(registry.consume({ capability: expiring.capability, scope: 'agent-runs', loopbackServer: true, remoteAddress: '127.0.0.1' })).toBeUndefined();

    const scoped = registry.issue({ capability: 'wrong-scope' });
    expect(registry.consume({
      capability: scoped.capability,
      scope: 'other-scope' as 'agent-runs',
      loopbackServer: true,
      remoteAddress: '127.0.0.1',
    })).toBeUndefined();
    expect(CLI_ASK_TRACE_CAPABILITY_TTL_MS).toBe(30_000);
  });

  it('mints a capability only from a loopback local runtime and marks it no-store', async () => {
    const base = await start(project());
    const response = await fetch(`${base}/api/ask-traces/cli-capability`);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      capability: expect.any(String),
      expiresAt: expect.any(String),
      scope: 'agent-runs',
    });
  });

  it('sets surface=cli only after a server-issued capability is consumed by an AgentRun', async () => {
    const answer = () => ({
      answer: 'Recorded through the canonical engine.',
      status: 'needs_review' as const,
      trustState: 'review_required' as const,
      stopReason: 'human_review_required' as const,
      artifacts: [], evaluations: [], nextActions: [],
    });
    const base = await start(project(), {
      agentRunExecutors: {
        conversation: answer,
        generated_answer: answer,
      },
    });
    const capabilityResponse = await fetch(`${base}/api/ask-traces/cli-capability`);
    const capability = (await capabilityResponse.json()) as { capability: string };
    const requestBody = {
      question: 'thanks, walk me through the prior customer result',
      requestedMode: 'ask',
      conversationContext: { priorMeasures: ['revenue'], resultColumns: ['customer_name', 'revenue'] },
      // This public value must be ignored; the header capability is the only
      // accepted source of CLI attribution.
      workspaceContext: { surface: 'cli' },
    };
    const create = async (header?: string) => {
      const response = await fetch(`${base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(header ? { 'X-DQL-Ask-Trace-Capability': header } : {}) },
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { run: { id: string; traceReference?: { traceId: string } } };
    };
    const cliRun = await create(capability.capability);
    // The same copied header cannot relabel a second request.
    const browserRun = await create(capability.capability);
    expect(cliRun.run.traceReference?.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(browserRun.run.traceReference?.traceId).toMatch(/^[a-f0-9]{32}$/);

    const readTrace = async (traceId: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await fetch(`${base}/api/ask-traces/${traceId}`);
        if (response.status === 200) return response.json() as Promise<{ envelope: { surface: string } }>;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Trace detail did not flush.');
    };
    await expect(readTrace(cliRun.run.traceReference!.traceId)).resolves.toMatchObject({ envelope: { surface: 'cli' } });
    await expect(readTrace(browserRun.run.traceReference!.traceId)).resolves.toMatchObject({ envelope: { surface: 'browser' } });
  });

  it('omits a sensitive question from the catalog while keeping trace persistence prompt-free', async () => {
    const base = await start(project(), {
      agentRunExecutors: {
        conversation: () => ({
          answer: 'Hello from the deterministic conversation executor.',
          status: 'completed' as const,
          trustState: 'not_applicable' as const,
          stopReason: 'conversational_reply' as const,
          artifacts: [], evaluations: [], nextActions: [],
        }),
      },
    });
    const secret = 'very-secret-preview-token';
    const question = `hello api_key: ${secret}`;
    const create = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'ask' }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { run: { id: string } };

    let entry: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await fetch(`${base}/api/ask-traces?mode=ask&surface=browser&limit=10`);
      if (listed.status === 200) {
        const body = await listed.json() as { traces: Array<Record<string, unknown>> };
        entry = body.traces.find((trace) => trace.runId === created.run.id);
        if (entry) break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(entry).toMatchObject({
      runId: created.run.id,
      scenarioLabel: expect.any(String),
    });
    expect(entry).not.toHaveProperty('questionPreview');
    expect(entry).not.toHaveProperty('question');
    expect(JSON.stringify(entry)).not.toContain(secret);
    const traceId = typeof entry?.traceId === 'string' ? entry.traceId : undefined;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain(secret);
    const strictExport = await fetch(`${base}/api/ask-traces/${traceId}/export?profile=strict`);
    expect(strictExport.status).toBe(200);
    expect(await strictExport.text()).not.toContain(secret);
  });

  it('only permits a short generic catalog preview and omits attack strings', () => {
    expect(askTraceQuestionPreview('Which customers have the highest revenue?'))
      .toBe('Which customers have the highest revenue?');
    const attacks = [
      'Show customer "Brittany Barrera" revenue',
      'SELECT * FROM orders WHERE customer_email = "person@example.com"',
      'Show results from https://example.test/secret',
      'Read /Users/kranthi/.dql/settings.json',
      'Show customer ssn 123-45-6789',
      'Show results for jane.doe@example.com',
      'Call +1 (512) 555-0199',
      'Authorization: Bearer very-secret-token-value',
      'api_key=very-secret-preview-token',
      'Show customers for the current fiscal year with total revenue',
    ];
    for (const attack of attacks) {
      expect(askTraceQuestionPreview(attack), attack).toBeUndefined();
    }
  });

  it('serves only exact Ask client routes through the static SPA fallback', async () => {
    const root = project();
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Ask traces</title>');
    const base = await start(root);
    const validPaths = [
      '/ask',
      '/ask/traces',
      `/ask/traces/${encodeURIComponent('run:office-42')}`,
    ];
    expect(isAskTraceClientDetailPath('/ask/traces/run%3Aoffice-42')).toBe(true);
    for (const validPath of validPaths) {
      const valid = await fetch(`${base}${validPath}`);
      expect(valid.status, validPath).toBe(200);
      expect(await valid.text(), validPath).toContain('Ask traces');
    }

    for (const invalidPath of [
      '/ask/traces/run%2Fchild',
      '/ask/traces/run/nested',
      '/ask/traces/%ZZ',
      '/ask/',
      '/ask/unrelated',
      '/unrelated',
    ]) {
      expect(isAskTraceClientDetailPath(invalidPath), invalidPath).toBe(false);
      const invalid = await fetch(`${base}${invalidPath}`);
      expect(invalid.status, invalidPath).toBe(404);
    }
  });

  it('returns an opaque, stable Ask cache identity that changes for a different local project', async () => {
    const firstRoot = project();
    const secondRoot = project();
    const firstBase = await start(firstRoot);
    const secondBase = await start(secondRoot);
    const first = await (await fetch(`${firstBase}/api/agent/threads`)).json() as {
      threads: unknown[];
      projectIdentity?: string;
    };
    const firstAgain = await (await fetch(`${firstBase}/api/agent/threads`)).json() as {
      projectIdentity?: string;
    };
    const second = await (await fetch(`${secondBase}/api/agent/threads`)).json() as {
      projectIdentity?: string;
    };

    expect(first.threads).toEqual([]);
    expect(first.projectIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstAgain.projectIdentity).toBe(first.projectIdentity);
    expect(second.projectIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.projectIdentity).not.toBe(first.projectIdentity);
    expect(JSON.stringify({ first, second })).not.toContain(firstRoot);
    expect(JSON.stringify({ first, second })).not.toContain(secondRoot);
  });

  it('serializes the selected fiscal clarification span with both the calendar flag and source coverage', async () => {
    const root = project();
    const store = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(root) });
    const observer = createAskTraceObserverV1({
      store,
      runId: 'run-api-fiscal-clarification',
      surface: 'browser',
      mode: 'ask',
      questionFingerprint: 'sha256:api-fiscal-clarification',
    });
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'clarify',
      source: 'heuristic',
      requiresClarification: true,
      retrievalEvidence: { candidateCount: 0, candidateIds: [] },
      analyticalCascadeDecision: {
        version: 1,
        requirements: {
          version: 1,
          measures: ['lost_opportunity_count', 'lost_amount'],
          dimensions: ['month'],
          entityTerms: [],
          entityDisplayTerms: [],
          memberTerms: ['competitor:datadog'],
          time: { role: 'time_axis', grain: 'month', fiscalPeriod: 'FY26', requiresDeclaredFiscalCalendar: true },
        },
        sourceCoverage: [
          { version: 1, source: 'certified', status: 'unavailable', candidateIds: [], reason: 'fixture certified source unavailable' },
          { version: 1, source: 'semantic', status: 'unavailable', candidateIds: [], reason: 'fixture semantic source unavailable' },
          { version: 1, source: 'dbt_manifest', status: 'unavailable', candidateIds: [], reason: 'fixture manifest source unavailable' },
          { version: 1, source: 'runtime_schema', status: 'unavailable', candidateIds: [], reason: 'fixture runtime source unavailable' },
        ],
        attempts: [{
          version: 1,
          tier: 'clarify_or_gap',
          outcome: 'ambiguous',
          candidateIds: [],
          reason: 'fixture requires a declared fiscal calendar and date role',
          planFrozen: false,
        }],
        planFrozen: false,
        stopReason: 'ambiguous',
      },
    } as never);
    const traceId = observer.traceId;
    observer.finalize({ status: 'completed', terminalOutcome: 'needs_clarification' });
    store.close();

    const base = await start(root);
    const response = await fetch(`${base}/api/ask-traces/${traceId}`);
    expect(response.status).toBe(200);
    const trace = await response.json() as {
      envelope: { terminalOutcome?: string; firstIssueSpanId?: string };
      spans: Array<{ spanId: string; name: string; outcome: string; reasonCode: string; payload: { kind?: string; decision?: Record<string, unknown> } }>;
    };
    const selected = trace.spans.find((span) => span.spanId === trace.envelope.firstIssueSpanId);

    expect(trace.envelope.terminalOutcome).toBe('needs_clarification');
    expect(selected).toMatchObject({
      name: 'cascade.clarify_or_gap',
      outcome: 'skipped',
      reasonCode: 'cascade_ambiguous',
      payload: {
        kind: 'cascade',
        decision: expect.objectContaining({
          requiresDeclaredFiscalCalendar: true,
          sourceCoverage: expect.arrayContaining([
            expect.objectContaining({ source: 'certified', status: 'unavailable' }),
            expect.objectContaining({ source: 'semantic', status: 'unavailable' }),
            expect.objectContaining({ source: 'dbt_manifest', status: 'unavailable' }),
            expect.objectContaining({ source: 'runtime_schema', status: 'unavailable' }),
          ]),
        }),
      },
    });
  });

  it('runs direct CLI Ask through the canonical snapshot, cascade, freeze, and SQL trace path', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/jaffle-supply-chain');
    const root = mkdtempSync(join(tmpdir(), 'dql-cli-canonical-trace-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    // Rebuild the immutable metadata snapshot under this temporary project
    // root. The fixture cache is intentionally portable as an input, but its
    // active snapshot lease is bound to the source checkout rather than this
    // per-test copy.
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const oldCassetteDirectory = process.env.DQL_EVAL_CASSETTE_DIR;
    const oldCassetteMode = process.env.DQL_EVAL_CASSETTE_MODE;
    process.env.DQL_EVAL_CASSETTE_DIR = join(root, 'test-cassettes', 'answerability');
    process.env.DQL_EVAL_CASSETTE_MODE = 'replay';
    const executeQuery = vi.fn(async (sql: string) => ({
      columns: ['customer_name', 'count_lifetime_orders'],
      rows: [{ customer_name: 'Fixture Customer', count_lifetime_orders: 3 }],
      rowCount: 1,
      sql,
    }));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const base = await start(root, {
        executor: { executeQuery } as unknown as QueryExecutor,
        connection: { driver: 'duckdb', filepath: join(root, 'jaffle_shop.duckdb') },
      });
      await runCanonicalCliAsk('what is the order count for each customer?', undefined, {
        runtimeUrl: base,
        format: 'json',
      } as any);

      const output = JSON.parse(String(printed.mock.calls.at(-1)?.[0])) as {
        runId?: string;
        traceId?: string;
        traceRecordingStatus?: string;
      };
      expect(output).toMatchObject({
        runId: expect.any(String),
        traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(executeQuery.mock.calls.length, JSON.stringify(output)).toBe(1);
      const list = await fetch(`${base}/api/ask-traces?limit=10`);
      await expect(list.json()).resolves.toMatchObject({ traces: [expect.objectContaining({ runId: output.runId })] });

      let detail: { envelope: { surface: string }; spans: Array<{ name: string }>; candidateDecisions: unknown[] } | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(`${base}/api/ask-traces/${output.traceId}`);
        if (response.status === 200) {
          detail = await response.json() as typeof detail;
          break;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(detail).toMatchObject({ envelope: { surface: 'cli' } });
      expect(detail?.candidateDecisions.length).toBeGreaterThan(0);
      expect(detail?.spans.map((span) => span.name)).toEqual(expect.arrayContaining([
        'snapshot.acquire',
        'retrieval',
        'cascade.evaluate',
        'plan.freeze',
        'sql.generate',
        'sql.validate',
        'sql.authorize',
        'sql.execute',
      ]));
    } finally {
      if (oldCassetteDirectory === undefined) delete process.env.DQL_EVAL_CASSETTE_DIR;
      else process.env.DQL_EVAL_CASSETTE_DIR = oldCassetteDirectory;
      if (oldCassetteMode === undefined) delete process.env.DQL_EVAL_CASSETTE_MODE;
      else process.env.DQL_EVAL_CASSETTE_MODE = oldCassetteMode;
    }
  });

  it('keeps BCM out of the real office-fixture Revenue reservation package before semantic cascade execution', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-revenue-runtime-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'Who are the top BCM customers who have highest revenue?';
    const pack = await buildLocalContextPack(root, { question, mode: 'question', limit: 80 });
    const packEvidence = toAgentRetrievalEvidence(pack.retrievalDiagnostics.meaningEvidence!, pack.questionPlan, {
      snapshotId: pack.knowledgeLens.snapshotId,
      sourceFingerprint: pack.freshness.fingerprint ?? undefined,
      knowledgeLens: pack.knowledgeLens,
      contextObjects: pack.objects,
      retrievalLanes: pack.retrievalDiagnostics.lanes,
    });
    const packRequirements = buildAnalyticalRequirementSet({ question, parsedIntent: packEvidence.parsedIntent });
    const packBcm = packEvidence.candidates.find((candidate) => candidate.id === 'semantic:metric:account_revenue.bcm_run_rate');
    expect(packRequirements.ranking, JSON.stringify({ parsedIntent: packEvidence.parsedIntent, bcm: packBcm }))
      .toMatchObject({ metricTerms: ['revenue'], limit: 10, defaultedLimit: true });

    const semanticAnswer = vi.fn(() => ({
      answer: 'Synthetic semantic answer.',
      status: 'completed' as const,
      trustState: 'governed' as const,
      stopReason: 'governed_semantic_answer' as const,
      artifacts: [], evaluations: [], nextActions: [],
    }));
    const base = await start(root, {
      // The real local context-pack, retrieval, package, cascade, and trace
      // callbacks remain in place. This only prevents a live provider from
      // becoming a dependency of the fixture assertion.
      requireMeaningCallForNaturalLanguage: false,
      agentRunExecutors: { semantic_answer: semanticAnswer },
    });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        requestedMode: 'ask',
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        status?: string;
        routeDecision?: {
          requiresClarification?: boolean;
          meaningResolution?: { queryIntent?: { limit?: number; measures?: string[] } };
          analyticalCascadeDecision?: { selectedTier?: string; planFrozen?: boolean };
        };
        traceReference?: { traceId?: string };
      };
    };
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);

    let detail: {
      candidateDecisions: Array<{ candidateId: string; role: string; decision: string; reasonCode: string }>;
      spans?: Array<{ name: string; payload?: unknown }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const trace = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (trace.status === 200) {
        detail = await trace.json() as typeof detail;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    const bcmDecisions = detail?.candidateDecisions
      .filter((decision) => /bcm_run_rate/i.test(decision.candidateId) && decision.role === 'metric')
      .map((decision) => [decision.decision, decision.reasonCode]);
    expect(body.run.route, JSON.stringify({
      routeDecision: body.run.routeDecision,
      bcmDecisions,
      cascadeSpans: detail?.spans?.filter((span) => span.name === 'cascade.evaluate'),
    })).toBe('semantic_answer');
    expect(body.run.status).not.toBe('needs_clarification');
    expect(body.run.routeDecision).toMatchObject({
      requiresClarification: false,
      // The verifier persists the canonical semantic metric after it proves
      // the requested business term. This is the immutable planning identity,
      // not a second lexical interpretation of "revenue".
      meaningResolution: { queryIntent: { measures: ['account_revenue.revenue'], limit: 10 } },
      analyticalCascadeDecision: { selectedTier: 'semantic', planFrozen: true },
    });
    expect(semanticAnswer).toHaveBeenCalledTimes(1);
    expect(bcmDecisions).toEqual(expect.arrayContaining([
      ['retrieved', expect.any(String)],
      ['excluded', 'explicit_measure_conflict'],
    ]));
    expect(bcmDecisions).not.toEqual(expect.arrayContaining([
      ['reserved', expect.any(String)],
      ['admitted', expect.any(String)],
      ['model_selected', expect.any(String)],
    ]));
  });

  it('executes the frozen office-fixture Revenue semantic plan without a provider or generated-route relabel', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-revenue-semantic-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'Who are the top BCM customers who have highest revenue?';
    const executeQuery = vi.fn(async (sql: string) => ({
      columns: ['customer_name', 'revenue'],
      rows: [{ customer_name: 'Synthetic Customer', revenue: 100 }],
      rowCount: 1,
      sql,
    }));
    const base = await start(root, {
      // The semantic compiler/answer loop is the production path. The local
      // executor supplies only deterministic synthetic result rows; it is not
      // an AgentRun route executor and cannot choose/relabel a route. The
      // built-in file driver avoids boot-time installation of the optional
      // native DuckDB connector, which this mocked routing/trace test never
      // loads.
      requireMeaningCallForNaturalLanguage: false,
      executor: { executeQuery } as unknown as QueryExecutor,
      connection: { driver: 'file', filepath: join(root, 'synthetic.duckdb') },
    });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        status?: string;
        trustState?: string;
        stopReason?: string;
        answer?: string;
        businessAnswer?: {
          mode?: string;
          factIds?: string[];
          resultFingerprint?: string;
        };
        artifacts?: Array<{ payload?: { result?: { resultFingerprint?: string; answerTier?: string } } }>;
        routeDecision?: {
          meaningResolution?: { selectedConceptIds?: string[]; recommendedExecutionId?: string };
          analyticalCascadeDecision?: { selectedTier?: string; planFrozen?: boolean };
          resolvedAnalyticalPlan?: { planId?: string; executionId?: string; selectedConceptIds?: string[] };
        };
        traceReference?: { traceId?: string };
      };
    };
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);

    let detail: {
      envelope: { terminalOutcome?: string };
      spans: Array<{
        name: string;
        outcome: string;
        payload?: { kind?: string; resultFingerprint?: string; trustState?: string; rowCount?: number };
      }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const trace = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (trace.status === 200) {
        detail = await trace.json() as typeof detail;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(body.run, JSON.stringify({ run: body.run, spans: detail?.spans })).toMatchObject({
      route: 'semantic_answer',
      status: 'completed',
      trustState: 'governed',
      stopReason: 'governed_semantic_answer',
      routeDecision: {
        meaningResolution: {
          // The route-neutral program retains both the requested metric and
          // the required customer display dimension. Dropping the dimension
          // here would make the frozen semantic tuple incomplete.
          selectedConceptIds: [
            'semantic:metric:account_revenue.revenue',
            'semantic:dimension:account_revenue.customer_name',
          ],
          recommendedExecutionId: 'semantic:metric:account_revenue.revenue',
        },
        analyticalCascadeDecision: { selectedTier: 'semantic', planFrozen: true },
        resolvedAnalyticalPlan: {
          // Router candidate IDs are projected to canonical semantic plan
          // identities without losing the display dimension the program
          // needs to produce the requested ranked rows.
          selectedConceptIds: [
            'semantic:account_revenue:revenue',
            'semantic:uncategorized:dimension:customer_name',
          ],
          executionId: 'semantic:account_revenue:revenue',
        },
      },
    });
    expect(body.run.artifacts?.[0]?.payload?.result).toMatchObject({
      resultFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      answerTier: 'semantic_metric',
    });
    const resultFingerprint = body.run.artifacts?.[0]?.payload?.result?.resultFingerprint;
    expect(body.run.businessAnswer).toMatchObject({
      mode: 'facts_only',
      resultFingerprint,
    });
    expect(body.run.businessAnswer?.factIds?.length).toBeGreaterThan(0);
    expect(body.run.answer).toContain('Synthetic Customer');
    expect(detail?.spans.find((span) => span.name === 'result.normalize')?.payload).toMatchObject({
      kind: 'result',
      resultFingerprint,
      trustState: 'governed',
      rowCount: 1,
    });
    // The runtime may inspect the configured local target while resolving the
    // semantic table mapping. The trace records the one authoritative semantic
    // statement handed to execution, rather than treating those setup probes as
    // a second answer query.
    expect(executeQuery).toHaveBeenCalled();
    expect(detail?.spans.filter((span) => span.name === 'sql.execute')).toHaveLength(1);
    expect(detail?.spans.map((span) => span.name)).toEqual(expect.arrayContaining([
      'cascade.evaluate',
      'plan.freeze',
      'sql.execute',
    ]));
    // The semantic compiler has already performed its adapter-owned checks.
    // Do not fabricate generated-SQL stages after the fact.
    expect(detail?.spans.map((span) => span.name)).not.toContain('sql.generate');
    expect(detail?.spans.map((span) => span.name)).not.toContain('sql.validate');
    expect(detail?.spans.map((span) => span.name)).not.toContain('sql.authorize');
    expect(detail?.spans.map((span) => span.name)).not.toContain('provider.attempt');
  });

  it('keeps a frozen office-fixture semantic plan semantic when no execution target is configured', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-revenue-semantic-no-target-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const base = await start(root, { requireMeaningCallForNaturalLanguage: false });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Who are the top BCM customers who have highest revenue?',
        requestedMode: 'ask',
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        status?: string;
        trustState?: string;
        stopReason?: string;
        routeDecision?: { analyticalCascadeDecision?: { selectedTier?: string; planFrozen?: boolean } };
        artifacts?: Array<{
          payload?: {
            analyticalFailure?: { code?: string };
            observabilityExecutionFailure?: { cause?: string; safeAction?: string };
            frozenPlanFailureCode?: string;
          };
        }>;
        evaluations?: Array<{ id?: string; evidence?: { reportedRoute?: string } }>;
        telemetry?: { providerRoundTrips?: number; toolCalls?: number; sqlExecutions?: number };
        diagnosticReceiptV4?: {
          summary?: {
            summaryFingerprint?: string;
            terminalIncident?: { code?: string; boundary?: string; origin?: string; impact?: string; safeAction?: string };
            safeNextAction?: string;
          };
        };
        traceReference?: { traceId?: string };
      };
    };
    expect(body.run, JSON.stringify(body.run)).toMatchObject({
      route: 'semantic_answer',
      status: 'blocked',
      trustState: 'blocked',
      stopReason: 'blocked',
      routeDecision: { analyticalCascadeDecision: { selectedTier: 'semantic', planFrozen: true } },
    });
    expect(body.run.artifacts?.[0]?.payload).toMatchObject({
      analyticalFailure: { code: 'COMPILATION_FAILED' },
      // The broad analytical failure remains backward-readable, while the
      // producer-tagged setup receipt is authoritative for trace narration.
      observabilityExecutionFailure: {
        cause: 'connection_not_configured',
        safeAction: 'configure_connection',
      },
    });
    expect(body.run.evaluations?.map((evaluation) => evaluation.id)).not.toContain('frozen-plan-route-mismatch');
    expect(body.run.evaluations?.some((evaluation) => evaluation.evidence?.reportedRoute === 'generated_answer')).not.toBe(true);
    expect(body.run.telemetry).toMatchObject({ providerRoundTrips: 0, toolCalls: 0, sqlExecutions: 0 });
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let detail: {
      envelope: { firstIssueSpanId?: string };
      decisionSummary?: {
        summaryFingerprint?: string;
        terminalIncident?: { code?: string; boundary?: string; origin?: string; impact?: string; safeAction?: string };
        safeNextAction?: string;
      };
      spans: Array<{
        spanId: string;
        name: string;
        outcome: string;
        reasonCode: string;
        payload?: { kind?: string; failureCode?: string; safeAction?: string };
      }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const trace = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (trace.status === 200) {
        detail = await trace.json() as typeof detail;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(detail?.spans.map((span) => span.name)).not.toContain('provider.attempt');
    expect(detail?.spans.map((span) => span.name)).not.toContain('tool.call');
    expect(detail?.spans.map((span) => span.name)).not.toContain('sql.execute');
    // This is the actual local API serialization, rather than a UI-only
    // fixture: the frozen semantic plan reached its host setup boundary, but
    // no connector received SQL. It must not be recast as compilation or a
    // completed result merely because the semantic graph caught the callback.
    const terminalFailure = detail?.spans.find((span) => span.name === 'result.normalize' && span.reasonCode === 'post_freeze_failure');
    expect(terminalFailure).toMatchObject({
      outcome: 'error',
      payload: { kind: 'result', failureCode: 'CONNECTION_NOT_CONFIGURED', safeAction: 'configure_connection' },
    });
    expect(detail?.envelope.firstIssueSpanId).toBe(terminalFailure?.spanId);
    expect(detail?.spans.some((span) => span.name === 'result.normalize' && span.outcome === 'ok')).toBe(false);
    // Both API consumers receive the one stored V4 summary; neither may derive
    // a different safe action from a span or a generic blocked status.
    expect(body.run.diagnosticReceiptV4?.summary).toMatchObject({
      summaryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      terminalIncident: {
        code: 'CONNECTION_NOT_CONFIGURED',
        boundary: 'sql.execute',
        origin: 'governance_gate',
        impact: 'execution_not_attempted',
        safeAction: 'configure_connection',
      },
      safeNextAction: 'configure_connection',
    });
    expect(detail?.decisionSummary).toEqual(body.run.diagnosticReceiptV4?.summary);
  });

  it('AGT-011/OBS-012 resumes the real office display-key clarification after restart without reparsing Revenue/top-10', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-structured-display-continuation-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'Show the top names by revenue';
    const firstBase = await start(root, { requireMeaningCallForNaturalLanguage: false });
    const threadResponse = await fetch(`${firstBase}/api/agent/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface: 'ask', title: 'Structured display clarification' }),
    });
    expect(threadResponse.status).toBe(201);
    const thread = await threadResponse.json() as { thread: { id: string } };

    const initialResponse = await fetch(`${firstBase}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'ask', threadId: thread.thread.id }),
    });
    expect(initialResponse.status).toBe(201);
    const initial = await initialResponse.json() as {
      run: {
        status?: string;
        clarificationOptions?: Array<{ id: string; label: string }>;
      };
    };
    expect(initial.run.status).toBe('needs_clarification');
    const accountName = initial.run.clarificationOptions?.find((option) => option.label === 'Account Name');
    const customerName = initial.run.clarificationOptions?.find((option) => option.label === 'Customer Name');
    expect(accountName?.id, JSON.stringify(initial.run.clarificationOptions)).toBe('semantic:uncategorized:dimension:account_revenue.account_name');
    expect(customerName?.id).toBe('semantic:uncategorized:dimension:account_revenue.customer_name');

    const persistedResponse = await fetch(`${firstBase}/api/agent/threads/${encodeURIComponent(thread.thread.id)}`);
    expect(persistedResponse.status).toBe(200);
    const persisted = await persistedResponse.json() as {
      turns: Array<{
        question?: string;
        contract?: { clarificationSelection?: { requirements?: { measures?: string[]; ranking?: { limit?: number; defaultedLimit?: boolean } } } };
      }>;
    };
    expect(persisted.turns.at(-1)).toMatchObject({
      question,
      contract: {
        clarificationSelection: {
          requirements: {
            measures: expect.arrayContaining(['revenue']),
            ranking: { limit: 10, defaultedLimit: true },
          },
        },
      },
    });

    // A browser reload/runtime restart supplies no client-built conversation
    // state. The next local server must reconstruct the server-issued pending
    // clarification from its persisted thread before accepting the stable ID.
    const firstServer = servers.pop();
    await new Promise<void>((done) => firstServer ? firstServer.close(() => done()) : done());
    const base = await start(root, { requireMeaningCallForNaturalLanguage: false });
    const selectedResponse = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        clarificationSourceQuestion: question,
        selectedEvidenceId: accountName!.id,
        requestedMode: 'ask',
        threadId: thread.thread.id,
      }),
    });
    expect(selectedResponse.status).toBe(201);
    const selected = await selectedResponse.json() as {
      run: {
        route?: string;
        status?: string;
        telemetry?: { providerRoundTrips?: number };
        routeDecision?: {
          meaningResolution?: { selectedConceptIds?: string[]; recommendedExecutionId?: string; queryIntent?: { limit?: number; measures?: string[] } };
          analyticalCascadeDecision?: { selectedTier?: string; planFrozen?: boolean };
        };
        traceReference?: { traceId?: string };
      };
    };
    expect(selected.run.route).toBe('semantic_answer');
    expect(selected.run).toMatchObject({
      route: 'semantic_answer',
      status: 'blocked',
      telemetry: { providerRoundTrips: 0 },
      routeDecision: {
        meaningResolution: {
          recommendedExecutionId: 'semantic:metric:account_revenue.revenue',
          queryIntent: { measures: ['account_revenue.revenue'], limit: 10 },
          selectedConceptIds: expect.arrayContaining([
            'semantic:metric:account_revenue.revenue',
            accountName!.id,
          ]),
        },
        analyticalCascadeDecision: { selectedTier: 'semantic', planFrozen: true },
      },
    });
    const traceId = selected.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: {
      spans: Array<{
        name: string;
        outcome: string;
        payload?: { kind?: string; continuation?: boolean; selectedCandidateIds?: string[] };
      }>;
      links: Array<{ kind: string }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        trace = await detail.json() as typeof trace;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(trace?.spans.find((span) => span.name === 'conversation.hydrate')).toMatchObject({
      outcome: 'ok',
      payload: { kind: 'conversation', continuation: true },
    });
    expect(trace?.spans.find((span) => span.name === 'meaning.resolve')).toMatchObject({
      payload: {
        kind: 'meaning',
        selectedCandidateIds: expect.arrayContaining([
          'semantic:metric:account_revenue.revenue',
          accountName!.id,
        ]),
      },
    });
    expect(trace?.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'clarification_continuation' }),
    ]));
    expect(trace?.spans.some((span) => span.name === 'provider.attempt')).toBe(false);
  });

  it('routes the real current-BCM top-account snapshot through a semantic tuple without inventing a time axis', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-current-bcm-semantic-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'What is the current BCM run rate across top accounts?';

    // Exercise the exact fixture snapshot/package before starting the API.
    // `account_name` is deliberately low-ranked in fused retrieval, so this
    // proves role reservation rather than a test-only narrowed candidate set.
    const pack = await buildLocalContextPack(root, { question, mode: 'question', limit: 80 });
    const evidence = toAgentRetrievalEvidence(pack.retrievalDiagnostics.meaningEvidence!, pack.questionPlan, {
      snapshotId: pack.knowledgeLens.snapshotId,
      sourceFingerprint: pack.freshness.fingerprint ?? undefined,
      knowledgeLens: pack.knowledgeLens,
      contextObjects: pack.objects,
      retrievalLanes: pack.retrievalDiagnostics.lanes,
    });
    const requirements = buildAnalyticalRequirementSet({ question, parsedIntent: evidence.parsedIntent });
    const meaningPackage = buildMeaningEvidencePackage(evidence, 16, question);
    expect(requirements).toMatchObject({
      entityTerms: ['account'],
      entityDisplayTerms: ['account name'],
      ranking: { metricTerms: ['bcm run rate'], limit: 10, defaultedLimit: true },
    });
    expect(requirements.time).toBeUndefined();
    expect(meaningPackage.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      'semantic:metric:account_revenue.bcm_run_rate',
      'dbt:column:dim_accounts.account_name',
    ]));
    expect(meaningPackage.map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining([
      'dbt:column:dim_accounts.account_sentiment_rating',
      'dbt:column:dim_accounts.account_owner_email',
      'dbt:column:dim_accounts.account_owner_name',
    ]));

    // A true time-series phrase still creates the explicit time requirement.
    const monthlyRequirements = buildAnalyticalRequirementSet({
      question: 'Show BCM run rate by month across top accounts.',
      parsedIntent: { measures: ['BCM run rate'], dimensions: ['account'], filters: [], timeGrain: 'month' },
    });
    expect(monthlyRequirements.time).toMatchObject({ role: 'time_axis', grain: 'month' });

    // No semantic execution target is configured. This must be a truthful
    // same-tier post-freeze compilation failure, never a pre-route
    // MISSING_DIMENSION refusal or a generated/provider fallback.
    const base = await start(root, { requireMeaningCallForNaturalLanguage: false });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        status?: string;
        trustState?: string;
        stopReason?: string;
        routeDecision?: {
          analyticalCascadeDecision?: {
            selectedTier?: string;
            planFrozen?: boolean;
            requirements?: { time?: unknown; ranking?: { limit?: number } };
            attempts?: Array<{ tier: string; planFrozen: boolean }>;
          };
        };
        artifacts?: Array<{ payload?: { analyticalFailure?: { code?: string } } }>;
        traceReference?: { traceId?: string };
      };
    };
    const cascade = body.run.routeDecision?.analyticalCascadeDecision;
    expect(body.run.route).toBe('semantic_answer');
    expect(body.run.status).toBe('blocked');
    expect(body.run.trustState).toBe('blocked');
    expect(body.run.stopReason).toBe('blocked');
    expect(cascade?.selectedTier).toBe('semantic');
    expect(cascade?.planFrozen).toBe(true);
    expect(cascade?.attempts?.map((attempt) => [attempt.tier, attempt.planFrozen])).toEqual([
      ['certified', false],
      ['semantic', true],
    ]);
    expect(cascade?.requirements?.ranking?.limit).toBe(10);
    expect(cascade?.requirements?.time).toBeUndefined();
    expect(body.run.artifacts?.[0]?.payload?.analyticalFailure?.code).toBe('COMPILATION_FAILED');
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);

    let detail: {
      candidateDecisions: Array<{ candidateId: string; role: string; decision: string; reasonCode: string }>;
      spans: Array<{ name: string; outcome: string; reasonCode: string }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const trace = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (trace.status === 200) {
        detail = await trace.json() as typeof detail;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    const decisions = detail?.candidateDecisions ?? [];
    expect(decisions.find((decision) =>
      decision.candidateId === 'dbt:column:dim_accounts.account_name'
      && decision.role === 'entity_label'
      && decision.decision === 'admitted')).toBeDefined();
    expect(decisions.find((decision) =>
      decision.candidateId === 'dbt:column:dim_accounts.account_sentiment_rating'
      && decision.role === 'categorical_dimension'
      && decision.decision === 'excluded')).toMatchObject({ reasonCode: 'entity_label_mismatch' });
    expect(decisions.find((decision) =>
      decision.candidateId === 'dbt:column:dim_accounts.account_owner_email'
      && decision.role === 'categorical_dimension'
      && decision.decision === 'excluded')).toMatchObject({ reasonCode: 'entity_label_mismatch' });
    expect(detail?.candidateDecisions.filter((decision) =>
      decision.candidateId === 'semantic:metric:account_revenue.bcm_run_rate'
      && decision.role === 'time_dimension')).toEqual([]);
    expect(detail?.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cascade.evaluate', outcome: 'ok' }),
      expect.objectContaining({ name: 'plan.freeze', outcome: 'ok' }),
      expect.objectContaining({ name: 'result.normalize', outcome: 'error', reasonCode: 'post_freeze_failure' }),
    ]));
    expect(detail?.spans.some((span) => span.reasonCode === 'missing_dimension')).toBe(false);

    // Reopen the real local WAL read-only and export the same frozen semantic
    // no-target receipt. Validation/replay must remain offline and must not
    // see stale governed/exploratory attempts after the semantic freeze.
    const traceStore = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(root), readOnly: true });
    try {
      const storedTrace = traceStore.get(traceId ?? '');
      expect(storedTrace).toBeDefined();
      const storedCascade = storedTrace?.spans.find((span) => span.name === 'cascade.evaluate');
      const attempts = (storedCascade?.payload as {
        kind?: string;
        decision?: { attempts?: Array<{ tier: string; planFrozen: boolean }> };
      }).decision?.attempts;
      expect(attempts?.map((attempt) => [attempt.tier, attempt.planFrozen])).toEqual([
        ['certified', false],
        ['semantic', true],
      ]);

      const strictBundle = join(root, 'strict-current-bcm-semantic-bundle');
      const receipt = exportAskTraceBundleV1(storedTrace!, {
        profile: 'strict',
        outputDirectory: strictBundle,
        provenance: 'recorded',
      });
      expect(receipt.canaryPassed).toBe(true);
      expect(validateAskTraceBundleV1(strictBundle)).toMatchObject({ valid: true, errors: [] });
      expect(replayAskTraceReceiptV1(strictBundle)).toMatchObject({ valid: true, errors: [] });
    } finally {
      traceStore.close();
    }
  });

  it('keeps the exact office certified title on the zero-provider Tier 1 path with catalog-proven output and grain bindings', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-certified-title-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'Top Customers by Revenue';
    const nonCertifiedExecutor = vi.fn();
    const certifiedAnswer = vi.fn(() => ({
      resolvedRoute: 'certified_answer' as const,
      answerTier: 'certified_block' as const,
      answer: 'Certified fixture block completed through the local test adapter.',
      status: 'completed' as const,
      trustState: 'certified' as const,
      stopReason: 'certified_answer_found' as const,
      artifacts: [
        // This is a deliberately self-consistent old artifact. It remains in
        // the run for inspection, but it must never become final answer
        // authority merely because its facts and narrative cite one another.
        {
          id: 'sql:stale-top-customers',
          kind: 'sql_cell' as const,
          title: 'Stale SQL preview',
          trustState: 'review_required' as const,
          payload: {
            result: {
              columns: ['customer_name', 'lifetime_spend'],
              rows: [{ customer_name: 'Forged stale customer', lifetime_spend: 999999 }],
              rowCount: 1,
              resultFingerprint: 'result:stale-top-customers',
            },
            analyticalFacts: {
              factSetId: 'facts:stale-top-customers',
              resultFingerprint: 'result:stale-top-customers',
              facts: [{ factId: 'fact:stale-top-customers' }],
            },
            analyticalNarrative: {
              factSetId: 'facts:stale-top-customers',
              text: 'FORGED STALE CUSTOMER HAS 999999 LIFETIME SPEND.',
              claims: [{ factIds: ['fact:stale-top-customers'] }],
            },
          },
        },
        {
          id: 'answer:fixture-certified-title',
          kind: 'answer' as const,
          title: 'Certified top customers',
          ref: 'revenue_operations::block::Top Customers by Revenue',
          trustState: 'certified' as const,
          payload: {
            selectedConceptIds: ['revenue_operations::block::Top Customers by Revenue'],
            // A local certified result has no narration-provider egress. The
            // engine must still project these exact rows into bounded facts and
            // render a useful fact-linked answer for the reader.
            result: {
              columns: ['customer_name', 'lifetime_spend'],
              rows: [{ customer_name: 'Brittany Barrera', lifetime_spend: 2701.72 }],
              rowCount: 1,
              resultFingerprint: 'result:certified-top-customers',
              answerTier: 'certified_block',
            },
          },
        },
      ],
      evaluations: [],
      nextActions: [],
    }));
    const base = await start(root, {
      agentRunExecutors: {
        certified_answer: certifiedAnswer,
        semantic_answer: nonCertifiedExecutor,
        generated_answer: nonCertifiedExecutor,
      },
    });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        status?: string;
        trustState?: string;
        stopReason?: string;
        answer?: string;
        businessAnswer?: { mode?: string; factIds?: string[]; resultFingerprint?: string };
        routeDecision?: {
          meaningResolution?: { selectedConceptIds?: string[] };
          analyticalCascadeDecision?: {
            selectedTier?: string;
            planFrozen?: boolean;
            attempts?: Array<{ tier: string; outcome: string; planFrozen: boolean }>;
          };
        };
        traceReference?: { traceId?: string };
      };
    };
    expect(body.run).toMatchObject({
      route: 'certified_answer', status: 'completed', trustState: 'certified', stopReason: 'certified_answer_found',
      routeDecision: {
        // Router meaning IDs preserve the resolver's stable legacy candidate
        // identity; the immutable frozen plan carries the qualified block ID.
        meaningResolution: { selectedConceptIds: ['dql:block:Top Customers by Revenue'] },
        analyticalCascadeDecision: {
          selectedTier: 'certified', planFrozen: true,
          attempts: [{ tier: 'certified', outcome: 'executable', planFrozen: true }],
        },
      },
    });
    expect(certifiedAnswer).toHaveBeenCalledOnce();
    expect(nonCertifiedExecutor).not.toHaveBeenCalled();
    expect(body.run.businessAnswer).toMatchObject({
      mode: 'facts_only',
      resultFingerprint: 'result:certified-top-customers',
    });
    expect(body.run.businessAnswer?.factIds?.length).toBeGreaterThan(0);
    expect(body.run.answer).toContain('Brittany Barrera');
    expect(body.run.answer).toContain('2701.72');
    expect(body.run.answer).not.toContain('FORGED STALE CUSTOMER');
    expect(body.run.answer).not.toContain('999999');
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);

    let detail: {
      candidateDecisions: Array<{ candidateId: string; role: string; decision: string; reasonCode: string }>;
      spans: Array<{ name: string; stage: string; outcome: string; reasonCode: string }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const trace = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (trace.status === 200) {
        detail = await trace.json() as typeof detail;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(detail?.candidateDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateId: 'dql:block:Top Customers by Revenue', role: 'context',
        decision: 'admitted', reasonCode: 'exact_name_match',
      }),
    ]));
    expect(detail?.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cascade.evaluate', outcome: 'ok', reasonCode: 'cascade_selected' }),
      expect.objectContaining({ name: 'plan.freeze', outcome: 'ok' }),
    ]));
    expect(detail?.spans.some((span) => span.stage === 'provider'), JSON.stringify(detail?.spans)).toBe(false);
  });

  it('persists the frozen certified no-connection failure as typed result evidence across browser, CLI, strict export, and receipt replay', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-certified-no-connection-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'Top Customers by Revenue';
    const executeQuery = vi.fn();
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      requireMeaningCallForNaturalLanguage: false,
    });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const browserBody = await response.json() as {
      run: {
        id: string;
        route?: string;
        status?: string;
        trustState?: string;
        answer?: string;
        routeDecision?: { analyticalCascadeDecision?: { selectedTier?: string; planFrozen?: boolean } };
        traceReference?: { traceId?: string };
      };
    };
    expect(browserBody.run, JSON.stringify(browserBody.run)).toMatchObject({
      route: 'certified_answer',
      status: 'blocked',
      trustState: 'blocked',
      routeDecision: { analyticalCascadeDecision: { selectedTier: 'certified', planFrozen: true } },
    });
    expect(browserBody.run.answer).toContain('No database connection is configured');
    expect(executeQuery).not.toHaveBeenCalled();
    const browserTraceId = browserBody.run.traceReference?.traceId;
    expect(browserTraceId).toMatch(/^[a-f0-9]{32}$/);

    const readTrace = async (traceId: string) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
        if (detail.status === 200) {
          return detail.json() as Promise<{
            envelope: { runId: string; surface: string; firstIssueSpanId?: string };
            spans: Array<{
              spanId: string;
              name: string;
              stage: string;
              outcome: string;
              reasonCode: string;
              payload?: { kind?: string; failureCode?: string; safeAction?: string };
            }>;
          }>;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error(`Trace ${traceId} did not flush.`);
    };

    const browserTrace = await readTrace(browserTraceId!);
    const browserTerminal = browserTrace.spans.find((span) => span.name === 'result.normalize' && span.reasonCode === 'post_freeze_failure');
    expect(browserTerminal).toBeDefined();
    expect(browserTrace.envelope).toMatchObject({ surface: 'browser', runId: browserBody.run.id, firstIssueSpanId: browserTerminal!.spanId });
    expect(browserTerminal).toMatchObject({
      outcome: 'error',
      payload: { kind: 'result', failureCode: 'CONNECTION_NOT_CONFIGURED', safeAction: 'configure_connection' },
    });
    // The deterministic Tier 1 route must not be described as a provider,
    // tool, SQL, or repair attempt merely because older run telemetry planned
    // one.  This is the canonical browser trace that the inline inspector
    // hydrates on demand for its physical performance counters.
    const physicalAttemptNames = new Set(['provider.attempt', 'tool.call', 'sql.execute', 'sql.repair']);
    expect(browserTrace.spans.filter((span) => physicalAttemptNames.has(span.name))).toEqual([]);
    expect(browserTrace.spans.some((span) => span.stage === 'provider' || span.name === 'sql.execute')).toBe(false);

    // The direct CLI uses the same local AgentRun engine. Its concise JSON
    // output must point at a canonical CLI trace with the same typed cause.
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCanonicalCliAsk(question, undefined, { runtimeUrl: base, format: 'json' } as never);
      const cliOutput = JSON.parse(String(printed.mock.calls.at(-1)?.[0])) as { runId?: string; traceId?: string; traceRecordingStatus?: string };
      expect(cliOutput).toMatchObject({
        runId: expect.any(String),
        traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
        traceRecordingStatus: 'complete',
      });
      const cliTrace = await readTrace(cliOutput.traceId!);
      expect(cliTrace.envelope).toMatchObject({ surface: 'cli', runId: cliOutput.runId });
      expect(cliTrace.spans.find((span) => span.name === 'result.normalize' && span.reasonCode === 'post_freeze_failure')).toMatchObject({
        outcome: 'error',
        payload: { failureCode: 'CONNECTION_NOT_CONFIGURED', safeAction: 'configure_connection' },
      });
      expect(cliTrace.spans.filter((span) => physicalAttemptNames.has(span.name))).toEqual([]);
      expect(cliTrace.spans.some((span) => span.stage === 'provider' || span.name === 'sql.execute')).toBe(false);
    } finally {
      printed.mockRestore();
    }

    // Reopen the persisted local WAL and keep strict export/replay content-free.
    const traceStore = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(root), readOnly: true });
    try {
      const persisted = traceStore.get(browserTraceId!);
      expect(persisted).toBeDefined();
      expect(JSON.stringify(persisted)).not.toContain('No database connection is configured');
      const strictBundle = join(root, 'strict-certified-no-connection-bundle');
      exportAskTraceBundleV1(persisted!, {
        profile: 'strict',
        outputDirectory: strictBundle,
        provenance: 'recorded',
        runReceipt: browserBody.run,
      });
      expect(validateAskTraceBundleV1(strictBundle)).toMatchObject({ valid: true, errors: [] });
      expect(replayAskTraceReceiptV1(strictBundle)).toMatchObject({ valid: true, errors: [] });
      const strictTrace = readFileSync(join(strictBundle, 'trace.json'), 'utf8');
      expect(strictTrace).toContain('CONNECTION_NOT_CONFIGURED');
      expect(strictTrace).toContain('configure_connection');
      expect(strictTrace).not.toContain('No database connection is configured');
    } finally {
      traceStore.close();
    }
  });

  it('returns the office un-attributed competitor observation request as a terminal relationship modeling gap without metric choices or execution', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-unattributed-relationship-gap-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'Rank accounts by un-attributed competitor observation signal';
    const provider = vi.fn();
    const executeQuery = vi.fn();
    const base = await start(root, {
      requireMeaningCallForNaturalLanguage: false,
      executor: { executeQuery } as unknown as QueryExecutor,
      agentRunExecutors: {
        generated_answer: provider as never,
        semantic_answer: provider as never,
      },
    });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        status?: string;
        trustState?: string;
        clarificationOptions?: Array<{ id: string; label: string }>;
        routeDecision?: {
          requiresClarification?: boolean;
          terminalOutcome?: {
            kind?: string;
            code?: string;
            gap?: { code?: string; missing?: string[]; witnessCandidateIds?: string[] };
          };
          analyticalCascadeDecision?: {
            stopReason?: string;
            planFrozen?: boolean;
            attempts?: Array<{ tier: string; outcome: string; candidateIds: string[]; planFrozen: boolean }>;
          };
        };
        traceReference?: { traceId?: string };
        diagnosticReceiptV3?: {
          terminalGap?: {
            code?: string;
            requirement?: string;
            witnessCandidateIds?: string[];
          };
          cascade?: {
            terminalGap?: {
              code?: string;
              requirement?: string;
              witnessCandidateIds?: string[];
            };
          };
        };
      };
    };
    expect(body.run, JSON.stringify(body.run)).toMatchObject({
      route: 'blocked',
      status: 'blocked',
      trustState: 'blocked',
      routeDecision: {
        requiresClarification: false,
        terminalOutcome: {
          kind: 'modeling_gap',
          code: 'ANALYTICAL_MODELING_GAP',
          gap: {
            code: 'MISSING_RELATIONSHIP',
            witnessCandidateIds: expect.arrayContaining(['revenue_operations::relationship::competitor_observation_to_lost_opportunity']),
          },
        },
        analyticalCascadeDecision: { stopReason: 'denied', planFrozen: false },
      },
    });
    expect(body.run.clarificationOptions).toBeUndefined();
    expect(body.run.routeDecision?.terminalOutcome?.gap?.missing?.join(' ')).toContain('certified attribution relationship');
    expect(body.run.routeDecision?.analyticalCascadeDecision?.attempts?.map((attempt) => attempt.tier)).toEqual([
      'certified',
      'semantic',
      'governed_relational',
    ]);
    expect(body.run.routeDecision?.analyticalCascadeDecision?.attempts?.at(-1)).toMatchObject({
      tier: 'governed_relational',
      outcome: 'denied',
      candidateIds: expect.arrayContaining(['revenue_operations::relationship::competitor_observation_to_lost_opportunity']),
    });
    expect(provider).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
    expect(body.run.diagnosticReceiptV3).toMatchObject({
      terminalGap: {
        code: 'MISSING_RELATIONSHIP',
        requirement: 'certified_relationship_or_allocation_proof',
        witnessCandidateIds: expect.arrayContaining(['revenue_operations::relationship::competitor_observation_to_lost_opportunity']),
      },
      cascade: {
        terminalGap: {
          code: 'MISSING_RELATIONSHIP',
          requirement: 'certified_relationship_or_allocation_proof',
        },
      },
    });

    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: {
      envelope: { terminalOutcome?: string };
      spans: Array<{
        name: string;
        stage: string;
        outcome: string;
        reasonCode: string;
        payload?: {
          kind?: string;
          decision?: {
            terminalGap?: {
              code?: string;
              requirement?: string;
              witnessCandidateIds?: string[];
            };
          };
        };
      }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        trace = await detail.json() as typeof trace;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(trace?.envelope.terminalOutcome).toBe('blocked');
    expect(trace?.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'cascade.evaluate', outcome: 'denied', reasonCode: 'cascade_denied',
        payload: expect.objectContaining({ decision: expect.objectContaining({ terminalGap: expect.objectContaining({ code: 'MISSING_RELATIONSHIP' }) }) }),
      }),
      expect.objectContaining({
        name: 'cascade.governed_relational', outcome: 'denied', reasonCode: 'cascade_denied',
        payload: expect.objectContaining({ decision: expect.objectContaining({ terminalGap: expect.objectContaining({ code: 'MISSING_RELATIONSHIP' }) }) }),
      }),
    ]));
    expect(trace?.spans.some((span) => span.stage === 'provider' || span.stage === 'tool' || span.stage === 'sql')).toBe(false);

    // The portable bundle must retain the typed gap and its relationship
    // witness through strict redaction/replay without carrying router prose.
    const exportDirectory = join(root, 'strict-relationship-gap-bundle');
    exportAskTraceBundleV1(trace as never, {
      profile: 'strict',
      outputDirectory: exportDirectory,
      provenance: 'synthetic',
      runReceipt: body.run,
    });
    expect(validateAskTraceBundleV1(exportDirectory)).toMatchObject({ valid: true, errors: [] });
    expect(replayAskTraceReceiptV1(exportDirectory)).toMatchObject({ valid: true, errors: [] });
    const strictTrace = JSON.parse(readFileSync(join(exportDirectory, 'trace.json'), 'utf8')) as {
      spans: Array<{
        payload?: {
          decision?: {
            terminalGap?: { code?: string; requirement?: string; witnessCandidateIds?: string[] };
          };
        };
      }>;
    };
    const strictReceipt = JSON.parse(readFileSync(join(exportDirectory, 'run-receipt.json'), 'utf8')) as {
      terminalGap?: { code?: string; requirement?: string; witnessCandidateIds?: string[] };
    };
    const strictGap = strictTrace.spans
      .map((span) => span.payload?.decision?.terminalGap)
      .find((gap) => gap?.code === 'MISSING_RELATIONSHIP');
    expect(strictGap).toMatchObject({
      code: 'MISSING_RELATIONSHIP',
      requirement: 'certified_relationship_or_allocation_proof',
      witnessCandidateIds: [expect.stringMatching(/^candidate_[0-9a-f]{16}$/)],
    });
    expect(strictReceipt.terminalGap).toEqual(strictGap);
  });

  it('keeps the no-provider office Research fixture truthful about failed branches and limited scope', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-research-no-provider-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    // The portable fixture intentionally has no provider or warehouse setup.
    // Rebuild only the local snapshot under this temp root; no test cassette,
    // network call, SQL executor, or gold result is injected here.
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const question = 'Investigate revenue and BCM across top accounts, explain trends, contributors, risks, counter-evidence, and limitations.';
    const base = await start(root, { requireMeaningCallForNaturalLanguage: false });
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, requestedMode: 'research' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        answer?: string;
        summary?: string;
        artifacts?: Array<{ kind: string; payload?: Record<string, unknown> }>;
        traceReference?: { traceId?: string };
      };
    };
    const researchArtifact = body.run.artifacts?.find((artifact) => artifact.kind === 'research_run');
    const branchReceipts = researchArtifact?.payload?.researchBranchReceipts as Array<{
      branchId?: string;
      childRunId?: string;
      state?: string;
      verdict?: string;
      stopReason?: string;
      evidenceKind?: string;
      lineageStatus?: string;
    }> | undefined;
    const ledger = researchArtifact?.payload?.researchLedgerV2 as {
      groundableBranchCount?: number;
      limitedScope?: boolean;
      entries?: Array<{ verdict?: string }>;
    } | undefined;
    const ledgerV3 = researchArtifact?.payload?.researchLedgerV3 as {
      groundableBranchCount?: number;
      limitedScope?: boolean;
      entries?: Array<{
        evidenceKind?: string;
        verdict?: string;
        resultFingerprint?: string;
        executionReceipt?: unknown;
        lineageReceipt?: {
          zeroCallCounters?: {
            providerCalls?: number;
            sqlExecutions?: number;
            warehouseExecutions?: number;
            repairAttempts?: number;
          };
        };
      }>;
    } | undefined;
    expect(body.run.route).toBe('research');
    // V2 is deliberately analytical-result-only for backwards compatibility:
    // a structural graph walk cannot masquerade as an execution receipt. V3
    // carries the mixed dossier while retaining the root's two planned,
    // groundable branches and limited-scope conclusion.
    expect(ledger).toMatchObject({ groundableBranchCount: 2, limitedScope: true });
    expect(ledger?.entries).toHaveLength(1);
    expect(ledger?.entries?.map((entry) => entry.verdict)).toEqual(['failed']);
    expect(ledgerV3).toMatchObject({ groundableBranchCount: 2, limitedScope: true });
    expect(ledgerV3?.entries).toHaveLength(2);
    expect(ledgerV3?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceKind: 'analytical_result', verdict: 'failed' }),
      expect.objectContaining({
        evidenceKind: 'lineage_graph',
        verdict: 'inconclusive',
        lineageReceipt: expect.objectContaining({
          zeroCallCounters: {
            providerCalls: 0,
            sqlExecutions: 0,
            warehouseExecutions: 0,
            repairAttempts: 0,
          },
        }),
      }),
    ]));
    const lineageEntry = ledgerV3?.entries?.find((entry) => entry.evidenceKind === 'lineage_graph');
    expect(lineageEntry?.resultFingerprint).toBeUndefined();
    expect(lineageEntry?.executionReceipt).toBeUndefined();
    expect(branchReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceKind: 'analytical_result',
        state: 'failed',
        verdict: 'failed',
        stopReason: 'execution_failed',
      }),
      expect.objectContaining({
        evidenceKind: 'lineage_graph',
        state: 'completed',
        verdict: 'inconclusive',
        stopReason: 'completed',
      }),
    ]));
    // Ask renders answer ahead of summary, so the limited-scope statement must
    // survive there instead of being hidden behind the generic no-result text.
    expect(body.run.answer).toContain('Limited research scope');
    expect(body.run.summary).toContain('Limited research scope');

    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: {
      spans: Array<{ name: string; reasonCode?: string; payload?: { kind?: string; verdict?: string; branchStopReason?: string } }>;
      links: Array<{ kind: string; targetRunId?: string }>;
    } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        trace = await detail.json() as typeof trace;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    const verdicts = trace?.spans
      .filter((span) => span.name === 'research.validate')
      .map((span) => span.payload?.verdict);
    // The structural branch has its own trace stage and never becomes a V2
    // analytical validation failure merely because a provider is unavailable.
    expect(verdicts).toEqual(['failed']);
    expect(trace?.spans
      .filter((span) => span.name === 'research.validate')
      .map((span) => ({ reasonCode: span.reasonCode, branchStopReason: span.payload?.branchStopReason })))
      .toEqual([{ reasonCode: 'execution_failed', branchStopReason: 'execution_failed' }]);
    expect(trace?.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'research.lineage',
        payload: expect.objectContaining({ evidenceKind: 'lineage_graph', verdict: 'inconclusive' }),
      }),
    ]));
    expect(trace?.links.filter((link) => link.kind === 'research_branch')).toHaveLength(2);
    // The durable receipt, branch trace span, and child link are a single
    // content-safe record of partial Research progress; no branch is merely a
    // presentation row without a corresponding lifecycle span. Structural
    // lineage has a dedicated lifecycle stage, rather than being relabeled as
    // a failed analytical validation.
    expect(branchReceipts?.map((receipt) => receipt.branchId)).toEqual(
      trace?.spans
        .filter((span) => span.name === 'research.validate' || span.name === 'research.lineage')
        .map((span) => (span.payload as { branchId?: string } | undefined)?.branchId),
    );
    expect(branchReceipts?.map((receipt) => receipt.childRunId)).toEqual(
      trace?.links.filter((link) => link.kind === 'research_branch').map((link) => link.targetRunId),
    );
  });

  it('maps a bounded missing detail request to TRACE_NOT_FOUND without leaking a run body', async () => {
    const base = await start(project());
    const status = await fetch(`${base}/api/ask-traces/status`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ status: { schemaVersion: 1 } });

    const trace = await fetch(`${base}/api/ask-traces/${'a'.repeat(32)}`);
    expect(trace.status).toBe(404);
    await expect(trace.json()).resolves.toEqual({
      code: 'TRACE_NOT_FOUND',
      error: 'No local trace was found.',
    });

    const byRun = await fetch(`${base}/api/ask-traces/by-run/no-such-run`);
    expect(byRun.status).toBe(404);
    await expect(byRun.json()).resolves.toMatchObject({ code: 'TRACE_NOT_FOUND' });
  });

  it('maps a newer local schema to TRACE_SCHEMA_UNSUPPORTED and keeps status inspectable', async () => {
    const root = project();
    const tracePath = defaultAskTraceSqlitePath(root);
    mkdirSync(join(root, '.dql', 'local'), { recursive: true });
    const db = new Database(tracePath);
    db.pragma('user_version = 2');
    db.close();

    const base = await start(root);
    const status = await fetch(`${base}/api/ask-traces/status`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      status: { available: false, reason: 'unsupported_schema' },
    });
    const list = await fetch(`${base}/api/ask-traces`);
    expect(list.status).toBe(409);
    await expect(list.json()).resolves.toMatchObject({ code: 'TRACE_SCHEMA_UNSUPPORTED' });
  });

  it('rejects a non-strict runtime export with TRACE_EXPORT_REDACTION_FAILED', async () => {
    const root = project();
    const store = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(root) });
    const observer = createAskTraceObserverV1({
      store,
      runId: 'run-export-api',
      surface: 'browser',
      mode: 'ask',
      questionFingerprint: 'sha256:api-fixture',
    });
    const traceId = observer.traceId;
    observer.finalize({ status: 'completed', trustState: 'review_required', selectedTier: 'exploratory_sql' });
    store.close();

    const base = await start(root);
    const response = await fetch(`${base}/api/ask-traces/${traceId}/export?profile=support`);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'TRACE_EXPORT_REDACTION_FAILED' });
  });

  it.each([
    ['AUTHENTICATION_FAILED', '401 Unauthorized', 'authentication'],
    ['MODEL_NOT_FOUND', 'model not found', 'model_not_found'],
    ['ECONNREFUSED', 'connection refused', 'network'],
    ['HTTP_502', '502 gateway', 'gateway'],
    ['ETIMEDOUT', 'provider timeout', 'provider_timeout'],
  ] as const)('records planner preflight %s as %s before any connection or SQL attempt', async (code, message, cause) => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), `dql-office-planner-preflight-${cause}-`));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const available = vi.fn(async () => {
      throw Object.assign(new Error(message), { code });
    });
    const generate = vi.fn(async () => {
      throw new Error('Planner dispatch must not begin after failed preflight.');
    });
    const planner: AgentProvider = { name: 'ollama', available, generate };
    const executeQuery = vi.fn();
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      askAnalyticalPlannerProviderFactory: () => planner,
    });

    // This office-shaped customer/product/revenue request cannot take a
    // one-relation deterministic fast path. It must reach the planner
    // boundary, where readiness is recorded before any compiler/connection
    // or SQL executor boundary can start.
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'who are the top customers have product with revenue',
        requestedMode: 'ask',
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        telemetry?: { sqlExecutions?: number };
        routeDecision?: { providerFailure?: { cause?: string; phase?: string } };
        traceReference?: { traceId?: string };
      };
    };
    expect(available).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
    expect(body.run.status).toBe('blocked');
    expect(body.run.telemetry?.sqlExecutions).toBe(0);
    expect(body.run.routeDecision?.providerFailure, JSON.stringify(body.run.routeDecision)).toMatchObject({
      cause,
      phase: 'preflight',
    });
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: {
      spans: Array<{
        name: string;
        stage: string;
        outcome: string;
        payload?: { kind?: string; attempt?: { phase?: string; cause?: string } };
      }>;
    } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        trace = await detail.json() as typeof trace;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    const preflight = trace?.spans.find((span) => span.name === 'provider.preflight');
    expect(preflight).toMatchObject({
      stage: 'provider', outcome: 'unavailable',
      payload: { kind: 'provider', attempt: { phase: 'preflight', cause } },
    });
    expect(trace?.spans.some((span) => span.name === 'sql.execute' || span.name === 'connection.preflight')).toBe(false);
  });

  it('records an unconfigured planner as a configuration-safe preflight incident, not authentication', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-planner-preflight-unconfigured-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const executeQuery = vi.fn();
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      // The host has deliberately no configured planner. Returning null here
      // exercises the same server-owned preflight boundary as production,
      // without letting a fixture-local default provider alter the cause.
      askAnalyticalPlannerProviderFactory: () => null,
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'who are the top customers have product with revenue',
        requestedMode: 'ask',
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        telemetry?: { sqlExecutions?: number };
        routeDecision?: { providerFailure?: { cause?: string; phase?: string; safeAction?: string } };
        traceReference?: { traceId?: string };
      };
    };
    expect(body.run.status).toBe('blocked');
    expect(body.run.telemetry?.sqlExecutions).toBe(0);
    expect(executeQuery).not.toHaveBeenCalled();
    expect(body.run.routeDecision?.providerFailure).toMatchObject({
      cause: 'unknown',
      phase: 'preflight',
      safeAction: 'fix_provider_configuration',
    });
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: {
      spans: Array<{
        name: string;
        stage: string;
        outcome: string;
        payload?: { kind?: string; attempt?: { phase?: string; cause?: string; safeAction?: string } };
      }>;
    } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        trace = await detail.json() as typeof trace;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(trace?.spans.find((span) => span.name === 'provider.preflight')).toMatchObject({
      stage: 'provider', outcome: 'unavailable',
      payload: {
        kind: 'provider',
        attempt: { phase: 'preflight', cause: 'unknown', safeAction: 'fix_provider_configuration' },
      },
    });
    expect(trace?.spans.some((span) => span.name === 'sql.execute' || span.name === 'connection.preflight')).toBe(false);
  });

  it('records a bare configured-provider readiness false as configuration-safe unknown, not authentication', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-office-planner-preflight-false-ready-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const available = vi.fn(async () => false);
    const generate = vi.fn(async () => {
      throw new Error('Planner dispatch must not begin after false readiness.');
    });
    const planner: AgentProvider = { name: 'openai', available, generate };
    const executeQuery = vi.fn();
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      askAnalyticalPlannerProviderFactory: () => planner,
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'who are the top customers have product with revenue',
        requestedMode: 'ask',
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        telemetry?: { sqlExecutions?: number };
        routeDecision?: { providerFailure?: { cause?: string; phase?: string; safeAction?: string } };
        traceReference?: { traceId?: string };
      };
    };
    expect(available).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
    expect(body.run.status).toBe('blocked');
    expect(body.run.telemetry?.sqlExecutions).toBe(0);
    expect(body.run.routeDecision?.providerFailure).toMatchObject({
      cause: 'unknown', phase: 'preflight', safeAction: 'fix_provider_configuration',
    });
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: { spans: Array<{ name: string; payload?: { attempt?: { cause?: string; safeAction?: string } } }> } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        trace = await detail.json() as typeof trace;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(trace?.spans.find((span) => span.name === 'provider.preflight')).toMatchObject({
      payload: { attempt: { cause: 'unknown', safeAction: 'fix_provider_configuration' } },
    });
    expect(trace?.spans.some((span) => span.name === 'sql.execute' || span.name === 'connection.preflight')).toBe(false);
  });
});

/**
 * A deliberately opt-in performance gate for OBS-010. It exercises the real
 * local Ask HTTP path with no provider and no warehouse: the enabled side must
 * still create/finalize a complete local trace, while the disabled side runs
 * the same request through the same router and failure path. Keep it opt-in so
 * shared CI machines do not turn process-wide CPU accounting into a flaky unit
 * assertion; release/performance runs invoke the command below explicitly.
 *
 * `DQL_RUN_ASK_TRACE_PERF=1 pnpm --filter @duckcodeailabs/dql-cli test -- src/ask-trace-api.test.ts`
 */
describe.skipIf(process.env.DQL_RUN_ASK_TRACE_PERF !== '1')('Ask trace producer CPU budget (OBS-010)', () => {
  it('keeps the paired no-provider/no-warehouse CPU overhead at or below two percent', async () => {
    const base = await start(project());
    const previous = process.env.DQL_ASK_OBSERVABILITY;
    const samplesPerMode = 240;
    const warmupPerMode = 24;
    const request = async () => {
      const response = await fetch(`${base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Which customers have the highest revenue?',
          requestedMode: 'ask',
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { run?: { status?: string; traceReference?: { traceId?: string } } };
      expect(body.run?.status).toBeDefined();
      return body;
    };
    const measure = async (enabled: boolean, count: number) => {
      if (enabled) delete process.env.DQL_ASK_OBSERVABILITY;
      else process.env.DQL_ASK_OBSERVABILITY = 'off';
      const before = process.cpuUsage();
      const wallStarted = performance.now();
      let traces = 0;
      let lastTraceId: string | undefined;
      for (let index = 0; index < count; index += 1) {
        const result = await request();
        if (result.run?.traceReference?.traceId) {
          traces += 1;
          lastTraceId = result.run.traceReference.traceId;
        }
      }
      const usage = process.cpuUsage(before);
      return {
        cpuMsPerAsk: (usage.user + usage.system) / 1_000 / count,
        wallMsPerAsk: (performance.now() - wallStarted) / count,
        traces,
        lastTraceId,
      };
    };

    try {
      // Warm both sides before collecting paired CPU samples. The fixed order
      // ensures the trace side exercises a warm WAL and prepared statements.
      await measure(false, warmupPerMode);
      await measure(true, warmupPerMode);
      const disabled = await measure(false, samplesPerMode);
      const enabled = await measure(true, samplesPerMode);
      const relativeCpuOverhead = (enabled.cpuMsPerAsk - disabled.cpuMsPerAsk) / disabled.cpuMsPerAsk;
      const wallOverheadMs = enabled.wallMsPerAsk - disabled.wallMsPerAsk;
      const latestTrace = enabled.lastTraceId
        ? await (await fetch(`${base}/api/ask-traces/${enabled.lastTraceId}`)).json() as { spans?: unknown[]; candidateDecisions?: unknown[] }
        : undefined;
      const traceShape = `spans=${latestTrace?.spans?.length ?? 0}; candidates=${latestTrace?.candidateDecisions?.length ?? 0}`;

      if (process.env.DQL_ASK_TRACE_PERF_REPORT === '1') {
        console.info(
          `[OBS-010] off=${disabled.cpuMsPerAsk.toFixed(3)}ms CPU/Ask; on=${enabled.cpuMsPerAsk.toFixed(3)}ms CPU/Ask; relative=${(relativeCpuOverhead * 100).toFixed(2)}%; wall delta=${wallOverheadMs.toFixed(3)}ms; ${traceShape}`,
        );
      }

      // Required trace evidence is never sampled or dropped for this gate.
      expect(enabled.traces).toBe(samplesPerMode);
      expect(
        relativeCpuOverhead,
        `off=${disabled.cpuMsPerAsk.toFixed(3)}ms CPU/Ask; on=${enabled.cpuMsPerAsk.toFixed(3)}ms CPU/Ask; wall delta=${wallOverheadMs.toFixed(3)}ms; ${traceShape}`,
      ).toBeLessThanOrEqual(0.02);
      expect(wallOverheadMs, `off=${disabled.wallMsPerAsk.toFixed(3)}ms/Ask; on=${enabled.wallMsPerAsk.toFixed(3)}ms/Ask`)
        .toBeLessThanOrEqual(10);
    } finally {
      if (previous === undefined) delete process.env.DQL_ASK_OBSERVABILITY;
      else process.env.DQL_ASK_OBSERVABILITY = previous;
    }
  });
});
