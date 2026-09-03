import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import {
  AskTraceSqliteStoreV1,
  SqliteAgentRunStore,
  buildMeaningEvidencePackage,
  createAskTraceObserverV1,
  defaultAgentRunSqlitePath,
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
  type AgentRun,
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
  askAgentRuntimeMode?: 'authoritative_v2';
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
    ...(options.askAgentRuntimeMode ? { askAgentRuntimeMode: options.askAgentRuntimeMode } : {}),
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

  it('OBS-017 projects authoritative V8 admissions exactly over a larger legacy trace count', async () => {
    const root = project();
    const runId = 'run-v8-admission-authority';
    const traceStore = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(root) });
    const observer = createAskTraceObserverV1({
      store: traceStore,
      runId,
      surface: 'browser',
      mode: 'ask',
      questionFingerprint: 'sha256:admission-authority',
    });
    const traceId = observer.traceId;
    observer.finalize({ status: 'completed', trustState: 'certified', selectedTier: 'certified' });
    traceStore.close();

    // Simulate an older, broader V1 trace persisted beside the later V8
    // receipt. The server must display V8's actual 16-card admission package,
    // not inflate it to the stale legacy decision count.
    const traceDb = new Database(defaultAskTraceSqlitePath(root));
    traceDb.prepare('UPDATE ask_traces SET candidate_decision_count = 116 WHERE trace_id = ?').run(traceId);
    traceDb.close();

    const runs = new SqliteAgentRunStore({ path: defaultAgentRunSqlitePath(root) });
    runs.save({
      id: runId,
      question: 'Who are the top customers?',
      route: 'certified_answer',
      status: 'completed',
      trustState: 'certified',
      startedAt: '2026-08-31T12:00:00.000Z',
      completedAt: '2026-08-31T12:00:01.000Z',
      artifacts: [],
      evaluations: [],
      events: [],
      diagnosticReceiptV8: {
        version: 8,
        mode: 'authoritative_v2',
        turnClass: 'analytics',
        snapshotId: 'snapshot:admission-authority',
        retainedCandidateCount: 32,
        initialCandidateCount: 16,
        expansionCount: 0,
        objective: 'analytics',
        contextCoverage: [],
        excludedCandidateCount: 0,
        exclusionReasonCodes: [],
        observations: [],
        tierAttempts: [{
          version: 2,
          tier: 'certified',
          outcome: 'executed',
          reasonCode: 'CERTIFIED_EXECUTED',
          candidateIds: ['block:customer_profile'],
          frozen: true,
        }],
        planFrozen: true,
        terminalOutcome: {
          version: 2,
          kind: 'finish_answer',
          reasonCode: 'CERTIFIED_EXECUTED',
          origin: 'execution',
        },
        outcome: { connectionAttempted: true, executionAttempts: 1, factCount: 1, narration: 'fact_bound' },
        activity: { providerDispatches: 0, toolCalls: 1, executionAttempts: 1, repairs: 0 },
        toolDurationMs: 1,
        finalStopReason: 'certified_answer_found',
      },
    } as unknown as AgentRun);
    runs.close();

    const base = await start(root);
    const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      envelope: { selectedTier: 'certified', candidateDecisionCount: 16, trustState: 'certified' },
      runtimeReceiptV8: { mode: 'authoritative_v2', initialCandidateCount: 16 },
    });
    const list = await fetch(`${base}/api/ask-traces?limit=10`);
    await expect(list.json()).resolves.toMatchObject({
      traces: [expect.objectContaining({
        runId,
        selectedTier: 'certified',
        candidateDecisionCount: 16,
      })],
    });
  });

  it('OBS-017 projects the V8 semantic execution failure instead of the next-policy relational tier', async () => {
    const root = project();
    const runId = 'run-v8-controller-progression';
    const traceStore = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(root) });
    const observer = createAskTraceObserverV1({
      store: traceStore,
      runId,
      surface: 'browser',
      mode: 'ask',
      questionFingerprint: 'sha256:controller-progression',
    });
    const traceId = observer.traceId;
    observer.finalize({ status: 'blocked', selectedTier: 'semantic' });
    traceStore.close();

    const runs = new SqliteAgentRunStore({ path: defaultAgentRunSqlitePath(root) });
    runs.save({
      id: runId,
      question: 'Show revenue by month',
      route: 'blocked',
      status: 'blocked',
      trustState: 'blocked',
      startedAt: '2026-08-31T12:00:00.000Z',
      completedAt: '2026-08-31T12:00:01.000Z',
      artifacts: [], evaluations: [], events: [],
      diagnosticReceiptV8: {
        version: 8, mode: 'authoritative_v2', turnClass: 'analytics', snapshotId: 'snapshot:controller-progression',
        retainedCandidateCount: 32, initialCandidateCount: 16, expansionCount: 0, objective: 'analytics', contextCoverage: [], excludedCandidateCount: 0, exclusionReasonCodes: [], observations: [],
        tierAttempts: [
          { version: 2, tier: 'semantic', outcome: 'eligible', reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE', candidateIds: ['semantic:metric:revenue'], frozen: false },
          { version: 2, tier: 'semantic', outcome: 'unavailable', reasonCode: 'SEMANTIC_EXECUTION_UNAVAILABLE', candidateIds: ['semantic:metric:revenue'], frozen: false },
          { version: 2, tier: 'governed_relational', outcome: 'unavailable', reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE', candidateIds: [], frozen: false },
        ],
        // The semantic compiler was the last actual controller action. A
        // relational/exploratory option may be next in policy, but it did not
        // run and must not become the trace's selected tier.
        controllerTier: 'semantic',
        planFrozen: false,
        terminalOutcome: { version: 2, kind: 'gap', reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED', origin: 'agent_control' },
        outcome: { connectionAttempted: false, executionAttempts: 0, factCount: 0, narration: 'not_retained' },
        activity: { providerDispatches: 4, toolCalls: 4, executionAttempts: 0, repairs: 0 }, toolDurationMs: 1,
        finalStopReason: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      },
    } as unknown as AgentRun);
    runs.close();

    const base = await start(root);
    const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      envelope: { selectedTier: 'semantic', candidateDecisionCount: 16 },
      runtimeReceiptV8: { controllerTier: 'semantic' },
    });
  });

  it('AGT-047 persists a semantic engine validation terminal without recasting it as a coverage gap', async () => {
    const root = project();
    const runId = 'run-v8-semantic-engine-invalid';
    const traceStore = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(root) });
    const observer = createAskTraceObserverV1({
      store: traceStore,
      runId,
      surface: 'browser',
      mode: 'ask',
      questionFingerprint: 'sha256:semantic-engine-invalid',
    });
    const traceId = observer.traceId;
    observer.finalize({ status: 'blocked', selectedTier: 'semantic' });
    traceStore.close();

    const runs = new SqliteAgentRunStore({ path: defaultAgentRunSqlitePath(root) });
    runs.save({
      id: runId,
      question: 'Show revenue by month using the revenue semantic metric',
      route: 'blocked',
      status: 'blocked',
      trustState: 'blocked',
      startedAt: '2026-08-31T12:00:00.000Z',
      completedAt: '2026-08-31T12:00:01.000Z',
      artifacts: [], evaluations: [], events: [],
      diagnosticReceiptV8: {
        version: 8, mode: 'authoritative_v2', turnClass: 'analytics', snapshotId: 'snapshot:semantic-engine-invalid',
        retainedCandidateCount: 32, initialCandidateCount: 16, expansionCount: 0, objective: 'analytics', contextCoverage: [], excludedCandidateCount: 0, exclusionReasonCodes: [],
        observations: [{
          version: 1, tool: 'compile_and_run_semantic', tier: 'semantic', outcome: 'ineligible',
          reasonCode: 'SEMANTIC_ENGINE_INVALID', candidateIds: ['semantic:metric:order_item.revenue'], origin: 'validation',
          safeAction: 'use:compile_and_run_semantic',
        }],
        tierAttempts: [{
          version: 2, tier: 'semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_ENGINE_INVALID',
          candidateIds: ['semantic:metric:order_item.revenue'], frozen: false,
        }],
        controllerTier: 'semantic',
        planFrozen: false,
        terminalOutcome: {
          version: 2, kind: 'gap', reasonCode: 'SEMANTIC_ENGINE_INVALID', origin: 'validation',
          safeAction: 'use:compile_and_run_semantic',
        },
        outcome: { connectionAttempted: false, executionAttempts: 0, factCount: 0, narration: 'not_retained' },
        activity: { providerDispatches: 4, toolCalls: 3, executionAttempts: 0, repairs: 0 }, toolDurationMs: 4,
        finalStopReason: 'SEMANTIC_ENGINE_INVALID',
      },
    } as unknown as AgentRun);
    runs.close();

    const base = await start(root);
    const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      envelope: { selectedTier: 'semantic', candidateDecisionCount: 16 },
      runtimeReceiptV8: {
        controllerTier: 'semantic',
        terminalOutcome: { reasonCode: 'SEMANTIC_ENGINE_INVALID', origin: 'validation' },
        outcome: { connectionAttempted: false, executionAttempts: 0 },
      },
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

  it('executes the unique authoritative-V2 certified fast path once after Tier 1 materialization', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/ask-observability-office');
    const root = mkdtempSync(join(tmpdir(), 'dql-ask-v2-certified-fast-path-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });

    const executeQuery = vi.fn(async (
      sql: string,
      _parameters: unknown[] = [],
      _variables: Record<string, unknown> = {},
    ) => ({
      columns: ['customer_name', 'revenue'],
      rows: Array.from({ length: 10 }, (_, index) => ({
        customer_name: `Customer ${index + 1}`,
        revenue: 1_000 - index,
      })),
      rowCount: 10,
      sql,
    }));
    const planner = vi.fn(async () => {
      throw new Error('The unique exact certified fast path must not open a provider dispatch.');
    });
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      connection: { driver: 'file', filepath: join(root, 'synthetic.duckdb') },
      requireMeaningCallForNaturalLanguage: false,
      askAgentRuntimeMode: 'authoritative_v2',
      askAnalyticalPlannerProviderFactory: () => ({
        name: 'ollama',
        available: async () => true,
        generate: planner,
      }),
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Top Customers by Revenue', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        trustState?: string;
        askAgentRuntimeMode?: string;
        businessAnswer?: { factIds?: string[] };
        telemetry?: { providerRoundTrips?: number; sqlExecutions?: number };
        traceReference?: { traceId?: string };
      };
    };
    expect(body.run, JSON.stringify(body.run)).toMatchObject({
      status: 'completed',
      trustState: 'certified',
      askAgentRuntimeMode: 'authoritative_v2',
      telemetry: { providerRoundTrips: 0, sqlExecutions: 1 },
    });
    expect(body.run.businessAnswer?.factIds?.length).toBeGreaterThan(0);
    expect(planner).not.toHaveBeenCalled();
    const certifiedCalls = executeQuery.mock.calls
      .filter(([sql]) => /from\s+analytics\.fct_account_revenue/i.test(String(sql)));
    const certifiedSql = certifiedCalls.map(([sql]) => String(sql));
    expect(certifiedSql).toHaveLength(1);
    // The compiler parameterizes the immutable top_n binding. This proves
    // the physical statement has the bound outer limit rather than only a
    // post-result trim.
    expect(certifiedSql[0]).toMatch(/limit\s+\$1\b/i);
    expect(certifiedCalls[0]?.[1]).toEqual([{ name: 'top_n', position: 1 }]);
    expect(certifiedCalls[0]?.[2]).toMatchObject({ top_n: 10 });

    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: {
      runtimeReceiptV8?: {
        planFrozen?: boolean;
        activity?: { providerDispatches?: number; toolCalls?: number; executionAttempts?: number };
        outcome?: { connectionAttempted?: boolean; executionAttempts?: number; factCount?: number };
        observations?: Array<{ tool?: string; outcome?: string; reasonCode?: string }>;
      };
    } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        const parsed = await detail.json() as NonNullable<typeof trace>;
        trace = parsed;
        if (parsed.runtimeReceiptV8) break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    const receipt = trace?.runtimeReceiptV8;
    expect(receipt, JSON.stringify(trace)).toMatchObject({
      planFrozen: true,
      outcome: { connectionAttempted: true, executionAttempts: 1, factCount: expect.any(Number) },
      activity: { providerDispatches: 0, toolCalls: 1, executionAttempts: 1 },
    });
    expect(receipt?.outcome?.factCount).toBeGreaterThan(0);
    expect(receipt?.observations?.filter((observation) => observation.tool === 'run_certified')).toEqual([
      expect.objectContaining({ outcome: 'eligible', reasonCode: 'ASK_V2_EXECUTION_AUTHORIZED' }),
      expect.objectContaining({ outcome: 'executed', reasonCode: 'CERTIFIED_EXECUTED' }),
    ]);
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

  it('executes one authoritative-V2 exploratory SQL capability through the local host and persists its V8 receipt', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/jaffle-supply-chain');
    const root = mkdtempSync(join(tmpdir(), 'dql-ask-v2-host-exploratory-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });

    const executeQuery = vi.fn(async (sql: string) => ({
      columns: ['order_item_id'],
      rows: [{ order_item_id: 1 }],
      rowCount: 1,
      sql,
    }));
    let dispatch = 0;
    const planner: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async (messages) => {
        dispatch += 1;
        if (dispatch === 1) return '```json\n{"tool":"inspect_ask_context","input":{}}\n```';
        if (dispatch === 2) return '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```';
        if (dispatch === 3) return '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```';
        if (dispatch === 4) return '```json\n{"tool":"inspect_relational_context","input":{}}\n```';
        if (dispatch === 5) return '```json\n{"tool":"validate_and_run_sql","input":{"sql":"SELECT order_item_id FROM jaffle_shop.dev.order_items LIMIT 1","expectedOutputIds":["model.jaffle_shop.order_items"]}}\n```';
        if (dispatch === 6) return '```json\n{"tool":"finish_answer","input":{"answer":"The validated local result contains one customer."}}\n```';
        throw new Error(`Unexpected V2 planner dispatch ${dispatch}.`);
      },
    };
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      connection: { driver: 'file', filepath: join(root, 'synthetic.duckdb') },
      askAgentRuntimeMode: 'authoritative_v2',
      askAnalyticalPlannerProviderFactory: () => planner,
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'show one order item id', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        trustState?: string;
        askAgentRuntimeMode?: string;
        telemetry?: { sqlExecutions?: number };
        traceReference?: { traceId?: string };
      };
    };
    // Exploratory SQL completed its host execution successfully, but its
    // result remains deliberately review-required rather than certified.
    expect(body.run.status, JSON.stringify(body.run)).toBe('needs_review');
    expect(body.run.trustState).toBe('review_required');
    expect(body.run.askAgentRuntimeMode).toBe('authoritative_v2');
    expect(body.run.telemetry?.sqlExecutions).toBe(1);
    // The host also performs one target-identity probe while minting the
    // capability. Count only the admitted user SQL as an execution; V8 below
    // independently records the same one execution attempt.
    expect(executeQuery.mock.calls.filter(([sql]) => /from\s+jaffle_shop\.dev\.order_items/i.test(String(sql)))).toHaveLength(1);
    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: { runtimeMode?: string; runtimeReceiptV8?: { activity?: { providerDispatches?: number; toolCalls?: number; executionAttempts?: number }; outcome?: { connectionAttempted?: boolean; executionAttempts?: number }; terminalOutcome?: { origin?: string } } } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
      if (detail.status === 200) {
        const parsedTrace = await detail.json() as NonNullable<typeof trace>;
        trace = parsedTrace;
        if (parsedTrace.runtimeReceiptV8) break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    const runtimeReceipt = trace?.runtimeReceiptV8;
    expect(runtimeReceipt, JSON.stringify(trace)).toMatchObject({
      outcome: { connectionAttempted: true, executionAttempts: 1 },
      terminalOutcome: { origin: 'execution' },
      activity: { executionAttempts: 1 },
    });
    expect(trace?.runtimeMode).toBe('authoritative_v2');
  });

  it('denies an authoritative-V2 exploratory proposal outside its admitted closure before user SQL execution', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/jaffle-supply-chain');
    const root = mkdtempSync(join(tmpdir(), 'dql-ask-v2-host-closure-denial-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });

    const executeQuery = vi.fn(async (sql: string) => ({ columns: [], rows: [], rowCount: 0, sql }));
    let dispatch = 0;
    const planner: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async () => {
        dispatch += 1;
        if (dispatch === 1) return '```json\n{"tool":"inspect_ask_context","input":{}}\n```';
        if (dispatch === 2) return '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```';
        if (dispatch === 3) return '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```';
        if (dispatch === 4) return '```json\n{"tool":"inspect_relational_context","input":{}}\n```';
        // `dim_customers` exists in the broad retrieval pack, but it is not
        // in the selected order-items execution closure. The V2 host, rather
        // than the provider-visible card list, must reject it before minting.
        if (dispatch === 5) return '```json\n{"tool":"validate_and_run_sql","input":{"sql":"SELECT customer_name FROM jaffle_shop.dev.dim_customers LIMIT 1","expectedOutputIds":["model.jaffle_shop.order_items"]}}\n```';
        if (dispatch === 6) return '```json\n{"tool":"finish_answer","input":{"answer":"No safe result."}}\n```';
        throw new Error(`Unexpected V2 planner dispatch ${dispatch}.`);
      },
    };
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      connection: { driver: 'file', filepath: join(root, 'synthetic.duckdb') },
      askAgentRuntimeMode: 'authoritative_v2',
      askAnalyticalPlannerProviderFactory: () => planner,
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'show one order item id', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        telemetry?: { sqlExecutions?: number };
        routeDecision?: { askAgentV2Decision?: { state?: { observations?: Array<{ tool?: string; reasonCode?: string; origin?: string }> } } };
      };
    };
    expect(body.run.status, JSON.stringify(body.run)).toBe('blocked');
    // Local target discovery may read information_schema while acquiring the
    // immutable snapshot. What must not happen is execution of the provider's
    // out-of-closure program; the V2 capability is rejected before that call.
    expect(executeQuery.mock.calls.filter(([sql]) => /select\s+customer_name\s+from\s+jaffle_shop\.dev\.dim_customers/i.test(String(sql)))).toHaveLength(0);
    expect(body.run.telemetry?.sqlExecutions).toBe(0);
    expect(body.run.routeDecision?.askAgentV2Decision?.state?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'validate_and_run_sql', reasonCode: 'ASK_V2_UNAUTHORIZED_SQL', origin: 'validation' }),
    ]));
  });

  it('maps opaque admitted semantic evidence through the immutable V2 capability before real local semantic compilation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-ask-v2-host-semantic-'));
    directories.push(root);
    // A minimal local semantic project isolates the actual host compiler from
    // fixture-specific dbt-runtime setup.  The V2 tool still receives only an
    // opaque admitted evidence ID; the host must map it to `revenue` before
    // its native semantic compiler sees the request.
    mkdirSync(join(root, 'semantic-layer', 'metrics'), { recursive: true });
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({
      project: 'ask-v2-host-semantic',
      semanticLayer: { provider: 'dql', path: 'semantic-layer' },
    }));
    writeFileSync(join(root, 'semantic-layer', 'metrics', 'revenue.yaml'), [
      'name: revenue',
      'label: Revenue',
      'description: Governed revenue.',
      'domain: finance',
      'sql: SUM(amount)',
      'type: sum',
      'table: orders',
      '',
    ].join('\n'));

    const executeQuery = vi.fn(async (sql: string) => ({
      columns: ['customer_name', 'revenue'],
      rows: [{ customer_name: 'Synthetic Customer', revenue: 100 }],
      rowCount: 1,
      sql,
    }));
    // Target-bound semantic execution deliberately uses the connector's
    // positional execution boundary (rather than the legacy generated-SQL
    // helper). Supply it in the host fixture so this asserts the real
    // compiler + target binding + execution path.
    const executePositional = vi.fn(async (sql: string) => ({
      columns: [{ name: 'customer_name' }, { name: 'revenue' }],
      rows: [{ customer_name: 'Synthetic Customer', revenue: 100 }],
      rowCount: 1,
      sql,
    }));
    let dispatch = 0;
    const planner: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async () => {
        dispatch += 1;
        if (dispatch === 1) return '```json\n{"tool":"inspect_ask_context","input":{}}\n```';
        if (dispatch === 2) return '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```';
        if (dispatch === 3) return '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```';
        if (dispatch === 4) return '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:revenue"],"engine":"native"}}\n```';
        if (dispatch === 5) return '```json\n{"tool":"finish_answer","input":{"answer":"The validated semantic result contains one revenue result."}}\n```';
        throw new Error(`Unexpected V2 semantic planner dispatch ${dispatch}.`);
      },
    };
    const base = await start(root, {
      executor: { executeQuery, executePositional } as unknown as QueryExecutor,
      connection: { driver: 'file', filepath: join(root, 'synthetic.duckdb') },
      askAgentRuntimeMode: 'authoritative_v2',
      askAnalyticalPlannerProviderFactory: () => planner,
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is revenue?', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        trustState?: string;
        telemetry?: { sqlExecutions?: number };
        routeDecision?: { askAgentV2Decision?: { state?: { observations?: Array<{ tool?: string; candidateIds?: string[]; reasonCode?: string }> } } };
      };
    };
    // Semantic execution is validated and successful, and the lane states its
    // aggregation safety (single-model native query): the persisted run is a
    // governed semantic answer, exactly as the V1 cascade labelled one that
    // passed its fanout proof. The V2 result retains the execution receipt.
    expect(body.run.status, JSON.stringify(body.run)).toBe('completed');
    expect(body.run.trustState).toBe('governed');
    expect(body.run.telemetry?.sqlExecutions).toBe(1);
    // Host-first semantic execution: every clause of this question binds to
    // exactly one admitted capability, so the HOST calls its own governed
    // tools and the planner is never dispatched at all. The scripted
    // transcript above remains as the fallback path's contract; the invariant
    // it protected — no transport turn after the validated result — is
    // trivially upheld at zero.
    expect(dispatch).toBe(0);
    // The real local compiler receives its runtime names from the immutable
    // capability map. The opaque provider evidence ID must never leak into
    // MetricFlow/dbt SQL or be reinterpreted through the V1 plan.
    expect(executePositional).toHaveBeenCalledTimes(1);
    expect(executePositional.mock.calls[0]?.[0]).not.toContain('semantic:metric:account_revenue.revenue');
    expect(body.run.routeDecision?.askAgentV2Decision?.state?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        reasonCode: 'SEMANTIC_RESULT_VALIDATED',
        candidateIds: expect.arrayContaining(['semantic:metric:revenue']),
      }),
    ]));
  });

  it('AGT-047 executes an admitted MetricFlow-shaped month capability once when the native tool returns runtime names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-ask-v2-host-semantic-time-'));
    directories.push(root);
    mkdirSync(join(root, 'semantic-layer', 'cubes'), { recursive: true });
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({
      project: 'ask-v2-host-semantic-time',
      semanticLayer: { provider: 'dql', path: 'semantic-layer' },
    }));
    // Mirrors the runtime shape behind the reported MetricFlow card: a
    // model-qualified metric and an authored time dimension with month as an
    // explicit granularity. The provider never receives raw SQL or a mutable
    // catalog lookup; it returns only compiler-facing names from safe cards.
    writeFileSync(join(root, 'semantic-layer', 'cubes', 'order_item.yaml'), [
      'name: order_item',
      'label: Order Item',
      'description: Governed order item revenue.',
      'domain: commerce',
      'table: order_items',
      'sql: |',
      '  SELECT * FROM order_items',
      'measures:',
      '  - name: revenue',
      '    label: Revenue',
      '    description: Revenue from order items.',
      '    sql: SUM(amount)',
      '    type: sum',
      'time_dimensions:',
      '  - name: metric_time',
      '    label: Metric Time',
      '    description: Order item metric date.',
      '    sql: ordered_at',
      '    granularities:',
      '      - day',
      '      - month',
      '',
    ].join('\n'));
    const executePositional = vi.fn(async (sql: string) => ({
      columns: [{ name: 'metric_time__month' }, { name: 'revenue' }],
      rows: [{ metric_time__month: '2026-01-01', revenue: 100 }],
      rowCount: 1,
      sql,
    }));
    let dispatch = 0;
    const planner: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async () => {
        dispatch += 1;
        if (dispatch === 1) return '```json\n{"tool":"inspect_ask_context","input":{}}\n```';
        if (dispatch === 2) return '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```';
        if (dispatch === 3) return '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```';
        // The controller deliberately omits `engine`: the local runtime must
        // bind the one host-advertised semantic capability, never infer one
        // from the metric/time runtime names.
        if (dispatch === 4) return '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["revenue"],"timeDimensionId":"metric_time","timeGrain":"month"}}\n```';
        if (dispatch === 5) return '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is grouped by month."}}\n```';
        throw new Error(`Unexpected V2 semantic-time planner dispatch ${dispatch}.`);
      },
    };
    const base = await start(root, {
      executor: { executePositional } as unknown as QueryExecutor,
      connection: { driver: 'file', filepath: join(root, 'synthetic.duckdb') },
      askAgentRuntimeMode: 'authoritative_v2',
      askAnalyticalPlannerProviderFactory: () => planner,
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Show revenue by month using the revenue semantic metric', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        status?: string;
        telemetry?: { sqlExecutions?: number };
        trustState?: string;
        routeDecision?: {
          retrievalEvidence?: { candidateTraceMetadata?: Array<{ candidateId?: string; role?: string }> };
          askAgentV2Decision?: { state?: { observations?: Array<{ tool?: string; outcome?: string; candidateIds?: string[] }> } };
        };
      };
    };
    // MetricFlow owns join and aggregation semantics, so the executed month
    // capability is a governed semantic answer.
    expect(body.run.status, JSON.stringify(body.run)).toBe('completed');
    expect(body.run.trustState).toBe('governed');
    expect(body.run.telemetry?.sqlExecutions).toBe(1);
    // The local runtime performs one bounded schema read before agent
    // execution. Count only the physical semantic statement: it must execute
    // exactly once after the selected time capability validates.
    expect(executePositional.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => !/information_schema\.columns/i.test(sql))).toHaveLength(1);
    expect(dispatch).toBe(5);
    expect(body.run.routeDecision?.retrievalEvidence?.candidateTraceMetadata).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateId: 'semantic:commerce:dimension:order_item.metric_time',
        role: 'time_dimension',
      }),
    ]));
    expect(body.run.routeDecision?.askAgentV2Decision?.state?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'executed',
        candidateIds: expect.arrayContaining([
          'revenue',
          'semantic:commerce:dimension:order_item.metric_time',
        ]),
      }),
    ]));
  });

  it('executes a real authoritative-V2 root-frozen Research child without a child provider dispatch', async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/jaffle-supply-chain');
    const root = mkdtempSync(join(tmpdir(), 'dql-ask-v2-host-frozen-research-'));
    directories.push(root);
    cpSync(fixture, root, { recursive: true });
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });

    const executeQuery = vi.fn(async (sql: string) => ({
      columns: ['customer_name', 'lifetime_spend', 'order_count'],
      rows: [{ customer_name: 'Frozen Research Customer', lifetime_spend: 100, order_count: 2 }],
      rowCount: 1,
      sql,
    }));
    let providerDispatches = 0;
    let plannerSnapshotId: string | undefined;
    let frozenChildId: string | undefined;
    const planner: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async (messages) => {
        providerDispatches += 1;
        if (providerDispatches > 1) throw new Error('A root-frozen Research child must not dispatch a provider.');
        const payload = JSON.parse(String(messages.find((message) => message.role === 'user')?.content ?? '{}')) as {
          snapshotId?: string;
          frozenResearchChildren?: Array<{ id?: string; tier?: string; candidateIds?: string[] }>;
        };
        plannerSnapshotId = payload.snapshotId;
        const frozen = payload.frozenResearchChildren?.find((child) => child.tier === 'certified' && typeof child.id === 'string');
        expect(frozen).toMatchObject({
          id: expect.stringMatching(/^research:frozen:certified:/),
          candidateIds: expect.arrayContaining([expect.any(String)]),
        });
        frozenChildId = frozen?.id;
        return JSON.stringify({ hypotheses: [{
          kind: 'analytical',
          question: 'Who are the top customers by lifetime spend?',
          frozenChildId,
        }] });
      },
    };
    const base = await start(root, {
      executor: { executeQuery } as unknown as QueryExecutor,
      connection: { driver: 'file', filepath: join(root, 'synthetic.duckdb') },
      askAgentRuntimeMode: 'authoritative_v2',
      askAnalyticalPlannerProviderFactory: () => planner,
    });

    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Research who are the top customers by lifetime spend?',
        requestedMode: 'research',
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      run: {
        route?: string;
        diagnosticReceiptV8?: { version?: number; snapshotId?: string; observations?: Array<{ tool?: string; reasonCode?: string }> };
        routeDecision?: { askAgentV2Decision?: { state?: {
          snapshotId?: string;
          sourceFingerprint?: string;
          researchLedgerV4?: {
            version?: number;
            branches?: Array<{ verdict?: string; evidenceHandleIds?: string[]; lineageProgram?: string }>;
          };
        } } };
        traceReference?: { traceId?: string };
      };
    };
    const state = body.run.routeDecision?.askAgentV2Decision?.state;
    expect(providerDispatches).toBe(1);
    expect(frozenChildId).toMatch(/^research:frozen:certified:/);
    expect(plannerSnapshotId).toBe(state?.snapshotId);
    expect(state?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    // The host, rather than a provider-selected SQL program, ran the
    // immutable certified artifact once. No analytical child asked the model
    // to plan again.
    const childConnectorSql = executeQuery.mock.calls.map(([sql]) => String(sql).replace(/["`\[\]]/g, ''));
    expect(childConnectorSql.filter((sql) => /\bfrom\s+(?:jaffle_shop\.dev\.)?dim_customers\b/i.test(sql))).toHaveLength(1);
    expect(state?.researchLedgerV4).toMatchObject({ version: 4 });
    expect(state?.researchLedgerV4?.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ verdict: 'supported', lineageProgram: 'not_run' }),
    ]));
    expect(body.run.diagnosticReceiptV8).toMatchObject({ version: 8, snapshotId: plannerSnapshotId });

    const traceId = body.run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    const detail = await fetch(`${base}/api/ask-traces/${traceId}`);
    expect(detail.status).toBe(200);
    const trace = await detail.json() as { runtimeReceiptV8?: { version?: number; snapshotId?: string } };
    expect(trace.runtimeReceiptV8).toMatchObject({ version: 8, snapshotId: plannerSnapshotId });
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
      askAgentRuntimeMode: 'authoritative_v2',
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
      askAgentRuntimeMode: 'authoritative_v2',
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
      askAgentRuntimeMode: 'authoritative_v2',
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
