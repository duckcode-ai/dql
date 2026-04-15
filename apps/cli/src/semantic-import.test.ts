import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { buildSemanticTree } from './semantic-import.js';

describe('buildSemanticTree', () => {
  it('creates unique group ids for repeated labels across cubes and domains', () => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'customers',
      label: 'Customers',
      description: 'Customers cube',
      domain: 'uncategorized',
      table: 'customers',
      sql: 'SELECT * FROM customers',
      tags: [],
      measures: [
        {
          name: 'lifetime_spend',
          label: 'Lifetime Spend',
          description: 'Lifetime spend',
          domain: 'uncategorized',
          sql: 'SUM(lifetime_spend)',
          type: 'sum',
          table: 'customers',
          tags: [],
        },
      ],
      dimensions: [
        {
          name: 'customer_type',
          label: 'Customer Type',
          description: 'Customer type',
          domain: 'uncategorized',
          sql: 'customer_type',
          type: 'string',
          table: 'customers',
          tags: [],
        },
      ],
      timeDimensions: [],
      joins: [],
      segments: [],
      preAggregations: [],
    });
    layer.addCube({
      name: 'orders',
      label: 'Orders',
      description: 'Orders cube',
      domain: 'uncategorized',
      table: 'orders',
      sql: 'SELECT * FROM orders',
      tags: [],
      measures: [
        {
          name: 'order_total',
          label: 'Order Total',
          description: 'Order total',
          domain: 'uncategorized',
          sql: 'SUM(order_total)',
          type: 'sum',
          table: 'orders',
          tags: [],
        },
      ],
      dimensions: [
        {
          name: 'ordered_at',
          label: 'Ordered At',
          description: 'Ordered at',
          domain: 'uncategorized',
          sql: 'ordered_at',
          type: 'date',
          table: 'orders',
          tags: [],
        },
      ],
      timeDimensions: [],
      joins: [],
      segments: [],
      preAggregations: [],
    });

    const tree = buildSemanticTree(layer, null);
    const groupIds: string[] = [];

    const visit = (node: { id: string; kind: string; children?: any[] }) => {
      if (node.kind === 'group') groupIds.push(node.id);
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);

    expect(new Set(groupIds).size).toBe(groupIds.length);
    expect(groupIds.some((id) => id.includes('cube:customers'))).toBe(true);
    expect(groupIds.some((id) => id.includes('cube:orders'))).toBe(true);
  });
});
