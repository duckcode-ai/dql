import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitComboChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, color, xAxisLabel, yAxisLabel } = chart.config;
  const y2 = chart.config.y2; // explicit secondary measure for combo charts

  const spec: VegaLiteSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    mark: { type: 'bar' },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
    layer: [
      {
        mark: {
          type: 'bar',
          color: color ?? theme.colors[0],
        },
        encoding: {
          x: {
            field: x,
            type: 'nominal',
            axis: { title: xAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
          },
          y: {
            field: y,
            type: 'quantitative',
            axis: { title: yAxisLabel ?? y, labelColor: theme.axisColor, titleColor: theme.axisColor },
          },
        },
      },
      {
        mark: {
          type: 'line',
          color: theme.colors[1],
          strokeWidth: chart.config.lineWidth ?? 2,
          point: true,
        },
        encoding: {
          x: {
            field: x,
            type: 'nominal',
          },
          y: {
            field: y2 ?? y,
            type: 'quantitative',
          },
        },
      },
    ],
  };

  return spec;
}
