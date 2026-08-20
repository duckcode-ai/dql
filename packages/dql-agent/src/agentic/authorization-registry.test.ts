import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSqlAuthorization,
  consumeSqlAuthorization,
  pendingAuthorizationCount,
  registerSqlAuthorization,
} from './authorization-registry.js';
import { mintFinalSqlAuthorization } from './sql-authorization.js';

const auth = (sql: string) => mintFinalSqlAuthorization({
  sql,
  proven: [{ identifier: 'dim_customers', evidence: 'schema_tool' }],
});

describe('authorization registry', () => {
  beforeEach(() => {
    for (const key of ['run-a', 'run-b']) clearSqlAuthorization(key);
  });

  it('hands the authorization to the run that proved it', () => {
    registerSqlAuthorization('run-a', auth('SELECT 1'));
    expect(consumeSqlAuthorization('run-a')?.provenIdentifiers).toEqual(['dim_customers']);
  });

  it('CONSUMES on read, so one proof licenses exactly one execution', () => {
    // A retry must prove itself again rather than riding the previous attempt.
    registerSqlAuthorization('run-a', auth('SELECT 1'));
    expect(consumeSqlAuthorization('run-a')).toBeDefined();
    expect(consumeSqlAuthorization('run-a')).toBeUndefined();
  });

  it('does not let one run inherit another run\'s proofs', () => {
    registerSqlAuthorization('run-a', auth('SELECT 1'));
    expect(consumeSqlAuthorization('run-b')).toBeUndefined();
  });

  it('returns nothing for a run that never registered', () => {
    expect(consumeSqlAuthorization('never-seen')).toBeUndefined();
    expect(consumeSqlAuthorization('')).toBeUndefined();
  });

  it('clears without executing, for a run that ended early', () => {
    registerSqlAuthorization('run-a', auth('SELECT 1'));
    clearSqlAuthorization('run-a');
    expect(consumeSqlAuthorization('run-a')).toBeUndefined();
  });

  it('is bounded, so a crashed turn cannot leak without limit', () => {
    for (let i = 0; i < 200; i += 1) registerSqlAuthorization(`bulk-${i}`, auth('SELECT 1'));
    expect(pendingAuthorizationCount()).toBeLessThanOrEqual(64);
    for (let i = 0; i < 200; i += 1) clearSqlAuthorization(`bulk-${i}`);
  });
});
