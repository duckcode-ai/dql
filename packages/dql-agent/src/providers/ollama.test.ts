import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from './ollama.js';
import { prepareProviderWireEnvelopeForDispatch } from '../provider-egress.js';
import type { ProviderDispatchEvent } from './types.js';

afterEach(() => vi.unstubAllGlobals());

describe('OllamaProvider physical dispatch accounting', () => {
  it('counts every POST endpoint attempt and sends the observed body', async () => {
    const bodies: unknown[] = [];
    const events: ProviderDispatchEvent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('{}', { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return new Response('retry', { status: 500 });
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
    }));
    const provider = new OllamaProvider({ baseUrl: 'http://primary.test', model: 'local-test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      maxProviderDispatches: 2,
      onProviderDispatch: (event) => {
        const envelope = prepareProviderWireEnvelopeForDispatch(event.provider, event.envelope);
        events.push({ ...event, envelope });
        return envelope;
      },
    })).resolves.toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(events.map((event) => event.attemptIndex)).toEqual([1, 2]);
    expect(events).toHaveLength(bodies.length);
    expect(bodies).toEqual(events.map((event) => event.envelope));
  });

  it('fails closed before a third endpoint dispatch', async () => {
    const events: ProviderDispatchEvent[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (
      (init?.method ?? 'GET') === 'GET'
        ? new Response('{}', { status: 200 })
        : new Response('retry', { status: 500 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({ baseUrl: 'http://primary.test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      maxProviderDispatches: 2,
      onProviderDispatch: (event) => { events.push(event); return event.envelope; },
    })).rejects.toThrow(/dispatch budget exhausted/i);
    expect(events).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'POST')).toHaveLength(2);
  });
});
