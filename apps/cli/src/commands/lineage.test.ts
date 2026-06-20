import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLineage } from './lineage.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeCrossDomainProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'dql-lineage-'));
  tempDirs.push(projectDir);
  writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'lineage-test' }));
  mkdirSync(join(projectDir, 'domains', 'customer', 'views'), { recursive: true });
  mkdirSync(join(projectDir, 'domains', 'revenue', 'blocks'), { recursive: true });
  writeFileSync(join(projectDir, 'domains', 'customer', 'domain.dql'), `domain "Customer" {
  owner = "customer-analytics"
}`);
  writeFileSync(join(projectDir, 'domains', 'revenue', 'domain.dql'), `domain "Revenue" {
  owner = "revenue-analytics"
}`);
  writeFileSync(join(projectDir, 'domains', 'revenue', 'blocks', 'revenue_total.dql'), `block "Revenue Total" {
  domain = "Revenue"
  type = "custom"
  status = "certified"
  owner = "revenue-analytics"
  pattern = "entity_rollup"
  grain = "customer_id"
  outputs = ["customer_id", "revenue"]
  query = """
    SELECT customer_id, SUM(revenue) AS revenue FROM fct_revenue GROUP BY 1
  """
}`);
  writeFileSync(join(projectDir, 'domains', 'customer', 'views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  owner = "customer-analytics"
  includes {
    block "Revenue Total"
  }
}`);
  return projectDir;
}

describe('runLineage', () => {
  it('returns JSON cross-domain flows filtered by domain', async () => {
    const projectDir = makeCrossDomainProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runLineage('cross-domain', [], {
        format: 'json',
        domain: 'Customer',
      } as any);
    } finally {
      process.chdir(previousCwd);
    }

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.domain).toBe('Customer');
    expect(payload.summary.flowCount).toBe(1);
    expect(payload.flows[0]).toEqual(expect.objectContaining({
      from: 'Revenue',
      to: 'Customer',
      edgeCount: 1,
    }));
    expect(payload.flows[0].targetNodes[0]).toEqual(expect.objectContaining({
      type: 'business_view',
      name: 'Customer 360',
      domain: 'Customer',
    }));
  });

  it('prints text cross-domain lineage without treating cross-domain as a node name', async () => {
    const projectDir = makeCrossDomainProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runLineage('cross-domain', [], {
        format: 'text',
        domain: '',
      } as any);
    } finally {
      process.chdir(previousCwd);
    }

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Cross-Domain Lineage');
    expect(output).toContain('Revenue -> Customer');
    expect(output).toContain('block:Revenue Total -> business_view:Customer 360');
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('"cross-domain" not found'));
  });
});
