import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitPieChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, innerRadius } = chart.config;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 300,
    height: chart.config.height ?? 300,
    mark: {
      type: 'arc',
      ...(innerRadius != null ? { innerRadius } : {}),
    },
    encoding: {
      theta: { field: y, type: 'quantitative' },
      color: {
        field: x,
        type: 'nominal',
        scale: { range: theme.colors },
      },
    },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
