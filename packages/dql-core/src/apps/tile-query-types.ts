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

export interface TileQuery {
  dimensions: TileQueryDimension[];
  measures: TileQueryMeasure[];
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
