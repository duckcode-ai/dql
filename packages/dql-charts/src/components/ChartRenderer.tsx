import React from 'react';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { ChartContainer } from '../primitives/ChartContainer.js';
import { BarChart } from './BarChart.js';
import { LineChart } from './LineChart.js';
import { ScatterChart } from './ScatterChart.js';
import { DonutChart } from './DonutChart.js';
import { KPICard } from './KPICard.js';
import { DataTable } from './DataTable.js';
import { GroupedBarChart } from './GroupedBarChart.js';
import { StackedAreaChart } from './StackedAreaChart.js';
import { ForecastChart } from './ForecastChart.js';
import { HeatmapChart } from './HeatmapChart.js';
import { FunnelChart } from './FunnelChart.js';
import { WaterfallChart } from './WaterfallChart.js';
import { BoxPlotChart } from './BoxPlotChart.js';
import type { BoxPlotDatum } from './BoxPlotChart.js';

export type ChartType =
  | 'bar'
  | 'grouped-bar'
  | 'line'
  | 'area'
  | 'stacked-area'
  | 'scatter'
  | 'donut'
  | 'pie'
  | 'kpi'
  | 'table'
  | 'forecast'
  | 'heatmap'
  | 'funnel'
  | 'waterfall'
  | 'boxplot';

export interface ChartRendererProps {
  type: ChartType;
  data: Record<string, unknown>[];
  props: Record<string, unknown>;
  title?: string;
  subtitle?: string;
  theme?: ChartTheme;
  height?: number;
}

export function ChartRenderer({
  type,
  data,
  props,
  title,
  subtitle,
  theme = editorialDark,
  height = 300,
}: ChartRendererProps) {
  if (type === 'kpi') {
    return (
      <KPICard
        title={(props.title as string) || title || ''}
        value={(props.value as number) ?? data[0]?.[props.y as string] ?? 0}
        change={props.change as number | undefined}
        changeLabel={props.changeLabel as string | undefined}
        format={props.format as 'compact' | undefined}
        theme={theme}
      />
    );
  }

  if (type === 'table') {
    return (
      <ChartContainer title={title} subtitle={subtitle} theme={theme} height={height}>
        {() => (
          <DataTable
            data={data}
            columns={props.columns as string[] | undefined}
            theme={theme}
            maxRows={props.maxRows as number | undefined}
          />
        )}
      </ChartContainer>
    );
  }

  return (
    <ChartContainer title={title} subtitle={subtitle} theme={theme} height={height}>
      {({ width: w, height: h }) => {
        switch (type) {
          case 'bar':
            return (
              <BarChart
                data={data}
                x={props.x as string}
                y={props.y as string}
                width={w}
                height={h}
                theme={theme}
                color={props.color as string | undefined}
              />
            );
          case 'line':
            return (
              <LineChart
                data={data}
                x={props.x as string}
                y={props.y as string | string[]}
                width={w}
                height={h}
                theme={theme}
                color={props.color as string | undefined}
              />
            );
          case 'area':
            return (
              <LineChart
                data={data}
                x={props.x as string}
                y={props.y as string | string[]}
                width={w}
                height={h}
                theme={theme}
                color={props.color as string | undefined}
                showArea
              />
            );
          case 'scatter':
            return (
              <ScatterChart
                data={data}
                x={props.x as string}
                y={props.y as string}
                size={props.size as string | undefined}
                category={props.category as string | undefined}
                width={w}
                height={h}
                theme={theme}
                color={props.color as string | undefined}
              />
            );
          case 'donut':
          case 'pie':
            return (
              <DonutChart
                data={data}
                label={props.label as string || props.x as string}
                value={props.value as string || props.y as string}
                width={w}
                height={h}
                theme={theme}
                innerRadiusRatio={type === 'pie' ? 0 : 0.6}
              />
            );
          case 'grouped-bar':
            return (
              <GroupedBarChart
                data={data}
                x={props.x as string}
                y={props.y as string[]}
                width={w}
                height={h}
                theme={theme}
              />
            );
          case 'stacked-area':
            return (
              <StackedAreaChart
                data={data}
                x={props.x as string}
                y={props.y as string[]}
                width={w}
                height={h}
                theme={theme}
              />
            );
          case 'forecast':
            return (
              <ForecastChart
                data={data}
                x={props.x as string}
                y={props.y as string}
                upper={props.upper as string}
                lower={props.lower as string}
                forecastStart={props.forecastStart as number | undefined}
                width={w}
                height={h}
                theme={theme}
                color={props.color as string | undefined}
              />
            );
          case 'heatmap':
            return (
              <HeatmapChart
                data={data}
                x={props.x as string}
                y={props.y as string}
                value={props.value as string}
                width={w}
                height={h}
                theme={theme}
              />
            );
          case 'funnel':
            return (
              <FunnelChart
                data={data}
                label={props.label as string || props.x as string}
                value={props.value as string || props.y as string}
                width={w}
                height={h}
                theme={theme}
              />
            );
          case 'waterfall':
            return (
              <WaterfallChart
                data={data}
                label={props.label as string || props.x as string}
                value={props.value as string || props.y as string}
                width={w}
                height={h}
                theme={theme}
              />
            );
          case 'boxplot':
            return (
              <BoxPlotChart
                data={data as unknown as BoxPlotDatum[]}
                width={w}
                height={h}
                theme={theme}
                color={props.color as string | undefined}
              />
            );
          default:
            return null;
        }
      }}
    </ChartContainer>
  );
}
