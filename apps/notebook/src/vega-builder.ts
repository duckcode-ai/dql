import type { VizConfig } from './notebook-engine.js';

export interface VegaSpec {
  $schema: string;
  width: number | string;
  height: number | string;
  data: { values: Record<string, unknown>[] };
  mark: unknown;
  encoding?: unknown;
  layer?: unknown[];
  [key: string]: unknown;
}

export function buildVegaSpec(
  viz: VizConfig,
  rows: Record<string, unknown>[],
  columns: { name: string; type: string }[],
): VegaSpec {
  const $schema = 'https://vega.github.io/schema/vega-lite/v5.json';
  const colTypes: Record<string, string> = {};
  for (const c of columns) colTypes[c.name] = c.type;

  function fieldType(field?: string): 'quantitative' | 'nominal' | 'temporal' | 'ordinal' {
    if (!field) return 'nominal';
    const t = (colTypes[field] ?? '').toLowerCase();
    if (t.includes('int') || t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('number')) return 'quantitative';
    if (t.includes('date') || t.includes('time') || t.includes('timestamp')) return 'temporal';
    return 'nominal';
  }

  const base: Partial<VegaSpec> = {
    $schema,
    width: 'container',
    height: 280,
    data: { values: rows },
  };

  switch (viz.chart) {
    case 'bar':
    case 'stacked_bar':
    case 'grouped_bar':
      return {
        ...base,
        mark: { type: 'bar', color: viz.color ?? '#6366f1', cornerRadiusTopLeft: 3, cornerRadiusTopRight: 3 },
        encoding: {
          x: { field: viz.x, type: fieldType(viz.x), axis: { labelAngle: -30 } },
          y: { field: viz.y as string, type: 'quantitative', title: viz.y as string },
          ...(viz.color && !viz.color.startsWith('#') ? { color: { field: viz.color, type: 'nominal' } } : {}),
          tooltip: [
            { field: viz.x, type: fieldType(viz.x) },
            { field: viz.y as string, type: 'quantitative', format: viz.format === 'currency' ? '$,.0f' : ',.0f' },
          ],
        },
      } as VegaSpec;

    case 'line':
    case 'area':
      return {
        ...base,
        mark: { type: viz.chart === 'area' ? 'area' : 'line', color: viz.color ?? '#6366f1', point: true, strokeWidth: 2 },
        encoding: {
          x: { field: viz.x, type: fieldType(viz.x) },
          y: { field: viz.y as string, type: 'quantitative' },
          tooltip: [
            { field: viz.x, type: fieldType(viz.x) },
            { field: viz.y as string, type: 'quantitative' },
          ],
        },
      } as VegaSpec;

    case 'scatter':
      return {
        ...base,
        mark: { type: 'point', color: viz.color ?? '#6366f1', size: 80 },
        encoding: {
          x: { field: viz.x, type: fieldType(viz.x) },
          y: { field: viz.y as string, type: 'quantitative' },
          ...(viz.color && !viz.color.startsWith('#') ? { color: { field: viz.color, type: 'nominal' } } : {}),
          tooltip: columns.map(c => ({ field: c.name, type: fieldType(c.name) })),
        },
      } as VegaSpec;

    case 'pie':
    case 'donut': {
      const inner = viz.chart === 'donut' ? 50 : 0;
      return {
        ...base,
        width: 280, height: 280,
        mark: { type: 'arc', innerRadius: inner },
        encoding: {
          theta: { field: viz.value ?? viz.y as string, type: 'quantitative' },
          color: { field: viz.label ?? viz.x, type: 'nominal', legend: { orient: 'bottom' } },
          tooltip: [
            { field: viz.label ?? viz.x, type: 'nominal' },
            { field: viz.value ?? viz.y as string, type: 'quantitative' },
          ],
        },
      } as VegaSpec;
    }

    case 'kpi': {
      // Show as a simple stat card — return first row, first value column
      const valField = viz.value ?? (columns.find(c => fieldType(c.name) === 'quantitative')?.name) ?? columns[0]?.name;
      const val = rows[0]?.[valField!] ?? 0;
      const formatted = viz.format === 'currency'
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact' }).format(Number(val))
        : new Intl.NumberFormat('en-US', { notation: 'compact' }).format(Number(val));
      // Return a text mark spec for KPI
      return {
        $schema,
        width: 'container',
        height: 120,
        data: { values: [{ label: valField, value: formatted }] },
        mark: { type: 'text', fontSize: 48, fontWeight: 'bold', color: viz.color ?? '#6366f1' },
        encoding: {
          text: { field: 'value', type: 'nominal' },
        },
        view: { stroke: null },
      } as VegaSpec;
    }

    case 'table':
    default:
      // Fallback: show a Vega-Lite table (use first two columns)
      return {
        ...base,
        mark: { type: 'bar', color: '#6366f1' },
        encoding: {
          x: { field: columns[0]?.name, type: fieldType(columns[0]?.name) },
          y: { field: columns[1]?.name, type: 'quantitative' },
        },
      } as VegaSpec;
  }
}
