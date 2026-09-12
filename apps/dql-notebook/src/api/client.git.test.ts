import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from './client';

let api: typeof ClientModule.api;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  ({ api } = await import('./client'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('git client error handling', () => {
  it('surfaces a server failure instead of reporting "not a git repository"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'git status crashed' }, 500)));
    await expect(api.fetchGitStatus()).rejects.toThrow('git status crashed');
    await expect(api.fetchGitRemote()).rejects.toThrow('git status crashed');
  });

  it('reports inRepo false only when the server says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ inRepo: false, branch: null, ahead: 0, behind: 0, changes: [] })));
    await expect(api.fetchGitStatus()).resolves.toMatchObject({ inRepo: false });
  });

  it('keeps the server reason code on git write failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, code: 'no_remote', error: 'This project has no Git remote yet.' }, 400)));
    await expect(api.gitPush()).resolves.toEqual({ ok: false, code: 'no_remote', error: 'This project has no Git remote yet.' });
  });

  it('posts init and remote requests to the connection endpoints', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
      return jsonResponse({ ok: true });
    }));
    await api.gitInit();
    await api.gitAddRemote({ url: 'git@github.com:acme/analytics.git' });
    expect(calls).toEqual([
      { url: expect.stringMatching(/\/api\/git\/init$/), method: 'POST', body: '{}' },
      { url: expect.stringMatching(/\/api\/git\/remote$/), method: 'POST', body: JSON.stringify({ url: 'git@github.com:acme/analytics.git' }) },
    ]);
  });

  it('returns a typed block history status, including for older servers and failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ entries: [], status: 'not_a_repo', message: 'This project is not a Git repository yet.' })));
    await expect(api.getBlockHistory('blocks/revenue.dql')).resolves.toEqual({
      entries: [], status: 'not_a_repo', message: 'This project is not a Git repository yet.',
    });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ entries: [{ hash: 'abc', date: '2026-09-12', author: 'A', message: 'm' }] })));
    await expect(api.getBlockHistory('blocks/revenue.dql')).resolves.toMatchObject({ status: 'ok', entries: [{ hash: 'abc' }] });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ entries: [], status: 'error', message: 'The block path must be inside the project.' }, 400)));
    await expect(api.getBlockHistory('../x')).resolves.toEqual({
      entries: [], status: 'error', message: 'The block path must be inside the project.',
    });
  });
});
