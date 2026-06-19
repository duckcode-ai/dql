import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { buildSemanticTree } from './semantic-import.js';

describe('buildSemanticTree', () => {
  it('keeps blank-domain semantic models visible under uncategorized', () => {
    const layer = new SemanticLayer();
    layer.addSemanticModel({
      name: 'orders',
      label: 'Orders',
      description: 'Orders semantic model',
      domain: '',
      table: 'orders',
      entities: [],
      measures: ['order_total'],
      dimensions: ['order_status'],
      timeDimensions: [],
    });
    layer.addMetric({
      name: 'order_total',
      label: 'Order Total',
      description: 'Order total',
      domain: '',
      sql: 'SUM(order_total)',
      type: 'sum',
      table: 'orders',
      tags: [],
    });
    layer.addDimension({
      name: 'order_status',
      label: 'Order Status',
      description: 'Order status',
      domain: '',
      sql: 'order_status',
      type: 'string',
      table: 'orders',
      tags: [],
    });

    const tree = buildSemanticTree(layer, null);
    const uncategorized = tree.children?.find((node) => node.id === 'domain:uncategorized');
    expect(uncategorized).toBeTruthy();
    expect(JSON.stringify(uncategorized)).toContain('Orders');
    expect(JSON.stringify(uncategorized)).toContain('Order Total');
    expect(JSON.stringify(uncategorized)).toContain('Order Status');
  });

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
