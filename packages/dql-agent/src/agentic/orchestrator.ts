/**
 * The strangler seam.
 *
 * `answer-loop.ts` grew from 4,532 to 10,105 lines over 300 commits because
 * every fix had to land inside it — 12% of all commits in that window touched
 * that one file. New behaviour only stops accreting there once it has somewhere
 * else to go WHILE the old path keeps serving.
 *
 * `answerAgentic` has the same signature as `answer`, so the two are
 * interchangeable at a single call site. Which one runs is a per-lane config
 * decision, and the default is legacy: this file is a migration control, not a
 * release.
 */
import type { AgentAnswer, AnswerLoopInput } from '../answer-loop.js';
import {
  laneUsesAgenticOrchestrator,
  type AgenticLane,
  type OrchestratorPolicy,
} from './orchestrator-policy.js';

/** The legacy loop, injected so this module never imports the 10k-line file's runtime. */
export type LegacyAnswerFn = (input: AnswerLoopInput) => Promise<AgentAnswer>;

/** The agentic path for one lane. Absent lanes fall through to legacy. */
export type AgenticLaneHandler = (input: AnswerLoopInput) => Promise<AgentAnswer>;

export interface AnswerAgenticOptions {
  policy: OrchestratorPolicy;
  /** Which lane this turn belongs to, decided by triage before dispatch. */
  lane: AgenticLane;
  legacy: LegacyAnswerFn;
  /** Registered agentic handlers. A lane enabled with no handler falls back. */
  handlers?: Partial<Record<AgenticLane, AgenticLaneHandler>>;
  /** Non-fatal diagnostics, so a silent fallback cannot hide a broken lane. */
  onDiagnostic?: (event: OrchestratorDiagnostic) => void;
}

export interface OrchestratorDiagnostic {
  kind: 'fallback' | 'dispatch';
  lane: AgenticLane;
  mode: OrchestratorPolicy['mode'];
  reason?: string;
}

/** Marker appended to the answer's route evidence when the agentic path bailed. */
export const ORCHESTRATOR_FALLBACK_STEP = 'orchestrator_fallback';

/**
 * Route one turn to the agentic loop or the legacy answer loop.
 *
 * Fallback is RECORDED on the answer's evidence rather than swallowed. A
 * silently-degrading migration looks exactly like a working one until someone
 * notices the new path never actually ran, so `orchestratorFallbackRate` has to
 * be observable from the run itself.
 */
export async function answerAgentic(
  input: AnswerLoopInput,
  options: AnswerAgenticOptions,
): Promise<AgentAnswer> {
  const { policy, lane, legacy, handlers, onDiagnostic } = options;
  const handler = handlers?.[lane];

  if (!laneUsesAgenticOrchestrator(policy, lane) || !handler) {
    return legacy(input);
  }

  onDiagnostic?.({ kind: 'dispatch', lane, mode: policy.mode });
  try {
    return await handler(input);
  } catch (error) {
    // A cancellation is the user's decision, not a lane failure: re-running the
    // legacy loop would ignore an abort the caller already made.
    if (isCancellation(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    onDiagnostic?.({ kind: 'fallback', lane, mode: policy.mode, reason });
    if (!policy.fallbackOnError) throw error;
    const answer = await legacy(input);
    return withFallbackEvidence(answer, lane, reason);
  }
}

function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'CancellationError';
}

/**
 * Stamp the fallback onto the answer's route evidence.
 *
 * Prepended, not appended: the first thing a reader of the trace should see is
 * that this answer did not come from the path the config selected.
 */
export function withFallbackEvidence(answer: AgentAnswer, lane: AgenticLane, reason: string): AgentAnswer {
  const evidence = answer.evidence;
  if (!evidence) return answer;
  return {
    ...answer,
    evidence: {
      ...evidence,
      route: [
        {
          tool: ORCHESTRATOR_FALLBACK_STEP,
          status: 'failed' as const,
          label: `Agentic orchestration fell back to the legacy answer loop (${lane})`,
          detail: reason,
        },
        ...(evidence.route ?? []),
      ],
    },
  };
}
