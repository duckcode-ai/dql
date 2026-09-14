/**
 * THE CONTRIBUTION PROGRAM: the metric by one dimension in both periods, one
 * reading through the pipeline, split into what each member added to the
 * change. A dimension the metric cannot be broken down by is reported as not
 * expressible, never approximated with another grouping.
 */
import { sumDecimals, type ExactDecimal } from '../../analytical-execution-graph.js';
import type { IntentGroupBy } from '../../ask-pipeline/intent.js';
import { runInvestigationQuery, type InvestigationRun } from './context.js';
import { contributionTable, memberKey, memberLabel, mixRateSplit, type ContributionTableV1, type MixRateSplitV1 } from './contribution.js';
import { yearOfPeriodValue } from './frame.js';
import { bucketDayOf, decimalOf, investigationIntent, periodValueIntent, resultColumns, timeBucket, type ResultColumns } from './intents.js';
import type { InvestigationDimensionRef, InvestigationFrameV1, InvestigationWindow } from './types.js';
import { bucketsIn } from './windows.js';

export type ContributionOutcome =
  | { status: 'measured'; dimension: InvestigationDimensionRef; table: ContributionTableV1; mixRate?: MixRateSplitV1; queryIds: string[]; aiSql: boolean }
  | { status: 'truncated' | 'failed' | 'not_expressible' | 'stopped'; dimension: InvestigationDimensionRef; reason: string; queryIds: string[] };

/** The pipeline's words when a metric cannot be grouped by a field. */
const NOT_EXPRESSIBLE = /join path|could not compose|not compatible|cannot be combined|join_path_required|not reachable|no governed join/i;

type Row = Record<string, unknown>;

interface Sliced { value: unknown; current: Row[]; prior: Row[] }

export async function measureContribution(run: InvestigationRun, frame: InvestigationFrameV1, dimension: InvestigationDimensionRef, input: {
  totals: { current: ExactDecimal; prior: ExactDecimal };
  allowAiSql: boolean;
  /** The program the queries belong to (a drill files them under the drill). */
  programId?: string;
}): Promise<ContributionOutcome> {
  const { windows, metric, grain } = frame;
  const { current, prior } = windows;
  const split: IntentGroupBy = { ref: dimension.ref, role: 'categorical' };
  const label = `${metric.label} by ${dimension.label} in ${current.label} and ${prior.label}`;
  const vocabulary = run.runtime.vocabulary();
  const queryIds: string[] = [];
  const members = new Map<string, Sliced>();
  let aiSql = false;
  let columns: ResultColumns | undefined;

  const failure = (message: string): ContributionOutcome => ({
    status: NOT_EXPRESSIBLE.test(message) ? 'not_expressible' : 'failed', dimension, reason: message, queryIds,
  });
  const slot = (value: unknown) => {
    const key = memberKey(value);
    const existing = members.get(key);
    if (existing) return existing;
    const created: Sliced = { value, current: [], prior: [] };
    members.set(key, created);
    return created;
  };

  /** One query; `period` places each row in a period, or drops it. */
  const read = async (intent: Parameters<typeof runInvestigationQuery>[1]['intent'], options: { time: boolean }, period: (row: Row, picked: ResultColumns) => 'current' | 'prior' | undefined): Promise<ContributionOutcome | undefined> => {
    const result = await runInvestigationQuery(run, { purpose: input.programId?.startsWith('drill:') ? 'drill' : 'contribution', programId: input.programId ?? `contribution:${dimension.ref}`, allowAiSql: input.allowAiSql, label, intent });
    if (result.status === 'stopped') return { status: 'stopped', dimension, reason: result.reason, queryIds };
    queryIds.push(result.id);
    if (result.status === 'no_rows') return undefined;
    if (result.status === 'unanswered') return failure(result.message);
    if (result.rows.truncated) return { status: 'truncated', dimension, reason: `${dimension.label} has more members than one result holds`, queryIds };
    aiSql ||= result.aiSql;
    const picked = resultColumns(result.rows, frame, vocabulary, { time: options.time, dimensionRef: dimension.ref });
    if (!picked.ok) return { status: 'failed', dimension, reason: picked.reason, queryIds };
    columns = picked.columns;
    for (const row of result.rows.rows) {
      const place = period(row, picked.columns);
      if (place) slot(row[picked.columns.dimension!])[place].push(row);
    }
    return undefined;
  };

  const inWindow = (day: string | undefined, window: InvestigationWindow) => day !== undefined && day >= window.start && day < window.end;
  if (frame.periodAxis) {
    const axis = frame.periodAxis;
    const from = Math.min(Number(prior.start), Number(current.start));
    const to = Math.max(Number(prior.end), Number(current.end));
    const stopped = await read(
      periodValueIntent({ ...frame, periodAxis: axis }, { reading: `${metric.label} by ${dimension.label} and ${axis.name} from ${from} to ${to - 1}.`, from, to, grouped: true, groupBy: [split], shape: 'grouped' }),
      { time: true },
      (row, picked) => {
        const season = yearOfPeriodValue(row[picked.time!]);
        return season === Number(current.start) ? 'current' : season === Number(prior.start) ? 'prior' : undefined;
      },
    );
    if (stopped) return stopped;
  } else if (bucketsIn(current, grain) && bucketsIn(prior, grain)) {
    const span = { start: current.start < prior.start ? current.start : prior.start, end: current.end > prior.end ? current.end : prior.end };
    const stopped = await read(
      investigationIntent(frame, { reading: `${metric.label} by ${dimension.label} and ${grain} from ${prior.label} to ${current.label}.`, window: span, groupBy: [split, timeBucket(frame)], shape: 'grouped' }),
      { time: true },
      (row, picked) => {
        const day = bucketDayOf(row[picked.time!]);
        return inWindow(day, current) ? 'current' : inWindow(day, prior) ? 'prior' : undefined;
      },
    );
    if (stopped) return stopped;
  } else {
    for (const [place, window] of [['current', current], ['prior', prior]] as const) {
      const stopped = await read(
        investigationIntent(frame, { reading: `${metric.label} by ${dimension.label} in ${window.label}.`, window, groupBy: [split], shape: 'grouped' }),
        { time: false },
        () => place,
      );
      if (stopped) return stopped;
    }
  }
  if (!columns || members.size === 0) return { status: 'failed', dimension, reason: `no rows of ${metric.label} by ${dimension.label} in either period`, queryIds };
  const picked: ResultColumns = columns;

  const sum = (rows: Row[], column: string | undefined) => {
    const values = rows.map((row) => decimalOf(row[column!])).filter((value): value is ExactDecimal => Boolean(value));
    return values.length ? sumDecimals(values) : undefined;
  };
  const entries = [...members.entries()];
  if (metric.ratio) {
    const ratioMembers = entries.map(([key, member]) => ({
      key, label: memberLabel(member.value),
      ...(member.current.length ? { currentNumerator: sum(member.current, picked.numerator), currentDenominator: sum(member.current, picked.denominator) } : {}),
      ...(member.prior.length ? { priorNumerator: sum(member.prior, picked.numerator), priorDenominator: sum(member.prior, picked.denominator) } : {}),
    }));
    const mixRate = mixRateSplit(ratioMembers);
    const table = contributionTable({
      additivity: 'ratio',
      totalCurrent: mixRate?.currentRatio ?? input.totals.current,
      totalPrior: mixRate?.priorRatio ?? input.totals.prior,
      members: entries.map(([key, member]) => {
        const row = mixRate?.members.find((item) => item.key === key);
        return { key, value: member.value, label: memberLabel(member.value), ...(row?.currentRatio ? { current: row.currentRatio } : {}), ...(row?.priorRatio ? { prior: row.priorRatio } : {}) };
      }),
    });
    return { status: 'measured', dimension, table, ...(mixRate ? { mixRate } : {}), queryIds, aiSql };
  }
  const additive = metric.additivity === 'additive';
  // A non-additive value is one row's value, never a sum of rows.
  const figure = (rows: Row[]) => (additive ? sum(rows, picked.value) : rows.length === 1 ? decimalOf(rows[0]![picked.value!]) : undefined);
  const table = contributionTable({
    additivity: metric.additivity,
    totalCurrent: input.totals.current,
    totalPrior: input.totals.prior,
    members: entries.map(([key, member]) => {
      const currentValue = member.current.length ? figure(member.current) : undefined;
      const priorValue = member.prior.length ? figure(member.prior) : undefined;
      return { key, value: member.value, label: memberLabel(member.value), ...(currentValue ? { current: currentValue } : {}), ...(priorValue ? { prior: priorValue } : {}) };
    }),
  });
  return { status: 'measured', dimension, table, queryIds, aiSql };
}
