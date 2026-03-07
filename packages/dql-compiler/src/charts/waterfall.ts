import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

export function emitWaterfallChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, xAxisLabel, yAxisLabel } = chart.config;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 300,
    transform: [
      { window: [{ op: 'sum', field: y, as: '_dql_sum' }] },
      { calculate: 'datum._dql_sum - datum.' + y, as: '_dql_prev_sum' },
    ],
    mark: { type: 'bar' },
    encoding: {
      x: {
        field: x,
        type: 'nominal',
        sort: null,
        axis: { title: xAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      y: {
        field: '_dql_prev_sum',
        type: 'quantitative',
        axis: { title: yAxisLabel ?? y, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      y2: { field: '_dql_sum' },
      color: {
        condition: { test: `datum.${y} >= 0`, value: theme.colors[0] },
        value: theme.colors[4] ?? '#E45756',
      },
    },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
