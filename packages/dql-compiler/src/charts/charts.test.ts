import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllCharts, emitChart } from './index.js';
import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';

const lightTheme: ThemeConfig = {
  name: 'light',
  background: '#ffffff',
  foreground: '#1a1a2e',
  cardBackground: '#ffffff',
  borderColor: '#e2e8f0',
  fontFamily: 'Inter, system-ui, sans-serif',
  colors: ['#4ECDC4', '#FF6B6B', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'],
  gridColor: '#e2e8f0',
  axisColor: '#718096',
  titleColor: '#1a1a2e',
  textColor: '#4a5568',
};

function makeChart(overrides: Partial<ChartIR>): ChartIR {
  return {
    id: 'test-chart',
    chartType: 'line',
    sql: 'SELECT x, y FROM data',
    sqlParams: [],
    config: { x: 'x', y: 'y' },
    ...overrides,
  };
}

beforeAll(() => {
  registerAllCharts();
});

describe('line chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'line', config: { x: 'date', y: 'revenue' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
    expect(spec!.mark).toBeDefined();
    expect(spec!.encoding).toBeDefined();
    expect(spec!.data).toEqual({ values: [] });
  });

  it('includes x and y encoding', () => {
    const chart = makeChart({ chartType: 'line', config: { x: 'date', y: 'revenue' } });
    const spec = emitChart(chart, lightTheme)!;
    expect(spec.encoding!.x).toBeDefined();
    expect(spec.encoding!.y).toBeDefined();
  });

  it('applies title from config', () => {
    const chart = makeChart({ chartType: 'line', title: 'Revenue Trend', config: { x: 'date', y: 'val' } });
    const spec = emitChart(chart, lightTheme)!;
    const titleText = typeof spec.title === 'string' ? spec.title : (spec.title as any)?.text;
    expect(titleText).toBe('Revenue Trend');
  });
});

describe('bar chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'bar', config: { x: 'category', y: 'count' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });

  it('uses bar mark', () => {
    const chart = makeChart({ chartType: 'bar', config: { x: 'category', y: 'count' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('bar');
  });
});

describe('pie chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'pie', config: { x: 'category', y: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });

  it('uses arc mark', () => {
    const chart = makeChart({ chartType: 'pie', config: { x: 'category', y: 'value' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('arc');
  });
});

describe('scatter chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'scatter', config: { x: 'weight', y: 'height' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
  });

  it('uses point mark', () => {
    const chart = makeChart({ chartType: 'scatter', config: { x: 'weight', y: 'height' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('point');
  });
});

describe('area chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'area', config: { x: 'date', y: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
  });

  it('uses area mark', () => {
    const chart = makeChart({ chartType: 'area', config: { x: 'date', y: 'value' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('area');
  });
});

describe('heatmap chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'heatmap', config: { x: 'day', y: 'hour', color: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
  });

  it('uses rect mark', () => {
    const chart = makeChart({ chartType: 'heatmap', config: { x: 'day', y: 'hour', color: 'value' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('rect');
  });
});

describe('stacked_bar chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'stacked_bar', config: { x: 'month', y: 'revenue', color: 'region' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });
});

describe('grouped_bar chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'grouped_bar', config: { x: 'month', y: 'revenue', color: 'region' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
  });
});

describe('combo chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'combo', config: { x: 'date', y: 'revenue', color: 'trend' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
  });
});

describe('histogram chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'histogram', config: { x: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
  });
});

describe('funnel chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'funnel', config: { x: 'stage', y: 'count' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });

  it('uses bar mark', () => {
    const chart = makeChart({ chartType: 'funnel', config: { x: 'stage', y: 'count' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('bar');
  });
});

describe('treemap chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'treemap', config: { x: 'category', y: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
    expect((spec as any).transform).toBeDefined();
  });

  it('uses rect mark', () => {
    const chart = makeChart({ chartType: 'treemap', config: { x: 'category', y: 'value' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('rect');
  });
});

describe('sankey chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'sankey', config: { x: 'source', y: 'value', colorField: 'target' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
    expect((spec as any).layer).toBeDefined();
  });

  it('uses rule links in first layer', () => {
    const chart = makeChart({ chartType: 'sankey', config: { x: 'source', y: 'value', colorField: 'target' } });
    const spec = emitChart(chart, lightTheme)! as any;
    const firstLayerMark = spec.layer?.[0]?.mark;
    const markType = typeof firstLayerMark === 'string' ? firstLayerMark : firstLayerMark?.type;
    expect(markType).toBe('rule');
  });
});

describe('sparkline chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'sparkline', config: { x: 'date', y: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });

  it('uses a line mark and hidden axes', () => {
    const chart = makeChart({ chartType: 'sparkline', config: { x: 'date', y: 'value' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('line');
    expect((spec.encoding as any)?.x?.axis).toBeNull();
    expect((spec.encoding as any)?.y?.axis).toBeNull();
  });
});

describe('small_multiples chart emitter', () => {
  it('produces a valid Vega-Lite facet spec', () => {
    const chart = makeChart({ chartType: 'small_multiples', config: { x: 'date', y: 'value', facet: 'region' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
    expect((spec as any).facet).toBeDefined();
    expect((spec as any).spec).toBeDefined();
  });

  it('uses line mark in the inner spec', () => {
    const chart = makeChart({ chartType: 'small_multiples', config: { x: 'date', y: 'value', facet: 'region' } });
    const spec = emitChart(chart, lightTheme)! as any;
    const innerMark = spec.spec?.mark;
    const markType = typeof innerMark === 'string' ? innerMark : innerMark?.type;
    expect(markType).toBe('line');
  });
});

describe('gauge chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'gauge', config: { x: 'label', y: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });

  it('uses layered spec', () => {
    const chart = makeChart({ chartType: 'gauge', config: { x: 'label', y: 'value' } });
    const spec = emitChart(chart, lightTheme)!;
    expect((spec as any).layer).toBeDefined();
  });
});

describe('waterfall chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'waterfall', config: { x: 'category', y: 'amount' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });
});

describe('boxplot chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'boxplot', config: { x: 'group', y: 'value' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });

  it('uses boxplot mark', () => {
    const chart = makeChart({ chartType: 'boxplot', config: { x: 'group', y: 'value' } });
    const spec = emitChart(chart, lightTheme)!;
    const markType = typeof spec.mark === 'string' ? spec.mark : (spec.mark as any)?.type;
    expect(markType).toBe('boxplot');
  });
});

describe('geo chart emitter', () => {
  it('produces a valid Vega-Lite spec', () => {
    const chart = makeChart({ chartType: 'geo', config: { x: 'longitude', y: 'latitude' } });
    const spec = emitChart(chart, lightTheme);
    expect(spec).not.toBeNull();
    expect(spec!.$schema).toContain('vega-lite');
  });

  it('has a layer with geoshape and circle marks', () => {
    const chart = makeChart({ chartType: 'geo', config: { x: 'longitude', y: 'latitude' } });
    const spec = emitChart(chart, lightTheme)!;
    expect((spec as any).layer).toBeDefined();
    expect((spec as any).layer.length).toBe(2);
  });
});

describe('chart emitter registry', () => {
  it('returns null for unknown chart type', () => {
    const chart = makeChart({ chartType: 'nonexistent' as any });
    const spec = emitChart(chart, lightTheme);
    expect(spec).toBeNull();
  });

  it('all registered chart types produce specs', () => {
    const chartTypes = [
      'line', 'bar', 'scatter', 'area', 'pie', 'heatmap',
      'stacked_bar', 'grouped_bar', 'combo', 'histogram',
      'funnel', 'treemap', 'sankey', 'sparkline', 'small_multiples', 'gauge', 'waterfall', 'boxplot', 'geo',
    ];

    for (const type of chartTypes) {
      const chart = makeChart({ chartType: type as any, config: { x: 'a', y: 'b', color: 'c' } });
      const spec = emitChart(chart, lightTheme);
      expect(spec, `${type} should produce a spec`).not.toBeNull();
      expect(spec!.$schema, `${type} should have $schema`).toContain('vega-lite');
    }
  });

  it('all specs have empty data values placeholder', () => {
    const chartTypes = ['line', 'bar', 'pie', 'scatter', 'area', 'funnel', 'sparkline', 'small_multiples', 'boxplot', 'geo'];
    for (const type of chartTypes) {
      const chart = makeChart({ chartType: type as any, config: { x: 'a', y: 'b' } });
      const spec = emitChart(chart, lightTheme)!;
      expect(spec.data, `${type} should have data`).toBeDefined();
      expect(spec.data.values, `${type} should have empty values`).toEqual([]);
    }
  });
});

describe('theme application', () => {
  it('applies theme colors to chart config', () => {
    const chart = makeChart({ chartType: 'bar', config: { x: 'cat', y: 'val' } });
    const spec = emitChart(chart, lightTheme)!;
    expect(spec.config).toBeDefined();
  });

  it('uses different theme colors for dark theme', () => {
    const darkTheme: ThemeConfig = {
      ...lightTheme,
      name: 'dark',
      background: '#1a1a2e',
      foreground: '#e2e8f0',
    };
    const chart = makeChart({ chartType: 'line', config: { x: 'x', y: 'y' } });
    const spec = emitChart(chart, darkTheme)!;
    expect(spec.config).toBeDefined();
  });
});
