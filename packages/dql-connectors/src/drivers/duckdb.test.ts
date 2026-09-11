import { describe, expect, it, vi } from 'vitest';
import { DuckDBConnector, normalizeDuckDBRow, normalizeDuckDBValue, resolveDuckDBModule } from './duckdb.js';

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
