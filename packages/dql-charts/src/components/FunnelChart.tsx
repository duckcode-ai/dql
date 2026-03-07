import React, { useCallback } from 'react';
import { Group } from '@visx/group';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { useChartTooltip, TooltipPortal } from '../primitives/ChartTooltip.js';
import { formatCompact } from '../utils/formatters.js';
import { getSeriesColors, withOpacity } from '../utils/colors.js';

export interface FunnelChartProps {
  data: Record<string, unknown>[];
  label: string;
  value: string;
  width: number;
  height: number;
  theme?: ChartTheme;
  margin?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_MARGIN = { top: 8, right: 24, bottom: 8, left: 24 };

export function FunnelChart({
  data, label, value, width, height,
  theme = editorialDark,
  margin = DEFAULT_MARGIN,
}: FunnelChartProps) {
  const tt = useChartTooltip();
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth <= 0 || innerHeight <= 0 || data.length === 0) return null;

  const colors = getSeriesColors(theme, data.length);
  const maxVal = Math.max(...data.map((d) => Number(d[value]) || 0));
  const stepH = innerHeight / data.length;
  const gap = 2;

  const onHover = useCallback(
    (event: React.MouseEvent, datum: Record<string, unknown>, idx: number) => {
      const el = event.currentTarget.getBoundingClientRect();
      const v = Number(datum[value]) || 0;
      const pct = maxVal > 0 ? ((v / maxVal) * 100).toFixed(1) : '0';
      tt.showTooltip({
        tooltipData: {
          label: String(datum[label]),
          value: `${formatCompact(v)} (${pct}%)`,
          color: colors[idx],
        },
        tooltipLeft: el.left + el.width / 2,
        tooltipTop: el.top - 8,
      });
    },
    [tt.showTooltip, label, value, maxVal, colors],
  );

  return (
    <>
      <svg width={width} height={height} role="img" aria-label="Funnel chart">
        <Group left={margin.left} top={margin.top}>
          {data.map((d, i) => {
            const v = Number(d[value]) || 0;
            const ratio = maxVal > 0 ? v / maxVal : 0;
            const barW = innerWidth * ratio;
            const barX = (innerWidth - barW) / 2;
            const barY = i * stepH + gap / 2;
            const barH = stepH - gap;
            return (
              <g key={`funnel-${i}`}>
                <rect
                  x={barX}
                  y={barY}
                  width={barW}
                  height={barH}
                  fill={withOpacity(colors[i], 0.85)}
                  rx={4}
                  style={{ cursor: 'pointer' }}
                  onMouseMove={(e) => onHover(e, d, i)}
                  onMouseLeave={tt.hideTooltip}
                />
                <text
                  x={innerWidth / 2}
                  y={barY + barH / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={theme.textPrimary}
                  fontSize={theme.fontSizeLabel}
                  fontFamily={theme.fontFamily}
                  fontWeight={500}
                  pointerEvents="none"
                >
                  {String(d[label])} — {formatCompact(v)}
                </text>
              </g>
            );
          })}
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
