import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColor } from '../utils/colors.js';

export interface BoxPlotDatum {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

export interface BoxPlotChartProps {
  data: BoxPlotDatum[];
  width: number;
  height: number;
  theme?: ChartTheme;
  color?: string;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function BoxPlotChart({
  data, width, height,
  theme = editorialDark,
  color,
  margin = DEFAULT_MARGIN,
}: BoxPlotChartProps) {
  const tt = useChartTooltip();
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const boxColor = color || getSeriesColor(theme, 0);

  const xScale = scaleBand<string>({
    domain: data.map((d) => d.label),
    range: [0, innerWidth],
    padding: 0.3,
  });

  const allVals = data.flatMap((d) => [d.min, d.max]);
  const yScale = scaleLinear<number>({
    domain: [Math.min(...allVals) * 0.9, Math.max(...allVals) * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const onHover = useCallback(
    (event: React.MouseEvent, datum: BoxPlotDatum) => {
      const el = event.currentTarget.getBoundingClientRect();
      tt.showTooltip({
        tooltipData: {
          label: datum.label,
          value: `Median: ${formatCompact(datum.median)}`,
          color: boxColor,
          rows: [
            { label: 'Max', value: formatCompact(datum.max) },
            { label: 'Q3', value: formatCompact(datum.q3) },
            { label: 'Q1', value: formatCompact(datum.q1) },
            { label: 'Min', value: formatCompact(datum.min) },
          ],
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, boxColor],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Box plot chart">
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          {data.map((d, i) => {
            const cx = (xScale(d.label) ?? 0) + xScale.bandwidth() / 2;
            const bw = xScale.bandwidth() * 0.6;
            const bx = cx - bw / 2;
            const yMin = yScale(d.min) ?? 0;
            const yMax = yScale(d.max) ?? 0;
            const yQ1 = yScale(d.q1) ?? 0;
            const yQ3 = yScale(d.q3) ?? 0;
            const yMed = yScale(d.median) ?? 0;
            return (
              <g
                key={`box-${i}`}
                style={{ cursor: 'pointer' }}
                onMouseMove={(e) => onHover(e, d)}
                onMouseLeave={tt.hideTooltip}
              >
                {/* Whisker line */}
                <line x1={cx} y1={yMax} x2={cx} y2={yMin} stroke={boxColor} strokeWidth={1} />
                {/* Whisker caps */}
                <line x1={cx - bw / 4} y1={yMax} x2={cx + bw / 4} y2={yMax} stroke={boxColor} strokeWidth={1.5} />
                <line x1={cx - bw / 4} y1={yMin} x2={cx + bw / 4} y2={yMin} stroke={boxColor} strokeWidth={1.5} />
                {/* IQR box */}
                <rect
                  x={bx}
                  y={yQ3}
                  width={bw}
                  height={yQ1 - yQ3}
                  fill={boxColor}
                  fillOpacity={0.25}
                  stroke={boxColor}
                  strokeWidth={1.5}
                  rx={3}
                />
                {/* Median line */}
                <line x1={bx} y1={yMed} x2={bx + bw} y2={yMed} stroke={boxColor} strokeWidth={2.5} />
              </g>
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
        tooltipOpen={tt.tooltipOpen}
        tooltipLeft={tt.tooltipLeft}
        tooltipTop={tt.tooltipTop}
        tooltipData={tt.tooltipData}
        theme={theme}
      />
    </>
  );
}
