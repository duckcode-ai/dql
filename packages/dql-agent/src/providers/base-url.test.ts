import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider, normalizeAnthropicBaseUrl } from './claude.js';
import { GeminiProvider, normalizeGeminiBaseUrl } from './gemini.js';

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(jsonBody: unknown): { calls: CapturedRequest[]; restore: () => void } {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => jsonBody,
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe('provider base-URL normalization', () => {
  it('normalizes Anthropic base URLs to the SDK root convention', () => {
    expect(normalizeAnthropicBaseUrl(undefined)).toBe('https://api.anthropic.com');
    expect(normalizeAnthropicBaseUrl('')).toBe('https://api.anthropic.com');
    expect(normalizeAnthropicBaseUrl('https://gw.corp/anthropic/')).toBe('https://gw.corp/anthropic');
    expect(normalizeAnthropicBaseUrl('https://gw.corp/anthropic/v1')).toBe('https://gw.corp/anthropic');
  });

  it('normalizes Gemini base URLs (keeps the version segment)', () => {
    expect(normalizeGeminiBaseUrl(undefined)).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(normalizeGeminiBaseUrl('https://gw.corp/gemini/v1beta/')).toBe('https://gw.corp/gemini/v1beta');
  });
});

describe('ClaudeProvider enterprise auth', () => {
  beforeEach(() => { vi.stubEnv('ANTHROPIC_BASE_URL', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('routes through a custom base URL and sends the API key header', async () => {
    const fetchMock = mockFetch({ content: [{ type: 'text', text: 'OK' }] });
    try {
      const provider = new ClaudeProvider({ apiKey: 'sk-ent', baseUrl: 'https://gw.corp/anthropic' });
      const out = await provider.generate([{ role: 'user', content: 'hi' }]);
      expect(out).toBe('OK');
      expect(fetchMock.calls[0].url).toBe('https://gw.corp/anthropic/v1/messages');
      expect(fetchMock.calls[0].headers['x-api-key']).toBe('sk-ent');
    } finally {
      fetchMock.restore();
    }
  });

  it('falls back to the public Anthropic host when no base URL is set', async () => {
    const fetchMock = mockFetch({ content: [{ type: 'text', text: 'OK' }] });
    try {
      const provider = new ClaudeProvider({ apiKey: 'sk-ent' });
      await provider.generate([{ role: 'user', content: 'hi' }]);
      expect(fetchMock.calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    } finally {
      fetchMock.restore();
    }
  });
});

describe('GeminiProvider enterprise auth', () => {
  beforeEach(() => { vi.stubEnv('GEMINI_BASE_URL', ''); vi.stubEnv('GOOGLE_GEMINI_BASE_URL', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('routes through a custom base URL and sends the key as a header (not a query param)', async () => {
    const fetchMock = mockFetch({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    try {
      const provider = new GeminiProvider({ apiKey: 'goog-ent', baseUrl: 'https://gw.corp/gemini/v1beta', model: 'gemini-x' });
      const out = await provider.generate([{ role: 'user', content: 'hi' }]);
      expect(out).toBe('OK');
      expect(fetchMock.calls[0].url).toBe('https://gw.corp/gemini/v1beta/models/gemini-x:generateContent');
      expect(fetchMock.calls[0].url).not.toContain('key=');
      expect(fetchMock.calls[0].headers['x-goog-api-key']).toBe('goog-ent');
    } finally {
      fetchMock.restore();
    }
  });

  it('falls back to the public Gemini host when no base URL is set', async () => {
    const fetchMock = mockFetch({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    try {
      const provider = new GeminiProvider({ apiKey: 'goog-ent', model: 'gemini-x' });
      await provider.generate([{ role: 'user', content: 'hi' }]);
      expect(fetchMock.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
    } finally {
      fetchMock.restore();
    }
  });
});
