import { describe, expect, it, vi, afterEach } from 'vitest';
import { postMessages } from './claude.js';

/**
 * Extended thinking and a custom temperature cannot travel together: the
 * Messages API allows `temperature` only at 1 while thinking is enabled, and
 * 400s otherwise. Every Ask turn on a subscription transport carried both — a
 * reasoning effort from the run, a temperature from the caller — so every one
 * failed, and the user was told "The AI provider could not complete this Ask
 * step" for a perfectly well-formed question.
 */
afterEach(() => vi.unstubAllGlobals());

function captureFetch(status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status });
  }));
  return bodies;
}

const dispatch = { operation: 'generate' as const, options: {}, nextAttempt: () => 1 };

describe('sampling fields alongside extended thinking', () => {
  it('drops temperature when thinking is enabled', async () => {
    const bodies = captureFetch();
    await postMessages('https://api.anthropic.com/v1/messages', {}, {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      temperature: 0.3,
      messages: [],
    }, { thinking: { type: 'enabled', budget_tokens: 8192 } }, dispatch);
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]!.thinking).toMatchObject({ type: 'enabled' });
  });

  it('keeps temperature when thinking is disabled, which is the ordinary case', async () => {
    const bodies = captureFetch();
    await postMessages('https://api.anthropic.com/v1/messages', {}, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      temperature: 0.2,
      messages: [],
    }, { thinking: { type: 'disabled' } }, dispatch);
    expect(bodies[0]!.temperature).toBe(0.2);
  });

  it('keeps temperature when no reasoning config is sent at all', async () => {
    const bodies = captureFetch();
    await postMessages('https://api.anthropic.com/v1/messages', {}, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      temperature: 0.2,
      messages: [],
    }, {}, dispatch);
    expect(bodies[0]!.temperature).toBe(0.2);
  });

  it('drops only the sampling field the API named, keeping the run\'s reasoning', async () => {
    // A model that retires `temperature` should cost a field, not a turn — and
    // not the extended thinking the run explicitly asked for.
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ error: { message: '`temperature` is deprecated for this model.' } }), { status: 400 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    }));
    const res = await postMessages('https://api.anthropic.com/v1/messages', {}, {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      temperature: 0.2,
      messages: [],
    }, { thinking: { type: 'disabled' } }, { ...dispatch, nextAttempt: () => call + 1 });
    expect(res.status).toBe(200);
    expect(bodies[1]).not.toHaveProperty('temperature');
    expect(bodies[1]!.thinking).toMatchObject({ type: 'disabled' });
  });

  it('retries without the reasoning config when the API still rejects it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ error: { message: 'output_config.effort: unsupported for this model' } }), { status: 400 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    }));
    const res = await postMessages('https://api.anthropic.com/v1/messages', {}, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      temperature: 0.2,
      messages: [],
    }, { thinking: { type: 'enabled', budget_tokens: 2048 } }, { ...dispatch, nextAttempt: () => call + 1 });
    expect(res.status).toBe(200);
    // The retry carries the caller's temperature and no thinking config.
    expect(bodies[1]).not.toHaveProperty('thinking');
    expect(bodies[1]!.temperature).toBe(0.2);
  });
});

describe('remembering a retired sampling control', () => {
  it('stops sending temperature to a model that has already rejected it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      call += 1;
      // Only the very first request 400s; everything after must already omit it.
      return call === 1
        ? new Response(JSON.stringify({ error: { message: '`temperature` is deprecated for this model.' } }), { status: 400 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    }));
    const body = () => ({ model: 'claude-retired-temp', max_tokens: 512, temperature: 0.2, messages: [] });
    // Each call is its own dispatch with its own attempt counter, as a real
    // turn's successive sends are.
    const send = () => postMessages('https://api.anthropic.com/v1/messages', {}, body(), {}, {
      operation: 'generate' as const,
      options: { maxProviderDispatches: 8 },
      nextAttempt: () => call + 1,
    });
    await send();
    await send();
    await send();
    // 1 rejected + 1 retry, then two clean sends: four requests, and only the
    // first ever carried the field.
    expect(bodies).toHaveLength(4);
    expect(bodies.filter((sent) => 'temperature' in sent)).toHaveLength(1);
  });
});
