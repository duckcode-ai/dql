import { describe, expect, it, vi } from 'vitest';
import { answerDatasetChartQuestion } from '../local-runtime.js';

/**
 * A question about an App chart is answered from that chart's governed result,
 * whose context carries the displayed rows. Those values reach a model only
 * inside the privacy boundary (RFC 0010 HH-5); otherwise the answer is the
 * deterministic summary, written without any model.
 */
const context = {
  tileId: 'claims-paid-by-region',
  evidenceScope: 'page',
  effectiveFilters: { quarter: '2026-Q3' },
  unboundFilters: [],
  source: { label: 'Claims paid by region', trust: 'certified' },
  result: {
    columns: ['region', 'claims_paid'],
    rows: [{ region: 'CA', claims_paid: 4210000 }, { region: 'US', claims_paid: 1830000 }],
    rowCount: 2,
  },
} as never;

describe('chart questions and the privacy boundary', () => {
  it('never sends the chart to a model outside the boundary', async () => {
    const generate = vi.fn(async () => 'CA leads with $4.21M.');
    const answer = await answerDatasetChartQuestion({
      context,
      question: 'Which region paid the most?',
      resolveProvider: () => ({ provider: { name: 'claude', generate } as never, valuesMayReachProvider: false }),
    });
    expect(generate).not.toHaveBeenCalled();
    expect(answer.mode).toBe('deterministic_context_summary');
    expect(answer.answer).toContain('outside the privacy boundary');
  });

  it('lets a model inside the boundary phrase the answer from the chart', async () => {
    const generate = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      expect(messages[1].content).toContain('4210000');
      return 'CA leads with $4.21M.';
    });
    const answer = await answerDatasetChartQuestion({
      context,
      question: 'Which region paid the most?',
      resolveProvider: () => ({ provider: { name: 'bedrock', generate } as never, valuesMayReachProvider: true }),
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({ mode: 'provider', answer: 'CA leads with $4.21M.' });
  });

  it('answers without a model when none is configured', async () => {
    const answer = await answerDatasetChartQuestion({ context, question: 'Which region paid the most?', resolveProvider: () => null });
    expect(answer.mode).toBe('deterministic_context_summary');
  });
});
