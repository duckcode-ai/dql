import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { Bar } from '@visx/shape';
import { scaleBand, scaleLinear, scaleOrdinal } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColors } from '../utils/colors.js';

export interface GroupedBarChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string[];
  width: number;
  height: number;
  theme?: ChartTheme;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function GroupedBarChart({
  data, x, y, width, height,
  theme = editorialDark,
  margin = DEFAULT_MARGIN,
}: GroupedBarChartProps) {
  const tt = useChartTooltip();
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const colors = getSeriesColors(theme, y.length);

  const x0Scale = scaleBand<string>({
    domain: data.map((d) => String(d[x])),
    range: [0, innerWidth],
    padding: 0.2,
  });

  const x1Scale = scaleBand<string>({
    domain: y,
    range: [0, x0Scale.bandwidth()],
    padding: 0.05,
  });

  const allVals = data.flatMap((d) => y.map((f) => Number(d[f]) || 0));
  const yScale = scaleLinear<number>({
    domain: [0, Math.max(...allVals) * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const colorScale = scaleOrdinal<string, string>({ domain: y, range: colors });

  const onHover = useCallback(
    (event: React.MouseEvent, datum: Record<string, unknown>, field: string) => {
      const el = event.currentTarget.getBoundingClientRect();
      tt.showTooltip({
        tooltipData: {
          label: `${String(datum[x])} — ${field}`,
          value: formatCompact(Number(datum[field])),
          color: colorScale(field),
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, x, colorScale],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Grouped bar chart">
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
            return (
              <Group key={`group-${i}`} left={x0Scale(xVal) ?? 0}>
                {y.map((field, si) => {
                  const val = Number(d[field]) || 0;
                  const bw = x1Scale.bandwidth();
                  const bh = innerHeight - (yScale(val) ?? 0);
                  return (
                    <Bar
                      key={`bar-${i}-${si}`}
                      x={x1Scale(field) ?? 0}
                      y={innerHeight - bh}
                      width={bw}
                      height={bh}
                      fill={colorScale(field)}
                      rx={2}
                      onMouseMove={(e: React.MouseEvent) => onHover(e, d, field)}
                      onMouseLeave={tt.hideTooltip}
                      style={{ cursor: 'pointer' }}
                    />
                  );
                })}
              </Group>
            );
          })}
          <AxisBottom
            top={innerHeight}
            scale={x0Scale}
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
