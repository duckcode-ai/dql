import { describe, expect, it } from 'vitest';
import { classifyGovernedQueryShape } from './query-shape.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';

// A minimal semantic layer stub: total_bcm composes natively, percent_mom_bcm does not.
const layer = {
  canComposeMetric: (name: string) => name === 'total_bcm',
};

function shape(question: string, metric: string | undefined = 'total_bcm') {
  return classifyGovernedQueryShape(buildAnalysisQuestionPlan(question), metric, layer);
}

describe('classifyGovernedQueryShape', () => {
  it('marks a simple metric breakdown as compiler_expressible', () => {
    expect(shape('total bcm by customer')).toBe('compiler_expressible');
    expect(shape('total bcm by customer for the south region')).toBe('compiler_expressible');
  });

  it('routes a non-composable (derived) metric to the runtime', () => {
    expect(shape('percent mom bcm by customer', 'percent_mom_bcm')).toBe('runtime_required');
  });

  it('marks per-group top-N as a genuine gap (free SQL)', () => {
    expect(shape('top 3 products per region by bcm')).toBe('genuine_gap');
  });

  it('marks window / cumulative / HAVING / arithmetic as genuine gaps', () => {
    expect(shape('running total of bcm by month')).toBe('genuine_gap');
    expect(shape('month over month bcm by customer')).toBe('genuine_gap');
    expect(shape('customers having total bcm more than 1000000')).toBe('genuine_gap');
    expect(shape('bcm split quantity multiplied by unit value by customer')).toBe('genuine_gap');
  });

  it('a plain per-X breakdown is NOT a genuine gap', () => {
    // "revenue per region" is a breakdown, not per-group top-N.
    expect(shape('bcm per region')).toBe('compiler_expressible');
  });
});
describe('classifyGovernedQueryShape — multi-metric questions (AGT-017)', () => {
  it('keeps a multi-metric question compiler_expressible when every metric composes', () => {
    expect(
      classifyGovernedQueryShape(
        buildAnalysisQuestionPlan('total bcm and total bcm by customer'),
        ['total_bcm', 'total_bcm'],
        layer,
      ),
    ).toBe('compiler_expressible');
  });

  it('sends the whole query to the runtime when any selected metric is derived', () => {
    // One runtime-only metric pulls the combined query with it: the native
    // compiler cannot build half of a multi-metric selection.
    expect(
      classifyGovernedQueryShape(
        buildAnalysisQuestionPlan('total bcm and percent mom bcm by customer'),
        ['total_bcm', 'percent_mom_bcm'],
        layer,
      ),
    ).toBe('runtime_required');
  });

  it('still accepts the single-metric string form unchanged', () => {
    expect(shape('total bcm by customer')).toBe('compiler_expressible');
    expect(shape('total bcm by customer', undefined)).toBe('compiler_expressible');
  });
});
