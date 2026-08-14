import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from './gemini.js';
import { prepareProviderWireEnvelopeForDispatch } from '../provider-egress.js';
import type { ProviderDispatchEvent } from './types.js';

afterEach(() => vi.unstubAllGlobals());

describe('GeminiProvider physical dispatch accounting', () => {
  it('observes and sends the exact normalized body once', async () => {
    const bodies: unknown[] = [];
    const events: ProviderDispatchEvent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
    }));
    const provider = new GeminiProvider({ apiKey: 'test', model: 'gemini-test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onProviderDispatch: (event) => {
        const envelope = prepareProviderWireEnvelopeForDispatch(event.provider, event.envelope);
        events.push({ ...event, envelope });
        return envelope;
      },
    })).resolves.toBe('ok');
    expect(bodies).toHaveLength(1);
    expect(events).toHaveLength(bodies.length);
    expect(bodies[0]).toEqual(events[0].envelope);
  });

  it.each([
    ['failure', () => new Response('failed', { status: 500 })],
    ['cancellation', () => { throw new DOMException('cancelled', 'AbortError'); }],
  ])('records a %s attempt before fetch settles', async (_label, response) => {
    const events: ProviderDispatchEvent[] = [];
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GeminiProvider({ apiKey: 'test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onProviderDispatch: (event) => { events.push(event); return event.envelope; },
    })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(fetchMock.mock.calls.length);
  });
});
