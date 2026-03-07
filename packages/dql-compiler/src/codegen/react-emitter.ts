import type { ChartIR, DashboardIR, ChartConfig } from '../ir/ir-nodes.js';

/**
 * A ReactChartSpec is a serializable descriptor that @dql/charts' ChartRenderer
 * can consume directly. It maps 1:1 from ChartIR to the props expected by
 * <ChartRenderer type={spec.chartType} data={queryResult} props={spec.props} />.
 */
export interface ReactChartSpec {
  chartId: string;
  chartType: string;
  title?: string;
  sql: string;
  sqlParams: Array<{ name: string; position: number; literalValue?: unknown }>;
  props: Record<string, unknown>;
  connection?: string;
  cacheTTL?: number;
}

export interface ReactDashboardSpec {
  title: string;
  charts: ReactChartSpec[];
  layout: {
    columns: number;
    items: Array<{ chartId: string; gridColumn: string; gridRow: string }>;
  };
  theme?: string;
}

/**
 * Convert a single ChartIR to a ReactChartSpec.
 */
export function emitReactChartSpec(chart: ChartIR): ReactChartSpec {
  return {
    chartId: chart.id,
    chartType: mapChartType(chart.chartType),
    title: chart.title,
    sql: chart.sql,
    sqlParams: chart.sqlParams,
    props: buildProps(chart.chartType, chart.config),
    connection: chart.connection,
    cacheTTL: chart.cacheTTL,
  };
}

/**
 * Convert a full DashboardIR to a ReactDashboardSpec.
 */
export function emitReactDashboardSpec(dashboard: DashboardIR): ReactDashboardSpec {
  return {
    title: dashboard.title,
    charts: dashboard.charts.map(emitReactChartSpec),
    layout: {
      columns: dashboard.layout.columns,
      items: dashboard.layout.items.map((item) => ({
        chartId: item.chartId,
        gridColumn: item.gridColumn,
        gridRow: item.gridRow,
      })),
    },
  };
}

/**
 * Map DQL chart type names to @dql/charts ChartType values.
 */
function mapChartType(dqlType: string): string {
  const mapping: Record<string, string> = {
    bar: 'bar',
    'grouped-bar': 'grouped-bar',
    grouped_bar: 'grouped-bar',
    'stacked-bar': 'grouped-bar',
    stacked_bar: 'grouped-bar',
    'stacked-area': 'stacked-area',
    line: 'line',
    area: 'area',
    stacked_area: 'stacked-area',
    scatter: 'scatter',
    pie: 'pie',
    donut: 'donut',
    kpi: 'kpi',
    metric: 'kpi',
    table: 'table',
    heatmap: 'heatmap',
    funnel: 'funnel',
    treemap: 'heatmap',
    sankey: 'line',
    sparkline: 'line',
    small_multiples: 'line',
    'small-multiples': 'line',
    waterfall: 'waterfall',
    box: 'boxplot',
    boxplot: 'boxplot',
    forecast: 'forecast',
    combo: 'line',
  };
  return mapping[dqlType] ?? 'bar';
}

/**
 * Build the props object that @dql/charts components expect from ChartConfig.
 */
function buildProps(chartType: string, config: ChartConfig): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  if (config.x) props.x = config.x;
  if (config.y) props.y = config.y;
  if (config.y2) props.y2 = config.y2;
  if (config.color) props.color = config.color;
  if (config.facet) props.facet = config.facet;
  if (config.colorField) props.category = config.colorField;
  if (config.size) props.size = config.size;
  if (config.width) props.width = config.width;
  if (config.height) props.height = config.height;

  // Multi-series: if metrics are specified, use them as y array
  if (config.metrics && config.metrics.length > 0) {
    props.y = config.metrics;
  }

  // KPI-specific
  if (chartType === 'kpi' || chartType === 'metric') {
    if (config.formatting) props.format = config.formatting;
    if (config.compareToPrevious) props.compareToPrevious = true;
  }

  // Table-specific
  if (chartType === 'table') {
    if (config.columns) props.columns = config.columns;
    if (config.sortable) props.sortable = config.sortable;
    if (config.pageSize) props.maxRows = config.pageSize;
  }

  // Donut/pie
  if (chartType === 'donut' || chartType === 'pie') {
    if (config.x) props.label = config.x;
    if (config.y) props.value = config.y;
    if (config.innerRadius != null) {
      props.innerRadiusRatio = config.innerRadius;
    }
  }

  // Funnel / waterfall
  if (chartType === 'funnel' || chartType === 'waterfall') {
    if (config.x) props.label = config.x;
    if (config.y) props.value = config.y;
  }

  // Heatmap
  if (chartType === 'heatmap') {
    if (config.y) props.value = config.y;
  }

  return props;
}
