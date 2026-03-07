import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { LinePath, AreaClosed } from '@visx/shape';
import { scaleLinear, scalePoint } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { LinearGradient } from '@visx/gradient';
import { curveMonotoneX } from '@visx/curve';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColor, withOpacity } from '../utils/colors.js';

export interface LineChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string | string[];
  width: number;
  height: number;
  theme?: ChartTheme;
  color?: string;
  showArea?: boolean;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function LineChart({
  data,
  x,
  y,
  width,
  height,
  theme = editorialDark,
  color,
  showArea = false,
  margin = DEFAULT_MARGIN,
}: LineChartProps) {
  const { showTooltip, hideTooltip, tooltipOpen, tooltipLeft, tooltipTop, tooltipData } =
    useChartTooltip();

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const yFields = Array.isArray(y) ? y : [y];

  const xScale = scalePoint<string>({
    domain: data.map((d) => String(d[x])),
    range: [0, innerWidth],
    padding: 0.5,
  });

  const allValues = data.flatMap((d) => yFields.map((f) => Number(d[f]) || 0));
  const yMax = Math.max(...allValues);
  const yScale = scaleLinear<number>({
    domain: [0, yMax * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const handleMouseOver = useCallback(
    (event: React.MouseEvent, datum: Record<string, unknown>, field: string, seriesColor: string) => {
      const point = event.currentTarget.getBoundingClientRect();
      showTooltip({
        tooltipData: {
          label: String(datum[x]),
          value: formatCompact(Number(datum[field])),
          color: seriesColor,
        },
        tooltipLeft: point.left + point.width / 2,
        tooltipTop: point.top - 8,
      });
    },
    [showTooltip, x],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Line chart">
        {yFields.map((field, si) => {
          const lineColor = color || getSeriesColor(theme, si);
          const gradId = `line-area-${si}-${Math.random().toString(36).slice(2, 8)}`;
          return (
            <LinearGradient
              key={gradId}
              id={gradId}
              from={withOpacity(lineColor, 0.25)}
              to={withOpacity(lineColor, 0.02)}
              vertical
            />
          );
        })}
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          {yFields.map((field, si) => {
            const lineColor = color || getSeriesColor(theme, si);
            const gradId = `line-area-${si}`;
            return (
              <React.Fragment key={`series-${si}`}>
                {showArea && (
                  <AreaClosed
                    data={data}
                    x={(d) => xScale(String(d[x])) ?? 0}
                    y={(d) => yScale(Number(d[field]) || 0) ?? 0}
                    yScale={yScale}
                    fill={`url(#${gradId})`}
                    curve={curveMonotoneX}
                  />
                )}
                <LinePath
                  data={data}
                  x={(d) => xScale(String(d[x])) ?? 0}
                  y={(d) => yScale(Number(d[field]) || 0) ?? 0}
                  stroke={lineColor}
                  strokeWidth={2}
                  curve={curveMonotoneX}
                />
                {data.map((d, i) => (
                  <circle
                    key={`dot-${si}-${i}`}
                    cx={xScale(String(d[x])) ?? 0}
                    cy={yScale(Number(d[field]) || 0) ?? 0}
                    r={3}
                    fill={lineColor}
                    stroke={theme.surface}
                    strokeWidth={1.5}
                    style={{ cursor: 'pointer' }}
                    onMouseMove={(e) => handleMouseOver(e, d, field, lineColor)}
                    onMouseLeave={hideTooltip}
                  />
                ))}
              </React.Fragment>
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
