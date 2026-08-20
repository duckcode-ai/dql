/**
 * Deterministic rolling summary: turns older than the recent verbatim window are
 * compacted into a bounded structured excerpt (one line per turn, oldest lines
 * dropped beyond the cap). Incremental and idempotent via the thread's
 * `summaryTurnSeq` cursor. An optional LLM compaction can layer on later; this
 * deterministic form is always the fallback and never blocks.
 */

import type { ConversationTurn } from './session-store.js';

/**
 * 600 characters could not hold a session's established facts once a few
 * metrics, filters, and entities had been agreed — the oldest were evicted
 * silently, so the agent "forgot" a binding the reader had already given it.
 */
const MAX_SUMMARY_CHARS = 1800;
const MAX_LINE_CHARS = 200;
const MAX_STRUCTURED_ENTRIES = 24;
const MAX_STRUCTURED_TEXT = 320;

export type ConversationSummaryEntryState =
  | 'confirmed'
  | 'provisional'
  | 'unresolved'
  | 'blocked'
  | 'context';

export interface ConversationSummaryEntryV1 {
  sourceTurnId: string;
  state: ConversationSummaryEntryState;
  question: string;
  answerSummary?: string;
  evidenceRefs?: string[];
}

/**
 * Trust-aware compaction stored beside the legacy text summary. It is entirely
 * deterministic: no model is allowed to turn a failed or review-required turn
 * into confirmed session context.
 */
export interface ConversationSummaryV1 {
  version: 1;
  entries: ConversationSummaryEntryV1[];
}

export function updateRollingSummary(input: {
  previousSummary?: string;
  compactedTurns: ConversationTurn[];
}): string | undefined {
  const newLines = input.compactedTurns.map(summarizeTurn).filter(Boolean);
  const lines = [
    ...(input.previousSummary ? input.previousSummary.split('\n') : []),
    ...newLines,
  ].filter(Boolean);
  // Keep the newest lines; drop the oldest beyond the budget.
  const kept: string[] = [];
  let total = 0;
  for (const line of lines.reverse()) {
    if (total + line.length + 1 > MAX_SUMMARY_CHARS) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return kept.length > 0 ? kept.join('\n') : undefined;
}

export function updateStructuredConversationSummary(input: {
  previousSummary?: ConversationSummaryV1;
  compactedTurns: ConversationTurn[];
}): ConversationSummaryV1 | undefined {
  const existing = input.previousSummary?.version === 1
    ? input.previousSummary.entries
    : [];
  const byTurnId = new Map<string, ConversationSummaryEntryV1>();
  for (const entry of existing) byTurnId.set(entry.sourceTurnId, entry);
  for (const turn of input.compactedTurns) {
    byTurnId.set(turn.id, structuredEntry(turn));
  }
  const entries = Array.from(byTurnId.values()).slice(-MAX_STRUCTURED_ENTRIES);
  return entries.length > 0 ? { version: 1, entries } : undefined;
}

/** Bounded prompt projection; source ids and trust states remain visible. */
export function renderStructuredConversationSummary(
  summary: ConversationSummaryV1 | undefined,
): string | undefined {
  if (!summary?.entries.length) return undefined;
  return summary.entries.map((entry) => {
    const parts = [
      `[${entry.state}; turn=${entry.sourceTurnId}] Q: ${entry.question}`,
      entry.answerSummary ? `A: ${entry.answerSummary}` : '',
      entry.evidenceRefs?.length ? `evidence: ${entry.evidenceRefs.join(', ')}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }).join('\n');
}

function summarizeTurn(turn: ConversationTurn): string {
  const columns = turn.result?.columns?.slice(0, 5).join(', ');
  const values = turn.result?.dimensionValues
    ? Object.entries(turn.result.dimensionValues)
        .slice(0, 3)
        .map(([key, list]) => `${key}: ${list.slice(0, 3).join(', ')}`)
        .join('; ')
    : '';
  const line = [
    `Q: ${turn.question}`,
    turn.answerSummary ? `A: ${turn.answerSummary}` : '',
    columns ? `cols: ${columns}` : '',
    values ? `vals: ${values}` : '',
  ].filter(Boolean).join(' | ');
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

function structuredEntry(turn: ConversationTurn): ConversationSummaryEntryV1 {
  const evidenceRefs = Array.from(new Set([
    turn.sourceCertifiedBlock,
    turn.dqlArtifact?.name,
    turn.contextPackId,
  ].filter((value): value is string => Boolean(value?.trim())))).slice(0, 4);
  return {
    sourceTurnId: turn.id,
    state: summaryState(turn),
    question: compact(turn.question),
    answerSummary: turn.answerSummary ? compact(turn.answerSummary) : undefined,
    evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
  };
}

function summaryState(turn: ConversationTurn): ConversationSummaryEntryState {
  if (turn.runStatus === 'blocked' || turn.trustLabel === 'blocked' || turn.route === 'blocked') {
    return 'blocked';
  }
  if (turn.runStatus === 'needs_clarification' || turn.route === 'clarify') {
    return 'unresolved';
  }
  if (turn.runStatus === 'needs_review' || turn.trustLabel === 'review_required') {
    return 'provisional';
  }
  if (
    turn.runStatus === 'completed'
    && (turn.trustLabel === 'certified' || turn.trustLabel === 'governed' || turn.trustLabel === 'grounded')
  ) {
    return 'confirmed';
  }
  return 'context';
}

function compact(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > MAX_STRUCTURED_TEXT
    ? `${normalized.slice(0, MAX_STRUCTURED_TEXT - 1)}…`
    : normalized;
}
