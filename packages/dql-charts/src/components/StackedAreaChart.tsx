import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { AreaStack } from '@visx/shape';
import { scaleLinear, scalePoint } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { curveMonotoneX } from '@visx/curve';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColors, withOpacity } from '../utils/colors.js';

export interface StackedAreaChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string[];
  width: number;
  height: number;
  theme?: ChartTheme;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function StackedAreaChart({
  data, x, y, width, height,
  theme = editorialDark,
  margin = DEFAULT_MARGIN,
}: StackedAreaChartProps) {
  const tt = useChartTooltip();
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const colors = getSeriesColors(theme, y.length);

  const xScale = scalePoint<string>({
    domain: data.map((d) => String(d[x])),
    range: [0, innerWidth],
    padding: 0.5,
  });

  const stackMax = Math.max(
    ...data.map((d) => y.reduce((sum, f) => sum + (Number(d[f]) || 0), 0)),
  );
  const yScale = scaleLinear<number>({
    domain: [0, stackMax * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const onHover = useCallback(
    (event: React.MouseEvent, idx: number) => {
      const el = event.currentTarget.getBoundingClientRect();
      const datum = data[idx];
      if (!datum) return;
      tt.showTooltip({
        tooltipData: {
          label: String(datum[x]),
          value: '',
          rows: y.map((f, si) => ({
            label: f,
            value: formatCompact(Number(datum[f]) || 0),
          })),
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, x, y, data],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Stacked area chart">
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          <AreaStack
            keys={y}
            data={data as Record<string, number>[]}
            x={(d) => xScale(String(d.data[x])) ?? 0}
            y0={(d) => yScale(d[0]) ?? 0}
            y1={(d) => yScale(d[1]) ?? 0}
            curve={curveMonotoneX}
          >
            {({ stacks, path }) =>
              stacks.map((stack, si) => (
                <path
                  key={`stack-${si}`}
                  d={path(stack) || ''}
                  fill={withOpacity(colors[si], 0.6)}
                  stroke={colors[si]}
                  strokeWidth={1.5}
                />
              ))
            }
          </AreaStack>
          {data.map((d, i) => (
            <rect
              key={`hover-${i}`}
              x={(xScale(String(d[x])) ?? 0) - innerWidth / data.length / 2}
              y={0}
              width={innerWidth / data.length}
              height={innerHeight}
              fill="transparent"
              onMouseMove={(e) => onHover(e, i)}
              onMouseLeave={tt.hideTooltip}
              style={{ cursor: 'pointer' }}
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
