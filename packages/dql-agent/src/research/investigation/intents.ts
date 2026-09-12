/**
 * THE READINGS AN INVESTIGATION RUNS. Each program asks for the frame's metric
 * over a window, grouped as it needs; nothing here writes SQL. The pipeline
 * turns each reading into a certified block, a semantic compile or, where the
 * frame allows it, AI-written SQL.
 */
import type { AnalyticalIntentV1, Grain, IntentGroupBy, IntentMeasure, IntentPredicate, IntentShape } from '../../ask-pipeline/intent.js';
import type { ExecutedRows, ResultColumnMeta } from '../../ask-pipeline/execute.js';
import type { VocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import { parseExactDecimal, type ExactDecimal } from '../../analytical-execution-graph.js';
import type { InvestigationFrameV1 } from './types.js';
import { formatDay, parseDay } from './windows.js';

export type InvestigationFrameCore = Pick<InvestigationFrameV1, 'metric' | 'timeRef' | 'grain' | 'baseFilters'>;

const aggregationFor = (ref: string, aggregation: string | undefined): Pick<IntentMeasure, 'aggregation'> =>
  (ref.startsWith('column:') ? { aggregation: (aggregation ?? 'sum') as IntentMeasure['aggregation'] } : {});

export function metricMeasures(frame: InvestigationFrameCore): IntentMeasure[] {
  const { metric } = frame;
  if (metric.ratio) {
    return [
      { ref: metric.ratio.numeratorRef, alias: 'numerator', ...aggregationFor(metric.ratio.numeratorRef, metric.ratio.numeratorAggregation) },
      { ref: metric.ratio.denominatorRef, alias: 'denominator', ...aggregationFor(metric.ratio.denominatorRef, metric.ratio.denominatorAggregation) },
    ];
  }
  return [{ ref: metric.ref, alias: 'value', ...aggregationFor(metric.ref, metric.aggregation) }];
}

export function investigationIntent(frame: InvestigationFrameCore, input: {
  reading: string;
  window?: { start: string; end: string };
  timeGrain?: Grain;
  groupBy?: IntentGroupBy[];
  filters?: IntentPredicate[];
  shape: IntentShape;
}): AnalyticalIntentV1 {
  return {
    version: 1, kind: 'analytics', reading: input.reading,
    measures: metricMeasures(frame),
    groupBy: input.groupBy ?? [],
    display: [],
    filters: [...frame.baseFilters, ...(input.filters ?? [])],
    time: { ref: frame.timeRef, grain: input.timeGrain ?? frame.grain, ...(input.window ? { window: { start: input.window.start, end: input.window.end } } : {}) },
    expectedShape: input.shape,
    unresolved: [],
    provenance: {},
  };
}

export const timeBucket = (frame: InvestigationFrameCore, grain: Grain = frame.grain): IntentGroupBy => ({ ref: frame.timeRef, role: 'time', grain });

export interface ResultColumns { value?: string; numerator?: string; denominator?: string; time?: string; dimension?: string; valueMeta?: ResultColumnMeta }

const nameOf = (vocabulary: VocabularyIndex, ref: string) => (vocabulary.get(ref)?.name ?? ref.replace(/^[a-z_]+:/i, '').split('.').pop() ?? ref).toLowerCase();

/**
 * Which result column holds what. A column is recognised by the ref the
 * pipeline recorded for it, its alias, or its name; a column that cannot be
 * recognised is reported, never guessed.
 */
export function resultColumns(result: Pick<ExecutedRows, 'columns'> & { columnsMeta?: ResultColumnMeta[] }, frame: InvestigationFrameCore, vocabulary: VocabularyIndex, options: { time?: boolean; dimensionRef?: string } = {}): { ok: true; columns: ResultColumns } | { ok: false; reason: string } {
  const metas = result.columnsMeta ?? [];
  const lower = (value: string) => value.toLowerCase();
  const byRefOrName = (ref: string, alias?: string) => metas.find((meta) => meta.ref === ref)?.name
    ?? result.columns.find((column) => (alias && lower(column) === alias) || lower(column) === nameOf(vocabulary, ref) || lower(column).endsWith(`__${nameOf(vocabulary, ref)}`));
  const columns: ResultColumns = {};
  if (options.time) {
    columns.time = metas.find((meta) => meta.ref === frame.timeRef)?.name
      ?? metas.find((meta) => meta.kind === 'date')?.name
      ?? result.columns.find((column) => lower(column) === nameOf(vocabulary, frame.timeRef) || lower(column).startsWith(`${nameOf(vocabulary, frame.timeRef)}__`) || lower(column).includes('metric_time'));
    if (!columns.time) return { ok: false, reason: 'the result does not show which column holds the period' };
  }
  if (options.dimensionRef) {
    columns.dimension = byRefOrName(options.dimensionRef);
    if (!columns.dimension) return { ok: false, reason: `the result does not show which column holds ${nameOf(vocabulary, options.dimensionRef)}` };
  }
  const rest = result.columns.filter((column) => column !== columns.time && column !== columns.dimension);
  if (frame.metric.ratio) {
    columns.numerator = byRefOrName(frame.metric.ratio.numeratorRef, 'numerator');
    columns.denominator = byRefOrName(frame.metric.ratio.denominatorRef, 'denominator');
    if (!columns.numerator || !columns.denominator) return { ok: false, reason: 'the result does not show the two parts of the ratio' };
  } else {
    columns.value = byRefOrName(frame.metric.ref, 'value') ?? (rest.length === 1 ? rest[0] : undefined);
    if (!columns.value) return { ok: false, reason: `the result does not show which column holds ${frame.metric.label}` };
    const meta = metas.find((item) => item.name === columns.value);
    if (meta) columns.valueMeta = meta;
  }
  return { ok: true, columns };
}

export const decimalOf = (value: unknown): ExactDecimal | undefined => (value === null || value === undefined || value === '' ? undefined : parseExactDecimal(value));

/** The calendar day a period cell names, whatever form the warehouse returned it in. */
export const bucketDayOf = (value: unknown): string | undefined => {
  const day = parseDay(value);
  return day ? formatDay(day) : undefined;
};
