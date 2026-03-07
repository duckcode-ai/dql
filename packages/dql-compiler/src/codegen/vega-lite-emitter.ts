import type { ChartIR, InteractionConfig } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { VegaLiteSpec } from '../charts/chart-registry.js';
import { emitChart } from '../charts/chart-registry.js';
import { emitKPISpec, type KPISpec } from '../charts/kpi.js';
import { emitTableSpec, type TableSpec } from '../charts/table.js';

export type ChartSpec =
  | { kind: 'vega-lite'; chartId: string; spec: VegaLiteSpec; interaction?: InteractionConfig }
  | { kind: 'kpi'; chartId: string; spec: KPISpec; interaction?: InteractionConfig }
  | { kind: 'table'; chartId: string; spec: TableSpec; interaction?: InteractionConfig };

export function emitChartSpecs(charts: ChartIR[], theme: ThemeConfig): ChartSpec[] {
  return charts.map((chart) => {
    if (chart.chartType === 'kpi' || chart.chartType === 'metric') {
      return {
        kind: 'kpi' as const,
        chartId: chart.id,
        spec: emitKPISpec(chart, theme),
        interaction: chart.interaction,
      };
    }

    if (chart.chartType === 'table') {
      return {
        kind: 'table' as const,
        chartId: chart.id,
        spec: emitTableSpec(chart, theme),
        interaction: chart.interaction,
      };
    }

    let spec = emitChart(chart, theme);
    if (!spec) {
      throw new Error(`No emitter registered for chart type '${chart.chartType}'`);
    }

    // Add Vega-Lite selection params for interactive charts
    if (chart.interaction) {
      spec = addInteractionParams(spec, chart.interaction, chart.config.x);
    }

    return {
      kind: 'vega-lite' as const,
      chartId: chart.id,
      spec,
      interaction: chart.interaction,
    };
  });
}

function addInteractionParams(
  spec: VegaLiteSpec,
  interaction: InteractionConfig,
  xField?: string,
): VegaLiteSpec {
  const params: unknown[] = [];

  // Add point selection for click-based interactions (drill_down, link_to, on_click)
  if (interaction.drillDown || interaction.linkTo || interaction.onClick) {
    params.push({
      name: 'dql_click',
      select: {
        type: 'point',
        on: 'click',
        encodings: xField ? ['x'] : undefined,
      },
    });

    // Add hover highlight for clickable charts
    params.push({
      name: 'dql_hover',
      select: {
        type: 'point',
        on: 'pointerover',
        clear: 'pointerout',
      },
    });

    // Add conditional opacity to show hover state
    if (spec.encoding) {
      spec.encoding.opacity = {
        condition: { param: 'dql_hover', value: 1 },
        value: 0.7,
      };
    }
  }

  // Add interval selection for filter_by interactions (brush select)
  if (interaction.filterBy) {
    const fields = Array.isArray(interaction.filterBy)
      ? interaction.filterBy
      : [interaction.filterBy];

    params.push({
      name: 'dql_filter',
      select: {
        type: 'point',
        fields,
      },
    });

    // Add conditional color for filter selection
    if (spec.encoding) {
      spec.encoding.opacity = {
        condition: { param: 'dql_filter', value: 1 },
        value: 0.3,
      };
    }
  }

  if (params.length > 0) {
    spec.params = params;
  }

  return spec;
}
