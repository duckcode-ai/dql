import { describe, expect, it } from 'vitest';
import type { AgentEvidenceCandidate } from './meaning-resolution.js';
import { rankingCandidateFitsBareQuestion } from './router.js';

function candidate(name: string, id = `semantic:metric:${name}`): AgentEvidenceCandidate {
  return {
    id,
    kind: 'semantic_metric',
    trustTier: 'governed',
    name,
    relevanceScore: 0.9,
    matchReasons: [],
    compatibility: 'compatible',
  } as AgentEvidenceCandidate;
}

describe('bare-ranking assumption fit', () => {
  it('accepts a measure that adds no scope the question did not ask for', () => {
    for (const name of ['revenue', 'lifetime_spend', 'total sales', 'order_count', 'gross margin']) {
      expect(rankingCandidateFitsBareQuestion('who are the top customers', candidate(name)))
        .toBe(true);
    }
  });

  it('rejects a measure carrying an unrequested filter', () => {
    // This is the case that makes silent assumption dangerous: answering "who
    // are the top customers" from `top_beverage_customers` returns a confident
    // list for a DIFFERENT question than the one asked.
    for (const name of ['top_beverage_customers', 'perishable_revenue', 'enterprise_arr']) {
      expect(rankingCandidateFitsBareQuestion('who are the top customers', candidate(name)))
        .toBe(false);
    }
  });

  it('accepts the same scoped measure once the question asks for that scope', () => {
    expect(rankingCandidateFitsBareQuestion(
      'who are the top beverage customers',
      candidate('top_beverage_customers'),
    )).toBe(true);
  });

  it('checks the qualified id too, not only the display name', () => {
    expect(rankingCandidateFitsBareQuestion(
      'who are the top customers',
      { ...candidate('revenue'), qualifiedId: 'semantic:metric:beverages.revenue' },
    )).toBe(false);
  });

  it('rejects a candidate with no usable name rather than assuming blind', () => {
    expect(rankingCandidateFitsBareQuestion('who are the top customers', candidate('', '')))
      .toBe(false);
  });
});
