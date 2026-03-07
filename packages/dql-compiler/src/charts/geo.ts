import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from './chart-registry.js';
import { buildTitle, buildCommonConfig } from './shared.js';

export function emitGeoChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec {
  const xField = chart.config.x ?? 'longitude';
  const yField = chart.config.y ?? 'latitude';
  const colorField = chart.config.color ?? chart.config.colorField;
  const sizeField = chart.config.size;
  const topologyUrl = chart.config.topologyUrl ?? 'https://cdn.jsdelivr.net/npm/vega-datasets@2/data/world-110m.json';

  const encoding: Record<string, unknown> = {
    longitude: { field: xField, type: 'quantitative' },
    latitude: { field: yField, type: 'quantitative' },
  };

  if (colorField) {
    encoding.color = {
      field: colorField,
      type: 'nominal',
      scale: { range: theme.colors },
    };
  }

  if (sizeField) {
    encoding.size = {
      field: sizeField,
      type: 'quantitative',
    };
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: buildTitle(chart, theme),
    width: chart.config.width ?? 'container',
    height: chart.config.height ?? 400,
    data: { values: [] },
    projection: { type: 'mercator' },
    layer: [
      {
        data: {
          url: topologyUrl,
          format: { type: 'topojson', feature: 'countries' },
        },
        mark: { type: 'geoshape', fill: theme.cardBackground, stroke: theme.borderColor },
      },
      {
        mark: { type: 'circle', opacity: 0.8 },
        encoding,
      },
    ],
    config: buildCommonConfig(chart, theme),
  };
}
