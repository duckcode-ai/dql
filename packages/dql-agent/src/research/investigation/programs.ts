/**
 * THE FIRST PROGRAMS: how far the data runs, what the metric was in each
 * period, and whether each period is fully covered by data. Every figure is
 * an exact decimal taken from a result the pipeline produced.
 */
import type { ResultColumnMeta } from '../../ask-pipeline/execute.js';
import { divideDecimal, parseExactDecimal, sumDecimals, type ExactDecimal } from '../../analytical-execution-graph.js';
import type { InvestigationFramePlan } from './frame.js';
import { bucketDayOf, decimalOf, investigationIntent, resultColumns, timeBucket, type InvestigationFrameCore } from './intents.js';
import { runInvestigationQuery, type InvestigationRun } from './context.js';
import type { InvestigationFrameV1, InvestigationWindow } from './types.js';
import { addDays, addMonths, bucketsIn, daysIn, formatDay, parseDay } from './windows.js';

const isZero = (value: ExactDecimal | undefined) => value === undefined || value.coefficient === 0n;

const rowHasValue = (row: Record<string, unknown>, columns: { value?: string; denominator?: string }): boolean =>
  columns.denominator ? !isZero(decimalOf(row[columns.denominator])) : !isZero(decimalOf(row[columns.value!]));

/**
 * The exclusive day after the last day the metric has data, from a monthly
 * series and then the days of its last month. When the days cannot be read,
 * the last month with data is treated as incomplete (`approximate`): a partial
 * month compared with a full one looks like a drop.
 */
export async function observeFreshness(run: InvestigationRun, plan: InvestigationFramePlan): Promise<{ observedThrough?: string; approximate?: boolean; queryIds: string[] }> {
  const core: InvestigationFrameCore = { metric: plan.metric, timeRef: plan.timeRef, grain: plan.grain, baseFilters: plan.baseFilters };
  const vocabulary = run.runtime.vocabulary();
  const allowAiSql = plan.lane === 'ai';
  const queryIds: string[] = [];
  const lastDay = (rows: { columns: string[]; rows: Array<Record<string, unknown>>; columnsMeta?: ResultColumnMeta[] }): string | undefined => {
    const picked = resultColumns(rows, core, vocabulary, { time: true });
    if (!picked.ok) return undefined;
    let last: string | undefined;
    for (const row of rows.rows) {
      const day = bucketDayOf(row[picked.columns.time!]);
      if (day && rowHasValue(row, picked.columns) && (!last || day > last)) last = day;
    }
    return last;
  };
  const monthly = await runInvestigationQuery(run, {
    purpose: 'freshness', programId: 'freshness', allowAiSql, label: `${plan.metric.label} by month, to find where the data ends`,
    intent: investigationIntent(core, { reading: `${plan.metric.label} by month over all periods.`, timeGrain: 'month', groupBy: [timeBucket(core, 'month')], shape: 'trend' }),
  });
  if (monthly.status === 'answered' || monthly.status === 'no_rows' || monthly.status === 'unanswered') queryIds.push(monthly.id);
  if (monthly.status !== 'answered') return { queryIds };
  const lastMonth = lastDay(monthly.rows);
  if (!lastMonth) return { queryIds };
  const monthStart = parseDay(lastMonth)!;
  const monthEnd = formatDay(addMonths(monthStart, 1));
  const daily = await runInvestigationQuery(run, {
    purpose: 'freshness', programId: 'freshness', allowAiSql, label: `${plan.metric.label} by day in the last month with data`,
    intent: investigationIntent(core, { reading: `${plan.metric.label} by day from ${lastMonth} to ${monthEnd}.`, window: { start: lastMonth, end: monthEnd }, timeGrain: 'day', groupBy: [timeBucket(core, 'day')], shape: 'trend' }),
  });
  if (daily.status === 'answered' || daily.status === 'no_rows' || daily.status === 'unanswered') queryIds.push(daily.id);
  const last = daily.status === 'answered' ? lastDay(daily.rows) : undefined;
  return last ? { observedThrough: formatDay(addDays(parseDay(last)!, 1)), queryIds } : { observedThrough: lastMonth, approximate: true, queryIds };
}

export interface HeadlineFigures {
  current?: ExactDecimal;
  prior?: ExactDecimal;
  yearAgo?: ExactDecimal;
  yearAgoPrior?: ExactDecimal;
  valueMeta?: ResultColumnMeta;
  queryIds: string[];
  aiSql: boolean;
  /** Neither period has any row. */
  noData: boolean;
  /** Why the headline could not be measured, in the pipeline's words. */
  failure?: string;
  /** The run was stopped before every period was measured. */
  stopped?: boolean;
  series?: { columns: string[]; rows: Array<Record<string, unknown>>; columnsMeta?: ResultColumnMeta[] };
}

type WindowKey = 'current' | 'prior' | 'yearAgo' | 'yearAgoPrior';
const WINDOW_KEYS: WindowKey[] = ['current', 'prior', 'yearAgo', 'yearAgoPrior'];

/** The metric in the current period, the one before, and the same two a year earlier. */
export async function measureHeadline(run: InvestigationRun, frame: InvestigationFrameV1): Promise<HeadlineFigures> {
  const vocabulary = run.runtime.vocabulary();
  const { windows, grain, metric } = frame;
  const figures: HeadlineFigures = { queryIds: [], aiSql: false, noData: false };
  const seen = new Set<WindowKey>();
  const valueOf = (rows: Array<Record<string, unknown>>, columns: { value?: string; numerator?: string; denominator?: string }): ExactDecimal | undefined => {
    if (metric.ratio) {
      const numerator = sumDecimals(rows.map((row) => decimalOf(row[columns.numerator!])).filter((value): value is ExactDecimal => Boolean(value)));
      const denominator = sumDecimals(rows.map((row) => decimalOf(row[columns.denominator!])).filter((value): value is ExactDecimal => Boolean(value)));
      const ratio = divideDecimal(numerator, denominator, 12);
      return ratio === undefined ? undefined : parseExactDecimal(ratio);
    }
    const values = rows.map((row) => decimalOf(row[columns.value!])).filter((value): value is ExactDecimal => Boolean(value));
    if (metric.additivity === 'non_additive') return values.length === 1 ? values[0] : undefined;
    return sumDecimals(values);
  };

  const bucketed = WINDOW_KEYS.every((key) => bucketsIn(windows[key], grain));
  if (bucketed) {
    const span = { start: windows.yearAgoPrior.start, end: windows.current.end };
    const result = await runInvestigationQuery(run, {
      purpose: 'headline', programId: 'headline', allowAiSql: true,
      label: `${metric.label} by ${grain} from ${windows.yearAgoPrior.label} to ${windows.current.label}`,
      intent: investigationIntent(frame, { reading: `${metric.label} by ${grain} from ${windows.yearAgoPrior.label} to ${windows.current.label}.`, window: span, groupBy: [timeBucket(frame)], shape: 'trend' }),
    });
    if (result.status !== 'stopped') figures.queryIds.push(result.id);
    if (result.status === 'answered') {
      figures.aiSql ||= result.aiSql;
      const picked = resultColumns(result.rows, frame, vocabulary, { time: true });
      if (picked.ok) {
        figures.valueMeta = picked.columns.valueMeta;
        figures.series = { columns: result.rows.columns, rows: result.rows.rows, ...(result.rows.columnsMeta ? { columnsMeta: result.rows.columnsMeta } : {}) };
        const inWindow = (window: InvestigationWindow) => result.rows.rows.filter((row) => {
          const day = bucketDayOf(row[picked.columns.time!]);
          return day !== undefined && day >= window.start && day < window.end;
        });
        for (const key of WINDOW_KEYS) {
          const rows = inWindow(windows[key]);
          // A period before the data starts is unknown, not zero; the two
          // compared periods are zero when the series has data but not there.
          if (rows.length === 0 && (key === 'yearAgo' || key === 'yearAgoPrior' || metric.additivity !== 'additive')) continue;
          const value = valueOf(rows, picked.columns);
          if (value !== undefined) { figures[key] = value; seen.add(key); }
        }
        if (inWindow(windows.current).length === 0 && inWindow(windows.prior).length === 0) figures.noData = true;
      } else {
        figures.failure = picked.reason;
      }
    } else if (result.status === 'no_rows') {
      figures.noData = true;
      return figures;
    } else if (result.status === 'unanswered') {
      figures.failure = result.message;
    } else {
      figures.stopped = true;
      return figures;
    }
  }

  // One period at a time, for windows the series could not settle.
  for (const key of WINDOW_KEYS) {
    if (seen.has(key) || figures.noData) continue;
    if ((key === 'yearAgo' || key === 'yearAgoPrior') && (!seen.has('current') || !seen.has('prior'))) continue;
    const window = windows[key];
    const result = await runInvestigationQuery(run, {
      purpose: 'headline', programId: 'headline', allowAiSql: true, label: `${metric.label} in ${window.label}`,
      intent: investigationIntent(frame, { reading: `${metric.label} in ${window.label}.`, window, shape: 'scalar' }),
    });
    if (result.status === 'stopped') { figures.stopped = true; break; }
    figures.queryIds.push(result.id);
    if (result.status === 'answered') {
      figures.aiSql ||= result.aiSql;
      const picked = resultColumns(result.rows, frame, vocabulary);
      if (!picked.ok) { figures.failure ??= picked.reason; continue; }
      figures.valueMeta ??= picked.columns.valueMeta;
      const value = valueOf(result.rows.rows, picked.columns);
      if (value !== undefined) { figures[key] = value; seen.add(key); }
    } else if (result.status === 'no_rows') {
      if ((key === 'current' || key === 'prior') && metric.additivity === 'additive') { figures[key] = { coefficient: 0n, scale: 0 }; seen.add(key); }
    } else if (key === 'current' || key === 'prior') {
      figures.failure ??= result.message;
    }
  }
  if (figures.current === undefined && figures.prior === undefined && !figures.failure && !figures.stopped) figures.noData = true;
  if (figures.current !== undefined && figures.prior !== undefined && isZero(figures.current) && isZero(figures.prior) && metric.additivity === 'additive') figures.noData = true;
  return figures;
}

export interface CoverageFigures { current?: number; prior?: number; queryIds: string[] }

/** The share of each period's days that have data. */
export async function checkCoverage(run: InvestigationRun, frame: InvestigationFrameV1): Promise<CoverageFigures> {
  const coverage: CoverageFigures = { queryIds: [] };
  if (frame.grain === 'day') return coverage;
  const { current, prior } = frame.windows;
  const result = await runInvestigationQuery(run, {
    purpose: 'coverage', programId: 'coverage', allowAiSql: frame.lane === 'ai', label: `${frame.metric.label} by day across both periods`,
    intent: investigationIntent(frame, { reading: `${frame.metric.label} by day from ${prior.label} to ${current.label}.`, window: { start: prior.start, end: current.end }, timeGrain: 'day', groupBy: [timeBucket(frame, 'day')], shape: 'trend' }),
  });
  if (result.status === 'stopped') return coverage;
  coverage.queryIds.push(result.id);
  if (result.status === 'no_rows') return { ...coverage, current: 0, prior: 0 };
  if (result.status !== 'answered' || result.rows.truncated) return coverage;
  const picked = resultColumns(result.rows, frame, run.runtime.vocabulary(), { time: true });
  if (!picked.ok) return coverage;
  const days = (window: InvestigationWindow) => new Set(result.rows.rows
    .filter((row) => rowHasValue(row, picked.columns))
    .map((row) => bucketDayOf(row[picked.columns.time!]))
    .filter((day): day is string => day !== undefined && day >= window.start && day < window.end)).size;
  return { ...coverage, current: days(current) / Math.max(1, daysIn(current)), prior: days(prior) / Math.max(1, daysIn(prior)) };
}
