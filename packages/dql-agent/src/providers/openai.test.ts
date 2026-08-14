import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai.js';
import {
  assertProviderPayloadAllowed,
  createProviderDispatchEgressReceipt,
  prepareProviderWireEnvelopeForDispatch,
} from '../provider-egress.js';
import type { ProviderDispatchEvent } from './types.js';

function dispatchRecorder() {
  const events: ProviderDispatchEvent[] = [];
  const receipts: ReturnType<typeof createProviderDispatchEgressReceipt>[] = [];
  return {
    events,
    receipts,
    observe: (event: ProviderDispatchEvent) => {
      const envelope = prepareProviderWireEnvelopeForDispatch(event.provider, event.envelope);
      assertProviderPayloadAllowed(envelope, { allowResultRows: false, maxResultRows: 0, purpose: 'answer_generation' });
      events.push({ ...event, envelope });
      receipts.push(createProviderDispatchEgressReceipt({
        purpose: 'answer_generation', provider: event.provider,
        permittedCategories: ['instructions', 'question'], optIn: false, envelope,
      }));
      return envelope;
    },
  };
}

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
    const recorded = dispatchRecorder();
    const result = await provider.generate([{ role: 'user', content: 'hello' }], {
      maxTokens: 64, onProviderDispatch: recorded.observe,
    });

    expect(result).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ max_tokens: 64 });
    expect(calls[0]).not.toHaveProperty('max_completion_tokens');
    expect(recorded.events).toHaveLength(calls.length);
    expect(recorded.receipts).toHaveLength(calls.length);
    expect(recorded.receipts[0]).toMatchObject({ resultRowCount: 0, columnCount: 0 });
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
    const recorded = dispatchRecorder();
    const result = await provider.generate([{ role: 'user', content: 'build metadata' }], {
      maxTokens: 128, onProviderDispatch: recorded.observe,
    });

    expect(result).toBe('{"name":"NBA"}');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ max_tokens: 128 });
    expect(calls[1]).toMatchObject({ max_completion_tokens: 128 });
    expect(calls[1]).not.toHaveProperty('max_tokens');
    expect(recorded.events.map((event) => event.attemptIndex)).toEqual([1, 2]);
    expect(recorded.receipts).toHaveLength(calls.length);
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

  it.each([
    ['failed dispatch', () => new Response('provider failed', { status: 500 })],
    ['cancelled dispatch', () => { throw new DOMException('cancelled', 'AbortError'); }],
  ])('records one exact receipt for a %s', async (_label, response) => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const recorded = dispatchRecorder();
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: 'https://example.test/v1' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onProviderDispatch: recorded.observe,
    })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorded.events).toHaveLength(1);
    expect(recorded.receipts).toHaveLength(1);
  });
});
