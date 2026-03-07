import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { LinePath, AreaClosed } from '@visx/shape';
import { scaleLinear, scalePoint } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { curveMonotoneX } from '@visx/curve';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColor, withOpacity } from '../utils/colors.js';

export interface ForecastChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  upper: string;
  lower: string;
  forecastStart?: number;
  width: number;
  height: number;
  theme?: ChartTheme;
  color?: string;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function ForecastChart({
  data, x, y, upper, lower, forecastStart,
  width, height,
  theme = editorialDark,
  color,
  margin = DEFAULT_MARGIN,
}: ForecastChartProps) {
  const tt = useChartTooltip();
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const lineColor = color || getSeriesColor(theme, 0);
  const splitIdx = forecastStart ?? data.length;
  const actual = data.slice(0, splitIdx);
  const forecast = data.slice(Math.max(0, splitIdx - 1));

  const xScale = scalePoint<string>({
    domain: data.map((d) => String(d[x])),
    range: [0, innerWidth],
    padding: 0.5,
  });

  const allVals = data.flatMap((d) => [
    Number(d[y]) || 0,
    Number(d[upper]) || 0,
    Number(d[lower]) || 0,
  ]);
  const yScale = scaleLinear<number>({
    domain: [Math.min(...allVals) * 0.9, Math.max(...allVals) * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const getX = (d: Record<string, unknown>) => xScale(String(d[x])) ?? 0;
  const getY = (d: Record<string, unknown>) => yScale(Number(d[y]) || 0) ?? 0;
  const getUpper = (d: Record<string, unknown>) => yScale(Number(d[upper]) || 0) ?? 0;
  const getLower = (d: Record<string, unknown>) => yScale(Number(d[lower]) || 0) ?? 0;

  const onHover = useCallback(
    (event: React.MouseEvent, datum: Record<string, unknown>) => {
      const el = event.currentTarget.getBoundingClientRect();
      tt.showTooltip({
        tooltipData: {
          label: String(datum[x]),
          value: formatCompact(Number(datum[y])),
          color: lineColor,
          rows: [
            { label: 'Upper', value: formatCompact(Number(datum[upper])) },
            { label: 'Lower', value: formatCompact(Number(datum[lower])) },
          ],
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, x, y, upper, lower, lineColor],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Forecast chart">
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          {/* Confidence band */}
          {forecast.length > 1 && (
            <path
              d={
                `M${forecast.map((d) => `${getX(d)},${getUpper(d)}`).join('L')}` +
                `L${[...forecast].reverse().map((d) => `${getX(d)},${getLower(d)}`).join('L')}Z`
              }
              fill={withOpacity(lineColor, 0.12)}
              stroke="none"
            />
          )}
          {/* Actual line */}
          <LinePath
            data={actual}
            x={getX}
            y={getY}
            stroke={lineColor}
            strokeWidth={2}
            curve={curveMonotoneX}
          />
          {/* Forecast line */}
          {forecast.length > 1 && (
            <LinePath
              data={forecast}
              x={getX}
              y={getY}
              stroke={lineColor}
              strokeWidth={2}
              strokeDasharray="6,4"
              curve={curveMonotoneX}
            />
          )}
          {/* Data points */}
          {data.map((d, i) => (
            <circle
              key={`dot-${i}`}
              cx={getX(d)}
              cy={getY(d)}
              r={3}
              fill={i < splitIdx ? lineColor : theme.surface}
              stroke={lineColor}
              strokeWidth={1.5}
              style={{ cursor: 'pointer' }}
              onMouseMove={(e) => onHover(e, d)}
              onMouseLeave={tt.hideTooltip}
            />
          ))}
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
        tooltipOpen={tt.tooltipOpen}
        tooltipLeft={tt.tooltipLeft}
        tooltipTop={tt.tooltipTop}
        tooltipData={tt.tooltipData}
        theme={theme}
      />
    </>
  );
}
