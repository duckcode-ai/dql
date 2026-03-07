import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import type { PieArcDatum } from '@visx/shape/lib/shapes/Pie';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColor } from '../utils/colors.js';

export interface DonutChartProps {
  data: Record<string, unknown>[];
  label: string;
  value: string;
  width: number;
  height: number;
  theme?: ChartTheme;
  innerRadiusRatio?: number;
}

export function DonutChart({
  data, label, value, width, height,
  theme = editorialDark,
  innerRadiusRatio = 0.6,
}: DonutChartProps) {
  const tt = useChartTooltip();
  const radius = Math.min(width, height) / 2 - 16;
  const innerRadius = radius * innerRadiusRatio;
  if (radius <= 0) return null;

  const total = data.reduce((s, d) => s + (Number(d[value]) || 0), 0);

  const onHover = useCallback(
    (event: React.MouseEvent, arc: PieArcDatum<Record<string, unknown>>) => {
      const el = event.currentTarget.getBoundingClientRect();
      const v = Number(arc.data[value]) || 0;
      const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0';
      tt.showTooltip({
        tooltipData: {
          label: String(arc.data[label]),
          value: `${formatCompact(v)} (${pct}%)`,
          color: getSeriesColor(theme, arc.index),
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, label, value, total, theme],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Donut chart">
        <Group top={height / 2} left={width / 2}>
          <Pie
            data={data}
            pieValue={(d) => Number(d[value]) || 0}
            outerRadius={radius}
            innerRadius={innerRadius}
            padAngle={0.02}
            cornerRadius={3}
          >
            {(pie) =>
              pie.arcs.map((arc, i) => {
                const c = getSeriesColor(theme, i);
                return (
                  <path
                    key={`arc-${i}`}
                    d={pie.path(arc) || ''}
                    fill={c}
                    style={{ cursor: 'pointer' }}
                    onMouseMove={(e) => onHover(e, arc)}
                    onMouseLeave={tt.hideTooltip}
                  />
                );
              })
            }
          </Pie>
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fill={theme.textPrimary}
            fontSize={20}
            fontFamily={theme.fontFamilyMono}
            fontWeight={700}
            dy={-4}
          >
            {formatCompact(total)}
          </text>
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fill={theme.textMuted}
            fontSize={theme.fontSizeTick}
            fontFamily={theme.fontFamily}
            dy={16}
          >
            Total
          </text>
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
