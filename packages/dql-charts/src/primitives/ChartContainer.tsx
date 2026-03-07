import React from 'react';
import { ParentSize } from '@visx/responsive';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';

export interface ChartContainerProps {
  title?: string;
  subtitle?: string;
  theme?: ChartTheme;
  height?: number;
  className?: string;
  children: (dimensions: { width: number; height: number }) => React.ReactNode;
}

export function ChartContainer({
  title,
  subtitle,
  theme = editorialDark,
  height = 300,
  className,
  children,
}: ChartContainerProps) {
  return (
    <div
      className={className}
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: '20px 24px',
        fontFamily: theme.fontFamily,
      }}
    >
      {(title || subtitle) && (
        <div style={{ marginBottom: 16 }}>
          {title && (
            <div
              style={{
                fontSize: theme.fontSizeTitle,
                fontWeight: 600,
                color: theme.textPrimary,
                letterSpacing: '-0.01em',
              }}
            >
              {title}
            </div>
          )}
          {subtitle && (
            <div
              style={{
                fontSize: theme.fontSizeLabel,
                color: theme.textMuted,
                marginTop: 2,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}
      <div style={{ width: '100%', height }}>
        <ParentSize>
          {({ width: w, height: h }) =>
            w > 0 && h > 0 ? children({ width: w, height: h }) : null
          }
        </ParentSize>
      </div>
    </div>
  );
}
