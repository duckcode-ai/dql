import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle } from './shared.js';

/**
 * Sankey MVP in Vega-Lite:
 * - links as rule marks from source node (left) to target node (right)
 * - node points + labels derived from folded source/target fields
 */
export function emitSankeyChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const sourceField = chart.config.x || 'source';
  const valueField = chart.config.y || 'value';
  const targetField = chart.config.colorField || 'target';

  const legendOrNull = chart.config.showLegend === false ? null : undefined;

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 340,
    transform: [
      {
        filter: `datum["${sourceField}"] != null && datum["${targetField}"] != null && datum["${valueField}"] != null`,
      },
    ],
    layer: [
      {
        mark: {
          type: 'rule',
          opacity: 0.45,
        },
        encoding: {
          x: {
            datum: 'source',
            type: 'nominal',
            axis: { title: null, labelColor: theme.axisColor, titleColor: theme.axisColor },
          },
          x2: { datum: 'target' },
          y: {
            field: sourceField,
            type: 'nominal',
            axis: { title: sourceField, labelColor: theme.axisColor, titleColor: theme.axisColor },
          },
          y2: {
            field: targetField,
          },
          size: {
            field: valueField,
            type: 'quantitative',
            legend: { title: valueField },
          },
          color: {
            field: targetField,
            type: 'nominal',
            legend: legendOrNull,
          },
          tooltip: [
            { field: sourceField, type: 'nominal', title: 'Source' },
            { field: targetField, type: 'nominal', title: 'Target' },
            { field: valueField, type: 'quantitative', title: 'Value' },
          ],
        },
      },
      {
        transform: [
          { fold: [sourceField, targetField], as: ['stage', 'node'] },
          { aggregate: [{ op: 'sum', field: valueField, as: '__node_value' }], groupby: ['stage', 'node'] },
        ],
        mark: {
          type: 'point',
          filled: true,
          size: 70,
          opacity: 0.95,
          stroke: theme.background,
          strokeWidth: 1,
        },
        encoding: {
          x: {
            field: 'stage',
            type: 'nominal',
            axis: null,
          },
          y: {
            field: 'node',
            type: 'nominal',
            axis: null,
          },
          color: {
            field: 'node',
            type: 'nominal',
            legend: null,
          },
          tooltip: [
            { field: 'stage', type: 'nominal', title: 'Stage' },
            { field: 'node', type: 'nominal', title: 'Node' },
            { field: '__node_value', type: 'quantitative', title: 'Flow' },
          ],
        },
      },
      {
        transform: [
          { fold: [sourceField, targetField], as: ['stage', 'node'] },
          { aggregate: [{ op: 'sum', field: valueField, as: '__node_value' }], groupby: ['stage', 'node'] },
        ],
        mark: {
          type: 'text',
          align: 'left',
          baseline: 'middle',
          dx: 8,
          fontSize: 11,
          color: theme.textColor,
        },
        encoding: {
          x: { field: 'stage', type: 'nominal' },
          y: { field: 'node', type: 'nominal' },
          text: { field: 'node' },
        },
      },
    ],
    data: { values: [] },
    config: buildCommonConfig(chart, theme),
  };
}
