/**
 * FRAMING AN INVESTIGATION from a reading: the metric, the date field it is
 * measured over, the grain, the filters every query keeps, and the periods to
 * compare. Pure: the only data it reads is the vocabulary and, when given, the
 * day the data runs through.
 */
import type { AnalyticalIntentV1, Grain, IntentMeasure, IntentPredicate } from '../../ask-pipeline/intent.js';
import type { VocabularyEntry, VocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import type { InvestigationFrameV1, InvestigationMetric, InvestigationWindow } from './types.js';
import { addDays, dayOf, formatDay, grainOfWindow, latestCompleteWindow, parseDay, priorWindow, windowOf, yearAgoWindow } from './windows.js';

export interface InvestigationFramePlan {
  reading: string;
  lane: 'governed' | 'ai';
  metric: InvestigationMetric;
  timeRef: string;
  grain: Grain;
  stated?: { current: { start: string; end: string }; prior?: { start: string; end: string }; expression?: string };
  baseFilters: IntentPredicate[];
  shape: 'change' | 'level';
}

export type InvestigationFramePlanResult =
  | { status: 'planned'; plan: InvestigationFramePlan }
  | { status: 'clarify'; question: string; options: string[] }
  | { status: 'not_investigable'; reason: string };

const NON_ADDITIVE = new Set(['avg', 'median', 'count_distinct', 'min', 'max']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function entryLabel(vocabulary: VocabularyIndex, ref: string, fallback?: string): string {
  const entry = vocabulary.get(ref);
  const name = entry?.label ?? entry?.name ?? fallback ?? ref.replace(/^[a-z_]+:/i, '').split('.').pop() ?? ref;
  return name.replace(/_/g, ' ');
}

const isTimeRef = (vocabulary: VocabularyIndex, ref: string, timeRef?: string) => ref === timeRef || Boolean(vocabulary.get(ref)?.roles.includes('time'));

function windowFromPredicates(vocabulary: VocabularyIndex, predicates: IntentPredicate[] | undefined, timeRef?: string): { start: string; end: string; ref: string } | undefined {
  const onTime = (predicates ?? []).filter((predicate) => isTimeRef(vocabulary, predicate.ref, timeRef));
  const from = onTime.find((predicate) => predicate.op === 'gte');
  const to = onTime.find((predicate) => predicate.op === 'lt');
  const start = from ? String(from.values[0]).slice(0, 10) : '';
  const end = to ? String(to.values[0]).slice(0, 10) : '';
  return ISO_DAY.test(start) && ISO_DAY.test(end) && end > start ? { start, end, ref: from!.ref } : undefined;
}

/** A ratio's parts from a derived metric written `a / b` over two named inputs. */
function ratioOfEntry(entry: VocabularyEntry | undefined): InvestigationMetric['ratio'] | undefined {
  const inputs = entry?.derived?.inputs ?? [];
  const parts = /^\s*([A-Za-z_]\w*)\s*\/\s*([A-Za-z_]\w*)\s*$/.exec(entry?.derived?.expr ?? '');
  if (!parts || inputs.length !== 2) return undefined;
  const numerator = inputs.find((input) => input.alias === parts[1]);
  const denominator = inputs.find((input) => input.alias === parts[2]);
  return numerator && denominator ? { numeratorRef: numerator.ref, denominatorRef: denominator.ref } : undefined;
}

function metricOf(vocabulary: VocabularyIndex, measure: IntentMeasure): InvestigationMetric {
  const entry = vocabulary.get(measure.ref) ?? vocabulary.resolve(measure.ref);
  const ref = entry?.ref ?? measure.ref;
  const label = entryLabel(vocabulary, ref, measure.alias);
  if (measure.derived) {
    return {
      ref, label, additivity: 'ratio',
      ratio: {
        numeratorRef: measure.derived.numerator, denominatorRef: measure.derived.denominator,
        ...(measure.derived.numeratorAggregation ? { numeratorAggregation: measure.derived.numeratorAggregation } : {}),
        ...(measure.derived.denominatorAggregation ? { denominatorAggregation: measure.derived.denominatorAggregation } : {}),
      },
    };
  }
  const ratio = ratioOfEntry(entry);
  if (ratio) return { ref, label, additivity: 'ratio', ratio };
  const aggregation = measure.aggregation ?? (entry?.aggregation as IntentMeasure['aggregation'] | undefined);
  const nonAdditive = NON_ADDITIVE.has(aggregation ?? '') || entry?.metricType === 'ratio';
  return { ref, label, additivity: nonAdditive ? 'non_additive' : 'additive', ...(measure.aggregation ? { aggregation: measure.aggregation } : {}) };
}

function timeRefFor(vocabulary: VocabularyIndex, reading: AnalyticalIntentV1, measure: IntentMeasure, metricRef: string): string | undefined {
  const timeGroup = reading.groupBy.find((group) => group.role === 'time');
  const scoped = windowFromPredicates(vocabulary, measure.scope)?.ref ?? windowFromPredicates(vocabulary, reading.filters)?.ref;
  const entry = vocabulary.get(metricRef);
  const sameModel = entry?.model
    ? vocabulary.entries.find((candidate) => (candidate.kind === 'dimension' || candidate.kind === 'column') && candidate.roles.includes('time') && candidate.model === entry.model)?.ref
    : undefined;
  return reading.time?.ref ?? timeGroup?.ref ?? scoped ?? entry?.timeRef ?? sameModel;
}

/** Frame the reading: what is measured, over which date field, at which grain, under which filters. */
export function planInvestigationFrame(input: { reading: AnalyticalIntentV1; vocabulary: VocabularyIndex; lane: 'governed' | 'ai' }): InvestigationFramePlanResult {
  const { reading, vocabulary } = input;
  if (reading.kind !== 'analytics') return { status: 'not_investigable', reason: 'Research investigates how a measure changed over time; this question is not a question about data.' };
  const byAlias = (alias: string) => reading.measures.find((measure) => measure.alias === alias);
  const changeMeasure = reading.measures.find((measure) => measure.change);
  const base = changeMeasure ? byAlias(changeMeasure.change!.base) : undefined;
  const comparison = changeMeasure ? byAlias(changeMeasure.change!.comparison) : undefined;
  const primary = comparison ?? reading.measures.find((measure) => !measure.change);
  if (!primary) {
    const options = [...new Set(vocabulary.lookup(reading.reading, { limit: 8, minScore: 0.4 })
      .map((hit) => hit.entry)
      .filter((entry) => entry.kind === 'metric' || entry.kind === 'measure')
      .map((entry) => entry.ref))].slice(0, 4);
    return { status: 'clarify', question: 'Research needs a measure to investigate. Which one should it look at?', options };
  }
  const metric = metricOf(vocabulary, primary);
  const timeRef = timeRefFor(vocabulary, reading, primary, metric.ref);
  if (!timeRef) return { status: 'not_investigable', reason: `Research compares periods, and no date field is known for ${metric.label}.` };
  const currentStated = comparison && base
    ? windowFromPredicates(vocabulary, comparison.scope, timeRef)
    : (reading.time?.window && ISO_DAY.test(reading.time.window.start.slice(0, 10)) && ISO_DAY.test(reading.time.window.end.slice(0, 10))
      ? { start: reading.time.window.start.slice(0, 10), end: reading.time.window.end.slice(0, 10), ref: timeRef }
      : windowFromPredicates(vocabulary, primary.scope, timeRef) ?? windowFromPredicates(vocabulary, reading.filters, timeRef));
  const priorStated = comparison && base ? windowFromPredicates(vocabulary, base.scope, timeRef) : undefined;
  const timeGroup = reading.groupBy.find((group) => group.role === 'time');
  const grain = reading.time?.grain ?? timeGroup?.grain ?? (currentStated ? grainOfWindow(currentStated) : undefined) ?? 'month';
  // Every query keeps the reading's restrictions, and the measure's own scope
  // ("beverage revenue"), except the dates the periods replace.
  const keep = (predicate: IntentPredicate) => predicate.on !== 'aggregate' && !isTimeRef(vocabulary, predicate.ref, timeRef);
  const baseFilters = [...reading.filters.filter(keep), ...(primary.scope ?? []).filter(keep)];
  return {
    status: 'planned',
    plan: {
      reading: reading.reading, lane: input.lane, metric, timeRef, grain, baseFilters,
      shape: changeMeasure || priorStated ? 'change' : 'level',
      ...(currentStated ? { stated: { current: { start: currentStated.start, end: currentStated.end }, ...(priorStated ? { prior: { start: priorStated.start, end: priorStated.end } } : {}), ...(reading.time?.window?.expression ? { expression: reading.time.window.expression } : {}) } } : {}),
    },
  };
}

const RELATIVE_WORDS = /\b(last|this|previous|prior|past|recent|current|latest|ytd|mtd|qtd|yesterday|today|ago)\b/i;

/** The periods to compare, from what the question stated and what the data covers. */
export function investigationWindowsFor(plan: InvestigationFramePlan, input: { observedThrough?: string; now: Date; fromSourceRun?: boolean }): Pick<InvestigationFrameV1, 'windows' | 'windowBasis' | 'observedThrough' | 'notes'> {
  const { grain } = plan;
  const notes: string[] = [];
  let current: InvestigationWindow;
  let basis: InvestigationFrameV1['windowBasis'];
  const lastDataDay = input.observedThrough ? formatDay(addDays(parseDay(input.observedThrough)!, -1)) : undefined;
  if (plan.stated) {
    const stated = windowOf(parseDay(plan.stated.current.start)!, parseDay(plan.stated.current.end)!, grain);
    const relative = Boolean(plan.stated.expression && RELATIVE_WORDS.test(plan.stated.expression) && !/\b\d{4}\b/.test(plan.stated.expression));
    if (input.observedThrough && stated.start >= input.observedThrough && relative) {
      current = latestCompleteWindow(input.observedThrough, grain);
      basis = 'shifted_to_data';
      notes.push(`The question asked about ${stated.label}, but the data runs through ${lastDataDay}, so this investigates ${current.label}, the latest complete ${grain}.`);
    } else {
      current = stated;
      basis = input.fromSourceRun ? 'source_run' : 'stated';
    }
  } else if (input.observedThrough) {
    current = latestCompleteWindow(input.observedThrough, grain);
    basis = 'latest_complete';
  } else {
    current = latestCompleteWindow(formatDay(dayOf(input.now)), grain);
    basis = 'latest_complete';
    notes.push(`How far the data runs could not be read, so the latest complete ${grain} is taken from today's date.`);
  }
  const prior = plan.stated?.prior && basis !== 'shifted_to_data'
    ? windowOf(parseDay(plan.stated.prior.start)!, parseDay(plan.stated.prior.end)!, grain)
    : priorWindow(current, grain);
  return {
    windows: { current, prior, yearAgo: yearAgoWindow(current, grain), yearAgoPrior: yearAgoWindow(prior, grain) },
    windowBasis: basis,
    ...(input.observedThrough ? { observedThrough: input.observedThrough } : {}),
    notes,
  };
}

/** Whether the frame needs to know how far the data runs before its windows can be set. */
export function frameNeedsFreshness(plan: InvestigationFramePlan): boolean {
  return !plan.stated || Boolean(plan.stated.expression && RELATIVE_WORDS.test(plan.stated.expression) && !/\b\d{4}\b/.test(plan.stated.expression));
}
