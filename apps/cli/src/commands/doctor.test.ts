import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runDoctor } from './doctor.js';

describe('runDoctor', () => {
  it('reports health for a starter-like project', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-doctor-'));
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
    spy.mockRestore();
  });
});
