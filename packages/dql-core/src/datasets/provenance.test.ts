import { describe, expect, it } from 'vitest';
import { canonicalize } from '../format/index.js';
import { parse } from '../parser/parser.js';
import { NodeKind } from '../ast/nodes.js';

const provenance = {
  version: 1,
  kind: 'dataset_tile_provenance',
  appId: 'app.commerce',
  pageId: 'overview',
  tileId: 'revenue',
  datasetId: 'dataset:commerce:order-lines',
  sourceRevision: 'sha256:source',
  contractFingerprint: 'sha256:contract',
  query: { dimensions: [], measures: [{ measure: 'revenue' }] },
  queryFingerprint: 'sha256:query',
  filterFingerprint: 'sha256:filters',
  parameterFingerprint: 'sha256:params',
  interactionFingerprint: 'sha256:interactions',
  snapshotFingerprint: 'sha256:snapshot',
  targetFingerprint: 'sha256:target',
  personaPolicyFingerprint: 'sha256:policy',
  receiptId: 'app_run_1',
  sqlFingerprint: 'sha256:sql',
  schemaFingerprint: 'sha256:schema',
  resultFingerprint: 'sha256:result',
  createdAt: '2026-09-11T00:00:00.000Z',
} as const;

describe('Dataset tile block provenance', () => {
  it('round-trips versioned review-draft provenance through parse and format', () => {
    const source = `block "Revenue" {
      domain = "commerce"
      type = "custom"
      status = "draft"
      dataset_tile_provenance = ${JSON.stringify(JSON.stringify(provenance))}
      query = """SELECT SUM(net_amount) AS revenue FROM order_lines"""
    }`;
    const formatted = canonicalize(source);
    const block = parse(formatted).statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind !== NodeKind.BlockDecl) return;
    expect(block.datasetTileProvenance).toEqual(provenance);
    expect(canonicalize(formatted)).toBe(formatted);
  });

  it('rejects malformed provenance instead of retaining untyped metadata', () => {
    expect(() => parse(`block "Revenue" {
      type = "custom"
      dataset_tile_provenance = "{\\"version\\":1}"
      query = """SELECT 1"""
    }`)).toThrow();
  });
});
