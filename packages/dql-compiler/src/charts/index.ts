export type { VegaLiteSpec, ChartEmitter } from './chart-registry.js';
export { registerChartEmitter, getChartEmitter, emitChart } from './chart-registry.js';
export { emitLineChart } from './line.js';
export { emitBarChart } from './bar.js';
export { emitScatterChart } from './scatter.js';
export { emitAreaChart } from './area.js';
export { emitPieChart } from './pie.js';
export { emitHeatmapChart } from './heatmap.js';
export { emitStackedBarChart } from './stacked-bar.js';
export { emitGroupedBarChart } from './grouped-bar.js';
export { emitComboChart } from './combo.js';
export { emitHistogramChart } from './histogram.js';
export { emitFunnelChart } from './funnel.js';
export { emitTreemapChart } from './treemap.js';
export { emitSankeyChart } from './sankey.js';
export { emitSparklineChart } from './sparkline.js';
export { emitSmallMultiplesChart } from './small-multiples.js';
export { emitGaugeChart } from './gauge.js';
export { emitWaterfallChart } from './waterfall.js';
export { emitBoxPlotChart } from './boxplot.js';
export { emitGeoChart } from './geo.js';
export { emitKPISpec, renderKPIHTML, type KPISpec } from './kpi.js';
export { emitTableSpec, renderTableHTML, type TableSpec } from './table.js';

import { registerChartEmitter } from './chart-registry.js';
import { emitLineChart } from './line.js';
import { emitBarChart } from './bar.js';
import { emitScatterChart } from './scatter.js';
import { emitAreaChart } from './area.js';
import { emitPieChart } from './pie.js';
import { emitHeatmapChart } from './heatmap.js';
import { emitStackedBarChart } from './stacked-bar.js';
import { emitGroupedBarChart } from './grouped-bar.js';
import { emitComboChart } from './combo.js';
import { emitHistogramChart } from './histogram.js';
import { emitFunnelChart } from './funnel.js';
import { emitTreemapChart } from './treemap.js';
import { emitSankeyChart } from './sankey.js';
import { emitSparklineChart } from './sparkline.js';
import { emitSmallMultiplesChart } from './small-multiples.js';
import { emitGaugeChart } from './gauge.js';
import { emitWaterfallChart } from './waterfall.js';
import { emitBoxPlotChart } from './boxplot.js';
import { emitGeoChart } from './geo.js';

export function registerAllCharts(): void {
  registerChartEmitter('line', emitLineChart);
  registerChartEmitter('bar', emitBarChart);
  registerChartEmitter('scatter', emitScatterChart);
  registerChartEmitter('area', emitAreaChart);
  registerChartEmitter('pie', emitPieChart);
  registerChartEmitter('heatmap', emitHeatmapChart);
  registerChartEmitter('stacked_bar', emitStackedBarChart);
  registerChartEmitter('grouped_bar', emitGroupedBarChart);
  registerChartEmitter('combo', emitComboChart);
  registerChartEmitter('histogram', emitHistogramChart);
  registerChartEmitter('funnel', emitFunnelChart);
  registerChartEmitter('treemap', emitTreemapChart);
  registerChartEmitter('sankey', emitSankeyChart);
  registerChartEmitter('sparkline', emitSparklineChart);
  registerChartEmitter('small_multiples', emitSmallMultiplesChart);
  registerChartEmitter('gauge', emitGaugeChart);
  registerChartEmitter('waterfall', emitWaterfallChart);
  registerChartEmitter('boxplot', emitBoxPlotChart);
  registerChartEmitter('geo', emitGeoChart);
  // Aliases — common spelling variants and missing types
  registerChartEmitter('forecast', emitLineChart);        // forecast = line with confidence band styling
  registerChartEmitter('stacked-bar', emitStackedBarChart);
  registerChartEmitter('grouped-bar', emitGroupedBarChart);
  registerChartEmitter('small-multiples', emitSmallMultiplesChart);
  registerChartEmitter('donut', emitPieChart);            // donut is a pie with innerRadius
}

// Auto-register on import
registerAllCharts();
