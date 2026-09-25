/**
 * Pivot tables with governed totals (RFC 0009 step 4).
 *
 * A pivot tile lists row dimensions down the side, column dimensions across
 * the top and its measures in the cells. Totals and subtotals are not added
 * up in the browser: the tile's query asks the warehouse for each total level
 * (`rollups`, compiled to GROUPING SETS), so the total of a distinct count or
 * a rate is recomputed from the rows, never summed from the cells.
 *
 * Shelves: dimensions on Rows are row headers, dimensions on Columns (and a
 * dimension on Colour) are column headers, every measure anywhere is a value.
 * Pure: no DOM.
 */
import type { TileQuery } from './tile-query-types.js';
import { isMeasureRef, refName, shelfContents, type DashboardVizEncoding } from './viz-encoding.js';

export interface PivotTotals {
  /** A total row under each column: every row group added up (recomputed). */
  rows?: boolean;
  /** A total column after the columns: each row across its columns (recomputed). */
  columns?: boolean;
  /** A subtotal row after each outer row group, when there are two or more row dimensions. */
  subtotals?: boolean;
}

export interface PivotLayout {
  /** Output aliases of the row dimensions, outermost first. */
  rows: string[];
  /** Output aliases of the column dimensions, outermost first. */
  columns: string[];
  /** Output aliases of the values, in shelf order. */
  values: string[];
}

export const MAX_ROLLUPS = 16;
/** The prefix of the flag columns a query with rollups returns: 1 where that dimension is totalled. */
export const PIVOT_TOTAL_FLAG = '__total_';

export function pivotTotalFlag(alias: string): string {
  return `${PIVOT_TOTAL_FLAG}${alias}`;
}

/** Totals default on: an absent choice shows the total. */
export function pivotTotalsWithDefaults(totals: PivotTotals | undefined): Required<PivotTotals> {
  return { rows: totals?.rows !== false, columns: totals?.columns !== false, subtotals: totals?.subtotals !== false };
}

/** Where each field of a pivot goes, from the tile's shelves. */
export function pivotLayout(encoding: DashboardVizEncoding, query: TileQuery): PivotLayout {
  const dimensionAlias = (field: string) => {
    const dimension = query.dimensions.find((entry) => entry.field.toLowerCase() === field.toLowerCase());
    return dimension ? dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field) : undefined;
  };
  const measureAlias = (name: string) => {
    const measure = query.measures.find((entry) => entry.measure.toLowerCase() === name.toLowerCase());
    if (measure) return measure.alias ?? measure.measure;
    return query.calculations?.find((calculation) => calculation.id.toLowerCase() === name.toLowerCase())?.id;
  };
  const contents = shelfContents(encoding);
  const rows: string[] = [];
  const columns: string[] = [];
  const values: string[] = [];
  const add = (list: string[], alias: string | undefined) => { if (alias && !rows.includes(alias) && !columns.includes(alias) && !list.includes(alias)) list.push(alias); };
  for (const ref of contents.rows) if (!isMeasureRef(ref)) add(rows, dimensionAlias(refName(ref)));
  for (const ref of [...contents.columns, ...contents.color]) if (!isMeasureRef(ref)) add(columns, dimensionAlias(refName(ref)));
  for (const ref of contents.detail) if (!isMeasureRef(ref)) add(rows, dimensionAlias(refName(ref)));
  for (const shelf of ['rows', 'columns', 'label', 'tooltip', 'color', 'size'] as const) {
    for (const ref of contents[shelf]) if (isMeasureRef(ref)) add(values, measureAlias(ref.measure));
  }
  // Dimensions the query groups by but no shelf places still need a home.
  for (const dimension of query.dimensions) add(rows, dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field));
  return { rows, columns, values };
}

/**
 * The total levels a pivot asks the warehouse for. Each entry lists the
 * dimension aliases kept; the others are totalled. The full grouping (every
 * dimension) is the query's own and is never listed.
 */
export function pivotRollups(layout: Pick<PivotLayout, 'rows' | 'columns'>, totals: PivotTotals | undefined): string[][] {
  const { rows: rowTotal, columns: columnTotal, subtotals } = pivotTotalsWithDefaults(totals);
  const R = layout.rows;
  const C = layout.columns;
  const prefixes = subtotals && R.length > 1 ? R.slice(1).map((_, index) => R.slice(0, index + 1)) : [];
  const sets: string[][] = [];
  const push = (set: string[]) => {
    const key = [...set].sort().join('\u0000');
    if (set.length === R.length + C.length) return;
    if (!sets.some((existing) => [...existing].sort().join('\u0000') === key)) sets.push(set);
  };
  for (const prefix of prefixes) push([...prefix, ...C]);
  if (columnTotal && C.length) {
    push([...R]);
    for (const prefix of prefixes) push([...prefix]);
  }
  if (rowTotal && R.length) {
    push([...C]);
  }
  if (rowTotal && columnTotal && R.length && C.length) push([]);
  if (rowTotal && !C.length && R.length) push([]);
  return sets.slice(0, MAX_ROLLUPS);
}

/** The query a pivot tile runs: its own grouping plus the total levels its shelves and choices ask for. */
export function withPivotRollups(query: TileQuery, encoding: DashboardVizEncoding, totals: PivotTotals | undefined): TileQuery {
  const { rollups: _previous, ...rest } = query;
  const rollups = pivotRollups(pivotLayout(encoding, query), totals);
  return rollups.length ? { ...rest, rollups } : rest;
}

/** A query without totals, for a tile that stops being a pivot. */
export function withoutRollups(query: TileQuery): TileQuery {
  const { rollups: _previous, ...rest } = query;
  return rest;
}

// ---------------------------------------------------------------------------
// Building the grid from a result
// ---------------------------------------------------------------------------

export interface PivotHeader {
  /** One value per column dimension; `total` columns hold none. */
  values: unknown[];
  total: boolean;
}

export interface PivotRow {
  /** One value per row dimension; a subtotal holds its prefix, the grand total none. */
  values: unknown[];
  kind: 'cell' | 'subtotal' | 'total';
  /** How many row dimensions this row keeps (the subtotal's depth). */
  depth: number;
}

export interface PivotGrid {
  layout: PivotLayout;
  columns: PivotHeader[];
  rows: PivotRow[];
  /** The value at a row, column and measure; undefined when the warehouse returned none. */
  value: (row: PivotRow, column: PivotHeader, measure: string) => unknown;
  /** The layout was cut to fit (too many rows or columns). */
  truncated: boolean;
}

export const MAX_PIVOT_ROWS = 500;
export const MAX_PIVOT_COLUMNS = 60;

/**
 * Arrange a result into a pivot grid. Rows marked by the flag columns as
 * totals become subtotal and total rows and the total column; without flags
 * (a pivot drawn from a query without rollups) the grid simply has no totals.
 */
export function buildPivotGrid(result: { columns: string[]; rows: Array<Record<string, unknown>> }, layout: PivotLayout): PivotGrid {
  const totalled = (row: Record<string, unknown>, alias: string) => Number(row[pivotTotalFlag(alias)] ?? 0) === 1;
  const keyOf = (values: unknown[]) => JSON.stringify(values.map((value) => (value instanceof Date ? value.toISOString() : value ?? null)));
  const cells = new Map<string, Record<string, unknown>>();
  const columnKeys = new Map<string, PivotHeader>();
  const rowKeys = new Map<string, PivotRow>();

  for (const record of result.rows) {
    const rowDepth = layout.rows.findIndex((alias) => totalled(record, alias));
    const depth = rowDepth === -1 ? layout.rows.length : rowDepth;
    // A row level with a totalled dimension before a kept one is not a pivot level; skip it.
    if (layout.rows.slice(depth).some((alias) => !totalled(record, alias))) continue;
    const columnTotal = layout.columns.length > 0 && layout.columns.every((alias) => totalled(record, alias));
    if (!columnTotal && layout.columns.some((alias) => totalled(record, alias))) continue;
    const rowValues = layout.rows.slice(0, depth).map((alias) => record[alias]);
    const columnValues = columnTotal ? [] : layout.columns.map((alias) => record[alias]);
    const kind: PivotRow['kind'] = depth === layout.rows.length ? 'cell' : depth === 0 ? 'total' : 'subtotal';
    const rowKey = `${kind}:${keyOf(rowValues)}`;
    const columnKey = `${columnTotal ? 'total' : 'cell'}:${keyOf(columnValues)}`;
    if (!rowKeys.has(rowKey)) rowKeys.set(rowKey, { values: rowValues, kind, depth });
    if (!columnKeys.has(columnKey)) columnKeys.set(columnKey, { values: columnValues, total: columnTotal });
    cells.set(`${rowKey}|${columnKey}`, record);
  }

  const compare = (left: unknown[], right: unknown[]) => {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const order = compareValues(left[index], right[index]);
      if (order !== 0) return order;
    }
    return left.length - right.length;
  };
  const columns = [...columnKeys.values()].sort((left, right) => (left.total === right.total ? compare(left.values, right.values) : left.total ? 1 : -1));
  // Rows: each group's cells, then its subtotal; the grand total last.
  const rows = [...rowKeys.values()].sort((left, right) => {
    if (left.kind === 'total' || right.kind === 'total') return left.kind === right.kind ? 0 : left.kind === 'total' ? 1 : -1;
    const shared = Math.min(left.depth, right.depth);
    const order = compare(left.values.slice(0, shared), right.values.slice(0, shared));
    if (order !== 0) return order;
    // Same prefix: the deeper row (the group's own cells) comes before its subtotal.
    return right.depth - left.depth;
  });
  const truncated = rows.length > MAX_PIVOT_ROWS || columns.length > MAX_PIVOT_COLUMNS;
  const keyForRow = (row: PivotRow) => `${row.kind}:${keyOf(row.values)}`;
  const keyForColumn = (column: PivotHeader) => `${column.total ? 'total' : 'cell'}:${keyOf(column.values)}`;
  return {
    layout,
    columns: columns.slice(0, MAX_PIVOT_COLUMNS),
    rows: rows.slice(0, MAX_PIVOT_ROWS),
    value: (row, column, measure) => cells.get(`${keyForRow(row)}|${keyForColumn(column)}`)?.[measure],
    truncated,
  };
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  const leftNumber = typeof left === 'number' ? left : undefined;
  const rightNumber = typeof right === 'number' ? right : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  const leftDate = left instanceof Date ? left.getTime() : typeof left === 'string' && /^\d{4}-\d{2}/.test(left) ? Date.parse(left) : NaN;
  const rightDate = right instanceof Date ? right.getTime() : typeof right === 'string' && /^\d{4}-\d{2}/.test(right) ? Date.parse(right) : NaN;
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) return leftDate - rightDate;
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}
