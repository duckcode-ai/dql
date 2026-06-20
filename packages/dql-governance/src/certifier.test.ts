import { describe, expect, it } from 'vitest';
import type { BlockRecord, TestResultSummary } from '@duckcodeailabs/dql-project';
import { Certifier, ENTERPRISE_RULES } from './certifier.js';

function block(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    id: 'block-1',
    name: 'Customer Profile',
    domain: 'Customer',
    type: 'custom',
    version: '0.0.0',
    status: 'draft',
    gitRepo: '',
    gitPath: 'domains/customer/blocks/customer_profile.dql',
    gitCommitSha: '',
    description: 'Reusable customer profile block.',
    owner: 'customer-analytics',
    tags: ['customer'],
    dependencies: [],
    usedInCount: 0,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    pattern: 'entity_profile',
    grain: 'customer_id',
    entities: ['Customer'],
    declaredOutputs: ['customer_id', 'customer_name'],
    sourceSystems: ['crm'],
    reviewCadence: 'monthly',
    ...overrides,
  };
}

const passingTests: TestResultSummary = {
  passed: 1,
  failed: 0,
  skipped: 0,
  duration: 5,
  assertions: [{ name: 'assert row_count > 0', passed: true }],
  runAt: new Date('2026-06-20T00:00:00.000Z'),
};

describe('Certifier enterprise rules', () => {
  it('makes reusable block contract metadata hard requirements in enterprise mode', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(block({
      grain: undefined,
      declaredOutputs: [],
      sourceSystems: [],
      reviewCadence: undefined,
      pattern: undefined,
    }), passingTests);

    expect(result.certified).toBe(false);
    expect(result.errors.map((error) => error.rule)).toEqual(
      expect.arrayContaining([
        'Block declares grain',
        'Block declares outputs',
        'Block declares review cadence',
        'Block declares lineage context',
        'Block declares reusable pattern',
      ]),
    );
  });

  it('certifies enterprise-ready blocks when contract metadata and tests pass', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(block(), passingTests);

    expect(result.certified).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
