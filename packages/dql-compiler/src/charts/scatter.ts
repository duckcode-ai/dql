import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitScatterChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, size, xAxisLabel, yAxisLabel } = chart.config;

  const encoding: Record<string, unknown> = {
    x: {
      field: x,
      type: 'quantitative',
      axis: { title: xAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
    },
    y: {
      field: y,
      type: 'quantitative',
      axis: { title: yAxisLabel ?? y, labelColor: theme.axisColor, titleColor: theme.axisColor },
    },
  };

  if (size) {
    encoding.size = { field: size, type: 'quantitative' };
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    mark: {
      type: 'point',
      color: chart.config.color ?? theme.colors[0],
      filled: true,
    },
    encoding,
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
