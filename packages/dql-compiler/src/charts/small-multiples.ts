import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildCommonConfig, buildTitle, buildTooltipEncoding, applyAxisFormat } from './shared.js';

export function emitSmallMultiplesChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const x = chart.config.x || 'x';
  const y = chart.config.y || 'y';
  const facet = chart.config.facet || chart.config.colorField || 'facet';
  const colorField = chart.config.colorField;
  const tooltip = buildTooltipEncoding(chart) ?? [
    { field: facet, type: 'nominal', title: facet },
    { field: x, type: 'temporal', title: x },
    { field: y, type: 'quantitative', title: y },
  ];

  const innerSpec: Record<string, unknown> = {
    width: chart.config.width ?? 180,
    height: chart.config.height ?? 110,
    mark: {
      type: 'line',
      interpolate: 'monotone',
      strokeWidth: chart.config.lineWidth ?? 2,
      color: colorField ? undefined : (chart.config.color ?? theme.colors[0]),
    },
    encoding: {
      x: {
        field: x,
        type: 'temporal',
        axis: { title: chart.config.xAxisLabel ?? x, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      y: {
        field: y,
        type: 'quantitative',
        axis: { title: chart.config.yAxisLabel ?? y, labelColor: theme.axisColor, titleColor: theme.axisColor },
      },
      tooltip,
    },
  };

  if (colorField) {
    (innerSpec.encoding as Record<string, unknown>).color = {
      field: colorField,
      type: 'nominal',
      legend: chart.config.showLegend === false ? null : undefined,
    };
  }

  applyAxisFormat(innerSpec.encoding as Record<string, unknown>, chart);

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    data: { values: [] },
    facet: {
      field: facet,
      type: 'nominal',
      columns: 2,
    },
    spec: innerSpec,
    resolve: {
      scale: { y: 'independent' },
    },
    config: buildCommonConfig(chart, theme),
  };
}
