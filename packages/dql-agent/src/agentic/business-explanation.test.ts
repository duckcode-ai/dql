import { describe, it, expect } from 'vitest';
import {
  composeBusinessExplanation,
  explainObject,
  type ExplainableObject,
} from './business-explanation.js';

const topCustomers: ExplainableObject = {
  objectKey: 'dql:block:top_customers',
  objectType: 'dql_block',
  name: 'top_customers',
  description: 'Top 10 customers by lifetime spend, with order counts.',
  domain: 'orders',
  owner: 'analytics@example.com',
  status: 'certified',
  payload: {
    grain: 'customer',
    declaredOutputs: ['customer_name', 'lifetime_spend', 'order_count'],
    dimensions: ['customer'],
    llmContext: 'Use for global lifetime customer spend only, not category-scoped drilldowns.',
  },
};

describe('explainObject', () => {
  it('explains a certified block from what the catalog already holds', () => {
    const explanation = explainObject(topCustomers)!;
    expect(explanation.text).toContain('**top_customers**');
    expect(explanation.text).toContain('Top 10 customers by lifetime spend');
    expect(explanation.text).toContain('customer grain');
    expect(explanation.text).toContain('customer_name, lifetime_spend, order_count');
    expect(explanation.text).toContain('When to use it:');
    expect(explanation.text).toContain('certified and owned by analytics@example.com');
    expect(explanation.citations).toEqual(['dql:block:top_customers']);
    expect(explanation.governed).toBe(true);
  });

  it('returns null when there is nothing beyond a bare name to say', () => {
    // A confident paragraph assembled from an empty description reads like an
    // answer and carries no information — worse than falling through.
    expect(explainObject({ objectKey: 'k', objectType: 'dql_block', name: 'mystery' })).toBeNull();
  });

  it('marks a draft as provisional rather than implying it is approved', () => {
    const draft = explainObject({ ...topCustomers, status: 'draft' })!;
    expect(draft.text).toContain('draft');
    expect(draft.text).toMatch(/provisional/i);
    expect(draft.governed).toBe(false);
  });

  it('says a dbt model is not an approved business definition', () => {
    const model = explainObject({
      objectKey: 'dbt:model:fct_orders', objectType: 'dbt_model', name: 'fct_orders',
      description: 'One row per order.', status: 'dbt_imported',
    })!;
    expect(model.text).toContain('dbt project');
    expect(model.governed).toBe(false);
  });

  it('works from authored guidance alone when no description exists', () => {
    const guidanceOnly = explainObject({
      objectKey: 'k', objectType: 'dql_block', name: 'x',
      payload: { llmContext: 'Use only for the weekly board pack.' },
    })!;
    expect(guidanceOnly.text).toContain('Use only for the weekly board pack.');
  });
});

describe('composeBusinessExplanation', () => {
  const pool = [
    topCustomers,
    { objectKey: 'dbt:model:dim_customers', objectType: 'dbt_model', name: 'dim_customers',
      description: 'One row per customer.', status: 'dbt_imported' } as ExplainableObject,
  ];

  it('answers about the artifact the question actually names', () => {
    const explanation = composeBusinessExplanation('what does the top_customers block measure?', pool)!;
    expect(explanation.citations).toEqual(['dql:block:top_customers']);
  });

  it('matches a spaced form of an underscored name', () => {
    expect(composeBusinessExplanation('what is top customers?', pool)?.citations)
      .toEqual(['dql:block:top_customers']);
  });

  it('returns null when the question names nothing — never guesses the subject', () => {
    // Guessing which artifact a definition is about answers a different question
    // confidently, which is the failure this exists to avoid.
    expect(composeBusinessExplanation('how is revenue defined here?', pool)).toBeNull();
    expect(composeBusinessExplanation('what does it mean?', pool)).toBeNull();
  });

  it('prefers the certified artifact over the raw model beneath it', () => {
    const both = [
      { objectKey: 'dbt:model:top_customers', objectType: 'dbt_model', name: 'top_customers',
        description: 'Raw model.', status: 'dbt_imported' } as ExplainableObject,
      topCustomers,
    ];
    expect(composeBusinessExplanation('explain top_customers', both)?.citations)
      .toEqual(['dql:block:top_customers']);
  });

  it('returns null on an empty pool', () => {
    expect(composeBusinessExplanation('explain top_customers', [])).toBeNull();
  });
});
