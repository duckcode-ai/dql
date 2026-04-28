import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runValidate } from './validate.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-validate-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), JSON.stringify({ version: 1, name: 'validate-test' }));
  return dir;
}

function writeValidBlock(path: string): void {
  writeFileSync(path, `block "Monthly Revenue" {
    domain = "finance"
    type = "custom"
    status = "certified"
    query = """
      SELECT 1 AS revenue
    """
  }
`);
}

describe('runValidate', () => {
  it('recursively validates domain-scoped DQL files in a project folder', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks', 'finance'), { recursive: true });
    writeValidBlock(join(root, 'blocks', 'finance', 'monthly_revenue.dql'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(root, { format: 'text' } as any);

    expect(log.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('Validated 1 DQL file(s)');
    expect(process.exitCode).toBeUndefined();
  });

  it('validates a nested single file while loading project-level context', async () => {
    const root = tempProject();
    mkdirSync(join(root, 'blocks', 'finance'), { recursive: true });
    const blockPath = join(root, 'blocks', 'finance', 'monthly_revenue.dql');
    writeValidBlock(blockPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runValidate(blockPath, { format: 'json' } as any);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(payload.files).toBe(1);
    expect(payload.diagnostics).toEqual([]);
  });
});
