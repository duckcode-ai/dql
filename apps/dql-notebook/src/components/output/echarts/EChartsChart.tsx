import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { CellChartConfig, QueryResult } from '../../../store/types';
import type { ThemeMode } from '../../../themes/notebook-theme';
import type { ChartType } from '../chart-helpers';
import { buildVizOption, type VizOptionOutput } from './viz-option';

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, FunnelChart,
  AriaComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, VisualMapComponent,
  SVGRenderer,
]);

export interface EChartsChartProps {
  chartType: ChartType;
  result: QueryResult;
  themeMode: ThemeMode;
  config?: CellChartConfig;
  availableHeight?: number;
  availableWidth?: number;
  /** App cross-filter hook: receives the typed result row behind a mark. */
  onMarkSelect?: (row: Record<string, unknown>) => void;
  /** Drawn instead when ECharts has nothing to draw for this data. */
  fallback?: JSX.Element | null;
}

/** Chart height inside a measured App tile, or a notebook default. */
export function echartsHeight(availableHeight?: number): number {
  return Math.max(120, (availableHeight ?? 264) - 4);
}

/**
 * Draws a chart with ECharts from the DQL chart settings. Without a DOM (tests,
 * server rendering, exports) it renders the same option to SVG markup; in the
 * page it is an interactive chart. When ECharts has no chart for this data
 * (a scatter with one measure, say) it draws `fallback` instead.
 */
export function EChartsChart(props: EChartsChartProps): JSX.Element | null {
  const { chartType, result, themeMode, config, availableHeight, availableWidth, onMarkSelect, fallback = null } = props;
  const serverRender = typeof document === 'undefined';
  const built = useMemo(
    () => buildVizOption({ chartType, result, themeMode, config, animate: !serverRender }),
    [chartType, result, themeMode, config, serverRender],
  );
  if (!built) return fallback;
  // Callers pass a height that does not depend on the chart's own size (a
  // fixed tile frame, or the tile's grid rows), so the chart cannot grow the
  // box it was measured from.
  const height = echartsHeight(availableHeight);
  return (
    <div style={{ position: 'relative' }}>
      {serverRender
        ? <div className="dql-echart" style={{ height }} dangerouslySetInnerHTML={{ __html: renderOptionToSvg(built, availableWidth ?? 600, height) }} />
        : <InteractiveChart built={built} height={height} onMarkSelect={onMarkSelect} />}
      {onMarkSelect ? <MarkButtons built={built} onMarkSelect={onMarkSelect} /> : null}
      {built.droppedSeries > 0
        ? <p style={{ margin: '4px 8px 0', fontSize: 11, color: 'var(--text-tertiary, #6b6e76)' }}>
          {built.droppedSeries} more {built.droppedSeries === 1 ? 'series is' : 'series are'} not shown; a chart shows at most eight.
        </p>
        : null}
    </div>
  );
}

/** The option as SVG markup. ECharts escapes every text node it writes. */
export function renderOptionToSvg(built: VizOptionOutput, width: number, height: number): string {
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(built.option);
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

function InteractiveChart({ built, height, onMarkSelect }: { built: VizOptionOutput; height: number; onMarkSelect?: (row: Record<string, unknown>) => void }): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.ECharts | null>(null);
  const selectRef = useRef(onMarkSelect);
  selectRef.current = onMarkSelect;

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const chart = echarts.init(element, undefined, { renderer: 'svg' });
    instance.current = chart;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => chart.resize()) : undefined;
    resize?.observe(element);
    return () => {
      resize?.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = instance.current;
    if (!chart) return;
    chart.setOption(built.option, true);
    chart.off('click');
    chart.on('click', (params) => {
      const category = built.categories[params.dataIndex ?? -1];
      const row = category === undefined ? undefined : built.rowForCategory.get(category);
      if (row && selectRef.current) selectRef.current(row);
    });
  }, [built]);

  return <div ref={container} className="dql-echart" style={{ height, width: '100%', cursor: onMarkSelect ? 'pointer' : 'default' }} />;
}

/** One real button per mark, so a keyboard or screen reader can cross-filter too. */
function MarkButtons({ built, onMarkSelect }: { built: VizOptionOutput; onMarkSelect: (row: Record<string, unknown>) => void }): JSX.Element | null {
  if (built.categories.length === 0) return null;
  return (
    // Hidden until one is focused; then the row shows (see .dql-chart-marks).
    <div className="dql-chart-marks">
      {built.categories.map((category, index) => {
        const row = built.rowForCategory.get(category);
        return row
          ? <button key={category} type="button" aria-label={`Select ${built.categoryLabels[index] ?? category}`} onClick={() => onMarkSelect(row)}>
            {built.categoryLabels[index] ?? category}
          </button>
          : null;
      })}
    </div>
  );
}
