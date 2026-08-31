import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import type { AgentProvider, AgentToolDefinition, ProviderDispatchEvent } from './types.js';
import { runAgenticToolLoop, runAgenticToolLoopDetailed } from '../agentic/tool-loop.js';
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

  it('OpenAIProvider refreshes the native tool declaration after a host policy update', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ choices: [{ message: {
          content: null,
          tool_calls: [{ id: 'inspect', function: { name: 'inspect_semantic', arguments: '{}' } }],
        } }] }), { status: 200 });
      }
      if (bodies.length === 2) {
        return new Response(JSON.stringify({ choices: [{ message: {
          content: null,
          tool_calls: [{ id: 'compile', function: { name: 'compile_semantic', arguments: '{}' } }],
        } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'semantic result complete' } }] }), { status: 200 });
    }));

    let semanticReady = false;
    const out = await new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1' }).generateWithTools!(
      [{ role: 'user', content: 'revenue by month' }],
      [
        {
          name: 'inspect_semantic', description: 'inspect', inputSchema: { type: 'object' },
          run: async () => {
            semanticReady = true;
            return { compatible: true };
          },
        },
        { name: 'compile_semantic', description: 'compile', inputSchema: { type: 'object' }, run: async () => ({ executed: true }) },
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 4,
        getCurrentToolPolicy: () => semanticReady
          ? { allowedToolNames: ['compile_semantic'], instruction: 'Compile the admitted semantic selection now.' }
          : { allowedToolNames: ['inspect_semantic'] },
      },
    );

    expect(out).toBe('semantic result complete');
    const toolNames = (body: Record<string, unknown>) => ((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
      .map((entry) => entry.function?.name);
    expect(toolNames(bodies[0]!)).toEqual(['inspect_semantic']);
    expect(toolNames(bodies[1]!)).toEqual(['compile_semantic']);
    expect(JSON.stringify(bodies[1]!.messages)).toContain('semantic');
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s reserves exactly one controller-approved native terminal action for each analytical tier', async (kind, createProvider) => {
    for (const terminalAction of ['compile_and_run_semantic', 'compile_and_run_dql', 'validate_and_run_sql'] as const) {
      const bodies: Array<Record<string, unknown>> = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        const first = bodies.length === 1;
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: {
            content: null,
            tool_calls: [{
              id: `call_${bodies.length}`,
              type: 'function',
              function: { name: first ? 'inspect_context' : terminalAction, arguments: '{}' },
            }],
          } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{
            type: 'tool_use', id: `tool_${bodies.length}`, name: first ? 'inspect_context' : terminalAction, input: {},
          }] }), { status: 200 });
      }));

      let inspected = false;
      const executed: string[] = [];
      const nativeTools: AgentToolDefinition[] = [
        { name: 'inspect_context', description: 'Inspect admitted context.', inputSchema: { type: 'object' }, run: async () => { inspected = true; return { inspected: true }; } },
        ...['compile_and_run_semantic', 'compile_and_run_dql', 'validate_and_run_sql'].map((name) => ({
          name,
          description: `Execute ${name}.`,
          inputSchema: { type: 'object' },
          run: async () => { executed.push(name); return { executed: true }; },
        })),
      ];
      const seen: string[] = [];
      await createProvider().generateWithTools!(
        [{ role: 'user', content: 'answer this analytical question' }],
        nativeTools,
        {
          maxToolCalls: 8,
          maxProviderDispatches: 2,
          getCurrentToolPolicy: () => inspected
            ? { allowedToolNames: [terminalAction], terminalActionToolNames: [terminalAction], instruction: `Call ${terminalAction} now.` }
            : { allowedToolNames: ['inspect_context'] },
          onToolCall: ({ name }) => seen.push(name),
        },
      );

      const toolNames = (body: Record<string, unknown>) => kind === 'OpenAI'
        ? ((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((entry) => entry.function?.name)
        : ((body.tools as Array<{ name?: string }>) ?? []).map((entry) => entry.name);
      expect(executed).toEqual([terminalAction]);
      expect(seen).toEqual(['inspect_context', terminalAction]);
      expect(bodies).toHaveLength(2);
      expect(toolNames(bodies[0]!)).toEqual(['inspect_context']);
      expect(toolNames(bodies[1]!)).toEqual([terminalAction]);
      expect(bodies[1]!.tool_choice).toEqual(kind === 'OpenAI'
        ? { type: 'function', function: { name: terminalAction } }
        : { type: 'tool', name: terminalAction });
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s rejects any non-controller-approved native call in the reserved terminal send', async (kind, createProvider) => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'inspect', type: 'function', function: { name: 'inspect_context', arguments: '{}' } }] } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'inspect', name: 'inspect_context', input: {} }] }), { status: 200 });
      }
      if (bodies.length === 2) {
        // This name is not present in the second request's native declaration.
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'wrong', type: 'function', function: { name: 'validate_and_run_sql', arguments: '{}' } }] } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'wrong', name: 'validate_and_run_sql', input: {} }] }), { status: 200 });
      }
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: 'bounded final answer' } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'bounded final answer' }] }), { status: 200 });
    }));

    let inspected = false;
    const executed: string[] = [];
    const seen: string[] = [];
    await expect(createProvider().generateWithTools!(
      [{ role: 'user', content: 'answer this analytical question' }],
      [
        { name: 'inspect_context', description: 'Inspect admitted context.', inputSchema: { type: 'object' }, run: async () => { inspected = true; return { inspected: true }; } },
        { name: 'compile_and_run_semantic', description: 'Compile semantic.', inputSchema: { type: 'object' }, run: async () => { executed.push('semantic'); return { executed: true }; } },
        { name: 'validate_and_run_sql', description: 'Validate SQL.', inputSchema: { type: 'object' }, run: async () => { executed.push('sql'); return { executed: true }; } },
      ],
      {
        // One ordinary inspection leaves the second send as the reserved
        // terminal-action round and a third physical send for forced prose.
        maxToolCalls: 1,
        maxProviderDispatches: 3,
        getCurrentToolPolicy: () => inspected
          ? { allowedToolNames: ['compile_and_run_semantic'], terminalActionToolNames: ['compile_and_run_semantic'] }
          : { allowedToolNames: ['inspect_context'] },
        onToolCall: ({ name }) => seen.push(name),
      },
    )).resolves.toMatchObject({ version: 1, kind: 'tool_budget_exhausted', toolCalls: 1 });

    const secondToolNames = kind === 'OpenAI'
      ? ((bodies[1]!.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((entry) => entry.function?.name)
      : ((bodies[1]!.tools as Array<{ name?: string }>) ?? []).map((entry) => entry.name);
    expect(secondToolNames).toEqual(['compile_and_run_semantic']);
    expect(executed).toEqual([]);
    expect(seen).toEqual(['inspect_context', 'tool_budget_exhausted']);
    // A dynamic Ask V2 policy must preserve the typed exhaustion boundary;
    // it cannot convert an invalid final native action into forced prose.
    expect(bodies).toHaveLength(2);
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s continues after a rejected Ask V2 finish control and executes the safe-next semantic action', async (kind, createProvider) => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const toolName = bodies.length === 1
        ? 'inspect_semantic'
        : bodies.length === 2
          ? 'finish_answer'
          : 'compile_and_run_semantic';
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: {
          content: null,
          tool_calls: [{
            id: `call_${bodies.length}`,
            type: 'function',
            function: { name: toolName, arguments: '{}' },
          }],
        } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{
          type: 'tool_use', id: `tool_${bodies.length}`, name: toolName, input: {},
        }] }), { status: 200 });
    }));

    let phase: 'inspect' | 'rejected_finish' | 'execute' = 'inspect';
    const executed: string[] = [];
    const seen: string[] = [];
    await createProvider().generateWithTools!(
      [{ role: 'user', content: 'revenue by month' }],
      [
        {
          name: 'inspect_semantic', description: 'Inspect admitted semantic context.', inputSchema: { type: 'object' },
          run: async () => {
            phase = 'rejected_finish';
            return { compatible: true };
          },
        },
        {
          name: 'finish_answer', description: 'Finish only after a validated result.', inputSchema: { type: 'object' },
          run: async () => {
            phase = 'execute';
            return {
              ok: false,
              reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
              safeNextTools: ['compile_and_run_semantic'],
            };
          },
        },
        {
          name: 'compile_and_run_semantic', description: 'Compile the admitted semantic selection.', inputSchema: { type: 'object' },
          run: async () => {
            executed.push('semantic');
            return { executed: true };
          },
        },
      ],
      {
        // The third physical send is reserved for the controller-selected
        // semantic action after the premature finish becomes an observation.
        maxToolCalls: 8,
        maxProviderDispatches: 3,
        getCurrentToolPolicy: () => phase === 'inspect'
          ? { allowedToolNames: ['inspect_semantic'] }
          : phase === 'rejected_finish'
            ? { allowedToolNames: ['finish_answer'] }
            : {
                allowedToolNames: ['compile_and_run_semantic'],
                terminalActionToolNames: ['compile_and_run_semantic'],
                instruction: 'Finish was rejected. Compile semantic now.',
              },
        onToolCall: ({ name }) => seen.push(name),
      },
    );

    const toolNames = (body: Record<string, unknown>) => kind === 'OpenAI'
      ? ((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((entry) => entry.function?.name)
      : ((body.tools as Array<{ name?: string }>) ?? []).map((entry) => entry.name);
    expect(bodies).toHaveLength(3);
    expect(toolNames(bodies[0]!)).toEqual(['inspect_semantic']);
    expect(toolNames(bodies[1]!)).toEqual(['finish_answer']);
    expect(toolNames(bodies[2]!)).toEqual(['compile_and_run_semantic']);
    expect(seen).toEqual(['inspect_semantic', 'finish_answer', 'compile_and_run_semantic']);
    expect(executed).toEqual(['semantic']);
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s discards a no-tool prose reply while semantic execution is required and re-dispatches only the semantic tool', async (kind, createProvider) => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'inspect', type: 'function', function: { name: 'inspect_semantic', arguments: '{}' } }] } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'inspect', name: 'inspect_semantic', input: {} }] }), { status: 200 });
      }
      if (bodies.length === 2) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: 'I can answer without execution.' } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'text', text: 'I can answer without execution.' }] }), { status: 200 });
      }
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'semantic', type: 'function', function: { name: 'compile_and_run_semantic', arguments: '{}' } }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'semantic', name: 'compile_and_run_semantic', input: {} }] }), { status: 200 });
    }));

    let phase: 'inspect' | 'execute' = 'inspect';
    const executed: string[] = [];
    await createProvider().generateWithTools!(
      [{ role: 'user', content: 'revenue by month' }],
      [
        { name: 'inspect_semantic', description: 'Inspect semantic.', inputSchema: { type: 'object' }, run: async () => { phase = 'execute'; return { compatible: true }; } },
        { name: 'compile_and_run_semantic', description: 'Compile semantic.', inputSchema: { type: 'object' }, run: async () => { executed.push('semantic'); return { executed: true }; } },
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 3,
        getCurrentToolPolicy: () => phase === 'inspect'
          ? { allowedToolNames: ['inspect_semantic'] }
          : { allowedToolNames: ['compile_and_run_semantic'], terminalActionToolNames: ['compile_and_run_semantic'] },
      },
    );

    const toolNames = (body: Record<string, unknown>) => kind === 'OpenAI'
      ? ((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((entry) => entry.function?.name)
      : ((body.tools as Array<{ name?: string }>) ?? []).map((entry) => entry.name);
    expect(bodies).toHaveLength(3);
    expect(toolNames(bodies[2]!)).toEqual(['compile_and_run_semantic']);
    expect(JSON.stringify(bodies[2]!)).not.toContain('I can answer without execution');
    expect(executed).toEqual(['semantic']);
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s stops after one constrained retry when a required semantic action receives prose twice', async (kind, createProvider) => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'inspect', type: 'function', function: { name: 'inspect_semantic', arguments: '{}' } }] } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'inspect', name: 'inspect_semantic', input: {} }] }), { status: 200 });
      }
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: 'I will not call the required tool.' } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'I will not call the required tool.' }] }), { status: 200 });
    }));

    let inspected = false;
    const result = await createProvider().generateWithTools!(
      [{ role: 'user', content: 'revenue by month' }],
      [
        { name: 'inspect_semantic', description: 'Inspect semantic.', inputSchema: { type: 'object' }, run: async () => { inspected = true; return { compatible: true }; } },
        { name: 'compile_and_run_semantic', description: 'Compile semantic.', inputSchema: { type: 'object' }, run: async () => ({ executed: true }) },
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 6,
        getCurrentToolPolicy: () => inspected
          ? { allowedToolNames: ['compile_and_run_semantic'], terminalActionToolNames: ['compile_and_run_semantic'] }
          : { allowedToolNames: ['inspect_semantic'] },
      },
    );

    expect(result).toMatchObject({ version: 1, kind: 'invalid_tool_response', toolCalls: 1 });
    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.tool_choice).toEqual(kind === 'OpenAI'
      ? { type: 'function', function: { name: 'compile_and_run_semantic' } }
      : { type: 'tool', name: 'compile_and_run_semantic' });
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s discards post-execution prose and re-dispatches only host finish_answer', async (kind, createProvider) => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'run', type: 'function', function: { name: 'run_certified', arguments: '{}' } }] } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'run', name: 'run_certified', input: {} }] }), { status: 200 });
      }
      if (bodies.length === 2) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: { content: 'The result is already complete.' } }] }), { status: 200 })
          : new Response(JSON.stringify({ content: [{ type: 'text', text: 'The result is already complete.' }] }), { status: 200 });
      }
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finish_answer', arguments: '{"answer":"The result is ready."}' } }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'finish', name: 'finish_answer', input: { answer: 'The result is ready.' } }] }), { status: 200 });
    }));

    let executed = false;
    const seen: string[] = [];
    await expect(createProvider().generateWithTools!(
      [{ role: 'user', content: 'who are the top customers?' }],
      [
        { name: 'run_certified', description: 'Run the frozen certified block.', inputSchema: { type: 'object' }, run: async () => { executed = true; return { executed: true }; } },
        { name: 'finish_answer', description: 'Finish the host-validated result.', inputSchema: { type: 'object' }, run: async () => ({ finished: true }) },
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 3,
        // The result has already executed when finish_answer is requested.
        // A soft-target guard must not treat this host-local control as a new
        // discovery branch.
        mayStartToolCall: () => !executed,
        getCurrentToolPolicy: () => executed
          ? { allowedToolNames: ['finish_answer'], terminalActionToolNames: ['finish_answer'] }
          : { allowedToolNames: ['run_certified'], terminalActionToolNames: ['run_certified'] },
        onToolCall: ({ name }) => seen.push(name),
      },
    )).resolves.toBe('');

    const toolNames = (body: Record<string, unknown>) => kind === 'OpenAI'
      ? ((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((entry) => entry.function?.name)
      : ((body.tools as Array<{ name?: string }>) ?? []).map((entry) => entry.name);
    expect(bodies).toHaveLength(3);
    expect(toolNames(bodies[1]!)).toEqual(['finish_answer']);
    expect(toolNames(bodies[2]!)).toEqual(['finish_answer']);
    expect(JSON.stringify(bodies[2]!)).not.toContain('The result is already complete.');
    expect(seen).toEqual(['run_certified', 'finish_answer']);
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s preserves a post-result run deadline as a typed native stop', async (kind, createProvider) => {
    let fetches = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetches += 1;
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: {
          content: null,
          tool_calls: [{ id: 'run', type: 'function', function: { name: 'run_certified', arguments: '{}' } }],
        } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{
          type: 'tool_use', id: 'run', name: 'run_certified', input: {},
        }] }), { status: 200 });
    }));
    let executed = false;
    const observed: Array<{ name: string; output?: unknown; isError?: boolean }> = [];
    const result = await runAgenticToolLoopDetailed(
      createProvider(),
      [{ role: 'user', content: 'who are the top customers?' }],
      [
        { name: 'run_certified', description: 'Run the frozen certified block.', inputSchema: { type: 'object' }, run: async () => { executed = true; return { executed: true }; } },
        { name: 'finish_answer', description: 'Finish the host-validated result.', inputSchema: { type: 'object' }, run: async () => ({ finished: true }) },
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 3,
        getCurrentToolPolicy: () => executed
          ? { allowedToolNames: ['finish_answer'], terminalActionToolNames: ['finish_answer'] }
          : { allowedToolNames: ['run_certified'] },
        onToolCall: (event) => observed.push(event),
        onProviderDispatch: (event) => {
          if (event.attemptIndex === 2) {
            throw Object.assign(new Error('The run soft target elapsed before narration could begin.'), {
              code: 'RUN_SOFT_TARGET_EXCEEDED',
            });
          }
          return event.envelope;
        },
      },
    );

    expect(result).toMatchObject({ stop: 'run_soft_target_exceeded', toolCalls: 1 });
    expect(fetches).toBe(1);
    expect(observed).toEqual([expect.objectContaining({ name: 'run_certified', isError: false })]);
  });

  it('preserves a post-result text-provider deadline without relabeling it as a tool budget', async () => {
    let executed = false;
    let turn = 0;
    const provider: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async () => {
        if (turn++ === 0) return '```json\n{"tool":"run_certified","input":{}}\n```';
        throw Object.assign(new Error('The run deadline has no narration allowance remaining.'), {
          code: 'RUN_DEADLINE_INSUFFICIENT',
        });
      },
    };
    const result = await runAgenticToolLoopDetailed(
      provider,
      [{ role: 'user', content: 'who are the top customers?' }],
      [
        { name: 'run_certified', description: 'Run the frozen certified block.', inputSchema: { type: 'object' }, run: async () => { executed = true; return { executed: true }; } },
        { name: 'finish_answer', description: 'Finish the host-validated result.', inputSchema: { type: 'object' }, run: async () => ({ finished: true }) },
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 3,
        getCurrentToolPolicy: () => executed
          ? { allowedToolNames: ['finish_answer'], terminalActionToolNames: ['finish_answer'] }
          : { allowedToolNames: ['run_certified'] },
      },
    );

    expect(result).toMatchObject({ stop: 'run_deadline_insufficient', toolCalls: 1 });
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s returns a typed tool-budget stop for an invalid final V2 action', async (kind, createProvider) => {
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'OpenAI'
      ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'wrong', type: 'function', function: { name: 'invented_tool', arguments: '{}' } }] } }] }), { status: 200 })
      : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'wrong', name: 'invented_tool', input: {} }] }), { status: 200 })));
    const seen: string[] = [];
    const result = await runAgenticToolLoopDetailed(
      createProvider(),
      [{ role: 'user', content: 'revenue by month' }],
      [{ name: 'compile_and_run_semantic', description: 'Compile semantic.', inputSchema: { type: 'object' }, run: async () => ({ executed: true }) }],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 1,
        getCurrentToolPolicy: () => ({
          allowedToolNames: ['compile_and_run_semantic'],
          terminalActionToolNames: ['compile_and_run_semantic'],
        }),
        onToolCall: ({ name }) => seen.push(name),
      },
    );

    expect(result).toMatchObject({ stop: 'tool_budget_exhausted', toolCalls: 0 });
    expect(seen).toEqual(['tool_budget_exhausted']);
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

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s stops immediately after canonical Ask V2 finish_answer instead of spending another provider dispatch', async (kind, createProvider) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: {
          content: null,
          tool_calls: [{
            id: 'finish_1', type: 'function',
            function: { name: 'finish_answer', arguments: '{"answer":"Revenue is validated."}' },
          }],
        } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ content: [{
          type: 'tool_use', id: 'finish_1', name: 'finish_answer', input: { answer: 'Revenue is validated.' },
        }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const finish = vi.fn(async () => ({ finished: true, answer: 'Revenue is validated.' }));
    const seen: string[] = [];

    await expect(createProvider().generateWithTools!(
      [{ role: 'user', content: 'show revenue' }],
      [{
        name: 'finish_answer', description: 'End the authoritative Ask V2 turn.', inputSchema: { type: 'object' }, run: finish,
      }],
      { maxToolCalls: 8, maxProviderDispatches: 6, onToolCall: ({ name }) => seen.push(name) },
    )).resolves.toBe('');

    expect(finish).toHaveBeenCalledOnce();
    expect(seen).toEqual(['finish_answer']);
    // The authoritative tool owns final narration. A second HTTP completion
    // would be an extra planner send and can overwrite a validated result
    // with a budget error.
    expect(bodies).toHaveLength(1);
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
