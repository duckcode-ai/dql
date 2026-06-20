import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCertify } from './certify.js';
import type { CLIFlags } from '../args.js';

const tempDirs: string[] = [];

function makeProject(prefix: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(projectDir);
  return projectDir;
}

function flags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
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
    connection: 'duckdb',
    verbose: false,
    skipTests: false,
    version: false,
    ...overrides,
  };
}

function writeDataLexManifest(projectDir: string): void {
  writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({
    project: 'demo',
    datalex: { manifestPath: 'datalex-manifest.json' },
  }));
  writeFileSync(join(projectDir, 'datalex-manifest.json'), JSON.stringify({
    manifestSpecVersion: '1.0.0',
    datalexVersion: '1.0.0',
    generatedAt: '2026-06-20T00:00:00Z',
    project: { name: 'demo' },
    domains: [
      {
        name: 'commerce',
        entities: [
          {
            name: 'Customer',
            contracts: [
              { id: 'commerce.Customer.monthly_active_customers', name: 'monthly_active_customers', version: 1 },
            ],
          },
        ],
      },
    ],
  }));
}

function writeCertifiedBlock(projectDir: string, contractRef: string): string {
  const blockPath = join(projectDir, 'blocks', 'customer_metric.dql');
  mkdirSync(join(projectDir, 'blocks'), { recursive: true });
  writeFileSync(blockPath, `block "Customer Metric" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  datalex_contract = "${contractRef}"
  description = "Certified customer metric bound to a DataLex contract."
  owner = "analytics"
  tags = ["customer"]
  query = """SELECT 1 AS ok"""

  tests {
    assert row_count > 0
  }
}`);
  return blockPath;
}

function lastJsonLog(spy: ReturnType<typeof vi.spyOn>): any {
  const json = spy.mock.calls
    .map((call) => String(call[0] ?? ''))
    .reverse()
    .find((value) => value.trim().startsWith('{'));
  return JSON.parse(json ?? '{}');
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runCertify', () => {
  it('fails certification when a certified block references an unresolved DataLex contract', async () => {
    const projectDir = makeProject('dql-certify-contract-');
    writeDataLexManifest(projectDir);
    const blockPath = writeCertifiedBlock(projectDir, 'commerce.Customer.unknown_contract@1');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(projectDir);
      await runCertify(blockPath, flags());
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.certified).toBe(false);
    expect(payload.errors.some((error: { rule: string; message: string }) =>
      error.rule === 'DataLex contract'
      && error.message.includes('not found in the loaded DataLex manifest'),
    )).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('does not add DataLex errors when a certified block references a known DataLex contract', async () => {
    const projectDir = makeProject('dql-certify-contract-ok-');
    writeDataLexManifest(projectDir);
    const blockPath = writeCertifiedBlock(projectDir, 'commerce.Customer.monthly_active_customers@1');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(projectDir);
      await runCertify(blockPath, flags());
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.errors.some((error: { rule: string }) => error.rule === 'DataLex contract')).toBe(false);
    expect(payload.datalexDiagnostics).toEqual([]);
  });

  it('treats declared tests as present when enterprise certification skips runtime execution', async () => {
    const projectDir = makeProject('dql-certify-skip-tests-');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    mkdirSync(join(projectDir, 'domains', 'nba', 'blocks', '_drafts'), { recursive: true });
    const blockPath = join(projectDir, 'domains', 'nba', 'blocks', '_drafts', 'top_players.dql');
    writeFileSync(blockPath, `block "Top Players" {
  domain = "nba"
  type = "custom"
  status = "draft"
  description = "Ranks players by total points."
  owner = "sports-analytics"
  tags = ["nba"]
  pattern = "ranking"
  grain = "player_name"
  entities = ["NBA player"]
  outputs = ["player_name", "total_points"]
  allowedFilters = ["season_start", "season_end", "top_n"]
  parameterPolicy {
    season_start = "dynamic"
    season_end = "dynamic"
    top_n = "dynamic"
  }
  sourceSystems = ["TRANSFORMED.int_player_stats"]
  reviewCadence = "quarterly"
  query = """SELECT player_name, SUM(pts) AS total_points FROM int_player_stats GROUP BY player_name"""
  tests {
    assert row_count > 0
  }
}`);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(projectDir);
      await runCertify(blockPath, flags({ enterprise: true, skipTests: true, connection: '' } as Partial<CLIFlags>));
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.certified).toBe(true);
    expect(payload.errors).toEqual([]);
    expect(payload.testResults).toMatchObject({ passed: 0, failed: 0, skipped: 1 });
    expect(process.exitCode).toBeUndefined();
  });

  it('promotes OSS drafts from domain-first paths as structured JSON', async () => {
    const projectDir = makeProject('dql-certify-promote-json-');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    mkdirSync(join(projectDir, 'domains', 'nba', 'blocks', '_drafts'), { recursive: true });
    const draftRel = 'domains/nba/blocks/_drafts/top_players.dql';
    writeFileSync(join(projectDir, draftRel), `block "Top Players" {
  domain = "nba"
  type = "custom"
  status = "draft"
  description = "Ranks players by total points."
  owner = "sports-analytics"
  query = """SELECT 1 AS value"""
}`);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(projectDir);
      await runCertify('', flags({ fromDraft: draftRel, force: true }));
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.ok).toBe(true);
    expect(payload.certifiedPath).toBe('domains/nba/blocks/top_players.dql');
    expect(payload.datalexManifestDiff).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });
});
