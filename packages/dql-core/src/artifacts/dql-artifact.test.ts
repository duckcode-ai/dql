import { describe, expect, it } from 'vitest';
import { normalizeDqlArtifactReference, normalizeDqlExecutableArtifactV1 } from './dql-artifact.js';

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
      source: '  block "revenue" { type = "semantic" }  ',
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

  it('preserves receipt-bound source text exactly, including the final newline', () => {
    const source = 'block "revenue" {\n  type = "semantic"\n}\n';
    expect(normalizeDqlArtifactReference({
      kind: 'semantic_block',
      source,
    })?.source).toBe(source);
  });

  it('normalizes a content-free executable artifact binding', () => {
    const fingerprint = (value: string) => value.repeat(64);
    const receipt = {
      sourceFingerprint: fingerprint('1'),
      compiledSqlFingerprint: fingerprint('2'),
      parameterFingerprint: fingerprint('3'),
      resultFingerprint: fingerprint('4'),
    };
    expect(normalizeDqlExecutableArtifactV1({
      version: 1,
      kind: 'sql_block',
      dqlFingerprint: fingerprint('5'),
      sourceFingerprint: fingerprint('1'),
      compiledSqlFingerprint: fingerprint('2'),
      normalizedSqlFingerprint: fingerprint('6'),
      parameterFingerprint: fingerprint('3'),
      provenanceFingerprint: fingerprint('7'),
      targetFingerprint: fingerprint('8'),
      snapshotFingerprint: fingerprint('9'),
      planFingerprint: 'a'.repeat(64),
      semanticAdapter: 'native',
      previewPolicy: { mode: 'read_only_bounded', rowLimit: 200 },
      trustState: 'review_required',
      receipt,
      rows: [{ secret: 'must not survive' }],
    })).toEqual({
      version: 1,
      kind: 'sql_block',
      dqlFingerprint: fingerprint('5'),
      sourceFingerprint: fingerprint('1'),
      compiledSqlFingerprint: fingerprint('2'),
      normalizedSqlFingerprint: fingerprint('6'),
      parameterFingerprint: fingerprint('3'),
      provenanceFingerprint: fingerprint('7'),
      targetFingerprint: fingerprint('8'),
      snapshotFingerprint: fingerprint('9'),
      planFingerprint: 'a'.repeat(64),
      semanticAdapter: 'native',
      previewPolicy: { mode: 'read_only_bounded', rowLimit: 200 },
      trustState: 'review_required',
      receipt,
    });
  });
});
