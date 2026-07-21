import { describe, expect, it } from 'vitest';
import { normalizeDqlArtifactReference } from './dql-artifact.js';

describe('normalizeDqlArtifactReference', () => {
  it('normalizes generated DQL artifact metadata for handoffs', () => {
    expect(normalizeDqlArtifactReference({
      kind: 'semantic_block',
      source: '  block "revenue" { type = "semantic" }  ',
      name: ' revenue_by_channel ',
      sourcePath: ' semantic/revenue.dql ',
      metrics: [' total_revenue ', '', 42],
      dimensions: [' channel '],
      filters: [{ dimension: ' channel ', operator: ' = ', values: [' Online ', ''] }],
      timeDimension: { name: ' order_date ', granularity: ' month ' },
      orderBy: [{ name: ' total_revenue ', direction: 'desc' }],
      limit: 10.8,
      parameters: [
        { name: 'category', type: 'string', required: false, default: 'Beverage', policy: 'dynamic', binding: { kind: 'semantic_filter', field: 'product_category', operator: 'equals' } },
        { name: 'top_n', type: 'number', required: false, default: 10, policy: 'dynamic', binding: { kind: 'limit' } },
      ],
      parameterValues: { category: 'Beverage', top_n: 10 },
      persistence: 'transient',
      trustState: 'governed',
      compiledSql: ' SELECT 1 ',
      executionReceipt: {
        sourceFingerprint: 'A'.repeat(64),
        compiledSqlFingerprint: 'b'.repeat(64),
        parameterFingerprint: 'c'.repeat(64),
        resultFingerprint: 'd'.repeat(64),
      },
    })).toEqual({
      kind: 'semantic_block',
      source: 'block "revenue" { type = "semantic" }',
      name: 'revenue_by_channel',
      sourcePath: 'semantic/revenue.dql',
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      filters: [{ dimension: 'channel', operator: '=', values: ['Online'] }],
      timeDimension: { name: 'order_date', granularity: 'month' },
      orderBy: [{ name: 'total_revenue', direction: 'desc' }],
      limit: 10,
      parameters: [
        { name: 'category', type: 'string', required: false, default: 'Beverage', policy: 'dynamic', binding: { kind: 'semantic_filter', field: 'product_category', operator: 'equals' } },
        { name: 'top_n', type: 'number', required: false, default: 10, policy: 'dynamic', binding: { kind: 'limit' } },
      ],
      parameterValues: { category: 'Beverage', top_n: 10 },
      persistence: 'transient',
      trustState: 'governed',
      compiledSql: 'SELECT 1',
      executionReceipt: {
        sourceFingerprint: 'a'.repeat(64),
        compiledSqlFingerprint: 'b'.repeat(64),
        parameterFingerprint: 'c'.repeat(64),
        resultFingerprint: 'd'.repeat(64),
      },
    });
  });

  it('rejects artifacts without a supported kind or source', () => {
    expect(normalizeDqlArtifactReference({ kind: 'semantic_block', source: ' ' })).toBeUndefined();
    expect(normalizeDqlArtifactReference({ kind: 'unknown', source: 'block "x" {}' })).toBeUndefined();
    expect(normalizeDqlArtifactReference(null)).toBeUndefined();
  });
});
