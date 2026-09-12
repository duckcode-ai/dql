/**
 * THE REPORT, WRITTEN FROM THE FACTS. Every number in the text is a fact the
 * programs computed, and the words describe contributions and comparisons,
 * never causes: the text passes the same check an AI narration would.
 */
import type { ResultColumnMeta } from '../../ask-pipeline/execute.js';
import { formatValue } from '../../ask-pipeline/outcomes.js';
import { absDecimal, formatDecimal, percentChange, subtractDecimal, type ExactDecimal } from '../../analytical-execution-graph.js';
import type { AskNarrationFactV1 } from '../../ask-result-narration.js';
import type { CoverageFigures, HeadlineFigures } from './programs.js';
import type {
  InvestigationCaveatV1, InvestigationContextItemV1, InvestigationFrameV1, InvestigationNumber, InvestigationQueryV1, InvestigationReportV1,
} from './types.js';
import { lastDayBefore } from './windows.js';

/** A change smaller than this, against the prior period and a year earlier, is not called a change. */
export const MATERIAL_CHANGE_PCT = 2;
/** For a share-like ratio, the same threshold in percentage points. */
export const MATERIAL_CHANGE_POINTS = 1;

const numberOf = (value: ExactDecimal) => Number(formatDecimal(value));
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const PERCENT_META: ResultColumnMeta = { name: 'value', kind: 'percent', unit: 'fraction' };

export function investigationNumber(value: ExactDecimal, meta?: ResultColumnMeta): InvestigationNumber {
  return { value: formatDecimal(value), formatted: formatValue(numberOf(value), meta) };
}

const pctOf = (delta: ExactDecimal, base: ExactDecimal | undefined): string | undefined =>
  (base && base.coefficient !== 0n ? percentChange(delta, absDecimal(base), 1) : undefined);

export function buildInvestigationReport(input: {
  question: string;
  frame: InvestigationFrameV1;
  headline: HeadlineFigures;
  coverage?: CoverageFigures;
  caveats: InvestigationCaveatV1[];
  queries: InvestigationQueryV1[];
  context: InvestigationContextItemV1[];
  stoppedBy?: 'cancelled' | 'deadline' | 'budget';
}): InvestigationReportV1 {
  const { frame, headline } = input;
  const { current: currentWindow, prior: priorWindow, yearAgo: yearAgoWindow } = frame.windows;
  const label = frame.metric.label;
  const facts: AskNarrationFactV1[] = [];
  const caveats = [...input.caveats];
  const reasons: string[] = [];
  let level: 'high' | 'medium' | 'low' = 'high';
  const cap = (next: 'medium' | 'low', reason: string) => {
    if (next === 'low') level = 'low';
    else if (level === 'high') level = 'medium';
    reasons.push(reason);
  };

  // A ratio whose every figure is a fraction (a share, a rate) reads as a
  // percent and changes in points; any other ratio (revenue per order) reads
  // as a number and changes in percent.
  const measuredValues = [headline.current, headline.prior, headline.yearAgo].filter((value): value is ExactDecimal => value !== undefined);
  const percentLike = Boolean(frame.metric.ratio) && !headline.valueMeta && measuredValues.length > 0
    && measuredValues.every((value) => numberOf(value) >= 0 && numberOf(value) <= 1);
  const meta = headline.valueMeta ?? (percentLike ? PERCENT_META : undefined);

  const measured = headline.current !== undefined && headline.prior !== undefined;
  const incomplete = !measured && !headline.noData && !headline.failure && Boolean(input.stoppedBy);
  const noData = !incomplete && (headline.noData || !measured);
  const delta = measured ? subtractDecimal(headline.current!, headline.prior!) : undefined;
  const yoyDelta = headline.current !== undefined && headline.yearAgo !== undefined ? subtractDecimal(headline.current, headline.yearAgo) : undefined;
  const pointsOf = (value: ExactDecimal | undefined) => (value && percentLike ? Number((numberOf(value) * 100).toFixed(1)) : undefined);
  const points = pointsOf(delta);
  const yoyPoints = pointsOf(yoyDelta);
  const pct = delta && !percentLike ? pctOf(delta, headline.prior) : undefined;
  const yoyPct = yoyDelta && !percentLike ? pctOf(yoyDelta, headline.yearAgo) : undefined;
  const material = delta !== undefined && (
    percentLike ? Math.abs(points!) >= MATERIAL_CHANGE_POINTS || (yoyPoints !== undefined && Math.abs(yoyPoints) >= MATERIAL_CHANGE_POINTS)
      : pct === undefined ? delta.coefficient !== 0n
      : Math.abs(Number(pct)) >= MATERIAL_CHANGE_PCT || (yoyPct !== undefined && Math.abs(Number(yoyPct)) >= MATERIAL_CHANGE_PCT)
  );
  const verdict: InvestigationReportV1['headline']['verdict'] = incomplete ? 'incomplete' : noData ? 'no_data' : material ? 'change' : 'no_material_change';

  const format = (value: ExactDecimal) => formatValue(numberOf(value), meta);
  const magnitude = (value: ExactDecimal) => (percentLike ? `${Math.abs(pointsOf(value)!).toFixed(1)} points` : formatValue(numberOf(absDecimal(value)), meta));
  const percentWords = (value: string | undefined, signed: boolean) => (value === undefined ? '' : ` (${signed && Number(value) >= 0 ? '+' : ''}${(signed ? Number(value) : Math.abs(Number(value))).toFixed(1)}%)`);
  let text: string;
  if (incomplete) {
    text = `Research stopped before it measured ${label} in ${currentWindow.label} and ${priorWindow.label}.`;
  } else if (noData) {
    text = headline.failure
      ? `Research could not measure ${label} for ${currentWindow.label} and ${priorWindow.label}: ${headline.failure.replace(/[.\s]+$/, '')}.`
      : `No ${label} was recorded for ${currentWindow.label} or ${priorWindow.label}.`;
  } else {
    const direction = delta!.coefficient < 0n ? 'fell' : 'rose';
    text = verdict === 'change'
      ? `${capitalize(label)} ${direction} ${magnitude(delta!)}${percentWords(pct, false)} in ${currentWindow.label} compared with ${priorWindow.label}: ${format(headline.current!)} against ${format(headline.prior!)}.`
      : `${capitalize(label)} was steady in ${currentWindow.label}: ${format(headline.current!)} against ${format(headline.prior!)} in ${priorWindow.label}${percentWords(pct, true)}.`;
    if (yoyDelta && headline.yearAgo !== undefined) {
      text += ` Compared with ${yearAgoWindow.label} (${format(headline.yearAgo)}), it was ${yoyDelta.coefficient < 0n ? 'down' : 'up'} ${magnitude(yoyDelta)}${percentWords(yoyPct, false)}.`;
    }
  }

  const figure = (key: string, value: ExactDecimal | undefined): Record<string, number> => {
    if (value === undefined) return {};
    const number = numberOf(value);
    // A share-like value is also stated as a percent; the field name tells the
    // narration check to accept that form.
    return { [key]: number, ...(percentLike ? { [`${key}Percent`]: number } : {}) };
  };
  const signedAndAbsolute = (key: string, value: number | undefined): Record<string, number> =>
    (value === undefined ? {} : { [key]: value, [`${key}Abs`]: Math.abs(value) });
  facts.push({
    factId: 'f-headline', kind: 'headline_change',
    values: {
      ...figure('current', headline.current),
      ...figure('prior', headline.prior),
      ...figure('yearAgo', headline.yearAgo),
      ...signedAndAbsolute('delta', delta && numberOf(delta)),
      ...signedAndAbsolute('yoyDelta', yoyDelta && numberOf(yoyDelta)),
      ...signedAndAbsolute('pct', pct === undefined ? undefined : Number(pct)),
      ...signedAndAbsolute('yoyPct', yoyPct === undefined ? undefined : Number(yoyPct)),
      ...signedAndAbsolute('points', points),
      ...signedAndAbsolute('yoyPoints', yoyPoints),
    },
    details: {
      currentPeriod: currentWindow.label, priorPeriod: priorWindow.label, yearAgoPeriod: yearAgoWindow.label,
      ...(headline.failure ? { failure: headline.failure } : {}),
      queryIds: headline.queryIds.join(','),
    },
  });

  // What limits the figures, as caveats and as caps on confidence.
  if (headline.aiSql) {
    const governedFallback = frame.lane === 'governed';
    caveats.push({ code: 'ai_sql', text: governedFallback ? 'The governed metric could not be computed here, so the figures come from SQL the AI wrote; review it before relying on them.' : 'The figures come from SQL the AI wrote from the tables; review it before relying on them.', queryIds: headline.queryIds });
    cap(governedFallback ? 'low' : 'medium', governedFallback ? 'the governed metric could not be computed, so AI-written SQL was used' : 'the figures come from AI-written SQL');
  }
  if (input.coverage?.current !== undefined && input.coverage.prior !== undefined && input.coverage.prior >= 0.8 && input.coverage.current < 0.8 * input.coverage.prior) {
    caveats.push({ code: 'coverage_gap', text: `${currentWindow.label} has data on ${Math.round(input.coverage.current * 100)}% of its days against ${Math.round(input.coverage.prior * 100)}% for ${priorWindow.label}; a period with fewer days of data can look like a drop.`, queryIds: input.coverage.queryIds });
    cap('low', 'the current period has data on far fewer days than the prior one');
  }
  if (frame.observedThrough && frame.observedThrough < currentWindow.end) {
    caveats.push({ code: 'partial_period', text: `The data runs only through ${lastDayBefore(frame.observedThrough)}, before ${currentWindow.label} ends.` });
    cap('medium', 'the current period is not complete');
  }
  if (input.stoppedBy) {
    caveats.push({ code: input.stoppedBy, text: input.stoppedBy === 'cancelled' ? 'The investigation was stopped before it finished.' : input.stoppedBy === 'deadline' ? 'The investigation ran out of time before it finished.' : 'The investigation used its query budget before it finished.' });
    cap(incomplete ? 'low' : 'medium', 'the investigation did not finish');
  }
  if (noData) cap('low', headline.failure ? 'the headline could not be measured' : 'there is no data for the periods compared');

  const notes = [...frame.notes, ...caveats.map((caveat) => caveat.text)];
  const headlineText = text;
  if (notes.length) {
    facts.push({ factId: 'f-context', kind: 'investigation_context', details: { notes: notes.join(' ') } });
    text = `${text}\n\n${notes.join(' ')}`;
  }

  return {
    version: 1,
    question: input.question,
    status: incomplete ? 'incomplete' : noData ? 'no_data' : 'answered',
    frame,
    headline: {
      text: headlineText,
      metric: { ref: frame.metric.ref, label },
      ...(headline.current !== undefined ? { current: investigationNumber(headline.current, meta) } : {}),
      ...(headline.prior !== undefined ? { prior: investigationNumber(headline.prior, meta) } : {}),
      ...(delta ? { delta: investigationNumber(delta, meta) } : {}),
      ...(pct ? { pct } : {}),
      ...(headline.yearAgo !== undefined ? { yearAgo: investigationNumber(headline.yearAgo, meta) } : {}),
      ...(yoyDelta ? { yoyDelta: investigationNumber(yoyDelta, meta) } : {}),
      ...(yoyPct ? { yoyPct } : {}),
      verdict,
      factIds: ['f-headline'],
      queryIds: headline.queryIds,
    },
    drivers: [],
    ruledOut: [],
    inconclusive: [],
    notInvestigated: [],
    caveats,
    confidence: { level, reasons },
    ...(headline.series ? { chart: { trend: headline.series } } : {}),
    context: input.context,
    queries: input.queries,
    facts: { factSetId: `investigation:${frame.metric.ref}:${currentWindow.start}`, facts },
    text,
  };
}
