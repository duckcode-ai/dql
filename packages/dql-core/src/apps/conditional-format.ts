/**
 * Conditional formatting for table and pivot cells (RFC 0009 step 4), stored
 * in `viz.style.conditional` beside the tile so it diffs in git and renders
 * the same in the reader, exports and HTML pages.
 *
 * Three kinds, one measure column each:
 * - `scale`: a colour scale; one hue for values of one sign, two hues around
 *   zero when the column has both;
 * - `bars`: a data bar behind the number, its length the value's share of
 *   the largest magnitude;
 * - `rules`: thresholds that mark a cell good, warning or bad. A state is
 *   always shown with an icon and its name as well as a colour.
 *
 * Colours are CSS variables from the theme, so both themes and the cloud
 * embed restyle them. Pure: no DOM.
 */
export type ConditionalTone = 'good' | 'warning' | 'bad' | 'neutral';
export type ConditionalRuleOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'between';

export interface ConditionalRule {
  op: ConditionalRuleOp;
  value: number;
  /** Upper bound for `between` (inclusive). */
  to?: number;
  tone: ConditionalTone;
}

export interface DashboardConditionalFormat {
  /** The measure's output column. */
  column: string;
  kind: 'scale' | 'bars' | 'rules';
  /** For `rules`: checked in order; the first that matches wins. */
  rules?: ConditionalRule[];
}

export const MAX_CONDITIONAL_FORMATS = 12;
const MAX_RULES = 8;
const TONES: readonly ConditionalTone[] = ['good', 'warning', 'bad', 'neutral'];
const OPS: readonly ConditionalRuleOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'between'];

export const CONDITIONAL_TONE_LABELS: Record<ConditionalTone, string> = {
  good: 'On track',
  warning: 'Watch',
  bad: 'Off track',
  neutral: 'Note',
};

export const CONDITIONAL_OP_SYMBOLS: Record<ConditionalRuleOp, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  between: 'between',
};

/** Theme colours: the accent for one-signed scales, ink blue and orange around zero, status colours for rules. */
const COLORS = {
  scale: 'var(--accent, #0b7a75)',
  up: 'var(--trust-governed, #3659c9)',
  down: 'var(--status-warning, #b26b1f)',
  good: 'var(--status-success, #0b7a75)',
  warning: 'var(--status-warning, #b26b1f)',
  bad: 'var(--status-error, #c14545)',
  neutral: 'var(--text-secondary, #4a4a52)',
} as const;

/** Validate a raw `viz.style.conditional`; problems go to `err` and bad entries are dropped. */
export function readConditionalFormats(raw: unknown, path: string, err: (message: string) => void): DashboardConditionalFormat[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    err(`${path} must be a list`);
    return undefined;
  }
  if (raw.length > MAX_CONDITIONAL_FORMATS) err(`${path} has ${raw.length} entries; at most ${MAX_CONDITIONAL_FORMATS} are kept`);
  const formats: DashboardConditionalFormat[] = [];
  raw.slice(0, MAX_CONDITIONAL_FORMATS).forEach((entry, index) => {
    const where = `${path}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      err(`${where} must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const column = typeof record.column === 'string' ? record.column.trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      err(`${where}.column must name an output column`);
      return;
    }
    if (record.kind !== 'scale' && record.kind !== 'bars' && record.kind !== 'rules') {
      err(`${where}.kind must be scale|bars|rules`);
      return;
    }
    if (record.kind !== 'rules') {
      formats.push({ column, kind: record.kind });
      return;
    }
    if (!Array.isArray(record.rules) || record.rules.length === 0) {
      err(`${where}.rules needs at least one rule`);
      return;
    }
    const rules: ConditionalRule[] = [];
    record.rules.slice(0, MAX_RULES).forEach((rawRule, ruleIndex) => {
      const at = `${where}.rules[${ruleIndex}]`;
      const rule = rawRule as Record<string, unknown> | null;
      if (!rule || typeof rule !== 'object' || !OPS.includes(rule.op as ConditionalRuleOp) || typeof rule.value !== 'number' || !Number.isFinite(rule.value) || !TONES.includes(rule.tone as ConditionalTone)) {
        err(`${at} needs op (${OPS.join('|')}), a numeric value and a tone (${TONES.join('|')})`);
        return;
      }
      if (rule.op === 'between' && (typeof rule.to !== 'number' || !Number.isFinite(rule.to) || rule.to < rule.value)) {
        err(`${at}.to must be a number not below value`);
        return;
      }
      rules.push({ op: rule.op as ConditionalRuleOp, value: rule.value, ...(rule.op === 'between' ? { to: rule.to as number } : {}), tone: rule.tone as ConditionalTone });
    });
    if (rules.length) formats.push({ column, kind: 'rules', rules });
  });
  return formats.length ? formats : undefined;
}

export interface ConditionalStats { min: number; max: number }

/** The range a scale or bar is drawn against: every numeric value in the column. */
export function conditionalStats(values: unknown[]): ConditionalStats | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    const number = numeric(value);
    if (number === undefined) continue;
    if (number < min) min = number;
    if (number > max) max = number;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined;
}

export interface ConditionalCell {
  /** A cell background: a colour scale tint or a rule's tone tint. */
  background?: string;
  /** A data bar: its colour and length as a percent of the cell. */
  bar?: { color: string; width: number };
  /** A rule's state, shown with an icon and its name. */
  tone?: ConditionalTone;
}

/** How one cell looks under one format. Undefined leaves the cell plain. */
export function conditionalCell(format: DashboardConditionalFormat, value: unknown, stats: ConditionalStats | undefined): ConditionalCell | undefined {
  const number = numeric(value);
  if (number === undefined) return undefined;
  if (format.kind === 'rules') {
    const rule = (format.rules ?? []).find((candidate) => ruleMatches(candidate, number));
    return rule ? { tone: rule.tone, background: tint(COLORS[rule.tone], 14) } : undefined;
  }
  if (!stats) return undefined;
  if (format.kind === 'bars') {
    const largest = Math.max(Math.abs(stats.min), Math.abs(stats.max));
    if (largest === 0) return undefined;
    return { bar: { color: tint(number < 0 ? COLORS.down : COLORS.scale, 28), width: Math.round((Math.abs(number) / largest) * 1000) / 10 } };
  }
  // A scale around zero when the column has both signs; one hue otherwise.
  if (stats.min < 0 && stats.max > 0) {
    const reach = number < 0 ? Math.abs(stats.min) : stats.max;
    const strength = reach === 0 ? 0 : Math.abs(number) / reach;
    return { background: tint(number < 0 ? COLORS.down : COLORS.up, Math.round(6 + 32 * strength)) };
  }
  const span = stats.max - stats.min;
  const position = span === 0 ? 1 : stats.min < 0 ? (stats.max - number) / span : (number - stats.min) / span;
  return { background: tint(COLORS.scale, Math.round(6 + 34 * position)) };
}

/** Words for a rule, as the Studio lists it: "≥ 0.5 · On track". */
export function describeConditionalRule(rule: ConditionalRule): string {
  const bound = rule.op === 'between' ? `between ${rule.value} and ${rule.to}` : `${CONDITIONAL_OP_SYMBOLS[rule.op]} ${rule.value}`;
  return `${bound} · ${CONDITIONAL_TONE_LABELS[rule.tone]}`;
}

function ruleMatches(rule: ConditionalRule, value: number): boolean {
  switch (rule.op) {
    case 'gt': return value > rule.value;
    case 'gte': return value >= rule.value;
    case 'lt': return value < rule.value;
    case 'lte': return value <= rule.value;
    case 'eq': return value === rule.value;
    case 'between': return value >= rule.value && value <= (rule.to ?? rule.value);
  }
}

function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${Math.max(0, Math.min(100, percent))}%, transparent)`;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
