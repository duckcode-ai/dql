import { describe, expect, it } from 'vitest';
import { applyFinding, createResearchState, nextHypothesis, DEFAULT_RESEARCH_LIMITS } from './agentic/research/hypothesis.js';

describe('the replan edge bounds an investigation', () => {
  it('stops once every hypothesis is settled', () => {
    let state = createResearchState('why did revenue fall', [
      { id: 'h1', statement: 'A', priorConfidence: 0.9 },
      { id: 'h2', statement: 'B', priorConfidence: 0.5 },
    ]);
    expect(nextHypothesis(state)?.id).toBe('h1');
    state = applyFinding(state, { id: 'f1', hypothesisId: 'h1', verdict: 'supports', summary: '', strength: 0.6 });
    expect(nextHypothesis(state)?.id).toBe('h2');
    state = applyFinding(state, { id: 'f2', hypothesisId: 'h2', verdict: 'refutes', summary: '', strength: 0.6 });
    // Nothing open — this is how the loop learns to stop.
    expect(nextHypothesis(state)).toBeUndefined();
  });

  it('stops at the hop budget even with hypotheses still open', () => {
    let state = createResearchState('q', Array.from({ length: 20 }, (_, i) => ({
      id: `h${i}`, statement: `H${i}`, priorConfidence: 0.5,
    })));
    for (let i = 0; i < DEFAULT_RESEARCH_LIMITS.maxHops; i += 1) {
      state = applyFinding(state, { id: `f${i}`, hypothesisId: `h${i}`, verdict: 'inconclusive', summary: '', strength: 0 });
    }
    expect(state.hopsUsed).toBe(DEFAULT_RESEARCH_LIMITS.maxHops);
    expect(nextHypothesis(state)).toBeUndefined();
  });
});
