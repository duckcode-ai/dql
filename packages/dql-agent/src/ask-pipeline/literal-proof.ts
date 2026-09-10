import type { AnalyticalIntentV1, IntentPredicate } from './intent.js';
import type { VocabularyEntry, VocabularyIndex } from './vocabulary.js';

/**
 * EVERY LITERAL IS PROVEN AGAINST ITS FIELD BEFORE SQL. The model interprets;
 * the host proves. A member name is grounded against the warehouse, a year is
 * checked against its window — but a value on a date field went to the
 * warehouse as written, and "current_month" died there as
 * `Date 'current_month' is not recognized`. This proof is general: a date
 * field accepts a date, a partial date (2025, 2025-03, 2025-Q2) or a relative
 * period the host resolves from today; a numeric field accepts a number; a
 * Boolean field accepts true or false; text accepts anything. What a field
 * cannot accept is asked back, with the field named and what it takes —
 * never sent to the warehouse to fail there.
 */

export interface PeriodBounds { start: string; end: string; label: string }

const UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
type Unit = typeof UNITS[number];

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m, d));

function startOf(now: Date, unit: Unit): Date {
  const y = now.getUTCFullYear(); const m = now.getUTCMonth(); const d = now.getUTCDate();
  switch (unit) {
    case 'day': return utc(y, m, d);
    case 'week': { const start = utc(y, m, d); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); return start; }
    case 'month': return utc(y, m, 1);
    case 'quarter': return utc(y, Math.floor(m / 3) * 3, 1);
    case 'year': return utc(y, 0, 1);
  }
}

function shift(date: Date, unit: Unit, by: number): Date {
  const out = new Date(date.getTime());
  switch (unit) {
    case 'day': out.setUTCDate(out.getUTCDate() + by); break;
    case 'week': out.setUTCDate(out.getUTCDate() + 7 * by); break;
    case 'month': out.setUTCMonth(out.getUTCMonth() + by); break;
    case 'quarter': out.setUTCMonth(out.getUTCMonth() + 3 * by); break;
    case 'year': out.setUTCFullYear(out.getUTCFullYear() + by); break;
  }
  return out;
}

/**
 * A relative period as a half-open window against `now`: "current_month",
 * "last month", "previous quarter", "this year", "ytd", "last 3 months"
 * (the three complete months before this one), "today", "yesterday".
 */
export function relativePeriodBounds(token: string, now: Date): PeriodBounds | undefined {
  const text = token.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const single: Record<string, [Unit, number]> = { today: ['day', 0], yesterday: ['day', -1], tomorrow: ['day', 1] };
  if (single[text]) { const [unit, by] = single[text]!; const start = shift(startOf(now, unit), unit, by); return { start: iso(start), end: iso(shift(start, unit, 1)), label: text }; }
  const toDate = /^(mtd|qtd|ytd|wtd|month to date|quarter to date|year to date|week to date)$/.exec(text);
  if (toDate) {
    const unit: Unit = text.startsWith('m') ? 'month' : text.startsWith('q') ? 'quarter' : text.startsWith('y') ? 'year' : 'week';
    return { start: iso(startOf(now, unit)), end: iso(shift(startOf(now, 'day'), 'day', 1)), label: text };
  }
  const relative = /^(this|current|present|last|previous|prior|past|next)\s+(day|week|month|quarter|year)$/.exec(text);
  if (relative) {
    const unit = relative[2] as Unit;
    const by = ['last', 'previous', 'prior', 'past'].includes(relative[1]!) ? -1 : relative[1] === 'next' ? 1 : 0;
    const start = shift(startOf(now, unit), unit, by);
    return { start: iso(start), end: iso(shift(start, unit, 1)), label: text };
  }
  const span = /^(last|previous|prior|past)\s+(\d{1,3})\s+(day|week|month|quarter|year)s?$/.exec(text);
  if (span) {
    const unit = span[3] as Unit; const count = Number(span[2]);
    const end = startOf(now, unit);
    return { start: iso(shift(end, unit, -count)), end: iso(end), label: text };
  }
  return undefined;
}

/** A date literal, whole or partial, as the window it names: 2025 → the year, 2025-03 → the month, 2025-Q2 → the quarter, 2025-03-14 → the day. A full timestamp is kept as a point. */
export function dateLiteralBounds(value: string): PeriodBounds | { point: string } | undefined {
  const text = value.trim();
  let m = /^(\d{4})$/.exec(text);
  if (m) { const y = Number(m[1]); return { start: iso(utc(y, 0, 1)), end: iso(utc(y + 1, 0, 1)), label: text }; }
  m = /^(\d{4})-(\d{2})$/.exec(text);
  if (m) { const y = Number(m[1]); const mo = Number(m[2]) - 1; if (mo < 0 || mo > 11) return undefined; return { start: iso(utc(y, mo, 1)), end: iso(utc(y, mo + 1, 1)), label: text }; }
  m = /^(\d{4})-?q([1-4])$/i.exec(text);
  if (m) { const y = Number(m[1]); const q = Number(m[2]) - 1; return { start: iso(utc(y, q * 3, 1)), end: iso(utc(y, q * 3 + 3, 1)), label: text }; }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) { const date = utc(Number(m[1]), Number(m[2]) - 1, Number(m[3])); if (Number.isNaN(date.getTime())) return undefined; return { start: iso(date), end: iso(shift(date, 'day', 1)), label: text }; }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) && !Number.isNaN(Date.parse(text))) return { point: text };
  return undefined;
}

export type FieldKind = 'date' | 'numeric' | 'boolean' | 'text' | 'unknown';

/** What a field accepts, from its declared type first and its role second. */
export function fieldKind(entry: VocabularyEntry | undefined): FieldKind {
  if (!entry) return 'unknown';
  const dataType = entry.dataType?.toLowerCase() ?? '';
  if (dataType) {
    if (/bool/.test(dataType)) return 'boolean';
    if (/date|time/.test(dataType) && !/interval/.test(dataType)) return 'date';
    if (/int|decimal|numeric|number|float|double|real/.test(dataType)) return 'numeric';
    if (/char|text|string|uuid|json|enum/.test(dataType)) return 'text';
  }
  if (entry.roles.includes('boolean')) return 'boolean';
  if (entry.roles.includes('time')) return 'date';
  if (entry.roles.includes('numeric')) return 'numeric';
  if (entry.roles.includes('label') || entry.roles.includes('key') || entry.roles.includes('text')) return 'text';
  return 'unknown';
}

export interface LiteralProof {
  intent: AnalyticalIntentV1;
  /** What the proof rewrote, for the receipt. */
  notes: string[];
  /** Literals no field of that kind can take: asked back, never executed. */
  problems: Array<{ ref: string; value: string; message: string }>;
}

const BOOLEAN_WORDS: Record<string, boolean> = { true: true, false: false, yes: true, no: false, y: true, n: false, '1': true, '0': false, t: true, f: false };

function proveOne(predicate: IntentPredicate, entry: VocabularyEntry | undefined, now: Date, label: string): { predicates: IntentPredicate[]; note?: string; problem?: string } {
  if (predicate.on === 'aggregate' || /^measure:\d+$/.test(predicate.ref)) return { predicates: [predicate] };
  const kind = fieldKind(entry);
  if (kind === 'text' || kind === 'unknown') return { predicates: [predicate] };
  if (kind === 'boolean') {
    if (predicate.op !== 'eq' && predicate.op !== 'neq' && predicate.op !== 'in' && predicate.op !== 'not_in') return { predicates: [predicate] };
    const values = predicate.values.map((value) => typeof value === 'boolean' ? value : BOOLEAN_WORDS[String(value).trim().toLowerCase()]);
    if (values.some((value) => value === undefined)) return { predicates: [predicate], problem: `${label} is true or false; "${predicate.values.map(String).join('/')}" is neither` };
    return { predicates: [{ ...predicate, values: values as boolean[] }] };
  }
  if (kind === 'numeric') {
    const bad = predicate.values.find((value) => typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) && typeof value !== 'boolean');
    if (bad !== undefined) return { predicates: [predicate], problem: `${label} is a number; "${String(bad)}" is not one` };
    return { predicates: [predicate] };
  }
  // A date field: each value must be a date, a partial date or a relative period.
  const bounds = (value: unknown): PeriodBounds | { point: string } | undefined => typeof value === 'string' ? (dateLiteralBounds(value) ?? relativePeriodBounds(value, now)) : undefined;
  if (predicate.op === 'eq' || predicate.op === 'in') {
    if (predicate.values.length !== 1) {
      const resolved = predicate.values.map(bounds);
      if (resolved.some((item) => item === undefined)) return { predicates: [predicate], problem: `${label} is a date; say the period ("last month", "2025-03") or the dates` };
      return { predicates: [predicate] }; // several exact points: left to the binder as typed values
    }
    const resolved = bounds(predicate.values[0]);
    if (!resolved) return { predicates: [predicate], problem: `${label} is a date; "${String(predicate.values[0])}" is neither a date nor a period this host can read — say the period ("last month", "2025-03") or the dates` };
    if ('point' in resolved) return { predicates: [predicate] };
    return {
      predicates: [{ ...predicate, op: 'gte', values: [resolved.start] }, { ...predicate, op: 'lt', values: [resolved.end] }],
      note: `${label}: "${resolved.label}" is ${resolved.start} to ${resolved.end} (half-open)`,
    };
  }
  if (predicate.op === 'neq' || predicate.op === 'not_in') return { predicates: [predicate] };
  if (predicate.op === 'gt' || predicate.op === 'gte' || predicate.op === 'lt' || predicate.op === 'lte') {
    const resolved = bounds(predicate.values[0]);
    if (!resolved) return { predicates: [predicate], problem: `${label} is a date; "${String(predicate.values[0])}" is neither a date nor a period this host can read` };
    if ('point' in resolved) return { predicates: [predicate] };
    // "since last month" starts at its start; "before this month" ends at its start; "until last month" ends at its end.
    const value = predicate.op === 'gte' || predicate.op === 'lt' ? resolved.start : predicate.op === 'gt' ? resolved.end : resolved.end;
    const op = predicate.op === 'gt' ? 'gte' : predicate.op === 'lte' ? 'lt' : predicate.op;
    return { predicates: [{ ...predicate, op, values: [value] }], note: `${label}: "${resolved.label}" resolves ${predicate.op} to ${op} ${value}` };
  }
  return { predicates: [predicate] };
}

export function proveLiterals(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, now: Date): LiteralProof {
  if (intent.kind !== 'analytics') return { intent, notes: [], problems: [] };
  const notes: string[] = []; const problems: LiteralProof['problems'] = [];
  const labelOf = (ref: string) => { const entry = vocabulary.get(ref) ?? vocabulary.resolve(ref); return entry?.label ?? entry?.name ?? ref; };
  const run = (predicates: IntentPredicate[]): IntentPredicate[] => predicates.flatMap((predicate) => {
    const entry = vocabulary.get(predicate.ref) ?? vocabulary.resolve(predicate.ref);
    const result = proveOne(predicate, entry, now, labelOf(predicate.ref));
    if (result.note) notes.push(`literal: ${result.note}`);
    if (result.problem) problems.push({ ref: predicate.ref, value: predicate.values.map(String).join('/'), message: result.problem });
    return result.predicates;
  });
  const next: AnalyticalIntentV1 = {
    ...intent,
    filters: run(intent.filters),
    measures: intent.measures.map((measure) => measure.scope?.length ? { ...measure, scope: run(measure.scope) } : measure),
    provenance: { ...intent.provenance },
  };
  for (const note of notes) next.provenance[`literal:${note.slice('literal: '.length, 60)}`] = 'host:a value on a typed field is proven before SQL';
  return { intent: next, notes, problems };
}
