import { describeIntent, type AnalyticalIntentV1 } from './intent.js';
import type { ExecutedRows } from './execute.js';
import type { PreparedCandidate, PreparedRefusal } from './prepare/types.js';
import type { VocabularyIndex } from './vocabulary.js';

/**
 * THE FOUR WAYS A TURN ENDS, and the words for each.
 *
 * answered · clarify · gap · failed (plus the two non-analytical replies).
 * A gap says which of five things is true — not retrieved, not modeled,
 * ambiguous, unsupported, denied — and names the nearest vocabulary. A
 * failure names the stage and carries the verbatim error. Nothing here ever
 * describes budgets, dispatches, snapshots or kernels.
 */

export type GapKind = 'not_retrieved' | 'not_modeled' | 'ambiguous' | 'unsupported' | 'denied';

export interface PipelineReceipt {
  version: 1;
  vocabularyFingerprint: string;
  intent?: AnalyticalIntentV1;
  reading?: string;
  dispatches: Array<{ purpose: string; ms: number; reply?: string }>;
  candidates: Array<{ tier: string; trust: string; proof: string[]; sqlFingerprint?: string; engine?: string }>;
  refusals: PreparedRefusal[];
  /** Tier attempts per preparation round, in order. */
  tiers: Array<{ round: number; tier: string; outcome: string; detail?: string }>;
  executed?: { tier: string; sqlFingerprint: string; rowCount: number; ms: number; proofs: string[] };
  timings: Record<string, number>;
  reuse?: 'interpretation' | 'preparation' | 'none';
  build?: Record<string, string>;
  /** Question words naming vocabulary the reading does not use; shown as a warning, never a refusal. */
  uncovered?: string[];
  /** Member literals the host grounded against allowlisted columns before preparing (canonical value, or that none matched). */
  grounding?: string[];
  /** Why resolution or execution stopped, verbatim, when it did. */
  failure?: { stage: 'resolve' | 'prepare' | 'execute'; reason?: string; message: string; problems?: Array<{ path: string; message: string; suggestions?: string[] }> };
}

/**
 * The Ask pipeline's diagnostic receipt, persisted on the run root as
 * `diagnosticReceiptV9` and served by the trace API as `runtimeReceiptV9`.
 * V1–V8 receipts stay readable for the runs that carry them.
 */
export type AskPipelineReceiptV9 = PipelineReceipt;

export type PipelineOutcome =
  | { kind: 'answered'; intent: AnalyticalIntentV1; candidate: PreparedCandidate; result: ExecutedRows; text: string; receipt: PipelineReceipt }
  | { kind: 'clarify'; intent: AnalyticalIntentV1; question: string; options: Array<{ ref: string; label: string; description?: string }>; text: string; receipt: PipelineReceipt }
  | { kind: 'conversation' | 'definition'; reply: string; text: string; receipt: PipelineReceipt; intent?: AnalyticalIntentV1 }
  | { kind: 'gap'; gap: GapKind; message: string; nearest: string[]; text: string; receipt: PipelineReceipt; intent?: AnalyticalIntentV1; offerExploration: boolean }
  | { kind: 'failed'; stage: 'resolve' | 'prepare' | 'execute'; message: string; text: string; receipt: PipelineReceipt; intent?: AnalyticalIntentV1 };

export function labelFor(vocabulary: VocabularyIndex): (ref: string) => string {
  return (ref) => {
    const entry = vocabulary.get(ref);
    if (!entry) return ref;
    return (entry.label ?? entry.name).replace(/_/g, ' ');
  };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

/** Deterministic answer prose from the rows themselves: no claim without a cell behind it. */
export function composeAnsweredText(intent: AnalyticalIntentV1, result: ExecutedRows, vocabulary: VocabularyIndex, trust: string): string {
  const reading = intent.reading || describeIntent(intent, labelFor(vocabulary));
  const lines: string[] = [`I read this as: ${reading.replace(/[.\s]+$/, '')}.`];
  const columns = result.columns;
  if (result.rowCount === 0) {
    lines.push('The query ran and returned no rows for that reading.');
    return lines.join(' ');
  }
  if (result.rowCount === 1 && columns.length <= 4) {
    const row = result.rows[0] ?? {};
    lines.push(columns.map((column) => `${column.replace(/_/g, ' ')}: ${formatValue(row[column])}`).join(', ') + '.');
  } else {
    lines.push(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'}${result.truncated ? ' (bounded)' : ''}.`);
    const first = result.rows.slice(0, 3).map((row) => columns.map((column) => formatValue(row[column])).join(' · '));
    if (first.length) lines.push(`Leading rows: ${first.join(' | ')}.`);
  }
  lines.push(trust === 'certified' ? 'Source: a certified block.' : trust === 'governed' ? 'Source: the governed semantic layer and join paths.' : 'Source: review-required SQL.');
  return lines.join(' ');
}

export function composeGapText(gap: GapKind, message: string, nearest: string[], offerExploration: boolean): string {
  const because = {
    not_retrieved: 'nothing in the governed catalogue was retrieved for it',
    not_modeled: 'the project does not model it',
    ambiguous: 'it can be read more than one way',
    unsupported: 'the governed engines cannot express it',
    denied: 'policy does not allow it',
  }[gap];
  const near = nearest.length ? ` The nearest governed vocabulary: ${nearest.join(', ')}.` : '';
  const offer = offerExploration ? ' You can ask for a review-required exploration of the physical tables instead.' : '';
  return `No governed query was run because ${because}: ${message}.${near}${offer}`;
}

export function composeFailedText(stage: 'resolve' | 'prepare' | 'execute', message: string): string {
  const where = stage === 'resolve' ? 'while reading the question' : stage === 'prepare' ? 'while preparing the query; no warehouse query ran' : 'on the warehouse';
  return `This could not be completed ${where}: ${message}`;
}
