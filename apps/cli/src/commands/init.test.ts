import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';

describe('runInit', () => {
  it('scaffolds a starter project with config, data, and valid block types', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-init-'));
    const projectDir = join(targetDir, 'demo-project');

    await runInit(projectDir, {
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
      verbose: false,
    });

    expect(readdirSync(projectDir)).toContain('blocks');
    expect(readdirSync(projectDir)).toContain('data');
    expect(readdirSync(projectDir)).toContain('dql.config.json');

    const config = readFileSync(join(projectDir, 'dql.config.json'), 'utf-8');
    expect(config).toContain('demo-project');

    const block = readFileSync(join(projectDir, 'blocks', 'revenue_by_segment.dql'), 'utf-8');
    expect(block).toContain('type = "custom"');
    expect(block).toContain("read_csv_auto('./data/revenue.csv')");
  });
});
