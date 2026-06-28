// Spec 14 — tiny event bus for the front-door "Ask AI to build a block"
// entry points. The Build surface lives in two places:
//   • the Notebook AI drawer (an in-panel Ask/Build toggle), and
//   • a shared AiBuildDialog mounted once at the app-shell level so the
//     front doors in views that are NOT the notebook (Get Started / Block
//     Studio) can open Build without each owning a drawer.
//
// Front doors call `openAiBuild({ target, prompt?, context? })`; the shared
// dialog subscribes via `subscribeAiBuild`. Decoupling through a bus avoids
// threading a callback through every intermediate view/store.

import type { AiBuildTarget, AiBuildMode } from '../store/types';

export interface AiBuildLaunchRequest {
  target: AiBuildTarget;
  /** Lock the target toggle when the door has a fixed intent (e.g. block). */
  lockTarget?: boolean;
  /** Optional pre-filled prompt (e.g. "Refine ‹model›" from a proposal row). */
  prompt?: string;
  /** Optional context handed to the build. */
  context?: { cellSql?: string; selection?: string };
  /** Human label for the surface that opened it (shown in the dialog header). */
  sourceLabel?: string;
  // ── Spec 17 (part A) — open straight into "Modify existing block" ──────────
  /** 'edit' rewrites the block at `blockPath`; 'create' (default) makes new. */
  mode?: AiBuildMode;
  /** The block path to modify, when `mode: 'edit'`. */
  blockPath?: string;
}

const EVENT = 'dql:ai-build-open';

export function openAiBuild(request: AiBuildLaunchRequest): void {
  window.dispatchEvent(new CustomEvent<AiBuildLaunchRequest>(EVENT, { detail: request }));
}

export function subscribeAiBuild(handler: (request: AiBuildLaunchRequest) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<AiBuildLaunchRequest>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
