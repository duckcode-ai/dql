import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { withOpacity } from '../utils/colors.js';

export interface HeatmapChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  value: string;
  width: number;
  height: number;
  theme?: ChartTheme;
  colorRange?: [string, string];
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 72 };

export function HeatmapChart({
  data, x, y, value, width, height,
  theme = editorialDark,
  colorRange,
  margin = DEFAULT_MARGIN,
}: HeatmapChartProps) {
  const tt = useChartTooltip();
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const xDomain = [...new Set(data.map((d) => String(d[x])))];
  const yDomain = [...new Set(data.map((d) => String(d[y])))];

  const xScale = scaleBand<string>({ domain: xDomain, range: [0, innerWidth], padding: 0.05 });
  const yScale = scaleBand<string>({ domain: yDomain, range: [0, innerHeight], padding: 0.05 });

  const vals = data.map((d) => Number(d[value]) || 0);
  const vMin = Math.min(...vals);
  const vMax = Math.max(...vals);
  const colorLow = colorRange?.[0] ?? theme.surfaceAlt;
  const colorHigh = colorRange?.[1] ?? theme.accent;

  const intensity = scaleLinear<number>({
    domain: [vMin, vMax],
    range: [0.1, 1],
  });

  const onHover = useCallback(
    (event: React.MouseEvent, datum: Record<string, unknown>) => {
      const el = event.currentTarget.getBoundingClientRect();
      tt.showTooltip({
        tooltipData: {
          label: `${String(datum[x])} × ${String(datum[y])}`,
          value: formatCompact(Number(datum[value])),
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, x, y, value],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Heatmap chart">
        <Group left={margin.left} top={margin.top}>
          {data.map((d, i) => {
            const cx = xScale(String(d[x])) ?? 0;
            const cy = yScale(String(d[y])) ?? 0;
            const w = xScale.bandwidth();
            const h = yScale.bandwidth();
            const t = intensity(Number(d[value]) || 0) ?? 0.1;
            return (
              <rect
                key={`cell-${i}`}
                x={cx}
                y={cy}
                width={w}
                height={h}
                fill={withOpacity(colorHigh, t)}
                rx={3}
                style={{ cursor: 'pointer' }}
                onMouseMove={(e) => onHover(e, d)}
                onMouseLeave={tt.hideTooltip}
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
            tickLabelProps={{
              fill: theme.textMuted,
              fontSize: theme.fontSizeTick,
              fontFamily: theme.fontFamily,
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
