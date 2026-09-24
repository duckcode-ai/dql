/**
 * Monitors on App pages (RFC 0008 step 10).
 *
 * A monitor watches one bound figure of a page — the same `tile.field`,
 * `tile.field[member]` or driver keys a story binds to — and is checked each
 * time the page runs on its schedule. It reads only the value the governed
 * run returned; it never runs its own query, so a monitor can never say
 * something the page would not show.
 *
 * Pure: parsing and evaluation, no I/O.
 */
import { figureLabel, type StoryBindingCatalog } from './story-bindings.js';

export type AppMonitorCondition =
  | { kind: 'threshold'; op: '<' | '<=' | '>' | '>='; value: number }
  | { kind: 'change'; direction: 'up' | 'down' | 'either'; percent: number };

export interface AppMonitor {
  id: string;
  /** A story binding key, e.g. `revenue_kpi.revenue` or `by_region.revenue[US]`. */
  binding: string;
  when: AppMonitorCondition;
  /** How people refer to it, e.g. "Revenue below plan". */
  label?: string;
}

export const MAX_MONITORS_PER_SCHEDULE = 20;

const THRESHOLD_OPS = new Set(['<', '<=', '>', '>=']);
const DIRECTIONS = new Set(['up', 'down', 'either']);

/** Parse `schedules[].monitors`; bad entries are reported and skipped. */
export function readAppMonitors(raw: unknown, ctx: string, err: (message: string) => void): AppMonitor[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`${ctx}.monitors must be an array`);
    return [];
  }
  const out: AppMonitor[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    const at = `${ctx}.monitors[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      err(`${at} must be an object`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const binding = typeof record.binding === 'string' ? record.binding.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      err(`${at}.id must be 1-80 letters, digits, _ or -`);
      continue;
    }
    if (ids.has(id)) {
      err(`${at}.id "${id}" is used twice`);
      continue;
    }
    if (!binding || binding.length > 300 || !binding.includes('.')) {
      err(`${at}.binding must be a bound figure such as "tile.field"`);
      continue;
    }
    const when = readCondition(record.when);
    if (!when) {
      err(`${at}.when must be { kind: "threshold", op: "<"|"<="|">"|">=", value } or { kind: "change", direction: "up"|"down"|"either", percent }`);
      continue;
    }
    if (out.length >= MAX_MONITORS_PER_SCHEDULE) {
      err(`${ctx} has more than ${MAX_MONITORS_PER_SCHEDULE} monitors`);
      break;
    }
    ids.add(id);
    const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim().slice(0, 120) : undefined;
    out.push({ id, binding, when, ...(label ? { label } : {}) });
  }
  return out;
}

function readCondition(raw: unknown): AppMonitorCondition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === 'threshold' && typeof record.op === 'string' && THRESHOLD_OPS.has(record.op)
    && typeof record.value === 'number' && Number.isFinite(record.value)) {
    return { kind: 'threshold', op: record.op as '<' | '<=' | '>' | '>=', value: record.value };
  }
  if (record.kind === 'change' && typeof record.direction === 'string' && DIRECTIONS.has(record.direction)
    && typeof record.percent === 'number' && Number.isFinite(record.percent) && record.percent > 0 && record.percent <= 10_000) {
    return { kind: 'change', direction: record.direction as 'up' | 'down' | 'either', percent: record.percent };
  }
  return null;
}

/** What a figure showed on an earlier run, as the digest remembers it. */
export interface MonitorPreviousValue {
  value: number | string | null;
  display: string;
}

export type MonitorStatus = 'breached' | 'ok' | 'missing' | 'no_baseline' | 'not_numeric';

export interface MonitorEvaluation {
  monitor: AppMonitor;
  status: MonitorStatus;
  label: string;
  /** The figure as readers see it this run. */
  current?: string;
  previous?: string;
  /** Percent change since the previous run, when there was one. */
  changePercent?: number;
  /** One sentence a reader can act on. */
  message: string;
}

const OP_WORDS: Record<'<' | '<=' | '>' | '>=', string> = { '<': 'below', '<=': 'at or below', '>': 'above', '>=': 'at or above' };

function formatLike(display: string | undefined, value: number): string {
  // Reuse the figure's own unit: "$1,200" → "$<n>", "45%" → "<n>%".
  const text = Math.abs(value) >= 1000 ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(value.toFixed(4)));
  if (display?.trim().startsWith('$')) return `$${text}`;
  if (display?.trim().endsWith('%')) return `${text}%`;
  return text;
}

const percentText = (value: number) => `${Math.abs(value) >= 10 ? Math.round(Math.abs(value)) : Number(Math.abs(value).toFixed(1))}%`;

/**
 * Check monitors against this run's bound figures. A percent figure's value
 * is a ratio (0.52 for 52%); thresholds on percent figures are written in
 * the same unit people read (52), so they are compared against value × 100.
 */
export function evaluateMonitors(
  monitors: AppMonitor[],
  catalog: StoryBindingCatalog,
  previous: Record<string, MonitorPreviousValue | undefined> = {},
): MonitorEvaluation[] {
  return monitors.map((monitor) => {
    const binding = catalog[monitor.binding];
    const label = monitor.label ?? (binding ? figureLabel(binding.label) : monitor.binding);
    if (!binding || binding.value === null || binding.value === undefined) {
      return { monitor, status: 'missing', label, message: `${label} did not return a value this run, so it could not be checked.` };
    }
    if (typeof binding.value !== 'number' || !Number.isFinite(binding.value)) {
      return { monitor, status: 'not_numeric', label, current: binding.display, message: `${label} is ${binding.display}, which is not a number, so it could not be checked.` };
    }
    const scale = binding.unit?.kind === 'percent' ? 100 : 1;
    const current = binding.value * scale;
    const prior = previous[monitor.binding];
    const priorValue = typeof prior?.value === 'number' && Number.isFinite(prior.value) ? prior.value * scale : undefined;
    const changePercent = priorValue !== undefined && priorValue !== 0 ? ((current - priorValue) / Math.abs(priorValue)) * 100 : undefined;
    const base = { monitor, label, current: binding.display, ...(prior ? { previous: prior.display } : {}), ...(changePercent !== undefined ? { changePercent } : {}) };
    if (monitor.when.kind === 'threshold') {
      const { op, value } = monitor.when;
      const breached = op === '<' ? current < value : op === '<=' ? current <= value : op === '>' ? current > value : current >= value;
      const limit = formatLike(binding.display, value);
      return {
        ...base,
        status: breached ? 'breached' : 'ok',
        message: breached
          ? `${label} is ${binding.display}, ${OP_WORDS[op]} ${limit}.`
          : `${label} is ${binding.display}; the alert is for ${OP_WORDS[op]} ${limit}.`,
      };
    }
    const { direction, percent } = monitor.when;
    if (changePercent === undefined) {
      return { ...base, status: 'no_baseline', message: `${label} is ${binding.display}. There is no earlier run to compare with yet.` };
    }
    const moved = changePercent >= 0 ? 'rose' : 'fell';
    const breached = Math.abs(changePercent) >= percent
      && (direction === 'either' || (direction === 'up' ? changePercent > 0 : changePercent < 0));
    const detail = `${label} ${moved} ${percentText(changePercent)} since the last run (${prior!.display} → ${binding.display})`;
    return {
      ...base,
      status: breached ? 'breached' : 'ok',
      message: breached ? `${detail}.` : `${detail}; the alert is for a ${direction === 'up' ? 'rise' : direction === 'down' ? 'fall' : 'change'} of ${percentText(percent)} or more.`,
    };
  });
}
