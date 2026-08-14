import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { providerPayloadFingerprint } from '@duckcodeailabs/dql-agent';
import { RunScopedProviderDispatchEvidence, startLocalServer } from './local-runtime.js';
import { saveProviderSettings } from './settings/provider-settings.js';

afterEach(() => vi.unstubAllGlobals());

const dispatchEvent = {
  provider: 'ollama' as const,
  operation: 'generate' as const,
  attemptIndex: 1,
  envelope: { messages: [{ role: 'user', content: 'bounded research follow-up' }] },
};

it('enforces independent Research narration/sample and local-analysis physical egress caps per run', () => {
  const collector = () => new RunScopedProviderDispatchEvidence({
    total: 8, meaningResolution: 1, generationGroup: 8, repair: 1,
  });
  const run = collector();

  expect(() => run.observe(dispatchEvent, {
    purpose: 'research_narration', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 20, columnCount: 2 }, cumulativeResultRowCount: 20,
  })).not.toThrow();
  expect(() => run.observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 200, columnCount: 4 }, cumulativeResultRowCount: 200,
  })).not.toThrow();
  expect(run.snapshot().providerEgressReceipts.map((receipt) => ({ purpose: receipt.purpose, rows: receipt.resultRowCount })))
    .toEqual([
      { purpose: 'research_narration', rows: 20 },
      { purpose: 'research_tool', rows: 200 },
    ]);

  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 201, columnCount: 1 }, cumulativeResultRowCount: 201,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_LIMIT_EXCEEDED' }));
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_narration', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 21, columnCount: 1 }, cumulativeResultRowCount: 21,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_LIMIT_EXCEEDED' }));
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: false,
    serializedResultShape: { resultRowCount: 1, columnCount: 1 }, cumulativeResultRowCount: 1,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));

  // Consent and cumulative counters are per collector/run; a new run begins at zero.
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 200, columnCount: 4 }, cumulativeResultRowCount: 200,
  })).not.toThrow();
});

it('shares one two-send ledger across ordinary meaning and generation phases', () => {
  const run = new RunScopedProviderDispatchEvidence({
    total: 2, meaningResolution: 1, generationGroup: 2, repair: 0,
  });

  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  })).not.toThrow();
  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(run.snapshot().providerEgressReceipts).toHaveLength(2);
});

it('retains the separate twelve-send Research ledger', () => {
  const run = new RunScopedProviderDispatchEvidence({
    total: 12, meaningResolution: 1, generationGroup: 11, repair: 0,
  });
  run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  });
  for (let attemptIndex = 1; attemptIndex <= 11; attemptIndex += 1) {
    run.observe({ ...dispatchEvent, attemptIndex }, {
      purpose: 'research_narration', dispatchPhase: 'generation', optIn: false,
    });
  }

  expect(run.snapshot().providerEgressReceipts).toHaveLength(12);
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 12 }, {
    purpose: 'research_narration', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
});

it('accounts every physical route and answer dispatch once on the persisted AgentRun', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-egress-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai',
    enabled: true,
    apiKey: 'test-secret',
    baseUrl: 'https://agent-run-egress.example.test/v1',
    model: 'probe-model',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://agent-run-egress.example.test/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      providerBodies.push(body);
      const serialized = JSON.stringify(body);
      const content = serialized.includes('Pick ONE category')
        ? JSON.stringify({
            category: 'general_knowledge',
            depth: 'quick',
            needsClarification: false,
            rationale: 'Specific governed metric lookup.',
          })
        : JSON.stringify({ summary: 'No governed result is available yet.' });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return nativeFetch(input, init);
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'How should I explain total revenue to a new analyst?',
        requestedMode: 'ask',
        workspaceContext: {
          schema: [{ customer_name: 'ROW_CANARY_SCHEMA', amount: 42 }],
          nested: {
            descriptor: [{ name: 'ROW_CANARY_DESCRIPTOR', type: 'varchar' }],
            content: [{ customer_name: 'ROW_CANARY_CONTENT', amount: 42 }],
          },
        },
      }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as { run: { id: string } };
    const persistedResponse = await nativeFetch(
      `http://127.0.0.1:${port}/api/agent-runs/${encodeURIComponent(payload.run.id)}`,
    );
    expect(persistedResponse.status).toBe(200);
    const persisted = await persistedResponse.json() as { run: any };

    // One ambiguous-route classification plus governed answer generation proves
    // the collector is additive across components, not an answer-only counter.
    expect(providerBodies).toHaveLength(2);
    expect(JSON.stringify(providerBodies)).not.toContain('ROW_CANARY');
    expect(persisted.run.telemetry.providerRoundTrips).toBe(providerBodies.length);
    expect(persisted.run.providerEgressReceipts).toHaveLength(providerBodies.length);
    expect(persisted.run.providerEgressReceipts.map((receipt: any) => receipt.dispatchPhase)).toEqual([
      'meaning_resolution',
      'generation',
    ]);
    expect(persisted.run.providerEgressReceipts.map((receipt: any) => receipt.payloadFingerprint)).toEqual(
      providerBodies.map(providerPayloadFingerprint),
    );
    expect(persisted.run.diagnosticReceipt.providerEgressReceipts).toHaveLength(providerBodies.length);
    expect(persisted.run.diagnosticReceiptV2.telemetry.providerRoundTrips).toBe(providerBodies.length);
    expect(persisted.run.diagnosticReceiptV2.providerEgressReceiptFingerprints).toHaveLength(providerBodies.length);
    expect(persisted.run.providerEgressReceipts.every((receipt: any) =>
      receipt.resultRowCount === 0
      && receipt.columnCount === 0
      && typeof receipt.payloadFingerprint === 'string'
      && !JSON.stringify(receipt).includes('ROW_CANARY')
      && !JSON.stringify(receipt).includes('test-secret')
    )).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('types a denied third physical send as orchestration budget exhaustion, not provider unavailability', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-third-send-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai',
    enabled: true,
    apiKey: 'test-secret',
    baseUrl: 'https://third-send.example.test/v1',
    model: 'probe-model',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://third-send.example.test/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    providerBodies.push(body);
    const serialized = JSON.stringify(body);
    if (serialized.includes('Pick ONE category')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        category: 'general_knowledge',
        depth: 'quick',
        needsClarification: false,
        rationale: 'A plain-language explanation is required.',
      }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." },
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'How should I explain total revenue to a new analyst?',
        requestedMode: 'ask',
      }),
    });

    expect(response.status).toBe(201);
    const { run } = await response.json() as { run: any };
    expect(providerBodies).toHaveLength(2);
    expect(run.telemetry.providerRoundTrips).toBe(2);
    expect(run).toMatchObject({
      route: 'blocked',
      status: 'blocked',
      diagnosticReceipt: {
        failure: { code: 'orchestration_budget_exhausted', recoverable: false },
      },
    });
    expect(JSON.stringify(run)).not.toContain('AI_PROVIDER_FAILURE');
    expect(JSON.stringify(run)).not.toMatch(/provider setup|provider unavailable/i);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('spends only one physical meaning attempt when OpenAI requests a compatibility retry', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-meaning-budget-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai', enabled: true, apiKey: 'secret',
    baseUrl: 'https://meaning-budget.example.test/v1', model: 'gpt-5',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://meaning-budget.example.test/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    providerBodies.push(body);
    if (JSON.stringify(body).includes('Pick ONE category')) {
      return new Response(JSON.stringify({
        error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Bounded deterministic fallback.' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is total revenue by customer?', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const { run } = await response.json() as { run: any };
    const meaningBodies = providerBodies.filter((body) => JSON.stringify(body).includes('Pick ONE category'));
    const phases = run.providerEgressReceipts.map((receipt: any) => receipt.dispatchPhase);

    expect(meaningBodies).toHaveLength(1);
    expect(providerBodies).toHaveLength(1);
    expect(phases.filter((phase: string) => phase === 'meaning_resolution')).toHaveLength(1);
    expect(phases.filter((phase: string) => ['planning', 'generation', 'narration'].includes(phase)).length)
      .toBeLessThanOrEqual(2);
    expect(providerBodies.length).toBeLessThanOrEqual(3);
    expect(run.telemetry.providerRoundTrips).toBe(providerBodies.length);
    expect(run.providerEgressReceipts).toHaveLength(providerBodies.length);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('isolates dispatch receipts across concurrent HTTP AgentRuns', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-concurrent-egress-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai', enabled: true, apiKey: 'secret',
    baseUrl: 'https://concurrent-egress.example.test/v1', model: 'probe-model',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://concurrent-egress.example.test/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    providerBodies.push(body);
    const content = JSON.stringify(body).includes('Pick ONE category')
      ? JSON.stringify({ category: 'general_knowledge', depth: 'quick', needsClarification: false, rationale: 'explanation' })
      : 'A bounded explanation.';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const submit = async (canary: string) => {
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: `How should I explain revenue to ${canary}?`,
          requestedMode: 'ask',
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as { run: any }).run;
    };
    const [alpha, beta] = await Promise.all([submit('RUN_ALPHA'), submit('RUN_BETA')]);
    const expected = (canary: string) => providerBodies
      .filter((body) => JSON.stringify(body).includes(canary))
      .map(providerPayloadFingerprint);

    expect(alpha.providerEgressReceipts.map((receipt: any) => receipt.payloadFingerprint)).toEqual(expected('RUN_ALPHA'));
    expect(beta.providerEgressReceipts.map((receipt: any) => receipt.payloadFingerprint)).toEqual(expected('RUN_BETA'));
    expect(alpha.telemetry.providerRoundTrips).toBe(expected('RUN_ALPHA').length);
    expect(beta.telemetry.providerRoundTrips).toBe(expected('RUN_BETA').length);
    expect(expected('RUN_ALPHA')).not.toEqual(expect.arrayContaining(expected('RUN_BETA')));
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);
