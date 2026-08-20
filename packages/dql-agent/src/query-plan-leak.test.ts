import { describe, expect, it } from 'vitest';
import { parseProposal, stripQueryPlanScaffolding } from './answer-loop.js';

describe('QUERY PLAN scaffolding never reaches the reader', () => {
  it('removes the plan section but keeps the answer around it', () => {
    // Reported verbatim from a live run: someone asked why a customer topped a
    // list and was handed a join plan.
    const raw = [
      'Outcome: Review SQL preview.',
      '',
      "QUERY PLAN: grain = one row per customer, filtered to the named customer",
      "(Matthew Meyer, honorific stripped). Single relation, no join needed: FROM",
      "dev.customers c, filtered on c.customer_name ILIKE '%Matthew Meyer%'.",
      '',
      'Matthew Meyer has the highest lifetime spend at $3,089.80.',
    ].join('\n');
    const out = stripQueryPlanScaffolding(raw);
    expect(out).not.toContain('QUERY PLAN');
    expect(out).not.toContain('ILIKE');
    expect(out).toContain('highest lifetime spend at $3,089.80');
  });

  it('handles a bolded heading and a plan that runs to the end', () => {
    expect(stripQueryPlanScaffolding('Answer first.\n\n**QUERY PLAN**: grain = one row per order.'))
      .toBe('Answer first.');
  });

  it('leaves prose without a plan untouched', () => {
    const clean = 'Wesley Jenkins leads with $2,004.00.';
    expect(stripQueryPlanScaffolding(clean)).toBe(clean);
  });

  it('strips it through parseProposal, which is what callers use', () => {
    const raw = 'QUERY PLAN: grain = one row per customer.\n\nThe top customer is Meyer.\n\n```sql\nSELECT 1\n```';
    const parsed = parseProposal(raw);
    expect(parsed.text).not.toContain('QUERY PLAN');
    expect(parsed.text).toContain('The top customer is Meyer.');
    expect(parsed.sql).toBe('SELECT 1');
  });
});
