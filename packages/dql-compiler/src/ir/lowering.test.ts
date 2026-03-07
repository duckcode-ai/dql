import { describe, it, expect } from 'vitest';
import { parse, SemanticLayer } from '@dql/core';
import { lowerProgram } from './lowering.js';

describe('lowerProgram', () => {
  it('keeps layout chart ids in sync when filters are present in rows', () => {
    const source = `dashboard "Layout Test" {
      layout(columns = 12) {
        row {
          chart.bar(
            SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
            x = category,
            y = total
          ) span 6
          filter.dropdown(
            SELECT DISTINCT category FROM orders,
            label = "Category",
            param = "category"
          ) span 6
        }
        row {
          chart.line(
            SELECT date, SUM(revenue) as total FROM orders GROUP BY date,
            x = date,
            y = total
          ) span 12
        }
      }
    }`;

    const ast = parse(source);
    const dashboards = lowerProgram(ast);
    expect(dashboards).toHaveLength(1);

    const [dashboard] = dashboards;
    expect(dashboard.charts.map((c) => c.id)).toEqual(['chart-0', 'chart-1']);
    expect(dashboard.layout.items.map((item) => item.chartId)).toEqual(['chart-0', 'chart-1']);
  });

  it('auto-places charts missing from explicit layout and emits diagnostics', () => {
    const source = `dashboard "Layout Missing Chart" {
      layout(columns = 12) {
        row {
          chart.bar(
            SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
            x = category,
            y = total
          ) span 12
        }
      }

      chart.line(
        SELECT date, SUM(revenue) as total FROM orders GROUP BY date,
        x = date,
        y = total
      )
    }`;

    const ast = parse(source);
    const dashboards = lowerProgram(ast);
    expect(dashboards).toHaveLength(1);

    const [dashboard] = dashboards;
    expect(dashboard.charts.map((c) => c.id)).toEqual(['chart-0', 'chart-1']);
    expect(dashboard.layout.items.map((item) => item.chartId)).toEqual(['chart-0', 'chart-1']);
    expect(dashboard.layoutDiagnostics?.some((diag) => diag.message.includes('missing from explicit layout'))).toBe(true);
  });

  it('emits layout diagnostics when row spans exceed configured columns', () => {
    const source = `dashboard "Layout Overflow" {
      layout(columns = 4) {
        row {
          chart.bar(
            SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
            x = category,
            y = total
          ) span 5
        }
      }
    }`;

    const ast = parse(source);
    const dashboards = lowerProgram(ast);
    expect(dashboards).toHaveLength(1);

    const [dashboard] = dashboards;
    expect(dashboard.layoutDiagnostics?.some((diag) => diag.message.includes('exceeds 4 columns'))).toBe(true);
  });

  it('lowers hierarchy drill config with semantic layer levels and rollup', () => {
    const source = `dashboard "Hierarchy Drill" {
      chart.bar(
        SELECT order_year, SUM(revenue) as revenue FROM orders GROUP BY order_year,
        x = order_year,
        y = revenue,
        drill_hierarchy = "time_hierarchy",
        drill_path = "calendar",
        drill_mode = "replace"
      )
    }`;

    const semanticLayer = new SemanticLayer({
      metrics: [],
      dimensions: [],
      hierarchies: [
        {
          name: 'time_hierarchy',
          label: 'Time',
          description: 'Time hierarchy',
          defaultRollup: 'sum',
          defaultDrillPath: 'calendar',
          levels: [
            { name: 'year', label: 'Year', description: '', dimension: 'order_year', order: 1 },
            { name: 'quarter', label: 'Quarter', description: '', dimension: 'order_quarter', order: 2 },
            { name: 'month', label: 'Month', description: '', dimension: 'order_month', order: 3 },
          ],
          drillPaths: [
            { name: 'calendar', levels: ['year', 'quarter', 'month'] },
          ],
        },
      ],
    });

    const ast = parse(source);
    const diagnostics: string[] = [];
    const dashboards = lowerProgram(ast, { semanticLayer, diagnostics });

    expect(diagnostics).toHaveLength(0);
    const drillConfig = dashboards[0].charts[0].drillConfig;
    expect(drillConfig).toBeDefined();
    expect(drillConfig?.hierarchy).toBe('time_hierarchy');
    expect(drillConfig?.path).toBe('calendar');
    expect(drillConfig?.mode).toBe('replace');
    expect(drillConfig?.rollup).toBe('sum');
    expect(drillConfig?.levels?.map((l) => l.dimension)).toEqual(['order_year', 'order_quarter', 'order_month']);
  });

  it('emits diagnostics when hierarchy or drill path cannot be resolved', () => {
    const source = `dashboard "Bad Hierarchy Drill" {
      chart.bar(
        SELECT order_year, SUM(revenue) as revenue FROM orders GROUP BY order_year,
        x = order_year,
        y = revenue,
        drill_hierarchy = "unknown_hierarchy",
        drill_path = "calendar"
      )
    }`;

    const semanticLayer = new SemanticLayer({ metrics: [], dimensions: [], hierarchies: [] });
    const ast = parse(source);
    const diagnostics: string[] = [];
    const dashboards = lowerProgram(ast, { semanticLayer, diagnostics });

    expect(dashboards).toHaveLength(1);
    expect(dashboards[0].charts[0].drillConfig?.hierarchy).toBe('unknown_hierarchy');
    expect(diagnostics.some((d) => d.includes("Unknown drill hierarchy 'unknown_hierarchy'"))).toBe(true);
  });
});
