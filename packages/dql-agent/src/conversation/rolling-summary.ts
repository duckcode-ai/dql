/**
 * Deterministic rolling summary: turns older than the recent verbatim window are
 * compacted into a bounded structured excerpt (one line per turn, oldest lines
 * dropped beyond the cap). Incremental and idempotent via the thread's
 * `summaryTurnSeq` cursor. An optional LLM compaction can layer on later; this
 * deterministic form is always the fallback and never blocks.
 */

import type { ConversationTurn } from './session-store.js';

const MAX_SUMMARY_CHARS = 600;
const MAX_LINE_CHARS = 200;

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
