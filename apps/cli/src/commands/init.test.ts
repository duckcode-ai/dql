import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';

describe('runInit', () => {
  it('scaffolds a DQL project with config, blocks dir, and notebook', async () => {
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
      template: '',
      connection: '',
      verbose: false,
      skipTests: false,
    });

    const contents = readdirSync(projectDir);
    expect(contents).toContain('blocks');
    expect(contents).toContain('dql.config.json');
    expect(contents).toContain('notebooks');

    const config = readFileSync(join(projectDir, 'dql.config.json'), 'utf-8');
    expect(config).toContain('demo-project');
    expect(config).toContain('duckdb');

    const notebook = readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf-8');
    expect(notebook).toContain('DQL');
  });
});
