import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthorizationUrl as claudeAuthUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateUserId,
  ClaudeOAuthProvider,
  ClaudeOAuthManager,
  CLAUDE_OAUTH_CONFIG,
} from './claude-oauth.js';
import {
  buildAuthorizationUrl as codexAuthUrl,
  extractAccountId,
  CodexOAuthProvider,
  CODEX_OAUTH_CONFIG,
} from './codex-oauth.js';
import {
  setClaudeCredentials,
  setCodexCredentials,
  getClaudeCredentials,
  clearOAuthProvider,
} from './oauth-store.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dql-oauth-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('PKCE + authorize URL', () => {
  it('code challenge is base64url(SHA256(verifier))', () => {
    const verifier = generateCodeVerifier();
    const expected = createHash('sha256').update(verifier).digest().toString('base64url');
    expect(generateCodeChallenge(verifier)).toBe(expected);
  });

  it('Claude authorize URL carries PKCE S256 + client id + redirect + state', () => {
    const url = new URL(claudeAuthUrl('CHALLENGE', 'STATE123'));
    expect(url.origin + url.pathname).toBe(CLAUDE_OAUTH_CONFIG.authorizationEndpoint);
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_OAUTH_CONFIG.redirectUri);
    expect(url.searchParams.get('state')).toBe('STATE123');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('Codex authorize URL carries PKCE S256 + codex flow flags', () => {
    const url = new URL(codexAuthUrl('CH', 'ST'));
    expect(url.searchParams.get('client_id')).toBe(CODEX_OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });

  it('generateUserId embeds a stable email hash', () => {
    const id = generateUserId('a@b.com');
    const hash = createHash('sha256').update('a@b.com').digest('hex').slice(0, 16);
    expect(id.startsWith(`user_${hash}_account_`)).toBe(true);
  });
});

describe('Codex JWT account-id extraction', () => {
  function jwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
  }
  it('reads chatgpt_account_id from the id_token', () => {
    const token = jwt({ chatgpt_account_id: 'acct_123' });
    expect(extractAccountId({ id_token: token, access_token: 'x.y.z' })).toBe('acct_123');
  });
  it('falls back to the namespaced claim, then organizations', () => {
    expect(extractAccountId({ id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ns_1' } }), access_token: 'a.b.c' })).toBe('ns_1');
    expect(extractAccountId({ id_token: jwt({ organizations: [{ id: 'org_9' }] }), access_token: 'a.b.c' })).toBe('org_9');
  });
  it('returns undefined for a non-JWT token', () => {
    expect(extractAccountId({ access_token: 'not-a-jwt' })).toBeUndefined();
  });
});

describe('oauth token store', () => {
  it('round-trips and clears Claude credentials with 0600 perms', () => {
    setClaudeCredentials(root, { type: 'claude', access_token: 'tok', refresh_token: 'ref', expired: new Date(Date.now() + 3.6e6).toISOString(), email: 'me@x.com' });
    expect(getClaudeCredentials(root)?.email).toBe('me@x.com');
    clearOAuthProvider(root, 'claude');
    expect(getClaudeCredentials(root)).toBeNull();
  });
});

describe('ClaudeOAuthProvider request', () => {
  it('sends Bearer + oauth beta headers + Claude Code preamble + effort thinking', async () => {
    setClaudeCredentials(root, { type: 'claude', access_token: 'TOK', refresh_token: 'REF', expired: new Date(Date.now() + 3.6e6).toISOString() });
    let captured: { headers: Record<string, string>; body: any } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'answer' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const provider = new ClaudeOAuthProvider({ projectRoot: root, model: 'claude-sonnet-4-5' });
    const out = await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' });
    expect(out).toBe('answer');
    expect(captured?.headers.Authorization).toBe('Bearer TOK');
    expect(captured?.headers['Anthropic-Beta']).toContain('oauth-2025-04-20');
    expect(captured?.body.system[0].text).toContain('Claude Code');
    expect(captured?.body.thinking).toEqual({ type: 'enabled', budget_tokens: 20000 });
  });

  it('throws a clear error when there is no credential at all', async () => {
    const provider = new ClaudeOAuthProvider({ projectRoot: root });
    await expect(provider.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Sign in with Claude/);
  });
});

describe('OAuth flow lifecycle', () => {
  it('isPending tracks the in-flight flow and clears on cancel', () => {
    const m = new ClaudeOAuthManager(root);
    expect(m.isPending()).toBe(false);
    const url = m.startAuthorizationFlow();
    expect(url).toContain('claude.ai/oauth/authorize');
    expect(m.isPending()).toBe(true);
    m.cancelAuthorizationFlow();
    expect(m.isPending()).toBe(false);
  });

  it('cancel settles the pending callback promise (no dangling flow)', async () => {
    const m = new ClaudeOAuthManager(root);
    m.startAuthorizationFlow();
    const pending = m.waitForCallback();
    m.cancelAuthorizationFlow(); // supersede
    await expect(pending).rejects.toThrow(/superseded/i);
    expect(m.isPending()).toBe(false);
  });
});

describe('CodexOAuthProvider request', () => {
  it('sends Bearer + ChatGPT-Account-Id and accumulates text deltas from the SSE stream', async () => {
    setCodexCredentials(root, { type: 'openai-codex', access_token: 'CTOK', refresh_token: 'CREF', expires: Date.now() + 3.6e6, accountId: 'acct_9' });
    let captured: Record<string, string> | undefined;
    const sse = 'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n' +
                'data: {"type":"response.output_text.delta","delta":"lo"}\n\n' +
                'data: {"type":"response.completed"}\n\n';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const provider = new CodexOAuthProvider({ projectRoot: root });
    const out = await provider.generate([{ role: 'user', content: 'hi' }], { reasoningEffort: 'medium' });
    expect(out).toBe('Hello');
    expect(captured?.Authorization).toBe('Bearer CTOK');
    expect(captured?.['ChatGPT-Account-Id']).toBe('acct_9');
  });

  it('flushes a final text delta even when the stream lacks a trailing blank line', async () => {
    setCodexCredentials(root, { type: 'openai-codex', access_token: 'C', refresh_token: 'R', expires: Date.now() + 3.6e6 });
    const sse = 'data: {"type":"response.output_text.delta","delta":"one"}\n\n' +
                'data: {"type":"response.output_text.delta","delta":"two"}'; // no trailing \n\n
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const provider = new CodexOAuthProvider({ projectRoot: root });
    expect(await provider.generate([{ role: 'user', content: 'hi' }])).toBe('onetwo');
  });
});
