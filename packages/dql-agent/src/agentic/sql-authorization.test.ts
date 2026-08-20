import { describe, expect, it } from 'vitest';
import {
  AgenticExecutionCapabilityGate,
  createAgenticSqlExecutionCapability,
  fingerprintSql,
  fingerprintSqlBindings,
  mintFinalSqlAuthorization,
  normalizeSqlForFingerprint,
  qualifyAuthorizationReferences,
  verifyAgenticSqlExecutionCapability,
  verifyFinalSql,
} from './sql-authorization.js';

const SQL = 'SELECT customer_name FROM dim_customers';
const auth = mintFinalSqlAuthorization({
  sql: SQL,
  proven: [
    { identifier: 'dim_customers', evidence: 'schema_tool' },
    { identifier: 'dim_customers.customer_name', evidence: 'preview' },
  ],
});

describe('exact-execution authorization', () => {
  it('admits a statement referencing only proven identifiers', () => {
    expect(verifyFinalSql(auth, SQL, ['dim_customers', 'dim_customers.customer_name']).ok).toBe(true);
  });

  it('REFUSES an identifier nothing in the run proved', () => {
    const verdict = verifyFinalSql(auth, SQL, ['dim_customers', 'dim_customers.credit_card_number']);
    expect(verdict.ok).toBe(false);
    expect(verdict.unproven).toEqual(['dim_customers.credit_card_number']);
  });

  it('REFUSES a statement that drifted from the one authorized', () => {
    // The gap this exists to close: the ledger verified one string and the
    // legacy loop executed another.
    const verdict = verifyFinalSql(auth, 'SELECT * FROM dim_customers', ['dim_customers']);
    expect(verdict.ok).toBe(false);
    expect(verdict.drifted).toBe(true);
  });

  it('REFUSES comment, whitespace, and literal drift from the authorized bytes', () => {
    const reformatted = '  SELECT   customer_name\n  FROM dim_customers;  -- trailing note\n';
    expect(verifyFinalSql(auth, reformatted, ['dim_customers', 'dim_customers.customer_name'])).toMatchObject({
      ok: false,
      drifted: true,
    });
    expect(verifyFinalSql(auth, "SELECT customer_name FROM dim_customers WHERE customer_name = 'Ada'", [
      'dim_customers',
      'dim_customers.customer_name',
    ])).toMatchObject({ ok: false, drifted: true });
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

  it('does not match an identity by its leaf name', () => {
    expect(verifyFinalSql(auth, SQL, ['main.dim_customers', 'customer_name']).ok).toBe(false);
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

  it('uses exact SQL and canonical bindings in the fingerprint', () => {
    expect(normalizeSqlForFingerprint('SELECT /* note */ 1')).toBe('SELECT /* note */ 1');
    expect(fingerprintSql('SELECT 1')).not.toBe(fingerprintSql('select   1;'));
    expect(fingerprintSqlBindings({ b: 2, a: [true, 'x'] }))
      .toBe(fingerprintSqlBindings({ a: [true, 'x'], b: 2 }));
    expect(fingerprintSqlBindings({ a: 'x' })).not.toBe(fingerprintSqlBindings({ a: 'X' }));
  });

  it('refuses capability use when any run scope or binding drifts', () => {
    const capability = createAgenticSqlExecutionCapability({
      sql: SQL,
      proven: [
        { identifier: 'dim_customers', evidence: 'schema_tool' },
        { identifier: 'dim_customers.customer_name', evidence: 'preview' },
      ],
      runId: 'run-a',
      executionId: 'child-a',
      snapshotId: 'snapshot-a',
      planId: 'plan-a',
      targetFingerprint: 'target-a',
      bindings: { limit: 10 },
    });
    expect(capability).toBeDefined();
    expect(verifyAgenticSqlExecutionCapability(capability!, SQL, {
      runId: 'run-a', executionId: 'child-a', snapshotId: 'snapshot-a', planId: 'plan-a',
      targetFingerprint: 'target-a', bindings: { limit: 10 },
    }).ok).toBe(true);
    expect(verifyAgenticSqlExecutionCapability(capability!, SQL, {
      runId: 'run-b', executionId: 'child-a', snapshotId: 'snapshot-a', planId: 'plan-a',
      targetFingerprint: 'target-a', bindings: { limit: 10 },
    })).toMatchObject({ ok: false, drifted: true });
    expect(verifyAgenticSqlExecutionCapability(capability!, SQL, {
      runId: 'run-a', executionId: 'child-a', snapshotId: 'snapshot-a', planId: 'plan-a',
      targetFingerprint: 'target-a', bindings: { limit: 11 },
    })).toMatchObject({ ok: false, drifted: true });
  });

  it('does not mint a generated execution capability without a frozen server scope', () => {
    expect(createAgenticSqlExecutionCapability({
      sql: SQL,
      proven: [{ identifier: 'dim_customers', evidence: 'schema_tool' }],
      runId: 'run-a', snapshotId: 'snapshot-a', planId: 'plan-a',
    })).toBeUndefined();
  });

  it('consumes one capability once while independent child gates stay isolated', async () => {
    const capability = createAgenticSqlExecutionCapability({
      sql: SQL,
      proven: [{ identifier: 'dim_customers', evidence: 'schema_tool' }],
      runId: 'run-parent', executionId: 'child-a', snapshotId: 'snapshot-a', planId: 'plan-a', targetFingerprint: 'target-a',
    })!;
    const childA = new AgenticExecutionCapabilityGate();
    const childB = new AgenticExecutionCapabilityGate();
    // Same event-loop turn: exactly one concurrent caller receives child A's
    // one-shot authority. A separate child instance is deliberately isolated.
    const attempts = await Promise.all([
      Promise.resolve().then(() => childA.consume(capability)),
      Promise.resolve().then(() => childA.consume(capability)),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    // A repair is a fresh analyst invocation/capability, not a second use of
    // the old one-shot proof.
    expect(childA.consume({ ...capability, executionId: 'child-a-repair' })).toBe(true);
    expect(childB.consume(capability)).toBe(true);
  });

  it('qualifies columns only through an alias observed in this exact statement', () => {
    expect(qualifyAuthorizationReferences(
      'SELECT c.customer_name FROM analytics.dim_customers AS c',
      { relations: ['analytics.dim_customers'], columns: [{ relation: 'c', column: 'customer_name' }] },
    )).toEqual(['analytics.dim_customers', 'analytics.dim_customers.customer_name']);
    expect(qualifyAuthorizationReferences(
      'SELECT id FROM analytics.orders JOIN analytics.customers ON 1 = 1',
      { relations: ['analytics.orders', 'analytics.customers'], columns: [{ column: 'id' }] },
    )).toContain('id');
  });
});
