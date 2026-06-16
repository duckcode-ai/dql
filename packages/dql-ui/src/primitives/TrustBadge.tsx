// Shared trust-state badge for notebook, App, and review surfaces.

import React from 'react';
import { StatusPill } from './PanelFrame.js';

export type TrustState =
  | 'draft'
  | 'pending'
  | 'review'
  | 'certified'
  | 'deprecated'
  | 'ai_generated'
  | 'uncertified'
  | 'no_answer';

export interface TrustBadgeProps {
  state?: TrustState;
  label?: React.ReactNode;
}

export function TrustBadge({ state, label }: TrustBadgeProps) {
  if (!state) return null;

  const config = TRUST_BADGE_CONFIG[state] ?? TRUST_BADGE_CONFIG.draft;
  return <StatusPill tone={config.tone}>{label ?? config.label}</StatusPill>;
}

const TRUST_BADGE_CONFIG: Record<TrustState, { tone: React.ComponentProps<typeof StatusPill>['tone']; label: string }> = {
  certified: { tone: 'success', label: 'Certified' },
  draft: { tone: 'warning', label: 'Draft' },
  pending: { tone: 'warning', label: 'Pending review' },
  review: { tone: 'warning', label: 'Review' },
  ai_generated: { tone: 'warning', label: 'AI draft' },
  uncertified: { tone: 'warning', label: 'Uncertified' },
  deprecated: { tone: 'neutral', label: 'Deprecated' },
  no_answer: { tone: 'error', label: 'No answer' },
};
