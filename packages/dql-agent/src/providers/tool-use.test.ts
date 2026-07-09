import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import type { AgentToolDefinition } from './types.js';

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
    const provider = new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' });
    const out = await provider.generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }],
      tools,
      { maxToolCalls: 3, onToolCall: (event) => seen.push(event) },
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
    const provider = new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' });
    const out = await provider.generateWithTools!(
      [{ role: 'user', content: 'monthly revenue' }],
      tools,
      { maxToolCalls: 3, onToolCall: (event) => seen.push(event) },
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
});
