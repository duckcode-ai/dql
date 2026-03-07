import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';

export interface VegaLiteSpec {
  $schema: string;
  description?: string;
  title?: string | { text: string; fontSize?: number };
  width?: number | 'container';
  height?: number | 'container';
  mark?: unknown;
  encoding?: Record<string, unknown>;
  data: { values: unknown[] };
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ChartEmitter = (chart: ChartIR, theme: ThemeConfig) => VegaLiteSpec | null;

const registry = new Map<string, ChartEmitter>();

export function registerChartEmitter(chartType: string, emitter: ChartEmitter): void {
  registry.set(chartType, emitter);
}

export function getChartEmitter(chartType: string): ChartEmitter | undefined {
  return registry.get(chartType);
}

export function emitChart(chart: ChartIR, theme: ThemeConfig): VegaLiteSpec | null {
  const emitter = registry.get(chart.chartType);
  if (!emitter) return null;
  return emitter(chart, theme);
}
