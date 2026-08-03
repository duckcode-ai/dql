import { describe, expect, it } from 'vitest';
import {
  resolveAgentFilterValueBindings,
  schemaContextWithAllowedSqlContext,
  type AgentSchemaTable,
} from './answer-loop.js';

const schema: AgentSchemaTable[] = [{
  relation: 'dev.customers',
  name: 'customers',
  columns: [
    { name: 'customer_name', type: 'VARCHAR', sampleValues: ['Melissa Lopez'] },
    { name: 'customer_type', type: 'VARCHAR', sampleValues: ['returning'] },
  ],
}];

describe('stored data-value resolution', () => {
  it('does not reintroduce stale context-pack columns after a complete live schema lookup', () => {
    const merged = schemaContextWithAllowedSqlContext([{
      relation: 'jaffle_shop.main.dim_customers',
      name: 'dim_customers',
      source: 'dbt metadata verified against live runtime schema',
      columnCompleteness: 'complete',
      columns: [
        { name: 'customer_id', type: 'VARCHAR' },
        { name: 'name', type: 'VARCHAR' },
      ],
    }], {
      allowedSqlContext: {
        relations: [{
          relation: 'jaffle_shop.main.dim_customers',
          name: 'dim_customers',
          source: 'dbt manifest',
          columns: [
            { name: 'customer_id', description: 'Customer key' },
            { name: 'customer_name', description: 'Stale declared name' },
          ],
        }],
      },
      retrievalDiagnostics: {},
    } as never);

    expect(merged[0]?.columns.map((column) => column.name)).toEqual(['customer_id', 'name']);
    expect(merged[0]?.columns[0]?.description).toBe('Customer key');
  });

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
