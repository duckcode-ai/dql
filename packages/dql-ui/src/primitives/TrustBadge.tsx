// v1.3 Track 4 — TrustBadge primitive (v1.4 plug slot).
//
// Ships as an empty-by-default slot so CellChrome (Track 6) has a stable
// DOM hook for v1.4's trust-state feature (draft/pending/certified/
// deprecated). In v1.3, only `certified` renders — matching current
// behavior where bound blocks show "certified" chrome. `undefined` and
// `draft`/`pending`/`deprecated` return null.

import React from 'react';
import { StatusPill } from './PanelFrame.js';

export type TrustState = 'draft' | 'pending' | 'certified' | 'deprecated';

export interface TrustBadgeProps {
  state?: TrustState;
  label?: React.ReactNode;
}

export function TrustBadge({ state, label }: TrustBadgeProps) {
  if (!state) return null;

  if (state === 'certified') {
    return <StatusPill tone="success">{label ?? 'Certified'}</StatusPill>;
  }

  // v1.4 will light these up. v1.3 keeps them null so the slot exists
  // structurally without implying a feature we haven't shipped yet.
  return null;
}
