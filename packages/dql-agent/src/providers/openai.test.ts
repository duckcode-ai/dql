import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIProvider', () => {
  it('uses max_tokens for chat-completions compatible providers by default', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'local-model' });
    const result = await provider.generate([{ role: 'user', content: 'hello' }], { maxTokens: 64 });

    expect(result).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ max_tokens: 64 });
    expect(calls[0]).not.toHaveProperty('max_completion_tokens');
  });

  it('retries with max_completion_tokens when newer OpenAI models reject max_tokens', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"name":"NBA"}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const provider = new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-5' });
    const result = await provider.generate([{ role: 'user', content: 'build metadata' }], { maxTokens: 128 });

    expect(result).toBe('{"name":"NBA"}');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ max_tokens: 128 });
    expect(calls[1]).toMatchObject({ max_completion_tokens: 128 });
    expect(calls[1]).not.toHaveProperty('max_tokens');
  });

  it('retries without temperature when newer OpenAI models require the default value', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.",
          },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"description":"NBA scoring leaders"}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const provider = new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-5' });
    const result = await provider.generate([{ role: 'user', content: 'build metadata' }], { maxTokens: 128, temperature: 0.1 });

    expect(result).toBe('{"description":"NBA scoring leaders"}');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ temperature: 0.1 });
    expect(calls[1]).not.toHaveProperty('temperature');
  });
});
