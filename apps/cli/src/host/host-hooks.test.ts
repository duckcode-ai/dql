import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { hostActor, normalizeHostPrincipal, withRequestContext, type DqlHostHooks, type DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-1: a host says who is asking, and DQL records that person —
 * never a name from the request body.
 */
const PEOPLE: Record<string, DqlPrincipal> = {
  maria: { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', displayName: 'Maria', groups: ['claims'], source: 'host' },
  dev: { id: 'u-dev', kind: 'person', displayName: 'Dev', source: 'host' },
};

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(hostHooks?: DqlHostHooks): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-host-hooks-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'host_hooks' }));
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(hostHooks ? { hostHooks } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  return `http://127.0.0.1:${port}`;
}

/** A host that reads the person from a header, as a proxy in front of DQL would. */
const headerHost: DqlHostHooks = {
  resolvePrincipal: async (req: IncomingMessage) => {
    const who = req.headers['x-test-person'];
    const delay = Number(req.headers['x-test-delay'] ?? 0);
    if (delay) await new Promise((done) => setTimeout(done, delay));
    return typeof who === 'string' ? PEOPLE[who] ?? null : null;
  },
};

describe('host principal (RFC 0010 HH-1)', () => {
  it('accepts only a well-formed principal and always marks it as the host\'s', () => {
    expect(normalizeHostPrincipal(null)).toBeNull();
    expect(normalizeHostPrincipal({ kind: 'person' })).toBeNull();
    expect(normalizeHostPrincipal({ id: '  ' })).toBeNull();
    expect(normalizeHostPrincipal({ id: 'x', kind: 'robot' })).toBeNull();
    expect(normalizeHostPrincipal({ id: 'x', source: 'local', groups: ['a', 3, ''] })).toEqual({ id: 'x', kind: 'person', groups: ['a'], source: 'host' });
  });

  it('names the acting person by email, then display name, then id — and only for a host principal', () => {
    expect(hostActor()).toBeUndefined();
    expect(withRequestContext({ principal: PEOPLE.maria!, requestId: 'r1' }, () => hostActor())).toBe('maria@insurer.example');
    expect(withRequestContext({ principal: PEOPLE.dev!, requestId: 'r2' }, () => hostActor())).toBe('Dev');
    expect(withRequestContext({ principal: { id: 'me', kind: 'person', source: 'local' }, requestId: 'r3' }, () => hostActor())).toBeUndefined();
  });

  it('refuses API requests the host cannot place, and keeps health open', async () => {
    const base = await start({
      resolvePrincipal: (req) => {
        if (req.headers['x-test-person'] === 'boom') throw new Error('identity provider down');
        if (req.headers['x-test-person'] === 'bad') return { kind: 'person' } as unknown as DqlPrincipal;
        return null;
      },
    });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    for (const person of [undefined, 'boom', 'bad']) {
      const response = await fetch(`${base}/api/identity`, person ? { headers: { 'x-test-person': person } } : {});
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Sign in to use DQL.' });
    }
  });

  it('answers each request as its own person, even when they overlap', async () => {
    const base = await start(headerHost);
    const [slow, fast] = await Promise.all([
      fetch(`${base}/api/identity`, { headers: { 'x-test-person': 'maria', 'x-test-delay': '60' } }).then((response) => response.json()),
      fetch(`${base}/api/identity`, { headers: { 'x-test-person': 'dev' } }).then((response) => response.json()),
    ]) as Array<{ owner: string; principal: { id: string; groups: string[] } }>;
    expect(slow).toMatchObject({ owner: 'maria@insurer.example', principal: { id: 'u-maria', groups: ['claims'] } });
    expect(fast).toMatchObject({ owner: 'Dev', principal: { id: 'u-dev', groups: [] } });
  });

  it('records the signed-in person as a correction\'s author and a hint\'s reviewer, ignoring names in the body', async () => {
    const base = await start(headerHost);
    const asMaria = { 'Content-Type': 'application/json', 'x-test-person': 'maria' };
    const captured = await fetch(`${base}/api/agent/learnings/correction`, {
      method: 'POST',
      headers: asMaria,
      body: JSON.stringify({
        question: 'What is net revenue?',
        wrongSql: 'SELECT SUM(amount) FROM orders',
        correctedSql: 'SELECT SUM(net_amount) FROM orders',
        scope: { metric: 'revenue' },
        author: 'mallory@elsewhere.example',
      }),
    }).then((response) => response.json()) as { hint: { id: string; author?: string } };
    expect(captured.hint.author).toBe('maria@insurer.example');

    const retired = await fetch(`${base}/api/agent/hints/${encodeURIComponent(captured.hint.id)}/lifecycle`, {
      method: 'POST',
      headers: asMaria,
      body: JSON.stringify({ action: 'retire', note: 'The metric changed.', reviewer: 'mallory@elsewhere.example' }),
    }).then((response) => response.json()) as { ok: boolean; hint: { status: string; reviewer?: string } };
    expect(retired).toMatchObject({ ok: true, hint: { status: 'retired', reviewer: 'maria@insurer.example' } });
  });

  it('changes nothing without host hooks: the local owner, and names from the body, as before', async () => {
    const base = await start();
    const identity = await fetch(`${base}/api/identity`).then((response) => response.json()) as Record<string, unknown>;
    expect(Object.keys(identity)).toEqual(['owner']);
    const captured = await fetch(`${base}/api/agent/learnings/correction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What is net revenue?',
        wrongSql: 'SELECT SUM(amount) FROM orders',
        correctedSql: 'SELECT SUM(net_amount) FROM orders',
        scope: { metric: 'revenue' },
        author: 'local-analyst',
      }),
    }).then((response) => response.json()) as { hint: { author?: string } };
    expect(captured.hint.author).toBe('local-analyst');
  });
});

describe('what a signed-in person may do (RFC 0010 HH-2)', () => {
  it('asks the host about each request and refuses with its reason, naming the action', async () => {
    const asked: Array<{ person: string; action: string; resource: unknown }> = [];
    const base = await start({
      ...headerHost,
      authorize: (principal, action, resource) => {
        asked.push({ person: principal.id, action, resource });
        if (action === 'settings.manage') throw new Error('policy store down');
        if (principal.id === 'u-dev' && action === 'connection.manage') return { allow: false, reason: 'Only admins change connections.' };
        return { allow: true };
      },
    });
    const asDev = { 'Content-Type': 'application/json', 'x-test-person': 'dev' };

    const refused = await fetch(`${base}/api/connections`, { method: 'PUT', headers: asDev, body: JSON.stringify({ connections: {} }) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Only admins change connections.', code: 'PERMISSION_DENIED', action: 'connection.manage', resource: { type: 'project' } });

    const broken = await fetch(`${base}/api/settings/providers`, { method: 'POST', headers: { ...asDev, 'x-test-person': 'maria' }, body: '{}' });
    expect(broken.status).toBe(403);
    expect(await broken.json()).toMatchObject({ error: 'You do not have permission to do this.', action: 'settings.manage' });

    expect((await fetch(`${base}/api/identity`, { headers: asDev })).status).toBe(200);
    await fetch(`${base}/api/apps/claims`, { headers: asDev });
    expect(asked).toContainEqual({ person: 'u-dev', action: 'app.view', resource: { type: 'app', id: 'claims' } });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect(asked.some((entry) => entry.action === 'project.read' && entry.person === 'u-dev')).toBe(true);
  });
});
