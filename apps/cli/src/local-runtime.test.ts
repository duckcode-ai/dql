import { describe, expect, it } from 'vitest';
import {
  createBlockArtifacts,
  createSemanticBuilderBlock,
  formatLocalQueryRuntimeError,
  normalizeProjectConnection,
  prepareLocalExecution,
  resolveProjectRelativeSqlPaths,
  serializeJSON,
} from './local-runtime.js';
import { afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatLocalQueryRuntimeError', () => {
  it('explains missing DuckDB native bindings with actionable guidance', () => {
    const message = formatLocalQueryRuntimeError(
      { driver: 'file', filepath: ':memory:' },
      new Error("Cannot find module '/tmp/duckdb/lib/binding/duckdb.node'"),
    );

    expect(message).toContain('DuckDB native bindings could not be loaded');
    expect(message).toContain(`Current Node.js runtime: ${process.versions.node}`);
    expect(message).toContain('Node 18, 20, or 22');
    expect(message).toContain('pnpm install');
  });
});

describe('serializeJSON', () => {
  it('serializes safe bigint values as numbers', () => {
    expect(serializeJSON({ revenue: 42n })).toBe('{"revenue":42}');
  });

  it('serializes unsafe bigint values as strings', () => {
    const value = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(serializeJSON({ revenue: value })).toBe(`{"revenue":"${value.toString()}"}`);
  });
});

describe('resolveProjectRelativeSqlPaths', () => {
  it('rewrites notebook sample file paths relative to the selected project', () => {
    const sql = "SELECT * FROM read_csv_auto('./data/revenue.csv')";
    const resolved = resolveProjectRelativeSqlPaths(sql, '/tmp/demo-project');

    expect(resolved).toBe("SELECT * FROM read_csv_auto('/tmp/demo-project/data/revenue.csv')");
  });

  it('leaves unrelated string literals untouched', () => {
    const sql = "SELECT './data/revenue.csv' AS label";
    expect(resolveProjectRelativeSqlPaths(sql, '/tmp/demo-project')).toBe(sql);
  });
});

describe('normalizeProjectConnection', () => {
  it('resolves relative local database paths against the project root', () => {
    expect(normalizeProjectConnection(
      { driver: 'duckdb', filepath: './local/dev.duckdb' },
      '/tmp/demo-project',
    )).toEqual({ driver: 'duckdb', filepath: '/tmp/demo-project/local/dev.duckdb' });
  });
});

describe('prepareLocalExecution', () => {
  it('rewrites SQL paths for file-backed notebook queries', () => {
    const prepared = prepareLocalExecution(
      "SELECT * FROM read_csv_auto('./data/revenue.csv')",
      { driver: 'file', filepath: ':memory:' },
      '/tmp/demo-project',
      { dataDir: './data' },
    );

    expect(prepared.connection).toEqual({ driver: 'file', filepath: ':memory:' });
    expect(prepared.sql).toBe("SELECT * FROM read_csv_auto('/tmp/demo-project/data/revenue.csv')");
  });
});

describe('semantic block save artifacts', () => {
  it('writes both the block file and semantic companion metadata for save-from-cell flows', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createBlockArtifacts(projectRoot, {
      name: 'Revenue Summary',
      domain: 'finance',
      content: 'SELECT @metric(total_revenue), @dim(order_date);',
      description: 'Finance summary block',
      tags: ['finance', 'exec'],
    });

    expect(created.path).toBe('blocks/finance/revenue-summary.dql');
    expect(created.companionPath).toBe('semantic-layer/blocks/finance/revenue-summary.yaml');
    expect(readFileSync(join(projectRoot, created.path), 'utf-8')).toContain('@metric(total_revenue)');

    const companion = readFileSync(join(projectRoot, created.companionPath), 'utf-8');
    expect(companion).toContain('provider: dql');
    expect(companion).toContain('semanticMetrics:');
    expect(companion).toContain('  - total_revenue');
    expect(companion).toContain('semanticDimensions:');
    expect(companion).toContain('  - order_date');
    expect(companion).toContain('reviewStatus: draft');
  });

  it('writes semantic builder blocks with lineage companion metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-builder-artifacts-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');

    const created = createSemanticBuilderBlock(projectRoot, {
      name: 'Executive Revenue',
      domain: 'finance',
      description: 'Executive revenue cut',
      owner: 'finance-analytics',
      tags: ['finance'],
      metrics: ['total_revenue'],
      dimensions: ['sales_channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      chart: 'line',
      blockType: 'semantic',
      sql: 'SELECT 1',
      tables: ['analytics.orders'],
      provider: 'dbt',
    });

    expect(created.path).toBe('blocks/finance/executive-revenue.dql');
    expect(created.content).toContain('type = "semantic"');
    expect(created.content).toContain('metric = "total_revenue"');

    const companion = readFileSync(join(projectRoot, created.companionPath), 'utf-8');
    expect(companion).toContain('provider: dbt');
    expect(companion).toContain('lineage:');
    expect(companion).toContain('analytics.orders');
    expect(companion).toContain('semanticMetrics:');
    expect(companion).toContain('  - total_revenue');
    expect(companion).toContain('semanticDimensions:');
    expect(companion).toContain('  - sales_channel');
    expect(companion).toContain('  - order_date');
  });
});
