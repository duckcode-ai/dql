import {
  composeEffectiveTrust,
  type DataStateLike,
  type ResolvedTrustLabel,
  type TrustLabelId,
} from '@duckcodeailabs/dql-core';

export interface TrustStampableAnswer {
  kind?: string;
  sourceTier?: string;
  certification?: string;
  reviewStatus?: string;
  block?: {
    dataState?: DataStateLike;
  };
}

/**
 * Canonical answer-loop trust mapping. Keep the legacy answer fields as-is, but
 * derive the shared dql-core trust label id from one place so every cascade lane
 * can stamp the same vocabulary at the same exit point.
 */
export function trustLabelIdForAnswer(result: TrustStampableAnswer): TrustLabelId {
  if (result.kind === 'no_answer') return 'insufficient_context';
  if (result.sourceTier === 'business_context' && result.reviewStatus === 'certified') return 'reviewed';
  if (result.certification === 'certified' || result.kind === 'certified') return 'certified';
  if (
    result.certification === 'ai_generated' ||
    result.certification === 'analyst_review_required' ||
    result.reviewStatus === 'analyst_review_required' ||
    result.reviewStatus === 'draft_ready'
  ) {
    return 'ai_generated';
  }
  return 'insufficient_context';
}

export function stampTrustLabel(result: TrustStampableAnswer): ResolvedTrustLabel {
  const id = trustLabelIdForAnswer(result);
  const dataState = id === 'certified' ? result.block?.dataState : undefined;
  return composeEffectiveTrust({ id, dataState });
}
