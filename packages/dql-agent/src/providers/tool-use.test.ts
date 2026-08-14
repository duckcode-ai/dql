import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import type { AgentToolDefinition, ProviderDispatchEvent } from './types.js';
import { runAgenticToolLoop } from '../agentic/tool-loop.js';
import {
  assertProviderPayloadAllowed,
  createProviderDispatchEgressReceipt,
  prepareProviderWireEnvelopeForDispatch,
  redactProviderResultRows,
} from '../provider-egress.js';

function dispatchRecorder(input: { purpose?: 'answer_generation' | 'research_narration'; optIn?: boolean } = {}) {
  const receipts: ReturnType<typeof createProviderDispatchEgressReceipt>[] = [];
  let pendingResultRowCount = 0;
  let pendingColumnCount = 0;
  return {
    receipts,
    onPayload: (event: { resultRowCount: number; columnCount: number }) => {
      pendingResultRowCount += event.resultRowCount;
      pendingColumnCount = Math.max(pendingColumnCount, event.columnCount);
    },
    observe: (event: ProviderDispatchEvent) => {
      const envelope = prepareProviderWireEnvelopeForDispatch(event.provider, event.envelope);
      assertProviderPayloadAllowed(envelope, {
        allowResultRows: false, maxResultRows: 0, purpose: input.purpose ?? 'answer_generation',
      });
      receipts.push(createProviderDispatchEgressReceipt({
        purpose: input.purpose ?? 'answer_generation',
        provider: event.provider,
        permittedCategories: pendingResultRowCount > 0
          ? ['instructions', 'question', 'result_rows']
          : ['instructions', 'question'],
        optIn: input.optIn === true && pendingResultRowCount > 0,
        envelope,
        serializedResultShape: { resultRowCount: pendingResultRowCount, columnCount: pendingColumnCount },
      }));
      pendingResultRowCount = 0;
      pendingColumnCount = 0;
      return envelope;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider tool use', () => {
  const tools: AgentToolDefinition[] = [
    {
      name: 'query_semantic_model',
      description: 'Compile semantic members.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
        },
      },
      run: async (args) => ({
        matched: true,
        input: args,
        sql: 'SELECT SUM(amount) AS total_revenue FROM orders',
      }),
    },
  ];

  it('OpenAIProvider executes tool calls and returns the final assistant text', async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'query_semantic_model',
                  arguments: '{"question":"monthly revenue"}',
                },
              }],
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '```json\n{"summary":"ok","sql":"SELECT SUM(amount) AS total_revenue FROM orders","viz":"single_value","outputs":["total_revenue"]}\n```',
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const seen: unknown[] = [];
    const recorded = dispatchRecorder();
    const provider = new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' });
    const out = await provider.generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }],
      tools,
      { maxToolCalls: 3, onToolCall: (event) => seen.push(event), onProviderDispatch: recorded.observe },
    );

    expect(out).toContain('"summary":"ok"');
    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: 'query_semantic_model' }),
        }),
      ]),
    );
    expect(calls[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_1',
          content: expect.stringContaining('total_revenue'),
        }),
      ]),
    );
    expect(seen[0]).toMatchObject({
      name: 'query_semantic_model',
      input: { question: 'monthly revenue' },
      isError: false,
    });
    expect(recorded.receipts).toHaveLength(calls.length);
    expect(recorded.receipts.every((receipt) => receipt.resultRowCount === 0)).toBe(true);
  });

  it('OpenAIProvider gives a graceful final answer when the tool-call budget is exhausted (P2)', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      // A request that still offers tools = the exhausting attempt. A request with
      // NO tools = the graceful final turn, which answers from prior tool results.
      if ('tools' in body) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'query_semantic_model', arguments: '{"question":"monthly revenue"}' },
              }],
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Revenue trended up over the last 6 months.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const seen: unknown[] = [];
    const provider = new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' });
    const out = await provider.generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }],
      tools,
      { maxToolCalls: 0, onToolCall: (event) => seen.push(event) },
    );

    // Real answer from the final turn, not the "budget exhausted" stub.
    expect(out).toBe('Revenue trended up over the last 6 months.');
    // The trace event still fires.
    expect(seen).toEqual([
      expect.objectContaining({
        name: 'tool_budget_exhausted',
        input: { requestedToolCalls: ['query_semantic_model'], maxToolCalls: 0, toolCallsUsed: 0 },
        isError: true,
      }),
    ]);
    // The final request omits tools/tool_choice so the model physically cannot loop.
    expect(bodies).toHaveLength(2);
    expect('tools' in bodies[1]).toBe(false);
    expect('tool_choice' in bodies[1]).toBe(false);
  });

  it('ClaudeProvider executes tool_use blocks and returns the final text response', async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'query_semantic_model',
            input: { question: 'monthly revenue' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        content: [{
          type: 'text',
          text: '```json\n{"summary":"ok","sql":"SELECT SUM(amount) AS total_revenue FROM orders","viz":"single_value","outputs":["total_revenue"]}\n```',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const seen: unknown[] = [];
    const recorded = dispatchRecorder();
    const provider = new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' });
    const out = await provider.generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }],
      tools,
      { maxToolCalls: 3, onToolCall: (event) => seen.push(event), onProviderDispatch: recorded.observe },
    );

    expect(out).toContain('"summary":"ok"');
    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'query_semantic_model' }),
      ]),
    );
    expect(calls[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: expect.stringContaining('total_revenue'),
            }),
          ]),
        }),
      ]),
    );
    expect(seen[0]).toMatchObject({
      name: 'query_semantic_model',
      input: { question: 'monthly revenue' },
      isError: false,
    });
    expect(recorded.receipts).toHaveLength(calls.length);
    expect(recorded.receipts.every((receipt) => receipt.resultRowCount === 0)).toBe(true);
  });

  it('ClaudeProvider gives a graceful final answer when the tool-call budget is exhausted (P2)', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      // A request that still offers tools = the exhausting attempt. A request with
      // NO tools = the graceful final turn, which answers from prior tool results.
      if ('tools' in body) {
        return new Response(JSON.stringify({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'query_semantic_model', input: { question: 'monthly revenue' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Revenue trended up over the last 6 months.' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const seen: unknown[] = [];
    const provider = new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' });
    const out = await provider.generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }],
      tools,
      { maxToolCalls: 0, onToolCall: (event) => seen.push(event) },
    );

    expect(out).toBe('Revenue trended up over the last 6 months.');
    expect(seen).toEqual([
      expect.objectContaining({
        name: 'tool_budget_exhausted',
        input: { requestedToolCalls: ['query_semantic_model'], maxToolCalls: 0, toolCallsUsed: 0 },
        isError: true,
      }),
    ]);
    // The final request omits tools so the model physically cannot loop.
    expect(bodies).toHaveLength(2);
    expect('tools' in bodies[1]).toBe(false);
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s executes a batched two-tool proposal in one round and one final dispatch', async (kind, createProvider) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
            { id: 'call_1', function: { name: 'query_semantic_model', arguments: '{}' } },
            { id: 'call_2', function: { name: 'inspect_schema', arguments: '{}' } },
          ] } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [
            { type: 'tool_use', id: 'tool_1', name: 'query_semantic_model', input: {} },
            { type: 'tool_use', id: 'tool_2', name: 'inspect_schema', input: {} },
          ] }), { status: 200 });
      }
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }] }), { status: 200 });
    }));
    const seen: string[] = [];
    const batchedTools: AgentToolDefinition[] = [
      ...tools,
      { name: 'inspect_schema', description: 'Inspect schema.', inputSchema: { type: 'object' }, run: async () => ({ columns: ['order_id'] }) },
    ];
    const recorded = dispatchRecorder();
    await expect(createProvider().generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }], batchedTools,
      { maxToolCalls: 4, maxProviderDispatches: 2, onToolCall: ({ name }) => seen.push(name), onProviderDispatch: recorded.observe },
    )).resolves.toBe('done');
    expect(seen).toEqual(['query_semantic_model', 'inspect_schema']);
    expect(bodies).toHaveLength(2);
    expect(recorded.receipts).toHaveLength(2);
  });

  it('denies the tool follow-up when a prior meaning send leaves only one ordinary generation send', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'query_semantic_model', arguments: '{}' },
        }],
      } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    let runWideAttempts = 1; // The bounded meaning-resolution send already occurred.
    const provider = new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' });

    await expect(provider.generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }],
      tools,
      {
        maxToolCalls: 4,
        maxProviderDispatches: 2,
        onProviderDispatch: (event) => {
          runWideAttempts += 1;
          if (runWideAttempts > 2) {
            throw Object.assign(new Error('Run-wide provider dispatch budget exhausted.'), {
              code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED',
            });
          }
          return event.envelope;
        },
      },
    )).rejects.toMatchObject({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' });
    expect(runWideAttempts).toBe(3);
    expect(bodies).toHaveLength(1);
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s stops after a malicious second tool-request round', async (kind, createProvider) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: `call_${bodies.length}`, function: { name: 'query_semantic_model', arguments: '{}' } }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: `tool_${bodies.length}`, name: 'query_semantic_model', input: {} }] }), { status: 200 });
    }));
    const recorded = dispatchRecorder();
    const out = await createProvider().generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }], tools,
      { maxToolCalls: 4, maxProviderDispatches: 2, onProviderDispatch: recorded.observe },
    );
    expect(bodies).toHaveLength(2);
    expect(recorded.receipts).toHaveLength(2);
    expect(out).toMatch(/bounded tool round|dispatch budget/i);
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s attaches bounded Research row counts to the affected physical dispatch', async (kind, createProvider) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'sample_rows', arguments: '{}' } }] } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tool_1', name: 'sample_rows', input: {} }] }), { status: 200 });
      }
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }] }), { status: 200 });
    }));
    const recorded = dispatchRecorder({ purpose: 'research_narration', optIn: true });
    const researchTool: AgentToolDefinition = {
      name: 'sample_rows', description: 'Return an explicitly consented sample.', inputSchema: { type: 'object' },
      run: async () => ({ rows: redactProviderResultRows(
        Array.from({ length: 25 }, (_, index) => ({ customer_name: `ROW_CANARY_${index}`, amount: index })),
        20,
      ) }),
    };
    await expect(runAgenticToolLoop(
      createProvider(), [{ role: 'user', content: 'research customers' }], [researchTool], {
        maxToolCalls: 4,
        maxProviderDispatches: 2,
        onProviderDispatch: recorded.observe,
        providerPayloadGuard: {
          purpose: 'research_tool', allowedResultRowTools: { sample_rows: 20 }, onPayload: recorded.onPayload,
        },
      },
    )).resolves.toBe('done');
    expect(bodies).toHaveLength(2);
    expect(recorded.receipts.map((receipt) => receipt.resultRowCount)).toEqual([0, 20]);
    expect(recorded.receipts[1]).toMatchObject({ columnCount: 2, optIn: true });
    expect(JSON.stringify(bodies[1])).toContain('[REDACTED]');
    expect(JSON.stringify(bodies[1])).not.toContain('ROW_CANARY_');
  });

  it('blocks ordinary result rows before an OpenAI follow-up dispatch', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'sample_rows', arguments: '{}' } }] } }] }), { status: 200 });
    }));
    const recorded = dispatchRecorder();
    await expect(runAgenticToolLoop(
      new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1' }),
      [{ role: 'user', content: 'ordinary ask' }],
      [{ name: 'sample_rows', description: 'Rows', inputSchema: { type: 'object' }, run: async () => ({ rows: [{ secret: 'ROW_CANARY_ADA' }] }) }],
      {
        maxToolCalls: 4,
        onProviderDispatch: recorded.observe,
        providerPayloadGuard: { purpose: 'research_tool', allowedResultRowTools: {} },
      },
    )).resolves.toMatch(/bounded tool round|dispatch budget/i);
    expect(bodies).toHaveLength(2);
    expect(recorded.receipts).toHaveLength(2);
    expect(recorded.receipts.every((receipt) => receipt.resultRowCount === 0)).toBe(true);
    expect(JSON.stringify(bodies[1])).not.toContain('ROW_CANARY_ADA');
  });

  it('shares the 20-row Research sample allowance across four native calls in one batch', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: 'call_1', function: { name: 'sample_rows', arguments: '{}' } },
          { id: 'call_2', function: { name: 'sample_alias', arguments: '{}' } },
          { id: 'call_3', function: { name: 'sample_rows', arguments: '{}' } },
          { id: 'call_4', function: { name: 'sample_alias', arguments: '{}' } },
        ] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 });
    }));
    let disclosedRows = 0;
    const cumulative: number[] = [];
    const rows = redactProviderResultRows(
      Array.from({ length: 20 }, (_, index) => ({ customer_name: `CANARY_${index}`, amount: index })),
      20,
    );
    await runAgenticToolLoop(
      new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1' }),
      [{ role: 'user', content: 'research customers' }],
      [
        { name: 'sample_rows', description: 'sample', inputSchema: { type: 'object' }, run: async () => ({ rows }) },
        { name: 'sample_alias', description: 'sample alias', inputSchema: { type: 'object' }, run: async () => ({ rows }) },
      ],
      {
        maxToolCalls: 4,
        maxProviderDispatches: 2,
        providerPayloadGuard: {
          purpose: 'research_tool',
          allowedResultRowTools: { sample_rows: 20, sample_alias: 20 },
          resultRowBudgetGroupByTool: { sample_rows: 'sample', sample_alias: 'sample' },
          cumulativeResultRowBudgets: { sample: 20 },
          onPayload: ({ resultRowCount, cumulativeResultRowCount }) => {
            disclosedRows += resultRowCount;
            cumulative.push(cumulativeResultRowCount);
          },
        },
      },
    );
    expect(disclosedRows).toBe(20);
    expect(cumulative).toEqual([20, 20, 20, 20]);
    expect(JSON.stringify(bodies[1])).toContain('PROVIDER_RESULT_ROWS_CUMULATIVE_LIMIT');
  });
});
