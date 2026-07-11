import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIFlags } from '../args.js';
import { runMigrate } from './migrate.js';

const tempDirs: string[] = [];

function baseFlags(overrides: Partial<CLIFlags> = {}): CLIFlags {
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

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-migrate-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  mkdirSync(join(dir, 'blocks'), { recursive: true });
  writeFileSync(join(dir, 'blocks', 'orders.dql'), `block "Customer Orders" {
  domain = "Customer Success"
  type = "custom"
  query = """SELECT * FROM orders"""
}`);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runMigrate layout', () => {
  it('previews and applies domain-first layout moves', async () => {
    const projectRoot = tempProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('layout', baseFlags({
      input: projectRoot,
      to: 'domain-first',
      dryRun: true,
    }));

    const dryRunReport = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(dryRunReport.moves).toEqual([
      {
        source: 'blocks/orders.dql',
        target: 'domains/customer-success/blocks/orders.dql',
        kind: 'block',
        domain: 'customer-success',
        status: 'move',
      },
    ]);
    expect(existsSync(join(projectRoot, 'blocks', 'orders.dql'))).toBe(true);
    expect(existsSync(join(projectRoot, 'domains', 'customer-success', 'blocks', 'orders.dql'))).toBe(false);

    await runMigrate('layout', baseFlags({
      input: projectRoot,
      to: 'domain-first',
      force: true,
    }));

    const target = join(projectRoot, 'domains', 'customer-success', 'blocks', 'orders.dql');
    expect(existsSync(join(projectRoot, 'blocks', 'orders.dql'))).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('block "Customer Orders"');
  });
});

describe('runMigrate parameters', () => {
  it('audits legacy placeholders without rewriting source', async () => {
    const projectRoot = tempProject();
    writeFileSync(join(projectRoot, 'blocks', 'orders.dql'), `block "Customer Orders" {
  domain = "Customer Success"
  type = "custom"
  parameterPolicy { region = "dynamic" }
  query = """SELECT * FROM orders WHERE region = ${'${region}'} AND occurred_at >= ${'${start_date}'}"""
}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('parameters', baseFlags({ input: projectRoot, check: false }));

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.blocksWithParameters).toBe(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'undeclared_placeholder', detail: expect.stringContaining('start_date') }),
      expect.objectContaining({ kind: 'policy_without_definition', detail: expect.stringContaining('region') }),
    ]));
    expect(readFileSync(join(projectRoot, 'blocks', 'orders.dql'), 'utf-8')).toContain('${start_date}');
  });
});
