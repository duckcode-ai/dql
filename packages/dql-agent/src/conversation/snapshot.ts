/**
 * Conversation snapshot: the bounded, structured view of a thread that every
 * question carries into the answer loop — working state + rolling summary +
 * a few verbatim recent turns + how the new question relates to the topic.
 */

import type { ConversationStore, ConversationTurn } from './session-store.js';
import {
  parseWorkingState,
  reduceWorkingState,
  type ConversationWorkingState,
  type TopicRelation,
} from './working-state.js';
import { updateRollingSummary } from './rolling-summary.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';
import { hybridRank } from '../embeddings/provider.js';

const RECENT_TURNS = 4;

export interface ConversationSnapshotTurn {
  id: string;
  question: string;
  answerSummary?: string;
  route?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  resultColumns?: string[];
  resultDimensionValues?: Record<string, string[]>;
}

export interface ConversationSnapshot {
  threadId: string;
  rollingSummary?: string;
  workingState?: ConversationWorkingState;
  recentTurns: ConversationSnapshotTurn[];
  /** Semantic-recall hits over older turns (P5). */
  recalledTurns?: ConversationSnapshotTurn[];
  /** How the NEW question relates to the ongoing topic (when a question is supplied). */
  topicRelation?: TopicRelation;
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
      workingState = { ...workingState, filters: [] };
    }
  }
  return {
    threadId,
    rollingSummary: thread.rollingSummary,
    workingState: hasWorkingState(workingState) ? workingState : undefined,
    recentTurns: recent.map(snapshotTurn),
    topicRelation,
  };
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
    store.updateThreadState(threadId, {
      workingState: state as unknown as Record<string, unknown>,
      rollingSummary,
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
 * FTS candidates re-ranked with the deterministic hash-embedding blend
 * (alpha 0.4 — FTS still dominates). Turns already in the recent verbatim
 * window are excluded; returns at most `limit` hits. Never throws.
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
      .filter((turn) => !excluded.has(turn.id));
    if (candidates.length === 0) return [];
    const ranked = await hybridRank(
      question,
      candidates.map((turn, index) => ({
        item: turn,
        // FTS returns rank-ordered rows; convert position to a [0,1] score.
        ftsScore: 1 - index / candidates.length,
        text: `${turn.question} ${turn.answerSummary ?? ''}`,
      })),
      { alpha: 0.4 },
    );
    return ranked.slice(0, options.limit ?? 3).map((entry) => snapshotTurn(entry.item));
  } catch {
    return [];
  }
}

/** Classify the NEW question against the current topic key (same Jaccard rule as the reducer). */
function classifyQuestionRelation(state: ConversationWorkingState, question: string): TopicRelation {
  const plan = buildAnalysisQuestionPlan(question);
  const terms = new Set([
    ...plan.entities.map((entity) => normalizeTerm(entity.text)),
    ...plan.metricTerms.map(normalizeTerm),
  ].filter(Boolean));
  const topicTerms = new Set((state.topicKey ?? '').split('|').filter(Boolean));
  if (terms.size === 0) return 'continuation';
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
  const onlyRefinement = plan.dimensionTerms.length === 0 && plan.metricTerms.length === 0 && plan.entities.length === 0;
  return onlyRefinement ? 'refinement' : 'shift';
}

function snapshotTurn(turn: ConversationTurn): ConversationSnapshotTurn {
  return {
    id: turn.id,
    question: turn.question,
    answerSummary: turn.answerSummary,
    route: turn.route,
    sourceCertifiedBlock: turn.sourceCertifiedBlock,
    contextPackId: turn.contextPackId,
    resultColumns: turn.result?.columns,
    resultDimensionValues: turn.result?.dimensionValues,
  };
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
