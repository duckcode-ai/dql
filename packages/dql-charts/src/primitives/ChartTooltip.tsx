import React from 'react';
import { defaultStyles, TooltipWithBounds, useTooltip } from '@visx/tooltip';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';

export type { TooltipData };

interface TooltipData {
  label: string;
  value: string | number;
  color?: string;
  rows?: Array<{ label: string; value: string | number }>;
}

export interface ChartTooltipProps {
  theme?: ChartTheme;
}

export function useChartTooltip() {
  return useTooltip<TooltipData>();
}

export function ChartTooltipContent({
  data,
  theme = editorialDark,
}: {
  data: TooltipData;
  theme?: ChartTheme;
}) {
  return (
    <div
      style={{
        fontFamily: theme.fontFamilyMono,
        fontSize: theme.fontSizeTooltip,
        color: theme.tooltipText,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: data.rows ? 4 : 0 }}>
        {data.color && (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: data.color,
              marginRight: 6,
            }}
          />
        )}
        {data.label}: {data.value}
      </div>
      {data.rows?.map((row, i) => (
        <div key={i} style={{ color: theme.textMuted }}>
          {row.label}: {row.value}
        </div>
      ))}
    </div>
  );
}

export function TooltipPortal({
  tooltipOpen,
  tooltipLeft,
  tooltipTop,
  tooltipData,
  theme = editorialDark,
}: {
  tooltipOpen: boolean;
  tooltipLeft?: number;
  tooltipTop?: number;
  tooltipData?: TooltipData;
  theme?: ChartTheme;
}) {
  if (!tooltipOpen || !tooltipData) return null;

  return (
    <TooltipWithBounds
      left={tooltipLeft}
      top={tooltipTop}
      style={{
        ...defaultStyles,
        background: theme.tooltipBg,
        color: theme.tooltipText,
        border: `1px solid ${theme.tooltipBorder}`,
        borderRadius: 8,
        padding: '8px 12px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        fontFamily: theme.fontFamilyMono,
        fontSize: theme.fontSizeTooltip,
      }}
    >
      <ChartTooltipContent data={tooltipData} theme={theme} />
    </TooltipWithBounds>
  );
}
