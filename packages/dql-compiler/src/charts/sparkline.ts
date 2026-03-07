import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle, buildTooltipEncoding, applyAxisFormat } from './shared.js';

export function emitSparklineChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const x = chart.config.x || 'x';
  const y = chart.config.y || 'y';
  const tooltip = buildTooltipEncoding(chart) ?? [
    { field: x, type: 'temporal', title: x },
    { field: y, type: 'quantitative', title: y },
  ];

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 72,
    mark: {
      type: 'line',
      interpolate: 'monotone',
      strokeWidth: chart.config.lineWidth ?? 2,
      color: chart.config.color ?? theme.colors[0],
    },
    encoding: (() => {
      const enc: Record<string, unknown> = {
        x: {
          field: x,
          type: 'temporal',
          axis: null,
        },
        y: {
          field: y,
          type: 'quantitative',
          axis: null,
        },
        tooltip,
      };
      applyAxisFormat(enc, chart);
      return enc;
    })(),
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
