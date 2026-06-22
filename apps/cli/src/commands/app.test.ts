import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIFlags } from '../args.js';
import { __test__, runApp } from './app.js';

const tempDirs: string[] = [];

function flags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
    format: 'json',
    verbose: false,
    help: false,
    version: false,
    check: false,
    open: null,
    input: '',
    outDir: '',
    port: null,
    chart: '',
    domain: '',
    owner: '',
    queryOnly: false,
    template: '',
    connection: '',
    skipTests: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('runApp', () => {
  it('creates new apps under a matching domain-first app folder', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-new-domain-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'demo' }), 'utf-8');
    mkdirSync(join(projectRoot, 'domains', 'customer'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const previousCwd = process.cwd();

    try {
      process.chdir(projectRoot);
      await runApp('new', ['customer-360'], flags({
        domain: 'customer',
        owner: 'customer-analytics@local',
      }));
    } finally {
      process.chdir(previousCwd);
    }

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      created: true,
      id: 'customer-360',
      path: 'domains/customer/apps/customer-360',
    });
    expect(existsSync(join(projectRoot, 'domains', 'customer', 'apps', 'customer-360', 'dql.app.json'))).toBe(true);
    expect(existsSync(join(projectRoot, 'apps', 'customer-360', 'dql.app.json'))).toBe(false);
    expect(__test__.collectApps(projectRoot)[0]).toMatchObject({
      id: 'customer-360',
      filePath: 'domains/customer/apps/customer-360',
    });
  });

  it('lists apps from an explicit project path', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-list-path-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'demo' }), 'utf-8');
    mkdirSync(join(projectRoot, 'apps', 'nba-performance', 'dashboards'), { recursive: true });
    writeFileSync(join(projectRoot, 'apps', 'nba-performance', 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'nba-performance',
      name: 'NBA Performance',
      domain: 'nba',
      visibility: 'shared',
      lifecycle: 'draft',
      owners: ['sports-analytics@local'],
      members: [],
      roles: [],
      policies: [],
      rlsBindings: [],
      schedules: [],
      homepage: { type: 'dashboard', id: 'overview' },
    }, null, 2), 'utf-8');
    writeFileSync(join(projectRoot, 'apps', 'nba-performance', 'dashboards', 'overview.dqld'), JSON.stringify({
      version: 1,
      id: 'overview',
      metadata: {
        title: 'Overview',
        domain: 'nba',
        visibility: 'shared',
        lifecycle: 'draft',
      },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
    }, null, 2), 'utf-8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runApp('ls', [projectRoot], flags());

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.apps).toHaveLength(1);
    expect(payload.apps[0]).toMatchObject({
      id: 'nba-performance',
      domain: 'nba',
      filePath: 'apps/nba-performance',
      dashboards: [{ id: 'overview', title: 'Overview' }],
    });
  });
});
