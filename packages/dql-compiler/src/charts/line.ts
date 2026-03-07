import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle, buildTooltipEncoding, applyAxisFormat } from './shared.js';

export function emitLineChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, lineWidth, fillOpacity, xAxisLabel, yAxisLabel } = chart.config;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    mark: {
      type: 'line',
      strokeWidth: lineWidth ?? 2,
      ...(fillOpacity != null ? { fillOpacity } : {}),
      color: chart.config.color ?? theme.colors[0],
    },
    encoding: (() => {
      const enc: Record<string, unknown> = {
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
      };
      const tt = buildTooltipEncoding(chart);
      if (tt) enc.tooltip = tt;
      applyAxisFormat(enc, chart);
      return enc;
    })(),
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
