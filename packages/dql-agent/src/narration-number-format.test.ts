import { describe, expect, it } from 'vitest';
import type { AnalyticalResultFactSetV1 } from './analytical-result-facts.js';
import { validateAnalyticalNarrativeClaims } from './analytical-result-facts.js';

/** Minimal fact set — the validator only reads `facts`. */
function factSet(value: unknown): AnalyticalResultFactSetV1 {
  return {
    version: 1, factSetId: 'fs', planId: 'p', graphId: 'g',
    graphFingerprint: 'gf', receiptId: 'r', resultFingerprint: 'rf',
    facts: [{
      factId: 'fact:1', kind: 'cell', receiptId: 'r', graphFingerprint: 'gf',
      resultFingerprint: 'rf', outputIds: ['revenue'], rowIndex: 0,
      value, coordinates: { customer_name: 'Wesley Jenkins' },
    }],
  } as AnalyticalResultFactSetV1;
}

function validate(text: string, value: unknown = 2004) {
  const set = factSet(value);
  return validateAnalyticalNarrativeClaims({
    factSet: set,
    claims: [{ claimId: 'c1', text, factIds: ['fact:1'] }],
  } as never);
}

describe('narration number validation tolerates formatting, not error', () => {
  it('accepts the number written the way the results table renders it', () => {
    // "$2,004.00" normalized to "2004.00", which never string-equalled the
    // fact's "2004" — so a correct sentence was rejected as UNSUPPORTED_NUMBER.
    // Two of those and the reader gets the deterministic row dump instead.
    expect(validate('Wesley Jenkins leads with $2,004.00.').status).toBe('valid');
  });

  it('accepts plain and comma-grouped forms of the same number', () => {
    expect(validate('Wesley Jenkins leads with 2004.').status).toBe('valid');
    expect(validate('Wesley Jenkins leads with 2,004.').status).toBe('valid');
  });

  it('accepts a fact stored with decimals against prose without them', () => {
    expect(validate('Wesley Jenkins leads with 2004.', 2004.0).status).toBe('valid');
  });

  it('STILL rejects a number that is genuinely not in the facts', () => {
    const outcome = validate('Wesley Jenkins leads with $2,005.00.');
    expect(outcome.status).toBe('invalid');
    expect(outcome.code).toBe('UNSUPPORTED_NUMBER');
  });

  it('STILL rejects a total the model computed rather than read', () => {
    expect(validate('The top customers total 4008 in revenue.').status).toBe('invalid');
  });
});
