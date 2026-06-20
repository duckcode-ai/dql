import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './doctor.js';

const tempDirs: string[] = [];

function makeProject(prefix: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(projectDir);
  return projectDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runDoctor', () => {
  it('reports health for a starter-like project', async () => {
    const projectDir = makeProject('dql-doctor-');
    mkdirSync(join(projectDir, 'blocks'));
    mkdirSync(join(projectDir, 'semantic-layer'));
    mkdirSync(join(projectDir, 'data'));
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({
      defaultConnection: { driver: 'file', filepath: ':memory:' },
    }, null, 2));
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      dependencies: { duckdb: '^1.1.0' },
    }, null, 2));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor(projectDir, {
      check: false,
      chart: '',
      domain: '',
      format: 'text',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: 'starter',
      connection: '',
      verbose: false,
      skipTests: false, version: false,
    });

    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('DQL Doctor');
    expect(output).toContain('blocks/');
    expect(output).not.toContain('add duckdb for file/duckdb local preview support');
  });

  it('reports enterprise scale counts and cache issues', async () => {
    const projectDir = makeProject('dql-doctor-scale-');
    mkdirSync(join(projectDir, 'domains', 'customer', 'blocks'), { recursive: true });
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(projectDir, 'domains', 'customer', 'domain.dql'), `domain "Customer" {
  owner = "customer-analytics"
}`);
    writeFileSync(join(projectDir, 'domains', 'customer', 'blocks', 'profile.dql'), `block "Customer Profile" {
  domain = "Customer"
  type = "custom"
  pattern = "entity_profile"
  grain = "customer_id"
  entities = ["Customer"]
  outputs = ["customer_id"]
  query = """SELECT customer_id FROM dim_customer"""
}`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runDoctor('scale', {
        check: false,
        chart: '',
        domain: '',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: '',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.counts.domains).toBe(1);
    expect(report.counts.blocks).toBe(1);
    expect(report.counts.lineageNodes).toBeGreaterThan(0);
    expect(report.issues.some((issue: { code: string }) => issue.code === 'metadata_catalog_missing')).toBe(true);
  });
});
