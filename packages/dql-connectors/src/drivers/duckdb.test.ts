import { describe, expect, it } from 'vitest';
import { normalizeDuckDBRow, normalizeDuckDBValue, resolveDuckDBModule } from './duckdb.js';

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
