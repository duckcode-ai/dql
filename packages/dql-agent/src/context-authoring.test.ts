import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContextAuthoringProposal,
  contextAuthoringDependencyClosure,
  FileContextAuthoringProposalStore,
} from './context-authoring.js';

describe('context authoring proposals', () => {
  const operations = [
    {
      id: 'entity:orders',
      kind: 'modeling_change' as const,
      change: { operation: 'upsert_entity' as const, value: { id: 'orders', domain: 'commerce', areaId: 'orders', dbtModel: 'model.shop.orders' } },
    },
    {
      id: 'entity:customers',
      kind: 'modeling_change' as const,
      change: { operation: 'upsert_entity' as const, value: { id: 'customers', domain: 'commerce', areaId: 'orders', dbtModel: 'model.shop.customers' } },
    },
    {
      id: 'relationship:orders_to_customers',
      kind: 'modeling_change' as const,
      dependsOn: ['entity:orders', 'entity:customers'],
      change: {
        operation: 'upsert_relationship' as const,
        value: { id: 'orders_to_customers', domain: 'commerce', areaId: 'orders', from: 'orders', to: 'customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one' as const, fanout: 'unknown' as const, status: 'draft' as const },
      },
    },
  ];

  it('expands selected changes to their exact dependency closure', () => {
    expect(contextAuthoringDependencyClosure(operations, ['relationship:orders_to_customers']).map((operation) => operation.id)).toEqual([
      'entity:orders',
      'entity:customers',
      'relationship:orders_to_customers',
    ]);
  });

  it('hashes the complete immutable review payload', () => {
    const first = buildContextAuthoringProposal({
      origin: 'ai',
      baseSnapshotId: 'snapshot-1',
      dependencyFingerprints: { manifest: 'abc' },
      operations,
      patches: [],
      diagnostics: [],
    });
    const second = buildContextAuthoringProposal({
      ...first,
      id: first.id,
      createdAt: first.createdAt,
      baseSnapshotId: 'snapshot-2',
    });
    expect(first.trustState).toBe('review_required');
    expect(first.proposalHash).not.toBe(second.proposalHash);
  });

  it('persists idempotency receipts across store instances', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-context-proposal-'));
    const first = new FileContextAuthoringProposalStore(root);
    first.saveCommitReceipt('stable-request', { proposalId: 'proposal-1', proposalHash: 'hash-1', snapshotId: 'snapshot-2' });
    expect(new FileContextAuthoringProposalStore(root).getCommitReceipt('stable-request')).toEqual({
      proposalId: 'proposal-1',
      proposalHash: 'hash-1',
      snapshotId: 'snapshot-2',
    });
    expect(first.getCommitReceipt('another-request')).toBeUndefined();
  });
});
