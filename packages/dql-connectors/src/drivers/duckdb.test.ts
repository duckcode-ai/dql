import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { DuckDBConnector, normalizeDuckDBRow, normalizeDuckDBValue, resolveDuckDBModule } from './duckdb.js';

const configuredDuckDbConnectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckDbIt = configuredDuckDbConnectorRoot ? it : it.skip;

describe('resolveDuckDBModule', () => {
  it('accepts a direct Database export', () => {
    class Database {}
    expect(resolveDuckDBModule({ Database })).toEqual({ Database });
  });

  it('accepts a CommonJS default export shape', () => {
    class Database {}
    expect(resolveDuckDBModule({ default: { Database } })).toEqual({ Database });
  });

  it('throws when Database is missing', () => {
    expect(() => resolveDuckDBModule({ default: {} })).toThrow('Database constructor');
  });
});

describe('normalizeDuckDBValue', () => {
  it('converts safe bigint values to numbers', () => {
    expect(normalizeDuckDBValue(42n)).toBe(42);
  });

  it('converts unsafe bigint values to strings', () => {
    expect(normalizeDuckDBValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe((BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString());
  });

  it('normalizes nested row values', () => {
    expect(normalizeDuckDBRow({
      revenue: 10n,
      breakdown: { total: 20n },
      points: [1n, 2n],
    })).toEqual({
      revenue: 10,
      breakdown: { total: 20 },
      points: [1, 2],
    });
  });
});

describe('DuckDBConnector execution control', () => {
  it('interrupts a pending native query on abort and ignores its late callback', async () => {
    const connector = new DuckDBConnector();
    let callback: ((error: Error | null, rows: unknown) => void) | undefined;
    const interrupt = vi.fn();
    const all = vi.fn((...args: unknown[]) => {
      callback = args.at(-1) as ((error: Error | null, rows: unknown) => void);
    });
    (connector as unknown as { connection: unknown; db: unknown }).connection = { all, interrupt };
    const controller = new AbortController();

    const pending = connector.execute('SELECT slow_value', undefined, { signal: controller.signal, deadlineMs: 10_000 });
    const cancelled = expect(pending).rejects.toThrow('DuckDB query was cancelled: Ask run cancelled.');
    expect(all).toHaveBeenCalledTimes(1);
    controller.abort(new Error('Ask run cancelled'));

    await cancelled;
    expect(interrupt).toHaveBeenCalledTimes(1);
    // node-duckdb can still invoke the callback after interrupt. It must not
    // revive a cancelled Ask execution or resolve a second result.
    callback?.(null, [{ slow_value: 42 }]);
    await Promise.resolve();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('interrupts a pending native query when its connector deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      const connector = new DuckDBConnector();
      const interrupt = vi.fn();
      const all = vi.fn();
      (connector as unknown as { connection: unknown; db: unknown }).connection = { all, interrupt };

      const pending = connector.execute('SELECT slow_value', undefined, { deadlineMs: 25 });
      const timedOut = expect(pending).rejects.toThrow('DuckDB query exceeded the 25ms deadline.');
      await vi.advanceTimersByTimeAsync(25);

      await timedOut;
      expect(interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DuckDB consistent App read scope', () => {
  duckDbIt('copies the active schema and holds its own same-Database snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-scope-'));
    const filepath = join(directory, 'scope.duckdb');
    const connector = new DuckDBConnector();
    try {
      await connector.connect({ driver: 'duckdb', filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await connector.execute('CREATE SCHEMA analytics');
      await connector.execute('CREATE TABLE main.scope_values (value INTEGER)');
      await connector.execute('INSERT INTO main.scope_values VALUES (1)');
      await connector.execute('CREATE TABLE analytics.scope_values (value INTEGER)');
      await connector.execute('INSERT INTO analytics.scope_values VALUES (2)');
      await connector.execute('SET schema = analytics');

      const scope = await connector.openConsistentReadScope();
      try {
        expect(scope.context.schema).toBe('analytics');
        expect((await scope.execute('SELECT value FROM scope_values')).rows).toEqual([{ value: 2 }]);
        await connector.execute('INSERT INTO analytics.scope_values VALUES (3)');
        expect((await scope.execute('SELECT value FROM scope_values ORDER BY value')).rows).toEqual([{ value: 2 }]);
      } finally {
        await scope.close();
      }
      expect((await connector.execute('SELECT value FROM analytics.scope_values ORDER BY value')).rows).toEqual([{ value: 2 }, { value: 3 }]);
    } finally {
      await connector.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('DuckDB database lifetime', () => {
  // duckdb-node frees a closed native instance only when its Connection and
  // Statement objects are garbage-collected. Force that moment instead of
  // waiting for it, which is when a stale instance used to delete the WAL.
  const collectGarbage = async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (let pass = 0; pass < 3; pass += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const count = async (connector: DuckDBConnector) =>
    (await connector.execute('SELECT COUNT(*)::INTEGER AS n, COUNT(value)::INTEGER AS keyed FROM lifetime_values')).rows[0];

  duckDbIt('keeps commits made after a reconnect when the closed database is finally destroyed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-lifetime-'));
    const filepath = join(directory, 'lifetime.duckdb');
    const config = { driver: 'duckdb' as const, filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] };
    const first = new DuckDBConnector();
    const second = new DuckDBConnector();
    const third = new DuckDBConnector();
    try {
      await first.connect(config);
      await first.execute('CREATE TABLE lifetime_values (value INTEGER)');
      await first.execute('INSERT INTO lifetime_values VALUES (1), (1)');
      expect(await count(first)).toEqual({ n: 2, keyed: 2 });
      await first.disconnect();

      await second.connect(config);
      await second.execute('DELETE FROM lifetime_values');
      await second.execute('INSERT INTO lifetime_values VALUES (1), (NULL)');
      await second.disconnect();
      await collectGarbage();

      await third.connect(config);
      expect(await count(third)).toEqual({ n: 2, keyed: 1 });
    } finally {
      await first.disconnect();
      await second.disconnect();
      await third.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  duckDbIt('serves differently configured connectors on one file from one database until the last disconnect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-shared-'));
    const filepath = join(directory, 'shared.duckdb');
    // Pool keys differ (module search paths, path spelling) but the file is
    // the same, so both connectors must read and write one native instance.
    const writer = new DuckDBConnector();
    const reader = new DuckDBConnector();
    try {
      await writer.connect({ driver: 'duckdb', filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await reader.connect({ driver: 'duckdb', filepath: join(directory, '.', 'shared.duckdb'), moduleSearchPaths: [configuredDuckDbConnectorRoot!, directory] });
      await writer.execute('CREATE TABLE lifetime_values (value INTEGER)');
      await writer.execute('INSERT INTO lifetime_values VALUES (1)');
      expect(await count(reader)).toEqual({ n: 1, keyed: 1 });

      const scope = await writer.openConsistentReadScope();
      await writer.disconnect();
      await expect(scope.execute('SELECT 1')).rejects.toThrow('DuckDB consistent read scope is closed.');
      await reader.execute('INSERT INTO lifetime_values VALUES (NULL)');
      expect(await count(reader)).toEqual({ n: 2, keyed: 1 });
      await reader.disconnect();
      await collectGarbage();

      await writer.connect({ driver: 'duckdb', filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      expect(await count(writer)).toEqual({ n: 2, keyed: 1 });
    } finally {
      await writer.disconnect();
      await reader.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  duckDbIt('keeps in-memory databases private to their connector', async () => {
    const first = new DuckDBConnector();
    const second = new DuckDBConnector();
    try {
      await first.connect({ driver: 'duckdb', moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await second.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await first.execute('CREATE TABLE only_first (value INTEGER)');
      await expect(second.execute('SELECT * FROM only_first')).rejects.toThrow();
    } finally {
      await first.disconnect();
      await second.disconnect();
    }
  });
});
