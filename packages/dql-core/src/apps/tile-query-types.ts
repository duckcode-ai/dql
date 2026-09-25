/**
 * The persisted TileQuery shape, kept apart from its validator so dataset
 * modules can import the types without an import cycle through tile-query.
 */
export type TileFilterOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'contains';

export interface TileQueryDimension {
  field: string;
  timeGrain?: string;
  alias?: string;
}

export interface TileQueryMeasure {
  measure: string;
  alias?: string;
}

export interface TileQueryFilter {
  field: string;
  op: TileFilterOperator;
  values?: unknown[];
}

/**
 * Explicit period comparison state for a field-based Dataset tile. This maps
 * one-for-one to the governed analytical period contract at execution time:
 * periods are start-inclusive/end-exclusive, and the comparison base is the
 * current result from which prior-period values are subtracted.
 *
 * Keep this in the TileQuery rather than deriving it from a chart title or a
 * date control. It is authored intent, participates in the query fingerprint,
 * and therefore invalidates preview/publication evidence when changed.
 */
export interface TileQueryComparisonPeriod {
  id: string;
  kind: 'absolute' | 'current' | 'previous_period' | 'previous_year';
  start?: string;
  end?: string;
  alignToPeriodId?: string;
}

export interface TileQueryComparison {
  version: 1;
  /** Exact approved physical time field; display labels are not authority. */
  timeField: string;
  timeRole: string;
  calendarId: string;
  timezone: string;
  grain: string;
  completenessPolicy: 'partial_current' | 'latest_complete' | 'closed_period';
  periods: TileQueryComparisonPeriod[];
  /** Current/base output. Deltas are calculated as base minus each comparison. */
  basePeriodId: string;
  comparisonPeriodIds: string[];
  alignment: 'elapsed_period' | 'calendar_period' | 'fiscal_period';
  outputs: Array<'value' | 'absolute_delta' | 'percent_delta'>;
  zeroDenominatorPolicy: 'null' | 'not_applicable';
}

/**
 * A calculated measure's typed expression (RFC 0009 step 3). It names Dataset
 * measures, never columns or SQL: `{ measure }` is that measure's own governed
 * aggregate, optionally restricted to rows matching `where` ("revenue where
 * region is US"); numbers are constants. Division of two measures is a ratio
 * of their aggregates, never an average of row ratios.
 */
export type TileCalcExpr =
  | { measure: string; where?: TileQueryFilter[] }
  | { number: number }
  | { op: '+' | '-' | '*' | '/'; left: TileCalcExpr; right: TileCalcExpr };

export type TileQuickCalcKind =
  | 'percent_of_total'
  | 'running_total'
  | 'difference'
  | 'percent_difference'
  | 'rank'
  | 'moving_average'
  | 'year_over_year';

/**
 * One calculation on a tile. Exactly one of `expr` (a calculated measure,
 * computed with the tile's grouping) or `quick` (a table calculation over the
 * tile's result, computed as a window over its rows) is set. `id` is the
 * output column the calculation adds.
 */
export interface TileCalculation {
  id: string;
  label?: string;
  expr?: TileCalcExpr;
  quick?: {
    kind: TileQuickCalcKind;
    /** The measure or calculated measure output this runs over. */
    of: string;
    /** Dimension output the calculation runs along; defaults to the date, else the first dimension. */
    along?: string;
    /** Percent of total and rank: restart for each value of this dimension output; the whole table when absent. */
    within?: string;
    /** Moving average: periods in the window, 2–24 (default 3). */
    window?: number;
  };
  format?: { kind: 'number' | 'currency' | 'percent'; currency?: string; decimals?: number };
}

export interface TileQuery {
  dimensions: TileQueryDimension[];
  measures: TileQueryMeasure[];
  /** Calculated measures and quick table calculations, in output order after `measures`. */
  calculations?: TileCalculation[];
  /**
   * Total levels a pivot asks for (RFC 0009 step 4). Each entry lists the
   * dimension outputs kept; the others are totalled. Compiled to GROUPING
   * SETS, so totals are recomputed from rows, never summed from cells.
   */
  rollups?: string[][];
  filters?: TileQueryFilter[];
  having?: TileQueryFilter[];
  comparison?: TileQueryComparison;
  orderBy?: Array<{ alias: string; direction: 'asc' | 'desc' }>;
  limit?: number | { param: string };
  /** Detail emits dataset-grain rows only when the contract explicitly allows it. */
  detail?: boolean;
  /**
   * Approved physical columns to expose for a bounded detail tile. The
   * source-grain key remains an execution ordering concern; it does not need
   * to be displayed when a builder deliberately omits it.
   */
  detailColumns?: string[];
  respectsGlobalFilters?: boolean;
}
