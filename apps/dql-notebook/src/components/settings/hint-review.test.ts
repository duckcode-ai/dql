import { describe, expect, it, vi } from 'vitest';
import type { AgentHint } from '../../api/client';
import {
  hintReviewActionLabel,
  runHintMutation,
  updateHintScopeField,
} from './hint-review';

function hint(overrides: Partial<AgentHint> = {}): AgentHint {
  return {
    id: 'hint-1',
    title: 'Correction',
    guidance: 'Use the governed relation.',
    status: 'candidate',
    scope: { dbtModel: 'orders', domain: 'commerce' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('governed hint review model', () => {
  it('shows failed evaluations as explicitly retryable', () => {
    expect(hintReviewActionLabel(hint({
      evaluation: {
        id: 'evaluation-1',
        status: 'failed',
        evaluation: 'correction',
        evaluator: 'analyst',
        checks: [],
        evidence: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }))).toBe('Rerun checks & approve');
  });

  it('keeps scope fields independent when an analyst edits one value', () => {
    const initial = hint().scope;
    expect(updateHintScopeField(initial, 'domain', 'finance')).toEqual({
      dbtModel: 'orders',
      domain: 'finance',
    });
    expect(updateHintScopeField(initial, 'metric', ' order_count ')).toEqual({
      dbtModel: 'orders',
      domain: 'commerce',
      metric: 'order_count',
    });
  });

  it('refreshes persisted lifecycle truth after a failed review', async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(runHintMutation(
      async () => { throw new Error('evaluation failed'); },
      refresh,
    )).rejects.toThrow('evaluation failed');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
