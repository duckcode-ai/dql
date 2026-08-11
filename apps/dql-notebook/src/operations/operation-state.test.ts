import { describe, expect, it } from 'vitest';
import type { LocalOperation } from '../api/client';
import {
  blockCertificationOperationsForReconciliation,
  listedNonterminalOperationIds,
  mergeOperation,
  mergeOperationLists,
  newestMatchingBlockCertificationOperation,
  preferredOperation,
  recoverTrackedOperationsById,
  seedListedNonterminalOperationIds,
} from './operation-state';

describe('durable local operation state', () => {
  it('keeps SSE success when the original POST running response arrives later', () => {
    const succeeded = operation({
      status: 'succeeded',
      phase: 'complete',
      progress: 100,
      updatedAt: '2026-08-11T12:00:02.000Z',
      result: { outcome: 'certified' },
    });
    const stalePost = operation({
      status: 'running',
      phase: 'validating',
      progress: 15,
      updatedAt: '2026-08-11T12:00:01.000Z',
    });

    expect(mergeOperation([succeeded], stalePost)[0]).toBe(succeeded);
  });

  it('rejects stale updates and resolves same-time ties by terminal state then progress', () => {
    const current = operation({ progress: 60, updatedAt: '2026-08-11T12:00:02.000Z' });
    expect(preferredOperation(current, operation({ progress: 90, updatedAt: '2026-08-11T12:00:01.000Z' }))).toBe(current);

    const sameTimeTerminal = operation({ status: 'failed', progress: 60, updatedAt: current.updatedAt });
    expect(preferredOperation(current, sameTimeTerminal)).toBe(sameTimeTerminal);
    expect(preferredOperation(current, operation({ progress: 75, updatedAt: current.updatedAt })).progress).toBe(75);
  });

  it('recovers the newest matching certification by scope, result path, or resource revision', () => {
    const older = operation({
      id: 'op-old',
      scope: 'block:domains/finance/blocks/_drafts/revenue.dql',
      updatedAt: '2026-08-11T12:00:01.000Z',
    });
    const newest = operation({
      id: 'op-new',
      status: 'succeeded',
      updatedAt: '2026-08-11T12:00:03.000Z',
      resourceRevision: 'fingerprint-1:1723399200000',
      result: {
        oldPath: 'domains/finance/blocks/_drafts/revenue.dql',
        draftPath: 'domains/finance/blocks/_drafts/revenue.dql',
        newPath: 'domains/finance/blocks/revenue.dql',
      },
    });

    expect(newestMatchingBlockCertificationOperation([older, newest], {
      activePath: 'domains/finance/blocks/revenue.dql',
    })?.id).toBe('op-new');
    expect(newestMatchingBlockCertificationOperation([older, newest], {
      sourceFingerprint: 'fingerprint-1',
    })?.id).toBe('op-new');
    expect(newestMatchingBlockCertificationOperation([older, newest], {
      operationId: 'op-old',
      activePath: 'domains/finance/blocks/revenue.dql',
      sourceFingerprint: 'fingerprint-1',
    })?.id).toBe('op-old');
  });

  it('replays terminal block results chronologically so the newest state is final', () => {
    const older = operation({
      id: 'op-old',
      status: 'succeeded',
      updatedAt: '2026-08-11T12:00:02.000Z',
      result: { outcome: 'draft_saved_with_blockers', block: { path: 'blocks/_drafts/revenue.dql' } },
    });
    const newer = operation({
      id: 'op-new',
      status: 'succeeded',
      updatedAt: '2026-08-11T12:00:04.000Z',
      result: { outcome: 'certified', block: { path: 'blocks/revenue.dql' } },
    });

    expect(blockCertificationOperationsForReconciliation([newer, older]).map((item) => item.id))
      .toEqual(['op-old', 'op-new']);
    expect(blockCertificationOperationsForReconciliation([newer, older], new Set(['op-old'])).map((item) => item.id))
      .toEqual(['op-new']);
  });

  it('restores exact-id tracking from every listed nonterminal operation on remount', () => {
    expect(listedNonterminalOperationIds([
      operation({ id: 'queued', status: 'queued' }),
      operation({ id: 'running', status: 'running' }),
      operation({ id: 'complete', status: 'succeeded' }),
      operation({ id: 'failed', status: 'failed' }),
    ])).toEqual(['queued', 'running']);
  });

  it('retains and exactly polls an older active certification beyond 50 newer terminal results', async () => {
    const olderActive = operation({
      id: 'older-active',
      status: 'running',
      updatedAt: '2026-08-11T12:00:01.000Z',
    });
    const terminals = Array.from({ length: 55 }, (_, index) => operation({
      id: `terminal-${index}`,
      status: 'succeeded',
      progress: 100,
      updatedAt: new Date(Date.UTC(2026, 7, 11, 12, 1, index)).toISOString(),
    }));
    const listed = mergeOperationLists([], [...terminals, olderActive]);

    expect(listed).toHaveLength(51);
    expect(listed.filter(isTerminal)).toHaveLength(50);
    expect(listed).toContainEqual(olderActive);

    const tracked = new Set<string>();
    seedListedNonterminalOperationIds(tracked, listed);
    expect([...tracked]).toEqual(['older-active']);

    const requested: string[] = [];
    await recoverTrackedOperationsById(
      tracked,
      async (operationId) => {
        requested.push(operationId);
        return { ...olderActive, status: 'succeeded', progress: 100 };
      },
      () => true,
    );
    expect(requested).toEqual(['older-active']);
    expect(tracked.size).toBe(0);
  });
});

function isTerminal(item: LocalOperation): boolean {
  return !['queued', 'running'].includes(item.status);
}

function operation(overrides: Partial<LocalOperation> = {}): LocalOperation {
  return {
    id: 'op-1',
    type: 'block_certification',
    scope: 'block:domains/finance/blocks/_drafts/revenue.dql',
    status: 'running',
    phase: 'previewing',
    progress: 40,
    message: 'Working.',
    cancellable: true,
    createdAt: '2026-08-11T12:00:00.000Z',
    updatedAt: '2026-08-11T12:00:01.000Z',
    ...overrides,
  };
}
