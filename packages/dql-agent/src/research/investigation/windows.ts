/**
 * PERIODS AS CALENDAR DAYS. Every window is a half-open `YYYY-MM-DD` range on
 * the Gregorian calendar in UTC: a month is its first day to the first day of
 * the next, the period before it is the same number of buckets earlier, and
 * the same period a year earlier keeps its days (February 29 becomes 28).
 */
import type { Grain } from '../../ask-pipeline/intent.js';
import type { InvestigationWindow } from './types.js';

export interface CalendarDay { year: number; month: number; day: number }

const DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const DAY_MS = 86_400_000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function parseDay(value: unknown): CalendarDay | undefined {
  const text = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : '') : typeof value === 'string' ? value.trim() : '';
  const match = DAY_PREFIX.exec(text);
  if (!match) return undefined;
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (day.month < 1 || day.month > 12 || day.day < 1 || day.day > daysInMonth(day.year, day.month)) return undefined;
  return day;
}

export function formatDay(day: CalendarDay): string {
  return `${String(day.year).padStart(4, '0')}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
}

export function dayOf(date: Date): CalendarDay {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const toUtc = (day: CalendarDay): number => Date.UTC(day.year, day.month - 1, day.day);

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(day: CalendarDay, count: number): CalendarDay {
  return dayOf(new Date(toUtc(day) + count * DAY_MS));
}

export function addMonths(day: CalendarDay, count: number): CalendarDay {
  const total = day.year * 12 + (day.month - 1) + count;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return { year, month, day: Math.min(day.day, daysInMonth(year, month)) };
}

export function startOfGrain(day: CalendarDay, grain: Grain): CalendarDay {
  switch (grain) {
    case 'day': return day;
    case 'week': {
      const weekday = new Date(toUtc(day)).getUTCDay();
      return addDays(day, -((weekday + 6) % 7));
    }
    case 'month': return { ...day, day: 1 };
    case 'quarter': return { year: day.year, month: Math.floor((day.month - 1) / 3) * 3 + 1, day: 1 };
    case 'year': return { year: day.year, month: 1, day: 1 };
  }
}

export function addGrains(day: CalendarDay, grain: Grain, count: number): CalendarDay {
  switch (grain) {
    case 'day': return addDays(day, count);
    case 'week': return addDays(day, 7 * count);
    case 'month': return addMonths(day, count);
    case 'quarter': return addMonths(day, 3 * count);
    case 'year': return addMonths(day, 12 * count);
  }
}

/** The last day a half-open range covers: the day before its exclusive end. */
export function lastDayBefore(exclusiveEnd: string): string {
  return formatDay(addDays(parseDay(exclusiveEnd)!, -1));
}

export function daysIn(window: { start: string; end: string }): number {
  const start = parseDay(window.start);
  const end = parseDay(window.end);
  return start && end ? Math.round((toUtc(end) - toUtc(start)) / DAY_MS) : 0;
}

/** How many whole buckets of `grain` the window spans, or undefined when it is not whole buckets. */
export function bucketsIn(window: { start: string; end: string }, grain: Grain): number | undefined {
  const start = parseDay(window.start);
  if (!start || formatDay(startOfGrain(start, grain)) !== window.start || window.end <= window.start) return undefined;
  let cursor = start;
  let count = 0;
  while (formatDay(cursor) < window.end && count < 1_000) {
    cursor = addGrains(cursor, grain, 1);
    count += 1;
  }
  return formatDay(cursor) === window.end ? count : undefined;
}

/** The coarsest grain the window is exactly one bucket of, else the grain it is several months or days of. */
export function grainOfWindow(window: { start: string; end: string }): Grain {
  for (const grain of ['year', 'quarter', 'month', 'week', 'day'] as const) if (bucketsIn(window, grain) === 1) return grain;
  return bucketsIn(window, 'month') ? 'month' : 'day';
}

export function windowLabel(window: { start: string; end: string }, grain: Grain): string {
  const start = parseDay(window.start);
  const end = parseDay(window.end);
  if (!start || !end) return `${window.start} to ${window.end}`;
  const buckets = bucketsIn(window, grain);
  const lastDay = addDays(end, -1);
  if (buckets === 1) {
    if (grain === 'month') return `${MONTH_NAMES[start.month - 1]} ${start.year}`;
    if (grain === 'quarter') return `Q${Math.floor((start.month - 1) / 3) + 1} ${start.year}`;
    if (grain === 'year') return String(start.year);
    if (grain === 'week') return `the week of ${window.start}`;
    return window.start;
  }
  if (buckets && grain === 'month') {
    const last = startOfGrain(lastDay, 'month');
    return `${MONTH_NAMES[start.month - 1]} ${start.year} to ${MONTH_NAMES[last.month - 1]} ${last.year}`;
  }
  return `${window.start} to ${formatDay(lastDay)}`;
}

export function windowOf(start: CalendarDay, end: CalendarDay, grain: Grain): InvestigationWindow {
  const window = { start: formatDay(start), end: formatDay(end) };
  return { ...window, label: windowLabel(window, grain) };
}

/** The period just before: the same number of buckets, or the same number of days when the window is not whole buckets. */
export function priorWindow(window: { start: string; end: string }, grain: Grain): InvestigationWindow {
  const start = parseDay(window.start)!;
  const buckets = bucketsIn(window, grain);
  if (buckets) return windowOf(addGrains(start, grain, -buckets), start, grain);
  return windowOf(addDays(start, -daysIn(window)), start, grain);
}

/** The same days a year earlier. */
export function yearAgoWindow(window: { start: string; end: string }, grain: Grain): InvestigationWindow {
  return windowOf(addMonths(parseDay(window.start)!, -12), addMonths(parseDay(window.end)!, -12), grain);
}

/**
 * The latest period of `grain` that the data covers completely. `observedThrough`
 * is the exclusive day after the last day with data.
 */
export function latestCompleteWindow(observedThrough: string, grain: Grain): InvestigationWindow {
  const lastDay = addDays(parseDay(observedThrough)!, -1);
  const start = startOfGrain(lastDay, grain);
  const end = addGrains(start, grain, 1);
  if (formatDay(end) <= observedThrough) return windowOf(start, end, grain);
  return windowOf(addGrains(start, grain, -1), start, grain);
}
