/**
 * ONE answer to "can the next turn lean on this one?".
 *
 * There used to be four, and they disagreed:
 *   - `recordConversationTurn` gated working-state folding on `runStatus`
 *   - `isUsableAnalyticalContextTurn` had its own rule
 *   - `turnIsBlockedContext` excluded only `blocked`
 *   - `renderConversationSnapshot` filtered nothing at all
 *
 * A failed turn passed all four, so its question, its failure text, and its
 * FAILING SQL were replayed into the next prompt, it became the follow-up
 * anchor, and its misparsed contract was folded into the thread's working
 * state. That is the reported "once one answer errors, every later question
 * loops back to the same error".
 *
 * The trap in fixing it: `needs_review` is the run status of every successful
 * UNCERTIFIED generated answer — the majority of Ask answers. Excluding that
 * status wholesale would delete all follow-up context. So trust is derived from
 * ANSWER STATE (did this turn actually produce data?), not from `runStatus`
 * alone.
 */

export type ConversationTurnTrust =
  /** Completed with a result. */
  | 'answered'
  /** Produced a result but is review-required — the normal generated answer. */
  | 'provisional'
  /** Asked the user a question; nothing was resolved. */
  | 'unresolved'
  /** Refused, errored, or produced no data. */
  | 'failed'
  /** Terminally blocked (provider, policy, execution). */
  | 'blocked';

/**
 * The fields trust is computed from. Deliberately structural so it works for a
 * persisted `ConversationTurn`, a `ConversationSnapshotTurn`, and the raw
 * records the provider layer sees.
 */
export interface ConversationTurnTrustInput {
  route?: string;
  runStatus?: string;
  trustLabel?: string;
  stopReason?: string;
  /** Refusal code from the governed answer, when the run refused. */
  refusalCode?: string;
  /** Execution error recorded on the run, when it failed. */
  executionError?: string;
  /** Result shape, when the turn produced one. */
  result?: { columns?: unknown[]; rowCount?: number } | undefined;
  resultColumns?: unknown[];
  resultRowCount?: number;
  /** Prose answer, for turns that legitimately have no result set. */
  answerText?: string;
  answerSummary?: string;
}

/** Refusal codes that mean the turn produced no usable answer. */
const FAILED_REFUSAL_CODES = new Set([
  'grounding_gap',
  'modeling_gap',
  'model_declined',
  'policy_blocked',
  'provider_error',
]);

function hasResult(turn: ConversationTurnTrustInput): boolean {
  const columns = turn.result?.columns ?? turn.resultColumns;
  if (Array.isArray(columns) && columns.length > 0) return true;
  const rowCount = turn.result?.rowCount ?? turn.resultRowCount;
  return typeof rowCount === 'number' && rowCount > 0;
}

export function conversationTurnTrust(turn: ConversationTurnTrustInput): ConversationTurnTrust {
  if (turn.runStatus === 'blocked' || turn.trustLabel === 'blocked' || turn.route === 'blocked') {
    return 'blocked';
  }
  if (turn.runStatus === 'needs_clarification' || turn.route === 'clarify') {
    return 'unresolved';
  }
  // A grounding/modeling gap is a REFUSAL, however gently it is worded. It used
  // to land in `needs_review` — the same bucket as a perfectly good uncertified
  // answer — which is precisely how failures got treated as trustworthy.
  if (turn.refusalCode && FAILED_REFUSAL_CODES.has(turn.refusalCode)) return 'failed';
  if (turn.runStatus === 'no_answer' || turn.stopReason === 'grounding_gap') return 'failed';
  if (typeof turn.executionError === 'string' && turn.executionError.trim().length > 0) return 'failed';

  if (turn.runStatus === 'completed') return hasResult(turn) ? 'answered' : 'provisional';
  if (hasResult(turn)) return 'provisional';
  // No result set is not by itself a failure: definition answers, conversational
  // replies, and business-term lookups legitimately answer in prose. What makes
  // a turn untrustworthy is a refusal or an error, both handled above.
  return hasAnswerText(turn) ? 'provisional' : 'failed';
}

function hasAnswerText(turn: ConversationTurnTrustInput): boolean {
  return Boolean(turn.answerText?.trim() || turn.answerSummary?.trim());
}

/**
 * May the next turn build on this one — carry its filters, reuse its context
 * pack, treat it as the follow-up anchor, see its SQL?
 */
export function isTrustedConversationTurn(turn: ConversationTurnTrustInput): boolean {
  const trust = conversationTurnTrust(turn);
  return trust === 'answered' || trust === 'provisional';
}
