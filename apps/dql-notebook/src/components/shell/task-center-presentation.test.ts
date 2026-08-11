import { describe, expect, it } from 'vitest';
import type { LocalOperation } from '../../api/client';
import { taskOutcomePresentation } from './task-center-presentation';

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
