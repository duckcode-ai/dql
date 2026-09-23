/**
 * How a tile's chart looks, stored in the `.dqld` page beside `viz.type`
 * (RFC 0008 step 4). A person in the Studio style panel and the App AI write
 * the same fields, so a chart built either way renders the same and diffs the
 * same in git. Every field is optional; an empty style is the DQL default.
 *
 * There is deliberately no second y-axis: two measures on different scales
 * are indexed to one axis or split into two tiles.
 */
export interface DashboardVizStyle {
  /** Value labels on marks: none, only the last point or bar, or every mark. */
  labels?: 'none' | 'last' | 'all';
  /** Stack series of a bar or area chart instead of placing them side by side. */
  stack?: boolean;
  /** Number format for axes, labels and tooltips. */
  format?: 'number' | 'compact' | 'currency' | 'percent';
  /** Series colours. `dql` is the validated default. */
  palette?: 'dql' | 'warm' | 'cool' | 'mono' | 'pastel';
  legend?: 'top' | 'right' | 'bottom' | 'none';
  /** Order categories by value; `none` keeps query order. */
  sort?: 'none' | 'asc' | 'desc';
  /** Horizontal lines at a value on the measure axis (a target, an average). */
  referenceLines?: DashboardVizReferenceLine[];
  /** Shaded value ranges on the measure axis (a target range). */
  bands?: DashboardVizBand[];
  /** Notes pinned to a category or date on the x axis, kept in git. */
  annotations?: DashboardVizAnnotation[];
}

export interface DashboardVizReferenceLine { value: number; label?: string }
export interface DashboardVizBand { from: number; to: number; label?: string }
export interface DashboardVizAnnotation { at: string; text: string }

const LABELS = ['none', 'last', 'all'] as const;
const FORMATS = ['number', 'compact', 'currency', 'percent'] as const;
const PALETTES = ['dql', 'warm', 'cool', 'mono', 'pastel'] as const;
const LEGENDS = ['top', 'right', 'bottom', 'none'] as const;
const SORTS = ['none', 'asc', 'desc'] as const;
const MAX_MARKS = 20;
const MAX_TEXT = 120;

/**
 * Validate a raw `viz.style` object. Problems are reported through `err`
 * (with `path` as the prefix) and the offending field is dropped; the result
 * only ever holds well-formed fields. Returns undefined for an absent or
 * empty style.
 */
export function readDashboardVizStyle(
  raw: unknown,
  path: string,
  err: (message: string) => void,
): DashboardVizStyle | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    err(`${path} must be an object`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const style: DashboardVizStyle = {};
  const pick = <T extends string>(key: keyof DashboardVizStyle, allowed: readonly T[]): T | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    err(`${path}.${key} must be one of ${allowed.join('|')}`);
    return undefined;
  };
  const labels = pick('labels', LABELS);
  if (labels) style.labels = labels;
  const format = pick('format', FORMATS);
  if (format) style.format = format;
  const palette = pick('palette', PALETTES);
  if (palette) style.palette = palette;
  const legend = pick('legend', LEGENDS);
  if (legend) style.legend = legend;
  const sort = pick('sort', SORTS);
  if (sort) style.sort = sort;
  if (record.stack !== undefined) {
    if (typeof record.stack === 'boolean') style.stack = record.stack;
    else err(`${path}.stack must be true or false`);
  }

  const list = (key: 'referenceLines' | 'bands' | 'annotations'): Record<string, unknown>[] => {
    const value = record[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      err(`${path}.${key} must be a list`);
      return [];
    }
    if (value.length > MAX_MARKS) err(`${path}.${key} has ${value.length} entries; at most ${MAX_MARKS} are kept`);
    return value.slice(0, MAX_MARKS).filter((entry, index): entry is Record<string, unknown> => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) return true;
      err(`${path}.${key}[${index}] must be an object`);
      return false;
    });
  };
  const label = (value: unknown, where: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_TEXT);
    err(`${where}.label must be non-empty text`);
    return undefined;
  };

  const referenceLines = list('referenceLines').flatMap((entry, index) => {
    const where = `${path}.referenceLines[${index}]`;
    if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
      err(`${where}.value must be a number`);
      return [];
    }
    const text = label(entry.label, where);
    return [{ value: entry.value, ...(text ? { label: text } : {}) }];
  });
  if (referenceLines.length) style.referenceLines = referenceLines;

  const bands = list('bands').flatMap((entry, index) => {
    const where = `${path}.bands[${index}]`;
    if (typeof entry.from !== 'number' || typeof entry.to !== 'number' || !Number.isFinite(entry.from) || !Number.isFinite(entry.to)) {
      err(`${where} needs numeric from and to`);
      return [];
    }
    if (entry.from > entry.to) {
      err(`${where}.from must not be greater than to`);
      return [];
    }
    const text = label(entry.label, where);
    return [{ from: entry.from, to: entry.to, ...(text ? { label: text } : {}) }];
  });
  if (bands.length) style.bands = bands;

  const annotations = list('annotations').flatMap((entry, index) => {
    const where = `${path}.annotations[${index}]`;
    const at = typeof entry.at === 'string' ? entry.at.trim() : typeof entry.at === 'number' ? String(entry.at) : '';
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, MAX_TEXT) : '';
    if (!at || !text) {
      err(`${where} needs an x value (at) and text`);
      return [];
    }
    return [{ at, text }];
  });
  if (annotations.length) style.annotations = annotations;

  return Object.keys(style).length > 0 ? style : undefined;
}
