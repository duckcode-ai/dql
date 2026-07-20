import { describe, expect, it } from 'vitest';
import { rankModelingOptions, type ModelingSearchOption } from './modeling-search';

describe('enterprise modeling search (UI-001, PERF-002)', () => {
  it('finds an exact model near the end of a 4,000-model catalog', () => {
    const options: ModelingSearchOption[] = Array.from({ length: 4_000 }, (_, index) => ({
      value: `model.company.analytics_${index}`,
      label: `analytics_${index}`,
      description: `warehouse model ${index}`,
    }));
    options[3_999] = { value: 'model.company.customer_lifetime_value', label: 'Customer lifetime value', description: 'One row per customer' };
    expect(rankModelingOptions(options, 'customer lifetime', 50)[0]?.value).toBe('model.company.customer_lifetime_value');
  });

  it('never renders more than the requested result window', () => {
    const options = Array.from({ length: 7_000 }, (_, index) => ({ value: `metric_${index}`, label: `Revenue metric ${index}` }));
    expect(rankModelingOptions(options, 'revenue', 50)).toHaveLength(50);
  });

  it('matches plain-English tokens across labels and descriptions', () => {
    const options = [
      { value: 'rx_claim', label: 'Claim fact', description: 'Prescription fulfillment and paid amount' },
      { value: 'member', label: 'Member', description: 'Covered patient' },
    ];
    expect(rankModelingOptions(options, 'prescription paid')[0]?.value).toBe('rx_claim');
  });
});
