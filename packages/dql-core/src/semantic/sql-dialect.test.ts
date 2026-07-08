import { describe, expect, it } from 'vitest';
import { describeDialectForPrompt } from './sql-dialect.js';

describe('describeDialectForPrompt (W1.5)', () => {
  it('describes DuckDB conventions (LIMIT at end, ILIKE, double-quote)', () => {
    const text = describeDialectForPrompt('duckdb');
    expect(text).toContain('duckdb');
    expect(text).toContain('LIMIT 100');
    expect(text).toContain('ILIKE');
  });

  it('describes SQL Server conventions (bracket quoting, OFFSET/FETCH, GETDATE)', () => {
    const text = describeDialectForPrompt('mssql');
    expect(text).toContain('[identifier]');
    expect(text).toContain('FETCH NEXT 100 ROWS ONLY');
    expect(text).toContain('GETDATE()');
    // SQL Server has no ILIKE.
    expect(text).not.toContain('ILIKE');
  });

  it('describes BigQuery conventions (backtick quoting, reversed DATE_TRUNC, LOWER LIKE)', () => {
    const text = describeDialectForPrompt('bigquery');
    expect(text).toContain('`identifier`');
    expect(text).toContain('DATE_TRUNC(ts_column, MONTH)');
    expect(text).toContain('LOWER(col) LIKE LOWER');
  });

  it('falls back to the DuckDB dialect for an unknown/blank driver', () => {
    expect(describeDialectForPrompt('')).toContain('duckdb');
    expect(describeDialectForPrompt('nonsense')).toContain('nonsense');
  });
});
