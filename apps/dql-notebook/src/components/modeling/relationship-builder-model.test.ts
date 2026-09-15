import { describe, expect, it } from 'vitest';
import {
  fanoutForCardinality,
  levelOfRelationship,
  lifecycleForLevel,
  nextRelationshipLocalId,
  proofSignature,
  relationshipProfileLines,
  relationshipSaveBlockers,
  relationshipSentence,
  relationshipStatusView,
  type RelationshipEvidence,
} from './relationship-builder-model';

const evidence = (overrides: Partial<RelationshipEvidence> = {}): RelationshipEvidence => ({
  status: 'passed', checkedAt: '2026-09-15T00:00:00Z', queryFingerprint: 'q', proofFingerprint: 'p',
  fromRows: 1000, toRows: 100, joinedRows: 1000, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 14, maxToPerKey: 1,
  message: '', ...overrides,
});

describe('relationship builder wording', () => {
  it('reads each cardinality as a sentence', () => {
    expect(relationshipSentence('many_to_one', 'Order', 'Customer')).toBe('Each Order belongs to one Customer.');
    expect(relationshipSentence('one_to_many', 'Customer', 'Order')).toBe('Each Customer can have many Order rows.');
    expect(relationshipSentence('one_to_one', 'Customer', 'Profile')).toBe('Each Customer matches exactly one Profile.');
    expect(relationshipSentence('many_to_many', 'Order', 'Promo')).toContain('multiplies rows');
    expect(relationshipSentence('unknown', 'A', 'B')).toBe('A relates to B.');
  });

  it('derives fanout from cardinality', () => {
    expect(fanoutForCardinality('many_to_one')).toBe('safe');
    expect(fanoutForCardinality('many_to_many')).toBe('forbidden');
    expect(fanoutForCardinality('unknown')).toBe('unknown');
  });

  it('summarizes the warehouse check without rounding a partial match up to 100%', () => {
    expect(relationshipProfileLines(evidence(), 'Order', 'Customer')).toEqual([
      'Every Order row finds a Customer.',
      'Each Customer key appears once; each Order key appears up to 14 times.',
    ]);
    const lines = relationshipProfileLines(evidence({ unmatchedFrom: 1, fromNullKeys: 1, joinedRows: 1400, maxToPerKey: 3 }), 'Order', 'Customer');
    expect(lines[0]).toBe("99.9% of Order rows find a Customer (1 don't).");
    expect(lines[1]).toBe('1 Order row has an empty key.');
    expect(lines.at(-1)).toContain('counted more than once');
  });
});

describe('relationship status and ids', () => {
  it('shows one badge that says what Ask does', () => {
    expect(relationshipStatusView({ status: 'certified', automaticJoinAllowed: true }).label).toBe('Certified');
    expect(relationshipStatusView({ status: 'certified', automaticJoinAllowed: false }).label).toBe('Needs recheck');
    expect(relationshipStatusView({ status: 'reviewed', automaticJoinAllowed: false, validation: evidence() }).label).toBe('Validated');
    expect(relationshipStatusView({ status: 'draft', automaticJoinAllowed: false }).label).toBe('Draft');
    expect(relationshipStatusView({ status: 'deprecated', automaticJoinAllowed: false }).label).toBe('Retired');
  });

  it('maps a saved relationship to its level and back, never downgrading silently', () => {
    expect(levelOfRelationship({ status: 'certified' })).toBe('certified');
    expect(levelOfRelationship({ status: 'reviewed', validation: evidence() })).toBe('validated');
    expect(levelOfRelationship({ status: 'reviewed' })).toBe('draft');
    expect(lifecycleForLevel('validated')).toBe('reviewed');
    expect(lifecycleForLevel('certified')).toBe('certified');
  });

  it('keeps ids short and unique when two relationships join the same models', () => {
    expect(nextRelationshipLocalId('orders', 'customers', [])).toBe('orders_to_customers');
    expect(nextRelationshipLocalId('orders', 'customers', ['orders_to_customers'])).toBe('orders_to_customers_2');
    expect(nextRelationshipLocalId('Stg Orders', 'customers', ['stg_orders_to_customers', 'stg_orders_to_customers_2'])).toBe('stg_orders_to_customers_3');
  });
});

describe('what blocks a save', () => {
  const signature = proofSignature({ from: 'a', to: 'b', keys: [{ from: 'k', to: 'k' }], cardinality: 'many_to_one' });
  const base = { keysComplete: true, currentSignature: signature, fromName: 'Order', toName: 'Customer' };

  it('saves a draft without a check', () => {
    expect(relationshipSaveBlockers({ ...base, level: 'draft' })).toEqual([]);
  });

  it('needs a passing check for these exact keys and cardinality before Validated', () => {
    expect(relationshipSaveBlockers({ ...base, level: 'validated' })).toEqual(['Run the warehouse check for these keys first.']);
    const otherCardinality = proofSignature({ from: 'a', to: 'b', keys: [{ from: 'k', to: 'k' }], cardinality: 'one_to_one' });
    expect(relationshipSaveBlockers({ ...base, level: 'validated', evidence: evidence(), evidenceSignature: otherCardinality })).toEqual(['Run the warehouse check for these keys first.']);
    expect(relationshipSaveBlockers({ ...base, level: 'validated', evidence: evidence({ status: 'failed' }), evidenceSignature: signature })[0]).toContain('only be saved as a draft');
    expect(relationshipSaveBlockers({ ...base, level: 'validated', evidence: evidence(), evidenceSignature: signature })).toEqual([]);
  });

  it('needs both grains to certify and names the model that is missing one', () => {
    const blockers = relationshipSaveBlockers({ ...base, level: 'certified', evidence: evidence(), evidenceSignature: signature, fromGrain: 'order_id' });
    expect(blockers).toEqual(["Certifying needs to know what one row of Customer means (its grain). Set it in the model's settings first."]);
    expect(relationshipSaveBlockers({ ...base, level: 'certified', evidence: evidence(), evidenceSignature: signature, fromGrain: 'order_id', toGrain: 'customer_id' })).toEqual([]);
  });
});
