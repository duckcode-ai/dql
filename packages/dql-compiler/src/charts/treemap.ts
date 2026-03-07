import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

/**
 * Treemap MVP: emitted as a slice treemap using Vega-Lite transforms.
 * It preserves area proportionality via normalized cumulative ranges.
 */
export function emitTreemapChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const { x, y, colorField } = chart.config;
  const groupField = x || 'category';
  const valueField = y || 'value';
  const colorBy = colorField || groupField;

  const tooltip = [
    { field: groupField, type: 'nominal', title: groupField },
    { field: valueField, type: 'quantitative', title: valueField },
  ];

  if (colorBy !== groupField) {
    tooltip.push({ field: colorBy, type: 'nominal', title: colorBy });
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 260,
    mark: {
      type: 'rect',
      stroke: theme.background,
      strokeWidth: 1,
    },
    transform: [
      {
        window: [{ op: 'sum', field: valueField, as: '__cum' }],
        sort: [{ field: valueField, order: 'descending' }],
      },
      { calculate: `datum.__cum - datum["${valueField}"]`, as: '__start' },
      { joinaggregate: [{ op: 'sum', field: valueField, as: '__total' }] },
      { calculate: 'datum.__start / datum.__total', as: '__x0' },
      { calculate: 'datum.__cum / datum.__total', as: '__x1' },
    ],
    encoding: {
      x: {
        field: '__x0',
        type: 'quantitative',
        axis: null,
      },
      x2: {
        field: '__x1',
      },
      y: { value: 0 },
      y2: { value: 1 },
      color: {
        field: colorBy,
        type: 'nominal',
        legend: chart.config.showLegend === false ? null : undefined,
      },
      tooltip,
    },
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
