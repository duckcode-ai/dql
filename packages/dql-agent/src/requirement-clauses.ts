/**
 * The single grammar for time-window clauses.
 *
 * Three question parsers each carried their own relative-time regexes, every
 * one requiring the determiner to sit adjacent to the time noun — so "last
 * month" parsed and "last two months" did not, anywhere. The phrase then
 * degraded to a bare `month` grouping while its count was misread as a row
 * limit, and the answer silently changed meaning.
 *
 * This module is the one producer of the typed window. Its accepted forms
 * deliberately MIRROR `resolvePlanTimeRange` (resolved-analytical-plan.ts) —
 * the already-written resolver of "last N units" into UTC bounds — so the
 * producer and the resolver cannot drift: everything parsed here resolves
 * there, via the canonical digits `expression`.
 */

import type { AnalyticalTimeWindowV1 } from './analytical-orchestration.js';

const WORD_COUNTS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

const WINDOW_UNIT_RE = 'day|week|month|quarter|year';

/**
 * Parse a relative or named time window from free text. Returns undefined
 * when the question carries no bounded period — a bare grain ("by month") is
 * a grouping, not a window, and stays out of this clause on purpose.
 */
export function parseAnalyticalTimeWindow(question: string): AnalyticalTimeWindowV1 | undefined {
  const lower = question.toLowerCase();

  // "2024-01-01 to 2024-03-01" — absolute, passed through verbatim.
  const absolute = /\b(\d{4}-\d{2}-\d{2})\s+(?:to|through)\s+(\d{4}-\d{2}-\d{2})\b/.exec(lower);
  if (absolute) {
    return {
      version: 1,
      kind: 'absolute',
      expression: `${absolute[1]} to ${absolute[2]}`,
      absolute: { startInclusive: absolute[1]!, endExclusive: absolute[2]! },
    };
  }

  // "ytd" / "month to date" — named periods.
  const named = /\b(ytd|qtd|mtd|wtd|(?:year|quarter|month|week)[ -]to[ -]date)\b/.exec(lower);
  if (named) {
    const token = named[1]!.replace(/[ -]to[ -]date$/, (unit) => unit).trim();
    const canonical = token.length <= 3 ? token : `${token[0]}td`;
    return { version: 1, kind: 'named_period', expression: canonical, namedPeriod: canonical };
  }

  // "last two months", "past 60 days", "this quarter", "since last 2 months".
  const relative = new RegExp(
    `\\b(last|this|past|previous|prior)\\s+(?:(\\d{1,3}|${Object.keys(WORD_COUNTS).join('|')})\\s+)?(${WINDOW_UNIT_RE})s?\\b`,
  ).exec(lower);
  if (!relative) return undefined;
  const determiner = relative[1]!;
  const rawCount = relative[2];
  const unit = relative[3]! as NonNullable<AnalyticalTimeWindowV1['relative']>['unit'];
  const count = rawCount === undefined
    ? 1
    : /^\d+$/.test(rawCount) ? Number(rawCount) : WORD_COUNTS[rawCount] ?? 1;
  if (count <= 0 || count > 366) return undefined;
  // Mirror `resolvePlanTimeRange` exactly: an UNcounted "last month" is the
  // previous complete period; a COUNTED "last 2 months" is a trailing window
  // ending now; "this month" is the current period. Diverging here would let
  // the producer promise a different span than the resolver computes.
  const mode = determiner === 'this' ? 'this' : 'last';
  const complete = mode === 'last' && rawCount === undefined;
  return {
    version: 1,
    kind: 'relative',
    expression: count === 1 && mode === 'last' ? `last ${unit}` : `${mode} ${count} ${unit}${count === 1 ? '' : 's'}`,
    relative: { count, unit, complete },
  };
}
