import { describe, expect, it } from 'vitest';
import { hypothesesToSteps, parseResearchHypotheses, planResearchHypotheses } from './research-agent.js';

const ASSETS = {
  metrics: ['orders.revenue', 'customers.lifetime_spend'],
  blocks: ['top_customers'],
  dimensions: ['product_type', 'customer_name'],
};

const ok = JSON.stringify({
  hypotheses: [
    { statement: 'Revenue fell because enterprise customers churned', priorConfidence: 0.7, target: 'orders.revenue', action: 'compare_time', expectation: 'Revenue declines while customer count declines' },
    { statement: 'Revenue fell because discounting deepened', priorConfidence: 0.4, target: 'top_customers', action: 'lookup_block', expectation: 'Average order value falls while volume holds' },
  ],
});

describe('research hypotheses', () => {
  it('parses grounded hypotheses strongest first', () => {
    const out = parseResearchHypotheses(ok, ASSETS);
    expect(out).toHaveLength(2);
    expect(out[0]?.priorConfidence).toBe(0.7);
    expect(out[0]?.action).toBe('compare_time');
  });

  it('DROPS a hypothesis about an asset nobody has', () => {
    // An invented table in a dossier that reads as governed is worse than a
    // shorter investigation, so ungrounded statements are dropped, not repaired.
    const raw = JSON.stringify({ hypotheses: [
      { statement: 'Revenue fell because the marketing_spend table changed', priorConfidence: 0.9, target: 'marketing_spend', action: 'check_lineage', expectation: 'Spend drops' },
      ...JSON.parse(ok).hypotheses,
    ] });
    const out = parseResearchHypotheses(raw, ASSETS);
    expect(out.map((h) => h.target)).not.toContain('marketing_spend');
    expect(out).toHaveLength(2);
  });

  it('resolves an asset named by its leaf', () => {
    const raw = JSON.stringify({ hypotheses: [
      { statement: 'Revenue moved', priorConfidence: 0.5, target: 'revenue', action: 'compare_time', expectation: 'It moved' },
    ] });
    expect(parseResearchHypotheses(raw, ASSETS)[0]?.target).toBe('orders.revenue');
  });

  it('drops duplicate statements and caps the fan-out', () => {
    const many = JSON.stringify({ hypotheses: Array.from({ length: 9 }, (_, i) => ({
      statement: i < 2 ? 'Same idea twice' : `Idea ${i}`,
      priorConfidence: 0.5, target: 'orders.revenue', action: 'breakdown', expectation: 'x',
    })) });
    const out = parseResearchHypotheses(many, ASSETS);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(new Set(out.map((h) => h.statement)).size).toBe(out.length);
  });

  it('falls back to an unknown action rather than dropping the hypothesis', () => {
    const raw = JSON.stringify({ hypotheses: [
      { statement: 'Something happened', priorConfidence: 0.5, target: 'orders.revenue', action: 'run_python', expectation: 'x' },
    ] });
    expect(parseResearchHypotheses(raw, ASSETS)[0]?.action).toBe('lookup_metric');
  });

  it('returns nothing for prose, so the caller keeps its template', () => {
    expect(parseResearchHypotheses('I think revenue fell.', ASSETS)).toEqual([]);
    expect(parseResearchHypotheses('{"hypotheses":', ASSETS)).toEqual([]);
  });

  it('carries the hypothesis into the step, so the trace shows what is being tested', () => {
    const steps = hypothesesToSteps(parseResearchHypotheses(ok, ASSETS));
    expect(steps[0]?.thought).toBe('Revenue fell because enterprise customers churned');
    expect(steps[0]?.action).toEqual({ kind: 'compare_time', target: 'orders.revenue' });
  });

  it('never fails the run when the provider throws', async () => {
    const out = await planResearchHypotheses(
      { generate: async () => { throw new Error('down'); } }, 'why did revenue fall', ASSETS);
    expect(out).toEqual([]);
  });

  it('does not call the provider when there is nothing to ground against', async () => {
    let called = false;
    const out = await planResearchHypotheses(
      { generate: async () => { called = true; return ok; } },
      'why did revenue fall',
      { metrics: [], blocks: [], dimensions: [] },
    );
    expect(called).toBe(false);
    expect(out).toEqual([]);
  });

  it('shows the model the catalog it must ground in', async () => {
    let prompt = '';
    await planResearchHypotheses(
      { generate: async (m) => { prompt = m[0]?.content ?? ''; return ok; } },
      'why did revenue fall', ASSETS);
    expect(prompt).toContain('orders.revenue');
    expect(prompt).toContain('top_customers');
  });
});
