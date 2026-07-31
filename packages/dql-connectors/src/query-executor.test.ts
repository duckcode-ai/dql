import { describe, expect, it, vi } from 'vitest';
import type { DatabaseConnector } from './connector.js';
import { QueryExecutor, isReconnectSafeReadOnlySql, isRecoverableConnectionLoss } from './query-executor.js';

const config = {
  driver: 'snowflake' as const,
  account: 'acct',
  username: 'analyst',
};

function connector(execute: DatabaseConnector['execute']): DatabaseConnector {
  return {
    driverName: 'snowflake',
    connect: vi.fn(async () => undefined),
    execute,
    disconnect: vi.fn(async () => undefined),
    ping: vi.fn(async () => true),
  };
}

describe('QueryExecutor stale-session recovery', () => {
  it('reconnects once and replays a read-only query after a terminated session', async () => {
    const stale = connector(vi.fn(async () => {
      throw new Error('Snowflake query failed: Unable to perform operation using terminated connection.');
    }));
    const fresh = connector(vi.fn(async () => ({
      columns: ['revenue'],
      rows: [{ revenue: 42 }],
      rowCount: 1,
      executionTimeMs: 2,
    })));
    const pool = {
      getConnector: vi.fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(fresh),
      removeConnector: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
    };
    const executor = new QueryExecutor(pool as never);

    const result = await executor.executePositional('SELECT SUM(revenue) FROM sales.orders', [], config);

    expect(result.rowCount).toBe(1);
    expect(pool.removeConnector).toHaveBeenCalledWith(config, stale);
    expect(fresh.execute).toHaveBeenCalledTimes(1);
  });

  it('does not replay unsafe SQL or retry a non-connection warehouse error', async () => {
    const unsafe = connector(vi.fn(async () => {
      throw new Error('terminated connection');
    }));
    const unsafePool = {
      getConnector: vi.fn(async () => unsafe),
      removeConnector: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
    };
    await expect(new QueryExecutor(unsafePool as never).executePositional(
      'UPDATE sales.orders SET amount = 0',
      [],
      config,
    )).rejects.toThrow('terminated connection');
    expect(unsafePool.removeConnector).not.toHaveBeenCalled();

    const compilationFailure = connector(vi.fn(async () => {
      throw new Error('SQL compilation error: invalid identifier');
    }));
    const compilePool = {
      getConnector: vi.fn(async () => compilationFailure),
      removeConnector: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
    };
    await expect(new QueryExecutor(compilePool as never).executePositional(
      'SELECT missing FROM sales.orders',
      [],
      config,
    )).rejects.toThrow('invalid identifier');
    expect(compilePool.removeConnector).not.toHaveBeenCalled();
  });

  it('recognizes only safe, single-statement replay candidates', () => {
    expect(isReconnectSafeReadOnlySql('-- bounded preview\nSELECT * FROM sales.orders')).toBe(true);
    expect(isReconnectSafeReadOnlySql('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent')).toBe(true);
    expect(isReconnectSafeReadOnlySql('SELECT 1; DROP TABLE orders')).toBe(false);
    expect(isReconnectSafeReadOnlySql('DELETE FROM orders')).toBe(false);
    expect(isRecoverableConnectionLoss(new Error('Connection reset by peer'))).toBe(true);
    expect(isRecoverableConnectionLoss(new Error('SQL compilation error'))).toBe(false);
  });
});
