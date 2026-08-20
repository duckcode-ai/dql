import { describe, expect, it } from 'vitest';
import { compoundStopReason, compoundTrustState, trustStateForAgentAnswer } from './local-runtime.js';

const certified = { certification: 'certified', kind: 'certified' } as never;
const semanticProven = {
  kind: 'uncertified',
  route: { tier: 'semantic_metric' },
  aggregationSafetyProof: { status: 'safe' },
} as never;
const semanticUnproven = {
  kind: 'uncertified',
  route: { tier: 'semantic_metric' },
  aggregationSafetyProof: { status: 'blocked' },
} as never;
const generated = { kind: 'uncertified', route: { tier: 'generated_sql' } } as never;

describe('trust for one answer', () => {
  it('grants certified only for an executed certified artifact', () => {
    expect(trustStateForAgentAnswer(certified)).toBe('certified');
  });

  it('grants governed to a semantic route ONLY when its proof passed', () => {
    expect(trustStateForAgentAnswer(semanticProven)).toBe('governed');
    // A route label is not authority — this is why the single-answer path
    // checks the proof rather than the tier.
    expect(trustStateForAgentAnswer(semanticUnproven)).toBe('review_required');
  });

  it('caps generated SQL at review_required', () => {
    expect(trustStateForAgentAnswer(generated)).toBe('review_required');
  });
});

describe('compound trust is the weakest successful child', () => {
  it('does NOT promote generated children to governed', () => {
    // The violation: `every child completed ? 'governed'` stamped governed
    // authority on an answer assembled from review-required SQL.
    expect(compoundTrustState(['certified', 'governed', 'review_required'])).toBe('review_required');
    expect(compoundTrustState(['governed', 'review_required'])).toBe('review_required');
  });

  it('caps an all-certified parent at governed, never certified', () => {
    // Certified is granted by EXECUTING the exact certified artifact. A parent
    // that merely assembled certified children executed no such artifact.
    expect(compoundTrustState(['certified', 'certified'])).toBe('governed');
    expect(compoundTrustState(['certified'])).toBe('governed');
  });

  it('reports governed when every successful child is governed', () => {
    expect(compoundTrustState(['governed', 'governed'])).toBe('governed');
    expect(compoundStopReason(2, 2, 'governed')).toBe('governed_compound_answer');
  });

  it('uses neutral review vocabulary for partial or review-required compound results', () => {
    expect(compoundStopReason(1, 2, 'governed')).toBe('human_review_required');
    expect(compoundStopReason(2, 2, 'review_required')).toBe('human_review_required');
  });

  it('takes the weakest regardless of order', () => {
    expect(compoundTrustState(['review_required', 'governed'])).toBe('review_required');
    expect(compoundTrustState(['governed', 'grounded'])).toBe('grounded');
  });

  it('refuses to invent trust when no child succeeded', () => {
    expect(compoundTrustState([])).toBe('review_required');
  });
});
