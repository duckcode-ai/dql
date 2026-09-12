import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import {
  friendlyGitRemoteError,
  resolveBlockHistoryPath,
  startLocalServer,
  validateGitRemoteName,
  validateGitRemoteUrl,
} from './local-runtime.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), '{}\n');
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=DQL Test',
    '-c', 'user.email=dql-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function withServer<T>(projectRoot: string, run: (base: string) => Promise<T>): Promise<T> {
  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('block history path boundary', () => {
  it('rejects shell metacharacters and paths outside the project', () => {
    const root = '/projects/acme';
    for (const bad of [
      'blocks/a.dql"; touch /tmp/pwned; echo "',
      'blocks/$(id).dql',
      'blocks/`id`.dql',
      'blocks/a.dql | cat',
      'blocks/a.dql\nrm',
      '../outside.dql',
      'blocks/../../outside.dql',
      '/etc/passwd',
      '--output=/tmp/x',
      ':(glob)**',
      '',
    ]) {
      expect(resolveBlockHistoryPath(root, bad).ok, bad).toBe(false);
    }
    expect(resolveBlockHistoryPath(root, 'blocks/revenue by region.dql')).toEqual({ ok: true, relativePath: 'blocks/revenue by region.dql' });
    expect(resolveBlockHistoryPath(root, '/projects/acme/blocks/revenue.dql')).toEqual({ ok: true, relativePath: 'blocks/revenue.dql' });
  });
});

describe('git remote input validation', () => {
  it('accepts https, ssh, and local path remotes', () => {
    for (const good of [
      'https://github.com/acme/analytics.git',
      'https://git@github.com/acme/analytics.git',
      'ssh://git@github.com/acme/analytics.git',
      'git@github.com:acme/analytics.git',
      '/srv/git/analytics.git',
      './shared/analytics.git',
      '../analytics.git',
      'file:///srv/git/analytics.git',
      'C:\\repos\\analytics.git',
    ]) {
      expect(validateGitRemoteUrl(good), good).toEqual({ ok: true, url: good });
    }
  });

  it('rejects transports that execute commands, option injection, embedded secrets, and junk', () => {
    for (const bad of [
      '',
      'ext::sh -c touch% /tmp/pwned',
      'ext::ssh',
      'fd::17',
      '--upload-pack=touch /tmp/pwned',
      '-oProxyCommand=evil',
      'http://github.com/acme/analytics.git',
      'https://user:ghp_secret@github.com/acme/analytics.git',
      'https://github.com',
      'github.com/acme/analytics',
      'git@github.com:acme/analytics.git; rm -rf /',
      'not a url',
    ]) {
      expect(validateGitRemoteUrl(bad).ok, bad).toBe(false);
    }
    expect(validateGitRemoteName(undefined)).toEqual({ ok: true, name: 'origin' });
    expect(validateGitRemoteName('upstream')).toEqual({ ok: true, name: 'upstream' });
    expect(validateGitRemoteName('--mirror').ok).toBe(false);
    expect(validateGitRemoteName('a b').ok).toBe(false);
  });

  it('maps common git network failures to a plain sentence', () => {
    expect(friendlyGitRemoteError("fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository."))
      .toMatch(/could not find a repository at the remote URL/);
    expect(friendlyGitRemoteError('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'))
      .toMatch(/could not sign in/);
    expect(friendlyGitRemoteError('git@github.com: Permission denied (publickey).')).toMatch(/could not sign in/);
    expect(friendlyGitRemoteError(' ! [rejected]        main -> main (fetch first)')).toMatch(/Get updates first/);
    expect(friendlyGitRemoteError('fatal: unable to access \'https://x.invalid/\': Could not resolve host: x.invalid')).toMatch(/could not connect/);
    expect(friendlyGitRemoteError('something unexpected')).toBe('something unexpected');
  });
});

describe('source-control connection API (git history, init, remote)', () => {
  it('never runs a shell for the block history path and refuses paths outside the project', async () => {
    const projectRoot = tempProject('dql-git-history-injection-');
    const sentinel = join(projectRoot, 'pwned');
    await withServer(projectRoot, async (base) => {
      const injected = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent(`blocks/a.dql"; touch "${sentinel}"; echo "`)}`);
      expect(injected.status).toBe(400);
      await expect(injected.json()).resolves.toMatchObject({ entries: [], status: 'error' });
      expect(existsSync(sentinel)).toBe(false);

      const outside = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('../../etc/passwd')}`);
      expect(outside.status).toBe(400);
      await expect(outside.json()).resolves.toMatchObject({ status: 'error', message: expect.stringContaining('inside the project') });

      const missing = await fetch(`${base}/api/blocks/history`);
      expect(missing.status).toBe(400);
    });
  });

  it('reports not_a_repo for block history outside Git, then real entries once committed', async () => {
    const projectRoot = tempProject('dql-git-history-status-');
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks', 'revenue.dql'), 'block "Revenue" {}\n');
    await withServer(projectRoot, async (base) => {
      const before = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('blocks/revenue.dql')}`);
      expect(before.status).toBe(200);
      await expect(before.json()).resolves.toMatchObject({ entries: [], status: 'not_a_repo' });

      git(projectRoot, ['init']);
      const emptyRepo = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('blocks/revenue.dql')}`);
      await expect(emptyRepo.json()).resolves.toMatchObject({ entries: [], status: 'ok' });

      git(projectRoot, ['add', 'blocks/revenue.dql']);
      git(projectRoot, ['commit', '-m', 'Add revenue block | with ||| separators']);
      const after = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('blocks/revenue.dql')}`);
      const body = await after.json() as { status: string; entries: Array<{ hash: string; date: string; author: string; message: string }> };
      expect(body.status).toBe('ok');
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ author: 'DQL Test', message: 'Add revenue block | with ||| separators' });
      expect(body.entries[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isNaN(new Date(body.entries[0]!.date).getTime())).toBe(false);
    });
  });

  it('initializes Git only for a project that is not already inside a repository', async () => {
    const projectRoot = tempProject('dql-git-init-');
    await withServer(projectRoot, async (base) => {
      const statusBefore = await fetch(`${base}/api/git/status`).then((r) => r.json()) as { inRepo: boolean };
      expect(statusBefore.inRepo).toBe(false);

      const init = await postJson(`${base}/api/git/init`, {});
      expect(init.status).toBe(201);
      await expect(init.json()).resolves.toMatchObject({ ok: true, status: { inRepo: true } });
      expect(existsSync(join(projectRoot, '.git'))).toBe(true);

      const again = await postJson(`${base}/api/git/init`, {});
      expect(again.status).toBe(409);
      await expect(again.json()).resolves.toMatchObject({ ok: false, code: 'already_a_repo' });
    });

    const parent = tempProject('dql-git-init-nested-');
    git(parent, ['init']);
    const nested = join(parent, 'analytics');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'dql.config.json'), '{}\n');
    await withServer(nested, async (base) => {
      const refused = await postJson(`${base}/api/git/init`, {});
      expect(refused.status).toBe(409);
      expect(existsSync(join(nested, '.git'))).toBe(false);
    });
  });

  it('saves a validated remote without contacting it, and push without a remote says so plainly', async () => {
    const projectRoot = tempProject('dql-git-remote-');
    await withServer(projectRoot, async (base) => {
      const notRepo = await postJson(`${base}/api/git/remote`, { url: 'https://github.com/acme/analytics.git' });
      expect(notRepo.status).toBe(400);
      await expect(notRepo.json()).resolves.toMatchObject({ ok: false, code: 'not_a_repo' });

      await postJson(`${base}/api/git/init`, {});
      writeFileSync(join(projectRoot, 'README.md'), '# analytics\n');
      git(projectRoot, ['add', 'README.md']);
      git(projectRoot, ['commit', '-m', 'init']);

      const pushWithoutRemote = await postJson(`${base}/api/git/push`, {});
      expect(pushWithoutRemote.status).toBe(400);
      await expect(pushWithoutRemote.json()).resolves.toMatchObject({ ok: false, code: 'no_remote', error: expect.stringContaining('no Git remote') });

      for (const url of ['ext::sh -c touch% /tmp/dql-pwned', '--upload-pack=touch', 'https://me:token@github.com/acme/a.git', 'nope']) {
        const rejected = await postJson(`${base}/api/git/remote`, { url });
        expect(rejected.status, url).toBe(400);
        await expect(rejected.json()).resolves.toMatchObject({ ok: false, code: 'invalid_url' });
      }
      expect(git(projectRoot, ['remote']).trim()).toBe('');

      // A path that does not exist and a host that can never resolve: saving
      // either succeeds only because nothing is fetched or contacted.
      const localMissing = join(projectRoot, 'does-not-exist', 'shared.git');
      const added = await postJson(`${base}/api/git/remote`, { url: localMissing });
      expect(added.status).toBe(200);
      await expect(added.json()).resolves.toMatchObject({ ok: true, name: 'origin', url: localMissing, replaced: false });
      expect(git(projectRoot, ['config', '--get', 'remote.origin.url']).trim()).toBe(localMissing);
      expect(existsSync(join(projectRoot, '.git', 'refs', 'remotes', 'origin'))).toBe(false);

      const duplicate = await postJson(`${base}/api/git/remote`, { url: 'https://git.example.invalid/acme/analytics.git' });
      expect(duplicate.status).toBe(409);
      await expect(duplicate.json()).resolves.toMatchObject({ ok: false, code: 'remote_exists' });

      const replaced = await postJson(`${base}/api/git/remote`, { url: 'https://git.example.invalid/acme/analytics.git', replace: true });
      expect(replaced.status).toBe(200);
      await expect(replaced.json()).resolves.toMatchObject({ ok: true, replaced: true, url: 'https://git.example.invalid/acme/analytics.git' });

      const remote = await fetch(`${base}/api/git/remote`).then((r) => r.json());
      expect(remote).toEqual({ inRepo: true, name: 'origin', url: 'https://git.example.invalid/acme/analytics.git' });
    });
  });
});
