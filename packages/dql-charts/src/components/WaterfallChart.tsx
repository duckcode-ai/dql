import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { Bar } from '@visx/shape';
import { scaleBand, scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';

export interface WaterfallChartProps {
  data: Record<string, unknown>[];
  label: string;
  value: string;
  width: number;
  height: number;
  theme?: ChartTheme;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };

export function WaterfallChart({
  data, label, value, width, height,
  theme = editorialDark,
  margin = DEFAULT_MARGIN,
}: WaterfallChartProps) {
  const tt = useChartTooltip();
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  // Compute running totals
  const bars: Array<{ label: string; start: number; end: number; val: number }> = [];
  let running = 0;
  for (const d of data) {
    const v = Number(d[value]) || 0;
    bars.push({ label: String(d[label]), start: running, end: running + v, val: v });
    running += v;
  }

  const allVals = bars.flatMap((b) => [b.start, b.end]);
  const yMin = Math.min(0, ...allVals);
  const yMax = Math.max(0, ...allVals);

  const xScale = scaleBand<string>({
    domain: bars.map((b) => b.label),
    range: [0, innerWidth],
    padding: 0.25,
  });

  const yScale = scaleLinear<number>({
    domain: [yMin * 1.1, yMax * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  const onHover = useCallback(
    (event: React.MouseEvent, bar: (typeof bars)[0]) => {
      const el = event.currentTarget.getBoundingClientRect();
      tt.showTooltip({
        tooltipData: {
          label: bar.label,
          value: formatCompact(bar.val),
          color: bar.val >= 0 ? theme.positive : theme.negative,
          rows: [{ label: 'Running', value: formatCompact(bar.end) }],
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, theme],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Waterfall chart">
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={theme.gridColor}
            strokeOpacity={theme.gridOpacity}
            strokeDasharray="2,3"
          />
          {bars.map((b, i) => {
            const bx = xScale(b.label) ?? 0;
            const bw = xScale.bandwidth();
            const top = yScale(Math.max(b.start, b.end)) ?? 0;
            const bottom = yScale(Math.min(b.start, b.end)) ?? 0;
            const bh = bottom - top;
            const fill = b.val >= 0 ? theme.positive : theme.negative;
            return (
              <g key={`wf-${i}`}>
                <Bar
                  x={bx}
                  y={top}
                  width={bw}
                  height={Math.max(bh, 1)}
                  fill={fill}
                  rx={2}
                  style={{ cursor: 'pointer' }}
                  onMouseMove={(e: React.MouseEvent) => onHover(e, b)}
                  onMouseLeave={tt.hideTooltip}
                />
                {/* Connector line */}
                {i < bars.length - 1 && (
                  <line
                    x1={bx + bw}
                    y1={yScale(b.end) ?? 0}
                    x2={(xScale(bars[i + 1].label) ?? 0)}
                    y2={yScale(b.end) ?? 0}
                    stroke={theme.borderLight}
                    strokeWidth={1}
                    strokeDasharray="3,2"
                  />
                )}
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
