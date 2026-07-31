/**
 * Conversation snapshot: the bounded, structured view of a thread that every
 * question carries into the answer loop — working state + rolling summary +
 * a few verbatim recent turns + how the new question relates to the topic.
 */

import type { ConversationStore, ConversationTurn } from './session-store.js';
import type { AgentDqlArtifactReference } from '../answer-loop.js';
import type { CascadeAnswerResult } from '../cascade/cascade.js';
import type { KnowledgeLens } from '../domain-context.js';
import {
  parseWorkingState,
  reduceWorkingState,
  type ConversationWorkingState,
  type TopicRelation,
} from './working-state.js';
import {
  renderStructuredConversationSummary,
  updateRollingSummary,
  updateStructuredConversationSummary,
  type ConversationSummaryV1,
} from './rolling-summary.js';
import { isTrustedConversationTurn } from './turn-trust.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';
import { envEmbeddingProvider, hybridRank } from '../embeddings/provider.js';

const RECENT_TURNS = 4;

export interface ConversationSnapshotTurn {
  id: string;
  question: string;
  answerSummary?: string;
  route?: string;
  trustLabel?: string;
  runStatus?: string;
  stopReason?: string;
  /** Carried so trust can be computed without re-reading the run. */
  refusalCode?: string;
  executionError?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  knowledgeLens?: KnowledgeLens;
  resultColumns?: string[];
  resultRowCount?: number;
  resultDimensionValues?: Record<string, string[]>;
  sourceSql?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
}

export interface ConversationEnvelopeV1 {
  /** Present on every newly built envelope; optional only for persisted v0 compatibility. */
  version?: 1;
  threadId: string;
  /** Present on every newly built envelope; optional only for persisted v0 compatibility. */
  surface?: string;
  rollingSummary?: string;
  /** Trust-aware, source-attributed summary of turns outside the recent window. */
  structuredSummary?: ConversationSummaryV1;
  workingState?: ConversationWorkingState;
  recentTurns: ConversationSnapshotTurn[];
  /** Semantic-recall hits over older turns (P5). */
  recalledTurns?: ConversationSnapshotTurn[];
  /** How the NEW question relates to the ongoing topic (when a question is supplied). */
  topicRelation?: TopicRelation;
  /** Latest clarification that is still the current turn. */
  /**
   * The clarification the last turn asked, and the analytical question it was
   * asked ABOUT. Both are needed: replying "by region" only makes sense
   * alongside the original request, and the engine has to restore that pairing
   * or the reply runs context-free and gets clarified again.
   */
  pendingClarification?: {
    sourceTurnId: string;
    /** The clarifying question DQL asked. */
    question: string;
    /** The user's original analytical question that triggered it. */
    sourceQuestion?: string;
  };
}

/** Compatibility name retained for existing API/provider consumers. */
export type ConversationSnapshot = ConversationEnvelopeV1;

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

const STANDALONE_QUESTION_START_RE =
  /^(?:who|what|why|where|when|how|show|give|list|compare|build|create|which|calculate|find|tell)\b/i;

/**
 * A pending clarification is deliberately one-shot. Only a short, incomplete
 * value/choice should bind to it; a complete analytical request starts a fresh
 * turn even when the previous turn asked for clarification.
 */
export function isLikelyClarificationReply(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const words = normalized.split(' ').filter(Boolean);
  if (words.length > 40) return false;
  if (words.length >= 4 && STANDALONE_QUESTION_START_RE.test(normalized)) return false;
  if (words.length >= 7 && /\?\s*$/.test(normalized)) return false;

  // Compact analytical phrases such as "revenue by region" are complete Ask
  // turns even without a verb or question mark. A terse choice such as
  // "by region", "last quarter", or "use order date" remains a clarification.
  if (words.length >= 3) {
    const plan = buildAnalysisQuestionPlan(normalized);
    const hasMeasure = plan.metricTerms.length > 0;
    const hasSubject = plan.entities.length > 0 || plan.dimensionTerms.length > 0;
    if ((hasMeasure && hasSubject) || plan.entities.length >= 2) return false;
  }
  return true;
}

/**
 * Build the snapshot for a new question. When the question starts a genuinely
 * new topic (shift), the carried filters are deterministically cleared in the
 * snapshot — stale-context protection that doesn't rely on the model.
 */
export function buildConversationSnapshot(
  store: ConversationStore,
  threadId: string,
  options: { question?: string; recent?: number } = {},
): ConversationSnapshot | null {
  const thread = store.getThread(threadId);
  if (!thread) return null;
  const recent = store.recentTurns(threadId, options.recent ?? RECENT_TURNS);
  let workingState = parseWorkingState(thread.workingState);
  let topicRelation: TopicRelation | undefined;
  if (options.question && workingState.topicKey) {
    topicRelation = classifyQuestionRelation(workingState, options.question);
    if (topicRelation === 'shift') {
      // A new topic clears the WHOLE carried shape, not just the filters.
      // Leaving `topicKey`, entities, measures, dimensions and the prior result
      // columns in place meant a genuinely new question was still rendered under
      // "active topic: <the old one>" with the old measures and dimensions
      // attached — the reported "when I ask a different question it doesn't give
      // the right solution". `reduceWorkingState` already clears these on shift;
      // this path only cleared `filters`.
      workingState = {
        ...workingState,
        filters: [],
        entities: [],
        measures: [],
        dimensions: [],
        topicKey: undefined,
        timeframe: undefined,
        limit: undefined,
        sourceCertifiedBlock: undefined,
        lastResultColumns: undefined,
        lastResultDimensionValues: undefined,
      };
    }
  }
  const latest = recent[recent.length - 1];
  const latestNeedsClarification = Boolean(
    latest && (latest.route === 'clarify' || latest.runStatus === 'needs_clarification'),
  );
  const carryPendingClarification = latestNeedsClarification
    && (!options.question || isLikelyClarificationReply(options.question));
  return {
    version: 1,
    threadId,
    surface: thread.surface,
    rollingSummary: thread.rollingSummary,
    structuredSummary: thread.structuredSummary,
    workingState: hasWorkingState(workingState) ? workingState : undefined,
    recentTurns: recent.map(snapshotTurn),
    topicRelation,
    pendingClarification: latest && carryPendingClarification
      ? {
          sourceTurnId: latest.id,
          question: latest.answerSummary ?? latest.answerText ?? latest.question,
          // Walk back past any intermediate short replies to the last real
          // analytical question, so a repeated clarify chain still recovers the
          // request rather than a terse "yes".
          sourceQuestion: analyticalQuestionBefore(recent, recent.length - 1),
        }
      : undefined,
  };
}

/**
 * Walk back from `index` to the last turn whose question is a real analytical
 * request rather than a clarification reply. A repeated clarify chain
 * (original question → "yes" → clarify again) must recover the ORIGINAL
 * request; returning the intermediate "yes" is how the loop kept restarting
 * from a context-free word.
 */
function analyticalQuestionBefore(turns: ConversationTurn[], index: number): string | undefined {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const question = turns[cursor]?.question?.trim();
    if (question && !isLikelyClarificationReply(question)) return question;
  }
  return turns[Math.max(0, index)]?.question?.trim() || undefined;
}

/**
 * Post-run maintenance: fold the appended turn into the thread's working state
 * and compact turns that just left the recent window into the rolling summary.
 * Incremental and idempotent (cursor = summaryTurnSeq); never throws.
 */
export function advanceThreadState(store: ConversationStore, threadId: string, turn: ConversationTurn): void {
  try {
    const thread = store.getThread(threadId);
    if (!thread) return;
    const { state } = reduceWorkingState(parseWorkingState(thread.workingState), turn);
    // Compact everything older than the recent verbatim window.
    const compactBefore = Math.max(turn.seq - RECENT_TURNS + 1, 1);
    const compactable = thread.summaryTurnSeq < compactBefore - 1
      ? store.turnsForCompaction(threadId, thread.summaryTurnSeq, compactBefore)
      : [];
    const rollingSummary = compactable.length > 0
      ? updateRollingSummary({ previousSummary: thread.rollingSummary, compactedTurns: compactable })
      : thread.rollingSummary;
    const structuredSummary = compactable.length > 0
      ? updateStructuredConversationSummary({
          previousSummary: thread.structuredSummary,
          compactedTurns: compactable,
        })
      : thread.structuredSummary;
    store.updateThreadState(threadId, {
      workingState: state as unknown as Record<string, unknown>,
      rollingSummary,
      ...(structuredSummary ? { structuredSummary } : {}),
      summaryTurnSeq: compactable.length > 0
        ? compactable[compactable.length - 1].seq
        : thread.summaryTurnSeq,
    });
  } catch {
    // Advisory maintenance — never fail the run for it.
  }
}

/**
 * Semantic recall over the thread's OLDER turns ("what did we discuss about X?").
 * FTS candidates are re-ranked with the configured project embedding provider
 * (and the deterministic local fallback when no provider is configured).
 * Turns already in the recent verbatim window are excluded; returns at most
 * `limit` hits. Never throws.
 */
export async function recallRelevantTurns(
  store: ConversationStore,
  threadId: string,
  question: string,
  options: { limit?: number; excludeTurnIds?: string[] } = {},
): Promise<ConversationSnapshotTurn[]> {
  try {
    const excluded = new Set(options.excludeTurnIds ?? []);
    const candidates = store.searchTurns({ query: question, threadId, limit: 24 })
      .filter((turn) => !excluded.has(turn.id))
      .filter((turn) => isUsableAnalyticalContextTurn(snapshotTurn(turn)));
    if (candidates.length === 0) return [];
    const ranked = await hybridRank(
      question,
      candidates.map((turn, index) => ({
        item: turn,
        // FTS returns rank-ordered rows; convert position to a [0,1] score.
        ftsScore: 1 - index / candidates.length,
        text: `${turn.question} ${turn.answerSummary ?? ''}`,
      })),
      { alpha: 0.4, provider: envEmbeddingProvider() },
    );
    return ranked.slice(0, options.limit ?? 3).map((entry) => snapshotTurn(entry.item));
  } catch {
    return [];
  }
}

/** Read the canonical server envelope while accepting the original key during upgrades. */
export function conversationEnvelopeFromContext(
  context: Record<string, unknown> | undefined,
): ConversationEnvelopeV1 | undefined {
  if (!context) return undefined;
  const raw = context.conversationEnvelope ?? context.serverSnapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const envelope = raw as Partial<ConversationEnvelopeV1>;
  if (typeof envelope.threadId !== 'string' || !Array.isArray(envelope.recentTurns)) return undefined;
  return {
    ...envelope,
    version: 1,
    surface: typeof envelope.surface === 'string' ? envelope.surface : 'agent',
    threadId: envelope.threadId,
    recentTurns: envelope.recentTurns,
  } as ConversationEnvelopeV1;
}

/**
 * One bounded history projection for routing, meaning resolution, planning and
 * execution fallbacks. Review/blocked state is explicit so prose cannot silently
 * become trusted analytical context.
 */
export function conversationHistoryFromContext(
  context: Record<string, unknown> | undefined,
  limit = 6,
): ConversationHistoryMessage[] {
  const envelope = conversationEnvelopeFromContext(context);
  if (!envelope) return [];
  return envelope.recentTurns
    .filter(isUsableAnalyticalContextTurn)
    .slice(-Math.max(1, limit))
    .flatMap((turn) => {
      const answer = turn.answerSummary?.trim();
      return [
        { role: 'user' as const, text: turn.question },
        ...(answer
          ? [{
              role: 'assistant' as const,
              text: `[${conversationTurnContextState(turn)}] ${answer}`,
            }]
          : []),
      ];
    });
}

/** Compact non-prose context shared by every orchestration stage. */
export function renderConversationEnvelopeForPrompt(
  context: Record<string, unknown> | undefined,
): string | undefined {
  const envelope = conversationEnvelopeFromContext(context);
  if (!envelope) return undefined;
  const state = envelope.workingState
    ? parseWorkingState(envelope.workingState as unknown as Record<string, unknown>)
    : undefined;
  const summary = renderStructuredConversationSummary(envelope.structuredSummary)
    ?? envelope.rollingSummary;
  const stateLines = state
    ? [
        state.topicKey ? `active topic: ${state.topicKey}` : '',
        state.entities.length ? `entities: ${state.entities.join(', ')}` : '',
        state.measures.length ? `measures: ${state.measures.join(', ')}` : '',
        state.dimensions.length ? `dimensions: ${state.dimensions.join(', ')}` : '',
        state.filters.length ? `filters: ${state.filters.map((filter) => filter.value).join(', ')}` : '',
        state.timeframe ? `timeframe: ${state.timeframe}` : '',
        state.limit !== undefined ? `limit: ${state.limit}` : '',
      ].filter(Boolean)
    : [];
  const lines = [
    `thread: ${envelope.threadId}`,
    `surface: ${envelope.surface}`,
    envelope.topicRelation ? `new-turn relation: ${envelope.topicRelation}` : '',
    ...stateLines,
    envelope.pendingClarification
      ? `pending clarification: ${envelope.pendingClarification.question}`
      : '',
    summary ? `older trusted-state summary:\n${summary}` : '',
  ].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** Classify the NEW question against the current topic key (same Jaccard rule as the reducer). */
function classifyQuestionRelation(state: ConversationWorkingState, question: string): TopicRelation {
  const plan = buildAnalysisQuestionPlan(question);
  const terms = new Set([
    ...plan.entities.map((entity) => normalizeTerm(entity.text)),
    ...plan.metricTerms.map(normalizeTerm),
  ].filter(Boolean));
  const topicTerms = new Set((state.topicKey ?? '').split('|').filter(Boolean));
  // A question the planner could not read is NOT evidence that the user stayed
  // on topic. Calling it a continuation carried the previous question's
  // entities, measures and filters onto an unrelated ask. Unless the question
  // is clearly deictic ("break that down", "same for EMEA"), treat an unreadable
  // question as a new topic and answer it fresh.
  if (terms.size === 0) {
    return referencesPriorTurn(question) ? 'continuation' : 'shift';
  }
  if (topicTerms.size === 0) return 'continuation';
  let shared = 0;
  for (const term of terms) if (topicTerms.has(term)) shared += 1;
  const overlap = shared / (terms.size + topicTerms.size - shared);
  if (overlap >= 0.5) return 'continuation';
  if (overlap > 0) return 'refinement';
  const returned = (state.priorTopics ?? []).some((frame) => {
    const frameTerms = new Set(frame.topicKey.split('|').filter(Boolean));
    let hit = 0;
    for (const term of terms) if (frameTerms.has(term)) hit += 1;
    return frameTerms.size > 0 && hit / (terms.size + frameTerms.size - hit) >= 0.5;
  });
  if (returned) return 'return';
  // A question carrying no measure, dimension or entity is only a "refinement"
  // if it actually points back at the previous turn. Otherwise it is simply a
  // question the planner's vocabulary does not cover, and treating it as a
  // refinement let it inherit — and reuse the entire context pack of — an
  // unrelated prior question.
  const onlyRefinement = plan.dimensionTerms.length === 0 && plan.metricTerms.length === 0 && plan.entities.length === 0;
  return onlyRefinement && referencesPriorTurn(question) ? 'refinement' : 'shift';
}

/**
 * Does the question explicitly point at what came before? Deictic reference is
 * the one reliable signal that the user means "carry the previous context",
 * independent of whether the analysis planner recognised any of the vocabulary.
 */
function referencesPriorTurn(question: string): boolean {
  return /\b(it|its|that|this|those|these|them|their|there|same|above|previous|prior|instead|also|too)\b/i.test(question);
}

function snapshotTurn(turn: ConversationTurn): ConversationSnapshotTurn {
  return {
    id: turn.id,
    question: turn.question,
    answerSummary: turn.answerSummary,
    route: turn.route,
    trustLabel: turn.trustLabel,
    runStatus: turn.runStatus,
    stopReason: turn.stopReason,
    sourceCertifiedBlock: turn.sourceCertifiedBlock,
    contextPackId: turn.contextPackId,
    knowledgeLens: turn.knowledgeLens,
    resultColumns: turn.result?.columns,
    resultRowCount: turn.result?.rowCount,
    resultDimensionValues: turn.result?.dimensionValues,
    refusalCode: turn.refusalCode,
    executionError: turn.executionError,
    sourceSql: turn.sql,
    dqlArtifact: turn.dqlArtifact,
    cascade: turn.cascade,
  };
}

export function conversationTurnContextState(turn: ConversationSnapshotTurn): string {
  if (turn.runStatus === 'blocked' || turn.trustLabel === 'blocked' || turn.route === 'blocked') {
    return 'blocked';
  }
  if (turn.runStatus === 'needs_clarification' || turn.route === 'clarify') {
    return 'unresolved';
  }
  if (turn.runStatus === 'needs_review' || turn.trustLabel === 'review_required') {
    return 'provisional';
  }
  if (turn.trustLabel === 'certified' || turn.trustLabel === 'governed' || turn.trustLabel === 'grounded') {
    return 'confirmed';
  }
  return 'context';
}

function isUsableAnalyticalContextTurn(turn: ConversationSnapshotTurn): boolean {
  // One predicate, shared with the provider layer, the working-state reducer and
  // the prompt renderer. They used to disagree, and a failed turn slipped
  // through every one of them.
  return isTrustedConversationTurn(turn);
}

function hasWorkingState(state: ConversationWorkingState): boolean {
  return state.entities.length > 0
    || state.measures.length > 0
    || state.dimensions.length > 0
    || state.filters.length > 0
    || Boolean(state.topicKey);
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_ ]+/g, '').replace(/s$/, '').trim();
}
