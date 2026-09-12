import { describe, expect, it } from 'vitest';
import { isNoRemoteFailure, remoteUrlInputProblem } from './git-connect';

describe('remoteUrlInputProblem', () => {
  it('accepts the addresses Git hosts hand out', () => {
    for (const url of [
      'https://github.com/acme/analytics.git',
      'ssh://git@gitlab.example.com/acme/analytics.git',
      'git@github.com:acme/analytics.git',
      '/srv/git/analytics.git',
      '../analytics.git',
      'file:///srv/git/analytics.git',
      'C:\\repos\\analytics.git',
      '  https://github.com/acme/analytics.git  ',
    ]) {
      expect(remoteUrlInputProblem(url), url).toBeNull();
    }
  });

  it('explains what is wrong with unusable input', () => {
    expect(remoteUrlInputProblem('')).toMatch(/Enter the remote URL/);
    expect(remoteUrlInputProblem('https://github.com/acme/a b.git')).toMatch(/spaces/);
    expect(remoteUrlInputProblem('ext::sh -c id')).not.toBeNull();
    expect(remoteUrlInputProblem('--upload-pack=id')).toMatch(/not a remote URL/);
    expect(remoteUrlInputProblem('http://github.com/acme/a.git')).toMatch(/HTTPS or SSH/);
    expect(remoteUrlInputProblem('https://me:ghp_token@github.com/acme/a.git')).toMatch(/password or token/);
    expect(remoteUrlInputProblem('github.com/acme/analytics')).toMatch(/Use an address like/);
  });
});

describe('isNoRemoteFailure', () => {
  it('recognizes only the server no_remote failure', () => {
    expect(isNoRemoteFailure({ ok: false, code: 'no_remote' })).toBe(true);
    expect(isNoRemoteFailure({ ok: false, code: 'push_failed' })).toBe(false);
    expect(isNoRemoteFailure({ ok: true, code: 'no_remote' })).toBe(false);
    expect(isNoRemoteFailure(null)).toBe(false);
  });
});
