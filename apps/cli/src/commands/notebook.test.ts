import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAskAgentRuntimeMode } from '../local-runtime.js';
import { resolveNotebookConnection, startProjectRuntime } from './notebook.js';

describe('resolveNotebookConnection', () => {
  it('does not invent a DuckDB/file fallback when no default connection is configured', () => {
    expect(resolveNotebookConnection({ project: 'starter' }, '/tmp/dql-project')).toBeNull();
  });

  it('normalizes a configured default connection', () => {
    expect(resolveNotebookConnection(
      { defaultConnection: { driver: 'duckdb', filepath: './local.duckdb' } },
      '/tmp/dql-project',
    )).toMatchObject({
      driver: 'duckdb',
      filepath: '/tmp/dql-project/local.duckdb',
    });
  });

  it('uses shadow_v2 by default, passes the explicit notebook mode to the server, and rejects invalid modes', async () => {
    expect(resolveAskAgentRuntimeMode(undefined)).toBe('shadow_v2');
    expect(resolveAskAgentRuntimeMode('authoritative_v2')).toBe('authoritative_v2');
    expect(() => resolveAskAgentRuntimeMode('experimental')).toThrow(/Invalid Ask runtime mode/i);

    const root = mkdtempSync(join(tmpdir(), 'dql-notebook-runtime-mode-'));
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'runtime-mode-test' }));
    const shadow = await startProjectRuntime(root, { preferredPort: 0 });
    try {
      const health = await fetch(`${shadow.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ askRuntimeMode: 'shadow_v2' });
    } finally {
      await shadow.close();
    }

    const authoritative = await startProjectRuntime(root, { preferredPort: 0, askAgentRuntimeMode: 'authoritative_v2' });
    try {
      const health = await fetch(`${authoritative.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ askRuntimeMode: 'authoritative_v2' });
    } finally {
      await authoritative.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
