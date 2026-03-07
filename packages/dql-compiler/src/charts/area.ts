import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitAreaChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, fillOpacity, xAxisLabel, yAxisLabel } = chart.config;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    mark: {
      type: 'area',
      color: chart.config.color ?? theme.colors[0],
      opacity: fillOpacity ?? 0.5,
    },
    encoding: {
      x: {
        field: x,
        type: 'temporal',
        axis: { title: xAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      y: {
        field: y,
        type: 'quantitative',
        axis: { title: yAxisLabel ?? y, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
    },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
