import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitHistogramChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, xAxisLabel, yAxisLabel } = chart.config;

  const spec: VegaLiteSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    mark: {
      type: 'bar',
      color: chart.config.color ?? theme.colors[0],
    },
    encoding: {
      x: {
        field: x,
        type: 'quantitative',
        bin: true,
        axis: { title: xAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      y: {
        ...(y
          ? { field: y, type: 'quantitative' as const }
          : { aggregate: 'count' as const, type: 'quantitative' as const }),
        axis: { title: yAxisLabel ?? y ?? 'Count', labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
    },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };

  return spec;
}
