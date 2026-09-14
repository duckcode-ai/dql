/**
 * WHAT THE NUMBERS SUPPORT. Fixed thresholds turn a contribution table into
 * verdicts on members and dimensions, a year-earlier comparison into a
 * seasonality check, and everything that limits the figures into a
 * confidence level with its reasons. No verdict is ever a cause: a supported
 * driver is where the change is concentrated, not why it happened.
 */
import { absDecimal, compareDecimal, formatDecimal, multiplyDecimal, parseExactDecimal, percentChange, subtractDecimal, type ExactDecimal } from '../../analytical-execution-graph.js';
import type { ContributionRowV1, ContributionTableV1 } from './contribution.js';

export const VERDICT_THRESHOLDS = {
  /** A supported driver made at least this share of the change... */
  supportedShare: 0.3,
  /** ...and this much more than its share of the prior period. */
  supportedExcess: 0.15,
  partialShare: 0.15,
  partialExcess: 0.05,
  /** A member moving against the change is listed when it offsets at least this share. */
  offsetShare: 0.15,
  /** Without a supported member, the top three same-direction members explain the change at this cumulative share... */
  explainsCumulativeShare: 0.6,
  /** ...when at least one of them exceeds its size by this much. */
  explainsExcess: 0.1,
  /** A reconciled dimension whose members all moved within this of their size is ruled out. */
  ruledOutExcess: 0.1,
  /** A change within this many percentage points of the same change a year earlier is seasonal. */
  seasonalPoints: 5,
  /** Only a supported member with at least this share is drilled into. */
  drillShare: 0.4,
  /** Members moving more than this many times the total change, in offsetting directions, have no meaningful shares. */
  maxChurn: 3,
  /** A dimension with more members than this is too fine for one member to stand out. */
  maxMembers: 50,
} as const;

const number = (value: ExactDecimal | undefined) => (value === undefined ? undefined : Number(formatDecimal(value)));

export type MemberVerdictV1 = 'supported' | 'partial' | 'offset';

export function memberVerdict(row: ContributionRowV1, table: ContributionTableV1): MemberVerdictV1 | undefined {
  if (!table.additive || table.offsetting || !table.reconciles) return undefined;
  const share = number(row.share);
  const excess = number(row.excess);
  if (share === undefined || excess === undefined) return undefined;
  if (row.role === 'offset') return Math.abs(share) >= VERDICT_THRESHOLDS.offsetShare ? 'offset' : undefined;
  if (row.role !== 'driver') return undefined;
  if (share >= VERDICT_THRESHOLDS.supportedShare && excess >= VERDICT_THRESHOLDS.supportedExcess) return 'supported';
  if (share >= VERDICT_THRESHOLDS.partialShare && excess >= VERDICT_THRESHOLDS.partialExcess) return 'partial';
  return undefined;
}

export interface DimensionVerdictV1 {
  verdict: 'explains' | 'ruled_out' | 'inconclusive';
  /** Largest |excess| over the members, when shares exist. */
  maxExcess?: number;
  reason?: string;
  members: Array<{ row: ContributionRowV1; verdict: MemberVerdictV1 }>;
}

export function dimensionVerdict(table: ContributionTableV1): DimensionVerdictV1 {
  if (!table.additive) return { verdict: 'inconclusive', reason: 'the metric does not add up across members, so no member has a share of the change', members: [] };
  if (table.offsetting) return { verdict: 'inconclusive', reason: 'the total did not change while members moved in offsetting directions', members: [] };
  if (!table.reconciles) {
    return { verdict: 'inconclusive', reason: `the members add up to ${formatDecimal(table.membersChange!)} of a change of ${formatDecimal(table.change)}, so their shares are not reliable`, members: [] };
  }
  if (table.rows.length > VERDICT_THRESHOLDS.maxMembers) {
    return { verdict: 'inconclusive', reason: `${table.rows.length} members is too many for one member's share of the change to stand out`, members: [] };
  }
  const gross = table.rows.reduce((sum, row) => sum + Math.abs(number(row.delta) ?? 0), 0);
  const net = Math.abs(number(table.change) ?? 0);
  if (net > 0 && gross > VERDICT_THRESHOLDS.maxChurn * net) {
    return { verdict: 'inconclusive', reason: `members moved ${(gross / net).toFixed(1)} times as much as the total changed, in offsetting directions, so no member's share of the change is meaningful`, members: [] };
  }
  const members = table.rows.flatMap((row) => {
    const verdict = memberVerdict(row, table);
    return verdict ? [{ row, verdict }] : [];
  });
  const excesses = table.rows.map((row) => number(row.excess)).filter((value): value is number => value !== undefined);
  const maxExcess = excesses.length ? Math.max(...excesses.map(Math.abs)) : undefined;
  if (members.some((member) => member.verdict === 'supported')) return { verdict: 'explains', ...(maxExcess !== undefined ? { maxExcess } : {}), members };
  const drivers = table.rows
    .filter((row) => row.role === 'driver' && row.share !== undefined)
    .sort((left, right) => compareDecimal(right.share!, left.share!) || left.label.localeCompare(right.label))
    .slice(0, 3);
  const cumulative = drivers.reduce((sum, row) => sum + number(row.share)!, 0);
  const topExcess = Math.max(-Infinity, ...drivers.map((row) => number(row.excess) ?? -Infinity));
  if (cumulative >= VERDICT_THRESHOLDS.explainsCumulativeShare && topExcess >= VERDICT_THRESHOLDS.explainsExcess) {
    return { verdict: 'explains', ...(maxExcess !== undefined ? { maxExcess } : {}), members };
  }
  if (maxExcess !== undefined && maxExcess < VERDICT_THRESHOLDS.ruledOutExcess) {
    return { verdict: 'ruled_out', maxExcess, members };
  }
  return { verdict: 'inconclusive', ...(maxExcess !== undefined ? { maxExcess } : {}), reason: 'no member moved far enough beyond its size to stand out', members };
}

/** The member worth breaking down further: the top supported driver, when it made enough of the change. */
export function drillTarget(verdict: DimensionVerdictV1): ContributionRowV1 | undefined {
  const supported = verdict.members.filter((member) => member.verdict === 'supported').map((member) => member.row);
  const top = supported.sort((left, right) => compareDecimal(right.share!, left.share!))[0];
  return top && number(top.share)! >= VERDICT_THRESHOLDS.drillShare ? top : undefined;
}

/** A drilled member's share of the whole change: its share within the parent member times the parent's share. */
export function globalShare(localShare: ExactDecimal, parentShare: ExactDecimal): ExactDecimal {
  return multiplyDecimal(localShare, parentShare);
}

export interface SeasonalityV1 { seasonal: boolean; pct?: string; yearAgoPct?: string }

/**
 * Whether the same change happened a year earlier: the change from the
 * period before to the period, then and now, in the same direction and within
 * a few percentage points.
 */
export function seasonalityCheck(input: { current?: ExactDecimal; prior?: ExactDecimal; yearAgo?: ExactDecimal; yearAgoPrior?: ExactDecimal }): SeasonalityV1 {
  const pctOf = (to?: ExactDecimal, from?: ExactDecimal) => (to && from && from.coefficient !== 0n ? percentChange(subtractDecimal(to, from), absDecimal(from), 2) : undefined);
  const pct = pctOf(input.current, input.prior);
  const yearAgoPct = pctOf(input.yearAgo, input.yearAgoPrior);
  const seasonal = pct !== undefined && yearAgoPct !== undefined
    && Math.sign(Number(pct)) !== 0 && Math.sign(Number(pct)) === Math.sign(Number(yearAgoPct))
    && Math.abs(Number(pct) - Number(yearAgoPct)) < VERDICT_THRESHOLDS.seasonalPoints;
  return { seasonal, ...(pct !== undefined ? { pct } : {}), ...(yearAgoPct !== undefined ? { yearAgoPct } : {}) };
}

export interface ConfidenceInputV1 {
  /** The headline needed an AI-written statement that was repaired after a failure. */
  headlineRepaired?: boolean;
  /** The governed metric could not be computed and AI-written SQL stood in for it. */
  governedFallback?: boolean;
  coverageGap?: boolean;
  noData?: boolean;
  /** Stopped before the headline ('headline') or after it ('drivers'). */
  stopped?: 'headline' | 'drivers';
  /** Whether a driver breakdown was expected (a material change). */
  driversExpected?: boolean;
  dimensionsAnalysed?: number;
  /** |residual| as a percent of the change, for the analysed dimensions. */
  maxResidualPct?: number;
  anyAiSql?: boolean;
  partialPeriod?: boolean;
  seasonal?: boolean;
  nonAdditive?: boolean;
  /** The largest share among supported drivers. */
  topSupportedShare?: number;
  relabel?: boolean;
}

/** Confidence starts high; each limit caps it and says why. Stale data alone never caps it. */
export function investigationConfidence(input: ConfidenceInputV1): { level: 'high' | 'medium' | 'low'; reasons: string[] } {
  let level: 'high' | 'medium' | 'low' = 'high';
  const reasons: string[] = [];
  const cap = (next: 'medium' | 'low', reason: string) => {
    if (next === 'low') level = 'low';
    else if (level === 'high') level = 'medium';
    reasons.push(reason);
  };
  if (input.noData) cap('low', 'there is no data for the periods compared');
  if (input.stopped === 'headline') cap('low', 'the investigation stopped before it measured the change');
  if (input.governedFallback) cap('low', 'the governed metric could not be computed, so AI-written SQL was used');
  if (input.headlineRepaired) cap('low', 'the AI-written statement behind the headline needed a repair');
  if (input.coverageGap) cap('low', 'the current period has data on far fewer days than the prior one');
  if (input.driversExpected && input.dimensionsAnalysed === 0) cap('low', 'no dimension could be analysed');
  if (input.maxResidualPct !== undefined && input.maxResidualPct > 5) cap('low', `a breakdown misses ${input.maxResidualPct.toFixed(1)}% of the change`);
  else if (input.maxResidualPct !== undefined && input.maxResidualPct > 1) cap('medium', `a breakdown misses ${input.maxResidualPct.toFixed(1)}% of the change`);
  if (input.stopped === 'drivers') cap('medium', 'the investigation did not finish');
  if (input.anyAiSql && !input.governedFallback) cap('medium', 'some figures come from AI-written SQL');
  if (input.partialPeriod) cap('medium', 'the current period is not complete');
  if (input.seasonal) cap('medium', 'the same change happened a year earlier');
  if (input.driversExpected && input.dimensionsAnalysed !== undefined && input.dimensionsAnalysed > 0 && input.dimensionsAnalysed < 2) cap('medium', 'only one dimension was analysed');
  if (input.nonAdditive) cap('medium', 'the metric does not add up across members');
  if (input.topSupportedShare !== undefined && input.topSupportedShare < 0.5) cap('medium', 'the strongest driver made less than half of the change');
  if (input.relabel) cap('medium', 'a member may have been renamed between the periods');
  return { level, reasons };
}

export const shareNumber = (value: string | undefined) => (value === undefined ? undefined : parseExactDecimal(value));
