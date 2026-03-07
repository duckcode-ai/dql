import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitGaugeChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { y } = chart.config;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 200,
    height: chart.config.height ?? 200,
    layer: [
      {
        mark: {
          type: 'arc',
          innerRadius: 60,
          outerRadius: 90,
          theta: { expr: '0' },
          theta2: { expr: 'PI' },
          color: theme.gridColor,
        },
      },
      {
        mark: {
          type: 'arc',
          innerRadius: 60,
          outerRadius: 90,
        },
        encoding: {
          theta: {
            field: y,
            type: 'quantitative',
            scale: { domain: [0, 100] },
          },
          color: {
            value: theme.colors[0],
          },
        },
      },
      {
        mark: {
          type: 'text',
          fontSize: 28,
          fontWeight: 'bold',
          color: theme.titleColor,
        },
        encoding: {
          text: { field: y, type: 'quantitative' },
        },
      },
    ],
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
