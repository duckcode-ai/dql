import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';

export function buildTitle(
  chart: ChartIR,
  theme: ThemeConfig,
): string | { text: string; fontSize?: number; color?: string } | undefined {
  if (!chart.title) return undefined;

  if (chart.config.titleFontSize) {
    return {
      text: chart.title,
      fontSize: chart.config.titleFontSize,
      color: theme.titleColor,
    };
  }

  return chart.title;
}

export function buildTooltipEncoding(chart: ChartIR): unknown[] | undefined {
  if (!chart.config.tooltip || chart.config.tooltip.length === 0) return undefined;
  return chart.config.tooltip.map((field) => ({ field, type: 'nominal' }));
}

export function applyAxisFormat(encoding: Record<string, unknown>, chart: ChartIR): void {
  if (chart.config.formatX && encoding.x) {
    (encoding.x as Record<string, unknown>).axis = {
      ...((encoding.x as Record<string, unknown>).axis as Record<string, unknown> ?? {}),
      format: chart.config.formatX,
    };
  }
  if (chart.config.formatY && encoding.y) {
    (encoding.y as Record<string, unknown>).axis = {
      ...((encoding.y as Record<string, unknown>).axis as Record<string, unknown> ?? {}),
      format: chart.config.formatY,
    };
  }
}

export function buildCommonConfig(chart: ChartIR, theme: ThemeConfig): Record<string, unknown> {
  return {
    background: theme.background,
    font: theme.fontFamily,
    title: { color: theme.titleColor, fontSize: 16 },
    axis: {
      gridColor: chart.config.showGrid !== false ? theme.gridColor : 'transparent',
      domainColor: theme.axisColor,
      tickColor: theme.axisColor,
      labelColor: theme.textColor,
      titleColor: theme.textColor,
    },
    legend: {
      ...(chart.config.showLegend === false ? { disable: true } : {}),
      labelColor: theme.textColor,
      titleColor: theme.textColor,
    },
    view: { stroke: 'transparent' },
  };
}
