import type { BlockCertificationOperationResult, LocalOperation } from '../../api/client';

export type TaskOutcomeTone = 'active' | 'success' | 'attention' | 'failure' | 'neutral';

export interface TaskOutcomePresentation {
  active: boolean;
  tone: TaskOutcomeTone;
  statusLabel: string;
  message: string;
  guidance?: string;
}

/**
 * Convert transport completion into the business outcome shown to a person.
 * A certification operation can finish successfully while its governed result
 * is still a saved draft with blockers; calling that result "succeeded" or
 * "complete" is misleading even though the background worker did its job.
 */
export function taskOutcomePresentation(operation: LocalOperation): TaskOutcomePresentation {
  const active = operation.status === 'queued' || operation.status === 'running';
  if (active) {
    return {
      active: true,
      tone: 'active',
      statusLabel: operation.status,
      message: operation.message,
      guidance: operation.type === 'block_certification'
        ? 'You can change pages while certification continues.'
        : undefined,
    };
  }

  if (operation.type === 'block_certification' && operation.status === 'succeeded') {
    const result = operation.result as BlockCertificationOperationResult | undefined;
    if (result?.outcome === 'draft_saved_with_blockers') {
      const blockerCount = result.checklist?.issues?.length
        ?? result.blockers?.length
        ?? result.checklist?.blockers.length
        ?? 0;
      return {
        active: false,
        tone: 'attention',
        statusLabel: 'needs attention',
        message: blockerCount > 0
          ? `Draft saved with ${blockerCount} certification blocker${blockerCount === 1 ? '' : 's'}.`
          : 'Draft saved, but certification requirements are not ready.',
        guidance: 'Open Block Studio to review the exact fixes and retry.',
      };
    }
    if (result?.outcome === 'certified') {
      return {
        active: false,
        tone: 'success',
        statusLabel: 'certified',
        message: 'The block passed its required gates and was certified.',
      };
    }
  }

  if (operation.status === 'failed' || operation.status === 'interrupted') {
    return {
      active: false,
      tone: 'failure',
      statusLabel: operation.status,
      message: operation.error?.message ?? operation.message,
      guidance: operation.type === 'block_certification'
        ? 'The saved draft is preserved for review or retry.'
        : undefined,
    };
  }

  if (operation.status === 'cancelled') {
    return {
      active: false,
      tone: 'neutral',
      statusLabel: 'cancelled',
      message: operation.message,
    };
  }

  return {
    active: false,
    tone: operation.status === 'succeeded' ? 'success' : 'neutral',
    statusLabel: operation.status,
    message: operation.error?.message ?? operation.message,
  };
}
