import { describe, expect, it } from 'vitest';
import { resolveNotebookConnection } from './notebook.js';

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
});
