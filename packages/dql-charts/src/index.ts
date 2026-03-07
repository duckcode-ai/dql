// Themes
export type { ChartTheme } from './themes/index.js';
export { editorialDark, editorialLight } from './themes/index.js';

// Primitives
export { ChartContainer } from './primitives/index.js';
export type { ChartContainerProps } from './primitives/index.js';
export { ChartTooltipContent, TooltipPortal, useChartTooltip } from './primitives/index.js';
export type { TooltipData } from './primitives/index.js';

// Components
export {
  BarChart,
  LineChart,
  ScatterChart,
  DonutChart,
  KPICard,
  DataTable,
  GroupedBarChart,
  StackedAreaChart,
  ForecastChart,
  HeatmapChart,
  FunnelChart,
  WaterfallChart,
  BoxPlotChart,
  ChartRenderer,
} from './components/index.js';
export type {
  BarChartProps,
  LineChartProps,
  ScatterChartProps,
  DonutChartProps,
  KPICardProps,
  DataTableProps,
  GroupedBarChartProps,
  StackedAreaChartProps,
  ForecastChartProps,
  HeatmapChartProps,
  FunnelChartProps,
  WaterfallChartProps,
  BoxPlotChartProps,
  BoxPlotDatum,
  ChartRendererProps,
  ChartType,
} from './components/index.js';

// Content Blocks
export {
  NarrativeBlock,
  SQLBlock,
  UserNoteBlock,
  PredictionBlock,
} from './blocks/index.js';
export type {
  NarrativeBlockProps,
  SQLBlockProps,
  UserNoteBlockProps,
  PredictionBlockProps,
} from './blocks/index.js';

// Utilities
export {
  formatNumber,
  formatCompact,
  formatCurrency,
  formatPercent,
  formatDate,
  autoFormat,
  getSeriesColor,
  getSeriesColors,
  withOpacity,
} from './utils/index.js';
export type { FormatType } from './utils/index.js';
