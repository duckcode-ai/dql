import type { AgentHint } from '../../api/client';

export type AgentHintScopeField = keyof AgentHint['scope'];

export function hintReviewActionLabel(hint: AgentHint): string {
  return hint.evaluation?.status === 'failed' ? 'Rerun checks & approve' : 'Run checks & approve';
}

export function hintGovernanceLabel(hint: AgentHint): string {
  if (hint.exclusions?.some((item) => item.reason === 'superseded')) return 'Superseded — excluded';
  if (hint.exclusions?.some((item) => item.reason === 'conflict')) return 'Conflict — excluded';
  if (hint.inspection?.state && hint.inspection.state !== 'current') return `${hint.inspection.state} — excluded`;
  if (hint.evaluation?.status === 'failed') return 'Evaluation failed';
  return hint.status === 'approved' ? 'Current & applied' : hint.status;
}

export function updateHintScopeField(
  scope: AgentHint['scope'],
  field: AgentHintScopeField,
  rawValue: string,
): AgentHint['scope'] {
  const value = rawValue.trim();
  return { ...scope, [field]: value || undefined };
}

/** Refresh persisted lifecycle truth after both successful and failed mutations. */
export async function runHintMutation<T>(
  mutate: () => Promise<T>,
  refresh: () => Promise<void>,
): Promise<T> {
  try {
    return await mutate();
  } finally {
    await refresh();
  }
}
