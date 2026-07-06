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
    });
  });

  it('rejects artifacts without a supported kind or source', () => {
    expect(normalizeDqlArtifactReference({ kind: 'semantic_block', source: ' ' })).toBeUndefined();
    expect(normalizeDqlArtifactReference({ kind: 'unknown', source: 'block "x" {}' })).toBeUndefined();
    expect(normalizeDqlArtifactReference(null)).toBeUndefined();
  });
});
