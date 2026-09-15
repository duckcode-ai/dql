import { describe, expect, it } from 'vitest';
import { runContextLine, runContextSummary, skillName } from './run-context-summary';

describe('what shaped an answer', () => {
  it('reads the scope, skills and enforced filters from the receipt', () => {
    const summary = runContextSummary({
      context: {
        envelope: { activeDomain: 'commerce' },
        rendered: { skills: ['commerce::skill::beverage-analysis', 'sql-conventions', 'sql-conventions'] },
        enforced: { requiredFilters: ["status = 'completed'", { text: 'is_test = false' }], policies: [], gaps: [] },
        suggestedDomain: 'commerce',
      },
    });
    expect(summary).toEqual({ domain: 'commerce', skills: ['beverage-analysis', 'sql-conventions'], requiredFilters: ["status = 'completed'", 'is_test = false'] });
    expect(runContextLine(summary)).toBe("Scoped to commerce · Skills: beverage-analysis, sql-conventions · Required filters applied: status = 'completed'; is_test = false");
  });

  it('offers the suggested domain only when the question was not scoped', () => {
    expect(runContextSummary({ context: { envelope: { activeDomain: null }, suggestedDomain: 'commerce' } }).suggestedDomain).toBe('commerce');
    expect(runContextLine(runContextSummary({ context: {} }))).toBeUndefined();
    expect(runContextSummary(undefined)).toEqual({ skills: [], requiredFilters: [] });
    expect(skillName('growth::skill::churn')).toBe('churn');
  });
});
