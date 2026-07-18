import { describe, expect, it } from 'vitest';
import { resolveAgentFilterValueBindings, type AgentSchemaTable } from './answer-loop.js';

const schema: AgentSchemaTable[] = [{
  relation: 'dev.customers',
  name: 'customers',
  columns: [
    { name: 'customer_name', type: 'VARCHAR', sampleValues: ['Melissa Lopez'] },
    { name: 'customer_type', type: 'VARCHAR', sampleValues: ['returning'] },
  ],
}];

describe('stored data-value resolution', () => {
  it('AGT-005 resolves a unique bounded typo without turning it into metadata tokens', () => {
    expect(resolveAgentFilterValueBindings('Melissa Lopex', schema)).toEqual([{
      column: 'customer_name',
      canonicalValue: 'Melissa Lopez',
      match: 'fuzzy',
      confidence: expect.any(Number),
    }]);
  });

  it('does not auto-bind ambiguous fuzzy candidates', () => {
    const ambiguous: AgentSchemaTable[] = [{
      relation: 'dev.customers',
      name: 'customers',
      columns: [{ name: 'customer_name', sampleValues: ['Melissa Lopez', 'Melissa Lopes'] }],
    }];
    expect(resolveAgentFilterValueBindings('Melissa Lopex', ambiguous)).toEqual([]);
  });

  it('resolves a unique partial display name to the stored member', () => {
    expect(resolveAgentFilterValueBindings('Melissa', schema)).toEqual([{
      column: 'customer_name',
      canonicalValue: 'Melissa Lopez',
      match: 'fuzzy',
      confidence: 0.97,
    }]);
  });

  it('does not guess when a partial name matches multiple stored members', () => {
    const ambiguous: AgentSchemaTable[] = [{
      relation: 'dev.customers',
      name: 'customers',
      columns: [{ name: 'customer_name', sampleValues: ['Melissa Lopez', 'Melissa Moore'] }],
    }];
    expect(resolveAgentFilterValueBindings('Melissa', ambiguous)).toEqual([]);
  });

  it('does not cross-bind unrelated values', () => {
    expect(resolveAgentFilterValueBindings('Melissa Lopex', [{
      relation: 'dev.products',
      name: 'products',
      columns: [{ name: 'product_name', sampleValues: ['Melissa Tea'] }],
    }])).toEqual([]);
  });
});
