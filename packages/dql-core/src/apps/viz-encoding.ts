/**
 * Shelves for a Dataset tile (RFC 0009 step 1).
 *
 * A Tableau or Power BI author builds a chart by putting fields on shelves:
 * Columns and Rows for the axes, Colour to split into series, Size for
 * bubble size, Label and Tooltip for extra values, Detail to add grain
 * without drawing it. `viz.encoding` stores that placement next to the tile's
 * checked `TileQuery`, which is derived from the shelves: every dimension on
 * an axis, Colour or Detail is grouped by, every measure anywhere is
 * selected. The query is still validated against the Dataset contract, so a
 * shelf can never ask for something the contract refuses.
 *
 * Tiles saved before shelves existed have no encoding; `encodingFromQuery`
 * gives the shelves they already draw as, and nothing changes until the
 * author edits them. Pure: no I/O.
 */
import type { TileQuery, TileQueryDimension, TileQueryMeasure } from './tile-query-types.js';

export type ShelfFieldRef = { dimension: string } | { measure: string };

export const SHELVES = ['columns', 'rows', 'color', 'size', 'label', 'tooltip', 'detail'] as const;
export type ShelfId = (typeof SHELVES)[number];

export const SHELF_LABELS: Record<ShelfId, string> = {
  columns: 'Columns',
  rows: 'Rows',
  color: 'Colour',
  size: 'Size',
  label: 'Label',
  tooltip: 'Tooltip',
  detail: 'Detail',
};

export type FieldFormatKind = 'number' | 'compact' | 'currency' | 'percent';

export interface ShelfFieldSettings {
  /** The name readers see instead of the field's own. */
  label?: string;
  /** Number format for a measure. */
  format?: { kind: FieldFormatKind; decimals?: number };
}

export interface DashboardVizEncoding {
  version: 1;
  columns: ShelfFieldRef[];
  rows: ShelfFieldRef[];
  /** A dimension splits into series; a measure colours cells (heatmap). */
  color?: ShelfFieldRef;
  size?: { measure: string };
  label?: Array<{ measure: string }>;
  tooltip?: Array<{ measure: string }>;
  detail?: Array<{ dimension: string }>;
  /** Per-field name and format, keyed by `fieldKey`. */
  fields?: Record<string, ShelfFieldSettings>;
}

const MAX_ON_SHELF = 12;
const MAX_LABEL = 80;
const FORMAT_KINDS: readonly FieldFormatKind[] = ['number', 'compact', 'currency', 'percent'];

export const isMeasureRef = (ref: ShelfFieldRef): ref is { measure: string } => 'measure' in ref;
export const refName = (ref: ShelfFieldRef): string => (isMeasureRef(ref) ? ref.measure : ref.dimension);
/** A stable key for a field on any shelf: `measure:revenue`, `dimension:region`. */
export const fieldKey = (ref: ShelfFieldRef): string => `${isMeasureRef(ref) ? 'measure' : 'dimension'}:${refName(ref)}`;
const sameRef = (left: ShelfFieldRef, right: ShelfFieldRef) => fieldKey(left) === fieldKey(right);

function readRef(raw: unknown, path: string, err: (message: string) => void, only?: 'dimension' | 'measure'): ShelfFieldRef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    err(`${path} must be { "dimension": name } or { "measure": name }`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const dimension = typeof record.dimension === 'string' ? record.dimension.trim() : '';
  const measure = typeof record.measure === 'string' ? record.measure.trim() : '';
  if (Boolean(dimension) === Boolean(measure)) {
    err(`${path} must name exactly one dimension or measure`);
    return undefined;
  }
  if (only === 'dimension' && !dimension) {
    err(`${path} takes a dimension`);
    return undefined;
  }
  if (only === 'measure' && !measure) {
    err(`${path} takes a measure`);
    return undefined;
  }
  return dimension ? { dimension } : { measure };
}

function readRefList(raw: unknown, path: string, err: (message: string) => void, only?: 'dimension' | 'measure'): ShelfFieldRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`${path} must be an array`);
    return [];
  }
  if (raw.length > MAX_ON_SHELF) err(`${path} holds at most ${MAX_ON_SHELF} fields`);
  const refs: ShelfFieldRef[] = [];
  raw.slice(0, MAX_ON_SHELF).forEach((entry, index) => {
    const ref = readRef(entry, `${path}[${index}]`, err, only);
    if (ref && !refs.some((existing) => sameRef(existing, ref))) refs.push(ref);
  });
  return refs;
}

/** Validate a raw `viz.encoding`; problems go to `err` and bad parts are dropped. */
export function readDashboardVizEncoding(raw: unknown, path: string, err: (message: string) => void): DashboardVizEncoding | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    err(`${path} must be an object`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) err(`${path}.version must be 1`);
  const encoding: DashboardVizEncoding = {
    version: 1,
    columns: readRefList(record.columns ?? [], `${path}.columns`, err),
    rows: readRefList(record.rows ?? [], `${path}.rows`, err),
  };
  if (record.color !== undefined) {
    const color = readRef(record.color, `${path}.color`, err);
    if (color) encoding.color = color;
  }
  if (record.size !== undefined) {
    const size = readRef(record.size, `${path}.size`, err, 'measure');
    if (size && isMeasureRef(size)) encoding.size = size;
  }
  const label = readRefList(record.label, `${path}.label`, err, 'measure').filter(isMeasureRef);
  const tooltip = readRefList(record.tooltip, `${path}.tooltip`, err, 'measure').filter(isMeasureRef);
  const detail = readRefList(record.detail, `${path}.detail`, err, 'dimension').filter((ref): ref is { dimension: string } => !isMeasureRef(ref));
  if (label.length) encoding.label = label;
  if (tooltip.length) encoding.tooltip = tooltip;
  if (detail.length) encoding.detail = detail;
  if (record.fields !== undefined) {
    if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
      err(`${path}.fields must be an object`);
    } else {
      const fields: Record<string, ShelfFieldSettings> = {};
      for (const [key, value] of Object.entries(record.fields as Record<string, unknown>)) {
        if (!/^(dimension|measure):.+$/.test(key)) {
          err(`${path}.fields key "${key}" must be "dimension:<name>" or "measure:<name>"`);
          continue;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          err(`${path}.fields.${key} must be an object`);
          continue;
        }
        const settings = value as Record<string, unknown>;
        const out: ShelfFieldSettings = {};
        if (settings.label !== undefined) {
          if (typeof settings.label === 'string' && settings.label.trim() && settings.label.length <= MAX_LABEL) out.label = settings.label.trim();
          else err(`${path}.fields.${key}.label must be text of at most ${MAX_LABEL} characters`);
        }
        if (settings.format !== undefined) {
          const format = settings.format as Record<string, unknown> | null;
          const kind = format?.kind;
          const decimals = format?.decimals;
          if (!format || typeof format !== 'object' || !FORMAT_KINDS.includes(kind as FieldFormatKind)) {
            err(`${path}.fields.${key}.format.kind must be ${FORMAT_KINDS.join('|')}`);
          } else if (decimals !== undefined && !(Number.isInteger(decimals) && (decimals as number) >= 0 && (decimals as number) <= 6)) {
            err(`${path}.fields.${key}.format.decimals must be 0-6`);
          } else {
            out.format = { kind: kind as FieldFormatKind, ...(decimals !== undefined ? { decimals: decimals as number } : {}) };
          }
        }
        if (Object.keys(out).length) fields[key] = out;
      }
      if (Object.keys(fields).length) encoding.fields = fields;
    }
  }
  return encoding;
}

/** Every field on the shelves, grouped by the shelf it is on. */
export function shelfContents(encoding: DashboardVizEncoding): Record<ShelfId, ShelfFieldRef[]> {
  return {
    columns: encoding.columns,
    rows: encoding.rows,
    color: encoding.color ? [encoding.color] : [],
    size: encoding.size ? [encoding.size] : [],
    label: encoding.label ?? [],
    tooltip: encoding.tooltip ?? [],
    detail: encoding.detail ?? [],
  };
}

/** Problems when an encoding names a field its query does not select. */
export function encodingQueryIssues(encoding: DashboardVizEncoding, query: TileQuery): string[] {
  const dimensions = new Set(query.dimensions.map((dimension) => dimension.field.toLowerCase()));
  const measures = new Set(query.measures.map((measure) => measure.measure.toLowerCase()));
  const issues: string[] = [];
  for (const [shelf, refs] of Object.entries(shelfContents(encoding)) as Array<[ShelfId, ShelfFieldRef[]]>) {
    for (const ref of refs) {
      const known = isMeasureRef(ref) ? measures.has(ref.measure.toLowerCase()) : dimensions.has(ref.dimension.toLowerCase());
      if (!known) issues.push(`${SHELF_LABELS[shelf]} names ${refName(ref)}, which the tile's query does not select.`);
    }
  }
  return issues;
}

/**
 * The query the shelves ask for. Dimensions on an axis, Colour or Detail are
 * grouped by; measures anywhere are selected. A dimension or measure already
 * in `previous` keeps its time grain and alias; `timeGrainFor` gives a new
 * time field its grain. Filters, comparison, limit and valid sorts carry on.
 */
export function queryFromEncoding(
  encoding: DashboardVizEncoding,
  previous: TileQuery,
  timeGrainFor: (field: string) => string | undefined = () => undefined,
): TileQuery {
  const dimensionRefs: string[] = [];
  const measureRefs: string[] = [];
  const add = (ref: ShelfFieldRef) => {
    const list = isMeasureRef(ref) ? measureRefs : dimensionRefs;
    const name = refName(ref);
    if (!list.some((existing) => existing.toLowerCase() === name.toLowerCase())) list.push(name);
  };
  [...encoding.columns, ...encoding.rows].forEach(add);
  if (encoding.color) add(encoding.color);
  (encoding.detail ?? []).forEach(add);
  if (encoding.size) add(encoding.size);
  (encoding.label ?? []).forEach(add);
  (encoding.tooltip ?? []).forEach(add);
  const dimensions: TileQueryDimension[] = dimensionRefs.map((field) => {
    const prior = previous.dimensions.find((dimension) => dimension.field.toLowerCase() === field.toLowerCase());
    if (prior) return prior;
    const grain = timeGrainFor(field);
    return { field, ...(grain ? { timeGrain: grain } : {}) };
  });
  const measures: TileQueryMeasure[] = measureRefs.map((name) => (
    previous.measures.find((measure) => measure.measure.toLowerCase() === name.toLowerCase()) ?? { measure: name }
  ));
  const aliases = new Set([
    ...dimensions.map((dimension) => (dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field)).toLowerCase()),
    ...measures.map((measure) => (measure.alias ?? measure.measure).toLowerCase()),
  ]);
  const { orderBy, detail: _detail, detailColumns: _detailColumns, ...rest } = previous;
  const keptOrder = orderBy?.filter((entry) => aliases.has(entry.alias.toLowerCase()));
  return {
    ...rest,
    dimensions,
    measures,
    ...(keptOrder?.length ? { orderBy: keptOrder } : {}),
  };
}

type VizType = string | undefined;

/**
 * The shelves a tile saved without an encoding already draws as, so the
 * editor shows what the reader sees: time runs along Columns, a category
 * lists down Rows (horizontal bars), measures take the other axis, a second
 * dimension splits into series by Colour.
 */
export function encodingFromQuery(query: TileQuery, viz: VizType): DashboardVizEncoding {
  const dims = query.dimensions.map((dimension) => ({ dimension: dimension.field }));
  const measures = query.measures.map((measure) => ({ measure: measure.measure }));
  const type = (viz ?? '').toLowerCase().replace(/-/g, '_');
  if (type === 'scatter' && measures.length >= 2) {
    return { version: 1, columns: [measures[0]!], rows: [measures[1]!], ...(measures[2] ? { size: measures[2] } : {}), ...(dims.length ? { detail: dims } : {}) };
  }
  if (type === 'heatmap' && dims.length >= 2 && measures[0]) {
    return { version: 1, columns: [dims[0]!], rows: [dims[1]!], color: measures[0] };
  }
  if (!dims.length) return { version: 1, columns: [], rows: measures };
  const timeIndex = query.dimensions.findIndex((dimension) => Boolean(dimension.timeGrain));
  const axisIndex = timeIndex >= 0 ? timeIndex : 0;
  const axis = dims[axisIndex]!;
  const others = dims.filter((_, index) => index !== axisIndex);
  const split = others[0];
  const detail = others.slice(1);
  const time = timeIndex >= 0 || type === 'line' || type === 'area';
  return {
    version: 1,
    columns: time ? [axis] : measures,
    rows: time ? measures : [axis],
    ...(split ? { color: split } : {}),
    ...(detail.length ? { detail } : {}),
  };
}

function withoutRef(encoding: DashboardVizEncoding, ref: ShelfFieldRef, shelves: ShelfId[]): DashboardVizEncoding {
  const next: DashboardVizEncoding = { ...encoding, columns: [...encoding.columns], rows: [...encoding.rows] };
  for (const shelf of shelves) {
    if (shelf === 'columns' || shelf === 'rows') next[shelf] = next[shelf].filter((entry) => !sameRef(entry, ref));
    else if (shelf === 'color') { if (next.color && sameRef(next.color, ref)) delete next.color; }
    else if (shelf === 'size') { if (next.size && sameRef(next.size, ref)) delete next.size; }
    else {
      const list = (next[shelf] as ShelfFieldRef[] | undefined)?.filter((entry) => !sameRef(entry, ref));
      if (list?.length) (next as unknown as Record<string, unknown>)[shelf] = list;
      else delete next[shelf];
    }
  }
  return next;
}

/** Whether a field may go on a shelf: Size, Label and Tooltip take measures; Detail takes dimensions. */
export function shelfAccepts(shelf: ShelfId, ref: ShelfFieldRef): boolean {
  if (shelf === 'size' || shelf === 'label' || shelf === 'tooltip') return isMeasureRef(ref);
  if (shelf === 'detail') return !isMeasureRef(ref);
  return true;
}

/**
 * Put a field on a shelf. On the axes, Colour and Detail a field appears
 * once, so it moves from wherever it was; Size, Label and Tooltip repeat a
 * measure already drawn (a label on a bar's own value). Colour and Size hold
 * one field; what was there is replaced.
 */
export function placeOnShelf(encoding: DashboardVizEncoding, shelf: ShelfId, ref: ShelfFieldRef, index?: number): DashboardVizEncoding {
  if (!shelfAccepts(shelf, ref)) return encoding;
  const structural: ShelfId[] = ['columns', 'rows', 'color', 'detail'];
  let next = structural.includes(shelf) ? withoutRef(encoding, ref, structural) : withoutRef(encoding, ref, [shelf]);
  if (shelf === 'columns' || shelf === 'rows') {
    const list = [...next[shelf]];
    list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, ref);
    next = { ...next, [shelf]: list };
  } else if (shelf === 'color') {
    next = { ...next, color: ref };
  } else if (shelf === 'size' && isMeasureRef(ref)) {
    next = { ...next, size: ref };
  } else {
    const list = [...((next[shelf] as ShelfFieldRef[] | undefined) ?? [])];
    list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, ref);
    next = { ...next, [shelf]: list } as DashboardVizEncoding;
  }
  return next;
}

export function removeFromShelf(encoding: DashboardVizEncoding, shelf: ShelfId, ref: ShelfFieldRef): DashboardVizEncoding {
  const next = withoutRef(encoding, ref, [shelf]);
  // A field gone from every shelf takes its name and format with it.
  const stillThere = Object.values(shelfContents(next)).some((refs) => refs.some((entry) => sameRef(entry, ref)));
  if (!stillThere && next.fields?.[fieldKey(ref)]) {
    const { [fieldKey(ref)]: _removed, ...fields } = next.fields;
    const { fields: _all, ...rest } = next;
    return Object.keys(fields).length ? { ...rest, fields } : rest;
  }
  return next;
}

/**
 * Where a clicked field goes, as a Tableau author expects: a date runs along
 * Columns; a category lists down Rows (or splits a date chart by Colour, then
 * adds Detail); a measure goes to the axis without dimensions.
 */
export function defaultShelfFor(encoding: DashboardVizEncoding, ref: ShelfFieldRef, isTime: boolean): ShelfId {
  const dimsOn = (refs: ShelfFieldRef[]) => refs.some((entry) => !isMeasureRef(entry));
  if (isMeasureRef(ref)) {
    if (dimsOn(encoding.rows) && !dimsOn(encoding.columns)) return 'columns';
    return 'rows';
  }
  if (isTime) return 'columns';
  if (dimsOn(encoding.columns) || dimsOn(encoding.rows)) return encoding.color ? 'detail' : 'color';
  return 'rows';
}

/** Place a field where a click puts it, moving measures off the axis a date takes. */
export function addFieldByClick(encoding: DashboardVizEncoding, ref: ShelfFieldRef, isTime: boolean): DashboardVizEncoding {
  const shelf = defaultShelfFor(encoding, ref, isTime);
  let next = placeOnShelf(encoding, shelf, ref);
  // A date on Columns sends the measures there to Rows (a line over time),
  // and a category already on an axis becomes the series split (Colour),
  // then Detail: revenue by customer plus a date reads as a line per customer.
  if (shelf === 'columns' && !isMeasureRef(ref)) {
    for (const measure of next.columns.filter(isMeasureRef)) next = placeOnShelf(next, 'rows', measure);
    const categories = [...next.columns, ...next.rows].filter((entry) => !isMeasureRef(entry) && fieldKey(entry) !== fieldKey(ref));
    for (const category of categories) next = placeOnShelf(next, next.color ? 'detail' : 'color', category);
  }
  // The first category on Rows sends the measures there to Columns (bars).
  if (shelf === 'rows' && !isMeasureRef(ref) && !next.columns.some((entry) => !isMeasureRef(entry))) {
    for (const measure of next.rows.filter(isMeasureRef)) next = placeOnShelf(next, 'columns', measure);
  }
  return next;
}

/** A field on a shelf, whatever shelf it is on. */
export function encodingHas(encoding: DashboardVizEncoding, ref: ShelfFieldRef): boolean {
  return Object.values(shelfContents(encoding)).some((refs) => refs.some((entry) => sameRef(entry, ref)));
}

/** Remove a field from every shelf. */
export function removeField(encoding: DashboardVizEncoding, ref: ShelfFieldRef): DashboardVizEncoding {
  let next = encoding;
  for (const shelf of SHELVES) next = removeFromShelf(next, shelf, ref);
  return next;
}

export type EncodedChart =
  | { kind: 'kpi' }
  | { kind: 'table'; reason: string }
  | { kind: 'cartesian'; orientation: 'vertical' | 'horizontal'; category: string; measures: string[]; line: boolean }
  | { kind: 'scatter'; x: string; y: string }
  | { kind: 'heatmap'; x: string; y: string; value: string };

/**
 * What the shelves draw. `isTime` tells whether a dimension is a time field.
 * RFC 0009 step 2 ranks alternatives; this picks the direct reading.
 */
export function chartFromEncoding(encoding: DashboardVizEncoding, isTime: (dimension: string) => boolean): EncodedChart {
  const chart = drawnChart(encoding, isTime);
  // Detail adds rows. A scatter draws each row as its own point; a bar, line
  // or cell has one mark per category, so several rows would have to be
  // merged into one number, and that number could be wrong.
  if (encoding.detail?.length && (chart.kind === 'cartesian' || chart.kind === 'heatmap')) {
    return { kind: 'table', reason: 'Detail adds rows that a bar, line or heatmap cannot show one by one, so this reads as a table. Use Detail with a scatter, or move the field to Colour.' };
  }
  return chart;
}

function drawnChart(encoding: DashboardVizEncoding, isTime: (dimension: string) => boolean): EncodedChart {
  const colDims = encoding.columns.filter((ref) => !isMeasureRef(ref)).map(refName);
  const rowDims = encoding.rows.filter((ref) => !isMeasureRef(ref)).map(refName);
  const colMeasures = encoding.columns.filter(isMeasureRef).map(refName);
  const rowMeasures = encoding.rows.filter(isMeasureRef).map(refName);
  const dims = colDims.length + rowDims.length;
  if (!dims && colMeasures.length + rowMeasures.length === 1 && !encoding.color) return { kind: 'kpi' };
  if (!dims && colMeasures.length >= 1 && rowMeasures.length >= 1) return { kind: 'scatter', x: colMeasures[0]!, y: rowMeasures[0]! };
  if (colDims.length === 1 && rowDims.length === 1 && encoding.color && isMeasureRef(encoding.color)) {
    return { kind: 'heatmap', x: colDims[0]!, y: rowDims[0]!, value: encoding.color.measure };
  }
  if (colDims.length === 1 && !rowDims.length && rowMeasures.length && !colMeasures.length) {
    return { kind: 'cartesian', orientation: 'vertical', category: colDims[0]!, measures: rowMeasures, line: isTime(colDims[0]!) };
  }
  if (rowDims.length === 1 && !colDims.length && colMeasures.length && !rowMeasures.length) {
    return { kind: 'cartesian', orientation: 'horizontal', category: rowDims[0]!, measures: colMeasures, line: false };
  }
  if (!colMeasures.length && !rowMeasures.length && !encoding.color) return { kind: 'table', reason: 'Add a measure to draw a chart.' };
  return { kind: 'table', reason: 'These shelves read best as a table: put one dimension on one axis and measures on the other for a chart.' };
}

/** The result column a query entry comes back as (its alias). */
export function outputAlias(query: TileQuery, ref: ShelfFieldRef): string | undefined {
  if (isMeasureRef(ref)) {
    const measure = query.measures.find((entry) => entry.measure.toLowerCase() === ref.measure.toLowerCase());
    return measure ? measure.alias ?? measure.measure : undefined;
  }
  const dimension = query.dimensions.find((entry) => entry.field.toLowerCase() === ref.dimension.toLowerCase());
  if (!dimension) return undefined;
  return dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field);
}

/**
 * What a renderer needs from the shelves, in result column names: the
 * category and value columns, orientation, colour and size columns, which
 * measures carry labels or appear in the tooltip, and per-column names and
 * formats. `isTime` tells whether a dimension is a time field.
 */
export interface EncodedChartColumns {
  chart: EncodedChart;
  x?: string;
  y?: string;
  metrics?: string[];
  color?: string;
  size?: string;
  orientation?: 'vertical' | 'horizontal';
  labelColumns: string[];
  tooltipColumns: string[];
  columnSettings: Record<string, ShelfFieldSettings>;
}

export function encodingChartColumns(encoding: DashboardVizEncoding, query: TileQuery, isTime: (dimension: string) => boolean): EncodedChartColumns {
  const chart = chartFromEncoding(encoding, isTime);
  const alias = (ref: ShelfFieldRef | undefined) => (ref ? outputAlias(query, ref) : undefined);
  const aliasOf = (name: string, kind: 'dimension' | 'measure') => alias(kind === 'measure' ? { measure: name } : { dimension: name });
  const columnSettings: Record<string, ShelfFieldSettings> = {};
  for (const [key, settings] of Object.entries(encoding.fields ?? {})) {
    const [kind, ...rest] = key.split(':');
    const column = aliasOf(rest.join(':'), kind === 'measure' ? 'measure' : 'dimension');
    if (column) columnSettings[column] = settings;
  }
  const base = {
    chart,
    labelColumns: (encoding.label ?? []).map((ref) => alias(ref)).filter((value): value is string => Boolean(value)),
    tooltipColumns: (encoding.tooltip ?? []).map((ref) => alias(ref)).filter((value): value is string => Boolean(value)),
    columnSettings,
    ...(encoding.size ? { size: alias(encoding.size) } : {}),
  };
  if (chart.kind === 'cartesian') {
    const metrics = chart.measures.map((name) => aliasOf(name, 'measure')).filter((value): value is string => Boolean(value));
    return {
      ...base,
      x: aliasOf(chart.category, 'dimension'),
      y: metrics[0],
      metrics,
      orientation: chart.orientation,
      ...(encoding.color && !isMeasureRef(encoding.color) ? { color: alias(encoding.color) } : {}),
    };
  }
  if (chart.kind === 'scatter') {
    return {
      ...base,
      x: aliasOf(chart.x, 'measure'),
      y: aliasOf(chart.y, 'measure'),
      ...(encoding.color && !isMeasureRef(encoding.color) ? { color: alias(encoding.color) } : {}),
    };
  }
  if (chart.kind === 'heatmap') {
    return { ...base, x: aliasOf(chart.x, 'dimension'), y: aliasOf(chart.value, 'measure') };
  }
  return base;
}
