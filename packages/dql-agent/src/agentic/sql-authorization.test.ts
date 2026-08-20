import { describe, expect, it } from 'vitest';
import {
  fingerprintSql,
  mintFinalSqlAuthorization,
  normalizeSqlForFingerprint,
  verifyFinalSql,
} from './sql-authorization.js';

const SQL = 'SELECT customer_name FROM dim_customers';
const auth = mintFinalSqlAuthorization({
  sql: SQL,
  proven: [
    { identifier: 'dim_customers', evidence: 'schema_tool' },
    { identifier: 'customer_name', evidence: 'preview' },
  ],
});

describe('exact-execution authorization', () => {
  it('admits a statement referencing only proven identifiers', () => {
    expect(verifyFinalSql(auth, SQL, ['dim_customers', 'customer_name']).ok).toBe(true);
  });

  it('REFUSES an identifier nothing in the run proved', () => {
    const verdict = verifyFinalSql(auth, SQL, ['dim_customers', 'credit_card_number']);
    expect(verdict.ok).toBe(false);
    expect(verdict.unproven).toEqual(['credit_card_number']);
  });

  it('REFUSES a statement that drifted from the one authorized', () => {
    // The gap this exists to close: the ledger verified one string and the
    // legacy loop executed another.
    const verdict = verifyFinalSql(auth, 'SELECT * FROM dim_customers', ['dim_customers']);
    expect(verdict.ok).toBe(false);
    expect(verdict.drifted).toBe(true);
  });

  it('does not mistake formatting for drift', () => {
    const reformatted = '  SELECT   customer_name\n  FROM dim_customers;  -- trailing note\n';
    expect(verifyFinalSql(auth, reformatted, ['dim_customers', 'customer_name']).ok).toBe(true);
  });

  it('CATALOG evidence alone does not authorize execution', () => {
    // Retrieval returning an object proves it exists in metadata, not that this
    // run proved the relation is real, reachable, and shaped as assumed.
    const catalogOnly = mintFinalSqlAuthorization({
      sql: SQL,
      proven: [{ identifier: 'dim_customers', evidence: 'catalog' }],
    });
    expect(verifyFinalSql(catalogOnly, SQL, ['dim_customers']).ok).toBe(false);
  });

  it('matches a qualified relation against its proven leaf', () => {
    expect(verifyFinalSql(auth, SQL, ['main.dim_customers', 'customer_name']).ok).toBe(true);
  });

  it('keeps the strongest evidence when an identity is proven twice', () => {
    const both = mintFinalSqlAuthorization({
      sql: SQL,
      proven: [
        { identifier: 'orders', evidence: 'catalog' },
        { identifier: 'orders', evidence: 'compiler' },
      ],
    });
    expect(both.evidence.orders).toBe('compiler');
    expect(verifyFinalSql(both, SQL, ['orders']).ok).toBe(true);
  });

  it('normalizes comments and whitespace out of the fingerprint', () => {
    expect(normalizeSqlForFingerprint('SELECT /* note */ 1')).toBe('select 1');
    expect(fingerprintSql('SELECT 1')).toBe(fingerprintSql('select   1;'));
  });
});
