import { describe, expect, it } from 'vitest';
import { buildDeterministicDashboardStory, validateDashboardStoryBrief } from './dashboard-story.js';

describe('dashboard business story', () => {
  it('uses all eligible governed tiles and keeps the least-trusted source', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Explain beverage revenue and top customers',
      filters: { category: 'Beverage', period: ['2026-01-01', '2026-06-30'] },
      driverTileIds: ['segments'],
      tiles: [
        {
          tileId: 'customers', title: 'Top customers', status: 'ok', trustState: 'certified',
          result: { columns: ['customer', 'revenue'], rows: [{ customer: 'Alice', revenue: 120 }, { customer: 'Bob', revenue: 80 }] },
          citation: { kind: 'block', name: 'top_customers' },
        },
        {
          tileId: 'segments', title: 'Revenue by beverage type', status: 'ok', trustState: 'review_required',
          result: { columns: ['type', 'revenue'], rows: [{ type: 'Coffee', revenue: 150 }, { type: 'Tea', revenue: 50 }] },
          citation: { kind: 'semantic_query', name: 'beverage_type_revenue' },
        },
      ],
    });
    expect(new Set(result.facts.map((fact) => fact.tileId))).toEqual(new Set(['customers', 'segments']));
    expect(result.story.trustState).toBe('review_required');
    expect(result.story.paragraphs.join(' ')).toContain('Alice');
    expect(result.story.paragraphs.join(' ')).toContain('Coffee');
    expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
  });

  it('rejects invented numbers and unsupported causal language', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Revenue overview', filters: {},
      tiles: [{
        tileId: 'revenue', title: 'Revenue', status: 'ok', trustState: 'certified',
        result: { columns: ['revenue'], rows: [{ revenue: 100 }] },
      }],
    });
    const invalid = {
      ...result.story,
      paragraphs: ['Revenue fell 25 because renewals caused the decline.'],
      claims: [{ text: 'Renewals caused the decline.', factIds: [result.facts[0]!.id], kind: 'driver' as const }],
      generatedBy: 'ai' as const,
    };
    const validation = validateDashboardStoryBrief(invalid, result.facts);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/unsupported number|causal claim/);
  });
});
