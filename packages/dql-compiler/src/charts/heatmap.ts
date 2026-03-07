import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitHeatmapChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, colorField, xAxisLabel, yAxisLabel } = chart.config;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    mark: { type: 'rect' },
    encoding: {
      x: {
        field: x,
        type: 'nominal',
        axis: { title: xAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      y: {
        field: y,
        type: 'nominal',
        axis: { title: yAxisLabel ?? y, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      color: {
        field: colorField ?? y,
        type: 'quantitative',
        scale: { scheme: theme.name === 'dark' ? 'viridis' : 'blues' },
      },
    },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
