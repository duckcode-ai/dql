/**
 * KPI tiles with a trend and a target (RFC 0009 step 4).
 *
 * A KPI with a date on its shelves shows the latest period, its change from
 * the period before and the trend as a sparkline; with a target, how far the
 * latest value is from it and whether that is on track. Every number is a
 * value the warehouse returned for its period: nothing is summed or averaged
 * here, so a distinct count or a rate stays correct. A period that is not
 * over yet is marked as such, so its change is not read as a full period's.
 * Pure: no DOM.
 */
export interface DashboardKpiStyle {
  /** The number the KPI is measured against, in the measure's own unit (a rate as 0..1). */
  target?: number;
  /** What the target is called: "Plan", "Budget". */
  targetLabel?: string;
  /** Whether a higher value is better (default) or a lower one (costs, churn). */
  better?: 'higher' | 'lower';
}

export interface KpiPoint { period: unknown; value: number | null }

export interface KpiSummary {
  value: number | null;
  /** The latest period, when the KPI has a date. */
  period?: { value: unknown; partial: boolean };
  previous?: KpiPoint;
  change?: { absolute: number; percent: number | null; direction: 'up' | 'down' | 'flat'; good: boolean | null };
  /** Oldest first, for the sparkline. */
  series: KpiPoint[];
  target?: { value: number; label?: string; share: number | null; met: boolean; better: 'higher' | 'lower' };
}

const GRAIN_MONTHS: Record<string, number> = { month: 1, quarter: 3, year: 12 };
const GRAIN_DAYS: Record<string, number> = { day: 1, week: 7 };

/** Validate a raw `viz.style.kpi`; problems go to `err`. */
export function readKpiStyle(raw: unknown, path: string, err: (message: string) => void): DashboardKpiStyle | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    err(`${path} must be an object`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const style: DashboardKpiStyle = {};
  if (record.target !== undefined) {
    if (typeof record.target === 'number' && Number.isFinite(record.target)) style.target = record.target;
    else err(`${path}.target must be a number`);
  }
  if (record.targetLabel !== undefined) {
    if (typeof record.targetLabel === 'string' && record.targetLabel.trim() && record.targetLabel.length <= 60) style.targetLabel = record.targetLabel.trim();
    else err(`${path}.targetLabel must be text of at most 60 characters`);
  }
  if (record.better !== undefined) {
    if (record.better === 'higher' || record.better === 'lower') style.better = record.better;
    else err(`${path}.better must be higher|lower`);
  }
  return Object.keys(style).length ? style : undefined;
}

/**
 * The KPI a tile shows. With `timeColumn`, rows are periods: the latest is the
 * value, the one before it the comparison. Without, the tile has one row.
 */
export function summarizeKpi(
  rows: Array<Record<string, unknown>>,
  options: { valueColumn: string; timeColumn?: string; grain?: string; style?: DashboardKpiStyle; now?: number },
): KpiSummary {
  const better = options.style?.better ?? 'higher';
  const withTarget = (value: number | null): KpiSummary['target'] => {
    const target = options.style?.target;
    if (target === undefined) return undefined;
    const met = value !== null && (better === 'higher' ? value >= target : value <= target);
    return { value: target, ...(options.style?.targetLabel ? { label: options.style.targetLabel } : {}), share: value !== null && target !== 0 ? value / target : null, met, better };
  };
  if (!options.timeColumn) {
    const value = rows.length === 1 ? numeric(rows[0]![options.valueColumn]) : null;
    return { value, series: [], ...(withTarget(value) ? { target: withTarget(value)! } : {}) };
  }
  const time = options.timeColumn;
  const series = rows
    .filter((row) => row[time] !== null && row[time] !== undefined)
    .map((row) => ({ period: row[time], value: numeric(row[options.valueColumn]) }))
    .sort((left, right) => timeOf(left.period) - timeOf(right.period));
  const latest = series[series.length - 1];
  if (!latest) return { value: null, series: [] };
  const previous = series[series.length - 2];
  const change = previous && latest.value !== null && previous.value !== null
    ? (() => {
      const absolute = latest.value! - previous.value!;
      const direction: 'up' | 'down' | 'flat' = absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat';
      return {
        absolute,
        percent: previous.value !== 0 ? absolute / Math.abs(previous.value!) : null,
        direction,
        good: direction === 'flat' ? null : (direction === 'up') === (better === 'higher'),
      };
    })()
    : undefined;
  return {
    value: latest.value,
    period: { value: latest.period, partial: isPartialPeriod(latest.period, options.grain, options.now ?? Date.now()) },
    ...(previous ? { previous } : {}),
    ...(change ? { change } : {}),
    series,
    ...(withTarget(latest.value) ? { target: withTarget(latest.value)! } : {}),
  };
}

/** Whether a period that starts at `start` has not ended by `now`. */
export function isPartialPeriod(start: unknown, grain: string | undefined, now: number): boolean {
  const begin = timeOf(start);
  if (!Number.isFinite(begin) || !grain) return false;
  const date = new Date(begin);
  let end: number;
  if (GRAIN_MONTHS[grain]) end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + GRAIN_MONTHS[grain]!, date.getUTCDate());
  else if (GRAIN_DAYS[grain]) end = begin + GRAIN_DAYS[grain]! * 86_400_000;
  else return false;
  return end > now;
}

function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(/^\d{4}-\d{2}$/.test(value) ? `${value}-01T00:00:00Z` : value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}
