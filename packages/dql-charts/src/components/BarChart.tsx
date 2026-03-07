import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { Bar } from '@visx/shape';
import { scaleBand, scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { LinearGradient } from '@visx/gradient';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColor, withOpacity } from '../utils/colors.js';

export interface BarChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  width: number;
  height: number;
  theme?: ChartTheme;
  color?: string;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function BarChart({
  data,
  x,
  y,
  width,
  height,
  theme = editorialDark,
  color,
  margin = DEFAULT_MARGIN,
}: BarChartProps) {
  const { showTooltip, hideTooltip, tooltipOpen, tooltipLeft, tooltipTop, tooltipData } =
    useChartTooltip();

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const barColor = color || getSeriesColor(theme, 0);

  const xScale = scaleBand<string>({
    domain: data.map((d) => String(d[x])),
    range: [0, innerWidth],
    padding: 0.3,
  });

  const yMax = Math.max(...data.map((d) => Number(d[y]) || 0));
  const yScale = scaleLinear<number>({
    domain: [0, yMax * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const handleMouseOver = useCallback(
    (event: React.MouseEvent, datum: Record<string, unknown>) => {
      const bar = event.currentTarget.getBoundingClientRect();
      showTooltip({
        tooltipData: {
          label: String(datum[x]),
          value: formatCompact(Number(datum[y])),
          color: barColor,
        },
        tooltipLeft: bar.left + bar.width / 2,
        tooltipTop: bar.top - 8,
      });
    },
    [showTooltip, x, y, barColor],
  );

  const gradientId = `bar-gradient-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Bar chart">
        <LinearGradient
          id={gradientId}
          from={barColor}
          to={withOpacity(barColor, 0.6)}
          vertical
        />
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          {data.map((d, i) => {
            const xVal = String(d[x]);
            const yVal = Number(d[y]) || 0;
            const barWidth = xScale.bandwidth();
            const barHeight = innerHeight - (yScale(yVal) ?? 0);
            const barX = xScale(xVal) ?? 0;
            const barY = innerHeight - barHeight;

            return (
              <Bar
                key={`bar-${i}`}
                x={barX}
                y={barY}
                width={barWidth}
                height={barHeight}
                fill={`url(#${gradientId})`}
                rx={3}
                onMouseMove={(e: React.MouseEvent) => handleMouseOver(e, d)}
                onMouseLeave={hideTooltip}
                style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
              />
            );
          })}
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            stroke={theme.axisColor}
            tickStroke={theme.tickColor}
            tickLabelProps={{
              fill: theme.textMuted,
              fontSize: theme.fontSizeTick,
              fontFamily: theme.fontFamily,
              textAnchor: 'middle',
            }}
          />
          <AxisLeft
            scale={yScale}
            stroke={theme.axisColor}
            tickStroke={theme.tickColor}
            tickFormat={(v) => formatCompact(v as number)}
            tickLabelProps={{
              fill: theme.textMuted,
              fontSize: theme.fontSizeTick,
              fontFamily: theme.fontFamilyMono,
              textAnchor: 'end',
              dx: -4,
              dy: 3,
            }}
          />
        </Group>
      </svg>
      <TooltipPortal
        tooltipOpen={tooltipOpen}
        tooltipLeft={tooltipLeft}
        tooltipTop={tooltipTop}
        tooltipData={tooltipData}
        theme={theme}
      />
    </>
  );
}
