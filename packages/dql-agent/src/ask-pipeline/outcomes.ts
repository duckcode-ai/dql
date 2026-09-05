import { describeIntent, type AnalyticalIntentV1 } from './intent.js';
import type { ExecutedRows, ResultColumnMeta } from './execute.js';
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

/** An ISO instant at UTC midnight is a calendar date; it is never rendered through the host timezone. */
const UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|\+00:00)$/;

export function formatValue(value: unknown, meta?: ResultColumnMeta): string {
  if (value === null || value === undefined) return 'null';
  if (meta && typeof value === 'number' && Number.isFinite(value)) {
    if (meta.kind === 'percent') {
      const points = meta.unit === 'percentage_points' ? value : value * 100;
      return meta.unit === 'percentage_points' ? `${points.toFixed(meta.decimals ?? 1)} pp` : `${points.toFixed(meta.decimals ?? 1)}%`;
    }
    if (meta.kind === 'count') return String(Math.round(value));
    if (meta.kind === 'currency') return value.toFixed(meta.decimals ?? 2);
    if (meta.decimals !== undefined) return value.toFixed(meta.decimals);
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? formatValue(value.toISOString()) : 'null';
  if (typeof value === 'string') {
    const date = UTC_MIDNIGHT.exec(value);
    return date ? date[1]! : value;
  }
  return String(value);
}

const CURRENCY_NAME = /(^|_)(revenue|sales|spend|amount|price|cost|profit|income|total|value|tax|fee|fees)(_|$)/i;
const COUNT_NAME = /(^|_)(count|orders|customers|items|units|quantity|num|number)(_|$)/i;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}(T00:00:00(?:\.0+)?(?:Z|\+00:00))?$/;

/**
 * The units contract of a result: what each column IS, from the vocabulary
 * entry it carries (display format, aggregation, metric type), the intent
 * (a time grain, a ratio of two measures), and only then the values.
 */
export function describeResultColumns(intent: AnalyticalIntentV1, result: Pick<ExecutedRows, 'columns' | 'rows'>, vocabulary: VocabularyIndex): ResultColumnMeta[] {
  const lower = (value: string) => value.toLowerCase();
  const entryOf = (ref: string) => vocabulary.get(ref);
  const byName = new Map<string, { ref?: string; meta: Partial<ResultColumnMeta> }>();
  const kindOfEntry = (ref: string): Partial<ResultColumnMeta> => {
    const entry = entryOf(ref);
    if (!entry) return {};
    if (entry.displayFormat) return { kind: entry.displayFormat.kind, ...(entry.displayFormat.kind === 'currency' ? { unit: entry.displayFormat.currency ?? 'USD' } : entry.displayFormat.kind === 'percent' ? { unit: 'fraction' } : {}), ...(entry.displayFormat.decimals !== undefined ? { decimals: entry.displayFormat.decimals } : {}) };
    if (entry.metricType === 'ratio') return { kind: 'percent', unit: 'fraction' };
    const aggregate = (entry.physical?.aggregate ?? entry.aggregation ?? '').toLowerCase();
    if (aggregate === 'count' || aggregate === 'count_distinct') return { kind: 'count' };
    // dbt counts are often a SUM over 1 (`order_count: expr: 1, agg: sum`), or a sum named as a count.
    const summedExpr = (entry.physical?.expr ?? entry.expr ?? '').replace(/^SUM\(|\)$/gi, '').replace(/"[^"]*"\./g, '').trim();
    if (aggregate === 'sum' && (/^1$/.test(summedExpr) || /^\s*1\s*$/.test(entry.expr ?? '') || COUNT_NAME.test(entry.name) || COUNT_NAME.test(entry.label ?? '') || /(^|_)count(_|$)/i.test(summedExpr))) return { kind: 'count' };
    if (entry.roles.includes('time')) return { kind: 'date' };
    if (entry.roles.includes('boolean') || entry.dataType?.toLowerCase() === 'boolean') return { kind: 'boolean' };
    if (entry.kind === 'metric' || entry.kind === 'measure') return CURRENCY_NAME.test(entry.name) ? { kind: 'currency', unit: 'USD' } : { kind: 'number' };
    if (/(int|decimal|numeric|double|float|real|bigint)/i.test(entry.dataType ?? '')) return { kind: 'number' };
    return { kind: 'text' };
  };
  const register = (name: string | undefined, ref: string | undefined, meta: Partial<ResultColumnMeta>) => {
    if (!name) return;
    byName.set(lower(name), { ...(ref ? { ref } : {}), meta });
  };
  for (const measure of intent.measures) {
    const entry = entryOf(measure.ref);
    const name = measure.alias ?? entry?.name ?? measure.ref.replace(/^ratio:/, '').replace(/[^A-Za-z0-9_]+/g, '_');
    if (measure.derived) {
      const numerator = kindOfEntry(measure.derived.numerator);
      const denominator = kindOfEntry(measure.derived.denominator);
      const meta: Partial<ResultColumnMeta> = numerator.kind === 'currency' && (denominator.kind === 'count' || denominator.kind === 'number') ? { kind: 'currency', unit: 'USD' }
        : numerator.kind === denominator.kind ? { kind: 'percent', unit: 'fraction' } : { kind: 'number' };
      register(name, undefined, meta);
      continue;
    }
    register(name, measure.ref, kindOfEntry(measure.ref));
    if (entry?.name && entry.name !== name) register(entry.name, measure.ref, kindOfEntry(measure.ref));
  }
  for (const group of intent.groupBy) {
    const entry = entryOf(group.ref);
    const base = entry?.physical?.column ?? entry?.name;
    const meta: Partial<ResultColumnMeta> = group.role === 'time' ? { kind: 'date', ...(group.grain ? { grain: group.grain } : {}) } : kindOfEntry(group.ref);
    register(base, group.ref, meta);
    if (group.role === 'time' && base && group.grain) register(`${base}_${group.grain}`, group.ref, meta);
  }
  for (const ref of intent.display) { const entry = entryOf(ref); register(entry?.physical?.column ?? entry?.name, ref, kindOfEntry(ref)); }
  const values = (column: string) => result.rows.slice(0, 50).map((row) => row[column]).filter((value) => value !== null && value !== undefined);
  return result.columns.map((rawColumn) => {
    const column = String(rawColumn ?? '');
    const key = lower(column);
    // Semantic engines qualify a column (`order_item__ordered_at__month`); the
    // registered name is found under the qualifier and the grain suffix.
    const stripped = key.replace(/__(day|week|month|quarter|year)$/, '');
    const found = byName.get(key)
      ?? [...byName.entries()].find(([name]) => stripped === name || stripped.endsWith(`__${name}`) || key.endsWith(`__${name}`) || key.endsWith(`_${name}`) || key.startsWith(`${name}__`))?.[1];
    if (found?.meta.kind) return { name: column, ...found.meta, kind: found.meta.kind, ...(found.ref ? { ref: found.ref } : {}) };
    const sample = values(column);
    if (sample.length && sample.every((value) => typeof value === 'boolean')) return { name: column, kind: 'boolean' };
    if (sample.length && sample.every((value) => typeof value === 'string' && UTC_DAY.test(value))) return { name: column, kind: 'date' };
    if (sample.length && sample.every((value) => typeof value === 'number' || typeof value === 'bigint')) {
      if (COUNT_NAME.test(column) && sample.every((value) => Number.isInteger(Number(value)))) return { name: column, kind: 'count' };
      return CURRENCY_NAME.test(column) ? { name: column, kind: 'currency', unit: 'USD' } : { name: column, kind: 'number' };
    }
    return { name: column, kind: 'text' };
  });
}

/** Deterministic answer prose from the rows themselves: no claim without a cell behind it. */
export function composeAnsweredText(intent: AnalyticalIntentV1, result: ExecutedRows, vocabulary: VocabularyIndex, trust: string, extras: { notes?: string[]; caveats?: string[] } = {}): string {
  const reading = intent.reading || describeIntent(intent, labelFor(vocabulary));
  const lines: string[] = [`I read this as: ${reading.replace(/[.\s]+$/, '')}.`];
  const columns = result.columns;
  const metaOf = (column: string) => result.columnsMeta?.find((meta) => meta.name === column);
  if (result.rowCount === 0) {
    lines.push('The query ran and returned no rows for that reading.');
    return lines.join(' ');
  }
  if (result.rowCount === 1 && columns.length <= 4) {
    const row = result.rows[0] ?? {};
    lines.push(columns.map((column) => `${column.replace(/_/g, ' ')}: ${formatValue(row[column], metaOf(column))}`).join(', ') + '.');
  } else {
    lines.push(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'}${result.truncated ? ' (bounded)' : ''}.`);
    const first = result.rows.slice(0, 3).map((row) => columns.map((column) => formatValue(row[column], metaOf(column))).join(' · '));
    if (first.length) lines.push(`Leading rows: ${first.join(' | ')}.`);
  }
  // Identity: several members share the asked-for name; the rows keep them apart.
  for (const note of extras.notes ?? []) if (note.startsWith('identity:')) lines.push(`${note.slice('identity:'.length).trim().replace(/[.\s]+$/, '')}.`);
  lines.push(trust === 'certified' ? 'Source: a certified block.' : trust === 'governed' ? 'Source: the governed semantic layer and join paths.' : 'Source: review-required SQL.');
  for (const caveat of extras.caveats ?? []) lines.push(caveat.replace(/[.\s]+$/, '') + '.');
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
