import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitFunnelChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, xAxisLabel, yAxisLabel } = chart.config;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    mark: {
      type: 'bar',
      cornerRadiusEnd: 4,
    },
    encoding: {
      y: {
        field: x,
        type: 'nominal',
        sort: { field: y, order: 'descending' as const },
        axis: { title: yAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      x: {
        field: y,
        type: 'quantitative',
        axis: { title: xAxisLabel ?? y, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      color: {
        field: x,
        type: 'nominal',
        scale: { range: theme.colors },
        legend: null,
      },
    },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
