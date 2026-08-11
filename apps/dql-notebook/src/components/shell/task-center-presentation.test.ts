import { describe, expect, it } from 'vitest';
import type { LocalOperation } from '../../api/client';
import {
  coalesceBlockCertificationOperations,
  taskCenterProjection,
  taskOutcomePresentation,
} from './task-center-presentation';

function operation(overrides: Partial<LocalOperation> = {}): LocalOperation {
  return {
    id: 'op-1',
    type: 'block_certification',
    scope: 'block:finance/revenue',
    status: 'succeeded',
    phase: 'complete',
    progress: 100,
    message: 'Operation completed.',
    cancellable: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
    ...overrides,
  };
}

describe('taskOutcomePresentation (UI-016)', () => {
  it('does not describe a saved draft with blockers as a successful certification', () => {
    const result = taskOutcomePresentation(operation({
      result: {
        outcome: 'draft_saved_with_blockers',
        oldPath: 'domains/finance/blocks/revenue.dql',
        draftPath: 'domains/finance/blocks/revenue.dql',
        blockers: ['Tests must pass.'],
        checklist: {
          metadata: true,
          validation: true,
          run: true,
          tests: false,
          chart: true,
          lineage: true,
          aiReviewed: false,
          blockers: ['Tests must pass.'],
          issues: [{ severity: 'error', message: 'Expected more than 10 rows.' }],
        },
        block: {} as never,
      },
    }));

    expect(result).toMatchObject({
      tone: 'attention',
      statusLabel: 'needs attention',
      message: 'Draft saved with 1 certification blocker.',
    });
  });

  it('uses certified only for the governed certified outcome', () => {
    const result = taskOutcomePresentation(operation({
      result: {
        outcome: 'certified',
        oldPath: 'draft.dql',
        draftPath: 'draft.dql',
        newPath: 'certified.dql',
        block: {} as never,
      },
    }));

    expect(result).toMatchObject({ tone: 'success', statusLabel: 'certified' });
  });
});

describe('Task Center block certification projection (UI-016)', () => {
  it('hides an older needs-attention result after the same block is certified', () => {
    const olderAttention = certificationOperation({
      id: 'op-attention',
      createdAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:01.000Z',
      outcome: 'draft_saved_with_blockers',
    });
    const newerCertified = certificationOperation({
      id: 'op-certified',
      createdAt: '2026-08-11T12:01:00.000Z',
      updatedAt: '2026-08-11T12:01:01.000Z',
      outcome: 'certified',
      newPath: 'domains/finance/blocks/revenue.dql',
      blockPath: 'domains/finance/blocks/revenue.dql',
    });

    expect(taskCenterProjection([newerCertified, olderAttention])).toMatchObject({
      operations: [{ id: 'op-certified' }],
      activeCount: 0,
      attentionCount: 0,
    });
  });

  it('shows attention when the newer result for the same block has blockers', () => {
    const olderCertified = certificationOperation({
      id: 'op-certified',
      createdAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:01.000Z',
      outcome: 'certified',
      newPath: 'domains/finance/blocks/revenue.dql',
      blockPath: 'domains/finance/blocks/revenue.dql',
    });
    const newerAttention = certificationOperation({
      id: 'op-attention',
      createdAt: '2026-08-11T12:01:00.000Z',
      updatedAt: '2026-08-11T12:01:01.000Z',
      outcome: 'draft_saved_with_blockers',
    });

    expect(taskCenterProjection([newerAttention, olderCertified])).toMatchObject({
      operations: [{ id: 'op-attention' }],
      activeCount: 0,
      attentionCount: 1,
    });
  });

  it('retains failures for different block paths', () => {
    const revenue = operation({
      id: 'op-revenue',
      scope: 'block:domains/finance/blocks/revenue.dql',
      status: 'failed',
      error: { code: 'CERTIFICATION_FAILED', message: 'Revenue failed.', retryable: true },
    });
    const margin = operation({
      id: 'op-margin',
      scope: 'block:domains/finance/blocks/margin.dql',
      status: 'failed',
      error: { code: 'CERTIFICATION_FAILED', message: 'Margin failed.', retryable: true },
    });

    expect(coalesceBlockCertificationOperations([margin, revenue]).map((item) => item.id))
      .toEqual(['op-margin', 'op-revenue']);
    expect(taskCenterProjection([margin, revenue]).operations).toHaveLength(2);
  });

  it('does not group distinct draft artifacts that share import provenance', () => {
    const revenue = certificationOperation({
      id: 'op-revenue',
      blockPath: 'domains/finance/blocks/_drafts/revenue.dql',
      draftPath: 'domains/finance/blocks/_drafts/revenue.dql',
      metadataSourcePath: 'imports/shared-multi-statement.sql',
      outcome: 'draft_saved_with_blockers',
    });
    const margin = certificationOperation({
      id: 'op-margin',
      blockPath: 'domains/finance/blocks/_drafts/margin.dql',
      draftPath: 'domains/finance/blocks/_drafts/margin.dql',
      metadataSourcePath: 'imports/shared-multi-statement.sql',
      outcome: 'draft_saved_with_blockers',
    });

    expect(taskCenterProjection([margin, revenue])).toMatchObject({
      operations: [{ id: 'op-margin' }, { id: 'op-revenue' }],
      attentionCount: 2,
    });
  });

  it('lets a newer active attempt replace the older terminal result for that block', () => {
    const olderAttention = certificationOperation({
      id: 'op-attention',
      createdAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:01.000Z',
      outcome: 'draft_saved_with_blockers',
    });
    const newerActive = operation({
      id: 'op-active',
      scope: 'block:domains/finance/blocks/_drafts/revenue.dql',
      status: 'running',
      phase: 'testing',
      progress: 60,
      createdAt: '2026-08-11T12:01:00.000Z',
      updatedAt: '2026-08-11T12:01:01.000Z',
    });

    expect(taskCenterProjection([newerActive, olderAttention])).toMatchObject({
      operations: [{ id: 'op-active' }],
      activeCount: 1,
      attentionCount: 0,
    });
  });
});

function certificationOperation(input: {
  id: string;
  outcome: 'certified' | 'draft_saved_with_blockers';
  scope?: string;
  blockPath?: string;
  draftPath?: string;
  metadataSourcePath?: string;
  newPath?: string;
  createdAt?: string;
  updatedAt?: string;
}): LocalOperation {
  const draftPath = input.draftPath ?? 'domains/finance/blocks/_drafts/revenue.dql';
  return operation({
    id: input.id,
    scope: input.scope ?? `block:${draftPath}`,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    result: {
      sourcePath: input.metadataSourcePath,
      path: input.metadataSourcePath,
      outcome: input.outcome,
      oldPath: draftPath,
      draftPath,
      newPath: input.newPath,
      blockers: input.outcome === 'draft_saved_with_blockers' ? ['Tests must pass.'] : undefined,
      block: {
        path: input.blockPath ?? draftPath,
        metadata: {
          path: input.blockPath ?? draftPath,
          sourcePath: input.metadataSourcePath,
        },
      },
    },
  });
}
