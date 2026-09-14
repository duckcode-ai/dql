/**
 * THE REPORT, WRITTEN FROM THE FACTS. Every number in the text is a fact the
 * programs computed, and the words describe contributions and comparisons,
 * never causes: the text passes the same check an AI narration would.
 */
import type { ResultColumnMeta } from '../../ask-pipeline/execute.js';
import { formatValue } from '../../ask-pipeline/outcomes.js';
import { absDecimal, formatDecimal, percentChange, subtractDecimal, type ExactDecimal } from '../../analytical-execution-graph.js';
import type { AskNarrationFactV1 } from '../../ask-result-narration.js';
import type { DriverFindingsV1, NotInvestigatedReason } from './driver-stage.js';
import type { CoverageFigures, HeadlineFigures } from './programs.js';
import type {
  InvestigationCaveatV1, InvestigationContextItemV1, InvestigationDriverV1, InvestigationFrameV1, InvestigationNumber, InvestigationQueryV1, InvestigationReportV1,
} from './types.js';
import { globalShare, investigationConfidence, seasonalityCheck } from './verdicts.js';
import { lastDayBefore } from './windows.js';

/** A change smaller than this, against the prior period and a year earlier, is not called a change. */
export const MATERIAL_CHANGE_PCT = 2;
/** For a share-like ratio, the same threshold in percentage points. */
export const MATERIAL_CHANGE_POINTS = 1;

const numberOf = (value: ExactDecimal) => Number(formatDecimal(value));
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const PERCENT_META: ResultColumnMeta = { name: 'value', kind: 'percent', unit: 'fraction' };
const LEVEL_RANK = { high: 0, medium: 1, low: 2 } as const;

const NOT_INVESTIGATED_WORDS: Record<NotInvestigatedReason, string> = {
  budget: 'the query budget ran out',
  deadline: 'time ran out',
  cancelled: 'the investigation was stopped',
  truncated_members: 'too many members to account for',
  not_expressible: 'the metric cannot be grouped by it',
  failed: 'the query failed',
  not_started: 'beyond the dimensions one investigation analyses',
};

export function investigationNumber(value: ExactDecimal, meta?: ResultColumnMeta): InvestigationNumber {
  return { value: formatDecimal(value), formatted: formatValue(numberOf(value), meta) };
}

const pctOf = (delta: ExactDecimal, base: ExactDecimal | undefined): string | undefined =>
  (base && base.coefficient !== 0n ? percentChange(delta, absDecimal(base), 1) : undefined);

/** A fraction as a percent with one decimal, the form the text states it in. */
const percentNumber = (value: ExactDecimal) => Number((numberOf(value) * 100).toFixed(1));

export function buildInvestigationReport(input: {
  question: string;
  frame: InvestigationFrameV1;
  headline: HeadlineFigures;
  coverage?: CoverageFigures;
  drivers?: DriverFindingsV1;
  caveats: InvestigationCaveatV1[];
  queries: InvestigationQueryV1[];
  context: InvestigationContextItemV1[];
  stoppedBy?: 'cancelled' | 'deadline' | 'budget';
}): InvestigationReportV1 {
  const { frame, headline, drivers } = input;
  const { current: currentWindow, prior: priorWindow, yearAgo: yearAgoWindow, yearAgoPrior: yearAgoPriorWindow } = frame.windows;
  const label = frame.metric.label;
  // At a yearly grain the period before IS the same period a year earlier: compare once.
  const yearAgo = yearAgoWindow.start === priorWindow.start ? undefined : headline.yearAgo;
  const yearAgoPrior = yearAgoWindow.start === priorWindow.start ? undefined : headline.yearAgoPrior;
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
  const measuredValues = [headline.current, headline.prior, yearAgo].filter((value): value is ExactDecimal => value !== undefined);
  const percentLike = Boolean(frame.metric.ratio) && !headline.valueMeta && measuredValues.length > 0
    && measuredValues.every((value) => numberOf(value) >= 0 && numberOf(value) <= 1);
  const meta = headline.valueMeta ?? (percentLike ? PERCENT_META : undefined);

  const measured = headline.current !== undefined && headline.prior !== undefined;
  const incomplete = !measured && !headline.noData && !headline.failure && Boolean(input.stoppedBy);
  const noData = !incomplete && (headline.noData || !measured);
  const delta = measured ? subtractDecimal(headline.current!, headline.prior!) : undefined;
  const yoyDelta = headline.current !== undefined && yearAgo !== undefined ? subtractDecimal(headline.current, yearAgo) : undefined;
  const pointsOf = (value: ExactDecimal | undefined) => (value && percentLike ? Number((numberOf(value) * 100).toFixed(1)) : undefined);
  const points = pointsOf(delta);
  const yoyPoints = pointsOf(yoyDelta);
  const pct = delta && !percentLike ? pctOf(delta, headline.prior) : undefined;
  const yoyPct = yoyDelta && !percentLike ? pctOf(yoyDelta, yearAgo) : undefined;
  const material = delta !== undefined && (
    percentLike ? Math.abs(points!) >= MATERIAL_CHANGE_POINTS || (yoyPoints !== undefined && Math.abs(yoyPoints) >= MATERIAL_CHANGE_POINTS)
      : pct === undefined ? delta.coefficient !== 0n
      : Math.abs(Number(pct)) >= MATERIAL_CHANGE_PCT || (yoyPct !== undefined && Math.abs(Number(yoyPct)) >= MATERIAL_CHANGE_PCT)
  );
  // The same change from the period before, a year earlier.
  const seasonality = material && yearAgo !== undefined && yearAgoPrior !== undefined
    ? seasonalityCheck({ current: headline.current!, prior: headline.prior!, yearAgo, yearAgoPrior })
    : undefined;
  const verdict: InvestigationReportV1['headline']['verdict'] = incomplete ? 'incomplete' : noData ? 'no_data' : material ? (seasonality?.seasonal ? 'seasonal' : 'change') : 'no_material_change';

  const format = (value: ExactDecimal) => formatValue(numberOf(value), meta);
  const magnitude = (value: ExactDecimal) => (percentLike ? `${Math.abs(pointsOf(value)!).toFixed(1)} points` : formatValue(numberOf(absDecimal(value)), meta));
  const percentWords = (value: string | undefined, signed: boolean) => (value === undefined ? '' : ` (${signed && Number(value) >= 0 ? '+' : ''}${(signed ? Number(value) : Math.abs(Number(value))).toFixed(1)}%)`);
  const signedPercent = (value: string) => `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
  let text: string;
  if (incomplete) {
    text = `Research stopped before it measured ${label} in ${currentWindow.label} and ${priorWindow.label}.`;
  } else if (noData) {
    text = headline.failure
      ? `Research could not measure ${label} for ${currentWindow.label} and ${priorWindow.label}: ${headline.failure.replace(/[.\s]+$/, '')}.`
      : `No ${label} was recorded for ${currentWindow.label} or ${priorWindow.label}.`;
  } else {
    const direction = delta!.coefficient < 0n ? 'fell' : 'rose';
    text = material
      ? `${capitalize(label)} ${direction} ${magnitude(delta!)}${percentWords(pct, false)} in ${currentWindow.label} compared with ${priorWindow.label}: ${format(headline.current!)} against ${format(headline.prior!)}.`
      : `${capitalize(label)} was steady in ${currentWindow.label}: ${format(headline.current!)} against ${format(headline.prior!)} in ${priorWindow.label}${percentWords(pct, true)}.`;
    if (yoyDelta && yearAgo !== undefined) {
      text += ` Compared with ${yearAgoWindow.label} (${format(yearAgo)}), it was ${yoyDelta.coefficient < 0n ? 'down' : 'up'} ${magnitude(yoyDelta)}${percentWords(yoyPct, false)}.`;
    }
    if (seasonality?.seasonal && seasonality.pct !== undefined && seasonality.yearAgoPct !== undefined) {
      text += ` The same change happened a year earlier: ${yearAgoPriorWindow.label} to ${yearAgoWindow.label} moved ${signedPercent(seasonality.yearAgoPct)}, against ${signedPercent(seasonality.pct)} now.`;
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
      ...figure('yearAgo', yearAgo),
      ...signedAndAbsolute('delta', delta && numberOf(delta)),
      ...signedAndAbsolute('yoyDelta', yoyDelta && numberOf(yoyDelta)),
      ...signedAndAbsolute('pct', pct === undefined ? undefined : Number(pct)),
      ...signedAndAbsolute('yoyPct', yoyPct === undefined ? undefined : Number(yoyPct)),
      ...signedAndAbsolute('points', points),
      ...signedAndAbsolute('yoyPoints', yoyPoints),
      ...(seasonality?.pct !== undefined ? signedAndAbsolute('seasonalPct', Number(seasonality.pct)) : {}),
      ...(seasonality?.yearAgoPct !== undefined ? signedAndAbsolute('seasonalYearAgoPct', Number(seasonality.yearAgoPct)) : {}),
    },
    details: {
      currentPeriod: currentWindow.label, priorPeriod: priorWindow.label, yearAgoPeriod: yearAgoWindow.label, yearAgoPriorPeriod: yearAgoPriorWindow.label,
      ...(headline.failure ? { failure: headline.failure } : {}),
      queryIds: headline.queryIds.join(','),
    },
  });

  // Where the change came from.
  const driverRows: InvestigationDriverV1[] = [];
  const ruledOut: InvestigationReportV1['ruledOut'] = [];
  const inconclusive: InvestigationReportV1['inconclusive'] = [];
  const notInvestigated: InvestigationReportV1['notInvestigated'] = [];
  const driverText: string[] = [];
  let mixRate: InvestigationReportV1['mixRate'];
  if (drivers && measured) {
    for (const item of [...drivers.analysed, ...drivers.drilled]) {
      const { dimension, outcome, verdict: dimensionVerdict, parent } = item;
      const within = parent ? ` within ${parent.row.label}` : '';
      if (dimensionVerdict.verdict === 'ruled_out') {
        const sentence = `By ${dimension.label}${within}, the change was spread in line with each member's size.`;
        ruledOut.push({ dimension, maxExcess: String(dimensionVerdict.maxExcess ?? 0), text: sentence, queryIds: outcome.queryIds });
        driverText.push(sentence);
        continue;
      }
      if (dimensionVerdict.verdict === 'inconclusive') {
        const reason = dimensionVerdict.reason ?? 'no member stood out';
        inconclusive.push({ dimension, reason, queryIds: outcome.queryIds });
        facts.push({ factId: `f-inconclusive-${inconclusive.length}`, kind: 'investigation_dimension', details: { dimension: dimension.label, reason, queryIds: outcome.queryIds.join(',') } });
        driverText.push(`By ${dimension.label}${within}, the breakdown was inconclusive: ${reason}.`);
        continue;
      }
      for (const member of dimensionVerdict.members) {
        const { row } = member;
        if (!row.share || !row.delta || row.current === undefined || row.prior === undefined) continue;
        const factId = `f-driver-${driverRows.length + 1}`;
        const whole = parent?.row.share ? globalShare(row.share, parent.row.share) : undefined;
        driverRows.push({
          path: [
            ...(parent ? [{ dimension: parent.dimension, member: { value: parent.row.value, label: parent.row.label } }] : []),
            { dimension, member: { value: row.value, label: row.label } },
          ],
          current: investigationNumber(row.current, meta),
          prior: investigationNumber(row.prior, meta),
          delta: investigationNumber(row.delta, meta),
          share: formatDecimal(row.share),
          ...(whole ? { globalShare: formatDecimal(whole) } : {}),
          ...(row.excess ? { excess: formatDecimal(row.excess) } : {}),
          status: row.status,
          role: row.role === 'offset' ? 'offset' : 'driver',
          verdict: member.verdict,
          factIds: [factId],
          queryIds: outcome.queryIds,
        });
        facts.push({
          factId, kind: 'investigation_driver',
          values: {
            current: numberOf(row.current), prior: numberOf(row.prior),
            ...signedAndAbsolute('delta', numberOf(row.delta)),
            ...signedAndAbsolute('sharePct', percentNumber(row.share)),
            ...(row.priorWeight ? { priorWeightPct: percentNumber(row.priorWeight) } : {}),
            ...(whole ? signedAndAbsolute('globalSharePct', percentNumber(whole)) : {}),
          },
          details: { dimension: dimension.label, member: row.label, ...(parent ? { within: parent.row.label } : {}), queryIds: outcome.queryIds.join(',') },
        });
        const share = `${Math.abs(percentNumber(row.share)).toFixed(1)}%`;
        const subject = `${row.label} in ${dimension.label}`;
        if (member.verdict === 'offset') {
          driverText.push(`${capitalize(subject)}${within} moved the other way, from ${format(row.prior)} to ${format(row.current)}, offsetting ${share} of the change.`);
        } else if (parent && whole) {
          driverText.push(`Within ${parent.row.label}, ${subject} accounted for ${share} of its change, ${Math.abs(percentNumber(whole)).toFixed(1)}% of the whole change.`);
        } else if (row.status === 'new') {
          driverText.push(`${capitalize(subject)} is new in ${currentWindow.label} (${format(row.current)}) and accounted for ${share} of the change.`);
        } else if (row.status === 'gone') {
          driverText.push(`${capitalize(subject)} had ${format(row.prior)} in ${priorWindow.label} and nothing in ${currentWindow.label}, ${share} of the change.`);
        } else {
          driverText.push(`${capitalize(subject)} accounted for ${share} of the change, from ${format(row.prior)} to ${format(row.current)}, though it was ${row.priorWeight ? `${percentNumber(row.priorWeight).toFixed(1)}%` : 'part'} of ${label} in ${priorWindow.label}.`);
        }
      }
    }
    if (drivers.mixRate) {
      const { split, dimension } = drivers.mixRate;
      mixRate = { mix: investigationNumber(split.mix, meta), rate: investigationNumber(split.rate, meta), queryIds: drivers.mixRate.queryIds };
      facts.push({
        factId: 'f-mix-rate', kind: 'investigation_mix_rate',
        values: {
          ...signedAndAbsolute('mix', numberOf(split.mix)), ...signedAndAbsolute('rate', numberOf(split.rate)),
          ...signedAndAbsolute('mixPoints', pointsOf(split.mix)), ...signedAndAbsolute('ratePoints', pointsOf(split.rate)),
        },
        details: { dimension: dimension.label, queryIds: drivers.mixRate.queryIds.join(',') },
      });
      driverText.push(`By ${dimension.label}, ${magnitude(split.mix)} of the change came from the mix of members and ${magnitude(split.rate)} from each member's own rate.`);
    }
    const seen = new Set<string>();
    for (const entry of drivers.notInvestigated) {
      const key = `${entry.dimension.ref}:${entry.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notInvestigated.push({ dimension: entry.dimension, reason: entry.reason, ...(entry.detail ? { detail: entry.detail } : {}) });
    }
    const byReason = new Map<NotInvestigatedReason, string[]>();
    for (const entry of notInvestigated) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.dimension!.label]);
    for (const [reason, labels] of byReason) driverText.push(`Not broken down by ${labels.join(', ')}: ${NOT_INVESTIGATED_WORDS[reason]}.`);

    for (const item of [...drivers.analysed, ...drivers.drilled]) {
      const { table } = item.outcome;
      if (table.relabel) caveats.push({ code: 'relabel', text: `By ${item.dimension.label}, ${table.relabel.gone} is gone and ${table.relabel.new} is new at about the same size; they may be one member renamed.`, queryIds: item.outcome.queryIds });
      if (table.nullMember) caveats.push({ code: 'null_member', text: `Some ${item.dimension.label} values are not set; they count as one member, "(not set)".`, queryIds: item.outcome.queryIds });
    }
    const truncated = notInvestigated.filter((entry) => entry.reason === 'truncated_members');
    if (truncated.length) caveats.push({ code: 'truncated_members', text: `${truncated.map((entry) => entry.dimension!.label).join(', ')} had more members than one result holds, so ${truncated.length === 1 ? 'it was' : 'they were'} not broken down.` });
    if (drivers.aiSql && !headline.aiSql) caveats.push({ code: 'ai_sql', text: 'Some breakdowns come from SQL the AI wrote; review them before relying on them.' });
    if (frame.metric.additivity === 'non_additive' && drivers.analysed.length) caveats.push({ code: 'non_additive', text: `${capitalize(label)} does not add up across members, so the breakdowns show each member's own change, not a share of the total.` });
    const memberSeasonal = drivers.memberSeasonality;
    if (memberSeasonal?.check.seasonal && memberSeasonal.check.yearAgoPct !== undefined) {
      facts.push({ factId: 'f-member-seasonality', kind: 'investigation_seasonality', values: signedAndAbsolute('seasonalYearAgoPct', Number(memberSeasonal.check.yearAgoPct)), details: { member: memberSeasonal.member, queryIds: memberSeasonal.queryIds.join(',') } });
      caveats.push({ code: 'seasonal', text: `${capitalize(memberSeasonal.member)} moved ${signedPercent(memberSeasonal.check.yearAgoPct)} over the same periods a year earlier.`, queryIds: memberSeasonal.queryIds });
    }
  }

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
  if (seasonality?.seasonal) {
    caveats.push({ code: 'seasonal', text: `The change matches the same change a year earlier, so it may be seasonal.` });
    cap('medium', 'the same change happened a year earlier');
  }
  if (input.stoppedBy) {
    caveats.push({ code: input.stoppedBy, text: input.stoppedBy === 'cancelled' ? 'The investigation was stopped before it finished.' : input.stoppedBy === 'deadline' ? 'The investigation ran out of time before it finished.' : 'The investigation used its query budget before it finished.' });
    cap(incomplete ? 'low' : 'medium', 'the investigation did not finish');
  }
  if (noData) cap('low', headline.failure ? 'the headline could not be measured' : 'there is no data for the periods compared');
  if (drivers && measured && drivers.candidates > 0) {
    const residuals = drivers.analysed
      .map((item) => item.outcome.table)
      .filter((table) => table.additive && table.residual && table.change.coefficient !== 0n)
      .map((table) => Math.abs(numberOf(table.residual!) / numberOf(table.change)) * 100);
    const supportedShares = drivers.analysed.flatMap((item) => item.verdict.members.filter((member) => member.verdict === 'supported').map((member) => numberOf(member.row.share!)));
    const limits = investigationConfidence({
      driversExpected: material,
      dimensionsAnalysed: drivers.analysed.length,
      ...(residuals.length ? { maxResidualPct: Math.max(...residuals) } : {}),
      anyAiSql: drivers.aiSql && !headline.aiSql,
      nonAdditive: frame.metric.additivity === 'non_additive' && drivers.analysed.length > 0,
      ...(supportedShares.length ? { topSupportedShare: Math.max(...supportedShares) } : {}),
      relabel: [...drivers.analysed, ...drivers.drilled].some((item) => Boolean(item.outcome.table.relabel)),
    });
    if (LEVEL_RANK[limits.level] > LEVEL_RANK[level]) level = limits.level;
    reasons.push(...limits.reasons);
  }

  const notes = [...frame.notes, ...caveats.map((caveat) => caveat.text)];
  const headlineText = text;
  if (driverText.length) text = `${text}\n\n${driverText.join(' ')}`;
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
      ...(yearAgo !== undefined ? { yearAgo: investigationNumber(yearAgo, meta) } : {}),
      ...(yoyDelta ? { yoyDelta: investigationNumber(yoyDelta, meta) } : {}),
      ...(yoyPct ? { yoyPct } : {}),
      verdict,
      factIds: ['f-headline'],
      queryIds: headline.queryIds,
    },
    drivers: driverRows,
    ...(mixRate ? { mixRate } : {}),
    ...(seasonality ? { seasonality } : {}),
    ruledOut,
    inconclusive,
    notInvestigated,
    caveats,
    confidence: { level, reasons },
    ...(headline.series ? { chart: { trend: headline.series } } : {}),
    context: input.context,
    queries: input.queries,
    facts: { factSetId: `investigation:${frame.metric.ref}:${currentWindow.start}`, facts },
    text,
  };
}
