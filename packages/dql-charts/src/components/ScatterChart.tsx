import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { Circle } from '@visx/shape';
import { scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows, GridColumns } from '@visx/grid';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColor, withOpacity } from '../utils/colors.js';

export interface ScatterChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  size?: string;
  category?: string;
  width: number;
  height: number;
  theme?: ChartTheme;
  color?: string;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function ScatterChart({
  data,
  x,
  y,
  size,
  category,
  width,
  height,
  theme = editorialDark,
  color,
  margin = DEFAULT_MARGIN,
}: ScatterChartProps) {
  const { showTooltip, hideTooltip, tooltipOpen, tooltipLeft, tooltipTop, tooltipData } =
    useChartTooltip();

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const xValues = data.map((d) => Number(d[x]) || 0);
  const yValues = data.map((d) => Number(d[y]) || 0);

  const xScale = scaleLinear<number>({
    domain: [Math.min(...xValues) * 0.9, Math.max(...xValues) * 1.1],
    range: [0, innerWidth],
    nice: true,
  });

  const yScale = scaleLinear<number>({
    domain: [Math.min(...yValues) * 0.9, Math.max(...yValues) * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const sizeValues = size ? data.map((d) => Number(d[size]) || 1) : [];
  const sizeMax = sizeValues.length > 0 ? Math.max(...sizeValues) : 1;
  const getRadius = (d: Record<string, unknown>) => {
    if (!size) return 5;
    return 3 + ((Number(d[size]) || 1) / sizeMax) * 12;
  };

  const categories = category
    ? [...new Set(data.map((d) => String(d[category])))]
    : [];

  const getCategoryColor = (d: Record<string, unknown>) => {
    if (color) return color;
    if (!category) return getSeriesColor(theme, 0);
    const idx = categories.indexOf(String(d[category]));
    return getSeriesColor(theme, idx >= 0 ? idx : 0);
  };

  const handleMouseOver = useCallback(
    (event: React.MouseEvent, datum: Record<string, unknown>) => {
      const el = event.currentTarget.getBoundingClientRect();
      showTooltip({
        tooltipData: {
          label: `${x}: ${formatCompact(Number(datum[x]))}`,
          value: formatCompact(Number(datum[y])),
          color: getCategoryColor(datum),
          rows: category ? [{ label: category, value: String(datum[category]) }] : undefined,
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [showTooltip, x, y, category],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Scatter chart">
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          <GridColumns
            scale={xScale}
            height={innerHeight}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          {data.map((d, i) => {
            const cx = xScale(Number(d[x]) || 0) ?? 0;
            const cy = yScale(Number(d[y]) || 0) ?? 0;
            const r = getRadius(d);
            const dotColor = getCategoryColor(d);
            return (
              <Circle
                key={`point-${i}`}
                cx={cx}
                cy={cy}
                r={r}
                fill={withOpacity(dotColor, 0.7)}
                stroke={dotColor}
                strokeWidth={1}
                style={{ cursor: 'pointer' }}
                onMouseMove={(e: React.MouseEvent) => handleMouseOver(e, d)}
                onMouseLeave={hideTooltip}
              />
            );
          })}
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            stroke={theme.axisColor}
            tickStroke={theme.tickColor}
            tickFormat={(v) => formatCompact(v as number)}
            tickLabelProps={{
              fill: theme.textMuted,
              fontSize: theme.fontSizeTick,
              fontFamily: theme.fontFamilyMono,
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
