import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Capture the JSON body of the (single) fetch call a provider makes. */
function stubFetch(responseJson: unknown): { bodies: any[] } {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return { bodies };
}

describe('reasoning effort wiring — Claude (output_config.effort)', () => {
  const ok = { content: [{ type: 'text', text: 'ok' }] };

  it('adds output_config.effort for a reasoning-capable model', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-7' });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' });
    expect(bodies[0].output_config).toEqual({ effort: 'high' });
  });

  it('omits output_config when no effort is requested', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-7' });
    await provider.generate([{ role: 'user', content: 'hi' }], {});
    expect(bodies[0]).not.toHaveProperty('output_config');
  });

  it('omits output_config for a non-reasoning model even when effort is set', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-3-5-sonnet' });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' });
    expect(bodies[0]).not.toHaveProperty('output_config');
  });

  it('retries WITHOUT output_config when the API 400s implicating effort', async () => {
    const bodies: any[] = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ type: 'error', error: { message: 'output_config.effort is not supported for this model' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(ok), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-7' });
    const result = await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' });
    expect(result).toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].output_config).toEqual({ effort: 'high' }); // first attempt carried it
    expect(bodies[1]).not.toHaveProperty('output_config'); // retry stripped it
  });
});

describe('reasoning effort wiring — OpenAI (reasoning_effort)', () => {
  const ok = { choices: [{ message: { content: 'ok' } }] };

  it('adds reasoning_effort for an o-series / gpt-5 model', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new OpenAIProvider({ apiKey: 'k', model: 'gpt-5' });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'medium' });
    expect(bodies[0].reasoning_effort).toBe('medium');
  });

  it('omits reasoning_effort for a non-reasoning model (gpt-4.1-mini)', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new OpenAIProvider({ apiKey: 'k', model: 'gpt-4.1-mini' });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' });
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });
});

describe('reasoning effort wiring — Gemini (thinkingConfig)', () => {
  const ok = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };

  it('adds a thinkingBudget for Gemini 2.5', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-2.5-pro' });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' });
    expect(bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingBudget: 16384 });
  });

  it('adds a thinkingLevel for Gemini 3', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-3-pro' });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'low' });
    expect(bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('omits thinkingConfig for a non-thinking Gemini model', async () => {
    const { bodies } = stubFetch(ok);
    const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-1.5-flash' });
    await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' });
    expect(bodies[0].generationConfig).not.toHaveProperty('thinkingConfig');
  });
});
