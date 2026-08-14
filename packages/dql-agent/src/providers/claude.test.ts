import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from './claude.js';
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

afterEach(() => vi.unstubAllGlobals());

describe('ClaudeProvider dispatch accounting', () => {
  it('records and sends one normalized envelope for a plain call', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    }));
    const recorded = dispatchRecorder();
    const provider = new ClaudeProvider({ apiKey: 'test', model: 'claude-test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onProviderDispatch: recorded.observe,
    })).resolves.toBe('ok');
    expect(bodies).toHaveLength(1);
    expect(recorded.events).toHaveLength(bodies.length);
    expect(recorded.receipts).toHaveLength(bodies.length);
    expect(recorded.receipts[0]).toMatchObject({ resultRowCount: 0, columnCount: 0 });
  });

  it('counts the effort-compatibility retry as a second physical dispatch', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return new Response('unsupported output_config effort', { status: 400 });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    }));
    const recorded = dispatchRecorder();
    const provider = new ClaudeProvider({ apiKey: 'test', model: 'claude-opus-4-7' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      reasoningEffort: 'high', onProviderDispatch: recorded.observe,
    })).resolves.toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('output_config');
    expect(bodies[1]).not.toHaveProperty('output_config');
    expect(recorded.events.map((event) => event.attemptIndex)).toEqual([1, 2]);
    expect(recorded.receipts).toHaveLength(bodies.length);
  });

  it.each([
    ['failed', () => new Response('provider failed', { status: 500 })],
    ['cancelled', () => { throw new DOMException('cancelled', 'AbortError'); }],
  ])('records one receipt when a dispatch is %s', async (_label, response) => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const recorded = dispatchRecorder();
    const provider = new ClaudeProvider({ apiKey: 'test', model: 'claude-test' });
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onProviderDispatch: recorded.observe,
    })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorded.events).toHaveLength(1);
    expect(recorded.receipts).toHaveLength(1);
  });
});
