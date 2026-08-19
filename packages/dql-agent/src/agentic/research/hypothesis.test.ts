import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RESEARCH_LIMITS,
  applyFinding,
  concludeResearch,
  createResearchState,
  nextHypothesis,
  type HypothesisFinding,
} from './hypothesis.js';

const state = () => createResearchState('why did revenue fall last month', [
  { id: 'h1', statement: 'enterprise customers churned', priorConfidence: 0.7 },
  { id: 'h2', statement: 'pricing changed', priorConfidence: 0.4 },
  { id: 'h3', statement: 'a pipeline broke', priorConfidence: 0.2 },
]);

const finding = (over: Partial<HypothesisFinding> & Pick<HypothesisFinding, 'hypothesisId' | 'verdict'>): HypothesisFinding => ({
  id: `f-${over.hypothesisId}`, summary: 'observed', strength: 0.8, ...over,
});

describe('nextHypothesis', () => {
  it('tests the most likely explanation first', () => {
    // Not cheapest-first: resolving the likely cause is what lets later hops be
    // skipped entirely.
    expect(nextHypothesis(state())?.id).toBe('h1');
  });

  it('stops when the hop budget is spent', () => {
    const spent = { ...state(), hopsUsed: DEFAULT_RESEARCH_LIMITS.maxHops };
    expect(nextHypothesis(spent)).toBeUndefined();
  });

  it('stops when nothing is open', () => {
    let s = state();
    for (const id of ['h1', 'h2', 'h3']) s = applyFinding(s, finding({ hypothesisId: id, verdict: 'refutes' }));
    expect(nextHypothesis(s)).toBeUndefined();
  });

  it('is deterministic when priors tie', () => {
    const tied = createResearchState('q', [
      { id: 'b', statement: 'b', priorConfidence: 0.5 },
      { id: 'a', statement: 'a', priorConfidence: 0.5 },
    ]);
    expect(nextHypothesis(tied)?.id).toBe('a');
  });
});

describe('applyFinding — the replan edge', () => {
  it('closes a refuted hypothesis instead of leaving it to be retried', () => {
    // The template's failure was elaborating a premise its own evidence had
    // already ruled out.
    const s = applyFinding(state(), finding({ hypothesisId: 'h1', verdict: 'refutes', summary: 'enterprise revenue rose' }));
    const h1 = s.hypotheses.find((h) => h.id === 'h1')!;
    expect(h1.status).toBe('refuted');
    expect(h1.rationale).toBe('enterprise revenue rose');
    expect(nextHypothesis(s)?.id).toBe('h2');
  });

  it('records support and inconclusive as distinct outcomes', () => {
    // An executed query that does not discriminate must not be recorded as
    // support.
    let s = applyFinding(state(), finding({ hypothesisId: 'h1', verdict: 'supports' }));
    s = applyFinding(s, finding({ hypothesisId: 'h2', verdict: 'inconclusive' }));
    expect(s.hypotheses.find((h) => h.id === 'h1')!.status).toBe('supported');
    expect(s.hypotheses.find((h) => h.id === 'h2')!.status).toBe('inconclusive');
  });

  it('spawns a new hypothesis a finding opened — the edge a frozen plan cannot express', () => {
    const s = applyFinding(state(), finding({
      hypothesisId: 'h1', verdict: 'supports',
      spawns: [{ statement: 'churn concentrated in one region', priorConfidence: 0.6 }],
    }));
    const spawned = s.hypotheses.find((h) => h.parentId === 'h1')!;
    expect(spawned).toMatchObject({ statement: 'churn concentrated in one region', status: 'open', priorConfidence: 0.6 });
    // And it becomes the next thing tested, ahead of the weaker originals.
    expect(nextHypothesis(s)?.id).toBe(spawned.id);
  });

  it('never re-proposes an idea already in play', () => {
    // A loop that keeps re-spawning the same statement burns the whole hop
    // budget without learning anything.
    const s = applyFinding(state(), finding({
      hypothesisId: 'h1', verdict: 'supports',
      spawns: [{ statement: 'Pricing Changed', priorConfidence: 0.9 }, { statement: '  ', priorConfidence: 0.5 }],
    }));
    expect(s.hypotheses).toHaveLength(3);
  });

  it('caps live hypotheses so spawning cannot fan out without end', () => {
    const s = applyFinding(state(), finding({
      hypothesisId: 'h1', verdict: 'supports',
      spawns: Array.from({ length: 20 }, (_, i) => ({ statement: `spawn ${i}`, priorConfidence: 0.5 })),
    }), { maxHops: 12, maxOpenHypotheses: 4 });
    expect(s.hypotheses.filter((h) => h.status === 'open').length).toBeLessThanOrEqual(4);
  });

  it('counts a hop per finding and clamps a bad confidence', () => {
    const s = applyFinding(state(), finding({
      hypothesisId: 'h1', verdict: 'supports',
      spawns: [{ statement: 'nested', priorConfidence: 99 }],
    }));
    expect(s.hopsUsed).toBe(1);
    expect(s.hypotheses.find((h) => h.statement === 'nested')!.priorConfidence).toBe(1);
  });
});

describe('concludeResearch', () => {
  it('reports what was NOT established as prominently as what was', () => {
    // A research answer listing only confirmations reads as a complete
    // explanation, and completeness is the one thing a bounded investigation
    // cannot honestly claim.
    let s = applyFinding(state(), finding({ hypothesisId: 'h1', verdict: 'supports' }));
    s = applyFinding(s, finding({ hypothesisId: 'h2', verdict: 'refutes' }));
    const conclusion = concludeResearch(s);
    expect(conclusion.supported.map((h) => h.id)).toEqual(['h1']);
    expect(conclusion.refuted.map((h) => h.id)).toEqual(['h2']);
    expect(conclusion.unresolved.map((h) => h.id)).toEqual(['h3']);
    expect(conclusion.exhausted).toBe(false);
  });

  it('flags an investigation that ran out of hops with threads still open', () => {
    const s = { ...state(), hopsUsed: 12 };
    expect(concludeResearch(s).exhausted).toBe(true);
  });

  it('does not flag exhaustion when everything was settled', () => {
    let s = state();
    for (const id of ['h1', 'h2', 'h3']) s = applyFinding(s, finding({ hypothesisId: id, verdict: 'supports' }));
    expect(concludeResearch({ ...s, hopsUsed: 12 }).exhausted).toBe(false);
  });
});
